/**
 * The timeline's rules (`src/lib/timeline.ts`): where a seek lands, the `?t=`
 * round trip, the zoom's arithmetic, the axis, and how the feed and the bar
 * keep from chasing each other.
 */

import { describe, expect, test } from "bun:test";
import {
  LIVE_SNAP_MS,
  MIN_VIEW_MS,
  ZOOM_SPAN_MS,
  axisTicks,
  centreOn,
  createScrollGuard,
  createUrlSync,
  feedPlan,
  fmtRunClock,
  fmtTick,
  focusTime,
  formatT,
  fractionOf,
  panBy,
  parseT,
  reveal,
  rowAt,
  rowInView,
  seekTarget,
  timeAt,
  viewOf,
  withT,
  zoomAt,
  zoomable,
  type FeedWindow,
  type Span,
} from "../src/lib/timeline";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("where a seek lands", () => {
  const span: Span = { from: 1_000_000, to: 2_000_000 };

  test("inside the span, clamped to its ends", () => {
    expect(seekTarget(span, 1_500_000, false)).toBe(1_500_000);
    expect(seekTarget(span, 0, false)).toBe(1_000_000);
    expect(seekTarget(span, 9_000_000, false)).toBe(2_000_000);
    expect(seekTarget(span, Number.NaN, false)).toBeNull();
  });

  test("on a live run the newest moment is the live edge itself, not a time that goes stale", () => {
    expect(seekTarget(span, 2_000_000, true)).toBeNull();
    expect(seekTarget(span, 2_000_000 - LIVE_SNAP_MS, true)).toBeNull();
    expect(seekTarget(span, 2_000_000 - LIVE_SNAP_MS - 1, true)).toBe(2_000_000 - LIVE_SNAP_MS - 1);
    // An ended run's end is a time like any other.
    expect(seekTarget(span, 2_000_000, false)).toBe(2_000_000);
  });

  test("a focus stands for its own time, or for the span's end while following", () => {
    expect(focusTime(span, null)).toBe(2_000_000);
    expect(focusTime({ from: 1_000_000, to: 2_500_000 }, null)).toBe(2_500_000);
    expect(focusTime(span, 1_200_000)).toBe(1_200_000);
    // A link's time from before the page knew the span is held to it once it does.
    expect(focusTime(span, 5)).toBe(1_000_000);
    expect(focusTime(null, 7)).toBe(7);
    expect(focusTime(null, null)).toBe(0);
  });
});

describe("?t=", () => {
  test("is whole epoch seconds, and round-trips to the second", () => {
    expect(formatT(1_763_290_294_499)).toBe("1763290294");
    expect(parseT("1763290294")).toBe(1_763_290_294_000);
    expect(parseT(formatT(1_763_290_294_000))).toBe(1_763_290_294_000);
  });

  test("anything that is not a time is none", () => {
    for (const raw of [undefined, null, "", "abc", "-5", "12.5", "1e9", "1763290294000000", ["1"], 5]) expect(parseT(raw)).toBeNull();
  });

  test("a link carries the focus, and nothing while following", () => {
    expect(withT("/map?run=r1", 1_763_290_294_000)).toBe("/map?run=r1&t=1763290294");
    expect(withT("/run/r1", 1_763_290_294_000)).toBe("/run/r1?t=1763290294");
    expect(withT("/run/r1", null)).toBe("/run/r1");
  });

  test("the page's own write coming back is not a seek; back, forward and a pasted link are", () => {
    const sync = createUrlSync(undefined);
    // Nothing to write while following and the URL has no t.
    expect(sync.toUrl(null)).toBeUndefined();
    expect(sync.toUrl(1_000_000)).toBe("1000");
    // The router hands the same value back: the page's own echo.
    expect(sync.fromUrl("1000")).toBeUndefined();
    // The same second written twice is one write.
    expect(sync.toUrl(1_000_400)).toBeUndefined();
    // Back to an entry with another time, then to one with none.
    expect(sync.fromUrl("940")).toBe(940_000);
    expect(sync.fromUrl(undefined)).toBe("none");
    expect(sync.fromUrl(undefined)).toBeUndefined();
    // Following again removes the parameter, once.
    expect(sync.toUrl(2_000_000)).toBe("2000");
    expect(sync.toUrl(null)).toBeNull();
    expect(sync.toUrl(null)).toBeUndefined();
  });

  test("a page opened on a link does not write that link back", () => {
    const sync = createUrlSync("1000");
    expect(sync.fromUrl("1000")).toBeUndefined();
    expect(sync.toUrl(1_000_000)).toBeUndefined();
    expect(sync.fromUrl("garbage")).toBe("none");
  });
});

