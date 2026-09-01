/**
 * The ladder's scatter: one point per roster entry on the selected tier,
 * average cost per run against average XP earned.
 *
 * Hand-drawn inline SVG, like `XpChart` — a roster is a few dozen points at
 * most, and a chart library is a dependency this dashboard has not earned.
 * The aggregation and label placement are `lib/ladder.ts`, where its tests
 * are; the scale and tick maths are the shared `lib/chart.ts`. This file only
 * draws what those return. Colours come from
 * the palette tokens so both themes work; the only data-driven colour is the
 * harness tag, which follows the same semantics as the table's `HarnessTag`.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { ResultRun } from "@viewer/api-types";
import {
  MARK_R,
  MARK_RING_R,
  type LadderPoint,
  fmtCostTick,
  ladderChartLayout,
  ladderPoints,
} from "../lib/ladder";
import { logoHrefOf } from "./ModelIcon";
import { COST_BASIS_NOTE, fmtUsd } from "../lib/format";
import { runsHref } from "../lib/runs";

const VB_W = 1000;
const VB_H = 380;
const M = { top: 16, right: 24, bottom: 40, left: 64 };
const BOX = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/** The logo inside a puck. Square, a little inside the ring, so a wide mark's art still fits. */
const LOGO_S = 7.5;
/** The transparent hit target: comfortably wider than the mark, which is small. */
const HIT_R = 12;

/** The colour of a point's ring: the harness that owned its runs, or neither when mixed. */
function harnessColour(harnesses: readonly string[]): string {
  if (harnesses.length === 1 && harnesses[0] === "claude-code") return "var(--claude)";
  if (harnesses.length === 1 && harnesses[0] === "wrathbench") return "var(--accent)";
  return "var(--dim)";
}

/** The dash pattern that marks a mean resting on one run. Nothing else on the chart is dashed but the gridlines. */
const SINGLE_DASH = "2 2";

/**
 * The hover's reading of the price. Basis (who produced the figure) and
 * as-if-metered (whether anyone paid it) are two facts, not one: a claude-code
 * run is reported AND as-if-metered, so the qualifier attaches to whichever
 * basis the runs had rather than only to list-price.
 */
export function pricedText(p: Pick<LadderPoint, "basis" | "asIfMetered">): string {
  const basis =
    p.basis === "reported" ? "reported" : p.basis === "list-price" ? "list-price est." : "reported and list-price est. mixed";
  if (!p.asIfMetered) return basis;
  return p.basis === "mixed" ? `${basis}, some as-if-metered` : `as-if-metered (${basis})`;
}

/** The hover text of one mark: what both means rest on, and what was left out. */
export function hoverText(p: LadderPoint, episode: string): string {
  const left = p.runs - p.n;
  const over =
    left === 0
      ? `over ${p.n === 1 ? "one run" : `${p.n} runs`}`
      : `over ${p.n} of ${p.runs} counted runs — ${left} lack${left === 1 ? "s" : ""} a cost or an xp reading and feed${left === 1 ? "s" : ""} neither mean`;
  return [
    `${p.key} — ${over}`,
    `avg cost per ${episode} run: ${fmtUsd(p.x)} (${pricedText(p)})`,
    `avg xp earned (lower bound): ${Math.round(p.y).toLocaleString()}`,
  ].join("\n");
}

function fmtXpTick(v: number): string {
  return v >= 1000 ? `${v / 1000}k` : String(v);
}

