/**
 * Polling as a Solid primitive.
 *
 * `createResource` refetches on a signal change, not on a clock, and the
 * dashboard's feeds are all "the same request again in N seconds". The two
 * things every caller needs and a bare interval does not give: the last good
 * value survives a failed poll (a blip must not blank the page), and the timer
 * stops when the component goes away.
 *
 * Polling rate is a public-hosting constraint, so the intervals
 * are stated at each call site rather than hidden in here.
 */

import { createSignal, onCleanup } from "solid-js";
import { logError } from "./errors";

/**
 * How many intervals may pass with no tick settling before the feed reads
 * stalled. Generous on purpose — a slow round trip must not become a verdict,
 * and every tick starts a fresh request, so a working-but-slow network settles
 * something well inside the window.
 */
export const STALL_INTERVALS = 5;

/**
 * Whether a feed has stalled: nothing — success or failure — has settled for
 * `STALL_INTERVALS` intervals on the real clock. This is the one hole `latest`
 * and `error` leave between them: a fetch that never settles produces neither,
 * so the last good value would stand forever looking healthy. Pure, and
 * exported, so the verdict is asserted rather than the timer.
 */
export function isStalled(lastSettledAt: number, now: number, intervalMs: number): boolean {
  return now - lastSettledAt >= intervalMs * STALL_INTERVALS;
}

export interface Poll<T> {
  /** The most recent successful value, kept across a failed poll. */
  readonly latest: T | undefined;
  /** The error from the most recent failed poll, cleared by the next success. */
  readonly error: unknown;
  /**
   * True while no poll has settled for a long stretch (`isStalled`). Distinct
   * from `error` — a wedged fetch reports nothing at all — and measured on
   * this browser's clock, because a frozen feed is a fact about this tab.
   */
  readonly stalled: boolean;
  /** Fetch now, without waiting for the next tick. */
  refresh: () => void;
}

export function poll<T>(fetcher: () => Promise<T>, intervalMs: number): Poll<T> {
  const [latest, setLatest] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [stalled, setStalled] = createSignal(false);
  let disposed = false;
  let lastSettledAt = Date.now();

  const tick = (): void => {
    // Judged at each tick rather than on a clock of its own: the stall bound
    // is a multiple of the interval, so the tick is granularity enough.
    setStalled(isStalled(lastSettledAt, Date.now(), intervalMs));
    void fetcher().then(
      (v) => {
        if (disposed) return;
        lastSettledAt = Date.now();
        setStalled(false);
        setLatest(() => v);
        setError(undefined);
      },
      (e: unknown) => {
        if (disposed) return;
        // A failure is a settlement: the feed is answering, just badly, and
        // `error` is the signal that carries that.
        lastSettledAt = Date.now();
        setStalled(false);
        setError(e);
        // The one place every polled feed's failure passes through, and not a
        // render, so the public build's console keeps the detail its banner
        // no longer prints.
        logError("poll", e);
      },
    );
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  onCleanup(() => {
    disposed = true;
    clearInterval(timer);
  });

  return {
    get latest() {
      return latest();
    },
    get error() {
      return error();
    },
    get stalled() {
      return stalled();
    },
    refresh: tick,
  };
}