describe("zoom", () => {
  const span: Span = { from: 0, to: 4 * DAY };

  test("is offered past a day of run time, and not under it", () => {
    expect(zoomable({ from: 0, to: ZOOM_SPAN_MS })).toBe(false);
    expect(zoomable({ from: 0, to: ZOOM_SPAN_MS + 1 })).toBe(true);
    expect(zoomable(null)).toBe(false);
  });

  test("keeps the time under the pointer where it is", () => {
    const anchor = DAY;
    const view = zoomAt(span, null, anchor, 0.5)!;
    expect(view.to - view.from).toBe(2 * DAY);
    expect(fractionOf(view, anchor)).toBeCloseTo(fractionOf(span, anchor), 9);
    const closer = zoomAt(span, view, anchor, 0.5)!;
    expect(closer.to - closer.from).toBe(DAY);
    expect(fractionOf(closer, anchor)).toBeCloseTo(0.25, 9);
  });

  test("stops at ten minutes, stays inside the run, and zooming all the way out is no view at all", () => {
    let view: Span | null = null;
    for (let i = 0; i < 80; i++) view = zoomAt(span, view, 3 * DAY, 0.5);
    expect(view!.to - view!.from).toBe(MIN_VIEW_MS);
    expect(view!.from).toBeGreaterThanOrEqual(span.from);
    expect(view!.to).toBeLessThanOrEqual(span.to);
    // At the right edge the view is pushed back in rather than past the end.
    const edge = zoomAt(span, null, span.to, 0.25)!;
    expect(edge.to).toBe(span.to);
    expect(zoomAt(span, edge, 2 * DAY, 100)).toBeNull();
  });

  test("pans, centres and follows a focus that leaves, each clamped to the run", () => {
    const view = { from: DAY, to: 2 * DAY };
    expect(panBy(span, view, HOUR)).toEqual({ from: DAY + HOUR, to: 2 * DAY + HOUR });
    expect(panBy(span, view, -9 * DAY)).toEqual({ from: 0, to: DAY });
    expect(panBy(span, null, HOUR)).toBeNull();
    expect(centreOn(span, view, 3 * DAY)).toEqual({ from: 2.5 * DAY, to: 3.5 * DAY });
    expect(centreOn(span, view, 9 * DAY)).toEqual({ from: 3 * DAY, to: 4 * DAY });
    // In view: the same object, so nothing redraws.
    expect(reveal(span, view, 1.5 * DAY)).toBe(view);
    // Off the right: back a tenth in from that edge. Off the left: a tenth in from the left.
    expect(reveal(span, view, 3 * DAY)).toEqual({ from: 3 * DAY - 0.9 * DAY, to: 3 * DAY + 0.1 * DAY });
    expect(reveal(span, view, 0.5 * DAY)).toEqual({ from: 0.4 * DAY, to: 0.4 * DAY + DAY });
    expect(reveal(span, null, 3 * DAY)).toBeNull();
  });

  test("a view is read inside the span it was made for, however the span has moved", () => {
    expect(viewOf(span, null)).toBe(span);
    expect(viewOf({ from: 0, to: DAY }, { from: 2 * DAY, to: 3 * DAY })).toEqual({ from: 0, to: DAY });
    expect(timeAt({ from: 100, to: 200 }, 0.25)).toBe(125);
    expect(timeAt({ from: 100, to: 200 }, 7)).toBe(200);
    expect(fractionOf({ from: 100, to: 100 }, 100)).toBe(0);
  });
});

