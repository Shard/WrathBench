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
import { characterSessionSeries, sessionCount } from "../src/lib/character";

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
    expect(s.seams).toEqual([attemptSeam(200, 2, 2, "a2"), attemptSeam(200, 3, 3, "a3")]);
    expect(s.totalMs).toBe(250);
  });

  test("nothing recorded is an empty axis, not a throw", () => {
    expect(characterSessionSeries([])).toEqual({ states: [], seams: [], totalMs: 0 });
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

  test("a chain still seams at each new attempt, and a resume inside one is a seam of its own", () => {
    const s = characterSessionSeries(
      [
        pt("a1", 1, 100, 1, 0),
        pt("a1", 1, 900, 2, 0),
        pt("a2", 2, DAY + 100, 2, 10),
        pt("a2", 2, 3 * DAY + 100, 3, 0),
      ],
      [
        { runId: "a1", playtimeMs: 1000, sessions: [{ start: 0, end: 1000 }] },
        {
          runId: "a2",
          playtimeMs: 600,
          sessions: [
            { start: DAY, end: DAY + 300 },
            { start: 3 * DAY, end: 3 * DAY + 300 },
          ],
        },
      ],
    );
    // a1 spans its playtime (1000), then a2's sessions follow it with the two-day pause closed.
    expect(s.states.map((p) => p.ts)).toEqual([100, 900, 1100, 1400]);
    expect(s.seams).toEqual([
      { at: 1000, attempt: 2, session: 2, runId: "a2", newAttempt: true, startedAt: DAY },
      { at: 1300, attempt: 2, session: 3, runId: "a2", newAttempt: false, startedAt: 3 * DAY },
    ]);
    expect(s.totalMs).toBe(1600);
  });

  test("an attempt the server sent no sessions for keeps its sample span beside one that has them", () => {
    const s = characterSessionSeries(
      [pt("a1", 1, 5000, 1, 0), pt("a1", 1, 5400, 1, 5), pt("a2", 2, DAY + 50, 2, 0)],
      [{ runId: "a2", playtimeMs: 100, sessions: [{ start: DAY, end: DAY + 100 }] }],
    );
    expect(s.states.map((p) => p.ts)).toEqual([0, 400, 450]);
    expect(s.totalMs).toBe(500);
  });
});

describe("sessionCount", () => {
  test("counts every session, and an attempt with none served as the one it was drawn as", () => {
    expect(sessionCount([])).toBe(0);
    expect(sessionCount([{}, { sessions: [] }])).toBe(2);
    expect(sessionCount([{ sessions: [{ start: 0, end: 1 }, { start: 5, end: null }] }, {}])).toBe(3);
  });
});
