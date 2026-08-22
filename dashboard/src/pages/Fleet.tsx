/**
 * Fleet overview: what the supervisor is running, and every run it has left
 * behind.
 *
 * Two feeds, deliberately independent. `/api/fleet` is the supervisor's own
 * published view — lanes, accounts, PIDs, a heartbeat — and it is the only
 * honest liveness signal across a container boundary. `/api/runs` is the
 * filesystem's view, where "live" means an unterminated run whose trajectory
 * grew recently. A lane can be alive with no live run (between episodes), and a
 * run can look live with a dead lane (a killed process writes no termination),
 * so the page shows both rather than reconciling them into one number.
 */

import { A } from "@solidjs/router";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { api, type FleetResponse, type RunListRow } from "../api/client";
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
                      <th>lane</th>
                      <th>account</th>
                      <th>pid</th>
                      <th>state</th>
                      <th>spawned</th>
                      <th>exit</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={f().lanes}>
                      {(lane) => (
                        <tr>
                          <td>{lane.name}</td>
                          <td class="dim">{lane.account}</td>
                          <td class="mono dim">{lane.pid}</td>
                          <td>
                            <span class={`dot ${lane.alive === false ? "dead" : "live"}`} />
                            {lane.alive === false ? "exited" : lane.draining ? "draining" : "running"}
                          </td>
                          <td class="dim" title={stamp(lane.spawnedAt)}>
                            {fmtWhen(lane.spawnedAt, now())}
                          </td>
                          <td class={lane.exitCode === null || lane.exitCode === 0 ? "dim" : "err"}>
                            {lane.exitCode === null ? "—" : lane.exitCode}
                          </td>
                        </tr>
                      )}
                    </For>
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

function RunRowView(props: { row: RunListRow; now: number }) {
  const r = (): RunListRow => props.row;
  /* Playtime is the wall clock the trajectory spans; a live run keeps counting. */
  const playtime = (): number | null => {
    const first = r().firstTs;
    if (first === null) return null;
    return (r().live ? props.now : (r().lastTs ?? first)) - first;
  };
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
