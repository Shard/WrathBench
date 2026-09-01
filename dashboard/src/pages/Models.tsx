/**
 * The roster, with the scheduler's verdict on each model.
 *
 * One row per roster entry, and every number on it arrives decided from
 * `/api/models` — which serves the same projection `run-fleet --status` prints,
 * so the page and the supervisor cannot disagree about why a model is not
 * running. Nothing is recomputed here.
 *
 * **Counted** runs are the ones that produced a model response, and they are
 * what a target counts. A launch that produced none is archived by the runner
 * as it exits, so it never appears here at all — it still climbs the defer
 * ladder, which is what the cooling and retired notes are reporting.
 *
 * The row key is the roster name, and it is also the anchor: run pages and results
 * rows link to `/models#<name>`, so a name is an address.
 */

import { A } from "@solidjs/router";
import { For, Show, createSignal, onMount } from "solid-js";
import { SNAPSHOT_MODE, api, type ModelRowView, type ModelsResponse } from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { ModelIcon } from "../components/ModelIcon";
import { fmtCost, fmtDuration, fmtWhen, modelDisplay, shortRunId } from "../lib/format";
import { EPISODE_COLUMNS, MODEL_COLUMNS, columnClass, compareModelRows, countedOf, extrasOf, highestTierOf, isPromoted, noteOf, resolvedSummary, schedulableOf, statusClass, tierOf, tierTitle } from "../lib/models";
import { poll } from "../lib/poll";
import { runsHref } from "../lib/runs";
import { displayError } from "../lib/errors";

/** The roster moves when a run ends or an operator edits the config. */
const POLL_MS = 30_000;

