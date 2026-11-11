/**
 * The trace player (`@wrathbench/inspector/views/traceplayer`) where WrathBench
 * adds to it: a segment as the public projection publishes it, the public
 * site's first load at the publisher's cadence, and a run's own position
 * standing where the trace has no answer. Everything the player does over a
 * session alone, keyed by its id, is the inspector's suite
 * (`wrath-mcp/inspector/test/views/traceplayer.test.ts`).
 *
 * Every row here is invented — a character walking along x at a yard a
 * second — so nothing in this file comes from a run.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, tailStart, type TraceRow } from "@wrathbench/inspector/codec/trace";
import type { TraceAura, TraceSegment, TrackResponse } from "../../runner/viewer/api-types";
import { DRAIN_MS, TRAIL_MS, createLiveClock, createTraceStore, ingestTracks, liveCadence, replaySpan } from "@wrathbench/inspector/views/traceplayer";
import { positionsAt } from "../src/lib/replay";
import { auraViews, gaugesOf, healthReading, targetReading, unitFlags } from "@wrathbench/inspector/views/unitframe";
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
const pos = (ts: number, x: number): TraceRow => ({ ts, kind: "pos", map: 0, x, y: 0, z: 0, o: 0, data: null });
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
function fetcher(segs: Map<number, TraceSegment>) {
  return async (_run: string, t0: number): Promise<TraceSegment> => {
    const s = segs.get(t0);
    if (s === undefined) throw new Error(`unlisted window requested: ${t0}`);
    return s;
  };
}

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

describe("the public site's live map", () => {
  test("on the first load the playhead lands in what live.json carries", async () => {
    const publicCadence = liveCadence({ renderMs: 420_000, cacheMs: 60_000 }, 5_000);
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
});

describe("replaying a run past its trace", () => {
  test("past the newest window with no tail the trace has no answer, and the run's own position stands", async () => {
    // A short run's one closed window, and its last track point two windows on.
    const start = W + 20_000;
    const end = W + 2 * SEG_MS + 30_000;
    const point = (ts: number, map: number, x: number, y: number) => ({ ts, map, x, y, level: 1, xp: 0, money: null, questsCompleted: null, turn: null });
    const track: TrackResponse = {
      runId: RUN,
      characterName: null,
      model: null,
      harnessVersion: null,
      points: [point(start + 60_000, 0, 60, 0), point(end, 1, -4025.4, -3787.6)],
      trace: { segMs: SEG_MS, segs: [[W, 1]] },
    };
    const store = createTraceStore();
    ingestTracks(store, [track], (t) => t.runId);
    await store.load(RUN, W, fetcher(new Map([[W, seg(walk(start, start + 240_000), W)]])));
    const span = replaySpan(track.points, track.runId, store)!;
    expect(span.to).toBe(end);
    expect(store.poseAt(RUN, span.to)).toBeNull();
    // What the map places instead: the run's reading at the cursor.
    expect(positionsAt(track, span.to)[0]).toMatchObject({ runId: RUN, map: 1, x: -4025.4, y: -3787.6 });
  });
});
