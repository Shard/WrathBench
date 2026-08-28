/**
 * The fleet table's pure layer: its columns, and the rows it is made of.
 *
 * One table, keyed by the JOB (the job is the unit of work, an
 * account — with a class — is where it runs). A row is either a job with an
 * account or an account with no job, and the table is ordered by state: see
 * `STATE_RANK` for the list and why it runs that way. The service-level
 * verdicts (heartbeat, deploy window) are shared with the status badge's
 * derivation in `status.ts`.
 *
 * The component renders its header from `FLEET_COLUMNS` and its body from
 * `fleetRows`, so what is asserted here is what ships — the same reason the run
 * rows keep their maths in `format.ts` (see dashboard/README.md).
 */

import type { FleetJobView, FleetPausedView, FleetResponse, FleetServerView, TpsFacts } from "@viewer/api-types";
import { fmtDuration, fmtTps } from "./format";
import type { RunListRow } from "@viewer/api-types";

/** The supervisor writes a heartbeat every tick (60s); past three ticks it is gone, not quiet. */
export const HEARTBEAT_STALE_MS = 180_000;

/**
 * How long ago the supervisor last beat, **on the server's own clock**.
 *
 * Both numbers come out of the same response, and that is the whole point.
 * `heartbeatAt` is written by the supervisor and read by the viewer; ageing it
 * against `Date.now()` in the browser measures the two machines' clock skew as
 * well as the silence, and there is a deployment where the skew is not noise:
 * the public dashboard reads a snapshot pushed up to a whole publish cadence
 * earlier — 5 minutes since 2026-08-25 (docs/PUBLIC-DASHBOARD.md) — so a
 * perfectly healthy fleet would drift toward the three-tick threshold and read
 * dead. Against `now` the age is what it was when the response was rendered,
 * which is the honest reading in both builds.
 *
 * A snapshot that stops arriving therefore freezes this age rather than
 * inflating it — deliberately. The publisher's own silence is a different
 * clock and gets its own banner (`snapshotBanner`); conflating the two would
 * blame the fleet for the publisher having stopped.
 *
 * Null when nothing has beaten here at all.
 */
export function heartbeatAge(fleet: Pick<FleetResponse, "heartbeatAt" | "now">): number | null {
  return fleet.heartbeatAt === undefined ? null : fleet.now - fleet.heartbeatAt;
}

/**
 * The supervisor's liveness, as --status decides it: a heartbeat inside the
 * window. No heartbeat at all is "not running" — the only honest reading
 * across a container boundary.
 */
export function supervisorAlive(fleet: Pick<FleetResponse, "heartbeatAt" | "now">): boolean {
  const age = heartbeatAge(fleet);
  return age !== null && age < HEARTBEAT_STALE_MS;
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

/** The gate's one-word verdict, as --status prints it. */
export function gateVerdict(pf: FleetResponse["preflight"]): "PASS" | "FAIL" | "SKIPPED" | "none" {
  if (pf === undefined) return "none";
  if (pf.skipped === true) return "SKIPPED";
  return pf.ok ? "PASS" : "FAIL";
}

/** Hours from now, coarse on purpose: a planning figure, not a clock (the badge's exhaust row). */
export function etaHours(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms === 0) return "0h";
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** One paused run as --status lists it: reason, pause count, and when the supervisor tries again. */
export function pausedLabel(p: FleetPausedView): string {
  const again = p.resumeAfter === null ? "" : `, resumes after ${new Date(p.resumeAfter).toLocaleTimeString()}`;
  return `${p.reason} (pause ${p.pauseCount})${again}`;
}

/** The fleet table, left to right. State leads: it is what an operator scans for. */
export const FLEET_COLUMNS = ["state", "job", "model", "episode", "account", "attempt", "run", "lvl / xp", "tokens", "tok/s", "cost", "elapsed"] as const;

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
   * The same models as ids, in roster order, for the cell's icons.
   * A paused account row carries the one model its run is on; an idle one
   * carries none. Kept beside the pre-joined string rather than replacing it:
   * the text is the truncated label and this is what identity is read from.
   */
  modelList: string[];
  /**
   * The episode id (e90, e360, freeplay). Null on an account row — and also on
   * a job whose episode the supervisor could not name, which the page
   * distinguishes: an account row has no episode to show, a job with none is a
   * job whose episode is *unknown*.
   */
  episode: string | null;
  account: string;
  /**
   * Which class the account belongs to: pool, paid, local, pinned. (The job's
   * `source` — file, queue, policy — is not a column: it maps to the class.)
   */
  accountClass: string;
  attempt: number | null;
  /** The run this row is about: the one being driven, or the paused one. */
  runId: string | null;
  level: number | null;
  xp: number | null;
  /** The run's token total, from the runs feed; null when there is no run or no trajectory. */
  tokens: number | null;
  /**
   * How fast the model is producing, from the runs feed (`TpsFacts`): the cell
   * shows the recent figure and the title carries the run's own average, because
   * on a live run the question is how it is going *now*. Null when there is no
   * run, no trajectory, or no measurable reply — never a rate for a row driving
   * nothing. A paused or exited row keeps whatever its trajectory last showed,
   * which is a fact about the run and not a claim that it is still producing;
   * the state badge is what says it stopped.
   */
  tps: TpsFacts | null;
  /** What the provider said it charged (the actual figure, as the episodes page shows it); null when unreported. */
  costUsd: number | null;
  /** Why the cost is blank, in the pricing layer's words; "" when there is a figure. */
  costNote: string;
  /** Active time in the episode, from the runs feed; null when there is no run. */
  elapsedMs: number | null;
  /**
   * The run's own recorded wall-clock watchdog (`comparability.budget.episodeMs`,
   * or the supervisor's `budgetMs` on a paused run). Never derived from the tier
   * name: a roster entry may override a tier's watchdogs, so the nominal 90/360
   * minutes is a claim about the tier and not about this run. Null when nothing
   * recorded one, which is the honest reading for a run assembled flag-by-flag.
   */
  budgetMs: number | null;
  /** Why an idle or paused row is what it is. */
  note: string | null;
}

