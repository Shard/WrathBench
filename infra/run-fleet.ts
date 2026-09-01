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
 * as `runner`, `restart: unless-stopped`, no deadline. It therefore
 * cannot assume the reader of `--status` shares its PID namespace: liveness is
 * published as a heartbeat in fleet-state.json and per-job `alive` flags, not
 * inferred with kill(pid, 0). Paths in that state file are repo-relative for
 * the same reason.
 *
 * The fleet is the config file, and its one unit of work is the JOB: a roster
 * entry (or a rotation of several), an episode tier, a repeat count, on ONE
 * game account for the life of its process. A job that names an `account` is
 * PINNED to it; a job without one takes whichever POOL account is free when
 * its turn comes; and the scheduling policy makes up jobs of its
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
 * Preflight gate (docs/OPERATIONS.md): the top-level `preflight` block in fleet.json is
 * the deploy-window smoke, made a normal part of fleet operation. The
 * supervisor runs those scripts against the live server before it spawns any
 * job, and again whenever the server identity changes (a recreate, or a
 * restart the container did by itself). A failure spawns nothing, complains
 * once, and is re-checked every tick; only `start` is ever suppressed, so
 * drains keep working while the gate is shut. `enabled:false` records a
 * "skipped" result and opens the gate.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  classPoolsOf,
  concurrencyKeyOfRef,
  eligibleFrom,
  type FleetConfig,
  type FleetJob,
  type FleetPreflight,
  type JobSpawn,
  keysOfIn,
  parseFleet,
  pinnedCampaignJobs,
  pinnedJobs,
  policyRefs,
  poolJobs,
  type PreflightRecord,
  type PreflightSmoke,
  probeRunsOf,
  rosterModels,
  scheduledAccounts,
  unpinnedCampaigns,
} from "./run-fleet-config";
import {
  affinityFrom,
  affinityOf,
  applyPause,
  bootMarker,
  BREAKER_SHORT_LIVED_MS,
  BREAKER_WINDOW_MS,
  type ConfigRejection,
  describeStanding,
  diffJobs,
  type EndedRun,
  failedAttemptsFor,
  fillEntries,
  fleetComplete,
  type FleetPause,
  gateDecision,
  gateOpen,
  isExtraJob,
  type JobSets,
  jobSpawn,
  keepFor,
  type NameSweep,
  nextConfigRejection,
  type Occupant,
  type PausedListing,
  pausesOnDrain,
  planContinuations,
  planNameSweeps,
  planPolicy,
  planQueue,
  planResumes,
  planStaleRuns,
  planTick,
  policyJobDropped,
  type QueuePlan,
  type QueueSkip,
  resumesInPlace,
  retryNumbers,
  runnableRefs,
  serverIdentity,
  type ServerIdentity,
  streamAffinity,
  streamKey,
  streamsFrom,
  streamStanding,
  tailOf,
  TICK_MS,
  tripsBreaker,
} from "./run-fleet-plan";
import {
  CONTAINER,
  deployLockFree,
  type FleetState,
  hasLiveChild,
  jobArgv,
  jobDefers,
  jobJsonlPath,
  jobLogPath,
  jobRosterPath,
  loadConfigForRead,
  PAUSE_PATH,
  type PoolView,
  readPauseSidecar,
  REPO_ROOT,
  rereadFleet,
  RUNS_DIR,
  SERVER_STATE_PATH,
  type ServerState,
  smokePath,
  STATE_PATH,
  type StateJob,
  stateJobFacts,
  statesAfterSweep,
  WINDOW_PHASES,
} from "./run-fleet-state";
import { formatEndedRun, printDryRun, printLiveRuns, printStatus } from "./run-fleet-status";
import { accountHeldBy, releaseRunSession } from "./run-roster";
import { DEFAULT_CLAUDE_TOKEN_ENV } from "../runner/src/config";
import {
  capFor,
  CLAUDE_TOTAL_KEY,
  claudeKeysFor,
  liveSubscriptions,
  MODELS_SIDECAR,
  modelStates,
  parseModelsSidecar,
  readModelsSidecar,
  readRunFacts,
  schedulability,
  serializeModelsSidecar,
} from "../runner/src/models";
import { moduleAuthHeaders } from "../runner/src/module-auth";
import { Trajectory } from "../runner/src/trajectory";
import { isAllowlistedFree } from "../runner/src/model-cost";

