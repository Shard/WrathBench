#!/usr/bin/env bun
/**
 * Overnight roster orchestrator.
 *
 *   ./infra/run-roster.sh infra/roster-example.json --until 07:30
 *   ./infra/run-roster.sh infra/roster-example.json --max-hours 8 --skip nvidia/nemotron-3-ultra-550b-a55b:free
 *   ./infra/run-roster.sh infra/roster-example.json --dry-run
 *   ./infra/run-roster.sh infra/roster-claude.json --loop --until 07:30
 *
 * Every entry is config: `model`, `driver` (openai | claude-subscription),
 * `account`, `effort`, `apiBase`/`apiKeyEnv` (openai only),
 * `character`/`race`/`class`, `episodeMs`. Everything but `model` has a default, so the old shape — a bare
 * list of `{ "model": ... }` — still means exactly what it meant before.
 *
 * One episode at a time, in roster order, each launched through
 * `infra/run-episode.sh` (so its preflight, .env handling and harness version
 * stamping all still apply — nothing here reimplements it).
 *
 * Why this exists: OpenRouter free-tier limits are per *upstream provider*, not
 * per account. When one model's pool is saturated the useful move is not to sit
 * on a backoff, it is to advance to the next model and come back later. So a
 * run that pauses `rate-limited` before it got going is deferred to a retry
 * queue and the roster moves on; a run that pauses mid-episode is worth
 * resuming in place, because its character and scratchpad are live progress.
 *
 * Two live-world facts drive the session handling here:
 *
 *  - A PAUSED run keeps its module session alive on purpose (that is what
 *    `--resume` reattaches to), and a live session holds the game account. The
 *    whole roster shares RUNNER, so the next episode would fail every
 *    createSession with `account_in_use`. Whenever the roster advances past a
 *    paused run, and defensively before every launch, we DELETE /session for
 *    that run's token, read back from its meta.json (`tokenOfRun`) now that
 *    tokens are random secrets rather than the run id. The *character*
 *    survives, so a later
 *    `--resume` still works.
 *  - A fresh (non-resumed) run wipes every character on its account first
 *    (runner/src/run.ts episode hygiene). So a run deferred to the end of the
 *    roster comes back to an empty account: `--resume` restores its trajectory
 *    and scratchpad, not its level. That is the reason mid-episode pauses are
 *    retried in place *before* being deferred.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// ------------------------------------------------------------------ types

type Driver = "openai" | "claude-subscription";

export interface RosterSpec {
  model: string;
  /** Defaults to "openai". `claude-subscription` runs are SHAKEOUT-ONLY. */
  driver?: Driver;
  /** Game account for the entry's session. Omitted -> the runner's default. */
  account?: string;
  /** Reasoning effort. Omitted -> the provider's own default, not a level. */
  effort?: string;
  apiBase?: string;
  apiKeyEnv?: string;
  runId?: string;
  character?: string;
  race?: number;
  class?: number;
  episodeMs?: number;
}

export interface Resolved {
  model: string;
  driver: Driver;
  account: string | undefined;
  effort: string | undefined;
  apiBase: string;
  apiKeyEnv: string;
  runId: string;
  character: string;
  race: number;
  class: number;
  episodeMs: number;
}

type Outcome =
  | "launch-failed"
  | "done"
  | "done-failed"
  | "retry"
  | "deferred"
  | "paused-operator"
  | "unknown"
  | "session-freed"
  | "skipped"
  | "budget-stop";

const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_API_KEY_ENV = "OPENROUTER_KEY";
const DEFAULT_EPISODE_MS = 5_400_000; // 90 minutes
const RETRY_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];
const MAX_RETRY_CYCLES = 2;
const CYCLE_GAP_MS = 10 * 60_000;
const EARLY_TURN_THRESHOLD = 2;
const CHILD_TERM_GRACE_MS = 30_000;
const RUNS_DIR = "data/runs";
/** A trajectory touched more recently than this belongs to a live process. */
const LIVE_TRAJECTORY_MS = 3 * 60_000;
const ACCOUNT_WAIT_POLL_MS = 60_000;
const ACCOUNT_WAIT_MAX_MS = 30 * 60_000;

const REPO_ROOT = dirname(import.meta.dir);
const COMPOSE_FILE = join(REPO_ROOT, "infra", "compose.yml");
const EPISODE_SH = join(REPO_ROOT, "infra", "run-episode.sh");

// ------------------------------------------------------------------ args

function parseArgs(argv: string[]): {
  roster: string | undefined;
  dryRun: boolean;
  loop: boolean;
  resumeRoster: boolean;
  until: string | undefined;
  maxHours: number | undefined;
  skip: string[];
  freeTokens: string[];
  date: string | undefined;
  log: string | undefined;
} {
  let roster: string | undefined;
  let dryRun = false;
  let loop = false;
  let resumeRoster = false;
  let until: string | undefined;
  let maxHours: number | undefined;
  let log: string | undefined;
  let date: string | undefined;
  const skip: string[] = [];
  const freeTokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--loop":
        loop = true;
        break;
      case "--resume-roster":
        resumeRoster = true;
        break;
      case "--until":
        until = argv[++i];
        break;
      case "--max-hours":
        maxHours = Number(argv[++i]);
        break;
      case "--skip":
        {
          const v = argv[++i];
          if (v !== undefined) skip.push(v);
        }
        break;
      case "--date":
        date = argv[++i];
        break;
      case "--free-tokens":
        {
          const v = argv[++i];
          if (v !== undefined) freeTokens.push(...v.split(",").filter((t) => t.length > 0));
        }
        break;
      case "--log":
        log = argv[++i];
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`run-roster: unknown flag ${a}`);
          usage();
          process.exit(2);
        }
        roster = a;
    }
  }
  return { roster, dryRun, loop, resumeRoster, until, maxHours, skip, freeTokens, date, log };
}

