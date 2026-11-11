/**
 * Map replay as a run's feed.
 *
 * The property that keeps the one-renderer design intact is that a cursor
 * produces the same `AgentPosition[]` shape the live feed produces; these pin
 * that, and the `?run=` parameter. The cursor maths and the route are the
 * inspector's, tested there.
 */

import { describe, expect, test } from "bun:test";
import type { TrackPoint, TrackResponse } from "../../runner/viewer/api-types";
import { trackSpan } from "@wrathbench/inspector/views/replay";
import { positionsAt, runParam } from "../src/lib/replay";

function point(ts: number, map: number, x: number, y: number): TrackPoint {
  return {
    ts, map, x, y, level: 5, xp: 100, money: null, questsCompleted: null, turn: ts,
    // The player frame's numbers, as a recorded track carries them.
    health: 140, maxHealth: 220, power: 30, maxPower: 100, powerType: 0, nextLevelXp: 2100,
  };
}

const TRACK: TrackResponse = {
  runId: "run-1",
  characterName: "Benchy",
  model: "test/model",
  harnessVersion: "harness-0.2",
  points: [point(100, 0, 1, 1), point(200, 0, 2, 2), point(300, 530, 9, 9)],
};

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

  test("the quest count is the track's at the cursor, so the replay's end reads the run's", () => {
    // Points as the viewer builds them: the run's count so far, across a resume (`trackFrom`).
    const counts = [4, 6, 9];
    const track: TrackResponse = { ...TRACK, points: TRACK.points.map((p, i) => ({ ...p, questsCompleted: counts[i]! })) };
    expect(positionsAt(track, 150)[0]?.questsCompleted).toBe(4);
    expect(positionsAt(track, trackSpan(track.points)!.to)[0]?.questsCompleted).toBe(9);
    // A track published before the count was filled reads as not recorded.
    expect(positionsAt(TRACK, 300)[0]?.questsCompleted).toBeNull();
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

describe("a run's feed over the edges of its track", () => {
  test("one position is one pip; none is no feed", () => {
    expect(positionsAt({ ...TRACK, points: [point(100, 0, 1, 1)] }, 100)).toHaveLength(1);
    expect(positionsAt({ ...TRACK, points: [] }, 0)).toEqual([]);
  });

  test("the feed carries no inventory: the sidebar reads it off the track", () => {
    const t: TrackResponse = { ...TRACK, points: [1, 2, 3].map((ts) => point(ts, 0, 0, 0)), inv: { items: [["Linen Cloth", 2589, 1]], at: [[1, [[255, 23, 0, 3]]]] } };
    expect(Object.keys(positionsAt(t, 3)[0]!)).not.toContain("items");
  });
});
