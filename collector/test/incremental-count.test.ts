/**
 * The collector's record count is incremental: one count scanner per run,
 * kept across passes, so re-deriving a live run's fact folds only the bytes
 * appended since its last read. It has to be the full count's answer every
 * time, through everything a trajectory goes through: appends cut mid-record,
 * torn lines, a pause and its resume, quiet stretches, truncation, a file
 * replaced or rotated under the same path, an archive move, a collector
 * restart, and continuation runs beside each other.
 *
 * Every pass is checked against `readRunFact` with no scanner cache — the
 * full count — at the collector's own clock, so the stored `fact_json` must
 * equal it field for field. Where it matters, the scanner object itself is
 * checked too: the same one after a pass means the pass folded only the
 * appended bytes; a new one means it counted the file whole.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunFact } from "../../runner/src/models";
import { Trajectory } from "../../runner/src/trajectory";
import { Collector } from "../src/collector";
import { readConfig } from "../src/config";
import { COUNT_SCANNER_QUIET_MS } from "../src/ingest";
import { OffsetStore } from "../src/offsets";
import { memorySink } from "../src/sink";

const roots: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "collector-counts-"));
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
  traj.append({ t: "response", turn: 1, ts: 1_200, message: { content: "ok" } });
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

function lastFact(sink: Sink, runId: string): unknown {
  const rows = ((sink.tables.get("run_totals") ?? []) as Record<string, unknown>[]).filter((r) => r["run_id"] === runId);
  return JSON.parse(String(rows.at(-1)?.["fact_json"]));
}

/** The stored fact is the full count's, field for field, at the same moment. */
function expectFullCount(sink: Sink, parent: string, runId: string, now: number): void {
  expect(lastFact(sink, runId)).toEqual(JSON.parse(JSON.stringify(readRunFact(parent, runId, now))));
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
  JSON.stringify({ t: "response", ts: 2, message: { content: "héllo 🎉" } }),
  JSON.stringify({ t: "response", ts: 3, text: 'mentions "pause" and "resume"' }),
  JSON.stringify({ t: "pause", ts: 4, reason: "rate-limited" }),
  JSON.stringify({ t: "pause", ts: 5, reason: "operator-pause" }),
  JSON.stringify({ t: "resume", ts: 6 }),
  JSON.stringify({ t: "events_served", ts: 7, events: [{ note: 'says "response"' }] }),
  JSON.stringify({ t: "snippet", ts: 8, code: "x".repeat(300) }),
];

