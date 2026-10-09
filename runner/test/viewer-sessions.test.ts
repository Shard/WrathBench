/**
 * A run's sessions (`runner/viewer/sessions.ts`).
 *
 * The case that motivated them is a freeplay run the operator paused and the
 * fleet resumed in place days later: one run id, one trajectory, a `pause`
 * and a `resume` with a multi-day gap between them. The marks below are that
 * run's own sequence (`fleet-codex-sol-61-freeplay-gpt-6-1-sol-20261001`), with
 * the duplicate `meta` records `run.ts` writes at a pause and at a resume.
 */

import { describe, expect, test } from "bun:test";
import type { StatePoint } from "../viewer/api-types";
import { activeMsUntil, playtimeMs, segmentsFrom, sessionClock } from "../viewer/sessions";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Played 20 hours, paused, resumed five days later, played one more hour, still going. */
const T0 = 1_790_992_856_357;
const PAUSE = T0 + 20 * HOUR;
const RESUME = PAUSE + 5 * DAY;
const MARKS = [
  { t: "meta", ts: T0 },
  { t: "pause", ts: PAUSE },
  { t: "meta", ts: PAUSE + 5 },
  { t: "resume", ts: RESUME },
  { t: "meta", ts: RESUME + 6 },
  { t: "meta", ts: RESUME + 6 },
];

function sample(ts: number, p: Partial<StatePoint> = {}): StatePoint {
  return {
    ts,
    level: null,
    xp: null,
    map: null,
    x: null,
    y: null,
    z: null,
    eventCount: null,
    lastSeq: null,
    turn: null,
    ...p,
  };
}

describe("a run resumed in place", () => {
  const sessions = segmentsFrom(MARKS);

  test("is two sessions: the pause closes one and the resume opens the next", () => {
    expect(sessions).toEqual([
      { start: T0, end: PAUSE },
      { start: RESUME, end: null },
    ]);
  });

  test("its playtime is the two sessions, never the five days between them", () => {
    expect(playtimeMs(sessions, { lastTs: null, live: true, now: RESUME + HOUR })).toBe(21 * HOUR);
    expect(activeMsUntil(sessions, RESUME + HOUR)).toBe(21 * HOUR);
  });

  test("its samples lie on the session clock, with the second session starting where the first stopped", () => {
    const clock = sessionClock(
      [sample(T0 + 5_000), sample(PAUSE - 60_000), sample(RESUME + 65_000), sample(RESUME + HOUR)],
      sessions,
    );
    expect(clock.points.map((p) => p.ts)).toEqual([5_000, 20 * HOUR - 60_000, 20 * HOUR + 65_000, 21 * HOUR]);
    expect(clock.starts).toEqual([0, 20 * HOUR]);
    expect(clock.startedAt).toEqual([T0, RESUME]);
  });

  test("a sample written inside the pause lands on the seam it precedes", () => {
    const clock = sessionClock([sample(PAUSE + DAY)], sessions);
    expect(clock.points[0]!.ts).toBe(20 * HOUR);
  });

  test("everything but the time is the sample as served", () => {
    const clock = sessionClock([sample(T0 + 1_000, { level: 13, xp: 4602, turn: 915 })], sessions);
    expect(clock.points[0]).toMatchObject({ ts: 1_000, level: 13, xp: 4602, turn: 915 });
  });
});

describe("the session clock", () => {
  test("a run of one session is its own active time from the first mark", () => {
    const clock = sessionClock([sample(1_500), sample(3_000)], segmentsFrom([{ t: "meta", ts: 1_000 }]));
    expect(clock.points.map((p) => p.ts)).toEqual([500, 2_000]);
    expect(clock.starts).toEqual([0]);
  });

  test("a run served without sessions is one session from its first sample", () => {
    for (const none of [undefined, []]) {
      const clock = sessionClock([sample(7_000), sample(4_000), sample(9_000)], none);
      expect(clock.points.map((p) => p.ts)).toEqual([3_000, 0, 5_000]);
      expect(clock.starts).toEqual([0]);
      expect(clock.startedAt).toEqual([4_000]);
    }
  });

  test("nothing sampled is an empty clock, not a throw", () => {
    expect(sessionClock([], undefined)).toEqual({ points: [], starts: [0], startedAt: [0] });
    expect(sessionClock([], segmentsFrom(MARKS)).points).toEqual([]);
  });
});
