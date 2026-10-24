/**
 * The ladder charts' hover card: one roster entry at a glance, beside the
 * mark or line the reader is pointing at (operator, 2026-10-24, in place of
 * the plain hover text).
 *
 * Drawn from what the site already draws an entry with — the model's icon and
 * harness tag as the table's row has them, the level badge and xp bar
 * (`LevelXp`), money as coins and the quest marker (`CharacterFacts`) — over
 * the entry's means (`LadderPoint`), so a card reads like a row and not like a
 * paragraph. The xp is the mean earned, read from a fresh L1 as the axes read
 * it; the rest of the facts are the rows the caller passes, which is where a
 * chart puts what its own axes say.
 *
 * It sits inside the chart's frame, beside the point and flipped away from an
 * edge (`cardPlacement`), and it never takes the pointer, so the mark under it
 * is still the link.
 */

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { LEVEL_START_XP, levelOfXp } from "../lib/axes";
import { type LadderPoint } from "../lib/ladder";
import { effortLabel, modelDisplay } from "../lib/format";
import { type Frame, cardPlacement } from "../lib/popover";
import { Coins, LevelXp, QuestCount } from "./CharacterFacts";
import { HarnessTag } from "./HarnessTag";
import { ModelIcon } from "./ModelIcon";
import { VB_W } from "./ChartParts";

/** The box `el` occupies, in `origin`'s coordinates. */
function frameIn(el: Element, origin: DOMRect): Frame {
  const r = el.getBoundingClientRect();
  return { l: r.left - origin.left, t: r.top - origin.top, r: r.right - origin.left, b: r.bottom - origin.top };
}

export function EntryCard(props: {
  point: LadderPoint;
  /** The point the card describes, in the chart's viewBox units. */
  cx: number;
  cy: number;
  /** The chart it sits in; its parent is the positioned box the card is placed in. */
  svg: SVGSVGElement | undefined;
  /** Label and reading, one line each, under the level and money. */
  rows: readonly (readonly [string, string])[];
  /** The xp to draw, where the chart reads it otherwise than the mean (the lines chart's end, raised to its level marks). */
  xp?: number;
  /** A footnote the readings need, dim. */
  note?: string | null;
}) {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  createEffect(() => {
    // Every input that moves or resizes the card: re-placed whenever one changes.
    const { cx, cy, svg } = props;
    void props.point;
    void props.rows;
    const box = el?.offsetParent;
    if (svg === undefined || el === undefined || !(box instanceof HTMLElement)) return;
    const origin = box.getBoundingClientRect();
    const plot = svg.getBoundingClientRect();
    let frame = frameIn(svg, origin);
    // Below 720px the chart scrolls inside its own strip; the card stays in the part of it on screen.
    const strip = svg.closest(".wide-scroll");
    if (strip !== null) {
      const seen = frameIn(strip, origin);
      frame = { l: Math.max(frame.l, seen.l), t: frame.t, r: Math.min(frame.r, seen.r), b: frame.b };
    }
    const scale = plot.width / VB_W;
    const anchor = { x: plot.left - origin.left + cx * scale, y: plot.top - origin.top + cy * scale };
    setPos(cardPlacement(anchor, { w: el.offsetWidth, h: el.offsetHeight }, frame, 12));
  });
  const xp = (): number | null => props.xp ?? props.point.metrics.xp;
  const level = (): number | null => (xp() === null ? null : levelOfXp(xp()!));
  const effort = (): string | null => effortLabel(props.point.effort, props.point.compactWindow);
  const quests = (): number | null => {
    const q = props.point.metrics.quests;
    return q === null ? null : Math.round(q * 10) / 10;
  };
  return (
    <div
      ref={el}
      class="popover entry-card"
      role="tooltip"
      classList={{ placed: pos() !== null }}
      style={pos() === null ? undefined : { left: `${pos()!.left}px`, top: `${pos()!.top}px` }}
    >
      <div class="charline">
        <ModelIcon model={props.point.model} />
        <strong>{modelDisplay(props.point.model)}</strong>
        <Show when={effort()}>{(e) => <span class="dim">{e()}</span>}</Show>
        <For each={props.point.harnesses}>{(h) => <HarnessTag harness={h} />}</For>
      </div>
      <div class="charline">
        <LevelXp level={level()} xp={xp() === null ? null : Math.round(xp()! - (LEVEL_START_XP[level()!] ?? 0))} />
        <Coins copper={props.point.gold === null ? null : Math.round(props.point.gold)} />
        <QuestCount count={quests()} />
      </div>
      <dl>
        <For each={props.rows}>
          {([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </>
          )}
        </For>
      </dl>
      <Show when={props.note}>{(n) => <div class="dim">{n()}</div>}</Show>
    </div>
  );
}

/**
 * Which entry's card is up, and the pointer handling that decides it, shared
 * by both charts so they behave alike.
 *
 * A mouse shows the card while it is over a mark or line and lights the page's
 * shared hover with it. A touch has no hover, so the first tap on a mark opens
 * its card (and lights it) instead of following the link, a second tap on the
 * same mark follows it, and a tap anywhere that is not a mark closes it. A
 * mark carries `data-entry` so a tap can tell.
 */
export function createCardHover(onHover: () => ((key: string | null) => void) | undefined) {
  const [shown, setShown] = createSignal<string | null>(null);
  let pointer = "mouse";
  const show = (key: string | null, hoverKey: string | null): void => {
    setShown(key);
    onHover()?.(hoverKey);
  };
  const outside = (e: PointerEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (e.pointerType !== "mouse" && shown() !== null && target?.closest("[data-entry]") == null) show(null, null);
  };
  onMount(() => document.addEventListener("pointerdown", outside));
  onCleanup(() => document.removeEventListener("pointerdown", outside));
  return {
    shown,
    down: (e: PointerEvent): void => {
      pointer = e.pointerType;
    },
    enter: (e: PointerEvent, key: string, hoverKey: string): void => {
      if (e.pointerType !== "touch") show(key, hoverKey);
    },
    leave: (e: PointerEvent): void => {
      if (e.pointerType !== "touch") show(null, null);
    },
    /** A click on a mark: whether to follow its link. On touch the first tap only opens the card. */
    follow: (key: string, hoverKey: string): boolean => {
      if (pointer !== "touch" || shown() === key) return true;
      show(key, hoverKey);
      return false;
    },
  };
}
