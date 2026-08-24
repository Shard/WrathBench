#!/usr/bin/env bun
/**
 * Fleet orchestrator: one run-roster process per enabled job in fleet.json.
 *
 *   docker compose -f infra/compose.yml up -d --no-deps fleet   (the normal shape)
 *   ./infra/run-fleet.sh infra/fleet.json --until 18:00         (ad-hoc, host)
 *   ./infra/run-fleet.sh infra/fleet.json --dry-run
 *   ./infra/run-fleet.sh --status                               (host, read-only)
 *
 * The supervisor's home is the `fleet` compose service — same image and mounts
 * as `runner`, `restart: unless-stopped`, no deadline (ADR-0020). It therefore
 * cannot assume the reader of `--status` shares its PID namespace: liveness is
 * published as a heartbeat in fleet-state.json and per-job `alive` flags, not
 * inferred with kill(pid, 0). Paths in that state file are repo-relative for
 * the same reason.
 *
 * The fleet is the config file, and its one unit of work is the JOB: a roster
 * entry (or a rotation of several), an episode tier, a repeat count, on ONE
 * game account for the life of its process. A job that names an `account` is
 * PINNED to it; a job without one takes whichever POOL account is free when
 * its turn comes; and the scheduling policy (ADR-0034) makes up jobs of its
 * own — synthetic, never persisted — for the accounts the manual queue leaves
 * free. Every job spawns through the same path: it becomes one run-roster
 * process on one account, and releases the account when that process exits.
 * There is no other shape: a file that still says `lanes` or `accounts.pinned`
 * is refused by name. The supervisor re-reads fleet.json every tick (60s):
 *
 *  - enabled:false  -> the job drains: no SIGTERM while its roster process
 *    has an episode child; once the process is between episodes it is
 *    SIGTERMed (run-roster's own handler stops it cleanly). There is an
 *    unavoidable small race — a child spawned in the instant between the
 *    idle check and the kill gets run-roster's graceful episode termination
 *    (30s grace), not a hard kill — so in the worst case "disable" costs one
 *    just-started episode, never a corrupted one.
 *  - enabled:true / new job -> spawned on the next tick.
 *  - malformed or invalid fleet.json on re-read -> complaint, last good
 *    config kept, nothing running is touched.
 *
 * Guards, enforced at startup and on every re-read:
 *  - two enabled jobs must not share an account (one live session per
 *    account; the second job would spend the night in account_in_use).
 *  - roster policy: claude-family models (opus/sonnet/haiku/claude-*) run only
 *    via the claude-code driver, and that driver runs only claude
 *    models. Shared free-cloud pools (OpenRouter/OpenCode) carry free models
 *    only; keeping a single stream per provider pool is the whole point of
 *    one job per account. A local/self-hosted openai apiBase is a distinct
 *    category: exempt from the free-suffix rule (no shared pool to meter),
 *    still barred from claude-* ids.
 *
 * The roster's own account-busy guard still runs under every job: a job
 * pointed at an account something else is using waits, it does not clobber.
 *
 * Preflight gate (ADR-0023): the top-level `preflight` block in fleet.json is
 * the deploy-window smoke, made a normal part of fleet operation. The
 * supervisor runs those scripts against the live server before it spawns any
 * job, and again whenever the server identity changes (a recreate, or a
 * restart the container did by itself). A failure spawns nothing, complains
 * once, and is re-checked every tick; only `start` is ever suppressed, so
 * drains keep working while the gate is shut. `enabled:false` records a
 * "skipped" result and opens the gate.
 */

import { Database } from "bun:sqlite";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { accountHeldBy, backoffMs, deferSidecarPath, isTainted, parseDefers, slug, type DeferEntry, type RosterSpec } from "./run-roster";
import { Trajectory } from "../runner/src/trajectory";
import { harnessSeries } from "../runner/src/comparability";
import { watchdogOverrideSchema } from "../runner/src/config";
import { isAllowlistedFree, isLocalBase, type Billing } from "../runner/src/model-cost";
import { campaignWork, parseCampaigns, workDimensions, type Campaign, type ProbeRun } from "../runner/src/campaigns";
import {
  ACCOUNT_CLASSES,
  LADDER_MS,
  MODELS_SIDECAR,
  accountClassOf,
  concurrencyKeyOf,
  inSeries,
  isCounted,
  isStalePause,
  modelStates,
  outstandingWork,
  formatOutstanding,
  readRunFacts,
  parsePolicyBlock,
  parseTier,
  parseIdle,
  TIERS,
  TIER_TABLE,
  UNLIMITED_SESSION_MS,
  type Tier,
  type IdleMode,
  parseModelsSidecar,
  planNextJobs,
  pinnedRefs as pinnedRefsOf,
  policyExclusion as policyExclusionOf,
  policyRefs as policyRefsOf,
  readModelsSidecar,
  rosterClass,
  schedulability,
  serializeModelsSidecar,
  extrasSoFar,
  STATS_EPISODES,
  type AccountClass,
  type BusyAccount,
  type HeldPick,
  type ModelState,
  type NextJob,
  type RosterModel,
  type RunFact,
  type SchedulingPolicy,
  type StartingCharacter,
} from "../runner/src/models";
import { isScoredEpisode } from "../runner/src/episodes";
import { harnessVersion } from "../runner/src/version";
import { DEFAULT_POLICY as DEFAULT_POLICY_FOR_FORMAT } from "../runner/src/models";

export { isAllowlistedFree };

/**
 * The harness series this supervisor runs from (ADR-0034): the projection
 * counts only runs stamped with it. Null outside a versioned checkout, which
 * counts every run and is said so in `--status`.
 */
export function currentSeries(): string | null {
  return harnessSeries(harnessVersion());
}

// ------------------------------------------------------------------ types

/**
 * A job as it is spawned: one run-roster process on one account. This is the
 * materialised form every job takes on its way to `spawnJob` — pinned, pool
 * and policy alike. The roster entries carry every run dimension themselves
 * (objective, watchdogs, maxToolCalls, wikiCoords — ADR-0024/0028); the
 * spawn adds only the account and the fleet-scoped run ids.
 */
export interface JobSpawn {
  name: string;
  enabled: boolean;
  account: string;
  loop: boolean;
  /** Roster entries — the exact per-entry schema run-roster accepts. */
  entries: RosterSpec[];
  /**
   * Set on a spawn that resumes a paused run (ADR-0036): its first entry
   * carries that run id, and the roster is started with --resume-roster so
   * it reattaches instead of launching fresh (which would wipe the account's
   * characters).
   */
  resumeRunId?: string;
}

/**
 * The deploy-window smoke, as a normal part of fleet operation. The supervisor
 * runs these scripts against the live server before it spawns anything, and
 * again whenever the server identity changes (a worldserver recreate or
 * restart). `enabled:false` keeps the mechanism installed and disarmed.
 *
 * `timeoutMs` is the budget for the WHOLE gate, not per script: every child
 * gets the same deadline and the per-script `ms` in the recorded results is
 * the breakdown.
 *
 * Smokes fan out: entries with distinct accounts run concurrently (one live
 * session per account is the module's rule, so the account is the stream), and
 * entries that share an account run one after the other in list order. A bare
 * string entry in fleet.json is the pre-2026-08-23 form and means "on the
 * default `account`".
 *
 * `deploySmokes` is the deploy-time full arc (module-quest.ts, minutes long):
 * run by infra/deploy-worldserver.sh once per deploy, never by the per-tick
 * gate. It is config here so the deploy script and the supervisor read the
 * same file and the same accounts clash-check.
 */
export interface FleetPreflight {
  enabled: boolean;
  /** Default game account for string-form smokes — its own, never a job's, never PROBE. */
  account: string;
  /** Repo-relative (or absolute) smoke scripts, each bound to the account it logs in as. */
  smokes: PreflightSmoke[];
  timeoutMs: number;
  /** Deploy-only smokes (deploy-worldserver.sh), same entry forms as `smokes`. */
  deploySmokes: PreflightSmoke[];
  /** Budget for the whole deploySmokes sequence. */
  deployTimeoutMs: number;
}

export interface PreflightSmoke {
  script: string;
  account: string;
}

/** Every account the gate logs in as, de-duplicated, in first-seen order. */
export function preflightAccounts(pf: FleetPreflight): string[] {
  return [...new Set([pf.account, ...pf.smokes.map((s) => s.account), ...pf.deploySmokes.map((s) => s.account)])];
}

/** One recorded gate attempt. Written into fleet-state.json; read by --status. */
export interface PreflightRecord {
  at: number;
  serverIdentity: string;
  /** The server's /health `build` stamp when it serves one (module >= 2026-08-22). */
  build?: string;
  ok: boolean;
  /** True when preflight.enabled is false: the gate is open, nothing ran. */
  skipped?: boolean;
  results: { script: string; ok: boolean; ms: number; tail: string }[];
}

// ------------------------------------------------------------------- jobs
//
// ADR-0034: the fleet is a set of jobs over a set of accounts. A job PINNED
// to an account (`account` in the file) runs there and nowhere else; a job
// without one is POOL work, spawned on whichever `accounts.pool` account is
// free when its turn comes; the policy's own picks are jobs too, made up each
// tick.

/** Episode tiers (ADR-0033). The unscored ids bypass the tiers gate entirely. */
export const EPISODE_IDS = ["e90", "e360", "probing", "freeplay"] as const;
export type EpisodeId = (typeof EPISODE_IDS)[number];

/**
 * A roster entry as named in the `roster` map: the exact per-entry schema plus
 * its scheduling axes (ADR-0040). `tier` is the whole answer to how much this
 * model runs, and it is required — except on a steered entry (one carrying an
 * `objective`), which is outside the policy and has no budget to state, where
 * it is refused instead. `idle` says what the model does with an account once
 * its tier is spent; absent is `none`. An entry may carry the run dimensions
 * (`objective`, `watchdogs`, `maxToolCalls`, `wikiCoords`): a probe with an
 * objective is a roster entry like any other, referenced by a pinned job.
 */
export interface FleetRosterEntry extends RosterSpec {
  /** Required: since ADR-0041 there is no such thing as an entry outside the policy. */
  tier: Tier;
  idle: IdleMode;
  /** Operator override of the free/paid verdict (`runner/src/model-cost.ts`); normally absent. */
  billing?: Billing;
}

export type JobSource = "pinned" | "queue" | "policy";

export interface FleetJob {
  /**
   * Keys into `roster`, one or more. Several refs make one job rotate through
   * several models on one account; `ref` in the file may be a string or an
   * array, normalised here.
   */
  refs: string[];
  /** `refs.join("+")`: what the job is called in logs and skip reasons. */
  ref: string;
  episode: EpisodeId;
  /** Episodes to run: a count (default 1) or "loop" (run-roster --loop). */
  repeat: number | "loop";
  /**
   * The job's name: run ids, roster and log paths hang off it
   * (`fleet-<name>-<model>-<stamp>`). Always `<first ref>-<episode>`; unique
   * across the file.
   */
  name: string;
  enabled: boolean;
  /** Set: the job is pinned to this account. Absent: the pool assigns one. */
  account?: string;
  source: JobSource;
  /**
   * Set on a job the scheduling policy made up, never on one from the file:
   * the n-th attempt on (model, episode), which suffixes the run id `-a<n>`
   * from the second attempt on so every attempt has its own id.
   */
  attempt?: number;
  /**
   * Set on an extra run that rolls a character (ADR-0034): a policy pick past
   * the model's target on a scored tier. Reaches the runner as `--race/--class`
   * plus `--extra true`, so the run is stamped and never counted. A local
   * model's extra is a freeplay run and rolls nothing — `isExtraJob` is the
   * question "is this an extra", this field is only "which character".
   */
  extra?: StartingCharacter;
  /**
   * Set by `planResumes` (ADR-0036): this job's spawn resumes the paused run
   * named here, on the account it was on, before anything fresh is launched.
   * `model`/`effort` pick the entry that carries the run id.
   */
  resume?: { runId: string; model: string; effort?: string | undefined };  /**
   * Set when this job is a probe campaign's work (ADR-0041): which campaign
   * commissioned it and which cell it is. The campaign's own dimensions are
   * looked up from the config at spawn time; only the identity travels here.
   */
  probe?: { campaign: string; cell: string };
}

export interface FleetAccounts {
  /** account -> the pinned job on it. Derived from the jobs, never authored. */
  pinned: Record<string, string>;
  /** free-for-the-pool accounts, in preference order. Free models only. */
  pool: string[];
  /**
   * The paid class (ADR-0034 amendment 2026-08-23): accounts a PAID policy
   * pick may use, in preference order. A paid pick lands here and nowhere
   * else; the pool stays free-only. Empty with `policy.paid` present means
   * paid picks are held ("no paid account configured") rather than spilling
   * into the pool.
   */
  paid: string[];
  /**
   * The local class (ADR-0034, "Account classes"): the accounts a model on the
   * operator's own hardware may use — `isLocalBase` in `runner/src/model-cost.ts`
   * decides which models those are. The LM Studio box serves one runner at a
   * time, so its accounts are its own for the same reason the paid ones are:
   * the resource is the limit, not a counter. Absent or empty with a local
   * model in the roster means those picks are HELD, never spilled into the pool.
   */
  local: string[];
}

export interface FleetConfig {
  notes: string[];
  preflight: FleetPreflight;
  accounts: FleetAccounts;
  roster: Record<string, FleetRosterEntry>;
  /** Every job the file names, pinned and pool, in file order. */
  jobs: FleetJob[];
  /** The `campaigns` block (ADR-0041), in declaration order; empty when the file has none. */
  campaigns: Campaign[];
  /** ADR-0034 targets; `policy.runsPerEpisode` in the file, defaults apply. */
  policy: SchedulingPolicy;
  /**
   * `policy.maxConcurrent`: streams the policy may have in flight per key
   * (`concurrencyKeyOf`), counting every run on that key (pinned ones
   * included). Absent key: unlimited. The knob for a subscription — or a
   * shared free pool's daily budget — that tolerates only so many concurrent
   * sessions.
   */
  maxConcurrent: Record<string, number>;
}

/**
 * The accounts each split-out class may use, for `planNextJobs`. `pool` is the
 * base class and is never in the map.
 *
 * Both split classes are unconditional. `paid` used to be split only when the
 * file said so — `accounts.paid` non-empty, or a `policy.paid` block present —
 * which left exactly one configuration where a paid pick took a free pool
 * account and spent real money on it: neither of those set. The file's own
 * `_notes` and ADR-0034's account-class amendment state the rule with no such
 * exception, so the code was conditional where the record was absolute. An
 * unconfigured paid class now HOLDS its picks and names them in --status,
 * exactly as `local` has since ADR-0034: the failure of an incomplete config is
 * a model that does not run, never an account that quietly bills.
 *
 * That leaves `policy.paid` with its one real job, the concurrency cap. It no
 * longer doubles as the switch deciding whether the class exists.
 */
export function classPoolsOf(config: Pick<FleetConfig, "accounts">): Partial<Record<AccountClass, string[]>> {
  return { paid: config.accounts.paid, local: config.accounts.local };
}

/** The accounts of one class, in file order. `pool` is the base class. */
export function classAccountsOf(config: Pick<FleetConfig, "accounts">, cls: AccountClass): string[] {
  // `?? []`: a hand-built config (a test, a state file read back) may predate a
  // class. An absent list is an empty one, never a crash in the scheduler.
  return (cls === "pool" ? config.accounts.pool : cls === "paid" ? config.accounts.paid : config.accounts.local) ?? [];
}

/** Every account the scheduler may hand out, whatever its class. */
export function scheduledAccounts(config: Pick<FleetConfig, "accounts">): string[] {
  return ACCOUNT_CLASSES.flatMap((c) => classAccountsOf(config, c));
}

/** The jobs pinned to an account, in file order. */
export function pinnedJobs(config: Pick<FleetConfig, "jobs">): FleetJob[] {
  return config.jobs.filter((j) => j.account !== undefined);
}

/**
 * The pinned campaigns' work, as jobs.
 *
 * A pinned campaign's account is by definition not one the policy may draw
 * from, so its work cannot go through `planNextJobs` — it goes through the same
 * path a pinned job does, which is also what keeps `nav-probe`'s behaviour
 * identical across its migration from a roster entry to a campaign.
 *
 * One job per campaign, not per work item: an account runs one live session, so
 * offering it the whole sweep at once would only queue behind itself. A
 * campaign with nothing left returns nothing, and the caller's usual
 * disabled-stand-in path drains whatever was on the account.
 */
export function pinnedCampaignJobs(
  config: Pick<FleetConfig, "campaigns" | "roster">,
  probeRuns: readonly ProbeRun[],
): FleetJob[] {
  const catalog = Object.keys(config.roster);
  const out: FleetJob[] = [];
  for (const c of config.campaigns) {
    if (c.account === undefined || !c.enabled) continue;
    const next = campaignWork([c], catalog, probeRuns)[0];
    if (next === undefined) continue;
    out.push({
      refs: [next.model],
      ref: next.model,
      episode: "probing",
      repeat: 1,
      name: `${c.name}-${next.cell.id}`,
      account: c.account,
      enabled: true,
      source: "pinned",
      probe: { campaign: c.name, cell: next.cell.id },
    });
  }
  return out;
}

/** The manual pool queue: jobs with no account, in file order. */
export function poolJobs(config: Pick<FleetConfig, "jobs">): FleetJob[] {
  return config.jobs.filter((j) => j.account === undefined);
}

/**
 * Roster names a pinned job references: never the policy's to schedule.
 * The predicate itself lives in `runner/src/models.ts`, beside the projection
 * it gates, so the viewer answers it the same way (FOLLOW-UPS 52).
 */
export function pinnedRefs(config: Pick<FleetConfig, "jobs">): Set<string> {
  return pinnedRefsOf(config.jobs);
}

/**
 * The campaigns the policy may schedule: enabled, and unpinned. A pinned
 * campaign is a pinned job in every way that matters here — its account is by
 * definition not one the policy draws from — so it is built into a pinned
 * job elsewhere and never reaches this list.
 */
export function unpinnedCampaigns(config: Pick<FleetConfig, "campaigns">): Campaign[] {
  return config.campaigns.filter((c) => c.enabled && c.account === undefined);
}

/**
 * Counted probe runs, in the shape `campaignWork` reads them: `ref` is the
 * roster name whose credentials the run used. Recovered by matching the
 * fact's model and effort against the roster the way `matchesRoster`
 * (models.ts, not exported) does — over every roster entry, catalog-only ones
 * included, since a campaign may name a model that carries no tier.
 */
