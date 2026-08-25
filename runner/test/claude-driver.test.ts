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
import { childEnv, claudeArgs, detectLimit, mcpToolNames, runClaudeEpisode } from "../src/adapter-claude";
import { STUB_STAMP, isUnscoredDriver, loadRunConfig, unscoredStamp } from "../src/config";
import { SYSTEM_PROMPT } from "../src/prompt";
import { Scratchpad } from "../src/scratchpad";
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
      scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
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
 * after the driver returns, so a single check would race it. A pid that has
 * exited but not been reaped answers signal 0 while it is a zombie, hence the
 * kernel-state read rather than kill(pid, 0) alone.
 */
async function gone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive: boolean;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      alive = state !== "Z";
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
    // the SAME fixed prompt as the OpenAI loop, byte for byte
    expect(record["systemPrompt"]).toBe(SYSTEM_PROMPT);
    // built-ins disabled; only our six tools granted
    expect(record["toolsFlag"]).toBe("");
    expect(record["allowedTools"]).toEqual(mcpToolNames());
    expect(record["strictMcpConfig"]).toBe(true);
    expect(record["inputFormat"]).toBe("stream-json");
    expect(record["outputFormat"]).toBe("stream-json");
    expect(record["model"]).toBe("opus");
    // our MCP server really answered tools/list over the loopback bridge
    expect(record["mcpTools"]).toEqual(TOOLS.map((t) => t.name));
    // the context message is the harness's, assembled by ADR-0012 machinery
    const userMessages = record["userMessages"] as string[];
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toContain("[turn 1]");
    expect(userMessages[0]).toContain("== state");

    // the tool call went to the runner's sandbox and is in the trajectory
    const records = readTrajectory(runDir);
    const types = records.map((r) => r.t);
    expect(types).toContain("snippet");
    expect(types).toContain("snippet_result");
    expect(types.filter((t) => t === "request")).toHaveLength(2);
    const snippetResult = records.find((r) => r.t === "snippet_result");
    expect(snippetResult?.["text"]).toContain('ran:await sdk.say("turn 1")');
    const result = records.find((r) => r.t === "claude_result");
    expect(result?.["numTurns"]).toBe(2);
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("turn-limit");
    trajectory.close();
  }, 20_000);

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
    expect(env["WRATHBENCH_DB_PASSWORD"]).toBeUndefined();
    expect(env["WRATHBENCH_TOKEN"]).toBe("keep");
    expect(env["UNRELATED"]).toBe("keep");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/runs/x/claude-config");
  });
});

describe("driver selection and stamping", () => {
  test("config defaults to the openai driver and refuses pre-0.4 spellings by name", () => {
    expect(loadRunConfig({}).driver).toBe("openai");
    expect(loadRunConfig({ driver: "stub" }).driver).toBe("stub");
    expect(loadRunConfig({ driver: "claude-code" }).driver).toBe("claude-code");
    // Pre-0.4 shapes are errors that name the 0.4 shape, never aliases.
    expect(() => loadRunConfig({ driver: "claude-subscription" })).toThrow(/claude-code/);
    expect(() => loadRunConfig({ adapter: "stub" })).toThrow(/the 0\.4 shape is driver/);
    // A 0.4 file that wrote the duplicate key reads its driver; the duplicate is dropped.
    const both = loadRunConfig({ driver: "stub", adapter: "stub" }) as Record<string, unknown>;
    expect(both["driver"]).toBe("stub");
    expect("adapter" in both).toBe(false);
    // The claude-code harness scores; only the stub never does.
    expect(isUnscoredDriver("claude-code")).toBe(false);
    expect(isUnscoredDriver("openai")).toBe(false);
    expect(isUnscoredDriver("stub")).toBe(true);
    expect(unscoredStamp("claude-code")).toBeUndefined();
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

  test("an externally delivered SIGTERM pauses the run as operator-pause (ADR-0036)", async () => {
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