function usage(): void {
  console.error(
    [
      "usage: infra/run-roster.sh <roster.json> [flags]",
      "",
      "  --until HH:MM        stop launching after this local time (tomorrow if already past)",
      "  --max-hours N        stop launching after N hours from now",
      "  --skip <model-id>    omit a model from the roster (repeatable)",
      "  --free-tokens a,b    DELETE /session for these run ids (or literal tokens) before",
      "                       starting; a run id is resolved to its stored token —",
      "                       a hand-started paused run still holds the shared game account",
      "  --loop               when the roster is exhausted, start over (cycle 2+ run ids get a",
      "                       -cN suffix so each pass is its own run). Requires --until/--max-hours",
      "  --resume-roster      continue a partially completed roster",
      "  --date YYYYMMDD      the stamp in derived run ids and the log name. Defaults to today —",
      "                       pass the ORIGINAL date when resuming a roster after midnight, or the",
      "                       derived run ids change and every model relaunches from scratch",
      "  --dry-run            print the plan and the exact argv per episode; launch nothing",
      "  --log <path>         roster JSONL (default data/runs/roster-<YYYYMMDD>.jsonl)",
    ].join("\n"),
  );
}

// ------------------------------------------------------------- derivation

export function slug(model: string): string {
  const tail = model.split("/").pop() ?? model;
  return tail
    .replace(/:free$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function dateStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Letters only, <= 12 chars, unique within the roster (letter suffix). */
function deriveCharacter(model: string, taken: Set<string>): string {
  const letters = slug(model).replace(/[^a-z]/g, "");
  const base = (letters.length >= 2 ? letters : "benchy").slice(0, 12);
  const name = base.charAt(0).toUpperCase() + base.slice(1);
  if (!taken.has(name.toLowerCase())) return name;
  for (const c of "abcdefghijklmnopqrstuvwxyz") {
    const stem = name.length >= 12 ? name.slice(0, 11) : name;
    const cand = stem + c.toUpperCase();
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return name.slice(0, 11) + "Z";
}

export function resolve(specs: RosterSpec[], stamp: string): Resolved[] {
  const taken = new Set<string>();
  const out: Resolved[] = [];
  for (const s of specs) {
    if (typeof s.model !== "string" || s.model.length === 0) {
      throw new Error(`roster entry without a model: ${JSON.stringify(s)}`);
    }
    const driver = s.driver ?? "openai";
    if (driver !== "openai" && driver !== "claude-subscription") {
      throw new Error(`roster entry ${s.model}: unknown driver ${String(driver)}`);
    }
    const character = s.character ?? deriveCharacter(s.model, taken);
    taken.add(character.toLowerCase());
    out.push({
      model: s.model,
      driver,
      account: s.account,
      effort: s.effort,
      apiBase: s.apiBase ?? DEFAULT_API_BASE,
      apiKeyEnv: s.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      // Effort is part of the run's identity, so it is part of the derived id:
      // opus at low and opus at high are two rows in the matrix, and a shared
      // run id would make them one run appended to twice.
      runId: s.runId ?? `roster-${slug(s.model)}${s.effort !== undefined ? `-${slug(s.effort)}` : ""}-${stamp}`,
      character,
      race: s.race ?? 1,
      class: s.class ?? 2,
      episodeMs: s.episodeMs ?? DEFAULT_EPISODE_MS,
    });
  }
  return out;
}

/**
 * The api-base/api-key-env pair is meaningless to the claude-subscription
 * driver (it authenticates through the `claude` CLI's own OAuth token), so a
 * claude entry gets neither flag. Everything else is driver-independent.
 */
export function episodeArgv(spec: Resolved, resume: boolean): string[] {
  if (resume) return [EPISODE_SH, "--resume", spec.runId];
  const argv = [EPISODE_SH, "--driver", spec.driver, "--model", spec.model, "--run-id", spec.runId];
  if (spec.driver === "openai") {
    argv.push("--api-base", spec.apiBase, "--api-key-env", spec.apiKeyEnv);
  }
  if (spec.account !== undefined) argv.push("--account", spec.account);
  if (spec.effort !== undefined) argv.push("--effort", spec.effort);
  argv.push(
    "--character",
    spec.character,
    "--race",
    String(spec.race),
    "--class",
    String(spec.class),
    "--episode-ms",
    String(spec.episodeMs),
  );
  return argv;
}

/** A cycle-2+ copy of a spec: same identity, its own run id. */
export function forCycle(spec: Resolved, cycle: number): Resolved {
  return cycle <= 1 ? spec : { ...spec, runId: `${spec.runId}-c${cycle}` };
}

/**
 * Cycle numbering restarts at 1 with the roster process, so a relaunch after a
 * ctrl-C would hand cycle 2 the run id an earlier process already used —
 * appending to its trajectory and overwriting the row classify() reads. Skip
 * forward past any cycle id that already exists on disk.
 */
function freeCycle(specs: Resolved[], cycle: number): number {
  for (let c = cycle; c < cycle + 100; c++) {
    if (specs.every((s) => !existsSync(runDir(forCycle(s, c).runId)))) return c;
  }
  return cycle;
}

// ------------------------------------------------------------- defer backoff
//
// Why a per-spec backoff instead of dropping deferred specs onto the retry
// queue: the retry queue at the end of main() is only reachable in NON-loop
// runs — under `--loop` the main cycle loop exits only on stop or deadline, and
// both disable the retry loop. So an overnight `--loop` fleet has to back a
// rate-limited model off *within* the rotation, or it either never retries
// (dropped) or hammers the saturated provider (relaunched fresh every cycle
// with no gap — the observed mimo-v2.5-free failure: 3 launches/min, all 429).
//
// A deferred spec therefore stays in the rotation but carries a `notBefore`:
// cycles before it are skipped with no launch and no session churn; the first
// cycle after it *resumes the same run id* rather than spawning a fresh L1
// `-cN`. Backoff escalates through RETRY_BACKOFF_MS on consecutive defers and
// is cleared the moment the spec finishes (`done`).

export interface DeferEntry {
  /** The run id that actually paused — resume targets this, never a new -cN. */
  runId: string;
  /** now + backoff; cycles before this skip the spec without launching. */
  notBefore: number;
  /** Consecutive defers, indexes RETRY_BACKOFF_MS (clamped to the last step). */
  defers: number;
  /** The pause reason carried for the log and operator lines. */
  reason: string;
}

export type AttemptPlan =
  | { kind: "skip"; until: number; reason: string }
  | { kind: "resume"; runId: string; reason: string }
  | { kind: "fresh" };

/** Escalating backoff for the Nth consecutive defer (1-based), clamped. */
export function backoffMs(defers: number): number {
  const i = Math.min(Math.max(defers, 1) - 1, RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[i]!;
}

/**
 * What a loop cycle should do with one spec, given its defer state.
 *
 *  - no entry            -> `fresh` (a healthy spec; the caller applies forCycle
 *                           for its own -cN burn sample, preserving loop semantics)
 *  - entry, still cooling -> `skip` (do not launch; this is what kills hammering,
 *                           and it is per-spec so a lane-mate failing in seconds
 *                           cannot drag this spec back into a fast relaunch)
 *  - entry, cooled off    -> `resume` the *stored* run id in place
 */
export function planAttempt(entry: DeferEntry | undefined, now: number): AttemptPlan {
  if (entry === undefined) return { kind: "fresh" };
  if (now < entry.notBefore) return { kind: "skip", until: entry.notBefore, reason: entry.reason };
  return { kind: "resume", runId: entry.runId, reason: entry.reason };
}

// ------------------------------------------------------------------- run state

interface RunRow {
  termination_reason: string | null;
  termination_detail: string | null;
  pause_reason: string | null;
}

function runDir(runId: string): string {
  return join(REPO_ROOT, RUNS_DIR, runId);
}

function readRunRow(runId: string): RunRow | undefined {
  const path = join(runDir(runId), "run.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .query("SELECT termination_reason, termination_detail, pause_reason FROM run WHERE run_id = ?")
        .get(runId) as RunRow | null;
      return row ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** The character a resumed run will actually use, per its stored meta.json. */
function metaCharacter(runId: string): string | undefined {
  const path = join(runDir(runId), "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config?: { character?: string } };
    return meta.config?.character;
  } catch {
    return undefined;
  }
}

/**
 * The session token a run actually holds. Tokens used to equal the run id;
 * since token hardening (FOLLOW-UPS 19) they are random secrets, so the only
 * way to address a run's module session is to read the token back out of the
 * meta.json the runner persisted. The run-id fallback covers pre-hardening
 * runs, whose token *was* the run id.
 */
function tokenOfRun(runId: string): string {
  const path = join(runDir(runId), "meta.json");
  if (!existsSync(path)) return runId;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config?: { token?: string } };
    return meta.config?.token ?? runId;
  } catch {
    return runId;
  }
}

function readLevel(runId: string): number | undefined {
  const path = join(runDir(runId), "run.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query("SELECT MAX(level) AS lvl FROM state WHERE run_id = ?").get(runId) as
        | { lvl: number | null }
        | null;
      return row?.lvl ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Turns made by *this* attempt. A resumed run appends to the same trajectory,
 * so a whole-file count would read "one turn, twice" as a healthy two-turn run
 * and retry something that never got off the ground. Not available from sqlite
 * at all — the run table has no turn column.
 */
function turnsSince(runId: string, sinceTs: number): number {
  const path = join(runDir(runId), "trajectory.jsonl");
  if (!existsSync(path)) return 0;
  let n = 0;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.length === 0 || !line.includes('"response"')) continue;
      try {
        const ev = JSON.parse(line) as { t?: string; ts?: number };
        if (ev.t === "response" && typeof ev.ts === "number" && ev.ts >= sinceTs) n++;
      } catch {
        // a torn last line while the runner is still writing: ignore
      }
    }
  } catch {
    return n;
  }
  return n;
}

// ------------------------------------------------------------- account guard

/**
 * The core allows one live session per game account, and the module answers
 * `account_in_use` to the second createSession. Two roster processes (the
 * two-wide pattern) or a hand-started run therefore have to stay off each
 * other's account.
 *
 * `freeSession` cannot be the answer here: it is keyed on the run's own stored
 * token, so it only ever frees the session of the very run the roster is about to launch
 * or resume — never someone else's. Freeing another run's session would kick a
 * *running* process out of the world. So the guard only reads, and waits.
 *
 * "Live" is inferred from the run's own files: no termination row and a write
 * in the last few minutes. A crashed run — no termination row, cold files — is
 * not live and is not waited on. Deliberately no process scan: the
 * only pattern available for one (`*run.ts*<runId>*`, as in signalInContainer)
 * is a substring match, and `roster-x-<date>` is a prefix of the loop's
 * `roster-x-<date>-c2`, so cycle 2 would see cycle 1 as forever alive.
 * The spec's own run id is always excluded — a `--resume` attempt would
 * otherwise refuse to launch the entry it is guarding, forever.
 */
function accountOfRun(runId: string): string | undefined {
  const path = join(runDir(runId), "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { config?: { account?: string } };
    return meta.config?.account;
  } catch {
    return undefined;
  }
}

/** Age of the most recently touched artefact of a run, whichever it is. */
function activityAgeMs(runId: string): number | undefined {
  let newest: number | undefined;
  for (const name of ["trajectory.jsonl", "run.sqlite"]) {
    try {
      const m = statSync(join(runDir(runId), name)).mtimeMs;
      if (newest === undefined || m > newest) newest = m;
    } catch {
      // not written yet
    }
  }
  return newest === undefined ? undefined : Date.now() - newest;
}

/** @returns the run id holding `account`, or undefined when it is free. */
export function accountHeldBy(account: string | undefined, ownRunId: string): string | undefined {
  const want = (account ?? "RUNNER").toUpperCase();
  let dirs: string[];
  try {
    dirs = readdirSync(join(REPO_ROOT, RUNS_DIR));
  } catch {
    return undefined;
  }
  for (const id of dirs) {
    if (id === ownRunId) continue;
    const acct = accountOfRun(id);
    if (acct === undefined || acct.toUpperCase() !== want) continue;
    const row = readRunRow(id);
    if (row !== undefined && row.termination_reason !== null && row.termination_reason !== "") continue;
    // A pause row means the session is already gone: every path in attemptSpec
    // that leaves a paused run behind frees its session first, and
    // pause_reason is only cleared by --resume. Without this skip, the
    // activity-age check below parks the lane for LIVE_TRAJECTORY_MS behind
    // its own just-deferred run's still-warm trajectory (fleet-free-or-a
    // waited 3m behind its deferred glm run, 2026-08-22). A hand-paused run
    // whose operator kept the session alive is the module's to defend: the
    // next createSession fails loudly with account_owned_by_other_token.
    if (row !== undefined && row.pause_reason !== null && row.pause_reason !== "") continue;
    const age = activityAgeMs(id);
    if (age !== undefined && age < LIVE_TRAJECTORY_MS) return id;
  }
  return undefined;
}

/** @returns true when the account came free (or was never held). */
async function awaitAccount(
  spec: Resolved,
  deadline: number | undefined,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return true;
  const giveUp = Date.now() + ACCOUNT_WAIT_MAX_MS;
  for (;;) {
    const holder = accountHeldBy(spec.account, spec.runId);
    if (holder === undefined) return true;
    if (stopping || Date.now() >= giveUp || (deadline !== undefined && Date.now() >= deadline)) {
      say(`account ${spec.account ?? "RUNNER"} still held by ${holder} — skipping ${spec.runId}`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "skipped",
        detail: `account ${spec.account ?? "RUNNER"} in use by ${holder}`,
      });
      return false;
    }
    say(`account ${spec.account ?? "RUNNER"} is live under ${holder} — waiting before ${spec.runId}`);
    await nap(ACCOUNT_WAIT_POLL_MS, deadline, `account ${spec.account ?? "RUNNER"} held by ${holder}`);
  }
}

// ------------------------------------------------------------------ output

let logPath = "";

function stamp(ts: number = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function say(line: string): void {
  console.log(`[${stamp()}] ${line}`);
}

function record(entry: {
  runId: string;
  model: string;
  outcome: Outcome;
  level?: number;
  detail?: string;
}): void {
  if (logPath === "") return;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

// ------------------------------------------------------------------ process

let stopping = false;
let child: ReturnType<typeof Bun.spawn> | undefined;
let childRunId: string | undefined;
const wakeups: (() => void)[] = [];

/**
 * Signal the runner *inside* the container.
 *
 * Verified by hand: SIGTERM to the local `docker compose exec` process does NOT
 * reach the process it started in the container — the exec'd command survives
 * and would be orphaned. So the signal has to be delivered on the other side.
 * Scoped to the run id (which appears in the runner's argv as `--run-id` or
 * `--resume`) so a parallel shakeout run in the same container is never hit.
 */
function signalInContainer(runId: string, signal: "TERM" | "KILL"): void {
  const sh =
    `for d in /proc/[0-9]*; do c=$(tr "\\0" " " < $d/cmdline 2>/dev/null); ` +
    `case "$c" in *run.ts*${runId}*) kill -${signal} "\${d#/proc/}" 2>/dev/null ;; esac; done`;
  try {
    Bun.spawnSync(["docker", "compose", "-f", COMPOSE_FILE, "exec", "-T", "runner", "sh", "-c", sh], {
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // best effort
  }
}

function requestStop(sig: string): void {
  if (stopping) process.exit(130);
  stopping = true;
  say(`${sig}: no further episodes will be launched`);
  for (const w of wakeups.splice(0)) w();
  if (child !== undefined) {
    const c = child;
    const id = childRunId;
    say(`${sig}: terminating the running episode (grace ${CHILD_TERM_GRACE_MS / 1000}s)`);
    c.kill("SIGTERM");
    if (id !== undefined) signalInContainer(id, "TERM");
    setTimeout(() => {
      if (id !== undefined) signalInContainer(id, "KILL");
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, CHILD_TERM_GRACE_MS).unref();
  }
}

/** Sleep that wakes early on stop, and never sleeps past the budget. */
async function nap(ms: number, deadline: number | undefined, why: string): Promise<void> {
  let capped = ms;
  if (deadline !== undefined) capped = Math.min(capped, Math.max(0, deadline - Date.now()));
  if (capped <= 0 || stopping) return;
  say(`waiting ${Math.round(capped / 60_000)}m — ${why}`);
  await new Promise<void>((res) => {
    const timer = setTimeout(res, capped);
    wakeups.push(() => {
      clearTimeout(timer);
      res();
    });
  });
}

async function runEpisode(spec: Resolved, resume: boolean): Promise<number> {
  const argv = episodeArgv(spec, resume);
  childRunId = spec.runId;
  child = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit", // the runner's operator lines all go to stderr
  });
  const code = await child.exited;
  child = undefined;
  childRunId = undefined;
  return code;
}

/**
 * Free the game account held by a paused run's still-live module session.
 * Best effort: the module is only reachable from inside the compose network.
 */
async function freeSession(spec: { runId: string; model: string }, why: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    say(`dry-run: would free module session for ${spec.runId} (${why})`);
    return;
  }
  const code = `const url=(process.env.WRATHBENCH_MODULE_URL??"http://worldserver:8086")+"/session";
const r=await fetch(url,{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({token:process.env.WB_TOKEN})});
console.log("delete-session",r.status,await r.text());`;
  try {
    const p = Bun.spawn(
      [
        "docker",
        "compose",
        "-f",
        COMPOSE_FILE,
        "exec",
        "-T",
        "-e",
        `WB_TOKEN=${tokenOfRun(spec.runId)}`,
        "runner",
        "bun",
        "-e",
        code,
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const out = (await new Response(p.stdout).text()).trim();
    const err = (await new Response(p.stderr).text()).trim();
    const rc = await p.exited;
    const detail = rc === 0 ? out : `exit ${rc}: ${err || out}`;
    say(`freed session for ${spec.runId} (${why}) — ${detail || "no output"}`);
    record({ runId: spec.runId, model: spec.model, outcome: "session-freed", detail: `${why}; ${detail}` });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    say(`could not free session for ${spec.runId}: ${detail}`);
    record({ runId: spec.runId, model: spec.model, outcome: "session-freed", detail: `failed: ${detail}` });
  }
}

// ------------------------------------------------------------------ classify

type Verdict =
  | { kind: "launch-failed"; detail: string }
  | { kind: "terminated"; reason: string; detail: string | undefined }
  | { kind: "paused"; reason: string }
  | { kind: "unknown"; detail: string };

function classify(spec: Resolved, exitCode: number): Verdict {
  const row = readRunRow(spec.runId);
  if (row === undefined) {
    return { kind: "launch-failed", detail: `exit ${exitCode}, no run.sqlite for ${spec.runId}` };
  }
  // Termination first: `--resume` clears the pause row, but checking in this
  // order is correct either way.
  if (row.termination_reason !== null && row.termination_reason !== "") {
    return {
      kind: "terminated",
      reason: row.termination_reason,
      detail: row.termination_detail ?? undefined,
    };
  }
  if (row.pause_reason !== null && row.pause_reason !== "") {
    return { kind: "paused", reason: row.pause_reason };
  }
  return { kind: "unknown", detail: `exit ${exitCode}, run row has neither termination nor pause` };
}

const RATE_PAUSES = new Set(["rate-limited", "quota-exhausted", "window-exhausted"]);

// ------------------------------------------------------------------ main

interface Attempt {
  spec: Resolved;
  resume: boolean;
}

/** @returns true when the spec is finished with (done or given up on). */
async function attemptSpec(
  spec: Resolved,
  opts: { resume: boolean; deadline: number | undefined; dryRun: boolean },
): Promise<"done" | "defer"> {
  let resume = opts.resume;
  for (let retry = 0; ; retry++) {
    if (!(await awaitAccount(spec, opts.deadline, opts.dryRun))) return "done";
    await freeSession(spec, resume ? "pre-resume hygiene" : "pre-launch hygiene", opts.dryRun);
    const launchTs = Date.now();
    say(
      `launch ${spec.model} as ${spec.runId}${resume ? " (--resume)" : ` (character ${spec.character})`}`,
    );
    const code = await runEpisode(spec, resume);
    const verdict = classify(spec, code);
    const level = readLevel(spec.runId);
    const turns = turnsSince(spec.runId, launchTs);

    if (verdict.kind === "launch-failed") {
      say(`launch-failed ${spec.runId}: ${verdict.detail}`);
      record({ runId: spec.runId, model: spec.model, outcome: "launch-failed", detail: verdict.detail });
      return "done";
    }
    if (verdict.kind === "unknown") {
      say(`unknown outcome ${spec.runId}: ${verdict.detail} — advancing`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "unknown",
        ...(level !== undefined ? { level } : {}),
        detail: verdict.detail,
      });
      await freeSession(spec, "unknown outcome", opts.dryRun);
      return "done";
    }
    if (verdict.kind === "terminated") {
      const failed = verdict.reason === "adapter-error" || verdict.reason === "harness-error";
      say(
        `done ${spec.runId}: terminated ${verdict.reason}${level !== undefined ? `, level ${level}` : ""}`,
      );
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: failed ? "done-failed" : "done",
        ...(level !== undefined ? { level } : {}),
        detail: `${verdict.reason}${verdict.detail !== undefined ? `: ${verdict.detail}` : ""}; turns ${turns}`,
      });
      return "done";
    }

    // paused
    if (!RATE_PAUSES.has(verdict.reason)) {
      say(`paused ${spec.runId}: ${verdict.reason} — leaving it for the operator, advancing`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "paused-operator",
        ...(level !== undefined ? { level } : {}),
        detail: verdict.reason,
      });
      await freeSession(spec, `paused ${verdict.reason}`, opts.dryRun);
      return "done";
    }

    // The defer/retry queue exists for OpenRouter's per-provider free-tier
    // pools: another model's pool may be open while this one is saturated, so
    // advancing and coming back is the useful move. A Claude subscription has
    // no such per-provider structure — its episodes end at the episode or
    // tool-call limit, and a pause that does happen will not be cleared by
    // running a different model first. So a claude entry never defers: it is
    // recorded and the roster advances.
    if (spec.driver === "claude-subscription") {
      say(`paused ${spec.runId}: ${verdict.reason} (claude-subscription — no defer queue), advancing`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "paused-operator",
        ...(level !== undefined ? { level } : {}),
        detail: `${verdict.reason}; claude-subscription entries are not deferred; turns ${turns}`,
      });
      await freeSession(spec, `paused ${verdict.reason}`, opts.dryRun);
      return "done";
    }

    const early = turns < EARLY_TURN_THRESHOLD;
    const outOfRetries = retry >= RETRY_BACKOFF_MS.length;
    if (early || outOfRetries || stopping) {
      const why = stopping
        ? "stopping"
        : early
          ? `early saturation (${turns} turn(s) this attempt)`
          : `still ${verdict.reason} after ${retry} retries`;
      say(`defer ${spec.model} (${spec.runId}): ${why}`);
      record({
        runId: spec.runId,
        model: spec.model,
        outcome: "deferred",
        ...(level !== undefined ? { level } : {}),
        detail: `${verdict.reason}; ${why}; deferred runs resume onto a wiped account (character recreated at level 1)`,
      });
      // The paused session still holds the shared account. Free it before the
      // next model starts, or every createSession there fails account_in_use.
      await freeSession(spec, `deferred while ${verdict.reason}`, opts.dryRun);
      return "defer";
    }

    const backoff = RETRY_BACKOFF_MS[retry]!;
    say(
      `retry ${spec.runId} in ${backoff / 60_000}m (${verdict.reason} mid-episode, ${turns} turns this attempt, attempt ${retry + 1}/${RETRY_BACKOFF_MS.length})`,
    );
    record({
      runId: spec.runId,
      model: spec.model,
      outcome: "retry",
      ...(level !== undefined ? { level } : {}),
      detail: `${verdict.reason}; backoff ${backoff}ms; attempt ${retry + 1}/${RETRY_BACKOFF_MS.length}`,
    });
    await nap(backoff, opts.deadline, `backoff before resuming ${spec.runId}`);
    if (stopping || (opts.deadline !== undefined && Date.now() >= opts.deadline)) {
      say(`budget reached during backoff — deferring ${spec.runId}`);
      record({ runId: spec.runId, model: spec.model, outcome: "deferred", detail: "budget reached during backoff" });
      await freeSession(spec, "budget reached during backoff", opts.dryRun);
      return "defer";
    }
    resume = true;
  }
}

function computeDeadline(until: string | undefined, maxHours: number | undefined): number | undefined {
  const now = Date.now();
  const candidates: number[] = [];
  if (until !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(until);
    if (m === null) throw new Error(`--until wants HH:MM, got ${until}`);
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    // Overnight script: a time already past means tomorrow.
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    candidates.push(d.getTime());
  }
  if (maxHours !== undefined) {
    if (!Number.isFinite(maxHours) || maxHours <= 0) throw new Error(`--max-hours wants a positive number`);
    candidates.push(now + maxHours * 3_600_000);
  }
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.roster === undefined) {
    console.error("run-roster: a roster JSON file path is required");
    usage();
    process.exit(2);
  }
  const rosterPath = args.roster;
  if (!existsSync(rosterPath)) {
    console.error(`run-roster: no such roster file: ${rosterPath}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(rosterPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    console.error(`run-roster: ${rosterPath} must contain a JSON array of specs`);
    process.exit(2);
  }
  if (args.date !== undefined && !/^\d{8}$/.test(args.date)) {
    console.error(`run-roster: --date wants YYYYMMDD, got ${args.date}`);
    process.exit(2);
  }
  const stampToday = args.date ?? dateStamp();
  let specs = resolve(raw as RosterSpec[], stampToday);
  const skip = new Set(args.skip);
  if (skip.size > 0) {
    const before = specs.length;
    specs = specs.filter((s) => !skip.has(s.model));
    say(`skipping ${before - specs.length} model(s): ${[...skip].join(", ")}`);
  }
  const deadline = computeDeadline(args.until, args.maxHours);
  if (args.loop && deadline === undefined) {
    console.error("run-roster: --loop needs a stop condition (--until HH:MM or --max-hours N)");
    process.exit(2);
  }
  logPath = args.log ?? join(REPO_ROOT, RUNS_DIR, `roster-${stampToday}.jsonl`);

  const pending: Attempt[] = [];
  for (const spec of specs) {
    const row = readRunRow(spec.runId);
    if (args.resumeRoster && row !== undefined) {
      if (row.termination_reason !== null && row.termination_reason !== "") {
        say(`skip ${spec.model} (${spec.runId}): already terminated ${row.termination_reason}`);
        if (!args.dryRun) {
          record({
            runId: spec.runId,
            model: spec.model,
            outcome: "skipped",
            ...(readLevel(spec.runId) !== undefined ? { level: readLevel(spec.runId)! } : {}),
            detail: `resume-roster: already terminated ${row.termination_reason}`,
          });
        }
        continue;
      }
      say(`resume-roster: ${spec.model} (${spec.runId}) will continue with --resume`);
      pending.push({ spec, resume: true });
      continue;
    }
    if (args.resumeRoster && row === undefined) {
      say(
        `resume-roster: no existing run for ${spec.runId} — launching fresh` +
          ` (if you expected a resume, the date stamp moved: pass --date <the original YYYYMMDD>)`,
      );
    }
    if (!args.resumeRoster && row !== undefined) {
      say(
        `warning: ${spec.runId} already exists and this is not --resume-roster; it will be launched fresh onto the same run id`,
      );
    }
    pending.push({ spec, resume: false });
  }

  say(
    `roster ${rosterPath}: ${pending.length} episode(s), log ${logPath}` +
      (deadline !== undefined ? `, stop launching at ${new Date(deadline).toLocaleString()}` : ", no wall-clock budget"),
  );

  if (args.dryRun) {
    console.log("\n--- plan (dry run; nothing launched, nothing logged) ---");
    for (const [i, a] of pending.entries()) {
      const s = a.spec;
      // A resumed episode reloads identity from meta.json; the derived values
      // here would be a lie, so show what it will actually use.
      const endpoint =
        s.driver === "openai"
          ? `   apiBase   ${s.apiBase} (key env ${s.apiKeyEnv})\n`
          : `   endpoint  claude CLI subscription (no api-base/api-key-env)\n`;
      const identity = a.resume
        ? `   identity  from ${join(RUNS_DIR, s.runId, "meta.json")} (character ${metaCharacter(s.runId) ?? "unknown"})`
        : `   driver    ${s.driver}, account ${s.account ?? "RUNNER (runner default)"}, effort ${s.effort ?? "unset (provider default)"}\n` +
          `   character ${s.character} (race ${s.race}, class ${s.class})\n` +
          endpoint +
          `   episodeMs ${s.episodeMs} (${s.episodeMs / 60_000}m)`;
      console.log(
        `\n${i + 1}. ${s.model}\n   runId     ${s.runId}\n${identity}\n   pre-launch: DELETE /session with ${s.runId}'s stored token via docker compose exec -T runner\n   argv      ${episodeArgv(s, a.resume).join(" ")}`,
      );
    }
    if (args.freeTokens.length > 0) {
      console.log(`\npre-roster: DELETE /session for tokens ${args.freeTokens.join(", ")}`);
    }
    if (args.loop) {
      console.log(
        `\nloop: after the last entry the roster starts over until the budget is spent, with a` +
          `\n      ${CYCLE_GAP_MS / 60_000}m gap between cycles (never spins faster than the backoff).` +
          `\n      A HEALTHY spec gets a fresh burn sample under a -cN run id each cycle:` +
          `\n      ${pending.map((a) => forCycle(a.spec, 2).runId).join(", ")}` +
          `\n      A spec that deferred rate-limited does NOT get a fresh -cN: it is skipped while` +
          `\n      cooling and then RESUMED on its own run id in place (backoff ${RETRY_BACKOFF_MS.map((m) => `${m / 60_000}m`).join("/")}, escalating).`,
      );
    }
    console.log(
      `\nguard:  an entry waits (poll ${ACCOUNT_WAIT_POLL_MS / 60_000}m, give up after ${ACCOUNT_WAIT_MAX_MS / 60_000}m)` +
        ` while another run holds its account — no termination row\n        and a write in the last` +
        ` ${LIVE_TRAJECTORY_MS / 60_000}m. Never frees another run's session.` +
        `\n        accounts in this roster: ${[...new Set(pending.map((a) => a.spec.account ?? "RUNNER (default)"))].join(", ")}`,
    );
    console.log(
      `\npolicy: terminated -> done | paused rate-limited/quota-exhausted with <${EARLY_TURN_THRESHOLD} turns -> defer` +
        `\n        claude-subscription entries never defer (no per-provider pools to wait on)` +
        `\n        mid-episode pause -> --resume with backoff ${RETRY_BACKOFF_MS.map((m) => `${m / 60_000}m`).join("/")}, then defer` +
        `\n        deferred spec -> per-spec backoff (${RETRY_BACKOFF_MS.map((m) => `${m / 60_000}m`).join("/")}, escalating): skipped while cooling,` +
        `\n        then RESUMED in place on its own run id (never relaunched fresh at L1). Resume` +
        `\n        restores trajectory + scratchpad but NOT level — a lane-mate's fresh launch wipes` +
        `\n        the shared account, so a resumed character is recreated at level 1.` +
        `\n        non-loop retry queue: up to ${MAX_RETRY_CYCLES} cycle(s), ${CYCLE_GAP_MS / 60_000}m gap before each (loop mode` +
        `\n        resumes in the rotation instead)` +
        `\n        roster log: ${logPath}`,
    );
    return;
  }

  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  // Stale sessions from hand-started runs hold the shared account too.
  for (const token of args.freeTokens) {
    await freeSession({ runId: token, model: "(external)" }, "pre-roster account release", false);
  }

  // Defer state, keyed on each spec's stable (cycle-1) run id. This is the one
  // source of truth for what is backed off: the retry queue below is derived
  // from it at loop exit, so a spec can never be both relaunched fresh AND
  // retried (the old code pushed to `queue` while the spec also stayed in the
  // rotation — double-booking that spawned a fresh L1 -cN every cycle).
  const deferred = new Map<string, DeferEntry>();
  for (let cycle = 1; ; cycle++) {
    // Cycle 1 is the roster as written (so a non-loop run is byte-identical to
    // before; the map is empty, so every spec plans `fresh`). Later cycles give
    // each *healthy* spec a fresh run under a -cN run id — reusing the id would
    // append to one trajectory and overwrite the run row classify() reads.
    // Characters are deliberately reused; a fresh episode wipes the account's
    // characters first, so a fresh cycle-N burn sample starts at level 1 either
    // way. Loop mode burns tokens; it does not accumulate progress.
    //
    // A spec that deferred (rate-limited) does NOT get a fresh -cN here: it is
    // either skipped (still cooling) or resumed in place. freeCycle only needs
    // to dodge collisions among the specs that will actually launch fresh.
    const freshBases = pending.filter((a) => !deferred.has(a.spec.runId)).map((a) => a.spec);
    const n = cycle === 1 ? 1 : freeCycle(freshBases.length > 0 ? freshBases : pending.map((a) => a.spec), cycle);
    if (cycle > 1) say(`loop cycle ${n}: restarting the roster (${pending.length} episode(s))`);
    let launched = 0;
    let earliest: number | undefined;
    for (const a of pending) {
      if (stopping) break;
      const plan = planAttempt(deferred.get(a.spec.runId), Date.now());
      if (plan.kind === "skip") {
        earliest = earliest === undefined ? plan.until : Math.min(earliest, plan.until);
        say(`hold ${a.spec.model} (${a.spec.runId}): ${plan.reason}, backing off until ${stamp(plan.until)}`);
        // Positive evidence in the log that the spec was HELD (not silently
        // dropped, not relaunched) — otherwise the fix is invisible to post-run
        // analysis, which would only see fewer `deferred` rows than before.
        record({
          runId: a.spec.runId,
          model: a.spec.model,
          outcome: "skipped",
          detail: `held ${plan.reason}; backing off until ${stamp(plan.until)}`,
        });
        continue;
      }
      // A deferred spec resumes its stored run id in place instead of spawning
      // a fresh L1 -cN — this is the "resume, don't recreate" Mark asked for.
      // Honesty (§C): resume restores that run's trajectory and scratchpad, but
      // NOT its level — a lane-mate's fresh launch wipes every character on the
      // shared account (run.ts hygiene, which we cannot change from here), so a
      // resumed run recreates its character at level 1. For a 0-turn rate-limit
      // there was nothing to preserve anyway; for a real-turns pause the model
      // keeps its own context but restarts its climb.
      const target =
        plan.kind === "resume" ? { ...a.spec, runId: plan.runId } : cycle === 1 ? a.spec : forCycle(a.spec, n);
      const resume = plan.kind === "resume" ? true : cycle === 1 ? a.resume : false;
      // The deadline check goes *after* the plan so a budget-stop logs the id
      // that would actually have launched (the -cN in a later loop cycle), not
      // the base id.
      if (deadline !== undefined && Date.now() >= deadline) {
        say(`wall-clock budget reached — not launching ${a.spec.model}`);
        record({ runId: target.runId, model: a.spec.model, outcome: "budget-stop", detail: "not launched" });
        continue;
      }
      if (plan.kind === "resume") {
        say(`resume ${a.spec.model}: retrying paused run ${plan.runId} in place (was ${plan.reason})`);
        record({
          runId: target.runId,
          model: a.spec.model,
          outcome: "retry",
          detail: `resuming in place after ${plan.reason}; resume restores trajectory + scratchpad, not level`,
        });
      }
      launched++;
      const res = await attemptSpec(target, { resume, deadline, dryRun: false });
      if (res === "defer") {
        const defers = (deferred.get(a.spec.runId)?.defers ?? 0) + 1;
        const reason = readRunRow(target.runId)?.pause_reason ?? "rate-limited";
        deferred.set(a.spec.runId, {
          runId: target.runId,
          notBefore: Date.now() + backoffMs(defers),
          defers,
          reason,
        });
      } else {
        deferred.delete(a.spec.runId);
      }
    }
    if (!args.loop || stopping) break;
    if (deadline !== undefined && Date.now() >= deadline) break;
    // A gap between cycles so the main loop can never spin faster than the
    // backoff: without it, a whole roster of saturated free models would 429 in
    // seconds and immediately loop. When nothing launched (every spec is still
    // cooling) sleep exactly until the earliest spec is due instead.
    const gap = launched === 0 && earliest !== undefined ? Math.max(0, earliest - Date.now()) : CYCLE_GAP_MS;
    await nap(gap, deadline, launched === 0 ? `all models backing off before cycle ${cycle + 1}` : `gap before cycle ${cycle + 1}`);
    if (stopping || (deadline !== undefined && Date.now() >= deadline)) break;
  }

  // The retry queue is the deferred map, materialised. It is only *reached* in
  // non-loop runs (a --loop run exits this point only on stop or deadline, both
  // of which disable the loop below); a looped run has already been resuming
  // these in place, cycle after cycle. Resume targets the stored run id.
  let queue: Attempt[] = [];
  for (const a of pending) {
    const entry = deferred.get(a.spec.runId);
    if (entry !== undefined) queue.push({ spec: { ...a.spec, runId: entry.runId }, resume: true });
  }

  for (let cycle = 1; cycle <= MAX_RETRY_CYCLES && queue.length > 0 && !stopping; cycle++) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    say(`retry cycle ${cycle}/${MAX_RETRY_CYCLES}: ${queue.length} deferred model(s)`);
    await nap(CYCLE_GAP_MS, deadline, `gap before retry cycle ${cycle}`);
    const next: Attempt[] = [];
    for (const a of queue) {
      if (stopping) {
        next.push(a);
        continue;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        say(`wall-clock budget reached — not retrying ${a.spec.model}`);
        record({ runId: a.spec.runId, model: a.spec.model, outcome: "budget-stop", detail: "retry not launched" });
        next.push(a);
        continue;
      }
      const res = await attemptSpec(a.spec, { resume: true, deadline, dryRun: false });
      if (res === "defer") next.push(a);
    }
    queue = next;
  }

  if (queue.length > 0) {
    say(`still deferred at exit: ${queue.map((a) => a.spec.model).join(", ")}`);
  }
  say("roster complete");
}

if (import.meta.main) {
  void main().catch((e: unknown) => {
    console.error(`run-roster: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
