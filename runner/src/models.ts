/**
 * The model-state projection: what the scheduler and the Models page read.
 *
 * One pure function turns the run history under `data/runs/` plus the roster
 * into a per-model verdict — how many runs it has toward its target on each
 * episode tier, whether it has earned the long tier, whether it is cooling on
 * the ladder or retired — and a second turns that into the next jobs for the
 * pool's free accounts. The fleet supervisor (`infra/run-fleet.ts`) calls both
 * every tick; `--status`, `--dry-run` and the viewer's `/api/models` read the
 * same projection, so there is exactly one answer to "why is this model not
 * running". The policy lives in docs/OPERATIONS.md; the tiers in
 * docs/METHODOLOGY.md ("Episodes, lanes, and evidence") / docs/EPISODES.md.
 *
 * Rules the projection holds to:
 *
 * - **Only stamped runs exist.** A run directory with no `comparability.episode`
 *   in its meta.json predates the tiers and is never back-labeled,
 *   so it is invisible here — it neither counts toward a target nor climbs the
 *   ladder. Every fleet run since the tiers landed is stamped.
 * - **A zero-response run is a launch that did not happen** — no model
 *   `response` record in the trajectory, and not live. The runner archives it
 *   as it terminates, so no listing shows one; it does not count toward the
 *   target, but it does count toward the defer ladder (a provider that refuses
 *   every launch is exactly what the ladder backs off from), which is why this
 *   projection reads the archive and the viewer does not.
 * - **Overrides do not count.** A stamped run whose leash was overridden
 *   (`episodeOverride`) is not a member of its tier's group; it is listed
 *   (`attempts`) but neither counted nor a promotion witness.
 * - **The ladder is derived, never written.** Consecutive no-progress attempts
 *   (stillborn, or ended `adapter-error`) index `LADDER_MS`; the cooling
 *   deadline is the last failure's end plus the rung. The only persisted state
 *   is the operator's `clear`, kept in a sidecar the supervisor owns, and it
 *   works by ignoring attempts that ended before it.
 * - **The harness series is the schedule's key.** A run records its exact
 *   version; the policy (`series`) names the series of the checkout it runs
 *   from, and runs from another series are shown but not counted — a minor
 *   bump restarts the evidence, a fix commit within the series does not. A
 *   policy with no series (an unversioned checkout) filters nothing.
 * - **A paused run is suspended, not judged.** A run with a
 *   `pause_reason` and no termination — the supervisor stopped under it, or
 *   its provider ran out of quota — is an attempt but is neither counted nor
 *   a ladder failure while it is paused, and it holds its model: the policy
 *   does not start a second stream for a model whose run is waiting to be
 *   resumed. It is counted, or climbs the ladder, only when it finally ends.
 * - **Billing is a model property** (`model-cost.ts`). A paid model has its own
 *   targets (hard: never extras) and shares one in-flight cap; a free model
 *   gets extra runs at lowest priority once nothing else is schedulable,
 *   cycling through `extras.characters`. An extra is an attempt, never counted.
 * - **A local model's extras are freeplay** (`policy.extras.local`).
 *   The box is inference-bound, so another 90 minutes of it says little that
 *   the last three said; one unbounded freeplay run at a time, restarted when
 *   it ends, is the long-horizon data it can give. Same rule otherwise: an
 *   attempt, reported apart, never counted toward a target.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { harnessSeries } from "./comparability";
import { DEFAULT_CLAUDE_TOKEN_ENV, DRIVERS, harnessOf, isDriver, isTokenEnvName, type Driver, type Harness } from "./config";
import { EPISODE_IDS, EPISODES, isEpisodeId, isScoredEpisode, type EpisodeId, type ScoredEpisodeId } from "./episodes";
import { campaignWork, type Campaign, type ProbeRun } from "./campaigns";
import { NOT_THE_MODELS_FAULT, TAINT_AFTER, resumesOnPause, staleAfterMs } from "./lapse";
import { billingOf, type Billing } from "./model-cost";
import { platformOfBase } from "./platform";
import { ARCHIVE_DIR } from "../viewer/archive-dir";

// ----------------------------------------------------------------- policy

/**
 * The episode tiers the policy has targets on. `freeplay` has none — it is
 * never scheduled as evidence — but an `idle: "unlimited"` model's extras are
 * freeplay runs, so the projection still keeps stats for it.
 */
export const POLICY_EPISODES: readonly ScoredEpisodeId[] = ["e90", "e360"];

/**
 * Every episode the projection keeps stats for, in presentation order. Wider
 * than `POLICY_EPISODES` by `freeplay`, which carries a target of zero and
 * exists here so that freeplay attempts are numbered (a run id is
 * `…-<datestamp>-a<attempt>`, so two freeplay extras in one day need real
 * attempt numbers) and so a freeplay extra is reported like any other.
 */
export const STATS_EPISODES: readonly EpisodeId[] = EPISODE_IDS;

/** A starting character for an extra run: race and class ids as the client sends them. */
export interface StartingCharacter {
  race: number;
  class: number;
}

/**
 * The ladder a model climbs, named once here. A tier is a statement
 * of **how much evidence** a model gets, denominated in runs, and it is the
 * only thing that sets a run count: there is no per-entry override and no
 * per-billing table, so "how many runs does this model get" has exactly one
 * answer and it is the word in the config.
 *
 * The table lives in code, not in `fleet.json`, for the reason promotion is a
 * threshold rather than a judgement: a budget that every model is
 * held to alike is a recorded decision, and a bespoke volume is a NAMED tier
 * added here, reviewed like an episode id — never a number edited into one
 * model's entry at 03:00.
 *
 * Money is deliberately not modelled. A tier is denominated in runs; a spend
 * cap, when one is wanted, belongs beside `paid.maxConcurrent` as its own
 * thing. Minting `t0a`/`t0b` to approximate dollars is the accretion this
 * table exists to stop.
 */
export const TIERS = ["t0", "t1", "t2"] as const;
export type Tier = (typeof TIERS)[number];

export interface TierSpec {
  /** The counted runs this tier buys, per scored episode. Zero: not eligible. */
  runsPerEpisode: Record<ScoredEpisodeId, number>;
  /**
   * The tier a counted rung-1 `e90` (level `promoteAtLevel`) promotes into, or
   * null when the ladder is held here. Held is not "rung zero": a `t0` model is
   * not unpromoted, it is not admitted to the ladder, and its witness is still
   * recorded so that moving it to `t1` promotes it on evidence it already has.
   */
  promotesTo: Tier | null;
  /** What `--status` calls it. */
  label: string;
}

export const TIER_TABLE: Record<Tier, TierSpec> = {
  t0: { runsPerEpisode: { e90: 1, e360: 0 }, promotesTo: null, label: "trial" },
  t1: { runsPerEpisode: { e90: 3, e360: 0 }, promotesTo: "t2", label: "standard" },
  t2: { runsPerEpisode: { e90: 3, e360: 1 }, promotesTo: null, label: "long" },
};

/**
 * The tier a model is actually scheduled under: its declared tier, advanced
 * once if it has earned rung 1 and its tier promotes. Derived every tick and
 * never written back — the config states where a model was ADMITTED, the run
 * history states what it EARNED, and the two are read together rather than one
 * overwriting the other. So an operator may hand-promote by editing the tier,
 * and that never fabricates a promotion record.
 */
export function effectiveTier(declared: Tier, earnedRung1: boolean): Tier {
  const to = TIER_TABLE[declared].promotesTo;
  return earnedRung1 && to !== null ? to : declared;
}

/**
 * What a model does with an account when it has no counted runs left to earn.
 *
 * Two values, not three. `characters` used to mean "another scored run of an
 * eligible tier with the next race/class in a code-side cycle", and it was the
 * wrong shape for what it was doing: sampling start states is exploration, so
 * putting it in a SCORED episode meant an unscored question was being asked in
 * the scored lane, with the cell chosen by a counter that meant something else
 * (how many extras this model had made). It is a probe campaign now, where
 * the cells are named in the config and the runs are unscored.
 *
 * - `none` — nothing. The default, and what a paid model wants.
 * - `unlimited` — a freeplay session, unscored, up to `UNLIMITED_SESSION_MS`.
 */
export const IDLE_MODES = ["none", "unlimited"] as const;
export type IdleMode = (typeof IDLE_MODES)[number];

/**
 * The wall clock an `unlimited` idle session gets, on every account class.
 *
 * It is a clock rather than the unbounded run local extras used to get, because
 * a class governs the next pick and never a run in flight: an
 * endless session ended only by a 20-minute idle watchdog — which a model that
 * keeps playing never trips — holds its account forever, and after a series
 * bump the re-armed scored targets would queue behind it indefinitely. Six
 * hours is `e360`'s constant, and the tier pins no clock of its own
 * (docs/EPISODES.md), so nothing about comparability changes. Long-horizon
 * continuity is meant to come from resuming the character, not from one run
 * that never ends (FOLLOW-UPS 67).
 */
export const UNLIMITED_SESSION_MS = 6 * 60 * 60_000;

export interface SchedulingPolicy {
  /** The level an e90 run must reach to promote the model up its tier. */
  promoteAtLevel: number;
  /**
   * The harness series (`comparability.ts`) runs must carry to count. Null:
   * no filter, every stamped run counts (the pre-series behaviour).
   */
  series: string | null;
  /**
   * The paid-model throttle, or null to treat paid and free alike. Only a
   * throttle now: how much evidence a paid model gets is its tier, the same
   * sentence a free model's budget is written in. Paid-ness buys a model
   * nothing and costs it nothing here — it says only where a run may
   * physically execute (the paid account class) and how many at once.
   */
  paid: { maxConcurrent: number } | null;
  /**
   * The Claude subscription LANES the fleet may schedule on, as the names of
   * the env vars holding their OAuth tokens — never the tokens, which stay in
   * `.env`. In preference order: a claude-code run takes the first lane with a
   * free slot.
   *
   * A subscription is a lane, not a model dimension. The roster stays one entry
   * per model however many accounts are behind it, because which subscription
   * paid for a run says nothing about what the run measured. What it does
   * decide is how many claude-code sessions may be live at once, which is why
   * it lives here with the rest of "where a run may physically execute".
   *
   * Defaults to the single default lane, which is exactly the behaviour of
   * every config written before there was a second subscription.
   */
  subscriptions: string[];
}

