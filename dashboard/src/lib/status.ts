/**
 * The service status badge's pure layer: one dot, one word, and the rows
 * behind the popout.
 *
 * The badge sits in the top bar on every page because it is about the
 * service — is the supervisor alive, is a deploy holding the server, can the
 * API be reached — and not about any one page. It replaces the stats strip
 * that used to head the fleet page (2026-08-23): the four lines of counters
 * were read once and then scanned past, while the one question they were
 * answering ("is it running?") is a colour.
 *
 * Everything here is a function of the fleet feed and the clock, so the
 * derivation is asserted in `test/status.test.ts` rather than in a DOM.
 */

import type { ApiInfoResponse, FleetResponse } from "@viewer/api-types";
import { HEARTBEAT_STALE_MS, deployWindowOpen, etaHours, supervisorAlive } from "./fleet";
import { fmtAge, fmtDuration, stamp } from "./format";

/** The dot's colour: the three the operator reads at a glance, and grey for "not known yet". */
export type StatusTone = "green" | "yellow" | "red" | "grey";

export interface ServiceStatus {
  tone: StatusTone;
  /** The short word beside the dot: a phase, or what is wrong. */
  word: string;
}

/** What the badge is derived from: the feed's last value and whether its last poll failed. */
export interface StatusInput {
  fleet: FleetResponse | undefined;
  /** The fleet poll's most recent error (`Poll.error`); undefined when the last poll succeeded. */
  error: unknown;
}

/**
 * Colour and word, in the order the facts outrank each other:
 *
 *   1 the API cannot be reached        — red "unreachable" (a stale value is no comfort)
 *   2 nothing has arrived yet          — grey "loading"
 *   3 the fleet has never run here     — red "down"
 *   4 a deploy verdict stands          — red "failed" / "rolled back"
 *   5 a deploy window is open          — yellow with the phase word; "paused for
 *                                        deploy" once the fleet's heartbeat is gone,
 *                                        which is the window's doing, not a fault
 *   6 no heartbeat at all              — red "down"
 *   7 a heartbeat past the stale bound — red "stale"
 *   8 otherwise                        — green "running"
 *
 * The stale bound is `HEARTBEAT_STALE_MS` (three supervisor ticks), the same
 * one `run-fleet --status` and the fleet table use, so the badge and the
 * table cannot disagree about whether the supervisor is alive.
 */
export function serviceStatus(input: StatusInput, now: number): ServiceStatus {
  if (input.error !== undefined) return { tone: "red", word: "unreachable" };
  const f = input.fleet;
  if (f === undefined) return { tone: "grey", word: "loading" };
  if (!f.present) return { tone: "red", word: "down" };
  if (f.server.phase === "failed") return { tone: "red", word: "failed" };
  if (f.server.phase === "rolled-back") return { tone: "red", word: "rolled back" };
  const alive = supervisorAlive(f, now);
  if (deployWindowOpen(f.server)) return { tone: "yellow", word: alive ? f.server.phase : "paused for deploy" };
  if (f.heartbeatAt === undefined) return { tone: "red", word: "down" };
  if (!alive) return { tone: "red", word: "stale" };
  return { tone: "green", word: "running" };
}

/** One label → value line of the popout. */
export interface StatusRow {
  label: string;
  value: string;
  /** A fuller form for the row's title, when the value is abbreviated. */
  title?: string;
}

/** How far past the stale bound a heartbeat reads before the badge's word is echoed in the row. */
const STALE_WORD = "stale";

/**
 * The popout's rows, top to bottom. Terse on purpose: a label and a value,
 * nothing the fleet table already says (which is why there is no per-job
 * listing and no gate detail here). A row whose fact is unknown says so in
 * the value rather than vanishing, so the list reads the same shape every
 * time; the two optional rows — the deploy detail and the worldserver's own
 * build — appear only when they carry news.
 */
export function statusRows(input: StatusInput, info: ApiInfoResponse | undefined, now: number): StatusRow[] {
  const f = input.fleet;
  if (f === undefined) return [{ label: "api", value: input.error === undefined ? "loading" : String(input.error) }];
  const rows: StatusRow[] = [];
  if (input.error !== undefined) rows.push({ label: "api", value: `unreachable: ${String(input.error)}` });
  if (!f.present) {
    rows.push({ label: "fleet", value: "no fleet-state.json — never run here" });
  } else {
    const hb = f.heartbeatAt;
    const hbAge = hb === undefined ? null : now - hb;
    rows.push({
      label: "heartbeat",
      value: hbAge === null ? "none" : `${fmtAge(hbAge)}${hbAge >= HEARTBEAT_STALE_MS ? ` (${STALE_WORD})` : ""}`,
      ...(hb === undefined ? {} : { title: stamp(hb) }),
    });
    const live = f.jobs.filter((j) => j.alive && j.runId !== null).length;
    const o = f.outstanding;
    const owed = o === undefined ? "outstanding unknown" : o.upper === 0 ? "outstanding exhausted" : `outstanding ${o.lower === o.upper ? o.lower : `${o.lower}–${o.upper}`}`;
    rows.push({ label: "jobs", value: `live ${live} / ${owed}` });
    rows.push({ label: "exhaust", value: o === undefined ? "unknown" : exhaustEta(o.etaLowerMs, o.etaUpperMs) });
    rows.push({
      label: "uptime",
      value: f.startedAt === undefined ? "unknown" : fmtDuration(now - f.startedAt),
      ...(f.startedAt === undefined ? {} : { title: `supervisor started ${stamp(f.startedAt)}` }),
    });
  }
  // The harness: the build the deploy put on the server (or, failing a deploy
  // record, the one the gate smoked), and the worldserver's own answer when
  // the viewer can reach it and it says something different.
  const harness = f.server.build !== "" ? f.server.build : (f.preflight?.build ?? "");
  rows.push({ label: "harness", value: harness === "" ? "unknown" : harness });
  const ws = info?.worldserver ?? null;
  if (ws !== null && ws.build !== harness) rows.push({ label: "worldserver", value: ws.build, title: `up since ${stamp(ws.startedAtMs)}` });
  if (f.server.phase !== "running" && f.server.detail !== "") rows.push({ label: f.server.phase, value: f.server.detail });
  if (f.present) rows.push({ label: "accounts", value: accountsBusy(f) });
  return rows;
}

/** `≈ 4h–9h`, or what is missing: the same reading the old strip gave, shorter. */
function exhaustEta(lo: number | null, hi: number | null): string {
  const a = etaHours(lo);
  const b = etaHours(hi);
  if (a === null || b === null) return "unknown";
  return a === b ? `≈ ${a}` : `≈ ${a}–${b}`;
}

/** `pool 4/5 · paid 0/1 · local 0/1` — busy over total per schedulable class; classes with no accounts left out. */
export function accountsBusy(f: Pick<FleetResponse, "accounts" | "jobs">): string {
  const busy = new Set(f.jobs.filter((j) => j.alive).map((j) => j.account.toUpperCase()));
  const parts: string[] = [];
  for (const cls of ["pool", "paid", "local"] as const) {
    const of = f.accounts.filter((a) => a.class === cls);
    if (of.length === 0) continue;
    parts.push(`${cls} ${of.filter((a) => busy.has(a.account.toUpperCase())).length}/${of.length}`);
  }
  return parts.length === 0 ? "none" : parts.join(" · ");
}
