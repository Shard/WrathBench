/**
 * A scored tier's entries as lines: xp earned against active playtime, one
 * line per roster entry, the mean of its counted runs — the ladder's second
 * chart beside the scatter, and the freeplay field's reading
 * (`CharacterChart`) for a tier.
 *
 * The series, the mean and the layout are `lib/runlines.ts`, where the tests
 * are; the axes, frame and cue are the shared `ChartParts`, the xp axis is
 * ticked at level boundaries like the scatter's, and a line's colour is the
 * harness, as the scatter's ring is (`harnessColour`). Each line ends in the
 * model's logo puck, drawn as the scatter draws its points (`Puck`, the
 * coloured dot for a model with no logo, the dashed ring for a mean resting on
 * one run). The entry the reader is pointing at — here or in the table,
 * through the page's one hover signal — comes forward. A line and its puck are
 * a link to the entry's runs, as a scatter point is.
 */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import type { ResultRun } from "@viewer/api-types";
import { PLAYTIME, XP } from "../lib/axes";
import { type ChartBox, type LadderPoint, ladderPoints } from "../lib/ladder";
import { type PlacedEntryLine, entryLines, runLines, runLinesLayout } from "../lib/runlines";
import { fmtDuration, fmtPlaytimeTick, fmtUsd, shortRunId } from "../lib/format";
import { runsHref } from "../lib/runs";
import { AxisFrame, Cue, Puck, VB_H, VB_W, XAxis, YAxis } from "./ChartParts";
import { EntryCard, createCardHover } from "./EntryCard";
import { SINGLE_DASH, harnessColour, pricedText } from "./LadderChart";
import { InfoHint } from "./InfoHint";

const M = { top: 16, right: 24, bottom: 40, left: 64 };
const BOX: ChartBox = { x0: M.left, x1: VB_W - M.right, y0: VB_H - M.bottom, y1: M.top };

/** The puck's transparent hit target: wider than the mark, narrower than the scatter's, since pucks here stack. */
const HIT_R = 9;

/** The line's colour: its harness, as the scatter's ring and the table's tag read it. */
const colourOf = (p: PlacedEntryLine): string => harnessColour(p.line.harnesses);

/** The line's accessible name: what its card says, in a sentence. */
function lineLabel(p: PlacedEntryLine): string {
  const l = p.line;
  return `${l.label}, mean of ${l.n === 1 ? "one run" : `${l.n} runs`}: ${Math.round(l.endY).toLocaleString()} xp (L${l.endLevel}) after ${fmtDuration(l.endX)} of active play`;
}

/** The model's puck at a line's end, as the scatter draws its point: the logo, or the harness-coloured dot. */
function EndPuck(props: { p: PlacedEntryLine }) {
  const single = (): boolean => props.p.line.n === 1;
  return (
    <Puck
      cx={props.p.markCx}
      cy={props.p.markCy}
      model={props.p.line.model}
      stroke={colourOf(props.p)}
      dash={single() ? SINGLE_DASH : undefined}
      ring
      fallback={
        <circle
          cx={props.p.markCx}
          cy={props.p.markCy}
          r={5}
          fill={single() ? "var(--bg)" : colourOf(props.p)}
          stroke={single() ? colourOf(props.p) : "var(--bg)"}
          stroke-width="1.5"
          stroke-dasharray={single() ? SINGLE_DASH : undefined}
        />
      }
    />
  );
}

/** The thin line from a line's end to a puck the spread moved off it — the scatter's label leader. */
function EndLeader(props: { p: PlacedEntryLine }) {
  return (
    <Show when={props.p.leader}>
      {(l) => <line class="chart-leader" x1={l().x1} y1={l().y1} x2={l().x2} y2={l().y2} stroke="var(--dim)" stroke-width="1" opacity="0.6" />}
    </Show>
  );
}

