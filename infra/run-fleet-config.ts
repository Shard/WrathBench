/**
 * The fleet config: the shape of the config document (jobs, roster, accounts, campaigns,
 * preflight), the helpers that read a parsed config, and the parser that
 * refuses a bad config by name. Pure data in, data out — no scheduler state, no
 * process, no disk. `run-fleet.ts` re-exports all of it, so importers may name
 * either module.
 */

import { join } from "node:path";
import type { RosterSpec } from "./run-roster";
import { harnessSeries } from "../runner/src/comparability";
import { compactWindowDriverRefusal, driverHasCompactWindow, harnessClash, parseEntryCompactWindow, watchdogOverrideSchema } from "../runner/src/config";
import type { Billing } from "../runner/src/model-cost";
import { isOpenRouterBase, parseRouting } from "../runner/src/routing";
import { QUEUE_JOB_KEYS, rosterEntryRefusal, strictKeyWhy, unknownKeysOf } from "../runner/src/roster-refusal";
import {
  applyPairRefusals,
  campaignSquares,
  campaignWork,
  parseCampaignBlocks,
  pinnedCampaignJobName,
  policyCampaignJobName,
  type Campaign,
  type CampaignRefusal,
  type ProbeIdentity,
  type ProbeRun,
  type PublishedCampaign,
} from "../runner/src/campaigns";
import type { CampaignFile } from "../runner/src/campaign-file";
import { isOneAgentArm } from "../runner/src/campaign-def";
import {
  isCounted,
  parsePolicyBlock,
  parseTier,
  parseIdle,
  TIERS,
  pinnedRefs as pinnedRefsOf,
  policyExclusion as policyExclusionOf,
  policyRefs as policyRefsOf,
  type IdleMode,
  type ModelState,
  type RosterModel,
  type RunFact,
  type SchedulingPolicy,
  type StartingCharacter,
  type Tier,
} from "../runner/src/models";
import { EPISODE_IDS, isScoredEpisode, isTaskEpisode, type EpisodeId } from "../runner/src/episodes";
import { credentialCandidates, isCredentialId, parseCredentials, type Credential } from "../runner/src/credential-slots";
import { evalPoolAccountNames, evalPoolSizeOf, isEvalPoolAccountName, isPoolAccountName, POOL_SIZE_ENV, poolAccountNames, poolSizeOf } from "../runner/src/account-pool";
import { tenantAccountRefusal } from "./tenant-accounts";
import type { PlacedCredential } from "./run-fleet-credentials";
import { harnessVersion } from "../runner/src/version";
import { DEFAULT_DRIVER, driverEntry, ROSTER_DRIVERS } from "../runner/src/drivers";

/**
 * The harness series this supervisor runs from: the projection
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
 * (objective, watchdogs, maxToolCalls, wikiCoords, wiki); the
 * spawn adds only the account and the fleet-scoped run ids.
 */
