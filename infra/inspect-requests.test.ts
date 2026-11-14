/**
 * `bun wb inspect requests`: tokens and cost per request, wakes, levels,
 * turn-ins and stalls per hour, over the run and up to each cut. Each run is
 * written by the runner's own Trajectory (and the stack's SessionWriter for a
 * v1 record), one per shape the readout has to tell apart: a 0.5 run, a v1
 * run, a fan-out run, a claude-code run with and without its turns' results,
 * a codex run whose usage is the thread's running total, and a run with wake
 * records. Where the runner or the viewer has a rule of its own (the drivers'
 * usage shapes, codex's per-turn delta, the run's token totals, the price
 * row), the readout is pinned to it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionWriter } from "@wrathbench/mcp/record";
import { loadRunConfig } from "../runner/src/config";
import { type CodexUsage, codexUsageDelta } from "../runner/src/codex-usage";
import { DRIVER_LIST } from "../runner/src/drivers";
import { readRunRow } from "../runner/src/run-reader";
import { Trajectory } from "../runner/src/trajectory";
import { priceFor } from "../runner/viewer/pricing";
import { scanRunTotals } from "../runner/viewer/tail";
import { writeLegacy05Run, type Legacy05State } from "../runner/test/fixtures/legacy05-writer";
import { recordDrain, traceOfReading, type TraceReading, writeReadings } from "../runner/test/fixtures/v1-session";
import { codexDelta, DRIVER_USAGE, type InspectStore, main, requestPrice, stallSpans, type WindowFigures } from "./inspect-run";
import { memoryStore } from "./inspect-memory-store";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const MIN = 60_000;
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const T0 = NOW - 3 * 3_600_000;
const TOKEN = "ef56".repeat(16);
const RUNS = tmp("inspect-requests-");

/** A record and the moment it is written. */
type At = [number, Record<string, unknown>];

/** A run's meta.json and trajectory, each record at its own moment, ended at `end`. */
async function writeRun(runId: string, config: Record<string, unknown>, records: At[], end: number): Promise<string> {
  const dir = join(RUNS, runId);
  let clock = T0;
  const traj = new Trajectory(dir, { now: () => clock });
  traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: T0, config: { ...loadRunConfig({ driver: "stub" }), runId, token: TOKEN, character: "Testwick", ...config } });
  for (const [ts, r] of records) {
    clock = ts;
    traj.append(r as Parameters<Trajectory["append"]>[0]);
  }
  clock = end;
  await traj.setTermination(runId, "episode-limit", "test");
  traj.close();
  return dir;
}

/** OpenRouter's shape, one response per request. */
function openrouter(ts: number, turn: number, o: { prompt?: number; cached?: number; out?: number; reasoning?: number; cost?: number } = {}): At[] {
  return [
    [ts, { t: "request", turn, adapter: "openai", messages: "m".repeat(100) }],
    [
      ts + 1_000,
      {
        t: "response",
        turn,
        message: { role: "assistant", content: "ok" },
        usage: {
          prompt_tokens: o.prompt ?? 1000,
          completion_tokens: o.out ?? 50,
          cached_tokens: o.cached ?? 600,
          reasoning_tokens: o.reasoning ?? 20,
          cost: o.cost ?? 0.01,
        },
      },
    ],
  ];
}

const reading = (min: number, r: Omit<TraceReading, "ts">): TraceReading => ({ ts: T0 + min * MIN, map: 0, x: 100, y: 100, z: 10, money: 50, ...r });

/**
 * A v1 run on OpenRouter: six requests, its character idle from 5m to 30m
 * (read every five minutes), a level and a turn-in at 30m, another level at
 * 40m, and nothing read after it to the end at 60m.
 */
const V1 = "run-v1";
{
  const records = [0, 6, 12, 18, 24, 30].flatMap((m, i) => openrouter(T0 + m * MIN + 10_000, i + 1));
  const dir = await writeRun(V1, { driver: "openai", model: "deepseek/deepseek-v4.1-flash", apiBase: "https://openrouter.ai/api/v1" }, records, T0 + 60 * MIN);
  writeReadings(dir, [
    reading(0, { level: 1, xp: 0 }),
    reading(5, { level: 1, xp: 100 }),
    ...[10, 15, 20, 25].map((m) => reading(m, { level: 1, xp: 100 })),
    reading(30, { level: 2, xp: 0, quests: 1 }),
    reading(40, { level: 3, xp: 0 }),
  ]);
}

