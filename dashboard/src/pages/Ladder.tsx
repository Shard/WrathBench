/**
 * The ladder of docs/VISION.md, with the highest rung each model has reached.
 *
 * Rungs are read from one episode tier at a time — e90 by default (ADR-0030) —
 * because a rung reached in six hours is not the same claim as the same rung
 * reached in ninety minutes. The count of what the filter removed is on the
 * page, not in a footnote.
 *
 * Rows are ordered by highest rung reached, then total XP, then gold — a stated
 * derivation over recorded signals, versioned with `lib/results.ts` (ADR-0018
 * amendment). The two tie-breaks are printed in their own columns so the order
 * is legible rather than mysterious, and neither is added to anything: there is
 * no aggregate score.
 *
 * Three of the eight rungs cannot be answered by anything the harness records
 * today — zone and area changes, flight paths, and group joins are not in the
 * trajectory (FOLLOW-UPS 35). Those read "not instrumented" rather than being
 * approximated by a level threshold, and every derived rung prints the exact
 * rule it applied so a reader can disagree with the derivation.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, on } from "solid-js";
import { api, type ResultsResponse, type ResultRun } from "../api/client";
import { EpisodeFilterNote, EpisodePicker, HarnessPicker, HarnessTag } from "../components/EpisodePicker";
import { ModelIcon } from "../components/ModelIcon";
import { episodeParam, harnessParam } from "../lib/episodes";
import { RUNGS, byCharacter, characterOptions, ladderRows, scored, type LadderCell, type LadderRow } from "../lib/results";
import { fmtMoney } from "../lib/format";
import { poll } from "../lib/poll";

const POLL_MS = 30_000;

export default function Ladder() {
  const [params, setParams] = useSearchParams();
  const episode = (): ReturnType<typeof episodeParam> => episodeParam(params.episode);
  const overrides = (): boolean => params.overrides === "1";
  const harness = (): ReturnType<typeof harnessParam> => harnessParam(params.harness);
  // `/api/ladder` is the same projection as `/api/results`; the rung rules stay
  // client-side, in `lib/results.ts`, where their tests are.
  const feed = poll(() => api.ladder(episode(), overrides(), harness()), POLL_MS);
  createEffect(on([episode, overrides, harness], () => feed.refresh(), { defer: true }));
  const body = (): ResultsResponse | undefined => feed.latest;
  const all = (): ResultRun[] => body()?.runs ?? [];
  /*
   * The starting character (ADR-0034's extras cycle) narrows the rungs; it is
   * never a row key. A model's row is its best run whatever it was played on,
   * because the baseline character is the comparison set.
   */
  const character = (): string | null =>
    typeof params.character === "string" && params.character.length > 0 ? params.character : null;
  const characters = createMemo(() => characterOptions(all()));
  const runs = (): ResultRun[] => byCharacter(all(), character());
  const rows = createMemo(() => ladderRows(runs()));
  const best = createMemo(() => rows().reduce((n, r) => Math.max(n, r.highest), 0));

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{String(feed.error)}</div>
      </Show>

      <h2 class="section">ladder</h2>
      <p class="dim">
        The eight rungs of the vision document. Rung 4 — a capital reached unaided — is the public
        release trigger. Derived from scored runs of one episode tier only.
      </p>

      <EpisodePicker
        value={episode()}
        onChange={(v) => setParams({ episode: v }, { replace: true })}
        includeOverrides={overrides()}
        onOverridesChange={(v) => setParams({ overrides: v ? "1" : null }, { replace: true })}
      />
      <HarnessPicker value={harness()} onChange={(v) => setParams({ harness: v === "all" ? null : v }, { replace: true })} />

      <Show when={characters().length > 0}>
        <div class="chips">
          <button class={character() === null ? "on" : ""} onClick={() => setParams({ character: null }, { replace: true })}>
            all characters
          </button>
          <For each={characters()}>
            {(c) => (
              <button
                class={character() === c ? "on" : ""}
                onClick={() => setParams({ character: character() === c ? null : c }, { replace: true })}
              >
                {c}
              </button>
            )}
          </For>
        </div>
        <p class="dim">
          Race and class filter and label the rows; they are not a group key. The baseline character
          (Human Paladin) is the comparison set — an extras run on another character (ADR-0034)
          counts toward its model's row unless one character is picked here.
        </p>
      </Show>

      <Show when={feed.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <EpisodeFilterNote
          episode={episode()}
          filteredOut={body()?.filteredOut ?? 0}
          overridesExcluded={body()?.overridesExcluded ?? 0}
        />
        <div class="cards">
          <div class="card">
            <div class="k">highest rung reached</div>
            <div class="v">{best() === 0 ? "—" : best()}</div>
            <div class="sub">across {scored(runs()).length} scorable runs</div>
          </div>
          <div class="card">
            <div class="k">models on the ladder</div>
            <div class="v">{rows().length}</div>
            <div class="sub">one row each, best run counts</div>
          </div>
          <div class="card">
            <div class="k">rungs not instrumented</div>
            <div class="v">{RUNGS.filter((r) => r.test === null).length}</div>
            <div class="sub">2, 4 and 6 — see FOLLOW-UPS 35</div>
          </div>
        </div>

        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th>harness</th>
                <th title="starting race and class among this model's scored runs">character</th>
                <th class="right">runs</th>
                <th class="right">highest</th>
                <th class="right" title="first tie-break: the furthest a run got — level, then xp within it">
                  level · xp
                </th>
                <th class="right" title="second tie-break: the most a run ended holding">gold</th>
                <For each={RUNGS}>
                  {(rung) => (
                    <th class="right" title={`${rung.title} — ${rung.rule}`}>
                      {rung.n}
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr>
                    <td>
                      <ModelIcon model={row.model} />
                      {row.model}
                    </td>
                    <td>
                      <For each={row.harnesses}>{(h) => <HarnessTag harness={h} />}</For>
                    </td>
                    <td class="dim" title={row.characters.join(", ")}>
                      {row.characters.length === 0
                        ? "—"
                        : row.characters.length === 1
                          ? row.characters[0]
                          : `${row.characters.length} characters`}
                    </td>
                    <td class="right mono dim">{row.runs}</td>
                    <td class="right mono">{row.highest === 0 ? "—" : row.highest}</td>
                    <td class="right mono dim" title={row.bestRunId ?? "not recorded"}>
                      <Furthest row={row} />
                    </td>
                    <td class="right mono dim" title={row.bestMoneyRunId ?? "not recorded"}>
                      {row.bestMoney === null ? "—" : fmtMoney(row.bestMoney)}
                    </td>
                    <For each={row.cells}>{(cell) => <RungCell cell={cell} />}</For>
                  </tr>
                )}
              </For>
              <Show when={rows().length === 0}>
                <tr>
                  <td colSpan={7 + RUNGS.length} class="dim">
                    No scorable runs recorded yet.
                  </td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>

        <p class="dim">
          Rows are ordered by highest rung reached, then total XP, then gold. Total XP is the
          level and the xp within it compared as a pair — xp resets at every ding, so the pair is
          the ordering and no single XP number is invented. Both tie-breaks are maxima over the
          model's scored runs and each names the run it came from; the gold column is usually a
          different run from the level column. Nothing here is summed into a score.
        </p>

        <h2 class="section">the rungs, and how each is decided</h2>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th class="right">#</th>
                <th>rung</th>
                <th>rule applied</th>
              </tr>
            </thead>
            <tbody>
              <For each={RUNGS}>
                {(rung) => (
                  <tr>
                    <td class="right mono">{rung.n}</td>
                    <td>{rung.title}</td>
                    <td class={rung.test === null ? "warn" : "dim"}>
                      {rung.test === null ? `not instrumented — ${rung.rule}` : rung.rule}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}

/** The furthest a model's run got: `L14 · 4,120 xp`, or what was recorded of it. */
function Furthest(props: { row: LadderRow }) {
  const r = (): LadderRow => props.row;
  return (
    <Show when={r().bestLevel !== null} fallback={<span>—</span>}>
      <span>
        L{r().bestLevel}
        <Show when={r().bestXp !== null}>
          <span class="dim"> · {r().bestXp!.toLocaleString()} xp</span>
        </Show>
      </span>
    </Show>
  );
}

function RungCell(props: { cell: LadderCell }) {
  const c = (): LadderCell => props.cell;
  return (
    <td class="right">
      <Show when={c().status === "reached"} fallback={<Unreached cell={c()} />}>
        <A href={`/run/${encodeURIComponent(c().runId ?? "")}`} title={c().runId ?? ""}>
          <span class="ok">✓</span>
        </A>
      </Show>
    </td>
  );
}

function Unreached(props: { cell: LadderCell }) {
  return (
    <span
      class="dim"
      title={props.cell.status === "not-instrumented" ? "not instrumented" : "not reached"}
    >
      {props.cell.status === "not-instrumented" ? "·" : "—"}
    </span>
  );
}
