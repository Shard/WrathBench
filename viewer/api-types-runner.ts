/**
 * The runner group's wire shapes: the supervisor's state (`/api/fleet`), the
 * scheduler's verdict per roster entry (`/api/models`) and the model-facing
 * tool list (`/api/tools`), all served by `api-fleet.ts`. Types only, like
 * the contract they extend (`api-types.ts`), whose shared shapes they import;
 * that file never imports back, so a viewer-only reader sees none of these.
 */

import type { CredentialFix, CredentialHealth, CredentialHold, CredentialRead, CredentialWindow, ResumeHoldCode } from "../runner/src/credential-health";
export type { CredentialFix, CredentialHealth, CredentialWindow, HealthState, ResumeHoldCode } from "../runner/src/credential-health";
import type { ComparabilityView, CostFigure, CostView, EpisodeIdView, HarnessView, SnapshotEnvelope, TokenTotals, TpsFacts } from "./api-types";

/**
 * One job with a process, as the supervisor publishes it (the job is the one
 * unit of work; an account, with a class, is where it runs). A job
 * names the roster entry it is running, the tier, the account it landed on,
 * where it came from — the file's pinned list, the manual queue, or the
 * policy's own pick — and the process that runs it.
 *
 * The supervisor publishes processes, not runs; the run a job is driving is
 * resolved the same way `run-fleet.ts --status` resolves it (see
 * `accountHeldBy` in `run-roster.ts`) — from the run directories themselves.
 */
export interface FleetJobView {
  name: string;
  /** The roster ref, or several joined by `+` for a rotating job. */
  ref: string;
  /**
   * The tier the job runs under, or **null** when the supervisor could not name
   * one (commit 95908d5: unknown is written as null, never guessed at). A page
   * says "episode unknown" for it rather than showing a dash, which is what an
   * account holding no job shows.
   */
  episode: string | null;
  account: string;
  /** Where the account it landed on comes from: the pool, or a pin. */
  accountClass: "pinned" | "pool";
  source: string;
  /** The n-th attempt on (model, episode); absent on a job from the file. */
  attempt?: number;
  /** The paused run this spawn is resuming, when it is resuming one. */
  resuming?: string;
  /** The models behind `ref`, in roster order. */
  models: string[];
  /** The run holding this job's account (`heldAccounts`). Null between episodes and while a resume is spawning. */
  runId: string | null;
  /** That run's model. Null whenever `runId` is. */
  model: string | null;
  /** The supervisor's process record for this job. */
  pid: number;
  spawnedAt: number;
  exitCode: number | null;
  draining: boolean;
  alive: boolean;
}

/**
 * One account and what holds it, as the supervisor's `accounts` block records
 * it, with its class. `job` is null when nothing is on it — which is what
 * the fleet table's idle rows are made of.
 */
export interface FleetAccountView {
  account: string;
  /** `pinned` (a job names it), or `pool`. */
  class: "pinned" | "pool";
  job: string | null;
}

/**
 * A paused run the supervisor is holding rather than resuming, as
 * `--status` lists it. A paused run holds no account, so it shows against the
 * idle account it paused on rather than as a job.
 */
export interface FleetPausedView {
  runId: string;
  model: string;
  account: string | null;
  reason: string;
  since: number;
  /** How many times this run has paused; what the resume cadence indexes. */
  pauseCount: number;
  /** When the supervisor will try again; null when it is not a matter of time. */
  resumeAfter: number | null;
  elapsedMs: number | null;
  budgetMs: number | null;
  why: string;
  /**
   * The wait is a subscription usage window's (operator, 2026-10-16) or any
   * credential's hold: its reset time and the credential are the operator's,
   * so the public build withholds `resumeAfter` and `why` on such a row.
   * Absent on every other row.
   */
  subscriptionWait?: true;
  /**
   * What holds the resume when its credential does (`ResumeHoldCode`): a
   * budget's hold code, or the credential gone or disabled. The public build
   * says which in a fixed phrase. Absent when the credential holds nothing
   * (and on a row from a supervisor that predates it, which reads as a usage
   * window).
   */
  hold?: ResumeHoldCode;
}

/**
 * One run's progress as the fleet table shows it: the listing row's own
 * figures (`RunListRow`, the same derivation the runs table reads), cut to the
 * cells — level and xp, tokens, speed, the cost, active time against the run's
 * recorded episode clock, and the id it was served as. The public runs index
 * publishes exactly this shape per row.
 */
