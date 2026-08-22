#!/usr/bin/env bun
/**
 * Fleet orchestrator: one run-roster process per enabled lane in fleet.json.
 *
 *   ./infra/run-fleet.sh infra/fleet.json --until 18:00
 *   ./infra/run-fleet.sh infra/fleet.json --dry-run
 *   ./infra/run-fleet.sh --status
 *
 * The fleet is the config file. Each lane is one sequential episode stream on
 * one game account; parallelism is exactly the set of enabled lanes. The
 * supervisor re-reads fleet.json every tick (60s):
 *
 *  - enabled:false  -> the lane drains: no SIGTERM while its roster process
 *    has an episode child; once the process is between episodes it is
 *    SIGTERMed (run-roster's own handler stops it cleanly). There is an
 *    unavoidable small race — a child spawned in the instant between the
 *    idle check and the kill gets run-roster's graceful episode termination
 *    (30s grace), not a hard kill — so in the worst case "disable" costs one
 *    just-started episode, never a corrupted one.
 *  - enabled:true / new lane -> spawned on the next tick.
 *  - malformed or invalid fleet.json on re-read -> complaint, last good
 *    config kept, nothing running is touched.
 *
 * Guards, enforced at startup and on every re-read:
 *  - two enabled lanes must not share an account (one live session per
 *    account; the second lane would spend the night in account_in_use).
 *  - lane-policy: claude-family models (opus/sonnet/haiku/claude-*) run only
 *    via the claude-subscription driver, and that driver runs only claude
 *    models. OpenRouter/OpenCode lanes carry free models; keeping a single
 *    stream per provider pool is the whole point of the lane shape.
 *
 * The roster's own account-busy guard still runs under every lane: a lane
 * pointed at an account something else is using waits, it does not clobber.
 */

import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { accountHeldBy, slug, type RosterSpec } from "./run-roster";

// ------------------------------------------------------------------ types

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
}

export interface FleetConfig {
  notes: string[];
  lanes: FleetLane[];
}

const TICK_MS = 60_000;
const REPO_ROOT = dirname(import.meta.dir);
const RUNS_DIR = join(REPO_ROOT, "data", "runs");
const ROSTER_SH = join(REPO_ROOT, "infra", "run-roster.sh");
const STATE_PATH = join(RUNS_DIR, "fleet-state.json");

// ------------------------------------------------------------------ parsing

function fail(msg: string): never {
  throw new Error(msg);
}

/** True for models that must ride the claude-subscription driver. */
export function isClaudeFamily(model: string): boolean {
  return /(^|\/)(claude|opus|sonnet|haiku)/i.test(model);
}

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
    const driver = e.driver ?? "openai";
    if (driver !== "openai" && driver !== "claude-subscription") {
      fail(`lane ${lane.name}: entry ${e.model}: unknown driver ${String(driver)}`);
    }
    if (driver === "openai" && isClaudeFamily(e.model)) {
      fail(
        `lane ${lane.name}: entry ${e.model}: lane-policy — claude models run only via the ` +
          `claude-subscription driver, never through an openai-driver lane`,
      );
    }
    if (driver === "claude-subscription" && !isClaudeFamily(e.model)) {
      fail(
        `lane ${lane.name}: entry ${e.model}: lane-policy — the claude-subscription driver ` +
          `carries claude models only`,
      );
    }
    if (e.account !== undefined && e.account.toUpperCase() !== lane.account.toUpperCase()) {
      fail(
        `lane ${lane.name}: entry ${e.model} pins account ${e.account} but the lane owns ` +
          `${lane.account} — one lane, one account`,
      );
    }
    out.push(e);
  }
  if (out.length === 0) fail(`lane ${lane.name}: no entries`);
  return out;
}

