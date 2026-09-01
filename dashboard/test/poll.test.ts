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
 */

import { describe, expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import { STALL_INTERVALS, contentKey, isStalled, poll } from "../src/lib/poll";

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
