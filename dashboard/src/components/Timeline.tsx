/**
 * The timeline: one bar fixed to the bottom of the viewport on the run page
 * and the map's replay, across its whole width, and the only scrubber either
 * page has. It draws a run of minutes or of days on one line and is where the
 * focused time is moved from; the state is the page's `TimelineStore`
 * (`lib/timelinestore.ts`), which the feed, the map, the camera's video and
 * the XP chart all follow.
 *
 * What it draws, left to right across the run's own clock:
 *
 * - the **chapters** as the bar itself: one band per level, numbered where
 *   it is wide enough, with a boss kill a mark on it (`@viewer/timeline-marks`);
 * - **deaths** as red ticks, which are events and not chapters;
 * - a stretch the run was **paused** for as a gap in the bar;
 * - under the bar, the stretch of the run the **feed** has loaded;
 * - the **playhead**, and behind it what has played.
 *
 * A run of more than a day can be zoomed: the wheel or a pinch over the bar,
 * or the two buttons, about the time under the pointer; a sideways wheel or a
 * drag on the overview strip pans, and "fit" goes back to the whole run. The
 * strip is the whole run with the part on screen marked, drawn only while
 * zoomed. A focus that leaves the zoomed part takes the view with it.
 *
 * One finger or the mouse scrubs; a click within a few pixels of a mark lands
 * on it. Space plays, the arrows step (between marks, or the page's own
 * steps), Home and End go to the ends: the map's old transport keys, on both
 * pages. While the bar is mounted the shell is padded by its height
 * (`.has-timeline`, `--timeline-h`), so it covers nothing.
 */

import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { keyBelongsToTarget, playbackKey } from "@wrathbench/inspector/views/playback";
import { levelBands, type TimelineMark } from "@viewer/timeline-marks";
import { stamp } from "../lib/format";
import { ZOOM_STEP, axisTicks, fmtRunClock, fractionOf, timeAt, type Span } from "../lib/timeline";
import type { TimelineStore } from "../lib/timelinestore";

/** A click this close to a mark lands on it. */
const SNAP_PX = 5;
/** A level's band is numbered from this width. */
const BAND_LABEL_PX = 26;

export interface TimelineSteps {
  back(): void;
  forward(): void;
  canBack: boolean;
  canForward: boolean;
  /** What a step is, for the buttons' titles: "sample", "mark". */
  noun: string;
}

export interface TimelineProps {
  store: TimelineStore;
  /** Chapters and events, oldest first. */
  marks?: readonly TimelineMark[] | undefined;
  /** The level the run began on, for the first band. */
  startLevel?: number | null | undefined;
  /** The run's active stretches; what lies between two is drawn as a gap. */
  sessions?: readonly { start: number; end: number | null }[] | undefined;
  /** The stretch of the run the feed has loaded. */
  feed?: Span | null | undefined;
  /** A scrub, where the page does more than move the focus (the map pauses and remembers). */
  onSeek?: ((ts: number) => void) | undefined;
  onToggle?: (() => void) | undefined;
  /** Whether anything is playing, where the store's own playback is not all there is (the camera's video). */
  playing?: boolean | undefined;
  /** The page's own steps; the marks otherwise. */
  steps?: TimelineSteps | undefined;
  /** The page's own controls, at the bar's right end. */
  children?: JSX.Element;
}

const pct = (f: number): string => `${(f * 100).toFixed(3)}%`;

