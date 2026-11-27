/**
 * The focused time's one home (`src/lib/timelinestore.ts`): who moves it, what
 * following the live edge is, and that its methods subscribe no one.
 */

import { describe, expect, test } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";
import { createTimeline, type TimelineStore } from "../src/lib/timelinestore";
import type { Span } from "../src/lib/timeline";

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
});

describe("a page's own effects", () => {
  test("an effect that seeks is not re-run when the span moves: the store's methods subscribe no one", () => {
    let runs = 0;
    const { tl, setSpan, setRoute, dispose } = createRoot((dispose) => {
      const [span, setSpan] = createSignal<Span | null>(null);
      const [route, setRoute] = createSignal("a");
      const tl = createTimeline({ span, external: true });
      // The map's route swap: it reads the route, and zeroes the replay through the store.
      createEffect(() => {
        route();
        runs++;
        tl.seek(0, "clock");
        tl.setPlaying(false);
        tl.fit();
      });
      return { tl, setSpan, setRoute, dispose };
    });
    expect(runs).toBe(1);
    // The track lands and the span with it: not the route's business.
    setSpan({ from: 1_000, to: 2_000 });
    tl.seek(1_500, "url");
    tl.toggle();
    tl.cycleSpeed();
    tl.zoom(1_500, 0.5);
    expect(runs).toBe(1);
    expect(tl.at()).toBe(1_500);
    setRoute("b");
    expect(runs).toBe(2);
    expect(tl.at()).toBe(1_000);
    dispose();
  });
});
