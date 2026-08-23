/**
 * The fleet table's pure layer: its columns, and the rows it is made of.
 *
 * One table, keyed by the JOB (ADR-0034: the job is the unit of work, an
 * account — with a class — is where it runs). A row is either a job with an
 * account or an account with no job, and the accounts that hold nothing sort
 * to the bottom under their class. The indicators above the table are the
 * same ones `run-fleet --status` prints, phrased here once.
 *
 * The component renders its header from `FLEET_COLUMNS` and its body from
 * `fleetRows`, so what is asserted here is what ships — the same reason the run
 * rows keep their maths in `format.ts` (see dashboard/README.md).
 */

import type { FleetJobView, FleetPausedView, FleetResponse } from "@viewer/api-types";
import type { RunListRow } from "@viewer/api-types";

/** The supervisor writes a heartbeat every tick (60s); past three ticks it is gone, not quiet. */
export const HEARTBEAT_STALE_MS = 180_000;

/**
 * The supervisor's liveness, as --status decides it: a heartbeat inside the
 * window. No heartbeat at all is "not running" — the only honest reading
 * across a container boundary.
 */
export function supervisorAlive(fleet: Pick<FleetResponse, "heartbeatAt">, now: number): boolean {
  return fleet.heartbeatAt !== undefined && now - fleet.heartbeatAt < HEARTBEAT_STALE_MS;
}

/** The gate's one-word verdict, as --status prints it. */
export function gateVerdict(pf: FleetResponse["preflight"]): "PASS" | "FAIL" | "SKIPPED" | "none" {
  if (pf === undefined) return "none";
  if (pf.skipped === true) return "SKIPPED";
  return pf.ok ? "PASS" : "FAIL";
}

/** `1 pinned, 5 pool, 1 paid, 1 local` — the accounts line of --status, classes with nothing listed left out. */
export function accountClassSummary(accounts: FleetResponse["accounts"]): string {
  const n = (cls: string): number => accounts.filter((a) => a.class === cls).length;
  return ["pinned", "pool", "paid", "local"]
    .filter((cls) => n(cls) > 0)
    .map((cls) => `${n(cls)} ${cls}`)
    .join(", ");
}

/** One paused run as --status lists it: reason, pause count, and when the supervisor tries again. */
export function pausedLabel(p: FleetPausedView): string {
  const again = p.resumeAfter === null ? "" : `, resumes after ${new Date(p.resumeAfter).toLocaleTimeString()}`;
  return `${p.reason} (pause ${p.pauseCount})${again}`;
}

/** The fleet table, left to right. State leads: it is what an operator scans for. */
export const FLEET_COLUMNS = ["state", "job", "models", "tier", "account", "source", "attempt", "run", "lvl / xp", "elapsed"] as const;

/**
 * What a row is doing.
 *
 * `resuming` is a spawned job that has not picked its paused run back up yet;
 * `paused` is a run holding nothing — it gave its session back — sitting
 * against the account it paused on. `idle` covers both a live job between
 * episodes and an account with nothing on it, which the account column tells
 * apart.
 */
export type FleetRowState = "exited" | "draining" | "running" | "resuming" | "paused" | "idle";

export interface FleetRow {
  /** Stable key: the job name, or the account for an idle account row. */
  key: string;
  state: FleetRowState;
  /** The job's name, or null on an account row. */
  job: string | null;
  /** The models behind the job's ref, truncated for the cell. */
  models: string;
  /** Every model behind it, for the cell's title. */
  modelsTitle: string;
  /**
   * The episode tier. Null on an account row — and also on a job whose tier the
   * supervisor could not name, which the page distinguishes: an account row has
   * no tier to show, a job with none is a job whose tier is *unknown*.
   */
  tier: string | null;
  account: string;
  /** Which class the account belongs to: pool, paid, local, pinned. */
  accountClass: string;
  /** Where the job came from: the file's pinned list, the manual queue, the policy. */
  source: string | null;
  attempt: number | null;
  /** The run this row is about: the one being driven, or the paused one. */
  runId: string | null;
  level: number | null;
  xp: number | null;
  /** Active time in the episode, from the runs feed; null when there is no run. */
  elapsedMs: number | null;
  /** Why an idle or paused row is what it is. */
  note: string | null;
}

