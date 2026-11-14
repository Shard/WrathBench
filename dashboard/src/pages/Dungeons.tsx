/**
 * The dungeon board (operator, 2026-11-14): the two Deadmines episodes side by
 * side, one table per id, a row per model condition. Everything is
 * `/api/dungeons`, derived server-side (`runner/viewer/dungeons.ts`), where
 * the order and the rules are written out; this page only lays it out. The
 * two tables are never ranked against each other.
 */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type DungeonBoardView, type DungeonRowView, type DungeonsResponse } from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { InfoHint } from "../components/InfoHint";
import { ModelIcon } from "../components/ModelIcon";
import { useSeriesFilter } from "../components/SeriesSelect";
import { attemptTitle, boardHint, boardTitle, bossesText, bossesTitle, clearTimeText, clearedText } from "../lib/dungeons";
import { displayError } from "../lib/errors";
import { effortLabel, modelDisplay } from "../lib/format";
import { partyHref } from "../lib/party";
import { poll } from "../lib/poll";

const BOARD_NOTE =
  "The fixed Deadmines episode from a staged level-20 party, as two evals never pooled: one agent driving all five characters, and five agents of one model. A row is a model condition's best attempt, with how many of its counted attempts cleared. Cleared rows first, by time to clear from launch; the rest by bosses killed of the eight, then time to the last. Deaths and wipes are shown and never order a row.";

/** Attempts end in hours; the board moves when one does. */
const POLL_MS = 60_000;

export default function Dungeons() {
  const feed = poll(() => api.dungeons(), POLL_MS);
  const body = (): DungeonsResponse | undefined => feed.latest;
  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>
      <h1>
        dungeons
        <InfoHint label="about this page" text={BOARD_NOTE} />
      </h1>
      <Show when={body()} fallback={<p class="dim">loading…</p>}>
        {(b) => (
          <div class="two-col">
            <For each={b().boards}>{(board) => <Board board={board} />}</For>
          </div>
        )}
      </Show>
    </div>
  );
}

function Board(props: { board: DungeonBoardView }) {
  // The shell's harness series, as every evals page applies it.
  const series = useSeriesFilter(() => props.board.rows.map((r) => ({ ...r, harnessSeries: r.series })));
  return (
    <section>
      <h2 class="section">
        {boardTitle(props.board.episode)}
        <InfoHint label={props.board.episode} text={boardHint(props.board.episode)} />
      </h2>
      <div class="scroller">
        <table>
          <thead>
            <tr>
              <th>model</th>
              <th>harness</th>
              <th class="right" title="counted attempts that cleared, of the counted attempts">cleared</th>
              <th class="right" title="the best attempt's time from launch to Edwin VanCleef's death">time</th>
              <th class="right" title="the best attempt's bosses killed, of the eight">bosses</th>
              <th class="right" title="the best attempt's deaths, over every character">deaths</th>
              <th class="right" title="the best attempt's wipes: every character dead at once">wipes</th>
            </tr>
          </thead>
          <tbody>
            <Show when={series.kept().length === 0}>
              <tr>
                <td colSpan={7} class="dim">
                  no counted attempts
                </td>
              </tr>
            </Show>
            <For each={series.kept()}>{(row) => <Row row={row} />}</For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Where a row's best attempt opens: its party's page on five agents, its run on one. */
function attemptHref(row: DungeonRowView): string {
  return row.best.party !== null ? partyHref(row.best.party) : `/run/${encodeURIComponent(row.best.runIds[0] ?? "")}`;
}

function Row(props: { row: DungeonRowView }) {
  const r = (): DungeonRowView => props.row;
  const effort = (): string | null => effortLabel(r().effort, r().compactWindow ?? null);
  return (
    <tr>
      <td>
        <ModelIcon model={r().model} />
        {modelDisplay(r().model ?? "(unnamed)")}
        <Show when={effort()}>{(e) => <span class="dim"> · {e()}</span>}</Show>
      </td>
      <td>
        <HarnessTag harness={r().harness} />
      </td>
      <td class="right mono" title="the row's best attempt">
        <A href={attemptHref(r())}>{clearedText(r())}</A>
      </td>
      <td class="right mono" title={attemptTitle(r().best)}>
        {clearTimeText(r().best)}
      </td>
      <td class="right mono" title={bossesTitle(r().best)}>
        {bossesText(r().best)}
      </td>
      <td class="right mono">{r().best.deaths}</td>
      <td class="right mono">{r().best.wipes}</td>
    </tr>
  );
}
