/**
 * Probe campaigns: the commissioned middle lane (ADR-0041).
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
import { fmtWhen } from "../lib/format";
import { poll } from "../lib/poll";

/** Campaign progress moves when a probe ends, which is a ~90-minute event. */
const POLL_MS = 60_000;

/** Cells done out of cells wanted, when the config still says what was wanted. */
function coverage(row: CampaignRowView): string {
  if (row.config === null) return `${row.cells.length} cell(s) run`;
  const want = row.config.cells.length * row.config.runsPerCell * row.config.models;
  return `${row.runs}/${want} run(s)`;
}

function stateOf(row: CampaignRowView): { label: string; cls: string } {
  if (row.config === null) return { label: "retired", cls: "dim" };
  if (row.config.complete) return { label: "complete", cls: "ok" };
  if (!row.config.enabled) return { label: "off", cls: "warn" };
  return { label: "sweeping", cls: "ok" };
}

export default function Campaigns() {
  const feed = poll(() => api.campaigns(), POLL_MS);
  const body = (): CampaignsResponse | undefined => feed.latest;
  const rows = (): CampaignRowView[] => body()?.campaigns ?? [];

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{String(feed.error)}</div>
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
            <section class="detail">
              <h3>
                {row.campaign}{" "}
                <span class={stateOf(row).cls}>{stateOf(row).label}</span>{" "}
                <span class="dim">
                  · {coverage(row)}
                  <Show when={row.live > 0}> · {row.live} live</Show>
                  <Show when={row.config?.account != null}> · pinned to {row.config!.account}</Show>
                </span>
              </h3>
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
            </section>
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