/** The paid default once `policy.paid` is present: one paid run in flight. */
export const DEFAULT_PAID = { maxConcurrent: 1 } as const;

export const DEFAULT_POLICY: SchedulingPolicy = {
  promoteAtLevel: 5,
  series: null,
  paid: null,
  subscriptions: [DEFAULT_CLAUDE_TOKEN_ENV],
};

/**
 * The file's `policy` block (`infra/fleet.json`) over the defaults, in one
 * place so the supervisor, `--status` and the viewer read the same answer.
 *
 * What is left here is only ever about **where a run may physically execute
 * and how many at once**: `maxConcurrent` per rate-limit key, and `paid` as
 * the paid class's throttle. How much evidence a model gets is its tier
 * and is not expressible in this block at all.
 *
 * The removed keys are refused BY NAME rather than ignored. A file still
 * carrying `policy.runsPerEpisode` meant something specific by it, and
 * silently dropping it would quietly re-scope every model's budget; the
 * supervisor keeps its last good config and says which key to move where.
 * The series is the caller's (the checkout it runs from), never the file's.
 */
export function parsePolicyBlock(raw: unknown, series: string | null = null): SchedulingPolicy & { maxConcurrent: Record<string, number> } {
  const base = { ...DEFAULT_POLICY, series, maxConcurrent: {} as Record<string, number> };
  if (raw === undefined) return base;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("fleet config: policy must be an object");
  const o = raw as { runsPerEpisode?: unknown; maxConcurrent?: unknown; paid?: unknown; extras?: unknown; resume?: unknown; subscriptions?: unknown };
  const out = { ...base };
  if (o.runsPerEpisode !== undefined) {
    throw new Error(`policy.runsPerEpisode is not a 0.5 key — run counts are a model's tier now (${TIERS.join(", ")}); set roster.<name>.tier`);
  }
  if (o.extras !== undefined) {
    throw new Error('policy.extras is not a 0.5 key — idle behaviour is per model now; set roster.<name>.idle to "unlimited", and put a race/class sweep in a probe campaign');
  }
  if (o.resume !== undefined) {
    throw new Error(
      "policy.resume is not a key — whether a lapsed run resumes is the lane's rule: scored evals never do, freeplay always does, a probe campaign opts in with campaigns.<name>.resume",
    );
  }
  if (o.maxConcurrent !== undefined) {
    if (typeof o.maxConcurrent !== "object" || o.maxConcurrent === null || Array.isArray(o.maxConcurrent)) {
      throw new Error('policy.maxConcurrent must be an object like { "claude-code": 2 }');
    }
    for (const [k, v] of Object.entries(o.maxConcurrent as Record<string, unknown>)) {
      if (!isConcurrencyKey(k)) throw new Error(`policy.maxConcurrent: unknown concurrency key ${k} — allowed: ${CONCURRENCY_KEYS.join(", ")}`);
      const key = k;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`policy.maxConcurrent.${k} must be a positive integer`);
      out.maxConcurrent[key] = v;
    }
  }
  if (o.paid !== undefined) {
    if (typeof o.paid !== "object" || o.paid === null || Array.isArray(o.paid)) throw new Error('policy.paid must be an object like { "maxConcurrent": 1 }');
    const p = o.paid as { runsPerEpisode?: unknown; maxConcurrent?: unknown };
    if (p.runsPerEpisode !== undefined) {
      throw new Error("policy.paid.runsPerEpisode is not a 0.5 key — a paid model's budget is its tier, the same sentence a free model's is written in");
    }
    let cap: number = DEFAULT_PAID.maxConcurrent;
    if (p.maxConcurrent !== undefined) {
      if (typeof p.maxConcurrent !== "number" || !Number.isInteger(p.maxConcurrent) || p.maxConcurrent < 0) throw new Error("policy.paid.maxConcurrent must be a non-negative integer");
      cap = p.maxConcurrent;
    }
    out.paid = { maxConcurrent: cap };
  }
  if (o.subscriptions !== undefined) {
    if (!Array.isArray(o.subscriptions) || o.subscriptions.length === 0) {
      throw new Error('policy.subscriptions must be a non-empty array of env var NAMES, like ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"]');
    }
    const names: string[] = [];
    for (const v of o.subscriptions as unknown[]) {
      // A NAME, checked as one: the token itself in this field would put a
      // credential in a file that is committed and printed by --status.
      if (typeof v !== "string" || !isTokenEnvName(v)) {
        throw new Error(`policy.subscriptions: ${JSON.stringify(v)} is not an environment variable name — name the var that holds the token, never the token`);
      }
      if (names.includes(v)) throw new Error(`policy.subscriptions: ${v} listed twice — one entry per subscription`);
      names.push(v);
    }
    out.subscriptions = names;
  }
  return out;
}

/** A tier name; `where` names the entry in the error. */
export function parseTier(raw: unknown, where: string): Tier {
  if (typeof raw !== "string" || !(TIERS as readonly string[]).includes(raw)) {
    throw new Error(`${where}: tier must be one of ${TIERS.join(", ")} — it is how many runs this model gets, and every entry states it`);
  }
  return raw as Tier;
}

/** An idle mode; absent is `none`, so idle work is never bought by omission. */
export function parseIdle(raw: unknown, where: string): IdleMode {
  if (raw === undefined) return "none";
  if (typeof raw !== "string" || !(IDLE_MODES as readonly string[]).includes(raw)) {
    throw new Error(`${where}: idle must be one of ${IDLE_MODES.join(", ")}`);
  }
  return raw as IdleMode;
}

/**
 * The supervisor's defer ladder, in milliseconds per consecutive no-progress
 * attempt. The ceiling is six hours; an attempt made at the ceiling that still
 * makes no progress retires the model. It mirrors run-roster's per-spec ladder
 * so an operator reading either log sees the same rungs.
 */
export const LADDER_MS: readonly number[] = [
  1 * 60_000,
  3 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
];

/** The trajectory record the loop appends for a model turn (viewer/archive-dir.ts). */
export const MODEL_RESPONSE_RECORD = "response";
/** The trajectory record a pause writes (`Trajectory.setPause`). */
export const PAUSE_RECORD = "pause";

/** Termination reasons that mean "the model never got to play" for the ladder. */
export const NO_PROGRESS_REASONS: ReadonlySet<string> = new Set(["adapter-error"]);

// ----------------------------------------------------------------- inputs

/** A roster entry as the projection needs it: identity plus the two optional overrides. */
export interface RosterModel {
  /** The roster name; the key everything else hangs off. */
  name: string;
  model: string;
  effort?: string;
  driver?: string;
  apiBase?: string;
  /**
   * How much evidence this model gets (`TIER_TABLE`). Required: with a default,
   * adding a model and forgetting the field quietly buys a full budget, and for
   * a paid model that is money nobody approved.
   */
  tier: Tier;
  /** What it does with an account once its tier is spent. Absent: nothing. */
  idle?: IdleMode;
  /** Operator override of the billing verdict (`model-cost.ts`). */
  billing?: Billing;
}

/**
 * A job as the membership predicate needs it: which roster names it holds, and
 * the account it is pinned to when it is pinned to one.
 *
 * Deliberately structural. The supervisor's `FleetJob` carries a spawn's worth
 * of fields and lives beside the process path; the viewer parses a narrow
 * slice of the same file at its own boundary. Both can satisfy this, so the
 * question "is this roster name the policy's to schedule" has one answer
 * rather than one per reader (FOLLOW-UPS 52).
 */
export interface PolicyJob {
  refs: readonly string[];
  /** Set: the job is pinned to this account. Absent: it takes a pool account. */
  account?: string | undefined;
  /** The job's name, for the exclusion sentence. */
  name?: string | undefined;
}

/**
 * A roster as the two predicates below need it: the NAMES, and nothing else.
 *
 * It used to need each entry's `objective`, because an entry carrying one was
 * outside the policy. A catalog entry cannot carry one any more, so nothing
 * about an entry excludes it — only a pinned job holding its
 * account does, and that is a property of the queue.
 */
export type PolicyRoster = Readonly<Record<string, unknown>>;

/** Roster names a pinned job references: never the policy's to schedule. */
export function pinnedRefs(jobs: readonly PolicyJob[]): Set<string> {
  return new Set(jobs.filter((j) => j.account !== undefined).flatMap((j) => [...j.refs]));
}

/**
 * The roster names the policy may schedule: every name not referenced by a
 * pinned job, whose account is spoken for.
 *
 * It used to also exclude an entry carrying an objective. An entry cannot
 * carry one any more — steering is a campaign, which BORROWS a catalog
 * entry rather than taking it out of the schedule — so that clause described a
 * state the parser now refuses.
 */
export function policyRefs(
  jobs: readonly PolicyJob[],
  roster: PolicyRoster,
): Set<string> {
  const pinned = pinnedRefs(jobs);
  return new Set(Object.keys(roster).filter((n) => !pinned.has(n) && refusalOf(roster, n) === undefined));
}

/** A per-entry refusal the parser recorded, if any (`FleetRosterEntry.refused`). */
function refusalOf(roster: PolicyRoster, name: string): string | undefined {
  const e = roster[name] as { refused?: unknown } | undefined;
  return typeof e?.refused === "string" ? e.refused : undefined;
}

/** Why a roster name is outside the policy, or undefined when it is inside. */
export function policyExclusion(
  jobs: readonly PolicyJob[],
  roster: PolicyRoster,
  name: string,
): string | undefined {
  const job = jobs.find((j) => j.account !== undefined && j.refs.includes(name));
  if (job !== undefined) return `pinned to ${job.account} by job ${job.name ?? job.refs.join("+")}`;
  // An entry the parser refused: it stays in the catalog (so a job naming it is
  // gated rather than taking the whole file down) and is scheduled by nothing.
  return refusalOf(roster, name);
}

