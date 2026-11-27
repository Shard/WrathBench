/**
 * The timeline's rules (`src/lib/timeline.ts`): where a seek lands, the `?t=`
 * round trip, the zoom's bounds, and which row of the feed a time is.
 */

import { describe, expect, test } from "bun:test";
import { LIVE_SNAP_MS, MIN_VIEW_MS, feedPlan, focusTime, formatT, fractionOf, parseT, rowAt, seekTarget, withT, zoomAt, type FeedWindow, type Span } from "../src/lib/timeline";

const DAY = 24 * 3_600_000;

describe("where a seek lands", () => {
  const span: Span = { from: 1_000_000, to: 2_000_000 };

  test("inside the span, clamped to its ends; on a live run the newest moment is the live edge itself", () => {
    expect(seekTarget(span, 1_500_000, false)).toBe(1_500_000);
    expect(seekTarget(span, 0, false)).toBe(1_000_000);
    expect(seekTarget(span, 9_000_000, false)).toBe(2_000_000);
    expect(seekTarget(span, Number.NaN, false)).toBeNull();
    expect(seekTarget(span, 2_000_000 - LIVE_SNAP_MS, true)).toBeNull();
    expect(seekTarget(span, 2_000_000 - LIVE_SNAP_MS - 1, true)).toBe(2_000_000 - LIVE_SNAP_MS - 1);
  });

  test("a focus stands for its own time, or for the span's end while following", () => {
    expect(focusTime(span, null)).toBe(2_000_000);
    expect(focusTime(span, 1_200_000)).toBe(1_200_000);
    // A link's time from before the page knew the span is held to it once it does.
    expect(focusTime(span, 5)).toBe(1_000_000);
    expect(focusTime(null, 7)).toBe(7);
  });
});

describe("?t=", () => {
  test("is whole epoch seconds, round-trips to the second, and a link carries it only when not following", () => {
    expect(formatT(1_763_290_294_499)).toBe("1763290294");
    expect(parseT(formatT(1_763_290_294_000))).toBe(1_763_290_294_000);
    for (const raw of [undefined, null, "", "abc", "-5", "12.5", "1e9", "1763290294000000", ["1"], 5]) expect(parseT(raw)).toBeNull();
    expect(withT("/map?run=r1", 1_763_290_294_000)).toBe("/map?run=r1&t=1763290294");
    expect(withT("/run/r1", null)).toBe("/run/r1");
  });
});

describe("zoom", () => {
  test("keeps the time under the pointer where it is, stops at ten minutes, and stays inside the run", () => {
    const span: Span = { from: 0, to: 4 * DAY };
    const view = zoomAt(span, null, DAY, 0.5)!;
    expect(view.to - view.from).toBe(2 * DAY);
    expect(fractionOf(view, DAY)).toBeCloseTo(fractionOf(span, DAY), 9);
    let deep: Span | null = null;
    for (let i = 0; i < 80; i++) deep = zoomAt(span, deep, 3 * DAY, 0.5);
    expect(deep!.to - deep!.from).toBe(MIN_VIEW_MS);
    expect(zoomAt(span, null, span.to, 0.25)!.to).toBe(span.to);
    expect(zoomAt(span, view, 2 * DAY, 100)).toBeNull();
  });
});

describe("the feed and the bar", () => {
  test("a time is shown by the last row at or before it", () => {
    const rows = [100, 200, 200, 350];
    expect(rowAt(rows, 250)).toBe(2);
    expect(rowAt(rows, 200)).toBe(2);
    expect(rowAt(rows, 999)).toBe(3);
    expect(rowAt(rows, 5)).toBe(0);
    expect(rowAt([], 5)).toBe(-1);
  });

  test("a time inside the window is a scroll; one past an end the run has more of is another window", () => {
    const w: FeedWindow = { from: 400, end: 600, total: 1000, oldestTs: 5_000, newestTs: 7_000 };
    expect(feedPlan(w, 6_000)).toBe("scroll");
    expect(feedPlan(w, 4_000)).toBe("load");
    expect(feedPlan(w, 8_000)).toBe("load");
    // The run's first window has nothing earlier to load, and its tail nothing later.
    expect(feedPlan({ ...w, from: 0 }, 4_000)).toBe("scroll");
    expect(feedPlan({ ...w, end: 1000 }, 8_000)).toBe("scroll");
    expect(feedPlan({ from: 0, end: 0, total: 10, oldestTs: null, newestTs: null }, 6_000)).toBe("load");
  });
});
