/**
 * What the supervisor SHOULD do, decided from facts it is handed: the tick's
 * planners, the character and drain rules, the gate's verdict, and the renderings
 * the planners embed in their own reasons.
 *
 * Imports run-fleet-config and the runner's projections, and NOTHING else in
 * this directory: no fs, no repo paths, no process globals, no console. Every
 * function here is pure, which is why the tests can hold it still.
 */

import {
  type Eligible,
  eligibleFrom,
  episodeDimensions,
  type EpisodeId,
  fail,
  type FleetConfig,
  type FleetJob,
  type FleetRosterEntry,
  healthyFrom,
  type JobSpawn,
  pinnedCampaignJobs,
  pinnedJobs,
  policyRefs,
  poolJobs,
  type PreflightRecord,
  probeRunsOf,
  rosterModels,
  scheduledAccounts,
  unpinnedCampaigns,
  withoutEvals,
} from "./run-fleet-config";
import { backoffMs, isTainted, type RosterSpec, slug } from "./run-roster";
import {
  armArg,
  campaignSquares,
  isConcluded,
  pinnedCampaignJobName,
  policyCampaignJobName,
  type Campaign,
  type ProbeRun,
  type PublishedCampaign,
} from "../runner/src/campaigns";
import { cellDimensions, isOneAgentArm } from "../runner/src/campaign-def";
import { campaignFileOf, type CampaignFile } from "../runner/src/campaign-file";
import { fanoutLaunchOf, memberRunId } from "../runner/src/party";
import { isEvalPoolAccountName } from "../runner/src/account-pool";
import { scoredWaitFor, stampedCompactWindow, type TerminationReason } from "../runner/src/config";
import { driverEntry, isProbeOnlyDriver } from "../runner/src/drivers";
import { EPISODES, isScoredEpisode, isTaskEpisode } from "../runner/src/episodes";
import { canonicalModelId } from "./model-catalogue";
import { asProvider, optionOf } from "../runner/src/provider-options";
import { taskDefinition } from "../runner/src/task-episodes";
import { taskLaunchFile } from "./task-launch";
import { classifyLapse, OFFLINE_PAUSE, PARTY_PAUSE, resumesOnPause, staleAfterMs, SUBSCRIPTION_PAUSE } from "../runner/src/lapse";
import {
  credentialGate,
  credentialKey,
  driverOfEntry,
  gateSpawns,
  placeRef,
  resumeHoldOf,
  RUN_POD_KEY,
  SlotBook,
  WORLD_KEY,
  type CredentialGate,
  type PlacedCredential,
  type ReadHold,
  type ResumeHold,
  type RunPodsSetting,
  type WorldsSetting,
} from "./run-fleet-credentials";
import { worldUsedBy } from "./world";
import type { ModelListsSidecar } from "../runner/src/model-lists";
import type { SubscriptionUsage } from "../runner/src/subscription-usage";
import type { ResumeHoldCode } from "../runner/src/credential-health";
import type { Credential } from "../runner/src/credential-slots";
import { byNewestStart, entryOwnsRun, type HeldPick, inSeries, lastActivityOf, type ModelState, newestStarted, type NextJob, planNextJobs, type SchedulingPolicy, staleForMs, ineligibleWhy, liveCredentials, type ModelsSidecar, modelSiblings, modelStates, sameModel, TIER_TABLE } from "../runner/src/models";
import { accountsOfRun, type RunFact, type UnstampedRun } from "../runner/src/run-fact";
import { rosterWindowKey } from "../runner/src/roster-entry";

export const TICK_MS = 60_000;
/** A heartbeat older than this means the supervisor is gone, not merely quiet. */
export const HEARTBEAT_STALE_MS = 3 * TICK_MS;

// ------------------------------------------------------------- scheduling

// The model names its own character, so a fixed name no longer
// travels with the roster entry — what travels is where the LAST one is
// standing. A fresh attempt therefore prefers the free account the model's
// previous run used: the character it may well name the same thing again is
// already there, hygiene wipes it on the way in, and the name cannot collide
// with a copy of itself on some other account. A resume always used to go
// back to its own account and this never came up; making every scored lapse
// a FRESH attempt changed that, and `fleet-sonnet-e90-...-a12` spent eight
// minutes looping `char_create_failed_code_50` on RUNNER3 while its
// predecessor's character still stood on RUNNER5 (2026-08-25).

/** Where a model's last recorded character is: the account, and the name on it. */
export interface Affinity {
  account: string;
  character: string | null;
}

/**
 * The account each roster name last ran on, from the run facts the supervisor
 * already reads. Pure. Latest start wins; a run with no recorded account is no
 * evidence. Matching is the projection's own (`entryOwnsRun`: model,
 * effort, compaction window), so a roster entry renamed keeps its history and
 * two entries on one model id do not.
 */
export function affinityFrom(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>): Map<string, Affinity> {
  const out = new Map<string, Affinity>();
  const at = new Map<string, number>();
  for (const [name, e] of Object.entries(roster)) {
    for (const f of runs) {
      if (f.account === null) continue;
      if (!entryOwnsRun(e, f)) continue;
      if ((at.get(name) ?? -1) >= f.startedAt) continue;
      at.set(name, f.startedAt);
      out.set(name, { account: f.account, character: f.character });
    }
  }
  return out;
}

/** The account a fresh attempt of `ref` would rather have, or undefined. */
export type AccountAffinity = (ref: string) => string | undefined;

export function affinityOf(map: ReadonlyMap<string, Affinity>): AccountAffinity {
  return (ref) => map.get(ref)?.account;
}

/**
 * Take an account off a free list: the preferred one when it is on the list,
 * otherwise the first, exactly as `shift()` gave it. Mutates the list, because
 * every caller is walking one list handing out accounts.
 */
export function takeAccount(free: string[], prefer?: string): string | undefined {
  if (prefer !== undefined) {
    const i = free.findIndex((a) => a.toUpperCase() === prefer.toUpperCase());
    if (i >= 0) return free.splice(i, 1)[0];
  }
  return free.shift();
}

export interface QueueSkip {
  job: FleetJob;
  reason: string;
}

// ------------------------------------------------------------- queue progress
//
// A config job's `repeat` is a TARGET, counted off the runs on disk, never off
// the supervisor's memory. It used to be the latter: the job was "finished"
// once its roster process exited, in a set that died with the supervisor, and
// the next boot took a new date stamp, so the same job materialised `repeat`
// fresh run ids and ran them all again: a `codex-luna-6` e360 x3 job added on
// 2026-10-03 launched three more e360 runs on every supervisor boot until an
// operator noticed on 2026-10-14.
//
// The counting rule is the policy's, so the two can never disagree about what
// a run is worth:
//
//  - A run counts toward `repeat` when it is COUNTED evidence (`isCounted`: it
//    finished with model responses, is not an extra or an override, and did not
//    end for a reason that is not the model's) on the job's episode, in this
//    supervisor's harness series (`inSeries`), for the roster entry the ref
//    names. That is exactly `EpisodeStats.counted`, the number the policy's
//    tier target reads, archive included.
//  - A failed attempt (`attempt-failed`, `stale`), a fleet stop or an operator
//    cut (`manual`), a transport failure (`adapter-error`), a harness error and
//    a launch that never produced a response do not count, and the remainder is
//    attempted again — the same rerun the policy gives a model.
//  - A run still in flight does not count yet.
//
// It is a TOTAL for the (ref, episode, series), not "n more": a policy pick
// names its job `<ref>-<episode>`, the same name a manual job gets, so there is
// no telling one's runs from the other's, and a run is worth the same whoever
// asked for it. `repeat: 3` tops the pair up to three counted runs; to get more,
// raise it.
//
// What bounds the retries is unchanged: a job whose roster exits while
// enabled is finished for the life of that supervisor (`JobSets.finished`), so
// a job that can never be satisfied — a dead endpoint — costs at most its
// remainder once per supervisor boot, per off/on flip, or per raise of its
// `repeat` above the one it finished under (`planTick`), never a loop.

/** Counted runs of a roster entry on an episode, in this series: the projection's own number. */
export type CountedRuns = (ref: string, episode: EpisodeId) => number;

/** `CountedRuns` read off the projection the policy schedules from. */
export function countedFrom(states: readonly ModelState[]): CountedRuns {
  const byName = new Map(states.map((s) => [s.name, s]));
  return (ref, episode) => byName.get(ref)?.perEpisode[episode]?.counted ?? 0;
}

/**
 * The copies each of `refs` still owes a config job, or undefined for a job
 * that has no count to meet: a `"loop"`, a policy pick (`attempt`) and a probe
 * are scheduled by their own rules. Pure.
 */
export function owedCopies(job: Pick<FleetJob, "repeat" | "episode" | "attempt" | "probe">, refs: readonly string[], counted: CountedRuns): Record<string, number> | undefined {
  if (job.repeat === "loop" || job.attempt !== undefined || job.probe !== undefined) return undefined;
  const repeat = job.repeat;
  return Object.fromEntries(refs.map((r) => [r, Math.max(0, repeat - counted(r, job.episode))]));
}

/** Whether every ref's copies are met: the job is done, and nothing about it is started. */
export function owesNothing(owed: Readonly<Record<string, number>> | undefined): boolean {
  return owed !== undefined && Object.keys(owed).length > 0 && Object.values(owed).every((n) => n === 0);
}

/** `<counted>/<repeat>` per ref, for a log line or `--status`; undefined for a job with no count. */
export function progressLabel(job: Pick<FleetJob, "refs" | "repeat" | "episode" | "attempt" | "probe">, counted: CountedRuns): string | undefined {
  if (job.repeat === "loop" || job.attempt !== undefined || job.probe !== undefined) return undefined;
  const one = (r: string): string => `${counted(r, job.episode)}/${job.repeat}`;
  return job.refs.length === 1 ? `${one(job.refs[0]!)} counted` : job.refs.map((r) => `${r} ${one(r)}`).join(", ") + " counted";
}

export interface QueuePlan {
  /** Jobs to spawn this tick, in queue order, each on the pool account it was given. */
  assign: { job: FleetJob; account: string }[];
  /** Runnable jobs with nothing free to run them on, in queue order. */
  waiting: FleetJob[];
  /** Jobs that will not run, and why (logged once per reason by the caller). */
  skipped: QueueSkip[];
  /** Enabled jobs whose `repeat` the counted runs on disk already meet (`owedCopies`). */
  done: FleetJob[];
}

/**
 * The pool scheduler, pure. Walks the manual queue in order; every pool job
 * that is enabled, not running, not finished, promoted into its episode's
 * tier, not a second run on a model already running, and not cooling on
 * the defer ladder takes the next free pool account. Free means: in `pool`,
 * not assigned to a running job, and not held live by anything (the roster's
 * own account-busy inference, injected as `held`). A job carrying an account
 * is pinned and is not this scheduler's: it is skipped here.
 *
 * `freeplay` bypasses the tiers gate: it is unscored, so there is no
 * promotion to record for it.
 *
 * With `counted`, a job's `repeat` is met off the runs on disk (`owedCopies`):
 * a job that owes nothing is `done` and takes no account, and an assigned one
 * carries the copies it still owes and the run ids already used (`takenRunIds`),
 * so its spawn launches only the remainder, under ids nothing has used.
 */
/**
 * Why a queue or pinned job is held by a scored-episode hold
 * (`SCORED_EPISODES_WAIT`, runner/src/config.ts; none today), or undefined
 * when it is not: the reason the policy holds its own scored picks with. Held
 * here, said once, rather than spawned for `run.ts` to refuse at launch.
 */
export function scoredHold(job: Pick<FleetJob, "episode">, scoredGate: string | undefined): string | undefined {
  const wait = scoredWaitFor(job.episode, scoredGate ?? null);
  return wait === null ? undefined : `${job.episode}: ${wait}`;
}

export function planQueue(opts: {
  queue: FleetJob[];
  roster: Record<string, FleetRosterEntry>;
  pool: string[];
  /** The pool's cap (`accounts.max`): at most that many pool accounts live at once. */
  maxLive?: number;
  running: Map<string, string>;
  finished: Set<string>;
  held: (account: string) => string | undefined;
  /** Why a job may not start yet (the defer ladder), or undefined. */
  cooling?: (job: FleetJob) => string | undefined;
  /**
   * Where a job's runs start (`placeJob` over this tick's book, committing the
   * slots on success), or why they may not: a job with no credential room is
   * skipped with the reason and gives its account back. Absent: every job
   * starts (a test's shorthand).
   */
  place?: (job: FleetJob) => { ok: true; job: FleetJob } | { ok: false; why: string };
  /**
   * Who may run what. Default: only what needs no promotion. The
   * supervisor passes `eligibleFrom(modelStates(...))`, which adds what run
   * history has earned.
   */
  eligible?: Eligible;
  /** Roster names with a run in flight outside `queue` (policy and pinned jobs). */
  runningRefs?: ReadonlySet<string>;
  /**
   * Those of `runningRefs` whose run in flight holds the model's other
   * entries: a scored or freeplay one, never a probe (`siblingHolding`).
   * Absent reads every running ref as holding.
   */
  holdingRefs?: ReadonlySet<string>;
  /**
   * The account a job's model would rather have (`affinityOf`): the
   * one its last run left its character on. A preference only — a job whose
   * account is busy takes the next free one, as before.
   */
  affinity?: AccountAffinity;
  /** Counted runs per (ref, episode) in this series (`countedFrom`); absent reads every job as owing its whole `repeat`. */
  counted?: CountedRuns;
  /** Every run id on disk, archive included: a remainder copy never reuses one. */
  takenRunIds?: ReadonlySet<string>;
  /** Scored episodes closed, and why (`scoredHold`): a scored job is skipped with it. Absent is open. */
  scoredGate?: string;
}): QueuePlan {
  const plan: QueuePlan = { assign: [], waiting: [], skipped: [], done: [] };
  const taken = new Set([...opts.running.values()].map((a) => a.toUpperCase()));
  const free = freePoolAccounts({ pool: opts.pool, maxLive: opts.maxLive, taken, held: opts.held });
  const runningRefs = new Set<string>(opts.runningRefs ?? []);
  for (const job of opts.queue) if (opts.running.has(job.name)) for (const r of job.refs) runningRefs.add(r);
  const holdingRefs = new Set<string>(opts.holdingRefs ?? runningRefs);
  for (const job of opts.queue) if (opts.running.has(job.name) && job.episode !== "probing") for (const r of job.refs) holdingRefs.add(r);
  const siblings = modelSiblings(Object.entries(opts.roster).map(([name, e]) => ({ name, ...e })));
  for (const job of opts.queue) {
    if (job.account !== undefined) continue;
    if (!job.enabled || opts.running.has(job.name) || opts.finished.has(job.name)) continue;
    const hold = scoredHold(job, opts.scoredGate);
    if (hold !== undefined) {
      plan.skipped.push({ job, reason: hold });
      continue;
    }
    const refs = runnableRefs(job, opts.roster, opts.eligible);
    if (refs.length === 0) {
      const gated = job.refs.filter((r) => opts.roster[r] !== undefined);
      plan.skipped.push({
        job,
        reason:
          gated.length === 0
            ? `ref ${job.ref} is not in roster`
            : `${job.ref} is not eligible for ${job.episode} (${ineligibleWhy(job.episode, undefined, opts.roster[job.ref]?.tier)})`,
      });
      continue;
    }
    const owed = opts.counted === undefined ? undefined : owedCopies(job, refs, opts.counted);
    if (owesNothing(owed)) {
      plan.done.push(job);
      continue;
    }
    const clash = refs.find((r) => runningRefs.has(r));
    if (clash !== undefined) {
      plan.skipped.push({ job, reason: `${clash} is already running under another job — one character per model` });
      continue;
    }
    // The same model on another provider is the same model (operator, 2026-11-16).
    const sibling = job.episode === "probing" ? undefined : refs.flatMap((r) => siblings.get(r) ?? []).find((r) => holdingRefs.has(r));
    if (sibling !== undefined) {
      plan.skipped.push({ job, reason: `${sibling} runs the same model under another job — one character per model` });
      continue;
    }
    const cool = opts.cooling?.(job);
    if (cool !== undefined) {
      plan.skipped.push({ job, reason: cool });
      continue;
    }
    const account = takeAccount(free, opts.affinity?.(refs[0]!));
    if (account === undefined) {
      plan.waiting.push(job);
      continue;
    }
    const placed = opts.place === undefined ? { ok: true as const, job } : opts.place({ ...job, refs });
    if (!placed.ok) {
      free.unshift(account);
      plan.skipped.push({ job, reason: placed.why });
      continue;
    }
    for (const r of refs) runningRefs.add(r);
    if (job.episode !== "probing") for (const r of refs) holdingRefs.add(r);
    const out = placed.job.placed !== undefined ? { ...job, placed: placed.job.placed } : job;
    plan.assign.push({ job: owed === undefined ? out : { ...out, owed: { copies: owed, taken: opts.takenRunIds ?? new Set() } }, account });
  }
  return plan;
}

/**
 * The refs of a job that may run in its episode: in the roster and promoted
 * into the tier (an unscored episode needs no promotion). A job runs
 * with whatever subset passes; a ref gated out is dropped from that job's
 * roster, and the skip reason names it only when nothing is left.
 */
export function runnableRefs(job: FleetJob, roster: Record<string, FleetRosterEntry>, eligible?: Eligible): string[] {
  return job.refs.filter((r) => {
    const e = roster[r];
    if (e === undefined) return false;
    // A refused entry (`FleetRosterEntry.refused`) runs under no job at all: it
    // is in the catalog only so a job naming it is gated with a reason.
    if (e.refused !== undefined) return false;
    // A probe-only driver's entry (`DriverEntry.probeOnly`), or a campaignOnly
    // one, runs as a probe campaign's square and under nothing else: a queue job naming it for a
    // scored or freeplay episode is the scored lane it is kept out of. The one
    // exception is a held entry's own `idle: "unlimited"` session, the policy's
    // freeplay pick (operator, 2026-11-15); a hand-written freeplay job naming
    // it stays gated.
    const heldFreeplay = e.campaignOnly === true && !isProbeOnlyDriver(e.driver) && e.idle === "unlimited" && job.source === "policy" && job.episode === "freeplay";
    if ((isProbeOnlyDriver(e.driver) || e.campaignOnly === true) && !heldFreeplay && job.probe === undefined && job.campaignFile === undefined) return false;
    // A policy job was made from the projection that answers eligibility; it is its own witness.
    if (job.attempt !== undefined) return true;
    // An unscored episode needs no promotion: no tier buys one, so there is no
    // level to have reached. Otherwise the entry's own DECLARED tier is the
    // static floor — every tier buys e90, and a `t2` or `t3` entry buys an e360 without
    // any run history, which is what the retired `tiers` force used to spell.
    // The projection is asked only for what a model has EARNED on top of that,
    // so a climb opens e360 for a `t1` entry. The Deadmines evals have no
    // floor: they open only on a counted e360 at `deadminesAtLevel`, which only
    // the projection knows (operator, 2026-11-15).
    if (!isScoredEpisode(job.episode)) return true;
    if (!isTaskEpisode(job.episode) && e.tier !== undefined && TIER_TABLE[e.tier].runsPerEpisode[job.episode] > 0) return true;
    return eligible !== undefined && eligible(r, job.episode);
  });
}

/**
 * A policy pick as a job: one ref, one run, named `<ref>-<episode>` — the
 * same name a manual job for that (ref, episode) would get, so its log and
 * defer sidecar accumulate across attempts; the run id is not (`attempt`).
 */
export function policyJob(pick: NextJob): FleetJob {
  return {
    refs: [pick.name],
    ref: pick.name,
    episode: pick.episode,
    repeat: 1,
    // A probe names its square: the job name is what run ids, log paths and
    // the defer sidecar hang off, so without it every cell and arm of one
    // sweep would accumulate under one name and a run id would not say which
    // square it was.
    name:
      pick.probe !== undefined
        ? policyCampaignJobName(pick.name, pick.probe.campaign, pick.probe.cell, pick.probe.arm)
        : `${pick.name}-${pick.episode}`,
    enabled: true,
    source: "policy",
    attempt: pick.attempt,
    ...(pick.probe !== undefined ? { probe: pick.probe } : {}),
  };
}

/**
 * Whether a job is an extra run — a policy pick past the model's targets, which
 * the runner stamps `extra: true` so it numbers attempts and is reported apart.
 * The one shape left is the `idle: "unlimited"` freeplay session: a freeplay
 * pick can only come from that path, because no episode target names
 * `freeplay`. `attempt` is what makes the job the policy's: a manual freeplay
 * job (the nav probe) is not an extra. The scored-tier extra that rolled a
 * race and class became the race and class probe campaigns.
 */
export function isExtraJob(job: Omit<Pick<FleetJob, "episode" | "attempt">, "episode"> & { episode: EpisodeId | null }): boolean {
  return job.attempt !== undefined && job.episode === "freeplay";
}

/** One policy pick, placed. */
export interface PolicyPick {
  job: FleetJob;
  account: string;
  why: string;
}

/**
 * What the policy's fill for whatever the queue left free reads
 * (`planPolicyHeld`). Pure: the projection is handed in. Only runs when no manual job is waiting — a manual entry always
 * outranks the policy — and never puts a second run on a model.
 *
 * `place` is where a pick may start (`placeRef` over this tick's `SlotBook`:
 * the first credential that serves it and has room under its slots, its
 * budget and the driver's host cap), and `take` commits a placement to that
 * book. A pick with nowhere to start is passed over and the next candidate is
 * asked for its account, until a round yields nothing to pass over; the pick
 * is held with the reason in `held` for `--dry-run`. Without `place`, every
 * pick starts (a test's shorthand).
 *
 * `maxLive` is the pool's cap (`accounts.max`): at most that many pool
 * accounts live at once, the running ones and the queue's included.
 */
export interface PolicyPlanOptions {
  states: readonly ModelState[];
  pool: string[];
  maxLive?: number;
  running: Map<string, string>;
  held: (account: string) => string | undefined;
  queuePlan: QueuePlan;
  runningRefs: ReadonlySet<string>;
  /** Those of `runningRefs` that hold their model's other entries (`PolicyPlanOptions` of `planQueue`); absent, every one does. */
  holdingRefs?: ReadonlySet<string>;
  place?: (name: string, episode: EpisodeId) => PlaceOutcome;
  take?: (keys: readonly string[]) => void;
  policy?: SchedulingPolicy;
  /** The enabled, unpinned campaigns the policy may schedule. */
  campaigns?: readonly Campaign[];
  /** Probe runs on disk, counted or not: what a campaign's remaining work is derived from. */
  probeRuns?: readonly ProbeRun[];
  /** The account a pick's model would rather have (`affinityOf`). */
  affinity?: AccountAffinity;
  /** The evals group (`NextJobsOptions.evals`): off picks no scored or probing episode. Absent is on. */
  evals?: boolean;
  /** Scored episodes closed, and why (`NextJobsOptions.scoredGate`). Absent is open. */
  scoredGate?: string;
  /**
   * A task episode pick's party accounts, from the eval pool (`evalPoolDraw`,
   * as `taskDraw` wraps it), or why there are none this tick. Absent, every
   * task pick is held: it has nowhere to stage.
   */
  drawTask?: (pick: NextJob) => { accounts: string[] } | { held: string };
}

/** Where a pick may start: its credential (null when it needs none) and the keys it spends, or why it may not. */
export type PlaceOutcome = { ok: true; credential: PlacedCredential | null; keys: readonly string[] } | { ok: false; why: string };