/** Operator overrides the supervisor persists (`fleet-models.json`). */
export interface ModelsSidecar {
  version: 1;
  /** roster name -> when the operator cleared its retirement/ladder (ms). */
  cleared: Record<string, number>;
}

export function parseModelsSidecar(text: string): ModelsSidecar {
  const empty: ModelsSidecar = { version: 1, cleared: {} };
  try {
    const raw = JSON.parse(text) as Partial<ModelsSidecar>;
    if (typeof raw !== "object" || raw === null || typeof raw.cleared !== "object" || raw.cleared === null) return empty;
    const cleared: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.cleared)) if (typeof v === "number" && Number.isFinite(v)) cleared[k] = v;
    return { version: 1, cleared };
  } catch {
    return empty;
  }
}

export function serializeModelsSidecar(s: ModelsSidecar): string {
  return JSON.stringify({ version: 1, cleared: s.cleared }, null, 2) + "\n";
}

/** One run, reduced to what the policy asks of it. */
export interface RunFact {
  runId: string;
  model: string;
  effort: string | null;
  episode: EpisodeId;
  episodeOverride: boolean;
  harnessVersion: string | null;
  /** `harnessSeries(harnessVersion)`; what the schedule keys on. */
  harnessSeries: string | null;
  /** An extra run: an attempt the policy made past the target, never counted. */
  extra: boolean;
  startedAt: number;
  /** `ended_at` from run.sqlite, else the trajectory's mtime. */
  endedAt: number | null;
  terminationReason: string | null;
  /** `response` records in trajectory.jsonl; null when the file is unreadable. */
  modelResponses: number | null;
  /** Highest `state.level` observed, or null when there are no rows. */
  bestLevel: number | null;
  /** No termination row, not paused, and a trajectory that grew recently. */
  live: boolean;
  /**
   * Set while the run is paused: `pause_reason` in run.sqlite with
   * no termination. `at` is meta.json's pause mark when present, else the
   * trajectory's mtime; `count` is how many times this run has paused, which
   * is what a resume cadence indexes; `episodeElapsedMs` is the clock the run
   * will continue from (null for a pause written before the mark existed).
   */
  pause: { reason: string; at: number; count: number; episodeElapsedMs: number | null } | null;
  /** The game account the run was launched on; a resume must go back to it. */
  account: string | null;
  /**
   * The character the run actually played (the model names it, and
   * `run.ts` rewrites the config's suggestion at the first sight of it). What
   * account affinity keys on: a fresh attempt prefers the account this
   * character is still standing on, so the name does not collide elsewhere.
   */
  character: string | null;
  /** The run's wall-clock budget (`watchdogs.episodeMs`), null when disabled. */
  episodeMs: number | null;
  /**
   * The probe campaign and cell this run was commissioned by, or
   * null on anything that is not a campaign run. Read straight off the run's own
   * config, which is why a campaign's progress survives an edit to the file —
   * and why a completed campaign's results outlive the deletion of its entry.
   */
  campaign: string | null;
  cell: string | null;
  /**
   * The Claude subscription lane this run bills, as the env var NAME holding
   * its token (`RunConfig.subscription`); null on anything that is not a
   * claude-code run, and on a claude-code run launched before lanes existed —
   * which is the default lane, and reads as one (`claudeLaneKey`).
   *
   * Read off the run's own config for the same reason `campaign` is: the fleet
   * counts live runs per lane, and that count has to survive a supervisor
   * restart, which nothing held in memory does.
   */
  subscription: string | null;
}

// ----------------------------------------------------------------- outputs

export type ModelStatus = "new" | "active" | "cooling" | "promoted" | "retired";

export interface EpisodeStats {
  /** Runs that count toward the target: stamped, un-overridden, not stillborn. */
  counted: number;
  /** Stamped runs that never produced a model response. */
  stillborn: number;
  /** Every stamped run, counted or not — what the next run id is numbered after. */
  attempts: number;
  /** Attempts the policy made past the target (`extra: true`); reported apart, never counted. */
  extras: number;
  /** Runs from another harness series: shown and numbered as attempts, never counted. */
  otherSeries: number;
  /**
   * Attempts spent on a run that lapsed and was not resumed:
   * `attempt-failed` terminations in this series. An operator-pause (`manual`)
   * and an offline gap (`stale`) are the harness's doing and are not here.
   */
  failed: number;
  /**
   * `failed` reached `TAINT_AFTER`: the model gets no further
   * attempts on this episode in this series. Distinct from the roster's own
   * `isTainted`, which is a per-process defer ladder over launch failures.
   */
  tainted: boolean;
  target: number;
  bestLevel: number | null;
  /** A counted, un-overridden run reached `promoteAtLevel` — the promotion witness on e90. */
  reachedL5: boolean;
  lastEnded: number | null;
  lastReason: string | null;
}

export interface ModelCooling {
  until: number;
  /** 1-based rung of `LADDER_MS`. */
  rung: number;
  reason: string;
}

export interface ModelRetired {
  at: number;
  reason: string;
}

export interface ModelState {
  name: string;
  model: string;
  effort: string | null;
  platform: string | null;
  /** The harness this entry's runs go through, from its driver; a tag, not a partition. */
  harness: Harness;
  status: ModelStatus;
  /** Free or paid, decided by `model-cost.ts` (or the roster's override). */
  billing: Billing;
  /** The tier the config admitted this model to — what an operator wrote. */
  declaredTier: Tier;
  /**
   * The tier it is scheduled under: `declaredTier`, advanced once if it earned
   * rung 1 and that tier promotes. Equal to `declaredTier` for a `t0` model
   * however well it plays, and for one an operator hand-promoted.
   */
  tier: Tier;
  /**
   * A counted `e90` in this series reached `promoteAtLevel`. Kept apart from
   * the tier on purpose: this is what the model EARNED, the tier is where it
   * was ADMITTED, and a hand-promoted model must never read as having earned
   * it. It is also why moving a `t0` model to `t1` promotes it immediately.
   */
  earnedRung1: boolean;
  /** What it does with an account once its tier is spent. */
  idle: IdleMode;
  /** Episode tiers the model may be scheduled on, in policy order. */
  eligible: EpisodeId[];
  perEpisode: Partial<Record<EpisodeId, EpisodeStats>>;
  cooling?: ModelCooling;
  retired?: ModelRetired;
  /** Consecutive no-progress attempts on the ladder (0 when the last attempt progressed). */
  ladder: number;
  /**
   * The model's newest paused run in this series: it holds the
   * model — nothing new is scheduled for it — until the supervisor resumes
   * the run or the run goes stale (`isStalePause`).
   */
  paused?: { runId: string; episode: EpisodeId; reason: string; at: number; episodeElapsedMs: number | null; episodeMs: number | null };
}

export interface NextJob {
  name: string;
  episode: EpisodeId;
  account: string;
  /** 1-based attempt number on this (model, episode): `attempts + 1`. */
  attempt: number;
  why: string;
  /** An extra run past the target (free models only), with the character it rolls. */
  extra?: StartingCharacter;
  /**
   * Set on a probe pick: which campaign commissioned it and which
   * cell it is. The supervisor reads the campaign back out of the config for
   * the run dimensions; only the identity travels on the pick.
   */
  probe?: { campaign: string; cell: string };
}

/** A pick the policy would have made but held back, with the reason — what `--dry-run` explains. */
export interface HeldPick {
  name: string;
  episode: EpisodeId;
  why: string;
}

/** An account that exists but is taken, and (where known) who is holding it. */
export interface BusyAccount {
  account: string;
  /** The run id or job name on it; absent when the caller cannot name one. */
  by?: string;
}

// ----------------------------------------------------------- reading runs

/** A trajectory touched more recently than this belongs to a live process. */
export const LIVE_WINDOW_MS = 120_000;

const RUN_ID = /^[A-Za-z0-9._-]+$/;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Count `response` records in a trajectory without holding the file in memory. */
export function countModelResponses(path: string): number | null {
  return countRecords(path, [MODEL_RESPONSE_RECORD])?.get(MODEL_RESPONSE_RECORD) ?? null;
}

/** One pass over a trajectory, counting the records of each kind named. Null when unreadable. */
export function countRecords(path: string, kinds: readonly string[]): Map<string, number> | null {
  if (!existsSync(path)) return null;
  const n = new Map<string, number>(kinds.map((k) => [k, 0]));
  try {
    const text = readFileSync(path, "utf8");
    let from = 0;
    for (;;) {
      const nl = text.indexOf("\n", from);
      const line = nl === -1 ? text.slice(from) : text.slice(from, nl);
      if (line.length > 0) {
        // Cheap prefilter, then the honest parse: the `t` key can sit anywhere.
        for (const k of kinds) {
          if (!line.includes(`"${k}"`)) continue;
          let hit = false;
          try {
            const rec = JSON.parse(line) as { t?: unknown };
            hit = rec.t === k;
          } catch {
            /* a torn line is not a record */
          }
          if (hit) {
            n.set(k, (n.get(k) ?? 0) + 1);
            break;
          }
        }
      }
      if (nl === -1) break;
      from = nl + 1;
    }
  } catch {
    return null;
  }
  return n;
}

/**
 * Read one run directory into a fact, or null when it is not a stamped run.
 * Tolerant everywhere: a run mid-write or an unreadable database degrades to
 * "no data", never to an exception that costs the whole projection.
 */
