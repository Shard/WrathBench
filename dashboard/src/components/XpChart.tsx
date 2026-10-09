/**
 * Cumulative XP over a run, with the levels drawn as bands on the y-axis.
 *
 * This is the simple version: inline SVG, laid out by hand, good for the dozen-
 * to-few-hundred samples a run records. A denser series (many runs overlaid, or
 * a high-frequency tap) is the case for a real plotting library — uPlot is the
 * intended one — but that is a dependency this page has not earned yet, so it
 * stays hand-drawn until a trajectory asks for more.
 *
 * The curve is a lower bound; see `lib/runview.ts` for why. The bands and the
 * curve are computed together there, so they always agree.
 */

import { For, Show, createMemo } from "solid-js";
import type { StatePoint } from "@viewer/api-types";
import { scaleLinear } from "../lib/chart";
import { xpChartModel } from "../lib/runview";
import { VB_W } from "./ChartParts";

/** Elapsed wall-clock label for an x tick: "mm:ss", or "Hh Mm" past an hour — shorter than `fmtElapsed`, which is a reading, not a tick. */
function tickLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Two sizes of one drawing. The full one takes the shared width and a strip's
 * height. The compact one is a sidebar card: a viewBox near the card's own
 * pixel width, so the tick text stays legible scaled down, and only the labels
 * that orient a reader — the first and last level, the two ends of the axis.
 */
const FULL = { w: VB_W, h: 200, m: { top: 12, right: 14, bottom: 24, left: 48 }, ticks: 5, tickY: 15 };
const COMPACT = { w: 300, h: 100, m: { top: 6, right: 6, bottom: 16, left: 26 }, ticks: 1, tickY: 13 };

export function XpChart(props: {
  states: readonly StatePoint[];
  startedAt: number | null;
  endedAt: number | null;
  episodeMs: number | null;
  now: number;
  /**
   * Session boundaries, in the same units as the samples' `ts`
   * (`@viewer/sessions`): one per resume on a run's own chart, and on a
   * character's one per resume and per attempt after the first, because a
   * curve laid across twelve sessions with nothing marking where they met
   * reads as one long climb.
   */
  seams?: readonly { at: number; label: string }[];
  /** The sidebar card's size: fewer labels, and no frame of its own (the card is the frame). */
  compact?: boolean;
}) {
  const size = props.compact === true ? COMPACT : FULL;
  const M = size.m;
  const model = createMemo(() =>
    xpChartModel(props.states, {
      startedAt: props.startedAt,
      endedAt: props.endedAt,
      episodeMs: props.episodeMs,
      now: props.now,
    }),
  );

  const plot = { x0: M.left, x1: size.w - M.right, y0: size.h - M.bottom, y1: M.top };
  const px = (ts: number): number => scaleLinear([model().t0, model().t1], [plot.x0, plot.x1])(ts);
  const py = (cum: number): number => scaleLinear([0, model().yMax], [plot.y0, plot.y1])(cum);

  const path = createMemo(() =>
    model()
      .points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.ts).toFixed(1)},${py(p.cum).toFixed(1)}`)
      .join(" "),
  );

  /* Evenly spaced time ticks across the window: a handful, or just the two ends. */
  const ticks = createMemo(() => {
    const m = model();
    const n = size.ticks;
    return Array.from({ length: n + 1 }, (_, i) => {
      const ts = m.t0 + ((m.t1 - m.t0) * i) / n;
      // The last tick ends at the plot's edge rather than centring on it, which
      // pushed "21h 37m" out of the viewBox; the compact axis's first tick
      // starts at the other edge for the same reason.
      const anchor: "start" | "middle" | "end" = i === n ? "end" : n > 1 ? "middle" : "start";
      return { ts, label: tickLabel(ts - m.t0), anchor };
    });
  });

  /* Which bands carry a label: every one, or only the first and the last. */
  const labelled = (i: number): boolean => props.compact !== true || i === 0 || i === model().bands.length - 1;

  return (
    <Show
      when={model().points.length >= 2}
      fallback={
        // A span in the compact card, which is a button and takes phrasing content only.
        props.compact === true ? (
          <span class="sub">no xp yet</span>
        ) : (
          <div class="xpchart empty dim">no xp recorded yet — the chart appears once the run reports progress</div>
        )
      }
    >
      {/* No preserveAspectRatio="none": stretching the viewBox to a fixed CSS height crushes the tick text. */}
      <svg
        class={props.compact === true ? "xpchart compact" : "xpchart"}
        viewBox={`0 0 ${size.w} ${size.h}`}
        role="img"
        aria-label="cumulative xp with level bands"
      >
        <title>cumulative xp over time, level bands on the y-axis</title>
        {/* Axes */}
        <line x1={plot.x0} y1={plot.y0} x2={plot.x1} y2={plot.y0} stroke="var(--line)" />
        <line x1={plot.x0} y1={plot.y1} x2={plot.x0} y2={plot.y0} stroke="var(--line)" />

        {/* Level bands: a gridline at the cumulative xp where each level began. */}
        <For each={model().bands}>
          {(b, i) => (
            <>
              <line x1={plot.x0} y1={py(b.cum)} x2={plot.x1} y2={py(b.cum)} stroke="var(--gridline)" stroke-dasharray="3 3" />
              <Show when={labelled(i())}>
                <text x={plot.x0 - 6} y={py(b.cum) + 3} text-anchor="end" font-size="11" fill="var(--dim)">
                  L{b.level}
                </text>
              </Show>
            </>
          )}
        </For>

        {/* Time ticks along the bottom. */}
        <For each={ticks()}>
          {(t) => (
            <text x={px(t.ts)} y={plot.y0 + size.tickY} text-anchor={t.anchor} font-size="11" fill="var(--dim)">
              {t.label}
            </text>
          )}
        </For>

        {/* Session boundaries, when the caller has any: where a pause was
            closed, or one attempt met the next. Drawn under the curve so the
            curve stays the thing being read. */}
        <For each={props.seams ?? []}>
          {(seam) => (
            <Show when={seam.at > model().t0 && seam.at < model().t1}>
              <line
                x1={px(seam.at)}
                y1={plot.y1}
                x2={px(seam.at)}
                y2={plot.y0}
                stroke="var(--dim)"
                stroke-dasharray="2 4"
                opacity="0.7"
              >
                <title>{seam.label}</title>
              </line>
            </Show>
          )}
        </For>

        {/* The cumulative-xp curve. */}
        <path d={path()} fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
      </svg>
    </Show>
  );
}
