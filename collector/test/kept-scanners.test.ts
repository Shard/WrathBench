/**
 * The collector keeps two resumable scanners per run across passes — the
 * totals scanner (`RunTotalsScanner`) and `readRunFact`'s record-count scanner —
 * so re-deriving a live run folds only the bytes appended since its last read.
 * Both have to give the full read's answer every time, through everything a
 * trajectory goes through: appends cut mid-record, torn lines, a pause and its
 * resume, quiet stretches, truncation, a file replaced or rotated under the
 * same path, an archive move, a collector restart, and continuation runs
 * beside each other.
 *
 * Every pass is checked against the uncached full reads at the collector's
 * own clock: the stored `fact_json` against `readRunFact` with no scanner
 * cache, and the stored `totals_json` against a `RunTotalsScanner` read from
 * byte zero. Where it matters the scanner objects themselves are checked too:
 * the same ones after a pass mean the pass folded only the appended bytes; new
 * ones mean the file was read whole.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunFact } from "../../runner/src/models";
import { Trajectory } from "../../runner/src/trajectory";
import { RunTotalsScanner } from "../../runner/viewer/tail";
import { Collector } from "../src/collector";
import { readConfig } from "../src/config";
import { SCANNER_QUIET_MS } from "../src/ingest";
import { OffsetStore } from "../src/offsets";
import { memorySink } from "../src/sink";

const roots: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "collector-kept-"));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A run still being written: meta, a run row, one response, no verdict. */
function writeLiveRun(runsDir: string, runId: string): string {
  const dir = join(runsDir, runId);
  const traj = new Trajectory(dir);
  traj.writeMeta({
    runId,
    harnessVersion: "harness-0.5-1-gtest",
    startedAt: 1_000,
    config: { runId, driver: "openai", model: "test-model", apiBase: "https://example.invalid/v1" } as never,
    comparability: { episode: "freeplay", harness: "wrathbench" } as never,
  });
  traj.append({ t: "response", turn: 1, ts: 1_200, message: { content: "ok" }, usage: { prompt_tokens: 10, completion_tokens: 3 } });
  traj.close();
  return dir;
}

type Sink = ReturnType<typeof memorySink>;

/** A collector on a clock the test moves. */
function clocked(runsDir: string, keep?: { sink: Sink; offsets: OffsetStore }) {
  const clock = { now: Date.now() };
  const sink = keep?.sink ?? memorySink();
  const offsets = keep?.offsets ?? new OffsetStore(":memory:");
  const cfg = readConfig({ runsDir, dataDir: runsDir, stateDb: ":memory:" });
  const collector = new Collector({ cfg, sink, offsets, now: () => clock.now, log: () => {} });
  return { collector, sink, offsets, clock };
}

function lastRow(sink: Sink, runId: string): Record<string, unknown> | undefined {
  return ((sink.tables.get("run_totals") ?? []) as Record<string, unknown>[]).filter((r) => r["run_id"] === runId).at(-1);
}
function lastFact(sink: Sink, runId: string): unknown {
  return JSON.parse(String(lastRow(sink, runId)?.["fact_json"]));
}

/** The stored fact and totals are the full reads', field for field, at the same moment. */
async function expectFullRead(sink: Sink, parent: string, runId: string, now: number): Promise<void> {
  expect(lastFact(sink, runId)).toEqual(JSON.parse(JSON.stringify(readRunFact(parent, runId, now))));
  const fresh = await new RunTotalsScanner(join(parent, runId, "trajectory.jsonl")).scan();
  expect(JSON.parse(String(lastRow(sink, runId)?.["totals_json"]))).toEqual(JSON.parse(JSON.stringify(fresh)));
}

