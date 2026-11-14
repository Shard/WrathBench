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

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { openRunDb, RUN_DB_JOURNAL_FILE, RUN_DB_WAL_FILE } from "./rundb";
import { bestLevelOf, fanoutLead, fanoutReadings, readRunRow } from "./run-reader";
import { harnessSeries } from "./comparability";
import { DEFAULT_DRIVER, defaultCompactWindowOf, driverEntry, eitherHas, entryOf, harnessDriver, isProbeOnlyDriver, probeOnlyRefusal } from "./drivers";
import { AUTO_COMPACT_WINDOW, DEFAULT_CLAUDE_TOKEN_ENV, DRIVERS, defaultLoopOf, harnessOf, isDriver, isTokenEnvName, isUnscoredDriverName, type Driver, type Harness } from "./config";
import { EPISODE_IDS, EPISODES, isEpisodeId, isLevelEpisode, isScoredEpisode, isTaskEpisode, type EpisodeId, type ScoredEpisodeId } from "./episodes";
import { campaignWork, partyAttempt, type Campaign, type ProbeIdentity, type ProbeRun } from "./campaigns";
import { badEvidenceReason, neverStale, OFFLINE_PAUSE, PARTY_PAUSE, SUBSCRIPTION_PAUSE, resumesOnPause, staleAfterMs } from "./lapse";
import { parseSubscriptionUsage, type SubscriptionUsage } from "./subscription-usage";
import { billingOf, type Billing } from "./model-cost";
import { credentialCarries, providerById, providerOfModel, type Credential } from "./credential-slots";
import { hostOfBase, isOpenCodeGoBase, platformOfBase } from "./platform";
import { parseRouting, type RoutingSpec } from "./routing";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { HEARTBEAT_DEAD_MS, HEARTBEAT_FILE, heartbeatAt, heartbeatOwner } from "./trajectory";
import { RunFactCache } from "./run-fact-cache";
import { servingSchema, type ServingSpec } from "./serving";
import { goneReason, modelGoneOf, readModelListsSidecar, type ModelGone, type ModelListsSidecar } from "./model-lists";

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

/*
 * `t2` also buys three attempts on each Deadmines id (operator, 2026-11-14):
 * the same threshold for every model, so no new word. The five-agent id
 * (`deadmines`) is bought only where the roster entry opts in as well
 * (`RosterModel.deadmines`), because it needs five sessions on one
 * credential at once; `targetFor` applies that.
 */
export const TIER_TABLE: Record<Tier, TierSpec> = {
  t0: { runsPerEpisode: { e90: 1, e360: 0, deadmines: 0, "deadmines-solo": 0 }, promotesTo: null, label: "trial" },
  t1: { runsPerEpisode: { e90: 3, e360: 0, deadmines: 0, "deadmines-solo": 0 }, promotesTo: "t2", label: "standard" },
  t2: { runsPerEpisode: { e90: 3, e360: 1, deadmines: 3, "deadmines-solo": 3 }, promotesTo: null, label: "long" },
};

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
 * - `unlimited` — a freeplay session, unscored, governed by its idle watchdog.
 */
export const IDLE_MODES = ["none", "unlimited"] as const;
export type IdleMode = (typeof IDLE_MODES)[number];

