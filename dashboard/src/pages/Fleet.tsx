/**
 * Fleet overview: what the supervisor is running, and every run it has left
 * behind.
 *
 * Two feeds, deliberately independent. `/api/fleet` is the supervisor's own
 * published view — lanes, accounts, a heartbeat — and it is the only
 * honest liveness signal across a container boundary. `/api/runs` is the
 * filesystem's view, where "live" means an unterminated run whose trajectory
 * grew recently. A lane can be alive with no live run (between episodes), and a
 * run can look live with a dead lane (a killed process writes no termination),
 * so the page shows both rather than reconciling them into one number.
 */

import { A, useNavigate } from "@solidjs/router";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { api, type ApiInfoResponse, type FleetResponse, type RunListRow } from "../api/client";
import type { FleetJobView, FleetLaneView } from "@viewer/api-types";
import { FLEET_COLUMNS, JOB_COLUMNS, jobModelLabel, laneModelLabel, laneModelTitle, laneRunHref, laneState } from "../lib/fleet";
import { fmtAge, fmtDuration, fmtMoney, fmtTokens, fmtUsd, fmtWhen, num, shortHarness, stamp } from "../lib/format";
import { poll } from "../lib/poll";

/** The supervisor writes a heartbeat every tick; past this it is not ticking. */
const HEARTBEAT_STALE_MS = 120_000;

