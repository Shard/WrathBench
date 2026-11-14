/**
 * A scaffold's thread context (`ThreadContext`, context.ts): on codex, the
 * program loop sends the pad only when the thread does not hold it, and
 * sends it whole after the thread lost it. The event window goes whole on
 * every message, and the snippet loop's messages, prompt and tools are its
 * own, untouched. Against fakes: the fake codex CLI and a scripted sandbox.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scratchpad, type EventSummary } from "@wrathbench/mcp";
import { runCodexEpisode } from "../src/adapter-codex";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, loopOf, threadContextOf } from "../src/config";
import { formatEventLine, ThreadContext } from "../src/context";
import { EpisodicLog } from "../src/episodic";
import { buildSystemPrompt } from "../src/prompt";
import { configFromArgs } from "../src/run";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { TOOLS, toolsFor } from "../src/tools";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { messageParts } from "../../infra/inspect-run";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const T0 = Date.UTC(2030, 0, 2, 12, 0, 0);

/** The n-th chat event, seq n. */
function ev(n: number, o: Partial<EventSummary> = {}): EventSummary {
  return { seq: n, ts: T0 + n * 1000, opcode: "SMSG_MESSAGECHAT", data: { text: `line ${n}` }, ...o } as EventSummary;
}
const evs = (from: number, to: number): EventSummary[] => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

describe("the thread context, as a pure rule", () => {
  test("a reset sends the pad whole again", () => {
    const t = new ThreadContext();
    expect(t.pad.sendWhole("# plan")).toBe(true);
    expect(t.pad.sendWhole("# plan")).toBe(false);
    t.reset();
    expect(t.pad.sendWhole("# plan")).toBe(true);
  });
});

// ------------------------------------------------------------ the codex driver

/** A sandbox whose window grows by the script: `counts[i]` events at its i-th window, then the last count. */
function scriptedSandbox(counts: number[]): SandboxHost {
  let calls = 0;
  return {
    evalSnippet: (code: string): Promise<SnippetResult> => Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    contextEvents: () => Promise.resolve({ events: evs(1, counts[Math.min(calls++, counts.length - 1)]!), folded: 0 }),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

function fakeBinDir(): string {
  const dir = tempDir("wrathbench-thread-bin-");
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures", "fake-codex.ts")} "$@"\n`, "utf8");
  chmodSync(join(dir, "codex"), 0o755);
  return dir;
}

function fakeCodexHome(): string {
  const dir = tempDir("wrathbench-thread-home-");
  writeFileSync(join(dir, "auth.json"), '{"auth_mode":"chatgpt","tokens":{"access_token":"fake"}}\n', "utf8");
  return dir;
}

const THREAD = "01a119da-ef89-7a63-ac51-314ac6a70a61";

interface CodexRun {
  counts: number[];
  turns: number;
  /** `WB_FAKE_ROLLOUT`'s entries; absent writes none, so every read fails. */
  rollout?: unknown[] | null;
  calls?: unknown[][];
  mode?: string;
  runDir?: string;
}

/** A codex episode over the scripted sandbox and the fake CLI: the messages it sent, the CLI's record, the trajectory. */
async function codexRun(o: CodexRun) {
  const runDir = o.runDir ?? tempDir("wrathbench-thread-run-");
  const record = join(runDir, `fake-${Date.now()}-${Math.random()}.json`);
  const config = {
    ...loadRunConfig({
      driver: "codex",
      model: "gpt-5.5",
      runsDir: tempDir("wrathbench-thread-runs-"),
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      credential: "chatgpt-1",
      usageMaxPct: { scored: 80, freeplay: 80 },
      episode: "probing",
      maxTurns: o.turns,
    }),
    runId: "run-thread",
    token: "run-thread",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
  const rollout = o.rollout === null ? undefined : (o.rollout ?? Array.from({ length: o.turns }, (_, i) => ({ total: 10_000 * (i + 1) })));
  await runCodexEpisode({
    config: config as typeof config & { runId: string; token: string },
    runDir,
    sandbox: scriptedSandbox(o.counts),
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
    sleep: () => Promise.resolve(),
    env: { PATH: `${fakeBinDir()}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] ?? "/tmp", CODEX_HOME: fakeCodexHome() },
    extraEnv: {
      WB_FAKE_MODE: o.mode ?? "tools",
      WB_FAKE_RECORD: record,
      WB_FAKE_THREAD_ID: THREAD,
      ...(rollout !== undefined ? { WB_FAKE_ROLLOUT: JSON.stringify(rollout) } : {}),
      ...(o.calls !== undefined ? { WB_FAKE_CALLS: JSON.stringify(o.calls) } : {}),
    },
  });
  trajectory.close();
  const rec = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
  return { runDir, rec, messages: rec["userMessages"] as string[], records: readTrajectory(runDir) };
}

const eventsOf = (message: string): string => messageParts(message).events;

describe("the snippet loop on codex", () => {
  test("is untouched: every turn the whole window and the whole pad", async () => {
    const r = await codexRun({ counts: [3, 5, 5], turns: 3, calls: [[{ name: "write_scratchpad", arguments: { content: "# plan" } }], [], []] });
    expect(r.messages.map(eventsOf)).toEqual([3, 5, 5].map((n) => `[events: last ${n}, newest last]\n${evs(1, n).map(formatEventLine).join("\n")}`));
    expect(r.messages.slice(1).every((m) => m.endsWith("[scratchpad 0.0k/32k]\n# plan"))).toBe(true);
    expect(String(r.rec["instructions"])).toBe(buildSystemPrompt(undefined, "probing", "codex", true, 5_400_000));
    expect(r.records.some((x) => x.t === "events_served" && "mode" in x)).toBe(false);
  }, 30_000);
});

describe("--loop: config, tuple and the thread context", () => {
  const CODEX = ["--driver", "codex", "--model", "gpt-5.5", "--credential", "chatgpt-1", "--run-id", "r1", "--token", "tok-aaaaaaaaaaaaaaaaaaaaaa", "--module-url", "http://x"];

  test("program or snippet, and nothing else", () => {
    expect(loopOf(undefined)).toBeUndefined();
    expect(loopOf("snippet")).toBeUndefined();
    expect(loopOf("program")).toBe("program");
    expect(() => loopOf("snippet-slim")).toThrow("--loop takes program or snippet");
  });

  test("the thread context is the program loop's on codex, and the tuple carries no key for it", () => {
    const snippet = configFromArgs(CODEX, {});
    const program = configFromArgs([...CODEX, "--loop", "program"], {});
    expect(threadContextOf(snippet)).toBe(false);
    expect(threadContextOf(program)).toBe(true);
    expect(threadContextOf({ loop: "program", driver: "openai" })).toBe(false);
    const tSnippet = comparabilityOf(snippet, "harness-1.0-1-gabc");
    const tProgram = comparabilityOf(program, "harness-1.0-1-gabc");
    expect("loop" in tSnippet).toBe(false);
    expect(tProgram.loop).toBe("program");
    expect("context" in tProgram).toBe(false);
    expect(Object.keys(tProgram).at(-1)).toBe("loop");
  });

  test("the snippet tool list is the one it always was", () => {
    expect(toolsFor({})).toEqual(TOOLS);
  });
});