export function readRunFact(runsDir: string, runId: string, now = Date.now()): RunFact | null {
  const dir = join(runsDir, runId);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return null;
  let meta: {
    harnessVersion?: unknown;
    startedAt?: unknown;
    config?: {
      model?: unknown;
      effort?: unknown;
      extra?: unknown;
      account?: unknown;
      character?: unknown;
      campaign?: unknown;
      cell?: unknown;
      subscription?: unknown;
      watchdogs?: { episodeMs?: unknown };
    };
    comparability?: { episode?: unknown; episodeOverride?: unknown; effort?: unknown };
    pause?: { reason?: unknown; at?: unknown; episodeElapsedMs?: unknown };
  };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as typeof meta;
  } catch {
    return null;
  }
  const episode = meta.comparability?.episode;
  if (!isEpisodeId(episode)) return null;
  const model = str(meta.config?.model);
  if (model === null) return null;

  const fact: RunFact = {
    runId,
    model,
    effort: str(meta.comparability?.effort) ?? str(meta.config?.effort),
    episode,
    episodeOverride: meta.comparability?.episodeOverride === true,
    harnessVersion: str(meta.harnessVersion),
    harnessSeries: harnessSeries(str(meta.harnessVersion)),
    extra: meta.config?.extra === true,
    startedAt: num(meta.startedAt) ?? 0,
    endedAt: null,
    terminationReason: null,
    modelResponses: null,
    bestLevel: null,
    live: false,
    pause: null,
    account: str(meta.config?.account),
    character: str(meta.config?.character),
    episodeMs: num(meta.config?.watchdogs?.episodeMs),
    campaign: str(meta.config?.campaign),
    cell: str(meta.config?.cell),
    subscription: str(meta.config?.subscription),
  };

  const jsonl = join(dir, "trajectory.jsonl");
  let mtime: number | null = null;
  if (existsSync(jsonl)) {
    try {
      mtime = statSync(jsonl).mtimeMs;
    } catch {
      /* unreadable stat: treat as no trajectory */
    }
  }
  const counts = countRecords(jsonl, [MODEL_RESPONSE_RECORD, PAUSE_RECORD]);
  fact.modelResponses = counts?.get(MODEL_RESPONSE_RECORD) ?? null;
  let pauseReason: string | null = null;

  const dbPath = join(dir, "run.sqlite");
  if (existsSync(dbPath)) {
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const r = db.query(`SELECT started_at, ended_at, termination_reason FROM run WHERE run_id = ?`).get(runId) as Record<
        string,
        unknown
      > | null;
      if (r !== null) {
        fact.startedAt = num(r["started_at"]) ?? fact.startedAt;
        fact.endedAt = num(r["ended_at"]);
        fact.terminationReason = str(r["termination_reason"]);
      }
      try {
        const p = db.query(`SELECT pause_reason FROM run WHERE run_id = ?`).get(runId) as Record<string, unknown> | null;
        pauseReason = p === null ? null : str(p["pause_reason"]);
      } catch {
        /* a store without the column (synthetic or very old) is not paused */
      }
      const lv = db.query(`SELECT MAX(level) AS v FROM state WHERE run_id = ? AND level > 0`).get(runId) as Record<
        string,
        unknown
      > | null;
      fact.bestLevel = lv === null ? null : num(lv["v"]);
    } catch {
      /* a busy or foreign database leaves the sqlite fields null */
    } finally {
      db?.close();
    }
  }
  if (fact.endedAt === null && fact.terminationReason !== null) fact.endedAt = mtime;
  // A termination wins over a stale pause row (the --resume path clears the
  // row, but a run can also be classified by hand after a pause).
  if (pauseReason !== null && fact.terminationReason === null) {
    const markedAt = num(meta.pause?.at);
    fact.pause = {
      reason: pauseReason,
      at: markedAt ?? mtime ?? fact.startedAt,
      count: Math.max(1, counts?.get(PAUSE_RECORD) ?? 1),
      episodeElapsedMs: num(meta.pause?.episodeElapsedMs),
    };
  }
  fact.live = fact.terminationReason === null && fact.pause === null && mtime !== null && now - mtime < LIVE_WINDOW_MS;
  if (!fact.live && fact.endedAt === null) fact.endedAt = mtime;
  return fact;
}

/**
 * Every stamped run under `runsDir`, oldest first.
 *
 * `archive/` is skipped by default, which is what a *listing* wants: an
 * archived run is one nobody should see again. The **scheduler** asks for them
 * (`includeArchived`), and has to. A run that terminates with no model
 * response is archived by the runner as it exits, and those runs are exactly
 * what the defer ladder is made of — drop them and a provider that refuses
 * every launch relaunches forever at rung zero. They also number attempts:
 * a run id carries a date stamp plus `-a<attempt>`, so an invisible attempt
 * would have the next one collide with a directory already on disk.
 */
export function readRunFacts(runsDir: string, now = Date.now(), opts: { includeArchived?: boolean } = {}): RunFact[] {
  if (!existsSync(runsDir)) return [];
  const out: RunFact[] = [];
  const scan = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !RUN_ID.test(d.name) || d.name === ARCHIVE_DIR) continue;
      const f = readRunFact(dir, d.name, now);
      if (f !== null) out.push(f);
    }
  };
  scan(runsDir);
  if (opts.includeArchived === true) scan(join(runsDir, ARCHIVE_DIR));
  out.sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

// ------------------------------------------------------------- projection

/**
 * The roster entry's platform: the shared classifier (`platform.ts`, which the
 * writer and the viewer also read), over this projection's own fallback — a
 * roster entry with no api base is the openai-compatible default, which is
 * OpenRouter. `local` is loopback and RFC-1918 only, the same test `billingOf`
 * calls the operator's own hardware; a public IPv4 reads as itself.
 */
export function platformOf(apiBase: string | undefined, driver: string | undefined): string | null {
  return platformOfBase(apiBase) ?? (driver ?? "openrouter");
}

/**
 * The rate-limit keys `policy.maxConcurrent` may cap: every driver, plus the
 * two shared free-cloud platforms whose free tiers are metered separately by
 * their upstream provider (`concurrencyKeyOf`). Widening validation from
 * drivers to these keys is purely additive — an old per-driver cap still parses.
 */
export const CONCURRENCY_KEYS: readonly string[] = [...DRIVERS, "openrouter", "opencode"];

/**
 * A claude-code run counts against TWO keys, and needs a free slot in both.
 *
 *  - `claude-code` — every Claude session in flight, whichever subscription
 *    pays for it. The operator's overall ceiling, and the same key (with the
 *    same meaning) that every config written before there was a second
 *    subscription already had.
 *  - `claude-code:<ENV NAME>` — that one subscription's sessions. Every lane
 *    has one, the default lane included, so the two questions never share a
 *    number: "how many Claude sessions at once" and "how many on THIS account"
 *    are different limits and are written as different keys.
 *
 * A key the file does not name is uncapped, as everywhere else. So an old file
 * saying only `"claude-code": 2` still means exactly what it meant — two
 * sessions, and nothing said about which account — and a per-account limit is
 * added by naming the lane, never by re-reading the total.
 */
export const CLAUDE_TOTAL_KEY = "claude-code";

export function claudeLaneKey(tokenEnv: string | null | undefined): string {
  return `${CLAUDE_TOTAL_KEY}:${tokenEnv ?? DEFAULT_CLAUDE_TOKEN_ENV}`;
}

/** The lane a `claude-code:<NAME>` key names, or null for anything else. */
export function laneOfKey(key: string): string | null {
  return key.startsWith(`${CLAUDE_TOTAL_KEY}:`) ? key.slice(CLAUDE_TOTAL_KEY.length + 1) : null;
}

export function isConcurrencyKey(k: string): boolean {
  if ((CONCURRENCY_KEYS as readonly string[]).includes(k)) return true;
  const lane = laneOfKey(k);
  return lane !== null && isTokenEnvName(lane);
}

/**
 * Both keys a claude-code run on `tokenEnv` counts against, in the order a
 * refusal should name them. Everything else counts against its one key.
 */
export function claudeKeysFor(tokenEnv: string | null | undefined): string[] {
  return [claudeLaneKey(tokenEnv), CLAUDE_TOTAL_KEY];
}

/** The cap on a key; undefined is uncapped. */
export function capFor(max: Record<string, number>, key: string): number | undefined {
  return max[key];
}

/**
 * The concurrency key a roster entry counts against for `policy.maxConcurrent`.
 *
 * The cap keys on a RATE-LIMIT key, not a driver, because the shared free-cloud
 * pools (OpenRouter, OpenCode Zen) all drive through the `openai` driver yet
 * meter their `:free`/`-free` tiers per upstream provider — running several at
 * once burns one daily budget and breaks the runs. So a FREE model on a shared
 * free platform lands in that platform's key (`openrouter` / `opencode`);
 * everything else keeps its driver key: paid models (governed by the separate
 * `policy.paid` cap even when their platform projects to OpenRouter), the local
 * box (its one account is its limit), `stub`, and `claude-code`.
 *
 * The free branch is gated on `driver === "openai"` and reads the platform from
 * the api base alone — `platformOfBase(apiBase) ?? "openrouter"`, an absent base
 * being the OpenRouter default, mirroring `isSharedFreePool` — never from the
 * driver, so a `:free` slug pinned to `driver: "openai"` with no base still
 * lands in the openrouter key rather than escaping the cap. The `opencode.ai`
 * host is normalized to `opencode` here and only here: `platformOfBase` keeps
 * its host spelling so `run.platform` and the viewer's listing stay stable
 * against runs already on disk; the key is the one seam that renames it.
 *
 * `claude-code` is the only key that is refined further, and not here: which
 * SUBSCRIPTION a claude run bills is decided when it is scheduled, not by the
 * roster entry, so the fleet turns this key into the run's lane key with
 * `claudeLaneKey`. A caller with no lane in hand gets the default lane's key,
 * which is this one.
 */
export function concurrencyKeyOf(r: Pick<RosterModel, "name" | "driver" | "apiBase">, billing: Billing): string {
  const driver = driverOf(r);
  if (driver === "openai" && billing === "free") {
    const platform = platformOfBase(r.apiBase) ?? "openrouter";
    if (platform === "openrouter") return "openrouter";
    if (platform === "opencode.ai" || platform === "opencode") return "opencode";
  }
  return driver;
}

/** A roster entry's driver; `openai` when it names none. A name outside the vocabulary is a config error. */
export function driverOf(r: { name: string; driver?: string }): Driver {
  const d = r.driver ?? "openai";
  if (!isDriver(d)) throw new Error(`roster.${r.name}: driver "${d}" is not one of openai|claude-code|stub`);
  return d;
}

