/**
 * The roster, with the scheduler's verdict on each model (ADR-0031, ADR-0032).
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
 * The row key is the roster name, and it is also the anchor: run pages and eval
 * rows link to `/models#<name>`, so a name is an address.
 */

import { A } from "@solidjs/router";
import { For, Show, createSignal, onMount } from "solid-js";
import { api, type ModelRowView, type ModelsResponse } from "../api/client";
import { HarnessTag } from "../components/EpisodePicker";
import { fmtDuration, fmtUsd, fmtWhen } from "../lib/format";
import { TIER_COLUMNS, countedOf, extrasOf, isPromoted, noteOf, schedulableOf, statusClass } from "../lib/models";
import { poll } from "../lib/poll";

/** The roster moves when a run ends or an operator edits the config. */
const POLL_MS = 30_000;

export default function Models() {
  const feed = poll(() => api.models(), POLL_MS);
  const body = (): ModelsResponse | undefined => feed.latest;
  const rows = (): ModelRowView[] => body()?.models ?? [];
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
        <div class="banner bad">{String(feed.error)}</div>
      </Show>

      <h2 class="section">models</h2>
      <p class="dim">
        The fleet roster and what the scheduler makes of it. A model is eligible for{" "}
        <A href="/episodes">e90</A> from the moment it is listed and earns <code>e360</code> by
        reaching level 5 in an un-overridden e90 run (ADR-0030). Counts are <em>counted</em> runs —
        launches that produced at least one model response; a launch that produced none is archived
        as it ends, and consecutive ones are what the defer ladder backs off from.
      </p>

      <Show when={body() !== undefined} fallback={<p class="dim">loading…</p>}>
        <Show when={body()!.roster.shape !== "roster"}>
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
              The fleet config at {body()!.roster.path} could not be read as a roster (ADR-0031: a{" "}
              <code>roster</code> map names the models). Fix the file and the rows appear.
            </Show>
          </div>
        </Show>

        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>status</th>
                <th>model</th>
                <th>billing</th>
                <th>platform</th>
                <th>harness</th>
                <For each={TIER_COLUMNS}>{(t) => <th class="right">{t}</th>}</For>
                <th class="right">extras</th>
                <th>schedulable</th>
                <th>note</th>
                <th>newest run</th>
              </tr>
            </thead>
            <tbody>
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
                        {row.name}
                        <Show when={isPromoted(row)}>
                          {" "}
                          <span class="ok" title="promoted into e360">
                            ↑e360
                          </span>
                        </Show>
                        <div class="dim">
                          {row.model}
                          <Show when={row.effort !== null}> · {row.effort}</Show>
                        </div>
                      </td>
                      <td class="dim">{row.billing}</td>
                      <td class="dim">{row.platform ?? "—"}</td>
                      <td>
                        <HarnessTag harness={row.harness} />
                      </td>
                      <For each={TIER_COLUMNS}>
                        {(t) => {
                          const st = (): ModelRowView["perEpisode"][typeof t] => row.perEpisode[t];
                          return (
                            <td class="right mono">
                              <Show when={row.eligible.includes(t)} fallback={<span class="dim">—</span>}>
                                <A
                                  href={`/eval?model=${encodeURIComponent(row.model)}${row.effort === null ? "" : `&effort=${encodeURIComponent(row.effort)}`}&episode=${t}`}
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
                      <td class="right mono dim">{extrasOf(row)}</td>
                      <td class={row.schedulable.ok ? "ok" : "dim"} title={row.schedulable.why}>
                        {schedulableOf(row)}
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
                        <td colSpan={8 + TIER_COLUMNS.length}>
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
            Targets are {body()!.policy.runsPerEpisode.e90} runs on e90 and{" "}
            {body()!.policy.runsPerEpisode.e360} on e360, counted per model. A row's tier cell links
            to that model's runs on the eval page; the row itself opens its runs below. Cooling is
            the defer ladder ({body()!.ladderMs.length} rungs, ending at{" "}
            {fmtDuration(body()!.ladderMs[body()!.ladderMs.length - 1] ?? null)}) — one more
            no-progress attempt at the ceiling retires the model until an operator clears it.
            <Show when={Object.keys(body()!.policy.maxConcurrent).length > 0}>
              {" "}
              At most{" "}
              {Object.entries(body()!.policy.maxConcurrent)
                .map(([driver, n]) => `${n} on ${driver}`)
                .join(", ")}{" "}
              at a time, counting every job on the driver.
            </Show>
          </p>
        </Show>

        {/*
          Roster entries the policy does not schedule are named, not rowed: a
          probe on a pinned account runs the same model under an objective, so a
          row would show that model's counts twice (FOLLOW-UPS 52).
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
          <A href={`/run/${encodeURIComponent(props.row.lastError!.runId)}`}>
            {props.row.lastError!.runId}
          </A>
          : <span class="mono">{props.row.lastError!.message}</span>
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
              <th title="the starting character this run was launched on (ADR-0034's extras cycle)">character</th>
              <th class="right">level</th>
              <th>ended</th>
              <th class="right">wall clock</th>
              <th class="right" title="what the provider charged; blank when it reported none — the run page also carries the list-price estimate">
                cost (actual)
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
                  {/* Extras cycle through races and classes; the baseline is Human Paladin. */}
                  <td class="dim">{r.characterLabel ?? "—"}</td>
                  <td class="right mono">{r.bestLevel ?? "—"}</td>
                  <td class="dim">{r.live ? "live" : fmtWhen(r.endedAt)}</td>
                  <td class="right mono dim">{fmtDuration(r.durationMs)}</td>
                  {/* The provider's own charge only. The list-price estimate is
                      a reconstruction and belongs on the run page next to the
                      tokens it was computed from, not in a column read as a
                      bill; a blank here means nobody billed us a number. */}
                  <td
                    class="right mono dim"
                    title={r.cost?.actual.note ?? "provider reports no cost for this run"}
                  >
                    {r.cost == null || r.cost.actual.basis === "none" ? "—" : fmtUsd(r.cost.actual.usd)}
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
