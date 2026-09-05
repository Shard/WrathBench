/**
 * The ladder's scatter: one point per roster entry on the selected tier, a
 * resource spent per run against a distance reached — by default average
 * cost against average XP earned, and any other pair `lib/axes.ts` offers.
 *
 * Hand-drawn inline SVG, like `XpChart` — a roster is a few dozen points at
 * most, and a chart library is a dependency this dashboard has not earned.
 * The aggregation and label placement are `lib/ladder.ts`, where its tests
 * are; the scale and tick maths are the shared `lib/chart.ts`; what each axis
 * is called, how it is ticked and what caveat travels with it is the view's
 * two `AxisSpec`s. This file only draws what those return. Colours come from
 * the palette tokens so both themes work; the only data-driven colour is the
 * harness tag, which follows the same semantics as the table's `HarnessTag`.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { ResultRun } from "@viewer/api-types";
import { AXES, type AxisSpec, DEFAULT_VIEW, type LadderView, METRIC_KEYS } from "../lib/axes";
import { LABEL_FONT, TICK_FONT, type LadderPoint, ladderChartLayout, ladderPoints } from "../lib/ladder";
import { paretoSteps } from "../lib/pareto";
import { AxisFrame, Cue, Puck, VB_H, VB_W, XAxis, YAxis } from "./ChartParts";
import { COST_BASIS_NOTE, fmtTokens, fmtUsd } from "../lib/format";
import { runsHref } from "../lib/runs";

const M = { top: 16, right: 24, bottom: 40, left: 64 };
const BOX = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/** The transparent hit target: comfortably wider than the mark, which is small. */
const HIT_R = 12;

/** The colour of a point's ring: the harness that owned its runs, or neither when mixed. */
function harnessColour(harnesses: readonly string[]): string {
  if (harnesses.length === 1 && harnesses[0] === "claude-code") return "var(--claude)";
  if (harnesses.length === 1 && harnesses[0] === "codex") return "var(--codex)";
  if (harnesses.length === 1 && harnesses[0] === "wrathbench") return "var(--accent)";
  return "var(--dim)";
}

/** The dash pattern that marks a mean resting on one run. Nothing else on the chart is dashed but the gridlines. */
const SINGLE_DASH = "2 2";

/**
 * The hover's reading of the price. Basis (who produced the figure) and
 * as-if-metered (whether anyone paid it) are two facts, not one: a claude-code
 * run is reported AND as-if-metered, so the qualifier attaches to whichever
 * basis the runs had rather than only to list-price. A null basis is an entry
 * none of whose counted runs carries a price, which a cost axis never plots.
 */
export function pricedText(p: Pick<LadderPoint, "basis" | "asIfMetered">): string {
  if (p.basis === null) return "unpriced";
  const basis =
    p.basis === "reported" ? "reported" : p.basis === "list-price" ? "list-price est." : "reported and list-price est. mixed";
  if (!p.asIfMetered) return basis;
  return p.basis === "mixed" ? `${basis}, some as-if-metered` : `as-if-metered (${basis})`;
}

/**
 * A mean in the hover. The tick format is built for round ticks, so an
 * unrounded mean gets a little more: dollars through `fmtUsd`, a level to one
 * decimal, a count rounded and grouped, and the rest as the tick prints them.
 */
function fmtHover(spec: AxisSpec, v: number): string {
  if (spec.key === "cost") return fmtUsd(v);
  if (spec.key === "level") return `L${v.toFixed(1)}`;
  if (spec.key === "xp" || spec.key === "turns" || spec.key === "toolCalls") return Math.round(v).toLocaleString();
  if (spec.key === "tokens") return fmtTokens(v);
  return spec.format(v);
}

/** One axis's line in the hover: the caption, then the mean — with the basis qualifier when the axis is cost. */
function axisLine(p: LadderPoint, v: number, spec: AxisSpec, episode: string): string {
  const reading = spec.key === "cost" ? `${fmtHover(spec, v)} (${pricedText(p)})` : fmtHover(spec, v);
  return `${spec.caption(episode)}: ${reading}`;
}

/** "a cost", "an xp": the article a label takes in the omission sentences. */
const article = (label: string): string => (/^[aeiou]/i.test(label) || label === "xp" ? "an" : "a");

/**
 * The hover text of one mark: what both means rest on, what was left out,
 * the two axes' readings, and the other means the same runs carry.
 */