/**
 * Whether a run produced no model response at all; null while undecidable.
 *
 * Internal to the scheduler now: such a run is archived by the runner as it
 * terminates and no listing shows one, but the ladder is made of them, so the
 * projection (which reads the archive) still has to name the state.
 */
export function stillbornOf(f: RunFact): boolean | null {
  if (f.modelResponses === null) return null;
  // Paused: undecided. A 0-response rate-limited pause is a launch still in
  // progress as far as the policy is concerned (the roster retries it).
  if (f.live || f.pause !== null) return null;
  return f.modelResponses === 0;
}

/** A run that counts toward a target: a member of its tier's group that got off the ground. */
// The set of "not the model's fault" terminations lives with the lapse rule,
// because the viewer's scored-ness predicate reads it too and the two must
// not drift. Re-exported here so every existing importer is unchanged.
export { NOT_THE_MODELS_FAULT } from "./lapse";

/**
 * When a run last showed a sign of life: its pause mark when it has one, else
 * the trajectory's own mtime (`endedAt` on a run with no termination row).
 *
 * The pause mark WINS over the mtime rather than being maxed with it. A paused
 * run does nothing after it pauses, but its directory can still be touched —
 * meta.json is written after the pause record, and the roster frees its
 * session afterwards — so a max() would read a five-second-newer file as five
 * hours of life.
 */
export function lastActivityOf(f: Pick<RunFact, "pause" | "endedAt" | "startedAt">): number {
  return f.pause !== null ? f.pause.at : Math.max(f.endedAt ?? 0, f.startedAt);
}

/**
 * A run nothing came back for: no termination, and no activity for
 * longer than its own episode budget (a run with no wall clock gets
 * `STALE_FALLBACK_MS`). The host slept, or the fleet was down; either way the
 * run is cooked and is ended rather than resumed. A live process is excluded
 * by `f.live`, which the caller must have computed against the same clock.
 */
export function isStaleRun(f: Pick<RunFact, "pause" | "endedAt" | "startedAt" | "episodeMs" | "live" | "terminationReason">, now: number): boolean {
  if (f.terminationReason !== null || f.live) return false;
  return now - lastActivityOf(f) > staleAfterMs(f.episodeMs);
}

/** How long a stale run has been silent, or null when it is current. */
export function staleForMs(f: Parameters<typeof isStaleRun>[0], now: number): number | null {
  return isStaleRun(f, now) ? now - lastActivityOf(f) : null;
}

/**
 * A failed attempt that counts toward the model's three strikes on an
 * episode. One predicate, and it reads the termination reason and nothing
 * else: `manual` (an operator-pause or a cut) and `stale` (an offline gap) are
 * the harness's doing and are deliberately not here. Only a run the fleet
 * launched spends a policy attempt.
 */
export function isFailedAttempt(f: RunFact): boolean {
  return f.terminationReason === "attempt-failed" && f.runId.startsWith("fleet-");
}

export function isCounted(f: RunFact): boolean {
  if (f.pause !== null) return false;
  if (f.extra || f.episodeOverride || f.modelResponses === null || f.modelResponses <= 0) return false;
  if (f.terminationReason !== null && NOT_THE_MODELS_FAULT.has(f.terminationReason)) return false;
  return true;
}

/** A finished attempt the ladder reads as "no progress". */
export function isNoProgress(f: RunFact): boolean {
  if (f.live || f.pause !== null) return false;
  if (stillbornOf(f) === true) return true;
  return f.terminationReason !== null && NO_PROGRESS_REASONS.has(f.terminationReason);
}

function matchesRoster(f: RunFact, r: Pick<RosterModel, "model" | "effort">): boolean {
  return f.model === r.model && (f.effort ?? null) === (r.effort ?? null);
}

/**
 * The subscription lane each roster entry's live-or-paused run is on, read off
 * the runs themselves.
 *
 * This is what makes lane assignment survive a supervisor restart: the fleet's
 * own record of which token a job was spawned with dies with the process, but
 * the run wrote its lane into its meta.json, and a paused run resumed later
 * goes back to the subscription it started on. A run with no lane recorded (one
 * launched before lanes existed) is the default lane, and the caller reads it
 * as one.
 */
export function liveSubscriptions(
  runs: readonly RunFact[],
  roster: readonly Pick<RosterModel, "name" | "model" | "effort">[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of roster) {
    const f = runs.find((x) => (x.live || x.pause !== null) && x.subscription !== null && matchesRoster(x, r));
    if (f?.subscription != null) out.set(r.name, f.subscription);
  }
  return out;
}

/**
 * How many counted runs of an episode a tier buys. One input beyond the
 * episode — the tier — and no override anywhere: this is the whole answer to
 * "how many runs does this model get". An unscored episode is never evidence,
 * so it is always zero: `freeplay` is reached only as an idle session and
 * `probing` only through a campaign.
 */
function targetFor(tier: Tier, ep: EpisodeId): number {
  // Derived from the episode table, never from a list of names. A name check
  // here is a landmine: when a new id lands, TypeScript forces *a* decision and
  // the cheapest one that compiles is to widen `runsPerEpisode`, which silently
  // wires an unscored episode into series-gated evidence and promotion. An
  // episode that cannot be scored cannot be evidence, so it has no target, and
  // `models.test.ts` asserts that for every id in the table.
  if (!isScoredEpisode(ep)) return 0;
  return TIER_TABLE[tier].runsPerEpisode[ep];
}

/** The billing verdict for a roster entry, as the projection stamps it. */
export function rosterBilling(r: RosterModel): Billing {
  return billingOf({ model: r.model, apiBase: r.apiBase, driver: r.driver, billing: r.billing });
}

/** Whether a run belongs to the policy's series (a policy with no series takes every run). */
export function inSeries(f: RunFact, policy: SchedulingPolicy): boolean {
  return policy.series === null || f.harnessSeries === policy.series;
}

/**
 * Project one roster entry's runs to its state. `clearedAt` is the operator's
 * clear: attempts that ended at or before it are ignored by the ladder (they
 * still count toward targets — a clear forgives the ladder, not the history).
 */
export function projectModel(
  r: RosterModel,
  runs: readonly RunFact[],
  policy: SchedulingPolicy,
  opts: { now: number; clearedAt?: number },
): ModelState {
  const billing = rosterBilling(r);
  const all = runs.filter((f) => matchesRoster(f, r));
  // Another series' runs are shown, never counted: not witnesses, not ladder.
  // The ladder is about the provider, but a run that old says nothing about
  // tonight's provider either. They DO number attempts: the attempt index is
  // what keeps run ids unique on disk, and a series bump must not make the
  // next run id collide with an older directory (2026-08-23, harness-0.4).
  const mine = all.filter((f) => inSeries(f, policy));
  const perEpisode: Partial<Record<EpisodeId, EpisodeStats>> = {};
  for (const ep of STATS_EPISODES) {
    const stats: EpisodeStats = {
      counted: 0,
      stillborn: 0,
      attempts: 0,
      extras: 0,
      otherSeries: all.filter((f) => f.episode === ep && !inSeries(f, policy)).length,
      failed: 0,
      tainted: false,
      // Filled below: a target depends on the effective tier, which depends on
      // whether the e90 walk found a rung-1 witness. Two passes, not a guess.
      target: 0,
      bestLevel: null,
      reachedL5: false,
      lastEnded: null,
      lastReason: null,
    };
    for (const f of all) if (f.episode === ep) stats.attempts++;
    for (const f of mine) {
      if (f.episode !== ep) continue;
      if (f.extra) stats.extras++;
      if (stillbornOf(f) === true) stats.stillborn++;
      // A clear forgives the ladder and the strikes alike: `--clear-model` is
      // the operator saying the endpoint is worth trying again.
      if (isFailedAttempt(f) && (opts.clearedAt === undefined || (f.endedAt ?? 0) > opts.clearedAt)) stats.failed++;
      if (isCounted(f)) {
        stats.counted++;
        if (f.bestLevel !== null && f.bestLevel >= policy.promoteAtLevel) stats.reachedL5 = true;
      }
      if (f.bestLevel !== null && (stats.bestLevel === null || f.bestLevel > stats.bestLevel)) stats.bestLevel = f.bestLevel;
      if (f.endedAt !== null && (stats.lastEnded === null || f.endedAt >= stats.lastEnded)) {
        stats.lastEnded = f.endedAt;
        stats.lastReason = stillbornOf(f) === true ? "stillborn" : f.terminationReason;
      }
    }
    perEpisode[ep] = stats;
  }

  // The tier the model is actually scheduled under: what the config admitted it
  // to, advanced once if it earned rung 1 and its tier promotes. `t0` holds the
  // ladder, so a trial model keeps its witness and gains nothing from it until
  // an operator moves it up — which is what makes that move cost no re-runs.
  for (const ep of STATS_EPISODES) perEpisode[ep]!.tainted = perEpisode[ep]!.failed >= TAINT_AFTER;

  const earnedRung1 = perEpisode.e90!.reachedL5;
  const tier = effectiveTier(r.tier, earnedRung1);
  for (const ep of STATS_EPISODES) perEpisode[ep]!.target = targetFor(tier, ep);

  // Eligibility falls out of the budget: an episode the tier buys no runs of is
  // not one this model may be scheduled on. One statement, so a target of zero
  // and "not eligible" can no longer disagree the way `promoted, 0/0` did.
  const eligible: EpisodeId[] = POLICY_EPISODES.filter((ep) => targetFor(tier, ep) > 0);
  if (!eligible.includes("e90")) eligible.unshift("e90");

  // The ladder: trailing consecutive no-progress attempts, newest last, after the clear.
  let ladder = 0;
  let lastFail: RunFact | undefined;
  // A paused run is neither rung nor reset: it is skipped on the walk.
  const finished = mine.filter((f) => !f.live && f.pause === null && f.endedAt !== null && (opts.clearedAt === undefined || f.endedAt > opts.clearedAt));
  for (let i = finished.length - 1; i >= 0; i--) {
    const f = finished[i]!;
    if (!isNoProgress(f)) break;
    ladder++;
    if (lastFail === undefined) lastFail = f;
  }

  const state: ModelState = {
    name: r.name,
    model: r.model,
    effort: r.effort ?? null,
    platform: platformOf(r.apiBase, r.driver),
    harness: harnessOf(driverOf(r)),
    status: "active",
    billing,
    declaredTier: r.tier,
    tier,
    earnedRung1,
    idle: r.idle ?? "none",
    eligible,
    perEpisode,
    ladder,
  };
  // The newest paused run that is not stale holds the model.
  const pausedRun = [...mine].reverse().find((f) => f.pause !== null && !isStaleRun(f, opts.now));
  if (pausedRun !== undefined && pausedRun.pause !== null) {
    state.paused = {
      runId: pausedRun.runId,
      episode: pausedRun.episode,
      reason: pausedRun.pause.reason,
      at: pausedRun.pause.at,
      episodeElapsedMs: pausedRun.pause.episodeElapsedMs,
      episodeMs: pausedRun.episodeMs,
    };
  }
  if (lastFail !== undefined && ladder > 0) {
    const reason = stillbornOf(lastFail) === true ? "stillborn" : (lastFail.terminationReason ?? "no progress");
    if (ladder > LADDER_MS.length) {
      state.retired = {
        at: lastFail.endedAt!,
        reason: `${ladder} consecutive no-progress attempts; last ${lastFail.runId} (${reason}) after the ${Math.round(LADDER_MS[LADDER_MS.length - 1]! / 3_600_000)}h ceiling`,
      };
      state.status = "retired";
      return state;
    }
    const rung = ladder;
    const until = lastFail.endedAt! + LADDER_MS[rung - 1]!;
    if (until > opts.now) {
      state.cooling = { until, rung, reason: `${lastFail.runId}: ${reason}` };
      state.status = "cooling";
      return state;
    }
  }
  const anyCounted = eligible.some((ep) => (perEpisode[ep]?.counted ?? 0) > 0);
  // "promoted" is the earned word, so it is said only when the ladder actually
  // moved this model — never for one hand-placed on t2, and never for a t0
  // model holding a rung-1 witness it has not been allowed to spend.
  const climbed = tier !== r.tier;
  state.status = !anyCounted ? "new" : climbed ? "promoted" : "active";
  return state;
}