/** A run's two kept scanners, the count's and the totals'. */
type Kept = readonly [unknown, unknown];
const keptOf = (c: Collector, runId: string): Kept => [c.countScannerOf(runId), c.totalsScannerOf(runId)];
/** Folded into the same scanners: the pass read only what was appended. */
function expectKept(now: Kept, was: Kept): void {
  expect(now[0]).toBe(was[0]);
  expect(now[1]).toBe(was[1]);
}
/** New scanners, both: the pass read the file whole. */
function expectRestarted(now: Kept, was: Kept): void {
  expect(now[0]).toBeDefined();
  expect(now[1]).toBeDefined();
  expect(now[0]).not.toBe(was[0]);
  expect(now[1]).not.toBe(was[1]);
}
function expectGone(now: Kept): void {
  expect(now[0]).toBeUndefined();
  expect(now[1]).toBeUndefined();
}

/** A small deterministic PRNG, so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RECORDS: readonly string[] = [
  JSON.stringify({ t: "request", turn: 2, ts: 1, adapter: "openai", messages: [{ role: "user", content: "go" }] }),
  JSON.stringify({ t: "response", ts: 2, message: { content: "héllo 🎉" }, usage: { prompt_tokens: 40, completion_tokens: 9, cost: 0.01 } }),
  JSON.stringify({ t: "response", ts: 3, text: 'mentions "pause" and "resume"', usage: { input_tokens: 12, output_tokens: 4 } }),
  JSON.stringify({ t: "pause", ts: 4, reason: "rate-limited" }),
  JSON.stringify({ t: "pause", ts: 5, reason: "operator-pause" }),
  JSON.stringify({ t: "resume", ts: 6 }),
  JSON.stringify({ t: "events_served", ts: 7, events: [{ note: 'says "response"' }] }),
  JSON.stringify({ t: "snippet", ts: 8, code: "x".repeat(300) }),
  JSON.stringify({ t: "tool_call", ts: 9, name: "eval_snippet", args: {} }),
  JSON.stringify({ t: "milestone", ts: 10, kind: "level", from: 2, to: 3 }),
];

describe("the collector's kept scanners are incremental, and the full reads' answer", () => {
  test("random appends cut anywhere, torn lines included: the full reads after every pass, from the same scanners", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const runsDir = tmpRoot();
      const runId = `live-${seed}`;
      const dir = writeLiveRun(runsDir, runId);
      const path = join(dir, "trajectory.jsonl");
      const { collector, sink, clock } = clocked(runsDir);
      await collector.pass();
      const kept = keptOf(collector, runId);
      expect(kept[0]).toBeDefined();
      expect(kept[1]).toBeDefined();
      const r = rng(seed);
      let pending = "";
      for (let step = 0; step < 40; step++) {
        let text = pending;
        pending = "";
        for (let k = 1 + Math.floor(r() * 3); k > 0; k--) text += `${RECORDS[Math.floor(r() * RECORDS.length)]!}\n`;
        const roll = r();
        if (roll < 0.25) {
          // Cut mid-record: the rest arrives with the next append.
          const cut = 1 + Math.floor(r() * (text.length - 1));
          pending = text.slice(cut);
          text = text.slice(0, cut);
        } else if (roll < 0.35) {
          // A line torn for good: the runner died mid-write and the next record follows it.
          text += '{"t":"response","ts":';
        }
        appendFileSync(path, text);
        clock.now += 5_000;
        await collector.pass();
        await expectFullRead(sink, runsDir, runId, clock.now);
        // Folded into the same scanners, which have read exactly what is there.
        expectKept(keptOf(collector, runId), kept);
        expect(collector.countScannerOf(runId)!.size).toBe(statSync(path).size);
        expect(collector.totalsScannerOf(runId)!.size).toBe(statSync(path).size);
      }
    }
  });

  test("a pause, quiet passes and the resume keep the count, the streak and the totals, in the same scanners", async () => {
    const runsDir = tmpRoot();
    const runId = "paused";
    const dir = writeLiveRun(runsDir, runId);
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const kept = keptOf(collector, runId);
    // Paused on its provider, as the runner pauses: the record and the row.
    const t = new Trajectory(dir);
    t.setPause(runId, "rate-limited");
    t.close();
    clock.now += 5_000;
    await collector.pass();
    await expectFullRead(sink, runsDir, runId, clock.now);
    expect((lastFact(sink, runId) as { pause: { count: number } }).pause.count).toBe(1);
    // Quiet passes inside the keep window: both scanners stay.
    for (let i = 0; i < 6; i++) {
      clock.now += 60_000;
      await collector.pass();
    }
    expectKept(keptOf(collector, runId), kept);
    // Resumed: the row cleared, the resume record, more turns; then paused again with no turn.
    const r = new Trajectory(dir);
    r.clearPause(runId);
    r.append({ t: "resume", ts: 9_000 });
    r.append({ t: "response", turn: 2, ts: 9_100, message: { content: "back" } });
    r.close();
    clock.now += 5_000;
    await collector.pass();
    await expectFullRead(sink, runsDir, runId, clock.now);
    expectKept(keptOf(collector, runId), kept);
    const again = new Trajectory(dir);
    again.append({ t: "resume", ts: 9_200 });
    again.setPause(runId, "rate-limited");
    again.close();
    clock.now += 5_000;
    await collector.pass();
    await expectFullRead(sink, runsDir, runId, clock.now);
    expectKept(keptOf(collector, runId), kept);
  });

  test("quiet past the keep window: both scanners are dropped, and the next write is read whole, once", async () => {
    const runsDir = tmpRoot();
    const runId = "quiet";
    const dir = writeLiveRun(runsDir, runId);
    const path = join(dir, "trajectory.jsonl");
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const first = keptOf(collector, runId);
    clock.now += SCANNER_QUIET_MS - 1;
    await collector.pass();
    expectKept(keptOf(collector, runId), first);
    clock.now += 1;
    await collector.pass();
    expectGone(keptOf(collector, runId));
    appendFileSync(path, `${RECORDS[1]!}\n`);
    clock.now += 5_000;
    await collector.pass();
    await expectFullRead(sink, runsDir, runId, clock.now);
    const fresh = keptOf(collector, runId);
    expectRestarted(fresh, first);
    appendFileSync(path, `${RECORDS[1]!}\n`);
    clock.now += 5_000;
    await collector.pass();
    expectKept(keptOf(collector, runId), fresh);
    await expectFullRead(sink, runsDir, runId, clock.now);
  });

  test("truncated, replaced by a rename, or rotated: read whole, then incrementally again", async () => {
    const runsDir = tmpRoot();
    const runId = "rewritten";
    const dir = writeLiveRun(runsDir, runId);
    const path = join(dir, "trajectory.jsonl");
    const { collector, sink, clock } = clocked(runsDir);
    for (let i = 0; i < 5; i++) appendFileSync(path, `${RECORDS[1]!}\n`);
    await collector.pass();
    let kept = keptOf(collector, runId);
    const step = async (change: () => void, fresh: boolean): Promise<void> => {
      change();
      clock.now += 5_000;
      await collector.pass();
      await expectFullRead(sink, runsDir, runId, clock.now);
      const now = keptOf(collector, runId);
      if (fresh) expectRestarted(now, kept);
      else expectKept(now, kept);
      kept = now;
    };
    const size = (): number => statSync(path).size;
    // Shorter than what was read.
    await step(() => writeFileSync(path, `${RECORDS[1]!}\n`), true);
    await step(() => appendFileSync(path, `${RECORDS[3]!}\n`), false);
    // A larger file renamed over it: a size check alone would fold on from the old offset.
    await step(() => {
      writeFileSync(`${path}.new`, `${JSON.stringify({ t: "meta", pad: "y".repeat(size()) })}\n${RECORDS[2]!}\n`);
      renameSync(`${path}.new`, path);
    }, true);
    await step(() => appendFileSync(path, `${RECORDS[1]!}\n`), false);
    // Rotated: moved away, started again, grown past the old size before the poll.
    await step(() => {
      const was = size();
      renameSync(path, `${path}.1`);
      writeFileSync(path, `${JSON.stringify({ t: "events_served", pad: "z".repeat(was) })}\n${RECORDS[1]!}\n`);
    }, true);
    await step(() => appendFileSync(path, `${RECORDS[5]!}\n${RECORDS[1]!}\n`), false);
  });

  test("archived by a rename: the stored reads still hold, and a later write is read under the new path", async () => {
    const runsDir = tmpRoot();
    const runId = "moving";
    writeLiveRun(runsDir, runId);
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const before = keptOf(collector, runId);
    mkdirSync(join(runsDir, "archive"));
    const archived = join(runsDir, "archive", runId);
    renameSync(join(runsDir, runId), archived);
    clock.now += 5_000;
    // A rename keeps the trajectory's size and mtime: nothing to re-derive, and what is stored is the full reads' there.
    expect((await collector.pass()).totals).toBe(0);
    await expectFullRead(sink, join(runsDir, "archive"), runId, clock.now);
    appendFileSync(join(archived, "trajectory.jsonl"), `${RECORDS[1]!}\n`);
    clock.now += 5_000;
    await collector.pass();
    const after = keptOf(collector, runId);
    expectRestarted(after, before);
    expect(collector.countScannerOf(runId)!.path).toBe(join(archived, "trajectory.jsonl"));
    expect(collector.totalsScannerOf(runId)!.path).toBe(join(archived, "trajectory.jsonl"));
    await expectFullRead(sink, join(runsDir, "archive"), runId, clock.now);
  });

  test("a run no longer listed drops its scanners", async () => {
    const runsDir = tmpRoot();
    writeLiveRun(runsDir, "gone");
    const { collector, clock } = clocked(runsDir);
    await collector.pass();
    expect(collector.totalsScannerOf("gone")).toBeDefined();
    rmSync(join(runsDir, "gone"), { recursive: true });
    clock.now += 5_000;
    await collector.pass();
    expectGone(keptOf(collector, "gone"));
  });

  test("a restarted collector: nothing re-derived while nothing moves, then one whole read, then incremental", async () => {
    const runsDir = tmpRoot();
    const runId = "restart";
    const dir = writeLiveRun(runsDir, runId);
    const path = join(dir, "trajectory.jsonl");
    const first = clocked(runsDir);
    await first.collector.pass();
    const restarted = clocked(runsDir, { sink: first.sink, offsets: first.offsets });
    expect((await restarted.collector.pass()).totals).toBe(0);
    expectGone(keptOf(restarted.collector, runId));
    appendFileSync(path, `${RECORDS[1]!}\n${RECORDS[3]!}\n`);
    restarted.clock.now += 5_000;
    expect((await restarted.collector.pass()).totals).toBe(1);
    await expectFullRead(first.sink, runsDir, runId, restarted.clock.now);
    const cold = keptOf(restarted.collector, runId);
    expect(restarted.collector.countScannerOf(runId)!.size).toBe(statSync(path).size);
    expect(restarted.collector.totalsScannerOf(runId)!.size).toBe(statSync(path).size);
    appendFileSync(path, `${RECORDS[1]!}\n`);
    restarted.clock.now += 5_000;
    await restarted.collector.pass();
    expectKept(keptOf(restarted.collector, runId), cold);
    await expectFullRead(first.sink, runsDir, runId, restarted.clock.now);
  });

  test("continuation runs side by side: each its own scanners and its own full reads", async () => {
    const runsDir = tmpRoot();
    const ids = ["fleet-x-freeplay-m-20261001", "fleet-x-freeplay-m-20261001-a2"];
    for (const id of ids) writeLiveRun(runsDir, id);
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const kept = ids.map((id) => keptOf(collector, id));
    expect(kept[0]![0]).not.toBe(kept[1]![0]);
    expect(kept[0]![1]).not.toBe(kept[1]![1]);
    const r = rng(9);
    for (let step = 0; step < 12; step++) {
      const id = ids[Math.floor(r() * ids.length)]!;
      appendFileSync(join(runsDir, id, "trajectory.jsonl"), `${RECORDS[Math.floor(r() * RECORDS.length)]!}\n`);
      clock.now += 5_000;
      await collector.pass();
      for (const each of ids) await expectFullRead(sink, runsDir, each, clock.now);
    }
    ids.forEach((id, i) => expectKept(keptOf(collector, id), kept[i]!));
  });
});