/** The same run with the adapter's retries on the record between each request and its response (`adapter_retry`). */
const V1_RETRIED = "run-v1-retried";
{
  const records = [0, 6, 12, 18, 24, 30].flatMap((m, i) => {
    const [request, response] = openrouter(T0 + m * MIN + 10_000, i + 1);
    const retry: At = [request![0] + 500, { t: "harness", kind: "adapter_retry", attempt: 2, of: 10, waitMs: 400, cause: "http", status: 429, detail: "HTTP 429: slow down" }];
    return [request!, retry, response!];
  });
  const dir = await writeRun(V1_RETRIED, { driver: "openai", model: "deepseek/deepseek-v4.1-flash", apiBase: "https://openrouter.ai/api/v1" }, records, T0 + 60 * MIN);
  writeReadings(dir, [
    reading(0, { level: 1, xp: 0 }),
    reading(5, { level: 1, xp: 100 }),
    ...[10, 15, 20, 25].map((m) => reading(m, { level: 1, xp: 100 })),
    reading(30, { level: 2, xp: 0, quests: 1 }),
    reading(40, { level: 3, xp: 0 }),
  ]);
}

/** A 0.5 run: run.sqlite's minute samples, its character idle from 3m to 13m, and the stub's responses. */
const OLD = "run-05";
{
  const records = [1, 2, 3, 4].flatMap((m, i) => openrouter(T0 + m * MIN, i + 1, { prompt: 2000, cached: 0, out: 100, cost: 0.02 }));
  const dir = await writeRun(OLD, { driver: "stub", model: "test/model" }, records, T0 + 20 * MIN);
  const states: Legacy05State[] = [];
  for (let m = 0; m <= 20; m++) {
    const xp = m < 3 ? m * 10 : m < 13 ? 30 : 30 + (m - 12) * 10;
    states.push({ ts: T0 + m * MIN, level: 2, xp, money: 7, questsCompleted: m >= 15 ? 1 : 0, turn: m, zone: 12, map: 0, x: 1, y: 1, z: 1 });
  }
  writeLegacy05Run(dir, readRunRow(dir, OLD)!, states);
}

/** A fan-out run: Alfa idle 0–20m, Bravo idle 10–30m, read every five minutes, so the run stalls 10–20m only. */
const FAN = "run-fan";
{
  const records = [2, 8, 14, 22].flatMap((m, i) => openrouter(T0 + m * MIN, i + 1));
  const dir = await writeRun(FAN, { driver: "openai", model: "test/model", fanout: { characters: 2, accounts: ["FA", "FB"] } }, records, T0 + 30 * MIN);
  const readings: Record<string, TraceReading[]> = {
    Alfa: [0, 5, 10, 15].map((m) => reading(m, { level: 1, xp: 0 })).concat([reading(20, { level: 2, xp: 0 }), reading(25, { level: 2, xp: 50 }), reading(30, { level: 2, xp: 90 })]),
    Bravo: [reading(0, { level: 1, xp: 0 }), reading(5, { level: 1, xp: 40 }), reading(10, { level: 1, xp: 80 })].concat([15, 20, 25, 30].map((m) => reading(m, { level: 1, xp: 80 }))),
  };
  for (const [i, [name, rs]] of Object.entries(readings).entries()) {
    const clock = { now: rs[0]!.ts };
    const writer = new SessionWriter({ dir: join(dir, "sessions", name), id: `fa0f0f0f0f0f0f0${i}`, stack: { version: "0.0.0-test" }, now: () => clock.now, log: () => {} });
    writer.open();
    const character = { guid: String(900 + i), name, race: 1, class: 1 };
    for (const r of rs) {
      clock.now = r.ts;
      const t = traceOfReading(r);
      writer.ingest(recordDrain({ trace: t.trace, dict: t.dict, character }));
    }
    await writer.close();
  }
}

/**
 * claude-code: a message's earlier envelope carries no usage; turn 1 has a
 * result (400 output, $0.30 so far in the session), turn 2 was cut short and
 * has only its opening snapshot.
 */
const CLAUDE = "run-claude";
const claudeUsage = (prompt: number, cached: number, out: number, write?: number): Record<string, unknown> => ({
  prompt_tokens: prompt,
  completion_tokens: out,
  total_tokens: prompt + out,
  cached_tokens: cached,
  ...(write !== undefined ? { cache_write_tokens: write } : {}),
});
await writeRun(
  CLAUDE,
  { driver: "claude-code", model: "sonnet" },
  [
    [T0, { t: "driver", driver: "claude-code" }],
    // The context it hands the CLI once a session, as the driver records it.
    [T0 + 1, { t: "request", turn: 1, adapter: "claude-code", messages: "m".repeat(400) }],
    [T0 + 1 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "a" } }],
    [T0 + 1 * MIN + 1, { t: "response", turn: 1, message: { role: "assistant", content: "b" }, usage: claudeUsage(3000, 2000, 2, 500) }],
    [T0 + 2 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "c" }, usage: claudeUsage(3200, 2900, 1) }],
    [T0 + 3 * MIN, { t: "claude_result", turn: 1, sessionId: "s1", costUsd: 0.3, usageRaw: { output_tokens: 400 }, usage: { prompt_tokens: 6200, completion_tokens: 400 } }],
    [T0 + 4 * MIN, { t: "response", turn: 2, message: { role: "assistant", content: "d" }, usage: claudeUsage(3500, 3000, 3) }],
  ],
  T0 + 5 * MIN,
);

