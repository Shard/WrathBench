/**
 * Fleet overview: what the supervisor is running, right now.
 *
 * One grain per page (decided 2026-08-23). This one is the fleet's:
 * one table keyed by the job with the idle accounts under it, the
 * paused and ended runs. The per-run grain is the episodes page, and a job's
 * run link is the only per-run reference here.
 *
 * The table is the page. The supervisor's liveness, the deploy phase, the
 * outstanding work and the account counts that used to head it as four lines
 * of counters (the "stats strip") now live in the service status badge in the
 * top bar (`components/StatusBadge.tsx`), where they are about the service
 * and not about this page. What remains above the table is only what needs
 * acting on: a deploy window or verdict, a REJECTED fleet.json, a failed gate.
 *
 * Two feeds, deliberately independent. `/api/fleet` is the supervisor's own
 * published view — jobs, accounts, a heartbeat, the gate — shared with the
 * badge through `lib/feeds.ts` so it is polled once. `/api/runs` is the
 * filesystem's view, read because the job rows carry the level, xp and
 * elapsed time of the run each job is driving.
 */

import { A, useNavigate } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type FleetResponse } from "../api/client";
import {
  FLEET_COLUMNS,
  fleetRows,
  gateVerdict,
  pausedLabel,
  progressLabel,
  progressTitle,
  rowProgress,
  rowStateLabel,
  runHref,
  serverBanner,
  type FleetRow,
} from "../lib/fleet";
import { useFeeds } from "../lib/feeds";
import { fmtDuration, fmtTokens, fmtUsd, num, stamp } from "../lib/format";
import { poll } from "../lib/poll";