export interface FleetRunFacts {
  runId: string;
  resolvedModel: string | null;
  level: number | null;
  xp: number | null;
  playtimeMs: number | null;
  tokens: Pick<TokenTotals, "totalTokens"> | null;
  tps?: TpsFacts | null;
  /**
   * The provider's own figure, and the list-price estimate the table shows,
   * marked, where there is none (operator, 2026-11-18). `expected` is carried
   * only on a row whose actual is `none`, the one row that shows it: this shape
   * is every row of the public runs index, and the rest would be bytes no page
   * reads. Absent, too, on a row from a viewer that predates it.
   */
  cost: {
    /** `asIfMetered` marks a figure nobody was charged (claude-code's own), which the cell shows as an estimate; absent on an older row. */
    actual: Pick<CostFigure, "usd" | "basis" | "note" | "backfill"> & { asIfMetered?: boolean };
    expected?: Pick<CostFigure, "usd" | "basis" | "asIfMetered" | "asOf">;
  } | null;
  comparability: { budget: Pick<ComparabilityView["budget"], "episodeMs"> } | null;
}

/** The supervisor's counters since it started (`session` in fleet-state.json). */
export interface FleetSessionView {
  finished: number;
  ok: number;
  retried: number;
}

/** A paused run the supervisor ended instead of resuming (its ref names another model now). */
export interface FleetEndedView {
  runId: string;
  model: string;
  ref: string;
  detail: string;
}

/** The preflight gate's last result, as the supervisor recorded it. */
export interface FleetPreflightView {
  at: number;
  serverIdentity: string;
  /** The server's /health `build` stamp. */
  build?: string;
  ok: boolean;
  /** The gate was disabled: nothing ran, the gate is open. */
  skipped?: boolean;
  results: { script: string; ok: boolean; ms: number; tail: string }[];
}

/** The file on disk is rejected; the supervisor runs on its last good config. */
export interface FleetConfigRejectedView {
  since: number;
  error: string;
}

/**
 * How much of the schedule is still owed, as `runner/src/models.ts` computes
 * it (`outstandingWork`, where the formula and its two simplifications are
 * written out). `lower` assumes no further promotions, `upper` assumes every
 * still-eligible model promotes; the ETAs are wall clock from now, and null
 * when some of the work has no account to run it on. Shaped here rather than
 * imported, because this file stays import-free.
 */
export interface FleetOutstandingView {
  lower: number;
  upper: number;
  etaLowerMs: number | null;
  etaUpperMs: number | null;
  breakdown: {
    group: string;
    concurrency: number;
    lowerRuns: number;
    upperRuns: number;
    lowerMinutes: number;
    upperMinutes: number;
  }[];
}

/**
 * The worldserver's deploy-window phase, as `infra/k8s-deploy.sh`
 * writes it to `data/runs/server-state.json` at each transition. `running`
 * is the rest state (and the answer when the file is absent); the four
 * window phases mean a deploy holds the server right now; `failed` is a
 * verdict that stays up until the supervisor next boots. The detail is the
 * script's own sentence — the page prints it, never guesses. These are exactly
 * the phases the script writes; `infra/deploy-phases.test.ts` holds them to it.
 */
export interface FleetServerView {
  phase: "running" | "draining" | "waiting" | "verifying" | "resuming" | "failed";
  /** When the window opened (or the phase was reclaimed as running). */
  since: number;
  /** The build being deployed (or, at rest, the one last deployed); "" when unknown. */
  build: string;
  detail: string;
  updatedAt: number;
}

/** One world per eval, as the fleet page lists it. */
export interface FleetWorldView {
  id: string;
  state: "booting" | "up" | "parked" | "ended";
  realmId: number;
  runIds: string[];
  createdAt: number;
  endedAt: number | null;
  /** Boots so far, the failed ones included. */
  boots: number;
  /** The last successful boot's time to ready; null before one. */
  bootMs: number | null;
  /** The last boot's failure, when it failed; else null. */
  failed: string | null;
}

/**
 * The supervisor's published state. `present: false` is the normal answer on a
 * machine where the fleet has never run — it is not an error.
 */
