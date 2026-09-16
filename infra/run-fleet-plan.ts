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
  classPoolsOf,
  concurrencyKeyOfRef,
  type Eligible,
  eligibleFrom,
  episodeDimensions,
  type EpisodeId,
  fail,
  type FleetConfig,
  type FleetJob,
  type FleetRosterEntry,
  type JobSpawn,
  keysOfIn,
  pinnedCampaignJobs,
  pinnedJobs,
  policyRefs,
  poolJobs,
  type PreflightRecord,
  scheduledAccounts,
  unpinnedCampaigns,
} from "./run-fleet-config";
import { backoffMs, isTainted, type RosterSpec, slug } from "./run-roster";
import { type Campaign, type ProbeRun, workDimensions } from "../runner/src/campaigns";
import { DEFAULT_CLAUDE_TOKEN_ENV, type TerminationReason } from "../runner/src/config";
import { isScoredEpisode } from "../runner/src/episodes";
import { classifyLapse, resumesOnPause } from "../runner/src/lapse";
import {
  ACCOUNT_CLASSES,
  type AccountClass,
  accountClassOf,
  type BusyAccount,
  capFor,
  CLAUDE_TOTAL_KEY,
  claudeKeysFor,
  DEFAULT_POLICY as DEFAULT_POLICY_FOR_FORMAT,
  type HeldPick,
  inSeries,
  type ModelState,
  type NextJob,
  planNextJobs,
  type RunFact,
  type SchedulingPolicy,
  staleForMs,
  TIER_TABLE,
} from "../runner/src/models";

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
 * evidence. Matching is the projection's own (model + effort), so a roster
 * entry renamed keeps its history and two entries on one model id do not.
 */