export interface JobSpawn {
  name: string;
  enabled: boolean;
  account: string;
  /**
   * A party's accounts, one per member in member order (`account` is the
   * leader's, the first): the job holds all of them. Absent on every spawn
   * that is not a party's, so a single run's spawn is what it was.
   */
  accounts?: string[];
  loop: boolean;
  /** Roster entries — the exact per-entry schema run-roster accepts. */
  entries: RosterSpec[];
  /**
   * Set on a spawn that resumes a paused run: its first entry
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
 * session per account is the module's rule, so the account is the character), and
 * entries that share an account run one after the other in list order. A bare
 * string entry in the config is the pre-2026-08-23 form and means "on the
 * default `account`".
 *
 * `deploySmokes` are the release's smokes on top of the gate, run by the
 * deploy window (infra/k8s-deploy.sh) once per deploy, never by the
 * supervisor. Empty or absent is none, which is how it stands: the window
 * verifies with the gate alone, and the game-surface regression smokes run on
 * demand (`bun wb smoke suite`, infra/smoke/lib/suite.ts). It is config here so the deploy scripts and the
 * supervisor read the same store and the same accounts clash-check.
 */
export interface FleetPreflight {
  enabled: boolean;
  /** Default game account for string-form smokes — its own, never a job's, never PROBE. */
  account: string;
  /** Repo-relative (or absolute) smoke scripts, each bound to the account it logs in as. */
  smokes: PreflightSmoke[];
  timeoutMs: number;
  /** Deploy-only smokes (infra/k8s-deploy.sh), same entry forms as `smokes`. */
  deploySmokes: PreflightSmoke[];
  /** Budget for the whole deploySmokes list: one deadline every smoke in it shares. */
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
// The fleet is a set of jobs over a set of accounts. A job PINNED
// to an account (`account` in the file) runs there and nowhere else; a job
// without one is POOL work, spawned on whichever `accounts.pool` account is
// free when its turn comes; the policy's own picks are jobs too, made up each
// tick.

/** Episode tiers. The unscored ids bypass the tiers gate entirely. */
export { EPISODE_IDS, type EpisodeId } from "../runner/src/episodes";

/**
 * A roster entry as named in the `roster` map: the exact per-entry schema plus
 * its scheduling axes. The roster is a catalog: `tier` is the whole answer to
 * how much this model runs, and it is required on every entry. `idle` says
 * what the model does with an account once its tier is spent; absent is
 * `none`. An entry never steers — `objective`, `wikiCoords` and `resume` are
 * refused, because steering is a probe campaign's, which borrows an entry by
 * naming it in an assignment and supplies the whole task shape itself.
 */
export interface FleetRosterEntry extends RosterSpec {
  /** Required: the roster is a pure catalog, so there is no such thing as an entry outside the policy. */
  tier: Tier;
  idle: IdleMode;
  /** Operator override of the free/paid verdict (`runner/src/model-cost.ts`); normally absent. */
  billing?: Billing;
  /**
   * Optional: pin this model's runs to ONE credential, by id. Normally absent
   * — a credential is the scheduler's to pick, and pinning costs the entry the
   * other credentials' free slots: with its own full the pick is HELD, never
   * moved. Its use is an entry that must be billed to a particular account (a
   * borrowed one, a usage window being spent on purpose).
   */
  credential?: string;
  /**
   * The entry runs only as a probe campaign's assignment, as a probe-only
   * driver's entry does (`DriverEntry.probeOnly`): its tier buys no scored
   * run, it has no idle work, and a queue job naming it for a scored or
   * freeplay episode is gated. For a harness variant that is not a driver of
   * its own (an arm's `--loop program` on the wrathbench driver), so its
   * model's probe needs no scored run first. Its probe runs map back to it by
   * name (`matchesRoster`), so it never pools with another entry's.
   */
  campaignOnly?: true;
  /**
   * Opts the entry into the five-agent Deadmines episode (operator,
   * 2026-11-14): `true` or absent. Its tier buys it as it buys the one-agent
   * one (`t2`, three attempts), and only here, because five agents need five
   * sessions on one credential at once, which is a lane fact, not a model's.
   * The policy still holds it until `policy.rehearsed` names `deadmines`.
   */
  deadmines?: true;
  /**
   * Set by the parser when this entry was refused: it stays in the catalog so a
   * job naming it is gated rather than taking the whole file down, and nothing
   * schedules it (`policyExclusion`). The operator's notice is the refusal line
   * in `--status`.
   */
  refused?: string;
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
  /**
   * A party campaign's job (docs/proposals/GROUP-PLAY.md §1): one job, one
   * roster process, every member's account in member order, `account` being
   * the leader's. The spawn materialises one entry per member, launched,
   * stopped and counted together. Never from the file.
   *
   * With `fanout`, the accounts of one run instead: a party definition's
   * one-agent arm, one agent driving every member's character (fan-out). The
   * job holds every account all the same, for the run's whole life, but
   * takes one credential slot and one driver session, and its spawn is one
   * entry (`sessionsOf`, `jobSpawn`).
   */
  accounts?: string[];
  /** Set with `accounts` on a one-agent arm's job: one run on every account. Never from the file. */
  fanout?: true;
  /**
   * Set by `planResumes` on a paused party's job: the party id the members'
   * run ids hang off, so the spawn names the paused runs rather than a fresh
   * attempt's. Never from the file.
   */
  partyId?: string;
  source: JobSource;
  /**
   * Set on a job the scheduling policy made up, never on one from the file:
   * the n-th attempt on (model, episode), which suffixes the run id `-a<n>`
   * from the second attempt on so every attempt has its own id. A party
   * campaign's square sets it too, from its version's tally, as the floor its
   * spawn numbers up from (`freshAttempt`).
   */
  attempt?: number;
  /**
   * Set on an extra run that rolls a character: a policy pick past
   * the model's target on a scored tier. Reaches the runner as `--race/--class`
   * plus `--extra true`, so the run is stamped and never counted. A local
   * model's extra is a freeplay run and rolls nothing — `isExtraJob` is the
   * question "is this an extra", this field is only "which character".
   */
  extra?: StartingCharacter;
  /**
   * Set by `planResumes`: this job's spawn resumes the paused run
   * named here, on the account it was on, before anything fresh is launched.
   * `model`/`effort`/`compactWindow` pick the entry that carries the run id.
   */
  resume?: { runId: string; model: string; effort?: string | undefined; compactWindow?: string | undefined; driver?: string | undefined };
  /**
   * Set by `planContinuations` on the `idle: "unlimited"` lane's next
   * session: the character's previous run, whose character and scratchpad this
   * spawn carries on (`--continue-from`). Never from the file.
   */
  continueFrom?: string;
  /**
   * Set on every fresh launch by the tick: the other refs' freeplay
   * characters standing on the account this job got, which its hygiene must
   * leave alone (`--keep-characters`). Never from the file.
   */
  keepCharacters?: string[];
  /**
   * Set by `planContinuations` when the character's head sits on an account
   * another ref's character occupies: the head this spawn deliberately does not
   * continue, and why (`--continue-dropped`). A record on the new run, no
   * lineage. Never from the file.
   */
  continueDropped?: { runId: string; reason: string };
  /**
   * Set when this job is a probe campaign's work: which campaign and version
   * commissioned it, and which cell and arm it is. Only the identity travels
   * here; the spawn builds the run's `campaign.json` from the published
   * definition (or, on a resume, the run keeps its own).
   */
  probe?: ProbeIdentity;
  /**
   * Set by `planResumes` on a paused probe's job: the run's own
   * `campaign.json`, which its spawn carries instead of building one from the
   * store, so the run comes back on its own arm whatever has been published
   * since. Never from the file.
   */
  campaignFile?: CampaignFile;
  /**
   * The credential this job's runs must take, by id: a queue job's or a
   * pinned campaign's own `credential`, from the file. Absent: each ref's
   * entry pin, else the scheduler's choice.
   */
  credential?: string;
  /**
   * Where each ref was placed, by the scheduler (`placeRef`): the credential
   * it took a slot on, or null for a scripted run that needs none. Never from
   * the file. On the job rather than the roster entry because which key pays
   * is not a model dimension: the same entry runs on whichever has room.
   */
  placed?: Readonly<Record<string, PlacedCredential | null>>;
  /**
   * Set by the planner on a config job with a numeric `repeat` it is about to
   * start (`owedCopies`): the copies each ref still owes, counted off the runs
   * on disk, and every run id already used, so the remainder's ids are fresh
   * ones. Absent means the full `repeat` for every ref. Never from the file.
   */
  owed?: { copies: Readonly<Record<string, number>>; taken: ReadonlySet<string> };
  /**
   * Set by the planner on a pinned campaign's fresh square (`withTakenRunIds`):
   * every run id on disk, archive included. The spawn numbers its attempt past
   * them (`-a<n>`), so no stem is ever reused: not across campaign versions,
   * which count their attempts afresh, and not after a stop on the same date.
   * Never from the file.
   */
  takenRunIds?: ReadonlySet<string>;
}

export interface FleetAccounts {
  /** account -> the pinned job on it. Derived from the jobs, never authored. */
  pinned: Record<string, string>;
  /**
   * The pool: every game account a run that names none is drawn from, in
   * preference order, one live session each. By default the generated pool,
   * `POOL01`…, sized by the deployment (`WRATHBENCH_POOL_SIZE`, the chart's
   * `worldserver.pool.size`; runner/src/account-pool.ts); a file that lists
   * `accounts.pool` names its own instead. Never a reserved account: the
   * preflight gate's, `SMOKE*`, `PROBE` and an enabled pin's are refused here.
   */
  pool: string[];
  /** At most this many pool accounts live at once; the pool's size when the file says none. */
  max: number;
  /**
   * The eval pool, `EVAL01`…, sized by the deployment (`WRATHBENCH_EVAL_POOL_SIZE`,
   * the chart's `worlds.pool.size`): what a party campaign that draws its
   * accounts (`accounts: "evals"`) takes per attempt. Never authored, never
   * pinned, never in `pool`. Absent is none.
   */
  evalPool?: string[];
}

export interface FleetConfig {
  notes: string[];
  preflight: FleetPreflight;
  accounts: FleetAccounts;
  /**
   * The provider credentials runs take a slot on (`runner/src/credential-slots.ts`),
   * in preference order. Empty when the store has none.
   */
  credentials: Credential[];
  roster: Record<string, FleetRosterEntry>;
  /** Every job the file names, pinned and pool, in file order. */
  jobs: FleetJob[];
  /** The `campaigns` block joined to its published definitions, in declaration order; empty when the file has none. */
  campaigns: Campaign[];
  /** Every published campaign definition (`campaign-defs`), whether a row names it or not. */
  campaignDefs: PublishedCampaign[];
  /**
   * Campaign rows and published definitions read but not used, by store key
   * (a version nobody published, a definition that no longer checks out).
   * Carried to `--status` and `/api/campaigns`.
   */
  campaignRefusals: CampaignRefusal[];
  /**
   * Pins refused at parse time, one line each. The rest of the file
   * IS in effect — that is the whole point of a refusal over a `fail()`. Empty
   * on a clean config; `--status` and the supervisor log name every entry.
   */
  refusals: ConfigRefusal[];
  /** The scheduling policy's run targets; `policy.runsPerEpisode` in the file, defaults apply. */
  policy: SchedulingPolicy;
}

/**
 * A PIN: a queue job or a campaign with an `account`, reduced to what the
 * account rules need. Jobs and campaigns are pinned by the same rules with the
 * same consequences, so they are checked as one list rather than as two nearly
 * identical loops.
 */
interface Pin {
  /** `accounts.pinned`'s value: a job's name, or `campaign <name>`. */
  readonly label: string;
  readonly account: string | undefined;
  /** Every account the pin holds: `account`, or a party campaign's members' (`Campaign.accounts`). */
  readonly accounts: readonly string[];
  /** Mutable: a refused pin is DISABLED in place, which is the enforcement. */
  enabled: boolean;
  /**
   * Every job name this pin can spawn under. A job is itself; a campaign is one
   * job per (cell, arm) (`pinnedCampaignJobName`: `<campaign>-<cell>-<arm>`).
   * The tick uses these to tell a run that is live under a REFUSED pin apart
   * from one the operator deliberately disabled — the first must not be drained.
   */
  readonly jobNames: readonly string[];
}

/** Jobs then campaigns, in file order — the order a refusal picks its loser by. */
function pinsOf(jobs: readonly FleetJob[], campaigns: readonly Campaign[]): Pin[] {
  return [
    ...jobs.map((j) => ({
      get label() { return j.name; },
      get account() { return j.account; },
      get accounts() { return j.account === undefined ? [] : [j.account]; },
      get enabled() { return j.enabled; },
      set enabled(v: boolean) { j.enabled = v; },
      jobNames: [j.name],
    })),
    ...campaigns.map((c) => ({
      get label() { return `campaign ${c.name}`; },
      get account() { return c.account; },
      get accounts() { return c.accounts ?? (c.account === undefined ? [] : [c.account]); },
      get enabled() { return c.enabled; },
      set enabled(v: boolean) { c.enabled = v; },
      jobNames: c.cells.flatMap((cell) => c.arms.map((arm) => pinnedCampaignJobName(c.name, cell.id, arm.id))),
    })),
  ];
}

/**
 * A pin the account rules refused. `jobs` is what it could have spawned under,
 * so the tick can leave a live one alone instead of draining it.
 */
export interface ConfigRefusal {
  /** The pin: a job's name, or `campaign <name>`. */
  pin: string;
  /** Why. The operator's only notice that their `enabled: true` did not take. */
  why: string;
  /** Job names this refusal suppresses (`Pin.jobNames`). */
  jobs: string[];
}

/** Disable one pin and say why. The message is the operator's only notice. */
function refuse(pin: Pin, refusals: ConfigRefusal[], why: string): void {
  pin.enabled = false;
  refusals.push({ pin: pin.label, why, jobs: [...pin.jobNames] });
}

/**
 * The account rules that are LOCAL to one pin, enforced by refusing that pin
 * rather than the whole file.
 *
 * They used to `fail()`. Since a rejected re-read keeps the last good config,
 * that meant one bad `enabled: true` made every other flag in the file inert
 * until somebody read the REJECTED banner — a config-wide outage from a
 * one-line edit whose intent was local. The rules themselves are
 * right: two enabled pins on one account starve each other, and an enabled pin
 * on a listed account fights the scheduler for the session. So the violating
 * pin is disabled and named, and the rest of the file takes effect. Shape
 * errors still fail, because a file that does not parse has no rest to keep.
 */
export function applyPinAccountRules(pins: readonly Pin[], accounts: FleetAccounts, refusals: ConfigRefusal[]): void {
  const byAccount = new Map<string, string>();
  for (const pin of pins) {
    if (pin.accounts.length === 0 || !pin.enabled) continue;
    // A party's pin holds every member's account, and loses all of them if any
    // one clashes: half a party cannot run.
    const why = pinClash(pin, accounts, byAccount);
    if (why !== undefined) {
      refuse(pin, refusals, why);
      continue;
    }
    for (const a of pin.accounts) byAccount.set(a.toUpperCase(), pin.label);
  }
}

/** Why one of a pin's accounts is not its to hold, or undefined. */
function pinClash(pin: Pin, accounts: FleetAccounts, byAccount: ReadonlyMap<string, string>): string | undefined {
  for (const account of pin.accounts) {
    const key = account.toUpperCase();
    // One live session per account: two enabled pins on one account means one
    // of them spends the whole window waiting behind the other. The FIRST in
    // file order keeps the account, so which pin loses does not move when an
    // unrelated entry is added above it.
    const other = byAccount.get(key);
    if (other !== undefined) return `account ${account} is already ${other}'s — one enabled job per account`;
    // Listing an account says who may SCHEDULE it; `enabled` says who HOLDS it,
    // and only an enabled pin holds. So a DISABLED pin may park on a pool
    // account; an enabled one may not, or the pin and the scheduler would
    // fight over the session.
    if (accounts.pool.some((a) => a.toUpperCase() === key) || isPoolAccountName(account)) {
      return `account ${account} is ${isPoolAccountName(account) ? "a generated pool account" : "in accounts.pool"} — a pinned account is reserved; only a disabled job may park on a pool account`;
    }
    if (isEvalPoolAccountName(account)) {
      return `account ${account} is an eval pool account — a party draws those per attempt (accounts: "evals"); nothing pins one`;
    }
  }
  return undefined;
}

/** Every account the scheduler may hand out: the pool. */
export function scheduledAccounts(config: Pick<FleetConfig, "accounts">): string[] {
  return config.accounts.pool;
}

/**
 * Why a campaign's `credential` pin cannot be honoured, or undefined. It is a
 * pinned campaign's (a credential chosen for launches the policy does not
 * place), and it must carry every assignment: configured, of the
 * assignment's provider, of its billing side (`credentialCandidates`). A
 * disabled credential is no refusal; the campaign waits for it.
 */
export function campaignCredentialProblem(
  c: Pick<Campaign, "name" | "credential" | "account" | "assignments" | "drawsAccounts">,
  roster: Readonly<Record<string, Pick<FleetRosterEntry, "model" | "driver" | "apiBase" | "billing">>>,
  credentials: readonly Credential[],
): string | undefined {
  const pin = c.credential;
  if (pin === undefined) return undefined;
  if (!isCredentialId(pin)) return `campaign ${c.name}: credential must be a credential's id (credentials/<id>), never a secret`;
  if (c.account === undefined && c.drawsAccounts !== true) return `campaign ${c.name}: a credential pin is a pinned campaign's (give account or accounts); the policy places an unpinned campaign's runs`;
  for (const a of c.assignments) {
    const e = roster[a.model];
    if (e === undefined) continue;
    const fit = credentialCandidates(credentials.map((x) => ({ ...x, enabled: true })), e, { pin });
    if (fit.why !== undefined) return `campaign ${c.name}: ${a.model}: ${fit.why}`;
    if (fit.provider === null) return `campaign ${c.name}: ${a.model} needs no credential, so it cannot be pinned to one`;
  }
  return undefined;
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
 *
 * `healthy` is `excludeUnhealthy`'s question — retired or cooling on the defer
 * ladder (`healthyFrom`) — asked exactly as the policy's campaign loop asks it
 * of its own picks. Not the policy's whole `blocked` verdict: that also covers
 * a model that is running, and the model running here is usually this
 * campaign's own live probe, whose job must keep its name until it ends.
 */
export function pinnedCampaignJobs(
  config: Pick<FleetConfig, "campaigns" | "roster">,
  probeRuns: readonly ProbeRun[],
  healthy?: (name: string) => boolean,
  /**
   * For a party that draws its accounts (`Campaign.drawsAccounts`): this
   * attempt's accounts from the eval pool, or why it has none now
   * (`evalPoolDraw`). Without it such a party yields no job.
   */
  draw?: (c: Campaign, jobName: string, size: number) => { accounts: string[] } | { held: string },
  /** Where a party that could draw no accounts is said, with its job. */
  held?: { job: FleetJob; why: string }[],
): FleetJob[] {
  const catalog = Object.keys(config.roster);
  const out: FleetJob[] = [];
  for (const c of config.campaigns) {
    if ((c.account === undefined && c.drawsAccounts !== true) || !c.enabled) continue;
    // A party's accounts carry its members' characters: while any attempt of
    // it is live or paused, a fresh one would restage over them. The paused
    // party comes back through `planResumes`, whole, or waits listed.
    if ((c.accounts !== undefined || c.drawsAccounts === true) && campaignSquares(c, catalog, probeRuns).some((s) => s.live > 0)) continue;
    const next = campaignWork([c], catalog, probeRuns, healthy)[0];
    if (next === undefined) continue;
    const name = pinnedCampaignJobName(c.name, next.cell.id, next.arm.id);
    let accounts = c.accounts;
    if (c.drawsAccounts === true) {
      const base: FleetJob = { refs: [next.model], ref: next.model, episode: "probing", repeat: 1, name, enabled: true, source: "pinned", probe: { campaign: c.name, version: c.version, cell: next.cell.id, arm: next.arm.id } };
      const drawn = draw?.(c, name, c.def.party?.size ?? 0) ?? { held: "no eval pool to draw a party's accounts from here" };
      if ("held" in drawn) {
        held?.push({ job: base, why: drawn.held });
        continue;
      }
      accounts = drawn.accounts;
    }
    out.push({
      refs: [next.model],
      ref: next.model,
      episode: "probing",
      repeat: 1,
      name,
      account: accounts?.[0] ?? c.account!,
      enabled: true,
      source: "pinned",
      probe: { campaign: c.name, version: c.version, cell: next.cell.id, arm: next.arm.id },
      // A party is every member's account at once, and each attempt its own
      // run-id stem (`-a<n>` from the second). This version's count is only
      // the floor: the spawn numbers past every id on disk (`takenRunIds`), so
      // a restaged party never lands on the ids of one before it.
      ...(accounts !== undefined ? { accounts: [...accounts], attempt: next.attempts + 1 } : {}),
      // A one-agent arm holds the same accounts for one run on all of them.
      ...(accounts !== undefined && isOneAgentArm(c.def, next.arm) ? { fanout: true as const } : {}),
      // The campaign's own credential, for its launches only (`campaigns.<id>.credential`).
      ...(c.credential !== undefined ? { credential: c.credential } : {}),
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
 * it gates, so the viewer answers it the same way.
 */
export function pinnedRefs(config: Pick<FleetConfig, "jobs">): Set<string> {
  return pinnedRefsOf(config.jobs);
}

/**
 * The config as a deployment with the evals group off runs it
 * (`runner/viewer/groups.ts`): every campaign and every scored or probing job
 * disabled, so each drains at its episode boundary and nothing resumes under
 * it, exactly as if the operator had switched it off. The policy's own scored
 * picks are the other half (`planPolicy`'s `evals`). Freeplay jobs are left as
 * they are. Pure, and applied to each config as it is read, so turning the
 * group back on is the next read.
 */
export function withoutEvals(config: FleetConfig): FleetConfig {
  return {
    ...config,
    campaigns: config.campaigns.map((c) => (c.enabled ? { ...c, enabled: false } : c)),
    jobs: config.jobs.map((j) => (j.enabled && (isScoredEpisode(j.episode) || j.episode === "probing") ? { ...j, enabled: false } : j)),
  };
}

/**
 * The campaigns the policy may schedule: enabled, and unpinned. A pinned
 * campaign is a pinned job in every way that matters here — its account is by
 * definition not one the policy draws from — so it is built into a pinned
 * job elsewhere and never reaches this list.
 */
export function unpinnedCampaigns(config: Pick<FleetConfig, "campaigns">): Campaign[] {
  // A party that draws its accounts from the eval pool is pinned like any party.
  return config.campaigns.filter((c) => c.enabled && c.account === undefined && c.drawsAccounts !== true);
}

/**
 * Every probe run on disk, in the shape `campaignSquares` reads them: the
 * run's own stamps — campaign, version, cell, the roster name it was launched
 * as and the arm — and nothing inferred. A run missing any of them predates
 * arms and belongs to no square; it stays on the runs pages.
 *
 * Failed launches come through too, carrying `counted: false`. The fan-out
 * needs both questions answered: `runsPerCell` is about counted runs, and
 * `maxAttemptsPerCell` is about launches. Filtering here — which is what this
 * did — is exactly how a cell that could never produce a counted run was
 * re-picked thirty-seven times.
 */
export function probeRunsOf(runs: readonly RunFact[]): ProbeRun[] {
  return runs
    .filter((f) => f.campaign !== null)
    .map((f) => ({
      campaign: f.campaign,
      version: f.campaignVersion ?? null,
      cell: f.cell,
      ref: f.ref ?? null,
      arm: f.arm ?? null,
      counted: isCounted(f),
      live: f.live || f.pause !== null,
      // A party member is tallied with its party (`campaignSquares`); the
      // reason says whether a run reached its definition's end.
      terminationReason: f.terminationReason,
      ...(f.party != null ? { party: { id: f.party.id, size: f.party.size } } : {}),
    }));
}

/**
 * `excludeUnhealthy`'s question over the projection: a model is unhealthy
 * when it is retired or cooling on the defer ladder. A name the projection
 * does not hold (a catalog-only entry) is healthy — absence means "never
 * eval-scheduled", not "unhealthy".
 */
export function healthyFrom(states: readonly ModelState[]): (name: string) => boolean {
  const byName = new Map(states.map((s) => [s.name, s]));
  return (name) => {
    const s = byName.get(name);
    return s === undefined || (s.retired === undefined && s.cooling === undefined);
  };
}

/**
 * What an episode id means in the flags the runner has today (mirrors
 * runner/src/episodes.ts), passed alongside `--episode <id>` until the runner
 * owns the id. e90: 90m, idle 20m, no-xp 20m, 3000 calls. e360: 6h, idle 20m,
 * no-xp off — ceilings are a runaway guard at 1000 calls per 30 min (e90
 * 3000, e360 12000; docs/EPISODES.md). freeplay: no wall clock, unscored, and
 * no tool-call ceiling either — a guard sized in calls-per-minute is
 * meaningless on a session with no minutes. That null reaches only a
 * POLICY-GENERATED freeplay job on an `idle: "unlimited"` ref; `jobSpawn`
 * drops it for every other freeplay job, including a hand-written one on that
 * same ref, which keeps stating its own leash (docs/EPISODES.md).
 */
export function episodeDimensions(id: EpisodeId): Pick<RosterSpec, "episode" | "watchdogs" | "maxToolCalls"> {
  switch (id) {
    case "e90":
      return { episode: id, watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: 1_200_000 }, maxToolCalls: 3000 };
    case "e360":
      return { episode: id, watchdogs: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: 12000 };
    case "probing":
      // Never what a probe runs under: every probe spawn carries its campaign
      // file, whose budget replaces these (`jobSpawn`). Kept so the switch is total.
      return { episode: id, watchdogs: { episodeMs: 5_400_000, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: undefined };
    case "freeplay":
      return { episode: id, watchdogs: { episodeMs: null, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: null };
    case "deadmines":
    case "deadmines-solo":
      // The id's own leash; the launch file carries the same budget, which
      // the runner reads (`jobSpawn`), and the tests hold the two equal.
      return { episode: id, watchdogs: { episodeMs: 14_400_000, idleMs: 1_200_000, noXpMs: null }, maxToolCalls: 8000 };
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

// ------------------------------------------------------------------ parsing

/** Refuse the config by name. Every validation path in this file ends here. */
export function fail(msg: string): never {
  throw new Error(msg);
}

/** True for models that must ride the claude-code driver (the claude-code harness), and that the codex driver refuses. */
export function isClaudeFamily(model: string): boolean {
  return /(^|\/)(claude|opus|sonnet|haiku)/i.test(model);
}

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
    const driver: string = e.driver ?? DEFAULT_DRIVER;
    const entry = driverEntry(driver);
    // The scripted reference is not a model: it is launched by hand, once per
    // harness series, and the policy may never schedule one (docs/EPISODES.md,
    // "The scripted reference run").
    if (entry?.rosterRefusal !== undefined) {
      fail(`${where}: entry ${e.model}: ${entry.rosterRefusal}`);
    }
    if (entry === undefined || !entry.roster) {
      fail(`${where}: entry ${e.model}: unknown driver ${String(e.driver)} (${ROSTER_DRIVERS.join(" | ")})`);
    }
    // Which model family the driver may carry: claude models only via
    // claude-code, and never through the openai or codex entries.
    const family = entry.claudeModels;
    if (family !== undefined && family.only !== isClaudeFamily(e.model)) {
      fail(`${where}: entry ${e.model}: ${family.refusal}`);
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
    // The reference wiki as a capability (operator decision 2026-09-16, issue
    // #61): included by default, switchable off per entry. Type-checked here
    // the way every other per-entry dimension is; the pairing with wikiCoords
    // is refused rather than resolved, because coordinates are a setting OF
    // the surface this flag removes.
    if (e.wiki !== undefined && typeof e.wiki !== "boolean") {
      fail(`${where}: entry ${e.model}: wiki must be a boolean`);
    }
    if (e.wiki === false && e.wikiCoords === true) {
      fail(`${where}: entry ${e.model}: wikiCoords needs the reference wiki, and this entry has wiki: false`);
    }
    // A CLI harness's auto-compaction window (operator decisions 2026-10-09,
    // and 2026-10-11 for codex): a run dimension like effort, settable on any
    // claude-code or codex entry and refused on every other driver, whose API
    // has no such window to set. NORMALISED like routing: one canonical spelling for every
    // reader. `auto` is the absent field where the CLI's own window is the
    // driver's default, so it can never make a second identity for the same
    // condition; where the driver defaults another (claude-code's 300k,
    // operator 2026-11-10) it stays `"auto"`, the entry's opt-out
    // (`parseEntryCompactWindow`).
    if (e.compactWindow !== undefined) {
      if (!driverHasCompactWindow(driver)) {
        fail(`${where}: entry ${e.model}: ${compactWindowDriverRefusal(driver)}`);
      }
      let window: string | undefined;
      try {
        window = parseEntryCompactWindow(e.compactWindow, driver);
      } catch (err) {
        fail(`${where}: entry ${e.model}: ${(err as Error).message}`);
      }
      if (window === undefined) delete e.compactWindow;
      else e.compactWindow = window;
    }
    // Which backend may serve this entry (operator decision 2026-09-16,
    // runner/src/routing.ts). Refused — never ignored — off OpenRouter, where
    // there is one machine behind the endpoint or (OpenCode Go) the provider routes: an operator who wrote a routing block on a
    // Cerebras or CLI entry believed the run was pinned, and config that does
    // nothing is what every strict-key rule in this file exists to prevent.
    if (e.routing !== undefined) {
      if (!entry.routing || !(e.apiBase === undefined || isOpenRouterBase(e.apiBase))) {
        fail(
          `${where}: entry ${e.model}: routing is an OpenRouter setting — this entry runs on ` +
            `${entry.routing ? String(e.apiBase) : `the ${driver} CLI`}, which is single-backend or (OpenCode Go) routed by its provider`,
        );
      }
      // NORMALISED, not merely checked: the shorthands (`"Z.AI"`, `["Z.AI"]`)
      // exist for the file, and every reader downstream — `--status`, the
      // spawned argv, the tuple — should see one shape. The store keeps the
      // raw document, so the file's own spelling is untouched.
      try {
        e.routing = parseRouting(e.routing, `${where}: entry ${e.model}`);
      } catch (err) {
        fail((err as Error).message);
      }
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
 * no smokes" — an older config keeps working unchanged.
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
  const preflight = { enabled: o.enabled, account: o.account, smokes, timeoutMs, deploySmokes, deployTimeoutMs };
  for (const a of preflightAccounts(preflight)) refuseTenantAccount("preflight", a);
  return preflight;
}

/**
 * The keys a roster entry and a queue job may carry, and the refusal of a
 * whole entry, live beside the viewer's reader of them
 * (runner/src/roster-refusal.ts); re-exported so importers of this module keep
 * their names.
 */
export { ROSTER_ENTRY_KEYS, QUEUE_JOB_KEYS, unknownKeysOf } from "../runner/src/roster-refusal";

/**
 * Every job name a roster entry could spawn under: the file's own jobs that
 * reference it, the policy's `<ref>-<episode>`, and a campaign's
 * `<ref>-<campaign>-<cell>-<arm>`. This is what a refusal of the ENTRY has to
 * carry for the tick to spare a live run under it — the same value an
 * account-rule refusal carries for a pin. A refusal suppresses scheduling; it
 * never drains.
 */
function refJobNames(name: string, jobs: readonly FleetJob[], campaigns: readonly Campaign[]): string[] {
  const names = new Set<string>(jobs.filter((j) => j.refs.includes(name)).map((j) => j.name));
  for (const ep of EPISODE_IDS) names.add(`${name}-${ep}`);
  for (const c of campaigns) {
    if (!c.assignments.some((a) => a.model === name)) continue;
    for (const cell of c.cells) for (const arm of c.arms) names.add(policyCampaignJobName(name, c.name, cell.id, arm.id));
  }
  return [...names];
}

/** What `parseFleet` is told that the document cannot say. */
export interface ParseFleetOptions {
  /**
   * The supervisor's own knowledge of where it runs, which only it has:
   * given, an arm that pins an image or a command is refused as a pair off
   * the cluster too (`campaignPairRefusals`). Every other reader leaves it
   * out, and gets the refusals `policy.runPods` alone implies.
   */
  onCluster?: boolean;
  /**
   * Where the deploy-time self-hosted model hosts are read from
   * (`rosterKeyRefusal`): the process's own unless given, so a test states
   * the deployment it means. Every other verdict is the document's alone.
   */
  env?: Record<string, string | undefined>;
}

/** Parse + validate a fleet config. Throws with a config-error message. */
export function parseFleet(raw: unknown, opts: ParseFleetOptions = {}): FleetConfig {
  const env = opts.env ?? process.env;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("fleet config must be a JSON object");
  }
  const o = raw as {
    _notes?: unknown;
    lanes?: unknown;
    preflight?: unknown;
    accounts?: unknown;
    credentials?: unknown;
    roster?: unknown;
    queue?: unknown;
    policy?: unknown;
    campaigns?: unknown;
    "campaign-defs"?: unknown;
  };
  if (o.lanes !== undefined) {
    fail("fleet config: `lanes` is not a 0.4 key — a job goes in `queue` ({ ref, episode, repeat, account? }) over a `roster` map (see docs/RUNBOOK.md)");
  }
  const notes = Array.isArray(o._notes) ? o._notes.filter((n): n is string => typeof n === "string") : [];
  const accounts = parseAccounts(o.accounts, env);
  let credentials: Credential[];
  try {
    credentials = parseCredentials(o.credentials);
  } catch (err) {
    fail((err as Error).message);
  }
  const roster = parseRoster(o.roster);
  const policy = parsePolicy(o.policy);
  // Never throws: a campaign row or a published definition that does not read
  // is refused by key below, and the roster, the policy and every other
  // campaign load as if it were not there. One bad row must not empty the board.
  // The (assignment, arm) pair refusals come last, once the roster's own
  // refusals are settled (`applyPairRefusals` below).
  const { campaigns, definitions: campaignDefs, refused: blockRefusals } = parseCampaignBlocks(o["campaign-defs"], o.campaigns);
  const jobs: FleetJob[] = [];
  const names = new Set<string>();
  const add = (job: FleetJob): void => {
    if (names.has(job.name)) {
      fail(`queue: two jobs would share the name ${job.name} (${job.ref} ${job.episode}) — one job per (ref, episode)`);
    }
    names.add(job.name);
    jobs.push(job);
  };
  const strictJobKeys = new Map<string, string[]>();
  for (const job of parseQueue(o.queue, roster, strictJobKeys)) add(job);
  const refusals: ConfigRefusal[] = [];
  // A campaign row refused by key — one that does not read, or names a
  // version nobody has published — is left out by name, so one row cannot take the rest of
  // the config down. It is also a pin refusal, so `--status` and the
  // supervisor log say it in the same place a refused pin is said.
  for (const r of blockRefusals) {
    if (r.campaign !== undefined) refusals.push({ pin: `campaign ${r.campaign}`, why: r.reason, jobs: [] });
  }
  // Strict keys BEFORE the account rules, deliberately: a job the harness
  // cannot read must not win an account off a well-formed one. A refused job
  // is disabled, and a disabled pin is already allowed to park anywhere.
  for (const [jobName, keys] of strictJobKeys) {
    const pin = pinsOf(jobs, campaigns).find((p) => p.label === jobName);
    if (pin !== undefined) refuse(pin, refusals, strictKeyWhy("queue job", keys, QUEUE_JOB_KEYS));
  }
  // A campaign's credential pin is checked as a roster entry's is, against the
  // credentials; a pin it cannot honour refuses the campaign, never runs it on
  // another credential.
  for (const c of campaigns) {
    const why = campaignCredentialProblem(c, roster, credentials);
    if (why === undefined) continue;
    const pin = pinsOf(jobs, campaigns).find((p) => p.label === `campaign ${c.name}`);
    if (pin !== undefined && pin.enabled) refuse(pin, refusals, why);
  }
  // A queue job's credential pin must carry every ref of it, as a campaign's
  // must; one it cannot honour refuses the job, never runs it elsewhere.
  for (const j of jobs) {
    if (j.credential === undefined || !j.enabled) continue;
    for (const r of j.refs) {
      const e = roster[r];
      if (e === undefined) continue;
      const fit = credentialCandidates(credentials.map((x) => ({ ...x, enabled: true })), e, { pin: j.credential, env });
      const why = fit.why ?? (fit.provider === null ? `${r} needs no credential, so it cannot be pinned to one` : undefined);
      if (why === undefined) continue;
      const pin = pinsOf(jobs, campaigns).find((p) => p.label === j.name);
      if (pin !== undefined) refuse(pin, refusals, `queue ${j.name}: ${why}`);
      else {
        j.enabled = false;
        refusals.push({ pin: j.name, why: `queue ${j.name}: ${why}`, jobs: [j.name] });
      }
      break;
    }
  }
  applyPinAccountRules(pinsOf(jobs, campaigns), accounts, refusals);
  for (const pin of pinsOf(jobs, campaigns)) {
    for (const account of pin.accounts) {
      // Derived, enabled first so a disabled stand-in on a running pin's account
      // (the burn switch) never hides the live one. Every pin is listed here,
      // refused ones included: `accounts.pinned` says who is parked, not who holds.
      const key = Object.keys(accounts.pinned).find((a) => a.toUpperCase() === account.toUpperCase()) ?? account;
      if (accounts.pinned[key] === undefined || pin.enabled) accounts.pinned[key] = pin.label;
    }
  }
  const preflight = parsePreflight(o.preflight);
  // The smokes hold a live session for their whole arc. Sharing an account with
  // an enabled job (or the pool) would mean the gate and the job reclaiming
  // the account from each other all night, so it is a config error, not a race
  // to discover live.
  if (preflight.enabled) {
    for (const account of preflightAccounts(preflight)) {
      // A pin on the gate's account is refused like any other local violation:
      // there is one pin to name and disable, and the gate outranks it (the
      // gate runs before anything else does). The two rules below have no pin to
      // refuse — the loser would be an account list — so they still fail.
      const clash = pinsOf(jobs, campaigns).find(
        (pin) => pin.enabled && pin.accounts.some((a) => a.toUpperCase() === account.toUpperCase()),
      );
      if (clash !== undefined) {
        refuse(clash, refusals, `account ${account} is the preflight gate's — the gate needs its own account`);
      }
      if (accounts.pool.some((a) => a.toUpperCase() === account.toUpperCase()) || isPoolAccountName(account)) {
        fail(`preflight account ${account} is also ${isPoolAccountName(account) ? "a generated pool account" : "in accounts.pool"} — the gate's account is reserved`);
      }
      if (isEvalPoolAccountName(account)) fail(`preflight account ${account} is an eval pool account — the gate's account is reserved, and an eval account is on no shared allowlist`);
    }
  }
  if (jobs.some((j) => j.enabled && j.account === undefined) && accounts.pool.length === 0) {
    fail(
      `queue has enabled pool jobs but the account pool is empty — nothing could ever run them (${POOL_SIZE_ENV}, the chart's worldserver.pool.size, is unset or 0 here, and accounts.pool lists none)`,
    );
  }
  // `policy.routing` is the fleet-wide default, applied HERE rather than at
  // launch so that `--status`, the spawned argv and the run's own config all
  // say the same thing an operator can read off one line. An entry that states
  // its own routing keeps it whole — the two are alternatives, never merged —
  // and an entry off OpenRouter is left alone, because a routing block there is refused, not defaulted.
  if (policy.routing !== undefined) {
    for (const [name, e] of Object.entries(roster)) {
      if (e.routing !== undefined) continue;
      if (driverEntry(e.driver ?? DEFAULT_DRIVER)?.routing !== true) continue;
      if (!(e.apiBase === undefined || isOpenRouterBase(e.apiBase))) continue;
      roster[name] = { ...e, routing: policy.routing };
    }
  }
  // Every refusal of a whole ENTRY, in one verdict the viewer's campaign
  // squares read too (`rosterEntryRefusal`, runner/src/roster-refusal.ts): a
  // key the harness does not read, a provider key towards a host its provider
  // does not own, a pinned credential that cannot carry it. Refused as the
  // ENTRY, not the file: it stays in the catalog, nothing schedules it or
  // launches a run that would send its key anywhere, and the rest of the
  // roster stays in effect. One line per entry; the jobs it could have spawned
  // under ride along, as a pin's refusal carries them, so a live freeplay run
  // under it is spared.
  for (const [name, e] of Object.entries(roster)) {
    const r = rosterEntryRefusal(e, credentials, env);
    if (r === null) continue;
    roster[name] = { ...e, refused: r.why };
    refusals.push({
      pin: `roster ${name}`,
      why: `${r.why} — the entry is in the catalog and scheduled by nothing`,
      jobs: refJobNames(name, jobs, campaigns),
    });
  }
  // Last, against the roster as refused: a campaign's (assignment, arm) pair
  // that would fail at launch — an entry refused above, an arm with nowhere
  // to run (`policy.runPods`, `onCluster`), a doubled compaction window — is
  // parked and shown on its squares, never offered to a planner.
  const campaignRefusals = [
    ...blockRefusals,
    ...applyPairRefusals(campaigns, roster, {
      runPods: policy.runPods,
      ...(opts.onCluster !== undefined ? { onCluster: opts.onCluster } : {}),
    }),
  ];
  return { notes, preflight, accounts, credentials, roster, jobs, campaigns, campaignDefs, campaignRefusals, policy, refusals };
}

/** Refuse the config when `account` is a hosted tenant's (infra/tenant-accounts.ts), enabled or not. */
function refuseTenantAccount(where: string, account: string): void {
  const why = tenantAccountRefusal(account);
  if (why !== null) fail(`${where}: ${why}`);
}

/** An account that is reserved by name and never in the pool: the smokes' and the ad-hoc debugging one. */
export function isReservedAccountName(a: string): boolean {
  return /^SMOKE/i.test(a) || a.toUpperCase() === "PROBE";
}

/**
 * The `accounts` block. With no `pool` listed, the pool is the generated one,
 * as many `POOLnn` accounts as the deployment says (`WRATHBENCH_POOL_SIZE`),
 * which the chart creates and puts on the module's allowlist from the same
 * value. A listed pool (the 0.5-era `RUNNER`… accounts) replaces it and may
 * not use the generated names.
 */
function parseAccounts(raw: unknown, env: Record<string, string | undefined>): FleetAccounts {
  const generated = (): string[] => {
    const size = poolSizeOf(env);
    if ("error" in size) fail(`accounts: ${size.error}`);
    return poolAccountNames(size.size);
  };
  const evalSize = evalPoolSizeOf(env);
  if ("error" in evalSize) fail(`accounts: ${evalSize.error}`);
  const evalPool = evalPoolAccountNames(evalSize.size);
  if (raw === undefined) {
    const pool = generated();
    return { pinned: {}, pool, max: pool.length, ...(evalPool.length > 0 ? { evalPool } : {}) };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("fleet config: accounts must be a JSON object");
  const o = raw as { pinned?: unknown; pool?: unknown; max?: unknown; paid?: unknown; local?: unknown };
  // `pinned` is derived from the jobs (`account` on a queue entry), never authored.
  if (o.pinned !== undefined) {
    fail("accounts.pinned is not a 0.4 key — pin the account on the job (`account` in its queue entry); the map is derived");
  }
  // The account classes went with credentials: a paid run is held by its
  // credential's slots, a model on the self-hosted box by its one-slot credential.
  for (const cls of ["paid", "local"] as const) {
    if (o[cls] !== undefined) fail(`accounts.${cls} is not a v1 key — every account is in the one pool; a provider's concurrency is its credentials' slots (credentials/<id>)`);
  }
  const extra = Object.keys(o).filter((k) => k !== "pool" && k !== "max");
  if (extra.length > 0) fail(`accounts: unknown key ${extra.join(", ")} — accounts is { pool?: [...], max? }`);
  const pinned: Record<string, string> = {};
  let pool: string[] = [];
  if (o.pool === undefined) {
    pool = generated();
  } else {
    if (!Array.isArray(o.pool)) fail("accounts.pool must be an array of account names, or left out for the generated pool (POOL01…, sized by the chart's worldserver.pool.size)");
    for (const a of o.pool as unknown[]) {
      if (typeof a !== "string" || a.length === 0) fail("accounts.pool: entries are account names");
      if (pool.some((p) => p.toUpperCase() === a.toUpperCase())) fail(`accounts.pool: ${a} listed twice`);
      if (isReservedAccountName(a)) fail(`accounts.pool: ${a} is reserved (SMOKE* and PROBE are never drawn from the pool)`);
      if (isPoolAccountName(a)) fail(`accounts.pool: ${a} is a generated pool account's name — leave accounts.pool out to draw from the generated pool`);
      if (isEvalPoolAccountName(a)) fail(`accounts.pool: ${a} is an eval pool account's — a party campaign draws those (accounts: "evals"), never the pool`);
      refuseTenantAccount("accounts.pool", a);
      pool.push(a);
    }
  }
  let max = pool.length;
  if (o.max !== undefined) {
    if (typeof o.max !== "number" || !Number.isInteger(o.max) || o.max < 0) fail("accounts.max must be a non-negative integer: at most that many pool accounts live at once");
    max = Math.min(o.max, pool.length);
  }
  return { pinned, pool, max, ...(evalPool.length > 0 ? { evalPool } : {}) };
}

function parseRoster(raw: unknown): Record<string, FleetRosterEntry> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("fleet config: roster must be an object of name -> entry");
  const out: Record<string, FleetRosterEntry> = {};
  for (const [name, e] of Object.entries(raw as Record<string, unknown>)) {
    if (name.length === 0 || !/^[A-Za-z0-9._-]+$/.test(name)) fail(`roster: entry name ${JSON.stringify(name)} must be [A-Za-z0-9._-]+`);
    if (typeof e !== "object" || e === null || Array.isArray(e)) fail(`roster ${name}: entry must be an object`);
    const { tier: rawTier, idle: rawIdle, tiers: rawTiers, runsPerEpisode: rawRuns, billing: rawBilling, credential: rawCred, campaignOnly: rawCampaignOnly, deadmines: rawDeadmines, ...rest } = e as {
      tier?: unknown;
      idle?: unknown;
      campaignOnly?: unknown;
      deadmines?: unknown;
      tiers?: unknown;
      runsPerEpisode?: unknown;
      billing?: unknown;
      credential?: unknown;
    } & Record<string, unknown>;
    // An id, never a secret. Whether it is a CONFIGURED credential that can
    // carry this entry is checked in `parseFleet` (`rosterEntryRefusal`): that
    // one is a refusal of this entry, not of the file.
    if (rawCred !== undefined && (typeof rawCred !== "string" || !isCredentialId(rawCred))) {
      fail(`roster ${name}: credential must be a credential's id (credentials/<id>), never a secret`);
    }
    if (rawCampaignOnly !== undefined && rawCampaignOnly !== true) fail(`roster ${name}: campaignOnly is true or absent`);
    if (rawCampaignOnly === true && rawIdle !== undefined && rawIdle !== "none") fail(`roster ${name}: a campaignOnly entry has no idle work — drop idle or set it to "none"`);
    // The five-agent Deadmines episode's opt-in (operator, 2026-11-14): one
    // spelling, and only where a tier can buy it.
    if (rawDeadmines !== undefined && rawDeadmines !== true) {
      fail(`roster ${name}: deadmines is true or absent — true opts this entry into the five-agent Deadmines episode, which its tier then buys`);
    }
    if (rawDeadmines === true && rawCampaignOnly === true) fail(`roster ${name}: a campaignOnly entry runs no scored episode, so deadmines cannot apply to it`);
    if (rawBilling !== undefined && rawBilling !== "free" && rawBilling !== "paid") fail(`roster ${name}: billing must be "free" or "paid" (normally absent: it is derived)`);
    // The retired 0.4 spellings, refused by name. Both said how much a model
    // runs, which is its tier now; dropping them silently would re-scope a
    // budget an operator wrote on purpose.
    if (rawTiers !== undefined) fail(`roster ${name}: tiers is not a 0.5 key — force a longer episode by setting tier: "t2"`);
    if (rawRuns !== undefined) fail(`roster ${name}: runsPerEpisode is not a 0.5 key — run counts are the tier (${TIERS.join(", ")})`);
    // Retired with the same argument, and refused at LOAD for the reason a bad
    // name was: a name in the config is a name the harness has to keep valid,
    // and an invalid one takes the whole file down (`Fleetsonnno`, 2026-08-25)
    // or respawn-loops a job (`Fleetsonnetlo`, 13 chars, 2026-08-24). The model
    // names its own character and the run records what it chose, so there is
    // nothing for an entry to say.
    if (rest["character"] !== undefined) {
      fail(`roster ${name}: character is not a key — the model names its own character and the run records it`);
    }
    if (rest["account"] !== undefined) fail(`roster ${name}: an entry must not pin an account — pin the job that references it`);
    // An entry carrying an objective is outside the policy entirely
    // The roster is a CATALOG: an entry describes a model and says
    // how much evidence it gets, and nothing else. Steering belongs to a
    // campaign, which owns its whole task shape — an entry that could carry an
    // objective is what used to make the roster two kinds of thing, and every
    // scored surface then needed a branch to tell them apart.
    if (rest["objective"] !== undefined) {
      fail(`roster ${name}: an entry must not carry an objective — steering is a probe campaign's (see docs/EPISODES.md), which names this entry in an assignment`);
    }
    if (rest["wikiCoords"] !== undefined) {
      fail(`roster ${name}: an entry must not carry wikiCoords — coordinates are for a steered run, so they belong to the campaign that asks for them`);
    }
    // Whether a lapse is resumed is a property of the LANE, not of the model:
    // scored runs never resume, freeplay always does, and a probe
    // campaign opts in. An entry saying `resume` meant something specific by
    // it, so it is refused rather than ignored.
    if (rest["resume"] !== undefined) {
      fail(`roster ${name}: an entry must not carry resume — resuming is the lane's rule; a probe campaign opts in through its published definition's resume`);
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
      ...(rawCred !== undefined ? { credential: rawCred as string } : {}),
      ...(rawCampaignOnly === true ? { campaignOnly: true as const } : {}),
      ...(rawDeadmines === true ? { deadmines: true as const } : {}),
    };
  }
  // One model id, one harness: what keeps the harness a tag (`harnessClash`).
  const clash = harnessClash(out);
  if (clash !== null) fail(`roster: ${clash}`);
  return out;
}

/**
 * The file's `policy` block: what is left in it is where runs may execute —
 * the per-driver session cap, the routing default, run pods
 * (`parsePolicyBlock` in runner/src/models.ts is the one parser; the viewer
 * reads the same). The tier table, the defer ladder and the promotion level
 * are code. The series is this checkout's.
 */
function parsePolicy(raw: unknown): SchedulingPolicy {
  try {
    return parsePolicyBlock(raw, currentSeries());
  } catch (err) {
    fail((err as Error).message);
  }
}

/**
 * The roster as the projection reads it: ordered, named, with its tier and
 * idle axis.
 *
 * Every entry projects. It used to drop the tierless ones, which were the
 * steered probes — and since campaigns took over steering there are none: an entry cannot carry an
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
            ...(e.compactWindow !== undefined ? { compactWindow: e.compactWindow } : {}),
            ...(e.driver !== undefined ? { driver: e.driver } : {}),
            ...(e.apiBase !== undefined ? { apiBase: e.apiBase } : {}),
            tier: e.tier,
            idle: e.idle,
            ...(e.billing !== undefined ? { billing: e.billing } : {}),
            ...(e.campaignOnly === true ? { campaignOnly: true as const } : {}),
            ...(e.deadmines === true ? { deadmines: true as const } : {}),
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
  return roster[name]?.driver ?? DEFAULT_DRIVER;
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

function parseQueue(
  raw: unknown,
  roster: Record<string, FleetRosterEntry>,
  /** Out: job name -> keys outside `QUEUE_JOB_KEYS`. The caller refuses the job. */
  strictKeys?: Map<string, string[]>,
): FleetJob[] {
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
    // A task episode is staged on the eval pool's accounts and a world of its
    // own, and bought by the tier (operator, 2026-11-14): the policy's to
    // launch, never a hand-written job.
    if (isTaskEpisode(j.episode)) {
      fail(`queue ${ref}: --episode ${j.episode} is the policy's — a model's tier buys its attempts (roster.<name>.tier, and roster.<name>.deadmines for the five-agent id)`);
    }
    // A probe exists only as a cell of a published campaign definition
    // (operator decision, 2026-10-09): a queue job naming `probing` would launch
    // one with no campaign, no cell and no definition to say what it was for.
    if (j.episode === "probing") {
      fail(`queue ${ref}: a probe is a campaign's cell, never a queue job — add an assignment to campaigns/<id> instead`);
    }
    // `resume` on a job means nothing: whether a lapsed run comes back is the
    // lane's rule, and the only opt-in is a campaign's. The key is
    // also the supervisor's own internal spelling for "this spawn resumes run
    // X", so accepting it from the file would be actively confusing.
    if ((j as Record<string, unknown>)["resume"] !== undefined) {
      fail(`queue ${ref}: a job must not carry resume — a scored run that pauses is a failed attempt; only campaigns opt in`);
    }
    // Same shape of refusal: a freeplay character's lineage is read off the
    // runs, never written into the file.
    for (const k of ["continueFrom", "keepCharacters", "continueDropped"] as const) {
      if ((j as Record<string, unknown>)[k] !== undefined) {
        fail(`queue ${ref}: a job must not carry ${k} — the supervisor derives a freeplay character's continuation from its runs`);
      }
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
      refuseTenantAccount(`queue ${ref}`, j.account);
      account = j.account;
    }
    // Optional: pin the job to one credential instead of letting the
    // scheduler pick the first with room. An id, checked as one.
    let credential: string | undefined;
    if (j.credential !== undefined) {
      if (typeof j.credential !== "string" || !isCredentialId(j.credential)) {
        fail(`queue ${ref}: credential must be a credential's id (credentials/<id>), never a secret`);
      }
      credential = j.credential;
    }
    // Collected, not thrown: the job is refused by name below the parse, which
    // suppresses its scheduling and leaves the rest of the file in effect.
    const unknown = unknownKeysOf(j as object, QUEUE_JOB_KEYS);
    if (unknown.length > 0) strictKeys?.set(name, unknown);
    out.push({
      refs: refs as string[],
      ref,
      episode: j.episode as EpisodeId,
      repeat,
      name,
      enabled,
      ...(account !== undefined ? { account } : {}),
      ...(credential !== undefined ? { credential } : {}),
      source: account !== undefined ? "pinned" : "queue",
    });
  }
  return out;
}
