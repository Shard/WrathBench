/**
 * Fleet overview: what the supervisor is running, right now.
 *
 * One grain per page (ADR-0022 amendment, 2026-08-23). This one is the fleet's:
 * the supervisor, the gate, the accounts and jobs, what is paused and what it
 * ended. The per-run grain is the episodes page, and a job's run link is the
 * only per-run reference here.
 *
 * Two feeds, deliberately independent. `/api/fleet` is the supervisor's own
 * published view — jobs, accounts, a heartbeat, the gate — and it is the only
 * honest liveness signal across a container boundary. `/api/runs` is the
 * filesystem's view, where "live" means an unterminated run whose trajectory
 * grew recently. A job can be alive with no live run (between episodes), and a
 * run can look live with a dead process (a killed job writes no termination),
 * so the page shows both rather than reconciling them into one number.
 *
 * The page carries what `run-fleet --status` prints, in the same order: the
 * supervisor line, the REJECTED banner, the gate, the account classes, one
 * table keyed by the job (ADR-0034) with the idle accounts under it, the
 * paused and ended runs. The models table is the Models page — same
 * projection, its own entity — and is linked, not repeated. The assembly is
 * in `lib/fleet.ts`.
 *
 * `/api/runs` is still read, because the job rows carry the level, xp and
 * elapsed time of the run each job is driving; what is gone is the table that
 * listed every run on disk underneath them.
 */

import { A, useNavigate } from "@solidjs/router";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { api, type ApiInfoResponse, type FleetResponse } from "../api/client";
import { FLEET_COLUMNS, accountClassSummary, fleetRows, gateVerdict, pausedLabel, runHref, supervisorAlive, type FleetRow } from "../lib/fleet";
import { fmtAge, fmtDuration, num, stamp } from "../lib/format";
import { poll } from "../lib/poll";

