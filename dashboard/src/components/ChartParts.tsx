/**
 * The pieces the hand-drawn charts share: the frame, the two axes' ticks and
 * captions, and the model puck. `LadderChart` and `CharacterChart` used to each
 * carry a copy of this markup; one drift between the copies (a tick offset, a
 * ring width) would have been a difference a reader could see and nobody
 * intended. Each chart keeps its own margins — the character chart's right
 * margin holds its end labels, the scatter's does not — so the box is the
 * chart's and only the drawing of it is here.
 *
 * Every number the layouts place against still comes from `lib/ladder.ts`
 * (`MARK_R`, `MARK_RING_R`, `TICK_FONT`); these components only draw.
 */

import { For, Show, type JSX } from "solid-js";
import { type ChartBox, type ChartCue, MARK_R, MARK_RING_R, TICK_FONT } from "../lib/ladder";
import { monogramOf } from "../lib/lineup";
import { logoHrefOf } from "./ModelIcon";

/**
 * The frame every chart shares: 1000 wide, so a viewBox unit is a tenth of a
 * percent of the width and the label metrics in `lib/ladder.ts` mean the same
 * thing on each. 380 tall is the scatter's and the character chart's height; the
 * run page's `XpChart` is a shorter strip and keeps its own.
 */
export const VB_W = 1000;
export const VB_H = 380;

/** The logo inside a puck. Square, a little inside the ring, so a wide mark's art still fits. */
export const LOGO_S = 7.5;

/**
 * The y axis: a dashed gridline across the plot at each tick, with the tick's
 * text just left of the axis. `format` returning null draws the gridline and
 * no text — the character chart's level 0, a line worth having and a level no
 * one has.
 *
 * `dominant-baseline="central"` centres the text on the gridline. It replaces
 * a hand-tuned `y + 4` nudge, and was adopted only after the two rendered the
 * same: at 11 units on the body's monospace stack the ink extents match to
 * the pixel in Chromium and sit within 0.3 viewBox units (a quarter of a CSS
 * pixel at a 1000px render) in Firefox 14x.
 */
export function YAxis(props: {
  ticks: readonly number[];
  py: (v: number) => number;
  box: ChartBox;
  format: (v: number) => string | null;
}) {
  return (
    <For each={props.ticks}>
      {(t) => {
        const y = (): number => props.py(t);
        const text = (): string | null => props.format(t);
        return (
          <>
            <line x1={props.box.x0} y1={y()} x2={props.box.x1} y2={y()} stroke="var(--gridline)" stroke-dasharray="3 3" />
            <Show when={text() !== null}>
              <text
                x={props.box.x0 - 8}
                y={y()}
                dominant-baseline="central"
                text-anchor="end"
                font-size={String(TICK_FONT)}
                fill="var(--dim)"
              >
                {text()}
              </text>
            </Show>
          </>
        );
      }}
    </For>
  );
}

/** The x axis: a short tick mark below the baseline at each tick, its text under it. */
export function XAxis(props: { ticks: readonly number[]; px: (v: number) => number; box: ChartBox; format: (v: number) => string }) {
  return (
    <For each={props.ticks}>
      {(t) => {
        const x = (): number => props.px(t);
        const text = (): string => props.format(t);
        return (
          <>
            <line x1={x()} y1={props.box.y0} x2={x()} y2={props.box.y0 + 4} stroke="var(--line)" />
            <text x={x()} y={props.box.y0 + 17} text-anchor="middle" font-size={String(TICK_FONT)} fill="var(--dim)">
              {text()}
            </text>
          </>
        );
      }}
    </For>
  );
}

/** The two axis lines and their unit captions: x's right-aligned under the ticks, y's rotated up the left edge. */
export function AxisFrame(props: { box: ChartBox; xCaption: string; yCaption: string }) {
  return (
    <>
      <line x1={props.box.x0} y1={props.box.y0} x2={props.box.x1} y2={props.box.y0} stroke="var(--line)" />
      <line x1={props.box.x0} y1={props.box.y1} x2={props.box.x0} y2={props.box.y0} stroke="var(--line)" />
      <text x={props.box.x1} y={props.box.y0 + 33} text-anchor="end" font-size={String(TICK_FONT)} fill="var(--dim)">
        {props.xCaption}
      </text>
      <text
        x={-(props.box.y1 + 4)}
        y={14}
        transform="rotate(-90)"
        text-anchor="end"
        font-size={String(TICK_FONT)}
        fill="var(--dim)"
      >
        {props.yCaption}
      </text>
    </>
  );
}

/**
 * The reading-direction cue: "↖ better" in the corner the axes point at,
 * quiet — tick font, dim — because it is furniture for a stranger's first
 * second with the chart, not a label. Where it goes and what it says is the
 * layout's (`chartCue`), derived from the specs; this only draws it. It is
 * for the comparison charts — the scatter and the freeplay field — and not
 * for `XpChart`, which is a time series and has no better corner.
 */
export function Cue(props: { cue: ChartCue }) {
  return (
    <text class="chart-cue" x={props.cue.x} y={props.cue.y} text-anchor={props.cue.anchor} font-size={String(TICK_FONT)} fill="var(--dim)">
      {props.cue.text}
    </text>
  );
}

/**
 * A model's mark: its family's logo on a white puck.
 *
 * The puck is light in both themes on purpose — the logo SVGs paint
 * `currentColor`, which an image document resolves to black — and the caller
 * colours the puck's edge with whatever the chart's colour means there (the
 * harness on the scatter, the character's status on the field). `ring` adds the
 * page-coloured separation ring outside it, which is what tells two pucks
 * apart when they land on top of each other; the scatter wants it, the
 * character chart's badge (one per line, never stacked) does not.
 *
 * A model no family claims has no logo. The default fallback is the
 * `lib/lineup` monogram on a panel-coloured puck, so a character is never left
 * with a hole where every other one has a badge; a caller with its own
 * convention passes `fallback` — the scatter keeps its coloured dot, the same
 * fallback every other render site takes for it.
 */
export function Puck(props: {
  cx: number;
  cy: number;
  model: string;
  stroke: string;
  strokeWidth?: number;
  dash?: string | undefined;
  ring?: boolean;
  fallback?: JSX.Element;
}) {
  const width = (): number => props.strokeWidth ?? 1.5;
  return (
    <Show
      when={logoHrefOf(props.model)}
      fallback={
        props.fallback ?? (
          <>
            <circle cx={props.cx} cy={props.cy} r={MARK_R} fill="var(--panel)" stroke="var(--line)" stroke-width="1" />
            <text
              x={props.cx}
              y={props.cy}
              dominant-baseline="central"
              text-anchor="middle"
              font-size="7"
              fill="var(--fg)"
            >
              {monogramOf(props.model)}
            </text>
          </>
        )
      }
    >
      {(href) => (
        <>
          <Show when={props.ring}>
            <circle cx={props.cx} cy={props.cy} r={MARK_RING_R} fill="none" stroke="var(--bg)" stroke-width="1.5" />
          </Show>
          <circle
            cx={props.cx}
            cy={props.cy}
            r={MARK_R}
            fill="#ffffff"
            stroke={props.stroke}
            stroke-width={String(width())}
            stroke-dasharray={props.dash}
          />
          <image
            href={href()}
            x={props.cx - LOGO_S / 2}
            y={props.cy - LOGO_S / 2}
            width={LOGO_S}
            height={LOGO_S}
            preserveAspectRatio="xMidYMid meet"
          />
        </>
      )}
    </Show>
  );
}
