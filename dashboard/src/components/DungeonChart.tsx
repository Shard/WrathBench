/**
 * A dungeon tab's scatter: one point per board row, at its best attempt,
 * placed by the view's two axes (`dungeonViews` in `lib/dungeons.ts`, where
 * the readings and their tests are): time from launch against bosses killed
 * by default, or the attempt's cost against either.
 *
 * Drawn as the ladder's scatter draws (`LadderChart`): the same frame, axes
 * and cue (`ChartParts`), the same label placement (`ladderChartLayout`), the
 * same cost axis with its decades and $0 gutter, the model's logo puck ringed
 * in its harness colour, and only the labels on the fronts standing
 * (`standingKeys`), the rest named while pointed at. The row the reader points
 * at, here or in the table, lights in both through the page's one hover
 * signal. A point is a link to its best attempt, as the table's "k of n" is.
 * There is no card: a board row has no means for one to read, so the point's
 * own hover says what it is.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { DungeonRowView, EpisodeIdView } from "../api/client";
import { COST } from "../lib/axes";
import { type DungeonPoint, type DungeonView, attemptHref, dungeonPoints, pointTitle, standingKeys } from "../lib/dungeons";
import { LABEL_FONT, type PlacedPoint, TICK_FONT, ladderChartLayout } from "../lib/ladder";
import { AxisFrame, Cue, Puck, VB_H, VB_W, XAxis, YAxis } from "./ChartParts";
import { InfoHint } from "./InfoHint";
import { harnessColour } from "./LadderChart";

const M = { top: 16, right: 24, bottom: 40, left: 64 };
const BOX = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/** The transparent hit target, as the scatter's. */
const HIT_R = 12;

export function DungeonChart(props: {
  rows: readonly DungeonRowView[];
  episode: EpisodeIdView;
  view: DungeonView;
  /** The row the reader is pointing at, shared with the table (`boardRowKey`). */
  hovered: string | null;
  onHover: (key: string | null) => void;
  /** The board's own rules, for the chart's note. */
  boardNote: string;
}) {
  const model = createMemo(() => dungeonPoints(props.rows, props.view));
  const standing = createMemo(() => standingKeys(model().points, props.view));
  const layout = createMemo(() => ladderChartLayout(model().points, BOX, props.view.x, props.view.y, standing()));
  const lit = (p: DungeonPoint): boolean => props.hovered === p.key;
  const named = (d: PlacedPoint<DungeonPoint>): boolean => d.labelled || lit(d.point);
  const colour = (p: DungeonPoint): string => harnessColour(p.row.harness === null ? [] : [p.row.harness]);
  const usesCost = (): boolean => props.view.x.scale === "log-cost";
  // A plain `<a>` under a `<g>`, routed by hand — the reason is `LadderChart`'s.
  const navigate = useNavigate();

  const note = (): string => {
    const lines = [
      `${props.view.hint}, one point per model condition at its best attempt: on a time axis, a cleared attempt at its time to clear and the rest at the time of their last boss. The best attempt is the table's, whatever the axes. Only the points on a front, of the cleared attempts or of the rest, are named; pointing at any other names it.`,
    ];
    if (usesCost()) lines.push(`${COST.note}, summed over the attempt's runs.`);
    lines.push(props.boardNote);
    if (model().omitted.length > 0) lines.push(`Not plotted: ${model().omitted.map((o) => `${o.label} (${o.why})`).join(", ")}.`);
    return lines.join("\n");
  };

  return (
    <div class="ladderchart-wrap">
      <Show
        when={model().points.length > 0}
        fallback={<div class="xpchart empty dim">nothing to plot for {props.episode} on {props.view.title}</div>}
      >
        <svg class="ladderchart" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={`${props.view.x.caption} against ${props.view.y.caption}, one point per model condition at its best ${props.episode} attempt`}>
          <YAxis ticks={layout().yTicks} py={layout().py} box={BOX} format={props.view.y.format} />
          {/* The cost axis's 2× and 5× inside each decade, as the ladder's scatter draws them. */}
          <For each={layout().xMinorTicks}>
            {(t) => <line x1={layout().px(t)} y1={BOX.y0} x2={layout().px(t)} y2={BOX.y1} stroke="var(--gridline)" opacity="0.4" />}
          </For>
          <XAxis ticks={layout().xTicks} px={layout().px} box={BOX} format={props.view.x.format} />
          {/* The $0 gutter, as the ladder's scatter draws it: a reported $0 is a reading, not a small price. */}
          <Show when={layout().hasFree}>
            <line x1={layout().dividerX} y1={BOX.y0} x2={layout().dividerX} y2={BOX.y1} stroke="var(--line)" stroke-dasharray="2 4" opacity="0.7" />
            <text text-anchor="middle" font-size={String(TICK_FONT)} fill="var(--dim)">
              <tspan x={layout().freeX} y={BOX.y0 + 17}>
                $0
              </tspan>
              <tspan x={layout().freeX} y={BOX.y0 + 29}>
                reported
              </tspan>
            </text>
          </Show>
          <AxisFrame box={BOX} xCaption={props.view.x.caption} yCaption={props.view.y.caption} />
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
                <title>{pointTitle(d.point, props.view.route)}</title>
                <a
                  href={attemptHref(d.point.row)}
                  aria-label={pointTitle(d.point, props.view.route)}
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
