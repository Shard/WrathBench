/**
 * The trace writer (`trace.ts`): the host's fold over what the child's
 * recorder latched, the per-window key rows, and the one place every row
 * lands (run.sqlite `trace`) — never trajectory.jsonl, which the collector
 * tails, and never a file of its own.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "@wrathbench/mcp";
import { TraceWriter, traceWindowStart } from "../src/trace";
import {
  emptyTraceSheet,
  emptyTraceState,
  TRACE_WINDOW_MS,
  type TraceDict,
  type TraceDrain,
  type TraceKeyData,
  type TraceRow,
  type TraceState,
} from "../src/trace-row";
import { encodeSegment, sheetAt, decodeSegment, type TraceRow as ViewerRow } from "../viewer/trace";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** Window starts on a clock that began at W0. */
const W0 = 1_700_000_400_000 - (1_700_000_400_000 % TRACE_WINDOW_MS);
const W1 = W0 + TRACE_WINDOW_MS;
const W2 = W1 + TRACE_WINDOW_MS;

function rig() {
  const dir = tempDir("wrathbench-trace-writer-");
  const trajectory = new Trajectory(dir);
  const queue: (TraceDrain | null)[] = [];
  let clock = W0 + 1_000;
  const logged: string[] = [];
  const writer = new TraceWriter({
    runId: "run-test",
    trajectory,
    sandbox: { traceDrain: () => Promise.resolve(queue.shift() ?? null) } as unknown as SandboxHost,
    now: () => clock,
    log: (t) => logged.push(t),
  });
  return {
    dir,
    trajectory,
    writer,
    logged,
    push: (rows: TraceRow[], dropped = 0, dict?: TraceDict) => queue.push({ rows, dropped, ...(dict !== undefined ? { dict } : {}) }),
    at: (t: number) => {
      clock = t;
    },
    rows: () => trajectory.traceRows("run-test"),
  };
}

const key = (ts: number, hp: number, pos: [number, number, number, number, number] | null): TraceRow => ({
  ts,
  kind: "key",
  map: pos?.[0] ?? null,
  x: pos?.[1] ?? null,
  y: pos?.[2] ?? null,
  z: pos?.[3] ?? null,
  o: pos?.[4] ?? null,
  data: { ...emptyTraceState(), hp, hpMax: 100 },
});
const pos = (ts: number, x: number, jump = false): TraceRow => ({ ts, kind: "pos", map: 0, x, y: 0, z: 10, o: 1, ...(jump ? { data: { jump: 1 } } : {}) });
const state = (ts: number, data: Partial<TraceState>): TraceRow => ({ ts, kind: "state", data });