/** claude-code with no result at all: every output figure an opening snapshot. */
const SNAPSHOTS = "run-claude-snapshots";
await writeRun(
  SNAPSHOTS,
  { driver: "claude-code", model: "sonnet" },
  [
    [T0, { t: "driver", driver: "claude-code" }],
    [T0 + 1, { t: "request", turn: 1, adapter: "claude-code", messages: "m".repeat(400) }],
    [T0 + 1 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "a" }, usage: claudeUsage(3000, 2000, 2) }],
    [T0 + 2 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "b" }, usage: claudeUsage(3300, 3000, 1) }],
  ],
  T0 + 3 * MIN,
);

/**
 * claude-code as the CLI reports it now: the result's `num_turns` (5) is more
 * than the turn's messages (2), and it lands after the run's end, in the
 * wind-down's grace, with one more message before it. A second process (a
 * resume) is killed before its turn's result.
 */
const CLAUDE_TURNS = "run-claude-turns";
await writeRun(
  CLAUDE_TURNS,
  { driver: "claude-code", model: "sonnet" },
  [
    [T0, { t: "driver", driver: "claude-code" }],
    [T0 + 1, { t: "request", turn: 1, adapter: "claude-code", messages: "m".repeat(400) }],
    [T0 + 1 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "a" } }],
    [T0 + 1 * MIN + 1, { t: "response", turn: 1, message: { role: "assistant", content: "b" }, usage: claudeUsage(3000, 2000, 2, 500) }],
    [T0 + 2 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "c" }, usage: claudeUsage(4000, 3500, 1) }],
    [T0 + 4 * MIN, { t: "driver", driver: "claude-code" }],
    [T0 + 4 * MIN + 1, { t: "request", turn: 1, adapter: "claude-code", messages: "m".repeat(400) }],
    [T0 + 5 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "d" }, usage: claudeUsage(5000, 4500, 4) }],
    [T0 + 6 * MIN, { t: "driver", driver: "claude-code" }],
    [T0 + 6 * MIN + 1, { t: "request", turn: 1, adapter: "claude-code", messages: "m".repeat(400) }],
    [T0 + 7 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "e" }, usage: claudeUsage(3000, 2500, 2) }],
    [T0 + 8 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "f" }, usage: claudeUsage(3100, 2900, 1) }],
    // The run ends at T0 + 9 min; the wind-down's last message and the result land after it.
    [T0 + 9 * MIN + 10_000, { t: "response", turn: 1, message: { role: "assistant", content: "g" }, usage: claudeUsage(3200, 3000, 1) }],
    [
      T0 + 9 * MIN + 20_000,
      { t: "claude_result", turn: 1, sessionId: "s3", numTurns: 6, costUsd: 0.5, usageRaw: { input_tokens: 400, output_tokens: 1200, cache_read_input_tokens: 8400, cache_creation_input_tokens: 500 }, usage: { prompt_tokens: 9300, completion_tokens: 1200, cached_tokens: 8400, cache_write_tokens: 500 } },
    ],
  ],
  T0 + 9 * MIN,
);

/**
 * codex from before per-turn deltas: each turn's usage is its thread's running
 * total, on the last of its response records; thread b starts again from zero.
 */
const CODEX = "run-codex";
const codexUsage = (prompt: number, out: number, cached: number): Record<string, unknown> => ({ prompt_tokens: prompt, completion_tokens: out, total_tokens: prompt + out, cached_tokens: cached });
await writeRun(
  CODEX,
  { driver: "codex", model: "gpt-6-astra" },
  [
    [T0, { t: "driver", driver: "codex" }],
    [T0 + 1, { t: "codex_thread", threadId: "a" }],
    [T0 + 1 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: "working" } }],
    [T0 + 2 * MIN, { t: "response", turn: 1, message: { role: "assistant", content: null }, usage: codexUsage(1000, 100, 500) }],
    [T0 + 4 * MIN, { t: "response", turn: 2, message: { role: "assistant", content: null }, usage: codexUsage(2500, 250, 1800) }],
    [T0 + 5 * MIN, { t: "codex_thread", threadId: "b" }],
    [T0 + 6 * MIN, { t: "response", turn: 3, message: { role: "assistant", content: null }, usage: codexUsage(800, 50, 0) }],
    // The driver's own per-turn figure, its thread total beside it: read as it is.
    [T0 + 8 * MIN, { t: "response", turn: 4, message: { role: "assistant", content: null }, usage: codexUsage(300, 30, 200), usageCumulative: codexUsage(1100, 80, 200) }],
  ],
  T0 + 10 * MIN,
);

