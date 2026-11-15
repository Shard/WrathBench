/**
 * A dungeon tab's scatter: one point per board row, at its best attempt —
 * time from launch against bosses killed (`dungeonPoints` in
 * `lib/dungeons.ts`, where the reading and its tests are).
 *
 * Drawn as the ladder's scatter draws (`LadderChart`): the same frame, axes
 * and cue (`ChartParts`), the same label placement (`ladderChartLayout`), the
 * model's logo puck ringed in its harness colour, and only the labels on the
 * fronts standing (`standingKeys`), the rest named while pointed at. The row the reader points
 * at, here or in the table, lights in both through the page's one hover
 * signal. A point is a link to its best attempt, as the table's "k of n" is.
 * There is no card: a board row has no means for one to read, so the point's
 * own hover says what it is.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { DungeonRowView, EpisodeIdView } from "../api/client";
import { type DungeonPoint, attemptHref, bossTicks, clearTimeTicks, dungeonPoints, pointTitle, standingKeys } from "../lib/dungeons";
import { fmtPlaytimeTick } from "../lib/format";
import { LABEL_FONT, type PlacedPoint, ladderChartLayout } from "../lib/ladder";
import { AxisFrame, Cue, Puck, VB_H, VB_W, XAxis, YAxis } from "./ChartParts";
import { InfoHint } from "./InfoHint";
import { harnessColour } from "./LadderChart";

const M = { top: 16, right: 24, bottom: 40, left: 64 };
const BOX = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/** The transparent hit target, as the scatter's. */
const HIT_R = 12;

const X_SPEC = { scale: "linear", ticks: clearTimeTicks, better: "lower" } as const;
const Y_SPEC = { ticks: bossTicks, better: "higher" } as const;

const X_CAPTION = "time from launch to the clear, or to the last boss";
const Y_CAPTION = "bosses killed, of 8";

export function DungeonChart(props: {
  rows: readonly DungeonRowView[];
  episode: EpisodeIdView;
  /** The row the reader is pointing at, shared with the table (`boardRowKey`). */
  hovered: string | null;
  onHover: (key: string | null) => void;
  /** The board's own rules, for the chart's note. */
  boardNote: string;
}) {
  const model = createMemo(() => dungeonPoints(props.rows));
  const standing = createMemo(() => standingKeys(model().points));
  const layout = createMemo(() => ladderChartLayout(model().points, BOX, X_SPEC, Y_SPEC, standing()));
  const lit = (p: DungeonPoint): boolean => props.hovered === p.key;
  const named = (d: PlacedPoint<DungeonPoint>): boolean => d.labelled || lit(d.point);
  const colour = (p: DungeonPoint): string => harnessColour(p.row.harness === null ? [] : [p.row.harness]);
  // A plain `<a>` under a `<g>`, routed by hand — the reason is `LadderChart`'s.
  const navigate = useNavigate();

  const note = (): string => {
    const lines = [
      `Time from launch against bosses killed, one point per model condition at its best attempt: a cleared attempt at its time to clear, the rest at the time of their last boss. The order is the table's, cleared rows first. Only the points on a front, of the cleared attempts or of the rest, are named; pointing at any other names it.`,
      props.boardNote,
    ];
    if (model().omitted.length > 0) lines.push(`Not plotted: ${model().omitted.map((o) => `${o.label} (${o.why})`).join(", ")}.`);
    return lines.join("\n");
  };

  return (
    <div class="ladderchart-wrap">
      <Show
        when={model().points.length > 0}
        fallback={<div class="xpchart empty dim">nothing to plot for {props.episode}: no counted attempt killed a boss</div>}
      >
        <svg class="ladderchart" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={`${X_CAPTION} against ${Y_CAPTION}, one point per model condition at its best ${props.episode} attempt`}>
          <YAxis ticks={layout().yTicks} py={layout().py} box={BOX} format={String} />
          <XAxis ticks={layout().xTicks} px={layout().px} box={BOX} format={fmtPlaytimeTick} />
          <AxisFrame box={BOX} xCaption={X_CAPTION} yCaption={Y_CAPTION} />
          <Cue cue={layout().cue} />
          <For each={layout().placed}>
            {(d) => (
              <g
                class="ladderchart-pt"
                classList={{ hovered: lit(d.point) }}
                data-entry={d.point.key}
                onPointerEnter={() => props.onHover(d.point.key)}
                onPointerLeave={() => props.onHover(null)}
              >
                <title>{pointTitle(d.point)}</title>
                <a
                  href={attemptHref(d.point.row)}
                  aria-label={pointTitle(d.point)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(e.currentTarget.getAttribute("href") ?? "/ladder");
                  }}
                >
                  <Show when={named(d) && d.leader}>
                    {(l) => <line class="chart-leader" x1={l().x1} y1={l().y1} x2={l().x2} y2={l().y2} stroke="var(--dim)" stroke-width="1" opacity="0.6" />}
                  </Show>
                  <circle cx={d.cx} cy={d.cy} r={HIT_R} fill="transparent" />
                  <Puck
                    cx={d.cx}
                    cy={d.cy}
                    model={d.point.model}
                    stroke={colour(d.point)}
                    ring
                    fallback={<circle cx={d.cx} cy={d.cy} r={5} fill={colour(d.point)} stroke="var(--bg)" stroke-width="1.5" />}
                  />
                  <Show when={named(d)}>
                    <text class={d.crowded ? "crowded" : undefined} x={d.labelX} y={d.labelY} text-anchor={d.anchor} font-size={String(LABEL_FONT)} fill="var(--fg)">
                      {d.point.label}
                    </text>
                  </Show>
                </a>
              </g>
            )}
          </For>
        </svg>
      </Show>
      <div class="chart-note">
        <InfoHint label="about this chart" text={note()} />
      </div>
    </div>
  );
}