/**
 * How far a row is through its episode, and how long is left.
 *
 * Two numbers an operator will believe, so they are shown only where they are
 * true and are absent otherwise — a wrong percentage here is worse than none.
 *
 * **Which rows.** Only a row whose episode clock is advancing right now:
 * `running`, and `draining` (a job finishing the episode it is on, taking
 * nothing new — its run is still being driven). Everything else is silent, and
 * on purpose: `paused` and `paused-deploy` hold a run that is not moving, so a
 * countdown against them would tick while nothing happens; `resuming` has not
 * picked its run back up yet (and note it *does* carry a runId, so the gate is
 * on the state and not on the absence of one); `idle` holds nothing; `exited`
 * is over.
 *
 * **Which clocks.** The denominator is the run's own recorded `episodeMs`
 * watchdog, never a nominal budget read off the tier name. The numerator is
 * `playtimeMs` from the runs feed — and because only running/draining rows get
 * here, that is its single provenance (the paused rows' `elapsedMs` never
 * reaches this). Both clocks exclude paused stretches: the `episode-limit`
 * watchdog carries `elapsedBeforeMs` across a resume (runner/src/run.ts, commit
 * 08cd691), so it measures active time just as playtime does. They are computed
 * differently — playtime sums trajectory segments, the watchdog sums process
 * uptime from the persisted `episodeElapsedMs` — so they agree to within a
 * segment boundary, not to the millisecond, and only where the pause persisted
 * its clock: a run resumed from a pause mark that predates the field restarts
 * the watchdog at zero (run.ts) while playtime keeps its earlier segments, and
 * the percentage then over-reads by whatever those segments held. That is the
 * accuracy claimed here.
 *
 * **Freeplay and the rest: the run's own clock decides, not the id.** The thing
 * that must never appear is a percentage against a TIER's nominal budget, and
 * `budgetMs` is never that — it is the `episodeMs` this run recorded and a
 * watchdog will actually end it on. So no episode is gated by name. `freeplay`
 * used to be, on the grounds that its id is uncapped (docs/EPISODES.md); that
 * was measured wrong in a way worth keeping written down. Four of the eight
 * freeplay runs on disk carry an enforced 21_600_000 — every session launched
 * under `idle: "unlimited"` does — and four carry null. Gating on the id hid a
 * real, enforced clock for half of them while adding nothing for the other half,
 * because a run with no recorded budget already falls out below. `probing` was
 * never gated for the same reason: a campaign sets an enforced clock and its run
 * ends on it.
 *
 * **Past the budget.** The real figure, over 100%. A run that overruns its
 * watchdog is a signal (`fleet-deepseek-flash-e90-…-a3` ran 114 minutes against
 * 90 and ended on `episode-limit`), and clamping to 100% would hide exactly the
 * thing worth seeing.
 */
export interface FleetProgress {
  /** Percent of the episode budget spent, rounded; may exceed 100. */
  pct: number;
  /** Time left before the watchdog fires; null once it is past due. */
  remainingMs: number | null;
  /** How far past the budget it has run; null while it is still inside it. */
  overMs: number | null;
}

