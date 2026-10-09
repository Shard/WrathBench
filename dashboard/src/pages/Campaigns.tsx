/**
 * Probe campaigns: the commissioned middle lane.
 *
 * Everything here is unscored by construction, so this page reports coverage
 * rather than performance — which cells have been swept, by which models, and
 * what is left. One pane per campaign VERSION (a checked-in definition), with
 * a cells × models grid: whether each square reached the definition's stop
 * level and how many minutes of play it took. The grid is read, never ranked:
 * cells keep the definition's order and columns the assignments' order, and
 * nothing is sorted by a result (`probing` has no comparability group).
 */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type CampaignRowView, type CampaignsResponse } from "../api/client";
import { Collapsible } from "../components/Collapsible";
import {
  campaignCosts,
  campaignCoverage,
  campaignLiveRuns,
  campaignRowKey,
  campaignState,
  columnLabel,
  columnTitle,
  progressOf,
  squareClass,
  squareText,
  squareTitle,
  type CampaignCost,
  type CampaignRunRow,
} from "../lib/campaigns";
import { useFeeds } from "../lib/feeds";
import { progressLabel, progressTitle, rowProgress, rowStateLabel, runHref } from "../lib/fleet";
import { fmtDuration, fmtUsd, fmtWhen, modelDisplay, shortRunId } from "../lib/format";
import { LevelXp } from "../components/CharacterFacts";
import { poll } from "../lib/poll";
import { displayError } from "../lib/errors";
import { InfoHint } from "../components/InfoHint";

/** What a campaign is, and why nothing here reaches a chart. */
const CAMPAIGNS_NOTE =
  "Commissioned sweeps of a checked-in campaign definition, one pane per version; every run is an unscored probe episode (see the about page), so nothing here reaches a chart or a target.";

/** Campaign progress moves when a probe ends, which is a ~90-minute event. */
const POLL_MS = 60_000;

/**
 * The live rows inside a pane move on their own clock — a level, a playtime —
 * so they are read faster than the campaign totals above them, and on the same
 * cadence the fleet page reads the same feed at. Slower than the fleet's 5s
 * shared poll because this page is not where an operator watches a run; the
 * run page is.
 */
const RUNS_POLL_MS = 10_000;

/** `1 cell` / `3 cells`. The `(s)` form is a note to self and this page is read. */
function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/**
 * The cost figure's tooltip. Its denominator is every run the campaign has,
 * which is not the swept count beside it, so the title says which runs it is.
 */
function costTitle(c: CampaignCost): string {
  const excluded =
    c.asIfMetered === 0
      ? ""
      : `; ${c.asIfMetered} subscription ${plural(c.asIfMetered, "run")} reported an as-if-metered figure, not summed`;
  return `what the providers reported billing, summed over the runs that reported a charge, out of every run recorded against this campaign (live and failed included)${excluded}`;
}

