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
 * published as a heartbeat in fleet-state.json and per-lane `alive` flags, not
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
 * Older files still load: the pre-pool shape (lanes that each name an account)
 * and the pool shape (a `lanes` list beside `accounts.pinned`) both read as
 * pinned jobs, with a one-line notice. The supervisor re-reads fleet.json
 * every tick (60s):
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
 *  - two enabled lanes must not share an account (one live session per
 *    account; the second lane would spend the night in account_in_use).
 *  - lane-policy: claude-family models (opus/sonnet/haiku/claude-*) run only
 *    via the claude-code driver, and that driver runs only claude
 *    models. Shared free-cloud pools (OpenRouter/OpenCode) carry free models
 *    only; keeping a single stream per provider pool is the whole point of the
 *    lane shape. A local/self-hosted openai apiBase is a distinct category:
 *    exempt from the free-suffix rule (no shared pool to meter), still barred
 *    from claude-* ids.
 *
 * The roster's own account-busy guard still runs under every lane: a lane
 * pointed at an account something else is using waits, it does not clobber.
 *
 * Preflight gate (ADR-0023): the top-level `preflight` block in fleet.json is
 * the deploy-window smoke, made a normal part of fleet operation. The
 * supervisor runs those scripts against the live server before it spawns any
 * lane, and again whenever the server identity changes (a recreate, or a
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
import { dirname, isAbsolute, join, relative } from "node:path";
import { accountHeldBy, deferSidecarPath, parseDefers, slug, type DeferEntry, type RosterSpec } from "./run-roster";
import { harnessSeries } from "../runner/src/comparability";
import { normalizeDriver, watchdogOverrideSchema, type WatchdogOverride } from "../runner/src/config";
import { isAllowlistedFree, type Billing } from "../runner/src/model-cost";
import {
  LADDER_MS,
  MODELS_SIDECAR,
  modelStates,
  parsePolicyBlock,
  parseRunsPerEpisode,
  parseModelsSidecar,
  planNextJobs,
  readModelsSidecar,
  schedulability,
  serializeModelsSidecar,
  type HeldPick,
  type ModelState,
  type NextJob,
  type RosterModel,
  type SchedulingPolicy,
  type StartingCharacter,
} from "../runner/src/models";
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
 * materialised form every job takes on its way to `spawnLane` — pinned, pool
 * and policy alike — and the shape a pre-pool fleet.json still describes
 * directly (see `legacyJob`). Nothing in a new-shape file is a lane.
 */
export interface FleetLane {
  name: string;
  enabled: boolean;
  account: string;
  loop: boolean;
  untilDefault?: string;
  /** Inline roster entries — the exact per-entry schema run-roster accepts. */
  entries?: RosterSpec[];
  /** Alternative to entries: a roster JSON on disk. */
  rosterFile?: string;
  /**
   * Lane-level defaults for the two run dimensions of ADR-0024 and for the
   * episode's tool-call ceiling. An entry that carries its own wins; a lane
   * that carries one applies it to every entry that does not. An objective
   * stamps every run in the lane unscored.
   */
  objective?: string;
  watchdogs?: WatchdogOverride;
  maxToolCalls?: number;
  /** Lane default for the wiki-coordinates tier (ADR-0028); entry wins. */
  wikiCoords?: boolean;
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
 * session per account is the module's rule, so the account IS the lane), and
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
  /** Default game account for string-form smokes — its own, never a lane's, never PROBE. */
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
// to an account (`account` in the file) is the old lane; a job without one is
// POOL work, spawned on whichever `accounts.pool` account is free when its
// turn comes; the policy's own picks are jobs too, made up each tick. Older
// shapes still load: a `lanes` list (pre-pool, or pool-era beside
// `accounts.pinned`) converts to pinned jobs that carry their entries verbatim.

/** Episode tiers (ADR-0033). `freeplay` is unscored and bypasses the tiers gate. */
export const EPISODE_IDS = ["e90", "e360", "freeplay"] as const;
export type EpisodeId = (typeof EPISODE_IDS)[number];

/**
 * A roster entry as named in the `roster` map: the exact per-entry schema
 * plus two optional scheduling fields. `tiers` is a manual FORCE — tiers
 * listed here are eligible regardless of history (ADR-0034: every model is
 * e90-eligible on arrival and e360 is earned from run history, so the field
 * is normally absent). `runsPerEpisode` overrides the policy's per-episode
 * target for this entry. An entry may carry the run dimensions (`objective`,
 * `watchdogs`, `maxToolCalls`, `wikiCoords`): a probe with an objective is
 * a roster entry like any other, referenced by a pinned job.
 */
export interface FleetRosterEntry extends RosterSpec {
  tiers: EpisodeId[];
  runsPerEpisode?: Partial<Record<"e90" | "e360", number>>;
  /** Operator override of the free/paid verdict (`runner/src/model-cost.ts`); normally absent. */
  billing?: Billing;
}

export type JobSource = "pinned" | "queue" | "policy" | "legacy";

export interface FleetJob {
  /**
   * Keys into `roster`, one or more. Several refs make one job rotate through
   * several models on one account; `ref` in the file may be a string or an
   * array, normalised here. Empty for a legacy job (its entries are inline).
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
   * across the file. A legacy lane keeps its lane name.
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
   * Set on an extra run (ADR-0034): a policy pick past the model's target,
   * rolling this character. Reaches the runner as `--race/--class` plus
   * `--extra true`, so the run is stamped and never counted.
   */
  extra?: StartingCharacter;
  /**
   * A pre-job lane, carried verbatim so an older file runs exactly as it did:
   * its own entries (or rosterFile), lane-level dimensions, untilDefault.
   * Only `legacyJob` sets it.
   */
  legacy?: FleetLane;
}

export interface FleetAccounts {
  /** account -> the pinned job on it. Derived from the jobs, never authored. */
  pinned: Record<string, string>;
  /** free-for-the-pool accounts, in preference order */
  pool: string[];
}

export interface FleetConfig {
  notes: string[];
  preflight: FleetPreflight;
  accounts: FleetAccounts;
  roster: Record<string, FleetRosterEntry>;
  /** Every job the file names, pinned and pool, in file order. */
  jobs: FleetJob[];
  /** ADR-0034 targets; `policy.runsPerEpisode` in the file, defaults apply. */
  policy: SchedulingPolicy;
  /**
   * `policy.maxConcurrent`: streams the policy may have in flight per driver,
   * counting every job on that driver (pinned ones included). Absent driver:
   * unlimited. The knob for a subscription that tolerates only so many
   * concurrent sessions.
   */
  maxConcurrent: Record<string, number>;
  /** Lane names read from a legacy `lanes` list this load, for the one-line notice. */
  legacyLanes: string[];
}

/** The jobs pinned to an account, in file order. */
export function pinnedJobs(config: Pick<FleetConfig, "jobs">): FleetJob[] {
  return config.jobs.filter((j) => j.account !== undefined);
}

/** The manual pool queue: jobs with no account, in file order. */
export function poolJobs(config: Pick<FleetConfig, "jobs">): FleetJob[] {
  return config.jobs.filter((j) => j.account === undefined);
}

/** Roster names a pinned job references: never the policy's to schedule. */
export function pinnedRefs(config: Pick<FleetConfig, "jobs">): Set<string> {
  return new Set(pinnedJobs(config).flatMap((j) => j.refs));
}

/**
 * What an episode id means in the flags the runner has today (mirrors
 * runner/src/episodes.ts), passed alongside `--episode <id>` until the runner
 * owns the id. e90: 90m, idle 20m, no-xp 20m, 3000 calls. e360: 6h, idle 20m,
 * no-xp off — ceilings are a runaway guard at 1000 calls per 30 min (e90
 * 3000, e360 12000; docs/EPISODES.md). freeplay: no wall clock, unscored, ceiling left to the lane (the runner has no "unbounded").
 */
export function episodeDimensions(id: EpisodeId): Pick<RosterSpec, "episode" | "watchdogs" | "maxToolCalls"> {
  switch (id) {
    case "e90":
      return { episode: id, watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: 1_200_000 }, maxToolCalls: 3000 };
    case "e360":
      return { episode: id, watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: 12000 };
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

// ------------------------------------------------------------------ parsing

function fail(msg: string): never {
  throw new Error(msg);
}

/** True for models that must ride the claude-code driver (the claude-code harness, ADR-0035). */
export function isClaudeFamily(model: string): boolean {
  return /(^|\/)(claude|opus|sonnet|haiku)/i.test(model);
}

/**
 * True when an openai lane points at a shared free-cloud pool — OpenRouter or
 * OpenCode Zen. Those pools are what the free-suffix rule polices: their free
 * tiers are metered per upstream provider, so only free model ids belong there.
 * An absent apiBase means the run-roster default (OpenRouter), so it counts as
 * a shared pool too. A local/self-hosted OpenAI-compatible endpoint (e.g. an
 * LM Studio box on the LAN) is NOT a shared pool: it has no free tier to abuse,
 * so it is exempt from the free-suffix rule — but still bound by every other
 * lane-policy check, the claude bar included.
 */
export function isSharedFreePool(apiBase: string | undefined): boolean {
  if (apiBase === undefined) return true;
  return /(^|\/\/|\.)(openrouter\.ai|opencode\.ai)(\/|:|$)/i.test(apiBase);
}

// `isAllowlistedFree` (suffixless ids verified free, e.g. `stealth/ox-alpha`)
// lives in runner/src/model-cost.ts, next to the billing verdict it feeds.

/**
 * Lane-policy and shape checks for one lane's entries. Used for inline
 * entries at parse time and for rosterFile contents at load time.
 */
export function validateEntries(lane: FleetLane, entries: unknown): RosterSpec[] {
  if (!Array.isArray(entries)) fail(`lane ${lane.name}: entries must be a JSON array`);
  const out: RosterSpec[] = [];
  for (const e of entries as RosterSpec[]) {
    if (typeof e !== "object" || e === null || typeof e.model !== "string" || e.model.length === 0) {
      fail(`lane ${lane.name}: entry without a model: ${JSON.stringify(e)}`);
    }
    // `claude-subscription` is the pre-ADR-0035 spelling of `claude-code`;
    // a live fleet.json may still carry it, and it reads as the same driver.
    const driver = normalizeDriver(e.driver ?? "openai");
    if (driver !== "openai" && driver !== "claude-code") {
      fail(`lane ${lane.name}: entry ${e.model}: unknown driver ${String(e.driver)}`);
    }
    if (driver === "openai" && isClaudeFamily(e.model)) {
      fail(
        `lane ${lane.name}: entry ${e.model}: lane-policy — claude models run only via the ` +
          `claude-code driver, never through an openai-driver lane`,
      );
    }
    if (driver === "claude-code" && !isClaudeFamily(e.model)) {
      fail(
        `lane ${lane.name}: entry ${e.model}: lane-policy — the claude-code driver ` +
          `carries claude models only`,
      );
    }
    if (e.account !== undefined && e.account.toUpperCase() !== lane.account.toUpperCase()) {
      fail(
        `lane ${lane.name}: entry ${e.model} pins account ${e.account} but the lane owns ` +
          `${lane.account} — one lane, one account`,
      );
    }
    // Shared free-cloud pools (OpenRouter, OpenCode Zen) carry free models
    // only; the suffix is how we keep a lane off a paid tier. Local/self-hosted
    // openai lanes have no such pool and are exempt — but still claude-barred
    // above.
    if (
      driver === "openai" &&
      isSharedFreePool(e.apiBase) &&
      !/(-free$|:free$)/.test(e.model) &&
      !isAllowlistedFree(e.model)
    ) {
      fail(
        `lane ${lane.name}: entry ${e.model}: lane-policy — a shared free-cloud pool ` +
          `(OpenRouter/OpenCode) carries free models only (id must end -free or :free, ` +
          `or be a verified-free stealth id in FREE_SUFFIXLESS_ALLOWLIST); ` +
          `a local/self-hosted apiBase is exempt`,
      );
    }
    if (e.watchdogs !== undefined) {
      const parsed = watchdogOverrideSchema.safeParse(e.watchdogs);
      if (!parsed.success) {
        fail(`lane ${lane.name}: entry ${e.model}: watchdogs — ${parsed.error.message}`);
      }
    }
    if (e.objective !== undefined && (typeof e.objective !== "string" || e.objective.length === 0)) {
      fail(`lane ${lane.name}: entry ${e.model}: objective must be a non-empty string`);
    }
    if (e.wikiCoords !== undefined && typeof e.wikiCoords !== "boolean") {
      fail(`lane ${lane.name}: entry ${e.model}: wikiCoords must be a boolean`);
    }
    if (
      e.maxToolCalls !== undefined &&
      (typeof e.maxToolCalls !== "number" || !Number.isInteger(e.maxToolCalls) || e.maxToolCalls <= 0)
    ) {
      fail(`lane ${lane.name}: entry ${e.model}: maxToolCalls must be a positive integer`);
    }
    // Normalised driver spelling from here on: meta.json and the runner argv
    // only ever see `claude-code`.
    out.push(e.driver === undefined ? e : { ...e, driver });
  }
  if (out.length === 0) fail(`lane ${lane.name}: no entries`);
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
  };
  const notes = Array.isArray(o._notes) ? o._notes.filter((n): n is string => typeof n === "string") : [];
  const accounts = parseAccounts(o.accounts);
  const legacyPinned = accounts.pinned;
  accounts.pinned = {};
  const roster = parseRoster(o.roster);
  const jobs: FleetJob[] = [];
  const names = new Set<string>();
  const add = (job: FleetJob): void => {
    if (names.has(job.name)) {
      fail(
        job.source === "legacy"
          ? `fleet config: duplicate lane name ${job.name}`
          : `queue: two jobs would share the name ${job.name} (${job.ref} ${job.episode}) — one job per (ref, episode)`,
      );
    }
    names.add(job.name);
    jobs.push(job);
  };
  // Legacy `lanes`: the pre-pool shape (each lane names its account) and the
  // pool shape (accounts come from accounts.pinned) both read as pinned jobs
  // that carry their entries verbatim.
  const legacyLanes: string[] = [];
  if (o.lanes !== undefined) {
    if (!Array.isArray(o.lanes)) fail("fleet config: lanes must be an array");
    const hasPinnedMap = o.accounts !== undefined && Object.keys(legacyPinned).length > 0;
    for (const l of o.lanes as Partial<FleetLane>[]) {
      const lane = parseLegacyLane(l, (name) => {
        if (o.accounts === undefined) return undefined;
        const pinned = Object.entries(legacyPinned).find(([, ln]) => ln === name)?.[0];
        if (pinned === undefined) {
          fail(`lane ${name}: not in accounts.pinned — a lane must be pinned to an account (pool work goes in queue)`);
        }
        return pinned;
      });
      add(legacyJob(lane));
      legacyLanes.push(lane.name);
    }
    if (hasPinnedMap) {
      for (const [account, laneName] of Object.entries(legacyPinned)) {
        if (!names.has(laneName)) fail(`accounts.pinned: ${account} is pinned to lane ${laneName}, which is not in lanes`);
      }
    }
  }
  for (const job of parseQueue(o.queue, roster)) add(job);
  for (const [account, name] of Object.entries(legacyPinned)) {
    const job = jobs.find((j) => j.name === name);
    if (job === undefined) fail(`accounts.pinned: ${account} is pinned to ${name}, which is not a job`);
    if (job.account !== undefined && job.account.toUpperCase() !== account.toUpperCase()) {
      fail(`accounts.pinned: ${account} -> ${name} disagrees with the job's own account ${job.account}`);
    }
    if (job.account === undefined) fail(`accounts.pinned: ${account} -> ${name}, but that job carries no account — pin it on the job`);
  }
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
    if (accounts.pool.some((a) => a.toUpperCase() === job.account!.toUpperCase())) {
      fail(`accounts.pool: ${job.account} is also pinned to job ${job.name}`);
    }
    // Derived, enabled first so a disabled stand-in on a running job's
    // account (the burn switch) never hides the live one.
    const key = Object.keys(accounts.pinned).find((a) => a.toUpperCase() === job.account!.toUpperCase()) ?? job.account;
    if (accounts.pinned[key] === undefined || job.enabled) accounts.pinned[key] = job.name;
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
    }
  }
  if (jobs.some((j) => j.enabled && j.account === undefined) && accounts.pool.length === 0) {
    fail("queue has enabled pool jobs but accounts.pool is empty — nothing could ever run them");
  }
  const { policy, maxConcurrent } = parsePolicy(o.policy);
  return { notes, preflight, accounts, roster, jobs, policy, maxConcurrent, legacyLanes };
}