export function RunLinesChart(props: {
  runs: readonly ResultRun[];
  episode: string;
  /** The entry the reader is pointing at, shared with the table (`hoverKeyOf`). */
  hovered?: string | null;
  onHover?: (key: string | null) => void;
}) {
  const model = createMemo(() => runLines(props.runs));
  const entries = createMemo(() => entryLines(model().lines));
  const layout = createMemo(() => runLinesLayout(entries(), BOX));
  const hover = createCardHover(() => props.onHover);
  const lit = (p: PlacedEntryLine): boolean =>
    hover.shown() === p.line.entry || (props.hovered != null && props.hovered === p.line.hoverKey);
  /*
   * The card's means, grouped as the scatter groups (`ladderPoints`) over the
   * two readings a line is drawn from, so a card rests on its line's runs.
   */
  const means = createMemo(() => new Map(ladderPoints(props.runs, PLAYTIME, XP).points.map((p) => [p.key, p])));
  const carded = createMemo(() => {
    const p = layout().placed.find((q) => q.line.entry === hover.shown());
    const point = p === undefined ? undefined : means().get(p.line.entry);
    return p === undefined || point === undefined ? null : { p, point };
  });
  let svg: SVGSVGElement | undefined;
  const cardRows = (point: LadderPoint): [string, string][] => [
    ["mean of", point.n === 1 ? "1 run" : `${point.n} runs`],
    ["cost", point.metrics.cost === null ? "—" : `${fmtUsd(point.metrics.cost)} (${pricedText(point)})`],
    ["active play", point.metrics.playtimeMs === null ? "—" : fmtDuration(point.metrics.playtimeMs)],
  ];
  // SVG has no z-order but the document's: the pucks are drawn after every
  // line, and the lit entries are drawn again on top of both, inert, so a
  // highlighted entry is never under the field.
  const litLines = createMemo(() => layout().placed.filter(lit));
  // A plain `<a>` under a `<g>`, routed by hand — the reason is `LadderChart`'s.
  const navigate = useNavigate();
  const caption = (): string => `xp earned per ${props.episode} run (lower bound)`;
  const href = (p: PlacedEntryLine): string =>
    runsHref({ model: p.line.model, effort: p.line.effort, compactWindow: p.line.compactWindow, episode: props.episode });
  const go = (p: PlacedEntryLine) => (e: MouseEvent & { currentTarget: Element }): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (hover.follow(p.line.entry, p.line.hoverKey)) navigate(e.currentTarget.getAttribute("href") ?? "/runs");
  };

  const note = (): string => {
    const lines = [
      `XP earned against active playtime, one line per model and effort, coloured by harness: the mean of its counted ${props.episode} runs, each read at the same fraction of its own active playtime, ending at their mean playtime and mean xp. Ticks on the xp axis mark where each level begins for a character starting from L1.`,
      "A run's line steps through its level marks — the first 60-second sample at each level, at the xp the level begins with — so it and the mean are lower bounds.",
      "The mark at a line's end is the model's; a dashed ring means the mean rests on a single run. Pointing at a line or its mark opens the entry's card.",
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
        {/* No `<title>`, as on the scatter: the hover is the card. */}
        <svg
          ref={svg}
          class="ladderchart"
          classList={{ "runlines-lit": litLines().length > 0 }}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          role="img"
          aria-label={`${caption()} against active playtime, one mean line per model and effort`}
        >
          <YAxis ticks={layout().yTicks} py={layout().py} box={BOX} format={XP.format} />
          <XAxis ticks={layout().xTicks} px={layout().px} box={BOX} format={fmtPlaytimeTick} />
          <AxisFrame box={BOX} xCaption="active playtime" yCaption={caption()} />
          <Cue cue={layout().cue} />

          <For each={layout().placed}>
            {(p) => (
              <g
                class="runlines-run"
                data-entry={p.line.entry}
                onPointerDown={hover.down}
                onPointerEnter={(e) => hover.enter(e, p.line.entry, p.line.hoverKey)}
                onPointerLeave={hover.leave}
              >
                <a href={href(p)} aria-label={lineLabel(p)} onClick={go(p)}>
                  {/* The hit target, wider than the line; then the line and its end. */}
                  <path d={p.d} fill="none" stroke="transparent" stroke-width="10" vector-effect="non-scaling-stroke" />
                  <path class="runlines-path" d={p.d} fill="none" stroke={colourOf(p)} vector-effect="non-scaling-stroke" />
                  <circle class="runlines-end" cx={p.endCx} cy={p.endCy} r={2.5} fill={colourOf(p)} />
                </a>
              </g>
            )}
          </For>
          <For each={layout().placed}>
            {(p) => (
              <g
                class="runlines-run runlines-mark"
                data-entry={p.line.entry}
                onPointerDown={hover.down}
                onPointerEnter={(e) => hover.enter(e, p.line.entry, p.line.hoverKey)}
                onPointerLeave={hover.leave}
              >
                <a href={href(p)} aria-label={lineLabel(p)} onClick={go(p)}>
                  <EndLeader p={p} />
                  <circle cx={p.markCx} cy={p.markCy} r={HIT_R} fill="transparent" />
                  <EndPuck p={p} />
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
                  <EndLeader p={p} />
                  <EndPuck p={p} />
                </>
              )}
            </For>
          </g>
        </svg>
        <Show when={carded()}>
          {(c) => <EntryCard point={c().point} cx={c().p.markCx} cy={c().p.markCy} svg={svg} rows={cardRows(c().point)} />}
        </Show>
      </Show>
      <div class="chart-note">
        <InfoHint label="about this chart" text={note()} />
      </div>
    </div>
  );
}