export interface SchedulingPolicy {
  /** The level an e90 run must reach to promote the model up its tier. */
  promoteAtLevel: number;
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

/** The trajectory record the loop appends for a model turn (viewer/archive-dir.ts). */
export const MODEL_RESPONSE_RECORD = "response";
/** The trajectory record a pause writes (`Trajectory.setPause`). */
export const PAUSE_RECORD = "pause";
/** The trajectory record `run.ts --resume` writes: where the run's next segment starts. */
export const RESUME_RECORD = "resume";

/**
 * Pause reasons that ride no backoff ladder: the fleet stopped under the run
 * (`operator-pause`), its runner died before it could write a verdict
 * (`offline`, derived and never on disk), or a credential's usage budget
 * stopped a freeplay run at the freeplay threshold (`subscription-budget`,
 * operator 2026-10-16), or a party member was paused because another member
 * paused first (`party-paused`, whose party waits on that member's own
 * pause). All four are the harness's own doing, so the pause
 * streak neither counts them nor resets on them; `resumeNotBefore` brings the
 * first two and the fourth back without cooling and the third at its window's reset, under
 * the lane gate. Every other pause — a provider's refusal, a dead login, a CLI
 * failing on its host, a stalled observation — is on the ladder.
 */
export const LADDER_EXEMPT_PAUSES: ReadonlySet<string> = new Set(["operator-pause", OFFLINE_PAUSE, SUBSCRIPTION_PAUSE, PARTY_PAUSE]);

/** Whether a pause of this reason cools on the backoff ladder and counts toward its streak. */
export function onPauseLadder(reason: unknown): boolean {
  return typeof reason === "string" && !LADDER_EXEMPT_PAUSES.has(reason);
}

/**
 * Whether a pause record counts toward the streak: its reason is on the
 * ladder and its provider did not state a reset. A pause that carries the
 * provider's `notBefore` waits for that instant once, off the ladder
 * (`resumeNotBefore`), so it neither counts nor resets the streak — without
 * that, a daily allowance spent at noon ran the whole ladder out on refusals
 * the provider had already announced, hours before the reset. Only records
 * the runner writes with a numeric `notBefore` are exempt: an older pause
 * whose reset sits in its detail text is read exactly as it always was.
 */
export function pauseCountsOnLadder(rec: { reason?: unknown; notBefore?: unknown }): boolean {
  return onPauseLadder(rec.reason) && typeof rec.notBefore !== "number";
}

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

/** A roster entry as the projection needs it: identity plus the two optional overrides. */
export interface RosterModel {
  /** The roster name; the key everything else hangs off. */
  name: string;
  model: string;
  effort?: string;
  /**
   * The CLI harness's compaction window as the entry declares it
   * (`parseEntryCompactWindow`): a canonical window, `"auto"` where the
   * driver defaults another, or absent for the driver's default — the CLI's
   * `auto`, or claude-code's 300k. Part of the entry's identity, like effort
   * (`entryOwnsWindow`).
   */
  compactWindow?: string;
  driver?: string;
  /** A local build's serving block (`serving.ts`); absent on a hosted entry. Identity, like effort. */
  serving?: ServingSpec;
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
  /** Runs only as a probe campaign's assignment (`FleetRosterEntry.campaignOnly`): projected like a probe-only driver's entry. */
  campaignOnly?: true;
  /** Opts into the five-agent Deadmines episode (`FleetRosterEntry.deadmines`), which its tier then buys like the one-agent one. */
  deadmines?: true;
}

/**
 * A job as the membership predicate needs it: which roster names it holds, and
 * the account it is pinned to when it is pinned to one.
 *
 * Deliberately structural. The supervisor's `FleetJob` carries a spawn's worth
 * of fields and lives beside the process path; the viewer parses a narrow
 * slice of the same file at its own boundary. Both can satisfy this, so the
 * question "is this roster name the policy's to schedule" has one answer
 * rather than one per reader.
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
  /**
   * Set when the verdict came from the trajectory's `termination` record
   * because the row has none: the runner recorded its end and could not
   * write the row (`Trajectory.setTermination`). The supervisor writes it
   * into the row (`repairRecordedTerminations`); absent on every other run.
   */
  recordedTermination?: { reason: string; detail: string | null; at: number };
  model: string;
  effort: string | null;
  /**
   * The CLI compaction window the run was stamped with. Absent or null
   * is the CLI's own `auto` — every run that set none, and every run written
   * before the field existed.
   */
  compactWindow?: string | null;
  episode: EpisodeId;
  episodeOverride: boolean;
  harnessVersion: string | null;
  /** `harnessSeries(harnessVersion)`; what the schedule keys on. */
  harnessSeries: string | null;
  /**
   * The agent loop and its `yield`, as the comparability tuple stamped them:
   * absent is the snippet loop with no `yield`, which every run stamped
   * before the keys existed is. A target counts only the runs on the loop
   * its entry now launches (`countsTowardTarget`).
   */
  loop?: "program";
  yield?: true;
  /**
   * The local build the run stated (`comparability.serving`), or null when it
   * stated none. Always set by `readRunFact`, so a roster entry's own build
   * (or its lack of one) decides whether the run is its (`entryOwnsRun`).
   */
  serving?: ServingSpec | null;
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
  /**
   * No termination row, not paused, and a sign of a live owner: a trajectory
   * that grew recently, or a fresh heartbeat (a run waiting on a slow request
   * writes nothing to its trajectory but keeps beating).
   */
  live: boolean;
  /**
   * When the run's owner last beat (`heartbeat` in the run directory), or null
   * when there is no such file: the owner exited cleanly and removed it, or the
   * run was written by a runner that predates the heartbeat.
   */
  heartbeatAt?: number | null;
  /** The run's idle watchdog (`watchdogs.idleMs`), null when disabled or unrecorded. */
  idleMs?: number | null;
  /**
   * Read from `archive/` (`readRunFacts` with `includeArchived`). The scheduler
   * reads such a run for the ladder and for attempt numbers and for nothing
   * else: it is not under the runs directory any more, so nothing can resume it.
   */
  archived?: boolean;
  /**
   * Set while the run is paused: `pause_reason` in run.sqlite with
   * no termination. `at` is meta.json's pause mark when present, else the
   * trajectory's mtime; `count` is the pause streak — the consecutive ladder
   * pauses since the last segment that made a turn, at least 1 — which is what
   * the resume cadence indexes; `episodeElapsedMs` is the clock the run will
   * continue from (null for a pause written before the mark existed).
   */
  pause: {
    reason: string;
    at: number;
    count: number;
    episodeElapsedMs: number | null;
    /**
     * Not resumable before this instant. On the supervisor's derived `offline`
     * pause, when the run is provably ownerless; on any other, the provider's
     * stated reset off the pause mark (adapter.ts), which the resume waits
     * for once and the streak does not count (`pauseCountsOnLadder`).
     */
    notBefore?: number;
  } | null;
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
   * The campaign definition version the run stamped, the roster name the
   * fleet launched it as, and the campaign arm it ran — absent on a run from
   * before each was recorded, which then belongs to no campaign square
   * (`probeRunsOf` reads stamps only). Optional so a fact built by hand need
   * not spell them.
   */
  campaignVersion?: number | null;
  ref?: string | null;
  arm?: string | null;
  /**
   * The party this run is a member of (`config.party`): its id — the attempt's
   * run-id stem, shared by every member — which member, and the size. Null on
   * every run that is not a party member; optional so a fact built by hand
   * need not spell it. A party is one attempt, so a campaign square tallies
   * parties by this id (`campaignSquares`) and the resume planner brings a
   * paused party back whole.
   */
  party?: { id: string; member: string; size: number } | null;
  /**
   * Every account a fan-out run holds (`config.fanout.accounts`): one agent
   * driving several characters, each on an account of its own, the first of
   * which is also `account`. Null on every other run; optional so a fact
   * built by hand need not spell it. What the fleet holds for the run's whole
   * life, live or paused (`accountsOfRun`).
   */
  fanoutAccounts?: string[] | null;
  /**
   * The world the run played on (`config.world`): a world per eval's id, or
   * `shared`. Null on a run written before worlds, which played on the shared
   * world; optional so a fact built by hand need not spell it. A label, never
   * a key: nothing groups or counts by it.
   */
  world?: string | null;
  /**
   * The credential this run took a slot on (`RunConfig.credential`), or null
   * on a run that recorded none (a 0.5 run, one launched by hand without
   * `--credential`). Read off the
   * run's own config for the same reason `campaign` is: the fleet counts live
   * runs per credential, and that count has to survive a supervisor restart,
   * which nothing held in memory does.
   */
  credential: string | null;
  /** The run's driver (`config.driver`), or null when meta.json names none. Optional so a fact built by hand need not spell it. */
  driver?: string | null;
  /**
   * The newest subscription usage reading the run recorded (meta.json's
   * `subscriptionUsage`), or null. What a credential's `usage` budget reads,
   * newest per credential (operator, 2026-10-16).
   */
  credentialUsage?: SubscriptionUsage | null;
  /**
   * When a response on this run was last billed to the provider's balance
   * past the allowance (meta.json's `credentialOverage`, OpenCode Go's
   * `billing_source: "balance"`), or null. The fleet holds its credential
   * until a usage read shows room after it (`FleetGoUsage.noteOverages`).
   */
  credentialOverageAt?: number | null;
  /**
   * The provider's own reported charge on this run's responses, in dollars,
   * per UTC day (`YYYY-MM-DD`) the response was recorded on: what a `spend`
   * budget sums. Absent on a fact built by hand; empty on a run whose
   * provider reports no charge.
   */
  spendByDay?: Record<string, number>;
  /**
   * The segments `run.ts --resume` started, per UTC day of their `resume`
   * record: with a start on that day, what a `runs` budget counts. Absent on a
   * fact built by hand.
   */
  resumesByDay?: Record<string, number>;
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
  /** The entry's declared CLI compaction window (`RosterModel.compactWindow`); absent is its driver's default. */
  compactWindow?: string;
  /** The entry's local build (`RosterModel.serving`); absent on a hosted entry. */
  serving?: ServingSpec;
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
  /**
   * The entry's driver is probe-only (`DriverEntry.probeOnly`), or the entry
   * says `campaignOnly`: no target, no eligible episode and no idle work, so
   * only a probe campaign runs it.
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

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
/** How much of a trajectory is held in memory at once while counting. */
const READ_CHUNK = 1 << 22;

/**
 * Where a pause streak stands partway through a trajectory. A segment is the
 * stretch between two `resume` records (the first starts at byte zero):
 * `closed` is the streak as the segments already closed left it, and `turn`
 * and `pause` are what the open one has shown so far.
 */
interface StreakFold {
  closed: number;
  turn: boolean;
  pause: boolean;
}

/**
 * The pause streak with the open segment as the newest: the ladder pauses
 * since the last segment that made a turn, that segment's own pause included.
 * A segment with a `response` in it resets the count — its pause, when it is
 * on the ladder, is the first of a new streak — and one with none adds its
 * pause to the streak before it. An exempt pause (`pauseCountsOnLadder`) adds
 * nothing and resets nothing. A segment's turns count wherever they fall in
 * it: a runner stopped mid-turn flushes its last `response` after the pause
 * record.
 */
function streakOf(s: StreakFold): number {
  const own = s.pause ? 1 : 0;
  return s.turn ? own : s.closed + own;
}

/** A record a scanner watches, as far as the counts, the streak and the spend read it. */
type WatchedRecord = { t: string; reason?: unknown; notBefore?: unknown; kind?: unknown; ts?: unknown; cost?: unknown };

/** The UTC day (`YYYY-MM-DD`) an instant falls on: what a credential's per-day budget counts in. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function foldStreak(s: StreakFold, rec: WatchedRecord): void {
  if (rec.t === MODEL_RESPONSE_RECORD) s.turn = true;
  else if (rec.t === PAUSE_RECORD) s.pause ||= pauseCountsOnLadder(rec);
  else if (rec.t === RESUME_RECORD) {
    s.closed = streakOf(s);
    s.turn = false;
    s.pause = false;
  }
}

/** `readSync` in its positional form: fill `buffer` from `position` on, answering the bytes read. */
export type ReadAt = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;

/**
 * How a scanner reads its file. Both default to what production uses; they
 * exist so a test can make a few-kilobyte file span hundreds of reads, or make
 * a read fail, instead of writing gigabytes to reach either.
 */
export interface ScanReads {
  /** Bytes per read (`READ_CHUNK`). */
  chunk?: number;
  /** The read itself (`readSync`). */
  read?: ReadAt;
}

/** What one pass over a trajectory answers. */
export interface RecordTally {
  /** Records of each kind asked for; a kind nothing carries is zero, never absent. */
  counts: Map<string, number>;
  /** The pause streak (`streakOf`), or null when the scanner was not asked to fold it. */
  pauseStreak: number | null;
  /**
   * The provider's own reported charge (`usage.cost` on a `response`) per UTC
   * day of the record, when `response` is among the kinds counted: what a
   * credential's `spend` budget sums. Empty when no response carried one.
   */
  spendByDay: Record<string, number>;
  /**
   * `resume` records per UTC day, when the scanner folds the pause streak
   * (the only time it reads them): each is a segment a resume started. Empty
   * otherwise.
   */
  resumesByDay: Record<string, number>;
}

/** The per-day sums a scanner keeps beside its counts: spend and resumes. */
interface DayTally {
  spend: Record<string, number>;
  resumes: Record<string, number>;
}

/**
 * Record counts for a trajectory without holding the file in memory, resumably.
 *
 * A count is monotone, so folding only the bytes appended since the last pass
 * gives the same answer as re-reading the file whole. That is the whole reason
 * this is an object: `readRunFact` is memoised on (size, mtime), which hits for
 * every finished run and structurally MISSES for a live one, whose trajectory
 * grows every second. The live runs reach hundreds of megabytes and
 * `/api/models` and `/api/fleet` are polled every five seconds, so re-reading
 * from byte zero on each poll blocked the viewer's event loop for one to three
 * seconds at a time (measured: 844ms and 895ms for the two live trajectories on
 * 2026-09-04, against ~0ms for everything else `readRunFact` does).
 *
 * The pause streak, when asked for, is the same kind of fold: a left fold over
 * the records in order (`foldStreak`), so resuming it from where the last pass
 * stopped gives the same answer too.
 *
 * A trailing half-written line is held in `pending` and re-read with the next
 * chunk rather than counted, so nothing is counted twice across a resume. A
 * file that SHRANK is not resumable at all — that is truncation or replacement
 * — and the check for it belongs to whoever holds the scanner
 * (`tallyRecordsCached`), which throws the scanner away and starts fresh.
 *
 * `countRecords` below is the one-shot form, with the contract it always had.
 *
 * Reading is `readSync` over a fixed buffer rather than the whole-file string
 * `readFileSync` built: the same discipline `RunTotalsScanner` follows in
 * `runner/viewer/tail.ts`, but not the same code — that one reads
 * asynchronously through `Bun.file`, and this path is sync all the way up
 * through the fleet supervisor. Splitting happens on bytes, which is safe
 * because 0x0A cannot occur inside a UTF-8 multi-byte sequence. The bytes are
 * searched for the prefilter's needles rather than walked one at a time, and
 * only the lines a needle falls in are cut out (`foldLines`): the same lines,
 * in the same order, as taking every line and dropping the ones without one.
 *
 * `from` starts the count at a byte other than zero, and nothing before it is
 * read: the roster counts one attempt's turns as the records past the size the
 * trajectory had when that attempt launched (`turnsSince`). Such a scanner is
 * one-shot. It never goes into a `CountCache`, whose reuse check knows nothing
 * of a starting byte and would answer its partial counts as the whole file's.
 */
export class RecordCountScanner {
  readonly path: string;
  readonly kinds: readonly string[];
  /** Whether this scanner folds the pause streak as well as counting. */
  readonly pauseStreak: boolean;
  /** The records worth parsing: the kinds counted, and the ones the streak reads. */
  private readonly watched: ReadonlySet<string>;
  /** The prefilter, as bytes: the record names are ASCII, so this is the same test. */
  private readonly needles: Buffer[];
  private readonly counts: Map<string, number>;
  private readonly streak: StreakFold = { closed: 0, turn: false, pause: false };
  private readonly days: DayTally = { spend: {}, resumes: {} };
  /** Bytes folded as complete lines; where the next scan resumes. */
  private consumed = 0;
  /** Bytes after the last newline: a record still being written, never counted. */
  private pending: Buffer = EMPTY;
  private readonly chunk: number;
  private readonly read: ReadAt;
  /** Why the last scan answered null. */
  private failed: unknown = undefined;