export function Timeline(props: TimelineProps) {
  const tl = props.store;
  const [width, setWidth] = createSignal(1000);
  const [hover, setHover] = createSignal<number | null>(null);
  let track: HTMLDivElement | undefined;

  const span = tl.span;
  const shown = tl.shown;
  const usable = (): boolean => {
    const sp = span();
    return sp !== null && sp.to > sp.from;
  };
  const marks = (): readonly TimelineMark[] => props.marks ?? [];
  const inView = <T extends { ts: number }>(list: readonly T[]): T[] => {
    const v = shown();
    return v === null ? [] : list.filter((m) => m.ts >= v.from && m.ts <= v.to);
  };
  /** A stretch as the bar's `left` and `width`, clipped to the view; null when none of it is in view. */
  const place = (from: number, to: number): { left: string; width: string } | null => {
    const v = shown();
    if (v === null) return null;
    const a = Math.max(0, fractionOf(v, from));
    const b = Math.min(1, fractionOf(v, to));
    return b <= a ? null : { left: pct(a), width: pct(b - a) };
  };
  const bands = createMemo(() => {
    const sp = span();
    if (sp === null || sp.to <= sp.from) return [];
    return levelBands(marks(), sp, props.startLevel ?? null).flatMap((b, i) => {
      const at = place(b.from, b.to);
      return at === null ? [] : [{ ...b, at, alt: i % 2 === 1 }];
    });
  });
  /** The pauses: between one active stretch's end and the next one's start. */
  const gaps = createMemo(() => {
    const s = props.sessions ?? [];
    const out: { left: string; width: string }[] = [];
    for (let i = 1; i < s.length; i++) {
      const end = s[i - 1]!.end;
      if (end === null) continue;
      const at = place(end, s[i]!.start);
      if (at !== null) out.push(at);
    }
    return out;
  });
  const ticks = createMemo(() => {
    const sp = span();
    const v = shown();
    return sp === null || v === null ? [] : axisTicks(sp, v, width());
  });
  /** Where the playhead is across the view; null while it is off it (zoomed elsewhere). */
  const head = createMemo((): { f: number } | null => {
    const v = shown();
    if (v === null || !usable()) return null;
    const f = fractionOf(v, tl.at());
    return f < 0 || f > 1 ? null : { f };
  });
  /** How much of the view has played: all of it once the playhead is past its right edge. */
  const played = (): number => {
    const v = shown();
    return v === null || !usable() ? 0 : Math.min(1, Math.max(0, fractionOf(v, tl.at())));
  };

  const timeOf = (clientX: number): number | null => {
    const v = shown();
    if (v === null || track === undefined) return null;
    const box = track.getBoundingClientRect();
    return box.width <= 0 ? null : timeAt(v, (clientX - box.left) / box.width);
  };
  /** The mark within a few pixels of `ts`, or undefined. */
  const markNear = (ts: number): TimelineMark | undefined => {
    const v = shown();
    if (v === null) return undefined;
    const reach = ((v.to - v.from) * SNAP_PX) / Math.max(1, width());
    let best: TimelineMark | undefined;
    for (const m of marks()) if (Math.abs(m.ts - ts) <= reach && (best === undefined || Math.abs(m.ts - ts) < Math.abs(best.ts - ts))) best = m;
    return best;
  };
  const seek = (ts: number): void => {
    if (props.onSeek !== undefined) props.onSeek(ts);
    else {
      tl.setPlaying(false);
      tl.seek(ts, "timeline");
    }
  };
  const toggle = (): void => (props.onToggle ?? tl.toggle)();
  const playing = (): boolean => props.playing ?? tl.playing();

  /* The steps: the page's own, or from mark to mark. */
  const prevMark = (): TimelineMark | undefined => marks().filter((m) => m.ts < tl.at() - 500).at(-1);
  const nextMark = (): TimelineMark | undefined => marks().find((m) => m.ts > tl.at() + 500);
  const steps = (): TimelineSteps =>
    props.steps ?? {
      back: () => {
        const m = prevMark();
        if (m !== undefined) seek(m.ts);
      },
      forward: () => {
        const m = nextMark();
        if (m !== undefined) seek(m.ts);
      },
      canBack: prevMark() !== undefined,
      canForward: nextMark() !== undefined,
      noun: "mark",
    };

  /* One finger scrubs; two pinch the zoom about their midpoint, and neither scrubs again until both lift. */
  const fingers = new Map<number, number>();
  let pinched = false;
  let spread = 0;
  const onDown = (e: PointerEvent): void => {
    if (!usable() || track === undefined) return;
    fingers.set(e.pointerId, e.clientX);
    track.setPointerCapture?.(e.pointerId);
    if (fingers.size === 1 && !pinched) {
      const ts = timeOf(e.clientX);
      if (ts !== null) seek(markNear(ts)?.ts ?? ts);
    } else if (fingers.size === 2) {
      pinched = true;
      const [a, b] = [...fingers.values()];
      spread = Math.abs(a! - b!);
    }
  };
  const onMove = (e: PointerEvent): void => {
    if (!usable()) return;
    if (!fingers.has(e.pointerId)) {
      if (e.pointerType === "mouse") setHover(timeOf(e.clientX));
      return;
    }
    fingers.set(e.pointerId, e.clientX);
    if (fingers.size >= 2) {
      const [a, b] = [...fingers.values()];
      const now = Math.abs(a! - b!);
      const mid = timeOf((a! + b!) / 2);
      if (mid !== null && now > 0 && spread > 0) tl.zoom(mid, spread / now);
      spread = now;
      return;
    }
    if (pinched) return;
    const ts = timeOf(e.clientX);
    if (ts !== null) seek(ts);
    if (e.pointerType === "mouse") setHover(ts);
  };
  const onUp = (e: PointerEvent): void => {
    fingers.delete(e.pointerId);
    if (fingers.size === 0) pinched = false;
  };
  const onWheel = (e: WheelEvent): void => {
    const v = shown();
    if (!tl.zoomable() || v === null) return;
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) tl.pan(((v.to - v.from) * e.deltaX) / Math.max(1, width()));
    else {
      const ts = timeOf(e.clientX);
      if (ts !== null) tl.zoom(ts, e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    }
  };
  /** The overview strip: the view goes where the pointer is, across the whole run. */
  const onOverview = (e: PointerEvent): void => {
    e.stopPropagation();
    const sp = span();
    if (sp === null || (e.type === "pointermove" && e.buttons === 0 && e.pointerType === "mouse")) return;
    const el = e.currentTarget as HTMLElement;
    if (e.type === "pointerdown") el.setPointerCapture?.(e.pointerId);
    const box = el.getBoundingClientRect();
    if (box.width > 0) tl.centre(timeAt(sp, (e.clientX - box.left) / box.width));
  };
  const zoomBy = (factor: number): void => tl.zoom(tl.at(), factor);

  const onKey = (e: KeyboardEvent): void => {
    if (!usable() || e.altKey || e.ctrlKey || e.metaKey) return;
    if (keyBelongsToTarget((e.target as HTMLElement | null)?.tagName)) return;
    const action = playbackKey(e.key);
    if (action === null) return;
    e.preventDefault();
    const sp = span()!;
    if (action === "toggle") toggle();
    else if (action === "back") steps().back();
    else if (action === "forward") steps().forward();
    else seek(action === "start" ? sp.from : sp.to);
  };

  onMount(() => {
    const root = document.documentElement;
    root.classList.add("has-timeline");
    document.addEventListener("keydown", onKey);
    // Not passive: a wheel over a zoomable bar zooms it and must not scroll the page under it.
    track?.addEventListener("wheel", onWheel, { passive: false });
    const ro = typeof ResizeObserver === "undefined" || track === undefined ? null : new ResizeObserver(() => setWidth(track!.clientWidth || 1000));
    if (track !== undefined) ro?.observe(track);
    onCleanup(() => {
      root.classList.remove("has-timeline");
      document.removeEventListener("keydown", onKey);
      track?.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    });
  });

  const clock = (): string => {
    const sp = span();
    return sp === null ? "—" : `${fmtRunClock(tl.at() - sp.from)} / ${fmtRunClock(sp.to - sp.from)}`;
  };
  const tip = createMemo(() => {
    const ts = hover();
    const sp = span();
    const v = shown();
    if (ts === null || sp === null || v === null) return null;
    const m = markNear(ts);
    const at = m?.ts ?? ts;
    return { f: fractionOf(v, at), text: `${fmtRunClock(at - sp.from)} · ${stamp(at)}`, mark: m };
  });

  return (
    <div class="timeline" role="group" aria-label="timeline">
      <div class="timeline-controls transport playbar-row">
        <button class="tbtn" title={`previous ${steps().noun} (←)`} aria-label={`previous ${steps().noun}`} disabled={!usable() || !steps().canBack} onClick={() => steps().back()}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3h2v10H3zM13 3v10L6 8z" />
          </svg>
        </button>
        <button class="tbtn play" title={playing() ? "pause (space)" : "play (space)"} aria-label={playing() ? "pause" : "play"} disabled={!usable()} onClick={toggle}>
          <Show
            when={playing()}
            fallback={
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 2.5v11L13 8z" />
              </svg>
            }
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />
            </svg>
          </Show>
        </button>
        <button class="tbtn" title={`next ${steps().noun} (→)`} aria-label={`next ${steps().noun}`} disabled={!usable() || !steps().canForward} onClick={() => steps().forward()}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11 3h2v10h-2zM3 3v10l7-5z" />
          </svg>
        </button>
        <button class="tbtn speed mono" title="playback speed, against the run's own clock; idle gaps are skipped" disabled={!usable()} onClick={() => tl.cycleSpeed()}>
          {tl.speed()}×
        </button>
        <span class="tclock mono timeline-clock" title={span() === null ? undefined : `${stamp(tl.at())} · the focused time, of the run's length`}>
          {clock()}
        </span>
      </div>

      <div
        class="timeline-track"
        classList={{ zoomed: tl.view() !== null, off: !usable() }}
        ref={track}
        role="slider"
        tabindex={usable() ? 0 : -1}
        aria-label="focused time"
        aria-valuemin={span()?.from ?? 0}
        aria-valuemax={span()?.to ?? 0}
        aria-valuenow={Math.round(tl.at())}
        aria-valuetext={span() === null ? "" : fmtRunClock(tl.at() - span()!.from)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHover(null)}
      >
        <Show when={tl.view() !== null && span() !== null ? shown() : null}>
          {(v) => (
            <div class="timeline-overview" title="the whole run; drag to move the zoomed part" onPointerDown={onOverview} onPointerMove={onOverview}>
              <div class="timeline-window" style={{ left: pct(fractionOf(span()!, v().from)), width: pct(fractionOf(span()!, v().to) - fractionOf(span()!, v().from)) }} />
            </div>
          )}
        </Show>
        <div class="timeline-bar">
          <For each={bands()}>
            {(b) => (
              <div class="timeline-band" classList={{ alt: b.alt }} style={b.at}>
                <Show when={b.level !== null && (parseFloat(b.at.width) / 100) * width() >= BAND_LABEL_PX}>
                  <span>{b.level}</span>
                </Show>
              </div>
            )}
          </For>
          <For each={gaps()}>{(g) => <div class="timeline-gap" style={g} />}</For>
          <div class="timeline-played" style={{ width: pct(played()) }} />
          <For each={inView(marks())}>{(m) => <div class={`timeline-mark ${m.kind}`} style={{ left: pct(fractionOf(shown()!, m.ts)) }} />}</For>
        </div>
        <Show when={props.feed ? place(props.feed.from, Math.max(props.feed.to, props.feed.from + 1)) : null}>{(at) => <div class="timeline-feed" style={at()} />}</Show>
        <div class="timeline-axis">
          <For each={ticks()}>{(t) => <span style={{ left: pct(fractionOf(shown()!, t.ts)) }}>{t.label}</span>}</For>
        </div>
        <Show when={head()}>{(h) => <div class="timeline-head" style={{ left: pct(h().f) }} />}</Show>
        <Show when={tip()}>
          {(t) => (
            <div class="card timeline-tip" style={{ left: pct(Math.min(1, Math.max(0, t().f))) }}>
              <Show when={t().mark}>{(m) => <span class={`timeline-tip-mark ${m().kind}`}>{m().label}</span>}</Show>
              <span class="mono">{t().text}</span>
            </div>
          )}
        </Show>
      </div>

      <div class="timeline-end playbar-row">
        <Show when={tl.zoomable()}>
          <button class="tbtn" title="zoom out (wheel or pinch on the bar)" aria-label="zoom out" disabled={tl.view() === null} onClick={() => zoomBy(ZOOM_STEP * ZOOM_STEP)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 7h10v2H3z" />
            </svg>
          </button>
          <button class="tbtn" title="zoom in (wheel or pinch on the bar)" aria-label="zoom in" onClick={() => zoomBy(1 / (ZOOM_STEP * ZOOM_STEP))}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M7 3h2v4h4v2H9v4H7V9H3V7h4z" />
            </svg>
          </button>
          <Show when={tl.view() !== null}>
            <button class="playbar-btn" title="show the whole run" onClick={() => tl.fit()}>
              fit
            </button>
          </Show>
        </Show>
        <Show when={tl.live()}>
          <button
            class="playbar-btn timeline-live"
            classList={{ on: tl.following() }}
            title={tl.following() ? "following the run as it plays" : "jump to live: follow the run as it plays"}
            aria-pressed={tl.following()}
            onClick={() => tl.goLive()}
          >
            <span class={tl.following() ? "dot live" : "dot grey"} />
            {tl.following() ? "live" : "go live"}
          </button>
        </Show>
        {props.children}
      </div>
    </div>
  );
}