/** A run with wake records (`harness/wake`'s shape): three wakes, two of them at the cap. */
const WAKE = "run-wake";
await writeRun(
  WAKE,
  { driver: "openai", model: "test/model" },
  [
    ...openrouter(T0 + 1 * MIN, 1),
    ...openrouter(T0 + 2 * MIN, 2),
    [T0 + 7 * MIN, { t: "wake", via: "turn-end", turn: 2, fired: "cap", sleptMs: 5 * MIN, maxMs: 5 * MIN }],
    ...openrouter(T0 + 7 * MIN + 5_000, 3),
    [T0 + 12 * MIN, { t: "wake", via: "turn-end", turn: 3, fired: "cap", sleptMs: 4 * MIN, maxMs: 5 * MIN }],
    ...openrouter(T0 + 12 * MIN + 5_000, 4),
    ...openrouter(T0 + 13 * MIN, 5),
    [T0 + 15 * MIN, { t: "wake", via: "turn-end", turn: 5, fired: "died", sleptMs: 1 * MIN, maxMs: 5 * MIN }],
    ...openrouter(T0 + 15 * MIN + 5_000, 6),
  ],
  T0 + 20 * MIN,
);

async function inspect(argv: string[], store?: InspectStore): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {}, (l) => out.push(l), (l) => err.push(l), NOW, store === undefined ? {} : { store });
  return { code, out, err };
}

interface Readout {
  usage: string;
  price: Record<string, unknown>;
  windows: WindowFigures[];
  notes: string[];
}

async function readout(runId: string, flags: string[] = [], store?: InspectStore): Promise<Readout> {
  const r = await inspect(["requests", runId, "--runs-dir", RUNS, "--json", ...flags], store);
  expect(r.err).toEqual([]);
  expect(r.code).toBe(0);
  expect(r.out).toHaveLength(1);
  return JSON.parse(r.out[0]!) as Readout;
}

/** A window's prompt, cached and output totals, from its per-request figures. */
function totals(w: WindowFigures): { prompt: number; cached: number; output: number } {
  return {
    prompt: Math.round((w.uncachedInPerRequest ?? 0) * w.reported.input + (w.cachedInPerRequest ?? 0) * w.reported.cached),
    cached: Math.round((w.cachedInPerRequest ?? 0) * w.reported.cached),
    output: Math.round((w.outputPerRequest ?? 0) * w.reported.output),
  };
}

describe("the rules it shares with the runner and the viewer", () => {
  test("each driver's usage shape is the driver table's", () => {
    for (const d of DRIVER_LIST) expect([d.id, DRIVER_USAGE[d.id]]).toEqual([d.id, d.usage]);
    expect(Object.keys(DRIVER_USAGE).sort()).toEqual(DRIVER_LIST.map((d) => d.id).sort());
  });

  test("codex's per-turn delta is the runner's", () => {
    const pairs: [CodexUsage | undefined, CodexUsage][] = [
      [undefined, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 40 }],
      [
        { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 40 },
        { prompt_tokens: 250, completion_tokens: 30, total_tokens: 280, cached_tokens: 90, reasoning_tokens: 7 },
      ],
      // A drop is a new baseline: the fields that fell read zero.
      [
        { prompt_tokens: 900, completion_tokens: 90, total_tokens: 990 },
        { prompt_tokens: 500, completion_tokens: 95, total_tokens: 595, cache_write_tokens: 3 },
      ],
    ];
    const of = (u: CodexUsage) => ({
      prompt: u.prompt_tokens,
      completion: u.completion_tokens,
      ...(u.cached_tokens !== undefined ? { cached: u.cached_tokens } : {}),
      ...(u.cache_write_tokens !== undefined ? { write: u.cache_write_tokens } : {}),
      ...(u.reasoning_tokens !== undefined ? { reasoning: u.reasoning_tokens } : {}),
    });
    for (const [prev, cur] of pairs) {
      expect(codexDelta(prev === undefined ? undefined : of(prev), of(cur))).toEqual(of(codexUsageDelta(prev, cur)));
    }
  });

  test("the price row is the viewer's, at the run's start and at another day", () => {
    const cat = JSON.parse(readFileSync(join(import.meta.dir, "model-catalogue.json"), "utf8")) as Record<string, unknown>;
    const runs = [
      { model: "deepseek/deepseek-v4.1-flash", driver: "openai", apiBase: "https://openrouter.ai/api/v1" },
      { model: "deepseek-v4.1-flash", driver: "openai", apiBase: "https://opencode.ai/inference/go/openai/v1" },
      { model: "gpt-6-astra", driver: "codex", apiBase: null },
      { model: "sonnet", driver: "claude-code", apiBase: null, resolvedModel: "claude-fable-5-1" },
      { model: "vendor/flash-model:free", driver: "openai", apiBase: "https://openrouter.ai/api/v1" },
    ];
    for (const at of [Date.UTC(2026, 8, 15), Date.UTC(2026, 10, 1)]) {
      for (const r of runs) {
        const theirs = priceFor({ model: r.model, apiBase: r.apiBase, driver: r.driver, harness: null, platform: null, declaredBilling: null, resolvedModel: r.resolvedModel ?? null } as never, at);
        const ours = requestPrice(cat, { model: r.model, driver: r.driver, apiBase: r.apiBase, resolvedModel: r.resolvedModel ?? null, billing: null }, at);
        expect(theirs).not.toBeNull();
        expect("none" in ours ? ours : { input: ours.input, output: ours.output, cacheRead: ours.cacheRead, cacheWrite: ours.cacheWrite }).toEqual({
          input: theirs!.input,
          output: theirs!.output,
          cacheRead: theirs!.cacheRead,
          cacheWrite: theirs!.cacheWrite,
        });
      }
    }
    // What it does not price, it says rather than guesses.
    expect(requestPrice(cat, { model: "qwen/qwen3.8-27b", driver: "openai", apiBase: "http://10.0.0.5:8000/v1", resolvedModel: null, billing: null }, NOW)).toMatchObject({ none: expect.stringContaining("no row here") });
    expect(requestPrice(null, { model: "x", driver: "openai", apiBase: null, resolvedModel: null, billing: null }, NOW)).toMatchObject({ none: expect.stringContaining("no price table") });
  });
});

