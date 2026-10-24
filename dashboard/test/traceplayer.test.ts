/**
 * The trace player's core, with synthetic recorder rows encoded by the real
 * codec: segments laid end to end across a window boundary and across the
 * tail's promotion to a closed segment, the listed-only fetch rule, the live
 * clock's delay, hold and re-anchoring, the replay clock's speeds and idle
 * skip, and what a run without a trace falls back to.
 *
 * Every row here is invented — a character walking along x at a yard a
 * second — so nothing in this file comes from a run.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, tailStart, type TraceRow } from "@viewer/trace";
import type { AgentPosition, TraceAura, TraceSegment, TrackPoint, TrackResponse } from "../../runner/viewer/api-types";
import {
  CATCHUP_RATE,
  DRAIN_MS,
  LIVE_REACH,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_TOTAL,
  RETRY_MS,
  TRAIL_MS,
  createLiveClock,
  createTraceStore,
  horizonOf,
  ingestIndex,
  ingestPositions,
  ingestTrack,
  replaySpan,
  liveCadence,
  marginOf,
  replayCursorAt,
  replayReach,
} from "../src/lib/traceplayer";
import { IDLE_GAP_MS, IDLE_PLAY_MS, SPEEDS, advanceCursor, idleSpans, nextSpeed } from "../src/lib/playback";
import { classifySegments, positionsAt, trackPoseAt } from "../src/lib/replay";
import { auraViews, gaugesOf, healthReading, targetReading, unitFlags } from "../src/lib/unitframe";
import { projectTraceSegment } from "../../runner/viewer/public-projection";

const RUN = "run-a";
/** A window boundary, well clear of zero so context reads stay positive. */
const W = 1_760_000_100_000 - (1_760_000_100_000 % SEG_MS);

const key = (ts: number, x: number, state: Record<string, unknown> = {}): TraceRow => ({
  ts,
  kind: "key",
  map: 0,
  x,
  y: 0,
  z: 0,
  o: 0,
  data: JSON.stringify({ hp: 100, hpMax: 100, level: 5, auras: [], ...state }),
});
const pos = (ts: number, x: number, extra: Partial<TraceRow> = {}): TraceRow => ({
  ts,
  kind: "pos",
  map: 0,
  x,
  y: 0,
  z: 0,
  o: 0,
  data: null,
  ...extra,
});
const stateRow = (ts: number, data: Record<string, unknown>): TraceRow => ({
  ts,
  kind: "state",
  map: null,
  x: null,
  y: null,
  z: null,
  o: null,
  data: JSON.stringify(data),
});

/** Walking along x at 1 yd/s from `from`, a sample a second, with a key row at every window start. */
function walk(from: number, to: number): TraceRow[] {
  const out: TraceRow[] = [];
  for (let t = from; t < to; t += 1000) {
    if (t % SEG_MS === 0) out.push(key(t, (t - from) / 1000));
    out.push(pos(t, (t - from) / 1000));
  }
  return out;
}
const truth = (from: number, t: number): number => (t - from) / 1000;

/** The rows a viewer would encode one window from: its own and `CONTEXT_MS` before. */
function seg(rows: readonly TraceRow[], t0: number, t1 = t0 + SEG_MS): TraceSegment {
  const inRange = rows.filter((r) => r.ts >= t0 - CONTEXT_MS && r.ts < t1);
  return JSON.parse(JSON.stringify(encodeSegment(inRange, { run: RUN, t0, t1 }))) as TraceSegment;
}

/** A fetcher over a fixed set of segments that fails the test on anything else. */
function fetcher(segs: Map<number, TraceSegment>, calls: number[] = []) {
  return async (_run: string, t0: number): Promise<TraceSegment> => {
    calls.push(t0);
    const s = segs.get(t0);
    if (s === undefined) throw new Error(`unlisted window requested: ${t0}`);
    return s;
  };
}

