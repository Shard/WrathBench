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

export interface Poll<T> {
  /** The most recent successful value, kept across a failed poll. */
  readonly latest: T | undefined;
  /** The error from the most recent failed poll, cleared by the next success. */
  readonly error: unknown;
  /** Fetch now, without waiting for the next tick. */
  refresh: () => void;
}

export function poll<T>(fetcher: () => Promise<T>, intervalMs: number): Poll<T> {
  const [latest, setLatest] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  let disposed = false;

  const tick = (): void => {
    void fetcher().then(
      (v) => {
        if (disposed) return;
        setLatest(() => v);
        setError(undefined);
      },
      (e: unknown) => {
        if (!disposed) setError(e);
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
    refresh: tick,
  };
}