export function probeRunsOf(runs: readonly RunFact[], roster: Record<string, FleetRosterEntry>): ProbeRun[] {
  const entries = Object.entries(roster);
  // Probe runs only. Every counted run would be correct — `campaignWork`
  // ignores a null campaign — but it would also walk the roster once per run in
  // the whole history on every tick, to learn nothing about the runs that are
  // not campaign work.
  return runs.filter((f) => f.campaign !== null && isCounted(f)).map((f) => {
    const match = entries.find(([, e]) => e.model === f.model && (e.effort ?? null) === (f.effort ?? null));
    return { campaign: f.campaign, cell: f.cell, ref: match?.[0] ?? null };
  });
}

/**
 * What an episode id means in the flags the runner has today (mirrors
 * runner/src/episodes.ts), passed alongside `--episode <id>` until the runner
 * owns the id. e90: 90m, idle 20m, no-xp 20m, 3000 calls. e360: 6h, idle 20m,
 * no-xp off — ceilings are a runaway guard at 1000 calls per 30 min (e90
 * 3000, e360 12000; docs/EPISODES.md). freeplay: no wall clock, unscored, ceiling left to the entry (the runner has no "unbounded").
 */
export function episodeDimensions(id: EpisodeId): Pick<RosterSpec, "episode" | "watchdogs" | "maxToolCalls"> {
  switch (id) {
    case "e90":
      return { episode: id, watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: 1_200_000 }, maxToolCalls: 3000 };
    case "e360":
      return { episode: id, watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: 12000 };
    case "probing":
      // The campaign's own clock wins over this; ninety minutes is what a
      // campaign that names none inherits (`EPISODES.probing`).
      return { episode: id, watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: undefined };
    case "freeplay":
      return { episode: id, watchdogs: { episodeMs: null, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: undefined };
  }
}

export const DEFAULT_PREFLIGHT: FleetPreflight = {
  enabled: false,
  account: "SMOKE",
  smokes: [],
  timeoutMs: 900_000,
  deploySmokes: [],
  deployTimeoutMs: 900_000,
};

const TICK_MS = 60_000;
/** A heartbeat older than this means the supervisor is gone, not merely quiet. */
const HEARTBEAT_STALE_MS = 3 * TICK_MS;
/** Set by the `fleet` compose service; see ADR-0020 and run-roster's inContainer(). */
const CONTAINER = process.env["WRATHBENCH_IN_CONTAINER"] === "1";
const REPO_ROOT = dirname(import.meta.dir);
const RUNS_DIR = join(REPO_ROOT, "data", "runs");
const ROSTER_SH = join(REPO_ROOT, "infra", "run-roster.sh");
const STATE_PATH = join(RUNS_DIR, "fleet-state.json");
/**
 * The deploy window's phase file (infra/deploy-worldserver.sh): what the
 * viewer's /api/fleet serves as `server`. The script holds an flock on the
 * `.lock` sibling for its lifetime; a phase found here with the lock FREE was
 * left by a deploy that did not finish, and this process is what clears it.
 */
const SERVER_STATE_PATH = join(RUNS_DIR, "server-state.json");
const SERVER_STATE_LOCK = join(RUNS_DIR, "server-state.lock");

// ------------------------------------------------------------------ parsing

function fail(msg: string): never {
  throw new Error(msg);
}

/** True for models that must ride the claude-code driver (the claude-code harness, ADR-0035). */
export function isClaudeFamily(model: string): boolean {
  return /(^|\/)(claude|opus|sonnet|haiku)/i.test(model);
}

/**
 * True when an openai entry points at a shared free-cloud pool — OpenRouter or
 * OpenCode Zen. Those pools are what the free-suffix rule polices: their free
 * tiers are metered per upstream provider, so only free model ids belong there.
 * An absent apiBase means the run-roster default (OpenRouter), so it counts as
 * a shared pool too. A local/self-hosted OpenAI-compatible endpoint (e.g. an
 * LM Studio box on the LAN) is NOT a shared pool: it has no free tier to abuse,
 * so it is exempt from the free-suffix rule — but still bound by every other
 * roster-policy check, the claude bar included.
 */
export function isSharedFreePool(apiBase: string | undefined): boolean {
  if (apiBase === undefined) return true;
  return /(^|\/\/|\.)(openrouter\.ai|opencode\.ai)(\/|:|$)/i.test(apiBase);
}

// `isAllowlistedFree` (suffixless ids verified free, e.g. `stealth/ox-alpha`)
// lives in runner/src/model-cost.ts, next to the billing verdict it feeds.

/**
 * Roster-policy and shape checks for roster entries. `where` names the
 * entry's home (`roster:<name>`) for the error message.
 */
export function validateEntries(where: string, entries: unknown): RosterSpec[] {
  if (!Array.isArray(entries)) fail(`${where}: entries must be a JSON array`);
  const out: RosterSpec[] = [];
  for (const e of entries as RosterSpec[]) {
    if (typeof e !== "object" || e === null || typeof e.model !== "string" || e.model.length === 0) {
      fail(`${where}: entry without a model: ${JSON.stringify(e)}`);
    }
    const driver: string = e.driver ?? "openai";
    if (driver !== "openai" && driver !== "claude-code") {
      fail(`${where}: entry ${e.model}: unknown driver ${String(e.driver)} (openai | claude-code)`);
    }
    if (driver === "openai" && isClaudeFamily(e.model)) {
      fail(
        `${where}: entry ${e.model}: roster policy — claude models run only via the ` +
          `claude-code driver, never through an openai-driver entry`,
      );
    }
    if (driver === "claude-code" && !isClaudeFamily(e.model)) {
      fail(
        `${where}: entry ${e.model}: roster policy — the claude-code driver ` +
          `carries claude models only`,
      );
    }
    // Shared free-cloud pools (OpenRouter, OpenCode Zen) carry free models
    // only; the suffix is how we keep an entry off a paid tier, and an explicit
    // `billing: "paid"` is how the operator opts one in on purpose. Local/self-hosted
    // openai entries have no such pool and are exempt — but still claude-barred
    // above.
    if (
      driver === "openai" &&
      isSharedFreePool(e.apiBase) &&
      !/(-free$|:free$)/.test(e.model) &&
      !isAllowlistedFree(e.model) &&
      e.billing !== "paid"
    ) {
      fail(
        `${where}: entry ${e.model}: roster policy — a shared free-cloud pool ` +
          `(OpenRouter/OpenCode) carries free models only (id must end -free or :free, ` +
          `or be a verified-free stealth id in FREE_SUFFIXLESS_ALLOWLIST) unless the entry ` +
          `declares "billing": "paid" — a deliberate paid model under policy.paid (ADR-0034); ` +
          `a local/self-hosted apiBase is exempt`,
      );
    }
    if (e.watchdogs !== undefined) {
      const parsed = watchdogOverrideSchema.safeParse(e.watchdogs);
      if (!parsed.success) {
        fail(`${where}: entry ${e.model}: watchdogs — ${parsed.error.message}`);
      }
    }
    if (e.objective !== undefined && (typeof e.objective !== "string" || e.objective.length === 0)) {
      fail(`${where}: entry ${e.model}: objective must be a non-empty string`);
    }
    if (e.wikiCoords !== undefined && typeof e.wikiCoords !== "boolean") {
      fail(`${where}: entry ${e.model}: wikiCoords must be a boolean`);
    }
    if (
      e.maxToolCalls !== undefined &&
      (typeof e.maxToolCalls !== "number" || !Number.isInteger(e.maxToolCalls) || e.maxToolCalls <= 0)
    ) {
      fail(`${where}: entry ${e.model}: maxToolCalls must be a positive integer`);
    }
    out.push(e);
  }
  if (out.length === 0) fail(`${where}: no entries`);
  return out;
}

/**
 * Parse the optional top-level `preflight` block. Absent means "disabled with
 * no smokes" — an older fleet.json keeps working unchanged.
 */
export function parsePreflight(raw: unknown): FleetPreflight {
  if (raw === undefined) return DEFAULT_PREFLIGHT;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("fleet config: preflight must be a JSON object");
  }
  const o = raw as Omit<Partial<FleetPreflight>, "smokes" | "deploySmokes"> & { smokes?: unknown; deploySmokes?: unknown };
  if (typeof o.enabled !== "boolean") fail("preflight: enabled must be true or false");
  if (typeof o.account !== "string" || o.account.length === 0) fail("preflight: account is required");
  const defaultAccount = o.account;
  const parseSmokes = (list: unknown, key: string): PreflightSmoke[] => {
    if (!Array.isArray(list)) fail(`preflight: ${key} must be an array of script paths`);
    return list.map((x: unknown) => {
      if (typeof x === "string" && x.length > 0) return { script: x, account: defaultAccount };
      if (typeof x === "object" && x !== null && !Array.isArray(x)) {
        const e = x as Partial<PreflightSmoke>;
        if (typeof e.script !== "string" || e.script.length === 0) fail(`preflight: ${key} entry needs a script path`);
        const account = e.account ?? defaultAccount;
        if (typeof account !== "string" || account.length === 0) fail(`preflight: ${key} ${e.script} needs an account`);
        return { script: e.script, account };
      }
      fail(`preflight: ${key} must be an array of script paths`);
    });
  };
  const parseBudget = (v: unknown, key: string, fallback: number): number => {
    const ms = v ?? fallback;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) fail(`preflight: ${key} must be a positive number of milliseconds`);
    return ms;
  };
  const smokes = parseSmokes(o.smokes, "smokes");
  const deploySmokes = o.deploySmokes === undefined ? [] : parseSmokes(o.deploySmokes, "deploySmokes");
  const timeoutMs = parseBudget(o.timeoutMs, "timeoutMs", DEFAULT_PREFLIGHT.timeoutMs);
  const deployTimeoutMs = parseBudget(o.deployTimeoutMs, "deployTimeoutMs", DEFAULT_PREFLIGHT.deployTimeoutMs);
  if (o.enabled && smokes.length === 0) fail("preflight: enabled with no smokes to run");
  return { enabled: o.enabled, account: o.account, smokes, timeoutMs, deploySmokes, deployTimeoutMs };
}

/** Parse + validate a fleet config. Throws with a config-error message. */
export function parseFleet(raw: unknown): FleetConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("fleet config must be a JSON object");
  }
  const o = raw as {
    _notes?: unknown;
    lanes?: unknown;
    preflight?: unknown;
    accounts?: unknown;
    roster?: unknown;
    queue?: unknown;
    policy?: unknown;
    campaigns?: unknown;
  };
  if (o.lanes !== undefined) {
    fail("fleet config: `lanes` is not a 0.4 key — a job goes in `queue` ({ ref, episode, repeat, account? }) over a `roster` map (ADR-0034)");
  }
  const notes = Array.isArray(o._notes) ? o._notes.filter((n): n is string => typeof n === "string") : [];
  const accounts = parseAccounts(o.accounts);
  const roster = parseRoster(o.roster);
  let campaigns: Campaign[];
  try {
    campaigns = parseCampaigns(o.campaigns);
  } catch (err) {
    fail(`campaigns: ${err instanceof Error ? err.message : String(err)}`);
  }
  const jobs: FleetJob[] = [];
  const names = new Set<string>();
  const add = (job: FleetJob): void => {
    if (names.has(job.name)) {
      fail(`queue: two jobs would share the name ${job.name} (${job.ref} ${job.episode}) — one job per (ref, episode)`);
    }
    names.add(job.name);
    jobs.push(job);
  };
  for (const job of parseQueue(o.queue, roster)) add(job);
  // One live session per account: two enabled jobs on one account means one
  // of them spends the whole window waiting behind the other.
  const byAccount = new Map<string, string>();
  for (const job of jobs) {
    if (job.account === undefined || !job.enabled) continue;
    const key = job.account.toUpperCase();
    const other = byAccount.get(key);
    if (other !== undefined) fail(`account ${job.account} is shared by enabled jobs ${other} and ${job.name} — one job per account`);
    byAccount.set(key, job.name);
  }
  for (const job of jobs) {
    if (job.account === undefined) continue;
    // Listing an account says who may SCHEDULE it; `enabled` says who HOLDS
    // it, and only an enabled job holds. So a disabled pinned job may park on
    // a listed account (the burn switch on the paid account); an enabled one
    // may not, or the pin and the scheduler would fight over the session.
    if (job.enabled && accounts.pool.some((a) => a.toUpperCase() === job.account!.toUpperCase())) {
      fail(`accounts.pool: ${job.account} is also pinned to job ${job.name} — only a disabled job may park on a listed account`);
    }
    for (const cls of ["paid", "local"] as const) {
      if (job.enabled && accounts[cls].some((a) => a.toUpperCase() === job.account!.toUpperCase())) {
        fail(`accounts.${cls}: ${job.account} is also pinned to job ${job.name} — only a disabled job may park on a listed account`);
      }
    }
    // Derived, enabled first so a disabled stand-in on a running job's
    // account (the burn switch) never hides the live one.
    const key = Object.keys(accounts.pinned).find((a) => a.toUpperCase() === job.account!.toUpperCase()) ?? job.account;
    if (accounts.pinned[key] === undefined || job.enabled) accounts.pinned[key] = job.name;
  }
  // A campaign with `account` set is pinned exactly like a pinned job (see
  // campaigns.ts): the same account-sharing and parking rules apply, with the
  // campaign's name standing in for the job's.
  for (const c of campaigns) {
    if (c.account === undefined || !c.enabled) continue;
    const key = c.account.toUpperCase();
    const other = byAccount.get(key);
    if (other !== undefined) fail(`account ${c.account} is shared by enabled jobs ${other} and campaign ${c.name} — one job per account`);
    byAccount.set(key, `campaign ${c.name}`);
  }
  for (const c of campaigns) {
    if (c.account === undefined) continue;
    // Listing an account says who may SCHEDULE it; `enabled` says who HOLDS
    // it, and only an enabled campaign holds. So a disabled pinned campaign
    // may park on a listed account; an enabled one may not, or the pin and
    // the scheduler would fight over the session.
    if (c.enabled && accounts.pool.some((a) => a.toUpperCase() === c.account!.toUpperCase())) {
      fail(`accounts.pool: ${c.account} is also pinned to campaign ${c.name} — only a disabled campaign may park on a listed account`);
    }
    for (const cls of ["paid", "local"] as const) {
      if (c.enabled && accounts[cls].some((a) => a.toUpperCase() === c.account!.toUpperCase())) {
        fail(`accounts.${cls}: ${c.account} is also pinned to campaign ${c.name} — only a disabled campaign may park on a listed account`);
      }
    }
    // Derived, enabled first so a disabled stand-in on a running campaign's
    // account never hides the live one.
    const key = Object.keys(accounts.pinned).find((a) => a.toUpperCase() === c.account!.toUpperCase()) ?? c.account;
    if (accounts.pinned[key] === undefined || c.enabled) accounts.pinned[key] = `campaign ${c.name}`;
  }
  const preflight = parsePreflight(o.preflight);
  // The smokes hold a live session for their whole arc. Sharing an account with
  // an enabled job (or the pool) would mean the gate and the job reclaiming
  // the account from each other all night, so it is a config error, not a race
  // to discover live.
  if (preflight.enabled) {
    for (const account of preflightAccounts(preflight)) {
      const clash = byAccount.get(account.toUpperCase());
      if (clash !== undefined) fail(`preflight account ${account} is also job ${clash}'s — the gate needs its own account`);
      if (accounts.pool.some((a) => a.toUpperCase() === account.toUpperCase())) {
        fail(`preflight account ${account} is also in accounts.pool — the gate needs its own account`);
      }
      for (const cls of ["paid", "local"] as const) {
        if (accounts[cls].some((a) => a.toUpperCase() === account.toUpperCase())) {
          fail(`preflight account ${account} is also in accounts.${cls} — the gate needs its own account`);
        }
      }
    }
  }
  if (jobs.some((j) => j.enabled && j.account === undefined) && accounts.pool.length === 0) {
    fail("queue has enabled pool jobs but accounts.pool is empty — nothing could ever run them");
  }
  const { policy, maxConcurrent } = parsePolicy(o.policy);
  return { notes, preflight, accounts, roster, jobs, campaigns, policy, maxConcurrent };
}

