/**
 * The facts a character is read by, wherever one is shown: the level and how
 * far into it, money, and quests turned in.
 *
 * One module rather than one per page. The run page's
 * character card drew these first; a ladder row, a runs row, a campaign row
 * and a character's attempt list all answer the same three questions, and
 * three pages spelling gold three ways is three chances to spell it wrong.
 *
 * Drawn rather than printed, because "1s 12c · 17 quests" is a line a reader
 * parses and "1 ● 12 ● · ? 17" is a line a reader recognises. Every glyph here
 * is ours: three CSS circles and a question mark in the stylesheet's own type.
 * Nothing Blizzard-derived is served by this repository, and an icon of a coin
 * is not worth becoming the exception (`docs/DATA-AND-LEGAL.md`).
 *
 * The split itself is `lib/format.ts`, so what counts as a coin worth showing
 * is testable without a renderer.
 */

import { For, Show } from "solid-js";
import { fmtMoney, moneyCoins } from "../lib/format";
import { XpBar } from "./UnitFrame";
import { xpCellTitle } from "../lib/unitframe";

/**
 * The level, and how far into it the run got — the site's one xp reading.
 *
 * `compact` is the table form: the same badge and the same `XpBar`, at a fixed
 * narrow width with no numbers drawn inside the bar, because a column is not
 * wide enough for "1,234 / 5,400" and a squeezed bar that prints half a figure
 * is worse than one that prints none. The exact reading is the cell's `title`
 * (`xpCellTitle`), and the row still sorts on the number behind it: nothing
 * here is the sort key, it is a drawing of one.
 *
 * A row with a level and no xp reading gets the badge alone rather than an
 * empty bar, which would read as "no progress" instead of "not recorded".
 */
export function LevelXp(props: {
  level: number | null | undefined;
  xp: number | null | undefined;
  nextLevelXp?: number | null | undefined;
  compact?: boolean;
  /** Anything else the cell knows — a row's spread across its runs — for the hover. */
  note?: string | null;
}) {
  const title = (): string => {
    const head = xpCellTitle(props.level, props.xp, props.nextLevelXp);
    const note = props.note;
    return note === null || note === undefined || note === "" ? head : `${head}\n${note}`;
  };
  return (
    <Show when={typeof props.level === "number"} fallback={<span class="dim" title={title()}>—</span>}>
      <Show
        when={typeof props.xp === "number"}
        fallback={
          <span class="level-badge" title={title()}>
            {props.level}
          </span>
        }
      >
        <span class={props.compact === true ? "xp-cell" : ""} title={title()}>
          <XpBar level={props.level} xp={props.xp} nextLevelXp={props.nextLevelXp} />
        </span>
      </Show>
    </Show>
  );
}

/** Money as coins: one per denomination present, the count ahead of the coin. */
export function Coins(props: { copper: number | null | undefined }) {
  const coins = () => moneyCoins(props.copper);
  return (
    <Show when={coins()} fallback={<span class="fact">—</span>}>
      {(cs) => (
        <span class="fact coins" title={fmtMoney(props.copper)}>
          <For each={cs()}>
            {(c) => (
              <span class="coin-pair">
                <span class="coin-value">{c.value}</span>
                <span class={`coin ${c.kind}`} aria-hidden="true" />
              </span>
            )}
          </For>
        </span>
      )}
    </Show>
  );
}

/** Quests turned in, behind the marker a quest giver wears. */
export function QuestCount(props: { count: number | null | undefined }) {
  return (
    <span class="fact quests" title="quests completed">
      <span class="quest-mark" aria-hidden="true">
        ?
      </span>
      <Show when={props.count !== null && props.count !== undefined} fallback="—">
        {props.count}
      </Show>
    </span>
  );
}
