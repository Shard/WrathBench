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
 * running". The policy lives in docs/RUNBOOK.md; the tiers in
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
 *   does not start a second run for a model whose run is waiting to be
 *   resumed. It is counted, or climbs the ladder, only when it finally ends.
 * - **Billing buys no runs** (`model-cost.ts`): it decides where a run may
 *   execute, never how many a model gets; the tier does that.
 * - **The one extra is a freeplay session** (`idle: "unlimited"` on the
 *   entry): past its targets, a model so marked gets one unbounded freeplay
 *   run at a time, restarted when it ends, at lowest priority. A held
 *   (`campaignOnly`) entry has no targets, so it is past them at once: so
 *   marked, it plays freeplay and nothing scored (operator, 2026-11-15). An extra is an
 *   attempt, stamped `extra: true` and reported apart, never counted toward a
 *   target. The scored-tier extras that rolled a race and class are probe
 *   campaigns now.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DRIVER, driverEntry, eitherHas, entryOf, harnessDriver, isNotAModelRun, isProbeOnlyDriver, probeOnlyRefusal } from "./drivers";
import { DEFAULT_CLAUDE_TOKEN_ENV, DRIVERS, defaultLoopOf, harnessOf, isDriver, isTokenEnvName, isUnscoredDriverName, type Driver, type Harness } from "./config";
import { EPISODE_IDS, EPISODES, isLevelEpisode, isScoredEpisode, isTaskEpisode, type EpisodeId, type ScoredEpisodeId } from "./episodes";
import { campaignWork, partyAttempt, type Campaign, type ProbeIdentity, type ProbeRun } from "./campaigns";
import { badEvidenceReason, countedRun, neverStale, SUBSCRIPTION_PAUSE, resumesOnPause, staleAfterMs } from "./lapse";
import { billingOf, type Billing } from "./model-cost";
import { credentialCarries, providerById, providerOfModel, type Credential } from "./credential-slots";
import { hostOfBase, isOpenCodeGoBase, platformOfBase } from "./platform";
import { parseRouting, type RoutingSpec } from "./routing";
import { canonicalModelId } from "../../infra/model-catalogue";
import { entryModelIds, type ProviderOption } from "./provider-options";
import { HEARTBEAT_DEAD_MS, heartbeatAt, heartbeatOwner } from "./heartbeat";
import { RunFactCache } from "./run-fact-cache";
import type { ServingSpec } from "./serving";
import { goneReason, modelGoneOf, readModelListsSidecar, type ModelGone, type ModelListsSidecar } from "./model-lists";
import { readRunFact, readRunFacts, runFactCacheVersion, stillbornOf, type RunFact } from "./run-fact";
import { entryOwnsWindow, IDLE_MODES, ownedWindows, TIERS, type IdleMode, type RosterIdentity, type RosterModel, type Tier } from "./roster-entry";

/*
 * One run's fact — `readRunFact`, the record-count scanner, the trajectory's
 * verdict and the walk over a runs tree — lives in `run-fact.ts`, which a
 * reader loads without the scheduler; re-exported here unchanged.
 */
export {
  accountsOfRun,
  cacheableFact,
  countModelResponses,
  countRecords,
  countRecordsCached,
  LADDER_EXEMPT_PAUSES,
  LIVE_WINDOW_MS,
  MODEL_RESPONSE_RECORD,
  onPauseLadder,
  PAUSE_RECORD,
  pauseCountsOnLadder,
  readFleetRuns,
  readRunFact,
  readRunFacts,
  RecordCountScanner,
  RESUME_RECORD,
  RUN_FACT_SETTLE_MS,
  runFactCacheVersion,
  runFactKey,
  stillbornOf,
  tallyRecords,
  tallyRecordsCached,
  TERMINATION_TAIL_BYTES,
  terminationOfTrajectory,
  utcDay,
  verdictOfTrajectory,
  type CountCache,
  type CountEntry,
  type ReadAt,
  type RecordTally,
  type RunFact,
  type RunReading,
  type ScanReads,
  type TrajectoryVerdict,
  type UnstampedRun,
} from "./run-fact";

// ----------------------------------------------------------------- policy

/**
 * The episode tiers the policy has targets on. `freeplay` has none — it is
 * never scheduled as evidence — but an `idle: "unlimited"` model's extras are
 * freeplay runs, so the projection still keeps stats for it.
 */
export const POLICY_EPISODES: readonly ScoredEpisodeId[] = ["e90", "e360", "deadmines-solo", "deadmines"];

/**
 * Every episode the projection keeps stats for, in presentation order. Wider
 * than `POLICY_EPISODES` by `freeplay`, which carries a target of zero and
 * exists here so that freeplay attempts are numbered (a run id is
 * `…-<datestamp>-a<attempt>`, so two freeplay extras in one day need real
 * attempt numbers) and so a freeplay extra is reported like any other.
 */
export const STATS_EPISODES: readonly EpisodeId[] = EPISODE_IDS;

/**
 * The ladder a model climbs, named once here. A tier is a statement
 * of **how much evidence** a model gets, denominated in runs, and it is the
 * only thing that sets a run count: there is no per-entry override and no
 * per-billing table, so "how many runs does this model get" has exactly one
 * answer and it is the word in the config.
 *
 * The table lives in code, not in the fleet config, for the reason promotion is a
 * threshold rather than a judgement: a budget that every model is
 * held to alike is a recorded decision, and a bespoke volume is a NAMED tier
 * added here, reviewed like an episode id — never a number edited into one
 * model's entry at 03:00.
 *
 * Money is deliberately not modelled. A tier is denominated in runs; a spend
 * cap is a credential's `spend` budget (`runner/src/credential-slots.ts`), its own
 * thing beside the tier. Minting `t0a`/`t0b` to approximate dollars is the accretion this
 * table exists to stop.
 */
export { TIERS, type Tier } from "./roster-entry";

export interface TierSpec {
  /** The counted runs this tier buys, per scored episode. Zero: not eligible. */
  runsPerEpisode: Record<ScoredEpisodeId, number>;
  /**
   * The next rung of the ladder, or null at the top or where the ladder is
   * held. Held is not "level zero": a `t0` model is not unpromoted, it is not
   * admitted to the ladder, and its witness is still recorded so that moving
   * it to `t1` promotes it on evidence it already has.
   */
  promotesTo: Tier | null;
  /**
   * The witness that climbs this rung to `promotesTo`: `promotion`, a counted
   * `e90` at `promoteAtLevel`; `deadmines`, a counted `e360` at
   * `deadminesAtLevel`. Null where `promotesTo` is.
   */
  climbsOn: keyof Witnesses | null;
  /** What `--status` calls it. */
  label: string;
}

/** What a model has earned, read from its counted runs (`modelStates`). */
export interface Witnesses {
  /** A counted `e90` reached `promoteAtLevel`. */
  promotion: boolean;
  /** A counted `e360` reached `deadminesAtLevel`. */
  deadmines: boolean;
}

/*
 * Each promotion step is its own tier (operator, 2026-11-20): `t2` buys the
 * `e360`, `t3` the Deadmines evals on top — three attempts on each id
 * (operator, 2026-11-14), spent only once a counted `e360` has reached
 * `deadminesAtLevel` (operator, 2026-11-15), which is also what climbs `t2` to
 * `t3`, so even a declared `t3` waits on it. The five-agent id (`deadmines`)
 * is bought only where the roster entry opts in as well
 * (`RosterModel.deadmines`), because it needs five sessions on one credential
 * at once; `targetFor` applies both.
 */
export const TIER_TABLE: Record<Tier, TierSpec> = {
  t0: { runsPerEpisode: { e90: 1, e360: 0, deadmines: 0, "deadmines-solo": 0 }, promotesTo: null, climbsOn: null, label: "trial" },
  t1: { runsPerEpisode: { e90: 3, e360: 0, deadmines: 0, "deadmines-solo": 0 }, promotesTo: "t2", climbsOn: "promotion", label: "standard" },
  t2: { runsPerEpisode: { e90: 3, e360: 1, deadmines: 0, "deadmines-solo": 0 }, promotesTo: "t3", climbsOn: "deadmines", label: "long" },
  t3: { runsPerEpisode: { e90: 3, e360: 1, deadmines: 3, "deadmines-solo": 3 }, promotesTo: null, climbsOn: null, label: "Deadmines" },
};

/**
 * The one declared tier that climbs (operator, 2026-11-20). Any other declared
 * tier is where the operator put the model and it stays there: `t0` holds the
 * ladder, and a declared `t2` or `t3` is a pin, so a `t2` entry keeps its `e360`
 * and never reaches the Deadmines however far it gets.
 */
export const LADDER_ENTRY: Tier = "t1";

/**
 * What a rehearsal has cleared to score (`SchedulingPolicy.rehearsed`): the
 * five-agent Deadmines id, and codex rows on either Deadmines id. Each waits
 * on a program-loop rehearsal the operator reads, and is held until the
 * policy names it.
 */
export const REHEARSALS = ["deadmines", "codex"] as const;
export type Rehearsal = (typeof REHEARSALS)[number];

export function parseRehearsed(raw: unknown, where: string): Rehearsal[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((x): x is Rehearsal => typeof x === "string" && (REHEARSALS as readonly string[]).includes(x))) {
    throw new Error(`${where} must be a list of ${REHEARSALS.map((r) => JSON.stringify(r)).join(", ")} — what a rehearsal has cleared to score; absent clears nothing`);
  }
  if (new Set(raw).size !== raw.length) throw new Error(`${where} names an entry twice`);
  return [...raw];
}

/**
 * Why the policy holds a model's pick on a task episode until a rehearsal
 * clears it, or null: the five-agent id until `rehearsed` names
 * `deadmines`, and a codex row on either id until it names `codex`.
 */