describe("assembly", () => {
  const start = W - 2 * SEG_MS;
  const rows = walk(start, W + 2 * SEG_MS);

  test("two closed windows play as one across their boundary", async () => {
    const store = createTraceStore();
    const segs = new Map([
      [W - SEG_MS, seg(rows, W - SEG_MS)],
      [W, seg(rows, W)],
    ]);
    store.list(RUN, SEG_MS, [W - SEG_MS, W]);
    await store.load(RUN, W - SEG_MS, fetcher(segs));
    await store.load(RUN, W, fetcher(segs));
    for (const t of [W - 1500, W - 500, W, W + 500, W + 1500]) {
      expect(store.poseAt(RUN, t)?.x).toBeCloseTo(truth(start, t), 1);
    }
  });

  test("a window first seen in the tail and then closed plays the same, once", async () => {
    // Inside the settle minute the tail still holds the window before.
    const now = W + 30_000;
    expect(tailStart(now)).toBe(W - SEG_MS);
    const early = rows.filter((r) => r.ts < now - DRAIN_MS);
    const store = createTraceStore();
    store.setTail(RUN, seg(early, W - SEG_MS, W + SEG_MS));
    const before = [W - 100_000, W - 500, W + 500, W + 20_000].map((t) => store.poseAt(RUN, t)?.x);
    before.forEach((x, i) => expect(x).toBeCloseTo(truth(start, [W - 100_000, W - 500, W + 500, W + 20_000][i]!), 1));

    // Settled: the window is closed and listed, and the tail moves on.
    const later = W + 90_000;
    const segs = new Map([[W - SEG_MS, seg(rows, W - SEG_MS)]]);
    store.list(RUN, SEG_MS, [W - SEG_MS]);
    await store.load(RUN, W - SEG_MS, fetcher(segs));
    // Between the two: closed copy loaded, old two-window tail still held.
    expect(store.poseAt(RUN, W - 500)?.x).toBeCloseTo(truth(start, W - 500), 1);
    expect(store.poseAt(RUN, W + 500)?.x).toBeCloseTo(truth(start, W + 500), 1);
    store.setTail(RUN, seg(rows.filter((r) => r.ts < later), W, W + SEG_MS));
    for (const t of [W - 100_000, W - 500, W + 500, W + 20_000, W + 80_000]) {
      expect(store.poseAt(RUN, t)?.x).toBeCloseTo(truth(start, t), 1);
    }
  });

  test("past the tail's last frame the pose holds: the playhead caught the data", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(rows.filter((r) => r.ts < W + 10_000), W));
    expect(store.poseAt(RUN, W + 60_000)?.x).toBeCloseTo(truth(start, W + 9_000), 1);
  });

  test("a listed window still loading answers null, and the caller falls back", async () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, [W - 2 * SEG_MS, W - SEG_MS, W]);
    const segs = new Map([
      [W - 2 * SEG_MS, seg(rows, W - 2 * SEG_MS)],
      [W, seg(rows, W)],
    ]);
    await store.load(RUN, W - 2 * SEG_MS, fetcher(segs));
    await store.load(RUN, W, fetcher(segs));
    expect(store.poseAt(RUN, W - 100_000)).toBeNull();
    expect(store.unitAt(RUN, W - 100_000)).toBeNull();
    expect(store.poseAt(RUN, W + 100)?.x).toBeCloseTo(truth(start, W + 100), 1);
  });

  test("a window with no rows between two loaded ones holds the one before", async () => {
    const gappy = [...walk(start, W - SEG_MS), ...walk(W, W + SEG_MS).map((r) => ({ ...r, x: 500 }))];
    const store = createTraceStore();
    store.list(RUN, SEG_MS, [W - 2 * SEG_MS, W]);
    const segs = new Map([
      [W - 2 * SEG_MS, seg(gappy, W - 2 * SEG_MS)],
      [W, seg(gappy, W)],
    ]);
    await store.load(RUN, W - 2 * SEG_MS, fetcher(segs));
    await store.load(RUN, W, fetcher(segs));
    expect(store.poseAt(RUN, W - 100_000)?.x).toBeCloseTo(truth(start, W - SEG_MS - 1000), 1);
  });

  test("the bounded cache evicts the least recently used, and the evicted window is wanted again", async () => {
    const store = createTraceStore({ maxSegments: 2 });
    const t0s = [W - 2 * SEG_MS, W - SEG_MS, W];
    store.list(RUN, SEG_MS, t0s);
    const segs = new Map(t0s.map((t0) => [t0, seg(rows, t0)]));
    for (const t0 of t0s) await store.load(RUN, t0, fetcher(segs));
    expect(store.poseAt(RUN, W - 2 * SEG_MS + 1000)).toBeNull();
    expect(store.wanted(RUN, W - 2 * SEG_MS + 1000)).toEqual([W - 2 * SEG_MS]);
  });
});

