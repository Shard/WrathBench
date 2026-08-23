/**
 * The ladder of docs/VISION.md, with the highest rung each model has reached.
 *
 * Rungs are read from one episode tier at a time — e90 by default (ADR-0030) —
 * because a rung reached in six hours is not the same claim as the same rung
 * reached in ninety minutes. The count of what the filter removed is on the
 * page, not in a footnote.
 *
 * Three of the eight rungs cannot be answered by anything the harness records
 * today — zone and area changes, flight paths, and group joins are not in the
 * trajectory (FOLLOW-UPS 35). Those read "not instrumented" rather than being
 * approximated by a level threshold, and every derived rung prints the exact
 * rule it applied so a reader can disagree with the derivation.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, on } from "solid-js";
import { api, type EvalResponse, type EvalRun } from "../api/client";
import { EpisodeFilterNote, EpisodePicker, episodeParam } from "../components/EpisodePicker";
import { RUNGS, ladderRows, scored, type LadderCell } from "../lib/eval";
import { poll } from "../lib/poll";

const POLL_MS = 30_000;

export default function Ladder() {
  const [params, setParams] = useSearchParams();
  const episode = (): ReturnType<typeof episodeParam> => episodeParam(params.episode);
  const overrides = (): boolean => params.overrides === "1";
  // Stillborn runs — launches with no model response — are hidden by default;
  // the choice rides in the URL like the tier does, so a link keeps its meaning.
  const stillborn = (): boolean => params.stillborn === "1";
  // `/api/ladder` is the same projection as `/api/eval`; the rung rules stay
  // client-side, in `lib/eval.ts`, where their tests are.
  const feed = poll(() => api.ladder(episode(), overrides(), stillborn()), POLL_MS);
  createEffect(on([episode, overrides, stillborn], () => feed.refresh(), { defer: true }));
  const body = (): EvalResponse | undefined => feed.latest;
  const runs = (): EvalRun[] => body()?.runs ?? [];
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
        stillborn={body()?.stillbornExcluded ?? 0}
        includeStillborn={stillborn()}
        onStillbornChange={(v) => setParams({ stillborn: v ? "1" : null }, { replace: true })}
      />

      <Show when={feed.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <EpisodeFilterNote
          episode={episode()}
          filteredOut={body()?.filteredOut ?? 0}
          overridesExcluded={body()?.overridesExcluded ?? 0}
          stillborn={body()?.stillbornExcluded ?? 0}
          includeStillborn={stillborn()}
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
                <th class="right">runs</th>
                <th class="right">highest</th>
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
                    <td>{row.model}</td>
                    <td class="right mono dim">{row.runs}</td>
                    <td class="right mono">{row.highest === 0 ? "—" : row.highest}</td>
                    <For each={row.cells}>{(cell) => <RungCell cell={cell} />}</For>
                  </tr>
                )}
              </For>
              <Show when={rows().length === 0}>
                <tr>
                  <td colSpan={3 + RUNGS.length} class="dim">
                    No scorable runs recorded yet.
                  </td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>

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