export interface ModelStatesInput {
  runsDir: string;
  roster: readonly RosterModel[];
  policy?: SchedulingPolicy;
  /** The operator sidecar; omitted reads `<runsDir>/fleet-models.json`. */
  sidecar?: ModelsSidecar;
  now?: number;
  /** Pre-read facts, for callers that already have them (tests, the viewer). */
  runs?: readonly RunFact[];
}

export const MODELS_SIDECAR = "fleet-models.json";

export function readModelsSidecar(runsDir: string): ModelsSidecar {
  const p = join(runsDir, MODELS_SIDECAR);
  if (!existsSync(p)) return { version: 1, cleared: {} };
  try {
    return parseModelsSidecar(readFileSync(p, "utf8"));
  } catch {
    return { version: 1, cleared: {} };
  }
}

/** The projection, in roster order. */
export function modelStates(input: ModelStatesInput): ModelState[] {
  const now = input.now ?? Date.now();
  const policy = input.policy ?? DEFAULT_POLICY;
  // The scheduler's own read includes the archive (see `readRunFacts`): the
  // ladder and the attempt numbers are made of runs no listing shows. A caller
  // that has already read the facts — the viewer — decides for itself.
  const runs = input.runs ?? readRunFacts(input.runsDir, now, { includeArchived: true });
  const sidecar = input.sidecar ?? readModelsSidecar(input.runsDir);
  return input.roster.map((r) => projectModel(r, runs, policy, { now, clearedAt: sidecar.cleared[r.name] }));
}

// -------------------------------------------------------------- scheduling

/**
 * What the scheduler may do with a model right now, as one answer instead of
 * two booleans.
 *
 * It was `{ ok, extras }`, and both call sites were written as an if-else over
 * exactly two outcomes — fine while there are two lanes, wrong the moment there
 * are three. The states are about the model's AVAILABILITY, not about which
 * lane wants it:
 *
 * - `eval` — owes counted runs on a scored episode. The highest-priority work,
 *   and the only state the viewer's `ok` field has ever meant.
 * - `free` — nothing blocking it, and nothing owed. Probe campaigns and idle
 *   work both draw from here, in that order.
 * - `blocked` — retired, cooling, already running, or holding a paused run. No
 *   lane may have it.
 *
 * Lane priority lives at the pick, not here: a model is never "a probe model",
 * it is a model that happens to owe nothing.
 */
export type Verdict = { verdict: "eval" | "free" | "blocked"; why: string };

/**
 * Why a model is or is not schedulable right now — the `--status` line.
 * The policy argument is vestigial: nothing about how much a model runs is
 * read from the file any more.
 */
export function schedulability(
  s: ModelState,
  running: ReadonlySet<string> = new Set(),
  _policy: Pick<SchedulingPolicy, "paid"> = DEFAULT_POLICY,
): Verdict {
  const blocked = (why: string): Verdict => ({ verdict: "blocked", why });
  if (s.retired !== undefined) return blocked(`retired: ${s.retired.reason} — clear with --clear-model ${s.name}`);
  if (s.cooling !== undefined) {
    return blocked(`cooling rung ${s.cooling.rung}/${LADDER_MS.length} until ${new Date(s.cooling.until).toISOString()} (${s.cooling.reason})`);
  }
  if (running.has(s.name)) return blocked("running (one stream per model)");
  if (s.paused !== undefined) {
    const spent = s.paused.episodeElapsedMs !== null ? `${Math.round(s.paused.episodeElapsedMs / 60_000)}m` : "?m";
    const of = s.paused.episodeMs !== null ? ` of ${Math.round(s.paused.episodeMs / 60_000)}m` : "";
    // A scored run that paused is not coming back: it holds the model only
    // until the next tick ends it as a failed attempt, and the fresh attempt
    // is scheduled the tick after. Unscored lanes still resume.
    const fate = resumesOnPause(s.paused.episode)
      ? "resumed by the supervisor, never rescheduled"
      : "ended as a failed attempt on the next tick, then reattempted fresh";
    return blocked(`paused run ${s.paused.runId} (${s.paused.reason}, ${spent}${of} elapsed) — ${fate}`);
  }
  // Three failed attempts on an episode stop the spending. The
  // model is blocked rather than "free": idle work is not the reward for
  // burning three evals, and the taint is a stop signal, not a target met.
  const tainted = s.eligible.filter((ep) => s.perEpisode[ep]?.tainted === true);
  const open = s.eligible.filter((ep) => {
    const st = s.perEpisode[ep];
    return st !== undefined && !st.tainted && st.counted < st.target;
  });
  if (open.length === 0 && tainted.length > 0) {
    return blocked(
      `tainted on ${tainted.map((ep) => `${ep} (${s.perEpisode[ep]!.failed} failed attempts)`).join(", ")} — ` +
        `clear with --clear-model ${s.name} once the endpoint is back`,
    );
  }
  if (open.length === 0) {
    // Idle work is the model's own axis now, not a consequence of its billing
    // or its account class: what it does with a spare account is what its entry
    // says it does. A paid model defaults to `none` and so buys nothing extra.
    const extras = s.idle !== "none";
    const how = s.idle === "unlimited" ? " — unlimited sessions while its account is idle" : " — extra characters when its class is idle";
    return { verdict: "free", why: `targets met on ${s.eligible.join(", ")}${extras ? how : ""}` };
  }
  return { verdict: "eval", why: `schedulable on ${open.join(", ")}` };
}

/**
 * Whether this model's idle axis wants a spare account. Asked of a verdict
 * rather than folded into it: "does it owe anything" and "does it want extra
 * work" are two questions, and only the second is a property of the entry.
 */
export function wantsIdle(v: Verdict, s: ModelState): boolean {
  return v.verdict === "free" && s.idle !== "none";
}

/**
 * The wire shape the viewer has always served, as a projection of the verdict.
 *
 * Not the verdict itself: a dashboard bundle and the API it talks to are two
 * artefacts that can restart out of order, so the names on the wire are not
 * free to change alongside an internal refactor. `ok` has always meant "owes a
 * counted run", which is exactly `verdict === "eval"`.
 */
export function schedulableView(v: Verdict, s: ModelState): { ok: boolean; why: string; extras: boolean } {
  return { ok: v.verdict === "eval", why: v.why, extras: wantsIdle(v, s) };
}

/** Extras made so far across every episode, which is what the character cycle indexes. */
export function extrasSoFar(s: ModelState): number {
  return STATS_EPISODES.reduce((n, ep) => n + (s.perEpisode[ep]?.extras ?? 0), 0);
}

/** Priority order of an episode: the scored tiers as they are declared, freeplay last. */
function episodeOrder(ep: EpisodeId): number {
  return EPISODE_IDS.indexOf(ep);
}

/**
 * The account class a pick belongs to (docs/OPERATIONS.md, "Account
 * classes"): which of `accounts.pool` / `accounts.paid` / `accounts.local`
 * it may land on. `pool` is the base class — every account that is not
 * split out belongs to it.
 */
export type AccountClass = "pool" | "paid" | "local";

/** Every class, pool first: the order `--status` and `--dry-run` print them in. */
export const ACCOUNT_CLASSES = ["pool", "paid", "local"] as const;

/**
 * Which class a model's picks belong to. Local wins over billing: the LM Studio
 * box is free by `model-cost.ts` and still has exactly one runner, so its models
 * are kept off the shared pool for the same reason paid models are.
 */
export function accountClassOf(s: Pick<ModelState, "billing" | "platform">): AccountClass {
  if (s.platform === "local") return "local";
  return s.billing === "paid" ? "paid" : "pool";
}