export default function Fleet() {
  // Every run on disk — read for the job rows, the live count, and the link to
  // the episodes page, not to be listed here.
  const runs = poll(() => api.runs().then((r) => r.runs), 10_000);
  const fleet = poll(() => api.fleet(), 5_000);
  /*
   * Server identity (FOLLOW-UPS 42). Slow on purpose: a build stamp changes on
   * a deploy, not on a tick, and the viewer caches the module's /health for ten
   * seconds behind this anyway.
   */
  const info = poll(() => api.info(), 60_000);

  // One clock for the whole page, so every relative time ticks together.
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  const live = createMemo(() => (runs.latest ?? []).filter((r) => r.live));

  return (
    <div class="page">
      <Show when={runs.error !== undefined}>
        <div class="banner bad">{String(runs.error)}</div>
      </Show>

      <h2 class="section">fleet</h2>
      <Show
        when={fleet.latest?.present === true}
        fallback={<p class="dim">No fleet-state.json — the fleet has never run here.</p>}
      >
        {(() => {
          const f = (): FleetResponse => fleet.latest!;
          const up = (): boolean => supervisorAlive(f(), now());
          const age = (): number | null => (f().heartbeatAt === undefined ? null : now() - f().heartbeatAt!);
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

              {/* The supervisor line: alive by heartbeat, where it runs, when its config was loaded. */}
              <div class="strip">
                <span>
                  <span class={`dot ${up() ? "live" : "dead"}`} />
                  supervisor {up() ? "ALIVE" : "NOT RUNNING"} · pid {f().fleetPid ?? "—"} ·{" "}
                  {f().containerized === true ? "container" : "host"} ·{" "}
                  {age() === null ? "no heartbeat" : `heartbeat ${fmtAge(age()!)}`}
                </span>
                <span class="dim">stamp {f().stamp ?? "—"}</span>
                <span class="dim" title={f().configLoadedAt === undefined ? "" : stamp(f().configLoadedAt!)}>
                  config loaded {f().configLoadedAt === undefined ? "—" : fmtAge(now() - f().configLoadedAt!)}
                </span>
                <span class="dim">{f().jobs.length} jobs · {live().length} live runs</span>
                <span class="dim">
                  <Show when={f().session !== undefined} fallback={<>session not reported</>}>
                    session: {f().session!.finished} finished · ok {f().session!.ok} · retried {f().session!.retried}
                  </Show>
                </span>
                <span class="dim">
                  {/* The per-run grain lives on the episodes page; this is the way in. */}
                  <A href="/episodes?episode=all">{runs.latest?.length ?? "—"} runs recorded</A>
                </span>
              </div>

              {/* The gate (ADR-0023): the last result per smoke, against the identity it smoked, and the server build. */}
              <div class="strip">
                <span class={gateVerdict(f().preflight) === "FAIL" ? "err" : gateVerdict(f().preflight) === "PASS" ? "ok" : "dim"}>
                  preflight {gateVerdict(f().preflight)}
                  <Show when={gateVerdict(f().preflight) === "FAIL"}> — jobs blocked</Show>
                </span>
                <Show when={f().preflight} fallback={<span class="dim">no gate result recorded yet</span>}>
                  {(pf) => (
                    <>
                      <span class="dim" title={stamp(pf().at)}>gated {fmtAge(now() - pf().at)}</span>
                      <span class="dim mono" title={pf().serverIdentity}>identity {pf().serverIdentity}</span>
                      <span class="dim">server build <span class="mono">{pf().build ?? "—"}</span></span>
                      <For each={pf().results}>
                        {(r) => (
                          <span class={r.ok ? "ok" : "err"} title={r.tail}>
                            {r.ok ? "ok" : "FAIL"} {r.script} ({Math.round(r.ms / 1000)}s)
                          </span>
                        )}
                      </For>
                    </>
                  )}
                </Show>
              </div>

              {/* Account classes (ADR-0034): the counts line, then one table with a row per job and per idle account. */}
              <p class="dim">
                accounts: {accountClassSummary(f().accounts)} · the <A href="/models">models table</A> carries the
                scheduler's verdict per roster entry.
              </p>
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

              {/* Paused runs the supervisor is not resuming, and why (ADR-0036); the ones it ended instead. */}
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

      <ServerIdentity info={info.latest} now={now()} />
    </div>
  );
}

/**
 * Which worldserver these runs were driven against (FOLLOW-UPS 41/42).
 *
 * `null` is the normal answer on the host: compose does not publish the
 * module's port, so the viewer cannot reach /health unless it is given a URL.
 * It says so rather than showing an empty stamp, because "unknown build" and
 * "no server" are different facts.
 */
function ServerIdentity(props: { info: ApiInfoResponse | undefined; now: number }) {
  const ws = (): ApiInfoResponse["worldserver"] | undefined => props.info?.worldserver ?? undefined;
  return (
    <footer class="identity">
      <Show when={props.info !== undefined} fallback={<>viewer: —</>}>
        <Show
          when={ws()}
          fallback={
            <>worldserver: unreachable from the viewer (set WRATHBENCH_MODULE_URL to name it)</>
          }
        >
          {(w) => (
            <>
              worldserver <span class="mono">{w().build}</span> · up {fmtDuration(props.now - w().startedAtMs)}{" "}
              (since <span title={stamp(w().startedAtMs)}>{stamp(w().startedAtMs)}</span>)
            </>
          )}
        </Show>
        <Show when={props.info?.publicMode === true}> · public mode</Show>
      </Show>
    </footer>
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
  return (
    <tr onClick={onClick} class={href() === null ? undefined : "clickable"}>
      <td>
        <span class={`dot ${dot()}`} />
        <span class={`badge ${r().state}`}>{r().state}</span>
      </td>
      <td title={r().note ?? ""}>{r().job ?? "—"}</td>
      <td class="dim" title={r().modelsTitle}>
        {r().models}
      </td>
      {/*
        A job with no tier is a job whose tier the supervisor could not name
        (null, never a guess); an account row has no tier to name at all.
      */}
      <td class="dim">
        {r().tier ?? (r().job === null ? "—" : "episode unknown")}
      </td>
      <td class="dim">
        {r().account} <span class="dim">({r().accountClass})</span>
      </td>
      <td class="dim">{r().source ?? "—"}</td>
      <td class="dim">{r().attempt === null ? "—" : `#${r().attempt}`}</td>
      <td class="dim" title={r().note ?? ""}>
        <Show when={href()} fallback={r().note ?? "—"}>
          {(to) => <A href={to()}>{r().runId}</A>}
        </Show>
      </td>
      <td class="right mono">{r().level === null ? "—" : `L${r().level} ${num(r().xp)}`}</td>
      <td class="right mono dim">{fmtDuration(r().elapsedMs)}</td>
    </tr>
  );
}