describe("a v1 run", () => {
  test("per request, per turn and per hour, priced at the catalogue's row and pinned to the viewer's totals", async () => {
    const r = await readout(V1);
    expect(r.usage).toBe("response");
    const w = r.windows[0]!;
    expect(w.label).toBe("run");
    expect(w.activeMinutes).toBe(60);
    expect(w.requests).toBe(6);
    expect(w.requestsPerHour).toBe(6);
    expect([w.uncachedInPerRequest, w.cachedInPerRequest, w.outputPerRequest, w.reasoningPerRequest]).toEqual([400, 600, 50, 20]);
    expect(w.reportedUsd).toBeCloseTo(0.06, 10);
    expect(w.wakes).toMatchObject({ by: "turn", count: 6, requestsPer: 1, asleepShare: null });
    const scanned = await scanRunTotals(join(RUNS, V1, "trajectory.jsonl"));
    const viewer = scanned.tokens;
    expect(totals(w)).toEqual({ prompt: viewer.promptTokens, cached: viewer.cacheReadTokens!, output: viewer.completionTokens });
    expect(w.reportedUsd).toBeCloseTo(scanned.reportedCostUsd!, 12);
    // 3,600 uncached, 2,400 read and 300 out at the row in force on T0 (2030: the newest window).
    expect(r.price).toMatchObject({ id: "deepseek/deepseek-v4.1-flash", input: 0.14, output: 0.42, cacheRead: 0.0042 });
    expect(w.pricedUsd).toBeCloseTo((2400 * 0.14 + 3600 * 0.0042 + 300 * 0.42) / 1e6, 12);
  });

  test("a retry record between a request and its response changes none of its figures", async () => {
    expect(JSON.stringify(await readout(V1_RETRIED)).replace(V1_RETRIED, V1)).toBe(JSON.stringify(await readout(V1)));
  });

  test("levels and turn-ins off the record, and its stalls by stuck's rule; what nothing covers is never a stall", async () => {
    const w = (await readout(V1)).windows[0]!;
    expect(w.characters).toEqual([expect.objectContaining({ name: "Testwick", levelFrom: 1, levelTo: 3, quests: 1 })]);
    expect(w.levelsPerHour).toBe(2);
    expect(w.quests).toBe(1);
    // 5m–30m with nothing changing and 30m–40m, then 20 minutes no reading or write covers.
    expect(w.stallMinutes).toBe(35);
    expect(w.uncoveredMinutes).toBe(20);
  });

  test("the cuts run from the start: to a level, and to active minutes", async () => {
    const r = await readout(V1, ["--at-level", "2,9", "--at-minutes", "20,90", "--stall", "10m"]);
    expect(r.windows.map((w) => [w.label, w.reached])).toEqual([
      ["run", true],
      ["to L2", true],
      ["to L9", false],
      ["to 20m", true],
      ["to 90m", false],
    ]);
    const [, l2, , m20] = r.windows;
    expect([l2!.until, l2!.activeMinutes, l2!.requests, l2!.quests, l2!.stallMinutes]).toEqual([T0 + 30 * MIN, 30, 5, 1, 25]);
    expect([m20!.until, m20!.requests, m20!.stallMinutes, m20!.levelsPerHour]).toEqual([T0 + 20 * MIN, 4, 15, 0]);
    // A ten-minute floor drops 30m–40m from the run's stalls.
    expect(r.windows[0]!.stallMinutes).toBe(25);
  });

  test("--since and --until window the main column only", async () => {
    const r = await readout(V1, ["--since", String(T0 + 10 * MIN), "--until", String(T0 + 20 * MIN)]);
    const w = r.windows[0]!;
    expect([w.label, w.requests, w.activeMinutes, w.stallMinutes]).toEqual(["window", 2, 10, 10]);
    expect(w.characters[0]).toMatchObject({ levelFrom: 1, levelTo: 1, quests: 0 });
  });

  test("the store reads what the files read", async () => {
    const store = await memoryStore(RUNS);
    const flags = ["--at-level", "2", "--at-minutes", "20"];
    for (const id of [V1, OLD, FAN, CLAUDE, CLAUDE_TURNS, CODEX, WAKE]) expect([id, (await readout(id, flags, store)).windows]).toEqual([id, (await readout(id, flags)).windows]);
  });

  test("the text form: a column per window, labels, and the notes", async () => {
    const r = await inspect(["requests", V1, "--runs-dir", RUNS, "--at-level", "2", "--at-minutes", "90"]);
    expect(r.code).toBe(0);
    const text = r.out.join("\n");
    expect(text).toContain(`${V1}: model requests over run, to L2, to 90m, UTC`);
    expect(text).toMatch(/^price {5}deepseek\/deepseek-v4\.1-flash at \$0\.14\/\$0\.42/m);
    expect(text).toMatch(/^requests +6 +5 +not reached$/m);
    expect(text).toMatch(/^uncached in\/request +400 +400 +not reached$/m);
    expect(text).toMatch(/^stall minutes +35\.0 \(\+20\.0\?\) +25\.0 +not reached$/m);
    expect(text).toMatch(/^Testwick +L1→L3 +L1→L2 +not reached$/m);
    expect(text).toContain("no wake records: wakes are harness turns");
    expect(text).not.toContain(TOKEN);
  });
});