export function rehearsalHold(ep: EpisodeId, harness: string, policy: Pick<SchedulingPolicy, "rehearsed">): string | null {
  if (!isTaskEpisode(ep)) return null;
  if (ep === "deadmines" && !policy.rehearsed.includes("deadmines")) {
    return "the five-agent Deadmines episode waits on a program-loop rehearsal (policy.rehearsed does not name \"deadmines\")";
  }
  if (harness === "codex" && !policy.rehearsed.includes("codex")) {
    return `a codex row on ${ep} waits on a rehearsal attempt (policy.rehearsed does not name "codex")`;
  }
  return null;
}

/**
 * The tier a model is actually scheduled under: a declared `t1` walked up the
 * ladder one rung per witness it holds (`climbsOn`), any other declared tier
 * as declared (`LADDER_ENTRY`). Derived every tick and never written back —
 * the config states where a model was ADMITTED, the run history states what
 * it EARNED, and the two are read together rather than one overwriting the
 * other. So an operator may hand-place a model by editing the tier, and that
 * never fabricates a promotion record.
 */
export function effectiveTier(declared: Tier, earned: Witnesses): Tier {
  if (declared !== LADDER_ENTRY) return declared;
  let tier = declared;
  for (;;) {
    const { promotesTo, climbsOn } = TIER_TABLE[tier];
    if (promotesTo === null || climbsOn === null || !earned[climbsOn]) return tier;
    tier = promotesTo;
  }
}

/**
 * Whether a model holds the witness that would move it up the ladder were its
 * declared tier not where an operator put it — the `*` beside its tier: a `t0`
 * with a counted level-`promoteAtLevel` e90, a declared `t2` with a counted
 * level-`deadminesAtLevel` e360. Never a `t1`, which climbs on its own, nor a
 * `t3`, the top.
 */
export function holdsWitness(s: { declaredTier: Tier; earnedPromotion: boolean; earnedDeadmines?: boolean }): boolean {
  if (s.declaredTier === "t0") return s.earnedPromotion;
  if (s.declaredTier === "t2") return s.earnedDeadmines === true;
  return false;
}

/**
 * Why a model may not be scheduled on an episode, in the words `--status`,
 * `--dry-run` and a gated job use: what opens it. A tier budget for `e90` and
 * `e360` (promotion buys the `e360`), and for the Deadmines evals the `e360`
 * witness on top of a tier that buys them (operator, 2026-11-15). Given the
 * entry's declared tier it says which: the thresholds that climb a `t1` there
 * (from `current`, the rung it stands on, when known), or that the declared
 * tier is a pin that never will.
 */
