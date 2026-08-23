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

import type { FleetJobView, FleetOutstandingView, FleetPausedView, FleetResponse, FleetServerView } from "@viewer/api-types";
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

/**
 * True while a deploy holds the server (infra/deploy-worldserver.sh): the
 * fleet is stopped on purpose, its jobs' processes are gone on purpose, and
 * the page must say so rather than "NOT RUNNING" and a column of "exited".
 * A `rolled-back` or `failed` verdict is not a window: by then the script has
 * brought the fleet back up, and the banner alone carries the news.
 */
export function deployWindowOpen(server: Pick<FleetServerView, "phase">): boolean {
  return server.phase === "draining" || server.phase === "swapping" || server.phase === "verifying" || server.phase === "resuming";
}

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The one banner line at the top of the page, stating the server's phase in
 * plain words. The phase word is ours; everything after the colon is the
 * deploy script's own `detail`, printed verbatim — the page never guesses at
 * what the window is doing. `null` at rest with nothing on file.
 */
export function serverBanner(server: FleetServerView): { text: string; tone: "info" | "bad" | "dim" } | null {
  const b = server.build === "" ? "an unnamed build" : server.build;
  const detail = server.detail === "" ? "" : `: ${server.detail}`;
  switch (server.phase) {
    case "running":
      return server.detail === "" ? null : { text: `server running${detail}`, tone: "dim" };
    case "draining":
      return { text: `Deploy window since ${hhmm(server.since)} — stopping the fleet for ${b}, runs are pausing${detail}`, tone: "info" };
    case "swapping":
      return { text: `Deploy window since ${hhmm(server.since)} — swapping the worldserver to ${b}${detail}`, tone: "info" };
    case "verifying":
      return { text: `Deploy window since ${hhmm(server.since)} — swapped to ${b}, verifying${detail}`, tone: "info" };
    case "resuming":
      return { text: `Deploy window since ${hhmm(server.since)} — ${b} verified, starting the fleet; paused runs resume${detail}`, tone: "info" };
    case "rolled-back":
      return { text: `Deploy of ${b} FAILED at ${hhmm(server.since)} and was rolled back${server.prevBuild !== undefined ? ` to ${server.prevBuild}` : ""}${detail}`, tone: "bad" };
    case "failed":
      return { text: `Deploy of ${b} FAILED at ${hhmm(server.since)}${detail}`, tone: "bad" };
  }
}

/**
 * The supervisor line's verdict. A dead heartbeat during a deploy window is
 * the script's doing, and the line says so instead of crying NOT RUNNING.
 */
export function supervisorLabel(fleet: Pick<FleetResponse, "heartbeatAt" | "server">, now: number): string {
  if (supervisorAlive(fleet, now)) return "supervisor ALIVE";
  return deployWindowOpen(fleet.server) ? "fleet stopped for the deploy window" : "supervisor NOT RUNNING";
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

/**
 * How much of the schedule is left, in the words `run-fleet --status` uses.
 *
 * Both halves are bounds, not estimates: `lower` assumes nothing else
 * promotes into the long tier, `upper` assumes everything still eligible
 * does. The ETA divides the runs' own wall clock (90m / 360m, from the
 * episode table) by how many can be in flight at once. The wire carries the
 * numbers — `outstandingWork` in `runner/src/models.ts` computes them, and the
 * viewer, the fleet page and `--status` all print that one answer.
 */
export function outstandingLabel(o: FleetOutstandingView): string {
  if (o.upper === 0) return "outstanding: exhausted";
  const runs = o.lower === o.upper ? `${o.lower}` : `${o.lower}\u2013${o.upper}`;
  const lo = etaHours(o.etaLowerMs);
  const hi = etaHours(o.etaUpperMs);
  const eta = lo === null || hi === null ? "eta unknown" : lo === hi ? `\u2248 ${lo}` : `\u2248 ${lo}\u2013${hi}`;
  return `outstanding: ${runs} scheduled runs, ${eta} to exhaust`;
}

/** Hours from now, coarse on purpose: a planning figure, not a clock. */
export function etaHours(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms === 0) return "0h";
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** The formula, spelled out for the strip's tooltip. */
export function outstandingTitle(o: FleetOutstandingView): string {
  const groups = o.breakdown
    .map((g) => `${g.group}: ${g.lowerRuns}\u2013${g.upperRuns} runs, ${g.lowerMinutes}\u2013${g.upperMinutes} min at ${g.concurrency} at a time`)
    .join("\n");
  return (
    "Counted (non-extra) runs the policy still owes.\n" +
    "lower = unmet e90 targets + unmet e360 targets of models already eligible for e360.\n" +
    "upper = the same, assuming every model still eligible promotes into e360.\n" +
    "Pinned, objective-carrying and retired models are excluded; extras never count.\n" +
    "ETA = sum over account classes of (remaining minutes / that class's concurrency),\n" +
    "with 90m per e90 run and 360m per e360; claude-code models are capped by their driver.\n" +
    "The classes actually drain in parallel, so this reads as a pessimistic bound.\n" +
    groups
  );
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
export type FleetRowState = "exited" | "paused-deploy" | "draining" | "running" | "resuming" | "paused" | "idle";

/** The badge text for a row state: identifiers above, plain words here. */
export function rowStateLabel(state: FleetRowState): string {
  return state === "paused-deploy" ? "paused for deploy" : state;
}

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

/**
 * A job whose process is gone during a deploy window, driving no run, is a
 * job the deploy stopped: its run paused (ADR-0036) and resumes when the
 * script starts the fleet again. The same row outside a window is just exited.
 */
function stateOf(job: FleetJobView, windowOpen: boolean): FleetRowState {
  if (job.alive === false) return windowOpen && (job.runId ?? null) === null ? "paused-deploy" : "exited";
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
  const windowOpen = deployWindowOpen(fleet.server);
  for (const job of fleet.jobs) {
    const runId = job.runId ?? null;
    const run = runId === null ? undefined : byId.get(runId);
    busy.add(job.account.toUpperCase());
    const state = stateOf(job, windowOpen);
    rows.push({
      key: job.name,
      state,
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
      note:
        state === "paused-deploy"
          ? "paused for the deploy window; the supervisor resumes it when the fleet starts"
          : job.resuming !== undefined && runId === null
            ? `resuming ${job.resuming}`
            : null,
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
