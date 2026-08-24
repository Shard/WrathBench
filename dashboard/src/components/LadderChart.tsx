/**
 * The ladder's scatter: one point per roster entry on the selected tier,
 * average cost per run against average XP earned.
 *
 * Hand-drawn inline SVG, like `XpChart` — a roster is a few dozen points at
 * most, and a chart library is a dependency this dashboard has not earned.
 * The maths (aggregation, ticks, label placement) is `lib/ladder.ts`, where
 * its tests are; this file only draws what that returns. Colours come from
 * the palette tokens so both themes work; the only data-driven colour is the
 * harness tag, which follows the same semantics as the table's `HarnessTag`.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { ResultRun } from "@viewer/api-types";
import { type LadderPoint, ladderChartLayout, ladderPoints } from "../lib/ladder";
import { fmtUsd } from "../lib/format";
import { runsHref } from "../lib/runs";

const VB_W = 1000;
const VB_H = 380;
const M = { top: 16, right: 24, bottom: 40, left: 64 };
const BOX = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/** The colour of a point: the harness that owned its runs, or neither when mixed. */
function harnessColour(harnesses: readonly string[]): string {
  if (harnesses.length === 1 && harnesses[0] === "claude-code") return "var(--claude)";
  if (harnesses.length === 1 && harnesses[0] === "wrathbench") return "var(--accent)";
  return "var(--dim)";
}

function hoverText(p: LadderPoint, episode: string): string {
  const priced =
    p.basis === "reported"
      ? "provider-reported"
      : p.basis === "list-price"
        ? `list price${p.asIfMetered ? ", as-if-metered" : ""}`
        : `provider-reported and list price mixed${p.asIfMetered ? ", some as-if-metered" : ""}`;
  return [
    p.key,
    `avg cost per ${episode} run: ${fmtUsd(p.x)} (${priced}, over ${p.costRuns} of ${p.runs} runs)`,
    `avg xp earned: ${Math.round(p.y).toLocaleString()} (over ${p.xpRuns} of ${p.runs} runs)`,
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
          aria-label={`average cost per ${props.episode} run against average xp earned, one point per model`}
        >
          <title>average cost per {props.episode} run (USD) against average xp earned, one point per model</title>

          {/* Gridlines and ticks. */}
          <For each={layout().yTicks}>
            {(t) => {
              const y = BOX.y0 - (t / layout().yMax) * (BOX.y0 - BOX.y1);
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
          <For each={layout().xTicks}>
            {(t) => {
              const x = BOX.x0 + (t / layout().xMax) * (BOX.x1 - BOX.x0);
              return (
                <>
                  <line x1={x} y1={BOX.y0} x2={x} y2={BOX.y0 + 4} stroke="var(--line)" />
                  <text x={x} y={BOX.y0 + 17} text-anchor="middle" font-size="11" fill="var(--dim)">
                    {fmtUsd(t)}
                  </text>
                </>
              );
            }}
          </For>

          {/* Axes and their units. */}
          <line x1={BOX.x0} y1={BOX.y0} x2={BOX.x1} y2={BOX.y0} stroke="var(--line)" />
          <line x1={BOX.x0} y1={BOX.y1} x2={BOX.x0} y2={BOX.y0} stroke="var(--line)" />
          <text x={BOX.x1} y={BOX.y0 + 33} text-anchor="end" font-size="11" fill="var(--dim)">
            avg cost per {props.episode} run (USD)
          </text>
          <text
            x={-(BOX.y1 + 4)}
            y={14}
            transform="rotate(-90)"
            text-anchor="end"
            font-size="11"
            fill="var(--dim)"
          >
            avg xp earned
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
                <circle cx={d.cx} cy={d.cy} r={12} fill="transparent" />
                <circle cx={d.cx} cy={d.cy} r={5} fill={harnessColour(d.point.harnesses)} stroke="var(--bg)" stroke-width="1.5" />
                <text x={d.labelX} y={d.labelY} text-anchor={d.anchor} font-size="11" fill="var(--fg)">
                  {d.point.key}
                </text>
              </a>
              </g>
            )}
          </For>
        </svg>
      </Show>

      <p class="dim ladderchart-caption">
        avg cost per {props.episode} run (USD) · avg xp earned, means over each entry's counted runs on{" "}
        {props.episode}. Cost is what the provider charged, else the list price applied to the run's own
        tokens ($0 for a free tier or local hardware, as-if-metered for a subscription); xp earned is the run
        page's lower bound. <span style={{ color: "var(--accent)" }}>●</span> wrathbench{" "}
        <span style={{ color: "var(--claude)" }}>●</span> claude-code{" "}
        <span style={{ color: "var(--dim)" }}>●</span> both.
        <Show when={model().omitted.length > 0}>
          {" "}
          Not plotted: {model().omitted.map((o) => `${o.key} (${o.why})`).join(", ")}.
        </Show>
      </p>
    </div>
  );
}