export function ineligibleWhy(
  ep: EpisodeId,
  policy: Pick<SchedulingPolicy, "promoteAtLevel" | "deadminesAtLevel"> = DEFAULT_POLICY,
  declared?: Tier,
  current?: Tier,
): string {
  const top = declared === undefined ? undefined : effectiveTier(declared, { promotion: true, deadmines: true });
  const pinned = (what: string): string =>
    declared === "t0" ? `declared t0: a trial tier holds the ladder and buys no ${what}` : `declared ${declared}: a manual tier, it does not climb to the ${what}`;
  if (isTaskEpisode(ep)) {
    const party = isPartyEpisode(ep) ? " and a roster entry that says deadmines: true" : "";
    if (top !== undefined && TIER_TABLE[top].runsPerEpisode[ep] === 0) return pinned("Deadmines (t3)");
    if (declared === LADDER_ENTRY) {
      const toT3 = `to t3 on level ${policy.deadminesAtLevel} in a counted e360${party}`;
      return current === "t2"
        ? `the Deadmines evals are t3's: a t1 climbs ${toT3}`
        : `the Deadmines evals are t3's: a t1 climbs to t2 on level ${policy.promoteAtLevel} in a counted e90, then ${toT3}`;
    }
    return `the Deadmines evals open on level ${policy.deadminesAtLevel} in a counted e360, on a tier that buys them${party}`;
  }
  if (ep === "e360") {
    if (top !== undefined && TIER_TABLE[top].runsPerEpisode.e360 === 0) return pinned("e360 (t2)");
    return `its tier buys no e360 runs — earn it with a level-${policy.promoteAtLevel} e90, or set a tier that includes it`;
  }
  return `its tier buys no ${ep} runs`;
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
 * - `unlimited` — a freeplay session, unscored, governed by its idle watchdog.
 */
export { IDLE_MODES, type IdleMode } from "./roster-entry";

export interface SchedulingPolicy {
  /** The level a counted e90 must reach to promote the model up its tier (operator, 2026-11-15). */
  promoteAtLevel: number;
  /**
   * The level a counted e360 must reach before the Deadmines evals are bought
   * (operator, 2026-11-15). Code, like `promoteAtLevel`: a threshold every
   * model is held to alike is a recorded decision, never a store key.
   */
  deadminesAtLevel: number;
  /**
   * The harness series (`comparability.ts`) runs must carry to count. Null:
   * no filter, every stamped run counts (the pre-series behaviour).
   */
  series: string | null;
  /**
   * How many sessions of a driver one host may carry at once, by driver id
   * (`{ "claude-code": 2 }`): the one cap that is not a credential's. Each
   * CLI session is a process with its own memory and sandbox, and a host
   * carries only so many whichever credential pays. Absent: no cap beyond
   * the credentials' slots. Credentials are the config's own block
   * (`runner/src/credential-slots.ts`), never this one.
   */
  maxSessions: Record<string, number>;
  /**
   * The fleet-wide routing default for OpenRouter entries (`routing.ts`), or
   * undefined for the built-in one — the model author's own provider, with
   * fallbacks off (operator decision 2026-09-16).
   *
   * It belongs in this block because it is the same species as everything else
   * here: *where a run may physically execute*. It buys a model no runs and
   * costs it none. An entry that states its own `routing` overrides it
   * outright — there is no merging of two half-specified blocks, because a
   * merged routing is one nobody wrote down.
   */
  routing?: RoutingSpec;
  /**
   * Where a probe-campaign episode executes: `off`, a child process of the
   * fleet like every other lane; `probes`, its own pod on the cluster, created
   * from the chart's template and able to run an arm's own image
   * (infra/episode-launcher.ts, docs/RUNBOOK.md "Run pods"). The same species
   * as the rest of this block — where a run may physically execute — and the
   * dark switch the launcher ships behind: off by default, and off the cluster
   * it changes nothing but turns an arm with a pinned image into a refusal.
   * A codex episode is a pod on the cluster whatever it says (`DriverEntry.runPod`).
   */
  runPods: RunPodsMode;
  /**
   * What a program-loop rehearsal has cleared to score (`REHEARSALS`): the
   * five-agent Deadmines id, and codex rows on either Deadmines id. The
   * operator's word after reading the rehearsal; until it names one, the
   * policy holds those picks and says why (`rehearsalHold`). Absent, or
   * empty, clears nothing.
   */
  rehearsed: Rehearsal[];
  /**
   * Where a scored or probing attempt plays: `off`, the deployment's one
   * shared world, as freeplay always does; `evals`, a short-lived world of its
   * own per attempt on the cluster, a worldserver over its own characters
   * schema (infra/world.ts, docs/RUNBOOK.md "Worlds"). The dark switch the
   * world launcher ships behind, of the same species as `runPods`: off by
   * default, and with it on the planner holds every scored or probing launch
   * that would land on the shared world instead.
   */
  worlds: WorldsMode;
}

export const WORLDS_MODES = ["off", "evals"] as const;
export type WorldsMode = (typeof WORLDS_MODES)[number];

export function parseWorldsMode(raw: unknown, where: string): WorldsMode {
  if (raw === undefined) return "off";
  if (typeof raw !== "string" || !(WORLDS_MODES as readonly string[]).includes(raw)) {
    throw new Error(`${where} must be one of ${WORLDS_MODES.map((m) => JSON.stringify(m)).join(", ")} — "evals" plays every scored and probing attempt on a world of its own on the cluster`);
  }
  return raw as WorldsMode;
}

export const RUN_PODS_MODES = ["off", "probes"] as const;
export type RunPodsMode = (typeof RUN_PODS_MODES)[number];

export function parseRunPodsMode(raw: unknown, where: string): RunPodsMode {
  if (raw === undefined) return "off";
  if (typeof raw !== "string" || !(RUN_PODS_MODES as readonly string[]).includes(raw)) {
    throw new Error(`${where} must be one of ${RUN_PODS_MODES.map((m) => JSON.stringify(m)).join(", ")} — "probes" runs every probe-campaign episode in its own pod on the cluster`);
  }
  return raw as RunPodsMode;
}

export const DEFAULT_POLICY: SchedulingPolicy = {
  promoteAtLevel: 5,
  deadminesAtLevel: 8,
  series: null,
  maxSessions: {},
  runPods: "off",
  worlds: "off",
  rehearsed: [],
};

/**
 * The fleet config's `policy` block (the config store; `infra/fleet.example.json`
 * shows the shape) over the defaults, in one place so the supervisor,
 * `--status` and the viewer read the same answer.
 *
 * What is left here is only ever about **where a run may physically execute**:
 * the per-driver session cap, the routing default and run pods. Which provider
 * credential a run takes, and how many runs one carries, is the `credentials`
 * block's (`runner/src/credential-slots.ts`); how much evidence a model gets is its
 * tier and is not expressible here at all.
 *
 * The removed keys are refused BY NAME rather than ignored: a file still
 * carrying one meant something specific by it, and silently dropping it would
 * re-scope the fleet. The series is the caller's (the checkout it runs from),
 * never the file's.
 */
export function parsePolicyBlock(raw: unknown, series: string | null = null): SchedulingPolicy {
  const base: SchedulingPolicy = { ...DEFAULT_POLICY, series, maxSessions: {}, rehearsed: [] };
  if (raw === undefined) return base;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("fleet config: policy must be an object");
  const o = raw as { runsPerEpisode?: unknown; maxConcurrent?: unknown; maxSessions?: unknown; paid?: unknown; extras?: unknown; resume?: unknown; subscriptions?: unknown; routing?: unknown; runPods?: unknown; worlds?: unknown; rehearsed?: unknown };
  const out = { ...base };
  out.runPods = parseRunPodsMode(o.runPods, "policy.runPods");
  out.worlds = parseWorldsMode(o.worlds, "policy.worlds");
  out.rehearsed = parseRehearsed(o.rehearsed, "policy.rehearsed");
  if (o.runsPerEpisode !== undefined) {
    throw new Error(`policy.runsPerEpisode is not a 0.5 key — run counts are a model's tier (${TIERS.join(", ")}); set roster.<name>.tier`);
  }
  if (o.extras !== undefined) {
    throw new Error('policy.extras is not a 0.5 key — idle behaviour is per model; set roster.<name>.idle to "unlimited", and put a race/class sweep in a probe campaign');
  }
  if (o.resume !== undefined) {
    throw new Error(
      "policy.resume is not a key — whether a lapsed run resumes is the lane's rule: scored evals never do, freeplay always does, a probe campaign opts in through its published definition's resume",
    );
  }
  if (o.maxConcurrent !== undefined) {
    throw new Error("policy.maxConcurrent is not a v1 key — a provider's concurrency is its credentials' slots (credentials/<id>.slots), and a host's per-driver cap is policy.maxSessions");
  }
  if (o.paid !== undefined) throw new Error("policy.paid is not a v1 key — paid concurrency is the slots of the paid credentials (credentials/<id>)");
  if (o.subscriptions !== undefined) throw new Error("policy.subscriptions is not a v1 key — each subscription is a credential (credentials/<id>, provider claude or chatgpt)");
  if (o.maxSessions !== undefined) {
    if (typeof o.maxSessions !== "object" || o.maxSessions === null || Array.isArray(o.maxSessions)) {
      throw new Error('policy.maxSessions must be an object like { "claude-code": 2 }');
    }
    for (const [k, v] of Object.entries(o.maxSessions as Record<string, unknown>)) {
      const d = driverEntry(k);
      if (d === undefined || !d.roster || !d.sessionCap) throw new Error(`policy.maxSessions: ${k} is not a driver a host carries sessions of — one of ${DRIVERS.filter((x) => entryOf(x).roster && entryOf(x).sessionCap).join(", ")}`);
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`policy.maxSessions.${k} must be a positive integer`);
      out.maxSessions[k] = v;
    }
  }
  if (o.routing !== undefined) {
    out.routing = parseRouting(o.routing, "policy.routing");
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
 * makes no progress retires the model. The roster's per-spec defer ladder is
 * this array (`infra/run-roster.ts`), so an operator reading either log sees
 * the same rungs.
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

/**
 * Termination reasons that mean "the model never got to play" for the ladder.
 *
 * `attempt-failed` is a scored run its provider refused (a quota or rate
 * limit) and the scheduler ended rather than resumed. It used to be a strike
 * of its own, three on one model, episode and series stopping the model on
 * that episode; strikes are folded into this ladder (operator, 2026-11-14), so
 * a refused attempt is a rung like any other no-progress attempt, one stop
 * mechanism per model with one clear. A refusal between good runs no longer
 * adds up: a responding run breaks the streak, and a credential's budget is
 * what bounds an intermittent provider's cost.
 */
export const NO_PROGRESS_REASONS: ReadonlySet<string> = new Set(["adapter-error", "attempt-failed"]);

// ----------------------------------------------------------------- inputs

/* A roster entry as the projection needs it: `roster-entry.ts`, re-exported here unchanged. */
export type { RosterModel } from "./roster-entry";

/* What a job holds of the roster, and why a name is outside the policy: `roster-entry.ts`, re-exported here unchanged. */
export { pinnedRefs, policyExclusion, policyRefs, type PolicyJob, type PolicyRoster } from "./roster-entry";

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
  target: number;
  bestLevel: number | null;
  /**
   * The highest level a counted, un-overridden run reached — `bestLevel` over
   * counted runs only. The witnesses read it: `promoteAtLevel` on e90,
   * `deadminesAtLevel` on e360.
   */
  countedLevel: number | null;
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
  /** The entry's declared CLI compaction window (`RosterModel.compactWindow`); absent is its driver's default. */
  compactWindow?: string;
  /** The entry's local build (`RosterModel.serving`); absent on a hosted entry. */
  serving?: ServingSpec;
  /** The entry's providers (`RosterModel.providers`); absent on a single-provider entry. */
  providers?: readonly ProviderOption[];
  /** What the entry launches with (`RosterModel`): its base and routing, and its wiki, which `countsTowardTarget` compares. */
  apiBase?: string;
  routing?: RoutingSpec;
  wiki?: boolean;
  platform: string | null;
  /**
   * The credential provider its runs are served through (`providerOfModel`,
   * credential-slots.ts), or null for one that needs none. Optional so a state
   * built by hand need not spell it.
   */
  provider?: string | null;
  /** The harness this entry's runs go through, from its driver; a tag, not a partition. */
  harness: Harness;
  /** The entry's driver, which decides the loop its targets count (`countsTowardTarget`). Optional so a state built by hand need not spell it. */
  driver?: Driver;
  status: ModelStatus;
  /**
   * Free or paid, decided by `model-cost.ts` (or the roster's override): the
   * SCHEDULER's verdict, which says only which credential may carry a run.
   * `fleet status` prints it; pages and the snapshot show `entryBilling`
   * (billing.ts) instead.
   */
  billing: Billing;
  /** The roster entry's own `billing`, as written; absent when derived. For the reader's verdict (`entryBilling`), never the scheduler's. */
  declaredBilling?: Billing;
  /** The tier the config admitted this model to — what an operator wrote. */
  declaredTier: Tier;
  /**
   * The tier it is scheduled under (`effectiveTier`): a declared `t1` advanced
   * one rung per witness it holds. Equal to `declaredTier` for any other
   * declared tier however well the model plays: `t0` holds the ladder and a
   * declared `t2` or `t3` is a pin.
   */
  tier: Tier;
  /**
   * A counted `e90` in this series reached `promoteAtLevel`. Kept apart from
   * the tier on purpose: this is what the model EARNED, the tier is where it
   * was ADMITTED, and a hand-promoted model must never read as having earned
   * it. It is also why moving a `t0` model to `t1` promotes it immediately.
   */
  earnedPromotion: boolean;
  /**
   * A counted `e360` in this series reached `deadminesAtLevel`: what opens the
   * Deadmines evals a tier buys (operator, 2026-11-15), and the witness that
   * climbs a `t1` from `t2` to `t3`. No tier opens them without it, a declared
   * `t3` included.
   */
  earnedDeadmines: boolean;
  /** What it does with an account once its tier is spent. */
  idle: IdleMode;
  /**
   * The entry's driver is probe-only (`DriverEntry.probeOnly`), or the entry
   * says `campaignOnly`: no target and no eligible episode, so no scored run.
   * A probe-only driver has no idle work either; a campaignOnly entry keeps
   * its `idle` (operator, 2026-11-15).
   */
  probeOnly?: true;
  /** The probe-only status is the entry's own `campaignOnly`, not its driver's. */
  campaignOnly?: true;
  /** Episode tiers the model may be scheduled on, in policy order. */
  eligible: EpisodeId[];
  perEpisode: Partial<Record<EpisodeId, EpisodeStats>>;
  cooling?: ModelCooling;
  retired?: ModelRetired;
  /**
   * Set with `retired` when the retirement is its provider's list, not the
   * ladder (`runner/src/model-lists.ts`): it lifts by itself once the model is
   * listed again, and no clear lifts it.
   */
  gone?: ModelGone;
  /** Consecutive no-progress attempts on the ladder (0 when the last attempt progressed). */
  ladder: number;
  /**
   * The model's newest paused run in this series, under any entry of its
   * identity. A paused run holds no session and plays nothing, so it holds
   * only its own way back (`schedulability`): a freeplay one keeps a fresh
   * freeplay session from starting over the character it will resume, a
   * resumable probe keeps its entry's unscored work, and none holds a scored
   * episode. It stands until the supervisor resumes the run or the run goes
   * stale (`isStandingPause`).
   */
  paused?: { runId: string; episode: EpisodeId; reason: string; at: number; episodeElapsedMs: number | null; episodeMs: number | null };
  /**
   * The newest live freeplay or scored run of this model, under any entry of
   * its identity, or a freeplay run the supervisor is resuming this tick
   * (`resuming`, `withResumesPlaying`). One character per model: a freeplay
   * character playing holds the model's scored episodes, and a scored run
   * playing holds its freeplay. A probe is neither, as before.
   */
  playing?: { runId: string; episode: EpisodeId; resuming?: true };
  /**
   * The other roster entries of this model (`modelSiblings`): the same model on
   * another provider, which fills the same target (operator, 2026-11-16).
   * Absent when the entry is alone on its model, or the caller projected one
   * entry without its roster.
   */
  siblings?: readonly string[];
  /**
   * The newest live freeplay or scored run of this model under one of its
   * other entries (`sameModel`, not owned by this one), or a sibling's
   * freeplay run the supervisor is resuming this tick. It holds this entry's
   * scored episodes, so two providers never launch toward one target at once,
   * and a scored one holds its freeplay; a sibling's freeplay does not hold
   * this entry's own freeplay character.
   */
  siblingPlaying?: { runId: string; episode: EpisodeId; resuming?: true };
}

export interface NextJob {
  name: string;
  episode: EpisodeId;
  account: string;
  /** 1-based attempt number on this (model, episode): `attempts + 1`. */
  attempt: number;
  why: string;
  /**
   * Set on a probe pick: which campaign and version commissioned it, and which
   * cell and arm it is. The shape is the published definition's; only the
   * identity travels on the pick.
   */
  probe?: ProbeIdentity;
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

/** `run.ts --resume` refused because the run has a live owner (EX_TEMPFAIL): nothing was written. */
export const RESUME_REFUSED_EXIT = 75;

/**
 * Why a run may not be resumed right now — a process still owns it — or null.
 *
 * Two signs, either enough: a fresh heartbeat, whatever the row says (a paused
 * run whose runner is still unwinding is still that runner's); or, for a run
 * with no heartbeat file at all, the reading `live` has always had. A cold
 * heartbeat is no owner: that is a runner killed without a chance to remove
 * it, which is the run a resume exists for.
 */
export function liveOwnerOf(runsDir: string, runId: string, now = Date.now()): string | null {
  const dir = join(runsDir, runId);
  const beat = heartbeatAt(dir);
  if (beat !== null && now - beat < HEARTBEAT_DEAD_MS) {
    const who = heartbeatOwner(dir);
    return `its heartbeat is ${Math.round((now - beat) / 1000)}s old${who !== "" ? ` (${who})` : ""}`;
  }
  const f = readRunFact(runsDir, runId, now);
  if (f !== null && f.live) return "its trajectory was written in the last two minutes and it has neither a pause nor a termination";
  return null;
}

/**
 * The kept facts of terminated runs at `path`, for a caller that reads every
 * run on a timer; `readOnly` for a one-shot reader beside it, which is served
 * the same and writes nothing.
 */
export function runFactCache(path: string, opts: { readOnly?: boolean } = {}): RunFactCache {
  return new RunFactCache(path, runFactCacheVersion(), opts);
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

/** A roster entry's driver; `openai` when it names none. A name outside the vocabulary is a config error. */
export function driverOf(r: { name: string; driver?: string }): Driver {
  const d = r.driver ?? DEFAULT_DRIVER;
  if (!isDriver(d)) throw new Error(`roster.${r.name}: driver "${d}" is not one of ${DRIVERS.join("|")}`);
  return d;
}

/** A completed run that is safe scoring evidence for its target. */
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
  if (f.pause === null) return Math.max(f.endedAt ?? 0, f.startedAt);
  // A pause waiting on a stated reset — a spent quota, a credential's usage budget —
  // is not gone quiet while it waits: nothing may play it before then, so its
  // gap starts at the reset, and a resuming probe whose reset is farther than
  // its own budget is not aged into stale while it waits.
  return WAITS_ON_RESET.has(f.pause.reason) && f.pause.notBefore !== undefined ? Math.max(f.pause.at, f.pause.notBefore) : f.pause.at;
}

/** The pauses whose `notBefore` is a reset the run must wait for (`lastActivityOf`). */
const WAITS_ON_RESET: ReadonlySet<string> = new Set(["quota-exhausted", SUBSCRIPTION_PAUSE]);

/**
 * A run nothing came back for: no termination, and no activity for
 * longer than its own episode budget (a run with no wall clock gets
 * `STALE_FALLBACK_MS`). The host slept, or the fleet was down; either way the
 * run is cooked and is ended rather than resumed. A live process is excluded
 * by `f.live`, which the caller must have computed against the same clock.
 * A freeplay run is never stale (`neverStale`): a paused one holds its model,
 * stays in the status listing and is resumed or listed by `planResumes`
 * however long it has sat, so no reader drops a run another still means to
 * bring back.
 */
export function isStaleRun(f: Pick<RunFact, "pause" | "endedAt" | "startedAt" | "episodeMs" | "episode" | "live" | "terminationReason">, now: number): boolean {
  if (f.terminationReason !== null || f.live || neverStale(f.episode)) return false;
  return now - lastActivityOf(f) > staleAfterMs(f.episodeMs);
}

/**
 * A pause that still stands: the run is paused and not stale, so it is
 * somebody's to resume. The one test behind both the model hold (the policy
 * starts nothing for a model whose run is waiting) and the status listing —
 * they read the same runs the resume planner walks, or a run one of them
 * dropped would be continued or hidden while another still meant to resume it.
 */
export function isStandingPause(f: Parameters<typeof isStaleRun>[0] & Pick<RunFact, "archived">, now: number): boolean {
  // An archived run is put away: nobody resumes it, so it holds nothing.
  return f.pause !== null && f.archived !== true && !isStaleRun(f, now);
}

/**
 * Newest start first — the one order for "which of a character's runs is its
 * head". The character head (`charactersFrom`), the model hold and the resume
 * planner all ask it, and when two runs of one character are paused at once they
 * must name the same one: ordering the planner by pause time instead let it
 * resume a run that was neither the character's head nor the one holding the
 * model. Ties go to the higher run id, the order `readRunFacts` returns.
 */
export function byNewestStart(a: Pick<RunFact, "startedAt" | "runId">, b: Pick<RunFact, "startedAt" | "runId">): number {
  return b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0);
}

/** The run `byNewestStart` puts first, or undefined for none. */
export function newestStarted<T extends Pick<RunFact, "startedAt" | "runId">>(runs: readonly T[]): T | undefined {
  let head: T | undefined;
  for (const f of runs) if (head === undefined || byNewestStart(f, head) < 0) head = f;
  return head;
}

/** How long a stale run has been silent, or null when it is current. */
export function staleForMs(f: Parameters<typeof isStaleRun>[0], now: number): number | null {
  return isStaleRun(f, now) ? now - lastActivityOf(f) : null;
}

/** What an entry launches a run as, for `countsTowardTarget`. Absent fields are the defaults. */
export interface TargetEntry {
  driver?: string | undefined;
  wiki?: boolean | undefined;
}

/**
 * Whether a counted run counts toward a roster entry's target: it is the
 * condition the entry launches now (operator, 2026-11-14) — the loop and
 * `yield` its driver defaults to (`defaultLoopOf`) and its wiki — as its
 * tuple stamped them. Effort, window and a local build are the model's
 * identity already (`sameModel`), and the series is `inSeries`'s. A run of
 * another condition is not a copy of this one, so it neither fills a target
 * nor is owed a rerun; the prompt hash is not compared, since a patch within
 * the series moves it. Nor is the routing: a model served by different
 * providers is one model, and whichever provider ran it counts (operator,
 * 2026-11-16). Pure.
 */
export function countsTowardTarget(f: Pick<RunFact, "loop" | "yield" | "wiki">, entry: TargetEntry): boolean {
  const driver = entry.driver !== undefined && isDriver(entry.driver) ? entry.driver : DEFAULT_DRIVER;
  const d = defaultLoopOf({ driver });
  const program = d.loop === "program";
  if ((f.loop === "program") !== program || (f.yield === true) !== (program && d.yield)) return false;
  return (f.wiki !== false) === (entry.wiki !== false);
}

export function isCounted(f: RunFact): boolean {
  // A driver that is not a model (the scripted stub, the scripted reference)
  // is never evidence about one, whatever episode it was launched under and
  // whatever model id it carries: no target, no promotion witness, no repeat
  // (docs/METHODOLOGY.md, "Scoring"). Read off the run's own config, so it
  // holds for a fact the cache wrote before this line existed.
  return countedRun({
    extra: f.extra,
    episodeOverride: f.episodeOverride,
    notAModel: isNotAModelRun({ driver: f.driver }),
    live: f.live,
    paused: f.pause !== null,
    modelResponses: f.modelResponses,
    terminationReason: f.terminationReason,
  });
}

/** A finished attempt the ladder reads as "no progress". */
export function isNoProgress(f: RunFact): boolean {
  if (f.live || f.pause !== null) return false;
  if (stillbornOf(f) === true) return true;
  return f.terminationReason !== null && NO_PROGRESS_REASONS.has(f.terminationReason);
}

/* What a run and a roster entry must share for the run to be that entry's: `roster-entry.ts`, re-exported here unchanged. */
export type { RosterIdentity } from "./roster-entry";

/** Whether an entry's build and a run's are one: equal blocks, or a run whose caller cannot say. */
function servingMatches(entry: RosterIdentity, run: RosterIdentity): boolean {
  if (run.serving === undefined) return true;
  const key = (s: ServingSpec | null | undefined): string => (s == null ? "" : `${s.weights}\n${s.quant}\n${s.runtime}`);
  return key(entry.serving) === key(run.serving);
}

/**
 * Whether an identity is a probe-only driver's (`DriverEntry.probeOnly`, pi
 * until promoted), by its driver or its harness tag. With neither it is the
 * default driver's, which is not.
 */
function probeOnlyIdentity(x: RosterIdentity): boolean {
  if (x.driver == null && x.harness == null) return isProbeOnlyDriver(DEFAULT_DRIVER);
  return eitherHas({ driver: x.driver, harness: x.harness }, (d) => d.probeOnly);
}

/* Which runs an entry's declared window owns: `roster-entry.ts`, re-exported here unchanged. */
export { entryOwnsWindow, ownedWindows, rosterWindowKey } from "./roster-entry";

/**
 * Whether a run is a roster entry's: same model, same effort, and a CLI
 * compaction window the entry owns (`entryOwnsWindow`). ENTRY FIRST: the two
 * sides are not alike, because an entry's absent window is a default and a
 * run's is `auto`. Absent and null read alike on both (the provider's default
 * effort), so a run written before a field existed still matches the entry
 * that never set it. Every place that maps a run back to an entry asks this,
 * so an entry that differs from another only in its window owns its own runs.
 *
 * A probe-only driver's identity (pi) is never another driver's: the
 * one-model-one-harness rule (`harnessClash`) exempts such an entry, so a pi
 * entry and a wrathbench entry may name one model at one effort, and their
 * runs must not pool either way. Only that bit of the harness is compared,
 * never the whole label: older runs of one model under two other harnesses
 * keep matching exactly as they did.
 */
export function entryOwnsRun(entry: RosterIdentity, run: RosterIdentity): boolean {
  return (
    (entry.providers === undefined ? entry.model === run.model : run.model !== null && entryModelIds(entry).includes(run.model)) &&
    (entry.effort ?? null) === (run.effort ?? null) &&
    entryOwnsWindow(entry, run.compactWindow) &&
    probeOnlyIdentity(entry) === probeOnlyIdentity(run) &&
    // A local build and the hosted model of one id are two entries (operator, 2026-11-14).
    servingMatches(entry, run)
  );
}

/**
 * Whether a run is of an entry's model, whichever provider served it:
 * `entryOwnsRun` with the model compared by its identity across providers
 * (`canonicalModelId`), so an OpenCode Go run recorded as
 * `deepseek-v4.1-flash` is the model of an entry that names
 * `deepseek/deepseek-v4.1-flash` (operator, 2026-11-16). Effort, window, a
 * local build and the probe-only bit are compared as `entryOwnsRun` compares
 * them.
 *
 * What a target counts and what one character per model holds, never what
 * owns a run: a run is resumed, its credential read and its account and
 * character kept only under the entry whose model id it recorded
 * (`entryOwnsRun`), since another provider cannot serve that id.
 */
export function sameModel(entry: RosterIdentity, run: RosterIdentity): boolean {
  const ids = entryModelIds(entry);
  return (
    run.model !== null &&
    ids.some((m) => m === run.model || canonicalModelId(m) === canonicalModelId(run.model!)) &&
    entryOwnsRun({ ...entry, model: run.model, providers: undefined }, run)
  );
}

/**
 * An entry's model identity as one string, for grouping entries rather than
 * matching a run (`sameModel`): its canonical model, effort, the windows it
 * owns, its local build and the probe-only bit. Two entries with one key are
 * one model on two providers, and fill one target.
 */
export function modelIdentityOf(entry: RosterIdentity): string {
  const s = entry.serving;
  return [
    entry.model === null ? "" : canonicalModelId(entry.model),
    entry.effort ?? "",
    ownedWindows(entry).join(","),
    s == null ? "" : `${s.weights}\n${s.quant}\n${s.runtime}`,
    probeOnlyIdentity(entry) ? "probe-only" : "",
  ].join("@");
}

/**
 * The other roster entries of each entry's model (`modelIdentityOf`), by name,
 * in roster order; an entry alone on its model has none. Pure.
 */
export function modelSiblings(roster: readonly (RosterIdentity & { name: string })[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const r of roster) {
    const key = modelIdentityOf(r);
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [r.name]);
    else list.push(r.name);
  }
  const out = new Map<string, string[]>();
  for (const r of roster) {
    const others = byKey.get(modelIdentityOf(r))!.filter((n) => n !== r.name);
    if (others.length > 0) out.set(r.name, others);
  }
  return out;
}

