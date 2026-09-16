/**
 * How the read-only commands RENDER it: every format* helper, plus the three
 * printers behind --status, --live-runs and --dry-run.
 *
 * Imports run-fleet-config, run-fleet-plan and run-fleet-state; never the entry
 * point. It prints; it never spawns, writes, or holds supervisor state — a
 * --status reader is a different process from the supervisor it reports on.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  classAccountsOf,
  type ConfigRefusal,
  eligibleFrom,
  type EpisodeId,
  type FleetConfig,
  type FleetJob,
  type FleetPreflight,
  type FleetRosterEntry,
  formatConcurrency,
  type JobSpawn,
  parseFleet,
  pinnedJobs,
  policyExclusion,
  poolJobs,
  preflightAccounts,
  type PreflightRecord,
  probeRunsOf,
  rosterModels,
  scheduledAccounts,
} from "./run-fleet-config";
import {
  affinityFrom,
  affinityOf,
  type ConfigRejection,
  type EndedRun,
  failedAttemptsFor,
  fillEntries,
  type FleetPause,
  fmtElapsed,
  fmtPaused,
  HEARTBEAT_STALE_MS,
  isExtraJob,
  jobSpawn,
  type Occupant,
  PAUSE_SIDECAR,
  type PausedListing,
  pausesOnDrain,
  planResumes,
  planStaleRuns,
  planTick,
  type ResumePlan,
  retryNumbers,
  type Character,
  charactersFrom,
  characterStanding,
  TICK_MS,
} from "./run-fleet-plan";
import {
  CONTAINER,
  type FleetState,
  foreignRosters,
  jobArgv,
  jobDefers,
  jobJsonlPath,
  jobLogPath,
  jobsByAccount,
  lastLaunchedRunId,
  liveJobsFromState,
  loadConfigForRead,
  pidAlive,
  readPauseSidecar,
  resolveStatePath,
  runProgress,
  RUNS_DIR,
  smokePath,
  STATE_PATH,
  type StateJob,
} from "./run-fleet-state";
import { accountHeldBy } from "./run-roster";
import { readFleetText } from "../runner/src/config-store";
import { TAINT_AFTER } from "../runner/src/lapse";
import {
  ACCOUNT_CLASSES,
  type AccountClass,
  DEFAULT_POLICY as DEFAULT_POLICY_FOR_FORMAT,
  extrasSoFar,
  formatOutstanding,
  type HeldPick,
  isStaleRun,
  LADDER_MS,
  liveSubscriptions,
  type ModelState,
  modelStates,
  outstandingWork,
  readRunFacts,
  rosterClass,
  schedulability,
  type SchedulingPolicy,
  type StartingCharacter,
  STATS_EPISODES,
  TIER_TABLE,
  TIERS,
} from "../runner/src/models";

/** The --status character rows: one per `idle: "unlimited"` ref. Pure. */
export function formatCharacters(
  roster: Record<string, FleetRosterEntry>,
  characters: ReadonlyMap<string, Character>,
  occupants: ReadonlyMap<string, Occupant>,
  running: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [ref, e] of Object.entries(roster)) {
    if (e.idle !== "unlimited") continue;
    const st = characters.get(ref);
    if (st === undefined) {
      out.push(`character ${ref}: no head — ${running.has(ref) ? "first session in flight" : "next pick starts fresh"}`);
      continue;
    }
    const standing = characterStanding(ref, st, occupants);
    const verdict =
      running.has(ref)
        ? "in flight"
        : standing.kind === "free"
          ? "continuable"
          : standing.kind === "own"
            ? "own account, resuming"
            : standing.kind === "boundary"
              ? `held: ${standing.occupant} on it until its episode boundary`
              : `occupied by ${standing.occupant}'s character: fresh-next on a free account, lineage dropped`;
    out.push(`character ${ref}: head ${st.runId} on ${st.account} as ${st.character} — ${verdict}`);
  }
  return out;
}

/** One line per run the supervisor would end rather than resume, for --status and --dry-run. */
export function formatEnded(ended: readonly EndedRun[], fleetUp: boolean, failedSoFar?: (e: EndedRun) => number): string[] {
  if (ended.length === 0) return [];
  const retries = failedSoFar === undefined ? undefined : retryNumbers(ended, failedSoFar);
  return [
    `lapsed runs the supervisor ${fleetUp ? "ends on its next tick" : "will end when it starts"} (${ended.length}):`,
    ...ended.map((e, i) => `  ${e.runId} — ${formatEndedRun(e, retries?.[i])}`),
  ];
}

