/**
 * The pi driver, exercised end to end against a scripted fake `pi` binary
 * (`fixtures/fake-pi.ts`) that speaks pi 1.4.0's RPC protocol and really calls
 * our MCP server through the loopback bridge. No live stack, no real CLI, no
 * endpoint. The real binary is checked against a stub endpoint by hand
 * (runner/README.md, "The pi driver").
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PI_MCP_TIMEOUT_S,
  PI_PROMPT_EXTENSION,
  detectPiFailure,
  normalizePiUsage,
  piArgs,
  piCostOf,
  piEffortRefusal,
  piThinkingClampRefusal,
  piThinkingLevel,
  runPiEpisode,
} from "../src/adapter-pi";
import { COMPACTED_NOTICE, piAutoCompactLimit, piReserveTokens, piWindowCapRefusal } from "../src/cli-compaction";
import { comparabilityOf, promptHash } from "../src/comparability";
import { harnessClash, loadRunConfig } from "../src/config";
import { CODEX_SYSTEM_PROMPT, CLAUDE_CODE_SYSTEM_PROMPT, PI_SYSTEM_PROMPT, SNIPPET_DELTA_SENTENCE, SYSTEM_PROMPT, buildSystemPrompt, contextSentence } from "../src/prompt";
import wrathbenchPromptExtension, { PI_PROMPT_MISSING } from "../src/pi-extension";
import { piProviderOf, rosterKeyRefusal } from "../src/providers";
import { priceFor, rosterPriceGap, runCost } from "../viewer/pricing";
import { projectEntry } from "../viewer/public-projection";
import { summarize, tokenTotals } from "../viewer/tail";
import { countRecords } from "../src/models";
import { EpisodicLog } from "../src/episodic";
import { Scratchpad } from "@wrathbench/mcp";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const FIXTURE = join(import.meta.dir, "fixtures", "fake-pi.ts");
const BASE = "https://api.deepseek.com/v1";
/** A pi run is a campaign's square: the identity a campaign file gives it. */
const PROBE = { episode: "probing", campaign: "pi-vs-wrathbench", campaignVersion: 1, cell: "dwarf-paladin", arm: "pi", ref: "deepseek-flash-pi" };

