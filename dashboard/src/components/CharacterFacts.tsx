/**
 * The three facts the character card carries beside the level: money, quests,
 * and (with `XpBar`) progress toward the next ding.
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