describe("fetch selection", () => {
  const start = W - 3 * SEG_MS;
  const rows = walk(start, W + 2 * SEG_MS);
  const listed = [W - 3 * SEG_MS, W - SEG_MS, W + SEG_MS];
  const segs = new Map(listed.map((t0) => [t0, seg(rows, t0)]));

  test("the playhead's window, then the next listed one — never an unlisted window", () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, listed);
    expect(store.wanted(RUN, W - SEG_MS + 10)).toEqual([W - SEG_MS, W + SEG_MS]);
    // The playhead sits in a window nobody listed (W - 2S, and W): nothing is
    // guessed at, and only the next listed one is prefetched.
    expect(store.wanted(RUN, W - 2 * SEG_MS + 10)).toEqual([W - SEG_MS]);
    expect(store.wanted(RUN, W + 10)).toEqual([W + SEG_MS]);
    expect(store.wanted(RUN, W + SEG_MS + 10)).toEqual([W + SEG_MS]);
    expect(store.wanted(RUN, W + 2 * SEG_MS + 10)).toEqual([]);
  });

  test("an unlisted window is refused before the fetcher is asked", async () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, listed);
    const calls: number[] = [];
    await expect(store.load(RUN, W, fetcher(segs, calls))).rejects.toThrow("never listed");
    await expect(store.load("other", W - SEG_MS, fetcher(segs, calls))).rejects.toThrow("never listed");
    expect(calls).toEqual([]);
  });

  test("a reach back takes the window before; a reach ahead holds the next until it is near", () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, listed);
    expect(store.wanted(RUN, W + 10, { back: TRAIL_MS })).toEqual([W - SEG_MS, W + SEG_MS]);
    expect(store.wanted(RUN, W - SEG_MS + 10, LIVE_REACH)).toEqual([W - SEG_MS]);
    expect(store.wanted(RUN, W - 30_000, LIVE_REACH)).toEqual([W - SEG_MS]);
    // The next listed window (W + S) is a whole window away until W + S − 60 s.
    expect(store.wanted(RUN, W + SEG_MS - 30_000, LIVE_REACH)).toEqual([W + SEG_MS]);
    // At 60× five wall seconds is a whole window of run time.
    expect(store.wanted(RUN, W - SEG_MS + 10, replayReach(60))).toEqual([W - SEG_MS]);
    expect(store.wanted(RUN, W + 10, replayReach(60))).toEqual([W + SEG_MS]);
    expect(store.wanted(RUN, W + 10, replayReach(1))).toEqual([]);
  });

  test("the page-wide in-flight cap holds across runs", () => {
    const store = createTraceStore();
    const calls: string[] = [];
    const hang = async (r: string, t0: number): Promise<TraceSegment> => {
      calls.push(`${r}:${t0}`);
      return await new Promise<TraceSegment>(() => {});
    };
    for (const r of ["a", "b", "c", "d", "e"]) {
      store.list(r, SEG_MS, [W]);
      store.pump(r, W + 10, hang, LIVE_REACH);
    }
    expect(calls.length).toBe(MAX_IN_FLIGHT_TOTAL);
  });

  test("in flight once, loaded never again, and the tail's windows are not fetched", async () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, listed);
    const calls: number[] = [];
    const f = fetcher(segs, calls);
    store.pump(RUN, W - SEG_MS + 10, f);
    store.pump(RUN, W - SEG_MS + 10, f);
    expect(calls).toEqual([W - SEG_MS, W + SEG_MS]);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.wanted(RUN, W - SEG_MS + 10)).toEqual([]);
    const tailed = createTraceStore();
    tailed.list(RUN, SEG_MS, listed);
    tailed.setTail(RUN, seg(rows, W - SEG_MS, W + SEG_MS));
    expect(tailed.wanted(RUN, W - SEG_MS + 10)).toEqual([]);
  });

  test("never more than the in-flight cap of one run at once", () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, [W - 2 * SEG_MS, W - SEG_MS, W, W + SEG_MS]);
    const calls: number[] = [];
    const hang = async (_r: string, t0: number): Promise<TraceSegment> => {
      calls.push(t0);
      return await new Promise<TraceSegment>(() => {});
    };
    store.pump(RUN, W + 10, hang, { back: 2 * SEG_MS });
    expect(calls.length).toBe(MAX_IN_FLIGHT);
  });

  test("a failure backs off; a 404 is never asked for again", async () => {
    let now = 1_000;
    const store = createTraceStore({ now: () => now });
    store.list(RUN, SEG_MS, [W, W + SEG_MS]);
    await store.load(RUN, W, async () => Promise.reject(Object.assign(new Error("boom"), { status: 503 })));
    expect(store.wanted(RUN, W + 10)).toEqual([W + SEG_MS]);
    now += RETRY_MS;
    expect(store.wanted(RUN, W + 10)).toEqual([W, W + SEG_MS]);
    await store.load(RUN, W + SEG_MS, async () => Promise.reject(Object.assign(new Error("gone"), { status: 404 })));
    now += 1e12;
    expect(store.wanted(RUN, W + SEG_MS + 10)).toEqual([]);
  });

  test("a feed lists only what it carries, and a run that leaves is forgotten", () => {
    const store = createTraceStore();
    const at = (runId: string, recent: number[]): AgentPosition =>
      ({ runId, ts: W, trace: { segMs: SEG_MS, recent, tail: null } }) as unknown as AgentPosition;
    ingestPositions(store, [at("a", [W - SEG_MS]), at("b", [W - 2 * SEG_MS])]);
    expect(store.wanted("a", W - SEG_MS + 5)).toEqual([W - SEG_MS]);
    ingestPositions(store, [at("b", [W - 2 * SEG_MS])]);
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
  });
});

