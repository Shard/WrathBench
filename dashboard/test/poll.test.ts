/**
 * The poller's stall verdict, on its pure seam.
 *
 * `latest` and `error` leave one hole between them: a fetch that never settles
 * produces neither, so a page reading only those two would show its last good
 * value forever with nothing marked wrong. `isStalled` is what closes it, and
 * what is worth pinning is the bound — a generous multiple of the interval on
 * the real clock, so a slow round trip is not a verdict — and that any
 * settlement, failure included, resets it (a failure has `error` to carry it).
 */

import { describe, expect, test } from "bun:test";
import { STALL_INTERVALS, isStalled } from "../src/lib/poll";

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