function fakeSandbox(): SandboxHost {
  return {
    evalSnippet: (code: string): Promise<SnippetResult> => Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

/** An executable `pi` that runs the fixture. */
function fakePi(): string {
  const dir = tempDir("wrathbench-fakepi-");
  const path = join(dir, "pi");
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${FIXTURE} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** Everything a runner's environment holds that must not reach pi. */
const RUNNER_SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-must-not-be-used",
  CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-lane",
  OPENROUTER_KEY: "fake-openrouter-key",
  OPENCODE_KEY: "fake-opencode-key",
  DEEPSEEK_API_KEY: "pi-would-read-this-one-itself",
  WRATHBENCH_MODULE_SECRET: "fake-module-port-secret",
  WRATHBENCH_DB_PASSWORD: "fake-db-password",
  CLICKHOUSE_PASSWORD: "fake-clickhouse-password",
  S3_SECRET_ACCESS_KEY: "fake-s3-secret",
  SOAP_PASSWORD: "fake-soap",
  WRATHBENCH_STAGER_PASSWORD: "fake-stager",
  CODEX_HOME: "/fake/codex/home",
};

function setup(mode: string, extraConfig: Record<string, unknown> = {}, fakeEnv: Record<string, string> = {}) {
  const runDir = tempDir("wrathbench-pi-run-");
  const recordPath = join(runDir, "record.json");
  const config = {
    ...loadRunConfig({
      driver: "pi",
      model: "deepseek-flash",
      apiBase: BASE,
      apiKeyEnv: "DEEPSEEK_KEY",
      ...PROBE,
      runsDir: tempDir("wrathbench-pi-runs-"),
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      ...extraConfig,
    }),
    runId: "run-test",
    token: "run-test",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  const options: Parameters<typeof runPiEpisode>[0] = {
    config,
    runDir,
    sandbox: fakeSandbox(),
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
    sleep: () => Promise.resolve(),
    piBin: fakePi(),
    env: { PATH: process.env["PATH"] ?? "", HOME: "/home/someone", DEEPSEEK_KEY: "sk-deepseek-for-tests", ...RUNNER_SECRETS },
    extraEnv: { WB_FAKE_MODE: mode, WB_FAKE_RECORD: recordPath, ...fakeEnv },
    killGraceMs: 500,
    windDownGraceMs: 5_000,
  };
  return { runDir, recordPath, trajectory, options };
}

const readRecord = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const entries = (runDir: string): Record<string, unknown>[] => readTrajectory(runDir) as Record<string, unknown>[];

describe("pi driver", () => {
  test("drives turns over RPC, round-trips a tool call through our MCP server, records per-request usage", async () => {
    const { runDir, recordPath, options } = setup("tools", { maxTurns: 2 });
    const outcome = await runPiEpisode(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });

    const rec = readRecord(recordPath);
    // Our tools, and only our tools, reached the CLI's MCP client.
    expect(rec["mcpTools"]).toContain("run_snippet");
    expect((rec["toolResults"] as { content: { text: string }[] }[])[0]!.content[0]!.text).toContain("ran:");
    // Two prompts, each the harness's context message.
    expect((rec["prompts"] as string[]).length).toBe(2);
    // The system prompt file holds exactly the pi render.
    expect(rec["systemPrompt"]).toBe(PI_SYSTEM_PROMPT);
    expect(rec["extensions"]).toEqual(["builtin:mcp", PI_PROMPT_EXTENSION]);

    const t = entries(runDir);
    const driver = t.find((e) => e["t"] === "driver")!;
    expect(driver["driver"]).toBe("pi");
    expect(driver["harness"]).toBe("pi");
    expect(driver["cliVersion"]).toBe("1.4.0");
    expect(driver["apiBase"]).toBe(BASE);
    expect(driver["piProvider"]).toBe("deepseek");
    expect(driver["systemPromptChars"]).toBe(PI_SYSTEM_PROMPT.length);
    const state = t.find((e) => e["t"] === "harness" && e["kind"] === "pi_state")!;
    expect(state["contextWindow"]).toBe(1_000_000);

    const responses = t.filter((e) => e["t"] === "response");
    expect(responses.length).toBe(4);
    // pi's input excludes the cache; the harness's prompt is the whole input.
    expect(responses[0]!["usage"]).toEqual({ prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, cached_tokens: 800, cache_write_tokens: 0, reasoning_tokens: 0 });
    expect(responses[0]!["thinkingChars"]).toBe(4);
    expect((responses[0]!["message"] as { tool_uses: { name: string }[] }).tool_uses[0]!.name).toBe("mcp__wrathbench__run_snippet");
    // pi's catalogue-priced figure, a cross-check only, never a `usage.cost` the viewer reads as a charge.
    expect(typeof responses[0]!["piCostUsd"]).toBe("number");
    expect((responses[0]!["usage"] as Record<string, unknown>)["cost"]).toBeUndefined();
    expect(t.filter((e) => e["t"] === "tool_call").length).toBe(2);

    const meta = readMeta(runDir) as { resolved?: { model?: string; cliVersion?: string } };
    expect(meta.resolved?.model).toBe("deepseek-flash");
    expect(meta.resolved?.cliVersion).toBe("1.4.0");
  });

  test("the child gets the run's own key under its own name and nothing else of the runner's", async () => {
    const { runDir, recordPath, options } = setup("tools", { maxTurns: 1 });
    await runPiEpisode(options);
    const rec = readRecord(recordPath);
    const env = rec["env"] as Record<string, string | null>;
    // models.json reads the key as `$DEEPSEEK_KEY`, and the child has it.
    expect(rec["keyResolves"]).toBe(true);
    const keys = rec["envKeys"] as string[];
    for (const secret of Object.keys(RUNNER_SECRETS)) expect(keys).not.toContain(secret);
    expect(keys).toContain("DEEPSEEK_KEY");
    // Nothing user-level: HOME and the agent directory are the run's own.
    expect(env["home"]).toBe(join(runDir, "pi"));
    expect(env["agentDir"]).toBe(join(runDir, "pi"));
    // No phone-home.
    expect(env).toMatchObject({ offline: "1", telemetry: "0", skipVersionCheck: "1" });
    const args = rec["argv"] as string[];
    expect(args).toContain("--offline");
    // The files: telemetry and cache warming off, the MCP server direct with a long timeout, the key by name.
    expect(rec["settings"]).toEqual({
      enableInstallTelemetry: false,
      defaultProjectTrust: "never",
      cacheWarming: "off",
      enableSkillCommands: false,
      quietStartup: true,
      compaction: { enabled: true },
    });
    const server = (rec["mcpConfig"] as { mcpServers: Record<string, Record<string, unknown>>; autoEnableCodemode: boolean });
    expect(server.autoEnableCodemode).toBe(false);
    expect(server.mcpServers["wrathbench"]).toMatchObject({ exposure: "direct", timeout: PI_MCP_TIMEOUT_S });
    expect(rec["models"]).toEqual({ providers: { deepseek: { baseUrl: BASE, apiKey: "$DEEPSEEK_KEY" } } });
    // The key value is in no file the driver wrote.
    for (const f of ["settings.json", "models.json", "mcp.json"]) expect(readFileSync(join(runDir, "pi", f), "utf8")).not.toContain("sk-deepseek");
  });

  test("a 300k window is pi's reserve below the model's window; the run records both", async () => {
    const { runDir, recordPath, options } = setup("tools", { maxTurns: 1, compactWindow: "300k" });
    await runPiEpisode(options);
    expect((readRecord(recordPath)["settings"] as { compaction: unknown }).compaction).toEqual({ enabled: true, reserveTokens: 700_000 });
    const driver = entries(runDir).find((e) => e["t"] === "driver")!;
    expect(driver).toMatchObject({ compactWindow: "300k", reserveTokens: 700_000 });
  });

  test("a window at or above the model's context is refused before the first turn", async () => {
    const { runDir, options } = setup("tools", { compactWindow: "300k" }, { WB_FAKE_CONTEXT_WINDOW: "262144" });
    const outcome = await runPiEpisode(options);
    expect(outcome.kind).toBe("terminated");
    expect(outcome.kind === "terminated" && outcome.reason).toBe("harness-error");
    expect((outcome as { detail?: string }).detail).toContain("compactWindow 300k (300000 tokens) is at or above the model's context window");
    expect(entries(runDir).some((e) => e["t"] === "request")).toBe(false);
  });

  test("a compaction is a harness record with pi's summary, and its summarisation call is billed usage", async () => {
    const { runDir, recordPath, options } = setup("tools", { maxTurns: 2 }, { WB_FAKE_COMPACT_TURN: "1" });
    await runPiEpisode(options);
    const t = entries(runDir);
    const compaction = t.find((e) => e["t"] === "harness" && e["kind"] === "compaction")!;
    expect(compaction).toMatchObject({ turn: 1, trigger: "threshold", preTokens: 301_234, postTokens: 21_000, summary: "## Goal\nlevel up\n" });
    const summaryCall = t.find((e) => e["t"] === "response" && e["kind"] === "compaction")!;
    expect((summaryCall["usage"] as { prompt_tokens: number }).prompt_tokens).toBe(300_000);
    // Counted as tokens, never as a model reply or as the conversation's context.
    const summaries = t.map((e, i) => summarize(e, i, 0, 0));
    const totals = tokenTotals(summaries);
    expect(totals.contextTokens).not.toBe(300_000);
    // Even when the summarisation call is the newest record, the context is the last reply's.
    const lastReply = summaries.filter((s) => s.t === "response" && s["kind"] !== "compaction").at(-1)!;
    const summaryEntry = summaries.find((s) => s["kind"] === "compaction")!;
    expect(tokenTotals([lastReply, summaryEntry]).contextTokens).toBe((lastReply["usage"] as { prompt: number }).prompt);
    const replies = t.filter((e) => e["t"] === "response" && e["kind"] !== "compaction");
    const replyPrompt = replies.reduce((a, e) => a + (e["usage"] as { prompt_tokens: number }).prompt_tokens, 0);
    expect(totals.promptTokens).toBe(replyPrompt + 300_000);
    expect(countRecords(join(runDir, "trajectory.jsonl"), ["response"])?.get("response")).toBe(replies.length);
    // The episodic-log ask follows a compaction it did not predict.
    expect((readRecord(recordPath)["prompts"] as string[])[1]).toContain(COMPACTED_NOTICE);
  });

  test("a result pi truncated before the model read it is recorded as the model saw it", async () => {
    const { runDir, options } = setup("tools", { maxTurns: 1 }, { WB_FAKE_TRUNCATE: "1" });
    await runPiEpisode(options);
    const t = entries(runDir);
    const cut = t.find((e) => e["t"] === "pi_tool_result_truncated")!;
    expect(cut).toMatchObject({ turn: 1, name: "run_snippet", toolCallId: "call-1" });
    expect(String(cut["text"])).toStartWith("Warning: truncated output");
    // What our server answered stays on the snippet result, whole.
    expect(String(t.find((e) => e["t"] === "snippet_result")!["text"])).toContain("ran:");
  });

  test("the public projection carries none of pi's own words, endpoint or key, and none of the text it truncated", async () => {
    const failed = setup("error500");
    await runPiEpisode(failed.options);
    const cut = setup("tools", { maxTurns: 1, compactWindow: "300k" }, { WB_FAKE_TRUNCATE: "1", WB_FAKE_COMPACT_TURN: "1" });
    await runPiEpisode(cut.options);
    for (const runDir of [failed.runDir, cut.runDir]) {
      const projected = JSON.stringify(entries(runDir).map((e, i) => projectEntry(summarize(e, i, 0, 0))));
      expect(projected).not.toContain("fake error 500");
      expect(projected).not.toContain("Warning: truncated output");
      expect(projected).not.toContain("api.deepseek.com");
      expect(projected).not.toContain("DEEPSEEK_KEY");
      expect(projected).not.toContain("sk-deepseek");
      expect(projected).not.toContain("piCostUsd");
      // Compaction counts cross, the summary does not.
      expect(projected).not.toContain("level up");
    }
  });

  test.each([
    ["error402", { kind: "paused", reason: "quota-exhausted" }],
    ["error429", { kind: "paused", reason: "rate-limited" }],
  ])("%s pauses the run by status", async (mode, want) => {
    const { options } = setup(mode);
    const outcome = await runPiEpisode(options);
    expect(outcome).toMatchObject(want);
  });

  test("an unclassified error is a session note, and three in a row end the run", async () => {
    const { runDir, options } = setup("error500");
    const outcome = await runPiEpisode(options);
    expect(outcome).toMatchObject({ kind: "terminated", reason: "adapter-error" });
    expect(entries(runDir).filter((e) => e["t"] === "request").length).toBe(3);
    expect(entries(runDir).filter((e) => e["t"] === "pi_error").length).toBe(3);
  });

  test("teardown takes pi and the MCP bridge it launched down with it", async () => {
    const { recordPath, options } = setup("tools", { maxTurns: 1 });
    await runPiEpisode(options);
    const rec = readRecord(recordPath);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = async (pid: number): Promise<boolean> => {
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      return !alive(pid);
    };
    expect(await gone(rec["pid"] as number)).toBe(true);
    expect(await gone(rec["mcpPid"] as number)).toBe(true);
  });

  test("a prompt the extension cannot force ends the run as harness-error, never on pi's default prompt", async () => {
    const { runDir, options } = setup("prompt-missing");
    const outcome = await runPiEpisode(options);
    expect(outcome).toMatchObject({ kind: "terminated", reason: "harness-error" });
    expect((outcome as { detail?: string }).detail).toContain("could not be forced");
    // One prompt sent, nothing answered, nothing recorded as a model reply.
    const t = entries(runDir);
    expect(t.filter((e) => e["t"] === "request").length).toBe(1);
    expect(t.some((e) => e["t"] === "response")).toBe(false);
  });

  test("the extension fails closed: no prompt to force is an entry and an abort, never a fallback", () => {
    const handlers: Record<string, (event: unknown, ctx: { abort(): void }) => unknown> = {};
    const entries: string[] = [];
    let aborts = 0;
    wrathbenchPromptExtension({
      on: (event: string, h: (event: never, ctx: { abort(): void }) => unknown) => {
        handlers[event] = h as (event: unknown, ctx: { abort(): void }) => unknown;
      },
      appendEntry: (type: string) => entries.push(type),
    } as unknown as Parameters<typeof wrathbenchPromptExtension>[0]);
    const ctx = { abort: () => void aborts++ };
    expect(handlers["before_agent_start"]!({ systemPromptOptions: { customPrompt: "OURS" } }, ctx)).toEqual({ systemPrompt: "OURS" });
    expect(aborts).toBe(0);
    expect(handlers["before_agent_start"]!({ systemPromptOptions: {} }, ctx)).toBeUndefined();
    expect(entries).toEqual([PI_PROMPT_MISSING]);
    handlers["before_provider_request"]!({}, ctx);
    expect(aborts).toBe(2);
  });

  test("pi exiting mid-turn is an adapter error", async () => {
    const { options } = setup("crash");
    const outcome = await runPiEpisode(options);
    expect(outcome).toMatchObject({ kind: "terminated", reason: "adapter-error" });
  });

  test("the tool-call ceiling ends the episode at the MCP boundary and winds down to agent_settled", async () => {
    const { runDir, options } = setup("wind-down", { maxToolCallsPerEpisode: 3 });
    const outcome = await runPiEpisode(options);
    expect(outcome).toMatchObject({ kind: "terminated", reason: "tool-call-limit" });
    const t = entries(runDir);
    expect(t.filter((e) => e["t"] === "tool_call").length).toBe(3);
    expect(t.find((e) => e["t"] === "wind-down")).toMatchObject({ outcome: "settled", reason: "tool-call-limit" });
  });

  test("an effort pi would clamp is refused before the first turn", async () => {
    const { runDir, options } = setup("tools", { effort: "medium" }, { WB_FAKE_CLAMP: "medium:high" });
    const outcome = await runPiEpisode(options);
    expect(outcome).toMatchObject({ kind: "terminated", reason: "harness-error" });
    expect((outcome as { detail?: string }).detail).toContain("which pi runs as high");
    expect(entries(runDir).some((e) => e["t"] === "request")).toBe(false);
  });

  test("effort none is pi's off, and reaches it as --thinking", async () => {
    const { recordPath, options } = setup("tools", { maxTurns: 1, effort: "none" });
    await runPiEpisode(options);
    const args = readRecord(recordPath)["argv"] as string[];
    expect(args[args.indexOf("--thinking") + 1]).toBe("off");
  });
});

describe("pi driver pieces", () => {
  test("the flag set: RPC, no session, offline, no built-ins, our tools, the MCP client and our prompt extension, no user resources", () => {
    expect(piArgs({ piProvider: "deepseek", model: "deepseek-flash", systemPromptPath: "/r/pi/system-prompt.md" })).toEqual([
      "--mode", "rpc", "--no-session", "--offline",
      "--provider", "deepseek", "--model", "deepseek-flash",
      "--system-prompt", "/r/pi/system-prompt.md",
      "--no-builtin-tools", "--tools", "mcp__wrathbench__*",
      "--no-extensions", "-e", "builtin:mcp", "-e", PI_PROMPT_EXTENSION,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    ]);
  });

  test("usage: the whole prompt, the cache as a subset; pi's cost kept apart", () => {
    const raw = { input: 200, output: 20, cacheRead: 800, cacheWrite: 0, reasoning: 5, totalTokens: 1020, cost: { total: 0.0000888 } };
    expect(normalizePiUsage(raw)).toEqual({ prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, cached_tokens: 800, cache_write_tokens: 0, reasoning_tokens: 5 });
    expect(piCostOf(raw)).toBe(0.0000888);
    expect(normalizePiUsage(null)).toBeUndefined();
  });

  test("failures by status, never by model text", () => {
    expect(detectPiFailure('402: {"message":"Insufficient Balance"}')).toMatchObject({ kind: "pause", reason: "quota-exhausted" });
    expect(detectPiFailure('429: {"message":"Rate limit reached"}')).toMatchObject({ kind: "pause", reason: "rate-limited" });
    expect(detectPiFailure('429: {"message":"quota exceeded"}')).toMatchObject({ kind: "pause", reason: "quota-exhausted" });
    expect(detectPiFailure('401: {"message":"Authentication Fails"}')).toMatchObject({ kind: "pause", reason: "auth-failed" });
    expect(detectPiFailure("400: This model's maximum context length is 1000000 tokens")).toMatchObject({ kind: "terminate", reason: "context-limit" });
    expect(detectPiFailure('500: {"message":"internal"}')).toBeNull();
    expect(detectPiFailure("")).toBeNull();
  });

  test("effort: pi's levels by name, none is off, ultra refused, a clamp refused", () => {
    expect(piThinkingLevel("none")).toBe("off");
    expect(piThinkingLevel("high")).toBe("high");
    expect(piThinkingLevel(undefined)).toBeUndefined();
    expect(piEffortRefusal("ultra")).toContain("refuses effort ultra");
    expect(piEffortRefusal("max")).toBeNull();
    expect(piThinkingClampRefusal("medium", "high", ["off", "low", "high", "max"])).toContain("this model's levels in pi: off, low, high, max");
    expect(piThinkingClampRefusal("high", "high", undefined)).toBeNull();
    expect(piThinkingClampRefusal(undefined, "high", undefined)).toBeNull();
  });

  test("the window: 300k on a 1M model compacts at 300,000; auto is pi's own 983,616; a window pi never reaches is refused", () => {
    expect(piReserveTokens(1_000_000, "300k")).toBe(700_000);
    expect(piReserveTokens(1_000_000, undefined)).toBeUndefined();
    expect(piAutoCompactLimit(1_000_000, "300k")).toBe(300_000);
    expect(piAutoCompactLimit(1_000_000, undefined)).toBe(983_616);
    expect(piWindowCapRefusal("300k", 1_000_000)).toBeNull();
    expect(piWindowCapRefusal("1M", 1_000_000)).toContain("at or above");
  });

  test("the endpoint: pi runs on DeepSeek's key, and refuses a key it has no provider for", () => {
    expect(piProviderOf("DEEPSEEK_KEY")).toEqual({ provider: "deepseek" });
    expect(piProviderOf("OPENROUTER_KEY")).toMatchObject({ refusal: expect.stringContaining("no pi provider for OPENROUTER_KEY") });
    // Refused as the roster entry, so a campaign's squares of it are parked rather than spent on failed launches.
    expect(rosterKeyRefusal({ driver: "pi", apiBase: BASE, apiKeyEnv: "DEEPSEEK_KEY" })).toBeNull();
    expect(rosterKeyRefusal({ driver: "pi", apiBase: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_KEY" })).toContain("no pi provider for OPENROUTER_KEY");
    expect(rosterKeyRefusal({ driver: "openai", apiBase: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_KEY" })).toBeNull();
  });

  test("the prompt: the CLI render, byte for byte, so no existing pin moves", () => {
    expect(contextSentence("pi")).toBe(contextSentence("codex"));
    expect(PI_SYSTEM_PROMPT).toBe(CODEX_SYSTEM_PROMPT);
    // claude-code alone takes the snippet delta (operator, 2026-10-21).
    expect(PI_SYSTEM_PROMPT).toBe(CLAUDE_CODE_SYSTEM_PROMPT.replace(` ${SNIPPET_DELTA_SENTENCE}`, ""));
    expect(PI_SYSTEM_PROMPT).not.toContain(SNIPPET_DELTA_SENTENCE);
    expect(PI_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt(undefined, undefined, "pi")).toBe(PI_SYSTEM_PROMPT);
    expect(PI_SYSTEM_PROMPT).not.toMatch(/claude|anthropic|openai|codex|\bpi\b/i);
  });

  test("the tuple stamps the pi harness and the window; the prompt hash is the CLI render's", () => {
    const config = loadRunConfig({ driver: "pi", model: "deepseek-flash", apiBase: BASE, apiKeyEnv: "DEEPSEEK_KEY", compactWindow: "300k", ...PROBE });
    const tuple = comparabilityOf(config, "harness-0.5-1-gabc");
    expect(tuple.harness).toBe("pi");
    expect(tuple.compactWindow).toBe("300k");
    expect(tuple.promptHash).toBe(promptHash(CODEX_SYSTEM_PROMPT));
    // DeepSeek is no OpenRouter base, so no routing is stamped.
    expect(tuple.routing).toBeUndefined();
  });

  test("a pi run is priced from its tokens by the provider row its base and model name, as an openai run there is", () => {
    const run = { model: "deepseek-flash", apiBase: BASE, platform: null, driver: "pi", harness: "pi" as const };
    const price = priceFor(run);
    expect(price?.id).toBe("deepseek/deepseek-flash");
    expect(price).toEqual(priceFor({ ...run, driver: "openai", harness: "wrathbench" as const }));
    expect(rosterPriceGap({ model: "deepseek-flash", driver: "pi", apiBase: BASE })).toBeNull();
    // No provider charge is ever read for it: only the estimate.
    expect(runCost({ run, tokens: null, reportedUsd: null }).actual.usd).toBeNull();
  });

  test("a pi run launches only as a campaign's square: a scored, freeplay or unnamed episode is refused", () => {
    const base = { driver: "pi", model: "deepseek-flash", apiBase: BASE, apiKeyEnv: "DEEPSEEK_KEY" };
    for (const episode of ["e90", "e360", "freeplay", undefined]) {
      expect(() => loadRunConfig({ ...base, ...(episode !== undefined ? { episode } : {}) })).toThrow(/driver pi is probe-only/);
    }
    // A probing run with no campaign named is no square either.
    expect(() => loadRunConfig({ ...base, episode: "probing" })).toThrow(/driver pi is probe-only/);
    expect(loadRunConfig({ ...base, ...PROBE }).campaign).toBe("pi-vs-wrathbench");
    // Every other driver is unaffected.
    expect(loadRunConfig({ driver: "openai", model: "deepseek-flash", apiBase: BASE, apiKeyEnv: "DEEPSEEK_KEY", episode: "e90" }).episode).toBe("e90");
  });

  test("a pi entry is outside the one-model-one-harness rule, since it never runs in a scored lane", () => {
    expect(
      harnessClash({
        ds: { model: "deepseek-flash" },
        "ds-pi": { model: "deepseek-flash", driver: "pi" },
      }),
    ).toBeNull();
    expect(harnessClash({ ds: { model: "x" }, "ds-codex": { model: "x", driver: "codex" } })).toContain("two harnesses");
  });
});
