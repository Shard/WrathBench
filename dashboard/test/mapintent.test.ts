/**
 * The movement-intention overlay's decisions, with no canvas: which intention
 * belongs to a cursor, whether it is still worth drawing, and what it means.
 */
import { describe, expect, test } from "bun:test";
import type { MoveIntentView, TrackResponse } from "@viewer/api-types";
import {
  INTENT_ENDED_MS,
  INTENT_WALKING_MS,
  intentAt,
  intentLabel,
  intentToDraw,
  intentTone,
} from "../src/lib/mapintent";
import { positionsAt } from "../src/lib/replay";

const NOW = 1_700_000_000_000;

function move(over: Partial<MoveIntentView> = {}): MoveIntentView {
  return { ts: NOW, map: 0, x: -6100, y: 400, z: 380, target: null, status: null, ...over };
}

describe("intentTone", () => {
  test("no verdict is a move still walking", () => {
    expect(intentTone(null)).toBe("walking");
  });

  test("the outcomes that are not failures are the listed ones", () => {
    for (const s of ["arrived", "transferred", "teleported", "stopped", "superseded"]) {
      expect(intentTone(s)).toBe("ended");
    }
  });

  test("every other status the module can answer with reads as a failure", () => {
    for (const s of ["too_far", "drop", "lost", "target_off_mesh", "something_new"]) {
      expect(intentTone(s)).toBe("failed");
    }
  });
});

describe("intentToDraw", () => {
  test("nothing to draw when the run recorded none", () => {
    expect(intentToDraw(null, 0, NOW)).toBeNull();
    expect(intentToDraw(undefined, 0, NOW)).toBeNull();
  });

  test("a destination from another map is not this map's", () => {
    expect(intentToDraw(move({ map: 1 }), 0, NOW)).toBeNull();
    // A row that never recorded a map is drawn where it is read: an old row
    // has no continent to disagree with.
    expect(intentToDraw(move({ map: null }), 0, NOW)).not.toBeNull();
  });

  test("a walking intention outlives a settled one, and both eventually go", () => {
    const walking = move({ ts: NOW - INTENT_ENDED_MS - 1 });
    expect(intentToDraw(walking, 0, NOW)).not.toBeNull();
    expect(intentToDraw(move({ ts: NOW - INTENT_ENDED_MS - 1, status: "arrived" }), 0, NOW)).toBeNull();
    // Past the walking bound the verdict is never coming: a paused run must
    // not sit on the map for the rest of the day claiming to be walking.
    expect(intentToDraw(move({ ts: NOW - INTENT_WALKING_MS - 1 }), 0, NOW)).toBeNull();
  });

  test("a snapshot feed's own latency counts against the intention, as it does a pip", () => {
    const m = move({ ts: NOW - 60_000, status: "arrived" });
    // The reading was already 100s old when the snapshot was rendered, and
    // this tab has held that response 30s: 130s of age on a reading whose own
    // timestamp is 60s old, which is past the settled bound.
    const clock = { generatedAt: NOW + 40_000, fetchedAt: NOW - 30_000 };
    expect(intentToDraw(m, 0, NOW, clock)).toBeNull();
    expect(intentToDraw(m, 0, NOW, null)).not.toBeNull();
  });
});

describe("intentAt", () => {
  const moves = [move({ ts: 1000 }), move({ ts: 1400, status: "arrived" }), move({ ts: 2000, x: -5000 })];

  test("the newest intention at or before the cursor", () => {
    expect(intentAt(moves, 999)).toBeNull();
    expect(intentAt(moves, 1000)!.ts).toBe(1000);
    expect(intentAt(moves, 1399)!.ts).toBe(1000);
    expect(intentAt(moves, 1400)!.status).toBe("arrived");
    expect(intentAt(moves, 9999)!.x).toBe(-5000);
  });

  test("a track with no intentions, or from a publish that predates them", () => {
    expect(intentAt([], 1000)).toBeNull();
    expect(intentAt(undefined, 1000)).toBeNull();
  });
});

describe("intentLabel", () => {
  test("what the move was aimed at, when it was aimed at something", () => {
    expect(intentLabel(move({ target: "Marshal McBride" }))).toBe("Marshal McBride");
  });

  test("where it was aimed otherwise, rounded", () => {
    expect(intentLabel(move({ x: -6100.4, y: 400.6 }))).toBe("-6100, 401");
    // The public build withholds names, so it always reads the second way.
    expect(intentLabel(move({ target: "" }))).toBe("-6100, 400");
  });
});

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