export interface FleetResponse extends SnapshotEnvelope {
  present: boolean;
  /** The deploy window's phase; `running` with an empty detail when nothing was ever written. */
  server: FleetServerView;
  fleetPid?: number;
  startedAt?: number;
  heartbeatAt?: number;
  containerized?: boolean;
  stamp?: string;
  /** When the config in force was last parsed. */
  configLoadedAt?: number;
  /** Set while the config store does not load; the store's enabled flags are not in effect. */
  configRejected?: FleetConfigRejectedView;
  /** The last gate result; absent until the supervisor has gated once. */
  preflight?: FleetPreflightView;
  /** Every job with a process, as the supervisor published it. */
  jobs: FleetJobView[];
  /**
   * Every credential's state as the supervisor last saw it: slots in use, the
   * budget and what it has used, whether its secret's variable is set (never
   * its value), what it holds, the newest failure that indicts it.
   * Operator-only: the public build ships none (`projectFleet`).
   */
  /**
   * The worlds per eval the supervisor holds or held lately, newest first
   * (`fleetWorldViews`, infra/world.ts). Operator-only: the public build
   * ships none (`projectFleet`).
   */
  worlds?: FleetWorldView[];
  /** Why no world may be booted now (`worldsHold`); absent when none holds them. */
  worldsHold?: string;
  credentials?: {
    id: string;
    provider: string;
    billing: "free" | "paid";
    enabled: boolean;
    secretEnv: string;
    secretSet: boolean;
    slots: number;
    inUse: number;
    budget: string;
    used: string | null;
    held: { scored?: string; freeplay?: string };
    /** The holds, structured (`CredentialStatus.holds`); absent from a supervisor that predates them. */
    holds?: { scored?: CredentialHold; freeplay?: CredentialHold };
    lastError: { reason: string; at: number } | null;
    /** The provider's newest read of it, where a reader reads it; absent from a supervisor that predates it. */
    lastRead?: CredentialRead;
    health?: CredentialHealth;
    windows?: CredentialWindow[] | null;
    fix?: CredentialFix | null;
  }[];
  /** Every account the supervisor knows, with its class and what holds it. */
  accounts: FleetAccountView[];
  /** Paused runs the supervisor is not resuming right now, with why. */
  paused: FleetPausedView[];
  /** Paused runs the supervisor ended instead of resuming, this session. */
  ended: FleetEndedView[];
  /** Runs finished since this supervisor started. */
  session?: FleetSessionView;
  /**
   * Counted runs the policy still owes, with an ETA. Absent when the viewer
   * was given no fleet config to read a roster and its accounts out of.
   */
  outstanding?: FleetOutstandingView;
  /**
   * The progress of each run a job is driving or a paused row names
   * (`FleetRunFacts`), so the fleet table fills its cells without reading the
   * whole runs index. Optional: an older viewer or snapshot has none.
   */
  runFacts?: FleetRunFacts[];
  /** How many runs the runs index lists (the fleet page's link to it). Optional as `runFacts` is. */
  runCount?: number;
  /** Server clock at read time, so a client can age the heartbeat honestly. */
  now: number;
}

/* -------------------------------------------------------------- models --- */

/**
 * The scheduler's verdict on a model, as `/api/models` serves it.
 *
 * Every field mirrors `ModelState` in `runner/src/models.ts`, which is where
 * the projection lives and the only place any of it is decided. The route adds
 * the run ids behind each count and the last error text; it computes no number
 * of its own, so the page and `run-fleet --status` cannot disagree about why a
 * model is not running.
 */
export type ModelStatusView = "new" | "active" | "cooling" | "promoted" | "retired";

/** A rung of the evidence ladder; mirrors `TIERS` in `runner/src/roster-entry.ts`. */
export type TierView = "t0" | "t1" | "t2" | "t3";

/** What a model does with an account once its tier is spent; mirrors `IDLE_MODES`. */
export type IdleModeView = "none" | "unlimited";

/** One tier's counts for one model, plus the runs behind them. */
export interface ModelEpisodeView {
  /** Stamped, un-overridden, completed runs that are safe scoring evidence. */
  counted: number;
  /** Every stamped run on this tier, counted or not. */
  attempts: number;
  /** Attempts past the target (`extra: true`), reported apart and never counted. */
  extras: number;
  /** Runs from another harness series: listed, never counted, never attempts. */
  otherSeries: number;
  /** Runs the policy wants at this tier before it stops scheduling them. */
  target: number;
  bestLevel: number | null;
  /**
   * The highest level a counted run reached: on e90 the promotion witness
   * (`policy.promoteAtLevel`), on e360 the Deadmines one (`policy.deadminesAtLevel`).
   */
  countedLevel: number | null;
  lastEnded: number | null;
  lastReason: string | null;
  /** The counted runs, newest first. The ids behind `counted`, not a sample. */
  runIds: string[];
}

