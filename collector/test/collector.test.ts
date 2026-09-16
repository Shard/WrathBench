/**
 * The collector, over synthetic run directories in a temp dir.
 *
 * Fixture-based and green from a bare clone: no `data/`, no ClickHouse. The
 * runs are built with the runner's own `Trajectory`, so the sqlite schema and
 * the JSONL shape under test are the ones the runner really writes rather than
 * a copy that can drift from it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trajectory } from "../../runner/src/trajectory";
import { Collector } from "../src/collector";
import { readConfig } from "../src/config";
import { OffsetStore } from "../src/offsets";
import { memorySink } from "../src/sink";
import { splitStatements } from "../src/schema";
import { tailLines } from "../src/tailer";
import { parseLine, usageOf, TURN_KINDS } from "../src/lines";
import { retryDelayMs, clickhouseSink, SinkAborted, jsonEachRow } from "../src/sink";
import { RunTotalsScanner } from "../../runner/viewer/tail";
import { readRunFact } from "../../runner/src/models";

const roots: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "collector-"));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/**
 * One run directory written the way the runner writes one: meta.json, a
 * run.sqlite with run/state/move rows, and a trajectory.jsonl carrying turn
 * lines, a milestone and a termination.
 */
function writeRun(runsDir: string, runId: string): string {
  const dir = join(runsDir, runId);
  const traj = new Trajectory(dir);
  traj.writeMeta({
    runId,
    harnessVersion: "harness-0.5-1-gtest",
    startedAt: 1_000,
    config: {
      runId,
      driver: "openai",
      model: "test-model",
      apiBase: "https://example.invalid/v1",
      watchdogs: { episodeMs: 5_400_000 },
    } as never,
    comparability: { episode: "e90", harness: "wrathbench" } as never,
  });
  traj.append({ t: "request", turn: 1, ts: 1_100, adapter: "openai", messages: [{ role: "user", content: "go" }] });
  traj.append({
    t: "response",
    turn: 1,
    ts: 1_200,
    message: { content: "ok" },
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.25 },
    finishReason: "stop",
  });
  traj.append({ t: "tool_call", turn: 1, ts: 1_250, name: "eval_snippet", args: {} });
  traj.append({ t: "snippet", turn: 1, ts: 1_260, code: "await sdk.self()" });
  traj.append({ t: "snippet_result", turn: 1, ts: 1_270, name: "eval_snippet", isError: false, text: "{}" });
  traj.append({ t: "events_served", ts: 1_280, via: "poll", count: 2, events: [{ a: 1 }, { a: 2 }] });
  traj.recordMilestone({ kind: "level", from: 1, to: 2, xp: 400, turn: 1 });
  traj.recordMilestone({ kind: "zone", from: { id: 1 }, to: { id: 12 }, turn: 1 });
  traj.recordState(runId, { level: 2, xp: 400, map: 0, x: 1, y: 2, z: 3, turn: 1, zone: 12 });
  traj.recordState(runId, { level: 2, xp: 500, map: 0, x: 4, y: 5, z: 6, turn: 2, zone: 12 });
  traj.recordMove(runId, { map: 0, x: 9, y: 9, z: 9, moveId: 1 });
  traj.recordMove(runId, { map: 0, x: 9, y: 9, z: 9, moveId: 1, status: "arrived" });
  traj.setTermination(runId, "episode-elapsed" as never, "done");
  traj.close();
  writeFileSync(join(dir, "episodic.jsonl"), `${JSON.stringify({ t: "note", ts: 1_300, text: "hi" })}\n`);
  return dir;
}

function collectorOver(runsDir: string): {
  collector: Collector;
  sink: ReturnType<typeof memorySink>;
  offsets: OffsetStore;
} {
  const sink = memorySink();
  const offsets = new OffsetStore(":memory:");
  const cfg = readConfig({ runsDir, dataDir: runsDir, stateDb: ":memory:" });
  return { collector: new Collector({ cfg, sink, offsets, log: () => {} }), sink, offsets };
}

function rowsOf(sink: ReturnType<typeof memorySink>, table: string): Record<string, unknown>[] {
  return (sink.tables.get(table) ?? []) as Record<string, unknown>[];
}