describe("the axis", () => {
  test("the run's clock reads short for a short run and in days for a long one", () => {
    expect(fmtRunClock(247_000)).toBe("4:07");
    expect(fmtRunClock(3 * HOUR + 247_000)).toBe("3:04:07");
    expect(fmtRunClock(2 * DAY + 3 * HOUR + 247_000)).toBe("2d 03:04");
    expect(fmtRunClock(-5)).toBe("0:00");
  });

  test("a tick says its time in the largest units that do", () => {
    expect([0, 45 * 60_000, 6 * HOUR, 90 * 60_000, DAY, DAY + 12 * HOUR].map(fmtTick)).toEqual(["0", "45m", "6h", "1h 30m", "1d", "1d 12h"]);
  });

  test("ticks are round steps from the run's start, spaced for the width, with none cut off at the right", () => {
    const span: Span = { from: 1_000, to: 1_000 + 150 * 60_000 };
    const ticks = axisTicks(span, span, 1150);
    expect(ticks.map((t) => t.label)).toEqual(["0", "15m", "30m", "45m", "1h", "1h 15m", "1h 30m", "1h 45m", "2h", "2h 15m"]);
    expect(ticks[1]!.ts).toBe(1_000 + 15 * 60_000);
    // A phone's width: fewer, further apart.
    expect(axisTicks(span, span, 350).map((t) => t.label)).toEqual(["0", "1h", "2h"]);
    // Zoomed into a nine-day run: still counted from the run's start.
    const long: Span = { from: 0, to: 9 * DAY };
    expect(axisTicks(long, { from: 2 * DAY, to: 2 * DAY + 6 * HOUR }, 1000).map((t) => t.label)).toEqual(["2d", "2d 1h", "2d 2h", "2d 3h", "2d 4h", "2d 5h"]);
    expect(axisTicks(long, long, 1000).map((t) => t.label)).toEqual(["0", "1d", "2d", "3d", "4d", "5d", "6d", "7d", "8d"]);
    expect(axisTicks(span, span, 0)).toEqual([]);
  });
});

describe("the feed and the bar", () => {
  test("a time is shown by the last row at or before it", () => {
    const rows = [100, 200, 200, 350];
    expect(rowAt(rows, 250)).toBe(2);
    expect(rowAt(rows, 200)).toBe(2);
    expect(rowAt(rows, 999)).toBe(3);
    // Before the first row there is only the first row to show.
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
    // Nothing held yet.
    expect(feedPlan({ from: 0, end: 0, total: 10, oldestTs: null, newestTs: null }, 6_000)).toBe("load");
    expect(feedPlan({ from: 0, end: 0, total: 0, oldestTs: null, newestTs: null }, 6_000)).toBe("scroll");
  });

  test("a scroll the page made is not the reader's, for a moment after it was made", () => {
    let now = 1_000;
    const guard = createScrollGuard(() => now, 200);
    expect(guard.own()).toBe(false);
    guard.mark();
    now += 16;
    expect(guard.own()).toBe(true);
    now += 199;
    // The hold has passed: this scroll is the reader's, and moves the focus.
    expect(guard.own()).toBe(false);
  });

  test("the row a scrolled feed shows is the first not wholly above the pane", () => {
    const bottoms = [40, 90, 200, 260];
    expect(rowInView(bottoms, 0)).toBe(0);
    expect(rowInView(bottoms, 40)).toBe(1);
    expect(rowInView(bottoms, 100)).toBe(2);
    expect(rowInView(bottoms, 9_999)).toBe(3);
    expect(rowInView([], 0)).toBe(-1);
  });
});