/**
 * One lane of a legacy `lanes` list, exactly as the pre-job code read it.
 * `accountOf` answers for the pool-era shape (accounts.pinned); undefined
 * means the lane names its own account (pre-pool shape).
 */
function parseLegacyLane(l: Partial<FleetLane>, accountOf: (name: string) => string | undefined): FleetLane {
  if (typeof l !== "object" || l === null) fail("fleet config: lane is not an object");
  if (typeof l.name !== "string" || l.name.length === 0) fail("fleet config: lane without a name");
  if (typeof l.enabled !== "boolean") fail(`lane ${l.name}: enabled must be true or false`);
  const pinnedAccount = accountOf(l.name);
  if (pinnedAccount !== undefined) {
    if (l.account !== undefined && l.account.toUpperCase() !== pinnedAccount.toUpperCase()) {
      fail(`lane ${l.name}: account ${l.account} disagrees with accounts.pinned (${pinnedAccount})`);
    }
    l.account = pinnedAccount;
  }
  if (typeof l.account !== "string" || l.account.length === 0) fail(`lane ${l.name}: account is required`);
  const loop = l.loop ?? false;
  if (typeof loop !== "boolean") fail(`lane ${l.name}: loop must be true or false`);
  if (l.untilDefault !== undefined && !/^\d{1,2}:\d{2}$/.test(l.untilDefault)) {
    fail(`lane ${l.name}: untilDefault wants HH:MM, got ${String(l.untilDefault)}`);
  }
  const hasEntries = l.entries !== undefined;
  const hasFile = l.rosterFile !== undefined;
  if (hasEntries === hasFile) fail(`lane ${l.name}: exactly one of entries or rosterFile`);
  if (l.objective !== undefined && (typeof l.objective !== "string" || l.objective.length === 0)) {
    fail(`lane ${l.name}: objective must be a non-empty string`);
  }
  if (l.wikiCoords !== undefined && typeof l.wikiCoords !== "boolean") {
    fail(`lane ${l.name}: wikiCoords must be a boolean`);
  }
  if (l.watchdogs !== undefined) {
    const parsed = watchdogOverrideSchema.safeParse(l.watchdogs);
    if (!parsed.success) fail(`lane ${l.name}: watchdogs — ${parsed.error.message}`);
  }
  if (
    l.maxToolCalls !== undefined &&
    (typeof l.maxToolCalls !== "number" || !Number.isInteger(l.maxToolCalls) || l.maxToolCalls <= 0)
  ) {
    fail(`lane ${l.name}: maxToolCalls must be a positive integer`);
  }
  const lane: FleetLane = {
    name: l.name,
    enabled: l.enabled,
    account: l.account,
    loop,
    ...(l.untilDefault !== undefined ? { untilDefault: l.untilDefault } : {}),
    ...(hasFile ? { rosterFile: l.rosterFile } : {}),
    ...(l.objective !== undefined ? { objective: l.objective } : {}),
    ...(l.watchdogs !== undefined ? { watchdogs: l.watchdogs } : {}),
    ...(l.maxToolCalls !== undefined ? { maxToolCalls: l.maxToolCalls } : {}),
    ...(l.wikiCoords !== undefined ? { wikiCoords: l.wikiCoords } : {}),
  };
  if (hasEntries) lane.entries = validateEntries(lane, l.entries);
  return lane;
}