describe("a pass over one run", () => {
  const runsDir = tmpRoot();
  writeRun(runsDir, "run-a");
  const { collector, sink } = collectorOver(runsDir);

  test("every source lands in its own table", async () => {
    const stats = await collector.pass();
    expect(stats.seen).toBe(1);
    expect(stats.ingested).toBe(1);

    // Six turn-shaped lines; the rest are events.
    const turns = rowsOf(sink, "turns");
    expect(turns).toHaveLength(6);
    for (const kind of turns.map((r) => String(r["kind"]))) expect(TURN_KINDS.has(kind)).toBe(true);

    // meta, two milestones, two states, termination — and nothing turn-shaped.
    const events = rowsOf(sink, "events");
    expect(events.map((r) => r["kind"])).toContain("meta");
    expect(events.map((r) => r["kind"])).toContain("termination");
    expect(events.some((r) => TURN_KINDS.has(String(r["kind"])))).toBe(false);

    expect(rowsOf(sink, "milestones")).toHaveLength(2);
    expect(rowsOf(sink, "states")).toHaveLength(2);
    expect(rowsOf(sink, "moves")).toHaveLength(2);
    expect(rowsOf(sink, "episodic")).toHaveLength(1);
    expect(rowsOf(sink, "runs")).toHaveLength(1);
    expect(rowsOf(sink, "run_totals")).toHaveLength(1);
  });

  test("the run row merges run.sqlite with meta.json", () => {
    const [row] = rowsOf(sink, "runs");
    expect(row?.["run_id"]).toBe("run-a");
    expect(row?.["archived"]).toBe(0);
    expect(row?.["model"]).toBe("test-model");
    expect(row?.["termination_reason"]).toBe("episode-elapsed");
    expect(row?.["harness_version"]).toBe("harness-0.5-1-gtest");
    // Only meta.json knows the tuple; only run.sqlite knows the driver.
    expect(JSON.parse(String(row?.["comparability_json"]))).toMatchObject({ episode: "e90" });
    expect(row?.["driver"]).toBe("openai");
    expect(Number(row?.["trajectory_bytes"])).toBeGreaterThan(0);
  });

  test("usage is read into columns whichever shape the provider sent", () => {
    const response = rowsOf(sink, "turns").find((r) => r["kind"] === "response");
    expect(response?.["input_tokens"]).toBe(11);
    expect(response?.["output_tokens"]).toBe(7);
    expect(response?.["cost_usd"]).toBe(0.25);
    expect(response?.["finish_reason"]).toBe("stop");
  });

  test("the big columns carry the payloads and raw carries the whole line", () => {
    const req = rowsOf(sink, "turns").find((r) => r["kind"] === "request");
    expect(JSON.parse(String(req?.["messages"]))).toEqual([{ role: "user", content: "go" }]);
    expect(JSON.parse(String(req?.["raw"]))).toMatchObject({ t: "request", turn: 1 });
    const served = rowsOf(sink, "turns").find((r) => r["kind"] === "events_served");
    expect(served?.["event_count"]).toBe(2);
    expect(JSON.parse(String(served?.["events"]))).toHaveLength(2);
  });

  test("milestone shapes land on one row shape", () => {
    const rows = rowsOf(sink, "milestones");
    const level = rows.find((r) => r["kind"] === "level");
    const zone = rows.find((r) => r["kind"] === "zone");
    // A level carries bare numbers; a zone carries {id}. Both read the same.
    expect(level?.["from_id"]).toBe(1);
    expect(level?.["to_id"]).toBe(2);
    expect(zone?.["from_id"]).toBe(1);
    expect(zone?.["to_id"]).toBe(12);
  });

  test("the totals row carries the viewer's own derivation", () => {
    const [row] = rowsOf(sink, "run_totals");
    const totals = JSON.parse(String(row?.["totals_json"])) as {
      modelResponses: number;
      toolCalls: number;
      snippets: number;
      leveling: unknown;
    };
    expect(totals.modelResponses).toBe(1);
    expect(totals.toolCalls).toBe(1);
    expect(totals.snippets).toBe(1);
    // An ordering-sensitive derivation nothing here reimplements in SQL.
    expect(totals.leveling).not.toBeNull();
    const fact = JSON.parse(String(row?.["fact_json"])) as { runId: string; bestLevel: number };
    expect(fact.runId).toBe("run-a");
    expect(fact.bestLevel).toBe(2);
  });
});

/**
 * The read path is about to depend on these two blobs being the whole answer,
 * not a summary of it. A field that serialises to `null` because it was
 * `undefined`, or a number that `JSON.stringify` turns into `null` because it
 * was `Infinity`, would reach the viewer as a silently different run.
 */