describe("the collector's record count is incremental, and the full count's answer", () => {
  test("random appends cut anywhere, torn lines included: the full count after every pass, from one scanner", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const runsDir = tmpRoot();
      const runId = `live-${seed}`;
      const dir = writeLiveRun(runsDir, runId);
      const path = join(dir, "trajectory.jsonl");
      const { collector, sink, clock } = clocked(runsDir);
      await collector.pass();
      const scanner = collector.countScannerOf(runId);
      expect(scanner).toBeDefined();
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
        expectFullCount(sink, runsDir, runId, clock.now);
        // Folded into the same scanner, which has read exactly what is there.
        expect(collector.countScannerOf(runId)).toBe(scanner);
        expect(scanner!.size).toBe(statSync(path).size);
      }
    }
  });

  test("a pause, quiet passes and the resume keep the count and the streak, in the same scanner", async () => {
    const runsDir = tmpRoot();
    const runId = "paused";
    const dir = writeLiveRun(runsDir, runId);
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const scanner = collector.countScannerOf(runId);
    // Paused on its provider, as the runner pauses: the record and the row.
    const t = new Trajectory(dir);
    t.setPause(runId, "rate-limited");
    t.close();
    clock.now += 5_000;
    await collector.pass();
    expectFullCount(sink, runsDir, runId, clock.now);
    expect((lastFact(sink, runId) as { pause: { count: number } }).pause.count).toBe(1);
    // Quiet passes inside the keep window: the scanner stays.
    for (let i = 0; i < 6; i++) {
      clock.now += 60_000;
      await collector.pass();
    }
    expect(collector.countScannerOf(runId)).toBe(scanner);
    // Resumed: the row cleared, the resume record, more turns; then paused again with no turn.
    const r = new Trajectory(dir);
    r.clearPause(runId);
    r.append({ t: "resume", ts: 9_000 });
    r.append({ t: "response", turn: 2, ts: 9_100, message: { content: "back" } });
    r.close();
    clock.now += 5_000;
    await collector.pass();
    expectFullCount(sink, runsDir, runId, clock.now);
    expect(collector.countScannerOf(runId)).toBe(scanner);
    const again = new Trajectory(dir);
    again.append({ t: "resume", ts: 9_200 });
    again.setPause(runId, "rate-limited");
    again.close();
    clock.now += 5_000;
    await collector.pass();
    expectFullCount(sink, runsDir, runId, clock.now);
    expect(collector.countScannerOf(runId)).toBe(scanner);
  });

  test("quiet past the keep window: the scanner is dropped, and the next write is counted whole, once", async () => {
    const runsDir = tmpRoot();
    const runId = "quiet";
    const dir = writeLiveRun(runsDir, runId);
    const path = join(dir, "trajectory.jsonl");
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const first = collector.countScannerOf(runId);
    clock.now += COUNT_SCANNER_QUIET_MS - 1;
    await collector.pass();
    expect(collector.countScannerOf(runId)).toBe(first);
    clock.now += 1;
    await collector.pass();
    expect(collector.countScannerOf(runId)).toBeUndefined();
    appendFileSync(path, `${RECORDS[0]!}\n`);
    clock.now += 5_000;
    await collector.pass();
    expectFullCount(sink, runsDir, runId, clock.now);
    const fresh = collector.countScannerOf(runId);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(first);
    appendFileSync(path, `${RECORDS[0]!}\n`);
    clock.now += 5_000;
    await collector.pass();
    expect(collector.countScannerOf(runId)).toBe(fresh);
    expectFullCount(sink, runsDir, runId, clock.now);
  });

  test("truncated, replaced by a rename, or rotated: counted whole, then incrementally again", async () => {
    const runsDir = tmpRoot();
    const runId = "rewritten";
    const dir = writeLiveRun(runsDir, runId);
    const path = join(dir, "trajectory.jsonl");
    const { collector, sink, clock } = clocked(runsDir);
    for (let i = 0; i < 5; i++) appendFileSync(path, `${RECORDS[0]!}\n`);
    await collector.pass();
    let scanner = collector.countScannerOf(runId);
    const step = async (change: () => void, fresh: boolean): Promise<void> => {
      change();
      clock.now += 5_000;
      await collector.pass();
      expectFullCount(sink, runsDir, runId, clock.now);
      const now = collector.countScannerOf(runId);
      if (fresh) expect(now).not.toBe(scanner);
      else expect(now).toBe(scanner);
      scanner = now;
    };
    const size = (): number => statSync(path).size;
    // Shorter than what was read.
    await step(() => writeFileSync(path, `${RECORDS[0]!}\n`), true);
    await step(() => appendFileSync(path, `${RECORDS[2]!}\n`), false);
    // A larger file renamed over it: a size check alone would fold on from the old offset.
    await step(() => {
      writeFileSync(`${path}.new`, `${JSON.stringify({ t: "meta", pad: "y".repeat(size()) })}\n${RECORDS[1]!}\n`);
      renameSync(`${path}.new`, path);
    }, true);
    await step(() => appendFileSync(path, `${RECORDS[0]!}\n`), false);
    // Rotated: moved away, started again, grown past the old size before the poll.
    await step(() => {
      const was = size();
      renameSync(path, `${path}.1`);
      writeFileSync(path, `${JSON.stringify({ t: "events_served", pad: "z".repeat(was) })}\n${RECORDS[0]!}\n`);
    }, true);
    await step(() => appendFileSync(path, `${RECORDS[4]!}\n${RECORDS[0]!}\n`), false);
  });

  test("archived by a rename: the stored count still holds, and a later write is counted under the new path", async () => {
    const runsDir = tmpRoot();
    const runId = "moving";
    writeLiveRun(runsDir, runId);
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const before = collector.countScannerOf(runId)!;
    mkdirSync(join(runsDir, "archive"));
    const archived = join(runsDir, "archive", runId);
    renameSync(join(runsDir, runId), archived);
    clock.now += 5_000;
    // A rename keeps the trajectory's size and mtime: nothing to re-derive, and the stored count is the full count there.
    expect((await collector.pass()).totals).toBe(0);
    expectFullCount(sink, join(runsDir, "archive"), runId, clock.now);
    appendFileSync(join(archived, "trajectory.jsonl"), `${RECORDS[0]!}\n`);
    clock.now += 5_000;
    await collector.pass();
    const after = collector.countScannerOf(runId)!;
    expect(after).not.toBe(before);
    expect(after.path).toBe(join(archived, "trajectory.jsonl"));
    expectFullCount(sink, join(runsDir, "archive"), runId, clock.now);
  });

  test("a run no longer listed drops its scanner", async () => {
    const runsDir = tmpRoot();
    writeLiveRun(runsDir, "gone");
    const { collector, clock } = clocked(runsDir);
    await collector.pass();
    expect(collector.countScannerOf("gone")).toBeDefined();
    rmSync(join(runsDir, "gone"), { recursive: true });
    clock.now += 5_000;
    await collector.pass();
    expect(collector.countScannerOf("gone")).toBeUndefined();
  });

  test("a restarted collector: nothing re-derived while nothing moves, then one whole count, then incremental", async () => {
    const runsDir = tmpRoot();
    const runId = "restart";
    const dir = writeLiveRun(runsDir, runId);
    const path = join(dir, "trajectory.jsonl");
    const first = clocked(runsDir);
    await first.collector.pass();
    const restarted = clocked(runsDir, { sink: first.sink, offsets: first.offsets });
    expect((await restarted.collector.pass()).totals).toBe(0);
    expect(restarted.collector.countScannerOf(runId)).toBeUndefined();
    appendFileSync(path, `${RECORDS[0]!}\n${RECORDS[2]!}\n`);
    restarted.clock.now += 5_000;
    expect((await restarted.collector.pass()).totals).toBe(1);
    expectFullCount(first.sink, runsDir, runId, restarted.clock.now);
    const cold = restarted.collector.countScannerOf(runId)!;
    expect(cold.size).toBe(statSync(path).size);
    appendFileSync(path, `${RECORDS[0]!}\n`);
    restarted.clock.now += 5_000;
    await restarted.collector.pass();
    expect(restarted.collector.countScannerOf(runId)).toBe(cold);
    expectFullCount(first.sink, runsDir, runId, restarted.clock.now);
  });

  test("continuation runs side by side: each its own scanner and its own full count", async () => {
    const runsDir = tmpRoot();
    const ids = ["fleet-x-freeplay-m-20261001", "fleet-x-freeplay-m-20261001-a2"];
    for (const id of ids) writeLiveRun(runsDir, id);
    const { collector, sink, clock } = clocked(runsDir);
    await collector.pass();
    const scanners = ids.map((id) => collector.countScannerOf(id));
    expect(scanners[0]).not.toBe(scanners[1]);
    const r = rng(9);
    for (let step = 0; step < 12; step++) {
      const id = ids[Math.floor(r() * ids.length)]!;
      appendFileSync(join(runsDir, id, "trajectory.jsonl"), `${RECORDS[Math.floor(r() * RECORDS.length)]!}\n`);
      clock.now += 5_000;
      await collector.pass();
      for (const each of ids) expectFullCount(sink, runsDir, each, clock.now);
    }
    expect(ids.map((id) => collector.countScannerOf(id))).toEqual(scanners);
  });
});
