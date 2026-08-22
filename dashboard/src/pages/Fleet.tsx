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
import { api, type FleetResponse, type RunListRow } from "../api/client";
import type { FleetLaneView } from "@viewer/api-types";
import { FLEET_COLUMNS, laneModelLabel, laneModelTitle, laneRunHref, laneState } from "../lib/fleet";
import { fmtAge, fmtDuration, fmtMoney, fmtTokens, fmtWhen, num, shortHarness, stamp } from "../lib/format";
import { poll } from "../lib/poll";

/** The supervisor writes a heartbeat every tick; past this it is not ticking. */
const HEARTBEAT_STALE_MS = 120_000;

export default function Fleet() {
  const runs = poll(() => api.runs().then((r) => r.runs), 10_000);
  const fleet = poll(() => api.fleet(), 5_000);

  // One clock for the whole page, so every relative time ticks together.
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  const live = createMemo(() => (runs.latest ?? []).filter((r) => r.live));
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
              </div>

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
    </div>
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

function RunRowView(props: { row: RunListRow; now: number }) {
  const r = (): RunListRow => props.row;
  /*
   * Playtime is the API's: cumulative time the run spent being driven, with the
   * stretches between a `pause` and its `resume` taken out. Server-side so this
   * table and the run page cannot drift apart.
   */
  const playtime = (): number | null => r().playtimeMs ?? null;
  return (
    <tr>
      <td>
        <Show when={r().live}>
          <span class="dot live" />
        </Show>
        <A href={`/run/${encodeURIComponent(r().runId)}`}>{r().runId}</A>
      </td>
      <td class="dim">
        {r().model ?? "—"}
        <Show when={r().shakeout !== null}>
          {" "}
          <span class="warn">shakeout</span>
        </Show>
        <Show when={r().objective !== null}>
          {" "}
          <span class="warn" title={r().objective ?? ""}>objective</span>
        </Show>
      </td>
      <td class="dim">{r().character ?? "—"}</td>
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
      <td class="dim" title={r().harnessVersion ?? ""}>
        {shortHarness(r().harnessVersion)}
      </td>
      <td class={r().terminationReason === null ? "dim" : ""} title={r().terminationDetail ?? ""}>
        {r().terminationReason ?? (r().pauseReason !== null ? `paused: ${r().pauseReason}` : "—")}
      </td>
    </tr>
  );
}