/**
 * Whether a run is this entry's. A fleet probe names the entry it ran as
 * (`config.ref`), and that stamp is the authority, as it is for the square
 * the probe counts in (`campaignSquares`): the probe is the named entry's
 * when its model and effort are the entry's, and its window is the entry's or
 * the entry has none — an arm may set the window itself (`--compact-window`,
 * operator 2026-10-11), and that window is in the run's tuple without being
 * the entry's identity. Matched by identity alone, such a run belonged to no
 * entry, or to a windowed copy it never ran as, and its credential and its
 * ladder went unseen. Every other run matches by identity (`entryOwnsRun`).
 * Arms that differ only by window still never pool: the square is keyed on
 * the arm, and the results on the tuple.
 */
export function matchesRoster(f: RunFact, r: Pick<RosterModel, "name" | "model" | "effort" | "compactWindow" | "driver" | "serving" | "providers">): boolean {
  if (f.campaign !== null && f.arm != null && f.ref != null) {
    return (
      f.ref === r.name &&
      entryOwnsRun({ model: r.model, effort: r.effort, driver: r.driver, serving: r.serving, providers: r.providers }, { model: f.model, effort: f.effort, driver: f.driver, serving: f.serving }) &&
      (r.compactWindow === undefined || entryOwnsWindow(r, f.compactWindow))
    );
  }
  return entryOwnsRun(r, f);
}