  constructor(
    path: string,
    kinds: readonly string[],
    opts: { pauseStreak?: boolean; from?: number } & ScanReads = {},
  ) {
    this.path = path;
    this.kinds = [...kinds];
    this.pauseStreak = opts.pauseStreak === true;
    this.watched = new Set([...this.kinds, ...(this.pauseStreak ? [MODEL_RESPONSE_RECORD, PAUSE_RECORD, RESUME_RECORD] : [])]);
    this.needles = [...this.watched].map((k) => Buffer.from(`"${k}"`, "utf8"));
    this.counts = new Map<string, number>(this.kinds.map((k) => [k, 0]));
    this.consumed = opts.from ?? 0;
    this.chunk = opts.chunk ?? READ_CHUNK;
    this.read = opts.read ?? readSync;
  }

  /** How far this scanner has read, complete lines and the partial one. */
  get size(): number {
    return this.consumed + this.pending.length;
  }

  /** Why the last scan answered null (the stat's or the read's error), for a caller that logs it; undefined after one that answered. */
  get failure(): unknown {
    return this.failed;
  }

  /** The record a line holds when it is one this scanner watches, else null. */
  private recordOf(line: Buffer): WatchedRecord | null {
    if (line.length === 0) return null;
    // Cheap prefilter, then the honest parse: the `t` key can sit anywhere.
    if (!this.needles.some((n) => line.includes(n))) return null;
    return this.parsed(line);
  }

  /** The parse alone, for a line already known to carry a needle. */
  private parsed(line: Buffer): WatchedRecord | null {
    let rec: { t?: unknown; reason?: unknown; notBefore?: unknown; kind?: unknown; ts?: unknown; usage?: { cost?: unknown } } | null;
    try {
      rec = JSON.parse(line.toString("utf8")) as typeof rec;
    } catch {
      return null; // a torn line is not a record
    }
    const t = rec?.t;
    return typeof t === "string" && this.watched.has(t)
      ? { t, reason: rec!.reason, notBefore: rec!.notBefore, kind: rec!.kind, ts: rec!.ts, cost: rec!.usage?.cost }
      : null;
  }

  /** One line into a set of counts and a streak: the scanner's own, or a copy of them. */
  private apply(line: Buffer, counts: Map<string, number>, streak: StreakFold, days: DayTally = this.days): void {
    this.applyRecord(this.recordOf(line), counts, streak, days);
  }

  private applyRecord(rec: WatchedRecord | null, counts: Map<string, number>, streak: StreakFold, days: DayTally = this.days): void {
    if (rec === null) return;
    // Billed usage, a CLI's compaction call included: whatever the provider charged.
    if (rec.t === MODEL_RESPONSE_RECORD && counts.has(MODEL_RESPONSE_RECORD) && typeof rec.cost === "number" && Number.isFinite(rec.cost) && rec.cost > 0 && typeof rec.ts === "number") {
      const day = utcDay(rec.ts);
      days.spend[day] = (days.spend[day] ?? 0) + rec.cost;
    }
    // A segment a resume started: a `runs` budget counts it as a launch.
    if (rec.t === RESUME_RECORD && typeof rec.ts === "number" && Number.isFinite(rec.ts)) {
      const day = utcDay(rec.ts);
      days.resumes[day] = (days.resumes[day] ?? 0) + 1;
    }
    // A CLI's own summarisation call (pi's compaction, a `response` of kind
    // `compaction`) is billed usage, not a reply of the model's: it neither
    // counts as one nor ends a pause streak.
    if (rec.t === MODEL_RESPONSE_RECORD && rec.kind === "compaction") return;
    // Pre-seeded with exactly the kinds asked for, so a line counts toward at most one.
    const n = counts.get(rec.t);
    if (n !== undefined) counts.set(rec.t, n + 1);
    if (this.pauseStreak) foldStreak(streak, rec);
  }

  private take(line: Buffer): void {
    this.apply(line, this.counts, this.streak);
  }

  /**
   * Fold the complete lines of `buf` from `from` (a line start) through `end`
   * (the index of its last newline). Only the lines that carry a needle are
   * cut out and parsed: every other line is one `recordOf` drops unparsed
   * (empty, or no needle in it), so not cutting it out is the same answer.
   * Each needle is found by a native search that passes over any byte at most
   * once, and the lines are taken in file order, which the streak fold
   * depends on. A byte loop over every line cost ~36 s for the cluster's
   * ~15 GB of trajectories.
   */
  private foldLines(buf: Buffer, from: number, end: number): void {
    const needles = this.needles;
    const next = needles.map((n) => buf.indexOf(n, from));
    for (;;) {
      let at = -1;
      for (const p of next) if (p !== -1 && (at === -1 || p < at)) at = p;
      // A needle holds no newline, so one that starts past `end` is in the partial tail.
      if (at === -1 || at > end) break;
      const start = buf.lastIndexOf(NEWLINE, at) + 1;
      const stop = buf.indexOf(NEWLINE, at);
      this.applyRecord(this.parsed(buf.subarray(start, stop)), this.counts, this.streak);
      // The line is taken once, whatever else it carries: search on from the next one.
      for (let k = 0; k < next.length; k++) if (next[k] !== -1 && next[k]! <= stop) next[k] = buf.indexOf(needles[k]!, stop + 1);
    }
    this.consumed += end + 1 - from;
  }

