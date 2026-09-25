/**
 * The claude-code driver, exercised end to end against a scripted fake
 * `claude` binary on PATH. No live stack, no real CLI, no subscription quota:
 * the fake speaks the real stream-json protocol and really calls our MCP
 * server through the loopback bridge.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparabilityOf } from "../src/comparability";
import {
  AUTO_MEMORY_ENV,
  childEnv,
  claudeArgs,
  claudeMcpConfig,
  claudeSettings,
  detectLimit,
  mcpToolNames,
  runClaudeEpisode,
  thinkingEnv,
  toolCallLimitReached,
} from "../src/adapter-claude";
import { assembleContext } from "../src/context";
import { STUB_STAMP, isUnscoredDriver, loadRunConfig, unscoredStamp } from "../src/config";
import { CLAUDE_CODE_SYSTEM_PROMPT, SYSTEM_PROMPT, contextSentence } from "../src/prompt";
import { EpisodicLog } from "../src/episodic";
import { Workspace, renderWorkspaceContext } from "../src/workspace";
import { renderTimeline } from "../src/timeline";
import { TOOLS } from "../src/tools";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { harnessVersion, HARNESS_VERSION_FALLBACK } from "../src/version";
import { Watchdogs } from "../src/watchdogs";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-claude.ts");

function fakeSandbox(): SandboxHost {
  return {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

/** A directory holding an executable `claude` that runs the fixture. */
function fakeBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-fakebin-"));
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${FIXTURE} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return dir;
}

interface EpisodeSetup {
  runDir: string;
  recordPath: string;
  trajectory: Trajectory;
  options: Parameters<typeof runClaudeEpisode>[0];
}

