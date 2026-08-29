/**
 * Map replay's cursor maths (FOLLOW-UPS 22).
 *
 * The property that keeps the one-renderer design intact is that a cursor produces the same
 * `AgentPosition[]` shape the live feed produces — these pin that, plus the
 * two things a scrubber gets wrong: a cursor before the first sample, and a
 * route drawn across a continent change.
 */

import { describe, expect, test } from "bun:test";
import type { TrackPoint, TrackResponse } from "../../runner/viewer/api-types";
import {
  indexAt,
  mapsVisited,
  nextSampleAfter,
  positionsAt,
  routeUpTo,
  runParam,
  trackSpan,
} from "../src/lib/replay";

function point(ts: number, map: number, x: number, y: number): TrackPoint {
  return {
    ts, map, x, y, level: 5, xp: 100, money: null, questsCompleted: null, turn: ts,
    // The player frame's numbers (FOLLOW-UPS 104), as a recorded track carries them.
    health: 140, maxHealth: 220, power: 30, maxPower: 100, powerType: 0, nextLevelXp: 2100,
  };
}

const TRACK: TrackResponse = {
  runId: "run-1",
  character: "Benchy",
  model: "test/model",
  harnessVersion: "harness-0.2",
  points: [point(100, 0, 1, 1), point(200, 0, 2, 2), point(300, 530, 9, 9)],
};

describe("indexAt", () => {
  test("finds the last sample at or before the cursor", () => {
    expect(indexAt(TRACK.points, 99)).toBe(-1);
    expect(indexAt(TRACK.points, 100)).toBe(0);
    expect(indexAt(TRACK.points, 250)).toBe(1);
    expect(indexAt(TRACK.points, 10_000)).toBe(2);
    expect(indexAt([], 5)).toBe(-1);
  });
});

describe("positionsAt", () => {
  test("produces the live feed's shape at the cursor", () => {
    const [p] = positionsAt(TRACK, 250);
    expect(p).toMatchObject({
      runId: "run-1",
      character: "Benchy",
      model: "test/model",
      map: 0,
      x: 2,
      y: 2,
      ts: 200,
      harnessVersion: "harness-0.2",
      // The frame replays with the sample, so a replayed pip lights up too.
      health: 140,
      maxHealth: 220,
      power: 30,
      maxPower: 100,
      powerType: 0,
      nextLevelXp: 2100,
    });
  });

  test("before the first recorded position there is nothing to draw", () => {
    expect(positionsAt(TRACK, 1)).toEqual([]);
  });
});

describe("trackSpan / routeUpTo / mapsVisited", () => {
  test("the span is first to last sample", () => {
    expect(trackSpan(TRACK.points)).toEqual({ from: 100, to: 300 });
    expect(trackSpan([])).toBeNull();
  });

  test("the route stops at the cursor and never crosses maps", () => {
    expect(routeUpTo(TRACK.points, 0, 250)).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
    // The Outland sample is on another map: it must not join the first route.
    expect(routeUpTo(TRACK.points, 0, 10_000)).toHaveLength(2);
    expect(routeUpTo(TRACK.points, 530, 10_000)).toEqual([{ x: 9, y: 9 }]);
  });

  test("maps come back in visit order", () => {
    expect(mapsVisited(TRACK.points)).toEqual([0, 530]);
  });
});

describe("nextSampleAfter", () => {
  test("walks the track one sample at a time and then stops", () => {
    expect(nextSampleAfter(TRACK.points, 0)?.ts).toBe(100);
    expect(nextSampleAfter(TRACK.points, 100)?.ts).toBe(200);
    expect(nextSampleAfter(TRACK.points, 150)?.ts).toBe(200);
    expect(nextSampleAfter(TRACK.points, 300)).toBeUndefined();
    // Nothing to play: the caller reads this as "the run is over" and pauses.
    expect(nextSampleAfter([], 0)).toBeUndefined();
  });

  test("two samples in the same millisecond do not stall playback", () => {
    const tied = [point(100, 0, 1, 1), point(100, 0, 2, 2), point(200, 0, 3, 3)];
    expect(nextSampleAfter(tied, 100)?.ts).toBe(200);
  });
});

describe("degenerate tracks", () => {
  test("a run that recorded one position still scrubs and draws", () => {
    const one = [point(100, 0, 1, 1)];
    expect(trackSpan(one)).toEqual({ from: 100, to: 100 });
    expect(positionsAt({ ...TRACK, points: one }, 100)).toHaveLength(1);
    // One point is a dot, not a line: the renderer skips a route this short.
    expect(routeUpTo(one, 0, 100)).toHaveLength(1);
    expect(nextSampleAfter(one, 100)).toBeUndefined();
  });

  test("a run that recorded nothing has no span, no feed and no route", () => {
    expect(trackSpan([])).toBeNull();
    expect(positionsAt({ ...TRACK, points: [] }, 0)).toEqual([]);
    expect(routeUpTo([], 0, 0)).toEqual([]);
    expect(mapsVisited([])).toEqual([]);
  });
});

describe("runParam", () => {
  /*
   * `/map` and `/map?run=<id>` are the page's two states, so this is the whole
   * of the mapping between a URL and a mode. A repeated parameter arrives as an
   * array and an empty one as "": neither names a run, and both mean live.
   */
  test("a non-empty single value is the run id", () => {
    expect(runParam("run-1")).toBe("run-1");
  });

  test("absent, empty and repeated all mean the live map", () => {
    expect(runParam(undefined)).toBeUndefined();
    expect(runParam("")).toBeUndefined();
    expect(runParam(["run-1", "run-2"])).toBeUndefined();
  });
});
