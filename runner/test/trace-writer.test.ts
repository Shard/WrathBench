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
import { Scratchpad } from "../src/scratchpad";
import { TraceWriter, traceWindowStart } from "../src/trace";
import { emptyTraceState, TRACE_WINDOW_MS, type TraceDrain, type TraceRow, type TraceState } from "../src/trace-row";
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
    push: (rows: TraceRow[], dropped = 0) => queue.push({ rows, dropped }),
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
    // then one stamped into W1: the W1 key must not claim to be older than
    // the W2 position already folded.
    r.at(W0 + 9_000);
    r.push([pos(W2 + 100, 50), pos(W1 + 100, 40)]);
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

  test("the window of a timestamp is its UTC-aligned 300 000 ms start", () => {
    expect(traceWindowStart(W1 + 299_999)).toBe(W1);
    expect(traceWindowStart(W1 + 300_000)).toBe(W2);
    expect(W0 % TRACE_WINDOW_MS).toBe(0);
  });
});
