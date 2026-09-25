/**
 * The codex driver, exercised end to end against a scripted fake `codex`
 * binary on PATH. No live stack, no real CLI, no subscription quota: the fake
 * speaks the real `codex exec --json` event protocol, exits per turn and
 * honours `exec resume`, and really calls our MCP server through the loopback
 * bridge.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BILLING_ENV_EXACT,
  CODEX_EFFORTS,
  DISABLED_FEATURES,
  childEnv,
  codexArgs,
  codexEffortRefusal,
  detectCodexFailure,
  laneLooksLoggedIn,
  normalizeCodexUsage,
  parseCodexEvent,
  runCodexEpisode,
  tomlString,
} from "../src/adapter-codex";
import { comparabilityOf, harnessOfRun } from "../src/comparability";
import { HARNESSES, harnessOf, isUnscoredDriver, loadRunConfig, unscoredStamp } from "../src/config";
import { CLAUDE_CODE_SYSTEM_PROMPT, CODEX_SYSTEM_PROMPT, SYSTEM_PROMPT, buildSystemPrompt, contextSentence } from "../src/prompt";
import { EpisodicLog } from "../src/episodic";
import { Scratchpad } from "../src/scratchpad";
import { TOOLS } from "../src/tools";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex.ts");
const SAMPLE = join(import.meta.dir, "fixtures", "codex-exec-sample.jsonl");

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

/** A directory holding an executable `codex` that runs the fixture. */
function fakeBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-fakebin-"));
  const path = join(dir, "codex");
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${FIXTURE} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return dir;
}

/** A lane directory that looks logged in: the CLI keeps its login in auth.json there. */
function fakeCodexHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-codex-home-"));
  writeFileSync(join(dir, "auth.json"), '{"auth_mode":"chatgpt","tokens":{"access_token":"fake"}}\n', "utf8");
  return dir;
}

interface EpisodeSetup {
  runDir: string;
  recordPath: string;
  codexHome: string;
  trajectory: Trajectory;
  options: Parameters<typeof runCodexEpisode>[0];
}