describe("the stored derivations are the same objects the viewer computed", () => {
  test("totals_json round-trips a whole RunTotals", async () => {
    const runsDir = tmpRoot();
    const dir = writeRun(runsDir, "run-totals");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const stored: unknown = JSON.parse(String(rowsOf(sink, "run_totals")[0]?.["totals_json"]));
    const fresh = await new RunTotalsScanner(join(dir, "trajectory.jsonl")).scan();
    expect(stored).toEqual(JSON.parse(JSON.stringify(fresh)));
  });

  test("fact_json round-trips a whole RunFact", async () => {
    const runsDir = tmpRoot();
    writeRun(runsDir, "run-fact");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const stored = JSON.parse(String(rowsOf(sink, "run_totals")[0]?.["fact_json"])) as Record<string, unknown>;
    const fresh = readRunFact(runsDir, "run-fact");
    // `live` is decided against `now` on both sides; everything else is fixed.
    expect(Object.keys(stored).sort()).toEqual(Object.keys(fresh ?? {}).sort());
    expect(stored).toEqual(JSON.parse(JSON.stringify({ ...fresh, live: stored["live"] })));
  });

  /**
   * The incremental scanner is the one thing here that could silently corrupt
   * a live run's totals: it folds only the bytes appended since its last read,
   * and nothing else would notice if it folded them wrongly.
   */
  test("an incrementally folded total equals a from-scratch one", async () => {
    const runsDir = tmpRoot();
    const dir = writeRun(runsDir, "run-fold");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const path = join(dir, "trajectory.jsonl");
    appendFileSync(
      path,
      `${JSON.stringify({ t: "response", ts: 5_000, turn: 2, usage: { input_tokens: 40, output_tokens: 9 } })}\n` +
        `${JSON.stringify({ t: "milestone", ts: 5_100, kind: "level", from: 2, to: 3 })}\n`,
    );
    await collector.pass();
    const stored: unknown = JSON.parse(String(rowsOf(sink, "run_totals").at(-1)?.["totals_json"]));
    const fresh = await new RunTotalsScanner(path).scan();
    expect(stored).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});

describe("resume and replay", () => {
  test("a second pass over an unchanged tree sends nothing", async () => {
    const runsDir = tmpRoot();
    writeRun(runsDir, "run-b");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const before = sink.tables.get("turns")?.length ?? 0;
    const stats = await collector.pass();
    expect(stats.ingested).toBe(0);
    expect(sink.tables.get("turns")?.length ?? 0).toBe(before);
  });

  test("appended lines are read from the offset, not from zero", async () => {
    const runsDir = tmpRoot();
    const dir = writeRun(runsDir, "run-c");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const first = rowsOf(sink, "turns").length;
    const lastLine = Math.max(...rowsOf(sink, "events").map((r) => Number(r["line_no"])));
    appendFileSync(
      join(dir, "trajectory.jsonl"),
      `${JSON.stringify({ t: "response", ts: 2_000, turn: 2, usage: { input_tokens: 1, output_tokens: 2 } })}\n`,
    );
    await collector.pass();
    const turns = rowsOf(sink, "turns");
    expect(turns).toHaveLength(first + 1);
    // The ordinal continues; it does not restart, which is what makes the key
    // stable across a restart AND across a replay.
    expect(turns[turns.length - 1]?.["line_no"]).toBe(lastLine + 1);
  });

  test("replay re-reads every run from byte zero with the same keys", async () => {
    const runsDir = tmpRoot();
    writeRun(runsDir, "run-d");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const first = rowsOf(sink, "turns").map((r) => `${String(r["run_id"])}:${String(r["line_no"])}`);
    collector.replayFromZero();
    await collector.pass();
    const all = rowsOf(sink, "turns").map((r) => `${String(r["run_id"])}:${String(r["line_no"])}`);
    // Twice the rows into a memory sink, but exactly the same keys: which is
    // what ReplacingMergeTree turns into one row on the real thing.
    expect(all).toHaveLength(first.length * 2);
    expect(all.slice(first.length)).toEqual(first);
  });

  test("a truncated trajectory is re-read whole rather than skipped", async () => {
    const runsDir = tmpRoot();
    const dir = writeRun(runsDir, "run-e");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    writeFileSync(join(dir, "trajectory.jsonl"), `${JSON.stringify({ t: "response", ts: 9, turn: 1 })}\n`);
    await collector.pass();
    const last = rowsOf(sink, "turns").at(-1);
    expect(last?.["line_no"]).toBe(0);
    expect(last?.["ts"]).toBe(9);
  });
});

describe("what the store must not lose", () => {
  test("a line that is not JSON lands in events.raw", async () => {
    const runsDir = tmpRoot();
    const dir = writeRun(runsDir, "run-f");
    appendFileSync(join(dir, "trajectory.jsonl"), "{not json at all\n");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const bad = rowsOf(sink, "events").find((r) => r["kind"] === "unparseable");
    expect(bad?.["raw"]).toBe("{not json at all");
  });

  test("a record kind nobody has written before still lands", async () => {
    const runsDir = tmpRoot();
    const dir = writeRun(runsDir, "run-g");
    appendFileSync(
      join(dir, "trajectory.jsonl"),
      `${JSON.stringify({ t: "some-future-kind", ts: 3_000, whatever: true })}\n`,
    );
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const row = rowsOf(sink, "events").find((r) => r["kind"] === "some-future-kind");
    expect(row).toBeDefined();
    expect(JSON.parse(String(row?.["raw"]))).toMatchObject({ whatever: true });
  });

  test("a half-written last line is not consumed", async () => {
    const runsDir = tmpRoot();
    const dir = writeRun(runsDir, "run-h");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const before = rowsOf(sink, "turns").length;
    // No trailing newline: the writer is mid-append.
    appendFileSync(join(dir, "trajectory.jsonl"), `{"t":"response","ts":4000`);
    await collector.pass();
    expect(rowsOf(sink, "turns")).toHaveLength(before);
    // ...and it is read once it is finished.
    appendFileSync(join(dir, "trajectory.jsonl"), `,"turn":3}\n`);
    await collector.pass();
    expect(rowsOf(sink, "turns")).toHaveLength(before + 1);
  });
});

describe("archived runs", () => {
  test("are ingested, flagged rather than skipped", async () => {
    const runsDir = tmpRoot();
    writeRun(join(runsDir, "archive"), "run-old");
    const { collector, sink } = collectorOver(runsDir);
    await collector.pass();
    const [row] = rowsOf(sink, "runs");
    expect(row?.["run_id"]).toBe("run-old");
    expect(row?.["archived"]).toBe(1);
    // The fact is read from the archive directory, not from the runs root.
    expect(JSON.parse(String(rowsOf(sink, "run_totals")[0]?.["fact_json"]))).toMatchObject({
      runId: "run-old",
    });
  });
});

describe("the tailer", () => {
  test("splits lines across chunk boundaries", async () => {
    const root = tmpRoot();
    const path = join(root, "lines.jsonl");
    const lines = ["{\"a\":1}", "{\"b\":22}", "{\"c\":333}"];
    writeFileSync(path, `${lines.join("\n")}\n`);
    const size = Bun.file(path).size;
    const out: string[] = [];
    // A chunk narrower than a line: the split has to survive it.
    for await (const l of tailLines(path, 0, size, 3)) if (l.text.length > 0) out.push(l.text);
    expect(out).toEqual(lines);
  });

  test("the offset it yields is always past a newline", async () => {
    const root = tmpRoot();
    const path = join(root, "off.jsonl");
    writeFileSync(path, "aa\nbbb\n");
    const ends: number[] = [];
    for await (const l of tailLines(path, 0, Bun.file(path).size, 2)) ends.push(l.endOffset);
    expect(ends).toEqual([3, 7]);
  });
});

describe("the boundary", () => {
  test("parseLine requires t and ts and passes the rest through", () => {
    expect(parseLine('{"t":"x","ts":1,"z":9}')).toMatchObject({ ok: true, t: "x", ts: 1 });
    expect(parseLine('{"t":"x"}').ok).toBe(false);
    expect(parseLine("nope").ok).toBe(false);
  });

  test("usage reads the Anthropic and OpenAI shapes into one row", () => {
    expect(usageOf({ usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7 } })).toMatchObject({
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 7,
    });
    expect(
      usageOf({ usage: { prompt_tokens: 5, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 3 } } }),
    ).toMatchObject({ input_tokens: 5, output_tokens: 6, reasoning_tokens: 3 });
    expect(usageOf({}).input_tokens).toBeNull();
  });
});

