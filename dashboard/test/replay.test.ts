/**
 * Map replay as a run's feed.
 *
 * The property that keeps the one-renderer design intact is that a cursor
 * produces the same `AgentPosition[]` shape the live feed produces; these pin
 * that, the readings it carries at the cursor, and the `?run=` parameter. The
 * cursor maths, the route and the intent overlay are the inspector's, tested
 * there.
 */

import { describe, expect, test } from "bun:test";
import type { MoveIntentView, TrackPoint, TrackResponse } from "../../viewer/api-types";
import { trackSpan } from "@wrathbench/inspector/views/replay";
import { intentToDraw } from "@wrathbench/inspector/views/mapintent";
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
  test("produces the live feed's shape at the cursor, and nothing before the first position", () => {
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
      health: 140,
      maxHealth: 220,
      nextLevelXp: 2100,
    });
    expect(positionsAt(TRACK, 1)).toEqual([]);
  });

  test("the quest count is the track's at the cursor, so the replay's end reads the run's", () => {
    const counts = [4, 6, 9];
    const track: TrackResponse = { ...TRACK, points: TRACK.points.map((p, i) => ({ ...p, questsCompleted: counts[i]! })) };
    expect(positionsAt(track, 150)[0]?.questsCompleted).toBe(4);
    expect(positionsAt(track, trackSpan(track.points)!.to)[0]?.questsCompleted).toBe(9);
    // A track published before the count was filled reads as not recorded.
    expect(positionsAt(TRACK, 300)[0]?.questsCompleted).toBeNull();
  });

  test("the movement intention is the one standing at the cursor, aged against the cursor and never the wall clock", () => {
    const move = (over: Partial<MoveIntentView>): MoveIntentView => ({ ts: 0, map: 0, x: -6100, y: 400, z: 380, target: null, status: null, ...over });
    const track: TrackResponse = { ...TRACK, moves: [move({ ts: 150 }), move({ ts: 190, status: "too_far" })] };
    expect(positionsAt(track, 100)[0]!.move).toBeNull();
    expect(positionsAt(track, 160)[0]!.move!.status).toBeNull();
    expect(positionsAt(track, 200)[0]!.move!.status).toBe("too_far");
    // What `positionsAt` hands the renderer is a recording: ageing it against
    // `Date.now()` would drop every intention a replay ever had.
    const at = positionsAt(track, 160)[0]!.move!;
    expect(intentToDraw(at, 0, 160)).not.toBeNull();
    expect(intentToDraw(at, 0, Date.now())).toBeNull();
    // A track published before intentions existed replays without them.
    expect(positionsAt(TRACK, 200)[0]!.move).toBeNull();
  });
});

describe("runParam", () => {
  test("a non-empty single value is the run id; absent, empty and repeated all mean the live map", () => {
    expect(runParam("run-1")).toBe("run-1");
    expect(runParam(undefined)).toBeUndefined();
    expect(runParam("")).toBeUndefined();
    expect(runParam(["run-1", "run-2"])).toBeUndefined();
  });
});
