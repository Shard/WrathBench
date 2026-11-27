/**
 * The character page's axis.
 *
 * The one thing worth pinning here is that the gaps between sessions are
 * closed and the seams survive: a character paused for a week — between two
 * attempts, or inside one when a paused run is resumed in place — must not
 * draw a week, and the boundary must land at the join even when the two
 * sessions' clocks are a second apart.
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

/** A seam at the start of a new attempt, where no sessions were served for it. */
const attemptSeam = (at: number, attempt: number, session: number, runId: string) => ({
  at,
  attempt,
  session,
  runId,
  newAttempt: true,
  startedAt: null,
});

describe("characterSessionSeries, attempts served without sessions", () => {
  test("lays attempts end to end and closes the gap between them", () => {
    const s = characterSessionSeries([
      pt("a1", 1, 1000, 1, 0),
      pt("a1", 1, 4000, 2, 50),
      // A week later, and the second attempt's own clock starts wherever it starts.
      pt("a2", 2, 1000 + DAY * 7, 2, 60),
      pt("a2", 2, 3000 + DAY * 7, 3, 90),
    ]);
    expect(s.states.map((p) => p.ts)).toEqual([0, 3000, 3000, 5000]);
    expect(s.totalMs).toBe(5000);
    // One seam, at the join, naming the attempt that begins there.
    expect(s.seams).toEqual([attemptSeam(3000, 2, 2, "a2")]);
  });
});

describe("characterSessionSeries on the session clock", () => {
  /** sol-61's shape: one attempt, 20 hours, paused, resumed in place five days later. */
  const HOUR = 3_600_000;
  const T0 = 1_000_000;
  const PAUSE = T0 + 20 * HOUR;
  const RESUME = PAUSE + 5 * DAY;

  test("an attempt resumed in place is two sessions: the pause is closed and the resume is a seam", () => {
    const s = characterSessionSeries(
      [pt("s1", 1, T0 + 1000, 1, 0), pt("s1", 1, PAUSE - 1000, 13, 4602), pt("s1", 1, RESUME + 1000, 13, 4602)],
      [
        {
          runId: "s1",
          playtimeMs: 20 * HOUR + 2000,
          sessions: [
            { start: T0, end: PAUSE },
            { start: RESUME, end: null },
          ],
        },
      ],
    );
    expect(s.states.map((p) => p.ts)).toEqual([1000, 20 * HOUR - 1000, 20 * HOUR + 1000]);
    expect(s.seams).toEqual([
      { at: 20 * HOUR, attempt: 1, session: 2, runId: "s1", newAttempt: false, startedAt: RESUME },
    ]);
    // The attempt's playtime, which is where the line ends: not the five days.
    expect(s.totalMs).toBe(20 * HOUR + 2000);
  });
});