/**
 * A legacy lane as a pinned job. It keeps its name, account and loop/once
 * semantics, and carries the lane itself so its entries spawn verbatim — no
 * episode tier is folded in (its entries say what they say; an entry's own
 * `episode` field still reaches the runner).
 */
export function legacyJob(lane: FleetLane): FleetJob {
  const episode = (lane.entries ?? []).map((e) => e.episode).find((e): e is EpisodeId => (EPISODE_IDS as readonly string[]).includes(e ?? ""));
  return {
    refs: [],
    ref: lane.name,
    episode: episode ?? "freeplay",
    repeat: lane.loop ? "loop" : 1,
    name: lane.name,
    enabled: lane.enabled,
    account: lane.account,
    source: "legacy",
    legacy: lane,
  };
}

function parseAccounts(raw: unknown): FleetAccounts {
  if (raw === undefined) return { pinned: {}, pool: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("fleet config: accounts must be a JSON object");
  const o = raw as { pinned?: unknown; pool?: unknown };
  // `pinned` is legacy input (account -> lane/job name): accepted so the
  // pool-era file loads, cross-checked against the jobs, never authored anew.
  const pinned: Record<string, string> = {};
  if (o.pinned !== undefined) {
    if (typeof o.pinned !== "object" || o.pinned === null || Array.isArray(o.pinned)) {
      fail("accounts.pinned must be an object of account -> job name (legacy; pin the account on the job instead)");
    }
    for (const [account, lane] of Object.entries(o.pinned as Record<string, unknown>)) {
      if (typeof lane !== "string" || lane.length === 0) fail(`accounts.pinned: ${account} needs a job name`);
      if (account.length === 0) fail("accounts.pinned: empty account name");
      pinned[account] = lane;
    }
  }
  const seenLanes = new Set<string>();
  for (const lane of Object.values(pinned)) {
    if (seenLanes.has(lane)) fail(`accounts.pinned: ${lane} is pinned to two accounts — one job, one account`);
    seenLanes.add(lane);
  }
  const pool: string[] = [];
  if (o.pool !== undefined) {
    if (!Array.isArray(o.pool)) fail("accounts.pool must be an array of account names");
    for (const a of o.pool as unknown[]) {
      if (typeof a !== "string" || a.length === 0) fail("accounts.pool: entries are account names");
      if (pool.some((p) => p.toUpperCase() === a.toUpperCase())) fail(`accounts.pool: ${a} listed twice`);
      if (Object.keys(pinned).some((p) => p.toUpperCase() === a.toUpperCase())) {
        fail(`accounts.pool: ${a} is also pinned (to ${pinned[a] ?? "a job"})`);
      }
      pool.push(a);
    }
  }
  return { pinned, pool };
}

function parseRoster(raw: unknown): Record<string, FleetRosterEntry> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("fleet config: roster must be an object of name -> entry");
  const out: Record<string, FleetRosterEntry> = {};
  for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
    if (name.length === 0 || !/^[A-Za-z0-9._-]+$/.test(name)) fail(`roster: entry name ${JSON.stringify(name)} must be [A-Za-z0-9._-]+`);
    if (typeof e !== "object" || e === null || Array.isArray(e)) fail(`roster ${name}: entry must be an object`);
    const { tiers: rawTiers, runsPerEpisode: rawRuns, billing: rawBilling, ...rest } = e as { tiers?: unknown; runsPerEpisode?: unknown; billing?: unknown } & Record<string, unknown>;
    if (rawBilling !== undefined && rawBilling !== "free" && rawBilling !== "paid") fail(`roster ${name}: billing must be "free" or "paid" (normally absent: it is derived)`);
    // Absent means "no force": eligibility comes from run history (ADR-0034).
    const tiers = rawTiers === undefined ? [] : rawTiers;
    if (!Array.isArray(tiers) || !tiers.every((t) => (EPISODE_IDS as readonly string[]).includes(t as string))) {
      fail(`roster ${name}: tiers must be an array of ${EPISODE_IDS.join("|")}`);
    }
    const runsPerEpisode = parseRunsPerEpisode(rawRuns, `roster ${name}: runsPerEpisode`);
    if (rest["account"] !== undefined) fail(`roster ${name}: an entry must not pin an account — pin the job that references it`);
    // Lane-policy checks are per entry; the pseudo-lane is only there for the
    // error message and the account-agreement check (vacuous here).
    const [validated] = validateEntries({ name: `roster:${name}`, enabled: true, account: "-", loop: false }, [rest]);
    out[name] = {
      ...validated!,
      tiers: tiers as EpisodeId[],
      ...(runsPerEpisode !== undefined ? { runsPerEpisode } : {}),
      ...(rawBilling !== undefined ? { billing: rawBilling as Billing } : {}),
    };
  }
  return out;
}

/**
 * The file's `policy` block: targets, the per-driver concurrency cap, the
 * paid policy and the extras policy are configurable (`parsePolicyBlock` in
 * runner/src/models.ts is the one parser; the viewer reads the same); the
 * ladder and the promotion level are code. The series is this checkout's.
 */
function parsePolicy(raw: unknown): { policy: SchedulingPolicy; maxConcurrent: Record<string, number> } {
  const { maxConcurrent, ...policy } = parsePolicyBlock(raw, currentSeries());
  return { policy, maxConcurrent };
}

/** The roster as the projection reads it: ordered, named, with the two overrides. */
export function rosterModels(roster: Record<string, FleetRosterEntry>): RosterModel[] {
  return Object.entries(roster).map(([name, e]) => ({
    name,
    model: e.model,
    ...(e.effort !== undefined ? { effort: e.effort } : {}),
    ...(e.driver !== undefined ? { driver: e.driver } : {}),
    ...(e.apiBase !== undefined ? { apiBase: e.apiBase } : {}),
    ...(e.tiers.length > 0 ? { tiers: e.tiers } : {}),
    ...(e.runsPerEpisode !== undefined ? { runsPerEpisode: e.runsPerEpisode } : {}),
    ...(e.billing !== undefined ? { billing: e.billing } : {}),
  }));
}

/**
 * The roster names the policy may schedule: not referenced by a pinned job
 * (that account is spoken for, and a probe's runs are not the model's
 * evidence), and not carrying an objective (an objective stamps every run
 * unscored, and the policy schedules evidence).
 */
export function policyRefs(config: Pick<FleetConfig, "jobs" | "roster">): Set<string> {
  const pinned = pinnedRefs(config);
  return new Set(Object.entries(config.roster).filter(([n, e]) => !pinned.has(n) && e.objective === undefined).map(([n]) => n));
}

/** Why a roster name is outside the policy, or undefined when it is inside. */
export function policyExclusion(config: Pick<FleetConfig, "jobs" | "roster">, name: string): string | undefined {
  const job = pinnedJobs(config).find((j) => j.refs.includes(name));
  if (job !== undefined) return `pinned to ${job.account} by job ${job.name}`;
  if (config.roster[name]?.objective !== undefined) return "carries an objective (unscored probe)";
  return undefined;
}

/** The driver a roster name runs on, for the concurrency cap. */
export function driverOf(roster: Record<string, FleetRosterEntry>, name: string): string {
  return normalizeDriver(roster[name]?.driver ?? "openai") ?? "openai";
}

/** An eligibility predicate over the projection, for planQueue / runnableRefs. */
export type Eligible = (ref: string, episode: EpisodeId) => boolean;

export function eligibleFrom(states: readonly ModelState[]): Eligible {
  const by = new Map(states.map((s) => [s.name, s]));
  return (ref, ep) => ep === "freeplay" || (by.get(ref)?.eligible.includes(ep) ?? false);
}