/** The states whose episode clock is advancing; see `rowProgress`. */
function advancing(state: FleetRowState): boolean {
  return state === "running" || state === "draining";
}

export function rowProgress(row: Pick<FleetRow, "state" | "episode" | "elapsedMs" | "budgetMs">): FleetProgress | null {
  if (!advancing(row.state)) return null;
  // No episode-name gate. The question is whether THIS RUN recorded an enforced
  // clock, and the `budget` check below already answers it: a freeplay session
  // launched under `idle: "unlimited"` records a real six-hour `episodeMs` that a
  // watchdog ends it on, while an uncapped one records none and still shows
  // nothing. Measured on the runs to hand — four of eight freeplay runs carry
  // 21_600_000 and four carry null — so gating on the id would hide a real clock
  // for half of them. What must never appear is a percentage against a TIER
  // target, and none exists here: this is elapsed against the run's own budget.
  const budget = row.budgetMs;
  const elapsed = row.elapsedMs;
  if (budget === null || budget <= 0 || elapsed === null || elapsed < 0) return null;
  const left = budget - elapsed;
  return {
    pct: Math.round((elapsed / budget) * 100),
    remainingMs: left > 0 ? left : null,
    overMs: left > 0 ? null : -left,
  };
}

/** The state cell's percentage, next to the badge. "" where there is none to show. */
export function progressLabel(p: FleetProgress | null): string {
  return p === null ? "" : `${p.pct}%`;
}

/**
 * The state cell's title: the ETA the operator asked for, with the two clocks
 * behind it so the percentage is checkable rather than taken on faith. A run
 * past its budget has no ETA to give, so it says how far past it is instead of
 * counting down through zero.
 */
export function progressTitle(p: FleetProgress | null, row: Pick<FleetRow, "elapsedMs" | "budgetMs">): string {
  if (p === null) return "";
  const of = `${fmtDuration(row.elapsedMs)} of ${fmtDuration(row.budgetMs)}`;
  return p.remainingMs === null
    ? `ETA: past due — ${of}, over by ${fmtDuration(p.overMs)}`
    : `ETA: ${fmtDuration(p.remainingMs)} — ${of}`;
}

/** The tok/s cell: the recent figure, because a live run's speed now is the question. */
export function tpsLabel(tps: TpsFacts | null): string {
  return fmtTps(tps?.recent ?? null);
}

/**
 * The cell's title: the run's own average behind the recent figure, and how
 * many replies each is measured over, so a rate off two replies is not read as
 * a settled one. "" where there is nothing to say — a row with no run, or one
 * whose run has produced no measurable reply. `overall` is non-null whenever
 * `recent` is (the recent window is a slice of the same replies), so the guard
 * above is the only one needed.
 */