describe("unit state", () => {
  test("the state at the playhead, and when its cast began", async () => {
    const rows = [
      key(W, 0),
      pos(W, 0),
      stateRow(W + 2_000, { hp: 80, auras: [[1243, 1, W + 1_800_000]] }),
      stateRow(W + 4_000, { cast: { spellId: 133, endsAt: W + 7_000 }, combat: true }),
      stateRow(W + 7_000, { cast: null }),
    ];
    const store = createTraceStore();
    store.setTail(RUN, seg(rows, W));
    expect(store.unitAt(RUN, W + 1_000)?.state.hp).toBe(100);
    const mid = store.unitAt(RUN, W + 5_000)!;
    expect(mid.state.hp).toBe(80);
    expect(mid.state.auras).toEqual([[1243, 1, W + 1_800_000]]);
    expect(mid.state.combat).toBe(true);
    expect(mid.state.cast).toEqual({ spellId: 133, endsAt: W + 7_000 });
    expect(mid.castFrom).toBe(W + 4_000);
    expect(store.unitAt(RUN, W + 8_000)?.castFrom).toBeNull();
  });
});

describe("replaying a short or unfinished run", () => {
  // A smoke run: it walked for four minutes inside one window, and the state
  // ticker wrote one 60 s point.
  const start = W + 20_000;
  const rows = walk(start, start + 240_000);
  const onePoint = (trace?: TrackResponse["trace"]): TrackResponse =>
    ({
      runId: RUN,
      characterName: null,
      model: null,
      harnessVersion: null,
      points: [{ ts: start + 60_000, map: 0, x: 60, y: 0, level: 1, xp: 0, money: null, questsCompleted: null, turn: null }],
      ...(trace === undefined ? {} : { trace }),
    }) as TrackResponse;

  test("one point and one closed window: scrubbable over the window's frames, its path drawn", async () => {
    const track = onePoint({ segMs: SEG_MS, segs: [[W, 1]] });
    const store = createTraceStore();
    ingestTrack(store, track);
    // Before the window lands the span reaches its edges, and the store asks for it.
    expect(replaySpan(track, store)).toEqual({ from: W, to: W + SEG_MS });
    expect(store.wanted(RUN, start + 60_000, { ends: true })).toEqual([W]);
    await store.load(RUN, W, fetcher(new Map([[W, seg(rows, W)]])));
    const span = replaySpan(track, store)!;
    expect(span).toEqual({ from: start, to: start + 239_000 });
    expect(span.to).toBeGreaterThan(span.from);
    for (const t of [start + 1_500, start + 120_500, span.to]) {
      expect(store.poseAt(RUN, t)?.x).toBeCloseTo(truth(start, Math.min(t, span.to)), 1);
    }
    const path = store.path(RUN, span.from, start + 100_000);
    expect(path.length).toBe(1);
    expect(path[0]!.points.at(-1)!.x).toBeCloseTo(100, 1);
    expect(store.covers(RUN, start + 60_000)).toBe(true);
  });

  test("past the newest window with no tail the trace has no answer, and the track's own point stands", async () => {
    // The track's last point is two windows on from the only listed one, and
    // there is no tail: the span's end is the track's, and the trace says nothing there.
    const end = W + 2 * SEG_MS + 30_000;
    const track: TrackResponse = {
      ...onePoint({ segMs: SEG_MS, segs: [[W, 1]] }),
      points: [...onePoint().points, { ts: end, map: 1, x: -4025.4, y: -3787.6, level: 1, xp: 0, money: null, questsCompleted: null, turn: null }],
    };
    const store = createTraceStore();
    ingestTrack(store, track);
    await store.load(RUN, W, fetcher(new Map([[W, seg(rows, W)]])));
    const span = replaySpan(track, store)!;
    expect(span.to).toBe(end);
    expect(store.poseAt(RUN, span.to)).toBeNull();
    // What the map places instead: the track's reading, and its coarse pose.
    expect(positionsAt(track, span.to)[0]).toMatchObject({ map: 1, x: -4025.4, y: -3787.6 });
    expect(trackPoseAt(track.points, classifySegments(track), span.to, IDLE_GAP_MS)).toEqual({ map: 1, x: -4025.4, y: -3787.6 });
  });

  test("one point and only a tail, the window still open: scrubbable over the tail", () => {
    const track = onePoint();
    const store = createTraceStore();
    ingestTrack(store, track);
    expect(replaySpan(track, store)).toEqual({ from: start + 60_000, to: start + 60_000 });
    ingestIndex(store, RUN, { segMs: SEG_MS, segs: [], tail: seg(rows.filter((r) => r.ts < start + 180_000), W) });
    const span = replaySpan(track, store)!;
    expect(span).toEqual({ from: start, to: start + 179_000 });
    expect(store.poseAt(RUN, start + 90_000)?.x).toBeCloseTo(90, 1);
    expect(store.wanted(RUN, start + 90_000, { ends: true })).toEqual([]);
  });

  test("the tail's window closing keeps the cursor where it was, before and after the closed copy lands", async () => {
    const track = onePoint();
    const store = createTraceStore();
    ingestTrack(store, track);
    ingestIndex(store, RUN, { segMs: SEG_MS, segs: [], tail: seg(rows, W) });
    const cursor = start + 200_000;
    const before = store.poseAt(RUN, cursor)!.x;
    const spanBefore = replaySpan(track, store)!;
    // Settled: the window is listed and the run has no tail any more.
    ingestIndex(store, RUN, { segMs: SEG_MS, segs: [[W, 1]], tail: null });
    expect(store.poseAt(RUN, cursor)?.x).toBe(before);
    expect(replaySpan(track, store)).toEqual(spanBefore);
    expect(store.wanted(RUN, cursor)).toEqual([W]);
    await store.load(RUN, W, fetcher(new Map([[W, seg(rows, W)]])));
    expect(store.poseAt(RUN, cursor)?.x).toBeCloseTo(before, 1);
    expect(replaySpan(track, store)).toEqual(spanBefore);
    // Or it moved on to the next window: the same, with the new tail beyond.
    const moving = createTraceStore();
    const longer = walk(start, W + SEG_MS + 60_000);
    moving.setTail(RUN, seg(longer.filter((r) => r.ts < W + SEG_MS), W, W + 2 * SEG_MS));
    const x = moving.poseAt(RUN, cursor)!.x;
    ingestIndex(moving, RUN, { segMs: SEG_MS, segs: [[W, 1]], tail: seg(longer, W + SEG_MS) });
    expect(moving.poseAt(RUN, cursor)?.x).toBe(x);
    expect(moving.poseAt(RUN, W + SEG_MS + 30_000)?.x).toBeCloseTo(truth(start, W + SEG_MS + 30_000), 1);
  });
});