function parseQueue(raw: unknown, roster: Record<string, FleetRosterEntry>): FleetJob[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("fleet config: queue must be an array of jobs");
  const out: FleetJob[] = [];
  for (const j of raw as (Partial<FleetJob> & { lane?: unknown })[]) {
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
    // `lane` is the pre-job name field: read and ignored — the name is derived.
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
   * Who may run what. Default: the roster's `tiers` (a manual force). The
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
            : `${job.ref} is not eligible for ${job.episode} (no e90 run reached level 5 yet; force it with roster.<name>.tiers)`,
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
 * into the tier (`freeplay` is unscored and needs no promotion). A job runs
 * with whatever subset passes; a ref gated out is dropped from that job's
 * roster, and the skip reason names it only when nothing is left.
 */
export function runnableRefs(job: FleetJob, roster: Record<string, FleetRosterEntry>, eligible?: Eligible): string[] {
  return job.refs.filter((r) => {
    const e = roster[r];
    if (e === undefined) return false;
    // A policy job was made from the projection that answers eligibility; it is its own witness.
    if (job.attempt !== undefined) return true;
    // e90 is every model's on arrival (ADR-0034); freeplay is unscored and needs no promotion.
    if (job.episode === "freeplay" || job.episode === "e90" || e.tiers.includes(job.episode)) return true;
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
    name: `${pick.name}-${pick.episode}`,
    enabled: true,
    source: "policy",
    attempt: pick.attempt,
    ...(pick.extra !== undefined ? { extra: pick.extra } : {}),
  };
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
 * model. `concurrency` is the per-driver cap: `running` counts every stream
 * in flight on that driver, pinned jobs included, so a subscription that
 * tolerates two sessions is a number in the file rather than a model removed
 * from the roster. `paid` is the paid cap (`policy.paid.maxConcurrent`):
 * `running` counts paid policy models in flight (pinned jobs excluded), and a
 * paid pick over the cap is held, with the reason in `held` for `--dry-run`.
 */
export function planPolicy(opts: {
  states: readonly ModelState[];
  pool: string[];
  running: Map<string, string>;
  held: (account: string) => string | undefined;
  queuePlan: QueuePlan;
  runningRefs: ReadonlySet<string>;
  concurrency?: { driverOf: (name: string) => string; max: Record<string, number>; running: ReadonlyMap<string, number> };
  policy?: SchedulingPolicy;
  /** Paid policy models already in flight (pinned jobs excluded). */
  paidRunning?: number;
}): PolicyPick[] {
  return planPolicyHeld(opts).picks;
}

/** `planPolicy` plus what it held back and why. */
export function planPolicyHeld(opts: Parameters<typeof planPolicy>[0]): { picks: PolicyPick[]; held: HeldPick[] } {
  if (opts.queuePlan.waiting.length > 0) return { picks: [], held: [] };
  const taken = new Set([...opts.running.values(), ...opts.queuePlan.assign.map((a) => a.account)].map((a) => a.toUpperCase()));
  const free = opts.pool.filter((a) => !taken.has(a.toUpperCase()) && opts.held(a) === undefined);
  if (free.length === 0) return { picks: [], held: [] };
  const running = new Set(opts.runningRefs);
  for (const a of opts.queuePlan.assign) for (const r of a.job.refs) running.add(r);
  const wrap = (pick: NextJob): PolicyPick => ({ job: policyJob(pick), account: pick.account, why: pick.why });
  const billingOf = new Map(opts.states.map((s) => [s.name, s.billing]));
  const next = (states: readonly ModelState[], accounts: readonly string[], also: readonly NextJob[]): ReturnType<typeof planNextJobs> =>
    planNextJobs(states, accounts, new Set([...running, ...also.map((p) => p.name)]), {
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      paidRunning: (opts.paidRunning ?? 0) + also.filter((p) => billingOf.get(p.name) === "paid").length,
    });
  if (opts.concurrency === undefined) {
    const plan = next(opts.states, free, []);
    return { picks: plan.jobs.map(wrap), held: plan.held };
  }
  // The cap, over the projection's own priority order: a pick whose driver is
  // full is passed over and the next candidate is asked for its account, until
  // a round yields nothing to pass over.
  const { driverOf, max } = opts.concurrency;
  const count = new Map(opts.concurrency.running);
  for (const a of opts.queuePlan.assign) for (const r of a.job.refs) count.set(driverOf(r), (count.get(driverOf(r)) ?? 0) + 1);
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
      const d = driverOf(pick.name);
      const cap = max[d];
      if (cap !== undefined && (count.get(d) ?? 0) >= cap) {
        passed.add(pick.name);
        held.push({ name: pick.name, episode: pick.episode, why: `driver cap: ${d} <= ${cap}, ${count.get(d) ?? 0} in flight` });
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
  // Accounts in preference order over the final picks, as an uncapped round would give.
  return { picks: out.map((pick, i) => wrap({ ...pick, account: free[i]! })), held };
}

/**
 * A job as the lane the spawner runs: the roster entries with the episode's
 * dimensions folded in, `repeat: n` as n copies with their own run ids
 * (`-r2`, `-r3`, ...) so one roster process runs them in sequence,
 * `repeat: "loop"` as run-roster's own --loop. `tiers` never reaches the
 * roster file. A legacy job is its lane, verbatim, on the account given.
 */
export function jobLane(job: FleetJob, roster: Record<string, FleetRosterEntry>, account: string, stamp: string, eligible?: Eligible): FleetLane {
  if (job.legacy !== undefined) return { ...job.legacy, account, enabled: job.enabled };
  const dims = episodeDimensions(job.episode);
  const copies = job.repeat === "loop" ? 1 : job.repeat;
  const entries: RosterSpec[] = [];
  for (const r of runnableRefs(job, roster, eligible)) {
    const { tiers: _tiers, runsPerEpisode: _runs, billing: _billing, ...spec } = roster[r]!;
    const base: RosterSpec = {
      ...spec,
      ...dims,
      watchdogs: { ...dims.watchdogs, ...spec.watchdogs },
      ...(spec.maxToolCalls !== undefined ? { maxToolCalls: spec.maxToolCalls } : {}),
      // An extra run rolls the policy's character and is stamped as an extra.
      ...(job.extra !== undefined ? { race: job.extra.race, class: job.extra.class, extra: true } : {}),
    };
    const runId =
      `fleet-${job.name}-${slug(base.model)}${base.effort !== undefined ? `-${slug(base.effort)}` : ""}-${stamp}` +
      (job.attempt !== undefined && job.attempt > 1 ? `-a${job.attempt}` : "");
    for (let k = 1; k <= copies; k++) {
      entries.push(k === 1 ? (job.attempt !== undefined && job.attempt > 1 ? { ...base, runId } : base) : { ...base, runId: `${runId}-r${k}` });
    }
  }
  if (entries.length === 0) fail(`job ${job.name}: no ref of ${job.ref} is eligible for ${job.episode}`);
  return {
    name: job.name,
    enabled: job.enabled,
    account,
    loop: job.repeat === "loop",
    entries,
  };
}

/**
 * Re-read the config during supervision. A broken edit must never take down
 * running lanes, so any error keeps the last good config and is reported.
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
      ` lane enabled flags in the file are NOT in effect`,
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
 * A lane's entries, stamped with the lane account and fleet-scoped run ids
 * (`fleet-<lane>-<model-slug>[-<effort>]-<date>`) so fleet runs never share a
 * run id with hand-launched rosters or with another lane.
 */
export function fillEntries(lane: FleetLane, entries: RosterSpec[], stamp: string): RosterSpec[] {
  return entries.map((e) => ({
    ...e,
    account: lane.account,
    // Lane defaults, entry wins. `watchdogs` merges key-by-key so a lane can
    // set a long episode while one entry tightens `idleMs`.
    ...((e.objective ?? lane.objective) !== undefined
      ? { objective: (e.objective ?? lane.objective)! }
      : {}),
    ...(lane.watchdogs !== undefined || e.watchdogs !== undefined
      ? { watchdogs: { ...lane.watchdogs, ...e.watchdogs } }
      : {}),
    ...((e.maxToolCalls ?? lane.maxToolCalls) !== undefined
      ? { maxToolCalls: (e.maxToolCalls ?? lane.maxToolCalls)! }
      : {}),
    ...((e.wikiCoords ?? lane.wikiCoords) !== undefined
      ? { wikiCoords: (e.wikiCoords ?? lane.wikiCoords)! }
      : {}),
    runId:
      e.runId ??
      `fleet-${lane.name}-${slug(e.model)}${e.effort !== undefined ? `-${slug(e.effort)}` : ""}-${stamp}`,
  }));
}

/** Load and validate a lane's entries, wherever they live. */
export function loadLaneEntries(
  lane: FleetLane,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): RosterSpec[] {
  if (lane.entries !== undefined) return lane.entries;
  const path = isAbsolute(lane.rosterFile!) ? lane.rosterFile! : join(REPO_ROOT, lane.rosterFile!);
  let raw: unknown;
  try {
    raw = JSON.parse(read(path));
  } catch (e) {
    fail(`lane ${lane.name}: cannot read rosterFile ${lane.rosterFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateEntries(lane, raw);
}

export function laneRosterPath(lane: string, stamp: string): string {
  return join(RUNS_DIR, `fleet-${lane}-${stamp}.roster.json`);
}
export function laneJsonlPath(lane: string, stamp: string): string {
  return join(RUNS_DIR, `fleet-${lane}-${stamp}.jsonl`);
}
export function laneStdoutPath(lane: string, stamp: string): string {
  return join(RUNS_DIR, `fleet-${lane}-${stamp}.log`);
}

/** The exact run-roster argv for one lane. Pure; tested. */
export function laneArgv(
  lane: FleetLane,
  opts: { stamp: string; until: string | undefined; resumeRoster?: boolean },
): string[] {
  const until = opts.until ?? lane.untilDefault;
  const argv = [
    ROSTER_SH,
    laneRosterPath(lane.name, opts.stamp),
    "--log",
    laneJsonlPath(lane.name, opts.stamp),
    "--date",
    opts.stamp,
  ];
  if (lane.loop) argv.push("--loop");
  if (until !== undefined) argv.push("--until", until);
  if (opts.resumeRoster === true) argv.push("--resume-roster");
  return argv;
}

/**
 * The stop condition for one lane, or none. A loop lane without one used to be
 * refused; under the fleet service that is the normal case — the supervisor is
 * up while the machine is up and lanes are steered by editing fleet.json, not
 * by a wall clock. `--until` and `untilDefault` remain as optional caps.
 */
export function laneUntil(lane: FleetLane, cliUntil: string | undefined): string | undefined {
  return cliUntil ?? lane.untilDefault;
}

// ------------------------------------------------------------------ diffing

export interface LaneSets {
  /** lanes with a live roster process */
  running: Set<string>;
  /** running lanes waiting for an episode boundary to be SIGTERMed */
  draining: Set<string>;
  /** lanes whose process exited while enabled (done; not respawned) */
  finished: Set<string>;
}

export interface LaneActions {
  start: FleetLane[];
  drain: string[];
  undrain: string[];
  /** finished lanes now disabled: forget them so a later re-enable respawns */
  rearm: string[];
}

/** What the supervisor should do to make reality match the config. Pure. */
export function diffLanes(lanes: FleetLane[], sets: LaneSets): LaneActions {
  const actions: LaneActions = { start: [], drain: [], undrain: [], rearm: [] };
  const byName = new Map(lanes.map((l) => [l.name, l]));
  for (const lane of lanes) {
    if (lane.enabled && sets.running.has(lane.name) && sets.draining.has(lane.name)) {
      actions.undrain.push(lane.name);
      continue;
    }
    if (lane.enabled && !sets.running.has(lane.name) && !sets.finished.has(lane.name)) {
      actions.start.push(lane);
      continue;
    }
    if (!lane.enabled && sets.finished.has(lane.name)) actions.rearm.push(lane.name);
  }
  for (const name of sets.running) {
    const lane = byName.get(name);
    if ((lane === undefined || !lane.enabled) && !sets.draining.has(name)) actions.drain.push(name);
  }
  return actions;
}

/**
 * Should the tick loop end? Only when a deadline was asked for.
 *
 * "Nothing running and nothing to start" is a terminal state for a one-shot
 * host run (`--until 18:00`, lanes finish, exit). It is NOT one for the fleet
 * SERVICE: the config is hot, so a lane can be enabled on any tick, and
 * `restart: unless-stopped` restarts on exit 0 as readily as on a crash. A
 * supervisor that exited when the operator parked every lane — which is exactly
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

/** May lanes be spawned given the gate's own last word? Pure. */
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
  const verdict = rec.skipped === true ? "SKIPPED (gate open)" : rec.ok ? "PASS" : "FAIL — lanes blocked";
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
  episode: EpisodeId;
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
  /** An extra run (ADR-0034), with the character it rolls. */
  extra?: StartingCharacter;
}

/** What an account is doing right now, for the accounts table. */
export type AccountRow =
  | { account: string; kind: "pinned" | "pool"; job: JobRow }
  | { account: string; kind: "pinned" | "pool"; free: true; note?: string };

const fmtElapsed = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/**
 * --status / --dry-run: one row per account — pinned first, then the pool in
 * preference order — with the job on it (model, episode, run id, level/xp,
 * elapsed) or free/cooling. Pure over rows the caller assembled.
 */
export function formatAccounts(rows: readonly AccountRow[]): string[] {
  const out: string[] = [`accounts: ${rows.filter((r) => r.kind === "pinned").length} pinned, ${rows.filter((r) => r.kind === "pool").length} pool`];
  const w = Math.max(9, ...rows.map((r) => r.account.length));
  for (const r of rows) {
    const head = `  ${r.account.padEnd(w)} ${r.kind.padEnd(6)} `;
    if ("free" in r) {
      out.push(`${head}free${r.note !== undefined ? ` — ${r.note}` : ""}`);
      continue;
    }
    const j = r.job;
    const what = `${j.name}: ${j.models.join("+")} ${j.episode}${j.attempt !== undefined && j.attempt > 1 ? ` attempt ${j.attempt}` : ""}${j.extra !== undefined ? ` extra (race ${j.extra.race} class ${j.extra.class})` : ""}`;
    if (j.planned === true) {
      out.push(`${head}${what} — would spawn${j.runId !== undefined ? ` as ${j.runId}` : ""}`);
      continue;
    }
    const prog = j.level !== undefined ? `L${j.level} ${j.xp ?? 0}xp` : "no state rows yet";
    const run = j.runId !== undefined ? `${j.runId} — ${prog}` : "no run launched yet";
    out.push(`${head}${what} — ${run}${j.elapsedMs !== undefined ? `, ${fmtElapsed(j.elapsedMs)}` : ""}${j.cooling !== undefined ? ` — ${j.cooling}` : ""}`);
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
    `models: ${states.length} in roster (policy: ADR-0034; series ${series}${policy.series === null ? " — unversioned checkout, every series counts" : ""}; ladder ${LADDER_MS.length} rungs to ${Math.round(LADDER_MS[LADDER_MS.length - 1]! / 3_600_000)}h` +
      `${policy.paid !== null ? `; paid ${policy.paid.runsPerEpisode.e90}/${policy.paid.runsPerEpisode.e360}, at most ${policy.paid.maxConcurrent} in flight` : "; no paid/free split"}` +
      `${policy.extras !== null ? `; extras cycle ${policy.extras.characters.length} character(s)` : "; no extras"})`,
    `  ${"model".padEnd(w)} ${"billing".padEnd(7)} ${"status".padEnd(8)} ${"e90".padEnd(12)} ${"e360".padEnd(12)} ${"extras".padEnd(6)} schedulable`,
  ];
  const ago = (ms: number | null): string => (ms === null ? "never" : `${Math.round((now - ms) / 60_000)}m ago`);
  const cell = (s: ModelState, ep: "e90" | "e360"): string => {
    const st = s.perEpisode[ep]!;
    if (!s.eligible.includes(ep)) return "-";
    return `${st.counted}/${st.target}${st.stillborn > 0 ? `+${st.stillborn}sb` : ""}${st.bestLevel !== null ? ` L${st.bestLevel}` : ""}`;
  };
  for (const s of states) {
    const ex = excluded.get(s.name);
    const last = (["e90", "e360"] as const).map((ep) => s.perEpisode[ep]!).filter((st) => st.lastEnded !== null).sort((a, b) => b.lastEnded! - a.lastEnded!)[0];
    const sched = ex !== undefined ? `no: ${ex}` : ((v) => `${v.ok ? "yes" : "no"}: ${v.why}`)(schedulability(s, running, policy));
    const extras = (["e90", "e360"] as const).reduce((n, ep) => n + (s.perEpisode[ep]?.extras ?? 0), 0);
    const other = (["e90", "e360"] as const).reduce((n, ep) => n + (s.perEpisode[ep]?.otherSeries ?? 0), 0);
    out.push(
      `  ${s.name.padEnd(w)} ${s.billing.padEnd(7)} ${(ex !== undefined ? "pinned" : s.status).padEnd(8)} ${cell(s, "e90").padEnd(12)} ${cell(s, "e360").padEnd(12)} ${String(extras).padEnd(6)} ${sched}` +
        (last !== undefined && ex === undefined ? ` — last ${last.lastReason ?? "unterminated"} ${ago(last.lastEnded)}` : "") +
        (s.ladder > 0 ? ` — ladder ${s.ladder}` : "") +
        (other > 0 ? ` — ${other} run(s) from other series not counted` : ""),
    );
  }
  return out;
}

/** `--dry-run`: the picks the policy held back and why. Pure. */
export function formatHeld(held: readonly HeldPick[]): string[] {
  return held.map((h) => `  ${h.name}: HELD — ${h.episode} wanted, ${h.why}`);
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
function record(entry: { lane: string; event: string; detail?: string }): void {
  if (fleetLog === "") return;
  mkdirSync(dirname(fleetLog), { recursive: true });
  appendFileSync(fleetLog, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

function dateStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${stamp2(d.getMonth() + 1)}${stamp2(d.getDate())}`;
}

// ------------------------------------------------------------------ process

interface LaneProc {
  lane: FleetLane;
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
   * outside observer (deploy-worldserver.sh) tells "smoking now, wait for the
   * verdict" from "not gating at all" without racing a second smoke onto the
   * same account.
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
  };
  /** The manual queue's shape, present only when the file has one. */
  queue?: {
    depth: number;
    running: string[];
    waiting: string[];
    finished: string[];
    skipped: { name: string; reason: string }[];
  };
  /** Every job with a live process: the one concept (ADR-0034). */
  jobs?: Record<string, { ref: string; episode: EpisodeId; account: string; source: JobSource; attempt?: number; extra?: StartingCharacter; models: string[] }>;
  /** Why the last tick spawned nothing from the policy, when it did not. */
  policy?: {
    idle?: string;
    /** Pre-job supervisors wrote the policy's running jobs here; read, never written. */
    jobs?: Record<string, { ref: string; episode: EpisodeId; account: string; attempt: number }>;
  };
  /** Counters since the supervisor started. */
  session?: { finished: number; ok: number; retried: number };
  lanes: Record<
    string,
    {
      pid: number;
      account: string;
      /** Repo-relative since ADR-0020; older states carry absolute host paths. */
      rosterPath: string;
      jsonl: string;
      stdoutLog: string;
      spawnedAt: number;
      exitCode: number | null;
      draining: boolean;
      /** The supervisor's own view of the lane process; see resolveStatePath. */
      alive?: boolean;
    }
  >;
}

/**
 * Resolve a path recorded in fleet-state.json against THIS side of the mount.
 *
 * The supervisor writes repo-relative paths so `--status` works from the host
 * while the state was written in the container (where REPO_ROOT is
 * /wrathbench). A state written by an older, host-side supervisor carries
 * absolute host paths: honour those when they exist, otherwise fall back to the
 * path recomputed locally from the lane name and stamp. Pure, so the mapping is
 * testable without a live fleet.
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
}

function writeState(
  configPath: string,
  stampToday: string,
  procs: Map<string, LaneProc>,
  draining: Set<string>,
  preflight?: PreflightRecord,
  pool?: PoolView,
): void {
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
          jobs: Object.fromEntries(
            [...pool.jobs].map(([name, j]) => [
              name,
              {
                ref: j.ref,
                episode: j.episode,
                account: pool.assigned.get(name) ?? j.account ?? "-",
                source: j.source,
                ...(j.attempt !== undefined ? { attempt: j.attempt } : {}),
                ...(j.extra !== undefined ? { extra: j.extra } : {}),
                models: (procs.get(name)?.lane.entries ?? []).map((e) => e.model),
              },
            ]),
          ),
          policy: { ...(pool.policyIdle !== undefined ? { idle: pool.policyIdle } : {}) },
          session: pool.session,
        }
      : {}),
    lanes: {},
  };
  for (const [name, p] of procs) {
    state.lanes[name] = {
      pid: p.pid,
      account: p.lane.account,
      rosterPath: relative(REPO_ROOT, laneRosterPath(name, stampToday)),
      jsonl: relative(REPO_ROOT, laneJsonlPath(name, stampToday)),
      stdoutLog: relative(REPO_ROOT, laneStdoutPath(name, stampToday)),
      spawnedAt: p.spawnedAt,
      exitCode: p.exitCode,
      draining: draining.has(name),
      alive: !p.exited,
    };
  }
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
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
 * Backed-off / tainted specs for one lane, straight off the roster's defer
 * sidecar. Read-only and tolerant: a lane mid-write (or no sidecar at all)
 * must degrade to "no rows", never break the status report for other lanes.
 */
function laneDefers(jsonl: string): { spec: string; entry: DeferEntry }[] {
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
 * Live episodes across every lane account, for scripts that must not run while
 * the world is busy (infra/deploy-worldserver.sh). Same signal --status shows:
 * the roster's own account-busy inference over the trajectory stores. Exit code
 * carries the answer so bash never parses this text.
 */
function printLiveRuns(configPath: string): number {
  const config = parseFleet(JSON.parse(readFileSync(configPath, "utf8")));
  // Lane accounts plus the gate's own and the ad-hoc debugging account: the
  // refusal claims "no episodes are live", and a PROBE session dies in a
  // recreate exactly like a lane's does.
  const accounts = [
    ...new Set([...Object.keys(config.accounts.pinned), ...config.accounts.pool, ...preflightAccounts(config.preflight), "PROBE"]),
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

/**
 * The running jobs as the state file tells them. A state written by a pre-job
 * supervisor has no `jobs` block: its lanes, `policy.jobs` and `queue.running`
 * are read instead, so --status on new code keeps reporting on an old
 * supervisor until the restart.
 */
export function liveJobsFromState(
  state: Pick<FleetState, "jobs" | "lanes" | "policy" | "queue" | "accounts"> | undefined,
  config: Pick<FleetConfig, "jobs" | "roster"> | undefined,
): Map<string, { ref: string; episode: EpisodeId; account: string; source: JobSource; attempt?: number; extra?: StartingCharacter; models: string[] }> {
  const out = new Map<string, { ref: string; episode: EpisodeId; account: string; source: JobSource; attempt?: number; extra?: StartingCharacter; models: string[] }>();
  if (state === undefined) return out;
  if (state.jobs !== undefined) {
    for (const [name, j] of Object.entries(state.jobs)) out.set(name, j);
    return out;
  }
  for (const [name, l] of Object.entries(state.lanes ?? {})) {
    if (l.alive !== true) continue;
    const pj = state.policy?.jobs?.[name];
    const fromFile = config?.jobs.find((j) => j.name === name);
    const ref = pj?.ref ?? fromFile?.ref ?? name;
    const models =
      pj !== undefined
        ? [config?.roster[pj.ref]?.model ?? pj.ref]
        : fromFile !== undefined
          ? fromFile.legacy !== undefined
            ? (fromFile.legacy.entries ?? []).map((e) => e.model)
            : fromFile.refs.map((r) => config!.roster[r]?.model ?? r)
          : [];
    out.set(name, {
      ref,
      episode: pj?.episode ?? fromFile?.episode ?? ("freeplay" as EpisodeId),
      account: l.account,
      source: pj !== undefined ? "policy" : fromFile?.source ?? "legacy",
      ...(pj !== undefined ? { attempt: pj.attempt } : {}),
      models,
    });
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
  const live = liveJobsFromState(state, config);
  const jobRow = (name: string, j: { ref: string; episode: EpisodeId; source: JobSource; attempt?: number; models: string[] }): JobRow => {
    const ls = state?.lanes[name];
    const alive = ls === undefined ? false : hbAgeMs !== undefined ? fleetUp && ls.alive === true : pidAlive(ls.pid);
    const row: JobRow = { name, models: j.models.length > 0 ? j.models : [j.ref], episode: j.episode, ...(j.attempt !== undefined ? { attempt: j.attempt } : {}) };
    if (ls === undefined) return row;
    const stdoutLog = resolveStatePath(ls.stdoutLog, laneStdoutPath(name, state!.stamp));
    const jsonl = resolveStatePath(ls.jsonl, laneJsonlPath(name, state!.stamp));
    const runId = lastLaunchedRunId(stdoutLog);
    if (runId !== undefined) {
      row.runId = runId;
      const prog = runProgress(runId);
      if (prog !== undefined) {
        row.level = prog.level;
        row.xp = prog.xp;
        row.elapsedMs = Date.now() - (prog.startedAt ?? ls.spawnedAt);
      } else {
        row.elapsedMs = Date.now() - ls.spawnedAt;
      }
    }
    const defers = laneDefers(jsonl);
    const tainted = defers.find((d) => d.entry.tainted === true);
    const cooling = defers.find((d) => d.entry.tainted !== true && d.entry.notBefore > Date.now());
    if (tainted !== undefined) row.cooling = `tainted: ${tainted.spec} (${tainted.entry.defers} defers, ${tainted.entry.reason})`;
    else if (cooling !== undefined) row.cooling = `cooling until ${new Date(cooling.entry.notBefore).toLocaleTimeString()} (${cooling.entry.reason})`;
    if (!alive) row.cooling = `${row.cooling !== undefined ? `${row.cooling}; ` : ""}process ${ls.exitCode !== null ? `exited ${ls.exitCode}` : "dead"}`;
    return row;
  };
  const byAccount = new Map<string, { name: string; j: ReturnType<typeof liveJobsFromState> extends Map<string, infer V> ? V : never }>();
  for (const [name, j] of live) byAccount.set(j.account.toUpperCase(), { name, j });
  const pinnedAccounts = config !== undefined ? Object.keys(config.accounts.pinned) : Object.keys(state?.accounts?.pinned ?? {});
  const poolAccounts = config !== undefined ? config.accounts.pool : Object.keys(state?.accounts?.pool ?? {});
  const rows: AccountRow[] = [];
  for (const [kind, accounts] of [["pinned", pinnedAccounts], ["pool", poolAccounts]] as const) {
    for (const account of accounts) {
      const on = byAccount.get(account.toUpperCase());
      if (on !== undefined) {
        rows.push({ account, kind, job: jobRow(on.name, on.j) });
        continue;
      }
      // Honesty about the account itself: a hand-started run holds it just as
      // hard as a fleet one would. Same liveness inference as the roster guard.
      const holder = accountHeldBy(account, "");
      let note: string | undefined;
      if (holder !== undefined) {
        const prog = runProgress(holder);
        note = `held by run ${holder}${prog !== undefined ? ` (L${prog.level}, ${prog.xp} xp)` : ""} — not fleet-managed`;
      } else if (kind === "pinned" && config !== undefined) {
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
      console.log(`  concurrency: ${Object.entries(config.maxConcurrent).map(([d, n]) => `${d} <= ${n}`).join(", ")} (every job on the driver counts)`);
    }
    if (state?.policy?.idle !== undefined) console.log(`  policy: ${state.policy.idle}`);
  }

  // (d) the session.
  const sess = state?.session;
  console.log(
    sess === undefined
      ? "  finished this session: (not reported by this supervisor)"
      : `  finished this session: ${sess.finished} (ok ${sess.ok}, retried ${sess.retried})`,
  );

  // (e) the manual queue, only when there is one.
  if (config !== undefined) for (const line of formatQueue(poolJobs(config), state?.queue)) console.log(`  ${line}`);

  // A /proc scan only means anything when the supervisor shares this namespace.
  // Against a containerized fleet every lane would show up here as "hand
  // started" (host pids, container pids in the state file) — pure noise.
  const foreign =
    state?.containerized === true
      ? []
      : foreignRosters(new Set(Object.values(state?.lanes ?? {}).map((l) => l.pid)));
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
export function planTick(config: FleetConfig, states: readonly ModelState[], held: (a: string) => string | undefined, stamp: string): {
  pinned: { job: FleetJob; lane: FleetLane }[];
  queue: QueuePlan;
  policy: PolicyPick[];
  /** Picks the policy wanted but held back (paid cap, driver cap), with why. */
  heldPicks: HeldPick[];
} {
  const eligible = eligibleFrom(states);
  const pinned = pinnedJobs(config)
    .filter((j) => j.enabled && (j.legacy !== undefined || runnableRefs(j, config.roster, eligible).length > 0))
    .map((job) => ({ job, lane: jobLane(job, config.roster, job.account!, stamp, eligible) }));
  const runningRefs = new Set(pinned.flatMap((p) => p.job.refs));
  const queue = planQueue({
    queue: poolJobs(config),
    roster: config.roster,
    pool: config.accounts.pool,
    running: new Map(),
    finished: new Set(),
    held,
    cooling: () => undefined,
    eligible,
    runningRefs,
  });
  const policyStates = states.filter((st) => policyRefs(config).has(st.name));
  const driverCount = new Map<string, number>();
  for (const r of runningRefs) driverCount.set(driverOf(config.roster, r), (driverCount.get(driverOf(config.roster, r)) ?? 0) + 1);
  const { picks: policy, held: heldPicks } = planPolicyHeld({
    states: policyStates,
    pool: config.accounts.pool,
    running: new Map(),
    held,
    queuePlan: queue,
    runningRefs,
    concurrency: { driverOf: (n) => driverOf(config.roster, n), max: config.maxConcurrent, running: driverCount },
    policy: config.policy,
    paidRunning: 0,
  });
  return { pinned, queue, policy, heldPicks };
}

function printDryRun(config: FleetConfig, cliUntil: string | undefined, stampToday: string): void {
  console.log(`--- fleet plan (dry run; nothing spawned, nothing written) ---`);
  if (config.legacyLanes.length > 0) console.log(`legacy lanes read as pinned jobs: ${config.legacyLanes.join(", ")}`);
  for (const line of formatGate(undefined, config.preflight)) console.log(line);
  if (config.preflight.enabled) {
    for (const s of config.preflight.smokes) console.log(`  would run: bun ${smokePath(s.script)} (account ${s.account})`);
    for (const s of config.preflight.deploySmokes) console.log(`  deploy-worldserver.sh only: bun ${smokePath(s.script)} (account ${s.account})`);
  } else {
    console.log("  gate open: jobs spawn without smoking the server first");
  }
  const states = modelStates({ runsDir: RUNS_DIR, roster: rosterModels(config.roster), policy: config.policy });
  const held = (a: string): string | undefined => accountHeldBy(a, "");
  const plan = planTick(config, states, held, stampToday);
  const rows: AccountRow[] = [];
  const argvs: string[] = [];
  const planned = (job: FleetJob, lane: FleetLane): JobRow => {
    const entries = fillEntries(lane, loadLaneEntries(lane), stampToday);
    argvs.push(`  ${job.name}: ${laneArgv(lane, { stamp: stampToday, until: cliUntil }).join(" ")}`);
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
  for (const account of Object.keys(config.accounts.pinned)) {
    const p = plan.pinned.find((x) => x.job.account!.toUpperCase() === account.toUpperCase());
    const holder = held(account);
    if (p !== undefined) rows.push({ account, kind: "pinned", job: planned(p.job, p.lane) });
    else {
      const job = pinnedJobs(config).find((j) => j.account?.toUpperCase() === account.toUpperCase());
      rows.push({ account, kind: "pinned", free: true, note: holder !== undefined ? `held by run ${holder}` : `job ${job?.name ?? "?"} disabled — flip enabled:true to spawn` });
    }
  }
  for (const account of config.accounts.pool) {
    const q = plan.queue.assign.find((a) => a.account === account);
    const pp = plan.policy.find((a) => a.account === account);
    const holder = held(account);
    if (q !== undefined) rows.push({ account, kind: "pool", job: planned(q.job, jobLane(q.job, config.roster, account, stampToday, eligibleFrom(states))) });
    else if (pp !== undefined) rows.push({ account, kind: "pool", job: { ...planned(pp.job, jobLane(pp.job, config.roster, account, stampToday)), name: `${pp.job.name} (policy: ${pp.why})` } });
    else rows.push({ account, kind: "pool", free: true, ...(holder !== undefined ? { note: `held by run ${holder}` } : {}) });
  }
  console.log("");
  for (const line of formatAccounts(rows)) console.log(line);
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
  if (Object.keys(config.maxConcurrent).length > 0) {
    console.log(`concurrency: ${Object.entries(config.maxConcurrent).map(([d, n]) => `${d} <= ${n}`).join(", ")} (every job on the driver counts)`);
  }
  console.log("finished this session: 0 (ok 0, retried 0) — dry run");
  for (const line of formatQueue(poolJobs(config), undefined)) console.log(line);
  console.log(
    `\n${plan.pinned.length} pinned job(s) would spawn now plus ${plan.queue.assign.length + plan.policy.length} pool job(s) over ${config.accounts.pool.length} pool account(s).` +
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
            "  --until HH:MM   stop condition passed to every lane (overridden by nothing;",
            "                  a lane's untilDefault applies when this is absent)",
            "  --dry-run       print what would spawn on every account right now; spawn nothing",
            "  --status        read-only: accounts, models and session report. Works from the",
            "                  host against a containerized supervisor (heartbeat, not kill -0)",
            "  --live-runs     read-only: list live episodes across the lane accounts and exit",
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
  return { config, dryRun, status, liveRuns, until, clearModel };
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
  // every run id, lane roster, lane log and defer sidecar hangs off it for the
  // life of the process — which under `restart: unless-stopped` is "until the
  // machine reboots". Rolling it at midnight would rename every lane's roster
  // and jsonl underneath a running lane and hand --resume-roster/freeCycle a
  // fresh namespace mid-flight; keeping it fixed leaves both semantics exactly
  // as they were. Roll it deliberately: stop the service, start it again.
  const stampToday = dateStamp();
  let config = parseFleet(JSON.parse(readFileSync(args.config, "utf8")));
  configLoadedAt = Date.now();
  if (config.legacyLanes.length > 0 && !args.dryRun) say(`legacy lanes read as pinned jobs: ${config.legacyLanes.join(", ")}`);
  // Fail fast on anything that would fail at spawn time.
  {
    const plan = planTick(config, modelStates({ runsDir: RUNS_DIR, roster: rosterModels(config.roster), policy: config.policy }), () => undefined, stampToday);
    for (const p of plan.pinned) loadLaneEntries(p.lane);
  }

  if (args.dryRun) {
    printDryRun(config, args.until, stampToday);
    return;
  }

  fleetLog = join(RUNS_DIR, `fleet-${stampToday}.jsonl`);
  const procs = new Map<string, LaneProc>();
  const sets: LaneSets = { running: new Set(), draining: new Set(), finished: new Set() };
  let stopping = false;
  let wasIdle = false;
  // Job bookkeeping (ADR-0034): which job holds which account, the job itself
  // for every live process, and the last plan's waiting/skipped rows for
  // --status. A skip reason is logged once per (job, reason), not once a tick.
  const assigned = new Map<string, string>();
  const liveJobs = new Map<string, FleetJob>();
  let lastPlan: QueuePlan = { assign: [], waiting: [], skipped: [] };
  const complainedSkips = new Map<string, string>();
  /** Jobs handed an account this tick, claimed by spawnLane; a gated tick re-plans next time. */
  const pending = new Map<string, FleetJob>();
  const announcedPicks = new Set<string>();
  let policyIdle: string | undefined;
  const session = { finished: 0, ok: 0, retried: 0 };
  const spawnedNames = new Set<string>();
  let legacyNotice = config.legacyLanes.join(",");

  /** Why a job is not runnable on the defer ladder, or undefined. Reads its own sidecar. */
  const jobCooling = (job: FleetJob): string | undefined => {
    const defers = laneDefers(laneJsonlPath(job.name, stampToday));
    const now = Date.now();
    for (const d of defers) {
      if (d.entry.tainted === true) return `${job.ref} tainted this epoch (${d.entry.defers} defers, ${d.entry.reason})`;
      if (now < d.entry.notBefore) return `${job.ref} cooling until ${new Date(d.entry.notBefore).toLocaleTimeString()} (${d.entry.reason})`;
    }
    return undefined;
  };

  /**
   * The lanes the supervisor acts on this tick, every one of them a job: the
   * pinned jobs on their accounts; every pool job already running (on the
   * account it was given; `enabled` follows the file so a job flipped off or
   * deleted drains); the manual jobs the queue just handed a free account;
   * and the policy's picks for what is left. Jobs with nothing free wait.
   */
  const effectiveLanes = (cfg: FleetConfig): FleetLane[] => {
    const out: FleetLane[] = [];
    // The projection, once a tick: eligibility for the queue's gate and the
    // policy's picks read the same answer (ADR-0034).
    const states = modelStates({ runsDir: RUNS_DIR, roster: rosterModels(cfg.roster), policy: cfg.policy });
    const eligible = eligibleFrom(states);
    const byName = new Map(cfg.jobs.map((j) => [j.name, j]));
    const runningRefs = new Set<string>();
    const driverCount = new Map<string, number>();
    // Paid policy models in flight, for the paid cap (pinned jobs excluded).
    const billingOf = new Map(states.map((st) => [st.name, st.billing]));
    let paidRunning = 0;
    const pinnedSkips: QueueSkip[] = [];
    const countDriver = (refs: readonly string[]): void => {
      for (const r of refs) driverCount.set(driverOf(cfg.roster, r), (driverCount.get(driverOf(cfg.roster, r)) ?? 0) + 1);
    };
    const countJob = (job: FleetJob): void => {
      if (job.legacy === undefined) return countDriver(job.refs);
      // A legacy job's driver is on its entries; count its first (a lane rotates one stream).
      const d = normalizeDriver(job.legacy.entries?.[0]?.driver ?? "openai") ?? "openai";
      driverCount.set(d, (driverCount.get(d) ?? 0) + 1);
    };
    // Pinned jobs: from the file, on their own accounts.
    for (const job of pinnedJobs(cfg)) {
      if (job.enabled && job.legacy === undefined && runnableRefs(job, cfg.roster, eligible).length === 0) {
        // A pinned job whose ref is not promoted into its tier: it waits,
        // with the reason said once, exactly like a gated queue job.
        pinnedSkips.push({ job, reason: `${job.ref} is not eligible for ${job.episode} (no e90 run reached level 5 yet; force it with roster.<name>.tiers)` });
        out.push({ name: job.name, enabled: false, account: job.account!, loop: false, entries: [{ model: "gated" }] });
        continue;
      }
      out.push(jobLane(job, cfg.roster, job.account!, stampToday, eligible));
      if (job.enabled || sets.running.has(job.name)) {
        for (const r of job.refs) runningRefs.add(r);
        // An enabled pinned job spawns this tick if it is not already running,
        // so it counts against the driver cap either way — otherwise the first
        // tick after a restart fills the pool before the pinned session exists.
        countJob(job);
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
          out.push(jobLane(running, cfg.roster, account, stampToday));
          runningRefs.add(running.ref);
          countDriver(running.refs);
          if (billingOf.get(running.ref) === "paid") paidRunning++;
        }
        continue;
      }
      if (fromFile === undefined || fromFile.account !== undefined || runnableRefs(fromFile, cfg.roster, eligible).length === 0) {
        // Removed from the queue (or pinned now, or its ref vanished): a
        // disabled stand-in makes diffLanes drain it. The process keeps its roster.
        out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
        continue;
      }
      out.push(jobLane(fromFile, cfg.roster, account, stampToday, eligible));
      for (const r of fromFile.refs) runningRefs.add(r);
      countDriver(fromFile.refs);
      // A manual pool job on a paid model holds a paid slot too: the cap is
      // about what is billing at once, not about who asked for it.
      for (const r of fromFile.refs) if (billingOf.get(r) === "paid") paidRunning++;
    }
    const held = (a: string): string | undefined => accountHeldBy(a, "");
    lastPlan = planQueue({
      queue: poolJobs(cfg),
      roster: cfg.roster,
      pool: cfg.accounts.pool,
      running: assigned,
      finished: sets.finished,
      held,
      cooling: jobCooling,
      eligible,
      runningRefs,
    });
    lastPlan.skipped.unshift(...pinnedSkips);
    for (const { job, account } of lastPlan.assign) {
      pending.set(job.name, job);
      out.push(jobLane(job, cfg.roster, account, stampToday, eligible));
    }
    // The policy fills what the queue left free. A gated spawn is not a
    // problem: the pick is re-made next tick from the same projection.
    if (cfg.accounts.pool.length > 0) {
      const allowed = policyRefs(cfg);
      const picks = planPolicy({
        states: states.filter((st) => allowed.has(st.name)),
        pool: cfg.accounts.pool,
        running: assigned,
        held,
        queuePlan: lastPlan,
        runningRefs,
        concurrency: { driverOf: (n) => driverOf(cfg.roster, n), max: cfg.maxConcurrent, running: driverCount },
        policy: cfg.policy,
        paidRunning,
      });
      for (const { job, account, why } of picks) {
        pending.set(job.name, job);
        // A policy job that finished an earlier attempt is fair game again;
        // the projection, not the finished set, decides whether it runs.
        sets.finished.delete(job.name);
        const key = `${job.name}:${job.attempt}`;
        if (!announcedPicks.has(key)) {
          announcedPicks.add(key);
          const tag = job.extra !== undefined ? " (extra)" : "";
          say(`policy ${job.name}: ${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account} — ${why}`);
          record({ lane: job.name, event: "policy-pick", detail: `${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account}: ${why}` });
        }
        out.push(jobLane(job, cfg.roster, account, stampToday));
      }
      const taken = new Set([...assigned.values(), ...lastPlan.assign.map((a) => a.account), ...picks.map((p) => p.account)].map((a) => a.toUpperCase()));
      const free = cfg.accounts.pool.filter((a) => !taken.has(a.toUpperCase()) && held(a) === undefined);
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
        record({ lane: sk.job.name, event: "queue-skipped", detail: sk.reason });
      }
    }
    for (const j of cfg.jobs) if (!lastPlan.skipped.some((sk) => sk.job.name === j.name)) complainedSkips.delete(j.name);
    return out;
  };
  const poolView = (cfg: FleetConfig): PoolView => ({
    pinned: cfg.accounts.pinned,
    pool: cfg.accounts.pool,
    assigned,
    jobs: liveJobs,
    queue: poolJobs(cfg),
    finished: sets.finished,
    waiting: lastPlan.waiting.map((j) => j.name),
    skipped: lastPlan.skipped.map((sk) => ({ name: sk.job.name, reason: sk.reason })),
    ...(policyIdle !== undefined ? { policyIdle } : {}),
    session,
  });

  const spawnLane = (lane: FleetLane): void => {
    let until: string | undefined;
    let entries: RosterSpec[];
    try {
      until = laneUntil(lane, args.until);
      entries = fillEntries(lane, loadLaneEntries(lane), stampToday);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      say(`lane ${lane.name}: not spawning — ${detail}`);
      record({ lane: lane.name, event: "spawn-refused", detail });
      return;
    }
    const rosterPath = laneRosterPath(lane.name, stampToday);
    mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(rosterPath, JSON.stringify(entries, null, 2) + "\n");
    // A respawn (lane toggled off then on again the same day) resumes the
    // materialized roster instead of relaunching finished runs from scratch.
    const resumeRoster = existsSync(laneJsonlPath(lane.name, stampToday));
    const argv = laneArgv(lane, { stamp: stampToday, until: args.until, resumeRoster });
    const stdoutLog = laneStdoutPath(lane.name, stampToday);
    // O_APPEND, not Bun.file(): a BunFile sink starts at offset 0, so a
    // respawned lane used to overwrite the head of its own log and leave the
    // dead process's tail behind it — which is exactly what `--status` reads.
    // The shared offset an append fd gives both streams also keeps stdout and
    // stderr from clobbering each other.
    mkdirSync(dirname(stdoutLog), { recursive: true });
    const fd = openSync(stdoutLog, "a");
    const proc = Bun.spawn(argv, { cwd: REPO_ROOT, stdin: "ignore", stdout: fd, stderr: fd });
    writeSync(fd, `---- spawned ${new Date().toISOString()} pid ${proc.pid} ${argv.join(" ")}\n`);
    closeSync(fd);
    const lp: LaneProc = { lane, proc, pid: proc.pid, spawnedAt: Date.now(), exited: false, exitCode: null };
    void proc.exited.then((code) => {
      lp.exited = true;
      lp.exitCode = code;
    });
    procs.set(lane.name, lp);
    sets.running.add(lane.name);
    if (spawnedNames.has(lane.name)) session.retried++;
    spawnedNames.add(lane.name);
    const pj = pending.get(lane.name) ?? pinnedJobs(config).find((j) => j.name === lane.name);
    if (pj !== undefined) {
      liveJobs.set(lane.name, pj);
      if (pj.account === undefined) assigned.set(lane.name, lane.account);
      pending.delete(lane.name);
      if (pj.attempt !== undefined) announcedPicks.delete(`${lane.name}:${pj.attempt}`);
    }
    say(`lane ${lane.name}: spawned pid ${proc.pid} (account ${lane.account}${resumeRoster ? ", --resume-roster" : ""}) -> ${stdoutLog}`);
    record({ lane: lane.name, event: "spawned", detail: `pid ${proc.pid}${resumeRoster ? "; resume-roster" : ""}; account ${lane.account}` });
  };

  const requestStop = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    say("stopping: SIGTERM to every lane (run-roster terminates its episode gracefully)");
    for (const [name, p] of procs) {
      if (!p.exited) {
        try {
          process.kill(p.pid, "SIGTERM");
        } catch {
          // already gone
        }
        record({ lane: name, event: "sigterm", detail: "fleet stop" });
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
   * Evaluate (and if needed run) the gate. Returns whether lanes may spawn.
   * Only `start` is ever suppressed: drains, undrains and rearms must keep
   * working while the gate is shut, or an operator could not park a lane during
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
        say("preflight: disabled in fleet.json — gate open, lanes spawn unsmoked");
        record({ lane: "-", event: "preflight-skipped" });
      }
      return gateOpen(action, gate);
    }
    if (action === "wait") {
      if (complainedFor !== "unready") {
        complainedFor = "unready";
        say(`preflight: ${MODULE_URL}/health is not answering ready — spawning nothing until it does`);
        record({ lane: "-", event: "preflight-waiting" });
      }
      return gateOpen(action, gate);
    }
    if (action === "pass") return gateOpen(action, gate);
    say(`preflight: smoking the server (identity ${identity!})`);
    record({ lane: "-", event: "preflight-start", detail: identity });
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
      say(`preflight: PASS in ${Math.round(Math.max(0, ...gate.results.map((r) => r.ms)) / 1000)}s wall — lanes may spawn`);
      record({ lane: "-", event: "preflight-pass", detail: identity });
    } else {
      const failed = gate.results.find((r) => !r.ok);
      if (complainedFor !== identity) {
        complainedFor = identity;
        say(
          `preflight: FAIL — ${failed?.script ?? "?"}: ${failed?.tail ?? "no output"}\n` +
            `           NO LANES WILL SPAWN against this server. Fix or roll back the ` +
            `worldserver; the gate re-runs every ${TICK_MS / 1000}s.`,
        );
      }
      record({ lane: "-", event: "preflight-fail", detail: `${failed?.script ?? "?"}: ${failed?.tail ?? ""}` });
    }
    return gateOpen(action, gate);
  };

  let mayStart = await checkGate(config.preflight);
  if (mayStart) for (const lane of diffLanes(effectiveLanes(config), sets).start) spawnLane(lane);
  writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config));

  for (;;) {
    await new Promise((res) => setTimeout(res, TICK_MS));

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
        record({ lane: name, event: "exited", detail: `code ${p.exitCode}${drained ? "; drained" : ""}` });
      }
    }

    if (stopping) {
      if (sets.running.size === 0) break;
      continue;
    }

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
        record({ lane: "-", event: "config-error", detail: error });
      }
    } else {
      configLoadedAt = Date.now();
      if (wasRejected !== undefined) {
        say("fleet config loads again — the file is back in effect");
        record({ lane: "-", event: "config-recovered" });
      }
    }
    config = next;
    if (config.legacyLanes.join(",") !== legacyNotice) {
      legacyNotice = config.legacyLanes.join(",");
      if (config.legacyLanes.length > 0) say(`legacy lanes read as pinned jobs: ${config.legacyLanes.join(", ")}`);
    }

    const actions = diffLanes(effectiveLanes(config), sets);
    for (const name of actions.undrain) {
      sets.draining.delete(name);
      say(`lane ${name}: re-enabled before it drained — keeping it running`);
      record({ lane: name, event: "undrain" });
    }
    for (const name of actions.rearm) {
      sets.finished.delete(name);
      record({ lane: name, event: "rearmed", detail: "disabled after finishing; enable again to respawn" });
    }
    for (const name of actions.drain) {
      sets.draining.add(name);
      say(`lane ${name}: disabled — draining (SIGTERM at the next episode boundary)`);
      record({ lane: name, event: "draining" });
    }
    // Drains: only SIGTERM a roster with no episode child. Delivered BEFORE the
    // gate, which can sit inside a smoke for minutes: an operator parking a lane
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
        say(`lane ${name}: between episodes — SIGTERM sent`);
        record({ lane: name, event: "drain-sigterm" });
      }
    }

    // The gate runs after every drain/undrain/rearm action precisely so a shut
    // gate never blocks the operator from parking a lane. `stopping` is
    // re-checked after the await: a SIGTERM that lands during a 15-minute smoke
    // has already killed the lanes, and spawning into that would be a leak.
    mayStart = await checkGate(config.preflight);
    if (mayStart && !stopping) {
      for (const lane of actions.start) spawnLane(lane);
    } else if (actions.start.length > 0 && !stopping) {
      record({ lane: "-", event: "spawn-gated", detail: actions.start.map((l) => l.name).join(",") });
    }

    writeState(args.config, stampToday, procs, sets.draining, gate, poolView(config));
    const toStart = diffLanes(effectiveLanes(config), sets).start.length + lastPlan.waiting.length;
    if (fleetComplete({ running: sets.running.size, toStart, hasDeadline: args.until !== undefined })) {
      say("all lanes have exited and nothing is left to spawn — fleet complete");
      break;
    }
    const idle = sets.running.size === 0 && toStart === 0;
    if (idle !== wasIdle) {
      wasIdle = idle;
      if (idle) {
        say("no lanes running and none to spawn — idling; enable a lane in fleet.json (or stop the service)");
        record({ lane: "-", event: "idle" });
      } else {
        record({ lane: "-", event: "unidle" });
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