describe("the sink", () => {
  test("backoff is capped, never a give-up", () => {
    expect(retryDelayMs(0)).toBe(1_000);
    expect(retryDelayMs(3)).toBe(8_000);
    expect(retryDelayMs(99)).toBe(30_000);
  });

  test("JSONEachRow is one object per line", () => {
    expect(jsonEachRow([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });

  test("a down ClickHouse is retried, and a shutdown ends the wait", async () => {
    const cfg = readConfig({ url: "http://127.0.0.1:1/never", stateDb: ":memory:" });
    const controller = new AbortController();
    let attempts = 0;
    const sink = clickhouseSink(cfg, {
      signal: controller.signal,
      sleep: async () => {
        attempts++;
        if (attempts >= 3) controller.abort();
      },
    });
    await expect(sink.insert("runs", [{ run_id: "x" }])).rejects.toBeInstanceOf(SinkAborted);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });
});

describe("the schema file", () => {
  test("splits into statements, every one idempotent", async () => {
    const sql = await Bun.file(join(import.meta.dir, "..", "schema.sql")).text();
    const statements = splitStatements(sql);
    expect(statements.length).toBeGreaterThan(5);
    for (const s of statements) expect(s).toMatch(/IF NOT EXISTS/);
    // Every table the ingester writes to has DDL here.
    for (const t of ["runs", "states", "moves", "milestones", "turns", "events", "episodic", "run_totals"]) {
      expect(sql).toContain(`wrathbench.${t}`);
    }
  });
});
