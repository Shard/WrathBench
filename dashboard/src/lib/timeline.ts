/**
 * The timeline's arithmetic and its rules, pure: the bar at the bottom of the
 * run page and the map's replay (`components/Timeline.tsx`) draws with these,
 * and `lib/timelinestore.ts` holds the state they decide over.
 *
 * Everything is run time, epoch ms. A `Span` is what the bar covers; a view
 * is the part of it on screen once the reader has zoomed, null while the
 * whole run fits.
 */

export interface Span {
  from: number;
  to: number;
}

/* ------------------------------------------------------------ the focus */

/**
 * Who moved the focused time. Each follower ignores a move it made itself,
 * which is the whole of what keeps the feed, the video and the bar from
 * chasing each other's echo:
 *
 * - `timeline`: the bar's own pointer, keys and marks, and a page's controls;
 * - `feed`: the reader scrolled the feed (never a scroll the page made);
 * - `video`: the camera video, while it plays;
 * - `clock`: playback on the run's own clock;
 * - `url`: a link opened, or back and forward;
 * - `live`: the live edge moved under a reader who is following it.
 */
export type Origin = "timeline" | "feed" | "video" | "clock" | "url" | "live";

/** A live run's focus this close to its newest moment is the live edge itself. */
export const LIVE_SNAP_MS = 2_000;

export function clampTo(span: Span, ts: number): number {
  return Math.min(span.to, Math.max(span.from, ts));
}

/**
 * Where a seek lands: inside the span, and on a live run a seek to the
 * newest moment is "follow the live edge" (null) rather than a time that
 * would be stale a second later.
 */
export function seekTarget(span: Span, ts: number, live: boolean): number | null {
  if (!Number.isFinite(ts)) return null;
  const at = clampTo(span, ts);
  return live && at >= span.to - LIVE_SNAP_MS ? null : at;
}

/** The time a focus stands for: itself, or the span's newest moment while following. */
export function focusTime(span: Span | null, focus: number | null): number {
  if (span === null) return focus ?? 0;
  return focus === null ? span.to : clampTo(span, focus);
}

/* -------------------------------------------------------------- the URL */

/**
 * `?t=`: the focused time in whole epoch seconds. Absolute rather than an
 * offset into the run, because the run page counts from the run's start and
 * a replay from its first recorded position, and a party's replay has five
 * starts: one number means the same moment on every page. Absent is "where
 * the page opens by itself": the live edge or the end on the run page, where
 * the replay was last left on the map.
 */
export function formatT(ts: number): string {
  return String(Math.round(ts / 1000));
}

/** A `?t=` value as run time, or null for anything that is not one. */
export function parseT(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw)) return null;
  const ts = Number(raw) * 1000;
  return Number.isFinite(ts) ? ts : null;
}

/**
 * The two-way door between the focus and `?t=`. The page writes the focus to
 * the URL by replacing the entry, so a scrub is not forty history entries;
 * what comes back from the URL moves the focus only when it is not the
 * page's own write returning, which is what back, forward and a pasted link
 * are.
 */
export interface UrlSync {
  /** The `t` to write for a focus, or undefined to leave the URL alone; null removes the parameter. */
  toUrl(focus: number | null): string | null | undefined;
  /** The time a URL's `t` asks for, `"none"` where it asks to follow, or undefined when it is this page's own write. */
  fromUrl(raw: unknown): number | "none" | undefined;
}

export function createUrlSync(initial: unknown): UrlSync {
  let held: string | null = typeof initial === "string" ? initial : null;
  return {
    toUrl(focus) {
      const next = focus === null ? null : formatT(focus);
      if (next === held) return undefined;
      held = next;
      return next;
    },
    fromUrl(raw) {
      const now = typeof raw === "string" && raw !== "" ? raw : null;
      if (now === held) return undefined;
      held = now;
      const ts = parseT(now);
      return ts === null ? "none" : ts;
    },
  };
}

/** A path with the focused time on it: what a link between the run page and the map carries. */
export function withT(href: string, focus: number | null): string {
  if (focus === null) return href;
  return `${href}${href.includes("?") ? "&" : "?"}t=${formatT(focus)}`;
}

/* ----------------------------------------------------------------- zoom */

/** Past this much run time the bar can be zoomed: under it a pixel is already seconds. */
const ZOOM_SPAN_MS = 24 * 3_600_000;
/** The closest zoom: ten minutes across the bar. */
export const MIN_VIEW_MS = 10 * 60_000;
/** One wheel notch. */
export const ZOOM_STEP = 1.25;

export function zoomable(span: Span | null): boolean {
  return span !== null && span.to - span.from > ZOOM_SPAN_MS;
}

/** What the bar shows: the view where there is one and it still lies in the span, else the span. */
export function viewOf(span: Span, view: Span | null): Span {
  if (view === null) return span;
  const len = Math.min(view.to - view.from, span.to - span.from);
  const from = Math.min(Math.max(view.from, span.from), span.to - len);
  return { from, to: from + len };
}

/** A view that covers the whole span is no view: the reader is not zoomed. */
function settle(span: Span, view: Span): Span | null {
  return view.from <= span.from && view.to >= span.to ? null : view;
}

/**
 * Zoom by `factor` (under 1 is in) keeping `anchor`, the time under the
 * pointer, where it is on screen.
 */
export function zoomAt(span: Span, view: Span | null, anchor: number, factor: number): Span | null {
  const v = viewOf(span, view);
  const full = span.to - span.from;
  const len = Math.min(full, Math.max(Math.min(MIN_VIEW_MS, full), (v.to - v.from) * factor));
  const a = clampTo(v, anchor);
  const share = v.to === v.from ? 0.5 : (a - v.from) / (v.to - v.from);
  return settle(span, viewOf(span, { from: a - share * len, to: a - share * len + len }));
}