export function hoverText(p: LadderPoint, episode: string, view: LadderView = DEFAULT_VIEW): string {
  const left = p.runs - p.n;
  const over =
    left === 0
      ? `over ${p.n === 1 ? "one run" : `${p.n} runs`}`
      : `over ${p.n} of ${p.runs} counted runs — ${left} lack${left === 1 ? "s" : ""} ${article(view.x.label)} ${
          view.x.label
        } or ${article(view.y.label)} ${view.y.label} reading and feed${left === 1 ? "s" : ""} neither mean`;
  // The rest of the bag, for the metrics that have a spec: means over the same
  // `n` runs, so nothing here rests on a different set than the mark does.
  const also = METRIC_KEYS.flatMap((k) => {
    const spec = AXES[k];
    const v = p.metrics[k];
    if (spec === null || v === null || k === view.x.key || k === view.y.key) return [];
    return [`${spec.label} ${fmtHover(spec, v)}`];
  });
  return [
    `${p.key} — ${over}`,
    axisLine(p, p.x, view.x, episode),
    axisLine(p, p.y, view.y, episode),
    ...(also.length > 0 ? [`also: ${also.join(", ")}`] : []),
  ].join("\n");
}

/**
 * `pareto` draws the front over the field rather than filtering to it: the
 * step line through the undominated entries (`paretoSteps`, which reads
 * `better` off the view's specs), and every other point — label included —
 * dimmed, so a reader sees who is on the front without losing the field.
 */
