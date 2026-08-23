/**
 * The fleet table's pure layer: its columns, and the rows it is made of.
 *
 * One table, keyed by the JOB (ADR-0034: the job is the unit of work, an
 * account is where it runs). The page used to show the same fleet three times —
 * lanes, jobs, accounts — which meant three answers to "what is RUNNER3 doing"
 * and no answer at all to "which of these is the same thing". A row is now
 * either a job with an account or an account with no job, and the accounts that
 * hold nothing sort to the bottom under their class.
 *
 * The component renders its header from `FLEET_COLUMNS` and its body from
 * `fleetRows`, so what is asserted here is what ships — the same reason the run
 * rows keep their maths in `format.ts` (see dashboard/README.md).
 */

import type { FleetJobView, FleetResponse } from "@viewer/api-types";
import type { RunListRow } from "@viewer/api-types";

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
  /** The episode tier, or null on an account row. */
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
  for (const job of fleet.jobs ?? []) {
    const runId = job.runId ?? null;
    const run = runId === null ? undefined : byId.get(runId);
    busy.add(job.account.toUpperCase());
    rows.push({
      key: job.name,
      state: stateOf(job),
      job: job.name,
      models: jobModelLabel(job),
      modelsTitle: job.models.join(", "),
      tier: job.episode,
      account: job.account,
      accountClass: job.accountClass ?? "pinned",
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
  const paused = fleet.paused ?? [];
  const idle = (fleet.accounts ?? []).filter((a) => !busy.has(a.account.toUpperCase()));
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
      note: here !== undefined ? `${here.reason} — ${here.why}` : a.job !== null ? `job ${a.job} holds nothing right now` : null,
    });
  }
  return rows;
}
