/**
 * The poller's stall verdict, on its pure seam.
 *
 * `latest` and `error` leave one hole between them: a fetch that never settles
 * produces neither, so a page reading only those two would show its last good
 * value forever with nothing marked wrong. `isStalled` is what closes it, and
 * what is worth pinning is the bound — a generous multiple of the interval on
 * the real clock, so a slow round trip is not a verdict — and that any
 * settlement, failure included, resets it (a failure has `error` to carry it).
 *
 * And the change guard: a tick that brings the same body must not move
 * `latest`, so the memos a page builds over it — the ladder's layout, the runs
 * table's sort — are not recomputed for nothing. Asserted on the graph itself,
 * against Solid's reactive build (`test/preload-solid.ts`).
 *
 * And the schedule: nothing fetched while the tab is hidden, and one poll on
 * return when a tick fell due.
 */

import { describe, expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import { STALL_INTERVALS, isStalled, poll } from "../src/lib/poll";

describe("isStalled", () => {
  const INTERVAL = 5_000;
  const BOUND = INTERVAL * STALL_INTERVALS;

  test("the bound is STALL_INTERVALS intervals, and scales with the interval", () => {
    expect(isStalled(0, BOUND - 1, INTERVAL)).toBe(false);
    expect(isStalled(0, BOUND, INTERVAL)).toBe(true);
    // The 60s info feed gets a proportionally longer leash than the 5s fleet
    // feed — the bound is about missed ticks, not an absolute silence.
    expect(isStalled(0, BOUND, 60_000)).toBe(false);
    expect(isStalled(0, 60_000 * STALL_INTERVALS, 60_000)).toBe(true);
  });
});

describe("poll's change guard", () => {
  /** Let the fetcher's promise settle and the graph run. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  test("a byte-identical body leaves `latest` — and every memo over it — untouched; a changed one moves it", async () => {
    let body = [{ id: "a", xp: 100 }];
    let fetches = 0;
    const feed = createRoot((dispose) => {
      // A fresh array every tick, as `fetch().json()` gives, never the same reference.
      const p = poll(async () => {
        fetches++;
        return structuredClone(body);
      }, 60_000);
      let layouts = 0;
      const layout = createMemo(() => {
        layouts++;
        return (p.latest ?? []).map((r) => r.xp);
      });
      return { p, layout, layouts: () => layouts, dispose };
    });
    await settle();
    expect(fetches).toBe(1);
    expect(feed.layout()).toEqual([100]);
    const after = feed.layouts();
    const held = feed.p.latest;

    feed.p.refresh();
    await settle();
    feed.p.refresh();
    await settle();
    expect(fetches).toBe(3);
    // Two more polls, same content: the same array is still `latest`, and the memo never re-ran.
    expect(feed.p.latest).toBe(held);
    expect(feed.layouts()).toBe(after);

    body = [{ id: "a", xp: 250 }];
    feed.p.refresh();
    await settle();
    expect(feed.p.latest).not.toBe(held);
    expect(feed.layout()).toEqual([250]);
    expect(feed.layouts()).toBe(after + 1);
    feed.dispose();
  });
});

/** A `document` stand-in: a hidden flag and the one event the poller listens for. */
class FakeVisibility {
  hidden = false;
  private readonly fns = new Set<() => void>();
  addEventListener(_type: "visibilitychange", fn: () => void): void {
    this.fns.add(fn);
  }
  removeEventListener(_type: "visibilitychange", fn: () => void): void {
    this.fns.delete(fn);
  }
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const fn of this.fns) fn();
  }
  get listeners(): number {
    return this.fns.size;
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("poll pauses while the tab is hidden", () => {
  test("no fetch while hidden; one at once on return when a tick fell due, then the schedule resumes", async () => {
    const vis = new FakeVisibility();
    let fetches = 0;
    const feed = createRoot((dispose) => ({
      p: poll(async () => ++fetches, 15, { visibility: vis }),
      dispose,
    }));
    await wait(60);
    expect(fetches).toBeGreaterThan(1);

    vis.set(true);
    const atHide = fetches;
    await wait(80);
    // Five periods hidden, not one fetch.
    expect(fetches).toBe(atHide);

    vis.set(false);
    // Overdue, so the return itself polls, before any timer runs.
    expect(fetches).toBe(atHide + 1);
    await wait(60);
    expect(fetches).toBeGreaterThan(atHide + 1);
    feed.dispose();
    expect(vis.listeners).toBe(0);
  });
});
