/**
 * An interval that does nothing while the tab is hidden.
 *
 * The map keeps two timers of its own beside its polled feed: the 1 s pump
 * that asks the trace and nearby stores for what the playhead is about to
 * reach, and a replay's poll of its run's open tail. Both fetch, and a map
 * left open behind other tabs fetched exactly as a watched one did. These
 * follow the rule `lib/poll.ts` keeps for the feeds: no work while hidden,
 * and on coming back one tick at once if any fell due while away, then the
 * schedule as before.
 */

/** The slice of `document` this reads (the same one `lib/poll.ts` does). Injected in tests. */
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

export interface VisibleIntervalOptions {
  /** `document` in a browser; always visible where there is none. */
  visibility?: Visibility | null;
  /** The timer underneath, as a start that returns its stop. Injected in tests. */
  every?: (fn: () => void, ms: number) => () => void;
}

function ambientVisibility(): Visibility | null {
  return typeof document === "undefined" ? null : document;
}

function realEvery(fn: () => void, ms: number): () => void {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

/** Run `fn` every `ms` while the tab is visible; the stop it returns ends both the timer and the watch. */
export function visibleInterval(fn: () => void, ms: number, opts: VisibleIntervalOptions = {}): () => void {
  const visibility = opts.visibility === undefined ? ambientVisibility() : opts.visibility;
  const hidden = (): boolean => visibility?.hidden === true;
  let missed = false;
  let stopped = false;
  const stopTimer = (opts.every ?? realEvery)(() => {
    if (stopped) return;
    if (hidden()) {
      missed = true;
      return;
    }
    fn();
  }, ms);
  const onVisibility = (): void => {
    if (stopped || hidden() || !missed) return;
    missed = false;
    fn();
  };
  visibility?.addEventListener("visibilitychange", onVisibility);
  return () => {
    if (stopped) return;
    stopped = true;
    stopTimer();
    visibility?.removeEventListener("visibilitychange", onVisibility);
  };
}