export default function Campaigns() {
  const feed = poll(() => api.campaigns(), POLL_MS);
  // Every run on disk, read for the live rows inside the panes: the campaigns
  // projection carries a live COUNT and no run ids, so the attribution comes
  // from the runs feed (which records the campaign per run) and the state from
  // the shared fleet feed, joined by run id in lib/campaigns.
  const runs = poll(() => api.runs().then((r) => r.runs), RUNS_POLL_MS);
  const { fleet } = useFeeds();
  const body = (): CampaignsResponse | undefined => feed.latest;
  const rows = (): CampaignRowView[] => body()?.campaigns ?? [];
  const live = (): Map<string, CampaignRunRow[]> => campaignLiveRuns(fleet.latest, runs.latest ?? []);
  // Undefined until the runs feed lands, so a pane shows no figure rather than a
  // "0 of 0" that only means the feed is still in flight.
  const cost = (key: string): CampaignCost | undefined =>
    runs.latest === undefined ? undefined : campaignCosts(runs.latest).get(key);
  const keyOf = (row: CampaignRowView): string => campaignRowKey(row.campaign, row.version);

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>
      <Show when={runs.error !== undefined}>
        <div class="banner bad">{displayError(runs.error)}</div>
      </Show>

      <h1>
        campaigns
        <InfoHint label="about this page" text={CAMPAIGNS_NOTE} />
      </h1>

      <Show when={body() !== undefined} fallback={<p class="dim">loading…</p>}>
        <Show when={rows().length === 0}>
          <p class="dim">no campaigns</p>
        </Show>

        <For each={rows()}>
          {(row) => (
            /*
              One pane per campaign version, closed until asked for: the grid is
              a detail, and the page's question — which sweeps exist and how far
              along they are — is answered by the headings alone.

              The storage key is not a nicety here. `poll()` hands back fresh objects
              every tick and `<For>` is keyed on reference, so without it every open
              pane would shut itself once a minute.
            */
            <Collapsible
              title={
                <>
                  <span title={row.definition?.question ?? ""}>{keyOf(row)}</span>{" "}
                  <span class={campaignState(row).cls}>{campaignState(row).label}</span>
                </>
              }
              summary={
                <>
                  {campaignCoverage(row)}
                  <Show when={row.live > 0}> · {row.live} live</Show>
                  <Show when={cost(keyOf(row))}>
                    {(c) => (
                      <>
                        {" · "}
                        <span title={costTitle(c())}>
                          {fmtUsd(c().actualUsd)} actual ({c().reported} of {c().runs} {plural(c().runs, "run")})
                        </span>
                      </>
                    )}
                  </Show>
                  {/* The account NAME is operator detail and is kept out of the
                      public projection; that it is pinned at all is the fact a
                      reader of this page needs. */}
                  <Show when={row.config?.account != null}> · pinned</Show>
                  <Show when={row.newestRunId !== null}>
                    {" · "}
                    <A href={`/run/${encodeURIComponent(row.newestRunId!)}`} title={row.newestRunId!}>
                      newest {fmtWhen(row.newestAt)}
                    </A>
                  </Show>
                </>
              }
              storageKey={`wrathbench.campaigns.${keyOf(row)}`}
            >
              {/*
                What is running right now, listed the way the fleet page lists
                the same rows — same state badge, same lvl/xp and elapsed cells,
                same click-through — because it is the same job seen from the
                campaign's side rather than the supervisor's. The rows are
                joined client-side (lib/campaigns); nothing here re-derives a
                fleet row. Both feeds, not just the runs one: with the fleet
                still in flight the join is legitimately empty.
              */}
              <Show
                when={runs.latest !== undefined && fleet.latest !== undefined}
                fallback={<p class="dim">live runs: loading…</p>}
              >
                <Show when={(live().get(keyOf(row)) ?? []).length > 0}>
                  <div class="scroller">
                    <table>
                      <thead>
                        <tr>
                          <th>state</th>
                          <th>cell</th>
                          <th>character</th>
                          <th>model</th>
                          <th class="right">lvl / xp</th>
                          <th class="right">elapsed</th>
                          <th>run</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={live().get(keyOf(row)) ?? []}>{(r) => <LiveRunRow row={r} />}</For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </Show>

              {/*
                The grid: cells as rows in the definition's order, model
                identities as columns in the assignments' order. A square reads
                reached/counted and the median minutes of play to the stop
                level; a definition with no stop level shows the best level.
              */}
              <div class="scroller">
                <table>
                  <thead>
                    <tr>
                      <th>cell</th>
                      <th>start</th>
                      <th class="right">runs</th>
                      <th class="right" title="best level any run of this cell reached">best</th>
                      <For each={row.columns}>
                        {(col) => (
                          <th class="right" title={columnTitle(col)}>
                            {columnLabel(col, modelDisplay)}
                          </th>
                        )}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={row.cells}>
                      {(c, i) => (
                        <tr>
                          <td>
                            {c.cell}
                            <Show when={!c.declared}>
                              {" "}
                              <span class="dim" title="not a cell of this definition">
                                (undeclared)
                              </span>
                            </Show>
                          </td>
                          <td class="dim" title={c.note ?? ""}>
                            {c.characterLabel ?? "—"}
                            <Show when={c.note !== null}>
                              <span class="dim">*</span>
                            </Show>
                          </td>
                          <td class={`right mono ${c.runs === 0 ? "dim" : ""}`}>{c.runs}</td>
                          <td class="right mono dim">
                            <LevelXp level={c.bestLevel} xp={null} compact />
                          </td>
                          <For each={row.grid[i()] ?? []}>
                            {(sq) => (
                              <td
                                class={squareClass(sq, row.definition?.stopAtLevel ?? null)}
                                title={squareTitle(sq, row.definition?.stopAtLevel ?? null)}
                              >
                                {squareText(sq, row.definition?.stopAtLevel ?? null)}
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Collapsible>
          )}
        </For>

        <Show when={body()!.orphans > 0}>
          <p class="banner warn" title="probe runs no campaign claims, left out of every count above">
            {body()!.orphans} unattributed probe {plural(body()!.orphans, "run")}
          </p>
        </Show>
      </Show>
    </div>
  );
}

/**
 * One live probe inside a pane. The state cell is the fleet's own — its badge,
 * its percentage, its ETA title — so the two pages cannot disagree about what
 * a job is doing.
 *
 * A row with no state is a run the runs feed calls unfinished that no job
 * holds: said plainly rather than dressed as running, because that is a fact
 * worth noticing (an orphaned probe) and not a rendering gap.
 */
function LiveRunRow(props: { row: CampaignRunRow }) {
  const r = (): CampaignRunRow => props.row;
  const prog = () => {
    const p = progressOf(r());
    return p === null ? null : rowProgress(p);
  };
  return (
    <tr>
      <td title={prog() === null ? "" : progressTitle(prog(), r())}>
        <Show
          when={r().state}
          fallback={
            <span class="dim" title="no job in the fleet is driving this run; it recorded no termination either">
              no job
            </span>
          }
        >
          {(state) => (
            <>
              <span class={`dot ${state() === "running" ? "live" : ""}`} />
              <span class={`badge ${state()}`}>{rowStateLabel(state())}</span>
              <Show when={prog() !== null}>
                <span class="dim mono progress">{progressLabel(prog())}</span>
              </Show>
            </>
          )}
        </Show>
      </td>
      <td class="dim">{r().cell ?? "—"}</td>
      <td>{r().character ?? "—"}</td>
      <td
        class="dim"
        title={[r().model ?? "", r().attempt === null ? "" : `attempt #${r().attempt}`].filter((t) => t.length > 0).join(" — ")}
      >
        {r().model === null ? "—" : modelDisplay(r().model!)}
      </td>
      <td class="right mono">
        <LevelXp level={r().level} xp={r().xp} compact />
      </td>
      <td class="right mono dim">{fmtDuration(r().elapsedMs)}</td>
      <td>
        <Show when={runHref(r().runId)} fallback={<span title={r().runId}>{shortRunId(r().runId)}</span>}>
          {(to) => (
            <A href={to()} title={r().runId}>
              {shortRunId(r().runId)}
            </A>
          )}
        </Show>
      </td>
    </tr>
  );
}
