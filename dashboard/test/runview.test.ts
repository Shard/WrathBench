/**
 * The run view's cumulative-XP/level-band derivation, and the run chart's
 * clock across a resume.
 *
 * The derivation is the load-bearing one — it reconstructs a total XP the
 * served data does not carry (see `lib/runview.ts`), so what it is allowed to
 * claim is pinned here: level and xp are read off the *same* sample, the curve
 * never dips, and the bands sit at the offsets the curve is built on.
 */

import { describe, expect, test } from "bun:test";
import type { StatePoint } from "../../viewer/api-types";
import { runChartInput, xpChartModel } from "../src/lib/runview";

function s(ts: number, level: number | null, xp: number | null): StatePoint {
  return { ts, level, xp, map: null, x: null, y: null, z: null, eventCount: null, lastSeq: null, turn: null };
}

const opts = { startedAt: 0, endedAt: null, episodeMs: null, now: 1_000_000 };

describe("xpChartModel", () => {
  test("bands sit at the cumulative offset each level began, curve stays monotonic", () => {
    const states = [
      s(0, 1, 100),
      s(1, 1, 200),
      s(2, 2, 50), // dinged: 200 carried in
      s(3, 2, 150),
      s(4, 3, 0), // dinged again: +150 → 350 carried in
    ];
    const m = xpChartModel(states, opts);
    expect(m.bands).toEqual([
      { level: 1, cum: 0, ts: 0 },
      { level: 2, cum: 200, ts: 2 },
      { level: 3, cum: 350, ts: 4 },
    ]);
    expect(m.points.map((p) => p.cum)).toEqual([100, 200, 250, 350, 350]);
    expect(m.yMax).toBe(350);
    // A noisy dip within a level does not lower the curve.
    expect(xpChartModel([s(0, 1, 100), s(1, 1, 90)], opts).points.map((p) => p.cum)).toEqual([100, 100]);
  });

  test("level and xp are read off the same sample; a half-recorded sample is skipped", () => {
    // The middle sample has no xp: it must not pair level 2 with the next xp.
    const m = xpChartModel([s(0, 1, 100), s(1, 2, null), s(2, 2, 40)], opts);
    expect(m.bands).toEqual([
      { level: 1, cum: 0, ts: 0 },
      { level: 2, cum: 100, ts: 2 },
    ]);
    expect(m.points.map((p) => p.cum)).toEqual([100, 140]);
  });

  test("the x-axis closes at the deadline capped at now, at endedAt when that beats it, else at the last sample", () => {
    const states = [s(0, 1, 100), s(4, 1, 200)];
    // Live: the future is not drawn.
    expect(xpChartModel(states, { startedAt: 0, endedAt: null, episodeMs: 10_000, now: 5_000 }).t1).toBe(5_000);
    expect(xpChartModel(states, { startedAt: 0, endedAt: 3_000, episodeMs: 10_000, now: 9_999 }).t1).toBe(3_000);
    expect(xpChartModel(states, { startedAt: 0, endedAt: null, episodeMs: null, now: 1_000_000 }).t1).toBe(4);
  });
});

describe("runChartInput", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const T0 = 1_000_000;
  const PAUSE = T0 + 20 * HOUR;
  const RESUME = PAUSE + 5 * DAY;
  const sessions = [
    { start: T0, end: PAUSE },
    { start: RESUME, end: null },
  ];
  const states = [s(T0 + 1000, 1, 0), s(PAUSE - 1000, 13, 4602), s(RESUME + 1000, 13, 4602)];

  test("a run resumed in place is drawn on active time with a seam at the resume", () => {
    const now = RESUME + HOUR;
    const c = runChartInput(states, { startedAt: T0, endedAt: null, live: true }, sessions, null, now);
    expect(c.states.map((p) => p.ts)).toEqual([1000, 20 * HOUR - 1000, 20 * HOUR + 1000]);
    expect(c.startedAt).toBe(0);
    expect(c.endedAt).toBeNull();
    // Live: the window runs to the session clock's now, 21 hours, not six days.
    expect(c.now).toBe(21 * HOUR);
    expect(c.seams.map((x) => x.at)).toEqual([20 * HOUR]);
    const m = xpChartModel(c.states, { startedAt: c.startedAt, endedAt: c.endedAt, episodeMs: null, now: c.now });
    expect(m.t1 - m.t0).toBe(20 * HOUR + 1000);
  });

  test("a run of one session reads as it always did, ninety minutes for an e90", () => {
    const one = [{ start: 0, end: 90 * 60_000 }];
    const c = runChartInput([s(60_000, 1, 0), s(80 * 60_000, 5, 10)], { startedAt: 0, endedAt: 90 * 60_000, live: false }, one, 90 * 60_000, 10 * DAY);
    expect(c.seams).toEqual([]);
    const m = xpChartModel(c.states, { startedAt: c.startedAt, endedAt: c.endedAt, episodeMs: 90 * 60_000, now: c.now });
    expect([m.t0, m.t1]).toEqual([0, 90 * 60_000]);
  });
});