/** Parse + validate a fleet config. Throws with a config-error message. */
export function parseFleet(raw: unknown): FleetConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("fleet config must be a JSON object with a lanes array");
  }
  const o = raw as { _notes?: unknown; lanes?: unknown };
  const notes = Array.isArray(o._notes) ? o._notes.filter((n): n is string => typeof n === "string") : [];
  if (!Array.isArray(o.lanes)) fail("fleet config: lanes must be an array");
  const lanes: FleetLane[] = [];
  const names = new Set<string>();
  for (const l of o.lanes as Partial<FleetLane>[]) {
    if (typeof l !== "object" || l === null) fail("fleet config: lane is not an object");
    if (typeof l.name !== "string" || l.name.length === 0) fail("fleet config: lane without a name");
    if (names.has(l.name)) fail(`fleet config: duplicate lane name ${l.name}`);
    names.add(l.name);
    if (typeof l.enabled !== "boolean") fail(`lane ${l.name}: enabled must be true or false`);
    if (typeof l.account !== "string" || l.account.length === 0) fail(`lane ${l.name}: account is required`);
    const loop = l.loop ?? false;
    if (typeof loop !== "boolean") fail(`lane ${l.name}: loop must be true or false`);
    if (l.untilDefault !== undefined && !/^\d{1,2}:\d{2}$/.test(l.untilDefault)) {
      fail(`lane ${l.name}: untilDefault wants HH:MM, got ${String(l.untilDefault)}`);
    }
    const hasEntries = l.entries !== undefined;
    const hasFile = l.rosterFile !== undefined;
    if (hasEntries === hasFile) fail(`lane ${l.name}: exactly one of entries or rosterFile`);
    const lane: FleetLane = {
      name: l.name,
      enabled: l.enabled,
      account: l.account,
      loop,
      ...(l.untilDefault !== undefined ? { untilDefault: l.untilDefault } : {}),
      ...(hasFile ? { rosterFile: l.rosterFile } : {}),
    };
    if (hasEntries) lane.entries = validateEntries(lane, l.entries);
    lanes.push(lane);
  }
  // One live session per account: two enabled lanes on one account means one
  // of them spends the whole window waiting behind the other.
  const byAccount = new Map<string, string>();
  for (const lane of lanes) {
    if (!lane.enabled) continue;
    const key = lane.account.toUpperCase();
    const other = byAccount.get(key);
    if (other !== undefined) {
      fail(`account ${lane.account} is shared by enabled lanes ${other} and ${lane.name} — one lane per account`);
    }
    byAccount.set(key, lane.name);
  }
  return { notes, lanes };
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

/** A loop lane with no stop condition would run forever; refuse up front. */
export function laneUntilOrFail(lane: FleetLane, cliUntil: string | undefined): string | undefined {
  const until = cliUntil ?? lane.untilDefault;
  if (lane.loop && until === undefined) {
    fail(`lane ${lane.name}: loop needs a stop condition — pass --until or set untilDefault`);
  }
  return until;
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
  stamp: string;
  fleetConfig: string;
  lanes: Record<
    string,
    {
      pid: number;
      account: string;
      rosterPath: string;
      jsonl: string;
      stdoutLog: string;
      spawnedAt: number;
      exitCode: number | null;
      draining: boolean;
    }
  >;
}