describe("trace writer", () => {
  test("rows land in sqlite only: never in trajectory.jsonl, and no trace.jsonl beside it", async () => {
    const r = rig();
    r.push([key(W0 + 500, 90, [0, 1, 2, 3, 0.5]), pos(W0 + 1_000, 5), state(W0 + 1_500, { hp: 80 })]);
    await r.writer.drain();
    const rows = r.rows();
    expect(rows.map((x) => x.kind)).toEqual(["key", "pos", "state"]);
    expect(rows[0]).toMatchObject({ ts: W0 + 500, map: 0, x: 1, y: 2, z: 3, o: 0.5 });
    expect((rows[0]!.data as TraceState).hp).toBe(90);
    expect(rows[1]).toEqual({ ts: W0 + 1_000, kind: "pos", map: 0, x: 5, y: 0, z: 10, o: 1, data: null });
    expect(rows[2]).toEqual({ ts: W0 + 1_500, kind: "state", map: null, x: null, y: null, z: null, o: null, data: { hp: 80 } });
    expect(readTrajectory(r.dir).filter((x) => x.t === "trace")).toEqual([]);
    expect(existsSync(join(r.dir, "trace.jsonl"))).toBe(false);
    r.trajectory.close();
  });

  test("each window gets one key from the fold before its first row, stating everything written so far", async () => {
    const r = rig();
    r.push([key(W0 + 500, 90, [0, 1, 2, 3, 0.5]), state(W0 + 1_500, { hp: 80, combat: true }), pos(W0 + 2_000, 7)]);
    await r.writer.drain();
    // The child keyed W0 itself: no host key beside it.
    expect(r.rows().filter((x) => x.kind === "key")).toHaveLength(1);

    // Rows observed either side of the boundary, drained in one tick: the
    // one before it belongs to W0, the key for W1 states the fold after it.
    r.at(W1 + 3_000);
    r.push([state(W1 - 100, { hp: 70 }), pos(W1 + 100, 9), state(W1 + 200, { combat: false })]);
    await r.writer.drain();
    const rows = r.rows().slice(3);
    expect(rows.map((x) => [x.kind, x.ts])).toEqual([
      ["state", W1 - 100],
      ["key", W1],
      ["pos", W1 + 100],
      ["state", W1 + 200],
    ]);
    const k = rows[1]!;
    expect(k).toMatchObject({ map: 0, x: 7, y: 0, z: 10, o: 1 });
    const data = k.data as TraceState;
    expect(data.hp).toBe(70);
    expect(data.hpMax).toBe(100);
    expect(data.combat).toBe(true);
    expect(data.auras).toEqual([]);

    // The rest of W1: no second key.
    r.at(W1 + 8_000);
    r.push([pos(W1 + 7_000, 11)]);
    await r.writer.drain();
    expect(r.rows().filter((x) => x.kind === "key")).toHaveLength(2);
    r.trajectory.close();
  });

  test("an idle child still keys each window; nothing is keyed before the fold has anything", async () => {
    const r = rig();
    // Nothing written yet: no key to state.
    r.push([]);
    await r.writer.drain();
    expect(r.rows()).toEqual([]);
    r.push([key(W0 + 500, 90, null), pos(W0 + 1_000, 5, true)]);
    await r.writer.drain();
    // Two windows pass with nothing latched: each gets its key at its t0.
    r.at(W1 + 4_000);
    r.push([]);
    await r.writer.drain();
    r.at(W2 + 2_000);
    r.push([]);
    await r.writer.drain();
    const keys = r.rows().filter((x) => x.kind === "key");
    expect(keys.map((x) => x.ts)).toEqual([W0 + 500, W1, W2]);
    expect(keys[2]).toMatchObject({ map: 0, x: 5, y: 0, z: 10, o: 1 });
    expect((keys[2]!.data as TraceState).hp).toBe(90);
    r.trajectory.close();
  });

  test("a key never predates an observation it states: the fold's newest ts wins over t0", async () => {
    const r = rig();
    r.push([key(W0 + 500, 90, null)]);
    await r.writer.drain();
    // A row stamped into W2 arrives first (the child's clock is its own),
    // then, a drain later, one stamped into W1: the W1 key must not claim to
    // be older than the W2 position already folded. (Inside one drain the
    // rows are written in ts order, so the case needs two.)
    r.at(W0 + 9_000);
    r.push([pos(W2 + 100, 50)]);
    await r.writer.drain();
    r.push([pos(W1 + 100, 40)]);
    await r.writer.drain();
    const keys = r.rows().filter((x) => x.kind === "key");
    expect(keys.map((x) => x.ts).sort((a, b) => a - b)).toEqual([W0 + 500, W2, W2 + 100]);
    r.trajectory.close();
  });

  test("no child means no rows and no key: a drain that answers null writes nothing", async () => {
    const r = rig();
    r.push([key(W0 + 500, 90, null), pos(W0 + 1_000, 5, true)]);
    await r.writer.drain();
    r.at(W1 + 4_000);
    // The queue is empty: the fake answers null, as the host does with no child.
    await r.writer.drain();
    expect(r.rows().filter((x) => x.kind === "key").map((x) => x.ts)).toEqual([W0 + 500]);
    r.trajectory.close();
  });

  test("the child's drop count is logged, not written as a row", async () => {
    const r = rig();
    r.push([key(W0 + 500, 90, null)], 12);
    await r.writer.drain();
    expect(r.logged).toEqual(["[trace] the sandbox buffer dropped 12 trace row(s) before this drain"]);
    expect(r.rows()).toHaveLength(1);
    r.trajectory.close();
  });

  test("a real host that is stopped is never spawned by the writer", async () => {
    const dir = tempDir("wrathbench-trace-writer-");
    const trajectory = new Trajectory(dir);
    const host = new SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
    });
    const writer = new TraceWriter({ runId: "run-test", trajectory, sandbox: host, now: () => W1 + 1_000 });
    await writer.drain();
    expect(trajectory.traceRows("run-test")).toEqual([]);
    expect((host as unknown as { proc: unknown }).proc).toBeNull();
    expect(existsSync(join(dir, "trace.jsonl"))).toBe(false);
    trajectory.close();
  });

  test("the sheet folds patch by patch into each window's key, and a key already out keeps the lists it stated", async () => {
    const r = rig();
    const sheetKey: TraceRow = { ...key(W0 + 500, 90, [0, 1, 2, 3, 0.5]), data: { ...(key(0, 90, null).data as TraceState), ...emptyTraceSheet(), money: 10, inv: [[255, 23, 100]], quests: [] } };
    // One drain across the boundary, with a patch after it: the W1 key is
    // written before the patch is folded, and must not see it.
    r.at(W1 + 3_000);
    r.push([
      sheetKey,
      state(W0 + 1_000, { inv: [[255, 24, 200, 3]], money: 15 } as Partial<TraceState>),
      pos(W1 + 100, 9),
      state(W1 + 200, { inv: [[255, 23]], quests: [[0, 77, 0, 1]], qdone: [76] } as Partial<TraceState>),
    ]);
    await r.writer.drain();
    const keys = r.rows().filter((x) => x.kind === "key");
    expect(keys.map((x) => x.ts)).toEqual([W0 + 500, W1]);
    const w1 = keys[1]!.data as TraceKeyData;
    expect(w1.money).toBe(15);
    expect(w1.inv).toEqual([
      [255, 23, 100],
      [255, 24, 200, 3],
    ]);
    expect(w1.quests).toEqual([]);
    expect(w1.equip).toBeNull();
    // A turn-in is an event: no key carries one.
    expect(Object.hasOwn(w1, "qdone")).toBe(false);
    // The next window's key has the patch.
    r.at(W2 + 1_000);
    r.push([]);
    await r.writer.drain();
    const w2 = r.rows().filter((x) => x.kind === "key")[2]!.data as TraceKeyData;
    expect(w2.inv).toEqual([[255, 24, 200, 3]]);
    expect(w2.quests).toEqual([[0, 77, 0, 1]]);
    r.trajectory.close();
  });

  test("chat lines are events: never folded into a key, and their text crosses the run's scrub", async () => {
    const r = rig();
    r.trajectory.redact("lease-secret-0123456789abcdef");
    r.push([
      key(W0 + 500, 90, [0, 1, 2, 3, 0.5]),
      { ts: W0 + 1_000, kind: "state", data: { chat: [["party", "the lease is lease-secret-0123456789abcdef"]] } },
    ]);
    await r.writer.drain();
    r.at(W1 + 1_000);
    r.push([pos(W1 + 500, 9)]);
    await r.writer.drain();
    const rows = r.rows();
    expect(rows[1]!.data).toEqual({ chat: [["party", "the lease is [redacted]"]] });
    const k = rows.find((x) => x.kind === "key" && x.ts === W1)!;
    expect(Object.keys(k.data as object)).not.toContain("chat");
    r.trajectory.close();
  });

  test("a state row observed before a key already written lands at that key, so the key cannot take it back", async () => {
    const r = rig();
    r.push([{ ...key(W0 + 500, 90, null), data: { ...(key(0, 90, null).data as TraceState), ...emptyTraceSheet(), money: 10 } }]);
    await r.writer.drain();
    // The clock crosses W1: the idle drain keys it from the fold (money 10).
    r.at(W1 + 2_000);
    r.push([]);
    await r.writer.drain();
    // The child had seen money change just before the boundary, and latched
    // it a drain late (the sheet is read at most once a second).
    r.push([state(W1 - 200, { money: 25 } as Partial<TraceState>)]);
    await r.writer.drain();
    const rows = r.rows();
    expect(rows.map((x) => [x.kind, x.ts])).toEqual([
      ["key", W0 + 500],
      ["key", W1],
      ["state", W1],
    ]);
    // Read back the way the viewer reads it: from W1 on, the change holds.
    const text: ViewerRow[] = rows.map((x) => ({ ...x, map: x.map ?? null, x: x.x ?? null, y: x.y ?? null, z: x.z ?? null, o: x.o ?? null, data: x.data === null || x.data === undefined ? null : JSON.stringify(x.data) }));
    const seg = decodeSegment(encodeSegment(text, { run: "run-test", t0: W1, t1: W2 }));
    expect(sheetAt(seg, W1 + 1).money).toBe(25);
    expect(sheetAt(seg, W2 - 1).money).toBe(25);
    r.trajectory.close();
  });

  test("a drain's names go to trace_dict once per id, scrubbed like every string the trajectory writes", async () => {
    const r = rig();
    r.trajectory.redact("hunter2-secret-value");
    r.push([key(W0 + 500, 90, null)], 0, { items: [[100, 2, "Blade of hunter2-secret-value"], [101, null, "Pouch"]], quests: [[77, [8, 0, 0, 0, [101, 4]]]] });
    await r.writer.drain();
    // A drain with names and no rows still writes them; a re-sent id replaces its entry.
    r.push([], 0, { items: [[101, 1, "Pouch"]] });
    await r.writer.drain();
    expect(r.trajectory.traceDict("run-test")).toEqual([
      { kind: "item", id: 100, data: [2, "Blade of [redacted]"] },
      { kind: "item", id: 101, data: [1, "Pouch"] },
      { kind: "quest", id: 77, data: [8, 0, 0, 0, [101, 4]] },
    ]);
    // Never in trajectory.jsonl.
    expect(readTrajectory(r.dir).some((x) => JSON.stringify(x).includes("Pouch"))).toBe(false);
    r.trajectory.close();
  });

  test("the window of a timestamp is its UTC-aligned 300 000 ms start", () => {
    expect(traceWindowStart(W1 + 299_999)).toBe(W1);
    expect(traceWindowStart(W1 + 300_000)).toBe(W2);
    expect(W0 % TRACE_WINDOW_MS).toBe(0);
  });
});
