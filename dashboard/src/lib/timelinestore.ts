/**
 * The focused time, and the one place it lives.
 *
 * A page makes one store and hands it to the bar (`components/Timeline.tsx`)
 * and to everything that shows a moment of the run: the feed, the map's pip,
 * the camera's video, the XP chart's cursor. They all read `at()`. Whoever
 * moves it says who they are (`Origin`, `lib/timeline.ts`), and a follower
 * skips a move that was its own, so nothing answers its own echo:
 *
 * - the bar leads: a scrub, a key or a mark is a seek everyone follows;
 * - the feed moves the focus only from the reader's own scroll, never from a
 *   scroll the page made (`createScrollGuard`), and does not scroll for a
 *   move it reported;
 * - the video moves it while it plays and is seeked while it does not
 *   (`lib/video-sync.ts`);
 * - playback moves it on the run's own clock.
 *
 * `focus` is null while the reader follows the run's newest moment: the live
 * edge of a run still going, the end of one that is not. `at()` is then the
 * span's end, so it advances with a live run by itself; a seek anywhere else
 * pins a time, and `goLive` lets go of it again.
 *
 * Playback here is an anchor (where it started, when, how fast) read on a
 * tick, never a tick that adds, so a tab put away and brought back is where
 * the time says. A page with a frame loop of its own (the map) passes
 * `external` and drives the focus itself; the store then only holds whether
 * it plays and how fast.
 */

import { batch, createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { DEFAULT_SPEED, advanceCursor, nextSpeed, type Speed } from "@wrathbench/inspector/views/playback";
import { centreOn, focusTime, panBy, reveal, seekTarget, viewOf, zoomAt, zoomable, type Origin, type Span } from "./timeline";

/** How often playback moves the focus: four times a second, as the map's throttled cursor does. */
export const PLAY_TICK_MS = 250;

export interface TimelineOptions {
  /** What the bar covers; null until the page knows. */
  span: Accessor<Span | null>;
  /** Whether the run is still going, so its end is an edge to follow. */
  live?: Accessor<boolean>;
  /** Stretches playback hurries through: nothing was recorded in them. */
  idle?: Accessor<readonly Span[]>;
  /** The page moves the focus during playback itself. */
  external?: boolean;
}

export interface TimelineStore {
  span: Accessor<Span | null>;
  live: Accessor<boolean>;
  /** The pinned time, or null while following the newest moment. */
  focus: Accessor<number | null>;
  /** The focused time, whichever of the two it is. */
  at: Accessor<number>;
  /** Following the live edge of a run still going. */
  following: Accessor<boolean>;
  /** Who last moved the focus. */
  origin: Accessor<Origin>;
  seek(ts: number, origin: Origin): void;
  /** Let go of the pinned time: the live edge, or the end. */
  goLive(origin?: Origin): void;
  playing: Accessor<boolean>;
  setPlaying(on: boolean): void;
  /** Play from the focus, from the start when the focus is the end; or stop. */
  toggle(): void;
  speed: Accessor<Speed>;
  setSpeed(s: Speed): void;
  cycleSpeed(): void;
  /** The zoomed view, or null while the whole span fits. */
  view: Accessor<Span | null>;
  /** What the bar draws across: the view inside the span, or the span. */
  shown: Accessor<Span | null>;
  zoomable: Accessor<boolean>;
  zoom(anchor: number, factor: number): void;
  pan(deltaMs: number): void;
  centre(ts: number): void;
  fit(): void;
}

export function createTimeline(opts: TimelineOptions): TimelineStore {
  const span = opts.span;
  const live = (): boolean => opts.live?.() === true;
  const [focus, setFocus] = createSignal<number | null>(null);
  const [origin, setOrigin] = createSignal<Origin>("live");
  const [playing, setPlaying] = createSignal(false);
  const [speed, setSpeed] = createSignal<Speed>(DEFAULT_SPEED);
  const [view, setView] = createSignal<Span | null>(null);
  const at = createMemo(() => focusTime(span(), focus()));
  const canZoom = createMemo(() => zoomable(span()));
  /** Where playback started, on which clock. */
  let anchor: { cursor: number; at: number } | null = null;

  const seek = (ts: number, by: Origin): void => {
    const sp = span();
    const next = sp === null ? (Number.isFinite(ts) ? ts : null) : seekTarget(sp, ts, live());
    batch(() => {
      setOrigin(by);
      setFocus(next);
      // A focus carried off the zoomed view brings the view with it.
      if (sp !== null && untrack(view) !== null) setView(reveal(sp, untrack(view), next ?? sp.to));
    });
    // A seek under playback is where playback carries on from.
    if (by !== "clock" && anchor !== null && next !== null) anchor = { cursor: next, at: performance.now() };
  };
  const goLive = (by: Origin = "timeline"): void => {
    batch(() => {
      setOrigin(by);
      setFocus(null);
      setPlaying(false);
      const sp = span();
      if (sp !== null && untrack(view) !== null) setView(reveal(sp, untrack(view), sp.to));
    });
  };
  const toggle = (): void => {
    const sp = span();
    if (sp === null || sp.to <= sp.from) return;
    if (playing()) {
      setPlaying(false);
      return;
    }
    if (at() >= sp.to) seek(sp.from, "timeline");
    setPlaying(true);
  };

  // A span that shrank under a zoomed view (never in practice) or stopped being zoomable drops the view.
  createEffect(() => {
    if (!canZoom() && untrack(view) !== null) setView(null);
  });

  // A reader following the newest moment of a zoomed run keeps it on screen as it advances.
  createEffect(() => {
    const sp = span();
    if (sp === null || focus() !== null) return;
    const v = untrack(view);
    if (v !== null) setView(reveal(sp, v, sp.to));
  });

  if (opts.external !== true) {
    createEffect(() => {
      if (!playing()) {
        anchor = null;
        return;
      }
      const s = speed();
      // A speed change carries on from where the focus is now.
      anchor = { cursor: untrack(at), at: performance.now() };
      const id = setInterval(() => {
        const sp = untrack(span);
        if (sp === null || anchor === null) return;
        const t = advanceCursor(anchor.cursor, performance.now() - anchor.at, s, untrack(() => opts.idle?.() ?? []));
        if (t >= sp.to) {
          batch(() => {
            seek(sp.to, "clock");
            setPlaying(false);
          });
        } else seek(t, "clock");
      }, PLAY_TICK_MS);
      onCleanup(() => clearInterval(id));
    });
  }

  return {
    span,
    live,
    focus,
    at,
    following: () => live() && focus() === null,
    origin,
    seek,
    goLive,
    playing,
    setPlaying: (on) => void setPlaying(on),
    toggle,
    speed,
    setSpeed: (s) => void setSpeed(s),
    cycleSpeed: () => void setSpeed(nextSpeed(speed())),
    view,
    shown: createMemo(() => {
      const sp = span();
      return sp === null ? null : viewOf(sp, view());
    }),
    zoomable: canZoom,
    zoom: (a, factor) => {
      const sp = span();
      if (sp !== null && canZoom()) setView(zoomAt(sp, view(), a, factor));
    },
    pan: (d) => {
      const sp = span();
      if (sp !== null) setView(panBy(sp, view(), d));
    },
    centre: (ts) => {
      const sp = span();
      if (sp !== null) setView(centreOn(sp, view(), ts));
    },
    fit: () => void setView(null),
  };
}
