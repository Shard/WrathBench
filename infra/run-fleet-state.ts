/**
 * What the fleet's files and processes SAY right now: where everything lives
 * under data/runs, fleet-state.json and the pause switch, the config re-read
 * for a reader, the deploy window's phase file, and the /proc answers.
 *
 * Imports run-fleet-config and run-fleet-plan; never run-fleet-status or the
 * entry point. It reads and resolves — it does not decide, print, or spawn.
 * main() reads several of these too (the defer ladder, run progress), which is
 * why they are here and not beside the status renderer.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  type EpisodeId,
  type FleetConfig,
  type FleetJob,
  type JobSource,
  type JobSpawn,
  parseFleet,
  type PreflightRecord,
  rosterModels,
} from "./run-fleet-config";
import {
  applyEnded,
  type ConfigRejection,
  type EndedRun,
  type FleetPause,
  parsePauseSidecar,
  PAUSE_SIDECAR,
  type PausedListing,
} from "./run-fleet-plan";
import { type DeferEntry, deferSidecarPath, parseDefers } from "./run-roster";
import { type Campaign } from "../runner/src/campaigns";
import {
  type ModelsSidecar,
  type ModelState,
  modelStates,
  type RunFact,
  type StartingCharacter,
} from "../runner/src/models";

/** Set by the `fleet` compose service; see run-roster's inContainer(). */
export const CONTAINER = process.env["WRATHBENCH_IN_CONTAINER"] === "1";
export const REPO_ROOT = dirname(import.meta.dir);
export const RUNS_DIR = join(REPO_ROOT, "data", "runs");
export const ROSTER_SH = join(REPO_ROOT, "infra", "run-roster.sh");
export const STATE_PATH = join(RUNS_DIR, "fleet-state.json");
/**
 * The deploy window's phase file (infra/deploy-worldserver.sh): what the
 * viewer's /api/fleet serves as `server`. The script holds an flock on the
 * `.lock` sibling for its lifetime; a phase found here with the lock FREE was
 * left by a deploy that did not finish, and this process is what clears it.
 */
export const SERVER_STATE_PATH = join(RUNS_DIR, "server-state.json");
export const SERVER_STATE_LOCK = join(RUNS_DIR, "server-state.lock");
export const PAUSE_PATH = join(RUNS_DIR, "fleet-pause.json");
/**
 * The projection the rest of a tick must read once its sweep has ended runs.
 * `sidecar` is the operator's clear list; omitted it is read from
 * the run directory, exactly as the top-of-tick projection reads it.
 */