export default function Fleet() {
  // Every run on disk — read for the job rows and the link to the episodes page, not to be listed here.
  const runs = poll(() => api.runs().then((r) => r.runs), 10_000);
  const { fleet } = useFeeds();

  return (
    <div class="page">
      <Show when={runs.error !== undefined}>
        <div class="banner bad">{String(runs.error)}</div>
      </Show>

      <h2 class="section">fleet</h2>
      {/*
        The server's phase first, in one line, in the deploy script's own words
        (infra/deploy-worldserver.sh writes data/runs/server-state.json at each
        transition). Shown even with no fleet state: a deploy can run on a
        machine the fleet has never run on.
      */}
      {/* A deploy window or verdict, in the deploy script's own words; nothing at rest. */}
      <Show when={fleet.latest !== undefined && serverBanner(fleet.latest.server)}>
        {(b) => (
          <Show when={b().tone !== "dim"}>
            <div class={b().tone === "bad" ? "banner bad" : "banner warn"}>{b().text}</div>
          </Show>
        )}
      </Show>
      <Show
        when={fleet.latest?.present === true}
        fallback={<p class="dim">No fleet-state.json — the fleet has never run here.</p>}
      >
        {(() => {
          const f = (): FleetResponse => fleet.latest!;
          return (
            <>
              {/*
                The REJECTED banner first, as --status prints it: the failure it
                covers is silent by construction — the operator's edit parses
                for them and is ignored by the supervisor.
              */}
              <Show when={f().configRejected}>
                {(rej) => (
                  <div class="banner bad">
                    fleet.json REJECTED since {stamp(rej().since)}: {rej().error} — running on config loaded at{" "}
                    {f().configLoadedAt === undefined ? "an unrecorded time" : stamp(f().configLoadedAt!)}; job enabled
                    flags in the file are NOT in effect. The supervisor retries every tick and clears this by itself.
                  </div>
                )}
              </Show>

              {/* The preflight gate only when it blocks: a PASS is not news. */}
              <Show when={gateVerdict(f().preflight) === "FAIL"}>
                <div class="banner bad">
                  preflight FAIL — jobs blocked
                  <For each={f().preflight?.results.filter((r) => !r.ok) ?? []}>
                    {(r) => <span title={r.tail}> · {r.script} ({Math.round(r.ms / 1000)}s)</span>}
                  </For>
                </div>
              </Show>

              <div class="scroller">
                <table>
                  <thead>
                    <tr>
                      <For each={FLEET_COLUMNS}>{(c) => <th>{c}</th>}</For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={fleetRows(f(), runs.latest ?? [])}>{(row) => <FleetRowView row={row} />}</For>
                  </tbody>
                </table>
              </div>
              <p class="dim">
                <A href="/episodes?episode=all">{runs.latest?.length ?? "—"} runs recorded</A> · the{" "}
                <A href="/models">models table</A> carries the scheduler's verdict per roster entry.
              </p>

              {/* Paused runs the supervisor is not resuming, and why; the ones it ended instead. */}
              <Show when={f().paused.length > 0}>
                <p class="dim">paused runs not resumed ({f().paused.length}):</p>
                <ul class="dim">
                  <For each={f().paused}>
                    {(p) => (
                      <li>
                        <A href={`/run/${encodeURIComponent(p.runId)}`}>{p.runId}</A> — {p.model}
                        <Show when={p.account !== null}> on {p.account}</Show>: {pausedLabel(p)},{" "}
                        {fmtDuration(p.elapsedMs)} elapsed
                        <Show when={p.budgetMs !== null}> of {fmtDuration(p.budgetMs)}</Show> — {p.why}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={f().ended.length > 0}>
                <p class="dim">ended by the supervisor this session ({f().ended.length}):</p>
                <ul class="dim">
                  <For each={f().ended}>
                    {(e) => (
                      <li>
                        <A href={`/run/${encodeURIComponent(e.runId)}`}>{e.runId}</A> — {e.detail}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </>
          );
        })()}
      </Show>

    </div>
  );
}

/**
 * One row of the fleet table: a job on its account, or an account holding
 * nothing. The whole row is a click-through to the run it is about, so the
 * table is a way into a live run and not just a status readout — the run cell
 * carries the same link for anyone tabbing rather than clicking, and the
 * handler stands aside when the click already landed on that anchor.
 */
function FleetRowView(props: { row: FleetRow }) {
  const navigate = useNavigate();
  const r = (): FleetRow => props.row;
  const href = (): string | null => runHref(r().runId);
  const onClick = (e: MouseEvent): void => {
    const to = href();
    if (to === null || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if ((e.target as Element | null)?.closest("a") !== null) return;
    navigate(to);
  };
  const dot = (): string => (r().state === "exited" ? "dead" : r().state === "running" ? "live" : "");
  /*
    Both numbers come off the 10s poll of /api/runs, which charges a live run's
    playtime up to request time — so the cell refreshes on the page's own
    cadence, and numerator and denominator come from one snapshot and cannot
    tear. No second timer: a figure up to ten seconds stale is fine here.
  */
  const prog = () => rowProgress(r());
  return (
    <tr onClick={onClick} class={href() === null ? undefined : "clickable"}>
      {/* The percentage rides beside the badge, and the ETA is the cell's title; both absent on a row that is not advancing (see `rowProgress`). */}
      <td title={progressTitle(prog(), r())}>
        <span class={`dot ${dot()}`} />
        <span class={`badge ${r().state}`}>{rowStateLabel(r().state)}</span>
        <Show when={prog() !== null}>
          <span class="dim mono progress">{progressLabel(prog())}</span>
        </Show>
      </td>
      <td title={r().note ?? ""}>{r().job ?? "—"}</td>
      <td class="dim" title={r().modelsTitle}>
        {r().models}
      </td>
      {/*
        A job with no episode is a job whose episode the supervisor could not
        name (null, never a guess); an account row has no episode to name at all.
      */}
      <td class="dim">
        {r().episode ?? (r().job === null ? "—" : "episode unknown")}
      </td>
      <td class="dim">
        {r().account} <span class="dim">({r().accountClass})</span>
      </td>
      <td class="dim">{r().attempt === null ? "—" : `#${r().attempt}`}</td>
      <td class="dim" title={r().note ?? ""}>
        <Show when={href()} fallback={r().note ?? "—"}>
          {(to) => <A href={to()}>{r().runId}</A>}
        </Show>
      </td>
      <td class="right mono">{r().level === null ? "—" : `L${r().level} ${num(r().xp)}`}</td>
      <td class="right mono dim">{fmtTokens(r().tokens)}</td>
      {/* The actual figure only, as the episodes page shows it; blank is "not reported", never an estimate. */}
      <td class="right mono dim" title={r().costNote}>{r().costUsd === null ? "—" : fmtUsd(r().costUsd)}</td>
      <td class="right mono dim">{fmtDuration(r().elapsedMs)}</td>
    </tr>
  );
}