export function tpsTitle(tps: TpsFacts | null): string {
  if (tps === null || tps.recent === null) return "";
  return `${fmtTps(tps.recent)} tok/s over the last ${tps.recentReplies} repl(ies) · ${fmtTps(tps.overall)} tok/s over the run's ${tps.replies} — output tokens ÷ wall time of model replies`;
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

/**
 * A model cell's tooltip, with the id the provider actually served appended
 * when it says something the label does not. Same rule as `resolvedLabel`:
 * an id identical to what was asked for is not worth a second mention.
 */
export function withServed(title: string, resolved: string | null | undefined): string {
  if (typeof resolved !== "string" || resolved.length === 0 || resolved === title) return title;
  return title.length === 0 ? `served as ${resolved}` : `${title} · served as ${resolved}`;
}

/** Only a row with a run has somewhere to click through to. */
export function runHref(runId: string | null): string | null {
  return runId === null ? null : `/run/${encodeURIComponent(runId)}`;
}

/** Classes in the order their idle rows are grouped at the bottom. */
const CLASS_ORDER = ["pool", "paid", "local", "pinned"];

/**
 * The order the table is read in, most alive first.
 *
 * An operator scans this page for what is moving and what has stopped moving,
 * so the rank is by state, not by job name:
 *
 *   1 running        — driving a run right now
 *   2 resuming       — spawned, coming back to a paused run
 *   3 draining       — finishing its episode, taking nothing new
 *   4 paused-deploy  — stopped by the deploy window, resumes when the fleet starts
 *   5 paused         — a paused run parked against the account it paused on
 *   6 idle           — holding nothing: a job between episodes, or a free account
 *   7 exited         — the process is gone and nothing is coming back
 *
 * `paused` sits between the deploy window and idle because it is an account row
 * that still holds something: account rows holding a run sort above account rows
 * holding nothing, and both sort above what has exited.
 *
 * Ties break by account name, with one exception: inside `idle` the accounts
 * stay grouped by class (`CLASS_ORDER`) first, which is how the free capacity
 * reads. A `Record` rather than an array so an eighth state fails to compile.
 */
const STATE_RANK: Record<FleetRowState, number> = {
  running: 1,
  resuming: 2,
  draining: 3,
  "paused-deploy": 4,
  paused: 5,
  idle: 6,
  exited: 7,
};

/** The one comparator behind the table's order; see `STATE_RANK`. */
function byState(a: FleetRow, b: FleetRow): number {
  const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (rank !== 0) return rank;
  if (a.state === "idle") {
    const cls = CLASS_ORDER.indexOf(a.accountClass) - CLASS_ORDER.indexOf(b.accountClass);
    if (cls !== 0) return cls;
  }
  return a.account.localeCompare(b.account);
}

/**
 * A job whose process is gone during a deploy window, driving no run, is a
 * job the deploy stopped: its run paused and resumes when the
 * script starts the fleet again. The same row outside a window is just exited.
 */
function stateOf(job: FleetJobView, windowOpen: boolean): FleetRowState {
  if (job.alive === false) return windowOpen && (job.runId ?? null) === null ? "paused-deploy" : "exited";
  if (job.draining === true) return "draining";
  if ((job.runId ?? null) !== null) return "running";
  return job.resuming !== undefined ? "resuming" : "idle";
}

/**
 * The actual cost only — `CostView.actual`, what the provider said it charged,
 * as the episodes page shows it — never the estimate, and null for any of the
 * ways there is none (no run, unreadable trajectory, a provider that reports no cost).
 */
function actualUsd(run: RunListRow | undefined): number | null {
  const c = run?.cost?.actual ?? null;
  return c === null || c.basis === "none" ? null : c.usd;
}

/**
 * The whole table: every job the supervisor has a process for, plus every
 * account holding nothing, ordered by state through `byState`.
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
      /*
       * The tooltip is where the resolved id lands on this page (the cell
       * itself is already truncated): the roster's strings, then what the run
       * on this account was actually served — which for an alias is the only
       * place the strip says which Claude is in flight.
       */
      modelsTitle: withServed(job.models.join(", "), run?.resolvedModel),
      modelList: [...job.models],
      episode: job.episode ?? null,
      account: job.account,
      accountClass: job.accountClass,
      attempt: job.attempt ?? null,
      runId: runId ?? job.resuming ?? null,
      level: run?.level ?? null,
      xp: run?.xp ?? null,
      tokens: run?.tokens?.totalTokens ?? null,
      tps: run?.tps ?? null,
      costUsd: actualUsd(run),
      costNote: run?.cost?.actual?.note ?? "",
      elapsedMs: run?.playtimeMs ?? null,
      budgetMs: run?.comparability?.budget.episodeMs ?? null,
      note:
        state === "paused-deploy"
          ? "paused for the deploy window; the supervisor resumes it when the fleet starts"
          : job.resuming !== undefined && runId === null
            ? `resuming ${job.resuming}`
            : null,
    });
  }
  // Accounts no job is on. A paused run holds no account, so it is reported
  // against the account it paused on rather than as a job of its own.
  const paused = fleet.paused;
  const idle = fleet.accounts.filter((a) => !busy.has(a.account.toUpperCase()));
  for (const a of idle) {
    const here = paused.find((p) => (p.account ?? "").toUpperCase() === a.account.toUpperCase());
    const run = here === undefined ? undefined : byId.get(here.runId);
    rows.push({
      key: `account:${a.account}`,
      state: here === undefined ? "idle" : "paused",
      job: null,
      models: here?.model ?? "—",
      modelsTitle: withServed(here?.model ?? "", run?.resolvedModel),
      modelList: here === undefined ? [] : [here.model],
      episode: null,
      account: a.account,
      accountClass: a.class,
      attempt: null,
      runId: here?.runId ?? null,
      level: run?.level ?? null,
      xp: run?.xp ?? null,
      tokens: run?.tokens?.totalTokens ?? null,
      tps: run?.tps ?? null,
      costUsd: actualUsd(run),
      costNote: run?.cost?.actual?.note ?? "",
      elapsedMs: here?.elapsedMs ?? run?.playtimeMs ?? null,
      budgetMs: here?.budgetMs ?? run?.comparability?.budget.episodeMs ?? null,
      note: here !== undefined ? `${pausedLabel(here)} — ${here.why}` : a.job !== null ? `job ${a.job} holds nothing right now` : null,
    });
  }
  return rows.sort(byState);
}