/**
 * The credential each roster entry's live-or-paused run is on, read off the
 * runs themselves: what makes the per-credential count survive a supervisor
 * restart, and what sends a resume back to the credential it started on. A
 * run that recorded none (0.5, or launched by hand without `--credential`) is
 * not listed.
 */
export function liveCredentials(
  runs: readonly RunFact[],
  roster: readonly Pick<RosterModel, "name" | "model" | "effort" | "compactWindow" | "driver">[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of roster) {
    const f = runs.find((x) => (x.live || x.pause !== null) && x.credential !== null && matchesRoster(x, r));
    if (f?.credential != null) out.set(r.name, f.credential);
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
function targetFor(tier: Tier, ep: EpisodeId, entry?: Pick<RosterModel, "deadmines">, earnedDeadmines = false): number {
  // Derived from the episode table, never from a list of names. A name check
  // here is a landmine: when a new id lands, TypeScript forces *a* decision and
  // the cheapest one that compiles is to widen `runsPerEpisode`, which silently
  // wires an unscored episode into series-gated evidence and promotion. An
  // episode that cannot be scored cannot be evidence, so it has no target, and
  // `models.test.ts` asserts that for every id in the table.
  if (!isScoredEpisode(ep)) return 0;
  // The five-agent id is bought only where the entry opts in (operator, 2026-11-14).
  if (ep === "deadmines" && entry?.deadmines !== true) return 0;
  // Either Deadmines id only once a counted e360 reached `deadminesAtLevel` (operator, 2026-11-15).
  if (isTaskEpisode(ep) && !earnedDeadmines) return 0;
  return TIER_TABLE[tier].runsPerEpisode[ep];
}

/** Whether an episode's attempt is a party of member runs (`deadmines`), counted as one. */
export function isPartyEpisode(ep: EpisodeId): boolean {
  return isTaskEpisode(ep) && EPISODES[ep].task.agents > 1;
}

/**
 * A party episode's runs, grouped into attempts by party id; a member run
 * with no party id is an attempt of its own (a stub written before its
 * stamp). In first-launched order.
 */
export function partyAttempts(facts: readonly RunFact[]): RunFact[][] {
  const by = new Map<string, RunFact[]>();
  for (const f of facts) {
    const key = f.party?.id ?? `run:${f.runId}`;
    const list = by.get(key);
    if (list === undefined) by.set(key, [f]);
    else list.push(f);
  }
  return [...by.values()];
}

/**
 * Fill one party episode's stats from its attempts (`partyAttempts`). An
 * attempt counts as `partyAttempt` says — whole on disk, nothing in flight,
 * no member `launch-failed`, every member that ended on its own verdict
 * counting. A provider's refusal on it is one rung of the model's cooling
 * ladder, however many members met it: the walk takes one member per party.
 * A `launch-failed` stub (staging that failed) is an attempt that numbers the
 * next, and neither counts nor cools. Levels and last verdicts read the
 * member runs as they are.
 */
function tallyParties(stats: EpisodeStats, all: readonly RunFact[], mine: readonly RunFact[], ofModel: readonly RunFact[], entry: TargetEntry): void {
  stats.attempts = partyAttempts(all).length;
  // What counts is the model's, under any entry of it (`sameModel`); the rest is the entry's own.
  for (const members of partyAttempts(ofModel)) {
    const verdict = partyAttempt(
      members.map((f) => ({
        campaign: null,
        version: null,
        cell: null,
        ref: null,
        arm: null,
        counted: isCounted(f) && countsTowardTarget(f, entry),
        live: f.live || f.pause !== null,
        party: f.party == null ? null : { id: f.party.id, size: f.party.size },
        terminationReason: f.terminationReason,
      })),
    );
    if (verdict.counted) {
      stats.counted++;
      for (const f of members) stats.countedLevel = maxLevelOf(stats.countedLevel, f.bestLevel);
    }
    for (const f of members) if (f.bestLevel !== null && (stats.bestLevel === null || f.bestLevel > stats.bestLevel)) stats.bestLevel = f.bestLevel;
  }
  for (const members of partyAttempts(mine)) {
    if (members.every((f) => stillbornOf(f) === true)) stats.stillborn++;
    for (const f of members) {
      if (f.endedAt !== null && (stats.lastEnded === null || f.endedAt >= stats.lastEnded)) {
        stats.lastEnded = f.endedAt;
        stats.lastReason = stillbornOf(f) === true ? "stillborn" : f.terminationReason;
      }
    }
  }
}

/** The higher of two level readings, where null is "none recorded". */
function maxLevelOf(a: number | null, b: number | null): number | null {
  if (b === null) return a;
  return a === null || b > a ? b : a;
}

/** Whether a counted run of the episode reached `level`: the promotion and Deadmines witnesses. */
function witnessed(stats: EpisodeStats | undefined, level: number): boolean {
  return stats?.countedLevel != null && stats.countedLevel >= level;
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
  opts: { now: number; clearedAt?: number; gone?: ModelGone },
): ModelState {
  const billing = rosterBilling(r);
  // A run whose driver is not a model is no roster entry's, even under a
  // colliding model id: it is neither an attempt, a best level nor a ladder
  // rung of the model it names.
  const all = runs.filter((f) => matchesRoster(f, r) && !isUnscoredDriverName(f.driver));
  // Another series' runs are shown, never counted: not witnesses, not ladder.
  // The ladder is about the provider, but a run that old says nothing about
  // tonight's provider either. They DO number attempts: the attempt index is
  // what keeps run ids unique on disk, and a series bump must not make the
  // next run id collide with an older directory (2026-08-23, harness-0.4).
  const mine = all.filter((f) => inSeries(f, policy));
  // The model's runs under any entry of it, whichever provider served them
  // (operator, 2026-11-16): what its targets count and its witnesses read,
  // and the best level it reached. Attempts, the ladder and a pause stay the
  // entry's own: they number its run ids and are evidence about its endpoint.
  const ofModelAll = runs.filter((f) => sameModel(r, f) && !isUnscoredDriverName(f.driver));
  const ofModel = ofModelAll.filter((f) => inSeries(f, policy));
  const perEpisode: Partial<Record<EpisodeId, EpisodeStats>> = {};
  for (const ep of STATS_EPISODES) {
    const stats: EpisodeStats = {
      counted: 0,
      stillborn: 0,
      attempts: 0,
      extras: 0,
      otherSeries: all.filter((f) => f.episode === ep && !inSeries(f, policy)).length,
      // Filled below: a target depends on the effective tier, which depends on
      // whether the e90 walk found a promotion witness, and a Deadmines target
      // on the e360 walk's witness. Two passes, not a guess.
      target: 0,
      bestLevel: null,
      countedLevel: null,
      lastEnded: null,
      lastReason: null,
    };
    // A party episode's attempt is its party, not its member runs (operator,
    // 2026-11-14): five members are one attempt and one count, and the
    // cooling walk takes one rung for it, however many met a refusal.
    if (isPartyEpisode(ep)) {
      tallyParties(stats, all.filter((f) => f.episode === ep), mine.filter((f) => f.episode === ep), ofModel.filter((f) => f.episode === ep), r);
      perEpisode[ep] = stats;
      continue;
    }
    for (const f of all) if (f.episode === ep) stats.attempts++;
    for (const f of mine) {
      if (f.episode !== ep) continue;
      if (f.extra) stats.extras++;
      if (stillbornOf(f) === true) stats.stillborn++;
      if (f.endedAt !== null && (stats.lastEnded === null || f.endedAt >= stats.lastEnded)) {
        stats.lastEnded = f.endedAt;
        stats.lastReason = stillbornOf(f) === true ? "stillborn" : f.terminationReason;
      }
    }
    for (const f of ofModel) {
      if (f.episode !== ep) continue;
      if (isCounted(f) && countsTowardTarget(f, r)) {
        stats.counted++;
        stats.countedLevel = maxLevelOf(stats.countedLevel, f.bestLevel);
      }
      if (f.bestLevel !== null && (stats.bestLevel === null || f.bestLevel > stats.bestLevel)) stats.bestLevel = f.bestLevel;
    }
    perEpisode[ep] = stats;
  }

  // The tier the model is actually scheduled under: what the config admitted it
  // to, and for a declared t1 one rung up per witness it holds (operator,
  // 2026-11-20). `t0` holds the ladder, so a trial model keeps its witness and
  // gains nothing from it until an operator moves it up — which is what makes
  // that move cost no re-runs. The Deadmines evals a tier buys open on the e360
  // witness alone (operator, 2026-11-15).
  const earnedPromotion = witnessed(perEpisode.e90, policy.promoteAtLevel);
  const earnedDeadmines = witnessed(perEpisode.e360, policy.deadminesAtLevel);
  const tier = effectiveTier(r.tier, { promotion: earnedPromotion, deadmines: earnedDeadmines });
  // A probe-only driver's entry is no scored lane's: its tier buys nothing
  // until the operator promotes the driver (`DriverEntry.probeOnly`). A
  // campaignOnly entry is the same on any driver.
  const probeOnly = isProbeOnlyDriver(r.driver) || r.campaignOnly === true;
  for (const ep of STATS_EPISODES) perEpisode[ep]!.target = probeOnly ? 0 : targetFor(tier, ep, r, earnedDeadmines);

  // Eligibility falls out of the budget: an episode the tier buys no runs of is
  // not one this model may be scheduled on. One statement, so a target of zero
  // and "not eligible" can no longer disagree the way `promoted, 0/0` did.
  const eligible: EpisodeId[] = probeOnly ? [] : POLICY_EPISODES.filter((ep) => targetFor(tier, ep, r, earnedDeadmines) > 0);
  if (!probeOnly && !eligible.includes("e90")) eligible.unshift("e90");

  // The ladder: trailing consecutive no-progress attempts, newest last, after the clear.
  let ladder = 0;
  let lastFail: RunFact | undefined;
  // A paused run is neither rung nor reset: it is skipped on the walk. So is a
  // launch that never became a run (`launch-failed`): it says nothing about
  // the provider, so it neither cools the model nor forgives its streak. Nor
  // is a party member another member's verdict ended (`party-ended`): the
  // party's evidence is that member's own run, which is on the walk, and four
  // more rungs for one early party death would cool the model's evals too.
  // And a party is one attempt on the walk as in the tally: a refusal or a
  // transport failure that ended all five members on their own verdict is one
  // rung, not five (operator, 2026-11-14), so only its last-ended member is
  // walked.
  const lastOfParty = new Map<string, RunFact>();
  for (const f of mine) {
    if (f.party == null || f.endedAt === null) continue;
    const prev = lastOfParty.get(f.party.id);
    if (prev === undefined || (prev.endedAt ?? 0) <= f.endedAt) lastOfParty.set(f.party.id, f);
  }
  const finished = mine.filter(
    (f) =>
      !f.live &&
      f.pause === null &&
      f.endedAt !== null &&
      f.terminationReason !== "launch-failed" &&
      f.terminationReason !== "party-ended" &&
      (f.party == null || lastOfParty.get(f.party.id) === f) &&
      (opts.clearedAt === undefined || f.endedAt > opts.clearedAt),
  );
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
    ...(r.compactWindow !== undefined ? { compactWindow: r.compactWindow } : {}),
    ...(r.serving !== undefined ? { serving: r.serving } : {}),
    ...(r.providers !== undefined ? { providers: r.providers } : {}),
    ...(r.apiBase !== undefined ? { apiBase: r.apiBase } : {}),
    ...(r.routing !== undefined ? { routing: r.routing } : {}),
    ...(r.wiki !== undefined ? { wiki: r.wiki } : {}),
    platform: platformOf(r.apiBase, r.driver),
    provider: providerOfModel(r),
    harness: harnessOf(driverOf(r)),
    driver: driverOf(r),
    status: "active",
    billing,
    ...(r.billing !== undefined ? { declaredBilling: r.billing } : {}),
    declaredTier: r.tier,
    tier,
    earnedPromotion,
    earnedDeadmines,
    // A probe-only driver plays nothing but its campaigns; a held entry may
    // still play freeplay (operator, 2026-11-15).
    idle: isProbeOnlyDriver(r.driver) ? "none" : (r.idle ?? "none"),
    ...(probeOnly ? { probeOnly: true as const } : {}),
    ...(r.campaignOnly === true ? { campaignOnly: true as const } : {}),
    eligible,
    perEpisode,
    ladder,
  };
  // The newest-started standing pause — a freeplay one for as long as it
  // sits, since it is never stale and is resumed, never rescheduled. What it
  // holds is `schedulability`'s to say.
  const pausedRun = newestStarted(mine.filter((f) => isStandingPause(f, opts.now)));
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
  // Any series: a live run is a character playing whatever harness it runs.
  const playingRun = newestStarted(all.filter((f) => f.live && f.episode !== "probing"));
  if (playingRun !== undefined) state.playing = { runId: playingRun.runId, episode: playingRun.episode };
  // The model playing under another of its entries (`siblingPlaying`).
  const own = new Set(all.map((f) => f.runId));
  const elsewhere = newestStarted(ofModelAll.filter((f) => f.live && f.episode !== "probing" && !own.has(f.runId)));
  if (elsewhere !== undefined) state.siblingPlaying = { runId: elsewhere.runId, episode: elsewhere.episode };
  if (opts.gone !== undefined) {
    state.gone = opts.gone;
    state.retired = { at: opts.gone.since, reason: goneReason(opts.gone) };
    state.status = "retired";
    return state;
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
  // moved this model — never for one hand-placed on t2 or t3, and never for a t0
  // model holding a promotion witness it has not been allowed to spend.
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
  /** The providers' model-list reads; omitted reads `<runsDir>/fleet-model-lists.json`. */
  modelLists?: ModelListsSidecar;
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
  const lists = input.modelLists ?? readModelListsSidecar(input.runsDir);
  const siblings = modelSiblings(input.roster);
  return input.roster.map((r) => {
    // An entry with providers is gone only when every one of them has dropped it.
    const goneEach = (r.providers ?? [r]).map((p) => modelGoneOf(lists, { driver: r.driver, model: p.model, apiBase: p.apiBase }));
    const gone = goneEach.every((g) => g !== undefined) ? goneEach[0] : undefined;
    const state = projectModel(r, runs, policy, { now, clearedAt: sidecar.cleared[r.name], ...(gone !== undefined ? { gone } : {}) });
    const others = siblings.get(r.name);
    return others === undefined ? state : { ...state, siblings: others };
  });
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
 * - `blocked` — retired, cooling, already running, a resumable probe paused
 *   (its unscored work only), or owing a scored run while a freeplay
 *   character of the model plays. No lane may have it.
 *
 * Lane priority lives at the pick, not here: a model is never "a probe model",
 * it is a model that happens to owe nothing.
 */
export type Verdict = { verdict: "eval" | "free" | "blocked"; why: string };

/**
 * A verdict as a deployment with the evals group off reads it
 * (`viewer/groups.ts`): owing a counted run is owing nothing, so the
 * model is free for its idle work. One rule for the policy's picks and the
 * `--status` table.
 */
export function verdictForGroups(v: Verdict, evals: boolean): Verdict {
  return !evals && v.verdict === "eval" ? { verdict: "free", why: "the evals group is off" } : v;
}

/**
 * Why a model is or is not schedulable right now — the `--status` line.
 * The policy argument is vestigial: nothing about how much a model runs is
 * read from the file any more.
 */
export function schedulability(
  s: ModelState,
  running: ReadonlySet<string> = new Set(),
  policy: SchedulingPolicy = DEFAULT_POLICY,
  /**
   * Those of `running` whose run in flight holds the model's other entries:
   * a scored or freeplay one, never a probe. Absent, every one does.
   */
  holding: ReadonlySet<string> = running,
): Verdict {
  const blocked = (why: string): Verdict => ({ verdict: "blocked", why });
  if (s.gone !== undefined) return blocked(`retired: ${s.retired?.reason ?? goneReason(s.gone)} — back by itself once it is listed again`);
  if (s.retired !== undefined) return blocked(`retired: ${s.retired.reason} — clear with bun wb fleet clear-model ${s.name}`);
  if (s.cooling !== undefined) {
    return blocked(`cooling rung ${s.cooling.rung}/${LADDER_MS.length} until ${new Date(s.cooling.until).toISOString()} (${s.cooling.reason})`);
  }
  if (running.has(s.name)) return blocked("running (one character per model)");
  const v = ownVerdict(s, policy);
  // A paused run holds no session and plays nothing, so it holds only its own
  // way back, never a scored episode of its model under any entry. A freeplay
  // one holds the model's freeplay (`idleHold`, below). A resumable probe holds
  // its entry's unscored work, so a campaign does not offer its square again
  // over the paused run. A scored one is not coming back: it holds the model
  // only until the next tick ends it as a failed attempt — the live tick ends
  // it before it picks, so this is what `--status` and `--dry-run` say in the
  // meantime — and the ladder then reads that attempt.
  const scoredPause = s.paused !== undefined && EPISODES[s.paused.episode].scored;
  if (s.paused !== undefined && s.paused.episode !== "freeplay" && (scoredPause || v.verdict !== "eval")) {
    const spent = s.paused.episodeElapsedMs !== null ? `${Math.round(s.paused.episodeElapsedMs / 60_000)}m` : "?m";
    const of = s.paused.episodeMs !== null ? ` of ${Math.round(s.paused.episodeMs / 60_000)}m` : "";
    const fate = resumesOnPause(s.paused.episode)
      ? "resumed by the supervisor, never rescheduled"
      : "ended as a failed attempt on the next tick, then reattempted fresh";
    return blocked(`paused run ${s.paused.runId} (${s.paused.reason}, ${spent}${of} elapsed) — ${fate}`);
  }
  // One character per model, across entries: a freeplay character playing (or
  // resuming this tick) holds the model's scored episodes.
  if (v.verdict === "eval" && s.playing?.episode === "freeplay") {
    return blocked(`running (one character per model): ${s.playing.runId} ${s.playing.resuming === true ? "resumes" : "plays"} its freeplay character`);
  }
  // Its other entries are the same model on another provider, filling the
  // same target (operator, 2026-11-16): while one plays, or was picked this
  // tick, none launches a scored episode beside it.
  if (v.verdict === "eval") {
    const busy = s.siblings?.find((n) => holding.has(n));
    if (busy !== undefined) return blocked(`running (one character per model): ${busy} runs it`);
    if (s.siblingPlaying !== undefined) {
      return blocked(`running (one character per model): ${s.siblingPlaying.runId} ${s.siblingPlaying.resuming === true ? "resumes" : "plays"} it under another entry`);
    }
  }
  return v;
}

/** The verdict from the entry's own state, before anything another run holds. */
function ownVerdict(s: ModelState, policy: Pick<SchedulingPolicy, "promoteAtLevel" | "deadminesAtLevel">): Verdict {
  // Free, so a probe campaign may take it, and owing nothing, so nothing else does.
  if (s.campaignOnly === true) {
    return { verdict: "free", why: s.idle === "none" ? "campaignOnly: it runs only as a probe campaign's assignment" : `campaignOnly: no scored runs${idleWords(s)}` };
  }
  if (s.probeOnly === true) return { verdict: "free", why: probeOnlyRefusal(harnessDriver(s.harness)?.id ?? s.harness) };
  // A provider refusing a scored attempt is a cooling rung (above), not a stop of
  // its own: one ladder per model, cleared one way.
  const open = s.eligible.filter((ep) => {
    const st = s.perEpisode[ep];
    return st !== undefined && st.counted < st.target;
  });
  if (open.length === 0) {
    // Idle work is the model's own axis now, not a consequence of its billing
    // or where its account comes from: what it does with a spare account is what its entry
    // says it does. A paid model defaults to `none` and so buys nothing extra.
    // One idle mode past `none`, so one thing to say. (The retired third,
    // `idle: "characters"`, is a probe campaign now — nothing here rolls a
    // start state, and nothing anywhere names a character.)
    return { verdict: "free", why: `targets met on ${s.eligible.join(", ")}${deadminesWait(s, policy)}${idleWords(s)}` };
  }
  return { verdict: "eval", why: `schedulable on ${open.join(", ")}${deadminesWait(s, policy)}` };
}

/**
 * What a model on its `e360` that can still reach the Deadmines evals (a `t1`
 * climbed to `t2`, or a declared `t3`) is waiting on, said beside its verdict so
 * `--status` and `--dry-run` never leave its missing Deadmines attempts
 * unexplained; empty when there is nothing to say, a pinned `t2` included.
 */
function deadminesWait(s: Pick<ModelState, "tier" | "declaredTier" | "earnedDeadmines">, policy: Pick<SchedulingPolicy, "promoteAtLevel" | "deadminesAtLevel">): string {
  if (s.earnedDeadmines || TIER_TABLE[s.tier].runsPerEpisode.e360 === 0) return "";
  const top = effectiveTier(s.declaredTier, { promotion: true, deadmines: true });
  if (TIER_TABLE[top].runsPerEpisode["deadmines-solo"] === 0) return "";
  return `; not yet on deadmines-solo: ${ineligibleWhy("deadmines-solo", policy, s.declaredTier, s.tier)}`;
}

/** What a model owing nothing does with a spare account, said after its verdict; empty for `idle: "none"`. */
function idleWords(s: ModelState): string {
  if (s.idle === "none") return "";
  const held = idleHold(s);
  return held !== undefined ? ` — no freeplay session: ${held}` : " — unlimited sessions while its account is idle";
}

/**
 * Why the model may not start a fresh freeplay session now, or undefined. Its
 * paused freeplay run is resumed, never started over, and one character per
 * model keeps a session from starting beside a live scored or freeplay run of
 * it under another entry.
 */
function idleHold(s: ModelState): string | undefined {
  if (s.paused !== undefined && s.paused.episode === "freeplay") {
    const spent = s.paused.episodeElapsedMs !== null ? `${Math.round(s.paused.episodeElapsedMs / 60_000)}m` : "?m";
    return `paused run ${s.paused.runId} (${s.paused.reason}, ${spent} elapsed) is resumed, never started over`;
  }
  if (s.playing !== undefined) return `${s.playing.runId} ${s.playing.resuming === true ? "resumes" : "plays"} this model (one character per model)`;
  // Another entry's scored run holds it; another entry's freeplay character does not, being its own.
  if (s.siblingPlaying !== undefined && EPISODES[s.siblingPlaying.episode].scored) {
    return `${s.siblingPlaying.runId} plays this model under another entry (one character per model)`;
  }
  return undefined;
}

/**
 * Whether this model's idle axis wants a spare account. Asked of a verdict
 * rather than folded into it: "does it owe anything" and "does it want extra
 * work" are two questions, and only the second is a property of the entry.
 */
export function wantsIdle(v: Verdict, s: ModelState): boolean {
  // A held (`campaignOnly`) entry may have freeplay work (operator,
  // 2026-11-15); a probe-only driver's entry never has (its idle is `none`).
  return v.verdict === "free" && s.idle !== "none" && (s.probeOnly !== true || s.campaignOnly === true) && idleHold(s) === undefined;
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

/** Extras made so far across every episode, which is what numbers the next one. */
export function extrasSoFar(s: ModelState): number {
  return STATS_EPISODES.reduce((n, ep) => n + (s.perEpisode[ep]?.extras ?? 0), 0);
}

/** Priority order of an episode: the scored tiers as they are declared, freeplay last. */
function episodeOrder(ep: EpisodeId): number {
  return EPISODE_IDS.indexOf(ep);
}

export interface NextJobsOptions {
  /**
   * Why the pool has no accounts this tick when something outside the policy
   * has reserved them — today, a manual queue job waiting for one. A pick
   * with nowhere to go is otherwise dropped in silence, which is how a
   * reserved pool read as "the models are just not schedulable today".
   */
  poolHeld?: string;
  /**
   * Scored episodes are held, and why (`SCORED_EPISODES_WAIT`, config.ts):
   * a model that owes a counted run is held with this reason instead of
   * picked, and is otherwise treated as owing none, as with the evals group
   * off, so its probes and idle work still go. Absent: open, as today.
   */
  scoredGate?: string;
  /**
   * The enabled, UNPINNED campaigns the policy may schedule, in
   * declaration order. A pinned campaign is a pinned job and never appears
   * here. Absent means no campaign work, which is what an older config gets.
   */
  campaigns?: readonly Campaign[];
  /** Probe runs on disk, counted or not: what a campaign's remaining work is derived from. */
  probeRuns?: readonly ProbeRun[];
  /** The scheduling policy; only the parts `schedulability` reads. */
  policy?: SchedulingPolicy;
  /**
   * Those of `running` whose run in flight holds the model's other entries
   * (`schedulability`): a scored or freeplay one, never a probe. Absent,
   * every one does.
   */
  holding?: ReadonlySet<string>;
  /**
   * Whether the deployment's evals group is on (`viewer/groups.ts`).
   * Off, the policy picks no scored episode and no campaign work, and a model
   * that would owe a counted run is treated as owing none, so its idle work
   * (an `unlimited` freeplay session) is what it gets. It changes what is
   * launched, never what is counted. Absent is on.
   */
  evals?: boolean;
}

/**
 * The policy's picks for the free pool accounts, in priority order:
 * (1) models with zero counted runs on any eligible episode, (2) the shorter
 * episode first, (3) fewest counted runs toward target, ties by roster order.
 * One job per model. `running` holds roster names with a run in flight.
 *
 * Every pick draws from the one pool of game accounts: which provider
 * credential it runs on, and whether that credential has a slot, is the
 * caller's (`planPolicyHeld` in infra/run-fleet-plan.ts), which passes over a
 * pick with no room and asks again. When every account still free has
 * nothing schedulable left, a model with `idle: "unlimited"` gets its
 * freeplay session.
 */
export function planNextJobs(
  states: readonly ModelState[],
  freeAccounts: readonly string[],
  running: ReadonlySet<string> = new Set(),
  opts: NextJobsOptions = {},
): { jobs: NextJob[]; held: HeldPick[] } {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const evals = opts.evals !== false;
  const campaigns = evals ? (opts.campaigns ?? []) : [];
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
  const gated: HeldPick[] = [];
  const rehearsalHeld: HeldPick[] = [];
  states.forEach((s, order) => {
    const sched = schedulability(s, running, policy, opts.holding ?? running);
    const open = verdictForGroups(sched, evals);
    // Owed episodes a rehearsal has not cleared (`rehearsalHold`) are said
    // and passed over; a model that owes nothing else does what a model
    // owing nothing does, as under a closed gate.
    const owedEps = s.eligible.filter((ep) => {
      const st = s.perEpisode[ep];
      return st !== undefined && st.counted < st.target;
    });
    const unheld = owedEps.filter((ep) => rehearsalHold(ep, s.harness, policy) === null);
    const onlyHeld = open.verdict === "eval" && owedEps.length > 0 && unheld.length === 0;
    // A closed gate holds a model that owes a counted run, with the reason,
    // and lets it do what a model owing nothing does.
    const v = (opts.scoredGate !== undefined || onlyHeld) && open.verdict === "eval" ? verdictForGroups(sched, false) : open;
    if (v !== open && opts.scoredGate === undefined) {
      for (const ep of owedEps) rehearsalHeld.push({ name: s.name, episode: ep, why: rehearsalHold(ep, s.harness, policy)! });
    } else if (v !== open && owedEps[0] !== undefined) {
      gated.push({ name: s.name, episode: owedEps[0], why: opts.scoredGate! });
    }
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
      // Owed, and not yet cleared to score: said, and passed over, so the
      // model's other owed episodes still go.
      const hold = rehearsalHold(ep, s.harness, policy);
      if (hold !== null) {
        rehearsalHeld.push({ name: s.name, episode: ep, why: hold });
        continue;
      }
      cands.push({ s, ep, epOrder: episodeOrder(ep), fresh, counted: st.counted, order });
    }
  });
  const byPriority = (a: Cand, b: Cand): number => a.fresh - b.fresh || a.epOrder - b.epOrder || a.counted - b.counted || a.order - b.order;
  cands.sort(byPriority);
  extraCands.sort(byPriority);

  const jobs: NextJob[] = [];
  const held: HeldPick[] = [...gated, ...rehearsalHeld];
  const taken = new Set<string>();
  // One scored pick per model, whichever of its entries (`modelIdentityOf`):
  // two entries of one model on two providers fill one target, so the first
  // in priority order, roster order breaking a tie, takes it. When its
  // credential has no room the caller passes over it and asks again
  // (`planPolicyHeld`), and the next entry of the model gets the pick.
  const takenModels = new Set<string>();
  const accounts = [...freeAccounts];
  for (const c of cands) {
    if (taken.has(c.s.name) || takenModels.has(modelIdentityOf(c.s))) continue;
    taken.add(c.s.name);
    takenModels.add(modelIdentityOf(c.s));
    if (accounts.length === 0) {
      // Only said when the caller knows why the pool is empty. An ordinarily
      // busy pool stays silent.
      if (opts.poolHeld !== undefined) held.push({ name: c.s.name, episode: c.ep, why: opts.poolHeld });
      continue;
    }
    const st = c.s.perEpisode[c.ep]!;
    jobs.push({
      name: c.s.name,
      episode: c.ep,
      account: accounts.shift()!,
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
    if (accounts.length === 0) break;
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
    taken.add(w.model);
    // Attempt numbers come from the probing bucket, which exists precisely so a
    // second probe in one day gets a real run id rather than colliding.
    const st = s.perEpisode["probing"];
    jobs.push({
      name: w.model,
      episode: "probing",
      account: accounts.shift()!,
      attempt: (st?.attempts ?? 0) + 1,
      why: `campaign ${w.campaign}@${w.version} cell ${w.cell.id} arm ${w.arm.id} (${w.done}/${w.want}${w.maxAttempts !== undefined ? `, attempt ${w.attempts + 1}/${w.maxAttempts}` : ""})`,
      probe: { campaign: w.campaign, version: w.version, cell: w.cell.id, arm: w.arm.id },
    });
  }
  // Idle work: lowest priority, only for accounts nothing else wanted, so an
  // unlimited session never takes an account a counted run could have used.
  for (const c of extraCands) {
    if (accounts.length === 0) break;
    // A scored pick of the model this tick holds its freeplay, as a scored run playing does.
    if (taken.has(c.s.name) || takenModels.has(modelIdentityOf(c.s))) continue;
    taken.add(c.s.name);
    const st = c.s.perEpisode[c.ep]!;
    const n = extrasSoFar(c.s);
    jobs.push({
      name: c.s.name,
      episode: c.ep,
      account: accounts.shift()!,
      attempt: st.attempts + 1,
      why: `extra #${n + 1}: unlimited session (${c.s.campaignOnly === true ? "campaignOnly: no targets" : "targets met"}; one continuous session, idle watchdog only)`,
    });
  }
  return { jobs, held };
}

/**
 * `planNextJobs` without the `held` explanation: the picks alone, for the
 * tests. The supervisor calls `planNextJobs` itself (`infra/run-fleet-plan.ts`).
 */
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
 * The groups are the credential providers a model's runs are served through,
 * a metered provider split by billing (a free model takes only a free
 * credential, a paid one only a paid credential), because a run can only
 * take a slot on a credential of its own group. A group's concurrency is the
 * slots its enabled credentials carry, under the pool's account cap and the
 * driver's per-host session cap.
 *
 * Two simplifications worth stating rather than hiding. The groups actually
 * drain in *parallel*, so the true exhaustion time is the largest term and
 * this sum is a pessimistic bound. And every group shares the one account
 * pool, so their concurrencies overlap. Both are deliberate: the number is a
 * planning aid ("is tonight enough?"), and a queueing model would be a worse
 * answer to that question than one an operator can check in their head. A
 * group with work and no credential or account to run it on has no ETA at
 * all, and the whole figure goes null rather than pretend.
 */
export interface OutstandingGroup {
  /** A credential provider, `<provider> (free|paid)` for a metered one, or `none` for a run that needs no credential. */
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
  /** Wall clock to exhaust `lower`, or null when some of it has nowhere to run. */
  etaLowerMs: number | null;
  etaUpperMs: number | null;
  breakdown: OutstandingGroup[];
}

export interface OutstandingInput {
  /** The projection — `modelStates` output. */
  states: readonly ModelState[];
  /** Roster names outside the policy (pinned, or carrying an objective). */
  excluded?: Iterable<string>;
  /** How many live sessions the account pool carries (`accounts.max`, else its size). */
  accounts?: number;
  /** The configured credentials; the enabled ones' slots are a group's concurrency. */
  credentials?: readonly Credential[];
  /** `policy.maxSessions`: the per-driver host cap. */
  maxSessions?: Record<string, number>;
}

/** The group a model's runs queue in: its provider, a metered one split by billing. */
function outstandingGroupOf(s: Pick<ModelState, "provider" | "billing">): string {
  const p = s.provider ?? null;
  if (p === null) return "none";
  return providerById(p)?.bill === "metered" ? `${p} (${s.billing})` : p;
}

/** The whole metric, pure over the same inputs the projection was built from. */
export function outstandingWork(input: OutstandingInput): Outstanding {
  const excluded = new Set(input.excluded ?? []);
  const accounts = input.accounts ?? 0;
  const concurrencyOf = (s: ModelState): number => {
    const p = s.provider ?? null;
    if (p === null) return accounts;
    const slots = (input.credentials ?? []).filter((c) => c.enabled && c.provider === p && credentialCarries(c, s.billing)).reduce((n, c) => n + c.slots, 0);
    const driver = harnessDriver(s.harness)?.id;
    const cap = driver !== undefined ? input.maxSessions?.[driver] : undefined;
    return Math.min(accounts, slots, cap ?? Number.POSITIVE_INFINITY);
  };

  const groups = new Map<string, OutstandingGroup>();
  const groupFor = (s: ModelState): OutstandingGroup => {
    const name = outstandingGroupOf(s);
    let g = groups.get(name);
    if (g === undefined) {
      g = { group: name, concurrency: concurrencyOf(s), lowerRuns: 0, upperRuns: 0, lowerMinutes: 0, upperMinutes: 0 };
      groups.set(name, g);
    }
    return g;
  };

  // One model's entries on two providers owe one target between them
  // (operator, 2026-11-16): each model is counted once, as whichever of its
  // entries owes the most, so the figure never owes a run twice.
  const owedBy = (s: ModelState): number => POLICY_EPISODES.reduce((n, ep) => n + Math.max(0, (s.perEpisode[ep]?.target ?? 0) - (s.perEpisode[ep]?.counted ?? 0)), 0);
  const counted = new Map<string, ModelState>();
  for (const s of input.states) {
    if (excluded.has(s.name) || s.retired !== undefined) continue;
    const key = modelIdentityOf(s);
    const prior = counted.get(key);
    if (prior === undefined || owedBy(s) > owedBy(prior)) counted.set(key, s);
  }
  for (const s of counted.values()) {
    const g = groupFor(s);
    // The upper bound's bet is that the model climbs: what its tier would buy
    // if it earned promotion. For a `t0` model the bet is off — the ladder is
    // held — so its upper and lower agree, which is the honest reading of a
    // trial: one run, and no more without an operator deciding.
    const climbed = TIER_TABLE[effectiveTier(s.declaredTier, { promotion: true, deadmines: true })].runsPerEpisode;
    // The level episodes only: a task episode's attempts wait on the
    // scored gate and on rehearsals the operator reads, so they are not yet
    // work this figure can put a clock on.
    for (const ep of POLICY_EPISODES) {
      if (!isLevelEpisode(ep)) continue;
      const st = s.perEpisode[ep];
      if (st === undefined) continue;
      const owed = Math.max(0, climbed[ep] - st.counted);
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
      ? "eta unknown — some of it has no credential or account to run on"
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
