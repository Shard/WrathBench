/**
 * Probe campaigns: the commissioned middle lane.
 *
 * Everything here is unscored by construction, so this page reports coverage
 * rather than performance — which cells have been swept, by how many models,
 * and what is left. There are no numbers to rank and none are offered; the
 * question a probe answers is "what happens when", and the answer is in the
 * runs.
 *
 * A row whose campaign is no longer in the config is not an error and is not
 * hidden. Retiring a sweep means switching it off and eventually deleting its
 * entry, and its results have to survive that or the lifecycle would be a way
 * of losing them.
 */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type CampaignRowView, type CampaignsResponse } from "../api/client";
import { Collapsible } from "../components/Collapsible";
import { campaignLiveRuns, progressOf, type CampaignRunRow } from "../lib/campaigns";
import { useFeeds } from "../lib/feeds";
import { progressLabel, progressTitle, rowProgress, rowStateLabel, runHref } from "../lib/fleet";
import { fmtDuration, fmtWhen, num } from "../lib/format";
import { poll } from "../lib/poll";

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

/** Cells done out of cells wanted, when the config still says what was wanted. */
function coverage(row: CampaignRowView): string {
  if (row.config === null) return `${row.cells.length} cell(s) run`;
  const want = row.config.cells.length * row.config.runsPerCell * row.config.models;
  return `${row.runs}/${want} run(s)`;
}

function stateOf(row: CampaignRowView): { label: string; cls: string } {
  if (row.config === null) return { label: "retired", cls: "dim" };
  // A finished sweep reads quieter than a running one: same green, faded, so
  // the vivid one on the page always means "something is happening here".
  if (row.config.complete) return { label: "complete", cls: "ok-muted" };
  if (!row.config.enabled) return { label: "off", cls: "warn" };
  return { label: "sweeping", cls: "ok" };
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

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{String(feed.error)}</div>
      </Show>
      <Show when={runs.error !== undefined}>
        <div class="banner bad">{String(runs.error)}</div>
      </Show>

      <h2 class="section">campaigns</h2>
      <p class="dim">
        Commissioned exploration: an objective swept over <em>cells</em> by a set of models, run once
        to completion and then switched off. Every run is an unscored{" "}
        <A href="/episodes">probing</A> episode, so nothing here reaches a chart or a target — a
        harness bump never re-arms a campaign, which is exactly what separates a probe from an eval.
        Coverage is what this page reports; there is no ranking to make.
      </p>

      <Show when={body() !== undefined} fallback={<p class="dim">loading…</p>}>
        <Show when={rows().length === 0}>
          <p class="dim">
            No campaigns and no probe runs
            <Show when={body()!.configPath !== null}> — {body()!.configPath} names none</Show>.
          </p>
        </Show>

        <For each={rows()}>
          {(row) => (
            /*
              One pane per campaign, closed until asked for: a sweep's cell table
              is a detail, and the page's question — which sweeps exist and how far
              along they are — is answered by the headings alone. The state word and
              the coverage counts stay in the header row for that reason.

              The storage key is not a nicety here. `poll()` hands back fresh objects
              every tick and `<For>` is keyed on reference, so without it every open
              pane would shut itself once a minute.
            */
            <Collapsible
              title={
                <>
                  {row.campaign} <span class={stateOf(row).cls}>{stateOf(row).label}</span>
                </>
              }
              summary={
                <>
                  {coverage(row)}
                  <Show when={row.live > 0}> · {row.live} live</Show>
                  <Show when={row.config?.account != null}> · pinned to {row.config!.account}</Show>
                </>
              }
              storageKey={`wrathbench.campaigns.${row.campaign}`}
            >
              <p class="dim">
                <Show
                  when={row.config !== null}
                  fallback={
                    /* Not an error: see the module comment. The runs are the record. */
                    <>
                      No config entry names this campaign any more, so there is nothing to compare
                      its runs against. They are still its results.
                    </>
                  }
                >
                  {row.config!.models} model(s) × {row.config!.cells.length} cell(s) ×{" "}
                  {row.config!.runsPerCell} run(s) per cell.
                </Show>
                <Show when={row.newestRunId !== null}>
                  {" "}
                  Newest:{" "}
                  <A href={`/run/${encodeURIComponent(row.newestRunId!)}`}>{row.newestRunId}</A>{" "}
                  ({fmtWhen(row.newestAt)}).
                </Show>
              </p>

              {/*
                What is running right now, listed the way the fleet page lists
                the same rows — same state badge, same lvl/xp and elapsed cells,
                same click-through — because it is the same job seen from the
                campaign's side rather than the supervisor's. The rows are
                joined client-side (lib/campaigns); nothing here re-derives a
                fleet row.
              */}
              <Show
                when={runs.latest !== undefined}
                fallback={<p class="dim">live runs: loading…</p>}
              >
                <Show
                  when={(live().get(row.campaign) ?? []).length > 0}
                  fallback={<p class="dim">No live runs.</p>}
                >
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
                        <For each={live().get(row.campaign) ?? []}>{(r) => <LiveRunRow row={r} />}</For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </Show>

              <div class="scroller">
                <table>
                  <thead>
                    <tr>
                      <th>cell</th>
                      <th class="right">runs</th>
                      <th class="right" title="the best level any run of this cell reached — a coverage signal, never a score">
                        best level
                      </th>
                      <th>models</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={row.cells}>
                      {(c) => (
                        <tr>
                          <td>
                            {c.cell}
                            {/* A cell the config dropped after runs happened: shown,
                                because pretending the run did not happen is worse. */}
                            <Show when={!c.declared}>
                              {" "}
                              <span class="dim" title="no longer declared by the config">
                                (undeclared)
                              </span>
                            </Show>
                          </td>
                          <td class={`right mono ${c.runs === 0 ? "dim" : ""}`}>{c.runs}</td>
                          <td class="right mono dim">{c.bestLevel ?? "—"}</td>
                          <td class="dim">{c.models.length > 0 ? c.models.join(", ") : "—"}</td>
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
          <p class="banner warn">
            {body()!.orphans} probing run(s) recorded no campaign. That should not be possible — a
            probe is always launched stamped — so these are worth looking at rather than counting.
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
      <td class="dim" title={r().account === null ? "" : `on ${r().account}${r().attempt === null ? "" : `, attempt #${r().attempt}`}`}>
        {r().model ?? "—"}
      </td>
      <td class="right mono">{r().level === null ? "—" : `L${r().level} ${num(r().xp)}`}</td>
      <td class="right mono dim">{fmtDuration(r().elapsedMs)}</td>
      <td>
        <Show when={runHref(r().runId)} fallback={r().runId}>
          {(to) => <A href={to()}>{r().runId}</A>}
        </Show>
      </td>
    </tr>
  );
}
