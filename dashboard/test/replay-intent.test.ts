/**
 * A run's replay feed carries the movement intention standing at the cursor.
 * The overlay's own decisions are the inspector's (`views/lib/mapintent.ts`),
 * tested there.
 */
import { describe, expect, test } from "bun:test";
import type { MoveIntentView, TrackResponse } from "@viewer/api-types";

import { intentToDraw } from "@wrathbench/inspector/views/mapintent";
import { positionsAt } from "../src/lib/replay";

const NOW = 1_700_000_000_000;

function move(over: Partial<MoveIntentView> = {}): MoveIntentView {
  return { ts: NOW, map: 0, x: -6100, y: 400, z: 380, target: null, status: null, ...over };
}

describe("the replay feed carries the intention standing at the cursor", () => {
  const track: TrackResponse = {
    runId: "r1",
    characterName: "Char",
    model: "a/model",
    harnessVersion: "harness-0.5",
    points: [
      { ts: 1000, map: 0, x: -6240, y: 380, level: 1, xp: 0, money: null, questsCompleted: null, turn: 1 },
      { ts: 2000, map: 0, x: -6200, y: 390, level: 1, xp: 0, money: null, questsCompleted: null, turn: 2 },
    ],
    moves: [move({ ts: 1500 }), move({ ts: 1900, status: "too_far" })],
  };

  test("the cursor picks the intention, not the track point beside it", () => {
    expect(positionsAt(track, 1000)[0]!.move).toBeNull();
    expect(positionsAt(track, 1600)[0]!.move!.status).toBeNull();
    expect(positionsAt(track, 2000)[0]!.move!.status).toBe("too_far");
  });

  test("a replayed intention is aged against the cursor, never the wall clock", () => {
    // The map's own composition, in one assertion: what `positionsAt` hands
    // the renderer is a recording, so ageing it against `Date.now()` would
    // drop every intention a replay ever had.
    const at = positionsAt(track, 1600)[0]!.move!;
    expect(intentToDraw(at, 0, 1600)).not.toBeNull();
    expect(intentToDraw(at, 0, Date.now())).toBeNull();
  });

  test("a track published before intentions existed replays without them", () => {
    const { moves: _dropped, ...older } = track;
    expect(positionsAt(older as TrackResponse, 2000)[0]!.move).toBeNull();
  });
});
