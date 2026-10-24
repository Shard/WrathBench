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
 * And the schedule: nothing fetched while the tab is hidden, one poll on
 * return only if a tick fell due, the absence never read as a stall, and a
 * period that follows the value (fast while something is live).
 */

import { describe, expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import { STALL_INTERVALS, contentKey, dueIn, isStalled, poll } from "../src/lib/poll";

describe("isStalled", () => {
  const INTERVAL = 5_000;
  const BOUND = INTERVAL * STALL_INTERVALS;

  test("a feed whose ticks keep settling never reads stalled", () => {
    // A settlement every interval, checked one interval later each time.
    for (let at = 0; at < BOUND * 3; at += INTERVAL) {
      expect(isStalled(at, at + INTERVAL, INTERVAL)).toBe(false);
    }
  });

  test("the bound is STALL_INTERVALS intervals, and scales with the interval", () => {
    expect(isStalled(0, BOUND - 1, INTERVAL)).toBe(false);
    expect(isStalled(0, BOUND, INTERVAL)).toBe(true);
    // The 60s info feed gets a proportionally longer leash than the 5s fleet
    // feed — the bound is about missed ticks, not an absolute silence.
    expect(isStalled(0, BOUND, 60_000)).toBe(false);
    expect(isStalled(0, 60_000 * STALL_INTERVALS, 60_000)).toBe(true);
  });

  test("one settlement resets the clock, however long the silence before it", () => {
    const settledAt = BOUND * 10;
    expect(isStalled(settledAt, settledAt + INTERVAL, INTERVAL)).toBe(false);
  });
});

describe("contentKey", () => {
  test("equal content keys alike whatever the object identity; a field absent and a field undefined are one page", () => {
    expect(contentKey({ runs: [{ id: "a", n: 1 }] })).toBe(contentKey({ runs: [{ id: "a", n: 1 }] }));
    expect(contentKey({ a: 1, b: undefined })).toBe(contentKey({ a: 1 }));
    expect(contentKey({ runs: [{ id: "a", n: 1 }] })).not.toBe(contentKey({ runs: [{ id: "a", n: 2 }] }));
  });
  test("what cannot be serialised has no key, and so always counts as new", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(contentKey(cyclic)).toBeNull();
    expect(contentKey(undefined)).toBeNull();
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

  test("an identical body after a failure still clears the error — the settlement counts even when the value does not move", async () => {
    let fail = false;
    const feed = createRoot((dispose) => ({
      p: poll(async () => {
        if (fail) throw new Error("blip");
        return { ok: true };
      }, 60_000),
      dispose,
    }));
    await settle();
    const held = feed.p.latest;
    fail = true;
    feed.p.refresh();
    await settle();
    expect(feed.p.error).toBeInstanceOf(Error);
    expect(feed.p.latest).toBe(held);
    fail = false;
    feed.p.refresh();
    await settle();
    expect(feed.p.error).toBeUndefined();
    expect(feed.p.latest).toBe(held);
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

describe("dueIn", () => {
  test("the rest of the period, and zero once a tick is overdue", () => {
    expect(dueIn(1_000, 1_000, 5_000)).toBe(5_000);
    expect(dueIn(1_000, 4_000, 5_000)).toBe(2_000);
    expect(dueIn(1_000, 6_000, 5_000)).toBe(0);
    expect(dueIn(1_000, 60_000, 5_000)).toBe(0);
  });
});

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

  test("a return before the next tick is due waits out the period rather than polling on every flick", () => {
    const vis = new FakeVisibility();
    let t = 0;
    let fetches = 0;
    const feed = createRoot((dispose) => ({
      p: poll(async () => ++fetches, 10_000, { visibility: vis, now: () => t }),
      dispose,
    }));
    expect(fetches).toBe(1);
    for (let i = 0; i < 5; i++) {
      t += 1_000;
      vis.set(true);
      vis.set(false);
    }
    expect(fetches).toBe(1);
    t += 6_000; // 11 s since the first tick: due.
    vis.set(true);
    vis.set(false);
    expect(fetches).toBe(2);
    feed.dispose();
  });

  test("time away is not silence: the first verdict after a long absence is not stalled", async () => {
    const vis = new FakeVisibility();
    let t = 0;
    const feed = createRoot((dispose) => ({
      p: poll(async () => ({ ok: true }), 1_000, { visibility: vis, now: () => t }),
      dispose,
    }));
    await wait(0);
    vis.set(true);
    t += 1_000 * STALL_INTERVALS * 10;
    // Overdue: the return polls at once, and that tick judges the stall.
    vis.set(false);
    expect(feed.p.stalled).toBe(false);
    feed.dispose();
  });

  test("a tab that opens hidden still loads once, then waits for the reader", async () => {
    const vis = new FakeVisibility();
    vis.hidden = true;
    let fetches = 0;
    const feed = createRoot((dispose) => ({
      p: poll(async () => ++fetches, 10, { visibility: vis }),
      dispose,
    }));
    await wait(50);
    expect(fetches).toBe(1);
    expect(feed.p.latest).toBe(1);
    feed.dispose();
  });
});

describe("poll's period can follow the value", () => {
  test("slow while nothing is live, fast once something is, and slow again", async () => {
    let live = false;
    let fetches = 0;
    const feed = createRoot((dispose) => ({
      p: poll(
        async () => {
          fetches++;
          return { live };
        },
        (v) => (v?.live === true ? 15 : 600_000),
        { visibility: null },
      ),
      dispose,
    }));
    await wait(60);
    // Not live: the first answer re-armed the timer ten minutes out.
    expect(fetches).toBe(1);

    live = true;
    feed.p.refresh();
    await wait(80);
    expect(fetches).toBeGreaterThan(2);

    live = false;
    // The next answer reads not-live and re-arms slow.
    feed.p.refresh();
    await wait(0);
    const settled = fetches;
    await wait(60);
    expect(fetches).toBe(settled);
    feed.dispose();
  });

  test("refresh replaces the pending tick rather than starting a second schedule", async () => {
    let fetches = 0;
    const feed = createRoot((dispose) => ({
      p: poll(async () => ++fetches, 40, { visibility: null }),
      dispose,
    }));
    for (let i = 0; i < 5; i++) feed.p.refresh();
    expect(fetches).toBe(6);
    await wait(60);
    // One timer chain: one more tick in 60 ms of a 40 ms period, not six.
    expect(fetches).toBe(7);
    feed.dispose();
  });
});