export function LadderChart(props: { runs: readonly ResultRun[]; episode: string }) {
  const model = createMemo(() => ladderPoints(props.runs));
  const layout = createMemo(() => ladderChartLayout(model().points, BOX));
  const xpKnown = (): boolean => props.runs.some((r) => r.xpEarned !== undefined);
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
            nothing to plot for {props.episode}: no counted run carries both a cost reading and an xp reading
            <Show when={props.runs.length > 0 && !xpKnown()}>
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
          aria-label={`average cost per ${props.episode} run, on a log scale, against average xp earned, one point per model and effort, each the mean of that entry's counted runs`}
        >
          <title>
            average cost per {props.episode} run (USD, log scale) against average xp earned, one point per
            model and effort, each the mean of that entry's counted runs
          </title>

          {/* Gridlines and ticks: the same px/py the points were placed with. */}
          <For each={layout().yTicks}>
            {(t) => {
              const y = layout().py(t);
              return (
                <>
                  <line x1={BOX.x0} y1={y} x2={BOX.x1} y2={y} stroke="var(--gridline)" stroke-dasharray="3 3" />
                  <text x={BOX.x0 - 8} y={y + 4} text-anchor="end" font-size="11" fill="var(--dim)">
                    {fmtXpTick(t)}
                  </text>
                </>
              );
            }}
          </For>
          {/*
           * The cost axis is logarithmic, so it gets the faint vertical lines
           * the linear one did not need: the 2× and 5× inside each decade,
           * without which the eye has no way to read a distance between two
           * decade labels. The decades themselves keep the tick mark below
           * the axis they always had — a full-height line at every decade on
           * top of these would be more chrome than data.
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
          <For each={layout().xTicks}>
            {(t) => {
              const x = layout().px(t);
              return (
                <>
                  <line x1={x} y1={BOX.y0} x2={x} y2={BOX.y0 + 4} stroke="var(--line)" />
                  <text x={x} y={BOX.y0 + 17} text-anchor="middle" font-size="11" fill="var(--dim)">
                    {fmtCostTick(t)}
                  </text>
                </>
              );
            }}
          </For>

          {/*
           * The $0 gutter. A $0 entry is a reading and not a small price, so
           * it sits left of the axis with its own label, divided off, and is
           * never interpolated against the decades. It is drawn only when
           * something in view reported costing nothing. Labelled "$0
           * reported" and not "free": the page's free filter is the billing
           * verdict, and a paid endpoint that reports $0 (a stealth preview)
           * lands here with free excluded — the coordinate is the honest test,
           * the word "free" would contradict the caption.
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
            <text
              x={layout().freeX}
              y={BOX.y0 + 17}
              text-anchor="middle"
              font-size="11"
              fill="var(--dim)"
            >
              $0 reported
            </text>
          </Show>

          {/* Axes and their units. */}
          <line x1={BOX.x0} y1={BOX.y0} x2={BOX.x1} y2={BOX.y0} stroke="var(--line)" />
          <line x1={BOX.x0} y1={BOX.y1} x2={BOX.x0} y2={BOX.y0} stroke="var(--line)" />
          <text x={BOX.x1} y={BOX.y0 + 33} text-anchor="end" font-size="11" fill="var(--dim)">
            avg cost per {props.episode} run (USD, log)
          </text>
          <text
            x={-(BOX.y1 + 4)}
            y={14}
            transform="rotate(-90)"
            text-anchor="end"
            font-size="11"
            fill="var(--dim)"
          >
            avg xp earned (lower bound)
          </text>

          {/* Points, each a link to that entry's runs on this tier. */}
          <For each={layout().placed}>
            {(d) => (
              <g class="ladderchart-pt">
              <a
                href={runsHref({ model: d.point.model, effort: d.point.effort, episode: props.episode })}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(e.currentTarget.getAttribute("href") ?? "/runs");
                }}
              >
                <title>{hoverText(d.point, props.episode)}</title>
                {/* A hit target wider than the mark. */}
                <circle cx={d.cx} cy={d.cy} r={HIT_R} fill="transparent" />
                {/*
                 * The mark is the model's logo on a puck, and the
                 * harness keeps the point's colour as the puck's ring, so the
                 * legend below still says what it always said. Three circles
                 * and not one: the outer page-coloured ring is what separates
                 * two pucks that land on top of each other, which is the job
                 * the old dot's `var(--bg)` stroke was doing. The puck itself
                 * is light in both themes on purpose — these SVGs paint
                 * `currentColor`, which an image document resolves to black.
                 * A model no family claims has no logo and keeps the coloured
                 * dot, the same fallback every other render site takes.
                 */}
                <Show
                  when={logoHrefOf(d.point.model)}
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
                >
                  {(href) => (
                    <>
                      <circle cx={d.cx} cy={d.cy} r={MARK_RING_R} fill="none" stroke="var(--bg)" stroke-width="1.5" />
                      <circle
                        cx={d.cx}
                        cy={d.cy}
                        r={MARK_R}
                        fill="#ffffff"
                        stroke={harnessColour(d.point.harnesses)}
                        stroke-width="1.5"
                        stroke-dasharray={d.point.single ? SINGLE_DASH : undefined}
                      />
                      <image
                        href={href()}
                        x={d.cx - LOGO_S / 2}
                        y={d.cy - LOGO_S / 2}
                        width={LOGO_S}
                        height={LOGO_S}
                        preserveAspectRatio="xMidYMid meet"
                      />
                    </>
                  )}
                </Show>
                <text x={d.labelX} y={d.labelY} text-anchor={d.anchor} font-size="11" fill="var(--fg)">
                  {d.point.label}
                </text>
              </a>
              </g>
            )}
          </For>
        </svg>
      </Show>

      {/*
        The caption was one line, the axes only (operator, 2026-08-30), on the
        reading that the hover text carries the rest. Widened the same day, for
        a reader arriving from outside who has no reason to hover: the sample
        size behind a mark and the basis of its price are what a stranger would
        otherwise assume, and assume wrongly. A mark that is *missing* has no
        hover to explain it, so the omissions are printed below, the way the
        freeplay StreamChart prints its own.
      */}
      <p class="dim ladderchart-caption">
        avg cost per {props.episode} run (USD, log) against avg xp earned — a lower bound, rebuilt from
        the run's 60-second samples. A dashed ring means the means rest on a single run.
        Cost is what the provider reported; {COST_BASIS_NOTE}. 
      </p>
    </div>
  );
}
