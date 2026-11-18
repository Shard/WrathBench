/**
 * The run feed's icons: one per kind of row (`lib/feedtier.ts`, `FeedKind`).
 *
 * Inline SVG paths on a 16-unit grid, drawn in the row's own colour by
 * `.feed-icon` in `styles.css`, as the play bar's and the theme switch's
 * are. No font, no sprite and no request: the public site's pages load
 * nothing but their own bundle. An icon is decoration beside a row's words,
 * so it is hidden from assistive technology unless it is given a title.
 */

import { Show } from "solid-js";
import type { FeedKind } from "../lib/feedtier";

/** The disclosure mark of a row that opens, beside the kinds. */
export type IconName = FeedKind | "chevron";

const RING = "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z";

export const ICONS: Readonly<Record<IconName, string>> = {
  // decisions
  turn: "M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3 2.5v2.7h2.7",
  response: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  snippet: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13",
  reflect: "M12.5 9.5a5.5 5.5 0 0 1-6-6 5.5 5.5 0 1 0 6 6z",
  log: "M3 13l.6-2.8 7-7 2.2 2.2-7 7zM9.4 4.4l2.2 2.2",
  pad: "M4 2.5h8v11H4zM6 5.5h4M6 8h4M6 10.5h2.5",
  program: "M4 2.5h5l3 3v8H4zM9 2.5v3h3M6.8 8.8l-1.2 1.3 1.2 1.3M9.2 8.8l1.2 1.3-1.2 1.3",
  routine: "M3.5 7a4.6 4.6 0 0 1 8-2l1 1M12.5 9a4.6 4.6 0 0 1-8 2l-1-1M12.5 3v3h-3M3.5 13v-3h3",
  roster: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.5-2.4 2.5-3.5 5-3.5s4.5 1.1 5 3.5",
  level: "M4 8.5l4-4 4 4M4 12.5l4-4 4 4",
  death: "M8 2.5a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9zM6.2 7.4v.9M9.8 7.4v.9M8 11.5v2",
  quest: "M3 8.5l3.2 3.2L13 4.8",
  milestone: "M4 14V2.5M4 3h8l-2 2.5 2 2.5H4",
  notice: "M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.2",
  end: `${RING}M6 6h4v4H6z`,
  meta: `${RING}M8 7.5v3.3M8 5.2v.2`,
  unknown: `${RING}M8 8h.01`,
  // actions
  move: "M2 8h1.8M5.8 8h1.8M9.6 8h4M11 5l3 3-3 3",
  combat: "M13.5 2.5l-7 7M13.5 2.5h-3M13.5 2.5v3M4.5 8.5l3 3M3 13l2.5-2.5",
  loot: "M5 5.5h6l1.5 7.5h-9zM6 5.5V4a2 2 0 0 1 4 0v1.5",
  interact: "M4 2.8l8.5 4.6-3.7 1.1L7.4 12.4z",
  errand: "M3.5 2.5h9v11h-9zM8 5v4.5M8 11.3v.2",
  trade: "M3 5.5C3 4.1 5.2 3 8 3s5 1.1 5 2.5S10.8 8 8 8 3 6.9 3 5.5zM3 5.5v5C3 11.9 5.2 13 8 13s5-1.1 5-2.5v-5M3 8c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5",
  item: "M2.5 5.5 8 2.5l5.5 3v5.5L8 14l-5.5-3zM2.5 5.5 8 8.5l5.5-3M8 8.5V14",
  say: "M2.5 3.5h11v7H8l-3 2.5v-2.5H2.5zM5.5 7h.01M8 7h.01M10.5 7h.01",
  read: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z",
  events: "M9 2 4 9h3.5L7 14l5-7H8.5z",
  state: "M1.5 8h3l1.5-4 3 8 1.5-4h4",
  area: "M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14zM8 5a1.6 1.6 0 1 0 0 3.2A1.6 1.6 0 0 0 8 5z",
  sleep: `${RING}M8 5v3l2 1.5`,
  repeat: "M2.5 6h10l-2.5-2.5M13.5 10h-10L6 12.5",
  record: "M3 4.5h10M3 8h10M3 11.5h6",
  other: "M4 8h.01M8 8h.01M12 8h.01",
  chevron: "M6 4l4 4-4 4",
};

export function FeedIcon(props: { kind: IconName; title?: string | undefined }) {
  return (
    <svg
      class={`feed-icon k-${props.kind}`}
      viewBox="0 0 16 16"
      role={props.title === undefined ? undefined : "img"}
      aria-hidden={props.title === undefined ? "true" : undefined}
      aria-label={props.title}
    >
      <Show when={props.title}>
        <title>{props.title}</title>
      </Show>
      <path d={ICONS[props.kind]} />
    </svg>
  );
}
