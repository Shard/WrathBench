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
 * are stated at each call site rather than hidden in here. An interval may be
 * a function of the value in hand, which is how a page that only changes while
 * something is live (a character, a party) polls fast while it is and slowly
 * once it is not.
 *
 * Nothing is fetched while the tab is hidden. A background tab polled exactly
 * as a foreground one did, and a private runs page left open behind other tabs
 * pulled about half a gigabyte an hour for nobody. On return the feed polls at
 * once if a tick fell due while it was away, and otherwise resumes its
 * schedule; either way the absence is not read as a stall.
 *
 * A poll that answers with the same content is not a change. `latest` is only
 * reassigned when the body differs from the one it holds (`contentKey`), so a
 * page's memos over it — the ladder's aggregation and label layout, the runs
 * table's sort, every `<For>` keyed on the array's objects — stay put across
 * the many ticks that bring nothing new, and only re-run when something did.
 * Before this every tick handed the graph a fresh array, and identical data
 * re-laid-out and rebuilt the DOM under the reader every 15–30 seconds.
 */

import { createSignal, onCleanup, untrack } from "solid-js";
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

/**
 * A value's identity for the change test: its JSON form. Two bodies that
 * serialise alike would render alike — every feed is API JSON, and a field
 * that is `undefined` in one and absent in the other draws the same page —
 * so string equality on the serialisation is the whole test. A value that
 * cannot be serialised (nothing the API returns, but the poller is generic)
 * gets no key and is always taken as new, which is the old behaviour.
 */
export function contentKey(v: unknown): string | null {
  try {
    const key = JSON.stringify(v);
    return typeof key === "string" ? key : null;
  } catch {
    return null;
  }
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

/**
 * How often to poll: a fixed period, or one read off the value in hand
 * (`undefined` before the first answer), so a feed can slow down once what it
 * shows has stopped moving. Read again after every answer that changed the
 * value; a period that moves re-arms the timer from the last tick.
 */
export type PollInterval<T> = number | ((latest: T | undefined) => number);

/** The slice of `document` the poller reads. Injected in tests. */
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

export interface PollOptions {
  /** The page's visibility: `document` in a browser, and always visible where there is none. */
  visibility?: Visibility | null;
  /** Injected in tests: the clock the schedule and the stall bound are measured on. */
  now?: () => number;
}

/**
 * How long until the next tick is due, from the last one: zero once it is
 * overdue. Pure, and exported, so the resume rule is asserted rather than the
 * timer: a tab that comes back after a tick fell due polls at once, and one
 * that comes back sooner waits out the rest of its period.
 */
export function dueIn(lastTickAt: number, now: number, intervalMs: number): number {
  return Math.max(0, lastTickAt + intervalMs - now);
}

/**
 * A period gated on liveness: `liveMs` while the value says something is still
 * moving, and before the first answer has said either way; `idleMs` once it
 * says nothing is. For the pages whose whole body is one live thing — a
 * character, a party — and is large, and stops changing when it ends.
 */
export function whileLive<T>(isLive: (v: T) => boolean, liveMs: number, idleMs: number): (v: T | undefined) => number {
  return (v) => (v === undefined || isLive(v) ? liveMs : idleMs);
}

function ambientVisibility(): Visibility | null {
  return typeof document === "undefined" ? null : document;
}

export function poll<T>(fetcher: () => Promise<T>, interval: PollInterval<T>, opts: PollOptions = {}): Poll<T> {
  const [latest, setLatest] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [stalled, setStalled] = createSignal(false);
  const clock = opts.now ?? ((): number => Date.now());
  const visibility = opts.visibility === undefined ? ambientVisibility() : opts.visibility;
  const hidden = (): boolean => visibility?.hidden === true;
  let disposed = false;
  let lastSettledAt = clock();
  let lastTickAt = clock();
  /** The period the pending tick was armed with: what its stall verdict is measured against. */
  let armedMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The key of the value `latest` holds; the next tick's body is compared against it. */
  let latestKey: string | null = null;

  /** The period as of the value in hand. Untracked: the timer is not a reactive computation. */
  const period = (): number => (typeof interval === "number" ? interval : untrack(() => interval(latest())));

  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  /** Arm the next tick one period after the last; nothing is armed while the tab is hidden. */
  const arm = (): void => {
    disarm();
    if (disposed || hidden()) return;
    armedMs = period();
    timer = setTimeout(tick, dueIn(lastTickAt, clock(), armedMs));
  };

  function tick(): void {
    // Judged at each tick rather than on a clock of its own: the stall bound
    // is a multiple of the period, so the tick is granularity enough. The
    // period is the one this tick was armed with, so a feed that has just
    // sped up is not measured against its new, shorter leash.
    const now = clock();
    setStalled(isStalled(lastSettledAt, now, armedMs ?? period()));
    lastTickAt = now;
    // Armed now rather than on settlement, as an interval would be: a slow
    // answer does not push the schedule back. `refresh()` lands here too, and
    // re-arming replaces the pending timer rather than starting a second one.
    arm();
    void fetcher().then(
      (v) => {
        if (disposed) return;
        lastSettledAt = clock();
        setStalled(false);
        // Same content, same value: the graph downstream is left alone. The
        // settlement above still counts — the feed answered — and an error
        // from the tick before is still cleared below.
        const key = contentKey(v);
        if (key === null || key !== latestKey) {
          latestKey = key;
          setLatest(() => v);
          // A value that moves the period re-arms from the last tick.
          if (timer !== undefined && period() !== armedMs) arm();
        }
        setError(undefined);
      },
      (e: unknown) => {
        if (disposed) return;
        // A failure is a settlement: the feed is answering, just badly, and
        // `error` is the signal that carries that.
        lastSettledAt = clock();
        setStalled(false);
        setError(e);
        // The one place every polled feed's failure passes through, and not a
        // render, so the public build's console keeps the detail its banner
        // no longer prints.
        logError("poll", e);
      },
    );
  }

  /*
   * Hidden: the pending tick is dropped. Shown again: the time away was not
   * the feed's silence, so the stall clock restarts, and the feed polls at
   * once if a tick fell due meanwhile or resumes its schedule if not, so
   * flicking between tabs does not refetch on every flick.
   */
  const onVisibility = (): void => {
    if (disposed) return;
    if (hidden()) {
      disarm();
      return;
    }
    lastSettledAt = clock();
    armedMs = null;
    setStalled(false);
    if (dueIn(lastTickAt, clock(), period()) === 0) tick();
    else arm();
  };

  visibility?.addEventListener("visibilitychange", onVisibility);
  tick();
  onCleanup(() => {
    disposed = true;
    disarm();
    visibility?.removeEventListener("visibilitychange", onVisibility);
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