// ------------------------------------------------------------ the modules
// The supervisor is four files. This one is the entry point: arg parsing,
// main(), the tick loop, and the process bookkeeping the loop needs. The
// domain sits beside it, imported one way only —
// config <- plan <- state <- status <- here:
//
//   run-fleet-config.ts  the shape of fleet.json and the parser that refuses one
//   run-fleet-plan.ts    the pure planners, the stream/drain rules, the gate verdict
//   run-fleet-state.ts   paths, fleet-state.json, the pause switch, what /proc says
//   run-fleet-status.ts  the format* helpers and the --status/--live-runs/--dry-run printers
//
// All four are re-exported here so `./run-fleet` still names every symbol the
// tests and scripts import from it.
export * from "./run-fleet-config";
export * from "./run-fleet-plan";
export * from "./run-fleet-state";
export * from "./run-fleet-status";
export { isAllowlistedFree };

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
        t.setTermination(e.runId, e.reason, e.detail);
      } finally {
        t.close();
      }
      return { runId: e.runId };
    } catch (err) {
      return { runId: e.runId, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * The game session a lapsed run left behind, released best-effort.
 *
 * Every roster path that walks away from a paused run frees its session first
 * (`run-roster.ts`, and the runner itself on an `operator-pause`), so this is
 * normally a no-op DELETE. It is here for the paths where nobody did: a roster
 * killed mid-backoff, a machine that slept with a live run on it. Without it
 * the account stays held and the fresh attempt this record promises dies
 * `account_in_use`.
 */
export async function releaseEndedSessions(ended: readonly EndedRun[], say: (s: string) => void): Promise<void> {
  for (const e of ended) {
    const detail = await releaseRunSession(e.runId);
    say(`released the session for ${e.runId}${e.account !== null ? ` on ${e.account}` : ""} — ${detail}`);
  }
}
/**
 * Delete the swept names, through the module's client delete path — the same
 * `POST /character-delete` episode hygiene uses, never a database write
 * (CONTRACTS.md). Best effort: a refusal is logged and the launch proceeds,
 * because the model can simply choose another name.
 */
export async function sweepNames(
  sweeps: readonly NameSweep[],
  say: (s: string) => void,
  f: typeof fetch = fetch,
): Promise<void> {
  const url = (process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086") + "/character-delete";
  for (const sw of sweeps) {
    // The module refuses tokens under 32 characters (`weak_token`), and this
    // one addresses no session of ours, so it is random per call.
    const token = `fleet-sweep-${randomUUID()}${randomUUID()}`;
    try {
      const r = await f(url, {
        method: "POST",
        // Operator class (module/PROTOCOL.md "Authentication"): character
        // deletes are the port secret's alone.
        headers: { "content-type": "application/json", ...moduleAuthHeaders() },
        body: JSON.stringify({ token, account: sw.account, character: sw.character }),
      });
      const j = (await r.json()) as { deleted?: boolean; error?: string };
      say(
        j.deleted === true
          ? `name hygiene: deleted ${sw.character} on ${sw.account} — ${sw.ref} is launching elsewhere`
          : `name hygiene: could not delete ${sw.character} on ${sw.account} (${j.error ?? `http ${r.status}`}) — the model can pick another name`,
      );
    } catch (e) {
      say(`name hygiene: could not reach the module to delete ${sw.character} on ${sw.account} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}


/** Where the module answers. Same default the runner and roster use. */
const MODULE_URL = process.env["WRATHBENCH_MODULE_URL"] ?? "http://worldserver:8086";
/** The worldserver's log directory as seen from this side of the mounts. */
const SERVER_LOG_DIR = join(REPO_ROOT, "data", "logs");
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

/**
 * The server as the supervisor currently sees it: `undefined` when the module
 * does not answer or the world is stopping, which is "not ready" — neither
 * smoke it nor spawn against it.
 */
async function readServerIdentity(): Promise<ServerIdentity | undefined> {
  let body: unknown;
  try {
    const res = await fetch(`${MODULE_URL}/health`, { headers: moduleAuthHeaders(), signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    body = await res.json();
  } catch {
    return undefined;
  }
  const o = body as { ok?: unknown; worldStopped?: unknown };
  if (o.ok !== true || o.worldStopped === true) return undefined;
  return serverIdentity(body, () => readBootMarker());
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

const START_AT = Date.now();

let preflightInFlight: { identity: string; since: number } | undefined;
/** Set while the file on disk will not load; every writeState carries it. */
let configRejected: ConfigRejection | undefined;
/** When the config actually in force was parsed. Set on load and on re-read. */
let configLoadedAt: number | undefined;
/** The pause switch as of the last tick; every writeState carries it. */
let pauseSwitch: FleetPause | undefined;
/**
 * The refusals last logged, joined. Deduping on the SET rather than a count
 * means a swap — one pin fixed and another broken in the same edit — is still
 * announced. `undefined` until the first tick, so a file that boots with
 * refusals says so once rather than never.
 */
let lastRefusals: string | undefined;
/** Live jobs spared a drain because their pin was refused — logged once each. */
const spared = new Set<string>();

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
      ...(resumesInPlace(j, pool?.campaigns) ? { resumesInPlace: true } : {}),
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
    ...(pauseSwitch !== undefined ? { pausedSwitch: pauseSwitch } : {}),
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
            "  --clear-model NAME  forgive a roster model's defer ladder / retirement:",
            "                  records the clear in data/runs/fleet-models.json; the running",
            "                  supervisor picks it up on its next tick. Safe while the fleet runs.",
            "",
            "The supervisor's normal home is the `fleet` compose service (see docs/OPERATIONS.md):",
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
  // Job bookkeeping: which job holds which account, the job itself
  // for every live process, and the last plan's waiting/skipped rows for
  // --status. A skip reason is logged once per (job, reason), not once a tick.
  const assigned = new Map<string, string>();
  const liveJobs = new Map<string, FleetJob>();
  /** Unlimited sessions already sent their one SIGTERM: a second would hard-exit the pause. */
  const pauseSignalled = new Set<string>();
  let lastPlan: QueuePlan = { assign: [], waiting: [], skipped: [] };
  /** Paused runs the last plan did not resume, with why; for the state file. */
  let lastPaused: PausedListing[] = [];
  /** Paused runs ended instead of resumed, this session; for the state file. */
  const endedRuns: EndedRun[] = [];
  const complainedSkips = new Map<string, string>();
  /** Jobs handed an account this tick, claimed by spawnJob; a gated tick re-plans next time. */
  const pending = new Map<string, FleetJob>();
  const announcedPicks = new Set<string>();
  /**
   * The subscription lane a job was last placed on, by job name. A run does not
   * appear on disk for a few seconds after it is spawned, and until it does the
   * only record of which subscription it took is this. Pruned every tick to the
   * jobs that are running or about to; across a restart the runs themselves are
   * the record (`liveSubscriptions`).
   */
  const laneMemo = new Map<string, string>();
  /** Why the newest projection dropped a live job, by job name; what the drain says. */
  const drainReasons = new Map<string, string>();
  let policyIdle: string | undefined;
  const session = { finished: 0, ok: 0, retried: 0 };
  const spawnedNames = new Set<string>();
  /** Exit timestamps of short-lived job processes, per name (the breaker's memory). */
  const shortLivedExits = new Map<string, number[]>();
  /** name -> hold-until, so a held job logs once per hold, not once per tick. */
  const breakerHolds = new Map<string, number>();

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
    // Rebuilt, not appended to: this runs twice a tick, and a reason must
    // describe the projection the drain is acting on.
    drainReasons.clear();
    // The run facts once a tick, shared by the projection and the resume
    // planner. Eligibility for the queue's gate and the policy's picks read
    // the same answer; resumes read the same facts.
    const runs = readRunFacts(RUNS_DIR, Date.now(), { includeArchived: true });
    // Both are re-derived below if this tick's sweep ends anything: a strike
    // written halfway down a tick has to be in the projection the queue and
    // the policy read at the bottom of it.
    let states = modelStates({ runsDir: RUNS_DIR, roster: rosterModels(cfg.roster), policy: cfg.policy, runs });
    let eligible = eligibleFrom(states);
    const byName = new Map(cfg.jobs.map((j) => [j.name, j]));
    const runningRefs = new Set<string>();
    const keyCount = new Map<string, number>();
    // Paid policy models in flight, for the paid cap (pinned jobs excluded).
    const billingOf = new Map(states.map((st) => [st.name, st.billing]));
    let paidRunning = 0;
    const pinnedSkips: QueueSkip[] = [];
    const keyOf = (n: string): string => concurrencyKeyOfRef(cfg.roster, n, billingOf.get(n));
    /**
     * The subscription lane each roster entry's live-or-paused run is on, read
     * back off the runs. This is what makes the per-lane count survive a
     * supervisor restart: the job objects that remember which token they were
     * spawned with die with the process, the runs do not.
     */
    const runLanes = liveSubscriptions(runs, rosterModels(cfg.roster));
    /** A job's lane: what it was scheduled on, else what its live run says. */
    const laneOf = (job: { subscription?: string; refs: readonly string[] }): string | undefined =>
      job.subscription ?? job.refs.map((r) => runLanes.get(r)).find((l) => l !== undefined);
    const countKey = (refs: readonly string[], lane?: string): void => {
      for (const r of refs) {
        for (const k of keysOfIn(keyOf, r, lane ?? runLanes.get(r))) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
      }
    };
    /**
     * The lane a claude-code job that nothing has placed yet should take: the
     * first subscription with a slot free, else the default one. Pinned jobs,
     * manual queue jobs and campaign cells all come through here — they bypass
     * the policy's cap loop, so without this every one of them would pile onto
     * the default subscription while the second sat idle.
     */
    /**
     * Lanes taken by this tick's queue assignments, which `keyCount` does not
     * hold: `planPolicyHeld` counts those itself, so counting them twice would
     * hide a free session from the policy.
     */
    const laneReserve = new Map<string, number>();
    const withLane = (job: FleetJob, lane: string | undefined): FleetJob => {
      if (lane !== undefined) laneMemo.set(job.name, lane);
      return lane === undefined || lane === DEFAULT_CLAUDE_TOKEN_ENV ? job : { ...job, subscription: lane };
    };
    const assignLane = (job: FleetJob): FleetJob => {
      if (job.subscription !== undefined) return job;
      if (!job.refs.some((r) => keyOf(r) === CLAUDE_TOTAL_KEY)) return job;
      // A roster pin outranks everything: that entry bills that subscription.
      const pin = job.refs.map((r) => cfg.roster[r]?.subscription).find((l) => l !== undefined);
      if (pin !== undefined) return withLane(job, pin);
      const known = laneOf(job) ?? laneMemo.get(job.name);
      if (known !== undefined) return withLane(job, known);
      // Room in the lane AND under the overall ceiling: a claude session spends
      // both, so a free subscription with the total spent is not free.
      const free = cfg.policy.subscriptions.find((l) =>
        claudeKeysFor(l).every((k) => {
          const cap = capFor(cfg.maxConcurrent, k);
          return cap === undefined || (keyCount.get(k) ?? 0) + (laneReserve.get(k) ?? 0) < cap;
        }),
      );
      // Nothing free: the job is pinned or manual, so it is not held for a cap
      // it never consulted — it takes the default lane, as it did before there
      // was a second one.
      return withLane(job, free);
    };
    /** Assign a lane and reserve it: for a job the policy's own cap loop will count. */
    const reserveLane = (job: FleetJob): FleetJob => {
      const placed = assignLane(job);
      if (job.refs.some((r) => keyOf(r) === CLAUDE_TOTAL_KEY)) {
        for (const k of claudeKeysFor(placed.subscription)) laneReserve.set(k, (laneReserve.get(k) ?? 0) + 1);
      }
      return placed;
    };
    for (const n of [...laneMemo.keys()]) if (!sets.running.has(n) && !pending.has(n)) laneMemo.delete(n);
    // Pinned jobs: from the file, on their own accounts — plus a pinned
    // campaign's next cell, which is a pinned job in everything but where it
    // was written down.
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
      const placed = assignLane(job);
      out.push(jobSpawn(placed, cfg.roster, job.account!, stampToday, eligible, cfg.campaigns));
      if (job.enabled || sets.running.has(job.name)) {
        for (const r of job.refs) runningRefs.add(r);
        // An enabled pinned job spawns this tick if it is not already running,
        // so it counts against the driver cap either way — otherwise the first
        // tick after a restart fills the pool before the pinned session exists.
        countKey(placed.refs, placed.subscription);
      }
    }
    // Pool jobs with a live process: keep running whatever the file now says,
    // drain if the file dropped them or their refs.
    for (const [name, account] of assigned) {
      const running = liveJobs.get(name);
      const fromFile = byName.get(name);
      if (running?.source === "policy") {
        const dropped = policyJobDropped(running, cfg.roster[running.ref]);
        if (dropped !== undefined) {
          // A disabled stand-in makes diffJobs drain it, and for a freeplay
          // stream a drain is an immediate SIGTERM (`pausesOnDrain`): the run
          // pauses as `operator-pause` and `planResumes` leaves it listed while
          // the ref stays out of the unlimited lane, so nothing respawns it.
          drainReasons.set(name, dropped);
          out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
          // A session under SIGTERM still holds its driver slot until the
          // process exits (runner backstop 60s, roster SIGKILL grace 90s), and
          // this tick's picks are planned below: without this the flip frees a
          // claude lane a live stream is still on and the policy spills a spawn
          // onto it, which is the 2026-08-24 incident the backstop block below
          // was written for — and that block skips anything in `assigned`.
          runningRefs.add(running.ref);
          countKey(running.refs, laneOf(running));
          if (billingOf.get(running.ref) === "paid") paidRunning++;
        } else {
          const placed = assignLane(running);
          out.push(jobSpawn(placed, cfg.roster, account, stampToday, undefined, cfg.campaigns));
          runningRefs.add(running.ref);
          countKey(placed.refs, placed.subscription);
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
      const placed = assignLane(fromFile);
      out.push(jobSpawn(placed, cfg.roster, account, stampToday, eligible, cfg.campaigns));
      for (const r of fromFile.refs) runningRefs.add(r);
      countKey(placed.refs, placed.subscription);
      // A manual pool job on a paid model holds a paid slot too: the cap is
      // about what is billing at once, not about who asked for it.
      for (const r of fromFile.refs) if (billingOf.get(r) === "paid") paidRunning++;
    }
    // Live processes the file no longer YIELDS still hold a session on their
    // driver: a completed campaign cell draining to its episode boundary, a
    // job whose config entry vanished. The pinned loop above walks what the
    // config yields, so such a process silently stopped occupying a slot —
    // which is how a third claude-code stream spilled onto a cap of 2 while
    // nav-probe-coldridge (cell quota met, draining) was still alive
    // (2026-08-24). Count every live job the loops above did not.
    {
      const yielded = new Set([...pinnedJobs(cfg), ...campaignJobs].map((j) => j.name));
      for (const name of sets.running) {
        if (yielded.has(name) || assigned.has(name)) continue;
        const job = liveJobs.get(name);
        if (job === undefined) continue;
        for (const r of job.refs) runningRefs.add(r);
        countKey(job.refs, laneOf(job));
        for (const r of job.refs) if (billingOf.get(r) === "paid") paidRunning++;
      }
    }
    const held = (a: string): string | undefined => accountHeldBy(a, "");
    // Resumes before anything fresh: a paused run goes back onto
    // its own account ahead of the queue and the policy, so nothing can wipe
    // its character first. A pinned job's spawn is replaced by its resume
    // spawn; a pool job's resume reserves its account like an assignment.
    const runningMap = new Map<string, string>(assigned);
    for (const job of pinnedJobs(cfg)) if (sets.running.has(job.name)) runningMap.set(job.name, job.account!);
    const resumes = planResumes({ runs, config: cfg, running: runningMap, held, now: Date.now() });
    lastPaused = resumes.listed;
    // Runs nothing came back for are ended on every tick, boot
    // included: the host slept, or the fleet was down past the run's own
    // budget, and neither a live run nor a paused one survives that.
    const lapsed = [
      ...resumes.end,
      ...planStaleRuns({
        runs,
        campaigns: cfg.campaigns,
        refs: Object.keys(cfg.roster),
        busyAccounts: new Set([...runningMap.values()].map((a) => a.toUpperCase())),
        now: Date.now(),
      }),
    ];
    // A lapsed run is ended through the runner's own writer, once, and leaves
    // the paused set. Its session goes back with it, so the fresh attempt this
    // record promises does not land on an account that is still held.
    const lapsedRetries = retryNumbers(lapsed, (e) => failedAttemptsFor(states, e) ?? 0);
    const applied: EndedRun[] = [];
    for (const r of endRuns(RUNS_DIR, lapsed)) {
      const i = lapsed.findIndex((x) => x.runId === r.runId);
      const e = lapsed[i]!;
      if (r.error !== undefined) {
        say(`end ${e.runId}: could not write the termination — ${r.error}`);
        record({ job: `${e.ref ?? e.model}-${e.episode}`, event: "end-failed", detail: `${e.detail}; ${r.error}` });
        continue;
      }
      endedRuns.push(e);
      applied.push(e);
      const line = formatEndedRun(e, lapsedRetries[i]);
      say(`end ${e.runId}: ${line}`);
      record({ job: `${e.ref ?? e.model}-${e.episode}`, event: "ended", detail: line });
    }
    if (lapsed.length > 0) void releaseEndedSessions(lapsed, say);
    if (applied.length > 0) {
      // The queue's gate, the policy's picks and the state file all read the
      // post-sweep projection from here down. Nothing above this line reads a
      // strike: the pinned jobs and the live pool jobs are the operator's, and
      // the manual queue outranks a taint by decision anyway (docs/OPERATIONS.md).
      states = statesAfterSweep(cfg, runs, applied, Date.now());
      eligible = eligibleFrom(states);
    }
    const reserved = new Map<string, string>();
    for (const r of resumes.resume) {
      const name = r.job.name;
      if (sets.running.has(name)) continue;
      // A resumed run goes back to the subscription it started on: the runner
      // rebuilds its config from meta.json, and the lane is in it. Stamped on
      // the spawn too so the count and the state file agree with the run.
      const resumed = assignLane(r.job);
      const spawn = jobSpawn(resumed, cfg.roster, r.account, stampToday, undefined, cfg.campaigns);
      if (r.job.account !== undefined) {
        pending.set(name, resumed);
        const idx = out.findIndex((l) => l.name === name);
        if (idx >= 0) out[idx] = spawn;
        else out.push(spawn);
      } else {
        pending.set(name, resumed);
        sets.finished.delete(name);
        reserved.set(name, r.account);
        out.push(spawn);
        for (const ref of r.job.refs) {
          runningRefs.add(ref);
          if (billingOf.get(ref) === "paid") paidRunning++;
        }
        countKey(resumed.refs, resumed.subscription);
      }
      const key = `resume:${r.runId}:${r.pauseCount}`;
      if (!announcedPicks.has(key)) {
        announcedPicks.add(key);
        say(`resume ${name}: ${r.runId} on ${r.account} — ${r.why}`);
        record({ job: name, event: "resume", detail: `${r.runId} on ${r.account}: ${r.why}` });
      }
    }
    const runningAndReserved = new Map([...assigned, ...reserved]);
    // Who holds each account this tick, for the stream rule (`streamStanding`):
    // the live pool jobs, the pinned ones, and the resumes reserving theirs.
    const occupants = new Map<string, Occupant>();
    {
      const claim = (account: string, job: FleetJob | undefined): void => {
        if (job === undefined) return;
        occupants.set(account.toUpperCase(), { ref: job.ref, unlimited: pausesOnDrain(job) && cfg.roster[job.ref]?.idle === "unlimited" });
      };
      for (const [name, account] of assigned) claim(account, liveJobs.get(name));
      for (const job of pinnedJobs(cfg)) if (sets.running.has(job.name)) claim(job.account!, job);
      for (const r of resumes.resume) claim(r.account, r.job);
    }
    // Where each model's last character is standing. Read once a
    // tick from the same run facts everything else here reads.
    const affinityMap = affinityFrom(runs, cfg.roster);
    // Where each unlimited ref's freeplay stream stands; a freeplay pick
    // goes back to that account, every fresh launch keeps those characters.
    const streams = streamsFrom(runs, cfg.roster);
    const affinity = streamAffinity(streams, affinityOf(affinityMap));
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
      affinity,
    });
    lastPlan.skipped.unshift(...pinnedSkips);
    // Every fresh launch this tick, for the cross-account name sweep below.
    const freshAssign: { ref: string; account: string }[] = [];
    for (const a of lastPlan.assign) {
      const { account } = a;
      // The lane is settled here, on the plan's own job, so the policy's cap
      // loop counts this assignment against the subscription it actually took.
      a.job = reserveLane(a.job);
      const keep = keepFor(account, streams);
      if (keep.length > 0) a.job = { ...a.job, keepCharacters: keep };
      pending.set(a.job.name, a.job);
      for (const r of a.job.refs) freshAssign.push({ ref: r, account });
      out.push(jobSpawn(a.job, cfg.roster, account, stampToday, eligible, cfg.campaigns));
    }
    // The policy fills what the queue left free. A gated spawn is not a
    // problem: the pick is re-made next tick from the same projection.
    if (scheduledAccounts(cfg).length > 0) {
      const allowed = policyRefs(cfg);
      const continued = planContinuations(
        planPolicy({
        states: states.filter((st) => allowed.has(st.name)),
        pool: cfg.accounts.pool,
        classPools: classPoolsOf(cfg),
        running: runningAndReserved,
        held,
        queuePlan: lastPlan,
        runningRefs,
        concurrency: { keyOf, max: cfg.maxConcurrent, running: keyCount, pinnedLane: (n) => cfg.roster[n]?.subscription },
        policy: cfg.policy,
        paidRunning,
        campaigns: unpinnedCampaigns(cfg),
        probeRuns: probes,
        affinity,
        }),
        streams,
        cfg.roster,
        occupants,
      );
      const picks = continued.picks;
      for (const w of continued.waiting) {
        const key = `${w.name}:stream:${w.stream.runId}:${w.why}`;
        if (!announcedPicks.has(key)) {
          announcedPicks.add(key);
          say(`policy ${w.name}: waiting — ${w.why}; not starting fresh on ${w.offered}`);
          record({ job: w.name, event: "stream-waiting", detail: `${w.why}; offered ${w.offered}` });
        }
      }
      for (const d of continued.dropped) {
        const key = `${d.name}:stream-dropped:${d.stream.runId}`;
        if (!announcedPicks.has(key)) {
          announcedPicks.add(key);
          say(`policy ${d.name}: ${d.stream.account} is occupied by ${d.occupant}'s stream — starting fresh on ${d.account}, lineage ${d.stream.runId} (${d.stream.character}) dropped`);
          record({ job: d.name, event: "stream-dropped", detail: `${d.stream.runId} (${d.stream.character} on ${d.stream.account}) account_occupied_by ${d.occupant}; fresh on ${d.account}` });
        }
      }
      // A stream whose head is on another ref's account and that got NO pick
      // this tick (no free account, the cap, the gate) says so once, so the
      // wait reads as a wait for a free account and not as the item-94 hold.
      for (const [ref, st] of streams) {
        if (!allowed.has(ref) || runningRefs.has(ref)) continue;
        if (picks.some((p) => p.job.ref === ref) || continued.waiting.some((w) => w.name === `${ref}-freeplay`)) continue;
        const standing = streamStanding(ref, st, occupants);
        if (standing.kind !== "occupied") continue;
        const key = `${ref}:stream-blocked:${st.runId}:${standing.occupant}`;
        if (!announcedPicks.has(key)) {
          announcedPicks.add(key);
          say(`policy ${ref}: ${describeStanding(st, standing)} — none free this tick`);
        }
      }
      for (const { job, account, why } of picks) {
        // Remember the lane the cap loop placed this pick on: the run does not
        // exist on disk yet, and the next tick must not move it.
        laneMemo.set(job.name, job.subscription ?? DEFAULT_CLAUDE_TOKEN_ENV);
        pending.set(job.name, job);
        // A policy job that finished an earlier attempt is fair game again;
        // the projection, not the finished set, decides whether it runs.
        sets.finished.delete(job.name);
        const key = `${job.name}:${job.attempt}`;
        if (!announcedPicks.has(key)) {
          announcedPicks.add(key);
          const tag = (isExtraJob(job) ? " (extra)" : "") + (job.continueFrom !== undefined ? ` (continues ${job.continueFrom})` : "");
          say(`policy ${job.name}: ${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account} — ${why}`);
          record({ job: job.name, event: "policy-pick", detail: `${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account}: ${why}` });
        }
        for (const r of job.refs) freshAssign.push({ ref: r, account });
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
    // Cross-account name hygiene: a name the launching account's own
    // hygiene cannot see, on an account this tick calls free.
    if (freshAssign.length > 0) {
      const busy = new Set(
        [...runningAndReserved.values(), ...lastPlan.assign.map((a) => a.account), ...freshAssign.map((a) => a.account)].map((a) =>
          a.toUpperCase(),
        ),
      );
      const sweeps = planNameSweeps({
        assign: freshAssign,
        affinity: affinityMap,
        isFree: (a) => !busy.has(a.toUpperCase()) && held(a) === undefined,
        protect: new Set([...streams.values()].map((s) => streamKey(s.account, s.character))),
      });
      if (sweeps.length > 0) void sweepNames(sweeps, say);
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
    campaigns: cfg.campaigns,
    finished: sets.finished,
    waiting: lastPlan.waiting.map((j) => j.name),
    skipped: lastPlan.skipped.map((sk) => ({ name: sk.job.name, reason: sk.reason })),
    ...(policyIdle !== undefined ? { policyIdle } : {}),
    session,
    paused: lastPaused,
    ended: endedRuns,
  });

  const spawnJob = (spawn: JobSpawn): void => {
    {
      // The breaker, before anything is written or spawned. Handing the
      // account back via `pending` is what makes a hold a hold: the planner
      // re-picks next tick, lands here again, and stays quiet until the
      // window lapses.
      const now = Date.now();
      const exits = (shortLivedExits.get(spawn.name) ?? []).filter((t) => now - t <= BREAKER_WINDOW_MS);
      shortLivedExits.set(spawn.name, exits);
      if (tripsBreaker(exits, now)) {
        const until = breakerHolds.get(spawn.name);
        if (until === undefined || now >= until) {
          breakerHolds.set(spawn.name, now + BREAKER_WINDOW_MS);
          const detail = `${exits.length} spawns died within ${Math.round(BREAKER_SHORT_LIVED_MS / 1000)}s of launch in the last ${Math.round(BREAKER_WINDOW_MS / 60_000)}m`;
          say(`job ${spawn.name}: crash loop — ${detail}; holding ${Math.round(BREAKER_WINDOW_MS / 60_000)}m (${jobLogPath(spawn.name, stampToday)} says why)`);
          record({ job: spawn.name, event: "breaker-hold", detail });
        }
        pending.delete(spawn.name);
        return;
      }
    }
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
      // The breaker's input: a process that died this fast launched nothing.
      if (Date.now() - lp.spawnedAt < BREAKER_SHORT_LIVED_MS) {
        const arr = shortLivedExits.get(spawn.name) ?? [];
        arr.push(Date.now());
        shortLivedExits.set(spawn.name, arr);
      }
    });
    procs.set(spawn.name, lp);
    pauseSignalled.delete(spawn.name);
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
    say("stopping: SIGTERM to every job — each live episode PAUSES as operator-pause; waiting for the rosters to exit");
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

  /**
   * The pause switch, re-read every tick beside the config. Boot reads it too:
   * a supervisor that comes back up inside an update window must not fill the
   * pool before the operator has cleared the switch.
   */
  const readPause = (): void => {
    const now = readPauseSidecar();
    if ((now === undefined) === (pauseSwitch === undefined)) {
      pauseSwitch = now;
      return;
    }
    pauseSwitch = now;
    if (now !== undefined) {
      say(`fleet PAUSED by ${PAUSE_PATH}: ${now.why} — nothing new is launched; live jobs drain at their episode boundary`);
      record({ job: "-", event: "paused", detail: now.why });
    } else {
      say("pause switch cleared — scheduling again on this tick");
      record({ job: "-", event: "unpaused" });
    }
  };
  readPause();
  if (pauseSwitch !== undefined) {
    say(`fleet PAUSED at boot by ${PAUSE_PATH}: ${pauseSwitch.why} — delete that file to schedule again`);
  }

  let mayStart = await checkGate(config.preflight);
  if (mayStart) for (const spawn of diffJobs(applyPause(effectiveJobs(config), pauseSwitch !== undefined), sets).start) spawnJob(spawn);
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

    // Refused pins (item 66). Deduped on the joined set, the way the rejection
    // is deduped on its message: a config that keeps refusing the same pin says
    // so once, not every 60s, but a NEW refusal always speaks.
    const refusals = config.refusals.map((r) => `${r.pin}: ${r.why}`).join("\n");
    if (refusals !== lastRefusals) {
      lastRefusals = refusals;
      for (const r of config.refusals) {
        say(`config: ${r.pin} REFUSED and left disabled: ${r.why}`);
        record({ job: "-", event: "config-refusal", detail: `${r.pin}: ${r.why}` });
      }
    }

    readPause();
    const actions = diffJobs(applyPause(effectiveJobs(config), pauseSwitch !== undefined), sets);
    // A refusal suppresses SCHEDULING; it must never drain. A disabled pin
    // normally means the operator parked it, so `diffJobs` drains its live run
    // at the next episode boundary — but a refused pin was not parked, it was
    // overruled, and under the old whole-file rejection the live run was never
    // touched at all. Without this, adding one queue job on an account a
    // campaign already holds would SIGTERM a probe hours into its episode:
    // strictly worse than the outage this replaced, because it destroys work
    // rather than confusing someone. The run finishes and does not respawn.
    const refusedJobs = new Set(config.refusals.flatMap((r) => r.jobs));
    for (const name of actions.drain.filter((n) => refusedJobs.has(n))) {
      if (spared.has(name)) continue;
      spared.add(name);
      say(`job ${name}: it was refused by the config rules — the live run is left alone, and will not respawn`);
      record({ job: name, event: "refusal-spared" });
    }
    actions.drain = actions.drain.filter((n) => !refusedJobs.has(n));
    // A pin that stops being refused may be drained again like any other.
    for (const name of [...spared]) if (!refusedJobs.has(name)) spared.delete(name);
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
      const why = pauseSwitch !== undefined ? "the fleet is paused" : (drainReasons.get(name) ?? "disabled");
      const how = pausesOnDrain(liveJobs.get(name)) ? "pausing now (no episode boundary on an unlimited session)" : "draining (SIGTERM at the next episode boundary)";
      say(`job ${name}: ${why} — ${how}`);
      record({ job: name, event: "draining", detail: why });
    }
    // Drains: only SIGTERM a roster with no episode child. Delivered BEFORE the
    // gate, which can sit inside a smoke for minutes: an operator parking a job
    // must never wait on the gate for their SIGTERM.
    for (const name of [...sets.draining]) {
      const p = procs.get(name);
      if (p === undefined || p.exited) continue;
      const now = pausesOnDrain(liveJobs.get(name));
      if (now && pauseSignalled.has(name)) continue;
      if (now) pauseSignalled.add(name);
      if (now || !hasLiveChild(p.pid)) {
        try {
          process.kill(p.pid, "SIGTERM");
        } catch {
          // already gone
        }
        say(`job ${name}: ${now ? "unlimited session — SIGTERM sent, the run pauses" : "between episodes — SIGTERM sent"}`);
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
    const toStart =
      diffJobs(applyPause(effectiveJobs(config), pauseSwitch !== undefined), sets).start.length +
      (pauseSwitch !== undefined ? 0 : lastPlan.waiting.length);
    if (fleetComplete({ running: sets.running.size, toStart, hasDeadline: args.until !== undefined })) {
      say("all jobs have exited and nothing is left to spawn — fleet complete");
      break;
    }
    const idle = sets.running.size === 0 && toStart === 0;
    if (idle !== wasIdle) {
      wasIdle = idle;
      if (idle) {
        say(
          pauseSwitch !== undefined
            ? `paused and quiet: no job is running and nothing will launch until ${PAUSE_PATH} is deleted — the update window is open`
            : "no jobs running and none to spawn — idling; enable a job in fleet.json (or stop the service)",
        );
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