function parseAccounts(raw: unknown): FleetAccounts {
  if (raw === undefined) return { pinned: {}, pool: [], paid: [], local: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("fleet config: accounts must be a JSON object");
  const o = raw as { pinned?: unknown; pool?: unknown; paid?: unknown; local?: unknown };
  // `pinned` is derived from the jobs (`account` on a queue entry), never authored.
  if (o.pinned !== undefined) {
    fail("accounts.pinned is not a 0.4 key — pin the account on the job (`account` in its queue entry); the map is derived");
  }
  const pinned: Record<string, string> = {};
  const pool: string[] = [];
  if (o.pool !== undefined) {
    if (!Array.isArray(o.pool)) fail("accounts.pool must be an array of account names");
    for (const a of o.pool as unknown[]) {
      if (typeof a !== "string" || a.length === 0) fail("accounts.pool: entries are account names");
      if (pool.some((p) => p.toUpperCase() === a.toUpperCase())) fail(`accounts.pool: ${a} listed twice`);
      pool.push(a);
    }
  }
  // The split-out classes, parsed alike: an account belongs to exactly one.
  const classes: Record<"paid" | "local", string[]> = { paid: [], local: [] };
  for (const cls of ["paid", "local"] as const) {
    const list = o[cls];
    if (list === undefined) continue;
    if (!Array.isArray(list)) fail(`accounts.${cls} must be an array of account names`);
    for (const a of list as unknown[]) {
      if (typeof a !== "string" || a.length === 0) fail(`accounts.${cls}: entries are account names`);
      const seen = [...pool, ...classes.paid, ...classes.local];
      const dupe = seen.find((p) => p.toUpperCase() === a.toUpperCase());
      if (dupe !== undefined) {
        fail(
          classes[cls].some((p) => p.toUpperCase() === a.toUpperCase())
            ? `accounts.${cls}: ${a} listed twice`
            : `accounts.${cls}: ${a} is already in another class — an account belongs to exactly one`,
        );
      }
      classes[cls].push(a);
    }
  }
  return { pinned, pool, paid: classes.paid, local: classes.local };
}

function parseRoster(raw: unknown): Record<string, FleetRosterEntry> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("fleet config: roster must be an object of name -> entry");
  const out: Record<string, FleetRosterEntry> = {};
  for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
    if (name.length === 0 || !/^[A-Za-z0-9._-]+$/.test(name)) fail(`roster: entry name ${JSON.stringify(name)} must be [A-Za-z0-9._-]+`);
    if (typeof e !== "object" || e === null || Array.isArray(e)) fail(`roster ${name}: entry must be an object`);
    const { tier: rawTier, idle: rawIdle, tiers: rawTiers, runsPerEpisode: rawRuns, billing: rawBilling, ...rest } = e as {
      tier?: unknown;
      idle?: unknown;
      tiers?: unknown;
      runsPerEpisode?: unknown;
      billing?: unknown;
    } & Record<string, unknown>;
    if (rawBilling !== undefined && rawBilling !== "free" && rawBilling !== "paid") fail(`roster ${name}: billing must be "free" or "paid" (normally absent: it is derived)`);
    // The retired 0.4 spellings, refused by name. Both said how much a model
    // runs, which is its tier now; dropping them silently would re-scope a
    // budget an operator wrote on purpose.
    if (rawTiers !== undefined) fail(`roster ${name}: tiers is not a 0.5 key — force a longer episode by setting tier: "t2"`);
    if (rawRuns !== undefined) fail(`roster ${name}: runsPerEpisode is not a 0.5 key — run counts are the tier (${TIERS.join(", ")})`);
    if (rest["account"] !== undefined) fail(`roster ${name}: an entry must not pin an account — pin the job that references it`);
    // An entry carrying an objective is outside the policy entirely
    // The roster is a CATALOG (ADR-0041): an entry describes a model and says
    // how much evidence it gets, and nothing else. Steering belongs to a
    // campaign, which owns its whole task shape — an entry that could carry an
    // objective is what used to make the roster two kinds of thing, and every
    // scored surface then needed a branch to tell them apart.
    if (rest["objective"] !== undefined) {
      fail(`roster ${name}: an entry must not carry an objective — steering is a campaign now (ADR-0041), which names this entry under "models"`);
    }
    if (rest["wikiCoords"] !== undefined) {
      fail(`roster ${name}: an entry must not carry wikiCoords — coordinates are for a steered run, so they belong to the campaign that asks for them (ADR-0041)`);
    }
    // Required, with no exception left to make: every entry is now something
    // the policy can schedule, so an absent tier is always a mistake.
    if (rawTier === undefined) fail(`roster ${name}: every entry states its tier (${TIERS.join(", ")})`);
    let tier: Tier;
    let idle: IdleMode = "none";
    try {
      tier = parseTier(rawTier, `roster ${name}`);
      idle = parseIdle(rawIdle, `roster ${name}`);
    } catch (err) {
      fail((err as Error).message);
    }
    const [validated] = validateEntries(`roster:${name}`, [rawBilling === undefined ? rest : { ...rest, billing: rawBilling }]);
    out[name] = {
      ...validated!,
      tier,
      idle,
      ...(rawBilling !== undefined ? { billing: rawBilling as Billing } : {}),
    };
  }
  return out;
}

/**
 * The file's `policy` block: what is left in it is the per-key concurrency cap
 * and the paid throttle — where runs may execute and how many at once
 * (`parsePolicyBlock` in runner/src/models.ts is the one parser; the viewer
 * reads the same). The tier table, the idle character cycle, the defer ladder
 * and the promotion level are code. The series is this checkout's.
 */
function parsePolicy(raw: unknown): { policy: SchedulingPolicy; maxConcurrent: Record<string, number> } {
  const { maxConcurrent, ...policy } = parsePolicyBlock(raw, currentSeries());
  return { policy, maxConcurrent };
}

/**
 * The roster as the projection reads it: ordered, named, with its tier and
 * idle axis.
 *
 * Every entry projects. It used to drop the tierless ones, which were the
 * steered probes — and since ADR-0041 there are none: an entry cannot carry an
 * objective, so it cannot be outside the policy, so it always states a tier.
 */
export function rosterModels(roster: Record<string, FleetRosterEntry>): RosterModel[] {
  return Object.entries(roster).flatMap(([name, e]) =>
    e.tier === undefined
      ? []
      : [
          {
            name,
            model: e.model,
            ...(e.effort !== undefined ? { effort: e.effort } : {}),
            ...(e.driver !== undefined ? { driver: e.driver } : {}),
            ...(e.apiBase !== undefined ? { apiBase: e.apiBase } : {}),
            tier: e.tier,
            idle: e.idle,
            ...(e.billing !== undefined ? { billing: e.billing } : {}),
          },
        ],
  );
}

/** The roster names the policy may schedule (`policyRefsOf`, models.ts). */
export function policyRefs(config: Pick<FleetConfig, "jobs" | "roster">): Set<string> {
  return policyRefsOf(config.jobs, config.roster);
}

/** Why a roster name is outside the policy, or undefined when it is inside. */
export function policyExclusion(config: Pick<FleetConfig, "jobs" | "roster">, name: string): string | undefined {
  return policyExclusionOf(config.jobs, config.roster, name);
}

/** The driver a roster name runs on. */
export function driverOf(roster: Record<string, FleetRosterEntry>, name: string): string {
  return roster[name]?.driver ?? "openai";
}

/**
 * The concurrency key a roster name counts against for `policy.maxConcurrent`
 * (`concurrencyKeyOf`, models.ts): the free shared pools are capped per
 * platform, everything else per driver. `billing` is the derived verdict the
 * caller already holds (the projection's `state.billing`); a name the roster
 * does not carry falls back to its driver key, so a stranger can never eat a
 * free key.
 */
export function concurrencyKeyOfRef(roster: Record<string, FleetRosterEntry>, name: string, billing: Billing | undefined): string {
  const e = roster[name];
  if (e === undefined || billing === undefined) return driverOf(roster, name);
  return concurrencyKeyOf({ name, ...(e.driver !== undefined ? { driver: e.driver } : {}), ...(e.apiBase !== undefined ? { apiBase: e.apiBase } : {}) }, billing);
}

/** An eligibility predicate over the projection, for planQueue / runnableRefs. */
export type Eligible = (ref: string, episode: EpisodeId) => boolean;

export function eligibleFrom(states: readonly ModelState[]): Eligible {
  const by = new Map(states.map((s) => [s.name, s]));
  // Asked of scored-ness, not of a name: `eligible` is the tier's own budget, so
  // an episode no tier can buy is not something a model is admitted TO. It was
  // the freeplay name check here, which is the same landmine 8cfabb1 closed in
  // `targetFor` and `runnableRefs` — dead for probing only because every caller
  // happens to short-circuit first, which is not a property worth relying on.
  return (ref, ep) => !isScoredEpisode(ep) || (by.get(ref)?.eligible.includes(ep) ?? false);
}

function parseQueue(raw: unknown, roster: Record<string, FleetRosterEntry>): FleetJob[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("fleet config: queue must be an array of jobs");
  const out: FleetJob[] = [];
  for (const j of raw as Partial<FleetJob>[]) {
    if (typeof j !== "object" || j === null) fail("queue: job is not an object");
    const rawRef = (j as { ref?: unknown }).ref;
    const refs = typeof rawRef === "string" ? [rawRef] : Array.isArray(rawRef) ? (rawRef as unknown[]) : undefined;
    if (refs === undefined || refs.length === 0 || !refs.every((r) => typeof r === "string" && r.length > 0)) {
      fail(`queue: job without a ref (a roster name or a list of them): ${JSON.stringify(j)}`);
    }
    for (const r of refs as string[]) if (roster[r] === undefined) fail(`queue: job ref ${r} is not in roster`);
    if (new Set(refs).size !== refs.length) fail(`queue: job lists a ref twice: ${refs.join(",")}`);
    const ref = (refs as string[]).join("+");
    if (typeof j.episode !== "string" || !(EPISODE_IDS as readonly string[]).includes(j.episode)) {
      fail(`queue ${ref}: episode must be one of ${EPISODE_IDS.join("|")}`);
    }
    const repeat = j.repeat ?? 1;
    if (repeat !== "loop" && (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat <= 0)) {
      fail(`queue ${ref}: repeat must be a positive integer or "loop"`);
    }
    const name = `${(refs as string[])[0]}-${j.episode}`;
    const enabled = j.enabled ?? true;
    if (typeof enabled !== "boolean") fail(`queue ${ref}: enabled must be true or false`);
    let account: string | undefined;
    if (j.account !== undefined) {
      if (typeof j.account !== "string" || j.account.length === 0) fail(`queue ${ref}: account must be a non-empty account name`);
      account = j.account;
    }
    out.push({
      refs: refs as string[],
      ref,
      episode: j.episode as EpisodeId,
      repeat,
      name,
      enabled,
      ...(account !== undefined ? { account } : {}),
      source: account !== undefined ? "pinned" : "queue",
    });
  }
  return out;
}

// ------------------------------------------------------------- scheduling

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
 * tier, not a second stream on a model already running, and not cooling on
 * the defer ladder takes the next free pool account. Free means: in `pool`,
 * not assigned to a running job, and not held live by anything (the roster's
 * own account-busy inference, injected as `held`). A job carrying an account
 * is pinned and is not this scheduler's: it is skipped here.
 *
 * `freeplay` bypasses the tiers gate: it is unscored (ADR-0033), so there is no
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
   * history has earned (ADR-0034).
   */
  eligible?: Eligible;
  /** Roster names with a stream in flight outside `queue` (policy and pinned jobs). */
  runningRefs?: ReadonlySet<string>;
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
      plan.skipped.push({ job, reason: `${clash} is already running under another job — one stream per model` });
      continue;
    }
    const cool = opts.cooling(job);
    if (cool !== undefined) {
      plan.skipped.push({ job, reason: cool });
      continue;
    }
    const account = free.shift();
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
 * The policy's fill for whatever the queue left free (ADR-0034). Pure: the
 * projection is handed in. Only runs when no manual job is waiting — a manual
 * entry always outranks the policy — and never puts a second stream on a
 * model. `concurrency` is the per-key cap (`concurrencyKeyOf`): `running`
 * counts every stream in flight on that key, pinned jobs included, so a
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
  concurrency?: { keyOf: (name: string) => string; max: Record<string, number>; running: ReadonlyMap<string, number> };
  policy?: SchedulingPolicy;
  /** Paid policy models already in flight (pinned jobs excluded). */
  paidRunning?: number;
  /** The enabled, unpinned campaigns the policy may schedule (ADR-0041). */
  campaigns?: readonly Campaign[];
  /** Counted probe runs on disk: what a campaign's remaining work is derived from. */
  probeRuns?: readonly ProbeRun[];
}): PolicyPick[] {
  return planPolicyHeld(opts).picks;
}