  /**
   * Read whatever has been appended since the last call and answer the tally
   * so far. Null when the file cannot be read — the contract `countRecords`
   * has always had — with whatever was already folded left intact, so a later
   * call resumes rather than starting over.
   */
  scan(): RecordTally | null {
    this.failed = undefined;
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch (e) {
      this.failed = e;
      return null;
    }
    if (size <= this.size) return this.snapshot();
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      const chunk = Buffer.allocUnsafe(this.chunk);
      // The partial line, as the reads delivered it: joined once, when its
      // newline arrives, not re-joined and re-walked on every read it spans.
      const carry: Buffer[] = this.pending.length === 0 ? [] : [this.pending];
      let carried = this.pending.length;
      this.pending = EMPTY;
      let pos = this.consumed + carried;
      while (pos < size) {
        const n = this.read(fd, chunk, 0, Math.min(this.chunk, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const fresh = chunk.subarray(0, n);
        const first = fresh.indexOf(NEWLINE);
        // The read buffer is reused, so anything held past this iteration is copied.
        if (first === -1) {
          carry.push(Buffer.from(fresh));
          carried += n;
          continue;
        }
        let from = 0;
        if (carried > 0) {
          const line = Buffer.concat([...carry, fresh.subarray(0, first)]);
          this.take(line);
          this.consumed += line.length + 1; // the newline
          carry.length = 0;
          carried = 0;
          from = first + 1;
        }
        const last = fresh.lastIndexOf(NEWLINE);
        if (last >= from) this.foldLines(fresh, from, last);
        if (last + 1 < n) {
          carry.push(Buffer.from(fresh.subarray(last + 1)));
          carried = n - last - 1;
        }
      }
      this.pending = carried === 0 ? EMPTY : carry.length === 1 ? carry[0]! : Buffer.concat(carry);
    } catch (e) {
      this.failed = e;
      return null;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* a file that will not close still counted */
        }
      }
    }
    return this.snapshot();
  }

  /**
   * Fold the trailing bytes that carry no newline as a line of their own, then
   * answer. Only the one-shot form does this: a file whose last record was
   * written without a terminating newline still has that record counted,
   * exactly as the whole-file read always did. A resumable scanner must not
   * fold them, because the next append would count those bytes twice;
   * `scanAsWhole` gives the same answer without folding.
   */
  countOnce(): RecordTally | null {
    const tally = this.scan();
    if (tally === null) return null;
    if (this.pending.length > 0) {
      this.take(this.pending);
      this.consumed += this.pending.length;
      this.pending = EMPTY;
    }
    return this.snapshot();
  }

  /**
   * `scan`, answered the way `countOnce` answers: trailing bytes with no
   * newline that already parse as a whole record count, as a whole-file read
   * counts them. Only the answer includes them — they stay pending, so the
   * scanner still resumes from the same byte and the newline that completes
   * them later does not count them twice. A torn tail does not parse and
   * counts nowhere, exactly as before.
   */
  scanAsWhole(): RecordTally | null {
    const tally = this.scan();
    if (tally === null || this.pending.length === 0) return tally;
    const streak = { ...this.streak };
    const days: DayTally = { spend: { ...tally.spendByDay }, resumes: { ...tally.resumesByDay } };
    this.apply(this.pending, tally.counts, streak, days);
    return { counts: tally.counts, pauseStreak: this.pauseStreak ? streakOf(streak) : null, spendByDay: days.spend, resumesByDay: days.resumes };
  }

  /** A copy: the caller must never hold a reference to resumable state. */
  private snapshot(): RecordTally {
    return {
      counts: new Map(this.counts),
      pauseStreak: this.pauseStreak ? streakOf(this.streak) : null,
      spendByDay: { ...this.days.spend },
      resumesByDay: { ...this.days.resumes },
    };
  }
}

/** One pass over a trajectory, counting the records of each kind named. Null when unreadable. */
export function countRecords(path: string, kinds: readonly string[]): Map<string, number> | null {
  return tallyRecords(path, kinds)?.counts ?? null;
}

/** `countRecords`, answering the pause streak as well when asked for it. */
export function tallyRecords(path: string, kinds: readonly string[], opts: { pauseStreak?: boolean } = {}): RecordTally | null {
  if (!existsSync(path)) return null;
  return new RecordCountScanner(path, kinds, opts).countOnce();
}

/** A kept scanner, and the file it was built on: the inode and device it read. */
export interface CountEntry {
  scanner: RecordCountScanner;
  ino: number;
  dev: number;
}

/** Scanners a caller keeps between polls, keyed by trajectory path. */
export type CountCache = Map<string, CountEntry>;

/** The resumable form of `countRecords` (`tallyRecordsCached`). */
export function countRecordsCached(cache: CountCache, path: string, kinds: readonly string[]): Map<string, number> | null {
  return tallyRecordsCached(cache, path, kinds)?.counts ?? null;
}

/**
 * The resumable form: the same tally, folding only what has been appended
 * since this cache last saw the file.
 *
 * The truncation check lives here rather than inside `scan`, because a scanner
 * that has read past the end of its own file cannot answer for it at all: the
 * only safe response is a new scanner, and only the holder of the cache can
 * make one. Same for a file that is not the one the scanner read — rotated,
 * or replaced by a rename at any size, which a size check alone would fold on
 * from the old file's offset — so the entry carries the inode and device it
 * was built on. Same for a caller that changes what it asks for: the counts a
 * scanner carries are the counts of the kinds it was built with, and it folds
 * a streak only if it was built to.
 *
 * The file is checked before it is read, not after. A replacement landing
 * between that stat and the scanner's own open is one poll's answer; every
 * caller polls again, and the replaced file's size or mtime has moved, so its
 * next read starts fresh here. The supervisor re-reads every tick; the
 * collector re-derives whenever a trajectory's (size, mtime) moves.
 */
export function tallyRecordsCached(
  cache: CountCache,
  path: string,
  kinds: readonly string[],
  opts: { pauseStreak?: boolean } = {},
): RecordTally | null {
  let st: { size: number; ino: number; dev: number };
  try {
    st = statSync(path);
  } catch {
    cache.delete(path);
    return null;
  }
  let entry = cache.get(path);
  const usable =
    entry !== undefined &&
    entry.ino === st.ino &&
    entry.dev === st.dev &&
    st.size >= entry.scanner.size &&
    entry.scanner.pauseStreak === (opts.pauseStreak === true) &&
    entry.scanner.kinds.length === kinds.length &&
    entry.scanner.kinds.every((k, i) => k === kinds[i]);
  if (!usable) {
    entry = { scanner: new RecordCountScanner(path, kinds, opts), ino: st.ino, dev: st.dev };
    cache.set(path, entry);
  }
  // `scanAsWhole`, not `scan`: the cache is an optimisation, never a different
  // answer, and a whole-file read counts a final record with no newline.
  return entry!.scanner.scanAsWhole();
}

/**
 * Read one run directory into a fact, or null when it is not a stamped run.
 * Tolerant everywhere: a run mid-write or an unreadable database degrades to
 * "no data", never to an exception that costs the whole projection.
 */
/** `config.party` as a fact reads it: id, member and size, or null when the run is no party member. */
/** A fan-out run's accounts, off its config's grant; null when it has none. */
function fanoutAccountsOfConfig(f: { accounts?: unknown } | undefined): string[] | null {
  if (f === undefined || f === null || typeof f !== "object" || !Array.isArray(f.accounts)) return null;
  const accounts = f.accounts.filter((a): a is string => typeof a === "string" && a.length > 0);
  return accounts.length > 0 ? accounts : null;
}

/**
 * Every account a run holds: a fan-out run's whole grant, else the one it was
 * launched on, else none. The one answer the fleet asks of a run whenever an
 * account's holder matters.
 */
export function accountsOfRun(f: Pick<RunFact, "account" | "fanoutAccounts">): string[] {
  if (f.fanoutAccounts != null && f.fanoutAccounts.length > 0) return [...f.fanoutAccounts];
  return f.account === null ? [] : [f.account];
}

function partyOfConfig(p: { id?: unknown; member?: unknown; size?: unknown } | undefined): RunFact["party"] {
  if (p === undefined || p === null || typeof p !== "object") return null;
  const id = str(p.id);
  const member = str(p.member);
  const size = num(p.size);
  return id === null || member === null || size === null ? null : { id, member, size };
}

export function readRunFact(
  runsDir: string,
  runId: string,
  now = Date.now(),
  opts: { counts?: CountCache } = {},
): RunFact | null {
  const r = readRunReading(runsDir, runId, now, { ...opts, stampedOnly: true });
  return r !== null && isStamped(r) ? r : null;
}

/**
 * A run with no episode stamp: one launched by hand without `--episode`
 * (docs/RUNBOOK.md, "Ad-hoc launches", "A fan-out run, by hand"). Read the way
 * a fact is, and never one: no projection, ladder, target, attempt number or
 * public row reads it, so it is never a scored run, an owed one or a strike.
 * What reads it is what it costs the fleet while it runs — the credential it
 * bills (its slot, its runs and spend today, its usage readings) — through
 * `readFleetRuns`. Its `bestLevel` is not read and is null.
 */
