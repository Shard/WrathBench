/**
 * The run view's two pure pieces: the cumulative-XP/level-band derivation and
 * the "is the feed pinned to the bottom" decision that drives autoscroll.
 *
 * The derivation is the load-bearing one — it reconstructs a total XP the
 * served data does not carry (see `lib/runview.ts`), so what it is allowed to
 * claim is pinned here: level and xp are read off the *same* sample, the curve
 * never dips, and the bands sit at the offsets the curve is built on.
 */

import { describe, expect, test } from "bun:test";
import type { StatePoint } from "../../runner/viewer/api-types";
import { atBottom, xpChartModel } from "../src/lib/runview";

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
  });

  test("a noisy dip within a level does not lower the cumulative curve", () => {
    const m = xpChartModel([s(0, 1, 100), s(1, 1, 90)], opts);
    expect(m.points.map((p) => p.cum)).toEqual([100, 100]);
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

  test("unordered samples are sorted before accumulating", () => {
    const m = xpChartModel([s(2, 2, 50), s(0, 1, 100), s(1, 1, 200)], opts);
    expect(m.points.map((p) => p.cum)).toEqual([100, 200, 250]);
  });

  test("a level jump between samples opens one band, at the level reached", () => {
    const m = xpChartModel([s(0, 1, 300), s(1, 3, 10)], opts);
    expect(m.bands).toEqual([
      { level: 1, cum: 0, ts: 0 },
      { level: 3, cum: 300, ts: 1 },
    ]);
  });

  describe("x-axis window", () => {
    const states = [s(0, 1, 100), s(4, 1, 200)];
    test("episodeMs sets the deadline, capped at now for a live run", () => {
      const m = xpChartModel(states, { startedAt: 0, endedAt: null, episodeMs: 10_000, now: 5_000 });
      expect(m.t0).toBe(0);
      expect(m.t1).toBe(5_000); // not the full 10_000: the future is not drawn
    });
    test("a finished run closes at endedAt when it beats the deadline", () => {
      const m = xpChartModel(states, { startedAt: 0, endedAt: 3_000, episodeMs: 10_000, now: 9_999 });
      expect(m.t1).toBe(3_000);
    });
    test("no episodeMs closes at the last sample", () => {
      const m = xpChartModel(states, { startedAt: 0, endedAt: null, episodeMs: null, now: 1_000_000 });
      expect(m.t1).toBe(4);
    });
  });

  test("fewer than two usable samples yields an empty, drawable model", () => {
    const m = xpChartModel([s(0, 1, 100)], opts);
    expect(m.points.length).toBe(1);
    expect(m.t1).toBeGreaterThan(m.t0);
    expect(m.yMax).toBeGreaterThanOrEqual(1);
  });
});

describe("atBottom", () => {
  test("exactly at the bottom follows", () => {
    expect(atBottom(800, 1000, 200)).toBe(true);
  });
  test("just within the threshold still follows", () => {
    expect(atBottom(780, 1000, 200, 32)).toBe(true);
  });
  test("scrolled up past the threshold stops following", () => {
    expect(atBottom(700, 1000, 200, 32)).toBe(false);
  });
  test("a non-overflowing container is always at the bottom", () => {
    expect(atBottom(0, 200, 200)).toBe(true);
  });
});