export function LadderChart(props: { runs: readonly ResultRun[]; episode: string; view?: LadderView; pareto?: boolean }) {
  const view = (): LadderView => props.view ?? DEFAULT_VIEW;
  const model = createMemo(() => ladderPoints(props.runs, view().x, view().y));
  const layout = createMemo(() => ladderChartLayout(model().points, BOX, view().x, view().y));
  const front = createMemo(() =>
    props.pareto ? paretoSteps(model().points, { x: view().x.better, y: view().y.better }) : null,
  );
  const onFront = (key: string): boolean => front()?.front.some((p) => p.key === key) ?? true;
  /** The staircase, in viewBox units: the same `px`/`py` the points were placed with. */
  const frontPath = (): string =>
    (front()?.steps ?? [])
      .map((s) => `M${layout().px(s.x1).toFixed(1)},${layout().py(s.y1).toFixed(1)} L${layout().px(s.x2).toFixed(1)},${layout().py(s.y2).toFixed(1)}`)
      .join(" ");
  const xpKnown = (): boolean => props.runs.some((r) => r.xpEarned !== undefined);
  const xCaption = (): string => view().x.caption(props.episode);
  const yCaption = (): string => view().y.caption(props.episode);
  // A plain `<a>` under a `<g>` rather than the router's `<A>`: the router's
  // renders an HTML anchor, and a template rooted at `<a>` is created in the
  // HTML namespace too (Solid decides by the root tag); a `<g>` root puts the
  // whole subtree in the SVG namespace. The click is routed in-app the same way.
  const navigate = useNavigate();

  return (
    <div class="ladderchart-wrap">
      <Show
        when={model().points.length > 0}
        fallback={
          <div class="xpchart empty dim">
            nothing to plot for {props.episode}: no counted run carries both {article(view().x.label)}{" "}
            {view().x.label} reading and {article(view().y.label)} {view().y.label} reading
            <Show when={props.runs.length > 0 && view().y.key === "xp" && !xpKnown()}>
              {" "}
              — the viewer predates <span class="mono">xpEarned</span> and needs a restart
            </Show>
          </div>
        }
      >
        <svg
          class="ladderchart"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          role="img"
          aria-label={`${xCaption()} against ${yCaption()}, one point per model and effort, each the mean of that entry's counted runs`}
        >
          <title>
            {xCaption()} against {yCaption()}, one point per model and effort, each the mean of that entry's
            counted runs
          </title>

          {/* Gridlines and ticks: the same px/py the points were placed with. */}
          <YAxis ticks={layout().yTicks} py={layout().py} box={BOX} format={view().y.format} />
          {/*
           * The cost axis is logarithmic, so it gets the faint vertical lines
           * the linear one did not need: the 2× and 5× inside each decade,
           * without which the eye has no way to read a distance between two
           * decade labels. The decades themselves keep the tick mark below
           * the axis they always had — a full-height line at every decade on
           * top of these would be more chrome than data. A linear x axis has
           * no minor ticks; its ticks are the same marks and labels.
           */}
          <For each={layout().xMinorTicks}>
            {(t) => (
              <line
                x1={layout().px(t)}
                y1={BOX.y0}
                x2={layout().px(t)}
                y2={BOX.y1}
                stroke="var(--gridline)"
                opacity="0.4"
              />
            )}
          </For>
          <XAxis ticks={layout().xTicks} px={layout().px} box={BOX} format={view().x.format} />

          {/*
           * The $0 gutter. A $0 entry is a reading and not a small price, so
           * it sits left of the axis with its own label, divided off, and is
           * never interpolated against the decades. It is drawn only when
           * something in view reported costing nothing. Labelled "$0
           * reported" and not "free": the page's free filter is the billing
           * verdict, and a paid endpoint that reports $0 (a stealth preview)
           * lands here with free excluded — the coordinate is the honest test,
           * the word "free" would contradict the caption. Two lines, because
           * the gutter is 54 units wide and "$0 reported" on one line ran
           * into the 1¢ tick beside it.
           */}
          <Show when={layout().hasFree}>
            <line
              x1={layout().dividerX}
              y1={BOX.y0}
              x2={layout().dividerX}
              y2={BOX.y1}
              stroke="var(--line)"
              stroke-dasharray="2 4"
              opacity="0.7"
            />
            <text text-anchor="middle" font-size={String(TICK_FONT)} fill="var(--dim)">
              <tspan x={layout().freeX} y={BOX.y0 + 17}>
                $0
              </tspan>
              <tspan x={layout().freeX} y={BOX.y0 + 29}>
                reported
              </tspan>
            </text>
          </Show>

          <AxisFrame box={BOX} xCaption={xCaption()} yCaption={yCaption()} />
          <Cue cue={layout().cue} />

          {/* The front's staircase, under the points: a run along x to the
              next member, then a rise along y to it. Dim and thin, like a
              leader — it is a reading of the points, not data of its own. */}
          <Show when={front() !== null && front()!.steps.length > 0}>
            <path class="chart-front" d={frontPath()} fill="none" stroke="var(--dim)" stroke-width="1" opacity="0.7" />
          </Show>

          {/* Points, each a link to that entry's runs on this tier. */}
          <For each={layout().placed}>
            {(d) => (
              <g class="ladderchart-pt" classList={{ dominated: !onFront(d.point.key) }}>
              <a
                href={runsHref({ model: d.point.model, effort: d.point.effort, episode: props.episode })}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(e.currentTarget.getAttribute("href") ?? "/runs");
                }}
              >
                <title>{hoverText(d.point, props.episode, view())}</title>
                {/*
                 * A displaced label's leader: first in the group, so it sits
                 * under the puck and the label and over the gridlines drawn
                 * before the points. Dim and thin — it is a pointer, not data —
                 * and it brightens with the rest of the point on hover.
                 */}
                <Show when={d.leader}>
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
                {/* A hit target wider than the mark. */}
                <circle cx={d.cx} cy={d.cy} r={HIT_R} fill="transparent" />
                {/*
                 * The mark is the model's logo on a puck (`Puck`), and the
                 * harness keeps the point's colour as the puck's ring, so the
                 * legend below still says what it always said; the
                 * page-coloured separation ring is what tells two pucks apart
                 * when they land on top of each other. A model no family
                 * claims has no logo and keeps the coloured dot, the same
                 * fallback every other render site takes for it.
                 */}
                <Puck
                  cx={d.cx}
                  cy={d.cy}
                  model={d.point.model}
                  stroke={harnessColour(d.point.harnesses)}
                  dash={d.point.single ? SINGLE_DASH : undefined}
                  ring
                  fallback={
                    <circle
                      cx={d.cx}
                      cy={d.cy}
                      r={5}
                      fill={d.point.single ? "var(--bg)" : harnessColour(d.point.harnesses)}
                      stroke={d.point.single ? harnessColour(d.point.harnesses) : "var(--bg)"}
                      stroke-width="1.5"
                      stroke-dasharray={d.point.single ? SINGLE_DASH : undefined}
                    />
                  }
                />
                {/* `crowded` is a label every slot failed, drawn over something
                    anyway (a hidden label is worse than an ugly one); the class
                    is a hook for the eye and for a scripted check, not a hide. */}
                <text
                  class={d.crowded ? "crowded" : undefined}
                  x={d.labelX}
                  y={d.labelY}
                  text-anchor={d.anchor}
                  font-size={String(LABEL_FONT)}
                  fill="var(--fg)"
                >
                  {d.point.label}
                </text>
              </a>
              </g>
            )}
          </For>
        </svg>
      </Show>

      {/* Axes, sample basis, each axis's caveat — the things a stranger would
          otherwise assume, and assume wrongly. The hover carries the rest. The
          caveats are the specs' own, so a view that swaps an axis swaps its
          sentence; cost's basis note is the one every page uses and rides with
          cost wherever it is drawn. */}
      <p class="dim ladderchart-caption">
        {xCaption()} against {yCaption()}, one point per model and effort. A dashed ring means the means rest
        on a single run. {view().x.note}
        {view().x.key === "cost" ? `; ${COST_BASIS_NOTE}` : ""}. {view().y.note}
        {view().y.key === "cost" ? `; ${COST_BASIS_NOTE}` : ""}.
        <Show when={front() !== null}>
          {" "}
          The step line is the Pareto front: the entries no other entry beats on both axes (
          {view().x.better === "lower" ? "less" : "more"} {view().x.label} and{" "}
          {view().y.better === "higher" ? "more" : "less"} {view().y.label}); the rest are dimmed.
        </Show>
        <Show when={model().omitted.length > 0}>
          {" "}
          Not plotted: {model().omitted.map((o) => `${o.label} (${o.why})`).join(", ")}.
        </Show>
      </p>
    </div>
  );
}