describe("a public segment", () => {
  test("a death published by the projection reaches the player and the frame, and the target does not", () => {
    // Killed, released (Ghost on), and raised by a spirit healer (Resurrection Sickness on).
    const GHOST: TraceAura = [8326, 1, 0];
    const SICK: TraceAura = [15007, 1, W + 640_000];
    const rows = [
      key(W, 0, { target: { kind: "player", hpPct: 30 } }),
      pos(W, 0),
      stateRow(W + 2_000, { hp: 0, dead: true }),
      stateRow(W + 20_000, { ghost: true, dead: false, hp: 1, auras: [GHOST] }),
      stateRow(W + 40_000, { ghost: false, hp: 50, auras: [SICK] }),
    ];
    const store = createTraceStore();
    store.setTail(RUN, projectTraceSegment(seg(rows, W)));
    const reading = { level: 5, xp: 10, nextLevelXp: 400, health: 0, maxHealth: 100, power: 0, maxPower: 50, powerType: 0 };
    const alive = store.unitAt(RUN, W + 1_000)!.state;
    expect(alive.hp).toBe(100);
    expect(targetReading(alive.target)).toBeNull();
    // Dead at the corpse: the bar at 0 of its max, and the frame says dead.
    const dead = store.unitAt(RUN, W + 5_000)!.state;
    const g = gaugesOf(reading, dead);
    expect(g).toMatchObject({ health: 0, maxHealth: 100, dead: true });
    expect(healthReading(g.health, g.maxHealth, g.dead)).toMatchObject({ dead: true, title: "dead" });
    // The corpse run: the ghost badge and the Ghost aura, as the private frame shows them.
    const ghost = store.unitAt(RUN, W + 25_000)!.state;
    expect(unitFlags(ghost)).toContain("ghost");
    expect(gaugesOf(reading, ghost)).toMatchObject({ health: 1, maxHealth: 100 });
    expect(auraViews(ghost.auras, W + 25_000).map((a) => a.spellId)).toEqual([GHOST[0]]);
    // Raised by the spirit healer: up, and Resurrection Sickness in the buffs row.
    const up = store.unitAt(RUN, W + 45_000)!.state;
    expect(up.hp).toBe(50);
    expect(unitFlags(up)).not.toContain("ghost");
    expect(auraViews(up.auras, W + 45_000).map((a) => a.spellId)).toEqual([SICK[0]]);
    expect(targetReading(up.target)).toBeNull();
  });
});