describe("a 0.5 run", () => {
  test("its samples are run.sqlite's, read once no owner can be writing it", async () => {
    const w = (await readout(OLD)).windows[0]!;
    expect([w.requests, w.uncachedInPerRequest, w.cachedInPerRequest, w.outputPerRequest, w.reportedUsd]).toEqual([4, 2000, 0, 100, 0.08]);
    // xp held from 3m to 13m: ten minutes; the turn-in at 15m.
    expect([w.stallMinutes, w.uncoveredMinutes, w.quests]).toEqual([10, 0, 1]);
    expect(w.characters[0]).toMatchObject({ levelFrom: 2, levelTo: 2 });
  });
});

describe("a fan-out run", () => {
  test("each character's levels and stalls, and the run stalled only while every character was", async () => {
    const r = await readout(FAN, ["--at-level", "2"]);
    const w = r.windows[0]!;
    expect(w.characters.map((c) => [c.name, c.levelFrom, c.levelTo, c.stallMinutes])).toEqual([
      ["Alfa", 1, 2, 20],
      ["Bravo", 1, 1, 20],
    ]);
    expect(w.stallMinutes).toBe(10);
    expect(w.levelsPerHour).toBe(2);
    // The cut is where the first character reached the level, and the note names each.
    expect(r.windows[1]).toMatchObject({ label: "to L2", until: T0 + 20 * MIN, reached: true });
    expect(r.notes).toContain("to L2: Alfa at 20m; 1 never");
  });
});