export default function Models() {
  const feed = poll(() => api.models(), POLL_MS);
  const body = (): ModelsResponse | undefined => feed.latest;
  // Copied before sorting: the array is the poll signal's own payload.
  const rows = (): ModelRowView[] => [...(body()?.models ?? [])].sort(compareModelRows);
  const [open, setOpen] = createSignal<string | null>(null);

  // A link from a run page arrives as `/models#<name>`: open that row.
  onMount(() => {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (hash.length > 0) setOpen(hash);
  });

  const toggle = (name: string): void => {
    setOpen(open() === name ? null : name);
  };

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>

      <h2 class="section">models</h2>
      <p class="dim">
        The fleet roster and what the scheduler makes of it. A model is eligible for{" "}
        <A href="/about">e90</A> from the moment it is listed, and a <code>t1</code> model earns{" "}
        <code>e360</code> by reaching level 5 in an un-overridden e90 run. Counts are <em>counted</em> runs —
        launches that produced at least one model response; a launch that produced none is archived
        as it ends, and consecutive ones are what the defer ladder backs off from.
      </p>

      <Show when={body() !== undefined} fallback={<p class="dim">loading…</p>}>
        {/*
          Operator-facing: a public reader cannot point a viewer at a config,
          and the message names a host path and an env var. The public build
          shows nothing rather than a repair instruction addressed to nobody.
        */}
        <Show when={!SNAPSHOT_MODE && body()!.roster.shape !== "roster"}>
          <div class="banner warn">
            <Show
              when={body()!.roster.shape === "unreadable"}
              fallback={
                <>
                  No fleet config was found
                  <Show when={body()!.roster.path !== null}> at {body()!.roster.path}</Show>. Point
                  the viewer at one with <code>WRATHBENCH_FLEET_CONFIG</code>.
                </>
              }
            >
              The fleet config at {body()!.roster.path} could not be read as a roster (a{" "}
              <code>roster</code> map names the models). Fix the file and the rows appear.
            </Show>
          </div>
        </Show>

        <div class="scroller">
          <table>
            <thead>
              <tr>
                {/* From the array, so the header cannot outnumber the body again. */}
                <For each={MODEL_COLUMNS}>{(c) => <th class={columnClass(c)}>{c}</th>}</For>
              </tr>
            </thead>
            <tbody>
              {/* A roster the API answered with no rows in: said in the table
                  rather than as an empty body, which reads as a render failure. */}
              <Show when={rows().length === 0}>
                <tr>
                  <td colSpan={MODEL_COLUMNS.length} class="dim">
                    No models on the roster.
                  </td>
                </tr>
              </Show>
              <For each={rows()}>
                {(row) => (
                  <>
                    <tr
                      id={row.name}
                      onClick={() => toggle(row.name)}
                      style={{ cursor: "pointer" }}
                      title="show this model's runs"
                    >
                      <td>
                        <span class={`badge ${statusClass(row.status)}`}>{row.status}</span>
                      </td>
                      <td>
                        {/*
                          The family's mark leads the cell, from the model id
                          rather than the roster name. It sits left of the whole
                          name-and-ids block and centred against it, at twice the
                          inline size: this page is the roster, and the mark is
                          what a reader scans it by.
                        */}
                        <div class="model-idcell">
                        <ModelIcon model={row.model} size="lg" />
                        <div>
                        {row.name}
                        <Show when={isPromoted(row)}>
                          {" "}
                          <span class="ok" title="promoted: it earned this tier">
                            ↑{highestTierOf(row)}
                          </span>
                        </Show>
                        <div class="dim" title={row.model}>
                          {modelDisplay(row.model)}
                          <Show when={row.effort !== null}> · {row.effort}</Show>
                        </div>
                        {/* The row stays grouped by the roster's model string —
                            that is the unit the scheduler counts in — and this
                            says what that string actually resolved to. More than
                            one id is an alias that moved under the entry. */}
                        <Show when={resolvedSummary(row.model, row.resolvedModels)}>
                          {(seen) => (
                            <div class="dim" title={`${seen().ids.join(", ")} — the id(s) the provider actually served`}>
                              {seen().ids.map(modelDisplay).join(", ")}
                              <Show when={seen().mixed}>
                                {" "}
                                <span class="warn" title="this entry's runs were not all on the same model">
                                  mixed
                                </span>
                              </Show>
                            </div>
                          )}
                        </Show>
                        </div>
                        </div>
                      </td>
                      <td class="mono" title={tierTitle(row)}>
                        {tierOf(row)}
                      </td>
                      <td class="dim">{row.platform ?? "—"}</td>
                      <td>
                        <HarnessTag harness={row.harness} />
                      </td>
                      <For each={EPISODE_COLUMNS}>
                        {(t) => {
                          const st = (): ModelRowView["perEpisode"][typeof t] => row.perEpisode[t];
                          return (
                            <td class="right mono">
                              <Show when={row.eligible.includes(t)} fallback={<span class="dim">—</span>}>
                                <A
                                  href={runsHref({ model: row.model, effort: row.effort, episode: t })}
                                >
                                  {countedOf(st())}
                                </A>
                                <Show when={(st()?.bestLevel ?? null) !== null}>
                                  {" "}
                                  <span class="dim">L{st()!.bestLevel}</span>
                                </Show>
                              </Show>
                            </td>
                          );
                        }}
                      </For>
                      <td class="right mono dim" title={schedulableOf(row)}>
                        {extrasOf(row)}
                      </td>
                      <td class={row.retired !== undefined ? "err" : row.cooling !== undefined ? "warn" : "dim"}>
                        {noteOf(row) ?? "—"}
                      </td>
                      <td class="dim">
                        <Show when={row.newestRunId} fallback="—">
                          {(id) => <A href={`/run/${encodeURIComponent(id())}`}>{id()}</A>}
                        </Show>
                      </td>
                    </tr>
                    <Show when={open() === row.name}>
                      <tr>
                        <td colSpan={MODEL_COLUMNS.length}>
                          <Detail row={row} />
                        </td>
                      </tr>
                    </Show>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </div>

        <Show when={rows().length > 0}>
          <p class="dim">
            A model's budget is its tier
            {/* Tolerate an API older than this bundle: a viewer and a dist/ are
                two artefacts and they can be restarted out of order (item 64).
                Missing detail is worth a shorter sentence, never a blank page. */}
            <Show when={body()!.policy.tiers !== undefined} fallback=".">
              {": "}
              {Object.entries(body()!.policy.tiers)
                .map(([t, spec]) => `${t} ${spec.label} — ${spec.runsPerEpisode.e90}x e90${spec.runsPerEpisode.e360 > 0 ? ` + ${spec.runsPerEpisode.e360}x e360` : ""}`)
                .join("; ")}
              .
            </Show>{" "}
            A tier that buys no e360 is not eligible for one, and t0 never promotes itself out —
            an operator moves it, and the promotion it earned still counts when they do. Rows are
            ordered by tier, highest first; an episode cell links to that model's runs on the runs
            page, and the row itself opens its runs below. Cooling is the defer ladder — the
            scheduler backs off over {body()!.ladderMs.length} steps, ending at{" "}
            {fmtDuration(body()!.ladderMs[body()!.ladderMs.length - 1] ?? null)}; one more
            no-progress attempt at the ceiling retires the model until an operator clears it.
            <Show when={Object.keys(body()!.policy.maxConcurrent).length > 0}>
              {" "}
              At most{" "}
              {Object.entries(body()!.policy.maxConcurrent)
                .map(([key, n]) => `${n} on ${key}`)
                .join(", ")}{" "}
              at a time, counting every run on the key.
              {/*
                A `claude-code:<VAR>` key is one Claude SUBSCRIPTION, and a run
                spends both it and the `claude-code` total — without this the
                two numbers read as a contradiction rather than a ceiling and
                a per-account share of it.
              */}
              <Show
                when={
                  !SNAPSHOT_MODE &&
                  Object.keys(body()!.policy.maxConcurrent).some((k) => k.startsWith("claude-code:"))
                }
              >
                {" "}
                A <code>claude-code:&lt;VAR&gt;</code> key is one Claude subscription (named by the env var
                holding its token): a run needs a free slot on its own subscription <em>and</em> under the{" "}
                <code>claude-code</code> total.
              </Show>
            </Show>
          </p>
        </Show>

        {/*
          Roster entries the policy does not schedule are named, not rowed. One
          reason is left — a pinned job holds that account — since the roster
          became a catalog: an entry cannot carry an objective, and a probe
          campaign BORROWS a catalog entry rather than taking it out of the
          schedule, so it produces no exclusion at all.
        */}
        <Show when={body()!.roster.excluded.length > 0}>
          <p class="dim">
            Outside the policy, so not listed above:{" "}
            <For each={body()!.roster.excluded}>
              {(e, i) => (
                <>
                  <Show when={i() > 0}>, </Show>
                  {/* The name stays an address (`/models#<name>`) even though
                      it is no longer a row, so an older link still lands. */}
                  <span id={e.name} title={e.reason}>{e.name}</span> ({e.reason})
                </>
              )}
            </For>
            .
          </p>
        </Show>
      </Show>
    </div>
  );
}

/** One model's runs, newest first: the panel a row click opens. */
function Detail(props: { row: ModelRowView }) {
  return (
    <div class="detail">
      <Show when={props.row.lastError !== null}>
        <p class="err">
          last error ({props.row.lastError!.reason}) in{" "}
          <A href={`/run/${encodeURIComponent(props.row.lastError!.runId)}`} title={props.row.lastError!.runId}>
            {shortRunId(props.row.lastError!.runId)}
          </A>
          {/* The message is projected out publicly; without one there is nothing to introduce. */}
          <Show when={props.row.lastError!.message !== ""}>
            : <span class="mono">{props.row.lastError!.message}</span>
          </Show>
        </p>
      </Show>
      <Show
        when={props.row.runs.length > 0}
        fallback={<p class="dim">no stamped runs yet — an unstamped run predates the tiers and is never back-labeled.</p>}
      >
        <table>
          <thead>
            <tr>
              <th>run</th>
              <th>episode</th>
              <th title="the starting character this run was launched on — a campaign cell for a probe, the entry's own otherwise">character</th>
              <th class="right">level</th>
              <th>ended</th>
              <th class="right">wall clock</th>
              <th class="right" title="what the provider charged; blank when it reported none — the run page also carries the list-price estimate">
                cost
              </th>
              <th>termination</th>
              <th>counts</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.row.runs}>
              {(r) => (
                <tr>
                  <td>
                    <A href={`/run/${encodeURIComponent(r.runId)}`}>{r.runId}</A>
                  </td>
                  <td class="dim">
                    {r.episode}
                    <Show when={r.episodeOverride}> (overridden)</Show>
                  </td>
                  {/* A probe campaign's cells vary race and class; everything else
                      starts on the entry's own character. */}
                  <td class="dim">{r.characterLabel ?? "—"}</td>
                  <td class="right mono">{r.bestLevel ?? "—"}</td>
                  <td class="dim">{r.live ? "live" : fmtWhen(r.endedAt)}</td>
                  <td class="right mono dim">{fmtDuration(r.durationMs)}</td>
                  {/* The provider's own charge only. The list-price estimate is
                      a reconstruction and belongs on the run page next to the
                      tokens it was computed from, not in a column read as a
                      bill; a blank here means nobody billed us a number. */}
                  {/* `fmtCost` rather than a bare figure: the number alone
                      invites a reconstruction to be read as an invoice, and a
                      subscription run's figure is as-if-metered. */}
                  <td
                    class="right mono dim"
                    title={r.cost?.actual.note ?? "provider reports no cost for this run"}
                  >
                    {fmtCost(r.cost?.actual, "—")}
                  </td>
                  <td class={r.terminationReason === "adapter-error" ? "err" : "dim"}>
                    {r.terminationReason ?? (r.live ? "—" : "no record")}
                  </td>
                  <td class={r.counted ? "ok" : "warn"}>
                    {r.counted ? "counted" : r.episodeOverride ? "overridden" : "not counted"}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