/** How many models a job names before the rest become a count. */
const MODELS_SHOWN = 2;

/**
 * A job's model cell: the models behind its ref, truncated rather than wrapped,
 * with the full list in the cell's title. A job with no models resolved falls
 * back to the ref itself, which is what it was called.
 */
export function jobModelLabel(job: Pick<FleetJobView, "ref" | "models">): string {
  const models = job.models;
  if (models.length === 0) return job.ref;
  if (models.length <= MODELS_SHOWN) return models.join(", ");
  return `${models.slice(0, MODELS_SHOWN).join(", ")} +${models.length - MODELS_SHOWN}`;
}

/** Only a row with a run has somewhere to click through to. */
export function runHref(runId: string | null): string | null {
  return runId === null ? null : `/run/${encodeURIComponent(runId)}`;
}

/** Classes in the order their idle rows are grouped at the bottom. */
const CLASS_ORDER = ["pool", "paid", "local", "pinned"];

function stateOf(job: FleetJobView): FleetRowState {
  if (job.alive === false) return "exited";
  if (job.draining === true) return "draining";
  if ((job.runId ?? null) !== null) return "running";
  return job.resuming !== undefined ? "resuming" : "idle";
}

/**
 * The whole table: every job the supervisor has a process for, then every
 * account holding nothing, grouped by class.
 *
 * `runs` is the filesystem's view (`/api/runs`) and is joined by run id for
 * level, xp and the episode's active time — the same numbers the runs table
 * shows, so the two cannot disagree. A job whose run is not in that feed still
 * gets its row; it is a launch the trajectory has not caught up with.
 */
export function fleetRows(fleet: FleetResponse, runs: readonly RunListRow[]): FleetRow[] {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const rows: FleetRow[] = [];
  const busy = new Set<string>();
  for (const job of fleet.jobs) {
    const runId = job.runId ?? null;
    const run = runId === null ? undefined : byId.get(runId);
    busy.add(job.account.toUpperCase());
    rows.push({
      key: job.name,
      state: stateOf(job),
      job: job.name,
      models: jobModelLabel(job),
      modelsTitle: job.models.join(", "),
      tier: job.episode ?? null,
      account: job.account,
      accountClass: job.accountClass,
      source: job.source,
      attempt: job.attempt ?? null,
      runId: runId ?? job.resuming ?? null,
      level: run?.level ?? null,
      xp: run?.xp ?? null,
      elapsedMs: run?.playtimeMs ?? null,
      note: job.resuming !== undefined && runId === null ? `resuming ${job.resuming}` : null,
    });
  }
  // Idle accounts, grouped by class. A paused run holds no account, so it is
  // reported against the account it paused on rather than as a job of its own.
  const paused = fleet.paused;
  const idle = fleet.accounts.filter((a) => !busy.has(a.account.toUpperCase()));
  idle.sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) || a.account.localeCompare(b.account));
  for (const a of idle) {
    const here = paused.find((p) => (p.account ?? "").toUpperCase() === a.account.toUpperCase());
    const run = here === undefined ? undefined : byId.get(here.runId);
    rows.push({
      key: `account:${a.account}`,
      state: here === undefined ? "idle" : "paused",
      job: null,
      models: here?.model ?? "—",
      modelsTitle: here?.model ?? "",
      tier: null,
      account: a.account,
      accountClass: a.class,
      source: null,
      attempt: null,
      runId: here?.runId ?? null,
      level: run?.level ?? null,
      xp: run?.xp ?? null,
      elapsedMs: here?.elapsedMs ?? run?.playtimeMs ?? null,
      note: here !== undefined ? `${pausedLabel(here)} — ${here.why}` : a.job !== null ? `job ${a.job} holds nothing right now` : null,
    });
  }
  return rows;
}
