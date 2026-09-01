/**
 * The freeplay field as a graph: one stepped series per stream, level against
 * cumulative active playtime.
 *
 * Same family as `XpChart` and `LadderChart` — inline SVG laid out by hand, no
 * plotting dependency, palette tokens so both themes work. The derivation, the
 * stitching across a stream's attempts and the axis argument all live in
 * `lib/ladder.ts` (`streamSeries`, `streamChartLayout`), where the tests are;
 * this file only draws what those return.
 *
 * A stream's status is drawn the way the table below states it: `--ok` live,
 * `--warn` paused, `--dim` ended, with the line dashed once it has ended so the
 * distinction survives a reader who does not separate those hues. Every series
 * runs flat to its own total active time — an ended stream did not stop
 * existing at its last ding — and for a live one that total is computed against
 * "now" by the viewer, so its line ends at the present with a filled marker.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { ResultRun } from "@viewer/api-types";
import {
  LABEL_FONT,
  type ChartBox,
  type StreamRow,
  type StreamStatus,
  streamChartLayout,
  streamIconCx,
  streamSeries,
} from "../lib/ladder";
import { AxisFrame, Puck, VB_H, VB_W, XAxis, YAxis } from "./ChartParts";
import { fmtDuration } from "../lib/format";

const M = { top: 16, right: 178, bottom: 40, left: 52 };
const BOX: ChartBox = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/*
 * The model's logo at the end of its line (operator, 2026-08-29): a reader
 * looking at the field wants to know which character is which model, and the
 * character label alone does not say. Exactly `LadderChart`'s mark — the shared
 * `Puck`, with the `lib/lineup` monogram it falls back to for an id no family
 * claims, so a stream is never left with a hole where every other one has a
 * badge. It sits between the status marker and the character label: the marker
 * still carries status, the badge carries identity, and the label is untouched.
 *
 * It is anchored to the *marker*'s y, not the label's. `labelY` slides down to
 * clear a label already placed, so a badge drawn against it would float free of
 * its own line and sit between two of them, naming neither; on the line's end it
 * always names the line it is on, and the label finds its own row as before —
 * with a leader from the badge once it is more than a row away
 * (`streamChartLayout`). The offsets are the layout's (`streamIconCx`,
 * `streamLabelX`), because the leader has to end where the label begins.
 */
const iconCx = streamIconCx;

/** The colour of a stream's line: exactly the class the table's status cell takes. */
function statusColour(status: StreamStatus): string {
  return status === "live" ? "var(--ok)" : status === "paused" ? "var(--warn)" : "var(--dim)";
}