export default function Fleet() {
  /*
   * Stillborn runs are hidden by default (`runner/viewer/stillborn.ts`): a
   * launch that never produced a model response is not a run this table should
   * count. The toggle brings them back greyed rather than deleting the fact,
   * and the count comes off the same response either way.
   */
  const [showStillborn, setShowStillborn] = createSignal(false);
  /** How many the API is hiding (or would hide) — it says so either way. */
  const [stillbornCount, setStillbornCount] = createSignal(0);
  const runs = poll(() => api.runs(showStillborn()).then((r) => {
    setStillbornCount(r.stillbornExcluded);
    return r.runs;
  }), 10_000);
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
  const toggleStillborn = (): void => {
    setShowStillborn(!showStillborn());
    runs.refresh();
  };
  const heartbeatAge = (f: FleetResponse): number | null =>
    f.heartbeatAt === undefined ? null : now() - f.heartbeatAt;

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
          const age = (): number | null => heartbeatAge(f());
          const stale = (): boolean => age() === null || age()! > HEARTBEAT_STALE_MS;
          return (
            <>
              <div class="cards">
                <div class="card">
                  <div class="k">supervisor</div>
                  <div class="v">
                    <span class={`dot ${stale() ? "dead" : "live"}`} />
                    {stale() ? "stale" : "beating"}
                  </div>
                  <div class="sub">
                    pid {f().fleetPid ?? "—"} · {f().containerized === true ? "container" : "host"} ·{" "}
                    {age() === null ? "no heartbeat" : fmtAge(age()!)}
                  </div>
                </div>
                <div class="card">
                  <div class="k">lanes</div>
                  <div class="v">
                    {f().lanes.filter((l) => l.alive !== false).length} / {f().lanes.length}
                  </div>
                  <div class="sub">alive · stamp {f().stamp ?? "—"}</div>
                </div>
                <div class="card">
                  <div class="k">live runs</div>
                  <div class="v">{live().length}</div>
                  <div class="sub">writing within the last two minutes</div>
                </div>
                <div class="card">
                  <div class="k">runs recorded</div>
                  <div class="v">{runs.latest?.length ?? "—"}</div>
                  <div class="sub">under data/runs</div>
                </div>
                {/*
                  The supervisor's own counters, not the filesystem's: runs it
                  finished since it started, how many exited clean, and how many
                  it relaunched. Absent on a supervisor that predates them, and
                  the card says so rather than showing a zero.
                */}
                <div class="card">
                  <div class="k">this session</div>
                  <div class="v">{f().session?.finished ?? "—"}</div>
                  <div class="sub">
                    <Show when={f().session !== undefined} fallback={<>not reported by this supervisor</>}>
                      finished · ok {f().session!.ok} · retried {f().session!.retried}
                    </Show>
                  </div>
                </div>
              </div>

              {/*
                Jobs, where the supervisor publishes them (ADR-0034: the job is
                the unit of work). A job says which roster entry is running, on
                what tier and account, and whether it is the file's, the manual
                queue's or the policy's own pick — none of which a lane carries.
              */}
              <Show when={(f().jobs ?? []).length > 0}>
                <div class="scroller">
                  <table>
                    <thead>
                      <tr>
                        <For each={JOB_COLUMNS}>{(c) => <th>{c}</th>}</For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={f().jobs}>{(job) => <JobRow job={job} />}</For>
                    </tbody>
                  </table>
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
                    <For each={f().lanes}>{(lane) => <LaneRow lane={lane} now={now()} />}</For>
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}
      </Show>

      <h2 class="section">runs</h2>
      <p class="dim">
        <Show when={stillbornCount() > 0} fallback={<>Every recorded run.</>}>
          <button class={showStillborn() ? "on" : ""} onClick={toggleStillborn}>
            show stillborn ({stillbornCount()})
          </button>{" "}
          Runs that never produced a model response — a dead provider on the first request, a
          refused key — never got off the ground and are hidden by default.
        </Show>
      </p>
      <Show when={runs.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>run</th>
                <th>model</th>
                <th>character</th>
                <th class="right">lvl</th>
                <th class="right">xp</th>
                <th class="right">money</th>
                <th class="right">quests</th>
                <th>started</th>
                <th class="right">playtime</th>
                <th class="right">tokens</th>
                <th class="right">cost</th>
                <th>harness</th>
                <th>ended</th>
              </tr>
            </thead>
            <tbody>
              <For each={runs.latest}>{(r) => <RunRowView row={r} now={now()} />}</For>
            </tbody>
          </table>
        </div>
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
 * One lane. The whole row is a click-through to the run the lane is holding, so
 * the fleet table is a way into a live run and not just a status readout — the
 * model cell carries the same link for anyone tabbing rather than clicking, and
 * the handler stands aside when the click already landed on that anchor.
 */
function LaneRow(props: { lane: FleetLaneView; now: number }) {
  const navigate = useNavigate();
  const lane = (): FleetLaneView => props.lane;
  const href = (): string | null => laneRunHref(lane());
  const state = (): string => laneState(lane());
  const onClick = (e: MouseEvent): void => {
    const to = href();
    if (to === null || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if ((e.target as Element | null)?.closest("a") !== null) return;
    navigate(to);
  };
  return (
    <tr onClick={onClick} class={href() === null ? undefined : "clickable"}>
      <td>
        <span class={`dot ${state() === "exited" ? "dead" : state() === "running" ? "live" : ""}`} />
        <span class={`badge ${state()}`}>{state()}</span>
      </td>
      <td>{lane().name}</td>
      <td class="dim" title={laneModelTitle(lane())}>
        <Show when={href()} fallback={laneModelLabel(lane())}>
          {(to) => <A href={to()}>{laneModelLabel(lane())}</A>}
        </Show>
      </td>
      <td class="dim">{lane().account}</td>
      <td class="dim" title={stamp(lane().spawnedAt)}>
        {fmtWhen(lane().spawnedAt, props.now)}
      </td>
      <td class={lane().exitCode === null || lane().exitCode === 0 ? "dim" : "err"}>
        {lane().exitCode === null ? "—" : lane().exitCode}
      </td>
    </tr>
  );
}

/** One job the supervisor has a process for. */
function JobRow(props: { job: FleetJobView }) {
  const job = (): FleetJobView => props.job;
  return (
    <tr>
      <td>{job().name}</td>
      <td class="dim" title={job().models.join(", ")}>
        {jobModelLabel(job())}
      </td>
      <td class="dim">{job().episode}</td>
      <td class="dim">{job().account}</td>
      <td class="dim">{job().source}</td>
      <td class="dim">{job().attempt === undefined ? "—" : `#${job().attempt}`}</td>
      <td class="dim">
        <Show when={job().resuming !== undefined} fallback={<>—</>}>
          <A href={`/run/${encodeURIComponent(job().resuming!)}`}>{job().resuming}</A>
        </Show>
      </td>
    </tr>
  );
}

function RunRowView(props: { row: RunListRow; now: number }) {
  const r = (): RunListRow => props.row;
  /*
   * Playtime is the API's: cumulative time the run spent being driven, with the
   * stretches between a `pause` and its `resume` taken out. Server-side so this
   * table and the run page cannot drift apart.
   */
  const playtime = (): number | null => r().playtimeMs ?? null;
  return (
    // Greyed, not hidden: a revealed stillborn run must still read as one.
    <tr class={r().stillborn ? "stillborn" : undefined}>
      <td>
        <Show when={r().live}>
          <span class="dot live" />
        </Show>
        <A href={`/run/${encodeURIComponent(r().runId)}`}>{r().runId}</A>
      </td>
      <td class="dim">
        {r().model ?? "—"}
        <Show when={r().stillborn}>
          {" "}
          <span class="warn" title="never produced a model response">stillborn</span>
        </Show>
        <Show when={r().shakeout !== null}>
          {" "}
          <span class="warn" title={r().shakeout ?? ""}>unscored</span>
        </Show>
        <Show when={r().objective !== null}>
          {" "}
          <span class="warn" title={r().objective ?? ""}>objective</span>
        </Show>
      </td>
      <td class="dim" title={r().characterLabel ?? "race and class not recorded for this run"}>
        {r().character ?? "—"}
        <Show when={r().characterLabel !== null}>
          {" "}
          <span class="dim">({r().characterLabel})</span>
        </Show>
      </td>
      <td class="right mono">{num(r().level)}</td>
      <td class="right mono">{num(r().xp)}</td>
      <td class="right mono">{fmtMoney(r().money)}</td>
      <td class="right mono">{num(r().questsCompleted)}</td>
      <td class="dim" title={stamp(r().startedAt)}>
        {fmtWhen(r().startedAt, props.now)}
      </td>
      <td class="right mono dim">{fmtDuration(playtime())}</td>
      <td class="right mono dim" title={r().tokens?.source ?? ""}>
        {fmtTokens(r().tokens?.totalTokens ?? null)}
      </td>
      {/* Cost where the model is priced; a dash where it is not, never a zero. */}
      <td class="right mono dim" title={r().cost?.note ?? "no price on file for this model"}>
        {r().cost?.basis === "none" || r().cost == null ? "—" : fmtUsd(r().cost!.usd)}
      </td>
      <td class="dim" title={r().harnessVersion ?? ""}>
        {shortHarness(r().harnessVersion)}
      </td>
      <td class={r().terminationReason === null ? "dim" : ""} title={r().terminationDetail ?? ""}>
        {r().terminationReason ?? (r().pauseReason !== null ? `paused: ${r().pauseReason}` : "—")}
      </td>
    </tr>
  );
}