export function panBy(span: Span, view: Span | null, deltaMs: number): Span | null {
  if (view === null) return null;
  const v = viewOf(span, view);
  return settle(span, viewOf(span, { from: v.from + deltaMs, to: v.to + deltaMs }));
}

/** The view centred on `ts`, at the length it has: the overview strip's drag. */
export function centreOn(span: Span, view: Span | null, ts: number): Span | null {
  if (view === null) return null;
  const v = viewOf(span, view);
  const len = v.to - v.from;
  return settle(span, viewOf(span, { from: ts - len / 2, to: ts + len / 2 }));
}

/**
 * The view moved just enough to hold `ts`: a focus that playback, the feed or
 * a link carried off screen comes back a tenth in from the edge it left by.
 */
export function reveal(span: Span, view: Span | null, ts: number): Span | null {
  if (view === null) return null;
  const v = viewOf(span, view);
  if (ts >= v.from && ts <= v.to) return view;
  const len = v.to - v.from;
  const from = ts < v.from ? ts - len * 0.1 : ts - len * 0.9;
  return settle(span, viewOf(span, { from, to: from + len }));
}

/** A time's place across the view, 0 to 1; outside it, outside that. */
export function fractionOf(view: Span, ts: number): number {
  return view.to <= view.from ? 0 : (ts - view.from) / (view.to - view.from);
}

/** The time at a fraction of the view, clamped to it. */
export function timeAt(view: Span, fraction: number): number {
  return view.from + Math.min(1, Math.max(0, fraction)) * (view.to - view.from);
}

/* ----------------------------------------------------------------- axis */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

/**
 * The run's own clock: time since it started, "4:07" under an hour,
 * "3:04:07" under a day, "2d 03:04" past one. A multi-day run's seconds are
 * noise, and its hours past 24 are arithmetic no one should do.
 */
export function fmtRunClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}:${m}`;
  return h > 0 ? `${h}:${m}:${sec}` : `${Number(m)}:${sec}`;
}

/** A tick's label: the largest units that say it, "45m", "6h", "1d 12h". */
function fmtTick(ms: number): string {
  const total = Math.round(ms / MIN);
  if (total === 0) return "0";
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * The ticks across a view `width` pixels wide: round steps of the run's own
 * clock, counted from the span's start, no closer than `gap` pixels, and none
 * so near the right edge that its label would be cut (`room` pixels).
 */
export function axisTicks(span: Span, view: Span, width: number, gap = 96, room = 44): { ts: number; label: string }[] {
  const len = view.to - view.from;
  if (len <= 0 || width <= 0) return [];
  const want = (len * gap) / width;
  const step = STEPS.find((s) => s >= want) ?? Math.ceil(want / (30 * DAY)) * 30 * DAY;
  const out: { ts: number; label: string }[] = [];
  for (let k = Math.ceil((view.from - span.from) / step); ; k++) {
    const ts = span.from + k * step;
    if (ts > view.to - (len * room) / width) break;
    out.push({ ts, label: fmtTick(ts - span.from) });
  }
  return out;
}

/* ----------------------------------------------------------------- feed */

/** The last row at or before `ts` in a feed's rows, oldest first; the first row when `ts` is before them all, -1 with none. */
export function rowAt(rowTs: readonly number[], ts: number): number {
  if (rowTs.length === 0) return -1;
  let lo = 0;
  let hi = rowTs.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rowTs[mid]! <= ts) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The feed window a page holds: which entries of the run, and the times at its two ends. */
export interface FeedWindow {
  from: number;
  /** One past the last entry held. */
  end: number;
  total: number;
  oldestTs: number | null;
  newestTs: number | null;
}

/**
 * What showing `ts` in the feed takes: a scroll inside the window held, or
 * another window, when the time is past an end of this one and the run has
 * entries there.
 */
export function feedPlan(w: FeedWindow, ts: number): "scroll" | "load" {
  if (w.oldestTs === null || w.newestTs === null) return w.total > 0 ? "load" : "scroll";
  if (ts < w.oldestTs && w.from > 0) return "load";
  if (ts > w.newestTs && w.end < w.total) return "load";
  return "scroll";
}

/**
 * Whose scroll it was. The page marks every scroll it makes itself (a seek, a
 * pin to the newest entry, a window loading above the reader); a scroll
 * event inside the hold after a mark is that scroll arriving, and is not the
 * reader's. Without it the feed would report the row a seek had just put in
 * view, the bar would move to that row's time, and the two would walk.
 */
export interface ScrollGuard {
  mark(): void;
  /** Whether a scroll event now is the page's own. */
  own(): boolean;
}

export const SCROLL_HOLD_MS = 200;

export function createScrollGuard(now: () => number = () => performance.now(), holdMs: number = SCROLL_HOLD_MS): ScrollGuard {
  let until = Number.NEGATIVE_INFINITY;
  return {
    mark: () => {
      until = now() + holdMs;
    },
    own: () => now() < until,
  };
}

/**
 * The row a scrolled feed is showing: the first of `count` rows, oldest
 * first, whose bottom (`bottomOf`, measured from the top of the pane) is
 * below that top; the last row when every one is above it, -1 with none. A
 * binary search that measures only the rows it visits, because a window is
 * a thousand entries and this runs as the reader scrolls.
 */
export function rowInView(count: number, bottomOf: (i: number) => number, slack = 4): number {
  let lo = 0;
  let hi = count - 1;
  let found = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > slack) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found;
}