describe("trail", () => {
  test("breaks at a cut, and flies a takeoff in its own run", () => {
    const rows = [
      key(W, 0),
      pos(W, 0),
      pos(W + 1000, 1),
      pos(W + 2000, 2),
      pos(W + 3000, 300, { data: JSON.stringify({ jump: 1 }) }),
      pos(W + 4000, 301),
      {
        ts: W + 5000,
        kind: "flight",
        map: 0,
        x: 302,
        y: 0,
        z: 0,
        o: 0,
        data: JSON.stringify({ to: { map: 0, x: 402, y: 0, z: 0 }, durationMs: 10_000 }),
      },
    ];
    const store = createTraceStore();
    store.setTail(RUN, seg(rows, W));
    const runs = store.trail(RUN, W, W + 10_000);
    expect(runs.map((r) => r.flight)).toEqual([false, false, true]);
    expect(runs[0]!.points.at(-1)!.x).toBeCloseTo(2, 1);
    expect(runs[1]!.points[0]!.x).toBeCloseTo(300, 1);
    // Half way along the flight at the playhead.
    expect(runs[2]!.points.at(-1)!.x).toBeCloseTo(352, 0);
  });
});

describe("live clock", () => {
  const H = W + 200_000;
  const privateCadence = liveCadence({ renderMs: 0, cacheMs: 4_000 }, 5_000);
  const publicCadence = liveCadence({ renderMs: 420_000, cacheMs: 60_000 }, 5_000);

  test("the delay comes from the source's cadence, not from which build it is", () => {
    expect(privateCadence).toEqual({ periodMs: 10_000, lagMs: 0 });
    expect(publicCadence).toEqual({ periodMs: 420_000, lagMs: 65_000 });
    expect(createLiveClock(privateCadence).delayMs()).toBe(12_000);
    expect(createLiveClock(publicCadence).delayMs()).toBe(420_000 + 65_000 + 42_000);
    expect(marginOf(10_000)).toBe(2_000);
  });

  test("anchored to the arrival and run off performance.now() at 1×", () => {
    const c = createLiveClock(privateCadence);
    expect(c.at(0)).toBeNull();
    c.arrive({ horizon: H, ageMs: 0, at: 1_000 });
    expect(c.at(1_000)).toBe(H - 12_000);
    expect(c.at(4_000)).toBe(H - 9_000);
  });

  test("a snapshot's age is counted, so a late fetch does not start a whole extra cadence behind", () => {
    const c = createLiveClock(publicCadence);
    c.arrive({ horizon: H, ageMs: 360_000, at: 0 });
    expect(c.at(0)).toBe(H + 360_000 - c.delayMs());
    // The next publish lands about a minute later and the playhead has not caught up.
    expect(c.at(125_000)!).toBeLessThan(H);
  });

  test("starved, it holds at the horizon, and the next arrival resumes it from there", () => {
    const c = createLiveClock(privateCadence);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    expect(c.at(12_000)).toBe(H);
    expect(c.at(40_000)).toBe(H);
    c.arrive({ horizon: H + 10_000, ageMs: 0, at: 40_000 });
    expect(c.at(40_000)).toBe(H);
    expect(c.at(41_000)).toBe(H + 1_000);
  });

  test("a tab that wakes an hour later holds, then jumps to the delay", () => {
    const c = createLiveClock(privateCadence);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    const woke = 3_600_000;
    expect(c.at(woke)).toBe(H);
    c.arrive({ horizon: H + woke, ageMs: 0, at: woke });
    expect(c.at(woke)).toBe(H + woke - c.delayMs());
  });

  test("a little behind, it catches up at the catch-up rate rather than jumping", () => {
    const c = createLiveClock(privateCadence);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    // Ten seconds of data five seconds later: five behind the ideal.
    c.arrive({ horizon: H + 10_000, ageMs: 0, at: 5_000 });
    expect(c.at(5_000)).toBe(H - 7_000);
    expect(c.at(7_000)).toBe(H - 7_000 + 2_000 * CATCHUP_RATE);
    // Level after 5 s / 0.5 = 10 s, then 1×.
    expect(c.at(15_000)).toBe(H + 10_000 - 12_000 + 10_000);
    expect(c.at(16_000)! - c.at(15_000)!).toBe(1_000);
  });

  test("a body seen again changes nothing", () => {
    const c = createLiveClock(privateCadence);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    c.arrive({ horizon: H, ageMs: 0, at: 3_000 });
    expect(c.at(3_000)).toBe(H - 9_000);
  });

  test("the period is learned from the horizons, an outage aside", () => {
    const c = createLiveClock(publicCadence);
    let h = H;
    let p = 0;
    c.arrive({ horizon: h, ageMs: 0, at: p });
    for (let i = 0; i < 4; i++) c.arrive({ horizon: (h += 400_000), ageMs: 0, at: (p += 400_000) });
    expect(c.delayMs()).toBe(400_000 + 65_000 + 40_000);
    c.arrive({ horizon: (h += 4 * 3_600_000), ageMs: 0, at: (p += 4 * 3_600_000) });
    expect(c.delayMs()).toBe(400_000 + 65_000 + 40_000);
  });

  test("a gap the tab slept through is not learned: a hidden map comes back on its old delay", () => {
    const c = createLiveClock(publicCadence);
    let h = H;
    let p = 0;
    /** One publish period watched: an answer every 5 s, the new horizon at its end. */
    const watched = (periodMs: number): void => {
      for (let t = 5_000; t < periodMs; t += 5_000) c.arrive({ horizon: h, ageMs: 0, at: p + t });
      c.arrive({ horizon: (h += periodMs), ageMs: 0, at: (p += periodMs) });
    };
    c.arrive({ horizon: h, ageMs: 0, at: p });
    for (let i = 0; i < 4; i++) watched(400_000);
    const learned = c.delayMs();
    expect(learned).toBe(400_000 + 65_000 + 40_000);
    // Hidden for three passes: no answers at all, then one spanning all three.
    c.arrive({ horizon: (h += 3 * 400_000), ageMs: 0, at: (p += 3 * 400_000) });
    expect(c.delayMs()).toBe(learned);
    // A slower publisher the tab does watch is still learned.
    watched(600_000);
    expect(c.delayMs()).toBe(600_000 + 65_000 + 60_000);
  });

  test("on the public site's first load the playhead lands in what live.json carries", async () => {
    const gen = W + 200_000;
    const start = gen - 30 * 60_000;
    const rows = walk(start, gen - DRAIN_MS);
    const tail0 = tailStart(gen);
    const recent = [tail0 - 3 * SEG_MS, tail0 - 2 * SEG_MS, tail0 - SEG_MS];
    const store = createTraceStore();
    store.list(RUN, SEG_MS, recent);
    store.setTail(RUN, seg(rows, tail0, tail0 + 2 * SEG_MS));
    const segs = new Map(recent.map((t0) => [t0, seg(rows, t0)]));
    const c = createLiveClock(publicCadence);
    // The worst case for reach: fetched the moment it was published.
    c.arrive({ horizon: gen - DRAIN_MS, ageMs: 0, at: 0 });
    const t = c.at(0)!;
    const want = store.wanted(RUN, t, { back: TRAIL_MS });
    expect(want.length).toBeGreaterThan(0);
    for (const t0 of want) expect(recent).toContain(t0);
    for (const t0 of want) await store.load(RUN, t0, fetcher(segs));
    expect(store.poseAt(RUN, t)?.x).toBeCloseTo(truth(start, t), 1);
    // And it runs a whole learned cadence without reaching the data's end.
    expect(c.at(420_000 + 65_000)!).toBeLessThan(gen - DRAIN_MS);
  });

  test("a feed's horizon: its render time when it has one, else the newest thing in it", () => {
    const tail = seg([key(W, 0), pos(W + 3_000, 3), stateRow(W + 4_500, { hp: 1 })], W);
    const p = { runId: RUN, ts: W - 50_000, trace: { segMs: SEG_MS, recent: [], tail } } as unknown as AgentPosition;
    expect(horizonOf({ positions: [p] }, 0, 7)).toEqual({ horizon: W + 4_500, ageMs: 0, at: 7 });
    expect(horizonOf({ positions: [p], generatedAt: W + 60_000 }, W + 90_000, 7)).toEqual({
      horizon: W + 60_000 - DRAIN_MS,
      ageMs: 30_000,
      at: 7,
    });
    expect(horizonOf({ positions: [] }, 0, 0)).toBeNull();
  });
});