function setupEpisode(
  mode: string,
  extraConfig: Record<string, unknown> = {},
  parentEnvExtra: Record<string, string> = {},
): EpisodeSetup {
  const runDir = mkdtempSync(join(tmpdir(), "wrathbench-claude-run-"));
  const recordPath = join(runDir, "record.json");
  const config = {
    ...loadRunConfig({
      driver: "claude-code",
      model: "opus",
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      ...extraConfig,
    }),
    runId: "run-test",
    token: "run-test",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({
    runId: "run-test",
    harnessVersion: "t",
    startedAt: Date.now(),
    config,
  });
  return {
    runDir,
    recordPath,
    trajectory,
    options: {
      config,
      runDir,
      sandbox: fakeSandbox(),
      workspace: new Workspace(join(runDir, "workspace")),
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      env: {
        PATH: `${fakeBinDir()}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "/tmp",
        // a key that must NOT reach the child
        ANTHROPIC_API_KEY: "sk-ant-must-not-be-used",
        AWS_BEARER_TOKEN_BEDROCK: "must-not-be-used",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-tests",
        WB_FAKE_MODE: mode,
        WB_FAKE_RECORD: recordPath,
        ...parentEnvExtra,
      },
    },
  };
}

/**
 * Whether a pid is gone, polled: a group SIGKILL reaches the grandchild a beat
 * after the driver returns, so a single check would race it. Use signal 0
 * rather than Linux-only /proc inspection so this test has the same meaning on
 * macOS, where the runner is developed and exercised.
 */
async function gone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive: boolean;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function readRecord(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("claude-code driver", () => {
  test("drives turns, round-trips a tool call through our MCP config, honours maxTurns", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 2 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });

    const record = readRecord(recordPath);
    // The same fixed prompt as the OpenAI loop except for one sentence: this
    // harness applies no context policy, so it must not tell the model its
    // conversation is being trimmed.
    expect(record["systemPrompt"]).toBe(CLAUDE_CODE_SYSTEM_PROMPT);
    expect(record["systemPrompt"]).not.toBe(SYSTEM_PROMPT);
    expect(record["systemPrompt"]).toContain(contextSentence("claude-code"));
    expect(record["systemPrompt"]).not.toContain("trimmed aggressively");
    // built-ins disabled; only our eleven tools granted
    expect(record["toolsFlag"]).toBe("");
    expect(record["allowedTools"]).toEqual(mcpToolNames());
    expect(record["strictMcpConfig"]).toBe(true);
    expect(record["inputFormat"]).toBe("stream-json");
    expect(record["outputFormat"]).toBe("stream-json");
    expect(record["model"]).toBe("opus");
    // our MCP server really answered tools/list over the loopback bridge
    expect(record["mcpTools"]).toEqual(TOOLS.map((t) => t.name));
    // the context message is the harness's, assembled by the fixed context machinery
    const userMessages = record["userMessages"] as string[];
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toContain("[turn 1]");
    expect(userMessages[0]).toContain("== state");
    // ...ending, as on the fixed loop, with the workspace listing and notes.md
    expect(userMessages[0]).toContain("<workspace>\n");
    expect(userMessages[0]!.endsWith('<notes path="notes.md" usage="0% 0/32000">\n</notes>')).toBe(true);

    // the tool call went to the runner's sandbox and is in the trajectory
    const records = readTrajectory(runDir);
    // The generated files: our server always loaded, and the compact hook named on argv.
    const driver = records.find((r) => r.t === "driver");
    expect(driver?.["settingsPath"]).toBe(join(runDir, "claude-settings.json"));
    expect((driver?.["args"] as string[]).includes("--settings")).toBe(true);
    const settings = JSON.parse(readFileSync(join(runDir, "claude-settings.json"), "utf8")) as {
      hooks: { SessionStart: { matcher: string; hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.SessionStart[0]!.matcher).toBe("compact");
    expect(settings.hooks.SessionStart[0]!.hooks[0]!.command).toContain(join(runDir, "workspace"));
    const mcp = JSON.parse(readFileSync(join(runDir, "claude-mcp.json"), "utf8")) as {
      mcpServers: Record<string, { alwaysLoad?: boolean }>;
    };
    expect(mcp.mcpServers["wrathbench"]?.alwaysLoad).toBe(true);
    const types = records.map((r) => r.t);
    expect(types).toContain("snippet");
    expect(types).toContain("snippet_result");
    expect(types.filter((t) => t === "request")).toHaveLength(2);
    const snippetResult = records.find((r) => r.t === "snippet_result");
    expect(snippetResult?.["text"]).toContain('ran:await sdk.say("turn 1")');
    // Appended after the call ran, so the call carries when it was dispatched:
    // a number no later than its own write time, and only on the call record.
    const toolCall = records.find((r) => r.t === "tool_call");
    const dispatchTs = toolCall?.["dispatchTs"];
    expect(typeof dispatchTs).toBe("number");
    expect(dispatchTs as number).toBeGreaterThan(0);
    expect(dispatchTs as number).toBeLessThanOrEqual(toolCall!.ts);
    expect(snippetResult?.["dispatchTs"]).toBeUndefined();
    const result = records.find((r) => r.t === "claude_result");
    expect(result?.["numTurns"]).toBe(2);
    // Both clocks: `duration_ms` covers the tool round trips too, and the
    // viewer prefers the API one when reading how fast the model wrote.
    expect(result?.["durationMs"]).toBe(12);
    expect(result?.["durationApiMs"]).toBe(7);
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("turn-limit");
    trajectory.close();
  }, 20_000);

  test("no trim notice is ever raised here: this harness runs no message window", async () => {
    // The documented asymmetry (docs/METHODOLOGY.md, "An episodic log, written
    // before each trim"): the CLI owns its own history, so there is no block
    // trim to announce and the model must never be told there was one.
    const { runDir, recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 4 });
    await runClaudeEpisode(options);
    for (const msg of readRecord(recordPath)["userMessages"] as string[]) {
      expect(msg).not.toContain("trim_pending");
      expect(msg).not.toContain("window_trimmed");
      expect(msg).not.toContain("will be trimmed");
    }
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "harness" && r["kind"] === "trim_pending")).toHaveLength(0);
    expect(records.filter((r) => r.t === "harness" && r["kind"] === "window_trimmed")).toHaveLength(0);
    trajectory.close();
  }, 20_000);

  test("a reflection window left open at the end of the episode is closed on the record", async () => {
    // The teardown counterpart of runLoop's finally. The fixture never reflects,
    // so the gate is opened directly on the builder the driver shares with the
    // tools; what is under test is that shutdown drains it either way.
    const { runDir, trajectory, options } = setupEpisode("tools", { maxTurns: 1 });
    await runClaudeEpisode(options);
    const windows = readTrajectory(runDir).filter((r) => r.t === "reflect_window");
    // Nothing opened one, so nothing may close one: the drain must not invent
    // a record for a window that never existed.
    expect(windows).toHaveLength(0);
    trajectory.close();
  }, 20_000);

  test("claudeArgs: a level is a flag, `none` is not", () => {
    const of = (effort?: string) =>
      claudeArgs({ mcpConfigPath: "/tmp/mcp.json", ...(effort !== undefined ? { effort } : {}) });
    expect(of("xhigh")).toContain("--effort");
    expect(of("xhigh")).toContain("xhigh");
    expect(of("none")).not.toContain("--effort");
    expect(of("none")).not.toContain("none");
    expect(of()).not.toContain("--effort");
  });

  test("a declared effort reaches the CLI as --effort; an undeclared one sends no flag", async () => {
    const plain = setupEpisode("tools", { maxTurns: 1 });
    await runClaudeEpisode(plain.options);
    expect(readRecord(plain.recordPath)["effort"]).toBeNull();
    expect(plain.options.config.effort).toBeUndefined();
    plain.trajectory.close();

    const low = setupEpisode("tools", { maxTurns: 1, effort: "low" });
    await runClaudeEpisode(low.options);
    expect(readRecord(low.recordPath)["effort"]).toBe("low");
    // and it is recorded as run identity, not just passed
    expect(readMeta(low.runDir)?.config.effort).toBe("low");
    expect(
      JSON.parse(String(low.trajectory.runRow("run-test")?.["config_json"])).effort,
    ).toBe("low");
    low.trajectory.close();
  }, 30_000);

  test("effort none is thinking off: no --effort, MAX_THINKING_TOKENS=0, and nothing else moves", async () => {
    const none = setupEpisode("tools", { maxTurns: 1, effort: "none" });
    await runClaudeEpisode(none.options);
    const record = readRecord(none.recordPath);
    // The CLI has no such level, so the flag stays off the line entirely.
    expect(record["effort"]).toBeNull();
    const env = record["env"] as Record<string, unknown>;
    expect(env["maxThinkingTokens"]).toBe("0");
    // Still the same lane, and still no API-key credential in there.
    expect(env["hasOauthToken"]).toBe(true);
    // The CLI's own memory is off: the workspace is the run's memory.
    expect(env["autoMemoryOff"]).toBe("1");
    expect(env["hasAnthropicApiKey"]).toBe(false);
    expect(env["hasAwsBearer"]).toBe(false);
    // And it is run identity like any other level: one more (model, effort) row.
    expect(readMeta(none.runDir)?.config.effort).toBe("none");
    expect(
      JSON.parse(String(none.trajectory.runRow("run-test")?.["config_json"])).effort,
    ).toBe("none");
    none.trajectory.close();

    // Every other level is untouched: the flag goes, the budget does not.
    const high = setupEpisode("tools", { maxTurns: 1, effort: "high" });
    await runClaudeEpisode(high.options);
    const other = readRecord(high.recordPath);
    expect(other["effort"]).toBe("high");
    expect((other["env"] as Record<string, unknown>)["maxThinkingTokens"]).toBeNull();
    high.trajectory.close();
  }, 30_000);

  test("the CLI's init word is promoted onto the run: meta.json, the tuple and the run row", async () => {
    const { runDir, trajectory, options } = setupEpisode("tools", { maxTurns: 1 });
    // Launched with a stamped tuple, the way run.ts launches one: the resolved
    // id is an annotation on it as well as a run field.
    trajectory.writeMeta({
      runId: "run-test",
      harnessVersion: "t",
      startedAt: Date.now(),
      config: options.config,
      comparability: comparabilityOf(options.config, "t"),
    });
    await runClaudeEpisode({
      ...options,
      extraEnv: { WB_FAKE_RESOLVED_MODEL: "claude-opus-5", WB_FAKE_CLI_VERSION: "2.1.239" },
    });

    // The run asked for the alias and was served an id: that is the fact no
    // page could read before, so it lands on all three of the run's records.
    const meta = readMeta(runDir);
    expect(meta?.config.model).toBe("opus");
    // No provider: the claude-code CLI names no backend, and a null there is the
    // honest answer rather than an absent key.
    expect(meta?.resolved).toEqual({ model: "claude-opus-5", cliVersion: "2.1.239", provider: null });
    expect(meta?.comparability?.resolvedModel).toBe("claude-opus-5");
    const row = trajectory.runRow("run-test");
    expect(row?.["model"]).toBe("opus");
    expect(row?.["resolved_model"]).toBe("claude-opus-5");
    expect(row?.["resolved_cli_version"]).toBe("2.1.239");
    // ...and exactly once, however many `system` envelopes the CLI sends.
    const promotions = readTrajectory(runDir).filter((r) => r["kind"] === "resolved_model");
    expect(promotions).toHaveLength(1);
    trajectory.close();
  }, 30_000);

  test("a CLI that ignores SIGTERM is killed with its MCP child, not orphaned", async () => {
    // A pause, deliberately: it is the path that does NOT call killClaude, so
    // shutdown() alone stands between the CLI and an orphan. Without the
    // escalation there, this hangs on `await proc.exited` forever.
    const { recordPath, trajectory, options } = setupEpisode("stubborn");
    const outcome = await runClaudeEpisode({ ...options, watchdogTickMs: 25, killGraceMs: 200 });
    expect(outcome.kind === "paused" && outcome.reason).toBe("quota-exhausted");

    const record = readRecord(recordPath);
    const pids = [record["pid"], record["mcpPid"]].filter((p): p is number => typeof p === "number");
    // the CLI itself and the MCP bridge it spawned — the grandchild is the one
    // that used to survive, reparented to init
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(await gone(pid)).toBe(true);
    trajectory.close();
  }, 30_000);

  test("the CLI's per-message usage lands on the response entry, in the shared shape", async () => {
    const { runDir, trajectory, options } = setupEpisode("tools", { maxTurns: 1 });
    await runClaudeEpisode(options);
    const response = readTrajectory(runDir).find((r) => r.t === "response");
    // input_tokens excludes both cache figures upstream; prompt_tokens includes
    // them, so a reader can subtract instead of guessing which convention it is.
    expect(response?.["usage"]).toEqual({
      prompt_tokens: 115,
      completion_tokens: 7,
      total_tokens: 122,
      cached_tokens: 100,
      cache_write_tokens: 3,
    });
    trajectory.close();
  }, 20_000);

  test("usage is counted once per API reply, from the LAST envelope of the message", async () => {
    const { runDir, trajectory, options } = setupEpisode("split-usage", { maxTurns: 1 });
    await runClaudeEpisode(options);
    const responses = readTrajectory(runDir).filter((r) => r.t === "response");
    // Two assistant envelopes (text + tool_use) share one message.id, so two
    // response entries are written and exactly one carries usage — the last,
    // whose running total is the whole reply. The fixture's envelopes report
    // 1 and then 7 output tokens for the same message.
    expect(responses).toHaveLength(2);
    const withUsage = responses.filter((r) => r["usage"] !== undefined);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toBe(responses[1]!);
    expect((withUsage[0]!["usage"] as { completion_tokens?: number }).completion_tokens).toBe(7);
    // Summing usage across response entries (what viewer/tail.ts does) equals a
    // single API call's tokens: not doubled, and not the partial first count.
    const sum = responses.reduce((acc, r) => {
      const u = r["usage"] as { total_tokens?: number } | undefined;
      return acc + (u?.total_tokens ?? 0);
    }, 0);
    expect(sum).toBe(122); // (12 + 3 + 100) + 7, counted once, from the last
    trajectory.close();
  }, 20_000);

  test("the spawned CLI never sees API-key credentials", async () => {
    const { recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 1 });
    await runClaudeEpisode(options);
    const env = readRecord(recordPath)["env"] as Record<string, unknown>;
    expect(env["hasAnthropicApiKey"]).toBe(false);
    expect(env["hasAwsBearer"]).toBe(false);
    expect(env["hasOauthToken"]).toBe(true);
    // The CLI's own memory is off: the workspace is the run's memory.
    expect(env["autoMemoryOff"]).toBe("1");
    // config dir is scratch, inside the run directory
    expect(String(env["configDir"])).toContain("claude-config");
    trajectory.close();
  }, 20_000);

  test("a usage-limit result pauses the run as quota-exhausted", async () => {
    const { trajectory, options } = setupEpisode("limit", { maxTurns: 3 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome.kind).toBe("paused");
    expect(outcome.kind === "paused" && outcome.reason).toBe("quota-exhausted");
    expect(outcome.kind === "paused" && outcome.detail).toContain("resets at");
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBe("quota-exhausted");
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBeNull();
    trajectory.close();
  }, 20_000);

  test("a usage-limit message on stderr with a non-zero exit also pauses", async () => {
    const { trajectory, options } = setupEpisode("limit-exit", { maxTurns: 3 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome.kind).toBe("paused");
    expect(outcome.kind === "paused" && outcome.reason).toBe("quota-exhausted");
    trajectory.close();
  }, 20_000);

  test("model output about in-game limits never pauses the run", async () => {
    const { trajectory, options } = setupEpisode("chatty-limit", { maxTurns: 1 });
    const outcome = await runClaudeEpisode(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "1 turns" });
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBeNull();
    trajectory.close();
  }, 20_000);

  test("a watchdog fires DURING a turn, records the reason, and kills the CLI", async () => {
    const { runDir, trajectory, options } = setupEpisode("long-turn", {
      watchdogs: { episodeMs: 300 },
    });
    const started = Date.now();
    const outcome = await runClaudeEpisode({ ...options, watchdogTickMs: 25, killGraceMs: 200 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("episode-limit");
    // it did not wait for the turn to finish: the fake would have run for minutes
    expect(Date.now() - started).toBeLessThan(15_000);
    const records = readTrajectory(runDir);
    // the named reason is in the trajectory, and it is recorded before nothing
    expect(records.find((r) => r.t === "watchdog")?.["reason"]).toBe("episode-limit");
    expect(records.filter((r) => r.t === "termination")).toHaveLength(1);
    expect(records.find((r) => r.t === "termination")?.["reason"]).toBe("episode-limit");
    // and it happened inside a single driver turn
    expect(records.filter((r) => r.t === "request")).toHaveLength(1);
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("episode-limit");
    trajectory.close();
  }, 30_000);

  test("the tool-call ceiling bounds the CLI's inner loop", async () => {
    const { runDir, trajectory, options } = setupEpisode("long-turn", {
      maxToolCallsPerEpisode: 3,
    });
    const outcome = await runClaudeEpisode({ ...options, watchdogTickMs: 50, killGraceMs: 200 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("tool-call-limit");
    expect(outcome.kind === "terminated" && outcome.detail).toContain("cap 3");
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "snippet")).toHaveLength(3);
    expect(records.find((r) => r.t === "limit")?.["kind"]).toBe("tool-call-limit");
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("tool-call-limit");
    trajectory.close();
  }, 30_000);

  test("at the ceiling, further tool calls are refused rather than executed", async () => {
    // cap 1: one call runs, the next is refused with an explicit result — the
    // same path the real CLI hits while it is being torn down.
    const { runDir, trajectory, options } = setupEpisode("long-turn", { maxToolCallsPerEpisode: 1 });
    const outcome = await runClaudeEpisode({ ...options, watchdogTickMs: 50, killGraceMs: 200 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("tool-call-limit");
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "snippet")).toHaveLength(1);
    trajectory.close();
  }, 30_000);

  test("a null ceiling is no ceiling: the branch the guard takes never trips", () => {
    // The predicate the enforcement branch reads, tested directly. A run with
    // the cap off cannot be driven past it end to end in a test — proving it
    // means letting the fake CLI make more calls than the ceiling it no longer
    // has — so the branch itself is pinned here and the cap-1/cap-3 cases above
    // keep covering the finite path all the way through the driver.
    expect(toolCallLimitReached(0, null)).toBe(false);
    expect(toolCallLimitReached(500, null)).toBe(false);
    expect(toolCallLimitReached(1_000_000, null)).toBe(false);
    // A finite ceiling is unchanged: it trips at the cap, not before it.
    expect(toolCallLimitReached(2, 3)).toBe(false);
    expect(toolCallLimitReached(3, 3)).toBe(true);
    expect(toolCallLimitReached(4, 3)).toBe(true);
  });

  test("with the ceiling off, a long turn ends on its watchdog and never on tool-call-limit", async () => {
    // The live shape: fleet-sub-opus-low-freeplay-opus-low-20260825-a6 sat at
    // 410/500 and would have terminated `tool-call-limit`, after which the
    // fleet starts a fresh level-1 character. With the ceiling off the session
    // keeps running and the idle/episode watchdogs are what stop it — which is
    // the point: this removes one automatic reset, not every stop.
    const { runDir, trajectory, options } = setupEpisode("long-turn", {
      maxToolCallsPerEpisode: null,
      watchdogs: { episodeMs: 600 },
    });
    const outcome = await runClaudeEpisode({ ...options, watchdogTickMs: 25, killGraceMs: 200 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("episode-limit");
    const records = readTrajectory(runDir);
    // It really did dispatch tools: the guard ran and let every one of them by.
    expect(records.filter((r) => r.t === "snippet").length).toBeGreaterThan(0);
    expect(records.filter((r) => r.t === "limit")).toHaveLength(0);
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("episode-limit");
    trajectory.close();
  }, 30_000);

  test("a watchdog mid-turn winds the CLI down: the closing result lands, tools stay refused", async () => {
    // The defect this exists for: the whole episode is one CLI turn, and
    // SIGTERM at the watchdog threw away the only record that carries finished
    // output tokens and the metered cost.
    const { runDir, recordPath, trajectory, options } = setupEpisode("wind-down", {
      watchdogs: { episodeMs: 300 },
    });
    const outcome = await runClaudeEpisode({
      ...options,
      watchdogTickMs: 25,
      killGraceMs: 200,
      windDownGraceMs: 10_000,
    });
    // The termination is unchanged: same reason, once, and recorded BEFORE the
    // wind-down rather than after it.
    expect(outcome.kind === "terminated" && outcome.reason).toBe("episode-limit");
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "termination")).toHaveLength(1);
    expect(records.find((r) => r.t === "termination")?.["reason"]).toBe("episode-limit");
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("episode-limit");

    // ...and the figures the kill used to destroy are on disk.
    const result = records.find((r) => r.t === "claude_result");
    expect(result).toBeDefined();
    expect((result?.["usageRaw"] as { output_tokens?: number }).output_tokens).toBe(20_000);
    expect(result?.["costUsd"]).toBe(1.25);
    expect(result?.["durationApiMs"]).toBe(2_121);

    // The wind-down is visible, and it ended on the result rather than the clock.
    const wind = records.filter((r) => r.t === "wind-down");
    expect(wind).toHaveLength(1);
    expect(wind[0]?.["outcome"]).toBe("result");
    expect(wind[0]?.["reason"]).toBe("episode-limit");
    expect(wind[0]?.["graceMs"]).toBe(10_000);

    // Ordering: termination first, then the result, then the wind-down record.
    const at = (t: string): number => records.findIndex((r) => r.t === t);
    expect(at("termination")).toBeLessThan(at("claude_result"));
    expect(at("claude_result")).toBeLessThan(at("wind-down"));

    // CONTRACTS: nothing reached the game after the termination. Asserted on
    // what the CLI was handed rather than on trajectory order — a dispatch that
    // passed the check a moment before the watchdog can still land after the
    // termination record — so the property is monotonic refusal: once one call
    // is refused, every later one is too, and none of them ran.
    const results = readRecord(recordPath)["toolResults"] as {
      isError?: boolean;
      content?: { text?: string }[];
    }[];
    const textOf = (r: { content?: { text?: string }[] }): string => r.content?.[0]?.text ?? "";
    const first = results.findIndex((r) => r.isError === true && textOf(r).includes("episode is over"));
    expect(first).toBeGreaterThanOrEqual(0);
    for (const r of results.slice(first)) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("Stop calling tools and end your turn now");
      expect(textOf(r)).not.toContain("ran:");
    }
    trajectory.close();
  }, 30_000);

  test("a CLI that ignores the refusal is killed when the grace expires", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("wind-down-deaf", {
      watchdogs: { episodeMs: 300 },
    });
    const started = Date.now();
    const outcome = await runClaudeEpisode({
      ...options,
      watchdogTickMs: 25,
      killGraceMs: 200,
      windDownGraceMs: 400,
    });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("episode-limit");
    // Bounded: the grace is a bound, not a wait for a CLI that never stops.
    expect(Date.now() - started).toBeLessThan(15_000);
    const records = readTrajectory(runDir);
    const wind = records.filter((r) => r.t === "wind-down");
    expect(wind).toHaveLength(1);
    expect(wind[0]?.["outcome"]).toBe("grace-expired");
    expect(Number(wind[0]?.["waitedMs"])).toBeGreaterThanOrEqual(300);
    // No result was ever emitted, so nothing pretends one was.
    expect(records.filter((r) => r.t === "claude_result")).toHaveLength(0);
    expect(records.filter((r) => r.t === "termination")).toHaveLength(1);
    // and it kept being refused the whole way down
    const results = readRecord(recordPath)["toolResults"] as {
      isError?: boolean;
      content?: { text?: string }[];
    }[];
    const last = results[results.length - 1];
    expect(last?.isError).toBe(true);
    expect(last?.content?.[0]?.text ?? "").toContain("The episode is over");
    // the CLI and its MCP child are gone regardless
    const record = readRecord(recordPath);
    for (const pid of [record["pid"], record["mcpPid"]].filter((x): x is number => typeof x === "number")) {
      expect(await gone(pid)).toBe(true);
    }
    trajectory.close();
  }, 30_000);

  test("windDownGraceMs 0 keeps the old immediate kill, and an operator stop always does", async () => {
    // The ceiling with no grace: killed at once, no wind-down record.
    const off = setupEpisode("wind-down-deaf", { maxToolCallsPerEpisode: 2 });
    const outcome = await runClaudeEpisode({
      ...off.options,
      watchdogTickMs: 50,
      killGraceMs: 200,
      windDownGraceMs: 0,
    });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("tool-call-limit");
    expect(readTrajectory(off.runDir).filter((r) => r.t === "wind-down")).toHaveLength(0);
    off.trajectory.close();

    // An operator stop is intent, not a measurement opportunity: it kills now.
    const stop = setupEpisode("wind-down", {});
    const abort = new AbortController();
    setTimeout(() => abort.abort("SIGTERM"), 300);
    const stopped = await runClaudeEpisode({
      ...stop.options,
      signal: abort.signal,
      watchdogTickMs: 50,
      killGraceMs: 200,
      windDownGraceMs: 10_000,
    });
    expect(stopped).toEqual({ kind: "terminated", reason: "manual", detail: "SIGTERM" });
    expect(readTrajectory(stop.runDir).filter((r) => r.t === "wind-down")).toHaveLength(0);
    stop.trajectory.close();
  }, 40_000);

  test("the world is sampled on the clock during a long turn, not once per turn", async () => {
    const { runDir, trajectory, options } = setupEpisode("long-turn", {
      maxToolCallsPerEpisode: 12,
      stateIntervalMs: 1,
    });
    await runClaudeEpisode({ ...options, watchdogTickMs: 20, killGraceMs: 200 });
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "request")).toHaveLength(1); // one driver turn
    expect(records.filter((r) => r.t === "state").length).toBeGreaterThan(1);
    expect(trajectory.stateRows("run-test").length).toBeGreaterThan(1);
    trajectory.close();
  }, 30_000);

  test("aborting the episode finalises it as manual", async () => {
    const { runDir, trajectory, options } = setupEpisode("long-turn", {});
    const abort = new AbortController();
    setTimeout(() => abort.abort("SIGTERM"), 300);
    const outcome = await runClaudeEpisode({
      ...options,
      signal: abort.signal,
      watchdogTickMs: 50,
      killGraceMs: 200,
    });
    expect(outcome).toEqual({ kind: "terminated", reason: "manual", detail: "SIGTERM" });
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "termination")).toHaveLength(1);
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("manual");
    trajectory.close();
  }, 30_000);

  test("a stop request carrying a pause suspends the episode as operator-pause and tears the CLI down", async () => {
    const { runDir, trajectory, options } = setupEpisode("long-turn", {});
    const abort = new AbortController();
    setTimeout(() => abort.abort({ kind: "pause", reason: "operator-pause", detail: "SIGTERM: supervisor stop" }), 300);
    const outcome = await runClaudeEpisode({
      ...options,
      signal: abort.signal,
      watchdogTickMs: 50,
      killGraceMs: 200,
    });
    expect(outcome).toEqual({ kind: "paused", reason: "operator-pause", detail: "SIGTERM: supervisor stop" });
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "termination")).toHaveLength(0);
    const pauses = records.filter((r) => r.t === "pause");
    expect(pauses).toHaveLength(1);
    expect(typeof pauses[0]?.["episodeElapsedMs"]).toBe("number");
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBe("operator-pause");
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBeNull();
    trajectory.close();
  }, 30_000);

  test("claudeArgs uses only flags that exist, and never invents --max-turns", () => {
    const args = claudeArgs({ mcpConfigPath: "/tmp/x.json", model: "opus" });
    expect(args.slice(0, 2)).toEqual(["-p", "--verbose"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--max-turns");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--settings");
    const withSettings = claudeArgs({ mcpConfigPath: "/tmp/x.json", settingsPath: "/runs/x/claude-settings.json" });
    expect(withSettings[withSettings.indexOf("--settings") + 1]).toBe("/runs/x/claude-settings.json");
    // The grant is every tool the server lists: eleven of them.
    expect(mcpToolNames()).toHaveLength(11);
  });
});

describe("the workspace on the claude-code driver", () => {
  test("our MCP server is always loaded, never deferred behind the CLI's tool search", () => {
    expect(claudeMcpConfig({ bunBin: "/usr/bin/bun", bridgePath: "/r/mcp-bridge.ts", port: 4242 })).toEqual({
      mcpServers: { wrathbench: { command: "/usr/bin/bun", args: ["/r/mcp-bridge.ts", "4242"], alwaysLoad: true } },
    });
  });

  test("the CLI's automatic memory is off, whatever the parent environment says", () => {
    expect(childEnv({ PATH: "/usr/bin" }, { configDir: "/c" })[AUTO_MEMORY_ENV]).toBe("1");
    expect(childEnv({ [AUTO_MEMORY_ENV]: "0" }, { configDir: "/c", extra: { [AUTO_MEMORY_ENV]: "0" } })[AUTO_MEMORY_ENV]).toBe("1");
  });

  test("a SessionStart hook with the compact matcher reprints the workspace block, byte for byte", async () => {
    const ws = new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-hook-")), "work space's"));
    ws.write("notes.md", "# plan\n- it's west\n");
    ws.write("lib/nav.ts", "// helpers\nexport {};\n");
    const script = join(import.meta.dir, "..", "src", "workspace.ts");
    const settings = claudeSettings({ bunBin: process.execPath, workspaceScript: script, workspaceDir: ws.dir }) as {
      hooks: { SessionStart: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0]!.matcher).toBe("compact");
    const hook = settings.hooks.SessionStart[0]!.hooks[0]!;
    expect(hook.type).toBe("command");
    // The CLI runs the command through a shell; quoting survives a quote in the path.
    const proc = Bun.spawn(["sh", "-c", hook.command], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toBe(`${renderWorkspaceContext(ws.view())}\n`);
    // The same bytes the turn's context message ends with.
    const context = assembleContext({ stateSummary: "== s ==", events: [], workspace: ws.view(), notices: [], turn: 1 });
    expect(context.endsWith(out.trimEnd())).toBe(true);
    // Read-only: nothing in the workspace changed.
    expect(ws.readNotes()).toBe("# plan\n- it's west\n");
  });
});

describe("detectLimit", () => {
  test("recognises the CLI's limit shapes and parses the reset epoch", () => {
    const epoch = detectLimit("Claude AI usage limit reached|1780000000");
    expect(epoch?.reason).toBe("quota-exhausted");
    expect(epoch?.detail).toContain(new Date(1780000000 * 1000).toISOString());
    expect(detectLimit("You've hit your 5-hour limit. Your limit resets at 3pm.")?.reason).toBe(
      "quota-exhausted",
    );
    expect(detectLimit("ordinary assistant text about limits of the sandbox")).toBeNull();
    expect(detectLimit(undefined)).toBeNull();
  });
});

describe("childEnv", () => {
  test("drops every billing credential and keeps the subscription token", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        ANTHROPIC_AUTH_TOKEN: "t",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        AWS_BEARER_TOKEN_BEDROCK: "b",
        GOOGLE_APPLICATION_CREDENTIALS: "/g.json",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        CLAUDE_CODE_OAUTH_TOKEN_2: "other-subscription",
        // Not a billing credential, dropped for a different reason: the runner
        // and fleet services carry it for the gate's fixture staging, and root
        // on acore_characters is the shortcut docs/CONTRACTS.md forbids.
        WRATHBENCH_DB_PASSWORD: "must-not-leak",
        WRATHBENCH_TOKEN: "keep",
        UNRELATED: "keep",
      },
      { configDir: "/runs/x/claude-config" },
    );
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["AWS_BEARER_TOKEN_BEDROCK"]).toBeUndefined();
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth");
    // The other subscription's token is not in the child's environment at all.
    expect(env["CLAUDE_CODE_OAUTH_TOKEN_2"]).toBeUndefined();
    expect(env["WRATHBENCH_DB_PASSWORD"]).toBeUndefined();
    expect(env["WRATHBENCH_TOKEN"]).toBe("keep");
    expect(env["UNRELATED"]).toBe("keep");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/runs/x/claude-config");
  });

  test("the thinking budget comes from the run's effort, never from the shell", () => {
    const parent = { PATH: "/usr/bin", MAX_THINKING_TOKENS: "31999", CLAUDE_CODE_OAUTH_TOKEN: "oauth" };
    // An operator's variable is not a run dimension anybody recorded.
    expect(childEnv(parent, { configDir: "/c" })["MAX_THINKING_TOKENS"]).toBeUndefined();
    // `effort: "none"` is the one thing that sets it.
    expect(
      childEnv(parent, { configDir: "/c", extra: thinkingEnv("none") })["MAX_THINKING_TOKENS"],
    ).toBe("0");
    expect(thinkingEnv("high")).toEqual({});
    expect(thinkingEnv(undefined)).toEqual({});
  });

  test("a second subscription lane arrives under the one name the CLI knows", () => {
    const parent = {
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "first-subscription",
      CLAUDE_CODE_OAUTH_TOKEN_2: "second-subscription",
      OPENROUTER_KEY: "not-a-claude-credential",
    };
    const env = childEnv(parent, { configDir: "/runs/x/claude-config", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("second-subscription");
    expect(env["CLAUDE_CODE_OAUTH_TOKEN_2"]).toBeUndefined();
    // Nothing about the lane changes the rest of the environment.
    expect(env["OPENROUTER_KEY"]).toBe("not-a-claude-credential");
    // And the default lane still means the default variable.
    expect(childEnv(parent, { configDir: "/c" })["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("first-subscription");
  });

  test("an empty chosen lane leaves the CLI with no token to bill", () => {
    const env = childEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: "first-subscription" },
      { configDir: "/c", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_2" },
    );
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
  });
});

describe("driver selection and stamping", () => {
  test("config defaults to the openai driver and refuses the former spellings by name", () => {
    expect(loadRunConfig({}).driver).toBe("openai");
    expect(loadRunConfig({ driver: "stub" }).driver).toBe("stub");
    expect(loadRunConfig({ driver: "claude-code" }).driver).toBe("claude-code");
    // The former shapes are errors that name the current one, never aliases.
    expect(() => loadRunConfig({ driver: "claude-subscription" })).toThrow(/claude-code/);
    expect(() => loadRunConfig({ adapter: "stub" })).toThrow(/the current shape is driver/);
    // A file that wrote the duplicate key reads its driver; the duplicate is dropped.
    const both = loadRunConfig({ driver: "stub", adapter: "stub" }) as Record<string, unknown>;
    expect(both["driver"]).toBe("stub");
    expect("adapter" in both).toBe(false);
    // The claude-code harness scores; only the stub never does.
    expect(isUnscoredDriver("claude-code")).toBe(false);
    expect(isUnscoredDriver("openai")).toBe(false);
    expect(isUnscoredDriver("stub")).toBe(true);
    expect(unscoredStamp("claude-code")).toBeUndefined();
  });

  test("every effort level parses, `none` included, and an invented one does not", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(loadRunConfig({ effort }).effort).toBe(effort);
    }
    // Absent is not a level: it is the provider's own default.
    expect(loadRunConfig({}).effort).toBeUndefined();
    expect(() => loadRunConfig({ effort: "off" })).toThrow();
  });

  test("meta, sqlite and the timeline carry the stub stamp; a claude-code run carries none", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-stamp-"));
    const config = loadRunConfig({ driver: "stub", stubScript: "x.json" });
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({
      runId: "run-stamp",
      harnessVersion: "t",
      startedAt: Date.now(),
      config,
      shakeout: STUB_STAMP,
    });
    const row = trajectory.runRow("run-stamp");
    expect(row?.["driver"]).toBe("stub");
    expect(row?.["shakeout"]).toBe(STUB_STAMP);
    trajectory.close();

    expect(readMeta(dir)?.shakeout).toBe(STUB_STAMP);
    const rendered = renderTimeline(dir, "run-stamp");
    expect(rendered).toContain("NOT A SCORED RESULT");
    expect(rendered).toContain("driver:     stub");

    // A claude-code run carries no stamp and renders as a score.
    const cc = mkdtempSync(join(tmpdir(), "wrathbench-ccstamp-"));
    const t2 = new Trajectory(cc);
    t2.writeMeta({
      runId: "run-cc",
      harnessVersion: "t",
      startedAt: Date.now(),
      config: loadRunConfig({ driver: "claude-code", model: "opus" }),
    });
    t2.close();
    const ccRendered = renderTimeline(cc, "run-cc");
    expect(ccRendered).not.toContain("NOT A SCORED RESULT");
    expect(ccRendered).toContain("driver:     claude-code");
  });

  /** Spawn run.ts against the fake CLI, deliver `sig` mid-turn, return what it left behind. */
  async function stopMidTurn(sig: "SIGTERM" | "SIGINT"): Promise<{ dir: string; runId: string; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-sigterm-"));
    const cwd = mkdtempSync(join(tmpdir(), "wrathbench-sigterm-cwd-"));
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "src", "run.ts"),
        "--driver",
        "claude-code",
        "--model",
        "x",
        "--runs-dir",
        dir,
        "--max-tool-calls",
        "100000",
        // nothing is listening: the sandbox only dials on connect(), which the
        // fake never asks for
        "--module-url",
        "http://127.0.0.1:9",
      ],
      cwd,
      env: {
        PATH: `${fakeBinDir()}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "/tmp",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-tests",
        WB_FAKE_MODE: "long-turn",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    // let it get into the turn and run some tool calls
    await new Promise((r) => setTimeout(r, 2_500));
    proc.kill(sig);
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const runId = readdirSync(dir).find((d) => d.startsWith("run-"));
    expect(runId).toBeDefined();
    return { dir, runId: runId!, stderr };
  }

  test("an externally delivered SIGTERM pauses the run as operator-pause", async () => {
    const { dir, runId, stderr } = await stopMidTurn("SIGTERM");
    expect(stderr).toContain("SIGTERM: pausing run as `operator-pause`");
    const runDir = join(dir, runId);
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "termination")).toHaveLength(0);
    const pauses = records.filter((r) => r.t === "pause");
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.["reason"]).toBe("operator-pause");
    expect(typeof pauses[0]?.["episodeElapsedMs"]).toBe("number");
    const trajectory = new Trajectory(runDir);
    expect(trajectory.runRow(runId)?.["pause_reason"]).toBe("operator-pause");
    expect(trajectory.runRow(runId)?.["termination_reason"]).toBeNull();
    trajectory.close();
    // The pause mark in meta.json is what a supervisor resumes from.
    const meta = readMeta(runDir);
    expect(meta?.pause?.reason).toBe("operator-pause");
    expect(meta?.pause?.episodeElapsedMs).toBeGreaterThan(0);
    expect(meta?.pause?.episodeElapsedMs).toBeLessThan(60_000);
  }, 40_000);

  test("an externally delivered SIGINT (Ctrl-C) still finalises the run as manual", async () => {
    const { dir, runId, stderr } = await stopMidTurn("SIGINT");
    expect(stderr).toContain("SIGINT: terminating run as `manual`");
    const runDir = join(dir, runId);
    const terminations = readTrajectory(runDir).filter((r) => r.t === "termination");
    expect(terminations).toHaveLength(1);
    expect(terminations[0]?.["reason"]).toBe("manual");
    const trajectory = new Trajectory(runDir);
    expect(trajectory.runRow(runId)?.["termination_reason"]).toBe("manual");
    expect(trajectory.runRow(runId)?.["ended_at"]).not.toBeNull();
    expect(readMeta(runDir)?.pause).toBeUndefined();
    trajectory.close();
  }, 40_000);

  test("run.ts refuses to start the claude driver without the OAuth token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-refuse-"));
    const env = { ...process.env };
    delete env["CLAUDE_CODE_OAUTH_TOKEN"];
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "src", "run.ts"),
        "--driver",
        "claude-code",
        "--model",
        "opus",
        "--runs-dir",
        dir,
      ],
      // a cwd without a .env: Bun auto-loads one, and the repo's has the token
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(stderr).toContain("claude setup-token");
  }, 20_000);

  test("the refusal names the chosen subscription lane, not the default one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-refuse-lane-"));
    const env = { ...process.env };
    // The DEFAULT lane is present and the chosen one is not: a run that read
    // the wrong variable would launch here instead of refusing.
    env["CLAUDE_CODE_OAUTH_TOKEN"] = "first-subscription";
    delete env["CLAUDE_CODE_OAUTH_TOKEN_2"];
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "src", "run.ts"),
        "--driver",
        "claude-code",
        "--model",
        "opus",
        "--token-env",
        "CLAUDE_CODE_OAUTH_TOKEN_2",
        "--runs-dir",
        dir,
      ],
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("$CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN_2=...");
  }, 20_000);

  test("run.ts refuses the former --adapter spelling by name, rather than ignoring it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-refuse-adapter-"));
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "src", "run.ts"),
        "--adapter",
        "stub",
        "--runs-dir",
        dir,
      ],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toContain("--adapter");
    expect(stderr).toContain("--driver");
  }, 20_000);
});

describe("harnessVersion", () => {
  test("prefers WRATHBENCH_HARNESS_VERSION when set", () => {
    expect(harnessVersion({ WRATHBENCH_HARNESS_VERSION: "0.0.0-phase0+gdeadbee-dirty" })).toBe(
      "0.0.0-phase0+gdeadbee-dirty",
    );
    // blank is not a version
    const fallback = harnessVersion({ WRATHBENCH_HARNESS_VERSION: "  " });
    expect(fallback === HARNESS_VERSION_FALLBACK || fallback.startsWith("0.0.0-phase0+g")).toBe(true);
  });
});