/** The pool accounts still free, under the pool's cap. */
export function freePoolAccounts(o: {
  pool: readonly string[];
  maxLive?: number | undefined;
  taken: ReadonlySet<string>;
  held: (account: string) => string | undefined;
}): string[] {
  const free = o.pool.filter((a) => !o.taken.has(a.toUpperCase()) && o.held(a) === undefined);
  if (o.maxLive === undefined) return free;
  const live = o.pool.filter((a) => o.taken.has(a.toUpperCase())).length;
  return free.slice(0, Math.max(0, o.maxLive - live));
}

/** The policy's picks for what the queue left free, and what it held back and why. */
export function planPolicyHeld(opts: PolicyPlanOptions): { picks: PolicyPick[]; held: HeldPick[] } {
  // A waiting manual job reserves the pool. Such a job has no account and can
  // only ever take a pool one, so the policy takes none this tick, and says
  // what the reservation was for.
  const reserved =
    opts.queuePlan.waiting.length > 0
      ? `pool reserved for waiting manual job(s): ${opts.queuePlan.waiting.map((j) => j.name).join(", ")}`
      : undefined;
  const taken = new Set([...opts.running.values(), ...opts.queuePlan.assign.map((a) => a.account)].map((a) => a.toUpperCase()));
  const free = reserved === undefined ? freePoolAccounts({ pool: opts.pool, maxLive: opts.maxLive, taken, held: opts.held }) : [];
  // A reserved pool still has something to report: the held rows are the
  // whole point of naming the reservation.
  if (free.length === 0 && reserved === undefined) return { picks: [], held: [] };
  const running = new Set(opts.runningRefs);
  for (const a of opts.queuePlan.assign) for (const r of a.job.refs) running.add(r);
  // What holds a model's other entries: a scored or freeplay run in flight, never a probe.
  const holding = new Set(opts.holdingRefs ?? opts.runningRefs);
  for (const a of opts.queuePlan.assign) if (a.job.episode !== "probing") for (const r of a.job.refs) holding.add(r);
  // The credential each pick was placed on, decided by the loop below and
  // carried onto the job it spawns.
  const chosen = new Map<string, PlacedCredential | null>();
  // A task pick's party accounts, drawn once per pick (`drawTask`).
  const drawn = new Map<string, string[]>();
  const draw = (pick: NextJob): { ok: true } | { ok: false; why: string } => {
    if (!isTaskEpisode(pick.episode) || drawn.has(pick.name)) return { ok: true };
    const d = opts.drawTask?.(pick) ?? { held: `--episode ${pick.episode} stages a party on the eval pool, and this plan draws none` };
    if ("held" in d) return { ok: false, why: d.held };
    drawn.set(pick.name, d.accounts);
    return { ok: true };
  };
  const wrap = (pick: NextJob): PolicyPick => {
    const job = withTaskAccounts(policyJob(pick), drawn.get(pick.name));
    const c = chosen.get(pick.name);
    return { job: c !== undefined ? { ...job, placed: { [pick.name]: c } } : job, account: job.account ?? pick.account, why: pick.why };
  };
  const next = (states: readonly ModelState[], accounts: readonly string[], also: readonly NextJob[]): ReturnType<typeof planNextJobs> =>
    planNextJobs(states, accounts, new Set([...running, ...also.map((p) => p.name)]), {
      holding: new Set([...holding, ...also.filter((p) => p.episode !== "probing").map((p) => p.name)]),
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      ...(reserved !== undefined ? { poolHeld: reserved } : {}),
      ...(opts.campaigns !== undefined ? { campaigns: opts.campaigns } : {}),
      ...(opts.probeRuns !== undefined ? { probeRuns: opts.probeRuns } : {}),
      ...(opts.evals !== undefined ? { evals: opts.evals } : {}),
      ...(opts.scoredGate !== undefined ? { scoredGate: opts.scoredGate } : {}),
    });
  /*
   * Accounts in preference order over the FINAL picks. Affinity is the one
   * thing that reorders the pool: a pick whose model left its character on a
   * free account takes that one instead of the first.
   */
  const pool = [...free];
  // A task pick plays on the eval pool's accounts, never a pool account.
  const place = (pick: NextJob): PolicyPick => wrap(isTaskEpisode(pick.episode) ? pick : { ...pick, account: takeAccount(pool, opts.affinity?.(pick.name)) ?? pick.account });
  if (opts.place === undefined) {
    const plan = next(opts.states, free, []);
    const held = [...plan.held];
    const picks = plan.jobs.filter((pick) => {
      const d = draw(pick);
      if (!d.ok) held.push({ name: pick.name, episode: pick.episode, why: d.why });
      return d.ok;
    });
    return { picks: picks.map(place), held };
  }
  const out: NextJob[] = [];
  const held: HeldPick[] = [];
  const passed = new Set<string>();
  let states = opts.states;
  let accounts = free;
  for (;;) {
    const plan = next(states, accounts, out);
    for (const h of plan.held) if (!held.some((x) => x.name === h.name)) held.push(h);
    let rejected = false;
    for (const pick of plan.jobs) {
      const d = draw(pick);
      if (!d.ok) {
        passed.add(pick.name);
        held.push({ name: pick.name, episode: pick.episode, why: d.why });
        rejected = true;
        continue;
      }
      const r = opts.place(pick.name, pick.episode);
      if (!r.ok) {
        passed.add(pick.name);
        held.push({ name: pick.name, episode: pick.episode, why: r.why });
        rejected = true;
        continue;
      }
      opts.take?.(r.keys);
      chosen.set(pick.name, r.credential);
      out.push(pick);
    }
    if (!rejected) break;
    states = states.filter((s) => !passed.has(s.name));
    accounts = free.filter((a) => !out.some((p) => p.account === a));
  }
  return { picks: out.map(place), held };
}

/**
 * A policy pick's job, made a task episode's attempt: its party's accounts
 * (`accounts`, member order, the first the job's own), and on the one-agent
 * id the fan-out flag that makes its spawn one run over all of them
 * (`fanoutSpawn`); on the five-agent id, one run per member (`partySpawn`).
 * Any other job, or a task pick with no draw, is returned as it was.
 */
export function withTaskAccounts(job: FleetJob, accounts: readonly string[] | undefined): FleetJob {
  if (!isTaskEpisode(job.episode) || accounts === undefined) return job;
  const oneAgent = EPISODES[job.episode].task.agents === 1;
  return { ...job, account: accounts[0]!, accounts: [...accounts], ...(oneAgent ? { fanout: true as const } : {}) };
}

/** How many sessions one attempt of an episode holds on its credential: a five-agent party's five, else one. */
export function episodeSessions(episode: EpisodeId): number {
  return isTaskEpisode(episode) ? EPISODES[episode].task.agents : 1;
}

/**
 * A task pick's draw from the eval pool, over this tick's `evalPoolDraw`:
 * the party's size in accounts, under the pick's own job name.
 */
export function taskDraw(
  draw: ((c: Pick<Campaign, "name">, jobName: string, size: number) => { accounts: string[] } | { held: string }) | undefined,
): ((pick: NextJob) => { accounts: string[] } | { held: string }) | undefined {
  if (draw === undefined) return undefined;
  return (pick) => {
    if (!isTaskEpisode(pick.episode)) return { held: `${pick.episode} draws no party` };
    const size = taskDefinition(pick.episode).party!.size;
    return draw({ name: pick.episode }, policyJob(pick).name, size);
  };
}

/**
 * Where every ref of a job may start — a rotation's refs one after another
 * on the same book, a party's members (`sessionsOf`) all on one credential —
 * or why not. The pin is the job's (a queue job's or a pinned campaign's),
 * else each ref's roster entry's. Never mutates `book`; the keys to commit
 * come back with the placed job.
 */
export function placeJob(
  job: FleetJob,
  roster: Readonly<Record<string, FleetRosterEntry>>,
  o: { credentials: readonly Credential[]; book: SlotBook; gate?: CredentialGate | undefined; env?: Record<string, string | undefined> },
): { ok: true; job: FleetJob; keys: string[] } | { ok: false; why: string } {
  const book = o.book.clone();
  const sessions = sessionsOf(job);
  const placed: Record<string, PlacedCredential | null> = {};
  const keys: string[] = [];
  for (const ref of job.refs) {
    const r = placeRef(roster[ref], job.episode, { ...o, book, pin: job.credential ?? roster[ref]?.credential, sessions });
    if (!r.ok) {
      const why = sessions > 1 ? `a party of ${sessions} starts whole or not at all: ${r.why}` : job.refs.length > 1 ? `${ref}: ${r.why}` : r.why;
      return { ok: false, why: job.fanout === true ? `one agent on ${job.accounts?.length ?? 1} accounts: ${why}` : why };
    }
    book.add(r.placement.keys, sessions);
    for (let i = 0; i < sessions; i++) keys.push(...r.placement.keys);
    placed[ref] = r.placement.credential;
  }
  // A job is one attempt at a time, so one world: whatever its members or its rotation's refs.
  return { ok: true, job: { ...job, placed }, keys: oneWorld(keys) };
}

/** What `outsideRuns` reads of a run, stamped (`RunFact`) or not (`UnstampedRun`). */
export type OutsideRun = Pick<RunFact, "runId" | "live" | "credential" | "account" | "fanoutAccounts">;

/**
 * The live runs this fleet did not launch that bill a credential: a hand
 * launch (`bun wb run episode`, `run.ts` with a fan-out grant), with an
 * episode or without one. Each takes a slot on the credential it recorded for
 * as long as it is live, so the fleet never plans past the credential's slots
 * around it (`countOutsideRuns`); its runs and spend today are the budgets'
 * (`credentialGate`) and its accounts are held off the files (`accountHeldBy`),
 * both whatever launched it.
 *
 * Not a `fleet-` run: the fleet's own runs are on the book through their jobs,
 * and one no job of this supervisor owns (`unownedLiveRuns`) holds its model
 * and account only, as it always has. Nor a run one of the supervisor's
 * processes holds (`running`) or one on an account a live job holds
 * (`busyAccounts`, upper-cased), which are that job's. Pure.
 */
export function outsideRuns<T extends OutsideRun>(
  runs: readonly T[],
  opts: { running?: ReadonlySet<string>; busyAccounts?: ReadonlySet<string> } = {},
): T[] {
  const busy = opts.busyAccounts ?? new Set<string>();
  return runs.filter(
    (f) => f.live && f.credential !== null && !f.runId.startsWith("fleet-") && opts.running?.has(f.runId) !== true && !onBusyAccount(f, busy),
  );
}

/**
 * Put the runs `outsideRuns` answers on the book: one session each on the
 * credential it recorded — a fan-out run is one agent on one credential,
 * however many characters it drives (`sessionsOf`). Not on a driver's host
 * cap: a hand launch runs in the runner pod, not as one of the host's
 * children that cap is for.
 */
export function countOutsideRuns(book: SlotBook, runs: readonly OutsideRun[]): void {
  for (const f of runs) if (f.credential !== null) book.add([credentialKey(f.credential)]);
}

/**
 * Count a job that holds its sessions already (live, or about to spawn) on
 * the book: each ref on the credential it was placed on, else the one its
 * live or paused run recorded (`liveCredentials`), and its driver's sessions.
 */
export function countJob(
  book: SlotBook,
  job: { refs: readonly string[]; placed?: FleetJob["placed"]; accounts?: readonly string[] | undefined; fanout?: true | undefined; episode?: string | null | undefined },
  roster: Readonly<Record<string, FleetRosterEntry>>,
  runCredentials: ReadonlyMap<string, string>,
): void {
  const sessions = sessionsOf(job);
  let world = false;
  for (const ref of job.refs) {
    const placed = job.placed?.[ref];
    const id = placed !== undefined ? (placed?.id ?? null) : (runCredentials.get(ref) ?? null);
    const keys = book.keysOf(driverOfEntry(roster[ref]), id, job.episode).filter((k) => k !== WORLD_KEY || !world);
    if (keys.includes(WORLD_KEY)) world = true;
    book.add(keys, sessions);
  }
}