/**
 * "failed attempt (quota-exhausted), retry 2/3" — how a lapsed eval run reads
 * on `--status` and in the strip. It is never called "paused" there: the run
 * is over, and what the operator needs to know is how many attempts are left
 * before the model is tainted for that episode.
 */
export function formatEndedRun(e: EndedRun, retry?: number): string {
  // `manual` is the supervisor ending a run for a reason its detail already
  // states in full ("ended by the supervisor: …"), so it gets no head of its own.
  const head = e.reason === "attempt-failed" ? "failed attempt: " : e.reason === "stale" ? "stale: " : "";
  const of = e.counts && retry !== undefined ? `, retry ${Math.min(retry, TAINT_AFTER)}/${TAINT_AFTER}${retry >= TAINT_AFTER ? " — tainted" : ""}` : "";
  return `${head}${e.detail}${of}`;
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
 * The refused pins (item 66), printed under the rejection banner.
 *
 * A refusal is quieter than the outage it replaces, which is the point — and
 * also the risk. The file IS in effect, so nothing else looks wrong; the only
 * way an operator learns their `enabled: true` did not take is this block and
 * the supervisor's log line. `!` rather than the banner's `!!`: the fleet is
 * running, one pin is not.
 */
export function formatRefusals(refusals: readonly ConfigRefusal[], inForce = true): string[] {
  if (refusals.length === 0) return [];
  // `inForce` false means the banner above already said the file is NOT what
  // the supervisor is running — a fixed file within a tick of being re-read, or
  // a whole-file failure. Saying "the rest IS in effect" under that banner
  // would contradict it at exactly the moment a board needs reading.
  return [
    `! ${refusals.length} pin(s) refused by the config rules` +
      (inForce ? " — the rest of the file IS in effect:" : " IN THE FILE — see the banner above for what is actually running:"),
    ...refusals.map((r) => `   ${r.pin} REFUSED and left disabled: ${r.why}`),
    "   a live run under a refused pin is left alone; it just will not respawn",
  ];
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
  /** A scored-tier extra run, with the character it rolls; a freeplay extra rolls none. */
  extra?: StartingCharacter;
  /** The Claude subscription this job bills, by env var NAME; absent on the default lane. */
  subscription?: string;
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
      `${isExtraJob(j) ? (j.extra !== undefined ? ` extra (race ${j.extra.race} class ${j.extra.class})` : " extra") : ""}` +
      // Only a second subscription is named: the default lane is what every
      // claude row meant before there was another one.
      `${j.subscription !== undefined ? ` [${j.subscription}]` : ""}`;
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
    `models: ${states.length} in roster (policy: tier budgets; series ${series}${policy.series === null ? " — unversioned checkout, every series counts" : ""}; ladder ${LADDER_MS.length} rungs to ${Math.round(LADDER_MS[LADDER_MS.length - 1]! / 3_600_000)}h` +
      `${policy.paid !== null ? `; at most ${policy.paid.maxConcurrent} paid in flight` : "; no paid/free split"}` +
      `; tiers ${TIERS.map((t) => `${t} ${TIER_TABLE[t].runsPerEpisode.e90}/${TIER_TABLE[t].runsPerEpisode.e360}`).join(", ")}` +
      `; idle unlimited (idle watchdog only; no wall clock)`,
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

// ------------------------------------------------------------------ status

/**
 * Live episodes across every job account, for an operator (or a script) that
 * wants to know whether the world is busy: the roster's own account-busy
 * inference over the trajectory stores, which is what the scheduler leases by.
 *
 * This is a DIFFERENT source than the --status accounts table, which reports
 * the supervisor's own `jobs` record — and saying the two were "the same
 * signal" is how a stale row there went unnoticed (item 68). They should
 * now agree on every fleet-managed account; where they cannot, this one is the
 * truth about the world and that one is the truth about the supervisor.
 *
 * Exit code carries the answer so bash never parses this text. The deploy
 * script does not use it any more: it stops the fleet for its window, and a
 * live episode pauses as `operator-pause` and resumes on the far side.
 */
export function printLiveRuns(configPath: string): number {
  const config = parseFleet(JSON.parse(readFleetText(configPath)));
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

/**
 * The banner `--status` leads with while the fleet is paused. Two facts, kept
 * apart on purpose: the switch on disk (what the operator set) and the switch
 * the supervisor has actually picked up (its last tick). Between them lies the
 * up-to-60s window where the file says stop and jobs are still being spawned.
 * Pure.
 */
export function formatPauseBanner(onDisk: FleetPause | undefined, inEffect: FleetPause | undefined): string[] {
  if (onDisk === undefined && inEffect === undefined) return [];
  if (onDisk === undefined) {
    return [
      `!! pause switch CLEARED on disk, still in effect for the supervisor (${inEffect!.why}) — it schedules again within a tick`,
    ];
  }
  const since = new Date(onDisk.at).toLocaleString();
  const head = `!! fleet PAUSED since ${since}: ${onDisk.why}`;
  return [
    head,
    inEffect === undefined
      ? `   the supervisor has NOT picked it up yet (up to 60s) — a job can still be spawned until it does`
      : `   in effect: nothing is launched, live jobs drain at their episode boundary; delete data/runs/${PAUSE_SIDECAR} to resume`,
  ];
}

export function printStatus(configPath: string): void {
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
  // The pause switch is read from ITS OWN file, not from the state: the state
  // is only as fresh as the last tick, and an operator who has just flipped the
  // switch is asking this very question.
  for (const line of formatPauseBanner(readPauseSidecar(), state?.pausedSwitch)) console.log(line);
  const { config, error: configError } = loadConfigForRead(configPath);
  if (config === undefined) {
    console.log(
      `!! ${configPath} does not load: ${configError}` +
        " — rows below are what the supervisor last ran, not the file's",
    );
  }
  for (const line of formatRefusals(config?.refusals ?? [], rejected === undefined)) console.log(line);
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
            : ", no heartbeat in state (supervisor predates heartbeats)") +
          `, up since ${new Date(state.startedAt).toLocaleString()}, stamp ${state.stamp}`),
  );
  if (state?.containerized === true) {
    console.log("  logs: docker compose -f infra/compose.yml logs -f fleet");
  }
  if (config !== undefined) for (const line of formatGate(state?.preflight, config.preflight)) console.log(`  ${line}`);

  // (b) accounts: pinned first, then the pool, each with the job on it.
  const live = liveJobsFromState(state);
  // Paused runs: what the supervisor would resume now, and what it
  // lists instead — computed from disk so it is right with the fleet down.
  const runFacts = readRunFacts(RUNS_DIR);
  const pausedRuns = runFacts.filter((f) => f.pause !== null && !isStaleRun(f, Date.now())).sort((a, b) => b.pause!.at - a.pause!.at);
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
      ...(j.subscription !== undefined ? { subscription: j.subscription } : {}),
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
        const ending = resumePlan.end.find((e) => e.runId === pausedHere.runId);
        const head =
          ending !== undefined
            ? `${formatEndedRun(ending)} — ${pausedHere.runId}`
            : `paused (${p.reason}, ${fmtPaused(p.episodeElapsedMs, pausedHere.episodeMs)}) — ${pausedHere.runId}`;
        note =
          head +
          `${prog !== undefined ? ` L${prog.level} ${prog.xp}xp` : ""}` +
          `${
            ending !== undefined
              ? fleetUp
                ? ", ended on the next tick and reattempted fresh"
                : ", ended when the fleet starts and reattempted fresh"
              : resumePlan.resume.some((r) => r.runId === pausedHere.runId)
                ? ", resumes on the next tick"
                : fleetUp
                  ? ""
                  : ", resumes when the fleet starts"
          }`;
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
    {
      const line = formatConcurrency(config.maxConcurrent, config.policy);
      if (line !== undefined) console.log(`  ${line}`);
    }
    if (state?.policy?.idle !== undefined) console.log(`  policy: ${state.policy.idle}`);
    // (c') freeplay characters: each unlimited ref's head and what the next pick
    // does with it. Occupancy is the live jobs' (plus the resumes that would
    // reserve theirs), the same facts the tick reads; heads read the archive.
    const occupants = new Map<string, Occupant>();
    for (const j of live.values()) {
      if (!isAlive(j)) continue;
      const unlimited = j.source === "policy" && j.episode === "freeplay" && config.roster[j.ref]?.idle === "unlimited";
      occupants.set(j.account.toUpperCase(), { ref: j.ref, unlimited });
    }
    for (const r of resumePlan.resume) {
      occupants.set(r.account.toUpperCase(), { ref: r.job.ref, unlimited: pausesOnDrain(r.job) && config.roster[r.job.ref]?.idle === "unlimited" });
    }
    const characters = charactersFrom(readRunFacts(RUNS_DIR, Date.now(), { includeArchived: true }), config.roster);
    for (const line of formatCharacters(config.roster, characters, occupants, running)) console.log(`  ${line}`);
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

  // (d) paused runs the supervisor is not resuming, and why; and the ones it
  // ends — a lapsed eval reads as a failed attempt with its retry number, not
  // as something waiting to come back.
  const lapsed = [
    ...resumePlan.end,
    ...planStaleRuns({ runs: runFacts, ...(config !== undefined ? { campaigns: config.campaigns, refs: Object.keys(config.roster) } : {}), now: Date.now() }),
  ];
  const statusStates = config !== undefined ? modelStates({ runsDir: RUNS_DIR, roster: rosterModels(config.roster), policy: config.policy, runs: runFacts }) : [];
  for (const line of formatPaused(resumePlan.listed)) console.log(`  ${line}`);
  for (const line of formatEnded(lapsed, fleetUp, (e) => failedAttemptsFor(statusStates, e) ?? 0)) console.log(`  ${line}`);
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

export function printDryRun(config: FleetConfig, cliUntil: string | undefined, stampToday: string): void {
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
  // Affinity, so the printed plan places accounts the way the live
  // supervisor would: a report that disagrees with the tick is worse than none.
  const plan = planTick(
    config,
    states,
    held,
    stampToday,
    resumes.resume,
    probeRunsOf(runs, config.roster),
    affinityOf(affinityFrom(runs, config.roster)),
    liveSubscriptions(runs, rosterModels(config.roster)),
  );
  const rows: AccountRow[] = [];
  const argvs: string[] = [];
  const planned = (job: FleetJob, spawn: JobSpawn): JobRow => {
    const entries = fillEntries(spawn, stampToday);
    // The same resume decision the live spawn makes (see the spawn path):
    // without it the plan showed a fresh launch for a job whose day jsonl was
    // on disk, which read as "the paused probe gets clobbered" when the real
    // spawn would have resumed it.
    const resumeRoster = spawn.resumeRunId !== undefined || existsSync(jobJsonlPath(spawn.name, stampToday));
    argvs.push(`  ${job.name}: ${jobArgv(spawn, { stamp: stampToday, until: cliUntil, resumeRoster }).join(" ")}`);
    return {
      name: job.name,
      models: [...new Set(entries.map((e) => e.model))],
      episode: job.episode,
      runId: entries.map((e) => e.runId).join(", "),
      planned: true,
      ...(job.attempt !== undefined ? { attempt: job.attempt } : {}),
      ...(job.extra !== undefined ? { extra: job.extra } : {}),
      ...(job.subscription !== undefined ? { subscription: job.subscription } : {}),
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
  for (const line of formatEnded(
    [...resumes.end, ...planStaleRuns({ runs, campaigns: config.campaigns, refs: Object.keys(config.roster), now: Date.now() })],
    false,
    (e) => failedAttemptsFor(states, e) ?? 0,
  )) {
    console.log(line);
  }
  {
    const line = formatConcurrency(config.maxConcurrent, config.policy);
    if (line !== undefined) console.log(line);
  }
  console.log("finished this session: 0 (ok 0, retried 0) — dry run");
  for (const line of formatQueue(poolJobs(config), undefined)) console.log(line);
  console.log(
    `\n${resumes.resume.length} paused run(s) would resume first; ${plan.pinned.length} pinned job(s) would spawn now plus ${plan.queue.assign.length + plan.policy.length} pool job(s) over ${config.accounts.pool.length} pool account(s).` +
      `\nsupervision: re-read fleet.json every ${TICK_MS / 1000}s; enabled:false drains at the next episode` +
      `\nboundary; enabled:true/new jobs spawn; a malformed edit keeps the last good config.` +
      `\nstamp ${stampToday} is fixed for the life of the supervisor, not rolled at midnight.` +
      `\nrunning as: ${CONTAINER ? "the `fleet` compose service (episodes spawn in-process)" : "a host process (episodes go through docker compose exec)"}.`,
  );
}