/** One of a model's runs, as the detail panel lists it. */
export interface ModelRunView {
  runId: string;
  episode: EpisodeIdView;
  episodeOverride: boolean;
  harnessVersion: string | null;
  /** The series the run's version belongs to; the schedule counts only the current one. */
  harnessSeries: string | null;
  /** An extra run: an attempt past the target, never counted. */
  extra: boolean;
  /**
   * The run's starting character, attached by the route from the same run rows
   * the listing reads. Optional for the reason `cost` is: the projection this
   * view is built from (`runner/src/models.ts`) does not carry it.
   */
  race?: number | null;
  raceName?: string | null;
  class?: number | null;
  className?: string | null;
  characterLabel?: string | null;
  /**
   * The id the provider actually served for this run (`RunRow.resolvedModel`),
   * attached by the route from the same run rows the listing reads. Optional
   * for the reason `cost` is: the scheduler's projection does not carry it.
   */
  resolvedModel?: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Wall clock, start to end — not active time; the run page owns that. */
  durationMs: number | null;
  bestLevel: number | null;
  terminationReason: string | null;
  live: boolean;
  counted: boolean;
  /**
   * The run's cost, attached by the route from the same memoised trajectory
   * totals the listing uses. Optional because the projection this view is built
   * from (`runner/src/models.ts`) does not know about prices. The panel prints
   * the provider's figure, else the list-price estimate, marked as one
   * (operator, 2026-11-18); the published snapshot carries the estimate's
   * dollars and date, not its note. `expected` is optional because a snapshot
   * published before it has only `actual`.
   */
  cost?: (Pick<CostView, "actual"> & { expected?: Pick<CostFigure, "usd" | "basis" | "asIfMetered" | "asOf"> }) | null;
}

/** The last error a model died of, off the end of that run's trajectory. */
export interface ModelLastErrorView {
  runId: string;
  reason: string;
  /** Truncated, and with the run's own recorded secrets struck out. */
  message: string;
  at: number | null;
}

export interface ModelRowView {
  /** The roster name (the config's `roster` map key) — the row's identity. */
  name: string;
  model: string;
  effort: string | null;
  /**
   * The entry's CLI compaction window as it declares it: a window, `"auto"`
   * for the CLI's own on a driver that defaults another, or absent for the
   * driver's default (the CLI's `auto`; claude-code's 300k).
   */
  compactWindow?: string | null;
  /**
   * The windows of the runs this entry owns, `"auto"` naming the CLI's own
   * (`ownedWindows`, runner/src/roster-entry.ts): one, except for an entry with no
   * window on a driver that defaults one, whose runs are its `auto` runs and
   * the default's. What a link to the entry's runs filters by. Absent on a
   * snapshot from before the field, which reads as the declared window alone.
   */
  windows?: string[];
  /**
   * The other roster entries of this model, in roster order: the same model on
   * another provider (`modelSiblings`, runner/src/models.ts). Its counts are
   * theirs too, since they fill one target (operator, 2026-11-16), and the
   * models page draws them as one row. Absent when the entry is alone on its
   * model, and on a snapshot from before the field.
   */
  siblings?: string[];
  platform: string | null;
  /**
   * Where each of the entry's providers serves it, in its preference order
   * (`runner/src/provider-options.ts`), when it has more than one; `platform`
   * is the first. Absent on a single-provider entry.
   */
  platforms?: string[];
  /** The harness this roster entry's runs go through, from its driver. */
  harness: HarnessView;
  /**
   * Whether this entry's runs cost the operator money: the reader's verdict
   * (`entryBilling`, `runner/src/billing.ts`), the same one its runs carry in
   * `ResultRun.billing`. Free means literally free — a `:free`/`-free`/
   * contributor-free endpoint, local hardware, or an entry that declared
   * `billing: "free"`; a subscription (claude-code, codex, OpenCode Go) is paid.
   *
   * Not the scheduler's verdict (`ModelState.billing`, `model-cost.ts`), which
   * says only which credential may carry a run and puts a subscription on
   * `free`; that one stays inside the supervisor and `bun wb fleet status`.
   */
  billing: "free" | "paid";
  /** The tier the config admitted this model to. */
  declaredTier: TierView;
  /** The tier it is scheduled under: `declaredTier` advanced once if it earned promotion. */
  tier: TierView;
  /**
   * A counted e90 in this series reached the promotion level. What the model
   * EARNED, kept apart from where it was ADMITTED: a `t0` model can hold this
   * without spending it, and a hand-promoted model never shows it falsely.
   */
  earnedPromotion: boolean;
  /**
   * A counted e360 in this series reached `policy.deadminesAtLevel`, which
   * opens the Deadmines evals its tier buys. Operator-only: the public build
   * shows no Deadmines episode on this page and ships none.
   */
  earnedDeadmines?: boolean;
  /** What it does with an account once its tier is spent. */
  idle: IdleModeView;
  status: ModelStatusView;
  /** Tiers the model may be scheduled on, in policy order. */
  eligible: EpisodeIdView[];
  perEpisode: Partial<Record<EpisodeIdView, ModelEpisodeView>>;
  cooling?: { until: number; rung: number; reason: string };
  retired?: { at: number; reason: string };
  /** Consecutive no-progress attempts on the defer ladder. */
  ladder: number;
  /**
   * The scheduler's verdict on this model right now — `schedulability` in
   * `runner/src/models.ts`, the function `run-fleet --status` prints — over
   * the jobs the supervisor has in flight. `extras` means the only thing left
   * to run is an extra past the target.
   */
  schedulable: { ok: boolean; why: string; extras: boolean };
  /**
   * Every distinct id this roster entry's runs actually resolved to, sorted.
   *
   * The row stays keyed on the roster's `model` string — that is the unit the
   * scheduler counts in — but an alias resolves at launch, so one row can hold
   * runs from two different Claudes. More than one entry here is that drift,
   * shown rather than averaged away. Empty when no run of this entry recorded
   * one; optional for the reason `ModelRunView.cost` is.
   */
  resolvedModels?: string[];
  /** This model's stamped runs, newest first. */
  runs: ModelRunView[];
  newestRunId: string | null;
  lastError: ModelLastErrorView | null;
}