export type UnstampedRun = Omit<RunFact, "episode"> & { episode: null };

/** A run directory as `readRunReading` reads it: a fact, or a run with no episode. */
export type RunReading = RunFact | UnstampedRun;

function isStamped(r: RunReading): r is RunFact {
  return r.episode !== null;
}

/**
 * `readRunFact`, and the same reading of a run with no episode stamp
 * (`UnstampedRun`). `stampedOnly` stops at the stamp, as `readRunFact` always
 * has, for a reader that has no use for the rest.
 */
function readRunReading(
  runsDir: string,
  runId: string,
  now: number,
  opts: { counts?: CountCache; stampedOnly?: boolean },
): RunReading | null {
  const dir = join(runsDir, runId);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return null;
  let meta: {
    harnessVersion?: unknown;
    startedAt?: unknown;
    config?: {
      model?: unknown;
      effort?: unknown;
      compactWindow?: unknown;
      extra?: unknown;
      account?: unknown;
      character?: unknown;
      campaign?: unknown;
      cell?: unknown;
      campaignVersion?: unknown;
      ref?: unknown;
      arm?: unknown;
      party?: { id?: unknown; member?: unknown; size?: unknown };
      fanout?: { accounts?: unknown };
      credential?: unknown;
      driver?: unknown;
      world?: unknown;
      watchdogs?: { episodeMs?: unknown; idleMs?: unknown };
    };
    comparability?: { episode?: unknown; episodeOverride?: unknown; effort?: unknown; compactWindow?: unknown; loop?: unknown; yield?: unknown; serving?: unknown };
    pause?: { reason?: unknown; at?: unknown; episodeElapsedMs?: unknown; notBefore?: unknown };
    subscriptionUsage?: unknown;
    credentialOverage?: { at?: unknown };
  };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as typeof meta;
  } catch {
    return null;
  }
  const stamp = meta.comparability?.episode;
  // No stamp at all is a hand launch; a stamp this reader does not know is not
  // a run it can read.
  const episode = isEpisodeId(stamp) ? stamp : stamp === null || stamp === undefined ? null : undefined;
  if (episode === undefined || (episode === null && opts.stampedOnly === true)) return null;
  const model = str(meta.config?.model);
  if (model === null) return null;
  const compactWindow = str(meta.comparability?.compactWindow) ?? str(meta.config?.compactWindow);

  const fact: RunReading = {
    runId,
    model,
    effort: str(meta.comparability?.effort) ?? str(meta.config?.effort),
    // Only when set: absent is `auto`, and every older fact reads the same.
    ...(compactWindow !== null ? { compactWindow } : {}),
    episode,
    episodeOverride: meta.comparability?.episodeOverride === true,
    harnessVersion: str(meta.harnessVersion),
    harnessSeries: harnessSeries(str(meta.harnessVersion)),
    // Only when stamped: absent is the snippet loop, and every older fact reads the same.
    ...(meta.comparability?.loop === "program" ? { loop: "program" as const } : {}),
    ...(meta.comparability?.yield === true ? { yield: true as const } : {}),
    serving: servingOfMeta(meta.comparability?.serving),
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
    idleMs: num(meta.config?.watchdogs?.idleMs),
    heartbeatAt: heartbeatAt(dir),
    campaign: str(meta.config?.campaign),
    cell: str(meta.config?.cell),
    campaignVersion: num(meta.config?.campaignVersion),
    ref: str(meta.config?.ref),
    arm: str(meta.config?.arm),
    party: partyOfConfig(meta.config?.party),
    fanoutAccounts: fanoutAccountsOfConfig(meta.config?.fanout),
    credential: str(meta.config?.credential),
    driver: str(meta.config?.driver),
    world: str(meta.config?.world),
    credentialUsage: parseSubscriptionUsage(meta.subscriptionUsage) ?? null,
    credentialOverageAt: num(meta.credentialOverage?.at),
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
  const kinds = [MODEL_RESPONSE_RECORD];
  // A caller that polls the same live run passes a scanner cache, which folds
  // only the bytes appended since its last read; everyone else reads once.
  const tally =
    opts.counts === undefined
      ? tallyRecords(jsonl, kinds, { pauseStreak: true })
      : tallyRecordsCached(opts.counts, jsonl, kinds, { pauseStreak: true });
  fact.modelResponses = tally?.counts.get(MODEL_RESPONSE_RECORD) ?? null;
  fact.spendByDay = tally?.spendByDay ?? {};
  fact.resumesByDay = tally?.resumesByDay ?? {};
  let pauseReason: string | null = null;

  // The run row and the best level, wherever the run keeps them (`run-reader.ts`).
  const r = readRunRow(dir, runId);
  if (r !== null) {
    fact.startedAt = num(r["started_at"]) ?? fact.startedAt;
    fact.endedAt = num(r["ended_at"]);
    fact.terminationReason = str(r["termination_reason"]);
    pauseReason = str(r["pause_reason"]);
  }
  // Nothing reads a level off a run with no episode, and it is the costly part of the read.
  fact.bestLevel = fact.episode === null ? null : bestLevelOf(dir, runId);
  const beating = fact.heartbeatAt != null && now - fact.heartbeatAt < HEARTBEAT_DEAD_MS;
  // A verdict the row lacks but the trajectory holds: the runner appends the
  // record before it writes the row, and a row write that gave up (after its
  // retries), or one still queued when the process was killed, leaves the
  // record alone. Without this the run reads as ownerless: a resuming lane
  // brings back a run that recorded its own end, and a scored run that paused
  // reads as unknown and is swept stale. Only for a run with no verdict, no
  // pause and no live owner, and only the file's tail: the record is among the
  // last few a run writes. A pause the tail does not show is taken from
  // meta.json's mark, which the pause path writes at once; a `resume` after
  // either means neither stands.
  let pauseFromRecord: TrajectoryVerdict | null = null;
  if (fact.terminationReason === null && pauseReason === null && !beating && mtime !== null) {
    const rec = verdictOfTrajectory(jsonl);
    if (rec?.kind === "terminated") {
      const at = rec.at ?? mtime;
      fact.terminationReason = rec.reason;
      fact.endedAt = at;
      fact.recordedTermination = { reason: rec.reason, detail: rec.detail, at };
    } else if (rec?.kind === "paused") {
      pauseReason = rec.reason;
      pauseFromRecord = rec;
    } else if (rec === null && typeof meta.pause?.reason === "string" && meta.pause.reason !== "") {
      pauseReason = meta.pause.reason;
    }
  }
  if (fact.endedAt === null && fact.terminationReason !== null) fact.endedAt = mtime;
  // A termination wins over a stale pause row (the --resume path clears the
  // row, but a run can also be classified by hand after a pause).
  if (pauseReason !== null && fact.terminationReason === null) {
    const recorded = pauseFromRecord?.kind === "paused" ? pauseFromRecord : null;
    const markedAt = num(meta.pause?.at) ?? recorded?.at ?? null;
    const statedReset = num(meta.pause?.notBefore) ?? recorded?.notBefore ?? null;
    fact.pause = {
      reason: pauseReason,
      at: markedAt ?? mtime ?? fact.startedAt,
      // The streak, not the run's lifetime of pauses: a freeplay run lives
      // forever, and nine pauses spread across weeks of good play are not a
      // provider that has refused for six hours (operator, 2026-09-25).
      count: Math.max(1, tally?.pauseStreak ?? 1),
      episodeElapsedMs: num(meta.pause?.episodeElapsedMs) ?? recorded?.episodeElapsedMs ?? null,
      ...(statedReset !== null ? { notBefore: statedReset } : {}),
    };
  }
  fact.live = fact.terminationReason === null && fact.pause === null && ((mtime !== null && now - mtime < LIVE_WINDOW_MS) || beating);
  if (!fact.live && fact.endedAt === null) fact.endedAt = mtime;
  return fact;
}

/** How much of a trajectory's end `verdictOfTrajectory` reads. */
export const TERMINATION_TAIL_BYTES = 1 << 20;

/** The last verdict a trajectory records: its end, a pause, or a resume that cancels the pause before it. */
export type TrajectoryVerdict =
  | { kind: "terminated"; reason: string; detail: string | null; at: number | null }
  | { kind: "paused"; reason: string; detail: string | null; at: number | null; notBefore: number | null; episodeElapsedMs: number | null }
  | { kind: "resumed" };

