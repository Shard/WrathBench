/**
 * Shared chart maths: the linear value→pixel map both hand-drawn charts use,
 * and the "nice" tick step the ladder scatter's axes are built from.
 */

import { describe, expect, test } from "bun:test";
import { niceTicks, scaleLinear } from "../src/lib/chart";

describe("scaleLinear", () => {
  test("maps the domain endpoints onto the range endpoints", () => {
    const s = scaleLinear([0, 100], [10, 210]);
    expect(s(0)).toBe(10);
    expect(s(100)).toBe(210);
    expect(s(50)).toBe(110);
  });

  test("a reversed range (top-to-bottom SVG y-axis) still lands endpoints correctly", () => {
    const s = scaleLinear([0, 10], [300, 20]);
    expect(s(0)).toBe(300);
    expect(s(10)).toBe(20);
    expect(s(5)).toBe(160);
  });

  test("a zero-width domain maps everything to the range start rather than dividing by zero", () => {
    const s = scaleLinear([5, 5], [0, 100]);
    expect(s(5)).toBe(0);
    expect(Number.isFinite(s(5))).toBe(true);
  });
});

describe("niceTicks", () => {
  test("1/2/5 steps from zero, the top tick at or past the max, and an axis even for all-free", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(6.5)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1.27)).toEqual([0, 0.5, 1, 1.5]);
    expect(niceTicks(2052)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    for (const m of [0.003, 0.9, 42, 99_999]) {
      const t = niceTicks(m);
      expect(t[0]).toBe(0);
      expect(t[t.length - 1]!).toBeGreaterThanOrEqual(m);
      expect(t.length).toBeLessThanOrEqual(7);
    }
  });
});