/**
 * The same verdict from a roster entry, for callers that have the file rather
 * than the projection (`--status` renders its accounts table before the
 * projection is read). One classifier, two entry points.
 */
export function rosterClass(r: RosterModel): AccountClass {
  return accountClassOf({ billing: rosterBilling(r), platform: platformOf(r.apiBase, r.driver) });
}

/**
 * What a model does with an idle account: the entry's own `idle` axis, read
 * straight off the state.
 *
 * It used to be inferred — the local class asked `policy.extras.local`, every
 * other class was assumed to want characters — so the same model meant
 * different things depending on which account it landed on, and a non-local
 * model could not take unlimited sessions at all. One axis, stated per model,
 * replaces both spellings.
 */
export function idleModeOf(s: Pick<ModelState, "idle">): IdleMode {
  return s.idle;
}

export interface NextJobsOptions {
  /** Paid models already in flight (pinned jobs excluded), for the paid cap. */
  paidRunning?: number;
  policy?: Pick<SchedulingPolicy, "paid">;
  /**
   * The accounts each SPLIT-OUT class may use (`accounts.paid`,
   * `accounts.local`; the account classes). A class missing from this
   * map is not split: its picks share `freeAccounts`, which is what every
   * caller did before the split. A class present takes its accounts from here
   * and never from `freeAccounts`; an empty array is therefore "this class has
   * nowhere free to run", and every pick of it is held saying so — `classBusy`
   * says which of the two reasons.
   */
  classAccounts?: Partial<Record<AccountClass, readonly string[]>>;
  /**
   * Accounts of a split-out class that EXIST but are occupied right now, with
   * the run or job holding each where the caller knows it. `classAccounts`
   * carries only what is free, so without this an all-busy class is
   * indistinguishable from an unconfigured one — and the fleet told operators
   * to add an account they already had (FOLLOW-UPS: the SHAKEOUT2 report).
   */
  classBusy?: Partial<Record<AccountClass, readonly BusyAccount[]>>;
  /**
   * Why the POOL has no accounts this tick when something outside the policy
   * has reserved them — today, a manual queue job waiting for one. A pool pick
   * with nowhere to go is otherwise dropped in silence (a split class has
   * `noRoom` to say it, the pool never had an equivalent), which is how a
   * reserved pool read as "the models are just not schedulable today".
   */
  poolHeld?: string;
  /**
   * The enabled, UNPINNED campaigns the policy may schedule, in
   * declaration order. A pinned campaign is a pinned job and never appears
   * here. Absent means no campaign work, which is what an older config gets.
   */
  campaigns?: readonly Campaign[];
  /** Counted probe runs on disk: what a campaign's remaining work is derived from. */
  probeRuns?: readonly ProbeRun[];
}

/**
 * The policy's picks for the free pool accounts, in priority order:
 * (1) models with zero counted runs on any eligible episode, (2) the shorter
 * episode first, (3) fewest counted runs toward target, ties by roster order.
 * One job per model. `running` holds roster names with a stream in flight.
 *
 * Two additions under the paid/free split. A paid pick is held when
 * `policy.paid.maxConcurrent` paid models are already in flight, and the
 * next candidate takes its account; `held` says so. A pick of a SPLIT-OUT
 * class (paid, local) draws from `opts.classAccounts[class]` — never from
 * `freeAccounts` — so a paid model can only ever land on a paid account and a
 * local one only on the local box's account.
 * When every account still
 * free has nothing schedulable left, free models with an extras policy get an
 * **extra** run: fewest extras first, the shorter tier first (`e360` only for
 * a promoted model), roster order — and the pick carries the next character
 * in the cycle.
 */
export function planNextJobs(
  states: readonly ModelState[],
  freeAccounts: readonly string[],
  running: ReadonlySet<string> = new Set(),
  opts: NextJobsOptions = {},
): { jobs: NextJob[]; held: HeldPick[] } {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const campaigns = opts.campaigns ?? [];
  const probeRuns = opts.probeRuns ?? [];
  interface Cand {
    s: ModelState;
    ep: EpisodeId;
    epOrder: number;
    fresh: number;
    counted: number;
    order: number;
  }
  const cands: Cand[] = [];
  const extraCands: Cand[] = [];
  /** Every model's verdict, computed once: the probe loop below asks it again. */
  const verdicts = new Map<string, Verdict>();
  const byName = new Map(states.map((s) => [s.name, s]));
  states.forEach((s, order) => {
    const v = schedulability(s, running, policy);
    verdicts.set(s.name, v);
    if (wantsIdle(v, s)) {
      // One candidate, not one per tier: `unlimited` is the only idle mode left
      // (the race/class cycle moved to a probe campaign, where an unscored
      // question belongs), an unlimited session has no tier, and there is
      // only ever one of them in flight.
      extraCands.push({ s, ep: "freeplay", epOrder: episodeOrder("freeplay"), fresh: 1, counted: extrasSoFar(s), order });
      return;
    }
    if (v.verdict !== "eval") return;
    const fresh = s.eligible.every((ep) => (s.perEpisode[ep]?.counted ?? 0) === 0) ? 0 : 1;
    for (const ep of s.eligible) {
      const st = s.perEpisode[ep];
      if (st === undefined || st.counted >= st.target) continue;
      cands.push({ s, ep, epOrder: episodeOrder(ep), fresh, counted: st.counted, order });
    }
  });
  const byPriority = (a: Cand, b: Cand): number => a.fresh - b.fresh || a.epOrder - b.epOrder || a.counted - b.counted || a.order - b.order;
  cands.sort(byPriority);
  extraCands.sort(byPriority);

  const jobs: NextJob[] = [];
  const held: HeldPick[] = [];
  const taken = new Set<string>();
  const accounts = [...freeAccounts];
  // The split-out classes' accounts, each drawn down separately. A class absent
  // here is not split and shares `accounts` — the pre-split behaviour.
  const split: Partial<Record<AccountClass, string[]>> = {};
  for (const cls of ACCOUNT_CLASSES) {
    const declared = opts.classAccounts?.[cls];
    if (cls !== "pool" && declared !== undefined) split[cls] = [...declared];
  }
  const listOf = (cls: AccountClass): string[] => split[cls] ?? accounts;
  const empty = (): boolean => accounts.length === 0 && Object.values(split).every((l) => l.length === 0);
  // Who took which account of a split class in THIS call: a second local model
  // is held because the box is busy, not because the box is missing.
  const tookHere = new Map<AccountClass, BusyAccount[]>();
  /**
   * Why a split class has nothing free. Two different operator actions, so
   * never one message: an empty class needs an account added to the file, a
   * busy one needs a run to finish (or the cap raised).
   */
  const noRoom = (cls: AccountClass): string => {
    const busy = [...(opts.classBusy?.[cls] ?? []), ...(tookHere.get(cls) ?? [])];
    if (busy.length === 0) return `no ${cls} account configured — add one to accounts.${cls}`;
    return `${cls} account(s) busy: ${busy.map((b) => (b.by !== undefined ? `${b.account} held by ${b.by}` : b.account)).join(", ")}`;
  };
  let paid = opts.paidRunning ?? 0;
  const cap = policy.paid?.maxConcurrent;
  for (const c of cands) {
    if (taken.has(c.s.name)) continue;
    const cls = accountClassOf(c.s);
    const isPaid = c.s.billing === "paid";
    const from = listOf(cls);
    if (split[cls] !== undefined && from.length === 0) {
      // The actionable reason wins over the cap: there is no account to run on.
      taken.add(c.s.name);
      held.push({ name: c.s.name, episode: c.ep, why: noRoom(cls) });
      continue;
    }
    if (isPaid && cap !== undefined && paid >= cap) {
      taken.add(c.s.name);
      held.push({ name: c.s.name, episode: c.ep, why: `paid cap: ${paid}/${cap} paid model(s) already in flight` });
      continue;
    }
    if (from.length === 0) {
      taken.add(c.s.name);
      // The pool's counterpart to `noRoom`: only said when the caller knows
      // why the pool is empty. An ordinarily busy pool stays silent, as before.
      if (split[cls] === undefined && opts.poolHeld !== undefined) held.push({ name: c.s.name, episode: c.ep, why: opts.poolHeld });
      continue;
    }
    taken.add(c.s.name);
    if (isPaid) paid++;
    const st = c.s.perEpisode[c.ep]!;
    const account = from.shift()!;
    if (split[cls] !== undefined) tookHere.set(cls, [...(tookHere.get(cls) ?? []), { account, by: c.s.name }]);
    jobs.push({
      name: c.s.name,
      episode: c.ep,
      account,
      attempt: st.attempts + 1,
      why: `${c.fresh === 0 ? "no counted runs yet" : `${st.counted}/${st.target} on ${c.ep}`}${c.s.status === "promoted" ? ", promoted" : ""}`,
    });
  }
  // Probe campaigns: commissioned work, above idle work and below
  // evidence. Only a model that owes nothing is eligible — a probe never delays
  // a counted run — and the sweep order is the fan-out's, which spreads across
  // models before finishing any one of them.
  //
  // A campaign PINNED to an account is not here: it is a pinned job, built by
  // the supervisor from the same machinery a manual pinned job uses, because
  // that account is by definition not one the policy may draw from. This loop
  // is the pool case.
  for (const w of campaignWork(campaigns, [...byName.keys()], probeRuns, (n) => verdicts.get(n)?.verdict !== "blocked")) {
    if (empty()) break;
    if (taken.has(w.model)) continue;
    const s = byName.get(w.model);
    if (s === undefined) continue;
    // The loop's own precondition, and deliberately redundant with `taken`
    // above: a model that owed evidence was already taken by the eval loop, so
    // this line only bites when a campaign set `excludeUnhealthy: false` and the
    // fan-out therefore handed us a blocked model. Stating it here anyway is
    // what makes the loop correct on its own terms rather than correct because
    // of the order the loops happen to run in.
    if (verdicts.get(w.model)?.verdict !== "free") continue;
    const pcls = accountClassOf(s);
    const from = listOf(pcls);
    if (from.length === 0) continue;
    taken.add(w.model);
    // Attempt numbers come from the probing bucket, which exists precisely so a
    // second probe in one day gets a real run id rather than colliding.
    const st = s.perEpisode["probing"];
    const account = from.shift()!;
    if (split[pcls] !== undefined) tookHere.set(pcls, [...(tookHere.get(pcls) ?? []), { account, by: w.model }]);
    jobs.push({
      name: w.model,
      episode: "probing",
      account,
      attempt: (st?.attempts ?? 0) + 1,
      why: `campaign ${w.campaign} cell ${w.cell.id} (${w.done}/${w.want})`,
      probe: { campaign: w.campaign, cell: w.cell.id },
    });
  }
  // Idle work: lowest priority, only for accounts nothing else wanted, and only
  // ever on the candidate's own class — so an unlimited session takes the
  // account its own class owns and never one a counted run could have used.
  for (const c of extraCands) {
    if (empty()) break;
    if (taken.has(c.s.name)) continue;
    const xcls = accountClassOf(c.s);
    const from = listOf(xcls);
    if (from.length === 0) continue;
    taken.add(c.s.name);
    const st = c.s.perEpisode[c.ep]!;
    const n = extrasSoFar(c.s);
    const account = from.shift()!;
    if (split[xcls] !== undefined) tookHere.set(xcls, [...(tookHere.get(xcls) ?? []), { account, by: c.s.name }]);
    jobs.push({
      name: c.s.name,
      episode: c.ep,
      account,
      attempt: st.attempts + 1,
      why: `extra #${n + 1}: unlimited session (targets met; one at a time, up to ${Math.round(UNLIMITED_SESSION_MS / 3_600_000)}h)`,
    });
  }
  return { jobs, held };
}