function writeState(configPath: string, stampToday: string, procs: Map<string, LaneProc>, draining: Set<string>): void {
  const state: FleetState = {
    fleetPid: process.pid,
    startedAt: Date.now(),
    stamp: stampToday,
    fleetConfig: configPath,
    lanes: {},
  };
  for (const [name, p] of procs) {
    state.lanes[name] = {
      pid: p.pid,
      account: p.lane.account,
      rosterPath: laneRosterPath(name, stampToday),
      jsonl: laneJsonlPath(name, stampToday),
      stdoutLog: laneStdoutPath(name, stampToday),
      spawnedAt: p.spawnedAt,
      exitCode: p.exitCode,
      draining: draining.has(name),
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

function runProgress(runId: string): { level: number; xp: number } | undefined {
  const path = join(RUNS_DIR, runId, "run.sqlite");
  if (!existsSync(path)) return undefined;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .query("SELECT level, xp FROM state WHERE run_id = ? ORDER BY ts DESC LIMIT 1")
        .get(runId) as { level: number | null; xp: number | null } | null;
      if (row === null || row.level === null) return undefined;
      return { level: row.level, xp: row.xp ?? 0 };
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

function printStatus(configPath: string): void {
  const config = parseFleet(JSON.parse(readFileSync(configPath, "utf8")));
  let state: FleetState | undefined;
  if (existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as FleetState;
    } catch {
      state = undefined;
    }
  }
  const fleetUp = state !== undefined && pidAlive(state.fleetPid);
  console.log(
    `fleet ${configPath}` +
      (state === undefined
        ? " — no fleet-state.json: the fleet has never run here"
        : ` — supervisor pid ${state.fleetPid} ${fleetUp ? "ALIVE" : "not running"} (state from ${new Date(state.startedAt).toLocaleString()})`),
  );
  for (const lane of config.lanes) {
    const ls = state?.lanes[lane.name];
    const alive = ls !== undefined && pidAlive(ls.pid);
    const head =
      `  ${lane.name.padEnd(16)} enabled=${lane.enabled ? "true " : "false"} account=${lane.account.padEnd(9)} ` +
      (ls === undefined
        ? "never spawned by this fleet"
        : `pid ${ls.pid} ${alive ? "ALIVE" : ls.exitCode !== null ? `exited ${ls.exitCode}` : "dead"}${ls.draining ? " (draining)" : ""}`);
    console.log(head);
    if (ls !== undefined) {
      const runId = lastLaunchedRunId(ls.stdoutLog);
      if (runId !== undefined) {
        const prog = runProgress(runId);
        console.log(
          `                   run ${runId}` +
            (prog !== undefined ? ` — level ${prog.level}, ${prog.xp} xp` : " — no state rows yet"),
        );
      }
      const tail = lastLine(ls.stdoutLog);
      if (tail !== undefined) console.log(`                   last: ${tail}`);
    }
    // Honesty about the account itself: a hand-started run holds it just as
    // hard as a fleet one would. Same liveness inference as the roster guard.
    const holder = accountHeldBy(lane.account, "");
    if (holder !== undefined) {
      const prog = runProgress(holder);
      console.log(
        `                   account ${lane.account} currently held by run ${holder}` +
          (prog !== undefined ? ` (level ${prog.level}, ${prog.xp} xp)` : "") +
          (ls !== undefined && pidAlive(ls.pid) ? "" : " — not fleet-managed"),
      );
    }
  }
  const foreign = foreignRosters(new Set(Object.values(state?.lanes ?? {}).map((l) => l.pid)));
  if (foreign.length > 0) {
    console.log("  not fleet-managed (hand-started run-roster processes):");
    for (const f of foreign) console.log(`    pid ${f.pid}: ${f.argv}`);
  }
}

// ------------------------------------------------------------------ dry run

function printDryRun(config: FleetConfig, cliUntil: string | undefined, stampToday: string): void {
  console.log(`--- fleet plan (dry run; nothing spawned, nothing written) ---`);
  for (const lane of config.lanes) {
    if (!lane.enabled) {
      console.log(`\nlane ${lane.name}: DISABLED (account ${lane.account}) — flip enabled:true to spawn`);
      continue;
    }
    const entries = fillEntries(lane, loadLaneEntries(lane), stampToday);
    const until = laneUntilOrFail(lane, cliUntil);
    console.log(`\nlane ${lane.name}: account ${lane.account}, ${entries.length} entr(ies), loop=${lane.loop}, until=${until ?? "none"}`);
    for (const e of entries) {
      console.log(
        `  - ${e.model}${e.effort !== undefined ? `@${e.effort}` : ""} (${e.driver ?? "openai"}) -> ${e.runId}`,
      );
    }
    console.log(`  roster    ${laneRosterPath(lane.name, stampToday)}`);
    console.log(`  jsonl     ${laneJsonlPath(lane.name, stampToday)}`);
    console.log(`  stdout    ${laneStdoutPath(lane.name, stampToday)}`);
    console.log(`  argv      ${laneArgv(lane, { stamp: stampToday, until: cliUntil }).join(" ")}`);
  }
  const enabled = config.lanes.filter((l) => l.enabled);
  console.log(
    `\n${enabled.length} lane(s) would run in parallel (${enabled.map((l) => `${l.name}=${l.account}`).join(", ")}).` +
      `\nsupervision: re-read fleet.json every ${TICK_MS / 1000}s; enabled:false drains at the next episode` +
      `\nboundary; enabled:true/new lanes spawn; a malformed edit keeps the last good config.`,
  );
}

// ------------------------------------------------------------------ main

function parseArgs(argv: string[]): {
  config: string;
  dryRun: boolean;
  status: boolean;
  until: string | undefined;
} {
  let config = join(REPO_ROOT, "infra", "fleet.json");
  let dryRun = false;
  let status = false;
  let until: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--status":
        status = true;
        break;
      case "--until":
        until = argv[++i];
        break;
      case "-h":
      case "--help":
        console.error(
          [
            "usage: infra/run-fleet.sh [fleet.json] [flags]",
            "",
            "  --until HH:MM   stop condition passed to every lane (overridden by nothing;",
            "                  a lane's untilDefault applies when this is absent)",
            "  --dry-run       print the lane plan; spawn nothing",
            "  --status        read-only: per-lane process/run/progress report",
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
  return { config, dryRun, status, until };
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
  const stampToday = dateStamp();
  let config = parseFleet(JSON.parse(readFileSync(args.config, "utf8")));
  // Fail fast on anything that would fail at spawn time.
  for (const lane of config.lanes) {
    if (!lane.enabled) continue;
    loadLaneEntries(lane);
    laneUntilOrFail(lane, args.until);
  }

  if (args.dryRun) {
    printDryRun(config, args.until, stampToday);
    return;
  }

  fleetLog = join(RUNS_DIR, `fleet-${stampToday}.jsonl`);
  const procs = new Map<string, LaneProc>();
  const sets: LaneSets = { running: new Set(), draining: new Set(), finished: new Set() };
  let stopping = false;

  const spawnLane = (lane: FleetLane): void => {
    let until: string | undefined;
    let entries: RosterSpec[];
    try {
      until = laneUntilOrFail(lane, args.until);
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
    const out = Bun.file(stdoutLog);
    const proc = Bun.spawn(argv, { cwd: REPO_ROOT, stdin: "ignore", stdout: out, stderr: out });
    const lp: LaneProc = { lane, proc, pid: proc.pid, spawnedAt: Date.now(), exited: false, exitCode: null };
    void proc.exited.then((code) => {
      lp.exited = true;
      lp.exitCode = code;
    });
    procs.set(lane.name, lp);
    sets.running.add(lane.name);
    say(`lane ${lane.name}: spawned pid ${proc.pid} (account ${lane.account}${resumeRoster ? ", --resume-roster" : ""}) -> ${stdoutLog}`);
    record({ lane: lane.name, event: "spawned", detail: `pid ${proc.pid}${resumeRoster ? "; resume-roster" : ""}` });
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

  say(`fleet ${args.config}: ${config.lanes.filter((l) => l.enabled).length} enabled lane(s), log ${fleetLog}`);
  for (const lane of diffLanes(config.lanes, sets).start) spawnLane(lane);
  writeState(args.config, stampToday, procs, sets.draining);

  for (;;) {
    await new Promise((res) => setTimeout(res, TICK_MS));

    // Reap exits.
    for (const [name, p] of procs) {
      if (p.exited && sets.running.has(name)) {
        sets.running.delete(name);
        const drained = sets.draining.delete(name);
        if (!drained) sets.finished.add(name);
        say(`lane ${name}: roster exited ${p.exitCode}${drained ? " (drained)" : ""}`);
        record({ lane: name, event: "exited", detail: `code ${p.exitCode}${drained ? "; drained" : ""}` });
      }
    }

    if (stopping) {
      if (sets.running.size === 0) break;
      continue;
    }

    // Re-read the config: the operator's tuning knob.
    const { config: next, error } = rereadFleet(args.config, config);
    if (error !== undefined) {
      say(`fleet config error — keeping the last good config: ${error}`);
      record({ lane: "-", event: "config-error", detail: error });
    }
    config = next;

    const actions = diffLanes(config.lanes, sets);
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
    for (const lane of actions.start) spawnLane(lane);

    // Drains: only SIGTERM a roster with no episode child.
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

    writeState(args.config, stampToday, procs, sets.draining);
    if (sets.running.size === 0 && diffLanes(config.lanes, sets).start.length === 0) {
      say("all lanes have exited and nothing is left to spawn — fleet complete");
      break;
    }
  }
  writeState(args.config, stampToday, procs, sets.draining);
  say("fleet exit");
}

if (import.meta.main) {
  void main().catch((e: unknown) => {
    console.error(`run-fleet: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
