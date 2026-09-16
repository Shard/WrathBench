/**
 * The character page's axis (item 128).
 *
 * The one thing worth pinning here is that the gaps between sessions are
 * closed and the seams survive: a character paused for a week between two
 * afternoons must not draw a week, and the boundary must land at the join even
 * when the two sessions' clocks are a second apart.
 */

import { describe, expect, test } from "bun:test";
import type { CharacterStatePoint } from "@viewer/api-types";
import { characterSessionSeries } from "../src/lib/character";

function pt(runId: string, attempt: number, ts: number, level: number, xp: number): CharacterStatePoint {
  return {
    runId,
    attempt,
    ts,
    level,
    xp,
    map: 0,
    x: null,
    y: null,
    z: null,
    eventCount: null,
    lastSeq: null,
    turn: null,
  };
}

const DAY = 86_400_000;

describe("characterSessionSeries", () => {
  test("lays sessions end to end and closes the gap between them", () => {
    const s = characterSessionSeries([
      pt("a1", 1, 1000, 1, 0),
      pt("a1", 1, 4000, 2, 50),
      // A week later, and the second session's own clock starts wherever it starts.
      pt("a2", 2, 1000 + DAY * 7, 2, 60),
      pt("a2", 2, 3000 + DAY * 7, 3, 90),
    ]);
    expect(s.states.map((p) => p.ts)).toEqual([0, 3000, 3000, 5000]);
    expect(s.totalMs).toBe(5000);
    // One seam, at the join, naming the attempt that begins there.
    expect(s.seams).toEqual([{ at: 3000, attempt: 2, runId: "a2" }]);
  });

  test("the sample is otherwise untouched, so both pages read one number", () => {
    const s = characterSessionSeries([pt("a1", 1, 500, 7, 1234)]);
    expect(s.states[0]).toMatchObject({ runId: "a1", attempt: 1, ts: 0, level: 7, xp: 1234 });
  });

  test("a character of one attempt has no seam at all", () => {
    const s = characterSessionSeries([pt("a1", 1, 0, 1, 0), pt("a1", 1, 100, 1, 10)]);
    expect(s.seams).toEqual([]);
    expect(s.totalMs).toBe(100);
  });

  test("an attempt sampled once lands a seam and contributes no time", () => {
    const s = characterSessionSeries([
      pt("a1", 1, 0, 1, 0),
      pt("a1", 1, 200, 2, 10),
      pt("a2", 2, DAY, 2, 10),
      pt("a3", 3, DAY * 2, 2, 10),
      pt("a3", 3, DAY * 2 + 50, 3, 20),
    ]);
    expect(s.seams).toEqual([
      { at: 200, attempt: 2, runId: "a2" },
      { at: 200, attempt: 3, runId: "a3" },
    ]);
    expect(s.totalMs).toBe(250);
  });

  test("nothing recorded is an empty axis, not a throw", () => {
    expect(characterSessionSeries([])).toEqual({ states: [], seams: [], totalMs: 0 });
  });
});
