/**
 * A scored tier's runs as lines: xp earned against active playtime, one line
 * per counted run — the ladder's second chart beside the scatter, and the
 * freeplay field's reading (`CharacterChart`) for a tier.
 *
 * The series and the layout are `lib/runlines.ts`, where the tests are; the
 * axes, frame and cue are the shared `ChartParts`, the xp axis is ticked at
 * level boundaries like the scatter's, and a line's colour is the harness, as
 * the scatter's ring is (`harnessColour`). A tier holds dozens of runs, so the
 * lines are thin and faint, and the entry the reader is pointing at — here or
 * in the table, through the page's one hover signal — comes forward, every
 * one of its runs at once. A line is a link to its run.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { ResultRun } from "@viewer/api-types";
import { XP } from "../lib/axes";
import { type ChartBox } from "../lib/ladder";
import { type PlacedRunLine, runLines, runLinesLayout } from "../lib/runlines";
import { fmtDuration, fmtPlaytimeTick, shortRunId } from "../lib/format";
import { AxisFrame, Cue, VB_H, VB_W, XAxis, YAxis } from "./ChartParts";
import { harnessColour } from "./LadderChart";
import { InfoHint } from "./InfoHint";

const M = { top: 16, right: 24, bottom: 40, left: 64 };
const BOX: ChartBox = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/** The line's colour: its harness, as the scatter's ring and the table's tag read it. */
const colourOf = (p: PlacedRunLine): string => harnessColour(p.line.harness === null ? [] : [p.line.harness]);

function lineTitle(p: PlacedRunLine): string {
  const l = p.line;
  return [
    `${l.label}${l.character === null ? "" : ` — ${l.character}`}`,
    `run ${shortRunId(l.runId)}`,
    `${Math.round(l.endY).toLocaleString()} xp (L${l.endLevel}) after ${fmtDuration(l.endX)} of active play`,
  ].join("\n");
}

export function RunLinesChart(props: {
  runs: readonly ResultRun[];
  episode: string;
  /** The entry the reader is pointing at, shared with the table (`hoverKeyOf`). */
  hovered?: string | null;
  onHover?: (key: string | null) => void;
}) {
  const model = createMemo(() => runLines(props.runs));
  const layout = createMemo(() => runLinesLayout(model().lines, BOX));
  const lit = (p: PlacedRunLine): boolean => props.hovered != null && props.hovered === p.line.hoverKey;
  // SVG has no z-order but the document's: the lit lines are drawn again on
  // top, inert, so a highlighted run is never under the field.
  const litLines = createMemo(() => layout().placed.filter(lit));
  // A plain `<a>` under a `<g>`, routed by hand — the reason is `LadderChart`'s.
  const navigate = useNavigate();
  const caption = (): string => `xp earned per ${props.episode} run (lower bound)`;

  const note = (): string => {
    const lines = [
      `XP earned against active playtime, one line per counted ${props.episode} run, coloured by harness. Ticks on the xp axis mark where each level begins for a character starting from L1.`,
      "A vertex is a level mark — the first 60-second sample at that level, at the xp the level begins with — so the line is a lower bound; it ends at the run's total active time and xp earned.",
    ];
    if (model().omitted.length > 0) {
      lines.push(`Not plotted: ${model().omitted.map((o) => `${shortRunId(o.runId)} (${o.why})`).join(", ")}.`);
    }
    return lines.join("\n");
  };

  return (
    <div class="ladderchart-wrap">
      <Show
        when={model().lines.length > 0}
        fallback={<div class="xpchart empty dim">nothing to plot for {props.episode}: no counted run carries both an xp and a playtime reading</div>}
      >
        <svg
          class="ladderchart"
          classList={{ "runlines-lit": props.hovered != null && litLines().length > 0 }}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          role="img"
          aria-label={`${caption()} against active playtime, one line per run`}
        >
          <title>{caption()} against active playtime, one line per run</title>
          <YAxis ticks={layout().yTicks} py={layout().py} box={BOX} format={XP.format} />
          <XAxis ticks={layout().xTicks} px={layout().px} box={BOX} format={fmtPlaytimeTick} />
          <AxisFrame box={BOX} xCaption="active playtime" yCaption={caption()} />
          <Cue cue={layout().cue} />

          <For each={layout().placed}>
            {(p) => (
              <g
                class="runlines-run"
                onMouseEnter={() => props.onHover?.(p.line.hoverKey)}
                onMouseLeave={() => props.onHover?.(null)}
              >
                <a
                  href={`/run/${encodeURIComponent(p.line.runId)}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(e.currentTarget.getAttribute("href") ?? "/ladder");
                  }}
                >
                  <title>{lineTitle(p)}</title>
                  {/* The hit target, wider than the line; then the line and its end. */}
                  <path d={p.d} fill="none" stroke="transparent" stroke-width="10" vector-effect="non-scaling-stroke" />
                  <path
                    class="runlines-path"
                    d={p.d}
                    fill="none"
                    stroke={colourOf(p)}
                    vector-effect="non-scaling-stroke"
                  />
                  <circle class="runlines-end" cx={p.endCx} cy={p.endCy} r={2.5} fill={colourOf(p)} />
                </a>
              </g>
            )}
          </For>
          <g class="runlines-top" aria-hidden="true">
            <For each={litLines()}>
              {(p) => (
                <>
                  <path class="runlines-path" d={p.d} fill="none" stroke={colourOf(p)} vector-effect="non-scaling-stroke" />
                  <circle class="runlines-end" cx={p.endCx} cy={p.endCy} r={3.5} fill={colourOf(p)} />
                </>
              )}
            </For>
          </g>
        </svg>
      </Show>
      <div class="chart-note">
        <InfoHint label="about this chart" text={note()} />
      </div>
    </div>
  );
}