export interface ModelsResponse extends SnapshotEnvelope {
  models: ModelRowView[];
  /** Where the roster came from. A fleet config without a `roster` map is `unreadable`. */
  roster: {
    path: string | null;
    shape: "roster" | "missing" | "unreadable";
    /** Every entry the roster names, excluded ones included. */
    count: number;
    /**
     * Entries the policy does not schedule and this response does not row:
     * a name a pinned job holds (a probe on its own account) or one carrying
     * an objective. Same predicate as `run-fleet --status`.
     */
    excluded: { name: string; reason: string }[];
  };
  policy: {
    promoteAtLevel: number;
    /** The level a counted e360 must reach to open the Deadmines evals. Operator-only, as `earnedDeadmines` is. */
    deadminesAtLevel?: number;
    /** The series the counts are keyed on (this checkout's); null when unversioned, which counts every run. */
    series: string | null;
    /** The ladder itself, so a page can name a tier's budget without hardcoding it. */
    tiers: Record<TierView, { runsPerEpisode: { e90: number; e360: number }; promotesTo: TierView | null; label: string }>;
    /** `policy.maxSessions`: how many sessions of a driver one host carries at once. An empty object caps none. */
    maxSessions: Record<string, number>;
    /**
     * The provider credentials runs take slots on, in preference order: id,
     * provider, billing, slots, enabled — never where the secret lives.
     * Private: the public build ships none (`projectModels`).
     */
    credentials?: { id: string; provider: string; billing: "free" | "paid"; slots: number; enabled: boolean }[];
  };
  /** The defer ladder's rungs, so the page can say "rung 3 of 9" honestly. */
  ladderMs: number[];
  /** The `?harness=` filter honoured; "all" (the default) lists every roster row. */
  harness: HarnessView | "all";
  now: number;
}

/** One model-facing tool as `/api/tools` presents it: the runner's own text, plus one example call. */
export interface ToolView {
  name: string;
  /** The description the model is given, verbatim from `runner/src/tools.ts` (names-first rendering). */
  description: string;
  /** The tool's parameters, in JSON Schema, as the model is given them. */
  inputSchema: Record<string, unknown>;
  /** One illustrative call, as the arguments would be sent; null for a tool that takes none. Harness text. */
  example: string | null;
  /** For an argument-less tool, one line on what the call gives back; null otherwise. */
  returns: string | null;
}

/** `/api/tools`: the model-facing tool list, in the order the model sees it. */
export interface ToolsResponse extends SnapshotEnvelope {
  tools: ToolView[];
}