/**
 * The run's last `termination`, `pause` or `resume` record, read off the
 * trajectory's tail, or null when the tail holds none. The verdict is
 * appended a handful of records before a runner exits, so the last MiB holds
 * it; a run that wrote more than that after its verdict is not one this
 * recovers.
 */
export function verdictOfTrajectory(path: string, tailBytes = TERMINATION_TAIL_BYTES): TrajectoryVerdict | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    // The first line of a tail that starts mid-file is a fragment.
    for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
      const line = lines[i]!;
      if (!line.includes('"termination"') && !line.includes(`"${PAUSE_RECORD}"`) && !line.includes(`"${RESUME_RECORD}"`)) continue;
      let rec: { t?: unknown; reason?: unknown; detail?: unknown; ts?: unknown; notBefore?: unknown; episodeElapsedMs?: unknown };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      if (rec.t === RESUME_RECORD) return { kind: "resumed" };
      if (typeof rec.reason !== "string" || rec.reason === "") continue;
      const detail = typeof rec.detail === "string" ? rec.detail : null;
      const at = typeof rec.ts === "number" ? rec.ts : null;
      if (rec.t === "termination") return { kind: "terminated", reason: rec.reason, detail, at };
      if (rec.t === PAUSE_RECORD) {
        return {
          kind: "paused",
          reason: rec.reason,
          detail,
          at,
          notBefore: typeof rec.notBefore === "number" ? rec.notBefore : null,
          episodeElapsedMs: typeof rec.episodeElapsedMs === "number" ? rec.episodeElapsedMs : null,
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The run's last `termination` record off the trajectory's tail, or null when the tail ends otherwise (`verdictOfTrajectory`). */
export function terminationOfTrajectory(path: string, tailBytes = TERMINATION_TAIL_BYTES): { reason: string; detail: string | null; at: number | null } | null {
  const v = verdictOfTrajectory(path, tailBytes);
  return v?.kind === "terminated" ? { reason: v.reason, detail: v.detail, at: v.at } : null;
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

/** Bump when what `readRunFact` answers, or what `runFactKey` keys on, changes in a way their source text would not show. */
const RUN_FACT_CACHE_SCHEMA = 1;
let runFactCacheVersionMemo: string | undefined;

/**
 * The identity of the reader a kept fact came from: the schema number, and the
 * source of `readRunFact` and of everything it calls that decides a
 * terminated run's fact. A fact read by other code is not this code's
 * answer, so a release that changes any of them starts the cache over rather
 * than serving what the old reader said (a level counted another way would
 * be a promotion decided on it).
 */
export function runFactCacheVersion(): string {
  runFactCacheVersionMemo ??= createHash("sha256")
    .update(
      [
        String(RUN_FACT_CACHE_SCHEMA),
        ...[readRunFact, readRunReading, isStamped, partyOfConfig, fanoutAccountsOfConfig, runFactKey, runDbWriteInFlight, verdictOfTrajectory, tallyRecords, RecordCountScanner, harnessSeries, isEpisodeId, heartbeatAt, openRunDb, readRunRow, bestLevelOf, fanoutReadings, fanoutLead, str, num, parseSubscriptionUsage].map(String),
        JSON.stringify([EPISODE_IDS, MODEL_RESPONSE_RECORD, HEARTBEAT_FILE]),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
  return runFactCacheVersionMemo;
}

/**
 * The kept facts of terminated runs at `path`, for a caller that reads every
 * run on a timer; `readOnly` for a one-shot reader beside it, which is served
 * the same and writes nothing.
 */
export function runFactCache(path: string, opts: { readOnly?: boolean } = {}): RunFactCache {
  return new RunFactCache(path, runFactCacheVersion(), opts);
}

/** The files `readRunFact` reads, and the heartbeat it stats: a kept fact is good while none of them has moved. */
const RUN_FACT_FILES = ["meta.json", "trajectory.jsonl", "run.sqlite", HEARTBEAT_FILE, "session/live.json"] as const;
/**
 * A write in flight on the run database: no key, so nothing is kept or served
 * for the run. A rollback journal is one; so is a WAL that holds frames, which
 * are commits `run.sqlite` does not show yet. An EMPTY `-wal` is not: a reader
 * of a WAL-mode file with no writer creates one and leaves it, and refusing
 * on that would keep such a run out of the cache for good (runner/src/rundb.ts).
 */
function runDbWriteInFlight(dir: string): boolean {
  if (statSync(join(dir, RUN_DB_JOURNAL_FILE), { throwIfNoEntry: false }) !== undefined) return true;
  const wal = statSync(join(dir, RUN_DB_WAL_FILE), { throwIfNoEntry: false });
  return wal !== undefined && wal.size > 0;
}
/** How long a run's files must have been still before its fact is kept. */
export const RUN_FACT_SETTLE_MS = 60_000;

/**
 * A run directory's cache key, or null when it has none. Taken BEFORE the
 * read, so a write that lands during the read leaves the key behind the files
 * and the next read misses. Size, mtime and inode of each file `readRunFact`
 * reads (absent is its own value): a write moves the mtime, and a copy put in
 * its place is a new inode. Not ctime: the kubelet's fsGroup chown moves every
 * file's ctime each time the fleet pod starts (every file under the runs
 * volume read the pod's start time on 2026-10-16), which would miss every
 * entry on exactly the boot the cache is for. The cost is a rewrite in place
 * at the same size with its mtime set back, which is served stale until the
 * file is deleted. `newest` is the latest mtime, for the settle rule.
 */
export function runFactKey(dir: string): { key: string; newest: number } | null {
  const parts: (number | string)[] = [];
  let newest = 0;
  try {
    if (runDbWriteInFlight(dir)) return null;
    for (const name of RUN_FACT_FILES) {
      const st = statSync(join(dir, name), { throwIfNoEntry: false });
      if (st === undefined) {
        parts.push(name, -1);
        continue;
      }
      parts.push(name, st.size, st.mtimeMs, st.ino);
      newest = Math.max(newest, st.mtimeMs);
    }
  } catch {
    return null; // a stat that fails for another reason is doubt
  }
  return { key: JSON.stringify(parts), newest };
}

/**
 * Whether a fact may be kept: the run is terminated, so nothing in it reads
 * the clock, and its files have been still for `RUN_FACT_SETTLE_MS`, so a
 * write in the same timestamp tick as the key cannot hide behind it. Paused
 * and open runs are always read fresh.
 */
export function cacheableFact(f: RunReading, newest: number, now: number): boolean {
  return f.terminationReason !== null && now - newest >= RUN_FACT_SETTLE_MS;
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
 *
 * `counts` is a scanner cache for a caller that reads every run on a timer —
 * the fleet supervisor, twice a tick — so each trajectory is read whole once
 * and after that only for what was appended since the last call, instead of
 * the whole tree from byte zero every time. Same facts either way.
 *
 * `facts` keeps terminated runs' facts on disk across processes
 * (`runFactCache`), so a supervisor's boot reads in full only the runs that
 * have not ended. A kept fact is served only under the key its files had when
 * it was read (`runFactKey`) and only once they had been still for a minute
 * (`cacheableFact`); everything else is read exactly as without it. Same facts
 * either way.
 */
export function readRunFacts(
  runsDir: string,
  now = Date.now(),
  opts: { includeArchived?: boolean; counts?: CountCache; facts?: RunFactCache } = {},
): RunFact[] {
  return scanRunReadings(runsDir, now, opts, false).facts;
}

/**
 * `readRunFacts`, and beside the facts every run under `runsDir` with no
 * episode stamp (`UnstampedRun`), read in the same walk and kept the same way.
 * For the fleet's budgets and slots, which every run on a credential costs,
 * stamped or not; nothing that reads the facts' meaning is given the others.
 */
export function readFleetRuns(
  runsDir: string,
  now = Date.now(),
  opts: { includeArchived?: boolean; counts?: CountCache; facts?: RunFactCache } = {},
): { facts: RunFact[]; unstamped: UnstampedRun[] } {
  return scanRunReadings(runsDir, now, opts, true);
}

function scanRunReadings(
  runsDir: string,
  now: number,
  opts: { includeArchived?: boolean; counts?: CountCache; facts?: RunFactCache },
  withUnstamped: boolean,
): { facts: RunFact[]; unstamped: UnstampedRun[] } {
  if (!existsSync(runsDir)) return { facts: [], unstamped: [] };
  const out: RunFact[] = [];
  const unstamped: UnstampedRun[] = [];
  const read = (dir: string, runId: string): RunReading | null =>
    readRunReading(dir, runId, now, { ...(opts.counts === undefined ? {} : { counts: opts.counts }), stampedOnly: !withUnstamped });
  const seen = new Set<string>();
  const kept = new Set<string>();
  const facts = opts.facts;
  const scan = (dir: string, archived: boolean): void => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || !RUN_ID.test(d.name) || d.name === ARCHIVE_DIR) continue;
      seen.add(join(dir, d.name, "trajectory.jsonl"));
      let f: RunReading | null = null;
      if (facts === undefined) {
        f = read(dir, d.name);
      } else {
        const rel = archived ? `${ARCHIVE_DIR}/${d.name}` : d.name;
        kept.add(rel);
        const key = runFactKey(join(dir, d.name));
        f = key === null ? null : (facts.get(rel, key.key) ?? null);
        if (f === null) {
          f = read(dir, d.name);
          if (key !== null && f !== null && cacheableFact(f, key.newest, now)) facts.set(rel, key.key, f);
          else facts.delete(rel);
        }
      }
      if (f === null) continue;
      if (isStamped(f)) out.push(archived ? { ...f, archived: true } : f);
      else if (withUnstamped) unstamped.push(archived ? { ...f, archived: true } : f);
    }
  };
  scan(runsDir, false);
  if (opts.includeArchived === true) scan(join(runsDir, ARCHIVE_DIR), true);
  // A cache held across calls keeps only the paths this call visited: a run
  // moved into `archive/` leaves its old path behind, and nothing else would
  // ever drop that scanner.
  if (opts.counts !== undefined) for (const path of opts.counts.keys()) if (!seen.has(path)) opts.counts.delete(path);
  if (facts !== undefined) {
    // An archive-less read sees only half the tree; it must not drop the other half's entries.
    if (opts.includeArchived === true) facts.retain(kept);
    facts.flush();
  }
  const order = (a: RunReading, b: RunReading): number => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  out.sort(order);
  unstamped.sort(order);
  return { facts: out, unstamped };
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

/**
 * Whether a run produced no model response at all; null while undecidable.
 *
 * Internal to the scheduler now: such a run is archived by the runner as it
 * terminates and no listing shows one, but the ladder is made of them, so the
 * projection (which reads the archive) still has to name the state.
 */
export function stillbornOf(f: Pick<RunFact, "live" | "pause" | "modelResponses">): boolean | null {
  if (f.modelResponses === null) return null;
  // Paused: undecided. A 0-response rate-limited pause is a launch still in
  // progress as far as the policy is concerned (the roster retries it).
  if (f.live || f.pause !== null) return null;
  return f.modelResponses === 0;
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

/**
 * Whether a counted run counts toward its roster entry's target: it ran the
 * loop, and the `yield`, the entry now launches (`defaultLoopOf`), as its
 * tuple stamped them (operator, 2026-11-14). A run of the other loop is
 * another condition, not a copy of this one, so it neither fills a target
 * nor is owed a rerun; the series is unchanged by it. Pure.
 */
export function countsTowardTarget(f: Pick<RunFact, "loop" | "yield">, driver: string | undefined): boolean {
  const d = defaultLoopOf({ driver: driver !== undefined && isDriver(driver) ? driver : DEFAULT_DRIVER });
  const program = d.loop === "program";
  return (f.loop === "program") === program && (f.yield === true) === (program && d.yield);
}

export function isCounted(f: RunFact): boolean {
  if (f.extra || f.episodeOverride) return false;
  // A driver that is not a model (the scripted stub, the scripted reference)
  // is never evidence about one, whatever episode it was launched under and
  // whatever model id it carries: no target, no promotion witness, no repeat
  // (docs/METHODOLOGY.md, "Scoring"). Read off the run's own config, so it
  // holds for a fact the cache wrote before this line existed.
  if (isUnscoredDriverName(f.driver)) return false;
  return (
    badEvidenceReason({
      live: f.live,
      paused: f.pause !== null,
      modelResponses: f.modelResponses,
      terminationReason: f.terminationReason,
    }) === null
  );
}

/** A finished attempt the ladder reads as "no progress". */
export function isNoProgress(f: RunFact): boolean {
  if (f.live || f.pause !== null) return false;
  if (stillbornOf(f) === true) return true;
  return f.terminationReason !== null && NO_PROGRESS_REASONS.has(f.terminationReason);
}

/** What a run and a roster entry must share for the run to be that entry's. */
export interface RosterIdentity {
  model: string | null;
  effort?: string | null | undefined;
  compactWindow?: string | null | undefined;
  /** The driver a run or entry names (absent: the default driver); read for `probeOnly` and the default window. */
  driver?: string | null | undefined;
  /** The harness tag, where a projection keeps that and not the driver; read for the same two facts. */
  harness?: string | null | undefined;
  /**
   * A local build (`serving.ts`). On an entry, absent is a hosted model. On a
   * run, null is "stated none" and absent is "this caller does not know",
   * which matches either way: a run fact always knows (`RunFact.serving`).
   */
  serving?: ServingSpec | null | undefined;
}

/** A stamped serving block, or null when there is none to read. */
function servingOfMeta(raw: unknown): ServingSpec | null {
  const parsed = servingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

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

/**
 * Whether an entry's declared window owns a run stamped with `runWindow`
 * (null: the CLI's own `auto`, which is every run that recorded none).
 *
 * - A stated window owns exactly its runs, so a 100k copy of an entry owns
 *   its own.
 * - `"auto"`, stated on a driver that defaults a window, owns the `auto` runs
 *   and no others.
 * - No window owns the runs launched at the driver's default, whatever the
 *   default was when they launched: the `auto` runs, and on claude-code the
 *   300k runs since that became its default (operator, 2026-11-10). The entry
 *   did not change, so its earlier runs stay its own: its targets stay met,
 *   its paused run is still its to resume, its freeplay character continues.
 *   Nothing pools for that, since results group on the run's tuple, where
 *   `auto` and 300k stay two rows. A later change of a driver's default must
 *   keep the earlier one owned here.
 */
export function entryOwnsWindow(entry: Pick<RosterIdentity, "compactWindow" | "driver" | "harness">, runWindow: string | null | undefined): boolean {
  const declared = entry.compactWindow ?? null;
  const stamped = runWindow ?? null;
  if (declared === AUTO_COMPACT_WINDOW) return stamped === null;
  if (declared !== null) return stamped === declared;
  return stamped === null || stamped === defaultCompactWindowOf(entry);
}

/**
 * The windows `entryOwnsWindow` gives an entry, in a reader's spelling
 * (`"auto"` for the CLI's own): what a page filters an entry's runs by.
 */
export function ownedWindows(entry: Pick<RosterIdentity, "compactWindow" | "driver" | "harness">): string[] {
  const declared = entry.compactWindow ?? null;
  if (declared !== null) return [declared];
  const dflt = defaultCompactWindowOf(entry);
  return dflt === undefined ? [AUTO_COMPACT_WINDOW] : [AUTO_COMPACT_WINDOW, dflt];
}

/**
 * A run's window as a key that is one per roster entry: `""` for the CLI's
 * `auto` and for the default of the run's driver, which an entry with no
 * window owns alike (`entryOwnsWindow`); any other window as stamped. For the
 * places that group runs by model without an entry in hand.
 */
export function rosterWindowKey(run: Pick<RosterIdentity, "compactWindow" | "driver" | "harness">): string {
  const stamped = run.compactWindow ?? null;
  return stamped === null || stamped === defaultCompactWindowOf(run) ? "" : stamped;
}

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
    entry.model === run.model &&
    (entry.effort ?? null) === (run.effort ?? null) &&
    entryOwnsWindow(entry, run.compactWindow) &&
    probeOnlyIdentity(entry) === probeOnlyIdentity(run) &&
    // A local build and the hosted model of one id are two entries (operator, 2026-11-14).
    servingMatches(entry, run)
  );
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
export function matchesRoster(f: RunFact, r: Pick<RosterModel, "name" | "model" | "effort" | "compactWindow" | "driver" | "serving">): boolean {
  if (f.campaign !== null && f.arm != null && f.ref != null) {
    return (
      f.ref === r.name &&
      entryOwnsRun({ model: r.model, effort: r.effort, driver: r.driver, serving: r.serving }, { model: f.model, effort: f.effort, driver: f.driver, serving: f.serving }) &&
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
function targetFor(tier: Tier, ep: EpisodeId, entry?: Pick<RosterModel, "deadmines">): number {
  // Derived from the episode table, never from a list of names. A name check
  // here is a landmine: when a new id lands, TypeScript forces *a* decision and
  // the cheapest one that compiles is to widen `runsPerEpisode`, which silently
  // wires an unscored episode into series-gated evidence and promotion. An
  // episode that cannot be scored cannot be evidence, so it has no target, and
  // `models.test.ts` asserts that for every id in the table.
  if (!isScoredEpisode(ep)) return 0;
  // The five-agent id is bought only where the entry opts in (operator, 2026-11-14).
  if (ep === "deadmines" && entry?.deadmines !== true) return 0;
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
function tallyParties(stats: EpisodeStats, all: readonly RunFact[], mine: readonly RunFact[], driver: string | undefined, policy: SchedulingPolicy): void {
  stats.attempts = partyAttempts(all).length;
  for (const members of partyAttempts(mine)) {
    const verdict = partyAttempt(
      members.map((f) => ({
        campaign: null,
        version: null,
        cell: null,
        ref: null,
        arm: null,
        counted: isCounted(f) && countsTowardTarget(f, driver),
        live: f.live || f.pause !== null,
        party: f.party == null ? null : { id: f.party.id, size: f.party.size },
        terminationReason: f.terminationReason,
      })),
    );
    if (verdict.counted) {
      stats.counted++;
      if (members.some((f) => f.bestLevel !== null && f.bestLevel >= policy.promoteAtLevel)) stats.reachedL5 = true;
    }
    if (members.every((f) => stillbornOf(f) === true)) stats.stillborn++;
    for (const f of members) {
      if (f.bestLevel !== null && (stats.bestLevel === null || f.bestLevel > stats.bestLevel)) stats.bestLevel = f.bestLevel;
      if (f.endedAt !== null && (stats.lastEnded === null || f.endedAt >= stats.lastEnded)) {
        stats.lastEnded = f.endedAt;
        stats.lastReason = stillbornOf(f) === true ? "stillborn" : f.terminationReason;
      }
    }
  }
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
  const perEpisode: Partial<Record<EpisodeId, EpisodeStats>> = {};
  for (const ep of STATS_EPISODES) {
    const stats: EpisodeStats = {
      counted: 0,
      stillborn: 0,
      attempts: 0,
      extras: 0,
      otherSeries: all.filter((f) => f.episode === ep && !inSeries(f, policy)).length,
      // Filled below: a target depends on the effective tier, which depends on
      // whether the e90 walk found a rung-1 witness. Two passes, not a guess.
      target: 0,
      bestLevel: null,
      reachedL5: false,
      lastEnded: null,
      lastReason: null,
    };
    // A party episode's attempt is its party, not its member runs (operator,
    // 2026-11-14): five members are one attempt and one count, and the
    // cooling walk takes one rung for it, however many met a refusal.
    if (isPartyEpisode(ep)) {
      tallyParties(stats, all.filter((f) => f.episode === ep), mine.filter((f) => f.episode === ep), r.driver, policy);
      perEpisode[ep] = stats;
      continue;
    }
    for (const f of all) if (f.episode === ep) stats.attempts++;
    for (const f of mine) {
      if (f.episode !== ep) continue;
      if (f.extra) stats.extras++;
      if (stillbornOf(f) === true) stats.stillborn++;
      if (isCounted(f) && countsTowardTarget(f, r.driver)) {
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
  const earnedRung1 = perEpisode.e90!.reachedL5;
  const tier = effectiveTier(r.tier, earnedRung1);
  // A probe-only driver's entry is no scored lane's: its tier buys nothing
  // until the operator promotes the driver (`DriverEntry.probeOnly`). A
  // campaignOnly entry is the same on any driver.
  const probeOnly = isProbeOnlyDriver(r.driver) || r.campaignOnly === true;
  for (const ep of STATS_EPISODES) perEpisode[ep]!.target = probeOnly ? 0 : targetFor(tier, ep, r);

  // Eligibility falls out of the budget: an episode the tier buys no runs of is
  // not one this model may be scheduled on. One statement, so a target of zero
  // and "not eligible" can no longer disagree the way `promoted, 0/0` did.
  const eligible: EpisodeId[] = probeOnly ? [] : POLICY_EPISODES.filter((ep) => targetFor(tier, ep, r) > 0);
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
    platform: platformOf(r.apiBase, r.driver),
    provider: providerOfModel(r),
    harness: harnessOf(driverOf(r)),
    driver: driverOf(r),
    status: "active",
    billing,
    declaredTier: r.tier,
    tier,
    earnedRung1,
    idle: probeOnly ? "none" : (r.idle ?? "none"),
    ...(probeOnly ? { probeOnly: true as const } : {}),
    ...(r.campaignOnly === true ? { campaignOnly: true as const } : {}),
    eligible,
    perEpisode,
    ladder,
  };
  // The newest-started standing pause holds the model — a freeplay one for as
  // long as it sits, since it is never stale and is resumed, never rescheduled.
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
  return input.roster.map((r) => {
    const gone = modelGoneOf(lists, r);
    return projectModel(r, runs, policy, { now, clearedAt: sidecar.cleared[r.name], ...(gone !== undefined ? { gone } : {}) });
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
 * - `blocked` — retired, cooling, already running, or holding a paused run. No
 *   lane may have it.
 *
 * Lane priority lives at the pick, not here: a model is never "a probe model",
 * it is a model that happens to owe nothing.
 */
export type Verdict = { verdict: "eval" | "free" | "blocked"; why: string };

/**
 * A verdict as a deployment with the evals group off reads it
 * (`runner/viewer/groups.ts`): owing a counted run is owing nothing, so the
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
  _policy: SchedulingPolicy = DEFAULT_POLICY,
): Verdict {
  const blocked = (why: string): Verdict => ({ verdict: "blocked", why });
  if (s.gone !== undefined) return blocked(`retired: ${s.retired?.reason ?? goneReason(s.gone)} — back by itself once it is listed again`);
  if (s.retired !== undefined) return blocked(`retired: ${s.retired.reason} — clear with bun wb fleet clear-model ${s.name}`);
  if (s.cooling !== undefined) {
    return blocked(`cooling rung ${s.cooling.rung}/${LADDER_MS.length} until ${new Date(s.cooling.until).toISOString()} (${s.cooling.reason})`);
  }
  if (running.has(s.name)) return blocked("running (one character per model)");
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
  // Free, so a probe campaign may take it, and owing nothing, so nothing else does.
  if (s.campaignOnly === true) return { verdict: "free", why: "campaignOnly: it runs only as a probe campaign's assignment" };
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
    const how = s.idle === "none" ? "" : " — unlimited sessions while its account is idle";
    return { verdict: "free", why: `targets met on ${s.eligible.join(", ")}${how}` };
  }
  return { verdict: "eval", why: `schedulable on ${open.join(", ")}` };
}

/**
 * Whether this model's idle axis wants a spare account. Asked of a verdict
 * rather than folded into it: "does it owe anything" and "does it want extra
 * work" are two questions, and only the second is a property of the entry.
 */
export function wantsIdle(v: Verdict, s: ModelState): boolean {
  return v.verdict === "free" && s.idle !== "none" && s.probeOnly !== true;
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
   * Scored episodes are closed, and why (`SCORED_EPISODES_WAIT`, config.ts):
   * a model that owes a counted run is held with this reason instead of
   * picked, and is otherwise treated as owing none, as with the evals group
   * off, so its probes and idle work still go. Absent: open.
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
   * Whether the deployment's evals group is on (`runner/viewer/groups.ts`).
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
    const sched = schedulability(s, running, policy);
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
  const accounts = [...freeAccounts];
  for (const c of cands) {
    if (taken.has(c.s.name)) continue;
    taken.add(c.s.name);
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
    if (taken.has(c.s.name)) continue;
    taken.add(c.s.name);
    const st = c.s.perEpisode[c.ep]!;
    const n = extrasSoFar(c.s);
    jobs.push({
      name: c.s.name,
      episode: c.ep,
      account: accounts.shift()!,
      attempt: st.attempts + 1,
      why: `extra #${n + 1}: unlimited session (targets met; one continuous session, idle watchdog only)`,
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

  for (const s of input.states) {
    if (excluded.has(s.name) || s.retired !== undefined) continue;
    const g = groupFor(s);
    // The upper bound's bet is that the model climbs: what its tier would buy
    // if it earned rung 1. For a `t0` model the bet is off — the ladder is
    // held — so its upper and lower agree, which is the honest reading of a
    // trial: one run, and no more without an operator deciding.
    const climbed = TIER_TABLE[effectiveTier(s.declaredTier, true)].runsPerEpisode;
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