describe("replay clock", () => {
  test("speeds are multiples of the run's own clock", () => {
    expect([...SPEEDS]).toEqual([1, 10, 60, 600, 3600]);
    expect(nextSpeed(3600)).toBe(1);
    expect(advanceCursor(0, 1_000, 60, [])).toBe(60_000);
    expect(advanceCursor(0, 1_000, 1, [])).toBe(1_000);
  });

  test("an idle gap plays in a second at any speed slower than that, and the rest at speed", () => {
    // 7,788 s: the longest pause on the record.
    const idle = [{ from: 100_000, to: 100_000 + 7_788_000 }];
    for (const speed of [1, 60, 600]) {
      const intoGap = (100_000 - 90_000) / speed;
      expect(advanceCursor(90_000, intoGap + IDLE_PLAY_MS, speed, idle)).toBeCloseTo(idle[0]!.to, 3);
    }
    expect(advanceCursor(idle[0]!.to, 1_000, 60, idle)).toBe(idle[0]!.to + 60_000);
  });

  test("monotonic in wall time, across gaps", () => {
    const idle = [{ from: 10_000, to: 500_000 }, { from: 600_000, to: 9_000_000 }];
    let last = -1;
    for (let w = 0; w < 20_000; w += 37) {
      const t = advanceCursor(0, w, 10, idle);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  test("no dead air: a run with a two-hour pause takes no longer than its active time", () => {
    const pts = [0, 60_000, 120_000, 120_000 + 7_788_000, 120_000 + 7_848_000].map((ts) => ({ ts }));
    const idle = idleSpans(pts);
    expect(idle).toEqual([{ from: 120_000, to: 120_000 + 7_788_000 }]);
    // 180 s of activity at 60× is 3 s; the pause adds one.
    expect(advanceCursor(0, 4_000, 60, idle)).toBeCloseTo(pts[4]!.ts, 3);
  });

  test("a gap just at the sample cadence is not idle", () => {
    expect(idleSpans([{ ts: 0 }, { ts: IDLE_GAP_MS }])).toEqual([]);
  });

  test("anchored: a tab that wakes later finds the cursor where the anchor puts it, stopped at the end", () => {
    const anchor = { cursor: 0, at: 1_000, speed: 60 };
    expect(replayCursorAt(anchor, 2_000, [], 1e9)).toBe(60_000);
    expect(replayCursorAt(anchor, 1_000 + 600_000, [], 1e9)).toBe(36_000_000);
    expect(replayCursorAt(anchor, 1_000 + 600_000, [], 5_000_000)).toBe(5_000_000);
  });
});

describe("a run with no trace", () => {
  const point = (ts: number, x: number, map = 0): TrackPoint => ({
    ts,
    map,
    x,
    y: 0,
    level: 1,
    xp: 0,
    money: null,
    questsCompleted: null,
    turn: null,
  });

  test("the store knows nothing and asks for nothing", () => {
    const store = createTraceStore();
    const track = { runId: RUN, points: [point(0, 0)] } as unknown as TrackResponse;
    ingestTrack(store, track);
    expect(store.has(RUN)).toBe(false);
    expect(store.poseAt(RUN, 0)).toBeNull();
    expect(store.unitAt(RUN, 0)).toBeNull();
    expect(store.wanted(RUN, 0)).toEqual([]);
  });

  test("the coarse track interpolates in time, and holds across a teleport and an idle gap", () => {
    const points = [point(0, 0), point(60_000, 60), point(120_000, 5_000), point(400_000, 5_100), point(460_000, 0, 1)];
    const kinds = classifySegments({ points, travel: [{ kind: "hearth", ts: 61_000 }] });
    expect(trackPoseAt(points, kinds, 30_000, IDLE_GAP_MS)?.x).toBe(30);
    expect(trackPoseAt(points, kinds, 90_000, IDLE_GAP_MS)?.x).toBe(60);
    expect(trackPoseAt(points, kinds, 300_000, IDLE_GAP_MS)?.x).toBe(5_000);
    expect(trackPoseAt(points, kinds, 430_000, IDLE_GAP_MS)?.x).toBe(5_100);
    expect(trackPoseAt(points, kinds, -1, IDLE_GAP_MS)).toBeNull();
  });
});