describe("claude-code", () => {
  test("with no num_turns on its result, a request is a usage-bearing response; output is each turn's result over its messages, and a turn with none is unreported", async () => {
    const r = await readout(CLAUDE);
    const w = r.windows[0]!;
    expect(r.usage).toBe("turn-snapshot");
    expect(w.requests).toBe(3);
    expect(w.reported).toMatchObject({ input: 3, output: 2 });
    expect(w.outputPerRequest).toBe(200);
    expect(w.reportedUsd).toBeCloseTo(0.3, 10);
    expect(r.notes.find((n) => n.startsWith("claude-code:"))).toContain("1 earlier envelope(s)");
    expect(r.notes.find((n) => n.startsWith("claude-code:"))).toContain("1 message(s) in 1 driver turn(s) have no result");
    // The viewer's totals: the same prompt, and the same output, the results' and never the snapshots.
    const scanned = await scanRunTotals(join(RUNS, CLAUDE, "trajectory.jsonl"));
    expect([totals(w).prompt, totals(w).output]).toEqual([scanned.tokens.promptTokens, scanned.tokens.completionTokens]);
    expect(w.reportedUsd).toBeCloseTo(scanned.reportedCostUsd!, 12);
    // The CLI's charge is per session and cumulative: the window's is what it added.
    const late = (await readout(CLAUDE, ["--since", String(T0 + 2 * MIN + 30_000)])).windows[0]!;
    expect(late.reportedUsd).toBeCloseTo(0.3, 10);
    expect((await readout(CLAUDE, ["--since", String(T0 + 3 * MIN + 1)])).windows[0]!.reportedUsd).toBeNull();
  });

  test("with only opening snapshots, output reads unreported, never the snapshots", async () => {
    const r = await readout(SNAPSHOTS);
    const w = r.windows[0]!;
    expect([w.requests, w.reported.output, w.outputPerRequest, w.reportedUsd]).toEqual([2, 0, null, null]);
    expect(r.notes.find((n) => n.startsWith("claude-code:"))).toContain("2 message(s) in 1 driver turn(s) have no result");
    // Where the viewer can only sum the snapshots, and labels its figure so, this reads unreported.
    const viewer = (await scanRunTotals(join(RUNS, SNAPSHOTS, "trajectory.jsonl"))).tokens;
    expect([viewer.source, viewer.completionTokens]).toEqual(["snapshot", 3]);
    expect(totals(w).prompt).toBe(viewer.promptTokens);
    const text = (await inspect(["requests", SNAPSHOTS, "--runs-dir", RUNS])).out.join("\n");
    expect(text).toMatch(/^output\/request +—$/m);
  });

  test("requests are the CLI's num_turns, a turn cut short counts its messages, and the wind-down's records are the run's", async () => {
    for (const store of [undefined, await memoryStore(RUNS)]) {
      const r = await readout(CLAUDE_TURNS, [], store);
      const w = r.windows[0]!;
      // The first process's 2 messages and the second's 1 got no result; the third's 3 stand for its 6 model turns.
      expect(w.requests).toBe(3 + 6);
      expect(w.reported).toMatchObject({ input: 9, output: 6 });
      expect(w.outputPerRequest).toBe(200);
      // The result after the run's end still counts, and its charge with it.
      expect(w.reportedUsd).toBeCloseTo(0.5, 10);
      // No wake records: wakes are the distinct turn numbers, here one, so a turn is weighted requests too.
      expect(w.wakes.requestsPer).toBe(9);
      const note = r.notes.find((n) => n.startsWith("claude-code: requests"));
      expect(note).toContain("6 in all");
      expect(note).toContain("3 message(s) in 2 driver turn(s) have no result");
      expect(r.notes).toContain("claude-code: 1 message(s) and 1 result(s) landed after the run's end, in the wind-down's grace, and count in the run column");
      // A cut inside the last turn holds its share of the turn's count, never a record's one.
      const cut = (await readout(CLAUDE_TURNS, ["--until", String(T0 + 7 * MIN + 30_000)], store)).windows[0]!;
      expect(cut.requests).toBe(3 + 2);
      expect(cut.reportedUsd).toBeNull();
      const text = (await inspect(["requests", CLAUDE_TURNS, "--runs-dir", RUNS], store)).out.join("\n");
      expect(text).toMatch(/^model turns \(requests\) +9$/m);
    }
  });
});

describe("claude-code's model turns, here and in the viewer", () => {
  test("a run's requests are the viewer's turns (runner/viewer/tail.ts `claudeModelTurns`), which this file copies", async () => {
    for (const id of [CLAUDE, SNAPSHOTS, CLAUDE_TURNS]) {
      const viewer = (await scanRunTotals(join(RUNS, id, "trajectory.jsonl"))).tokens.turns;
      expect([id, (await readout(id)).windows[0]!.requests]).toEqual([id, viewer]);
    }
  });
});