/** `planPolicy` plus what it held back and why. */
export function planPolicyHeld(opts: Parameters<typeof planPolicy>[0]): { picks: PolicyPick[]; held: HeldPick[] } {
  // A waiting manual job reserves the POOL, and nothing else. Such a job has no
  // account, and a job with no account can only ever take a pool one (ADR-0034:
  // the class split governs the policy; a manual queue job draws from the
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
  const wrap = (pick: NextJob): PolicyPick => ({ job: policyJob(pick), account: pick.account, why: pick.why });
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
  if (opts.concurrency === undefined) {
    const plan = next(opts.states, free, []);
    return { picks: plan.jobs.map(wrap), held: plan.held };
  }
  // The cap, over the projection's own priority order: a pick whose key is
  // full is passed over and the next candidate is asked for its account, until
  // a round yields nothing to pass over.
  const { keyOf, max } = opts.concurrency;
  const count = new Map(opts.concurrency.running);
  for (const a of opts.queuePlan.assign) for (const r of a.job.refs) count.set(keyOf(r), (count.get(keyOf(r)) ?? 0) + 1);
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
      const d = keyOf(pick.name);
      const cap = max[d];
      if (cap !== undefined && (count.get(d) ?? 0) >= cap) {
        passed.add(pick.name);
        held.push({ name: pick.name, episode: pick.episode, why: `cap: ${d} <= ${cap}, ${count.get(d) ?? 0} in flight` });
        rejected = true;
        continue;
      }
      count.set(d, (count.get(d) ?? 0) + 1);
      out.push(pick);
    }
    if (!rejected) break;
    states = states.filter((s) => !passed.has(s.name));
    accounts = free.filter((a) => !out.some((p) => p.account === a));
  }
  // Accounts in preference order over the final picks, as an uncapped round
  // would give — each class over its own list, so a paid pick keeps a paid
  // account, a local one keeps the box, and the pool rows stay free-only.
  const at: Partial<Record<AccountClass, number>> = {};
  const take = (cls: AccountClass): string => {
    const i = at[cls] ?? 0;
    at[cls] = i + 1;
    return (cls === "pool" ? free[i] : splitFree[cls]![i])!;
  };
  return { picks: out.map((pick) => wrap({ ...pick, account: take(listClass(pick.name)) })), held };
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
   * A probe's task shape comes from its campaign and nothing else (ADR-0041).
   * The catalog entry supplies credentials and a model, so its own `objective`,
   * `watchdogs`, `maxToolCalls` and `wikiCoords` are dropped rather than merged:
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
    const { objective: _obj, watchdogs: _wd, maxToolCalls: _mtc, wikiCoords: _wc, ...credentials } = entry;
    const isProbe = probeDims !== undefined;
    const spec: RosterSpec = isProbe ? credentials : entry;
    // The entry's own leash, kept only when the entry is the authority on it.
    const own = isProbe ? {} : { watchdogs: entry.watchdogs, maxToolCalls: entry.maxToolCalls };
    // An `idle: "unlimited"` session is the one freeplay run the policy makes,
    // and it carries a wall clock the tier does not pin: a class governs the
    // next pick and never a run in flight, so a session ended only by the idle
    // watchdog would hold its account for as long as the model kept playing.
    // The entry's own watchdogs still win — this is a default, not a ceiling.
    const unlimited = isExtraJob(job) && job.episode === "freeplay" ? { episodeMs: UNLIMITED_SESSION_MS } : {};
    const base: RosterSpec = {
      ...spec,
      ...dims,
      watchdogs: { ...dims.watchdogs, ...unlimited, ...(own.watchdogs ?? {}), ...(probeWatchdogs ?? {}) },
      ...(own.maxToolCalls !== undefined ? { maxToolCalls: own.maxToolCalls } : {}),
      ...(probeDims ?? {}),
      ...(job.probe !== undefined ? { campaign: job.probe.campaign, cell: job.probe.cell } : {}),
      // An extra run is stamped as one; a scored-tier extra also rolls the
      // policy's character, where a freeplay extra keeps the entry's own.
      ...(isExtraJob(job) ? { extra: true } : {}),
      ...(job.extra !== undefined ? { race: job.extra.race, class: job.extra.class } : {}),
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
 * The spawn, made to resume one paused run first (ADR-0036): the entry for
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
// ADR-0036: a fleet stop pauses every live run (the runner pauses on SIGTERM,
// clock stopped, session released) and a fleet start resumes them before the
// queue or the policy launches anything fresh. The same planner runs every
// tick, so a run its provider paused (rate-limited, quota-exhausted) is also
// picked back up once its cooling is over — that is FOLLOW-UPS 43.

export interface ResumePlan {
  job: FleetJob;
  account: string;
  runId: string;
  /** How many times the run has paused; with the run id, names this resume attempt. */
  pauseCount: number;
  why: string;
}

/**
 * A paused run the supervisor ENDS instead of resuming: the roster entry its
 * job ref names is a different model now (the operator re-pointed the ref),
 * so the run has no job to come back under. Ended as `manual` with the detail
 * below, through the runner's own termination writer, never resumed.
 */
export interface EndedRun {
  runId: string;
  model: string;
  ref: string;
  detail: string;
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
  config: Pick<FleetConfig, "jobs" | "roster" | "policy" | "accounts">;
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
  const paused = opts.runs.filter((f) => f.pause !== null && inSeries(f, config.policy)).sort((a, b) => b.pause!.at - a.pause!.at);
  const seenModel = new Set<string>();
  for (const f of paused) {
    const pause = f.pause!;
    const list = (why: string, resumeAfter: number | null = null): void => {
      listed.push({ runId: f.runId, model: f.model, account: f.account, reason: pause.reason, since: pause.at, pauseCount: pause.count, resumeAfter, elapsedMs: pause.episodeElapsedMs, budgetMs: f.episodeMs, why });
    };
    const modelKey = `${f.model}@${f.effort ?? ""}`;
    const launchedUnder = refOfRunId(f.runId, f.episode, Object.keys(config.roster));
    const current = launchedUnder === undefined ? undefined : config.roster[launchedUnder];
    if (launchedUnder !== undefined && current !== undefined && (current.model !== f.model || (current.effort ?? null) !== (f.effort ?? null))) {
      end.push({ runId: f.runId, model: f.model, ref: launchedUnder, detail: `ended by the supervisor: model ${f.model} no longer under ref ${launchedUnder}` });
      continue;
    }
    if (isStalePause(f, now)) {
      list(`stale: paused ${fmtElapsed(now - pause.at)} ago, past twice its ${f.episodeMs !== null ? fmtElapsed(f.episodeMs) : "6h"} budget — resume by hand (--resume ${f.runId}) or archive`);
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
    const fromFile = config.jobs.find((j) => j.refs.some((r) => refs.includes(r)) && j.episode === f.episode);
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
      const ref = refs.find((r) => policyNames.has(r));
      if (ref === undefined || (f.episode !== "e90" && f.episode !== "e360")) {
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
 * End the runs `planResumes` said to end, through the runner's own writer
 * (`Trajectory.setTermination`: the trajectory record, the run row, the
 * pause cleared) — the same path `classify.ts` takes, so nothing else writes
 * a termination into run.sqlite. Returns what it ended; a run directory that
 * will not open is reported, not fatal.
 */
export function endRuns(runsDir: string, ended: readonly EndedRun[]): { runId: string; error?: string }[] {
  return ended.map((e) => {
    try {
      const t = new Trajectory(join(runsDir, e.runId));
      try {
        t.setTermination(e.runId, "manual", e.detail);
      } finally {
        t.close();
      }
      return { runId: e.runId };
    } catch (err) {
      return { runId: e.runId, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** One line per run the supervisor would end rather than resume, for --status and --dry-run. */
export function formatEnded(ended: readonly EndedRun[], fleetUp: boolean): string[] {
  if (ended.length === 0) return [];
  return [
    `paused runs the supervisor ${fleetUp ? "ends on its next tick" : "will end when it starts"} (${ended.length}):`,
    ...ended.map((e) => `  ${e.runId} — ${e.detail}`),
  ];
}

/** One line per paused run the supervisor is not resuming, for --status and --dry-run. */
export function formatPaused(listed: readonly PausedListing[]): string[] {
  if (listed.length === 0) return [];
  return [
    `paused runs not resumed (${listed.length}):`,
    ...listed.map((l) => `  ${l.runId} — ${l.model}${l.account !== null ? ` on ${l.account}` : ""}: ${l.reason}, ${fmtPaused(l.elapsedMs, l.budgetMs)} — ${l.why}`),
  ];
}

/**
 * Re-read the config during supervision. A broken edit must never take down
 * running jobs, so any error keeps the last good config and is reported.
 */
export function rereadFleet(
  path: string,
  lastGood: FleetConfig,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { config: FleetConfig; error?: string } {
  try {
    return { config: parseFleet(JSON.parse(read(path))) };
  } catch (e) {
    return { config: lastGood, error: e instanceof Error ? e.message : String(e) };
  }
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

/**
 * The first thing `--status` prints while the file is rejected. The failure it
 * covers is silent by construction — the operator's edit parses for THEM and is
 * ignored by the supervisor — so the banner says both halves: rejected since
 * when, and that the file's enabled flags are not what is running.
 */
export function formatConfigBanner(rej: ConfigRejection | undefined, loadedAt: number | undefined): string[] {
  if (rej === undefined) return [];
  return [
    `!! fleet.json REJECTED since ${new Date(rej.since).toLocaleString()}: ${rej.error}` +
      ` — running on config loaded at ${loadedAt === undefined ? "an unrecorded time" : new Date(loadedAt).toLocaleString()};` +
      ` job enabled flags in the file are NOT in effect`,
    `   fix the file (or roll it back) — the supervisor retries every ${TICK_MS / 1000}s and clears this by itself`,
  ];
}

/**
 * Load a config for a read-only reader (`--status`), which must survive a file
 * the supervisor already rejected instead of dying on it.
 */
export function loadConfigForRead(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { config?: FleetConfig; error?: string } {
  try {
    return { config: parseFleet(JSON.parse(read(path))) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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

/** Per-job files, all hanging off the job name and the supervisor's stamp. */
export function jobRosterPath(job: string, stamp: string): string {
  return join(RUNS_DIR, `fleet-${job}-${stamp}.roster.json`);
}
export function jobJsonlPath(job: string, stamp: string): string {
  return join(RUNS_DIR, `fleet-${job}-${stamp}.jsonl`);
}
export function jobLogPath(job: string, stamp: string): string {
  return join(RUNS_DIR, `fleet-${job}-${stamp}.log`);
}

/**
 * The exact run-roster argv for one spawn. Pure; tested. `until` is the CLI's
 * optional cap; under the fleet service there is none — the supervisor is up
 * while the machine is up and jobs are steered by editing fleet.json.
 */
export function jobArgv(
  spawn: JobSpawn,
  opts: { stamp: string; until: string | undefined; resumeRoster?: boolean },
): string[] {
  const argv = [
    ROSTER_SH,
    jobRosterPath(spawn.name, opts.stamp),
    "--log",
    jobJsonlPath(spawn.name, opts.stamp),
    "--date",
    opts.stamp,
  ];
  if (spawn.loop) argv.push("--loop");
  if (opts.until !== undefined) argv.push("--until", opts.until);
  // A resume spawn always reattaches: the roster must find the paused run's
  // row and --resume it rather than launch the id fresh.
  if (opts.resumeRoster === true || spawn.resumeRunId !== undefined) argv.push("--resume-roster");
  return argv;
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

/** Where the module answers. Same default the runner and roster use. */
const MODULE_URL = process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086";
/** The worldserver's log directory as seen from this side of the mounts. */
const SERVER_LOG_DIR = join(REPO_ROOT, "data", "logs");
/** Coarse bucket for an unreadable boot marker: re-gate every 10 minutes, loudly. */
const UNKNOWN_MARKER_BUCKET_MS = 10 * 60_000;

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

/** Read the boot marker off the shared logs volume. */
function readBootMarker(dir: string = SERVER_LOG_DIR): string {
  let birth: number | undefined;
  let backups: string[] | undefined;
  try {
    birth = statSync(join(dir, "Server.log")).birthtimeMs;
  } catch {
    birth = undefined;
  }
  try {
    backups = readdirSync(dir);
  } catch {
    backups = undefined;
  }
  return bootMarker(birth, backups, Date.now());
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
 * The server as the supervisor currently sees it: `undefined` when the module
 * does not answer or the world is stopping, which is "not ready" — neither
 * smoke it nor spawn against it.
 */
async function readServerIdentity(): Promise<ServerIdentity | undefined> {
  let body: unknown;
  try {
    const res = await fetch(`${MODULE_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    body = await res.json();
  } catch {
    return undefined;
  }
  const o = body as { ok?: unknown; worldStopped?: unknown };
  if (o.ok !== true || o.worldStopped === true) return undefined;
  return serverIdentity(body, () => readBootMarker());
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

/** Resolve a configured smoke path against the repo. */
export function smokePath(script: string, root: string = REPO_ROOT): string {
  return isAbsolute(script) ? script : join(root, script);
}

/**
 * One smoke as a child of this supervisor, with the account env it reads
 * (`MODULE_ACCOUNT`), killed at `deadline`. A timed-out child is SIGKILLed and
 * recorded as a failure. A killed smoke can leak its module session; the
 * module reclaims a permitted account's stale session on the next create
 * (commit 9bba93b), so the next attempt is not stuck behind it.
 */
export type SmokeRunner = (smoke: PreflightSmoke, deadline: number) => Promise<PreflightRecord["results"][number]>;

async function spawnSmoke(smoke: PreflightSmoke, deadline: number): Promise<PreflightRecord["results"][number]> {
  const { script, account } = smoke;
  const path = smokePath(script);
  if (!existsSync(path)) return { script, ok: false, ms: 0, tail: `no such smoke script: ${path}` };
  const left = deadline - Date.now();
  if (left <= 0) return { script, ok: false, ms: 0, tail: "preflight budget exhausted before this script ran" };
  say(`preflight: ${script} (account ${account})`);
  const t0 = Date.now();
  const proc = Bun.spawn(["bun", path], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MODULE_ACCOUNT: account },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, left);
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  const ms = Date.now() - t0;
  return {
    script,
    ok: code === 0 && !timedOut,
    ms,
    tail: timedOut ? `TIMEOUT after ${ms}ms: ${tailOf(out + "\n" + err)}` : tailOf(out + "\n" + err),
  };
}

/**
 * Run the configured smokes: one sequential chain per account, all chains
 * concurrently, every child against the same shared deadline. Within a chain
 * a failure stops the rest of that chain (they would be logging into the same
 * account the failed one may have left mid-arc); other chains run to their own
 * end so the record names every script that failed, not just the first.
 * Results are reported in config order. Pure apart from the injected runner.
 */
export async function runPreflight(
  pf: FleetPreflight,
  server: ServerIdentity,
  run: SmokeRunner = spawnSmoke,
  clock: () => number = Date.now,
): Promise<PreflightRecord> {
  const deadline = clock() + pf.timeoutMs;
  const chains = new Map<string, PreflightSmoke[]>();
  for (const s of pf.smokes) {
    const key = s.account.toUpperCase();
    chains.set(key, [...(chains.get(key) ?? []), s]);
  }
  const results = new Map<PreflightSmoke, PreflightRecord["results"][number]>();
  await Promise.all(
    [...chains.values()].map(async (chain) => {
      for (const smoke of chain) {
        const r = await run(smoke, deadline);
        results.set(smoke, r);
        if (!r.ok) break;
      }
    }),
  );
  const ordered = pf.smokes.map(
    (s) => results.get(s) ?? { script: s.script, ok: false, ms: 0, tail: `not run: an earlier smoke on account ${s.account} failed` },
  );
  return {
    at: clock(),
    serverIdentity: server.identity,
    ...(server.build !== undefined ? { build: server.build } : {}),
    ok: ordered.every((r) => r.ok),
    results: ordered,
  };
}

/** --status / --dry-run rendering of a gate record. Pure. */
export function formatGate(rec: PreflightRecord | undefined, pf: FleetPreflight): string[] {
  const accounts = preflightAccounts(pf);
  const head =
    `preflight ${pf.enabled ? "enabled" : "disabled"} (${pf.smokes.length} smoke(s) on ${accounts.join(",")}, ` +
    `budget ${Math.round(pf.timeoutMs / 1000)}s; ${pf.deploySmokes.length} deploy-only smoke(s), budget ${Math.round(pf.deployTimeoutMs / 1000)}s)`;
  if (rec === undefined) return [head, "  no gate result recorded yet"];
  const when = new Date(rec.at).toLocaleString();
  const verdict = rec.skipped === true ? "SKIPPED (gate open)" : rec.ok ? "PASS" : "FAIL — jobs blocked";
  const out = [head, `  last gate ${verdict} at ${when}, identity ${rec.serverIdentity}`];
  if (rec.build !== undefined) out.push(`  server build ${rec.build}`);
  for (const r of rec.results) {
    out.push(`    ${r.ok ? "ok  " : "FAIL"} ${r.script} (${Math.round(r.ms / 1000)}s)${r.tail === "" ? "" : ` — ${r.tail}`}`);
  }
  return out;
}

/** One running job as --status / --dry-run renders it. */
export interface JobRow {
  name: string;
  /** Model ids the job's roster carries (one, or a rotation). */
  models: string[];
  /** `null` when the supervisor could not name it; printed as "episode unknown". */
  episode: EpisodeId | null;
  runId?: string;
  level?: number;
  xp?: number;
  /** Since the run started (or the process was spawned). */
  elapsedMs?: number;
  /** The job's defer sidecar says it is cooling (or tainted) — between episodes. */
  cooling?: string;
  /** Dry-run only: this job would spawn, nothing is running yet. */
  planned?: boolean;
  /** The policy's attempt number, for a policy job. */
  attempt?: number;
  /** A scored-tier extra run (ADR-0034), with the character it rolls; a freeplay extra rolls none. */
  extra?: StartingCharacter;
  /**
   * The job is running on an account of another class (it was scheduled before
   * the classes were, or the file moved the account). Noted, never acted on: a
   * class governs the next pick, not a run already in flight.
   */
  offClass?: string;
  /**
   * Another job's process is live on this account too. One session per account
   * is the invariant the whole scheduler rests on, so this is a real fault,
   * not a rendering choice: say both names rather than pick one quietly.
   */
  clash?: string;
}

/** What an account is doing right now, for the accounts table. */
export type AccountRow =
  | { account: string; kind: AccountKind; job: JobRow }
  | { account: string; kind: AccountKind; free: true; note?: string };

/** Which class an account row belongs to: pinned to a job, or one of the scheduled classes. */
export type AccountKind = "pinned" | AccountClass;

const fmtElapsed = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/**
 * --status / --dry-run: one row per account — pinned first, then the pool in
 * preference order, then the paid class — with the job on it (model, episode,
 * run id, level/xp, elapsed) or free/cooling. Pure over rows the caller
 * assembled; a paid row has the same shape as a pool one.
 */
export function formatAccounts(rows: readonly AccountRow[]): string[] {
  const n = (k: AccountKind): number => rows.filter((r) => r.kind === k).length;
  const extra = ACCOUNT_CLASSES.filter((c) => c !== "pool" && n(c) > 0).map((c) => `, ${n(c)} ${c}`).join("");
  const out: string[] = [`accounts: ${n("pinned")} pinned, ${n("pool")} pool${extra}`];
  const w = Math.max(9, ...rows.map((r) => r.account.length));
  for (const r of rows) {
    const head = `  ${r.account.padEnd(w)} ${r.kind.padEnd(6)} `;
    if ("free" in r) {
      out.push(`${head}free${r.note !== undefined ? ` — ${r.note}` : ""}`);
      continue;
    }
    const j = r.job;
    const what =
      `${j.name}: ${j.models.join("+")} ${j.episode ?? "episode unknown"}${j.attempt !== undefined && j.attempt > 1 ? ` attempt ${j.attempt}` : ""}` +
      `${isExtraJob(j) ? (j.extra !== undefined ? ` extra (race ${j.extra.race} class ${j.extra.class})` : " extra") : ""}`;
    if (j.planned === true) {
      out.push(`${head}${what} — would spawn${j.runId !== undefined ? ` as ${j.runId}` : ""}`);
      continue;
    }
    const prog = j.level !== undefined ? `L${j.level} ${j.xp ?? 0}xp` : "no state rows yet";
    const run = j.runId !== undefined ? `${j.runId} — ${prog}` : "no run launched yet";
    out.push(
      `${head}${what} — ${run}${j.elapsedMs !== undefined ? `, ${fmtElapsed(j.elapsedMs)}` : ""}${j.cooling !== undefined ? ` — ${j.cooling}` : ""}` +
        `${j.offClass !== undefined ? ` [${j.offClass}]` : ""}${j.clash !== undefined ? ` !! ${j.clash}` : ""}`,
    );
  }
  return out;
}

/**
 * --status / --dry-run rendering of the projection as a table: one row per
 * roster model — status, counted/target per episode, best level, why it is or
 * is not schedulable. `excluded` names roster entries outside the policy
 * (pinned, or a probe) and why. Pure.
 */
export function formatModels(
  states: readonly ModelState[],
  running: ReadonlySet<string>,
  now = Date.now(),
  excluded: ReadonlyMap<string, string> = new Map(),
  policy: SchedulingPolicy = { ...DEFAULT_POLICY_FOR_FORMAT },
): string[] {
  const w = Math.max(12, ...states.map((s) => s.name.length));
  const series = policy.series ?? "any";
  const out: string[] = [
    `models: ${states.length} in roster (policy: ADR-0040; series ${series}${policy.series === null ? " — unversioned checkout, every series counts" : ""}; ladder ${LADDER_MS.length} rungs to ${Math.round(LADDER_MS[LADDER_MS.length - 1]! / 3_600_000)}h` +
      `${policy.paid !== null ? `; at most ${policy.paid.maxConcurrent} paid in flight` : "; no paid/free split"}` +
      `; tiers ${TIERS.map((t) => `${t} ${TIER_TABLE[t].runsPerEpisode.e90}/${TIER_TABLE[t].runsPerEpisode.e360}`).join(", ")}` +
      `; idle unlimited ${Math.round(UNLIMITED_SESSION_MS / 3_600_000)}h)`,
    `  ${"model".padEnd(w)} ${"billing".padEnd(7)} ${"tier".padEnd(9)} ${"status".padEnd(8)} ${"e90".padEnd(12)} ${"e360".padEnd(12)} ${"extras".padEnd(6)} schedulable`,
  ];
  const ago = (ms: number | null): string => (ms === null ? "never" : `${Math.round((now - ms) / 60_000)}m ago`);
  /**
   * The tier column. A climb is shown as the move it was (`t1>t2`); a held
   * witness is shown as a held witness (`t0*`), because a trial model that has
   * earned rung 1 is exactly the row an operator is looking for when deciding
   * what to promote — and the old table could only say `promoted, 0/0`.
   */
  const tierCell = (s: ModelState): string =>
    s.tier !== s.declaredTier ? `${s.declaredTier}>${s.tier}` : s.earnedRung1 ? `${s.tier}*` : s.tier;
  const cell = (s: ModelState, ep: "e90" | "e360"): string => {
    const st = s.perEpisode[ep]!;
    if (!s.eligible.includes(ep)) return "-";
    return `${st.counted}/${st.target}${st.stillborn > 0 ? `+${st.stillborn}sb` : ""}${st.bestLevel !== null ? ` L${st.bestLevel}` : ""}`;
  };
  for (const s of states) {
    const ex = excluded.get(s.name);
    // Freeplay is in the walk: a local model past its targets has nothing but
    // freeplay extras, and "last ... never" would be wrong about it.
    const last = STATS_EPISODES.map((ep) => s.perEpisode[ep]).filter((st) => st !== undefined && st.lastEnded !== null).sort((a, b) => b!.lastEnded! - a!.lastEnded!)[0];
    // Three words, not two. "no" used to mean both "cannot run" and "has
    // nothing owed but would take a spare account", and telling those apart is
    // the whole reason the verdict stopped being a pair of booleans: `free` is
    // where probe campaigns and idle work draw from.
    const verdictWord = { eval: "yes", free: "free", blocked: "no" } as const;
    const sched = ex !== undefined ? `no: ${ex}` : ((v) => `${verdictWord[v.verdict]}: ${v.why}`)(schedulability(s, running, policy));
    const extras = extrasSoFar(s);
    const other = (["e90", "e360"] as const).reduce((n, ep) => n + (s.perEpisode[ep]?.otherSeries ?? 0), 0);
    out.push(
      `  ${s.name.padEnd(w)} ${s.billing.padEnd(7)} ${tierCell(s).padEnd(9)} ${(ex !== undefined ? "pinned" : s.status).padEnd(8)} ${cell(s, "e90").padEnd(12)} ${cell(s, "e360").padEnd(12)} ${String(extras).padEnd(6)} ${sched}` +
        (last !== undefined && ex === undefined ? ` — last ${last.lastReason ?? "unterminated"} ${ago(last.lastEnded)}` : "") +
        (s.ladder > 0 ? ` — ladder ${s.ladder}` : "") +
        (other > 0 ? ` — ${other} run(s) from other series not counted` : ""),
    );
  }
  // A steered entry carries no tier and so has no row: it is not evidence, and
  // the table is the evidence table. It is still named here, because vanishing
  // from `--status` entirely is how an operator loses track of a probe that is
  // very much running (the accounts block above shows it on its account).
  const rowed = new Set(states.map((s) => s.name));
  const offBook = [...excluded].filter(([name]) => !rowed.has(name));
  for (const [name, why] of offBook) out.push(`  ${name.padEnd(w)} ${"—".padEnd(7)} ${"steered".padEnd(9)} ${"—".padEnd(8)} ${"—".padEnd(12)} ${"—".padEnd(12)} ${"—".padEnd(6)} no: ${why}`);
  return out;
}

/** `--dry-run`: the picks the policy held back and why. Pure. */
export function formatHeld(held: readonly HeldPick[]): string[] {
  return held.map((h) => `  ${h.name}: HELD — ${h.episode} wanted, ${h.why}`);
}

/**
 * One line per split-out class when there is something to say: a class with
 * work to schedule and no account to run it on is a config gap the operator has
 * to close, so --status names it rather than leaving the picks silently held.
 */
export function formatAccountClasses(config: Pick<FleetConfig, "accounts" | "policy" | "roster">): string[] {
  return [...formatPaidClass(config), ...formatLocalClass(config)];
}

/**
 * The paid class line — the same shape as the local one, now that the split is
 * unconditional. It says what the roster wants, what the file provides, and the
 * cap when there is one, and stays quiet only when there is neither a paid
 * account nor a paid model to put on one.
 */
export function formatPaidClass(config: Pick<FleetConfig, "accounts" | "policy" | "roster">): string[] {
  const models = rosterModels(config.roster).filter((r) => rosterClass(r) === "paid");
  if (config.accounts.paid.length === 0) {
    if (models.length === 0) return [];
    return [
      `paid class: NO PAID ACCOUNT CONFIGURED — ${models.map((m) => m.name).join(", ")} held, never spilled into the pool; add one to accounts.paid`,
    ];
  }
  const cap = config.policy.paid === null ? "no policy.paid block, so no cap" : `at most ${config.policy.paid.maxConcurrent} in flight`;
  return [
    `paid class: ${config.accounts.paid.join(", ")} — paid models only (${models.length === 0 ? "none in the roster" : models.map((m) => m.name).join(", ")}); ${cap}; the pool stays free-only`,
  ];
}

/**
 * The local class line. Unlike paid there is no `policy.local` to key on, so it
 * speaks when there are local accounts or a local model in the roster, and stays
 * quiet on a file that has neither.
 */
export function formatLocalClass(config: Pick<FleetConfig, "accounts" | "roster">): string[] {
  const models = rosterModels(config.roster).filter((r) => rosterClass(r) === "local");
  if (config.accounts.local.length === 0) {
    if (models.length === 0) return [];
    return [
      `local class: NO LOCAL ACCOUNT CONFIGURED — ${models.map((m) => m.name).join(", ")} held, never spilled into the pool; add one to accounts.local`,
    ];
  }
  return [
    `local class: ${config.accounts.local.join(", ")} — local models only (${models.length === 0 ? "none in the roster" : models.map((m) => m.name).join(", ")}); the pool stays off the box`,
  ];
}

/** --status / --dry-run: the manual queue, only when there is one. Pure. */
export function formatQueue(queue: readonly FleetJob[], state: FleetState["queue"] | undefined): string[] {
  if (queue.length === 0) return [];
  const enabled = queue.filter((j) => j.enabled);
  const out = [`queue: ${enabled.length} enabled manual job(s) of ${queue.length}` + (state === undefined ? " (supervisor has not reported on it)" : "")];
  for (const job of queue) {
    const status =
      !job.enabled
        ? "disabled"
        : state === undefined
          ? "?"
          : state.running.includes(job.name)
            ? "RUNNING"
            : state.finished.includes(job.name)
              ? "finished"
              : state.skipped.find((sk) => sk.name === job.name) !== undefined
                ? `skipped: ${state.skipped.find((sk) => sk.name === job.name)!.reason}`
                : state.waiting.includes(job.name)
                  ? "waiting for a free pool account"
                  : "pending";
    out.push(`  ${job.name.padEnd(28)} ${job.ref} ${job.episode} x${job.repeat} — ${status}`);
  }
  return out;
}

// ------------------------------------------------------------------ output

let fleetLog = "";

function stamp2(n: number): string {
  return String(n).padStart(2, "0");
}
function now(): string {
  const d = new Date();
  return `${stamp2(d.getHours())}:${stamp2(d.getMinutes())}:${stamp2(d.getSeconds())}`;
}
function say(line: string): void {
  console.log(`[${now()}] fleet: ${line}`);
}
function record(entry: { job: string; event: string; detail?: string }): void {
  if (fleetLog === "") return;
  mkdirSync(dirname(fleetLog), { recursive: true });
  appendFileSync(fleetLog, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

function dateStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${stamp2(d.getMonth() + 1)}${stamp2(d.getDate())}`;
}

// ------------------------------------------------------------------ process

interface JobProc {
  spawn: JobSpawn;
  /**
   * The job this process was spawned for, kept for as long as the process row
   * exists. `liveJobs` drops a job the moment it exits, and the state row was
   * reading from there — so every exited row lost its episode, ref, source and
   * attempt to the fallbacks and came out as a pinned freeplay job.
   */
  job?: FleetJob;
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
  spawnedAt: number;
  exited: boolean;
  exitCode: number | null;
}

/** Does this pid have a live child (an episode in flight)? /proc scan. */
function hasLiveChild(pid: number): boolean {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, "utf8");
      // field 4 (after the parenthesised comm, which can contain spaces)
      const after = stat.slice(stat.lastIndexOf(")") + 2);
      const ppid = Number(after.split(" ")[1]);
      if (ppid === pid) return true;
    } catch {
      // process vanished mid-scan
    }
  }
  return false;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface FleetState {
  fleetPid: number;
  startedAt: number;
  /** Refreshed every tick. The only honest liveness signal across a namespace. */
  heartbeatAt?: number;
  /** True when the supervisor is the `fleet` compose service, not a host process. */
  containerized?: boolean;
  /**
   * Set while a preflight sequence is running against `identity`. The gate
   * record itself is only written when the sequence ends, so this is how an
   * outside observer tells "smoking now, wait for the verdict" from "not
   * gating at all" without racing a second smoke onto the same account. (The
   * deploy script no longer reads it — it stops the fleet for the window — but
   * --status does.)
   */
  preflightInFlight?: { identity: string; since: number };
  stamp: string;
  fleetConfig: string;
  /** When the config the supervisor is actually running was last parsed. */
  configLoadedAt?: number;
  /**
   * Present while the file on disk cannot be loaded. The supervisor keeps its
   * last good config, which means every `enabled` flag in the file is inert —
   * so `--status` must say so loudly. Cleared by a successful re-read.
   */
  configRejected?: ConfigRejection;
  /** The last deploy-window gate result; absent for a pre-gate supervisor. */
  preflight?: PreflightRecord;
  /** Who holds which account: pinned -> job name; pool -> job name or null when free. */
  accounts?: {
    pinned: Record<string, string>;
    pool: Record<string, string | null>;
    paid?: Record<string, string | null>;
    local?: Record<string, string | null>;
  };
  /** The manual queue's shape, present only when the file has one. */
  queue?: {
    depth: number;
    running: string[];
    waiting: string[];
    finished: string[];
    skipped: { name: string; reason: string }[];
  };
  /**
   * Every job with a process: the one unit of work (ADR-0034) — what it is
   * (ref, tier, account, source) and the process that runs it (pid, files,
   * exit). Written fresh every tick; the supervisor rewrites the whole file
   * on boot, so nothing reads an older shape.
   */
  jobs: Record<string, StateJob>;
  /** Why the last tick spawned nothing from the policy, when it did not. */
  policy?: { idle?: string };
  /** Counters since the supervisor started. */
  session?: { finished: number; ok: number; retried: number };
  /** Paused runs the supervisor is not resuming right now, with why (ADR-0036). */
  paused?: PausedListing[];
  /** Paused runs the supervisor ended instead of resuming, this session (ADR-0036 amendment). */
  ended?: EndedRun[];
}

/** One job in the state file: the job and its process. */
export interface StateJob {
  ref: string;
  /** `null` only when the supervisor genuinely does not know it — never guessed. */
  episode: EpisodeId | null;
  account: string;
  source: JobSource;
  attempt?: number;
  extra?: StartingCharacter;
  /** The paused run this spawn is resuming (ADR-0036). */
  resuming?: string;
  models: string[];
  pid: number;
  /** Repo-relative (ADR-0020): the reader may be on the other side of the mount. */
  rosterPath: string;
  jsonl: string;
  log: string;
  spawnedAt: number;
  exitCode: number | null;
  draining: boolean;
  /** The supervisor's own view of the process; see resolveStatePath. */
  alive: boolean;
}

/**
 * Resolve a path recorded in fleet-state.json against THIS side of the mount.
 *
 * The supervisor writes repo-relative paths so `--status` works from the host
 * while the state was written in the container (where REPO_ROOT is
 * /wrathbench). A host-side supervisor writes the same relative form; an
 * absolute path is honoured when it exists, otherwise the path is recomputed
 * locally from the job name and stamp. Pure, so the mapping is testable
 * without a live fleet.
 */
export function resolveStatePath(
  stored: string | undefined,
  fallback: string,
  exists: (p: string) => boolean = existsSync,
  root: string = REPO_ROOT,
): string {
  if (stored !== undefined && stored.length > 0) {
    const p = isAbsolute(stored) ? stored : join(root, stored);
    if (exists(p)) return p;
  }
  return fallback;
}

const START_AT = Date.now();

let preflightInFlight: { identity: string; since: number } | undefined;
/** Set while the file on disk will not load; every writeState carries it. */
let configRejected: ConfigRejection | undefined;
/** When the config actually in force was parsed. Set on load and on re-read. */
let configLoadedAt: number | undefined;

/** Live job bookkeeping, published into the state file every tick. */
interface PoolView {
  pinned: Record<string, string>;
  pool: string[];
  /** `accounts.paid` / `accounts.local`: the split-out classes, reported so --status can render them with the fleet up. */
  paid: string[];
  local: string[];
  /** job name -> the account it is running on (pinned or pool) */
  assigned: Map<string, string>;
  /** job name -> the job, for every job with a live process */
  jobs: Map<string, FleetJob>;
  queue: FleetJob[];
  finished: Set<string>;
  waiting: string[];
  skipped: { name: string; reason: string }[];
  policyIdle?: string;
  session: { finished: number; ok: number; retried: number };
  /** Paused runs the last plan did not resume, with why (ADR-0036). */
  paused: PausedListing[];
  /** Paused runs ended instead of resumed, this session. */
  ended: EndedRun[];
}

/**
 * What a state row says about the job behind a process. Pure, and the only
 * place the fallbacks live: a row whose job is unknown says so — `episode` is
 * `null` rather than a guessed "freeplay", and the rest degrade to the name.
 */
export function stateJobFacts(
  name: string,
  job: FleetJob | undefined,
): { ref: string; episode: EpisodeId | null; source: JobSource; attempt?: number; extra?: StartingCharacter } {
  if (job === undefined) return { ref: name, episode: null, source: "pinned" };
  return {
    ref: job.ref,
    episode: job.episode,
    source: job.source,
    ...(job.attempt !== undefined ? { attempt: job.attempt } : {}),
    ...(job.extra !== undefined ? { extra: job.extra } : {}),
  };
}

function writeState(
  configPath: string,
  stampToday: string,
  procs: Map<string, JobProc>,
  draining: Set<string>,
  preflight?: PreflightRecord,
  pool?: PoolView,
): void {
  const jobs: Record<string, StateJob> = {};
  for (const [name, p] of procs) {
    // The process's own copy first: it outlives the job's removal from
    // `liveJobs` at exit, so an exited row keeps its real episode.
    const j = p.job ?? pool?.jobs.get(name);
    jobs[name] = {
      ...stateJobFacts(name, j),
      account: p.spawn.account,
      ...(p.spawn.resumeRunId !== undefined ? { resuming: p.spawn.resumeRunId } : {}),
      models: p.spawn.entries.map((e) => e.model),
      pid: p.pid,
      rosterPath: relative(REPO_ROOT, jobRosterPath(name, stampToday)),
      jsonl: relative(REPO_ROOT, jobJsonlPath(name, stampToday)),
      log: relative(REPO_ROOT, jobLogPath(name, stampToday)),
      spawnedAt: p.spawnedAt,
      exitCode: p.exitCode,
      draining: draining.has(name),
      alive: !p.exited,
    };
  }
  const state: FleetState = {
    fleetPid: process.pid,
    startedAt: START_AT,
    heartbeatAt: Date.now(),
    containerized: CONTAINER,
    stamp: stampToday,
    fleetConfig: configPath,
    ...(configLoadedAt !== undefined ? { configLoadedAt } : {}),
    ...(configRejected !== undefined ? { configRejected } : {}),
    ...(preflight !== undefined ? { preflight } : {}),
    ...(preflightInFlight !== undefined ? { preflightInFlight } : {}),
    ...(pool !== undefined
      ? {
          accounts: {
            pinned: pool.pinned,
            pool: Object.fromEntries(pool.pool.map((a) => [a, [...pool.assigned].find(([, acct]) => acct === a)?.[0] ?? null])),
            paid: Object.fromEntries(pool.paid.map((a) => [a, [...pool.assigned].find(([, acct]) => acct === a)?.[0] ?? null])),
            local: Object.fromEntries(pool.local.map((a) => [a, [...pool.assigned].find(([, acct]) => acct === a)?.[0] ?? null])),
          },
          ...(pool.queue.length > 0
            ? {
                queue: {
                  depth: pool.queue.filter((j) => j.enabled).length,
                  running: pool.queue.filter((j) => pool.assigned.has(j.name)).map((j) => j.name),
                  waiting: pool.waiting,
                  finished: pool.queue.filter((j) => pool.finished.has(j.name)).map((j) => j.name),
                  skipped: pool.skipped,
                },
              }
            : {}),
          policy: { ...(pool.policyIdle !== undefined ? { idle: pool.policyIdle } : {}) },
          session: pool.session,
          paused: pool.paused,
          ended: pool.ended,
        }
      : {}),
    jobs,
  };
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ------------------------------------------------------------ server state

/** The phases the deploy script writes while it holds the lock; `running` is the rest state. */
export type ServerPhase = "running" | "draining" | "swapping" | "verifying" | "resuming" | "rolled-back" | "failed";
/** Phases that mean a deploy is in progress RIGHT NOW — meaningless once nothing holds the lock. */
const WINDOW_PHASES: ReadonlySet<string> = new Set(["draining", "swapping", "verifying", "resuming"]);

interface ServerState {
  phase: ServerPhase;
  since: number;
  build: string;
  prevBuild?: string;
  detail: string;
  pid?: number;
  updatedAt: number;
}

/** True when no deploy holds the lock (flock -n succeeds). Unknown is "held": never clear what might be live. */
function deployLockFree(): boolean {
  try {
    return Bun.spawnSync(["flock", "-n", SERVER_STATE_LOCK, "true"]).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Write `running` over a phase the deploy script left behind. On boot any
 * phase goes (a `rolled-back` or `failed` notice has been on the page until
 * now; the restart is the operator's acknowledgement); on a tick only a WINDOW
 * phase goes, because those claim a deploy is in progress and, with the lock
 * free, none is — while a terminal verdict stays up until the next boot.
 */
function reclaimServerState(where: "boot" | "tick"): void {
  if (!existsSync(SERVER_STATE_PATH)) return;
  let prev: ServerState;
  try {
    prev = JSON.parse(readFileSync(SERVER_STATE_PATH, "utf8")) as ServerState;
  } catch {
    return;
  }
  if (prev.phase === "running") return;
  if (where === "tick" && !WINDOW_PHASES.has(prev.phase)) return;
  if (!deployLockFree()) return;
  const next: ServerState = {
    phase: "running",
    since: Date.now(),
    build: prev.build ?? "",
    ...(prev.prevBuild !== undefined ? { prevBuild: prev.prevBuild } : {}),
    detail:
      `supervisor ${where === "boot" ? "started" : "ticked"} with the phase "${prev.phase}" on file and no deploy holding the lock` +
      (WINDOW_PHASES.has(prev.phase) ? " (that deploy did not finish)" : "") +
      ` — was: ${prev.detail}`,
    updatedAt: Date.now(),
  };
  writeFileSync(SERVER_STATE_PATH, JSON.stringify(next, null, 2) + "\n");
  say(`server-state: phase ${prev.phase} -> running (${next.detail})`);
}

// ------------------------------------------------------------------ status

function lastLaunchedRunId(stdoutLog: string): string | undefined {
  if (!existsSync(stdoutLog)) return undefined;
  let found: string | undefined;
  for (const line of readFileSync(stdoutLog, "utf8").split("\n")) {
    const m = /\] launch \S+ as (\S+)/.exec(line);
    if (m !== null) found = m[1];
  }
  return found;
}

function lastLine(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1];
}

function runProgress(runId: string): { level: number; xp: number; startedAt?: number } | undefined {
  const path = join(RUNS_DIR, runId, "run.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .query("SELECT level, xp FROM state WHERE run_id = ? ORDER BY ts DESC LIMIT 1")
        .get(runId) as { level: number | null; xp: number | null } | null;
      if (row === null || row.level === null) return undefined;
      let startedAt: number | undefined;
      try {
        const r = db.query("SELECT started_at FROM run WHERE run_id = ?").get(runId) as { started_at: number | null } | null;
        if (r !== null && typeof r.started_at === "number") startedAt = r.started_at;
      } catch {
        // older store
      }
      return { level: row.level, xp: row.xp ?? 0, ...(startedAt !== undefined ? { startedAt } : {}) };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** run-roster processes on the host that this fleet did not spawn. */
function foreignRosters(managedPids: Set<number>): { pid: number; argv: string }[] {
  const out: { pid: number; argv: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (managedPids.has(pid)) continue;
    try {
      const cmd = readFileSync(`/proc/${e}/cmdline`, "utf8").split("\0").join(" ").trim();
      if (cmd.includes("run-roster.ts")) out.push({ pid, argv: cmd });
    } catch {
      // vanished
    }
  }
  return out;
}

/**
 * Backed-off / tainted specs for one job, straight off the roster's defer
 * sidecar. Read-only and tolerant: a job mid-write (or no sidecar at all)
 * must degrade to "no rows", never break the status report for other jobs.
 */
function jobDefers(jsonl: string): { spec: string; entry: DeferEntry }[] {
  const path = deferSidecarPath(jsonl);
  if (!existsSync(path)) return [];
  try {
    return [...parseDefers(readFileSync(path, "utf8"))].map(([specRunId, entry]) => ({
      spec: specRunId,
      entry,
    }));
  } catch {
    return [];
  }
}

/**
 * Live episodes across every job account, for an operator (or a script) that
 * wants to know whether the world is busy: the roster's own account-busy
 * inference over the trajectory stores, which is what the scheduler leases by.
 *
 * This is a DIFFERENT source than the --status accounts table, which reports
 * the supervisor's own `jobs` record — and saying the two were "the same
 * signal" is how a stale row there went unnoticed (FOLLOW-UPS 68). They should
 * now agree on every fleet-managed account; where they cannot, this one is the
 * truth about the world and that one is the truth about the supervisor.
 *
 * Exit code carries the answer so bash never parses this text. The deploy
 * script does not use it any more: it stops the fleet for its window, and a
 * live episode pauses as `operator-pause` and resumes on the far side.
 */
function printLiveRuns(configPath: string): number {
  const config = parseFleet(JSON.parse(readFileSync(configPath, "utf8")));
  // Job accounts plus the gate's own and the ad-hoc debugging account: the
  // refusal claims "no episodes are live", and a PROBE session dies in a
  // recreate exactly like a job's does.
  const accounts = [
    ...new Set([...Object.keys(config.accounts.pinned), ...scheduledAccounts(config), ...preflightAccounts(config.preflight), "PROBE"]),
  ];
  let live = 0;
  for (const account of accounts) {
    const holder = accountHeldBy(account, "");
    if (holder === undefined) continue;
    live++;
    console.log(`live: account ${account} held by run ${holder}`);
  }
  console.log(`${live} live run(s)`);
  return live;
}

/** The jobs with a process, as the state file tells them. A state without a `jobs` map is not this supervisor's. */
export function liveJobsFromState(state: Pick<FleetState, "jobs"> | undefined): Map<string, StateJob> {
  const out = new Map<string, StateJob>();
  if (state === undefined || typeof state.jobs !== "object" || state.jobs === null) return out;
  for (const [name, j] of Object.entries(state.jobs)) out.set(name, j);
  return out;
}

/**
 * Which job is on each account, out of every job the supervisor has spawned.
 *
 * `state.jobs` is keyed by job NAME — stable across attempts — so it is a
 * cumulative record, not a live set: over a long night a dozen entries name
 * the same pool account and all but one of them exited hours ago. Keying a map
 * by account and letting the last write win therefore reads the object's
 * insertion order, which is FIRST-spawn order, and a job that finished at noon
 * can mask the run holding the account now. That is what made the accounts
 * table disagree with --live-runs (FOLLOW-UPS 68).
 *
 * So rank rather than overwrite: a live job beats a dead one, and among live
 * ones the most recently spawned wins. `alive` is passed in so the selection
 * and the row's own liveness note are the same verdict — with the supervisor
 * down, `j.alive` is stale on every job and only the caller knows that.
 *
 * Two live jobs on one account is a double-lease. It is reported, never
 * resolved silently: the scheduler leases by `accountHeldBy`, so this table is
 * the only place such a fault would ever surface.
 */
export function jobsByAccount(
  live: ReadonlyMap<string, StateJob>,
  alive: (j: StateJob) => boolean,
): Map<string, { name: string; j: StateJob; clash?: string }> {
  const groups = new Map<string, { name: string; j: StateJob }[]>();
  for (const [name, j] of live) {
    const key = j.account.toUpperCase();
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [{ name, j }]);
    else g.push({ name, j });
  }
  const out = new Map<string, { name: string; j: StateJob; clash?: string }>();
  for (const [key, g] of groups) {
    const ranked = [...g].sort((a, b) => {
      const la = alive(a.j) ? 1 : 0;
      const lb = alive(b.j) ? 1 : 0;
      // A state file from another supervisor build carries no spawnedAt; it
      // sorts last rather than throwing the comparison.
      if (la !== lb) return lb - la;
      return (typeof b.j.spawnedAt === "number" ? b.j.spawnedAt : 0) - (typeof a.j.spawnedAt === "number" ? a.j.spawnedAt : 0);
    });
    const pick = ranked[0]!;
    const alsoLive = ranked.slice(1).filter((o) => alive(o.j));
    out.set(
      key,
      alive(pick.j) && alsoLive.length > 0
        ? { ...pick, clash: `also live here: ${alsoLive.map((o) => o.name).join(", ")} — one session per account` }
        : pick,
    );
  }
  return out;
}

function printStatus(configPath: string): void {
  // State first, and the banner before anything else: the file may not parse
  // here either, and even when it does, this reader can be a different code
  // version than the supervisor (that is how the shape-change incident hid).
  // The verdict that matters is the supervisor's, carried in the state file.
  let state: FleetState | undefined;
  if (existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as FleetState;
    } catch {
      state = undefined;
    }
  }
  const rejected = state?.configRejected;
  for (const line of formatConfigBanner(rejected, state?.configLoadedAt)) console.log(line);
  const { config, error: configError } = loadConfigForRead(configPath);
  if (config === undefined) {
    console.log(
      `!! ${configPath} does not load: ${configError}` +
        " — rows below are what the supervisor last ran, not the file's",
    );
  }
  // Liveness, honestly, from either side of a container boundary: a heartbeat
  // refreshed every tick. kill(pid, 0) is meaningless when the supervisor lives
  // in another PID namespace — it either says "no such process" for a healthy
  // fleet or, worse, hits an unrelated host process with the same number. It is
  // still the right check for a state file written by a host supervisor, which
  // has no heartbeat field at all.
  const hb = state?.heartbeatAt;
  const hbAgeMs = hb === undefined ? undefined : Date.now() - hb;
  const fleetUp =
    state === undefined ? false : hbAgeMs !== undefined ? hbAgeMs < HEARTBEAT_STALE_MS : pidAlive(state.fleetPid);
  const where = state?.containerized === true ? "compose service `fleet`" : "host process";
  console.log(
    `fleet ${configPath}` +
      (state === undefined
        ? " — no fleet-state.json: the fleet has never run here"
        : ` — supervisor pid ${state.fleetPid} (${where}) ${fleetUp ? "ALIVE" : "NOT RUNNING"}` +
          (hbAgeMs !== undefined
            ? `, heartbeat ${Math.round(hbAgeMs / 1000)}s ago`
            : ", no heartbeat in state (pre-ADR-0020 supervisor)") +
          `, up since ${new Date(state.startedAt).toLocaleString()}, stamp ${state.stamp}`),
  );
  if (state?.containerized === true) {
    console.log("  logs: docker compose -f infra/compose.yml logs -f fleet");
  }
  if (config !== undefined) for (const line of formatGate(state?.preflight, config.preflight)) console.log(`  ${line}`);

  // (b) accounts: pinned first, then the pool, each with the job on it.
  const live = liveJobsFromState(state);
  // Paused runs (ADR-0036): what the supervisor would resume now, and what it
  // lists instead — computed from disk so it is right with the fleet down.
  const runFacts = readRunFacts(RUNS_DIR);
  const pausedRuns = runFacts.filter((f) => f.pause !== null && !isStalePause(f, Date.now())).sort((a, b) => b.pause!.at - a.pause!.at);
  const resumePlan =
    config !== undefined
      ? planResumes({
          runs: runFacts,
          config,
          running: new Map([...live].filter(([, j]) => fleetUp).map(([name, j]) => [name, j.account])),
          held: (a) => accountHeldBy(a, ""),
          now: Date.now(),
        })
      : { resume: [], listed: [], end: [] };
  /**
   * The one liveness verdict for this printing. A heartbeat is the only honest
   * signal across a container boundary; without one (a host supervisor) the pid
   * is. Shared with `jobsByAccount` so the job a row picks and the note that
   * row prints can never contradict each other.
   */
  const isAlive = (j: StateJob): boolean =>
    typeof j.pid !== "number" ? false : hbAgeMs !== undefined ? fleetUp && j.alive : pidAlive(j.pid);
  const jobRow = (name: string, j: StateJob): JobRow => {
    const row: JobRow = {
      name,
      models: j.models.length > 0 ? j.models : [j.ref],
      episode: j.episode ?? null,
      ...(j.attempt !== undefined ? { attempt: j.attempt } : {}),
      ...(j.extra !== undefined ? { extra: j.extra } : {}),
    };
    // A job record without its process half was written by another build of
    // the supervisor: say so rather than render NaN. The restart rewrites it.
    if (typeof j.pid !== "number" || typeof j.spawnedAt !== "number") {
      row.cooling = "state file from another supervisor build — restart the fleet service";
      return row;
    }
    const alive = isAlive(j);
    const stdoutLog = resolveStatePath(j.log, jobLogPath(name, state!.stamp));
    const jsonl = resolveStatePath(j.jsonl, jobJsonlPath(name, state!.stamp));
    const runId = lastLaunchedRunId(stdoutLog);
    if (runId !== undefined) {
      row.runId = runId;
      const prog = runProgress(runId);
      if (prog !== undefined) {
        row.level = prog.level;
        row.xp = prog.xp;
        row.elapsedMs = Date.now() - (prog.startedAt ?? j.spawnedAt);
      } else {
        row.elapsedMs = Date.now() - j.spawnedAt;
      }
    }
    const defers = jobDefers(jsonl);
    const tainted = defers.find((d) => d.entry.tainted === true);
    const cooling = defers.find((d) => d.entry.tainted !== true && d.entry.notBefore > Date.now());
    if (tainted !== undefined) row.cooling = `tainted: ${tainted.spec} (${tainted.entry.defers} defers, ${tainted.entry.reason})`;
    else if (cooling !== undefined) row.cooling = `cooling until ${new Date(cooling.entry.notBefore).toLocaleTimeString()} (${cooling.entry.reason})`;
    if (!alive) row.cooling = `${row.cooling !== undefined ? `${row.cooling}; ` : ""}process ${j.exitCode !== null ? `exited ${j.exitCode}` : "dead"}`;
    return row;
  };
  const byAccount = jobsByAccount(live, isAlive);
  // With the config in hand the classes come from the file; without it (an
  // older or foreign checkout) from whatever the state file published.
  const classAccounts = (cls: AccountClass): string[] =>
    config !== undefined ? classAccountsOf(config, cls) : Object.keys(state?.accounts?.[cls] ?? {});
  // A disabled pinned job may park on a listed account (the coexistence rule),
  // so an account can be both pinned and listed: it belongs to the class that
  // schedules it, and its row carries the parked job as the note.
  const listed = new Set(ACCOUNT_CLASSES.flatMap(classAccounts).map((a) => a.toUpperCase()));
  const pinnedAccounts = (config !== undefined ? Object.keys(config.accounts.pinned) : Object.keys(state?.accounts?.pinned ?? {})).filter(
    (a) => !listed.has(a.toUpperCase()),
  );
  /** The class an account belongs to, for the off-class note on a running job. */
  const classOfAccount = (account: string): AccountKind =>
    ACCOUNT_CLASSES.find((c) => classAccounts(c).some((a) => a.toUpperCase() === account.toUpperCase())) ?? "pinned";
  const rows: AccountRow[] = [];
  for (const [kind, accounts] of [["pinned", pinnedAccounts], ...ACCOUNT_CLASSES.map((c) => [c, classAccounts(c)] as const)] as const) {
    for (const account of accounts) {
      const on = byAccount.get(account.toUpperCase());
      if (on !== undefined) {
        // A class governs the next pick, never a run in flight: a job that
        // landed before the classes did keeps its account and says so.
        const entry = config?.roster[on.j.ref];
        // A steered entry carries no tier and so projects to no model: it is a
        // probe on a pinned account, and it has no class to be off.
        const projected = entry === undefined ? [] : rosterModels({ [on.j.ref]: entry });
        const want = projected[0] === undefined ? undefined : rosterClass(projected[0]);
        const row = jobRow(on.name, on.j);
        if (on.clash !== undefined) row.clash = on.clash;
        if (want !== undefined && on.j.source === "policy" && want !== classOfAccount(account)) {
          row.offClass = `${want} model on a ${classOfAccount(account)} account — left alone; the class applies to the next pick`;
        }
        rows.push({ account, kind, job: row });
        continue;
      }
      // Honesty about the account itself: a hand-started run holds it just as
      // hard as a fleet one would. Same liveness inference as the roster guard.
      const holder = accountHeldBy(account, "");
      const pausedHere = pausedRuns.find((f) => f.account?.toUpperCase() === account.toUpperCase());
      let note: string | undefined;
      if (holder !== undefined) {
        const prog = runProgress(holder);
        note = `held by run ${holder}${prog !== undefined ? ` (L${prog.level}, ${prog.xp} xp)` : ""} — not fleet-managed`;
      } else if (pausedHere !== undefined) {
        const p = pausedHere.pause!;
        const prog = runProgress(pausedHere.runId);
        note =
          `paused (${p.reason}, ${fmtPaused(p.episodeElapsedMs, pausedHere.episodeMs)}) — ${pausedHere.runId}` +
          `${prog !== undefined ? ` L${prog.level} ${prog.xp}xp` : ""}` +
          `${resumePlan.resume.some((r) => r.runId === pausedHere.runId) ? ", resumes on the next tick" : fleetUp ? "" : ", resumes when the fleet starts"}`;
      } else if (kind !== "pool" && config !== undefined) {
        const job = pinnedJobs(config).find((j) => j.account?.toUpperCase() === account.toUpperCase() && j.enabled) ?? pinnedJobs(config).find((j) => j.account?.toUpperCase() === account.toUpperCase());
        if (job !== undefined) {
          note = job.enabled
            ? `job ${job.name} enabled${rejected !== undefined ? " (FILE, NOT in effect)" : ""}, not spawned${fleetUp ? "" : " (supervisor down)"}`
            : `job ${job.name} disabled${rejected !== undefined ? " (FILE, NOT in effect)" : ""}`;
        }
      }
      rows.push({ account, kind, free: true, ...(note !== undefined ? { note } : {}) });
    }
  }
  for (const line of formatAccounts(rows)) console.log(`  ${line}`);
  if (config !== undefined) for (const line of formatAccountClasses(config)) console.log(`  ${line}`);

  // (c) models: the projection, every roster entry, with why (not) schedulable.
  if (config !== undefined && Object.keys(config.roster).length > 0) {
    const running = new Set<string>();
    for (const j of live.values()) for (const r of j.ref.split("+")) running.add(r);
    const states = modelStates({ runsDir: RUNS_DIR, roster: rosterModels(config.roster), policy: config.policy });
    const excluded = new Map<string, string>();
    for (const name of Object.keys(config.roster)) {
      const why = policyExclusion(config, name);
      if (why !== undefined) excluded.set(name, why);
    }
    for (const line of formatModels(states, running, Date.now(), excluded, config.policy)) console.log(`  ${line}`);
    if (Object.keys(config.maxConcurrent).length > 0) {
      console.log(`  concurrency: ${Object.entries(config.maxConcurrent).map(([d, n]) => `${d} <= ${n}`).join(", ")} (every run on the key counts)`);
    }
    if (state?.policy?.idle !== undefined) console.log(`  policy: ${state.policy.idle}`);
    /*
     * How much of the schedule is left, bounded by whether anything else
     * promotes (`outstandingWork` carries the formula). Computed from the
     * file's accounts rather than the state file's, so the line is the same
     * with the supervisor down as up.
     */
    console.log(
      `  ${formatOutstanding(
        outstandingWork({
          states,
          policy: config.policy,
          excluded: excluded.keys(),
          accounts: Object.fromEntries(ACCOUNT_CLASSES.map((c) => [c, classAccountsOf(config, c).length])),
          maxConcurrent: config.maxConcurrent,
        }),
      )}`,
    );
  }

  // (d) paused runs the supervisor is not resuming, and why; and the ones it ends.
  for (const line of formatPaused(resumePlan.listed)) console.log(`  ${line}`);
  for (const line of formatEnded(resumePlan.end, fleetUp)) console.log(`  ${line}`);
  if (state?.ended !== undefined && state.ended.length > 0) {
    console.log(`  ended this session (${state.ended.length}): ${state.ended.map((e) => `${e.runId} (${e.detail})`).join("; ")}`);
  }
  if (!fleetUp && resumePlan.resume.length > 0) {
    console.log(`  resumes on the next fleet start (${resumePlan.resume.length}): ${resumePlan.resume.map((r) => `${r.runId} on ${r.account}`).join(", ")}`);
  }

  // (e) the session.
  const sess = state?.session;
  console.log(
    sess === undefined
      ? "  finished this session: (not reported by this supervisor)"
      : `  finished this session: ${sess.finished} (ok ${sess.ok}, retried ${sess.retried})`,
  );

  // (f) the manual queue, only when there is one.
  if (config !== undefined) for (const line of formatQueue(poolJobs(config), state?.queue)) console.log(`  ${line}`);

  // A /proc scan only means anything when the supervisor shares this namespace.
  // Against a containerized fleet every job would show up here as "hand
  // started" (host pids, container pids in the state file) — pure noise.
  const foreign =
    state?.containerized === true
      ? []
      : foreignRosters(new Set([...live.values()].map((l) => l.pid)));
  if (foreign.length > 0) {
    console.log("  not fleet-managed (hand-started run-roster processes):");
    for (const f of foreign) console.log(`    pid ${f.pid}: ${f.argv}`);
  }
}

// ------------------------------------------------------------------ dry run

/**
 * The plan for one tick with nothing running: which pinned jobs spawn, which
 * pool accounts the queue and then the policy would take. Pure over the
 * projection; used by --dry-run and by the startup fail-fast.
 */
export function planTick(config: FleetConfig, states: readonly ModelState[], held: (a: string) => string | undefined, stamp: string, resumes: readonly ResumePlan[] = [], probeRuns: readonly ProbeRun[] = []): {
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
  });
  const policyStates = states.filter((st) => policyRefs(config).has(st.name));
  const billingOfName = new Map(states.map((st) => [st.name, st.billing]));
  const keyOf = (n: string): string => concurrencyKeyOfRef(config.roster, n, billingOfName.get(n));
  const keyCount = new Map<string, number>();
  for (const r of runningRefs) keyCount.set(keyOf(r), (keyCount.get(keyOf(r)) ?? 0) + 1);
  const { picks: policy, held: heldPicks } = planPolicyHeld({
    states: policyStates,
    pool: config.accounts.pool,
    classPools: classPoolsOf(config),
    running,
    held,
    queuePlan: queue,
    runningRefs,
    concurrency: { keyOf, max: config.maxConcurrent, running: keyCount },
    policy: config.policy,
    paidRunning: 0,
    campaigns: unpinnedCampaigns(config),
    probeRuns,
  });
  return { pinned, queue, policy, heldPicks };
}

function printDryRun(config: FleetConfig, cliUntil: string | undefined, stampToday: string): void {
  console.log(`--- fleet plan (dry run; nothing spawned, nothing written) ---`);
  for (const line of formatGate(undefined, config.preflight)) console.log(line);
  if (config.preflight.enabled) {
    for (const s of config.preflight.smokes) console.log(`  would run: bun ${smokePath(s.script)} (account ${s.account})`);
    for (const s of config.preflight.deploySmokes) console.log(`  deploy-worldserver.sh only: bun ${smokePath(s.script)} (account ${s.account})`);
  } else {
    console.log("  gate open: jobs spawn without smoking the server first");
  }
  const runs = readRunFacts(RUNS_DIR, Date.now(), { includeArchived: true });
  const states = modelStates({ runsDir: RUNS_DIR, roster: rosterModels(config.roster), policy: config.policy, runs });
  const held = (a: string): string | undefined => accountHeldBy(a, "");
  const resumes = planResumes({ runs, config, running: new Map(), held, now: Date.now() });
  const plan = planTick(config, states, held, stampToday, resumes.resume, probeRunsOf(runs, config.roster));
  const rows: AccountRow[] = [];
  const argvs: string[] = [];
  const planned = (job: FleetJob, spawn: JobSpawn): JobRow => {
    const entries = fillEntries(spawn, stampToday);
    argvs.push(`  ${job.name}: ${jobArgv(spawn, { stamp: stampToday, until: cliUntil }).join(" ")}`);
    return {
      name: job.name,
      models: [...new Set(entries.map((e) => e.model))],
      episode: job.episode,
      runId: entries.map((e) => e.runId).join(", "),
      planned: true,
      ...(job.attempt !== undefined ? { attempt: job.attempt } : {}),
      ...(job.extra !== undefined ? { extra: job.extra } : {}),
    };
  };
  const resumeRow = (r: ResumePlan, kind: AccountKind): AccountRow => ({
    account: r.account,
    kind,
    job: { ...planned(r.job, jobSpawn(r.job, config.roster, r.account, stampToday, undefined, config.campaigns)), name: `${r.job.name} (resume ${r.runId}: ${r.why})` },
  });
  const listedInDryRun = new Set(scheduledAccounts(config).map((a) => a.toUpperCase()));
  for (const account of Object.keys(config.accounts.pinned).filter((a) => !listedInDryRun.has(a.toUpperCase()))) {
    const p = plan.pinned.find((x) => x.job.account!.toUpperCase() === account.toUpperCase());
    const holder = held(account);
    const rs = resumes.resume.find((r) => r.account.toUpperCase() === account.toUpperCase());
    if (rs !== undefined) rows.push(resumeRow(rs, "pinned"));
    else if (p !== undefined) rows.push({ account, kind: "pinned", job: planned(p.job, p.spawn) });
    else {
      const job = pinnedJobs(config).find((j) => j.account?.toUpperCase() === account.toUpperCase());
      rows.push({ account, kind: "pinned", free: true, note: holder !== undefined ? `held by run ${holder}` : `job ${job?.name ?? "?"} disabled — flip enabled:true to spawn` });
    }
  }
  for (const [kind, accounts] of ACCOUNT_CLASSES.map((c) => [c, classAccountsOf(config, c)] as const)) {
    for (const account of accounts) {
      const q = plan.queue.assign.find((a) => a.account === account);
      const pp = plan.policy.find((a) => a.account === account);
      const holder = held(account);
      const rs = resumes.resume.find((r) => r.account.toUpperCase() === account.toUpperCase());
      if (rs !== undefined) rows.push(resumeRow(rs, kind));
      else if (q !== undefined) rows.push({ account, kind, job: planned(q.job, jobSpawn(q.job, config.roster, account, stampToday, eligibleFrom(states), config.campaigns)) });
      else if (pp !== undefined) rows.push({ account, kind, job: { ...planned(pp.job, jobSpawn(pp.job, config.roster, account, stampToday, undefined, config.campaigns)), name: `${pp.job.name} (policy: ${pp.why})` } });
      else rows.push({ account, kind, free: true, ...(holder !== undefined ? { note: `held by run ${holder}` } : {}) });
    }
  }
  console.log("");
  for (const line of formatAccounts(rows)) console.log(line);
  for (const line of formatAccountClasses(config)) console.log(line);
  if (argvs.length > 0) {
    console.log("argv:");
    for (const a of argvs) console.log(a);
  }
  for (const job of plan.queue.waiting) console.log(`  ${job.name}: waiting — ${job.ref} ${job.episode} x${job.repeat} (no free pool account)`);
  for (const sk of plan.queue.skipped) console.log(`  ${sk.job.name}: SKIP — ${sk.reason}`);
  if (plan.policy.length === 0 && plan.queue.waiting.length > 0) console.log("  (manual jobs are waiting; they outrank the policy)");
  console.log("");
  const excluded = new Map<string, string>();
  for (const name of Object.keys(config.roster)) {
    const why = policyExclusion(config, name);
    if (why !== undefined) excluded.set(name, why);
  }
  for (const line of formatModels(states, new Set(), Date.now(), excluded, config.policy)) console.log(line);
  for (const line of formatHeld(plan.heldPicks)) console.log(line);
  for (const line of formatPaused(resumes.listed)) console.log(line);
  for (const line of formatEnded(resumes.end, false)) console.log(line);
  if (Object.keys(config.maxConcurrent).length > 0) {
    console.log(`concurrency: ${Object.entries(config.maxConcurrent).map(([d, n]) => `${d} <= ${n}`).join(", ")} (every run on the key counts)`);
  }
  console.log("finished this session: 0 (ok 0, retried 0) — dry run");
  for (const line of formatQueue(poolJobs(config), undefined)) console.log(line);
  console.log(
    `\n${resumes.resume.length} paused run(s) would resume first; ${plan.pinned.length} pinned job(s) would spawn now plus ${plan.queue.assign.length + plan.policy.length} pool job(s) over ${config.accounts.pool.length} pool account(s).` +
      `\nsupervision: re-read fleet.json every ${TICK_MS / 1000}s; enabled:false drains at the next episode` +
      `\nboundary; enabled:true/new jobs spawn; a malformed edit keeps the last good config.` +
      `\nstamp ${stampToday} is fixed for the life of the supervisor (ADR-0020), not rolled at midnight.` +
      `\nrunning as: ${CONTAINER ? "the `fleet` compose service (episodes spawn in-process)" : "a host process (episodes go through docker compose exec)"}.`,
  );
}

// ------------------------------------------------------------------ main

function parseArgs(argv: string[]): {
  config: string;
  dryRun: boolean;
  status: boolean;
  liveRuns: boolean;
  until: string | undefined;
  clearModel: string | undefined;
} {
  let config = join(REPO_ROOT, "infra", "fleet.json");
  let dryRun = false;
  let status = false;
  let liveRuns = false;
  let until: string | undefined;
  let clearModel: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--status":
        status = true;
        break;
      case "--live-runs":
        liveRuns = true;
        break;
      case "--until":
        until = argv[++i];
        break;
      case "--clear-model":
        clearModel = argv[++i];
        if (clearModel === undefined) {
          console.error("run-fleet: --clear-model needs a roster name");
          process.exit(2);
        }
        break;
      case "-h":
      case "--help":
        console.error(
          [
            "usage: infra/run-fleet.sh [fleet.json] [flags]",
            "",
            "  --until HH:MM   stop condition passed to every job (none when absent)",
            "  --dry-run       print what would spawn on every account right now; spawn nothing",
            "  --status        read-only: accounts, models and session report. Works from the",
            "                  host against a containerized supervisor (heartbeat, not kill -0)",
            "  --live-runs     read-only: list live episodes across the job accounts and exit",
            "                  non-zero if there are any (the deploy window's refusal check)",
            "  --clear-model NAME  forgive a roster model's defer ladder / retirement (ADR-0032):",
            "                  records the clear in data/runs/fleet-models.json; the running",
            "                  supervisor picks it up on its next tick. Safe while the fleet runs.",
            "",
            "The supervisor's normal home is the `fleet` compose service (ADR-0020):",
            "  docker compose -f infra/compose.yml up -d --no-deps fleet",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`run-fleet: unknown flag ${a}`);
          process.exit(2);
        }
        config = isAbsolute(a) ? a : join(process.cwd(), a);
    }
  }
  return { config: preferNextConfig(config), dryRun, status, liveRuns, until, clearModel };
}

/**
 * The 0.5 shape ships as a SIBLING file, the way 0.4's two shape changes did
 * (ADR-0034): whoever asks for `fleet.json` gets `fleet.next.json` when one is
 * beside it, so the running supervisor keeps its old config until it restarts,
 * this build reads the new one wherever it is pointed — compose still passes
 * the old path — and the restart and the eventual rename commute.
 *
 * Without it the deploy meets a config it cannot parse, keeps its last good
 * one, and flies the REJECTED banner with nothing wrong except the order the
 * two halves landed in. Delete this once `fleet.next.json` is renamed over
 * `fleet.json` and no supervisor from before 0.5 can come back.
 */
export function preferNextConfig(path: string): string {
  if (basename(path) !== "fleet.json") return path;
  const next = join(dirname(path), "fleet.next.json");
  return existsSync(next) ? next : path;
}

/**
 * `--clear-model`: the one write an operator makes against the projection.
 * Attempts that ended before the clear no longer climb the ladder; history
 * toward targets is untouched. Atomic rename so a supervisor mid-read never
 * sees a torn file.
 */
function clearModel(configPath: string, name: string): void {
  const { config } = loadConfigForRead(configPath);
  if (config !== undefined && config.roster[name] === undefined) {
    console.error(`run-fleet: ${name} is not a roster entry in ${configPath} (clearing it anyway; names are free-form in the sidecar)`);
  }
  const path = join(RUNS_DIR, MODELS_SIDECAR);
  const prev = readModelsSidecar(RUNS_DIR);
  const next = { ...prev, cleared: { ...prev.cleared, [name]: Date.now() } };
  mkdirSync(RUNS_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeModelsSidecar(next));
  renameSync(tmp, path);
  console.log(`cleared ${name} at ${new Date(next.cleared[name]!).toISOString()} -> ${relative(REPO_ROOT, path)}`);
  if (config !== undefined) {
    const st = modelStates({ runsDir: RUNS_DIR, roster: rosterModels(config.roster), policy: config.policy, sidecar: parseModelsSidecar(serializeModelsSidecar(next)) }).find((m) => m.name === name);
    if (st !== undefined) console.log(`  ${name}: now ${st.status} — ${schedulability(st).why}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (!existsSync(args.config)) {
    console.error(`run-fleet: no such fleet config: ${args.config}`);
    process.exit(2);
  }
  if (args.status) {
    printStatus(args.config);
    return;
  }
  if (args.liveRuns) {
    process.exit(printLiveRuns(args.config) === 0 ? 0 : 1);
  }
  if (args.clearModel !== undefined) {
    clearModel(args.config, args.clearModel);
    return;
  }
  // The stamp is a supervisor EPOCH, not a date. It is taken once, here, and
  // every run id, job roster, job log and defer sidecar hangs off it for the
  // life of the process — which under `restart: unless-stopped` is "until the
  // machine reboots". Rolling it at midnight would rename every job's roster
  // and jsonl underneath a running job and hand --resume-roster/freeCycle a
  // fresh namespace mid-flight; keeping it fixed leaves both semantics exactly
  // as they were. Roll it deliberately: stop the service, start it again.
  const stampToday = dateStamp();
  let config = parseFleet(JSON.parse(readFileSync(args.config, "utf8")));
  configLoadedAt = Date.now();
  // Fail fast on anything that would fail at spawn time.
  planTick(config, modelStates({ runsDir: RUNS_DIR, roster: rosterModels(config.roster), policy: config.policy }), () => undefined, stampToday);

  if (args.dryRun) {
    printDryRun(config, args.until, stampToday);
    return;
  }

  fleetLog = join(RUNS_DIR, `fleet-${stampToday}.jsonl`);
  reclaimServerState("boot");
  const procs = new Map<string, JobProc>();
  const sets: JobSets = { running: new Set(), draining: new Set(), finished: new Set() };
  let stopping = false;
  let wasIdle = false;
  // Job bookkeeping (ADR-0034): which job holds which account, the job itself
  // for every live process, and the last plan's waiting/skipped rows for
  // --status. A skip reason is logged once per (job, reason), not once a tick.
  const assigned = new Map<string, string>();
  const liveJobs = new Map<string, FleetJob>();
  let lastPlan: QueuePlan = { assign: [], waiting: [], skipped: [] };
  /** Paused runs the last plan did not resume, with why; for the state file. */
  let lastPaused: PausedListing[] = [];
  /** Paused runs ended instead of resumed, this session; for the state file. */
  const endedRuns: EndedRun[] = [];
  const complainedSkips = new Map<string, string>();
  /** Jobs handed an account this tick, claimed by spawnJob; a gated tick re-plans next time. */
  const pending = new Map<string, FleetJob>();
  const announcedPicks = new Set<string>();
  let policyIdle: string | undefined;
  const session = { finished: 0, ok: 0, retried: 0 };
  const spawnedNames = new Set<string>();

  /** Why a job is not runnable on the defer ladder, or undefined. Reads its own sidecar. */
  const jobCooling = (job: FleetJob): string | undefined => {
    const defers = jobDefers(jobJsonlPath(job.name, stampToday));
    const now = Date.now();
    for (const d of defers) {
      if (d.entry.tainted === true) return `${job.ref} tainted this epoch (${d.entry.defers} defers, ${d.entry.reason})`;
      if (now < d.entry.notBefore) return `${job.ref} cooling until ${new Date(d.entry.notBefore).toLocaleTimeString()} (${d.entry.reason})`;
    }
    return undefined;
  };

  /**
   * The spawns the supervisor acts on this tick, every one of them a job: the
   * pinned jobs on their accounts; every pool job already running (on the
   * account it was given; `enabled` follows the file so a job flipped off or
   * deleted drains); the manual jobs the queue just handed a free account;
   * and the policy's picks for what is left. Jobs with nothing free wait.
   */
  /**
   * The pinned-campaign jobs the newest tick generated. Published rather than
   * re-derived because `spawnJob` needs the job a spawn came from, and a
   * campaign's jobs exist only for the tick that planned them.
   */
  let campaignJobs: FleetJob[] = [];
  const effectiveJobs = (cfg: FleetConfig): JobSpawn[] => {
    const out: JobSpawn[] = [];
    // The run facts once a tick, shared by the projection and the resume
    // planner. Eligibility for the queue's gate and the policy's picks read
    // the same answer (ADR-0034); resumes read the same facts (ADR-0036).
    const runs = readRunFacts(RUNS_DIR, Date.now(), { includeArchived: true });
    const states = modelStates({ runsDir: RUNS_DIR, roster: rosterModels(cfg.roster), policy: cfg.policy, runs });
    const eligible = eligibleFrom(states);
    const byName = new Map(cfg.jobs.map((j) => [j.name, j]));
    const runningRefs = new Set<string>();
    const keyCount = new Map<string, number>();
    // Paid policy models in flight, for the paid cap (pinned jobs excluded).
    const billingOf = new Map(states.map((st) => [st.name, st.billing]));
    let paidRunning = 0;
    const pinnedSkips: QueueSkip[] = [];
    const keyOf = (n: string): string => concurrencyKeyOfRef(cfg.roster, n, billingOf.get(n));
    const countKey = (refs: readonly string[]): void => {
      for (const r of refs) keyCount.set(keyOf(r), (keyCount.get(keyOf(r)) ?? 0) + 1);
    };
    // Pinned jobs: from the file, on their own accounts — plus a pinned
    // campaign's next cell, which is a pinned job in everything but where it
    // was written down (ADR-0041).
    const probes = probeRunsOf(runs, cfg.roster);
    campaignJobs = pinnedCampaignJobs(cfg, probes);
    for (const job of [...pinnedJobs(cfg), ...campaignJobs]) {
      if (job.enabled && runnableRefs(job, cfg.roster, eligible).length === 0) {
        // A pinned job whose ref is not promoted into its tier: it waits,
        // with the reason said once, exactly like a gated queue job.
        pinnedSkips.push({ job, reason: `${job.ref} is not eligible for ${job.episode} (its tier buys no ${job.episode} runs — earn it with a level-5 e90, or set a tier that includes it)` });
        out.push({ name: job.name, enabled: false, account: job.account!, loop: false, entries: [{ model: "gated" }] });
        continue;
      }
      out.push(jobSpawn(job, cfg.roster, job.account!, stampToday, eligible, cfg.campaigns));
      if (job.enabled || sets.running.has(job.name)) {
        for (const r of job.refs) runningRefs.add(r);
        // An enabled pinned job spawns this tick if it is not already running,
        // so it counts against the driver cap either way — otherwise the first
        // tick after a restart fills the pool before the pinned session exists.
        countKey(job.refs);
      }
    }
    // Pool jobs with a live process: keep running whatever the file now says,
    // drain if the file dropped them or their refs.
    for (const [name, account] of assigned) {
      const running = liveJobs.get(name);
      const fromFile = byName.get(name);
      if (running?.source === "policy") {
        if (cfg.roster[running.ref] === undefined) {
          out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
        } else {
          out.push(jobSpawn(running, cfg.roster, account, stampToday, undefined, cfg.campaigns));
          runningRefs.add(running.ref);
          countKey(running.refs);
          if (billingOf.get(running.ref) === "paid") paidRunning++;
        }
        continue;
      }
      if (fromFile === undefined || fromFile.account !== undefined || runnableRefs(fromFile, cfg.roster, eligible).length === 0) {
        // Removed from the queue (or pinned now, or its ref vanished): a
        // disabled stand-in makes diffJobs drain it. The process keeps its roster.
        out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
        continue;
      }
      out.push(jobSpawn(fromFile, cfg.roster, account, stampToday, eligible, cfg.campaigns));
      for (const r of fromFile.refs) runningRefs.add(r);
      countKey(fromFile.refs);
      // A manual pool job on a paid model holds a paid slot too: the cap is
      // about what is billing at once, not about who asked for it.
      for (const r of fromFile.refs) if (billingOf.get(r) === "paid") paidRunning++;
    }
    const held = (a: string): string | undefined => accountHeldBy(a, "");
    // Resumes before anything fresh (ADR-0036): a paused run goes back onto
    // its own account ahead of the queue and the policy, so nothing can wipe
    // its character first. A pinned job's spawn is replaced by its resume
    // spawn; a pool job's resume reserves its account like an assignment.
    const runningMap = new Map<string, string>(assigned);
    for (const job of pinnedJobs(cfg)) if (sets.running.has(job.name)) runningMap.set(job.name, job.account!);
    const resumes = planResumes({ runs, config: cfg, running: runningMap, held, now: Date.now() });
    lastPaused = resumes.listed;
    // A paused run whose ref now names another model is ended, not resumed:
    // the runner's own writer, once, and the run leaves the paused set.
    for (const r of endRuns(RUNS_DIR, resumes.end)) {
      const e = resumes.end.find((x) => x.runId === r.runId)!;
      if (r.error !== undefined) {
        say(`end ${e.runId}: could not write the termination — ${r.error}`);
        record({ job: `${e.ref}-${runs.find((f) => f.runId === e.runId)?.episode ?? "e90"}`, event: "end-failed", detail: `${e.detail}; ${r.error}` });
        continue;
      }
      endedRuns.push(e);
      say(`end ${e.runId}: ${e.detail}`);
      record({ job: `${e.ref}-${runs.find((f) => f.runId === e.runId)?.episode ?? "e90"}`, event: "ended", detail: e.detail });
    }
    const reserved = new Map<string, string>();
    for (const r of resumes.resume) {
      const name = r.job.name;
      if (sets.running.has(name)) continue;
      const spawn = jobSpawn(r.job, cfg.roster, r.account, stampToday, undefined, cfg.campaigns);
      if (r.job.account !== undefined) {
        pending.set(name, r.job);
        const idx = out.findIndex((l) => l.name === name);
        if (idx >= 0) out[idx] = spawn;
        else out.push(spawn);
      } else {
        pending.set(name, r.job);
        sets.finished.delete(name);
        reserved.set(name, r.account);
        out.push(spawn);
        for (const ref of r.job.refs) {
          runningRefs.add(ref);
          if (billingOf.get(ref) === "paid") paidRunning++;
        }
        countKey(r.job.refs);
      }
      const key = `resume:${r.runId}:${r.pauseCount}`;
      if (!announcedPicks.has(key)) {
        announcedPicks.add(key);
        say(`resume ${name}: ${r.runId} on ${r.account} — ${r.why}`);
        record({ job: name, event: "resume", detail: `${r.runId} on ${r.account}: ${r.why}` });
      }
    }
    const runningAndReserved = new Map([...assigned, ...reserved]);
    lastPlan = planQueue({
      queue: poolJobs(cfg),
      roster: cfg.roster,
      pool: cfg.accounts.pool,
      running: runningAndReserved,
      finished: sets.finished,
      held,
      cooling: jobCooling,
      eligible,
      runningRefs,
    });
    lastPlan.skipped.unshift(...pinnedSkips);
    for (const { job, account } of lastPlan.assign) {
      pending.set(job.name, job);
      out.push(jobSpawn(job, cfg.roster, account, stampToday, eligible, cfg.campaigns));
    }
    // The policy fills what the queue left free. A gated spawn is not a
    // problem: the pick is re-made next tick from the same projection.
    if (scheduledAccounts(cfg).length > 0) {
      const allowed = policyRefs(cfg);
      const picks = planPolicy({
        states: states.filter((st) => allowed.has(st.name)),
        pool: cfg.accounts.pool,
        classPools: classPoolsOf(cfg),
        running: runningAndReserved,
        held,
        queuePlan: lastPlan,
        runningRefs,
        concurrency: { keyOf, max: cfg.maxConcurrent, running: keyCount },
        policy: cfg.policy,
        paidRunning,
        campaigns: unpinnedCampaigns(cfg),
        probeRuns: probes,
      });
      for (const { job, account, why } of picks) {
        pending.set(job.name, job);
        // A policy job that finished an earlier attempt is fair game again;
        // the projection, not the finished set, decides whether it runs.
        sets.finished.delete(job.name);
        const key = `${job.name}:${job.attempt}`;
        if (!announcedPicks.has(key)) {
          announcedPicks.add(key);
          const tag = isExtraJob(job) ? " (extra)" : "";
          say(`policy ${job.name}: ${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account} — ${why}`);
          record({ job: job.name, event: "policy-pick", detail: `${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account}: ${why}` });
        }
        out.push(jobSpawn(job, cfg.roster, account, stampToday, undefined, cfg.campaigns));
      }
      const taken = new Set([...runningAndReserved.values(), ...lastPlan.assign.map((a) => a.account), ...picks.map((p) => p.account)].map((a) => a.toUpperCase()));
      const free = scheduledAccounts(cfg).filter((a) => !taken.has(a.toUpperCase()) && held(a) === undefined);
      const idle =
        free.length === 0
          ? undefined
          : lastPlan.waiting.length > 0
            ? `${free.length} free account(s) but manual job(s) waiting (${lastPlan.waiting.map((j) => j.name).join(", ")}) — they outrank the policy`
            : `${free.length} free account(s), nothing schedulable: ${states
                .filter((st) => allowed.has(st.name))
                .map((st) => `${st.name}=${st.status}`)
                .join(" ")}`;
      if (idle !== policyIdle) {
        if (idle !== undefined) say(`policy: ${idle}`);
        policyIdle = idle;
      }
    }
    for (const sk of lastPlan.skipped) {
      if (complainedSkips.get(sk.job.name) !== sk.reason) {
        complainedSkips.set(sk.job.name, sk.reason);
        say(`queue ${sk.job.name}: skipped — ${sk.reason}`);
        record({ job: sk.job.name, event: "queue-skipped", detail: sk.reason });
      }
    }
    for (const j of cfg.jobs) if (!lastPlan.skipped.some((sk) => sk.job.name === j.name)) complainedSkips.delete(j.name);
    return out;
  };
  const poolView = (cfg: FleetConfig): PoolView => ({
    pinned: cfg.accounts.pinned,
    pool: cfg.accounts.pool,
    paid: cfg.accounts.paid,
    local: cfg.accounts.local,
    assigned,
    jobs: liveJobs,
    queue: poolJobs(cfg),
    finished: sets.finished,
    waiting: lastPlan.waiting.map((j) => j.name),
    skipped: lastPlan.skipped.map((sk) => ({ name: sk.job.name, reason: sk.reason })),
    ...(policyIdle !== undefined ? { policyIdle } : {}),
    session,
    paused: lastPaused,
    ended: endedRuns,
  });

  const spawnJob = (spawn: JobSpawn): void => {
    const entries = fillEntries(spawn, stampToday);
    const rosterPath = jobRosterPath(spawn.name, stampToday);
    mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(rosterPath, JSON.stringify(entries, null, 2) + "\n");
    // A respawn (job toggled off then on again the same day) resumes the
    // materialized roster instead of relaunching finished runs from scratch.
    const resumeRoster = spawn.resumeRunId !== undefined || existsSync(jobJsonlPath(spawn.name, stampToday));
    const argv = jobArgv(spawn, { stamp: stampToday, until: args.until, resumeRoster });
    const stdoutLog = jobLogPath(spawn.name, stampToday);
    // O_APPEND, not Bun.file(): a BunFile sink starts at offset 0, so a
    // respawned job used to overwrite the head of its own log and leave the
    // dead process's tail behind it — which is exactly what `--status` reads.
    // The shared offset an append fd gives both streams also keeps stdout and
    // stderr from clobbering each other.
    mkdirSync(dirname(stdoutLog), { recursive: true });
    const fd = openSync(stdoutLog, "a");
    const proc = Bun.spawn(argv, { cwd: REPO_ROOT, stdin: "ignore", stdout: fd, stderr: fd });
    writeSync(fd, `---- spawned ${new Date().toISOString()} pid ${proc.pid} ${argv.join(" ")}\n`);
    closeSync(fd);
    // A pinned CAMPAIGN's job is not in `config.jobs` — it is generated from the
    // campaigns block each tick — so looking only at `pinnedJobs` left its
    // process with no job at all, and every state row for it read "episode
    // unknown" through `stateJobFacts`' fallback. `campaignJobs` is what the
    // tick that planned this spawn generated, so the lookup finds it without
    // re-deriving the sweep here.
    const pj =
      pending.get(spawn.name) ??
      [...pinnedJobs(config), ...campaignJobs].find((j) => j.name === spawn.name);
    const lp: JobProc = { spawn, ...(pj !== undefined ? { job: pj } : {}), proc, pid: proc.pid, spawnedAt: Date.now(), exited: false, exitCode: null };
    void proc.exited.then((code) => {
      lp.exited = true;
      lp.exitCode = code;
    });
    procs.set(spawn.name, lp);
    sets.running.add(spawn.name);
    if (spawnedNames.has(spawn.name)) session.retried++;
    spawnedNames.add(spawn.name);
    if (pj !== undefined) {
      liveJobs.set(spawn.name, pj);
      if (pj.account === undefined) assigned.set(spawn.name, spawn.account);
      pending.delete(spawn.name);
      if (pj.attempt !== undefined) announcedPicks.delete(`${spawn.name}:${pj.attempt}`);
    }
    const how = spawn.resumeRunId !== undefined ? `, resuming ${spawn.resumeRunId}` : resumeRoster ? ", --resume-roster" : "";
    say(`job ${spawn.name}: spawned pid ${proc.pid} (account ${spawn.account}${how}) -> ${stdoutLog}`);
    record({ job: spawn.name, event: "spawned", detail: `pid ${proc.pid}${how}; account ${spawn.account}` });
  };

  let wakeTick: (() => void) | undefined;
  const requestStop = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    say("stopping: SIGTERM to every job — each live episode PAUSES as operator-pause (ADR-0036); waiting for the rosters to exit");
    wakeTick?.();
    for (const [name, p] of procs) {
      if (!p.exited) {
        try {
          process.kill(p.pid, "SIGTERM");
        } catch {
          // already gone
        }
        record({ job: name, event: "sigterm", detail: "fleet stop" });
      }
    }
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  say(
    `fleet ${args.config}: ${pinnedJobs(config).filter((j) => j.enabled).length} enabled pinned job(s), ` +
      `${poolJobs(config).filter((j) => j.enabled).length} queued job(s) and ${policyRefs(config).size} policy model(s) over ${config.accounts.pool.length} pool account(s), log ${fleetLog}` +
      `, stamp ${stampToday}${CONTAINER ? " (compose service `fleet`)" : ""}` +
      `${args.until !== undefined ? `, deadline ${args.until}` : ", no deadline — steer with fleet.json"}`,
  );
  // The gate: nothing is spawned against a server nobody has smoked. Held
  // across ticks so a passing result is not re-run for the same identity.
  let gate: PreflightRecord | undefined;
  let complainedFor: string | undefined;

  /**
   * Evaluate (and if needed run) the gate. Returns whether jobs may spawn.
   * Only `start` is ever suppressed: drains, undrains and rearms must keep
   * working while the gate is shut, or an operator could not park a job during
   * a bad deploy.
   */
  const checkGate = async (pf: FleetPreflight): Promise<boolean> => {
    // Disabled short-circuits before the /health probe: a gate nobody armed
    // must not cost a 5s fetch every tick.
    const server = pf.enabled ? await readServerIdentity() : undefined;
    const identity = server?.identity;
    const action = gateDecision({ enabled: pf.enabled, identity, last: gate });
    if (action === "skip") {
      if (gate?.skipped !== true) {
        gate = { at: Date.now(), serverIdentity: identity ?? "unknown", ok: true, skipped: true, results: [] };
        say("preflight: disabled in fleet.json — gate open, jobs spawn unsmoked");
        record({ job: "-", event: "preflight-skipped" });
      }
      return gateOpen(action, gate);
    }
    if (action === "wait") {
      if (complainedFor !== "unready") {
        complainedFor = "unready";
        say(`preflight: ${MODULE_URL}/health is not answering ready — spawning nothing until it does`);
        record({ job: "-", event: "preflight-waiting" });
      }
      return gateOpen(action, gate);
    }
    if (action === "pass") return gateOpen(action, gate);
    say(`preflight: smoking the server (identity ${identity!})`);
    record({ job: "-", event: "preflight-start", detail: identity });
    preflightInFlight = { identity: identity!, since: Date.now() };
    writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config));
    // Keep the heartbeat fresh while the sequence runs: a smoke outlasts the
    // liveness window and an outside observer would otherwise read a busy
    // supervisor as a dead one.
    const pulse = setInterval(() => writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config)), 30_000);
    try {
      gate = await runPreflight(pf, server!);
    } finally {
      clearInterval(pulse);
      preflightInFlight = undefined;
    }
    if (gate.ok) {
      complainedFor = undefined;
      say(`preflight: PASS in ${Math.round(Math.max(0, ...gate.results.map((r) => r.ms)) / 1000)}s wall — jobs may spawn`);
      record({ job: "-", event: "preflight-pass", detail: identity });
    } else {
      const failed = gate.results.find((r) => !r.ok);
      if (complainedFor !== identity) {
        complainedFor = identity;
        say(
          `preflight: FAIL — ${failed?.script ?? "?"}: ${failed?.tail ?? "no output"}\n` +
            `           NO JOBS WILL SPAWN against this server. Fix or roll back the ` +
            `worldserver; the gate re-runs every ${TICK_MS / 1000}s.`,
        );
      }
      record({ job: "-", event: "preflight-fail", detail: `${failed?.script ?? "?"}: ${failed?.tail ?? ""}` });
    }
    return gateOpen(action, gate);
  };

  let mayStart = await checkGate(config.preflight);
  if (mayStart) for (const spawn of diffJobs(effectiveJobs(config), sets).start) spawnJob(spawn);
  writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config));

  for (;;) {
    // A stop wakes the tick and then polls fast: the container's grace period
    // is finite, and a roster that paused its episode in 5s must not wait
    // 60s to be reaped.
    await new Promise<void>((res) => {
      const t = setTimeout(res, stopping ? 2_000 : TICK_MS);
      wakeTick = () => {
        clearTimeout(t);
        res();
      };
    });
    wakeTick = undefined;

    // Reap exits.
    for (const [name, p] of procs) {
      if (p.exited && sets.running.has(name)) {
        sets.running.delete(name);
        const drained = sets.draining.delete(name);
        if (!drained) sets.finished.add(name);
        const acct = assigned.get(name);
        assigned.delete(name);
        session.finished++;
        if (p.exitCode === 0) session.ok++;
        // A policy job is not "finished": the projection decides whether it
        // runs again, so nothing here keeps it out of the next plan.
        const job = liveJobs.get(name);
        liveJobs.delete(name);
        if (job?.source === "policy") sets.finished.delete(name);
        say(`job ${name}: roster exited ${p.exitCode}${drained ? " (drained)" : ""}${acct !== undefined ? ` — pool account ${acct} released` : ""}`);
        record({ job: name, event: "exited", detail: `code ${p.exitCode}${drained ? "; drained" : ""}` });
      }
    }

    if (stopping) {
      if (sets.running.size === 0) break;
      writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config));
      continue;
    }

    reclaimServerState("tick");
    // Re-read the config: the operator's tuning knob. Unconditionally, every
    // tick — mtime gating would add a second way for an edit to go silently
    // unapplied, which is the failure this whole path exists to make loud.
    // mtime is only recorded, and used to dedupe the complaint in the log.
    let mtime = 0;
    try {
      mtime = statSync(args.config).mtimeMs;
    } catch {
      // Unreadable stat is itself an attempt failure; rereadFleet reports it.
    }
    const { config: next, error } = rereadFleet(args.config, config);
    const wasRejected = configRejected;
    configRejected = nextConfigRejection(wasRejected, { error, mtime }, Date.now());
    if (error !== undefined) {
      // The state field persists for --status; the log complains only when the
      // error or the file changed, so a rejected file does not spam all night.
      if (wasRejected?.error !== error || wasRejected.mtime !== mtime) {
        say(
          `fleet config REJECTED — keeping the last good config; the enabled flags in ` +
            `${args.config} are NOT in effect: ${error}`,
        );
        record({ job: "-", event: "config-error", detail: error });
      }
    } else {
      configLoadedAt = Date.now();
      if (wasRejected !== undefined) {
        say("fleet config loads again — the file is back in effect");
        record({ job: "-", event: "config-recovered" });
      }
    }
    config = next;

    const actions = diffJobs(effectiveJobs(config), sets);
    for (const name of actions.undrain) {
      sets.draining.delete(name);
      say(`job ${name}: re-enabled before it drained — keeping it running`);
      record({ job: name, event: "undrain" });
    }
    for (const name of actions.rearm) {
      sets.finished.delete(name);
      record({ job: name, event: "rearmed", detail: "disabled after finishing; enable again to respawn" });
    }
    for (const name of actions.drain) {
      sets.draining.add(name);
      say(`job ${name}: disabled — draining (SIGTERM at the next episode boundary)`);
      record({ job: name, event: "draining" });
    }
    // Drains: only SIGTERM a roster with no episode child. Delivered BEFORE the
    // gate, which can sit inside a smoke for minutes: an operator parking a job
    // must never wait on the gate for their SIGTERM.
    for (const name of [...sets.draining]) {
      const p = procs.get(name);
      if (p === undefined || p.exited) continue;
      if (!hasLiveChild(p.pid)) {
        try {
          process.kill(p.pid, "SIGTERM");
        } catch {
          // already gone
        }
        say(`job ${name}: between episodes — SIGTERM sent`);
        record({ job: name, event: "drain-sigterm" });
      }
    }

    // The gate runs after every drain/undrain/rearm action precisely so a shut
    // gate never blocks the operator from parking a job. `stopping` is
    // re-checked after the await: a SIGTERM that lands during a 15-minute smoke
    // has already killed the jobs, and spawning into that would be a leak.
    mayStart = await checkGate(config.preflight);
    if (mayStart && !stopping) {
      for (const spawn of actions.start) spawnJob(spawn);
    } else if (actions.start.length > 0 && !stopping) {
      record({ job: "-", event: "spawn-gated", detail: actions.start.map((l) => l.name).join(",") });
    }

    writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config));
    const toStart = diffJobs(effectiveJobs(config), sets).start.length + lastPlan.waiting.length;
    if (fleetComplete({ running: sets.running.size, toStart, hasDeadline: args.until !== undefined })) {
      say("all jobs have exited and nothing is left to spawn — fleet complete");
      break;
    }
    const idle = sets.running.size === 0 && toStart === 0;
    if (idle !== wasIdle) {
      wasIdle = idle;
      if (idle) {
        say("no jobs running and none to spawn — idling; enable a job in fleet.json (or stop the service)");
        record({ job: "-", event: "idle" });
      } else {
        record({ job: "-", event: "unidle" });
      }
    }
  }
  writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config));
  say("fleet exit");
}

if (import.meta.main) {
  void main().catch((e: unknown) => {
    console.error(`run-fleet: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