export function affinityFrom(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>): Map<string, Affinity> {
  const out = new Map<string, Affinity>();
  const at = new Map<string, number>();
  for (const [name, e] of Object.entries(roster)) {
    for (const f of runs) {
      if (f.account === null) continue;
      if (f.model !== e.model || (f.effort ?? null) !== (e.effort ?? null)) continue;
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

export interface QueuePlan {
  /** Jobs to spawn this tick, in queue order, each on the pool account it was given. */
  assign: { job: FleetJob; account: string }[];
  /** Runnable jobs with nothing free to run them on, in queue order. */
  waiting: FleetJob[];
  /** Jobs that will not run, and why (logged once per reason by the caller). */
  skipped: QueueSkip[];
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
 */
export function planQueue(opts: {
  queue: FleetJob[];
  roster: Record<string, FleetRosterEntry>;
  pool: string[];
  running: Map<string, string>;
  finished: Set<string>;
  held: (account: string) => string | undefined;
  cooling: (job: FleetJob) => string | undefined;
  /**
   * Who may run what. Default: only what needs no promotion. The
   * supervisor passes `eligibleFrom(modelStates(...))`, which adds what run
   * history has earned.
   */
  eligible?: Eligible;
  /** Roster names with a run in flight outside `queue` (policy and pinned jobs). */
  runningRefs?: ReadonlySet<string>;
  /**
   * The account a job's model would rather have (`affinityOf`): the
   * one its last run left its character on. A preference only — a job whose
   * account is busy takes the next free one, as before.
   */
  affinity?: AccountAffinity;
}): QueuePlan {
  const plan: QueuePlan = { assign: [], waiting: [], skipped: [] };
  const taken = new Set([...opts.running.values()].map((a) => a.toUpperCase()));
  const free = opts.pool.filter((a) => !taken.has(a.toUpperCase()) && opts.held(a) === undefined);
  const runningRefs = new Set<string>(opts.runningRefs ?? []);
  for (const job of opts.queue) if (opts.running.has(job.name)) for (const r of job.refs) runningRefs.add(r);
  for (const job of opts.queue) {
    if (job.account !== undefined) continue;
    if (!job.enabled || opts.running.has(job.name) || opts.finished.has(job.name)) continue;
    const refs = runnableRefs(job, opts.roster, opts.eligible);
    if (refs.length === 0) {
      const gated = job.refs.filter((r) => opts.roster[r] !== undefined);
      plan.skipped.push({
        job,
        reason:
          gated.length === 0
            ? `ref ${job.ref} is not in roster`
            : `${job.ref} is not eligible for ${job.episode} (its tier buys no ${job.episode} runs — earn it with a level-5 e90, or set a tier that includes it)`,
      });
      continue;
    }
    const clash = refs.find((r) => runningRefs.has(r));
    if (clash !== undefined) {
      plan.skipped.push({ job, reason: `${clash} is already running under another job — one character per model` });
      continue;
    }
    const cool = opts.cooling(job);
    if (cool !== undefined) {
      plan.skipped.push({ job, reason: cool });
      continue;
    }
    const account = takeAccount(free, opts.affinity?.(refs[0]!));
    if (account === undefined) {
      plan.waiting.push(job);
      continue;
    }
    for (const r of refs) runningRefs.add(r);
    plan.assign.push({ job, account });
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
    // A policy job was made from the projection that answers eligibility; it is its own witness.
    if (job.attempt !== undefined) return true;
    // An unscored episode needs no promotion: no tier buys one, so there is no
    // rung to have climbed. Otherwise the entry's own DECLARED tier is the
    // static floor — every tier buys e90, and a `t2` entry buys an e360 without
    // any run history, which is what the retired `tiers` force used to spell.
    // The projection is asked only for what a model has EARNED on top of that,
    // so a climb opens e360 for a `t1` entry.
    if (!isScoredEpisode(job.episode)) return true;
    if (e.tier !== undefined && TIER_TABLE[e.tier].runsPerEpisode[job.episode] > 0) return true;
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
    // A probe names its cell: the job name is what run ids, log paths and the
    // defer sidecar hang off, so without it every cell of one sweep would
    // accumulate under one name and a run id would not say which cell it was.
    name: pick.probe !== undefined ? `${pick.name}-${pick.probe.campaign}-${pick.probe.cell}` : `${pick.name}-${pick.episode}`,
    enabled: true,
    source: "policy",
    attempt: pick.attempt,
    ...(pick.extra !== undefined ? { extra: pick.extra } : {}),
    ...(pick.probe !== undefined ? { probe: pick.probe } : {}),
  };
}

/**
 * Whether a job is an extra run — a policy pick past the model's targets, which
 * the runner stamps `extra: true` so the projection never counts it.
 *
 * Two shapes, one question. A scored-tier extra carries the character it rolls;
 * a local model's extra is a freeplay pick with no character, and a freeplay
 * pick can only ever come from the extras path because no episode target names
 * `freeplay`. `attempt` is what makes the job the policy's: a manual freeplay
 * job (the nav probe) is not an extra.
 */
export function isExtraJob(job: Omit<Pick<FleetJob, "episode" | "extra" | "attempt">, "episode"> & { episode: EpisodeId | null }): boolean {
  return job.attempt !== undefined && (job.extra !== undefined || job.episode === "freeplay");
}

/** One policy pick, placed. */
export interface PolicyPick {
  job: FleetJob;
  account: string;
  why: string;
}

/**
 * The policy's fill for whatever the queue left free. Pure: the
 * projection is handed in. Only runs when no manual job is waiting — a manual
 * entry always outranks the policy — and never puts a second run on a
 * model. `concurrency` is the per-key cap (`concurrencyKeyOf`): `running`
 * counts every run in flight on that key, pinned jobs included, so a
 * subscription (or a shared free pool's daily budget) that tolerates only so
 * many sessions is a number in the file rather than a model removed from the
 * roster. `paid` is the paid cap (`policy.paid.maxConcurrent`):
 * `running` counts paid policy models in flight (pinned jobs excluded), and a
 * paid pick over the cap is held, with the reason in `held` for `--dry-run`.
 */
export function planPolicy(opts: {
  states: readonly ModelState[];
  pool: string[];
  /**
   * The accounts each split-out class may use (`classPoolsOf`): `accounts.paid`
   * and `accounts.local`, both unconditional. Picks of that class draw from
   * here and never from `pool`; an EMPTY array holds them and reports them.
   * A class ABSENT from the map shares the pool — a shape `classPoolsOf` no
   * longer produces, kept because hand-built configs (tests, a state file read
   * back) may predate a class.
   */
  classPools?: Partial<Record<AccountClass, string[]>>;
  running: Map<string, string>;
  held: (account: string) => string | undefined;
  queuePlan: QueuePlan;
  runningRefs: ReadonlySet<string>;
  concurrency?: {
    keyOf: (name: string) => string;
    max: Record<string, number>;
    running: ReadonlyMap<string, number>;
    /** A roster entry pinned to one subscription (`FleetRosterEntry.subscription`): its only candidate lane. */
    pinnedLane?: (name: string) => string | undefined;
  };
  policy?: SchedulingPolicy;
  /** Paid policy models already in flight (pinned jobs excluded). */
  paidRunning?: number;
  /** The enabled, unpinned campaigns the policy may schedule. */
  campaigns?: readonly Campaign[];
  /** Probe runs on disk, counted or not: what a campaign's remaining work is derived from. */
  probeRuns?: readonly ProbeRun[];
  /** The account a pick's model would rather have (`affinityOf`). */
  affinity?: AccountAffinity;
}): PolicyPick[] {
  return planPolicyHeld(opts).picks;
}

/** `planPolicy` plus what it held back and why. */
export function planPolicyHeld(opts: Parameters<typeof planPolicy>[0]): { picks: PolicyPick[]; held: HeldPick[] } {
  // A waiting manual job reserves the POOL, and nothing else. Such a job has no
  // account, and a job with no account can only ever take a pool one (the
  // class split governs the policy; a manual queue job draws from the
  // pool), so vetoing every class starved paid and local picks on accounts the
  // queue could never have used — a queue job stuck behind a busy RUNNER would
  // hold the local box idle. Returning no `held` with it also broke this file's
  // own rule that a held pick is always named. Reserve the pool, let the other
  // classes pick, and say what the reservation was for.
  const reserved =
    opts.queuePlan.waiting.length > 0
      ? `pool reserved for waiting manual job(s): ${opts.queuePlan.waiting.map((j) => j.name).join(", ")}`
      : undefined;
  const taken = new Set([...opts.running.values(), ...opts.queuePlan.assign.map((a) => a.account)].map((a) => a.toUpperCase()));
  const usable = (list: readonly string[]): string[] => list.filter((a) => !taken.has(a.toUpperCase()) && opts.held(a) === undefined);
  const free = reserved === undefined ? usable(opts.pool) : [];
  // Per split-out class: the accounts of that class still free right now.
  const splitFree: Partial<Record<AccountClass, string[]>> = {};
  for (const cls of ACCOUNT_CLASSES) {
    const declared = opts.classPools?.[cls];
    if (cls !== "pool" && declared !== undefined) splitFree[cls] = usable(declared);
  }
  // Nothing to place on, and nothing to say. A split class with nothing FREE
  // still has held picks to report — whether it is unconfigured or merely all
  // busy — so it does not short-circuit here.
  const gap = ACCOUNT_CLASSES.some((c) => c !== "pool" && opts.classPools?.[c] !== undefined && splitFree[c]!.length === 0);
  // A reserved pool still has something to report, so it does not short-circuit
  // either: the held rows are the whole point of naming the reservation.
  if (free.length === 0 && Object.values(splitFree).every((l) => l.length === 0) && !gap && reserved === undefined)
    return { picks: [], held: [] };
  const running = new Set(opts.runningRefs);
  for (const a of opts.queuePlan.assign) for (const r of a.job.refs) running.add(r);
  // The subscription lane each claude-code pick was placed on, decided by the
  // cap loop below and carried onto the job it spawns.
  const chosenLane = new Map<string, string>();
  const wrap = (pick: NextJob): PolicyPick => {
    const job = policyJob(pick);
    const lane = chosenLane.get(pick.name);
    return { job: lane !== undefined ? { ...job, subscription: lane } : job, account: pick.account, why: pick.why };
  };
  const billingOf = new Map(opts.states.map((s) => [s.name, s.billing]));
  const classOf = new Map(opts.states.map((s) => [s.name, accountClassOf(s)]));
  /** The class a pick draws its account from: `pool` unless that class is split out. */
  const listClass = (name: string): AccountClass => {
    const cls = classOf.get(name) ?? "pool";
    return splitFree[cls] !== undefined ? cls : "pool";
  };
  /** A class's accounts still free once the picks made so far have taken theirs. */
  const left = (cls: AccountClass, also: readonly NextJob[]): string[] =>
    (splitFree[cls] ?? []).filter((a) => !also.some((p) => listClass(p.name) === cls && p.account === a));
  /** Who holds an account that is not free: the run id if any, else the job on it. */
  const holderOf = (account: string): string | undefined =>
    opts.held(account) ??
    [...opts.running].find(([, a]) => a.toUpperCase() === account.toUpperCase())?.[0] ??
    opts.queuePlan.assign.find((a) => a.account.toUpperCase() === account.toUpperCase())?.job.name;
  /**
   * A class's accounts that exist but are taken — by a live run, by this
   * tick's queue, or by a pick already made in this round. Without it an
   * all-busy class reads as an unconfigured one.
   */
  const busy = (cls: AccountClass, also: readonly NextJob[]): BusyAccount[] => [
    ...(opts.classPools?.[cls] ?? [])
      .filter((a) => !(splitFree[cls] ?? []).includes(a))
      .map((a) => {
        const by = holderOf(a);
        return by !== undefined ? { account: a, by } : { account: a };
      }),
    ...also.filter((p) => listClass(p.name) === cls).map((p) => ({ account: p.account, by: p.name })),
  ];
  const next = (states: readonly ModelState[], accounts: readonly string[], also: readonly NextJob[]): ReturnType<typeof planNextJobs> =>
    planNextJobs(states, accounts, new Set([...running, ...also.map((p) => p.name)]), {
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      classAccounts: Object.fromEntries(
        ACCOUNT_CLASSES.filter((c) => splitFree[c] !== undefined).map((c) => [c, left(c, also)]),
      ) as Partial<Record<AccountClass, string[]>>,
      classBusy: Object.fromEntries(
        ACCOUNT_CLASSES.filter((c) => splitFree[c] !== undefined).map((c) => [c, busy(c, also)]),
      ) as Partial<Record<AccountClass, BusyAccount[]>>,
      paidRunning: (opts.paidRunning ?? 0) + also.filter((p) => billingOf.get(p.name) === "paid").length,
      ...(reserved !== undefined ? { poolHeld: reserved } : {}),
      ...(opts.campaigns !== undefined ? { campaigns: opts.campaigns } : {}),
      ...(opts.probeRuns !== undefined ? { probeRuns: opts.probeRuns } : {}),
    });
  /*
   * Accounts in preference order over the FINAL picks, each class over its own
   * list — a paid pick keeps a paid account, a local one keeps the box, and
   * the pool rows stay free-only. Affinity is the one thing that
   * reorders a class's list: a pick whose model left its character on a free
   * account of its own class takes that one instead of the first.
   */
  const pools: Partial<Record<AccountClass, string[]>> = { pool: [...free] };
  for (const cls of ACCOUNT_CLASSES) if (splitFree[cls] !== undefined) pools[cls] = [...splitFree[cls]!];
  const place = (pick: NextJob): PolicyPick =>
    wrap({ ...pick, account: takeAccount(pools[listClass(pick.name)] ?? [], opts.affinity?.(pick.name)) ?? pick.account });
  if (opts.concurrency === undefined) {
    const plan = next(opts.states, free, []);
    return { picks: plan.jobs.map(place), held: plan.held };
  }
  // The cap, over the projection's own priority order: a pick whose key is
  // full is passed over and the next candidate is asked for its account, until
  // a round yields nothing to pass over.
  const { keyOf, max } = opts.concurrency;
  const lanes = opts.policy?.subscriptions ?? DEFAULT_POLICY_FOR_FORMAT.subscriptions;
  /**
   * The keys a pick may count against, in preference order. One for everything
   * but a claude-code pick, which may go on any configured subscription: the
   * lane is not a property of the model, it is whichever account has a session
   * free, so the choice is made here and recorded on the job.
   */
  /** The candidate placements for a pick: one per lane it may take, each with the keys it would spend. */
  const keysOf = (name: string): { keys: string[]; lane: string }[] => {
    const k = keyOf(name);
    if (k !== CLAUDE_TOTAL_KEY) return [{ keys: [k], lane: "" }];
    // An entry pinned to one subscription has one candidate: with that lane
    // busy the pick is held, never quietly moved to the other account.
    const pin = opts.concurrency?.pinnedLane?.(name);
    const usable = pin !== undefined ? [pin] : lanes;
    return usable.map((l) => ({ keys: claudeKeysFor(l), lane: l }));
  };
  const count = new Map(opts.concurrency.running);
  const bump = (key: string): void => {
    count.set(key, (count.get(key) ?? 0) + 1);
  };
  for (const a of opts.queuePlan.assign) for (const r of a.job.refs) for (const k of keysOfIn(keyOf, r, a.job.subscription)) bump(k);
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
      const cands = keysOf(pick.name);
      /** A key with no room left; undefined when this placement can be made. */
      const fullKey = (keys: readonly string[]): string | undefined =>
        keys.find((k) => {
          const cap = capFor(max, k);
          return cap !== undefined && (count.get(k) ?? 0) >= cap;
        });
      const room = cands.find(({ keys }) => fullKey(keys) === undefined);
      if (room === undefined) {
        passed.add(pick.name);
        // Name the key that actually blocked each candidate: "the other
        // subscription had a slot but the overall ceiling is spent" and "this
        // subscription is busy" are different problems with different fixes.
        const blocked = cands.map((c) => fullKey(c.keys)!);
        const why =
          cands.length === 1
            ? `cap: ${blocked[0]} <= ${capFor(max, blocked[0]!)}, ${count.get(blocked[0]!) ?? 0} in flight${cands[0]!.lane !== "" ? " (pinned to this subscription)" : ""}`
            : `cap: no claude session free (${blocked.map((k) => `${k} ${count.get(k) ?? 0}/${capFor(max, k)}`).join(", ")})`;
        held.push({ name: pick.name, episode: pick.episode, why });
        rejected = true;
        continue;
      }
      for (const k of room.keys) bump(k);
      // Only a non-default lane is recorded: the default lane is what a job
      // with nothing said about it already runs on.
      if (room.lane !== "" && room.lane !== DEFAULT_CLAUDE_TOKEN_ENV) chosenLane.set(pick.name, room.lane);
      out.push(pick);
    }
    if (!rejected) break;
    states = states.filter((s) => !passed.has(s.name));
    accounts = free.filter((a) => !out.some((p) => p.account === a));
  }
  return { picks: out.map(place), held };
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
): JobSpawn {
  const dims = episodeDimensions(job.episode);
  /*
   * A probe's task shape comes from its campaign and nothing else.
   * The catalog entry supplies credentials and a model, so its own `objective`,
   * `watchdogs`, `maxToolCalls`, `wikiCoords` and `wiki` are dropped rather than merged:
   * a campaign that says "no objective" must not inherit one from whichever
   * entry it borrowed, or two cells of one sweep would be running different
   * experiments. Precedence is episode table < campaign < cell, which is what
   * `workDimensions` already resolves.
   */
  const campaign = job.probe === undefined ? undefined : campaigns.find((c) => c.name === job.probe!.campaign);
  const cell = campaign?.cells.find((x) => x.id === job.probe!.cell);
  const allProbeDims = campaign !== undefined && cell !== undefined ? workDimensions(campaign, cell) : undefined;
  // Watchdogs are merged into their own key below, so they are held apart here:
  // spreading them with the rest would replace that merge with the campaign's
  // partial override and silently drop the episode's idle and no-XP thresholds.
  const probeWatchdogs = allProbeDims?.watchdogs;
  const probeDims = allProbeDims === undefined ? undefined : (({ watchdogs: _w, ...rest }) => rest)(allProbeDims);
  const copies = job.repeat === "loop" ? 1 : job.repeat;
  const entries: RosterSpec[] = [];
  // A resume is its own witness too: the run was launched, so its ref is runnable.
  for (const r of job.resume !== undefined ? job.refs.filter((x) => roster[x] !== undefined) : runnableRefs(job, roster, eligible)) {
    const { tier: _tier, idle: _idle, billing: _billing, ...entry } = roster[r]!;
    // A probe keeps only what identifies the model; the campaign owns the rest.
    const { objective: _obj, watchdogs: _wd, maxToolCalls: _mtc, wikiCoords: _wc, wiki: _wk, ...credentials } = entry;
    const isProbe = probeDims !== undefined;
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
      ...(job.probe !== undefined ? { campaign: job.probe.campaign, cell: job.probe.cell } : {}),
      // Whether a pause is resumed at all, decided by the lane and travelling
      // with the spec so the roster process needs no config of its own.
      // Scored evals never resume; freeplay always does; a probe
      // campaign opts in.
      resumeOnPause: resumesOnPause(job.episode, campaign?.resume),
      // An extra run is stamped as one; a scored-tier extra also rolls the
      // policy's race/class, where a freeplay extra keeps the entry's own.
      ...(isExtraJob(job) ? { extra: true } : {}),
      ...(job.extra !== undefined ? { race: job.extra.race, class: job.extra.class } : {}),
      // The character's lineage rides only on the lane that owns one: a
      // hand-written freeplay job is the operator's own experiment and starts
      // where the operator says. Another ref's freeplay characters on the account
      // are kept on every fresh launch.
      ...(uncappedLane && job.continueFrom !== undefined ? { continueFrom: job.continueFrom } : {}),
      ...(job.keepCharacters !== undefined && job.keepCharacters.length > 0 ? { keepCharacters: [...job.keepCharacters] } : {}),
      ...(uncappedLane && job.continueDropped !== undefined ? { continueDropped: { ...job.continueDropped } } : {}),
      // The subscription lane, for the one driver that has one. Omitted on the
      // default lane, so a spawn is byte-identical to a pre-lane one.
      ...(job.subscription !== undefined && (entry.driver === "claude-code" || entry.driver === "codex") ? { tokenEnv: job.subscription } : {}),
    };
    const runId =
      `fleet-${job.name}-${slug(base.model)}${base.effort !== undefined ? `-${slug(base.effort)}` : ""}-${stamp}` +
      (job.attempt !== undefined && job.attempt > 1 ? `-a${job.attempt}` : "");
    for (let k = 1; k <= copies; k++) {
      entries.push(k === 1 ? (job.attempt !== undefined && job.attempt > 1 ? { ...base, runId } : base) : { ...base, runId: `${runId}-r${k}` });
    }
  }
  if (entries.length === 0) fail(`job ${job.name}: no ref of ${job.ref} is eligible for ${job.episode}`);
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
 * The spawn, made to resume one paused run first: the entry for
 * that model carries the paused run id and moves to the front — the roster
 * runs entries in order, and a *fresh* launch of a rotation-mate wipes the
 * account's characters, which would cost the paused run its level. The
 * roster's --resume-roster then reattaches that run id instead of launching.
 */
export function withResume(spawn: JobSpawn, resume: NonNullable<FleetJob["resume"]>): JobSpawn {
  const entries = [...spawn.entries];
  const i = entries.findIndex((e) => e.model === resume.model && (e.effort ?? undefined) === (resume.effort ?? undefined));
  if (i >= 0) {
    const [hit] = entries.splice(i, 1);
    entries.unshift({ ...hit!, runId: resume.runId });
  } else if (entries.length > 0) {
    // The paused run's identity comes from its meta.json on --resume; the
    // entry only has to name the run id and a model the roster accepts.
    entries.unshift({ ...entries[0]!, model: resume.model, ...(resume.effort !== undefined ? { effort: resume.effort } : {}), runId: resume.runId });
  }
  return { ...spawn, entries, resumeRunId: resume.runId };
}

// ------------------------------------------------------------------ resumes
//
// A fleet stop pauses every live run (the runner pauses on SIGTERM,
// clock stopped, session released) and a fleet start resumes them before the
// queue or the policy launches anything fresh. The same planner runs every
// tick, so a run its provider paused (rate-limited, quota-exhausted) is also
// picked back up once its cooling is over — that is item 43.

export interface ResumePlan {
  job: FleetJob;
  account: string;
  runId: string;
  /** How many times the run has paused; with the run id, names this resume attempt. */
  pauseCount: number;
  why: string;
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
 * `counts` is the three-strike question and it is exactly
 * `reason === "attempt-failed"`, carried here so the log line and the
 * projection cannot disagree about it.
 */
export interface EndedRun {
  runId: string;
  model: string;
  /** Part of the model's identity: opus-low and opus-high are two rows. */
  effort: string | null;
  /** The job ref it was launched under, when the run id names one. */
  ref: string | null;
  episode: EpisodeId;
  reason: TerminationReason;
  detail: string;
  counts: boolean;
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
  /** How many times this run has paused; what the resume cadence indexes. */
  pauseCount: number;
  /** When the supervisor will try again; null when waiting on something other than time. */
  resumeAfter: number | null;
  elapsedMs: number | null;
  budgetMs: number | null;
  why: string;
}

/** "41m of 90m" — what the accounts table and the paused listing say about a paused run. */
export function fmtPaused(elapsedMs: number | null, budgetMs: number | null): string {
  const spent = elapsedMs !== null ? fmtElapsed(elapsedMs) : "?";
  return budgetMs !== null ? `${spent} elapsed of ${fmtElapsed(budgetMs)}` : `${spent} elapsed`;
}

/**
 * The resume cadence for a paused run. An operator-pause resumes at once —
 * the fleet stopped under it and nothing about the provider changed. A
 * provider pause resumes on the roster's own defer ladder (1m … 6h), indexed
 * by how many times THIS run has paused, which continues the cadence the
 * roster process was on before it gave up and exited; past the ladder the
 * run is listed, not hammered. Null means "now".
 */
export function resumeNotBefore(pause: NonNullable<RunFact["pause"]>): number | "never" | null {
  if (pause.reason === "operator-pause") return null;
  if (isTainted(pause.count)) return "never";
  return pause.at + backoffMs(pause.count);
}

/**
 * Whether the campaign that commissioned a run asked to be resumed
 * (`campaigns.<name>.resume`, default false). A run with no campaign, or one
 * whose campaign has since been deleted from the file, is not resumed: the
 * config is the only place that opt-in can come from.
 */
export function campaignResumeOf(campaigns: readonly Campaign[] | undefined, campaign: string | null): boolean {
  if (campaign === null || campaigns === undefined) return false;
  return campaigns.find((c) => c.name === campaign)?.resume === true;
}

/**
 * Runs nothing came back for. Pure.
 *
 * The host slept, or the fleet was down for half a day: a run left live or
 * paused is cooked, because its episode budget elapsed in wall clock while
 * nobody was playing it. Every such run is ENDED — a failed attempt when it
 * was waiting on its provider, `stale` otherwise, since an offline gap is the
 * harness's weather and not the model's failure. Freeplay is ended the same
 * way; the next tick starts a fresh session rather than resuming a dead one.
 *
 * Paused runs are handled by `planResumes`, which walks them anyway; this
 * covers the ones with no pause record at all — a run whose process died with
 * the machine.
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
    if (f.account !== null && busy.has(f.account.toUpperCase())) continue;
    const gap = staleForMs(f, opts.now);
    if (gap === null) continue;
    const lapse = classifyLapse({
      episode: f.episode,
      campaignResume: campaignResumeOf(opts.campaigns, f.campaign),
      pause: null,
      staleForMs: gap,
    });
    if (lapse.kind === "resume") continue;
    out.push({
      runId: f.runId,
      model: f.model,
      effort: f.effort,
      ref: refOfRunId(f.runId, f.episode, opts.refs ?? []) ?? null,
      episode: f.episode,
      reason: lapse.reason!,
      detail: lapse.detail!,
      counts: lapse.counts,
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
}): { resume: ResumePlan[]; listed: PausedListing[]; end: EndedRun[] } {
  const { config, now } = opts;
  const resume: ResumePlan[] = [];
  const listed: PausedListing[] = [];
  const end: EndedRun[] = [];
  const takenAccounts = new Set([...opts.running.values()].map((a) => a.toUpperCase()));
  const takenJobs = new Set(opts.running.keys());
  const policyNames = policyRefs(config);
  // Any scheduled class may carry a resume: a paid or local run comes back on
  // its own account, exactly as a pool run comes back on its pool account.
  const poolSet = new Set(scheduledAccounts(config).map((a) => a.toUpperCase()));
  const paused = opts.runs.filter((f) => f.pause !== null).sort((a, b) => b.pause!.at - a.pause!.at);
  const seenModel = new Set<string>();
  for (const f of paused) {
    const pause = f.pause!;
    const list = (why: string, resumeAfter: number | null = null): void => {
      listed.push({ runId: f.runId, model: f.model, account: f.account, reason: pause.reason, since: pause.at, pauseCount: pause.count, resumeAfter, elapsedMs: pause.episodeElapsedMs, budgetMs: f.episodeMs, why });
    };
    // Another series' paused run is not this supervisor's to resume — the
    // harness it ran under is not the one running now — and just as
    // importantly it is not this supervisor's to END: the sweep below would
    // write a termination on every paused run left over from every older
    // series (42 of them on 2026-09-08). It used to be filtered out before the
    // loop, which made it invisible everywhere, including in `--status`. A
    // FRESH one is listed instead, because that is a run somebody is waiting
    // on; a cold one stays out of the listing, as it always was.
    if (!inSeries(f, config.policy)) {
      if (staleForMs(f, now) === null) {
        list(
          `paused under harness series ${f.harnessSeries ?? "unversioned"}, this supervisor runs ${config.policy.series ?? "no series"} — resume by hand (--resume ${f.runId}) or archive`,
        );
      }
      continue;
    }
    const modelKey = `${f.model}@${f.effort ?? ""}`;
    const launchedUnder = refOfRunId(f.runId, f.episode, Object.keys(config.roster));
    const current = launchedUnder === undefined ? undefined : config.roster[launchedUnder];
    if (launchedUnder !== undefined && current !== undefined && (current.model !== f.model || (current.effort ?? null) !== (f.effort ?? null))) {
      end.push({
        runId: f.runId,
        model: f.model,
        effort: f.effort,
        ref: launchedUnder,
        episode: f.episode,
        reason: "manual",
        detail: `ended by the supervisor: model ${f.model} no longer under ref ${launchedUnder}`,
        counts: false,
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
      campaignResume: campaignResumeOf(config.campaigns, f.campaign),
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
        ref: launchedUnder ?? null,
        episode: f.episode,
        reason: lapse.reason!,
        detail: lapse.detail!,
        counts: lapse.counts,
        account: f.account,
      });
      continue;
    }
    if (seenModel.has(modelKey)) {
      list("another, newer paused run of this model is ahead of it — resume by hand or archive");
      continue;
    }
    seenModel.add(modelKey);
    const refs = Object.entries(config.roster)
      .filter(([, e]) => e.model === f.model && (e.effort ?? null) === (f.effort ?? null))
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
    if (job.account === undefined && !poolSet.has(account.toUpperCase())) {
      list(`account ${account} is in no account class (pool, paid, local) — resume by hand`);
      continue;
    }
    if (takenJobs.has(job.name)) continue; // its roster is running; it handles its own pause
    const notBefore = resumeNotBefore(pause);
    if (notBefore === "never") {
      list(`${pause.reason} ${pause.count} times — past the defer ladder; resume by hand when the provider is back`);
      continue;
    }
    if (notBefore !== null && now < notBefore) {
      list(`${pause.reason}, pause ${pause.count}: resuming after ${new Date(notBefore).toLocaleTimeString()}`, notBefore);
      continue;
    }
    if (takenAccounts.has(account.toUpperCase())) {
      list(`waiting: account ${account} is busy (${[...opts.running].find(([, a]) => a.toUpperCase() === account!.toUpperCase())?.[0] ?? "another job"})`);
      continue;
    }
    const holder = opts.held(account);
    if (holder !== undefined && holder !== f.runId) {
      list(`waiting: account ${account} is held by run ${holder}`);
      continue;
    }
    takenAccounts.add(account.toUpperCase());
    takenJobs.add(job.name);
    resume.push({
      job: { ...job, resume: { runId: f.runId, model: f.model, ...(f.effort !== null ? { effort: f.effort } : {}) } },
      account,
      runId: f.runId,
      pauseCount: pause.count,
      why: `${pause.reason}${pause.count > 1 ? ` (pause ${pause.count})` : ""}, ${fmtPaused(pause.episodeElapsedMs, f.episodeMs)}`,
    });
  }
  return { resume, listed, end };
}

/**
 * The run facts as they read once this tick's terminations are on disk. Pure.
 *
 * The projection is built at the top of a tick and the sweep writes its
 * terminations halfway down it, so without this the scheduler reads a strike
 * count that predates the strike it just wrote. That is not a cosmetic lag: on
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
// idle watchdog, a hand kill, a stale sweep — is continued under the next
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
 * its predecessor. Latest start wins.
 *
 * A PAUSED run is a head too. It used to be excluded on the argument that
 * `planResumes` owns it, and that is true while the supervisor can see it —
 * but the runs directory is the only thing that survives a supervisor, and a
 * paused head the resume planner declines (another series, a spent ladder, a
 * job the operator disabled) then vanished from the chain entirely: on
 * 2026-09-08 the newest attempt of the nemotron-super character sat paused while
 * the policy started a fresh one `--continue-from` the ENDED attempt before
 * it, orphaning the paused one off the chain. The character is the same one
 * either way, so the honest lineage is the newest attempt, resumed or
 * continued from. Nothing here launches anything: a head that IS resumable is
 * resumed by `planResumes`, which reserves its account and job name before the
 * policy picks.
 */
export function charactersFrom(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>): Map<string, Character> {
  const out = new Map<string, Character>();
  const at = new Map<string, number>();
  for (const [name, e] of Object.entries(roster)) {
    if (e.idle !== "unlimited") continue;
    for (const f of runs) {
      if (f.episode !== "freeplay" || f.account === null || f.character === null) continue;
      if (f.live || (f.terminationReason === null && f.pause === null)) continue;
      if (f.model !== e.model || (f.effort ?? null) !== (e.effort ?? null)) continue;
      if ((at.get(name) ?? -1) >= f.startedAt) continue;
      at.set(name, f.startedAt);
      out.set(name, { runId: f.runId, account: f.account, character: f.character });
    }
  }
  return out;
}

/** The freeplay characters standing on `account` that a launch of `ref` must keep. */
export function keepFor(account: string, characters: ReadonlyMap<string, Character>, ref?: string): string[] {
  const out: string[] = [];
  for (const [name, s] of characters) {
    if (name === ref) continue;
    if (s.account.toUpperCase() !== account.toUpperCase()) continue;
    if (!out.some((c) => c.toLowerCase() === s.character.toLowerCase())) out.push(s.character);
  }
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
 * its account to keep.
 */
export function planContinuations(
  picks: readonly PolicyPick[],
  characters: ReadonlyMap<string, Character>,
  roster: Record<string, FleetRosterEntry>,
  occupants: ReadonlyMap<string, Occupant> = new Map(),
): { picks: PolicyPick[]; waiting: CharacterWait[]; dropped: CharacterDrop[] } {
  const out: PolicyPick[] = [];
  const waiting: CharacterWait[] = [];
  const dropped: CharacterDrop[] = [];
  for (const p of picks) {
    const keep = keepFor(p.account, characters, p.job.ref);
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
 * re-enable: resumed in place while the pause is fresh, continued under the
 * next attempt once the stale sweep has ended it.
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
 * active model never trips (item 107: flipping a character's `idle` to `"none"`
 * did nothing until someone SIGTERMed the roster by hand). This is what makes
 * the ROSTER_ENTRY_KEYS hint — "to pause a character set `idle: \"none\"`" — true.
 *
 * The question is asked of the LOADED CONFIG, never of the plan. The caller
 * walks the accounts that are assigned, so a live policy job is reached every
 * tick whether or not the policy would pick it again, and the reasons the
 * policy would not (account busy, a lane or paid cap, cooling on the defer
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
 * Whether this job's run comes back WHERE IT LEFT OFF after a supervisor
 * restart — same run id, account and character — rather than spending its
 * attempt. Two kinds do: the freeplay character (`pausesOnDrain`, resumed in
 * place while the pause is fresh) and a probe campaign that asked to be
 * resumed (`campaigns.<name>.resume`). Everything else — every scored e90 or
 * e360 — is ended `manual` on the next boot and must be waited out on its own
 * clock.
 *
 * Published per job row so `infra/fleet-update.sh` can decide what its
 * graceful window is actually waiting for without re-deriving the campaign's
 * opt-in from a config the supervisor may not even be running (the pause
 * switch exists to work while `fleet.json` is rejected). Pure.
 */
export function resumesInPlace(job: Pick<FleetJob, "source" | "episode" | "probe"> | undefined, campaigns: readonly Campaign[] | undefined): boolean {
  if (job === undefined) return false;
  if (pausesOnDrain(job)) return true;
  return job.probe !== undefined && campaignResumeOf(campaigns, job.probe.campaign);
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

/**
 * How many failed attempts this model already has on the episode a lapsed run
 * belongs to — what "retry 2/3" counts from. The projection is the only place
 * that number is derived, so the log line and the Models page agree.
 */
export function failedAttemptsFor(states: readonly ModelState[], e: Pick<EndedRun, "model" | "effort" | "episode">): number | undefined {
  const st = states.find((s) => s.model === e.model && s.effort === e.effort)?.perEpisode[e.episode];
  return st?.failed;
}

/**
 * The retry number each of a batch of lapsed runs will carry, in order.
 *
 * The projection is read once a tick, so it does not know about the runs this
 * same tick is about to end. A sweep after an outage ends several failures for
 * one model at once, and without this every line would read "retry 1/3" while
 * they summed to three. Counting within the batch is what makes `--status`
 * honest about a model that is being tainted right now.
 */
export function retryNumbers(ended: readonly EndedRun[], base: (e: EndedRun) => number): number[] {
  const seen = new Map<string, number>();
  return ended.map((e) => {
    const key = `${e.model}@${e.effort ?? ""}@${e.episode}`;
    const n = base(e) + (seen.get(key) ?? 0);
    if (e.counts) seen.set(key, (seen.get(key) ?? 0) + 1);
    return n + 1;
  });
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
 * (`fleet-<job>-<model-slug>[-<effort>]-<date>`) so fleet runs never share a
 * run id with hand-launched rosters or with another job.
 */
export function fillEntries(spawn: JobSpawn, stamp: string): RosterSpec[] {
  return spawn.entries.map((e) => ({
    ...e,
    account: spawn.account,
    runId:
      e.runId ??
      `fleet-${spawn.name}-${slug(e.model)}${e.effort !== undefined ? `-${slug(e.effort)}` : ""}-${stamp}`,
  }));
}

/**
 * Respawn circuit breaker (2026-08-24). A job whose process keeps dying
 * within seconds of spawning leaves no run artifact, so nothing else cools
 * it: the defer ladder reads runs from disk, and a launch that failed before
 * `run.sqlite` existed is invisible to it. `sonnet-low` respawned every 60s
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
  /** jobs whose process exited while enabled (done; not respawned) */
  finished: Set<string>;
}

export interface JobActions {
  start: JobSpawn[];
  drain: string[];
  undrain: string[];
  /** finished jobs now disabled: forget them so a later re-enable respawns */
  rearm: string[];
}

// ------------------------------------------------------------- the switch
//
// One knob, outside fleet.json: `data/runs/fleet-pause.json`. It stops the
// fleet launching anything while every live episode finishes on its own clock,
// which is what makes a supervisor update (`infra/fleet-update.sh graceful`)
// cost no run its attempt.
//
// A SIDECAR rather than a config key, for the reason the models sidecar is one:
// `infra/fleet.json` is hand-written, checked in, and a typo in it makes every
// `enabled` flag in the file inert until someone notices the banner. A switch
// an operator flips under time pressure must not be able to do that. It also
// means the switch survives the file being rejected, which is exactly when
// somebody wants to stop the fleet.
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
 * what docs/OPERATIONS.md tells them to do before a deploy window — would be
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
 * The plan for one tick with nothing running: which pinned jobs spawn, which
 * pool accounts the queue and then the policy would take. Pure over the
 * projection; used by --dry-run and by the startup fail-fast.
 */
export function planTick(
  config: FleetConfig,
  states: readonly ModelState[],
  held: (a: string) => string | undefined,
  stamp: string,
  resumes: readonly ResumePlan[] = [],
  probeRuns: readonly ProbeRun[] = [],
  affinity?: AccountAffinity,
  /** Which subscription each ref's live run is on (`liveSubscriptions`); absent reads every claude ref as the default lane. */
  lanes: ReadonlyMap<string, string> = new Map(),
): {
  pinned: { job: FleetJob; spawn: JobSpawn }[];
  queue: QueuePlan;
  policy: PolicyPick[];
  /** Picks the policy wanted but held back (paid cap, driver cap), with why. */
  heldPicks: HeldPick[];
} {
  const eligible = eligibleFrom(states);
  const resumed = new Set(resumes.map((r) => r.job.name));
  // A pinned campaign's next cell is a pinned job, and it has to be one HERE
  // too: `planTick` is what `--status` and `--dry-run` print, and a probe the
  // live loop would spawn but this planner never mentions is exactly the kind
  // of quiet disagreement between the supervisor and its own report that has
  // cost a night before.
  const pinned = [...pinnedJobs(config), ...pinnedCampaignJobs(config, probeRuns)]
    .filter((j) => j.enabled && !resumed.has(j.name) && runnableRefs(j, config.roster, eligible).length > 0)
    .map((job) => ({ job, spawn: jobSpawn(job, config.roster, job.account!, stamp, eligible, config.campaigns) }));
  // Resumes hold their accounts and their refs ahead of everything fresh.
  const running = new Map(resumes.map((r) => [r.job.name, r.account]));
  const runningRefs = new Set([...pinned.flatMap((p) => p.job.refs), ...resumes.flatMap((r) => r.job.refs)]);
  const queue = planQueue({
    queue: poolJobs(config),
    roster: config.roster,
    pool: config.accounts.pool,
    running,
    finished: new Set(),
    held,
    cooling: () => undefined,
    eligible,
    runningRefs,
    ...(affinity !== undefined ? { affinity } : {}),
  });
  const policyStates = states.filter((st) => policyRefs(config).has(st.name));
  const billingOfName = new Map(states.map((st) => [st.name, st.billing]));
  const keyOf = (n: string): string => concurrencyKeyOfRef(config.roster, n, billingOfName.get(n));
  const keyCount = new Map<string, number>();
  // Same rule the live tick uses: a claude ref counts against the subscription
  // its own run says it is on, so --status and --dry-run agree with the fleet.
  for (const r of runningRefs) {
    for (const k of keysOfIn(keyOf, r, lanes.get(r))) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  const { picks: policy, held: heldPicks } = planPolicyHeld({
    states: policyStates,
    pool: config.accounts.pool,
    classPools: classPoolsOf(config),
    running,
    held,
    queuePlan: queue,
    runningRefs,
    concurrency: { keyOf, max: config.maxConcurrent, running: keyCount, pinnedLane: (n) => config.roster[n]?.subscription },
    policy: config.policy,
    paidRunning: 0,
    campaigns: unpinnedCampaigns(config),
    probeRuns,
    ...(affinity !== undefined ? { affinity } : {}),
  });
  return { pinned, queue, policy, heldPicks };
}