describe("codex", () => {
  test("a request is a CLI turn, and a thread's running totals become what each turn added", async () => {
    const r = await readout(CODEX);
    const w = r.windows[0]!;
    expect(r.usage).toBe("exec-tally");
    expect(w.requests).toBe(4);
    expect(totals(w)).toEqual({ prompt: 1000 + 1500 + 800 + 300, cached: 500 + 1300 + 0 + 200, output: 100 + 150 + 50 + 30 });
    const note = r.notes.find((n) => n.startsWith("codex:"))!;
    expect(note).toContain("one CLI turn");
    expect(note).toContain("3 turn(s) recorded the thread's running total");
    const viewer = (await scanRunTotals(join(RUNS, CODEX, "trajectory.jsonl"))).tokens;
    expect([totals(w).prompt, totals(w).output]).toEqual([viewer.promptTokens, viewer.completionTokens]);
    const text = (await inspect(["requests", CODEX, "--runs-dir", RUNS])).out.join("\n");
    expect(text).toMatch(/^CLI turns \(requests\) +4$/m);
    // A CLI turn is one request: what varies is the items the model answered with, five over four turns.
    expect(w.wakes.responsesPer).toBe(1.25);
    expect(text).toMatch(/^ {2}responses per turn +1\.3$/m);
    expect(r.notes.some((n) => n.startsWith("codex: responses per wake counts the response records"))).toBe(true);
  });
});

describe("wake records", () => {
  test("requests per wake, wakes by what fired them, and the asleep share", async () => {
    const r = await readout(WAKE);
    const w = r.windows[0]!;
    expect(w.wakes).toEqual({ by: "wake", count: 3, perHour: 9, requestsPer: 2, responsesPer: 2, fired: { cap: 2, died: 1 }, asleepShare: 0.5 });
    expect(r.notes).toContain("wakes are the run's wake records; asleep is their slept time over the active time");
    const text = (await inspect(["requests", WAKE, "--runs-dir", RUNS])).out.join("\n");
    expect(text).toMatch(/^wakes +3$/m);
    expect(text).toMatch(/^ {2}requests per wake +2\.0$/m);
    expect(text).toMatch(/^ {2}asleep +50%$/m);
    expect(text).toMatch(/^ {2}fired by +cap 2, died 1$/m);
  });
});

describe("stallSpans", () => {
  const s = (min: number, x: number, xp = 0) => ({ ts: T0 + min * MIN, level: 1, xp, money: 0, quests: 0, map: 0, x, y: 0, z: 0, items: null });
  const t = { moveYards: 50, maxGapMs: 15 * MIN, stallMs: 5 * MIN };
  test("movement is measured from where the stretch began, so a slow drift past the yards is progress", () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => s(m, m * 10));
    const { stalls } = stallSpans(samples, { since: T0, until: T0 + 10 * MIN }, t);
    expect(stalls).toEqual([[T0, T0 + 6 * MIN]]);
  });
  test("a stretch before the first reading is uncovered, not stalled", () => {
    const { stalls, uncovered } = stallSpans([s(4, 0), s(12, 0)], { since: T0, until: T0 + 12 * MIN }, t, []);
    expect(uncovered).toEqual([[T0, T0 + 4 * MIN]]);
    expect(stalls).toEqual([[T0 + 4 * MIN, T0 + 12 * MIN]]);
  });
});

describe("the command line", () => {
  test("refuses what it cannot read", async () => {
    for (const [flags, msg] of [
      [["--at-level", "0"], "--at-level is a whole number"],
      [["--at-minutes", "x"], "--at-minutes is a whole number"],
      [["--stall", "5"], "--stall is a duration"],
      [["--price-at", "Sept"], "--price-at is a day"],
      [["--errors"], "--errors does not apply to requests"],
    ] as const) {
      const r = await inspect(["requests", V1, "--runs-dir", RUNS, ...flags]);
      expect(r.code).toBe(2);
      expect(r.err.join("\n")).toContain(msg);
    }
    expect((await inspect(["run", V1, "--runs-dir", RUNS, "--json"])).err.join("\n")).toContain("--json does not apply to run");
  });

  test("--json keeps stdout to the one object, a character's session id too", async () => {
    const r = await inspect(["requests", `${FAN}~Alfa`, "--runs-dir", RUNS, "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out.join("")) as Readout).windows[0]!.requests).toBe(4);
    expect(r.err.join("\n")).toContain(`${FAN}~Alfa is Alfa's session: this view is the run's`);
  });

  test("--price-at re-prices at that day's window and says so", async () => {
    const r = await readout(V1, ["--price-at", "2026-09-15"]);
    expect(r.price).toMatchObject({ input: 0.15, output: 0.6, at: Date.UTC(2026, 8, 15) });
    const text = (await inspect(["requests", V1, "--runs-dir", RUNS, "--price-at", "2026-09-15"])).out.join("\n");
    expect(text).toContain("at --price-at 2026-09-15");
  });

  test("a catalogue it cannot find is said, not guessed", async () => {
    const r = await readout(V1, ["--catalogue", join(RUNS, "none.json")]);
    expect(r.price).toEqual({ none: "no price table here (infra/model-catalogue.json not found)" });
    expect(r.windows[0]!.pricedUsd).toBeNull();
  });
});