export function statesAfterSweep(
  cfg: Pick<FleetConfig, "roster" | "policy">,
  runs: readonly RunFact[],
  ended: readonly EndedRun[],
  now: number,
  sidecar?: ModelsSidecar,
): ModelState[] {
  return modelStates({
    runsDir: RUNS_DIR,
    roster: rosterModels(cfg.roster),
    policy: cfg.policy,
    runs: applyEnded(runs, ended, now),
    now,
    ...(sidecar !== undefined ? { sidecar } : {}),
  });
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
/** The switch as it stands on disk, or undefined when the fleet is not paused. */
export function readPauseSidecar(runsDir: string = RUNS_DIR): FleetPause | undefined {
  const p = join(runsDir, PAUSE_SIDECAR);
  if (!existsSync(p)) return undefined;
  try {
    return parsePauseSidecar(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** Resolve a configured smoke path against the repo. */
export function smokePath(script: string, root: string = REPO_ROOT): string {
  return isAbsolute(script) ? script : join(root, script);
}

/** Does this pid have a live child (an episode in flight)? /proc scan. */
export function hasLiveChild(pid: number): boolean {
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

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface FleetState {
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
  /**
   * Present while the pause switch (`data/runs/fleet-pause.json`) is set: the
   * fleet is launching nothing and every live job is draining to its episode
   * boundary. What `infra/fleet-update.sh` waits on, and what `--status` says
   * instead of leaving an operator to wonder why nothing spawns.
   */
  pausedSwitch?: FleetPause;
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
   * Every job with a process: the one unit of work — what it is
   * (ref, tier, account, source) and the process that runs it (pid, files,
   * exit). Written fresh every tick; the supervisor rewrites the whole file
   * on boot, so nothing reads an older shape.
   */
  jobs: Record<string, StateJob>;
  /** Why the last tick spawned nothing from the policy, when it did not. */
  policy?: { idle?: string };
  /** Counters since the supervisor started. */
  session?: { finished: number; ok: number; retried: number };
  /** Paused runs the supervisor is not resuming right now, with why. */
  paused?: PausedListing[];
  /** Paused runs the supervisor ended instead of resuming, this session. */
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
  /** The paused run this spawn is resuming. */
  resuming?: string;
  /**
   * The Claude subscription this job is billing, by env var NAME. Absent on the
   * default lane and on everything that is not a claude-code job.
   */
  subscription?: string;
  models: string[];
  pid: number;
  /** Repo-relative: the reader may be on the other side of the mount. */
  rosterPath: string;
  jsonl: string;
  log: string;
  spawnedAt: number;
  exitCode: number | null;
  draining: boolean;
  /** The supervisor's own view of the process; see resolveStatePath. */
  alive: boolean;
  /**
   * `resumesInPlace`: this job's run comes back where it left off after a
   * supervisor restart, so a drain that is waiting on it is waiting for
   * nothing. Absent on a supervisor older than this field — readers must fall
   * back to the `source`/`episode` pair rather than reading absence as false.
   */
  resumesInPlace?: boolean;
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

/** Live job bookkeeping, published into the state file every tick. */
export interface PoolView {
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
  /** The campaigns in force, for the per-job `resumesInPlace` flag. */
  campaigns: readonly Campaign[];
  /** Paused runs the last plan did not resume, with why. */
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
): { ref: string; episode: EpisodeId | null; source: JobSource; attempt?: number; extra?: StartingCharacter; subscription?: string } {
  if (job === undefined) return { ref: name, episode: null, source: "pinned" };
  return {
    ref: job.ref,
    episode: job.episode,
    source: job.source,
    ...(job.attempt !== undefined ? { attempt: job.attempt } : {}),
    ...(job.extra !== undefined ? { extra: job.extra } : {}),
    ...(job.subscription !== undefined ? { subscription: job.subscription } : {}),
  };
}

// ------------------------------------------------------------ server state

/** The phases the deploy script writes while it holds the lock; `running` is the rest state. */
export type ServerPhase = "running" | "draining" | "swapping" | "verifying" | "resuming" | "rolled-back" | "failed";
/** Phases that mean a deploy is in progress RIGHT NOW — meaningless once nothing holds the lock. */
export const WINDOW_PHASES: ReadonlySet<string> = new Set(["draining", "swapping", "verifying", "resuming"]);

export interface ServerState {
  phase: ServerPhase;
  since: number;
  build: string;
  prevBuild?: string;
  detail: string;
  pid?: number;
  updatedAt: number;
}

/** True when no deploy holds the lock (flock -n succeeds). Unknown is "held": never clear what might be live. */
export function deployLockFree(): boolean {
  try {
    return Bun.spawnSync(["flock", "-n", SERVER_STATE_LOCK, "true"]).exitCode === 0;
  } catch {
    return false;
  }
}

export function lastLaunchedRunId(stdoutLog: string): string | undefined {
  if (!existsSync(stdoutLog)) return undefined;
  let found: string | undefined;
  for (const line of readFileSync(stdoutLog, "utf8").split("\n")) {
    const m = /\] launch \S+ as (\S+)/.exec(line);
    if (m !== null) found = m[1];
  }
  return found;
}

export function lastLine(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1];
}

export function runProgress(runId: string): { level: number; xp: number; startedAt?: number } | undefined {
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
export function foreignRosters(managedPids: Set<number>): { pid: number; argv: string }[] {
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
export function jobDefers(jsonl: string): { spec: string; entry: DeferEntry }[] {
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
 * table disagree with --live-runs (item 68).
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
