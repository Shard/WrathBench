/**
 * The map's own timers (the 1 s pump, a replay's tail poll) do no work while
 * the tab is hidden, and catch up once on coming back if a tick fell due, as
 * the polled feeds do. The timer and the document are injected, so the rule is
 * asserted tick by tick rather than by waiting on a clock.
 */

import { describe, expect, test } from "bun:test";
import { type Visibility, visibleInterval } from "../src/lib/visibleinterval";

function fakes(): {
  visibility: Visibility & { set(hidden: boolean): void; listeners: number };
  every: (fn: () => void, ms: number) => () => void;
  tick(): void;
  running: () => boolean;
} {
  const listeners = new Set<() => void>();
  let hidden = false;
  let timer: (() => void) | null = null;
  return {
    visibility: {
      get hidden() {
        return hidden;
      },
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
      set(h: boolean) {
        hidden = h;
        for (const fn of [...listeners]) fn();
      },
      get listeners() {
        return listeners.size;
      },
    },
    every: (fn) => {
      timer = fn;
      return () => {
        timer = null;
      };
    },
    tick: () => timer?.(),
    running: () => timer !== null,
  };
}

describe("visibleInterval", () => {
  test("ticks while the tab is visible", () => {
    const f = fakes();
    let runs = 0;
    visibleInterval(() => runs++, 1000, { visibility: f.visibility, every: f.every });
    f.tick();
    f.tick();
    expect(runs).toBe(2);
  });

  test("does no work while hidden, and catches up once on coming back", () => {
    const f = fakes();
    let runs = 0;
    visibleInterval(() => runs++, 1000, { visibility: f.visibility, every: f.every });
    f.visibility.set(true);
    f.tick();
    f.tick();
    f.tick();
    expect(runs).toBe(0);
    f.visibility.set(false);
    expect(runs).toBe(1);
    // One catch-up, not one per missed tick; then the schedule as before.
    f.visibility.set(true);
    f.visibility.set(false);
    expect(runs).toBe(1);
    f.tick();
    expect(runs).toBe(2);
  });

  test("coming back before any tick fell due does not tick early", () => {
    const f = fakes();
    let runs = 0;
    visibleInterval(() => runs++, 1000, { visibility: f.visibility, every: f.every });
    f.visibility.set(true);
    f.visibility.set(false);
    expect(runs).toBe(0);
  });

  test("a stop ends the timer and the watch, even from inside a tick", () => {
    const f = fakes();
    let runs = 0;
    const stop = visibleInterval(
      () => {
        runs++;
        stop();
      },
      1000,
      { visibility: f.visibility, every: f.every },
    );
    f.tick();
    expect(runs).toBe(1);
    expect(f.running()).toBe(false);
    expect(f.visibility.listeners).toBe(0);
    f.visibility.set(true);
    f.visibility.set(false);
    expect(runs).toBe(1);
  });

  test("with no document at all it is a plain interval", () => {
    const f = fakes();
    let runs = 0;
    visibleInterval(() => runs++, 1000, { visibility: null, every: f.every });
    f.tick();
    expect(runs).toBe(1);
  });
});

describe("the map page", () => {
  test("keeps no timer of its own that runs while the tab is hidden", async () => {
    const src = await Bun.file(new URL("../src/pages/MapPage.tsx", import.meta.url)).text();
    expect(src).not.toMatch(/\bsetInterval\(/);
    // The pump and a replay's tail poll both go through the one helper.
    expect(src.match(/visibleInterval\(/g)?.length).toBe(2);
  });
});