/** A playtime tick: whole hours past an hour, minutes below it. */
function fmtPlaytimeTick(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

export function StreamChart(props: { rows: readonly StreamRow[]; runs: readonly ResultRun[] }) {
  const model = createMemo(() => streamSeries(props.rows, props.runs));
  // A plain `<a>` under a `<g>`, and the click routed by hand: the router's
  // `<A>` roots its template in the HTML namespace, which breaks inside an SVG.
  // Same reason, same shape, as `LadderChart`.
  const navigate = useNavigate();
  const layout = createMemo(() => streamChartLayout(model().series, BOX));
  const anyTruncated = (): boolean => model().series.some((s) => s.truncated);

  return (
    <div class="ladderchart-wrap">
      <Show
        when={model().series.length > 0}
        fallback={
          <div class="xpchart empty dim">
            nothing to plot: no stream carries a level mark with an active-time reading
          </div>
        }
      >
        <svg
          class="ladderchart"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          role="img"
          aria-label="level against cumulative active playtime, one stepped series per freeplay stream"
        >
          <title>level against cumulative active playtime, one series per freeplay character</title>

          {/* Level gridlines. The axis is anchored at zero so a two-level gain
              is not the whole chart, but nothing is ever level 0 — that
              gridline goes unlabelled rather than naming a level no one has. */}
          <YAxis ticks={layout().yTicks} py={layout().py} box={BOX} format={(t) => (t > 0 ? `L${t}` : null)} />
          {/* Playtime ticks along the bottom. */}
          <XAxis ticks={layout().xTicks} px={layout().px} box={BOX} format={fmtPlaytimeTick} />
          <AxisFrame box={BOX} xCaption="active playtime, stitched across attempts" yCaption="level" />

          {/* One stepped line per stream, labelled at its end with the character. */}
          <For each={layout().placed}>
            {(p) => (
              <g class="streamchart-series">
                <a
                  href={`/run/${encodeURIComponent(p.series.latestRunId)}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(e.currentTarget.getAttribute("href") ?? "/ladder");
                  }}
                >
                  <title>
                    {[
                      `${p.series.label} (${p.series.model}${p.series.effort === null ? "" : `, ${p.series.effort}`})`,
                      `${p.series.status}${p.series.attempts > 1 ? `, ${p.series.attempts} attempts` : ""}`,
                      `L${p.series.endLevel} after ${fmtDuration(p.series.endX)} of active play`,
                      p.series.truncated ? "history before the oldest attempt served is not drawn" : "",
                    ]
                      .filter((l) => l.length > 0)
                      .join("\n")}
                  </title>
                  {/* A hit target wider than the line, for the reason
                      `LadderChart` gives one to its 5px puck: a 2px stroke is
                      not something a pointer can be asked to find. */}
                  <path d={p.d} fill="none" stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke" />
                  <path
                    d={p.d}
                    fill="none"
                    stroke={statusColour(p.series.status)}
                    stroke-width={p.series.status === "live" ? 2 : 1.5}
                    stroke-dasharray={p.series.status === "ended" ? "5 4" : undefined}
                    vector-effect="non-scaling-stroke"
                  />
                  {/* The end marker: filled while the stream is going somewhere,
                      hollow once it has ended. */}
                  <circle
                    cx={p.endCx}
                    cy={p.endCy}
                    r={3.5}
                    fill={p.series.status === "ended" ? "var(--panel)" : statusColour(p.series.status)}
                    stroke={statusColour(p.series.status)}
                    stroke-width="1.5"
                  />
                  {/* The model, as its family's logo. `aria-label` names it in
                      words; the anchor's own <title> above already reads
                      "<character> (<model>)" for a pointer. */}
                  <g class="streamchart-logo" role="img" aria-label={`model: ${p.series.model}`}>
                    <Puck cx={iconCx(p.endCx)} cy={p.endCy} model={p.series.model} stroke={statusColour(p.series.status)} strokeWidth={1} />
                  </g>
                  <Show when={p.leader}>
                    {(l) => (
                      <line
                        class="chart-leader"
                        x1={l().x1}
                        y1={l().y1}
                        x2={l().x2}
                        y2={l().y2}
                        stroke="var(--dim)"
                        stroke-width="1"
                        opacity="0.6"
                      />
                    )}
                  </Show>
                  <text x={p.labelX} y={p.labelY} text-anchor="start" font-size={String(LABEL_FONT)} fill="var(--fg)">
                    <Show when={p.series.truncated}>
                      <tspan fill="var(--dim)">…</tspan>
                    </Show>
                    {p.series.label}
                    <Show when={p.series.attempts > 1}>
                      <tspan fill="var(--dim)"> ×{p.series.attempts}</tspan>
                    </Show>
                  </text>
                </a>
              </g>
            )}
          </For>
        </svg>
      </Show>

      <p class="dim ladderchart-caption">
        level against cumulative <strong>active playtime</strong>, one series per stream, stitched across its
        attempts. Wall clock would draw the days a stream spends paused rather than the character's progress,
        and turn indices restart on a resume, so the axis is the pause-corrected active time each level mark
        already carries. A line is a step, never a slope: a mark is the first sample that showed a level, so
        the level is held flat until the next one — a lower bound on when the ding happened. Colour:{" "}
        <span style={{ color: "var(--ok)" }}>●</span> live (the line ends at now){" "}
        <span style={{ color: "var(--warn)" }}>●</span> paused{" "}
        <span style={{ color: "var(--dim)" }}>●</span> ended (dashed), the same three the status column reads.
        Each line ends with its model's family logo — the scatter's mark, and the same badge the table's
        model column carries — because the character label does not say which model is playing it.
        <Show when={anyTruncated()}>
          {" "}
          A label with a leading … begins mid-history: that stream's oldest served attempt still names a
          predecessor this viewer did not serve, so its axis starts from the oldest attempt on screen.
        </Show>
        <Show when={model().omitted.length > 0}>
          {" "}
          Not plotted: {model().omitted.map((o) => `${o.label} (${o.why})`).join(", ")}.
        </Show>
      </p>
    </div>
  );
}
