/**
 * The focused time's one home (`src/lib/timelinestore.ts`): who moves it, what
 * following the live edge is, and the zoomed view going where the focus goes.
 */

import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createTimeline, type TimelineStore } from "../src/lib/timelinestore";
import type { Span } from "../src/lib/timeline";

const DAY = 24 * 3_600_000;

function make(span: Span | null, live = false): { tl: TimelineStore; setSpan: (s: Span | null) => void; setLive: (l: boolean) => void; dispose: () => void } {
  return createRoot((dispose) => {
    const [s, setSpan] = createSignal<Span | null>(span);
    const [l, setLive] = createSignal(live);
    // External: no test here waits on the playback tick.
    return { tl: createTimeline({ span: s, live: l, external: true }), setSpan: (v) => void setSpan(v), setLive: (v) => void setLive(v), dispose };
  });
}

describe("the focused time", () => {
  test("starts at the newest moment and follows it; a seek pins a time and says who made it", () => {
    const { tl, setSpan, dispose } = make({ from: 1_000_000, to: 2_000_000 }, true);
    expect(tl.focus()).toBeNull();
    expect(tl.following()).toBe(true);
    expect(tl.at()).toBe(2_000_000);
    // The live edge advances under a reader who follows it.
    setSpan({ from: 1_000_000, to: 2_060_000 });
    expect(tl.at()).toBe(2_060_000);

    tl.seek(1_500_000, "timeline");
    expect(tl.following()).toBe(false);
    expect(tl.at()).toBe(1_500_000);
    expect(tl.origin()).toBe("timeline");
    // Pinned: the edge moving on does not move the focus.
    setSpan({ from: 1_000_000, to: 2_120_000 });
    expect(tl.at()).toBe(1_500_000);

    tl.seek(1_600_000, "feed");
    expect(tl.origin()).toBe("feed");
    expect(tl.at()).toBe(1_600_000);
    dispose();
  });

  test("a seek to a live run's newest moment, or the live button, is following again", () => {
    const { tl, dispose } = make({ from: 1_000_000, to: 2_000_000 }, true);
    tl.seek(1_500_000, "timeline");
    tl.seek(2_000_000, "timeline");
    expect(tl.following()).toBe(true);
    tl.seek(1_500_000, "feed");
    tl.setPlaying(true);
    tl.goLive();
    expect(tl.following()).toBe(true);
    expect(tl.playing()).toBe(false);
    expect(tl.origin()).toBe("timeline");
    dispose();
  });

  test("an ended run has an end, not an edge: nothing is followed, and its end is a time", () => {
    const { tl, dispose } = make({ from: 1_000_000, to: 2_000_000 });
    expect(tl.following()).toBe(false);
    expect(tl.at()).toBe(2_000_000);
    tl.seek(2_000_000, "timeline");
    expect(tl.focus()).toBe(2_000_000);
    dispose();
  });

  test("a link's time set before the page knows the run is held to the run once it does", () => {
    const { tl, setSpan, dispose } = make(null);
    tl.seek(1_500_000, "url");
    expect(tl.at()).toBe(1_500_000);
    setSpan({ from: 1_000_000, to: 1_400_000 });
    expect(tl.at()).toBe(1_400_000);
    setSpan({ from: 1_000_000, to: 2_000_000 });
    expect(tl.at()).toBe(1_500_000);
    dispose();
  });

  test("play from the end starts over; with nothing to play it does nothing", () => {
    const { tl, setSpan, dispose } = make({ from: 1_000_000, to: 2_000_000 });
    tl.toggle();
    expect(tl.playing()).toBe(true);
    expect(tl.at()).toBe(1_000_000);
    tl.toggle();
    expect(tl.playing()).toBe(false);
    setSpan({ from: 5, to: 5 });
    tl.toggle();
    expect(tl.playing()).toBe(false);
    setSpan(null);
    tl.toggle();
    expect(tl.playing()).toBe(false);
    dispose();
  });

  test("the speed cycles through the map's speeds", () => {
    const { tl, dispose } = make({ from: 0, to: 10 });
    expect(tl.speed()).toBe(60);
    tl.cycleSpeed();
    expect(tl.speed()).toBe(600);
    dispose();
  });
});

describe("the zoomed view", () => {
  test("is only for a run of more than a day, and fit undoes it", () => {
    const short = make({ from: 0, to: DAY / 2 });
    short.tl.zoom(1000, 0.5);
    expect(short.tl.zoomable()).toBe(false);
    expect(short.tl.view()).toBeNull();
    expect(short.tl.shown()).toEqual({ from: 0, to: DAY / 2 });
    short.dispose();

    const { tl, dispose } = make({ from: 0, to: 4 * DAY });
    expect(tl.zoomable()).toBe(true);
    tl.zoom(DAY, 0.25);
    expect(tl.view()).toEqual({ from: 0.75 * DAY, to: 1.75 * DAY });
    expect(tl.shown()).toEqual(tl.view());
    tl.pan(DAY);
    expect(tl.view()).toEqual({ from: 1.75 * DAY, to: 2.75 * DAY });
    tl.centre(0);
    expect(tl.view()).toEqual({ from: 0, to: DAY });
    tl.fit();
    expect(tl.view()).toBeNull();
    dispose();
  });

  test("goes with a focus that leaves it, and stays with the live edge of a run being followed", () => {
    const { tl, setSpan, dispose } = make({ from: 0, to: 4 * DAY }, true);
    tl.seek(DAY, "timeline");
    tl.zoom(DAY, 0.25);
    const view = tl.view();
    tl.seek(1.2 * DAY, "feed");
    expect(tl.view()).toBe(view);
    tl.seek(3 * DAY, "clock");
    expect(tl.view()).toEqual({ from: 2.1 * DAY, to: 3.1 * DAY });
    tl.goLive();
    expect(tl.view()!.to).toBe(4 * DAY);
    setSpan({ from: 0, to: 4 * DAY + 3_600_000 });
    expect(tl.view()!.to).toBeGreaterThan(4 * DAY);
    expect(tl.view()!.from).toBeLessThanOrEqual(tl.at());
    dispose();
  });

  test("a run that is no longer zoomable drops its view", () => {
    const { tl, setSpan, dispose } = make({ from: 0, to: 4 * DAY });
    tl.zoom(DAY, 0.25);
    expect(tl.view()).not.toBeNull();
    setSpan({ from: 0, to: DAY / 2 });
    expect(tl.view()).toBeNull();
    dispose();
  });
});