function setupEpisode(
  mode: string,
  extraConfig: Record<string, unknown> = {},
  parentEnvExtra: Record<string, string> = {},
): EpisodeSetup {
  const runDir = mkdtempSync(join(tmpdir(), "wrathbench-codex-run-"));
  const recordPath = join(runDir, "record.json");
  const codexHome = fakeCodexHome();
  const config = {
    ...loadRunConfig({
      driver: "codex",
      model: "gpt-5.5",
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      ...extraConfig,
    }),
    runId: "run-test",
    token: "run-test",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  return {
    runDir,
    recordPath,
    codexHome,
    trajectory,
    options: {
      config,
      runDir,
      sandbox: fakeSandbox(),
      scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      env: {
        PATH: `${fakeBinDir()}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"] ?? "/tmp",
        CODEX_HOME: codexHome,
        // credentials that must NOT reach the child
        OPENAI_API_KEY: "sk-must-not-be-used",
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
        CODEX_API_KEY: "must-not-be-used",
        CODEX_ACCESS_TOKEN: "must-not-be-used",
        CODEX_HOME_2: "/other/lane",
        ANTHROPIC_API_KEY: "sk-ant-must-not-be-used",
        AWS_BEARER_TOKEN_BEDROCK: "must-not-be-used",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-be-used",
        WRATHBENCH_DB_PASSWORD: "must-not-leak",
        WB_FAKE_MODE: mode,
        WB_FAKE_RECORD: recordPath,
        ...parentEnvExtra,
      },
    },
  };
}

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

describe("codex driver", () => {
  test("drives turns as exec then exec resume, round-trips a tool call over MCP, honours maxTurns", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 2 });
    const outcome = await runCodexEpisode(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });

    const record = readRecord(recordPath);
    // One process per turn: the first is `exec`, the second `exec resume <thread>`.
    const argvs = record["argvs"] as string[][];
    expect(argvs).toHaveLength(2);
    expect(argvs[0]!.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(argvs[1]!.slice(0, 3)).toEqual(["exec", "resume", "fake-thread"]);
    expect(record["threadArgs"]).toEqual([null, "fake-thread"]);
    // The fixed prompt REPLACES the CLI's base instructions, via a file in the run dir.
    expect(String(record["instructionsPath"])).toContain(runDir);
    expect(record["instructions"]).toBe(CODEX_SYSTEM_PROMPT);
    expect(record["instructions"]).not.toBe(SYSTEM_PROMPT);
    expect(record["instructions"]).not.toContain("trimmed aggressively");
    // The flag set the header promises.
    expect(record["json"]).toBe(true);
    expect(record["ignoreUserConfig"]).toBe(true);
    expect(record["skipGitRepoCheck"]).toBe(true);
    expect(record["promptPositional"]).toBe("-");
    expect(record["model"]).toBe("gpt-5.5");
    expect(record["sandboxMode"]).toBe("read-only");
    expect(record["approvalPolicy"]).toBe("never");
    expect(record["webSearch"]).toBe("disabled");
    expect(record["mcpApproval"]).toBe("approve");
    expect(record["disabled"]).toEqual([...DISABLED_FEATURES]);
    // our MCP server really answered tools/list over the loopback bridge
    expect(record["mcpTools"]).toEqual(TOOLS.map((t) => t.name));
    // the context message is the harness's, delivered on stdin
    const userMessages = record["userMessages"] as string[];
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toContain("[turn 1]");
    expect(userMessages[0]).toContain("== state");
    expect(userMessages[1]).toContain("[turn 2]");

    const records = readTrajectory(runDir);
    const types = records.map((r) => r.t);
    expect(types).toContain("snippet");
    expect(types).toContain("snippet_result");
    expect(types.filter((t) => t === "request")).toHaveLength(2);
    const snippetResult = records.find((r) => r.t === "snippet_result");
    expect(snippetResult?.["text"]).toContain('ran:await sdk.say("inner 1")');
    // Appended after the call ran, so the call carries when it was dispatched:
    // a number no later than its own write time, and only on the call record.
    const toolCall = records.find((r) => r.t === "tool_call");
    const dispatchTs = toolCall?.["dispatchTs"];
    expect(typeof dispatchTs).toBe("number");
    expect(dispatchTs as number).toBeGreaterThan(0);
    expect(dispatchTs as number).toBeLessThanOrEqual(toolCall!.ts);
    expect(snippetResult?.["dispatchTs"]).toBeUndefined();
    // The driver record names the lane by NAME, never by path or contents.
    const driver = records.find((r) => r.t === "driver");
    expect(driver?.["driver"]).toBe("codex");
    expect(driver?.["harness"]).toBe("codex");
    expect(driver?.["lane"]).toBe("CODEX_HOME");
    expect(JSON.stringify(driver)).not.toContain("auth.json");
    // Thread and per-turn results are on the record.
    expect(records.find((r) => r.t === "codex_thread")?.["threadId"]).toBe("fake-thread");
    const results = records.filter((r) => r.t === "codex_result");
    expect(results).toHaveLength(2);
    expect(results[0]?.["status"]).toBe("completed");
    expect(results[0]?.["threadId"]).toBe("fake-thread");
    expect((results[0]?.["usage"] as { reasoning_tokens?: number }).reasoning_tokens).toBe(128);
    // Second request names the thread it continues.
    expect(records.filter((r) => r.t === "request")[1]?.["threadId"]).toBe("fake-thread");
    // The CLI version was promoted onto the run.
    expect(readMeta(runDir)?.resolved?.cliVersion).toBe("0.0.0-fake");
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("turn-limit");
    trajectory.close();
  }, 30_000);

  test("the turn's usage lands once, on the last response entry of the turn", async () => {
    const { runDir, trajectory, options } = setupEpisode("tools", { maxTurns: 1 });
    await runCodexEpisode(options);
    const responses = readTrajectory(runDir).filter((r) => r.t === "response");
    // text, the tool call, text: three entries, exactly one carrying usage — the last.
    expect(responses).toHaveLength(3);
    const withUsage = responses.filter((r) => r["usage"] !== undefined);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toBe(responses[2]!);
    expect(withUsage[0]?.["usage"]).toEqual({
      prompt_tokens: 1916,
      completion_tokens: 157,
      total_tokens: 2073,
      cached_tokens: 1408,
      cache_write_tokens: 0,
      reasoning_tokens: 128,
    });
    // The tool call is mirrored on a response entry, named server.tool.
    const toolUse = (responses[1]?.["message"] as { tool_uses?: { name: string }[] }).tool_uses?.[0];
    expect(toolUse?.name).toBe("wrathbench.run_snippet");
    trajectory.close();
  }, 20_000);

  test("a silent turn still counts its tokens, on a content-null response", async () => {
    const { runDir, trajectory, options } = setupEpisode("silent", { maxTurns: 1 });
    await runCodexEpisode(options);
    const records = readTrajectory(runDir);
    const responses = records.filter((r) => r.t === "response");
    expect(responses).toHaveLength(1);
    expect((responses[0]?.["message"] as { content: unknown }).content).toBeNull();
    expect((responses[0]?.["usage"] as { prompt_tokens: number }).prompt_tokens).toBe(1916);
    expect(records.some((r) => r.t === "harness" && String(r["text"]).includes("no assistant output"))).toBe(true);
    trajectory.close();
  }, 20_000);

  test("no trim notice is ever raised: this harness runs no message window", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 3 });
    await runCodexEpisode(options);
    for (const msg of readRecord(recordPath)["userMessages"] as string[]) {
      expect(msg).not.toContain("trim_pending");
      expect(msg).not.toContain("window_trimmed");
    }
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "harness" && r["kind"] === "trim_pending")).toHaveLength(0);
    trajectory.close();
  }, 30_000);

  test("the spawned CLI sees exactly one credential: the lane's CODEX_HOME", async () => {
    const { recordPath, codexHome, trajectory, options } = setupEpisode("tools", { maxTurns: 1 });
    await runCodexEpisode(options);
    const env = readRecord(recordPath)["env"] as Record<string, unknown>;
    expect(env["codexHome"]).toBe(codexHome);
    expect(env["hasCodexApiKey"]).toBe(false);
    expect(env["hasCodexAccessToken"]).toBe(false);
    expect(env["hasCodexHome2"]).toBe(false);
    expect(env["hasOpenAiApiKey"]).toBe(false);
    expect(env["hasOpenAiBaseUrl"]).toBe(false);
    expect(env["hasAnthropicApiKey"]).toBe(false);
    expect(env["hasOauthToken"]).toBe(false);
    expect(env["hasAwsBearer"]).toBe(false);
    expect(env["hasDbPassword"]).toBe(false);
    trajectory.close();
  }, 20_000);

  test("a second lane arrives under the one name the CLI reads", async () => {
    const other = fakeCodexHome();
    const { recordPath, trajectory, options } = setupEpisode("tools", { maxTurns: 1, subscription: "CODEX_HOME_2" }, { CODEX_HOME_2: other });
    await runCodexEpisode(options);
    const env = readRecord(recordPath)["env"] as Record<string, unknown>;
    expect(env["codexHome"]).toBe(other);
    expect(env["hasCodexHome2"]).toBe(false);
    expect(readTrajectory(trajectory.dir).find((r) => r.t === "driver")?.["lane"]).toBe("CODEX_HOME_2");
    trajectory.close();
  }, 20_000);

  test("a declared effort reaches the CLI as model_reasoning_effort; an undeclared one sends nothing", async () => {
    const plain = setupEpisode("tools", { maxTurns: 1 });
    await runCodexEpisode(plain.options);
    expect(readRecord(plain.recordPath)["effort"]).toBeNull();
    plain.trajectory.close();

    const ultra = setupEpisode("tools", { maxTurns: 1, effort: "ultra" });
    await runCodexEpisode(ultra.options);
    expect(readRecord(ultra.recordPath)["effort"]).toBe("ultra");
    expect(readMeta(ultra.runDir)?.config.effort).toBe("ultra");
    ultra.trajectory.close();
  }, 30_000);

  test("none and minimal are refused by name, never mapped", () => {
    expect(codexEffortRefusal(undefined)).toBeNull();
    for (const e of CODEX_EFFORTS) expect(codexEffortRefusal(e)).toBeNull();
    expect(codexEffortRefusal("none")).toContain("not a Codex reasoning level");
    expect(codexEffortRefusal("minimal")).toContain("minimal");
    expect(() => codexArgs({ effort: "none", instructionsPath: "/i", bunBin: "/b", bridgePath: "/p", mcpPort: 1 })).toThrow(/not a Codex reasoning level/);
  });

  test("a usage-limit failure pauses the run as quota-exhausted", async () => {
    const { trajectory, options } = setupEpisode("limit", { maxTurns: 3 });
    const outcome = await runCodexEpisode(options);
    expect(outcome.kind === "paused" && outcome.reason).toBe("quota-exhausted");
    expect(outcome.kind === "paused" && outcome.detail).toContain("usage limit");
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBe("quota-exhausted");
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBeNull();
    trajectory.close();
  }, 20_000);

  test("a rate-limit error pauses as rate-limited; a dead login pauses as auth-failed", async () => {
    const rate = setupEpisode("rate-limit", { maxTurns: 3 });
    expect(await runCodexEpisode(rate.options)).toMatchObject({ kind: "paused", reason: "rate-limited" });
    rate.trajectory.close();
    const auth = setupEpisode("auth", { maxTurns: 3 });
    const outcome = await runCodexEpisode(auth.options);
    expect(outcome).toMatchObject({ kind: "paused", reason: "auth-failed" });
    expect(outcome.kind === "paused" && outcome.detail).toContain("refresh token was already used");
    auth.trajectory.close();
  }, 30_000);

  test("a usage-limit line on stderr with a non-zero exit also pauses", async () => {
    const { trajectory, options } = setupEpisode("limit-stderr", { maxTurns: 3 });
    expect(await runCodexEpisode(options)).toMatchObject({ kind: "paused", reason: "quota-exhausted" });
    trajectory.close();
  }, 20_000);

  test("the provider's policy monitor ends the run as provider-policy, message verbatim, no override", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("policy", { maxTurns: 3 });
    const outcome = await runCodexEpisode(options);
    expect(outcome.kind === "terminated" && outcome.reason).toBe("provider-policy");
    expect(outcome.kind === "terminated" && outcome.detail).toContain("misalignmentPolicyViolation");
    const records = readTrajectory(runDir);
    const result = records.find((r) => r.t === "codex_result");
    expect(result?.["status"]).toBe("failed");
    expect((result?.["error"] as { message: string }).message).toBe(
      "The model's continued work on this task was stopped by the misalignment monitor.",
    );
    expect(trajectory.runRow("run-test")?.["termination_reason"]).toBe("provider-policy");
    // One process, one turn: nothing tried to steer or retry.
    expect((readRecord(recordPath)["argvs"] as string[][]).length).toBe(1);
    trajectory.close();
  }, 20_000);

  test("a blown context window ends the run as context-limit", async () => {
    const { trajectory, options } = setupEpisode("context", { maxTurns: 3 });
    expect(await runCodexEpisode(options)).toMatchObject({ kind: "terminated", reason: "context-limit" });
    trajectory.close();
  }, 20_000);

  test("a transient failed turn is a session note; the next turn resumes the same thread", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("flaky", { maxTurns: 2 });
    const outcome = await runCodexEpisode(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });
    const record = readRecord(recordPath);
    expect(record["threadArgs"]).toEqual([null, "fake-thread"]);
    expect((record["userMessages"] as string[])[1]).toContain("ended with an error from the CLI");
    const results = readTrajectory(runDir).filter((r) => r.t === "codex_result");
    expect(results.map((r) => r["status"])).toEqual(["failed", "completed"]);
    trajectory.close();
  }, 30_000);

  test("model output about in-game limits never pauses the run", async () => {
    const { trajectory, options } = setupEpisode("chatty-limit", { maxTurns: 1 });
    expect(await runCodexEpisode(options)).toEqual({ kind: "terminated", reason: "turn-limit", detail: "1 turns" });
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBeNull();
    trajectory.close();
  }, 20_000);

  test("a CLI that ignores SIGTERM is killed with its MCP child, not orphaned", async () => {
    const { recordPath, trajectory, options } = setupEpisode("stubborn");
    const outcome = await runCodexEpisode({ ...options, watchdogTickMs: 25, killGraceMs: 200 });
    expect(outcome.kind === "paused" && outcome.reason).toBe("quota-exhausted");
    const record = readRecord(recordPath);
    const pids = [...(record["pids"] as number[]), ...(record["mcpPids"] as number[])];
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(await gone(pid)).toBe(true);
    trajectory.close();
  }, 30_000);

  test("a watchdog fires DURING a turn, records the reason first, and the CLI goes", async () => {
    const { runDir, trajectory, options } = setupEpisode("long-turn", { watchdogs: { episodeMs: 300 } });
    const started = Date.now();
    const outcome = await runCodexEpisode({ ...options, watchdogTickMs: 25, killGraceMs: 200 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("episode-limit");
    expect(Date.now() - started).toBeLessThan(15_000);
    const records = readTrajectory(runDir);
    expect(records.find((r) => r.t === "watchdog")?.["reason"]).toBe("episode-limit");
    expect(records.filter((r) => r.t === "termination")).toHaveLength(1);
    expect(records.filter((r) => r.t === "request")).toHaveLength(1);
    trajectory.close();
  }, 30_000);

  test("the tool-call ceiling bounds the CLI's inner loop; further calls are refused, not run", async () => {
    const { runDir, trajectory, options } = setupEpisode("long-turn", { maxToolCallsPerEpisode: 3 });
    const outcome = await runCodexEpisode({ ...options, watchdogTickMs: 50, killGraceMs: 200 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("tool-call-limit");
    expect(outcome.kind === "terminated" && outcome.detail).toContain("cap 3");
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "snippet")).toHaveLength(3);
    expect(records.find((r) => r.t === "limit")?.["kind"]).toBe("tool-call-limit");
    trajectory.close();
  }, 30_000);

  test("a watchdog mid-turn winds the CLI down: the closing turn.completed lands, tools stay refused", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("wind-down", { watchdogs: { episodeMs: 300 } });
    const outcome = await runCodexEpisode({ ...options, watchdogTickMs: 25, killGraceMs: 200, windDownGraceMs: 10_000 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("episode-limit");
    const records = readTrajectory(runDir);
    expect(records.filter((r) => r.t === "termination")).toHaveLength(1);
    const result = records.find((r) => r.t === "codex_result");
    expect(result?.["status"]).toBe("completed");
    expect((result?.["usageRaw"] as { output_tokens?: number }).output_tokens).toBe(20_000);
    const wind = records.filter((r) => r.t === "wind-down");
    expect(wind).toHaveLength(1);
    expect(wind[0]?.["outcome"]).toBe("result");
    const at = (t: string): number => records.findIndex((r) => r.t === t);
    expect(at("termination")).toBeLessThan(at("codex_result"));
    expect(at("codex_result")).toBeLessThan(at("wind-down"));
    // Monotonic refusal: once one call is refused, none after it ran.
    const results = readRecord(recordPath)["toolResults"] as { isError?: boolean; content?: { text?: string }[] }[];
    const textOf = (r: { content?: { text?: string }[] }): string => r.content?.[0]?.text ?? "";
    const first = results.findIndex((r) => r.isError === true && textOf(r).includes("episode is over"));
    expect(first).toBeGreaterThanOrEqual(0);
    for (const r of results.slice(first)) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).not.toContain("ran:");
    }
    trajectory.close();
  }, 30_000);

  test("a CLI that ignores the refusal is killed when the grace expires", async () => {
    const { runDir, recordPath, trajectory, options } = setupEpisode("wind-down-deaf", { watchdogs: { episodeMs: 300 } });
    const started = Date.now();
    const outcome = await runCodexEpisode({ ...options, watchdogTickMs: 25, killGraceMs: 200, windDownGraceMs: 400 });
    expect(outcome.kind === "terminated" && outcome.reason).toBe("episode-limit");
    expect(Date.now() - started).toBeLessThan(15_000);
    const records = readTrajectory(runDir);
    const wind = records.filter((r) => r.t === "wind-down");
    expect(wind).toHaveLength(1);
    expect(wind[0]?.["outcome"]).toBe("grace-expired");
    expect(records.filter((r) => r.t === "codex_result")).toHaveLength(0);
    const record = readRecord(recordPath);
    for (const pid of [...(record["pids"] as number[]), ...(record["mcpPids"] as number[])]) {
      expect(await gone(pid)).toBe(true);
    }
    trajectory.close();
  }, 30_000);

  test("aborting the episode finalises it as manual; a pause request suspends it", async () => {
    const manual = setupEpisode("long-turn", {});
    const abort = new AbortController();
    setTimeout(() => abort.abort("SIGTERM"), 300);
    expect(await runCodexEpisode({ ...manual.options, signal: abort.signal, watchdogTickMs: 50, killGraceMs: 200 })).toEqual({
      kind: "terminated",
      reason: "manual",
      detail: "SIGTERM",
    });
    expect(manual.trajectory.runRow("run-test")?.["termination_reason"]).toBe("manual");
    manual.trajectory.close();

    const paused = setupEpisode("long-turn", {});
    const abort2 = new AbortController();
    setTimeout(() => abort2.abort({ kind: "pause", reason: "operator-pause", detail: "SIGTERM: supervisor stop" }), 300);
    expect(await runCodexEpisode({ ...paused.options, signal: abort2.signal, watchdogTickMs: 50, killGraceMs: 200 })).toEqual({
      kind: "paused",
      reason: "operator-pause",
      detail: "SIGTERM: supervisor stop",
    });
    expect(readTrajectory(paused.runDir).filter((r) => r.t === "termination")).toHaveLength(0);
    paused.trajectory.close();
  }, 40_000);

  test("codexArgs: the verified flag set, resume threading, TOML-quoted paths", () => {
    const base = { instructionsPath: "/runs/x/codex-instructions.md", bunBin: "/usr/bin/bun", bridgePath: "/repo/runner/src/mcp-bridge.ts", mcpPort: 40123 };
    const first = codexArgs({ ...base, model: "gpt-6-astra", effort: "high" });
    expect(first.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(first).toContain("--ignore-user-config");
    expect(first).toContain("--skip-git-repo-check");
    expect(first[first.length - 1]).toBe("-");
    expect(first[first.indexOf("-m") + 1]).toBe("gpt-6-astra");
    const cfg = first.filter((_, i) => first[i - 1] === "-c");
    expect(cfg).toContain('model_reasoning_effort="high"');
    expect(cfg).toContain('approval_policy="never"');
    expect(cfg).toContain('sandbox_mode="read-only"');
    expect(cfg).toContain('web_search="disabled"');
    expect(cfg).toContain('model_instructions_file="/runs/x/codex-instructions.md"');
    expect(cfg).toContain('mcp_servers.wrathbench.command="/usr/bin/bun"');
    expect(cfg).toContain('mcp_servers.wrathbench.args=["/repo/runner/src/mcp-bridge.ts","40123"]');
    expect(cfg).toContain('mcp_servers.wrathbench.default_tools_approval_mode="approve"');
    // exec-only flags stay off the line so the resume form is identical
    expect(first).not.toContain("-s");
    expect(first).not.toContain("-C");
    expect(first).not.toContain("--ephemeral");
    // never a developer_instructions: the prompt REPLACES the base instructions
    expect(cfg.some((c) => c.startsWith("developer_instructions"))).toBe(false);
    const resumed = codexArgs({ ...base, threadId: "01a06f87-aa52-7a53-8057-ce41ff444cab" });
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "01a06f87-aa52-7a53-8057-ce41ff444cab"]);
    expect(resumed.filter((a) => a.startsWith("model_reasoning_effort"))).toHaveLength(0);
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  test("the sample exec JSONL parses into the shapes the driver reads", () => {
    const lines = readFileSync(SAMPLE, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const events = lines.map(parseCodexEvent);
    expect(events.every((e) => e !== null)).toBe(true);
    const types = events.map((e) => e!["type"]);
    expect(types).toContain("thread.started");
    expect(types).toContain("item.completed");
    expect(types).toContain("turn.completed");
    const completed = events.filter((e) => e!["type"] === "turn.completed");
    expect(normalizeCodexUsage(completed[0]!["usage"])).toEqual({
      prompt_tokens: 8886,
      completion_tokens: 83,
      total_tokens: 8969,
      cached_tokens: 7680,
      cache_write_tokens: 0,
      reasoning_tokens: 17,
    });
    // A tool call the CLI failed before it reached us carries its error.
    const failed = events.find((e) => (e!["item"] as { status?: string } | undefined)?.status === "failed")!;
    expect((failed["item"] as { error: { message: string } }).error.message).toContain("requires approval");
    expect(parseCodexEvent("not json")).toBeNull();
    expect(parseCodexEvent('{"no":"type"}')).toBeNull();
    expect(normalizeCodexUsage(null)).toBeUndefined();
    expect(normalizeCodexUsage({})).toBeUndefined();
  });
});

describe("detectCodexFailure", () => {
  test("maps the CLI's failure vocabulary onto pause and termination reasons", () => {
    expect(detectCodexFailure("You've hit your usage limit. Try again at 4 PM.")).toMatchObject({ kind: "pause", reason: "quota-exhausted" });
    expect(detectCodexFailure('{"message":"limit","codexErrorInfo":"usageLimitExceeded"}')).toMatchObject({ kind: "pause", reason: "quota-exhausted" });
    expect(detectCodexFailure("Rate limit reached for gpt-5.5")).toMatchObject({ kind: "pause", reason: "rate-limited" });
    expect(detectCodexFailure('{"codexErrorInfo":"rateLimitExceeded"}')).toMatchObject({ kind: "pause", reason: "rate-limited" });
    expect(detectCodexFailure("Your access token could not be refreshed because your refresh token was already used")).toMatchObject({ kind: "pause", reason: "auth-failed" });
    expect(detectCodexFailure("401 Unauthorized")).toMatchObject({ kind: "pause", reason: "auth-failed" });
    expect(detectCodexFailure('{"codexErrorInfo":"contextWindowExceeded"}')).toMatchObject({ kind: "terminate", reason: "context-limit" });
    expect(detectCodexFailure('{"message":"stopped","codexErrorInfo":"misalignmentPolicyViolation"}')).toMatchObject({ kind: "terminate", reason: "provider-policy" });
    // the policy verdict wins over limit words in the same message
    expect(detectCodexFailure("misalignment monitor: task paused; usage limit unaffected")).toMatchObject({ reason: "provider-policy" });
    expect(detectCodexFailure("stream disconnected before completion")).toBeNull();
    expect(detectCodexFailure("ordinary assistant text about limits of the sandbox")).toBeNull();
    expect(detectCodexFailure(undefined)).toBeNull();
    expect(detectCodexFailure("")).toBeNull();
  });
});

describe("childEnv", () => {
  test("drops every OPENAI_ and CODEX_ variable and every cloud credential; keeps only the lane's CODEX_HOME", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        CODEX_HOME: "/home/u/.codex",
        CODEX_HOME_2: "/home/u/.codex-2",
        CODEX_API_KEY: "outranks the login",
        CODEX_ACCESS_TOKEN: "outranks the login too",
        OPENAI_API_KEY: "sk-openai",
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
        OPENAI_ORG_ID: "org",
        ANTHROPIC_API_KEY: "sk-ant",
        AWS_BEARER_TOKEN_BEDROCK: "b",
        GOOGLE_APPLICATION_CREDENTIALS: "/g.json",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        CLAUDE_CODE_OAUTH_TOKEN_2: "oauth-2",
        WRATHBENCH_DB_PASSWORD: "must-not-leak",
        WRATHBENCH_TOKEN: "keep",
        OPENROUTER_KEY: "keep",
        UNRELATED: "keep",
      },
      {},
    );
    for (const k of ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) {
      expect(BILLING_ENV_EXACT).toContain(k);
      expect(env[k]).toBeUndefined();
    }
    expect(env["CODEX_HOME_2"]).toBeUndefined();
    expect(env["OPENAI_ORG_ID"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["AWS_BEARER_TOKEN_BEDROCK"]).toBeUndefined();
    expect(env["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(env["CLAUDE_CODE_OAUTH_TOKEN_2"]).toBeUndefined();
    expect(env["WRATHBENCH_DB_PASSWORD"]).toBeUndefined();
    expect(env["CODEX_HOME"]).toBe("/home/u/.codex");
    expect(env["WRATHBENCH_TOKEN"]).toBe("keep");
    expect(env["OPENROUTER_KEY"]).toBe("keep");
    expect(env["UNRELATED"]).toBe("keep");
    expect(env["HOME"]).toBe("/home/u");
  });

  test("a second lane arrives as CODEX_HOME, and an empty chosen lane leaves none", () => {
    const parent = { PATH: "/usr/bin", CODEX_HOME: "/first", CODEX_HOME_2: "/second" };
    expect(childEnv(parent, { laneEnv: "CODEX_HOME_2" })["CODEX_HOME"]).toBe("/second");
    expect(childEnv(parent, { laneEnv: "CODEX_HOME_2" })["CODEX_HOME_2"]).toBeUndefined();
    expect(childEnv(parent, {})["CODEX_HOME"]).toBe("/first");
    expect(childEnv({ CODEX_HOME: "/first" }, { laneEnv: "CODEX_HOME_2" })["CODEX_HOME"]).toBeUndefined();
  });

  test("a lane looks logged in only with an auth.json in it", () => {
    const home = fakeCodexHome();
    expect(laneLooksLoggedIn(home)).toBe(true);
    const empty = mkdtempSync(join(tmpdir(), "wrathbench-codex-empty-"));
    mkdirSync(join(empty, "sessions"), { recursive: true });
    expect(laneLooksLoggedIn(empty)).toBe(false);
    expect(laneLooksLoggedIn(undefined)).toBe(false);
    expect(laneLooksLoggedIn("")).toBe(false);
  });
});

describe("driver, harness and prompt vocabulary", () => {
  test("codex is a driver and a harness of its own; the harness scores", () => {
    expect(loadRunConfig({ driver: "codex" }).driver).toBe("codex");
    expect(harnessOf("codex")).toBe("codex");
    expect(HARNESSES).toContain("codex");
    expect(harnessOfRun({ driver: "codex" })).toBe("codex");
    expect(harnessOfRun({ comparability: { harness: "codex" } })).toBe("codex");
    expect(comparabilityOf(loadRunConfig({ driver: "codex", model: "gpt-5.5" }), "v").harness).toBe("codex");
    expect(isUnscoredDriver("codex")).toBe(false);
    expect(unscoredStamp("codex")).toBeUndefined();
    expect(() => loadRunConfig({ driver: "codex-cli" })).toThrow(/codex/);
  });

  test("ultra parses as an effort; the codex prompt is the CLI-scaffold render, byte-identical to claude-code's", () => {
    expect(loadRunConfig({ effort: "ultra" }).effort).toBe("ultra");
    expect(contextSentence("codex")).toBe(contextSentence("claude-code"));
    expect(CODEX_SYSTEM_PROMPT).toBe(CLAUDE_CODE_SYSTEM_PROMPT);
    expect(CODEX_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    expect(CODEX_SYSTEM_PROMPT).not.toMatch(/claude|anthropic|openai|codex/i);
    expect(buildSystemPrompt(undefined, undefined, "codex")).toBe(CODEX_SYSTEM_PROMPT);
    expect(buildSystemPrompt("walk to Ironforge", "e90", "codex")).toBe(buildSystemPrompt("walk to Ironforge", "e90", "claude-code"));
  });

  /** Spawn run.ts against the fake CLI and return what it said. */
  async function launch(args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stderr: string; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-codex-refuse-"));
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "..", "src", "run.ts"), "--driver", "codex", "--runs-dir", dir, ...args],
      // a cwd without a .env: Bun auto-loads one, and the repo's may carry lanes
      cwd: dir,
      env: { PATH: `${fakeBinDir()}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] ?? "/tmp", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr, dir };
  }

  test("run.ts refuses to start without a logged-in lane, and names the chosen variable", async () => {
    const unset = await launch(["--model", "gpt-5.5"], {});
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain("$CODEX_HOME");
    expect(unset.stderr).toContain("codex login");

    const empty = mkdtempSync(join(tmpdir(), "wrathbench-codex-noauth-"));
    const noAuth = await launch(["--model", "gpt-5.5"], { CODEX_HOME: empty });
    expect(noAuth.code).toBe(2);
    expect(noAuth.stderr).toContain("auth.json");

    const lane2 = await launch(["--model", "gpt-5.5", "--token-env", "CODEX_HOME_2"], { CODEX_HOME: fakeCodexHome() });
    expect(lane2.code).toBe(2);
    expect(lane2.stderr).toContain("$CODEX_HOME_2");
    expect(lane2.stderr).toContain("CODEX_HOME_2=");
  }, 30_000);

  test("run.ts refuses effort none and minimal for this driver by name", async () => {
    const none = await launch(["--model", "gpt-5.5", "--effort", "none"], { CODEX_HOME: fakeCodexHome() });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("not a Codex reasoning level");
  }, 30_000);
});