/** `planNextJobs` without the explanation — what the supervisor consumes. */
export function nextJobs(
  states: readonly ModelState[],
  freeAccounts: readonly string[],
  running: ReadonlySet<string> = new Set(),
  opts: NextJobsOptions = {},
): NextJob[] {
  return planNextJobs(states, freeAccounts, running, opts).jobs;
}

// ------------------------------------------------------------- outstanding

/**
 * How many counted runs the policy still owes, and roughly how long they take.
 *
 * The fleet page's one forward-looking number: everything else on it says what
 * is happening now, this says how much of the schedule is left. Two bounds,
 * because the biggest unknown is promotion (a model enters e360 by reaching
 * `promoteAtLevel` on e90, which has not happened yet for most of the
 * roster):
 *
 * - **lower** assumes nobody else promotes: every schedulable model's unmet
 *   e90 target, plus the unmet e360 target of models *already* eligible for
 *   e360 (promoted, or force-tiered in the roster — `eligible` is the
 *   predicate, because a force-tiered model's e360 runs are owed right now).
 * - **upper** assumes every model still eligible for promotion gets there, so
 *   it adds the full e360 target of the models the lower bound left out.
 *
 * Extras never appear: they are what the pool does when the schedule is empty,
 * not work the policy owes. Neither do models outside the policy —
 * a name a pinned job holds or one carrying an objective, the same exclusion
 * `/api/models` makes — nor retired ones. A cooling or paused model still owes
 * its runs; it is late, not excused.
 *
 * ## The ETA
 *
 * Remaining minutes come from the episode table (`episodes.ts` is the only
 * place that spells out 90 and 360) and are divided by how many runs of that
 * kind can be in flight at once:
 *
 *     eta = Σ over groups  (group's remaining minutes / group's concurrency)
 *
 * The groups are the account classes — pool, paid, local — because
 * a model can only ever land on its own class's accounts, with `policy.paid.
 * maxConcurrent` capping the paid class below its account count. Claude-code
 * models are carved out of the pool as their own group, since
 * `policy.maxConcurrent["claude-code"]` binds them tighter than the pool's
 * account count does.
 *
 * Two simplifications worth stating rather than hiding. The classes actually
 * drain in *parallel*, so the true exhaustion time is the largest term and
 * this sum is a pessimistic bound. And the claude-code group shares the pool's
 * accounts with the rest of the pool group, so their concurrencies overlap.
 * Both are deliberate: the number is a planning aid ("is tonight enough?"),
 * and a queueing model would be a worse answer to that question than one an
 * operator can check in their head. A group with work and no account to run it
 * on has no ETA at all, and the whole figure goes null rather than pretend.
 */
export interface OutstandingGroup {
  /** An account class, or `claude-code` for the driver-capped carve-out. */
  group: string;
  /** Runs of this group that can be in flight at once; 0 means nowhere to run. */
  concurrency: number;
  lowerRuns: number;
  upperRuns: number;
  lowerMinutes: number;
  upperMinutes: number;
}

export interface Outstanding {
  /** Counted runs still owed assuming no further promotions. */
  lower: number;
  /** The same assuming every still-eligible model promotes. */
  upper: number;
  /** Wall clock to exhaust `lower`, or null when some of it has no account. */
  etaLowerMs: number | null;
  etaUpperMs: number | null;
  breakdown: OutstandingGroup[];
}

/** Accounts per class, as `accounts.pool` / `.paid` / `.local` name them. */
export type ClassAccountCounts = Partial<Record<AccountClass, number>>;

export interface OutstandingInput {
  /** The projection — `modelStates` output. */
  states: readonly ModelState[];
  /** The policy in force; only `paid.maxConcurrent` is read. */
  policy?: Pick<SchedulingPolicy, "paid">;
  /** Roster names outside the policy (pinned, or carrying an objective). */
  excluded?: Iterable<string>;
  /** How many accounts each class has. */
  accounts?: ClassAccountCounts;
  /** `policy.maxConcurrent`: per-driver stream caps; `claude-code` is the one read. */
  maxConcurrent?: Record<string, number>;
}

/** The group a model's runs queue in: its account class, claude-code apart. */
function outstandingGroupOf(s: ModelState): string {
  return s.harness === "claude-code" ? "claude-code" : accountClassOf(s);
}

/** The whole metric, pure over the same inputs the projection was built from. */
export function outstandingWork(input: OutstandingInput): Outstanding {
  const excluded = new Set(input.excluded ?? []);
  const accounts = input.accounts ?? {};
  const paidCap = input.policy?.paid?.maxConcurrent;
  const ccCap = input.maxConcurrent?.["claude-code"];
  const concurrencyOf = (group: string): number => {
    if (group === "claude-code") {
      const pool = accounts.pool ?? 0;
      return ccCap === undefined ? pool : Math.min(pool, ccCap);
    }
    const n = accounts[group as AccountClass] ?? 0;
    return group === "paid" && paidCap !== undefined ? Math.min(n, paidCap) : n;
  };

  const groups = new Map<string, OutstandingGroup>();
  const groupFor = (name: string): OutstandingGroup => {
    let g = groups.get(name);
    if (g === undefined) {
      g = { group: name, concurrency: concurrencyOf(name), lowerRuns: 0, upperRuns: 0, lowerMinutes: 0, upperMinutes: 0 };
      groups.set(name, g);
    }
    return g;
  };

  for (const s of input.states) {
    if (excluded.has(s.name) || s.retired !== undefined) continue;
    const g = groupFor(outstandingGroupOf(s));
    // The upper bound's bet is that the model climbs: what its tier would buy
    // if it earned rung 1. For a `t0` model the bet is off — the ladder is
    // held — so its upper and lower agree, which is the honest reading of a
    // trial: one run, and no more without an operator deciding.
    const climbed = TIER_TABLE[effectiveTier(s.declaredTier, true)].runsPerEpisode;
    for (const ep of POLICY_EPISODES) {
      const st = s.perEpisode[ep];
      if (st === undefined) continue;
      const owed = Math.max(0, climbed[ep as "e90" | "e360"] - st.counted);
      if (owed === 0) continue;
      // e360 is owed now only if the model may already be scheduled on it;
      // otherwise it is the upper bound's bet that the model promotes.
      const now = ep === "e360" && !s.eligible.includes("e360") ? 0 : Math.max(0, st.target - st.counted);
      const minutes = EPISODES[ep].minutes ?? 0;
      g.lowerRuns += now;
      g.lowerMinutes += now * minutes;
      g.upperRuns += owed;
      g.upperMinutes += owed * minutes;
    }
  }

  const breakdown = [...groups.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  const eta = (pick: (g: OutstandingGroup) => number): number | null => {
    let ms = 0;
    for (const g of breakdown) {
      const minutes = pick(g);
      if (minutes === 0) continue;
      if (g.concurrency === 0) return null;
      ms += (minutes / g.concurrency) * 60_000;
    }
    return ms;
  };
  return {
    lower: breakdown.reduce((n, g) => n + g.lowerRuns, 0),
    upper: breakdown.reduce((n, g) => n + g.upperRuns, 0),
    etaLowerMs: eta((g) => g.lowerMinutes),
    etaUpperMs: eta((g) => g.upperMinutes),
    breakdown,
  };
}

/**
 * The one-line rendering `--status` prints and the fleet page echoes:
 * `outstanding: 11–23 scheduled runs, ≈ 4h–9h to exhaust`. Bounds that agree
 * collapse to one number; nothing owed at all is `exhausted`.
 */
export function formatOutstanding(o: Outstanding): string {
  if (o.upper === 0) return "outstanding: exhausted — the policy owes no scheduled runs";
  const runs = o.lower === o.upper ? `${o.lower}` : `${o.lower}–${o.upper}`;
  const lo = formatEtaHours(o.etaLowerMs);
  const hi = formatEtaHours(o.etaUpperMs);
  const eta =
    lo === null || hi === null
      ? "eta unknown — some of it has no account to run on"
      : lo === hi
        ? `≈ ${lo} to exhaust`
        : `≈ ${lo}–${hi} to exhaust`;
  return `outstanding: ${runs} scheduled runs, ${eta}`;
}

/** Hours from now, coarse on purpose: this is a planning figure, not a clock. */
export function formatEtaHours(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms === 0) return "0h";
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