/** Keys with the world key once: a job holds one world at a time. */
function oneWorld(keys: readonly string[]): string[] {
  let seen = false;
  return keys.filter((k) => {
    if (k !== WORLD_KEY) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

/**
 * Put the live fleet runs no job of this supervisor owns (`unownedLiveRuns`)
 * on the book: each on the credential it recorded, a pod (a probe, a codex
 * run) on the run-pod cap, and an eval on the worlds' while worlds are on. Not on a driver's host cap: such a run is a run pod still playing
 * after its roster died with the supervisor's container, or a runner
 * unwinding for the seconds its heartbeat stays warm, and neither is one of
 * the host's children for long. A run pod outlives a container restart (its
 * owner is the pod, which stayed), so it can hold its credential for hours.
 */
export function countUnownedRuns(book: SlotBook, runs: readonly { credential: string | null; episode: string | null; driver?: string | null }[]): void {
  for (const u of runs) {
    const keys = [...(u.credential !== null ? [credentialKey(u.credential)] : []), ...book.keysOf(u.driver ?? undefined, null, u.episode).filter((k) => k === RUN_POD_KEY || k === WORLD_KEY)];
    book.add(keys);
  }
}

/**
 * The accounts a party that draws them (`accounts: "evals"`) takes for one
 * attempt, the same answer for the live tick and `planTick`: the first
 * `size` of the eval pool that no run without a verdict holds (its own or a
 * paused party's members), no running job holds, and nothing this tick drew
 * before it. A job already running keeps the accounts it was drawn. Such a
 * party plays on a world of its own, so with `policy.worlds` off it is held
 * with the reason, never moved to a pinned list or the shared world.
 */
export function evalPoolDraw(o: {
  mode: string;
  pool: readonly string[];
  /** Accounts no draw may take (`evalPoolTaken`); drawn ones are added as they go. */
  taken: Set<string>;
  held: (account: string) => string | undefined;
  /** A running job's own accounts, by its name. */
  running?: (jobName: string) => readonly string[] | undefined;
}): (c: Pick<Campaign, "name">, jobName: string, size: number) => { accounts: string[] } | { held: string } {
  return (c, jobName, size) => {
    const own = o.running?.(jobName);
    if (own !== undefined && own.length === size) return { accounts: [...own] };
    if (o.mode !== "evals") {
      return { held: `${isTaskEpisode(c.name) ? `--episode ${c.name}` : `campaign ${c.name}`} draws its party's accounts from the eval pool, and such a party plays on a world of its own: policy.worlds is ${JSON.stringify(o.mode)}` };
    }
    const free = o.pool.filter((a) => !o.taken.has(a.toUpperCase()) && o.held(a) === undefined);
    if (free.length < size) {
      return { held: `eval pool: ${free.length} of ${size} accounts free (${o.pool.length} in the pool, the chart's worlds.pool.size) — waits for a party to end` };
    }
    const accounts = free.slice(0, size);
    for (const a of accounts) o.taken.add(a.toUpperCase());
    return { accounts };
  };
}

/** The eval pool's accounts no draw may take: every run's without a verdict, and the given jobs'. */
export function evalPoolTaken(runs: readonly Pick<RunFact, "account" | "fanoutAccounts" | "terminationReason">[], jobAccounts: Iterable<string>): Set<string> {
  const taken = new Set<string>();
  for (const f of runs) if (f.terminationReason === null) for (const a of accountsOfRun(f)) taken.add(a.toUpperCase());
  for (const a of jobAccounts) taken.add(a.toUpperCase());
  return taken;
}

/**
 * The published definition `<campaign>@<version>`: from the campaign's row
 * (`Campaign.versions` holds every published version of its id, the active one
 * included), else from every published definition, for a row that is gone.
 */
export function publishedVersion(
  probe: { campaign: string; version: number },
  campaigns: readonly Campaign[],
  defs: readonly PublishedCampaign[] = [],
): PublishedCampaign | undefined {
  const c = campaigns.find((x) => x.name === probe.campaign);
  if (c !== undefined && c.version === probe.version) return c.published;
  const same = (d: PublishedCampaign): boolean => d.def.id === probe.campaign && d.def.version === probe.version;
  return c?.versions.find(same) ?? defs.find(same);
}

/**
 * A job materialised for the spawner: the roster entries with the episode's
 * dimensions folded in, `repeat: n` as n copies with their own run ids
 * (`-r2`, `-r3`, ...) so one roster process runs them in sequence,
 * `repeat: "loop"` as run-roster's own --loop. `tier` and `idle` never reach
 * the roster file: they are the fleet's bookkeeping, not a run dimension.
 */
export function jobSpawn(
  job: FleetJob,
  roster: Record<string, FleetRosterEntry>,
  account: string,
  stamp: string,
  eligible?: Eligible,
  campaigns: readonly Campaign[] = [],
  /** Every published definition (`FleetConfig.campaignDefs`), for a live job whose campaign row is gone. */
  defs: readonly PublishedCampaign[] = [],
): JobSpawn {
  const dims = episodeDimensions(job.episode);
  /*
   * A probe's task shape comes from its campaign file and nothing else. The
   * catalog entry supplies credentials and a model, so its own `objective`,
   * `watchdogs`, `maxToolCalls`, `wikiCoords` and `wiki` are dropped rather than
   * merged: a definition that says "no objective" must not inherit one from
   * whichever entry it borrowed. A fresh probe's file is built here from the
   * published definition and travels on the spec for the roster to write as
   * `runs/<id>/campaign.json`; a resumed probe brings the run's own file
   * (`planResumes`). The runner reads its shape from that file and refuses any
   * flag that would set part of it; the numbers are carried on the spec only
   * so the fleet plans with what the run will be given (its ceiling, for ETAs
   * and drains) and a resume restates the same leash.
   *
   * The definition is the job's own `<id>@<version>`, never the row's active
   * one: a published version is immutable, so a live job launched on @1 is
   * still @1's after the row moves to @2 (or is deleted), and runs to its end
   * as that. Every tick projects the live jobs through here, so matching only
   * the active version threw on the next tick after the move and took the
   * supervisor down with it (program-probe, 2026-11-12).
   */
  const published = job.probe === undefined ? undefined : publishedVersion(job.probe, campaigns, defs);
  // A task episode's shape is its pinned definition's (`task-episodes.ts`),
  // through the same launch file a probe's comes in; it is never a campaign's.
  const probeFile: CampaignFile | undefined = isTaskEpisode(job.episode)
    ? (job.campaignFile ?? taskLaunchFile(job.episode))
    : job.probe === undefined
      ? undefined
      : job.campaignFile ?? (published === undefined ? undefined : campaignFileOf(published, job.probe.cell, job.probe.arm));
  if (job.probe !== undefined && probeFile === undefined) {
    fail(`job ${job.name}: ${job.probe.campaign}@${job.probe.version} is not a published campaign this config names`);
  }
  const allProbeDims = probeFile === undefined ? undefined : cellDimensions(probeFile.definition, probeFile.cell);
  // Watchdogs are merged into their own key below, so they are held apart here.
  const probeWatchdogs = allProbeDims?.watchdogs;
  const probeDims =
    allProbeDims === undefined
      ? undefined
      : {
          race: allProbeDims.race,
          class: allProbeDims.class,
          maxToolCalls: allProbeDims.maxToolCalls,
          wikiCoords: allProbeDims.wikiCoords,
          wiki: allProbeDims.wiki,
          ...(allProbeDims.objective !== undefined ? { objective: allProbeDims.objective } : {}),
        };
  // What the planner says a ref still owes (`owedCopies`), else the whole count.
  const copiesOf = (r: string): number => job.owed?.copies[r] ?? (job.repeat === "loop" ? 1 : job.repeat);
  const entries: RosterSpec[] = [];
  // A resume is its own witness too: the run was launched, so its ref is runnable.
  for (const r of job.resume !== undefined ? job.refs.filter((x) => roster[x] !== undefined) : runnableRefs(job, roster, eligible)) {
    const copies = copiesOf(r);
    if (copies <= 0) continue;
    const { tier: _tier, idle: _idle, campaignOnly: _campaignOnly, deadmines: _deadmines, ...listed } = roster[r]!;
    // An entry with providers launches as the one it was placed on (the
    // credential `placeRef` chose, or a paused run's own), else its first.
    const entry = listed.providers === undefined ? listed : asProvider(listed, optionOf(listed.providers, job.placed?.[r]?.id) ?? listed.providers[0]!);
    // A probe keeps only what identifies the model; the campaign owns the rest.
    const { objective: _obj, watchdogs: _wd, maxToolCalls: _mtc, wikiCoords: _wc, wiki: _wk, ...credentials } = entry;
    const isProbe = probeFile !== undefined;
    const spec: RosterSpec = isProbe ? credentials : entry;
    // The entry's own leash, kept only when the entry is the authority on it.
    const own = isProbe ? {} : { watchdogs: entry.watchdogs, maxToolCalls: entry.maxToolCalls };
    // An `idle: "unlimited"` session is the one freeplay run the policy makes.
    // Freeplay has no episode wall clock, so the run stays continuous and its
    // only automatic stop is the idle watchdog. The entry's own watchdogs still
    // win, as they do for every other episode.
    //
    // The tier's uncapped ceiling belongs to that lane and only that lane: it
    // is what keeps the session from ending `tool-call-limit` at 500 and being
    // replaced by a fresh level-1 character.
    //
    // All three conditions, not two. The lane is the session the *policy*
    // grants a spent-tier ref, so an idle-capable ref is necessary and not
    // sufficient: a freeplay job written in the fleet file that happens to name
    // the same ref is the operator's own experiment, states its own leash, and
    // keeps the runner's 500 default. `source: "policy"` is set only on a job
    // the scheduler made up, which is exactly the distinction wanted here.
    const uncappedLane =
      job.source === "policy" && job.episode === "freeplay" && roster[r]!.idle === "unlimited";
    const laneDims =
      job.episode === "freeplay" && !uncappedLane
        ? (({ maxToolCalls: _drop, ...rest }) => rest)(dims)
        : dims;
    const base: RosterSpec = {
      ...spec,
      ...laneDims,
      watchdogs: { ...dims.watchdogs, ...(own.watchdogs ?? {}), ...(probeWatchdogs ?? {}) },
      ...(own.maxToolCalls !== undefined ? { maxToolCalls: own.maxToolCalls } : {}),
      ...(probeDims ?? {}),
      // The probe's whole campaign file, which the roster writes beside the run
      // before launching it; the roster name the run is launched as; and where
      // it executes — its own pod, on the arm's image and command, or the
      // release image when the arm pins none (`RosterSpec.launch`).
      ...(probeFile !== undefined
        ? {
            campaignFile: probeFile,
            ref: r,
            // A task episode runs where an eval runs; only a probe takes a run pod.
            ...(job.probe !== undefined ? { launch: { pod: true as const, image: probeFile.arm.image ?? null, command: probeFile.arm.command ?? null } } : {}),
          }
        : {}),
      // Whether a pause is resumed at all, decided by the lane and travelling
      // with the spec so the roster process needs no config of its own.
      // Scored evals never resume; freeplay always does; a probe opts in
      // through its own definition.
      resumeOnPause: resumesOnPause(job.episode, probeFile?.definition.resume),
      // An extra run is stamped as one, and keeps the entry's own character.
      ...(isExtraJob(job) ? { extra: true } : {}),
      // The character's lineage rides only on the lane that owns one: a
      // hand-written freeplay job is the operator's own experiment and starts
      // where the operator says. Another ref's freeplay characters on the account
      // are kept on every fresh launch.
      ...(uncappedLane && job.continueFrom !== undefined ? { continueFrom: job.continueFrom } : {}),
      ...(job.keepCharacters !== undefined && job.keepCharacters.length > 0 ? { keepCharacters: [...job.keepCharacters] } : {}),
      ...(uncappedLane && job.continueDropped !== undefined ? { continueDropped: { ...job.continueDropped } } : {}),
      // The credential the scheduler placed this ref on: its id, its secret's
      // variable and its usage thresholds, which the run records.
      ...(job.placed?.[r] != null ? { placedOn: { ...job.placed[r]! } } : {}),
    };
    const idBase =
      `fleet-${job.name}-${slug(base.model)}${base.effort !== undefined ? `-${slug(base.effort)}` : ""}` +
      `${stampedCompactWindow(base.compactWindow) !== undefined ? `-${slug(stampedCompactWindow(base.compactWindow)!)}` : ""}-${stamp}`;
    const attemptStem = (n: number | undefined): string => (n !== undefined && n > 1 ? `${idBase}-a${n}` : bareRunId(job.name, base, stamp));
    // A fresh campaign square numbers past every id on disk (`freshAttempt`).
    // A one-agent arm's attempt is one run, so its id is the stem alone.
    const attempt = freshAttempt(job, attemptStem, job.fanout === true ? undefined : probeFile?.definition.party?.members.map((m) => m.id));
    const runId = idBase + (attempt !== undefined && attempt > 1 ? `-a${attempt}` : "");
    // Copy k's id: the first is the attempt's, else the bare id `fillEntries`
    // stamps; the rest are `-r<k>`. A remainder skips every id already on disk
    // — under the same stamp a redone copy would otherwise land on the id of
    // the run it replaces, which `--resume-roster` skips as terminated.
    const firstId = attemptStem(attempt);
    const idOf = (k: number): string => (k === 1 ? firstId : `${runId}-r${k}`);
    for (let k = 1, made = 0; made < copies; k++) {
      if (job.owed?.taken.has(idOf(k)) === true) continue;
      entries.push(k === 1 ? (attempt !== undefined && attempt > 1 ? { ...base, runId } : base) : { ...base, runId: idOf(k) });
      made++;
    }
  }
  if (entries.length === 0 && owesNothing(job.owed?.copies)) fail(`job ${job.name}: its repeat is already met by counted runs — nothing to spawn`);
  if (entries.length === 0) fail(`job ${job.name}: no ref of ${job.ref} is eligible for ${job.episode}`);
  if (job.accounts !== undefined && job.fanout === true) return fanoutSpawn(job, entries, probeFile);
  if (job.accounts !== undefined) return partySpawn(job, entries, probeFile, stamp);
  const spawn: JobSpawn = {
    name: job.name,
    enabled: job.enabled,
    account,
    loop: job.repeat === "loop",
    entries,
  };
  return job.resume === undefined ? spawn : withResume(spawn, job.resume);
}

/**
 * The attempt a spawn's run ids carry. A fresh campaign square
 * (`takenRunIds` set, nothing resumed) takes the first attempt from its own
 * (`attempt`, else 1) whose ids are all free on disk: the stem's for a single
 * run, every member's (`<stem>-<member>`) for a party. Its campaign version's
 * count is only the floor — that count starts again at a new version, and a
 * stopped attempt may already hold the next number — so this, and not the
 * tally, is what keeps a fresh attempt off the ids of one before it. The cap
 * (`maxAttemptsPerCell`) still counts what the tally counts. Every other job
 * keeps the attempt it was given. Pure.
 */
export function freshAttempt(
  job: Pick<FleetJob, "attempt" | "probe" | "resume" | "partyId" | "takenRunIds">,
  stemOf: (attempt: number | undefined) => string,
  members: readonly string[] | undefined,
): number | undefined {
  const taken = job.takenRunIds;
  if (taken === undefined || job.probe === undefined || job.resume !== undefined || job.partyId !== undefined) return job.attempt;
  const idsOf = (n: number): string[] => {
    const stem = stemOf(n);
    return members === undefined ? [stem] : members.map((m) => memberRunId(stem, m));
  };
  const floor = Math.max(1, job.attempt ?? 1);
  let n = floor;
  while (idsOf(n).some((id) => taken.has(id))) n++;
  // A solo square never numbered its first attempt: it keeps the bare id
  // (`attempt` absent) unless that id is taken.
  return n === floor && job.attempt === undefined ? undefined : n;
}

/**
 * A fresh policy pick with its attempt numbered past every run id on disk
 * (`takenRunIds`, archive included). The pick's attempt is the model's count
 * on the episode plus one, and a count is not an id: a run removed from disk
 * by hand lowers the count while a later attempt's id is still there, and the
 * pick then names that run again — its roster skips it as terminated, exits,
 * and the next tick spawns the same no-op (sub-haiku-55 e90, 2026-11-16, with
 * `-a2` deleted and `-a3` on disk). The count stays the floor and stays what
 * counts; only the id moves on, to the first attempt whose every run id
 * (`idsOf`: the spawn's, a party's members' included) is free. The number is
 * written onto the job, so the pick's line, its announcement key and the live
 * job's re-spawn on every later tick all name the run it launched. A resume, a
 * party's own id, or a job with no attempt is returned as it was. Pure.
 */
export function attemptPastTaken(job: FleetJob, idsOf: (job: FleetJob) => readonly string[], taken: ReadonlySet<string>): FleetJob {
  if (job.attempt === undefined || job.resume !== undefined || job.partyId !== undefined) return job;
  // At most `taken.size` attempts can collide, so the walk ends.
  for (let n = Math.max(1, job.attempt), left = taken.size; left >= 0; n++, left--) {
    const at = n === job.attempt ? job : { ...job, attempt: n };
    if (!idsOf(at).some((id) => taken.has(id))) return at;
  }
  return job;
}

/**
 * Whether a spawn would launch nothing: a fresh (not looping, not resuming)
 * spawn every one of whose run ids already ended on disk. Its roster skips
 * each as terminated and exits `roster complete`, so spawning it only respawns
 * it on the next tick, forever. `attemptPastTaken` keeps a policy pick out of
 * this; the tick holds any spawn still in it rather than launch it. Pure.
 */
export function spawnsOnlyEnded(spawn: JobSpawn, stamp: string, ended: ReadonlySet<string>): boolean {
  if (!spawn.enabled || spawn.loop || spawn.resumeRunId !== undefined) return false;
  const ids = fillEntries(spawn, stamp).map((e) => e.runId!);
  return ids.length > 0 && ids.every((id) => ended.has(id));
}

/**
 * The tick's pinned campaign jobs, each told every run id on disk so its spawn
 * numbers its attempt past them (`freshAttempt`). One function for the live
 * tick and `planTick`, so `--dry-run` names the ids the spawn will use.
 */
export function withTakenRunIds(jobs: readonly FleetJob[], taken: ReadonlySet<string>): FleetJob[] {
  return jobs.map((j) => (j.probe !== undefined && j.resume === undefined ? { ...j, takenRunIds: taken } : j));
}

/**
 * A party job's spawn (docs/proposals/GROUP-PLAY.md §1): the one entry the
 * job's ref yields, made into one entry per member — the member's run id
 * (`<stem>-<member>`), account, start, objective and party stamp, and a
 * campaign file that names the member and every other one — for one roster
 * process to launch together. The stem is the id the job's single entry
 * would have had (`-a<n>` from the second attempt), or, on a resume, the
 * paused party's own id. Every member shares the entry's credential
 * (`placedOn`), so a party is never spread across credentials.
 */
function partySpawn(job: FleetJob, entries: RosterSpec[], probeFile: CampaignFile | undefined, stamp: string): JobSpawn {
  const party = probeFile?.definition.party;
  const accounts = job.accounts!;
  if (probeFile === undefined || party === undefined) fail(`job ${job.name}: a party job needs a party campaign's square`);
  if (accounts.length !== party.size) fail(`job ${job.name}: a party of ${party.size} needs ${party.size} accounts, the job holds ${accounts.length}`);
  if (entries.length !== 1) fail(`job ${job.name}: a party is one model's — ${entries.length} entries to place`);
  const base = entries[0]!;
  const stem = job.partyId ?? base.runId ?? bareRunId(job.name, base, stamp);
  const members = party.members.map((m, i) => ({ member: m.id, role: m.role, runId: memberRunId(stem, m.id), account: accounts[i]!, character: m.character }));
  const memberEntries: RosterSpec[] = party.members.map((m, i) => {
    const dims = cellDimensions(probeFile.definition, probeFile.cell, m);
    return {
      ...base,
      race: dims.race,
      class: dims.class,
      ...(dims.objective !== undefined ? { objective: dims.objective } : {}),
      runId: members[i]!.runId,
      account: accounts[i]!,
      campaignFile: { ...probeFile, party: { id: stem, member: m.id, members } },
      party: { id: stem, member: m.id, role: m.role, size: party.size },
    };
  });
  return {
    name: job.name,
    enabled: job.enabled,
    account: accounts[0]!,
    accounts: [...accounts],
    loop: false,
    entries: memberEntries,
    ...(job.resume !== undefined ? { resumeRunId: members[0]!.runId } : {}),
  };
}

/**
 * A one-agent arm's spawn (`arms[].agents: 1`): the job's one entry, on the
 * leader's account, with a campaign file that names every member's account
 * and character (`fanout`), for the roster to stage and launch as one run.
 * The spawn holds every account (`accounts`), as a party's does, so nothing
 * else is placed on one while the run lives; a resume brings the run's own
 * file, which already names them.
 */
function fanoutSpawn(job: FleetJob, entries: RosterSpec[], probeFile: CampaignFile | undefined): JobSpawn {
  const party = probeFile?.definition.party;
  const accounts = job.accounts!;
  if (probeFile === undefined || party === undefined || !isOneAgentArm(probeFile.definition, probeFile.arm)) {
    fail(`job ${job.name}: a fan-out job needs a party campaign's one-agent arm`);
  }
  if (accounts.length !== party.size) fail(`job ${job.name}: one agent on a party of ${party.size} needs ${party.size} accounts, the job holds ${accounts.length}`);
  if (entries.length !== 1) fail(`job ${job.name}: a one-agent run is one model's — ${entries.length} entries to place`);
  const launch = probeFile.fanout ?? fanoutLaunchOf(party, accounts);
  const named = launch.members.map((m) => m.account.toUpperCase());
  if (named.some((a, i) => a !== accounts[i]!.toUpperCase())) fail(`job ${job.name}: its campaign file names accounts ${named.join(", ")}, the job holds ${accounts.join(", ")}`);
  const entry: RosterSpec = { ...entries[0]!, account: accounts[0]!, campaignFile: { ...probeFile, fanout: launch } };
  const spawn: JobSpawn = { name: job.name, enabled: job.enabled, account: accounts[0]!, accounts: [...accounts], loop: false, entries: [entry] };
  return job.resume === undefined ? spawn : withResume(spawn, job.resume);
}

/**
 * The spawn, made to resume one paused run first: the entry for
 * that model carries the paused run id and moves to the front — the roster
 * runs entries in order, and a *fresh* launch of a rotation-mate wipes the
 * account's characters, which would cost the paused run its level. The
 * roster's --resume-roster then reattaches that run id instead of launching.
 */
export function withResume(spawn: JobSpawn, resume: NonNullable<FleetJob["resume"]>): JobSpawn {
  const entries = [...spawn.entries];
  const i = entries.findIndex((e) => entryOwnsRun(e, resume));
  if (i >= 0) {
    const [hit] = entries.splice(i, 1);
    entries.unshift({ ...hit!, runId: resume.runId });
  } else if (entries.length > 0) {
    // The paused run's identity comes from its meta.json on --resume; the
    // entry only has to name the run id and a model the roster accepts.
    entries.unshift({
      ...entries[0]!,
      model: resume.model,
      ...(resume.effort !== undefined ? { effort: resume.effort } : {}),
      ...(resume.compactWindow !== undefined ? { compactWindow: resume.compactWindow } : {}),
      runId: resume.runId,
    });
  }
  return { ...spawn, entries, resumeRunId: resume.runId };
}

// ------------------------------------------------------------------ resumes
//
// A fleet stop pauses every live run (the runner pauses on SIGTERM,
// clock stopped, session released) and a fleet start resumes them before the
// queue or the policy launches anything fresh. The same planner runs every
// tick, so a run its provider paused (rate-limited, quota-exhausted) is also
// picked back up once its cooling is over — that is the resume path.

export interface ResumePlan {
  job: FleetJob;
  account: string;
  runId: string;
  /** The pause streak (`RunFact.pause.count`), for the line that announces the resume. */
  pauseCount: number;
  why: string;
  /**
   * A probe launched before campaign files has none: this is the one rebuilt
   * for it from the published definition its stamps name
   * (`pausedProbeFile`). The caller writes it into the run's directory before
   * the resume is spawned, so the run carries it from then on; never set when
   * the run has its own.
   */
  writeCampaignFile?: CampaignFile;
}

/**
 * The campaign file a paused probe comes back with: its own `campaign.json`,
 * or, for a run launched before campaign files existed (a probe paused across
 * the release that brought them), one rebuilt from the published definition
 * its stamps name — the version it recorded, its cell, and its arm, or the
 * definition's only arm when the run predates arms. `rebuilt` tells the caller
 * to write it. A run whose stamps name a version nobody published, or a cell
 * or arm that version does not have, gets the reason instead and stays
 * listed: nothing about it is guessed.
 */
export function pausedProbeFile(
  f: Pick<RunFact, "runId" | "campaign" | "campaignVersion" | "cell" | "arm">,
  campaigns: readonly Campaign[],
  own: (runId: string) => CampaignFile | null,
): { file: CampaignFile; rebuilt: boolean } | { why: string } {
  const file = own(f.runId);
  if (file !== null) return { file, rebuilt: false };
  const version = f.campaignVersion ?? null;
  const ref = `${f.campaign ?? "?"}@${version ?? "?"}`;
  const published = version === null ? undefined : campaigns.find((c) => c.name === f.campaign)?.versions.find((v) => v.def.version === version);
  if (published === undefined) return { why: `no campaign.json, and the run's ${ref} is not a published version this config names` };
  if (f.cell === null) return { why: `no campaign.json, and the run stamps no cell of ${ref}` };
  try {
    return { file: campaignFileOf(published, f.cell, f.arm ?? undefined), rebuilt: true };
  } catch (e) {
    return { why: `no campaign.json, and none can be rebuilt from ${ref}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * A run the supervisor ENDS instead of resuming, through the runner's own
 * termination writer. Three kinds reach here:
 *
 *  - the roster entry its job ref names is a different model now (the operator
 *    re-pointed the ref), so the run has nothing to come back under (`manual`);
 *  - it is a scored eval (or a campaign that did not ask to resume) that
 *    paused: such a run is a **failed attempt**, not a resume;
 *  - nothing came back for it at all and it went stale.
 *
 * An `attempt-failed` one is a rung of the model's cooling ladder
 * (`NO_PROGRESS_REASONS`); `manual` and `stale` are the harness's and are not.
 */
export interface EndedRun {
  runId: string;
  model: string;
  /** Part of the model's identity: opus-low and opus-high are two rows. */
  effort: string | null;
  /** Identity too: the CLI compaction window (claude-code or codex); absent or null is `auto`. */
  compactWindow?: string | null;
  /** The run's driver: a probe-only driver's run is never another entry's (`entryOwnsRun`). */
  driver?: string | null;
  /** The job ref it was launched under, when the run id names one. */
  ref: string | null;
  episode: EpisodeId;
  reason: TerminationReason;
  detail: string;
  /** The account to release, when the run recorded one. */
  account: string | null;
}

/** The job ref a fleet run id was launched under, off the id's `fleet-<ref>-<episode>-` prefix. Longest ref wins. */
export function refOfRunId(runId: string, episode: EpisodeId, refs: readonly string[]): string | undefined {
  return [...refs].filter((r) => runId.startsWith(`fleet-${r}-${episode}-`)).sort((a, b) => b.length - a.length)[0];
}

/** A paused run the supervisor will NOT resume right now, and why. For --status. */
export interface PausedListing {
  runId: string;
  model: string;
  account: string | null;
  reason: string;
  /** When the run paused. */
  since: number;
  /** The pause streak (`RunFact.pause.count`); what the resume cadence indexes. */
  pauseCount: number;
  /** When the supervisor will try again; null when waiting on something other than time. */
  resumeAfter: number | null;
  elapsedMs: number | null;
  budgetMs: number | null;
  why: string;
  /**
   * Set when the wait is a subscription usage window's — a `subscription-budget`
   * pause, a spent quota's reset — or any credential's hold, whose figures and
   * name are the operator's: the public projection withholds `resumeAfter` and
   * `why` then. Kept on every credential hold, not only a usage one, so a
   * projection that predates `hold` still withholds them.
   */
  subscriptionWait?: true;
  /** What holds it, when its credential does (`FleetPausedView.hold`): the public phrase's code. */
  hold?: ResumeHoldCode;
}

/** "41m of 90m" — what the accounts table and the paused listing say about a paused run. */
export function fmtPaused(elapsedMs: number | null, budgetMs: number | null): string {
  const spent = elapsedMs !== null ? fmtElapsed(elapsedMs) : "?";
  return budgetMs !== null ? `${spent} elapsed of ${fmtElapsed(budgetMs)}` : `${spent} elapsed`;
}

/**
 * The reset a paused run's provider stated (`RunFact.pause.notBefore` on any
 * pause but the derived `offline` one, whose instant is its ownerless proof),
 * or undefined. What every reader that names the wait asks.
 */
export function providerResetOf(pause: NonNullable<RunFact["pause"]>): number | undefined {
  return pause.reason === OFFLINE_PAUSE ? undefined : pause.notBefore;
}

/**
 * The resume cadence for a paused run. An operator-pause resumes at once —
 * the fleet stopped under it and nothing about the provider changed. A pause
 * whose provider stated when its allowance resets resumes at that instant,
 * once. Every other pause (`onPauseLadder`) resumes on the roster's own defer
 * ladder (1m … 6h), indexed by the run's pause streak: the ladder pauses since
 * the last segment of the run that made a turn. A segment that played resets
 * it, so a freeplay run that paused nine times across weeks with good play
 * between each keeps resuming, while one its provider has refused through the
 * whole ladder is listed, not hammered. Null means "now".
 */
export function resumeNotBefore(pause: NonNullable<RunFact["pause"]>): number | "never" | null {
  if (pause.reason === "operator-pause") return null;
  // A party member paused because another member did: the party comes back
  // when that member's own pause says, which `planResumes` asks of the whole
  // party at once, so this member waits on nothing of its own.
  if (pause.reason === PARTY_PAUSE) return null;
  // A credential's usage budget stopped a freeplay run (operator, 2026-10-16):
  // it waits for the window's reset, and is on no ladder at all — the budget
  // (`credentialHold`) is what holds it while the window stays over.
  if (pause.reason === SUBSCRIPTION_PAUSE) return pause.notBefore ?? null;
  // An offline pause is the harness's own doing too — the runner was killed
  // under the run, and nothing about the provider changed — but it is derived,
  // not written, so it is resumable only from the instant the run provably
  // has no live owner.
  if (pause.reason === OFFLINE_PAUSE) return pause.notBefore ?? null;
  // The provider's stated reset (adapter.ts carries it, already bounded): any
  // resume before it is a refusal the provider has announced, so it is waited
  // out rather than spent as rungs. Ahead of the taint check because the pause
  // is not on the streak (`pauseCountsOnLadder`) — the streak it would be
  // judged by is the one before it.
  const reset = providerResetOf(pause);
  if (reset !== undefined) return reset;
  if (isTainted(pause.count)) return "never";
  return pause.at + backoffMs(pause.count);
}

/**
 * Whether the campaign that commissioned a run asked to be resumed: the
 * `resume` of the published version the run was stamped with, which may be
 * an older one than the row names now. A run with no campaign or no version,
 * or one whose campaign has no store row any more, is not resumed: a campaign
 * nobody is running has nobody to resume it.
 */
export function campaignResumeOf(
  campaigns: readonly Campaign[] | undefined,
  campaign: string | null,
  /** The run's own definition version. */
  version: number | null,
): boolean {
  if (campaign === null || version === null || campaigns === undefined) return false;
  const c = campaigns.find((x) => x.name === campaign);
  if (c === undefined) return false;
  return c.versions.find((p) => p.def.version === version)?.def.resume === true;
}

/** The quiet a run with no heartbeat and no recorded idle watchdog must show before it reads as ownerless. */
export const OFFLINE_QUIET_FLOOR_MS = 30 * 60_000;
/** Added to the run's idle watchdog, which is checked between turns and so fires a little late. */
export const OFFLINE_QUIET_MARGIN_MS = 2 * 60_000;

/**
 * When a verdict-less run is provably without a live owner. Pure.
 *
 * A run that carries a heartbeat is ownerless the moment the heartbeat is
 * cold — `live` already reads it, so "not live" is the proof (0: at once), and
 * a hard-killed run comes back as soon as the supervisor does. A run with no
 * heartbeat file (its runner predates the heartbeat, or exited without a
 * verdict) has only its silence to go by, and the proof may not be weaker than
 * the silence the run is permitted: its own idle watchdog plus a margin, or a
 * floor when it recorded none.
 */
export function ownerlessAt(f: Pick<RunFact, "pause" | "endedAt" | "startedAt" | "heartbeatAt" | "idleMs">): number {
  if (f.heartbeatAt != null) return 0;
  return lastActivityOf(f) + (f.idleMs ?? OFFLINE_QUIET_FLOOR_MS) + OFFLINE_QUIET_MARGIN_MS;
}

/**
 * The runs as the supervisor reads them, with the pause a dead runner never
 * wrote filled in. Pure.
 *
 * A `fleet-` run with no termination, no pause and no live process is a run
 * whose runner was killed before its verdict. It used to be nothing at all:
 * `planResumes` walks paused runs, `planStaleRuns` waits out the run's budget
 * (twelve hours for freeplay, which has none), and in between the run was
 * invisible — not resumed, not a character head, its character fair game for
 * the next launch's hygiene. On 2026-09-20 that cost a level-7 freeplay
 * character: the pod was SIGKILLed two seconds into its stop grace, and nine
 * hours later the policy started a fresh attempt on the same account.
 *
 * Such a run is paused `offline` as of its last activity, on the lanes that
 * resume a pause (freeplay, and a campaign that asked): `planResumes` then
 * brings it back on the next tick, same run id, same character. The scored
 * lanes are left to the stale sweep — a lapsed e90 is a failed attempt either
 * way, and the sweep's wait is the guard against ending a run that is merely
 * quiet.
 *
 * The same guards as the stale sweep, and for the same reason: a run the
 * supervisor's own processes hold (`running`, by run id) or that sits on an
 * account a live job holds (`busyAccounts`) is left exactly as read.
 *
 * Those guards only cover this supervisor's own children, and the run may be
 * somebody else's — another replica during an upgrade, a hand `--resume`, a
 * runner in another pod — so the resume also needs proof that NO process owns
 * the run (`ownerlessAt`, carried as the pause's `notBefore`). A trajectory
 * quiet for two minutes is not that: a run waiting on a slow provider writes
 * nothing for as long as the request takes.
 */
export function implicitPauses(opts: {
  runs: readonly RunFact[];
  campaigns?: readonly Campaign[];
  /** Run ids the supervisor's own processes hold. */
  running?: ReadonlySet<string>;
  /** Accounts a live job holds, upper-cased. */
  busyAccounts?: ReadonlySet<string>;
  now: number;
}): RunFact[] {
  const running = opts.running ?? new Set<string>();
  const busy = opts.busyAccounts ?? new Set<string>();
  return opts.runs.map((f) => {
    if (f.terminationReason !== null || f.pause !== null || f.live) return f;
    // An archived run is put away and not under the runs directory any more:
    // `--resume` cannot find it, and stamping it would respawn a resume that
    // exits on "no meta.json" every tick, ahead of the model's real paused run.
    if (f.archived === true) return f;
    if (!f.runId.startsWith("fleet-") || running.has(f.runId)) return f;
    if (onBusyAccount(f, busy)) return f;
    if (!resumesOnPause(f.episode, campaignResumeOf(opts.campaigns, f.campaign, f.campaignVersion ?? null))) return f;
    // Stamped either way — a run that is waiting out its proof still holds its
    // model, its account's character and the head, or the policy would start
    // the next attempt over it — but resumed only once the proof is in.
    const proofAt = ownerlessAt(f);
    return {
      ...f,
      pause: { reason: OFFLINE_PAUSE, at: lastActivityOf(f), count: 1, episodeElapsedMs: null, ...(proofAt > opts.now ? { notBefore: proofAt } : {}) },
    };
  });
}

/** Whether any account a run holds (a fan-out run's every one) is on a live job's set. */
function onBusyAccount(f: Pick<RunFact, "account" | "fanoutAccounts">, busy: ReadonlySet<string>): boolean {
  return accountsOfRun(f).some((a) => busy.has(a.toUpperCase()));
}

/** A live fleet run that no job of the running supervisor owns (`unownedLiveRuns`). */
export interface UnownedRun {
  runId: string;
  account: string;
  /** Every account it holds, when that is more than `account`: a fan-out run's. */
  accounts?: string[];
  /** The roster ref it plays; empty when no roster entry matches it any more. */
  refs: string[];
  model: string;
  episode: EpisodeId;
  /** The credential it recorded, which it holds a slot on while it plays (`countUnownedRuns`). */
  credential: string | null;
  /** The driver it recorded: a `runPod` driver's run is a pod, on the run-pod cap (`countUnownedRuns`). */
  driver?: string | null;
  /** Its lane resumes a pause in place (freeplay, a campaign that asked) rather than ending it. */
  resumesInPlace: boolean;
}

/**
 * Live fleet runs that none of the supervisor's own jobs is playing. Pure.
 *
 * After a fleet pod is recreated (an eviction, a node drain, a manual
 * restart), a runner SIGKILLed before it wrote its pause leaves a warm
 * heartbeat behind, and its run reads `live` for up to two minutes with no
 * process of the new supervisor behind it. So does a run whose roster exited
 * while its runner, or its run pod, is still unwinding. Such a run holds its
 * account (`accountHeldBy`) and its model: one character per model holds
 * whoever launched the run, and a model left free here was planned a second
 * session on another free account while its character was still mid-run on
 * the first. Freshness is `live` and nothing else, so a run that has truly
 * stopped lets go once it reads cold. On a lane that resumes,
 * `implicitPauses` then makes it an `offline` pause, which holds the model
 * through the resume path; on a scored lane it waits for the stale sweep, as
 * before.
 *
 * The guards are `implicitPauses`' guards: a run one of the supervisor's
 * processes holds (`running`, by run id) or that sits on an account a live
 * job holds (`busyAccounts`) is that job's. The account guard is what covers a
 * loop's later cycles, whose run ids the roster mints itself. One run per
 * account, the first read.
 */
export function unownedLiveRuns(opts: {
  /** The runs as the tick reads them (`implicitPauses` applied, which leaves a live run as it was). */
  runs: readonly RunFact[];
  roster: Readonly<Record<string, FleetRosterEntry>>;
  campaigns?: readonly Campaign[];
  /** Run ids the supervisor's own processes hold. */
  running: ReadonlySet<string>;
  /** Accounts a live job holds, upper-cased. */
  busyAccounts: ReadonlySet<string>;
}): UnownedRun[] {
  const out: UnownedRun[] = [];
  const busy = new Set(opts.busyAccounts);
  const names = Object.keys(opts.roster);
  for (const f of opts.runs) {
    if (!f.live || !f.runId.startsWith("fleet-") || f.account === null) continue;
    if (opts.running.has(f.runId) || onBusyAccount(f, busy)) continue;
    const ref =
      (f.ref != null && opts.roster[f.ref] !== undefined ? f.ref : undefined) ??
      refOfRunId(f.runId, f.episode, names) ??
      names.find((n) => entryOwnsRun(opts.roster[n]!, f));
    // Every account the run holds: a fan-out run's whole grant.
    const held = accountsOfRun(f);
    for (const a of held) busy.add(a.toUpperCase());
    out.push({
      runId: f.runId,
      account: f.account,
      ...(held.length > 1 ? { accounts: held } : {}),
      refs: ref !== undefined ? [ref] : [],
      model: f.model,
      episode: f.episode,
      credential: f.credential,
      driver: f.driver,
      resumesInPlace: resumesOnPause(f.episode, campaignResumeOf(opts.campaigns, f.campaign, f.campaignVersion ?? null)),
    });
  }
  return out;
}

/**
 * Runs nothing came back for. Pure.
 *
 * The host slept, or the fleet was down for half a day: a run left live or
 * paused is cooked, because its episode budget elapsed in wall clock while
 * nobody was playing it. Every such run is ENDED — a failed attempt when it
 * was waiting on its provider, `stale` otherwise, since an offline gap is the
 * harness's weather and not the model's failure. Freeplay is not: it has no
 * budget to elapse, and `classifyLapse` resumes it however long the gap.
 *
 * Paused runs are handled by `planResumes`, which walks them anyway; this
 * covers the ones with no pause record at all — a scored run whose process
 * died with the machine (`implicitPauses` has already turned the resumable
 * lanes' verdict-less runs into paused ones).
 */
export function planStaleRuns(opts: {
  runs: readonly RunFact[];
  campaigns?: readonly Campaign[];
  /** Roster ref names, so an ended run can name the job it was launched under. */
  refs?: readonly string[];
  /** Run ids the supervisor's own processes hold; never ended from under them. */
  running?: ReadonlySet<string>;
  /**
   * Accounts a live job holds, upper-cased. A run on one of them is left
   * alone even if it looks cold: the supervisor cannot name the run ids its
   * children are playing, and ending a live run's row would be worse than
   * leaving a dead one open for another tick.
   */
  busyAccounts?: ReadonlySet<string>;
  now: number;
}): EndedRun[] {
  const running = opts.running ?? new Set<string>();
  const busy = opts.busyAccounts ?? new Set<string>();
  const out: EndedRun[] = [];
  for (const f of opts.runs) {
    if (f.pause !== null || running.has(f.runId)) continue;
    if (!f.runId.startsWith("fleet-")) continue; // not the fleet's run, not the fleet's verdict
    if (onBusyAccount(f, busy)) continue;
    const gap = staleForMs(f, opts.now);
    if (gap === null) continue;
    const lapse = classifyLapse({
      episode: f.episode,
      campaignResume: campaignResumeOf(opts.campaigns, f.campaign, f.campaignVersion ?? null),
      pause: null,
      staleForMs: gap,
    });
    if (lapse.kind === "resume") continue;
    out.push({
      runId: f.runId,
      model: f.model,
      effort: f.effort,
      ...(f.compactWindow != null ? { compactWindow: f.compactWindow } : {}),
      ref: refOfRunId(f.runId, f.episode, opts.refs ?? []) ?? null,
      episode: f.episode,
      reason: lapse.reason!,
      detail: lapse.detail!,
      account: f.account,
    });
  }
  return out;
}

/**
 * Which paused runs to resume this tick, and which to list instead. Pure.
 *
 * A run maps back to its job by what the run recorded — model, effort,
 * episode — against the roster; a pinned or queued job from the file takes
 * it, else a policy model gets a synthetic policy job (the attempt number is
 * read off the run id's `-aN`). A run whose job ref now names a DIFFERENT
 * model is ended (`end`): it has nothing to come back under, and the policy
 * will schedule the ref's current model fresh. A run whose model or tier is
 * otherwise no longer in the file stays paused and is listed: the operator
 * resumes it by hand or archives it. Resumes go to the account the run was
 * on (the character lives there), so a busy account means waiting, never a
 * different account.
 */
export function planResumes(opts: {
  runs: readonly RunFact[];
  config: Pick<FleetConfig, "jobs" | "roster" | "policy" | "accounts"> & Partial<Pick<FleetConfig, "campaigns">>;
  /** job name -> account, every job with a process (pinned ones included). */
  running: ReadonlyMap<string, string>;
  held: (account: string) => string | undefined;
  now: number;
  /**
   * A run's own `campaign.json` (`runCampaignFile`), or null when it has none.
   * A paused probe is rebuilt from it, arm included, or from the published
   * definition when it has none (`pausedProbeFile`); absent reads every run as
   * having none.
   */
  campaignFileOf?: (runId: string) => CampaignFile | null;
  /**
   * Whether a run's directory holds `image.json`, the record a run pod's
   * launcher writes when the container starts. Absent reads every run as
   * having none.
   */
  hasImageRecord?: (runId: string) => boolean;
  /**
   * Why this run's credential holds its resume — its budget
   * (`CredentialGate`), or the credential gone or disabled — or undefined.
   * Absent holds nothing. A paused run comes back only on the credential it
   * recorded (`placeResume`).
   */
  credentialHold?: (f: RunFact) => ResumeHold | undefined;
  /**
   * The jobs with a live process, with their refs and episode. A freeplay
   * resume waits while one of them plays its model on a scored episode or
   * another freeplay session: one character per model, before the run it
   * spawned reads live. Absent: only the live runs are asked.
   */
  inFlight?: readonly { name: string; refs: readonly string[]; episode?: EpisodeId | null | undefined }[];
}): { resume: ResumePlan[]; listed: PausedListing[]; end: EndedRun[] } {
  const { config, now } = opts;
  const ownCampaignFile = opts.campaignFileOf ?? ((): CampaignFile | null => null);
  const hasImageRecord = opts.hasImageRecord ?? ((): boolean => false);
  const resume: ResumePlan[] = [];
  const listed: PausedListing[] = [];
  const end: EndedRun[] = [];
  const takenAccounts = new Set([...opts.running.values()].map((a) => a.toUpperCase()));
  const takenJobs = new Set(opts.running.keys());
  const policyNames = policyRefs(config);
  // A pool account may carry a resume: a run comes back on its own account.
  const poolSet = new Set(scheduledAccounts(config).map((a) => a.toUpperCase()));
  // Archived runs are read for the ladder, never for a resume: there is no
  // directory under the runs dir for `--resume` to open.
  // Newest START first, the order the character head and the model hold read
  // (`byNewestStart`): of two paused runs of one model (or of one pinned
  // campaign, below), the one resumed is the one the rest of the supervisor
  // already treats as the character's head.
  const paused = opts.runs.filter((f) => f.pause !== null && f.archived !== true).sort(byNewestStart);
  const seenModel = new Set<string>();
  /** Paused party members whose lane resumes them, by party id: they come back whole, below. */
  const partyPaused = new Map<string, RunFact[]>();
  for (const f of paused) {
    const pause = f.pause!;
    // A wait on a credential's usage window: its figures are the operator's.
    const onCredential = f.credential !== null;
    const list = (why: string, resumeAfter: number | null = null, subscriptionWait = false, hold?: ResumeHoldCode): void => {
      listed.push({
        runId: f.runId,
        model: f.model,
        account: f.account,
        reason: pause.reason,
        since: pause.at,
        pauseCount: pause.count,
        resumeAfter,
        elapsedMs: pause.episodeElapsedMs,
        budgetMs: f.episodeMs,
        why,
        ...(subscriptionWait || pause.reason === SUBSCRIPTION_PAUSE ? { subscriptionWait: true as const } : {}),
        ...(hold !== undefined ? { hold } : {}),
      });
    };
    // Another series' paused run is not this supervisor's to resume — the
    // harness it ran under is not the one running now — and just as
    // importantly it is not this supervisor's to END: the sweep below would
    // write a termination on every paused run left over from every older
    // series (42 of them on 2026-09-08). It used to be filtered out before the
    // loop, which made it invisible everywhere, including in `--status`. A
    // FRESH one is listed instead, because that is a run somebody is waiting
    // on; a cold one stays out of the listing, as it always was. Cold by the
    // wall clock, not by `isStaleRun`: a freeplay run is never stale, and this
    // is a listing of another supervisor's runs, not a decision about one.
    //
    // A probe a run pod ran is exempt, while it resumes as one (run pods on,
    // or a codex probe, which always is: `episodeRunsInPod`): the launcher
    // relaunches the digest it recorded in image.json, not this supervisor's
    // build, so the harness running now is beside the point. A campaign.json
    // alone pins nothing — with run pods off, or for a probe that ran as a
    // child process, the resume would run on this build — so such a probe
    // keeps the gate like any other run.
    const pinnedBuild = f.episode === "probing" && (config.policy.runPods === "probes" || driverEntry(f.driver)?.runPod === true) && hasImageRecord(f.runId);
    if (!pinnedBuild && !inSeries(f, config.policy)) {
      if (now - lastActivityOf(f) <= staleAfterMs(f.episodeMs)) {
        list(
          `paused under harness series ${f.harnessSeries ?? "unversioned"}, this supervisor runs ${config.policy.series ?? "no series"} — resume by hand (--resume ${f.runId}) or archive`,
        );
      }
      continue;
    }
    const probeFile = f.episode === "probing" && f.campaign !== null ? pausedProbeFile(f, config.campaigns ?? [], ownCampaignFile) : null;
    const file = probeFile !== null && "file" in probeFile ? probeFile.file : null;
    // One character per model: an arm's own compaction window is not a
    // different model, so it does not make a second paused run of one entry
    // resumable beside the first.
    // Nor is the driver's default window a different model from its `auto`:
    // an entry with no window owns both (`entryOwnsWindow`), so a run of each
    // is still one entry's two paused runs.
    const armWindow = file !== null && armArg(file.arm, "compact-window") !== undefined;
    const windowKey = armWindow ? "" : rosterWindowKey(f);
    const modelKey = resumeModelKey(f, windowKey);
    const launchedUnder = refOfRunId(f.runId, f.episode, Object.keys(config.roster));
    const current = launchedUnder === undefined ? undefined : config.roster[launchedUnder];
    if (launchedUnder !== undefined && current !== undefined && !entryOwnsRun(current, f)) {
      end.push({
        runId: f.runId,
        model: f.model,
        effort: f.effort,
        ...(f.compactWindow != null ? { compactWindow: f.compactWindow } : {}),
        ...(f.driver != null ? { driver: f.driver } : {}),
        ref: launchedUnder,
        episode: f.episode,
        reason: "manual",
        detail: `ended by the supervisor: model ${f.model} no longer under ref ${launchedUnder}`,
        account: f.account,
      });
      continue;
    }
    // The lane decides whether a lapse is resumed at all. A scored
    // eval never is — it is a failed attempt, the account and character go
    // back, and the scheduler gives the model a fresh one. Freeplay resumes,
    // and a campaign resumes only if it asked to.
    const lapse = classifyLapse({
      episode: f.episode,
      campaignResume: campaignResumeOf(config.campaigns, f.campaign, f.campaignVersion ?? null),
      pause,
      staleForMs: staleForMs(f, now),
    });
    if (lapse.kind !== "resume") {
      // Only a run the fleet launched is the fleet's to end. A hand-started
      // run is listed exactly as it always was: the operator resumes it or
      // archives it, and the supervisor does not write a verdict on work it
      // did not commission.
      if (!f.runId.startsWith("fleet-")) {
        list(`${lapse.detail} — hand-launched, so the supervisor leaves it: resume by hand (--resume ${f.runId}) or archive`);
        continue;
      }
      end.push({
        runId: f.runId,
        model: f.model,
        effort: f.effort,
        ...(f.compactWindow != null ? { compactWindow: f.compactWindow } : {}),
        ...(f.driver != null ? { driver: f.driver } : {}),
        ref: launchedUnder ?? null,
        episode: f.episode,
        reason: lapse.reason!,
        detail: lapse.detail!,
          account: f.account,
      });
      continue;
    }
    // A party member is never resumed alone, and its siblings are the same
    // model on purpose: the party is grouped and planned whole below.
    if (f.party != null && f.episode === "probing") {
      partyPaused.set(f.party.id, [...(partyPaused.get(f.party.id) ?? []), f]);
      continue;
    }
    // One character per model is the policy's rule, and a pinned campaign is
    // outside it: its square runs on its own account beside whatever else the
    // model is playing (`pinnedCampaignJobs` asks health, not "running"). So
    // its paused run is one of the campaign's, not one of the model's: keyed by
    // the model it claimed the model's single resume, and every other paused
    // run of that model — another pinned campaign's, its freeplay — was listed
    // while the campaign's square was offered again and spawned a fresh `-a2`
    // over the paused run. A campaign's own older attempt still waits behind
    // its newest-started one.
    const pinnedCampaign = file === null ? undefined : config.campaigns?.find((c) => c.name === file.campaign && (c.account !== undefined || c.drawsAccounts === true));
    const resumeKey = pinnedCampaign !== undefined ? `campaign:${pinnedCampaign.name}` : modelKey;
    if (seenModel.has(resumeKey)) {
      list(`a later-started paused run of ${pinnedCampaign !== undefined ? `campaign ${pinnedCampaign.name}` : "this model"} is ahead of it — resume by hand or archive`);
      continue;
    }
    seenModel.add(resumeKey);
    const refs = Object.entries(config.roster)
      .filter(([, e]) => entryOwnsRun(e, f))
      .map(([name]) => name);
    // The ref the run id NAMES is the authority, and it is the authority on
    // BOTH paths below. Two roster entries may share a model and an effort
    // while sitting in different lanes, so matching on model+effort alone lets
    // a configured job written for one of them claim a run launched under the
    // other — taking its job name, lane, account and credentials with it, none
    // of which the run was launched with. Model+effort is the fallback for a
    // run id no ref matches, and nothing else.
    //
    // A rotation job that genuinely lists the authoritative ref still claims
    // the run: this narrows which refs may be matched, not which jobs.
    const candidates = launchedUnder !== undefined ? [launchedUnder] : refs;
    const fromFile = config.jobs.find((j) => j.refs.some((r) => candidates.includes(r)) && j.episode === f.episode);
    let job: FleetJob | undefined;
    let account: string | null = f.account;
    if (fromFile !== undefined) {
      if (!fromFile.enabled) {
        list(`job ${fromFile.name} is disabled — enable it to resume, or resume by hand`);
        continue;
      }
      if (fromFile.account !== undefined && f.account !== null && fromFile.account.toUpperCase() !== f.account.toUpperCase()) {
        list(`pinned job ${fromFile.name} is on ${fromFile.account}, the run was on ${f.account} — resume by hand`);
        continue;
      }
      job = fromFile;
      account = fromFile.account ?? f.account;
    } else if (f.episode === "probing") {
      // A probe whose definition asked to resume (the lapse rule above already
      // said so) comes back under the job it was spawned as, rebuilt from the
      // run's own campaign.json — or, for a run from before campaign files,
      // from the published definition its stamps name (`pausedProbeFile`): the
      // campaign, its version, the cell and the arm, and the roster name it
      // stamped. The spawn carries that file, so the run resumes on its own
      // arm whatever has been published since. Without this a supervisor
      // restart stranded a paused probe as "not in config", and the paused run
      // then held its model out of every lane until someone resumed it by hand
      // — on a twelve-hour cell, the most expensive way to lose one.
      if (probeFile !== null && "why" in probeFile) {
        list(`paused probe with ${probeFile.why} — resume by hand or archive`);
        continue;
      }
      const c = file === null ? undefined : config.campaigns?.find((x) => x.name === file.campaign);
      const ref = f.ref ?? launchedUnder;
      if (file === null || c === undefined || ref === undefined || config.roster[ref] === undefined) {
        list("paused probe whose campaign row or roster entry the config no longer names — resume by hand or archive");
        continue;
      }
      if (!c.enabled) {
        list(`campaign ${c.name} is disabled — enable it to resume, or resume by hand`);
        continue;
      }
      // The run's own version, not the row's: a row that moved on still
      // names the versions the operator concluded.
      if (isConcluded(c, file.version)) {
        list(`campaign ${c.name}@${file.version} is concluded — it owes nothing; resume by hand or archive`);
        continue;
      }
      // A pinned arm runs only in a run pod. With them off the launcher would
      // refuse the resume before the run moved, the pause would stand, and the
      // next tick would try again: it waits, listed, for the switch.
      if ((file.arm.image !== undefined || file.arm.command !== undefined) && config.policy.runPods !== "probes") {
        list(`arm ${file.arm.id} pins ${file.arm.image !== undefined ? "an image" : "a command"} and runs only in a run pod; policy.runPods is ${JSON.stringify(config.policy.runPods)} — it resumes once that is "probes"`);
        continue;
      }
      const probe = { campaign: file.campaign, version: file.version, cell: file.cell.id, arm: file.arm.id };
      // A one-agent arm whose party drew its accounts comes back on the ones it drew.
      const drawnFanout = c.drawsAccounts === true ? file.fanout?.members.map((m) => m.account) : undefined;
      if (c.drawsAccounts === true && (drawnFanout === undefined || drawnFanout.some((a) => !isEvalPoolAccountName(a)))) {
        list(`campaign ${c.name} draws its accounts from the eval pool, and the run holds ${drawnFanout?.join(", ") ?? f.account ?? "none"} — resume by hand`);
        continue;
      }
      if (drawnFanout !== undefined) {
        job = {
          refs: [ref],
          ref,
          episode: "probing",
          repeat: 1,
          name: pinnedCampaignJobName(file.campaign, file.cell.id, file.arm.id),
          account: drawnFanout[0]!,
          enabled: true,
          source: "pinned",
          probe,
          campaignFile: file,
          accounts: drawnFanout,
          fanout: true as const,
        };
        account = drawnFanout[0]!;
      } else if (c.account !== undefined) {
        if (f.account !== null && c.account.toUpperCase() !== f.account.toUpperCase()) {
          list(`campaign ${c.name} is pinned to ${c.account}, the run was on ${f.account} — resume by hand`);
          continue;
        }
        // A one-agent arm's run holds the party's accounts, which the
        // campaign must still be pinned to, in the same order.
        const fanout = file.fanout?.members.map((m) => m.account);
        if (fanout !== undefined && (c.accounts === undefined || c.accounts.length !== fanout.length || c.accounts.some((a, i) => a.toUpperCase() !== fanout[i]!.toUpperCase()))) {
          list(`campaign ${c.name} is pinned to ${(c.accounts ?? [c.account]).join(", ")}, the run holds ${fanout.join(", ")} — resume by hand`);
          continue;
        }
        job = {
          refs: [ref],
          ref,
          episode: "probing",
          repeat: 1,
          name: pinnedCampaignJobName(file.campaign, file.cell.id, file.arm.id),
          account: c.account,
          enabled: true,
          source: "pinned",
          probe,
          campaignFile: file,
          ...(fanout !== undefined ? { accounts: fanout, fanout: true as const } : {}),
        };
        account = c.account;
      } else {
        // The name `policyJob` gives a probe pick, and the attempt its run id carries.
        const m = /-a(\d+)(?:-r\d+)?$/.exec(f.runId);
        job = {
          refs: [ref],
          ref,
          episode: "probing",
          repeat: 1,
          name: policyCampaignJobName(ref, file.campaign, file.cell.id, file.arm.id),
          enabled: true,
          source: "policy",
          attempt: m !== null ? Number(m[1]) : 1,
          probe,
          campaignFile: file,
        };
      }
    } else {
      // Only the ref the run was launched under decides whether it may come
      // back — under its own job name, which is what the run id, the log path
      // and the defer sidecar all hang off.
      //
      // The policy makes freeplay runs too — the one continuous `idle:
      // "unlimited"` session an eligible ref gets — so a paused one comes back
      // under the same synthetic job as an e90/e360 lapse, on its own account
      // and its own run id. Without this a fleet restart stranded the session
      // and the policy started the next attempt on a fresh character, which is
      // the continuity the unlimited lane exists for. A ref not in that lane
      // owes no freeplay session, so its run is listed rather than resumed.
      const ref = candidates.find((r) => policyNames.has(r) && (f.episode !== "freeplay" || config.roster[r]?.idle === "unlimited"));
      if (ref === undefined || (f.episode !== "e90" && f.episode !== "e360" && f.episode !== "freeplay")) {
        list("paused, not in config — resume by hand or archive");
        continue;
      }
      const m = /-a(\d+)(?:-r\d+)?$/.exec(f.runId);
      job = {
        refs: [ref],
        ref,
        episode: f.episode,
        repeat: 1,
        name: `${ref}-${f.episode}`,
        enabled: true,
        source: "policy",
        attempt: m !== null ? Number(m[1]) : 1,
      };
    }
    if (account === null) {
      list("the run recorded no account — resume by hand");
      continue;
    }
    // A fan-out run comes back holding every one of its accounts, and only as
    // what the fleet launches one as: a party campaign's one-agent arm.
    if (f.fanoutAccounts != null && job.fanout !== true) {
      list(`a fan-out run on ${f.fanoutAccounts.join(", ")} comes back only as a party campaign's one-agent arm — resume by hand`);
      continue;
    }
    const holds = job.fanout === true ? job.accounts! : [account];
    if (job.account === undefined && !poolSet.has(account.toUpperCase())) {
      list(`account ${account} is not in the account pool — resume by hand`);
      continue;
    }
    if (takenJobs.has(job.name)) continue; // its roster is running; it handles its own pause
    const notBefore = resumeNotBefore(pause);
    if (notBefore === "never") {
      list(`${pause.reason}, ${pause.count} ladder pauses since it last made a turn — past the defer ladder; resume by hand when the provider is back`);
      continue;
    }
    if (notBefore !== null && now < notBefore) {
      const waiting =
        providerResetOf(pause) !== undefined
          ? `${pause.reason}, resuming at ${new Date(notBefore).toLocaleString()} (${onCredential ? "usage window reset" : "provider reset"})`
          : `${pause.reason}, pause ${pause.count}: resuming after ${new Date(notBefore).toLocaleTimeString()}`;
      list(waiting, notBefore, onCredential && providerResetOf(pause) !== undefined);
      continue;
    }
    // The credential's budget: one at or over this run's threshold holds the
    // resume until its window resets (operator, 2026-10-16), and a credential
    // gone or disabled holds it until the operator says otherwise.
    // Every credential hold is withheld publicly (`subscriptionWait`, which a
    // projection of any build keys on), and `hold` says which kind it is.
    const gated = opts.credentialHold?.(f);
    if (gated !== undefined) {
      list(gated.text, null, true, gated.code ?? undefined);
      continue;
    }
    // One character per model: a paused freeplay run holds none of its model's
    // scored episodes (`schedulability`), so one may be playing when the
    // resume comes due, under this entry or another of the model's. The
    // resume waits for it, as for a busy account. A pinned job is outside the
    // policy's rule, as a pinned campaign is.
    // Under another entry of the model (the same model on another provider,
    // operator 2026-11-16), only a scored run holds it: that entry's freeplay
    // character is its own.
    if (f.episode === "freeplay" && job.account === undefined) {
      const anyProvider = resumeModelKey(f, windowKey, true);
      const ofThisModel = (g: RunFact): boolean =>
        resumeModelKey(g, rosterWindowKey(g)) === modelKey || (EPISODES[g.episode].scored && resumeModelKey(g, rosterWindowKey(g), true) === anyProvider);
      const playing = opts.runs.find((g) => g.live && g.runId !== f.runId && g.episode !== "probing" && ofThisModel(g));
      if (playing !== undefined) {
        list(`waiting: ${playing.runId} plays ${f.model} (${playing.episode}) — one character per model`);
        continue;
      }
      const owner = opts.inFlight?.find(
        (j) =>
          j.name !== job.name &&
          j.episode !== "probing" &&
          j.refs.some((r) => {
            const e = config.roster[r];
            return e !== undefined && (entryOwnsRun(e, f) || (j.episode != null && EPISODES[j.episode].scored && sameModel(e, f)));
          }),
      );
      if (owner !== undefined) {
        list(`waiting: job ${owner.name} plays ${f.model}${owner.episode != null ? ` (${owner.episode})` : ""} — one character per model`);
        continue;
      }
    }
    // Every account or none: a fan-out run never comes back on part of its grant.
    const busyOne = holds.find((a) => takenAccounts.has(a.toUpperCase()));
    if (busyOne !== undefined) {
      list(`waiting: account ${busyOne} is busy (${[...opts.running].find(([, a]) => a.toUpperCase() === busyOne.toUpperCase())?.[0] ?? "another job"})`);
      continue;
    }
    const heldOne = holds.map((a) => [a, opts.held(a)] as const).find(([, h]) => h !== undefined && h !== f.runId);
    if (heldOne !== undefined) {
      list(`waiting: account ${heldOne[0]} is held by run ${heldOne[1]}`);
      continue;
    }
    for (const a of holds) takenAccounts.add(a.toUpperCase());
    takenJobs.add(job.name);
    resume.push({
      job: {
        ...job,
        resume: {
          runId: f.runId,
          model: f.model,
          ...(f.effort !== null ? { effort: f.effort } : {}),
          // The entry's identity, which an arm's own window is not part of.
          ...(f.compactWindow != null && !armWindow ? { compactWindow: f.compactWindow } : {}),
          ...(f.driver != null ? { driver: f.driver } : {}),
        },
      },
      account,
      runId: f.runId,
      pauseCount: pause.count,
      why: `${pause.reason}${
        providerResetOf(pause) !== undefined ? " (provider reset passed)" : pause.count > 1 ? ` (pause ${pause.count})` : ""
      }, ${fmtPaused(pause.episodeElapsedMs, f.episodeMs)}${probeFile !== null && "rebuilt" in probeFile && probeFile.rebuilt ? `; campaign.json rebuilt from the published ${file!.campaign}@${file!.version}` : ""}`,
      ...(probeFile !== null && "rebuilt" in probeFile && probeFile.rebuilt ? { writeCampaignFile: probeFile.file } : {}),
    });
  }
  for (const [id, members] of partyPaused) {
    const plan = planPartyResume(id, members, {
      runs: opts.runs,
      config,
      now,
      ownCampaignFile,
      takenAccounts,
      takenJobs,
      held: opts.held,
      running: opts.running,
      ...(opts.credentialHold !== undefined ? { credentialHold: opts.credentialHold } : {}),
    });
    if ("listed" in plan) {
      listed.push(...plan.listed);
      continue;
    }
    if (plan.skip) continue;
    for (const a of plan.resume.job.accounts ?? [plan.resume.account]) takenAccounts.add(a.toUpperCase());
    takenJobs.add(plan.resume.job.name);
    resume.push(plan.resume);
  }
  return { resume, listed, end };
}

/**
 * The key one character per model groups a run under when resuming: model,
 * effort and the entry's window (`rosterWindowKey`, or "" for an arm's own).
 * A probe-only driver's run is never another entry's (`entryOwnsRun`).
 * `anyProvider` keys the model by its identity across providers
 * (`canonicalModelId`) rather than the id the run recorded.
 */
function resumeModelKey(f: Pick<RunFact, "model" | "effort" | "driver">, windowKey: string, anyProvider = false): string {
  const model = anyProvider && f.model !== null ? canonicalModelId(f.model) : f.model;
  return `${model}@${f.effort ?? ""}@${windowKey}${isProbeOnlyDriver(f.driver) ? "@probe-only" : ""}`;
}

/**
 * The projection as a tick that resumes freeplay runs reads it: every entry
 * of a resumed run's model reads that run as playing (`ModelState.playing`),
 * so the policy picks none of the model's scored episodes on the tick the
 * character comes back, as it picks none while it plays. Pure.
 */
export function withResumesPlaying(
  states: readonly ModelState[],
  resumes: readonly Pick<ResumePlan, "job" | "runId">[],
  roster: Readonly<Record<string, FleetRosterEntry>>,
): ModelState[] {
  const back = resumes.filter((r) => r.job.episode === "freeplay" && r.job.resume !== undefined);
  if (back.length === 0) return [...states];
  return states.map((s) => {
    const entry = roster[s.name];
    if (entry === undefined || s.playing?.episode === "freeplay") return s;
    const r = back.find((x) => entryOwnsRun(entry, x.job.resume!));
    if (r !== undefined) return { ...s, playing: { runId: r.runId, episode: "freeplay", resuming: true } };
    // Another entry of the model's character coming back holds this one's scored episodes too.
    const sib = back.find((x) => sameModel(entry, x.job.resume!));
    return sib === undefined || s.siblingPlaying !== undefined ? s : { ...s, siblingPlaying: { runId: sib.runId, episode: "freeplay", resuming: true } };
  });
}

/**
 * A paused party, planned whole (docs/proposals/GROUP-PLAY.md §1, "Shared
 * fate"): one resume of every member at once, or a listing of each member
 * with why not. It comes back when every one of its members is on disk and
 * paused, its campaign still names the same accounts, every member's own
 * pause has run its course (the latest `resumeNotBefore` of them, which is
 * the first member's — a `party-paused` member waits on nothing of its own),
 * no member's credential is held by its budget, and every member's account is
 * free. A party whose members cannot all come back — one ended, one missing,
 * one in another series — is listed, never half-resumed.
 */
function planPartyResume(
  id: string,
  members: readonly RunFact[],
  o: {
    runs: readonly RunFact[];
    config: Pick<FleetConfig, "roster" | "policy"> & Partial<Pick<FleetConfig, "campaigns">>;
    now: number;
    ownCampaignFile: (runId: string) => CampaignFile | null;
    takenAccounts: ReadonlySet<string>;
    takenJobs: ReadonlySet<string>;
    held: (account: string) => string | undefined;
    running: ReadonlyMap<string, string>;
    credentialHold?: (f: RunFact) => ResumeHold | undefined;
  },
): { resume: ResumePlan; skip?: false } | { skip: true } | { listed: PausedListing[] } {
  const listAll = (why: string, resumeAfter: number | null = null, subscriptionWait = false, hold?: ResumeHoldCode): { listed: PausedListing[] } => ({
    listed: members.map((f) => ({
      runId: f.runId,
      model: f.model,
      account: f.account,
      reason: f.pause!.reason,
      since: f.pause!.at,
      pauseCount: f.pause!.count,
      resumeAfter,
      elapsedMs: f.pause!.episodeElapsedMs,
      budgetMs: f.episodeMs,
      why: `party ${id}: ${why}`,
      ...(subscriptionWait ? { subscriptionWait: true as const } : {}),
      ...(hold !== undefined ? { hold } : {}),
    })),
  });
  const size = members[0]!.party!.size;
  const all = o.runs.filter((r) => r.party?.id === id);
  const whole = all.length === size && members.length === size && all.every((r) => r.pause !== null && r.terminationReason === null && r.archived !== true);
  if (!whole) {
    const states = all.map((r) => `${r.party!.member} ${r.terminationReason ?? (r.pause !== null ? `paused ${r.pause.reason}` : "live")}`).join(", ");
    return listAll(`not every member can come back (${states || "none on disk"}; ${all.length} of ${size}) — a party resumes whole; resume or end it by hand`);
  }
  const leaderFile = members.map((f) => o.ownCampaignFile(f.runId)).find((x) => x !== null) ?? null;
  const launch = leaderFile?.party;
  if (leaderFile === null || launch === undefined) return listAll("no member's campaign.json names the party — resume by hand or archive");
  const byRun = new Map(members.map((f) => [f.runId, f]));
  if (launch.members.some((m) => !byRun.has(m.runId))) return listAll("its campaign file names runs that are not its paused members — resume by hand");
  const ordered = launch.members.map((m) => byRun.get(m.runId)!);
  const leader = ordered[0]!;
  const c = o.config.campaigns?.find((x) => x.name === leaderFile.campaign);
  const ref = leader.ref ?? undefined;
  if (c === undefined || ref === undefined || o.config.roster[ref] === undefined) {
    return listAll("its campaign row or roster entry is no longer in the config — resume by hand or archive");
  }
  if (!c.enabled) return listAll(`campaign ${c.name} is disabled — enable it to resume, or resume by hand`);
  if (isConcluded(c, leaderFile.version)) return listAll(`campaign ${c.name}@${leaderFile.version} is concluded — it owes nothing; resume by hand or archive`);
  const accounts = launch.members.map((m) => m.account);
  if (c.drawsAccounts === true) {
    // It comes back on the accounts it drew, which must still be the eval pool's.
    if (accounts.some((a) => !isEvalPoolAccountName(a))) return listAll(`campaign ${c.name} draws its accounts from the eval pool, and the party ran on ${accounts.join(", ")} — resume by hand`);
  } else {
    const pinned = c.accounts ?? [];
    if (pinned.length !== accounts.length || pinned.some((a, i) => a.toUpperCase() !== accounts[i]!.toUpperCase())) {
      return listAll(`campaign ${c.name} is pinned to ${pinned.join(", ") || "no accounts"}, the party ran on ${accounts.join(", ")} — resume by hand`);
    }
  }
  if ((leaderFile.arm.image !== undefined || leaderFile.arm.command !== undefined) && o.config.policy.runPods !== "probes") {
    return listAll(`arm ${leaderFile.arm.id} runs only in a run pod; policy.runPods is ${JSON.stringify(o.config.policy.runPods)} — it resumes once that is "probes"`);
  }
  const name = pinnedCampaignJobName(leaderFile.campaign, leaderFile.cell.id, leaderFile.arm.id);
  if (o.takenJobs.has(name)) return { skip: true };
  // The party waits on its slowest member's own pause.
  let notBefore: number | null = null;
  for (const f of ordered) {
    const nb = resumeNotBefore(f.pause!);
    if (nb === "never") return listAll(`${f.party!.member}: ${f.pause!.reason}, ${f.pause!.count} ladder pauses since it last made a turn — past the defer ladder; resume by hand`);
    if (nb !== null && (notBefore === null || nb > notBefore)) notBefore = nb;
  }
  const cause = ordered.find((f) => f.pause!.reason !== PARTY_PAUSE) ?? leader;
  if (notBefore !== null && o.now < notBefore) {
    return listAll(`${cause.party!.member} ${cause.pause!.reason}: resuming after ${new Date(notBefore).toLocaleTimeString()}`, notBefore);
  }
  for (const f of ordered) {
    const gated = o.credentialHold?.(f);
    if (gated !== undefined) return listAll(gated.text, null, true, gated.code ?? undefined);
  }
  for (const [i, a] of accounts.entries()) {
    if (o.takenAccounts.has(a.toUpperCase())) {
      return listAll(`waiting: account ${a} is busy (${[...o.running].find(([, x]) => x.toUpperCase() === a.toUpperCase())?.[0] ?? "another job"})`);
    }
    const holder = o.held(a);
    if (holder !== undefined && holder !== ordered[i]!.runId) return listAll(`waiting: account ${a} is held by run ${holder}`);
  }
  const m = /-a(\d+)$/.exec(id);
  return {
    resume: {
      job: {
        refs: [ref],
        ref,
        episode: "probing",
        repeat: 1,
        name,
        account: accounts[0]!,
        accounts,
        enabled: true,
        source: "pinned",
        probe: { campaign: leaderFile.campaign, version: leaderFile.version, cell: leaderFile.cell.id, arm: leaderFile.arm.id },
        campaignFile: leaderFile,
        partyId: id,
        attempt: m !== null ? Number(m[1]) : 1,
        resume: {
          runId: leader.runId,
          model: leader.model,
          ...(leader.effort !== null ? { effort: leader.effort } : {}),
          ...(leader.driver != null ? { driver: leader.driver } : {}),
        },
      },
      account: accounts[0]!,
      runId: leader.runId,
      pauseCount: Math.max(...ordered.map((f) => f.pause!.count)),
      why: `party ${id} of ${size}: ${cause.party!.member} ${cause.pause!.reason}, ${fmtPaused(cause.pause!.episodeElapsedMs, cause.episodeMs)}`,
    },
  };
}

/**
 * The run facts as they read once this tick's terminations are on disk. Pure.
 *
 * The projection is built at the top of a tick and the sweep writes its
 * terminations halfway down it, so without this the scheduler reads a ladder
 * that predates the failed attempt it just wrote. That is not a cosmetic lag: on
 * 2026-08-25 the first tick after the lane-resume rule shipped logged
 * `retry 3/3 — tainted` for nemotron-ultra and spawned its ninth attempt one
 * second later, because the projection behind the pick still said zero.
 *
 * Applied rather than re-read: the same values `setTermination` just wrote, so
 * the answer is exactly next tick's without a second pass over the directory.
 * A run that was paused stops being paused here too, which is the other half —
 * a run the sweep ended must not go on holding its model or its account.
 */
export function applyEnded(runs: readonly RunFact[], ended: readonly EndedRun[], now: number): RunFact[] {
  if (ended.length === 0) return [...runs];
  const by = new Map(ended.map((e) => [e.runId, e]));
  return runs.map((f) => {
    const e = by.get(f.runId);
    return e === undefined ? f : { ...f, terminationReason: e.reason, endedAt: now, pause: null, live: false };
  });
}


// ---------------------------------------------------------- freeplay characters
//
// A freeplay character is durable (operator ask, 2026-08-29): the operator
// disables and re-enables an `idle: "unlimited"` ref at will, and the character
// comes back to the same account, the same character and the same scratchpad
// instead of a fresh level-1 character. Its identity is nothing new on disk:
// the ref's latest ENDED freeplay run that recorded an account and a
// character. A paused one is `planResumes`' (same run id); an ended one — the
// idle watchdog, a hand kill — is continued under the next
// attempt's run id with `--continue-from`, which is the lineage the run
// record then carries. Two things keep the character standing meanwhile:
// every fresh launch on that account keeps it (`--keep-characters`), and the
// cross-account name sweep never deletes it.

/** Where a ref's freeplay character stands: its last ended run, account and name. */
export interface Character {
  runId: string;
  account: string;
  character: string;
}

/** The key a freeplay character is protected under: account and name, case-folded as the realm folds them. */
export function characterKey(account: string, character: string): string {
  return `${account.toUpperCase()}:${character.toLowerCase()}`;
}

/**
 * The character of every `idle: "unlimited"` ref, from the run facts. Pure.
 * Matching is the projection's own (model + effort), as `affinityFrom`;
 * only freeplay runs count, only those that recorded both an account and a
 * character, and only ones that are not LIVE — a live run is the character, not
 * its predecessor. Latest start wins (`byNewestStart`, the order the resume
 * planner and the model hold read too).
 *
 * A PAUSED run is a head too. It used to be excluded on the argument that
 * `planResumes` owns it, and that is true while the supervisor can see it —
 * but the runs directory is the only thing that survives a supervisor, and a
 * paused head the resume planner declines (a spent ladder, a
 * job the operator disabled) then vanished from the chain entirely: on
 * 2026-09-08 the newest attempt of the nemotron-super character sat paused while
 * the policy started a fresh one `--continue-from` the ENDED attempt before
 * it, orphaning the paused one off the chain. The character is the same one
 * either way, so the honest lineage is the newest attempt, resumed or
 * continued from. Nothing here launches anything: a head that IS resumable is
 * resumed by `planResumes`, which reserves its account and job name before the
 * policy picks.
 *
 * So is a run with NO verdict at all — no termination, no pause, no live
 * process. That is a runner killed before it could write (2026-09-20), and
 * excluding it made the run before it the head: the next pick continued a
 * stale predecessor, launches on the account got no `--keep-characters` for
 * the character it was actually playing, and hygiene deleted it. The newest
 * attempt is the head whatever it managed to write on the way down.
 *
 * A character does not carry across a harness series (operator, 2026-11-15):
 * only a run of `series` (`policy.series`; null takes every run, as
 * `inSeries` does) is a head or a predecessor, so a series' first session of
 * a model starts a fresh character. The earlier series' characters stay in
 * the realm (`formerCharactersFrom`), and a paused one is neither resumed nor
 * a hold on its model (`planResumes`, `projectModel`, both in-series too).
 */
export function charactersFrom(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>, series: string | null = null): Map<string, Character> {
  return newestCharacterRuns(runs, roster, (f) => !f.live && (series === null || f.harnessSeries === series));
}

/**
 * The freeplay characters an earlier harness series left standing, which no
 * launch of this series may delete (operator, 2026-11-15): for every roster
 * entry, whatever its `idle` now, the newest attempt of its character in each
 * other series, picked as `charactersFrom` picks a head. Pure. They are kept
 * by every fresh launch on their account, the entry's own included
 * (`keepFor`), and the cross-account sweep skips them. Empty when `series` is
 * null: then every run is the current series'.
 */
export function formerCharactersFrom(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>, series: string | null): Character[] {
  if (series === null) return [];
  const out: Character[] = [];
  const seen = new Set<string>();
  for (const e of Object.values(roster)) {
    const bySeries = new Map<string, RunFact[]>();
    for (const f of runs) {
      if (f.harnessSeries === series || f.live || !isCharacterRun(f) || !entryOwnsRun(e, f)) continue;
      const k = f.harnessSeries ?? "";
      bySeries.set(k, [...(bySeries.get(k) ?? []), f]);
    }
    for (const fs of bySeries.values()) {
      const head = newestStarted(fs)!;
      const key = characterKey(head.account!, head.character!);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ runId: head.runId, account: head.account!, character: head.character! });
    }
  }
  return out;
}

/** A freeplay run that recorded where its character stands, and was not put away without a verdict. */
function isCharacterRun(f: RunFact): boolean {
  return (
    f.episode === "freeplay" &&
    f.account !== null &&
    f.character !== null &&
    // Put away without a verdict: not a run anything resumes or
    // continues, so not one that may displace the head that is.
    !(f.archived === true && f.terminationReason === null)
  );
}

/**
 * The character each `idle: "unlimited"` ref is playing RIGHT NOW: its newest
 * LIVE freeplay run that recorded an account and a character. Pure. The
 * complement of `charactersFrom`, which leaves a live run out because the tick
 * asks what the next session continues from; `--status` asks what is in
 * flight, and naming the predecessor there printed a run that ended a week
 * before as the head of a character that was playing.
 */
export function liveCharactersFrom(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>): Map<string, Character> {
  return newestCharacterRuns(runs, roster, (f) => f.live);
}

function newestCharacterRuns(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>, keep: (f: RunFact) => boolean): Map<string, Character> {
  const out = new Map<string, Character>();
  for (const [name, e] of Object.entries(roster)) {
    if (e.idle !== "unlimited") continue;
    const head = newestStarted(runs.filter((f) => isCharacterRun(f) && keep(f) && entryOwnsRun(e, f)));
    if (head !== undefined) out.set(name, { runId: head.runId, account: head.account!, character: head.character! });
  }
  return out;
}

/**
 * The freeplay characters standing on `account` that a launch of `ref` must
 * keep: the other refs' heads, and every earlier series' character
 * (`formerCharactersFrom`), the ref's own included, since this series never
 * continues one.
 */
export function keepFor(account: string, characters: ReadonlyMap<string, Character>, ref?: string, former: readonly Character[] = []): string[] {
  const out: string[] = [];
  const add = (s: Character): void => {
    if (s.account.toUpperCase() !== account.toUpperCase()) return;
    if (!out.some((c) => c.toLowerCase() === s.character.toLowerCase())) out.push(s.character);
  };
  for (const [name, s] of characters) if (name !== ref) add(s);
  for (const s of former) add(s);
  return out;
}

/** The account a fresh freeplay session of `ref` must have: its character's, else the model's last. */
export function characterAffinity(characters: ReadonlyMap<string, Character>, fallback: AccountAffinity): AccountAffinity {
  return (ref) => characters.get(ref)?.account ?? fallback(ref);
}

/** Who holds an account this tick, for the character rule: the ref, and whether its session has no boundary. */
export interface Occupant {
  ref: string;
  /** A policy freeplay session of an `idle: "unlimited"` ref: no wall clock, ends only by watchdog or hand. */
  unlimited: boolean;
}

/**
 * Where a ref's character head stands against the accounts in use this tick.
 * Pure. `occupants` is keyed by upper-cased account.
 *
 * - `free`: nobody on the head's account — the next pick continues there.
 * - `own`: the ref itself is there (live, or a resume reserving it) — the
 *   run is in flight, nothing to plan.
 * - `boundary`: another ref's BOUNDED run holds it (a scored episode, a
 *   probe, a hand-written job) — it ends at its episode boundary, so the
 *   pick is held; a fresh start would trade a whole character for minutes.
 * - `occupied`: another ref's UNLIMITED session holds it — there is no
 *   boundary to wait for, and the wait is the item-94 deadlock: the pick
 *   starts fresh on a free account, lineage dropped and recorded.
 */
export type CharacterStanding =
  | { kind: "free" }
  | { kind: "own"; occupant: string }
  | { kind: "boundary"; occupant: string }
  | { kind: "occupied"; occupant: string };

export function characterStanding(ref: string, head: Character, occupants: ReadonlyMap<string, Occupant>): CharacterStanding {
  const o = occupants.get(head.account.toUpperCase());
  if (o === undefined) return { kind: "free" };
  if (o.ref === ref) return { kind: "own", occupant: o.ref };
  return o.unlimited ? { kind: "occupied", occupant: o.ref } : { kind: "boundary", occupant: o.ref };
}

/** The one-line reason a character is not continuing this tick, for the log and --status. */
export function describeStanding(head: Character, standing: CharacterStanding): string {
  switch (standing.kind) {
    case "free":
      return `${head.account} is free — continues ${head.runId} (${head.character}) there`;
    case "own":
      return `${head.account} is its own — in flight`;
    case "boundary":
      return `${head.account} is held by ${standing.occupant} until its episode boundary — holding for ${head.character} (${head.runId})`;
    case "occupied":
      return `${head.account} is occupied by ${standing.occupant}'s character — next pick starts FRESH on a free account, lineage ${head.runId} (${head.character}) dropped`;
  }
}

/** A policy pick held back this tick because its character's account is busy. */
export interface CharacterWait {
  name: string;
  head: Character;
  /** The account the pick would have taken instead. */
  offered: string;
  /** Why it holds rather than continuing or starting fresh. */
  why: string;
}

/** A policy pick that started fresh because its character's account is another ref's. */
export interface CharacterDrop {
  name: string;
  head: Character;
  /** The other ref's character on the head's account. */
  occupant: string;
  /** The free account the fresh start went to. */
  account: string;
}

/**
 * The policy's freeplay picks, made to continue their characters. Pure. A pick
 * on an `idle: "unlimited"` ref whose character is on the account it got carries
 * `continueFrom`. One whose character is on another account is decided by
 * `characterStanding`: held while the account will come free at a boundary (or
 * is the ref's own), started FRESH on the account it was offered when
 * another ref's unlimited session sits there — with `continueDropped` naming
 * the head and the reason (`account_occupied_by <ref>`), so the new run's
 * trajectory says the lineage was dropped on purpose. Every pick (and every
 * queue assignment the caller passes) gets the other refs' freeplay characters on
 * its account to keep, and every earlier series' (`former`).
 */
export function planContinuations(
  picks: readonly PolicyPick[],
  characters: ReadonlyMap<string, Character>,
  roster: Record<string, FleetRosterEntry>,
  occupants: ReadonlyMap<string, Occupant> = new Map(),
  former: readonly Character[] = [],
): { picks: PolicyPick[]; waiting: CharacterWait[]; dropped: CharacterDrop[] } {
  const out: PolicyPick[] = [];
  const waiting: CharacterWait[] = [];
  const dropped: CharacterDrop[] = [];
  for (const p of picks) {
    const keep = keepFor(p.account, characters, p.job.ref, former);
    const withKeep = (job: FleetJob): FleetJob => (keep.length > 0 ? { ...job, keepCharacters: keep } : job);
    const head = characters.get(p.job.ref);
    const owns = p.job.source === "policy" && p.job.episode === "freeplay" && roster[p.job.ref]?.idle === "unlimited";
    if (!owns || head === undefined) {
      out.push({ ...p, job: withKeep(p.job) });
      continue;
    }
    if (head.account.toUpperCase() !== p.account.toUpperCase()) {
      const standing = characterStanding(p.job.ref, head, occupants);
      if (standing.kind === "occupied") {
        dropped.push({ name: p.job.name, head, occupant: standing.occupant, account: p.account });
        out.push({
          ...p,
          why: `${p.why}; fresh — ${head.account} is ${standing.occupant}'s`,
          job: withKeep({ ...p.job, continueDropped: { runId: head.runId, reason: `account_occupied_by ${standing.occupant}` } }),
        });
        continue;
      }
      waiting.push({ name: p.job.name, head, offered: p.account, why: describeStanding(head, standing) });
      continue;
    }
    out.push({ ...p, job: withKeep({ ...p.job, continueFrom: head.runId }) });
  }
  return { picks: out, waiting, dropped };
}

/**
 * Whether a disabled job is paused at once rather than drained to its
 * episode boundary. The `idle: "unlimited"` session has no boundary — no
 * wall clock, no call ceiling — so draining it means waiting for the idle
 * watchdog or a hand kill; the operator flipping the ref to `idle: "none"`
 * wants it stopped. SIGTERM takes the pause path (the runner logs the
 * character out and writes `operator-pause`), and the character comes back on
 * re-enable: resumed in place, however long it sat — a freeplay pause never
 * goes stale.
 */
export function pausesOnDrain(job: Pick<FleetJob, "source" | "episode"> | undefined): boolean {
  return job !== undefined && job.source === "policy" && job.episode === "freeplay";
}

/**
 * Why the config no longer keeps a LIVE POLICY job running — the drain reason —
 * or undefined while it does. Pure.
 *
 * A policy job is made up each tick, so it is never in the file and cannot be
 * `enabled: false`; before this, a live one whose ref simply stopped generating
 * work was left enabled forever and ran until its idle watchdog, which an
 * active model never trips (flipping a character's `idle` to `"none"`
 * did nothing until someone SIGTERMed the roster by hand). This is what makes
 * the ROSTER_ENTRY_KEYS hint — "to pause a character set `idle: \"none\"`" — true.
 *
 * The question is asked of the LOADED CONFIG, never of the plan. The caller
 * walks the accounts that are assigned, so a live policy job is reached every
 * tick whether or not the policy would pick it again, and the reasons the
 * policy would not (account busy, no credential with room, cooling on the defer
 * ladder, tier not eligible) are transient: none of them belongs on a character
 * the operator has not turned off, and none of them is visible here. The ref's
 * presence in the roster and its idle mode are the whole answer.
 *
 * Only the freeplay character is idle-keyed. A scored (`e90`/`e360`) policy job
 * keeps exactly the handling it had — it drains when its ref leaves the roster
 * and not otherwise — because `idle` says nothing about what a tier bought.
 */
export function policyJobDropped(
  job: Pick<FleetJob, "source" | "episode"> | undefined,
  entry: Pick<FleetRosterEntry, "idle"> | undefined,
): string | undefined {
  if (job === undefined || job.source !== "policy") return undefined;
  if (entry === undefined) return "removed from the roster";
  if (job.episode === "freeplay" && entry.idle === "none") return 'idle: "none"';
  return undefined;
}

/**
 * Why a live pinned job the config no longer yields is drained — the words on
 * the drain line, and nothing else: the drain is `diffJobs`' (a running job
 * with no spawn), whatever this says. Pure.
 *
 * A pinned campaign yields one job, for its next square, so a job whose run
 * fills its square stops being yielded while that run plays. It used to drain
 * as plain "disabled" with the campaign row still enabled, which read as if the
 * operator had switched the campaign off (pod-proof@1, 2026-10-11).
 */
export function unyieldedDrainReason(
  job: Pick<FleetJob, "ref" | "probe">,
  campaigns: readonly Campaign[],
  catalog: readonly string[],
  probeRuns: readonly ProbeRun[],
): string {
  if (job.probe === undefined) return "no longer in the config";
  const { campaign, version, cell, arm } = job.probe;
  const c = campaigns.find((x) => x.name === campaign);
  if (c === undefined) return `campaign ${campaign} is no longer in the config`;
  if (!c.enabled) return `campaign ${campaign} disabled`;
  if (isConcluded(c, version)) return `campaign ${campaign}@${version} is concluded — nothing more to launch`;
  if (c.version !== version) return `campaign ${campaign} moved to version ${c.version}`;
  const square = `square ${cell}/${arm} of ${campaign}@${version}`;
  const sq = campaignSquares(c, catalog, probeRuns).find((s) => s.ref === job.ref && s.cell.id === cell && s.arm.id === arm);
  if (sq === undefined) return `${square} is no longer assigned to ${job.ref}`;
  const tally = `${sq.done}/${sq.want} counted, ${sq.attempts} launched`;
  if (sq.refused !== null) return `${square} refused: ${sq.refused}`;
  if (sq.done >= sq.want) return `${square} is met (${tally}) — nothing more to launch`;
  if (c.maxAttemptsPerCell !== undefined && sq.attempts >= c.maxAttemptsPerCell) {
    return `${square} has had its ${c.maxAttemptsPerCell} launch(es), the live run included (${tally}) — nothing more to launch`;
  }
  return `campaign ${campaign}@${version} moved on to another square (${cell}/${arm}: ${tally})`;
}

/**
 * Whether this job's run comes back WHERE IT LEFT OFF after a supervisor
 * restart — same run id, account and character — rather than spending its
 * attempt. Two kinds do: the freeplay character (`pausesOnDrain`, resumed in
 * place however long it sat) and a probe campaign that asked to be
 * resumed (its definition's `resume`). Everything else — every scored e90 or
 * e360 — is ended `manual` on the next boot and must be waited out on its own
 * clock.
 *
 * Published per job row so `infra/fleet-update.sh` can decide what its
 * graceful window is actually waiting for without re-deriving the campaign's
 * opt-in from a config the supervisor may not even be running (the pause
 * switch exists to work while the config is rejected). Pure.
 */
export function resumesInPlace(job: Pick<FleetJob, "source" | "episode" | "probe"> | undefined, campaigns: readonly Campaign[] | undefined): boolean {
  if (job === undefined) return false;
  if (pausesOnDrain(job)) return true;
  return job.probe !== undefined && campaignResumeOf(campaigns, job.probe.campaign, job.probe.version);
}

/**
 * Cross-account name hygiene, the fallback under account affinity.
 *
 * Episode hygiene clears the LAUNCHING account and nothing else, so a name
 * standing on some other pool account is invisible to it: the model asks for
 * the name it used last time and the server answers `code 50`. Affinity makes
 * that rare — the model usually goes back to the account its character is on —
 * but it cannot when that account is busy or when the character is two runs
 * old. So the supervisor, which is the only thing that knows which accounts
 * are free, plans a delete of the stale name on the account that still holds
 * it.
 *
 * The safety argument is the one that governs assignment itself: a sweep is
 * planned only for an account this same tick considers FREE — not held by a
 * live run, not assigned to anything — so it is exactly as safe as handing
 * that account to a fresh run, whose hygiene would wipe the character anyway.
 * The launching account is excluded: its own hygiene owns it.
 */
export interface NameSweep {
  ref: string;
  account: string;
  character: string;
}

export function planNameSweeps(opts: {
  /** What this tick is launching fresh: the roster ref and the account it got. */
  assign: readonly { ref: string; account: string }[];
  affinity: ReadonlyMap<string, Affinity>;
  /** True when nothing holds the account and nothing this tick was given it. */
  isFree: (account: string) => boolean;
  /**
   * Freeplay characters (`characterKey`), which a sweep must never
   * delete: the character comes back to it.
   */
  protect?: ReadonlySet<string>;
}): NameSweep[] {
  const out: NameSweep[] = [];
  for (const a of opts.assign) {
    const prev = opts.affinity.get(a.ref);
    if (prev === undefined || prev.character === null) continue;
    if (prev.account.toUpperCase() === a.account.toUpperCase()) continue;
    if (!opts.isFree(prev.account)) continue;
    if (opts.protect?.has(characterKey(prev.account, prev.character)) === true) continue;
    if (out.some((s) => s.account.toUpperCase() === prev.account.toUpperCase() && s.character === prev.character)) continue;
    out.push({ ref: a.ref, account: prev.account, character: prev.character });
  }
  return out;
}

/** A live rejection of the config file. Written into fleet-state.json. */
export interface ConfigRejection {
  /** First tick the file stopped loading; kept across later, different errors. */
  since: number;
  error: string;
  /** mtime of the file that failed, so a status reader can tell edits apart. */
  mtime: number;
}

/**
 * Fold one re-read attempt into the rejection state. Only call it for a tick
 * that actually attempted a parse: a successful attempt clears the rejection,
 * so a skipped tick must not be reported as success.
 */
export function nextConfigRejection(
  prev: ConfigRejection | undefined,
  attempt: { error?: string; mtime: number },
  now: number,
): ConfigRejection | undefined {
  if (attempt.error === undefined) return undefined;
  return { since: prev?.since ?? now, error: attempt.error, mtime: attempt.mtime };
}


// ------------------------------------------------------------- materialize

/**
 * A spawn's entries, stamped with the job's account and fleet-scoped run ids
 * (`fleet-<job>-<model-slug>[-<effort>][-<compactWindow>]-<date>`) so fleet runs never share a
 * run id with hand-launched rosters or with another job.
 */
export function fillEntries(spawn: JobSpawn, stamp: string): RosterSpec[] {
  return spawn.entries.map((e) => ({
    ...e,
    // A party member keeps its own account (`partySpawn`); every other entry
    // takes the job's, as it always has.
    account: e.party !== undefined && e.account !== undefined ? e.account : spawn.account,
    runId: e.runId ?? bareRunId(spawn.name, e, stamp),
  }));
}

/**
 * The id an entry with none is given: `fleet-<job>-<model>[-<effort>]-<stamp>`.
 * The first copy of a job's entry carries no id and gets this one, so a
 * remainder that has to know which ids are taken asks the same function.
 */
export function bareRunId(job: string, e: { model: string; effort?: string | undefined }, stamp: string): string {
  return `fleet-${job}-${slug(e.model)}${e.effort !== undefined ? `-${slug(e.effort)}` : ""}-${stamp}`;
}

/**
 * Respawn circuit breaker (2026-08-24). A job whose process keeps dying
 * within seconds of spawning leaves no run artifact, so nothing else cools
 * it: the defer ladder reads runs from disk, and a launch that failed before
 * the run wrote anything is invisible to it. `sonnet-low` respawned every 60s
 * tick for two hours on a character name the runner refuses — the name is
 * validated at config load now, but the MECHANISM outlives any one cause
 * (a bad flag, a broken driver binary, the next config gap). Three
 * short-lived exits inside the window hold the job for one window, named in
 * the log with a pointer at the job log that says why it is dying. In-memory
 * only, deliberately: a supervisor restart forgets everything, and a real
 * crash loop re-trips the breaker within three ticks.
 */
export const BREAKER_SHORT_LIVED_MS = 90_000;
export const BREAKER_WINDOW_MS = 10 * 60_000;
export const BREAKER_TRIPS = 3;
export function tripsBreaker(shortLivedExits: readonly number[], now: number): boolean {
  return shortLivedExits.filter((t) => now - t <= BREAKER_WINDOW_MS).length >= BREAKER_TRIPS;
}


// ------------------------------------------------------------------ diffing

export interface JobSets {
  /** jobs with a live roster process */
  running: Set<string>;
  /** running jobs waiting for an episode boundary to be SIGTERMed */
  draining: Set<string>;
  /** jobs whose process exited while enabled (not respawned until rearmed: a boot, a flip or a raised repeat) */
  finished: Set<string>;
}

export interface JobActions {
  start: JobSpawn[];
  drain: string[];
  undrain: string[];
  /**
   * Finished jobs whose spawn is now disabled: forget them so a later
   * re-enable respawns. A config job is rearmed by the planner already
   * (`planTick`), a pool one included, which yields no spawn while disabled.
   */
  rearm: string[];
}

// ------------------------------------------------------------- the switch
//
// One knob, outside the config store: `data/runs/fleet-pause.json`. It stops the
// fleet launching anything while every live episode finishes on its own clock,
// which is what makes a supervisor update (`infra/fleet-update.sh graceful`)
// cost no run its attempt.
//
// A SIDECAR rather than a config key, for the reason the models sidecar is one:
// the config is operator-edited, and a rejected config makes every `enabled`
// flag in it inert until someone notices the banner. A switch an operator
// flips under time pressure must not be able to do that. It also means the
// switch survives the config being rejected, which is exactly when somebody
// wants to stop the fleet.
//
// The pause does NOT signal anything. It marks every job disabled for the
// tick, and `diffJobs` then drains them the way it drains a job the operator
// parked: no SIGTERM while a roster has an episode child, SIGTERM at the next
// episode boundary. Same small race, same worst case — one just-started
// episode terminated gracefully, never one mid-flight.

/** The pause switch's file name, under `data/runs/`. */
export const PAUSE_SIDECAR = "fleet-pause.json";
// PAUSE_PATH (above, beside the other state paths) is this file resolved.

export interface FleetPause {
  /** Free text: who paused the fleet and what for. Printed by `--status`. */
  why: string;
  /** When the switch was set. */
  at: number;
}

/**
 * Read the switch out of its file's text. A file that does not parse, or does
 * not say `paused: true`, is NOT a pause: this runs every tick and a half
 * written file must never take the fleet down. Pure.
 */
export function parsePauseSidecar(text: string): FleetPause | undefined {
  try {
    const raw = JSON.parse(text) as { paused?: unknown; why?: unknown; at?: unknown };
    if (typeof raw !== "object" || raw === null || raw.paused !== true) return undefined;
    return {
      why: typeof raw.why === "string" && raw.why.length > 0 ? raw.why : "no reason given",
      at: typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : Date.now(),
    };
  } catch {
    return undefined;
  }
}

/**
 * The switch, applied to a tick's spawns: every job disabled, which is
 * `enabled:false` on all of them at once. `diffJobs` then starts nothing
 * (including a resume spawn) and drains everything that is running. Pure, and
 * reversible: clear the switch and the same diff `undrain`s a job that had not
 * reached its episode boundary yet.
 */
export function applyPause(spawns: JobSpawn[], paused: boolean): JobSpawn[] {
  if (!paused) return spawns;
  return spawns.map((s) => (s.enabled ? { ...s, enabled: false } : s));
}

/**
 * Whether a job whose roster exited on its own (not drained) joins
 * `sets.finished`, which keeps `diffJobs` from starting that name again until
 * the operator disables and re-enables it or raises its `repeat`. A policy
 * job does not: the projection decides whether it runs again. Nor does a party campaign's job:
 * its campaign's tally and `maxAttemptsPerCell` decide, exactly as after a
 * supervisor restart, which empties the set. A party square keeps one job name
 * across its attempts and versions, and its runs end before its roster exits,
 * so the square was yielded again meanwhile, which undrained the roster, and
 * the undrained exit then parked the name for good. A party may be released
 * this way because `pinnedCampaignJobs` plans no fresh attempt while one is
 * live or paused. A solo square has no such guard (its paused run, still
 * cooling, leaves the square yielded), so it stays parked as it always was.
 * An unknown job is the operator's, and stays finished. Pure.
 */
export function finishesOnExit(job: Pick<FleetJob, "source" | "probe" | "accounts"> | undefined): boolean {
  if (job === undefined) return true;
  if (job.source === "policy") return false;
  return !(job.probe !== undefined && job.accounts !== undefined);
}

/** What the supervisor should do to make reality match the config. Pure. */
export function diffJobs(spawns: JobSpawn[], sets: JobSets): JobActions {
  const actions: JobActions = { start: [], drain: [], undrain: [], rearm: [] };
  const byName = new Map(spawns.map((l) => [l.name, l]));
  for (const spawn of spawns) {
    if (spawn.enabled && sets.running.has(spawn.name) && sets.draining.has(spawn.name)) {
      actions.undrain.push(spawn.name);
      continue;
    }
    if (spawn.enabled && !sets.running.has(spawn.name) && !sets.finished.has(spawn.name)) {
      actions.start.push(spawn);
      continue;
    }
    if (!spawn.enabled && sets.finished.has(spawn.name)) actions.rearm.push(spawn.name);
  }
  for (const name of sets.running) {
    const spawn = byName.get(name);
    if ((spawn === undefined || !spawn.enabled) && !sets.draining.has(name)) actions.drain.push(name);
  }
  return actions;
}

/**
 * Should the tick loop end? Only when a deadline was asked for.
 *
 * "Nothing running and nothing to start" is a terminal state for a one-shot
 * host run (`--until 18:00`, jobs finish, exit). It is NOT one for the fleet
 * SERVICE: the config is hot, so a job can be enabled on any tick, and
 * `restart: unless-stopped` restarts on exit 0 as readily as on a crash. A
 * supervisor that exited when the operator parked every job — which is exactly
 * what docs/RUNBOOK.md tells them to do before a deploy window — would be
 * restarted every 60s, taking a new epoch stamp each time. So with no deadline
 * the supervisor idles instead, which is also the honest reading of a control
 * plane that is only ever as finished as its config says.
 */
export function fleetComplete(opts: { running: number; toStart: number; hasDeadline: boolean }): boolean {
  return opts.hasDeadline && opts.running === 0 && opts.toStart === 0;
}

// --------------------------------------------------------------- preflight
//
// The deploy-window smoke as a supervisor gate. The rule the operator wants is
// simple: never launch episodes against a server nobody has smoked. So the
// supervisor runs the configured smokes before it spawns anything, and again
// whenever the server it is pointed at is no longer the same server.
//
// SERVER IDENTITY. Preferred source: /health's `build` (the repo's git describe
// compiled into the module at image build time) and `startedAtMs` (process
// start) — "this build, this boot", served to every caller since 2026-08-22.
// Fallback, for a deployed module that predates those fields: the supervisor
// is a container without a docker socket, so it cannot ask the daemon for an
// image id, but it shares the logs volume with the worldserver, and a boot is
// visible there: the appender opens a fresh Server.log (creation time = boot)
// after renaming the previous one aside. So the fallback identity is "which
// boot of the world is this", plus a digest of /health's stable fields so a
// module whose health surface changes also re-gates. That is weaker than a
// build id and it is deliberately allowed to be: everything downstream keys on
// the RECORDED TIME of a gate result, never on matching an identity string, so
// a marker that fails to change can only ever cost an extra smoke run — it can
// never greenlight an unsmoked server.
/** Coarse bucket for an unreadable boot marker: re-gate every 10 minutes, loudly. */
export const UNKNOWN_MARKER_BUCKET_MS = 10 * 60_000;

/**
 * A string that changes when the worldserver boots. Primary signal is the live
 * Server.log's creation time; the timestamped backups are the fallback for a
 * filesystem without birthtime. An unreadable log directory yields a bucketed
 * "unknown" that changes on its own every 10 minutes — the gate must fail
 * toward re-running the smokes, never toward a frozen identity that is treated
 * as "already smoked" forever. Pure: all IO is injected.
 */
export function bootMarker(
  birthtimeMs: number | undefined,
  backups: string[] | undefined,
  nowMs: number,
): string {
  if (birthtimeMs !== undefined && birthtimeMs > 0) return `boot:${Math.round(birthtimeMs)}`;
  const rotated = (backups ?? []).filter((f) => f.startsWith("Server.log.")).sort();
  if (rotated.length > 0) return `logs:${rotated.length}:${rotated[rotated.length - 1]}`;
  return `unknown:${Math.floor(nowMs / UNKNOWN_MARKER_BUCKET_MS)}`;
}

/**
 * A digest of the stable fields of a /health body. Session counts and drop
 * counters are live telemetry, not identity, so they are dropped; everything
 * else (today: `module`; tomorrow, one hopes, a build id) is kept.
 */
export function healthDigest(body: unknown): string {
  if (typeof body !== "object" || body === null) return "health:unparsed";
  const volatile = new Set(["sessions", "droppedPackets", "droppedPacketsLive", "worldStopped", "ok", "uptimeMs"]);
  const parts = Object.entries(body as Record<string, unknown>)
    .filter(([k]) => !volatile.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length === 0 ? "health:bare" : parts.join(",");
}

export interface ServerIdentity {
  /** The string the gate keys on; changes when the server is no longer the same server. */
  identity: string;
  /** /health's `build` when the module serves one; absent on the boot-marker fallback. */
  build?: string;
}

/**
 * Resolve a ready /health body into an identity. `build` + `startedAtMs`
 * name the server outright; without them (a module that predates the field)
 * fall back to the boot marker plus the health digest. Pure: the marker is
 * injected, and only read when it is needed.
 */
export function serverIdentity(body: unknown, bootMarker: () => string): ServerIdentity {
  const o = (typeof body === "object" && body !== null ? body : {}) as { build?: unknown; startedAtMs?: unknown };
  if (typeof o.build === "string" && o.build !== "" && typeof o.startedAtMs === "number" && o.startedAtMs > 0) {
    return { identity: `build:${o.build}@${Math.round(o.startedAtMs)}`, build: o.build };
  }
  return { identity: `${bootMarker()}|${healthDigest(body)}` };
}

/**
 * Whether a /health answer is a server the gate may smoke and spawn against:
 * a 200, `ok`, a world that is not stopping, and one that loaded whole. A
 * module whose world load came up short answers 503 `world_not_loaded` with
 * `worldLoaded: false` (wrath-mcp/module/PROTOCOL.md, GET /health), so the status alone
 * already refuses it; the field is read too so the body is judged the same
 * whatever the status. A module that predates the field omits it, which
 * reads as loaded.
 */
export function healthReady(status: number, body: unknown): boolean {
  if (status !== 200 || typeof body !== "object" || body === null) return false;
  const o = body as { ok?: unknown; worldStopped?: unknown; worldLoaded?: unknown };
  return o.ok === true && o.worldStopped !== true && o.worldLoaded !== false;
}

export type GateAction = "skip" | "wait" | "pass" | "run";

/**
 * What the gate should do this tick. Pure — the whole point of the gate is that
 * its decision is testable without a live server.
 *
 *  - disabled            -> skip (record it once, spawn freely)
 *  - server not ready    -> wait (spawn nothing; there is nothing to smoke yet)
 *  - a passing record for exactly this identity -> pass (spawn)
 *  - anything else (no record, a different identity, or a FAILED record for this
 *    identity) -> run the smokes. Re-running after a failure every tick is what
 *    makes a fix or a rollback unblock the fleet with no operator action.
 */
export function gateDecision(opts: {
  enabled: boolean;
  identity: string | undefined;
  last: PreflightRecord | undefined;
}): GateAction {
  if (!opts.enabled) return "skip";
  if (opts.identity === undefined) return "wait";
  const last = opts.last;
  if (last !== undefined && last.skipped !== true && last.ok && last.serverIdentity === opts.identity) return "pass";
  return "run";
}

/** May jobs be spawned given the gate's own last word? Pure. */
export function gateOpen(action: GateAction, record: PreflightRecord | undefined): boolean {
  if (action === "skip") return true;
  if (action === "pass") return true;
  if (action === "wait") return false;
  return record !== undefined && record.ok;
}

/** Last few non-empty lines of a smoke's output, for the state file and --status. */
export function tailOf(text: string, lines = 3, maxChars = 500): string {
  const kept = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0).slice(-lines).join(" | ");
  return kept.length > maxChars ? kept.slice(kept.length - maxChars) : kept;
}

export const fmtElapsed = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/**
 * How many sessions a job holds on its credential and its driver's host cap:
 * a party's members, else one per ref. A fan-out job holds every one of its
 * accounts but runs one agent, so it takes one (`FleetJob.fanout`).
 */
export function sessionsOf(job: { accounts?: readonly string[] | undefined; fanout?: true | undefined }): number {
  if (job.fanout === true) return 1;
  return job.accounts?.length ?? 1;
}

// ------------------------------------------------------------------ the tick

/**
 * What the supervisor knows about its own jobs when a tick is planned: the
 * live processes and what they play, the accounts its pool jobs hold, and the
 * jobs it handed out and has not yet seen on disk. The live tick passes its
 * memory; `--status` and `--dry-run` pass what fleet-state.json says of it
 * (`supervisorFromState`).
 */
export interface SupervisorView {
  /** The run ids the live processes were materialized with. */
  ownRunIds: ReadonlySet<string>;
  /** The jobs with a live process. */
  running: ReadonlySet<string>;
  /** The jobs whose process finished and that do not run again until rearmed. */
  finished: ReadonlySet<string>;
  /** The `repeat` each of `finished` was spawned with; absent or unread, a raise rearms nothing. */
  finishedRepeat?: ReadonlyMap<string, FleetJob["repeat"]>;
  /** Pool jobs with a live process, on the account each was given. */
  assigned: ReadonlyMap<string, string>;
  /** The job each live process was spawned for. */
  liveJobs: ReadonlyMap<string, FleetJob>;
  /** Jobs handed an account by an earlier tick that have not spawned yet. */
  pending: ReadonlySet<string>;
  /** Where each running or pending job was placed, before its run is on disk. */
  placedMemo: ReadonlyMap<string, NonNullable<FleetJob["placed"]>>;
}

/**
 * Whether a live job goes in `SupervisorView.assigned`, the one rule for the
 * live supervisor, `--status` (`supervisorFromState`) and the tick fixture:
 * every job but a pinned one, whose account is the config's and which the
 * config yields each tick. A policy pick on a task episode carries an account
 * of its own, the first of the party it drew (`withTaskAccounts`), and is
 * assigned all the same, or the tick finds a live job nothing yields and
 * drains it as gone from the config.
 */
export function holdsAssignment(job: Pick<FleetJob, "source">): boolean {
  return job.source !== "pinned";
}

/**
 * Everything a tick reads, read once: the config, every run's facts, the
 * credentials' readings and holds, the worlds, run pods and accounts, the
 * supervisor's own jobs, and the clock. `planTick` decides from this alone.
 */
export interface TickSnapshot {
  /** The config as read; the plan applies the evals group (`withoutEvals`). */
  config: FleetConfig;
  /** The evals group: off, no scored or probing episode is launched. */
  evals: boolean;
  stamp: string;
  now: number;
  /** Scored episodes closed, and why (`SCORED_EPISODES_WAIT`); null is open. */
  scoredWait: string | null;
  /** The pause switch is set: resumes and picks are planned but not announced (nothing spawns). */
  paused: boolean;
  /** Every run's facts as read, archive included, before `implicitPauses`. */
  facts: readonly RunFact[];
  /** The runs with no episode (a hand launch): only the credentials read them. */
  unstamped: readonly UnstampedRun[];
  /** The projection's sidecars (`modelStates`). */
  modelsSidecar: ModelsSidecar;
  modelLists: ModelListsSidecar;
  /** Usage readings beyond the runs' own (OpenCode Go's), and the holds the keys' last reads put on credentials. */
  usage: readonly SubscriptionUsage[];
  readHolds: ReadonlyMap<string, ReadHold>;
  /** The book's run-pod setting (`runPodsOf`) and world setting (`worldsOf`). */
  runPods: RunPodsSetting | undefined;
  worlds: WorldsSetting | undefined;
  /** The run holding each account, by upper-cased account (`accountHoldersIn`); an account absent is free. */
  holders: ReadonlyMap<string, string>;
  /** Why each queue job is cooling on its defer ladder, by job name; absent is not. */
  cooling: ReadonlyMap<string, string>;
  /** The campaign file beside each run without a verdict, by run id (null: none). */
  campaignFiles: ReadonlyMap<string, CampaignFile | null>;
  /** The runs without a verdict that carry an image record. */
  imageRecords: ReadonlySet<string>;
  supervisor: SupervisorView;
  /**
   * Writes the live tick could not make for an earlier plan of this same
   * snapshot: an end it could not record stays out of the projection, and a
   * resume whose campaign file could not be written waits.
   */
  failed?: { ends?: ReadonlySet<string>; campaignFiles?: ReadonlySet<string> };
}

/** One thing the tick says, or one write it makes, in the order the tick makes them. */
export type TickStep =
  /** A line for the log; with `key`, said once per key (the supervisor's `announcedPicks`). */
  | { kind: "say"; line: string; key?: string; record?: { job: string; event: string; detail?: string } }
  /** The recorded terminations the rows lack (`TickPlan.repairs`) are written here. */
  | { kind: "repair" }
  /** The lapsed runs (`TickPlan.ends`) are ended here, and their sessions released. */
  | { kind: "end" }
  /** A probe resumed with a campaign file rebuilt from its published definition: written here, before the spawn. */
  | { kind: "campaign-file"; name: string; runId: string; file: CampaignFile }
  /** Why the policy left accounts free, or undefined when it did not; said when it changes. */
  | { kind: "idle"; idle: string | undefined }
  /** The name sweeps (`TickPlan.sweeps`) start here, in the background. */
  | { kind: "sweep" }
  /** A queue job skipped, said once per (job, reason). */
  | { kind: "skip"; name: string; reason: string }
  /** A job whose `repeat` is met, said once. */
  | { kind: "done"; job: FleetJob; progress: string };

/** A launch the tick holds back this time, and why. */
export interface TickHold {
  name: string;
  /** The roster names it would have launched. */
  refs: readonly string[];
  episode: EpisodeId | null;
  why: string;
  /** Which planner held it. */
  by: "pinned" | "queue" | "policy" | "resume" | "character" | "credential";
}

/** Everything one tick decides. */
export interface TickPlan {
  /** The config as planned: the evals group applied. */
  config: FleetConfig;
  /** The run facts the tick read, with `implicitPauses` applied. */
  runs: RunFact[];
  /** The projection after this tick's ends and resumes. */
  states: ModelState[];
  /** What `diffJobs` acts on: every job's spawn, live, fresh, drained or held, after the credential gate. */
  spawns: JobSpawn[];
  /** Pinned jobs (config and campaign) launching fresh this tick, as placed. */
  pinned: { job: FleetJob; spawn: JobSpawn }[];
  /** Paused runs resuming this tick, as placed. */
  resumed: { plan: ResumePlan; job: FleetJob; spawn: JobSpawn }[];
  /** The resume planner's answer: what comes back, what is listed and why, what is ended. */
  resumes: { resume: ResumePlan[]; listed: PausedListing[]; end: EndedRun[] };
  /** The queue's plan; its `skipped` leads with the pinned jobs this tick held. */
  queue: QueuePlan;
  /** The policy's picks, continued (`planContinuations`) and placed. */
  picks: PolicyPick[];
  /** Freeplay picks waiting for their character's account, and the ones that started fresh instead. */
  waiting: CharacterWait[];
  dropped: CharacterDrop[];
  /** Every launch held back this tick, with why. */
  holds: TickHold[];
  /** Live jobs this tick drains, and why. */
  drainReasons: Map<string, string>;
  /** Runs nothing came back for: ended this tick. */
  ends: EndedRun[];
  /** Runs whose trajectory records a termination their row lacks. */
  repairs: RunFact[];
  /** Stale character names to delete on free accounts. */
  sweeps: NameSweep[];
  /** The pinned campaigns' jobs this tick generated. */
  campaignJobs: FleetJob[];
  /** Pinned config jobs whose `repeat` is met. */
  pinnedDone: FleetJob[];
  /** Why the policy left accounts free; absent when there is no policy pool. */
  policyIdle?: { idle: string | undefined };
  /** The models held while a run no job owns is live on them. */
  unownedRefs: string[];
  /** The credentials' ledger this tick. */
  credentials: { gate: CredentialGate; book: SlotBook; credentials: readonly Credential[]; runs: readonly (RunFact | UnstampedRun)[] };
  /** What the supervisor remembers after this tick. */
  memory: { pending: Map<string, FleetJob>; placedMemo: Map<string, NonNullable<FleetJob["placed"]>>; unfinished: string[] };
  /** What the tick says and writes, in order. */
  steps: TickStep[];
}

/**
 * The tick: every decision the supervisor makes on one tick, from one
 * snapshot, with no I/O. The live supervisor gathers the snapshot, plans, and
 * applies the plan (`infra/run-fleet-tick.ts`); `--status` and `--dry-run`
 * gather the same snapshot from disk and the state file and print the plan.
 *
 * The order is the supervisor's: every session already held goes on the book
 * (its live jobs, runs it did not launch, live runs no job owns); then the
 * pinned jobs and campaigns are placed; then the paused runs that come back,
 * each on the credential it started on; then the manual queue; then the
 * policy, with freeplay characters continued; and last the credentials'
 * budgets over every spawn (`gateSpawns`). A run that lapsed is ended and the
 * projection re-derived before the queue and the policy read it.
 */
export function planTick(snap: TickSnapshot): TickPlan {
  const read = snap.config;
  const sup = snap.supervisor;
  const now = snap.now;
  // With the evals group off, every campaign and scored or probing job reads
  // as disabled, and the policy below picks none (`withoutEvals`).
  const cfg = snap.evals ? read : withoutEvals(read);
  const out: JobSpawn[] = [];
  const steps: TickStep[] = [];
  const holds: TickHold[] = [];
  const drainReasons = new Map<string, string>();
  const held = (a: string): string | undefined => snap.holders.get(a.toUpperCase());
  const scoredGate = snap.scoredWait ?? undefined;
  const pending = new Map<string, FleetJob>();
  const finished = new Set(sup.finished);
  const unfinished: string[] = [];
  // A finished config job is rearmed when the operator flips it off (its own
  // flag, not the evals group's) or raises its `repeat` above the one its
  // process was spawned with: each costs what it still owes once, and an
  // unchanged job never respawns. Here rather than in `diffJobs`, because a
  // disabled pool job holds no account and so yields no spawn to rearm.
  for (const job of read.jobs) {
    if (!finished.has(job.name) || sup.running.has(job.name)) continue;
    const under = sup.finishedRepeat?.get(job.name);
    const why = !job.enabled
      ? "disabled after finishing; enable again to respawn"
      : typeof job.repeat === "number" && typeof under === "number" && job.repeat > under
        ? `repeat raised from ${under} to ${job.repeat}`
        : undefined;
    if (why === undefined) continue;
    finished.delete(job.name);
    unfinished.push(job.name);
    steps.push({ kind: "say", line: `job ${job.name}: rearmed — ${why}`, record: { job: job.name, event: "rearmed", detail: why } });
  }
  const placedMemo = new Map(sup.placedMemo);
  // The run facts once a tick, shared by the projection and the resume
  // planner. A verdict-less run on a resuming lane reads as paused `offline`
  // from here on — unless one of this supervisor's own processes is playing
  // it, or a live job holds its account (the same guards the stale sweep
  // applies, for the same reason).
  const ownRunIds = sup.ownRunIds;
  const ownAccounts = new Set(
    [...sup.assigned.values(), ...pinnedJobs(cfg).filter((j) => sup.running.has(j.name)).map((j) => j.account!)].map((a) => a.toUpperCase()),
  );
  const runs = implicitPauses({ runs: snap.facts, campaigns: cfg.campaigns, running: ownRunIds, busyAccounts: ownAccounts, now });
  // The freeplay characters earlier harness series left standing: every fresh
  // launch on the shared world keeps those on its account, pinned ones
  // included (operator, 2026-11-15).
  const former = formerCharactersFrom(runs, cfg.roster, cfg.policy.series);
  const project = (facts: readonly RunFact[]): ModelState[] =>
    modelStates({ runsDir: "", roster: rosterModels(cfg.roster), policy: cfg.policy, runs: facts, now, sidecar: snap.modelsSidecar, modelLists: snap.modelLists });
  // Both are re-derived below if this tick's sweep ends anything: a failed
  // attempt ended halfway down a tick has to be in the projection the queue
  // and the policy read at the bottom of it.
  let states = project(runs);
  let eligible = eligibleFrom(states);
  // The credentials over the same facts: each one's budget (its newest usage
  // reading, its runs and spend today) and every live session on its slots
  // and its driver's host cap, asked at every launch below
  // (`run-fleet-credentials.ts`). Every run on a credential costs it,
  // whether or not it carries an episode: a hand launch's are read too.
  const billed = [...runs, ...snap.unstamped];
  const credGate = credentialGate(cfg.credentials, [...billed.map((f) => f.credentialUsage), ...snap.usage], billed, now, snap.readHolds);
  const book = new SlotBook(cfg.credentials, cfg.policy.maxSessions, snap.runPods, snap.worlds);
  const byName = new Map(cfg.jobs.map((j) => [j.name, j]));
  const runningRefs = new Set<string>();
  /**
   * Those of `runningRefs` whose run in flight holds the model's other
   * entries (operator, 2026-11-16): a scored or freeplay one, or one whose
   * episode is not known. A probe holds only its own entry, as it always has.
   */
  const holdingRefs = new Set<string>();
  const holdRefs = (refs: readonly string[], episode: EpisodeId | null | undefined): void => {
    for (const r of refs) {
      runningRefs.add(r);
      if (episode !== "probing") holdingRefs.add(r);
    }
  };
  const pinnedSkips: QueueSkip[] = [];
  /**
   * The credential each roster entry's live-or-paused run is on, read back
   * off the runs. This is what makes the per-credential count survive a
   * supervisor restart: the job objects that remember where they were placed
   * die with the process, the runs do not.
   */
  const runCreds = liveCredentials(runs, rosterModels(cfg.roster));
  /** A job with where it was placed: what it carries, else what this supervisor placed it on (`placedMemo`). */
  const withPlaced = (job: FleetJob): FleetJob => {
    const placed = job.placed ?? placedMemo.get(job.name);
    return placed !== undefined ? { ...job, placed } : job;
  };
  const placing = { credentials: cfg.credentials, book, gate: credGate };
  /** Place a job that holds no session yet and commit its slots, or say why it may not start. */
  const placeFresh = (job: FleetJob): { ok: true; job: FleetJob } | { ok: false; why: string } => {
    const r = placeJob(job, cfg.roster, placing);
    if (!r.ok) return r;
    book.add(r.keys);
    if (r.job.placed !== undefined) placedMemo.set(job.name, r.job.placed);
    return { ok: true, job: r.job };
  };
  for (const n of [...placedMemo.keys()]) if (!sup.running.has(n) && !sup.pending.has(n)) placedMemo.delete(n);
  // Pinned jobs: from the file, on their own accounts — plus a pinned
  // campaign's next cell, which is a pinned job in everything but where it
  // was written down.
  const probes = probeRunsOf(runs);
  // Every run id on disk, archive included: a job's remainder never reuses
  // one, and a campaign square's fresh attempt numbers past them.
  const takenRunIds = new Set(runs.map((f) => f.runId));
  // A party that draws its accounts takes this attempt's from the eval pool:
  // none a run without a verdict or a running job holds (`evalPoolDraw`).
  const drawHeld: { job: FleetJob; why: string }[] = [];
  const draw = evalPoolDraw({
    mode: cfg.policy.worlds,
    pool: cfg.accounts.evalPool ?? [],
    taken: evalPoolTaken(runs, [...sup.assigned.values(), ...[...sup.liveJobs.values()].flatMap((j) => j.accounts ?? (j.account !== undefined ? [j.account] : []))]),
    held,
    running: (name) => (sup.running.has(name) ? sup.liveJobs.get(name)?.accounts : undefined),
  });
  const campaignJobs = withTakenRunIds(pinnedCampaignJobs(cfg, probes, healthyFrom(states), draw, drawHeld), takenRunIds);
  for (const h of drawHeld) pinnedSkips.push({ job: h.job, reason: h.why });
  const pinnedNamed = (name: string): FleetJob | undefined => [...pinnedJobs(cfg), ...campaignJobs].find((j) => j.name === name);
  // Every session already held goes on the book first — a live job of this
  // supervisor's, pinned, pooled, drained or no longer in the file — so a
  // fresh placement below never takes a slot a live run is on (the
  // 2026-08-24 spill: a draining campaign cell no loop yielded).
  for (const name of sup.running) {
    const job = sup.liveJobs.get(name) ?? pinnedNamed(name);
    if (job === undefined) continue;
    countJob(book, withPlaced(job), cfg.roster, runCreds);
  }
  // And every live run this fleet did not launch, on the credential it
  // bills: a hand launch takes a slot as surely as a job does.
  countOutsideRuns(book, outsideRuns(billed, { running: ownRunIds, busyAccounts: ownAccounts }));
  // And every live fleet run no job of this supervisor owns — a run pod
  // still playing after its roster died with this container — on its
  // credential and the run-pod cap (`countUnownedRuns`). It holds its
  // account and its model below, too.
  const unowned = unownedLiveRuns({ runs, roster: cfg.roster, campaigns: cfg.campaigns, running: ownRunIds, busyAccounts: ownAccounts });
  countUnownedRuns(book, unowned);
  // Resumes before anything fresh: a paused run goes back onto its own
  // account ahead of the queue and the policy, so nothing can wipe its
  // character first. A pinned job's spawn is replaced by its resume spawn; a
  // pool job's resume reserves its account like an assignment.
  const runningMap = new Map<string, string>(sup.assigned);
  for (const job of pinnedJobs(cfg)) if (sup.running.has(job.name)) runningMap.set(job.name, job.account!);
  const resumes = planResumes({
    runs,
    config: cfg,
    running: runningMap,
    held,
    now,
    campaignFileOf: (id) => snap.campaignFiles.get(id) ?? null,
    hasImageRecord: (id) => snap.imageRecords.has(id),
    credentialHold: (f) => resumeHoldOf(f, cfg, credGate),
    // What each live process plays, before its run reads live.
    inFlight: [...sup.running].flatMap((name) => {
      const job = sup.liveJobs.get(name) ?? pinnedNamed(name);
      return job === undefined ? [] : [{ name, refs: job.refs, episode: job.episode }];
    }),
  });
  const resumingNames = new Set(resumes.resume.filter((r) => !sup.running.has(r.job.name)).map((r) => r.job.name));
  const pinnedDone: FleetJob[] = [];
  const pinned: TickPlan["pinned"] = [];
  const spawnOf = (job: FleetJob, account: string, elig: Eligible | undefined): JobSpawn => jobSpawn(job, cfg.roster, account, snap.stamp, elig, cfg.campaigns, cfg.campaignDefs);
  for (const job of [...pinnedJobs(cfg), ...campaignJobs]) {
    if (job.enabled && runnableRefs(job, cfg.roster, eligible).length === 0) {
      // A pinned job whose ref is not promoted into its tier: it waits,
      // with the reason said once, exactly like a gated queue job.
      pinnedSkips.push({ job, reason: `${job.ref} is not eligible for ${job.episode} (${ineligibleWhy(job.episode, cfg.policy, cfg.roster[job.ref]?.tier)})` });
      out.push({ name: job.name, enabled: false, account: job.account!, loop: false, entries: [{ model: "gated" }] });
      continue;
    }
    // While scored episodes are held (`SCORED_EPISODES_WAIT`), held as the
    // policy's own picks are: never spawned for the launch to refuse (`scoredHold`).
    const hold = job.enabled && !sup.running.has(job.name) ? scoredHold(job, scoredGate) : undefined;
    if (hold !== undefined) {
      pinnedSkips.push({ job, reason: hold });
      out.push({ name: job.name, enabled: false, account: job.account!, loop: false, entries: [{ model: "gated" }] });
      continue;
    }
    // A pinned job's `repeat` is met off the runs on disk, the queue's rule
    // (`owedCopies`): one that owes nothing yields no spawn, so a supervisor
    // boot cannot start it again. Only a job that is not running is asked —
    // a live roster keeps its spawn and is never drained for finishing.
    const owed = job.enabled && !sup.running.has(job.name) ? owedCopies(job, runnableRefs(job, cfg.roster, eligible), countedFrom(states)) : undefined;
    if (owesNothing(owed)) {
      pinnedDone.push(job);
      continue;
    }
    const owing = owed === undefined ? job : { ...job, owed: { copies: owed, taken: takenRunIds } };
    if (sup.running.has(job.name) || !job.enabled) {
      // Live (counted above), or disabled and so a drain or a park.
      out.push(spawnOf(withPlaced(owing), job.account!, eligible));
      if (sup.running.has(job.name)) holdRefs(job.refs, job.episode);
      continue;
    }
    // A pinned job about to resume a paused run is placed with the resume,
    // on the credential that run is on.
    if (resumingNames.has(job.name)) {
      out.push({ ...spawnOf(owing, job.account!, eligible), enabled: false });
      holdRefs(job.refs, job.episode);
      continue;
    }
    // A slot on a credential with room, and a session under the driver's
    // host cap, or it waits with the reason said — a party for all of its
    // members at once. It spends no slot it will not use.
    const placed = placeFresh(owing);
    if (!placed.ok) {
      pinnedSkips.push({ job, reason: placed.why });
      out.push({ ...spawnOf(owing, job.account!, eligible), enabled: false });
      continue;
    }
    // An earlier series' character on the pinned account stays standing too.
    const keep = worldUsedBy(cfg.policy.worlds, job.episode) ? [] : keepFor(job.account!, new Map(), undefined, former);
    const launching = keep.length > 0 ? { ...placed.job, keepCharacters: keep } : placed.job;
    const spawn = spawnOf(launching, job.account!, eligible);
    pinned.push({ job: launching, spawn });
    out.push(spawn);
    holdRefs(job.refs, job.episode);
  }
  // Pool jobs with a live process: keep running whatever the file now says,
  // drain if the file dropped them or their refs. Their sessions are on the
  // book already.
  for (const [name, account] of sup.assigned) {
    const running = sup.liveJobs.get(name);
    const fromFile = byName.get(name);
    if (running?.source === "policy") {
      const dropped = policyJobDropped(running, cfg.roster[running.ref]);
      if (dropped !== undefined) {
        // A disabled stand-in makes diffJobs drain it, and for a freeplay
        // character a drain is an immediate SIGTERM (`pausesOnDrain`): the run
        // pauses as `operator-pause` and `planResumes` leaves it listed while
        // the ref stays out of the unlimited lane, so nothing respawns it.
        // A session under SIGTERM still holds its slot until the process
        // exits (runner backstop 60s, roster SIGKILL grace 90s), which is
        // why it was counted above with the rest.
        drainReasons.set(name, dropped);
        out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
        holdRefs([running.ref], running.episode);
      } else {
        out.push(spawnOf(withPlaced(running), account, undefined));
        holdRefs([running.ref], running.episode);
      }
      continue;
    }
    if (fromFile === undefined || fromFile.account !== undefined || runnableRefs(fromFile, cfg.roster, eligible).length === 0) {
      // Removed from the queue (or pinned now, or its ref vanished): a
      // disabled stand-in makes diffJobs drain it. The process keeps its roster.
      out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
      continue;
    }
    out.push(spawnOf(withPlaced(running ?? fromFile), account, eligible));
    holdRefs(fromFile.refs, (running ?? fromFile).episode);
  }
  // Live processes the file no longer YIELDS — a completed campaign cell
  // draining to its episode boundary, a job whose config entry vanished —
  // hold their model, and the drain line says why. Their sessions were
  // counted with every live one above.
  {
    const yielded = new Set([...pinnedJobs(cfg), ...campaignJobs].map((j) => j.name));
    for (const name of sup.running) {
      if (yielded.has(name) || sup.assigned.has(name)) continue;
      const job = sup.liveJobs.get(name);
      if (job === undefined) continue;
      // Words only: what the drain line says about a job nothing yields.
      drainReasons.set(name, unyieldedDrainReason(job, cfg.campaigns, Object.keys(cfg.roster), probes));
      holdRefs(job.refs, job.episode);
    }
  }
  // A live fleet run none of this supervisor's jobs is playing — the two
  // minutes a killed runner's heartbeat stays warm after a pod recreate, a
  // runner still unwinding under an exited roster, or a run pod playing on
  // after this container restarted — holds its model as well as its account
  // (`held`), or the policy plans that model a second session on another
  // free account while its character is mid-run on the first. It is on its
  // credential and the run-pod cap (counted above), never on a driver's
  // host cap. Once it reads cold it lets go, and `implicitPauses` has made
  // it an `offline` pause on a lane that resumes.
  const unownedRefs: string[] = [];
  for (const u of unowned) {
    const refs = u.refs.filter((r) => !runningRefs.has(r));
    if (refs.length === 0) continue;
    holdRefs(refs, u.episode);
    unownedRefs.push(...refs);
    steps.push({ kind: "say", key: `unowned:${u.runId}`, line: `hold ${refs.join("+")}: ${u.runId} is live on ${u.account} and no job of this supervisor owns it — nothing new is planned for it until the run stops or reads cold` });
  }

  // A verdict the runner recorded but could not write into the row: the
  // facts already read it from the trajectory, and the row is told now.
  const repairs = runs.filter((f) => f.recordedTermination !== undefined && f.archived !== true);
  steps.push({ kind: "repair" });
  // Runs nothing came back for are ended on every tick, boot included: the
  // host slept, or the fleet was down past the run's own budget, and neither
  // a live run nor a paused one survives that.
  const ends = [
    ...resumes.end,
    ...planStaleRuns({
      runs,
      campaigns: cfg.campaigns,
      refs: Object.keys(cfg.roster),
      busyAccounts: new Set([...runningMap.values()].map((a) => a.toUpperCase())),
      now,
    }),
  ];
  // A lapsed run is ended through the runner's own writer, once, and leaves
  // the paused set. Its session goes back with it, so the fresh attempt this
  // record promises does not land on an account that is still held.
  steps.push({ kind: "end" });
  const applied = ends.filter((e) => snap.failed?.ends?.has(e.runId) !== true);
  if (applied.length > 0) {
    // The queue's gate, the policy's picks and the state file all read the
    // post-sweep projection from here down, so a run this sweep ended is
    // already a cooling rung when the policy picks.
    states = project(applyEnded(runs, applied, now));
    eligible = eligibleFrom(states);
  }
  const reserved = new Map<string, string>();
  /** The resumes spawned this tick: what holds their models below. */
  const resumedNow: ResumePlan[] = [];
  const resumed: TickPlan["resumed"] = [];
  for (const r of resumes.resume) {
    const name = r.job.name;
    if (sup.running.has(name)) continue;
    // A probe paused before campaign files existed comes back with one
    // rebuilt from its published definition (`pausedProbeFile`); it goes
    // beside the run before the spawn, so the run carries it from here on.
    // Never over a file the run already has.
    if (r.writeCampaignFile !== undefined && (snap.campaignFiles.get(r.runId) ?? null) === null) {
      steps.push({ kind: "campaign-file", name, runId: r.runId, file: r.writeCampaignFile });
      if (snap.failed?.campaignFiles?.has(r.runId) === true) continue;
    }
    // A resumed run goes back to the credential it started on: the runner
    // rebuilds its config from meta.json, and the credential is in it. It
    // needs a slot there, like a fresh start, and a paused party needs one
    // per member, whole; with none the resume waits for a tick with room.
    // Stamped on the spawn too so the count and the state file agree with
    // the run.
    const recorded = runs.find((f) => f.runId === r.runId)?.credential ?? null;
    const placedResume = placeFresh(recorded !== null ? { ...r.job, credential: recorded } : r.job);
    if (!placedResume.ok) {
      holds.push({ name, refs: r.job.refs, episode: r.job.episode, why: placedResume.why, by: "resume" });
      steps.push({ kind: "say", key: `resume-held:${r.runId}:${placedResume.why}`, line: `resume ${name}: held — ${placedResume.why}` });
      continue;
    }
    const job = placedResume.job;
    resumedNow.push(r);
    const spawn = spawnOf(job, r.account, undefined);
    resumed.push({ plan: r, job, spawn });
    if (r.job.account !== undefined) {
      pending.set(name, job);
      const idx = out.findIndex((l) => l.name === name);
      if (idx >= 0) out[idx] = spawn;
      else out.push(spawn);
    } else {
      pending.set(name, job);
      finished.delete(name);
      unfinished.push(name);
      reserved.set(name, r.account);
      out.push(spawn);
      holdRefs(r.job.refs, r.job.episode);
    }
    // Once per pause, named by its instant: the streak starts over at 1
    // after every segment that made a turn, so it cannot tell two pauses of
    // one run apart. Not while the pause switch holds: nothing is spawned
    // then, and the line is said on the tick the switch clears.
    if (!snap.paused) {
      steps.push({
        kind: "say",
        key: `resume:${r.runId}:${runs.find((f) => f.runId === r.runId)?.pause?.at ?? r.pauseCount}`,
        line: `resume ${name}: ${r.runId} on ${r.account} — ${r.why}`,
        record: { job: name, event: "resume", detail: `${r.runId} on ${r.account}: ${r.why}` },
      });
    }
  }
  // A character resuming this tick holds its model's scored episodes under
  // every entry, as one playing does (`withResumesPlaying`).
  states = withResumesPlaying(states, resumedNow, cfg.roster);
  const runningAndReserved = new Map([...sup.assigned, ...reserved]);
  // Who holds each account this tick, for the character rule (`characterStanding`):
  // the live pool jobs, the pinned ones, and the resumes reserving theirs.
  const occupants = new Map<string, Occupant>();
  {
    const claim = (account: string, job: FleetJob | undefined): void => {
      if (job === undefined) return;
      occupants.set(account.toUpperCase(), { ref: job.ref, unlimited: pausesOnDrain(job) && cfg.roster[job.ref]?.idle === "unlimited" });
    };
    for (const [name, account] of sup.assigned) claim(account, sup.liveJobs.get(name));
    for (const job of pinnedJobs(cfg)) if (sup.running.has(job.name)) claim(job.account!, job);
    for (const r of resumes.resume) claim(r.account, r.job);
  }
  // Where each model's last character is standing. Read once a tick from
  // the same run facts everything else here reads.
  const affinityMap = affinityFrom(runs, cfg.roster);
  // Where each unlimited ref's freeplay character of this series stands; a
  // freeplay pick goes back to that account, every fresh launch keeps those
  // characters and every earlier series' (operator, 2026-11-15).
  const characters = charactersFrom(runs, cfg.roster, cfg.policy.series);
  const affinity = characterAffinity(characters, affinityOf(affinityMap));
  const queue = planQueue({
    queue: poolJobs(cfg),
    roster: cfg.roster,
    pool: cfg.accounts.pool,
    maxLive: cfg.accounts.max,
    running: runningAndReserved,
    finished,
    held,
    cooling: (job) => snap.cooling.get(job.name),
    // A slot on a credential with room, committed as the queue assigns.
    place: placeFresh,
    eligible,
    runningRefs,
    holdingRefs,
    affinity,
    counted: countedFrom(states),
    takenRunIds,
    ...(scoredGate !== undefined ? { scoredGate } : {}),
  });
  queue.skipped.unshift(...pinnedSkips);
  for (const sk of pinnedSkips) holds.push({ name: sk.job.name, refs: sk.job.refs, episode: sk.job.episode, why: sk.reason, by: "pinned" });
  for (const sk of queue.skipped.slice(pinnedSkips.length)) holds.push({ name: sk.job.name, refs: sk.job.refs, episode: sk.job.episode, why: sk.reason, by: "queue" });
  // Every fresh launch this tick, for the cross-account name sweep below.
  const freshAssign: { ref: string; account: string }[] = [];
  for (const a of queue.assign) {
    const { account } = a;
    // The credential was settled by the plan (`place`), and is on the book.
    const keep = keepFor(account, characters, undefined, former);
    if (keep.length > 0) a.job = { ...a.job, keepCharacters: keep };
    pending.set(a.job.name, a.job);
    // A launch onto a world of its own meets no name of the shared world's.
    if (!worldUsedBy(cfg.policy.worlds, a.job.episode)) for (const r of a.job.refs) freshAssign.push({ ref: r, account });
    out.push(spawnOf(a.job, account, eligible));
  }
  // The policy fills what the queue left free. A held spawn is not a
  // problem: the pick is re-made next tick from the same projection.
  let picks: PolicyPick[] = [];
  let waiting: CharacterWait[] = [];
  let dropped: CharacterDrop[] = [];
  let policyIdle: TickPlan["policyIdle"];
  if (scheduledAccounts(cfg).length > 0) {
    const allowed = policyRefs(cfg);
    const policy = planPolicyHeld({
      states: states.filter((st) => allowed.has(st.name)),
      pool: cfg.accounts.pool,
      maxLive: cfg.accounts.max,
      running: runningAndReserved,
      held,
      queuePlan: queue,
      runningRefs,
      holdingRefs: new Set([...holdingRefs, ...queue.assign.filter((a) => a.job.episode !== "probing").flatMap((a) => a.job.refs)]),
      place: (n, ep) => {
        const r = placeRef(cfg.roster[n], ep, { ...placing, pin: cfg.roster[n]?.credential, sessions: episodeSessions(ep) });
        return r.ok ? { ok: true, credential: r.placement.credential, keys: r.placement.keys } : r;
      },
      take: (keys) => book.add(keys),
      policy: cfg.policy,
      drawTask: taskDraw(draw)!,
      campaigns: unpinnedCampaigns(cfg),
      probeRuns: probes,
      affinity,
      evals: snap.evals,
      // While scored episodes are held: held with the reason rather than picked for a launch run.ts refuses.
      ...(scoredGate !== undefined ? { scoredGate } : {}),
    });
    for (const h of policy.held) holds.push({ ...h, refs: [h.name], by: "policy" });
    const continued = planContinuations(policy.picks, characters, cfg.roster, occupants, former);
    ({ picks, waiting, dropped } = continued);
    // Each pick's attempt past every id on disk (`attemptPastTaken`), before
    // it is remembered, announced or spawned.
    picks = picks.map((p) => ({
      ...p,
      job: attemptPastTaken(p.job, (j) => fillEntries(spawnOf(j, p.account, undefined), snap.stamp).map((e) => e.runId!), takenRunIds),
    }));
    for (const w of waiting) {
      const ref = policy.picks.find((p) => p.job.name === w.name)?.job.ref ?? w.name;
      holds.push({ name: w.name, refs: [ref], episode: "freeplay", why: `${w.why}; not starting fresh on ${w.offered}`, by: "character" });
      steps.push({
        kind: "say",
        key: `${w.name}:character:${w.head.runId}:${w.why}`,
        line: `policy ${w.name}: waiting — ${w.why}; not starting fresh on ${w.offered}`,
        record: { job: w.name, event: "character-waiting", detail: `${w.why}; offered ${w.offered}` },
      });
    }
    for (const d of dropped) {
      steps.push({
        kind: "say",
        key: `${d.name}:character-dropped:${d.head.runId}`,
        line: `policy ${d.name}: ${d.head.account} is occupied by ${d.occupant}'s character — starting fresh on ${d.account}, lineage ${d.head.runId} (${d.head.character}) dropped`,
        record: { job: d.name, event: "character-dropped", detail: `${d.head.runId} (${d.head.character} on ${d.head.account}) account_occupied_by ${d.occupant}; fresh on ${d.account}` },
      });
    }
    // A character whose head is on another ref's account and that got NO pick
    // this tick (no free account, the cap, the gate) says so once, so the
    // wait reads as a wait for a free account and not as the item-94 hold.
    for (const [ref, st] of characters) {
      if (!allowed.has(ref) || runningRefs.has(ref)) continue;
      if (picks.some((p) => p.job.ref === ref) || waiting.some((w) => w.name === `${ref}-freeplay`)) continue;
      const standing = characterStanding(ref, st, occupants);
      if (standing.kind !== "occupied") continue;
      steps.push({ kind: "say", key: `${ref}:character-blocked:${st.runId}:${standing.occupant}`, line: `policy ${ref}: ${describeStanding(st, standing)} — none free this tick` });
    }
    for (const { job, account, why } of picks) {
      // Remember the credential the pick was placed on: the run does not
      // exist on disk yet, and the next tick must count it there.
      if (job.placed !== undefined) placedMemo.set(job.name, job.placed);
      pending.set(job.name, job);
      // A policy job that finished an earlier attempt is fair game again;
      // the projection, not the finished set, decides whether it runs.
      finished.delete(job.name);
      unfinished.push(job.name);
      // As with a resume: a pick is announced when it can spawn, not while the switch holds.
      if (!snap.paused) {
        const tag = (isExtraJob(job) ? " (extra)" : "") + (job.continueFrom !== undefined ? ` (continues ${job.continueFrom})` : "");
        steps.push({
          kind: "say",
          key: `${job.name}:${job.attempt}`,
          line: `policy ${job.name}: ${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account} — ${why}`,
          record: { job: job.name, event: "policy-pick", detail: `${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account}: ${why}` },
        });
      }
      if (!worldUsedBy(cfg.policy.worlds, job.episode)) for (const r of job.refs) freshAssign.push({ ref: r, account });
      out.push(spawnOf(job, account, undefined));
    }
    const taken = new Set([...runningAndReserved.values(), ...queue.assign.map((a) => a.account), ...picks.map((p) => p.account)].map((a) => a.toUpperCase()));
    const free = scheduledAccounts(cfg).filter((a) => !taken.has(a.toUpperCase()) && held(a) === undefined);
    const idle =
      free.length === 0
        ? undefined
        : queue.waiting.length > 0
          ? `${free.length} free account(s) but manual job(s) waiting (${queue.waiting.map((j) => j.name).join(", ")}) — they outrank the policy`
          : `${free.length} free account(s), nothing schedulable: ${states
              .filter((st) => allowed.has(st.name))
              .map((st) => `${st.name}=${st.status}`)
              .join(" ")}`;
    policyIdle = { idle };
    steps.push({ kind: "idle", idle });
  }
  // Cross-account name hygiene: a name the launching account's own
  // hygiene cannot see, on an account this tick calls free.
  let sweeps: NameSweep[] = [];
  if (freshAssign.length > 0) {
    const busy = new Set([...runningAndReserved.values(), ...queue.assign.map((a) => a.account), ...freshAssign.map((a) => a.account)].map((a) => a.toUpperCase()));
    sweeps = planNameSweeps({
      assign: freshAssign,
      affinity: affinityMap,
      isFree: (a) => !busy.has(a.toUpperCase()) && held(a) === undefined,
      // Every freeplay head, an earlier series' included, and the character
      // of every run that has not ended — whatever its lane, a run without a
      // verdict still owns it.
      protect: new Set([
        ...[...characters.values(), ...former].map((s) => characterKey(s.account, s.character)),
        ...runs.filter((f) => f.terminationReason === null && f.account !== null && f.character !== null).map((f) => characterKey(f.account!, f.character!)),
      ]),
    });
  }
  if (sweeps.length > 0) steps.push({ kind: "sweep" });
  for (const sk of queue.skipped) steps.push({ kind: "skip", name: sk.job.name, reason: sk.reason });
  // A job whose `repeat` is met says so once, not once a tick; raising its
  // repeat and meeting it again says so again.
  const counted = countedFrom(states);
  for (const j of [...pinnedDone, ...queue.done]) steps.push({ kind: "done", job: j, progress: progressLabel(j, counted) ?? "met" });
  // A fresh spawn whose every run id already ended would launch nothing and
  // be spawned again next tick (`spawnsOnlyEnded`): held with the reason.
  const ended = new Set(runs.filter((f) => f.terminationReason !== null).map((f) => f.runId));
  for (let i = 0; i < out.length; i++) {
    const s = out[i]!;
    if (sup.running.has(s.name) || !spawnsOnlyEnded(s, snap.stamp, ended)) continue;
    out[i] = { ...s, enabled: false };
    const job = pending.get(s.name) ?? [...pinnedJobs(cfg), ...campaignJobs].find((j) => j.name === s.name);
    const why = `every run id it would launch has already ended (${fillEntries(s, snap.stamp).map((e) => e.runId).join(", ")}) — nothing to launch`;
    holds.push({ name: s.name, refs: job?.refs ?? [], episode: job?.episode ?? null, why, by: job?.source ?? "queue" });
    steps.push({ kind: "say", key: `ended:${s.name}:${why}`, line: `hold ${s.name}: ${why}`, record: { job: s.name, event: "nothing-to-launch", detail: why } });
  }
  // The credentials' budgets over every spawn, last: a running job's next
  // episode on a held credential. A running freeplay job is its driver's to
  // pause; a running scored one drains to its boundary.
  const gated = gateSpawns(out, credGate, sup.running);
  for (const g of gated.gated) {
    if (g.drained) drainReasons.set(g.name, g.why);
    else {
      const job = pending.get(g.name) ?? [...pinnedJobs(cfg), ...campaignJobs].find((j) => j.name === g.name);
      holds.push({ name: g.name, refs: job?.refs ?? [], episode: job?.episode ?? null, why: g.why, by: "credential" });
    }
    steps.push({
      kind: "say",
      key: `gate:${g.name}:${g.drained}:${g.why}`,
      line: `${g.drained ? "drain" : "hold"} ${g.name}: ${g.why}${g.drained ? " — its live episode finishes, the next does not start" : ""}`,
      record: { job: g.name, event: "credential-budget", detail: g.why },
    });
  }
  return {
    config: cfg,
    runs,
    states,
    spawns: gated.spawns,
    pinned,
    resumed,
    resumes,
    queue,
    picks,
    waiting,
    dropped,
    holds,
    drainReasons,
    ends,
    repairs,
    sweeps,
    campaignJobs,
    pinnedDone,
    ...(policyIdle !== undefined ? { policyIdle } : {}),
    unownedRefs,
    credentials: { gate: credGate, book, credentials: cfg.credentials, runs: billed },
    memory: { pending, placedMemo, unfinished },
    steps,
  };
}
