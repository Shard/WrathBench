/**
 * The supervisor's tick over fixture states (#516): what it spawns, drains,
 * holds, ends and announces, and what it leaves in its memory, pinned as
 * snapshots. Each scenario runs the tick twice, as the loop does (once for
 * its actions, once for `toStart`), on one clock. A change to any decision
 * here is a change to what the live supervisor does.
 */
import { describe, expect, test } from "bun:test";

import { parseFleet, type FleetConfig, type FleetJob, type JobSpawn } from "./run-fleet-config";
import { effectiveJobs, type TickIO, type TickMemory } from "./run-fleet-tick";
import type { EndedRun, NameSweep } from "./run-fleet-plan";
import type { RunFact, UnstampedRun } from "../runner/src/run-fact";
import type { CampaignFile } from "../runner/src/campaign-file";
import type { SubscriptionUsage } from "../runner/src/subscription-usage";
import { countedFact } from "../runner/test/fixtures/counted-fact";
import { emptyModelLists } from "../runner/src/model-lists";
import { planOf } from "./fixtures/tick";
import { formatHeld, formatModels, plannedVerdicts } from "./run-fleet-status";
import { checkedIn, defsBlock, definition, partyDefinition } from "../runner/test/fixtures/campaigns";

const NOW = Date.UTC(2026, 10, 15, 12);
const H = 3_600_000;
const STAMP = "20261115";
const SERIES = "0.5";
const RUNS_DIR = "/nonexistent/runs";

// ------------------------------------------------------------------ fixtures

const CREDENTIALS = {
  "claude-1": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN", slots: 2, billing: "paid", enabled: true },
  "claude-2": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", slots: 1, billing: "paid", enabled: true },
  "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, billing: "free", enabled: true },
  "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, budget: { kind: "spend", usdPerDay: 5 }, billing: "paid", enabled: true },
};

const ROSTER = {
  son: { tier: "t1", model: "sonnet", driver: "claude-code" },
  opus: { tier: "t3", model: "opus", driver: "claude-code" },
  glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
  fp: { tier: "t0", model: "stealth/ox-alpha:free", idle: "unlimited" },
  fp2: { tier: "t0", model: "z-ai/glm-5.3-flash:free", idle: "unlimited" },
};

const POOL = ["RUNNER", "RUNNER2", "RUNNER3", "RUNNER4"];

/** A parsed fleet on the fixed series, with `over` laid over the base file. */
function fleet(over: Record<string, unknown> = {}, env: Record<string, string> = {}): FleetConfig {
  const cfg = parseFleet({ _notes: ["n"], accounts: { pool: POOL }, credentials: CREDENTIALS, roster: ROSTER, queue: [], ...over }, { env });
  return { ...cfg, policy: { ...cfg.policy, series: SERIES } };
}

/** Only the unlimited refs and glm, every one past its targets: the pool is the idle lane's. */
function idleFleet(over: Record<string, unknown> = {}): FleetConfig {
  return fleet({ roster: { glm: ROSTER.glm, fp: ROSTER.fp, fp2: ROSTER.fp2 }, ...over });
}
/** The counted runs that put glm, fp and fp2 past their targets. */
function pastTargets(): RunFact[] {
  return [...counted({ model: "z-ai/glm-5.2:free" }, "e90", 3, 3), ...counted({ model: "stealth/ox-alpha:free" }, "e90", 1, 4), ...counted({ model: "z-ai/glm-5.3-flash:free" }, "e90", 1, 4)];
}
const FP = { model: "stealth/ox-alpha:free", driver: "openrouter", episode: "freeplay", extra: true, episodeMs: null } as Partial<RunFact>;
const FP2 = { model: "z-ai/glm-5.3-flash:free", driver: "openrouter", episode: "freeplay", extra: true, episodeMs: null } as Partial<RunFact>;

/** A run of the fleet's, ended unless `over` says otherwise. */
function run(runId: string, over: Partial<RunFact> = {}): RunFact {
  return {
    runId,
    model: "sonnet",
    effort: null,
    driver: "claude-code",
    episode: "e90",
    episodeOverride: false,
    harnessVersion: `harness-${SERIES}-1-gx`,
    harnessSeries: SERIES,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: NOW - 3 * H,
    endedAt: NOW - 2 * H,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: 3,
    live: false,
    pause: null,
    account: "RUNNER",
    character: "Synth",
    episodeMs: 90 * 60_000,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  };
}

/** A run that is live now: no verdict, a fresh heartbeat. */
function live(runId: string, over: Partial<RunFact> = {}): RunFact {
  return run(runId, { startedAt: NOW - 10 * 60_000, endedAt: NOW - 30_000, heartbeatAt: NOW - 30_000, terminationReason: null, live: true, ...over });
}

/** A run paused at `at` with `reason`. */
function paused(runId: string, reason: string, over: Partial<RunFact> = {}, at = NOW - 20 * 60_000): RunFact {
  return run(runId, { endedAt: at, terminationReason: null, pause: { reason, at, count: 1, episodeElapsedMs: 20 * 60_000 }, ...over });
}

/** `n` counted runs of a roster entry on `episode` at `level`. */
function counted(entry: { model: string; driver?: string; effort?: string }, episode: "e90" | "e360" | "deadmines-solo", n: number, level: number): RunFact[] {
  return Array.from({ length: n }, (_, i) => countedFact(entry, episode, level, { i: i + 1, now: NOW, series: SERIES }));
}

/** The policy's own job, as the supervisor holds it in `liveJobs`. */
function policyJob(ref: string, episode: FleetJob["episode"], attempt: number, over: Partial<FleetJob> = {}): FleetJob {
  return { refs: [ref], ref, episode, repeat: 1, name: `${ref}-${episode}`, enabled: true, source: "policy", attempt, ...over };
}

// ------------------------------------------------------------------ the harness

interface Scenario {
  config: FleetConfig;
  facts?: RunFact[];
  unstamped?: UnstampedRun[];
  /** The supervisor's live jobs: name -> the job, its account, the run ids its process plays. */
  running?: { job: FleetJob; account: string; runIds?: string[] }[];
  /** Exited processes still in the table (their jobs no longer running). */
  exited?: { name: string; runIds: string[] }[];
  finished?: string[];
  pending?: FleetJob[];
  placedMemo?: Record<string, NonNullable<FleetJob["placed"]>>;
  /** Accounts a run outside the tick's view holds, and by which run. */
  holders?: Record<string, string>;
  cooling?: Record<string, string>;
  usage?: SubscriptionUsage[];
  campaignFiles?: Record<string, CampaignFile>;
  imageRecords?: string[];
  evals?: boolean;
  onCluster?: boolean;
  maxRunPods?: number;
  worlds?: { max: number | undefined; hold?: string };
  scoredWait?: string | null;
  pauseSwitch?: boolean;
  /** Ends whose write fails, by run id. */
  endFails?: string[];
  /** Campaign files whose write fails, by run id. */
  fileFails?: string[];
}

/** A Set or Map, as plain data, so a snapshot can hold it; a local clock reading is the same in every zone. */
function plain(v: unknown): unknown {
  const text = JSON.stringify(v, (_k, x: unknown) => (x instanceof Set ? [...(x as Set<unknown>)].sort() : x instanceof Map ? Object.fromEntries([...(x as Map<string, unknown>)].sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  return JSON.parse(text.replace(/(\d{1,2}\/\d{1,2}\/\d{4}, )?\d{1,2}:\d{2}:\d{2}( [AP]M)?/g, "<local time>")) as unknown;
}

function spawnOf(s: JobSpawn): unknown {
  return plain(s);
}

/** Run the scenario's tick twice, as the loop does, and return everything it decided. */
export function runScenario(sc: Scenario): Record<string, unknown> {
  const log: string[] = [];
  const records: unknown[] = [];
  const ended: string[] = [];
  const repaired: string[] = [];
  const released: string[] = [];
  const sweeps: NameSweep[][] = [];
  const written: string[] = [];
  const procs = new Map<string, { exited: boolean; runIds: string[] }>();
  const assigned = new Map<string, string>();
  const liveJobs = new Map<string, FleetJob>();
  const runningNames = new Set<string>();
  for (const r of sc.running ?? []) {
    procs.set(r.job.name, { exited: false, runIds: r.runIds ?? [] });
    liveJobs.set(r.job.name, r.job);
    runningNames.add(r.job.name);
    if (r.job.account === undefined) assigned.set(r.job.name, r.account);
  }
  for (const e of sc.exited ?? []) procs.set(e.name, { exited: true, runIds: e.runIds });
  const mem: TickMemory = {
    procs,
    assigned,
    liveJobs,
    sets: { running: runningNames, draining: new Set(), finished: new Set(sc.finished ?? []) },
    finishedRepeat: new Map(),
    pending: new Map((sc.pending ?? []).map((j) => [j.name, j])),
    placedMemo: new Map(Object.entries(sc.placedMemo ?? {})),
    drainReasons: new Map(),
    announcedPicks: new Set(),
    complainedSkips: new Map(),
    announcedDone: new Set(),
    endedRuns: [],
    campaignJobs: [],
    lastPlan: { assign: [], waiting: [], skipped: [], done: [] },
    lastPaused: [],
    pinnedDone: [],
    policyIdle: undefined,
    lastCredentials: undefined,
  };
  const endFails = new Set(sc.endFails ?? []);
  const files = new Map(Object.entries(sc.campaignFiles ?? {}));
  const io: TickIO = {
    evals: sc.evals ?? true,
    stamp: STAMP,
    runsDir: RUNS_DIR,
    onCluster: sc.onCluster ?? false,
    now: () => NOW,
    scoredWait: sc.scoredWait ?? null,
    pauseSwitch: () => (sc.pauseSwitch === true ? { at: NOW, why: "update window" } : undefined),
    maxRunPods: () => sc.maxRunPods,
    worldsSetting: (mode) => (mode !== "evals" || sc.worlds === undefined ? undefined : { max: sc.worlds.max, ...(sc.worlds.hold !== undefined ? { hold: sc.worlds.hold } : {}) }),
    readFacts: () => ({ facts: structuredClone(sc.facts ?? []), unstamped: structuredClone(sc.unstamped ?? []) }),
    readModelsSidecar: () => ({ version: 1, cleared: {} }),
    readModelLists: () => emptyModelLists(),
    goUsage: { noteOverages: () => {}, observations: () => sc.usage ?? [], readHolds: () => new Map() },
    holders: () => new Map(Object.entries(sc.holders ?? {})),
    jobCooling: (job) => sc.cooling?.[job.name],
    runCampaignFile: (dir) => files.get(dir.slice(RUNS_DIR.length + 1)) ?? null,
    writeCampaignFile: (dir, file) => {
      if ((sc.fileFails ?? []).includes(dir.slice(RUNS_DIR.length + 1))) throw new Error("read-only file system");
      written.push(`${dir.slice(RUNS_DIR.length + 1)} ${file.campaign}@${file.version}`);
      files.set(dir.slice(RUNS_DIR.length + 1), file);
    },
    hasImageRecord: (id) => (sc.imageRecords ?? []).includes(id),
    repairRecordedTerminations: (_dir, runs) => runs.filter((f) => f.recordedTermination !== undefined && f.archived !== true).map((f) => (repaired.push(f.runId), { runId: f.runId })),
    endRuns: (_dir, list: readonly EndedRun[]) =>
      list.map((e) => {
        ended.push(`${e.runId} ${e.reason}: ${e.detail}`);
        return endFails.has(e.runId) ? { runId: e.runId, error: "disk full" } : { runId: e.runId };
      }),
    releaseEndedSessions: async (list) => {
      for (const e of list) released.push(e.runId);
    },
    sweepNames: async (list) => {
      sweeps.push([...list]);
    },
    say: (line) => log.push(line),
    record: (entry) => records.push(entry),
  };
  const first = effectiveJobs(mem, io, sc.config).map(spawnOf);
  const memoryAfterFirst = plain({
    pending: [...mem.pending.keys()].sort(),
    placedMemo: mem.placedMemo,
    finished: mem.sets.finished,
    drainReasons: mem.drainReasons,
  });
  const second = effectiveJobs(mem, io, sc.config).map(spawnOf);
  return plain({
    spawns: first,
    secondCall: JSON.stringify(second) === JSON.stringify(first) ? "same" : second,
    memoryAfterFirst,
    memory: {
      pending: [...mem.pending.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      placedMemo: mem.placedMemo,
      finished: mem.sets.finished,
      drainReasons: mem.drainReasons,
      endedRuns: mem.endedRuns,
      campaignJobs: mem.campaignJobs.map((j) => j.name),
      lastPlan: {
        assign: mem.lastPlan.assign.map((a) => `${a.job.name} on ${a.account}`),
        waiting: mem.lastPlan.waiting.map((j) => j.name),
        skipped: mem.lastPlan.skipped.map((sk) => `${sk.job.name}: ${sk.reason}`),
        done: mem.lastPlan.done.map((j) => j.name),
      },
      lastPaused: mem.lastPaused,
      pinnedDone: mem.pinnedDone.map((j) => j.name),
      policyIdle: mem.policyIdle ?? null,
      credentialsBooked: mem.lastCredentials === undefined ? null : Object.fromEntries(Object.keys(CREDENTIALS).map((id) => [id, mem.lastCredentials!.book.inUse(`credential:${id}`)])),
    },
    io: { ended, repaired, released, sweeps, written },
    say: log,
    record: records,
  }) as Record<string, unknown>;
}

// ------------------------------------------------------------------ scenarios

const SCENARIOS: Record<string, () => Scenario> = {
  // ---- boots and the empty board
  "an empty board": () => ({ config: parseFleet({ _notes: ["n"], accounts: { pool: POOL }, roster: {}, queue: [] }, { env: {} }) }),
  "a boot with no credentials": () => ({ config: fleet({ credentials: {} }) }),
  "a fresh boot: e90 for every t1/t3 model, credentials in order": () => ({ config: fleet() }),
  "a fresh boot with the pool capped at two": () => ({ config: fleet({ accounts: { pool: POOL, max: 2 } }) }),
  "an account held by a run outside the tick's view": () => ({ config: fleet(), holders: { RUNNER: "hand-run-1" } }),

  // ---- the lanes
  "e360: a t3 model past its e90s owes e360": () => ({
    config: fleet(),
    facts: [...counted({ model: "opus", driver: "claude-code" }, "e90", 3, 6)],
  }),
  "Deadmines solo: a t3 model with an L8 e360 opens the solo id on an eval world": () => ({
    config: fleet({ policy: { worlds: "evals" } }, { WRATHBENCH_EVAL_POOL_SIZE: "10" }),
    facts: [...counted({ model: "opus", driver: "claude-code" }, "e90", 3, 6), ...counted({ model: "opus", driver: "claude-code" }, "e360", 1, 8)],
    worlds: { max: 4 },
  }),
  "Deadmines solo held by the world cap": () => ({
    config: fleet({ policy: { worlds: "evals" } }, { WRATHBENCH_EVAL_POOL_SIZE: "10" }),
    facts: [...counted({ model: "opus", driver: "claude-code" }, "e90", 3, 6), ...counted({ model: "opus", driver: "claude-code" }, "e360", 1, 8)],
    worlds: { max: 0 },
  }),
  "Deadmines solo while failed boots hold the worlds": () => ({
    config: fleet({ policy: { worlds: "evals" } }, { WRATHBENCH_EVAL_POOL_SIZE: "10" }),
    facts: [...counted({ model: "opus", driver: "claude-code" }, "e90", 3, 6), ...counted({ model: "opus", driver: "claude-code" }, "e360", 1, 8)],
    worlds: { max: 4, hold: "three world boots failed in a row" },
  }),
  "Deadmines solo with worlds off": () => ({
    config: fleet(),
    facts: [...counted({ model: "opus", driver: "claude-code" }, "e90", 3, 6), ...counted({ model: "opus", driver: "claude-code" }, "e360", 1, 8)],
  }),
  "scored episodes held (SCORED_EPISODES_WAIT)": () => ({ config: fleet({ queue: [{ ref: "glm", episode: "e90", repeat: 1 }] }), scoredWait: "the scored-episode hold" }),
  "the evals group off": () => ({ config: fleet(), evals: false }),
  "freeplay: models past their targets take a freeplay session each": () => ({ config: idleFleet(), facts: pastTargets() }),
  "freeplay: a character continues on the account it stands on": () => ({
    config: idleFleet(),
    facts: [...pastTargets(), run("fleet-fp-freeplay-a3", { ...FP, account: "RUNNER3", character: "Bromdir", terminationReason: "idle" })],
  }),
  "freeplay: a character waits while another unlimited ref holds its account": () => ({
    config: idleFleet(),
    facts: [...pastTargets(), run("fleet-fp-freeplay-a3", { ...FP, account: "RUNNER3", character: "Bromdir", terminationReason: "idle" }), live("fleet-fp2-freeplay-a1", { ...FP2, account: "RUNNER3", character: "Glimmer" })],
    running: [{ job: policyJob("fp2", "freeplay", 1), account: "RUNNER3", runIds: ["fleet-fp2-freeplay-a1"] }],
  }),
  "freeplay: a character's account held by a bounded job is dropped for a fresh one": () => ({
    config: idleFleet({ queue: [{ ref: "glm", episode: "e90", repeat: 5 }] }),
    facts: [...pastTargets(), run("fleet-fp-freeplay-a3", { ...FP, account: "RUNNER3", character: "Bromdir", terminationReason: "idle" }), live("fleet-glm-e90-20261115", { model: "z-ai/glm-5.2:free", account: "RUNNER3" })],
    running: [{ job: { refs: ["glm"], ref: "glm", episode: "e90", repeat: 5, name: "glm-e90", enabled: true, source: "queue" }, account: "RUNNER3", runIds: ["fleet-glm-e90-20261115"] }],
  }),
  "freeplay: with no free account a character says it is blocked": () => ({
    config: idleFleet({ accounts: { pool: ["RUNNER3"] } }),
    facts: [...pastTargets(), run("fleet-fp-freeplay-a3", { ...FP, account: "RUNNER3", character: "Bromdir", terminationReason: "idle" }), live("fleet-fp2-freeplay-a1", { ...FP2, account: "RUNNER3", character: "Glimmer" })],
    running: [{ job: policyJob("fp2", "freeplay", 1), account: "RUNNER3", runIds: ["fleet-fp2-freeplay-a1"] }],
  }),
  "a fresh launch sweeps its model's old name off a free account, and keeps every freeplay character": () => ({
    config: fleet({ roster: { glm: ROSTER.glm, son: ROSTER.son, fp: ROSTER.fp } }),
    facts: [
      ...counted({ model: "stealth/ox-alpha:free" }, "e90", 1, 4),
      run("fleet-fp-freeplay-a3", { ...FP, account: "RETIRED2", character: "Bromdir", terminationReason: "idle" }),
      run("fleet-glm-e90-old", { model: "z-ai/glm-5.2:free", account: "RETIRED1", character: "Oldname", terminationReason: "episode-limit", endedAt: NOW - 5 * H }),
      run("fleet-son-e90-old", { account: "RETIRED2", character: "Bromdir", terminationReason: "episode-limit", endedAt: NOW - 5 * H }),
    ],
  }),
  // ---- the queue and pinned jobs
  "queue: a manual job takes a pool account ahead of the policy": () => ({ config: fleet({ queue: [{ ref: "glm", episode: "e90", repeat: 2 }] }) }),
  "queue: manual jobs wait when the pool is full, and hold the policy back": () => ({
    config: fleet({ accounts: { pool: POOL, max: 1 }, queue: [{ ref: "glm", episode: "e90", repeat: 1 }, { ref: "son", episode: "e90", repeat: 1 }] }),
  }),
  "queue: a job whose ref is ineligible is skipped": () => ({ config: fleet({ queue: [{ ref: "glm", episode: "e360", repeat: 1 }] }) }),
  "queue: a job whose repeat is met is done": () => ({
    config: fleet({ queue: [{ ref: "glm", episode: "e90", repeat: 1 }] }),
    facts: counted({ model: "z-ai/glm-5.2:free" }, "e90", 1, 3).map((f) => ({ ...f, runId: "fleet-glm-e90-20261115" })),
  }),
  "queue: a cooling job waits out its defer": () => ({
    config: fleet({ queue: [{ ref: "glm", episode: "e90", repeat: 1 }] }),
    cooling: { "glm-e90": "glm cooling until 13:00 (rate-limited)" },
  }),
  "queue: a finished job stays finished": () => ({ config: fleet({ queue: [{ ref: "glm", episode: "e90", repeat: 1 }] }), finished: ["glm-e90"] }),
  "pinned: a job on its own account": () => ({ config: fleet({ accounts: { pool: ["RUNNER", "RUNNER2"] }, queue: [{ ref: "son", episode: "e90", repeat: 1, account: "PINNED1" }] }) }),
  "pinned: a job whose repeat is met spawns nothing": () => ({
    config: fleet({ accounts: { pool: ["RUNNER"] }, queue: [{ ref: "glm", episode: "e90", repeat: 1, account: "PINNED1" }] }),
    facts: counted({ model: "z-ai/glm-5.2:free" }, "e90", 1, 3).map((f) => ({ ...f, runId: "fleet-glm-e90-20261115" })),
  }),
  "pinned: an ineligible job is gated": () => ({ config: fleet({ accounts: { pool: ["RUNNER"] }, queue: [{ ref: "glm", episode: "e360", repeat: 1, account: "PINNED1" }] }) }),
  "pinned: a disabled job that is running drains": () => {
    const config = fleet({ accounts: { pool: ["RUNNER"] }, queue: [{ ref: "son", episode: "e90", repeat: 1, account: "PINNED1", enabled: false }] });
    return {
      config,
      facts: [live("fleet-son-e90-pin", { account: "PINNED1" })],
      running: [{ job: { ...config.jobs[0]!, enabled: true }, account: "PINNED1", runIds: ["fleet-son-e90-pin"] }],
    };
  },
  "pinned: a running job the config removed is unyielded and drains": () => ({
    config: fleet({ accounts: { pool: ["RUNNER"] } }),
    facts: [live("fleet-son-e90-pin", { account: "PINNED1" })],
    running: [{ job: { refs: ["son"], ref: "son", episode: "e90", repeat: 1, name: "son-e90-pin", enabled: true, source: "queue", account: "PINNED1" }, account: "PINNED1", runIds: ["fleet-son-e90-pin"] }],
  }),
  "pool: a running queue job the config dropped drains": () => ({
    config: fleet(),
    facts: [live("fleet-glm-e90-q", { model: "z-ai/glm-5.2:free", account: "RUNNER2" })],
    running: [{ job: { refs: ["glm"], ref: "glm", episode: "e90", repeat: 1, name: "glm-e90", enabled: true, source: "queue" }, account: "RUNNER2", runIds: ["fleet-glm-e90-q"] }],
  }),
  "pool: a running queue job still in the config keeps running": () => ({
    config: fleet({ queue: [{ ref: "glm", episode: "e90", repeat: 2 }] }),
    facts: [live("fleet-glm-e90-20261115", { model: "z-ai/glm-5.2:free", account: "RUNNER2", credential: "or-free" })],
    running: [{ job: { refs: ["glm"], ref: "glm", episode: "e90", repeat: 2, name: "glm-e90", enabled: true, source: "queue" }, account: "RUNNER2", runIds: ["fleet-glm-e90-20261115"] }],
  }),
  "policy: a running freeplay job whose roster entry went idle none drains": () => ({
    config: fleet({ roster: { ...ROSTER, fp: { ...ROSTER.fp, idle: "none" } } }),
    facts: [...counted({ model: "stealth/ox-alpha:free" }, "e90", 1, 4), live("fleet-fp-freeplay-a1", { model: "stealth/ox-alpha:free", episode: "freeplay", extra: true, account: "RUNNER2", episodeMs: null })],
    running: [{ job: policyJob("fp", "freeplay", 1), account: "RUNNER2", runIds: ["fleet-fp-freeplay-a1"] }],
  }),
  "policy: a running e90 job keeps its account and its credential": () => ({
    config: fleet(),
    facts: [live("fleet-son-e90-a1", { account: "RUNNER2", credential: "claude-1" })],
    running: [{ job: policyJob("son", "e90", 1), account: "RUNNER2", runIds: ["fleet-son-e90-a1"] }],
  }),
  "policy: a pick from last tick still pending, and its placement remembered": () => ({
    config: fleet(),
    pending: [policyJob("son", "e90", 1, { placed: { son: { id: "claude-1", key: "credential:claude-1" } as never } })],
    placedMemo: { "son-e90": { son: { id: "claude-1" } as never }, "gone-e90": { glm: { id: "or-free" } as never } },
  }),

  // ---- holds: credentials, slots, budgets, the host cap
  "credentials: a usage window past its scored share holds claude picks": () => ({
    config: fleet(),
    usage: [
      { credential: "claude-1", observedAt: NOW - 60_000, windows: [{ usedPercent: 90, windowMinutes: 300, resetsAt: NOW + 2 * H }] },
      { credential: "claude-2", observedAt: NOW - 60_000, windows: [{ usedPercent: 90, windowMinutes: 300, resetsAt: NOW + 2 * H }] },
    ],
  }),
  "credentials: a spent window drains a running scored job at its boundary": () => ({
    config: fleet(),
    usage: [{ credential: "claude-1", observedAt: NOW - 60_000, windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: NOW + 2 * H }] }],
    facts: [live("fleet-son-e90-a1", { account: "RUNNER2", credential: "claude-1" })],
    running: [{ job: policyJob("son", "e90", 1), account: "RUNNER2", runIds: ["fleet-son-e90-a1"] }],
  }),
  "credentials: a disabled credential carries nothing": () => ({
    config: fleet({ credentials: { ...CREDENTIALS, "claude-1": { ...CREDENTIALS["claude-1"], enabled: false }, "claude-2": { ...CREDENTIALS["claude-2"], enabled: false } } }),
  }),
  "credentials: slots full on every claude credential": () => ({
    config: fleet(),
    unstamped: [
      { ...live("hand-1", { account: "HAND1", credential: "claude-1" }), episode: null } as unknown as UnstampedRun,
      { ...live("hand-2", { account: "HAND2", credential: "claude-1" }), episode: null } as unknown as UnstampedRun,
      { ...live("hand-3", { account: "HAND3", credential: "claude-2" }), episode: null } as unknown as UnstampedRun,
    ],
  }),
  "credentials: a runs-per-day budget spent": () => ({
    config: fleet({ credentials: { ...CREDENTIALS, "or-free": { ...CREDENTIALS["or-free"], budget: { kind: "runs", perDay: 1 } } } }),
    facts: [run("fleet-glm-e90-old", { model: "z-ai/glm-5.2:free", credential: "or-free", startedAt: NOW - H, endedAt: NOW - 30 * 60_000, account: "RUNNER4" })],
  }),
  "the host cap: claude-code sessions capped at one": () => ({ config: fleet({ policy: { maxSessions: { "claude-code": 1 } } }) }),

  // ---- paused runs, lapses, cooling
  "resume: an operator-paused e90 goes back on its own account": () => ({
    config: fleet(),
    facts: [paused("fleet-son-e90-a1", "operator-pause", { account: "RUNNER3", credential: "claude-1" })],
  }),
  "resume: a paused freeplay character comes back ahead of anything fresh": () => ({
    config: fleet(),
    facts: [
      ...counted({ model: "stealth/ox-alpha:free" }, "e90", 1, 4),
      paused("fleet-fp-freeplay-a2", "operator-pause", { model: "stealth/ox-alpha:free", episode: "freeplay", extra: true, account: "RUNNER4", character: "Bromdir", credential: "or-free", episodeMs: null }),
    ],
  }),
  "resume: held by its credential's usage window": () => ({
    config: idleFleet({ credentials: { ...CREDENTIALS, "or-free": { ...CREDENTIALS["or-free"], budget: { kind: "runs", perDay: 1 } } } }),
    facts: [...pastTargets(), paused("fleet-fp-freeplay-a2", "operator-pause", { ...FP, account: "RUNNER4", character: "Bromdir", credential: "or-free" }), run("fleet-glm-e90-today", { model: "z-ai/glm-5.2:free", credential: "or-free", startedAt: NOW - H, endedAt: NOW - 30 * 60_000, account: "RUNNER2" })],
  }),
  "resume: a scored run that paused is ended, not resumed": () => ({
    config: fleet(),
    facts: [paused("fleet-son-e90-a1", "operator-pause", { account: "RUNNER3", credential: "claude-1" })],
    usage: [{ credential: "claude-1", observedAt: NOW - 60_000, windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: NOW + 2 * H }] }],
  }),
  "resume: held for want of a slot on its credential": () => ({
    config: idleFleet({ credentials: { ...CREDENTIALS, "or-free": { ...CREDENTIALS["or-free"], slots: 1 } } }),
    facts: [...pastTargets(), paused("fleet-fp-freeplay-a2", "operator-pause", { ...FP, account: "RUNNER4", character: "Bromdir", credential: "or-free" }), live("fleet-fp2-freeplay-a1", { ...FP2, account: "RUNNER2", character: "Glimmer", credential: "or-free" })],
    running: [{ job: policyJob("fp2", "freeplay", 1), account: "RUNNER2", runIds: ["fleet-fp2-freeplay-a1"] }],
  }),
  "resume: a provider-reset pause waits for its reset": () => ({
    config: idleFleet(),
    facts: [...pastTargets(), paused("fleet-fp-freeplay-a2", "rate-limited", { ...FP, account: "RUNNER4", character: "Bromdir", credential: "or-free", pause: { reason: "rate-limited", at: NOW - 60_000, count: 1, episodeElapsedMs: 60_000, notBefore: NOW + H } })],
  }),
  "resume: a paused run whose account a live job holds waits": () => ({
    config: idleFleet({ queue: [{ ref: "glm", episode: "e90", repeat: 5 }] }),
    facts: [...pastTargets(), paused("fleet-fp-freeplay-a2", "operator-pause", { ...FP, account: "RUNNER4", character: "Bromdir", credential: "or-free" }), live("fleet-glm-e90-20261115", { model: "z-ai/glm-5.2:free", account: "RUNNER4" })],
    running: [{ job: { refs: ["glm"], ref: "glm", episode: "e90", repeat: 5, name: "glm-e90", enabled: true, source: "queue" }, account: "RUNNER4", runIds: ["fleet-glm-e90-20261115"] }],
  }),
  "lapse: a paused scored run past its budget is ended as a failed attempt": () => ({
    config: fleet(),
    facts: [paused("fleet-son-e90-a1", "operator-pause", { account: "RUNNER3", credential: "claude-1", startedAt: NOW - 30 * H }, NOW - 26 * H)],
  }),
  "lapse: an end that cannot be written is said and kept out of the projection": () => ({
    config: fleet(),
    facts: [paused("fleet-son-e90-a1", "operator-pause", { account: "RUNNER3", credential: "claude-1", startedAt: NOW - 30 * H }, NOW - 26 * H)],
    endFails: ["fleet-son-e90-a1"],
  }),
  "lapse: a verdict-less freeplay run long cold reads offline and resumes": () => ({
    config: idleFleet(),
    facts: [...pastTargets(), run("fleet-fp-freeplay-a2", { ...FP, account: "RUNNER4", character: "Bromdir", terminationReason: null, endedAt: NOW - 2 * H, startedAt: NOW - 6 * H })],
  }),
  "lapse: a verdict-less scored run long cold is ended": () => ({
    config: fleet(),
    facts: [run("fleet-son-e90-a1", { account: "RUNNER3", terminationReason: null, endedAt: NOW - 5 * H, startedAt: NOW - 6 * H })],
  }),
  "cooling: a model on the defer ladder after a failed attempt": () => ({
    config: fleet(),
    facts: [run("fleet-son-e90-a1", { account: "RUNNER3", terminationReason: "provider-error", modelResponses: 0, endedAt: NOW - 5 * 60_000 })],
  }),
  "a recorded termination the row lacks is repaired": () => ({
    config: fleet(),
    facts: [run("fleet-son-e90-a1", { account: "RUNNER3", terminationReason: "episode-limit", recordedTermination: { reason: "episode-limit", detail: null, at: NOW - H } })],
  }),

  // ---- runs no job of this supervisor owns
  "an unowned live run holds its account and its model": () => ({
    config: fleet(),
    facts: [live("fleet-son-e90-a1", { account: "RUNNER2", credential: "claude-1" })],
  }),
  "a hand launch with no episode bills its credential": () => ({
    config: fleet(),
    unstamped: [{ ...live("hand-1", { account: "HAND1", credential: "claude-2" }), episode: null } as unknown as UnstampedRun],
  }),
  "a run this supervisor's process plays before its run reads live": () => ({
    config: fleet(),
    running: [{ job: policyJob("son", "e90", 1), account: "RUNNER2", runIds: ["fleet-son-e90-a1"] }],
    placedMemo: { "son-e90": { son: { id: "claude-1", key: "credential:claude-1" } as never } },
  }),
  "an exited process no longer counts as the supervisor's own": () => ({
    config: fleet(),
    facts: [run("fleet-son-e90-a1", { account: "RUNNER2", terminationReason: null, endedAt: NOW - 3 * 60_000, heartbeatAt: NOW - 3 * 60_000 })],
    exited: [{ name: "son-e90", runIds: ["fleet-son-e90-a1"] }],
  }),

  // ---- probe campaigns
  "probes: an unpinned campaign is scheduled for a model that owes nothing": () => ({
    config: idleFleet({ "campaign-defs": defsBlock(definition({ id: "solo" })), campaigns: { solo: { version: 1, assignments: [{ model: "glm", runsPerCell: 1 }] } } }),
    facts: pastTargets(),
  }),
  "probes: run pods on, capped at zero": () => ({
    config: idleFleet({ policy: { runPods: "probes" }, "campaign-defs": defsBlock(definition({ id: "solo" })), campaigns: { solo: { version: 1, assignments: [{ model: "glm", runsPerCell: 1 }] } } }),
    facts: pastTargets(),
    onCluster: true,
    maxRunPods: 0,
  }),
  "probes: run pods on, a live probe pod fills the cap": () => ({
    config: idleFleet({ policy: { runPods: "probes" }, "campaign-defs": defsBlock(definition({ id: "solo" }), definition({ id: "duo" })), campaigns: { solo: { version: 1, assignments: [{ model: "glm", runsPerCell: 1 }] }, duo: { version: 1, assignments: [{ model: "fp", runsPerCell: 1 }] } } }),
    facts: [...pastTargets(), live("fleet-glm-probing-solo-a1", { model: "z-ai/glm-5.2:free", episode: "probing", account: "RUNNER2", credential: "or-free", campaign: "solo", campaignVersion: 1, cell: "a", ref: "glm", arm: "base" } as Partial<RunFact>)],
    onCluster: true,
    maxRunPods: 1,
  }),
  "probes: a pinned campaign spawns its next cell on its account": () => ({
    config: fleet({ "campaign-defs": defsBlock(checkedIn("race-probe@1")), campaigns: { "race-probe": { version: 1, account: "PROBE", assignments: [{ model: "glm", runsPerCell: 1 }] } } }),
  }),
  "probes: a paused probe that predates campaign files gets one written and resumes": () => {
    const def = definition({ id: "solo" });
    return {
      config: idleFleet({ "campaign-defs": defsBlock(def), campaigns: { solo: { version: 1, assignments: [{ model: "glm", runsPerCell: 1 }] } } }),
      facts: [
        ...pastTargets(),
        paused("fleet-glm-probing-solo-a1", "operator-pause", {
          model: "z-ai/glm-5.2:free",
          episode: "probing",
          account: "RUNNER2",
          credential: "or-free",
          campaign: "solo",
          campaignVersion: 1,
          cell: def.cells[0]!.id,
          ref: "glm",
          arm: "base",
        } as Partial<RunFact>),
      ],
    };
  },
  "probes: a campaign file that cannot be written holds the resume this tick": () => {
    const def = definition({ id: "solo" });
    return {
      config: idleFleet({ "campaign-defs": defsBlock(def), campaigns: { solo: { version: 1, assignments: [{ model: "glm", runsPerCell: 1 }] } } }),
      facts: [
        ...pastTargets(),
        paused("fleet-glm-probing-solo-a1", "operator-pause", {
          model: "z-ai/glm-5.2:free",
          episode: "probing",
          account: "RUNNER2",
          credential: "or-free",
          campaign: "solo",
          campaignVersion: 1,
          cell: def.cells[0]!.id,
          ref: "glm",
          arm: "base",
        } as Partial<RunFact>),
      ],
      fileFails: ["fleet-glm-probing-solo-a1"],
    };
  },
  "parties: two parties draw from the eval pool, a third is held": () => ({
    config: fleet(
      {
        policy: { worlds: "evals" },
        "campaign-defs": defsBlock(...["deadmines", "stockades", "wailing"].map((id) => partyDefinition({ id }))),
        campaigns: Object.fromEntries(["deadmines", "stockades", "wailing"].map((id) => [id, { version: 1, assignments: [{ model: "son" }], accounts: "evals", credential: "claude-1" }])),
        credentials: { ...CREDENTIALS, "claude-1": { ...CREDENTIALS["claude-1"], slots: 20 } },
      },
      { WRATHBENCH_EVAL_POOL_SIZE: "10" },
    ),
    worlds: { max: 4 },
  }),
  "parties: a pinned party with no room on its credential waits": () => ({
    config: fleet(
      {
        "campaign-defs": defsBlock(partyDefinition({ id: "deadmines" })),
        campaigns: { deadmines: { version: 1, assignments: [{ model: "son" }], accounts: ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"], credential: "claude-1" } },
      },
    ),
  }),

  // ---- the operator
  "the pause switch: picks are planned, nothing is announced": () => ({
    config: fleet(),
    facts: [paused("fleet-son-e90-a1", "operator-pause", { account: "RUNNER3", credential: "claude-1" })],
    pauseSwitch: true,
  }),
  "a refused pin is left disabled": () => ({
    config: fleet({ queue: [{ ref: "son", episode: "e90", repeat: 1, account: "RUNNER" }] }),
  }),
};

describe("the supervisor's tick over fixture states", () => {
  for (const [name, make] of Object.entries(SCENARIOS)) {
    test(name, () => {
      expect(runScenario(make())).toMatchSnapshot();
    });
  }
});



describe("the reports say the tick's own decision", () => {
  test("a model the projection would schedule but the tick holds reads held, with the tick's reason; one it launches says where", () => {
    const config = fleet();
    const usage = ["claude-1", "claude-2"].map((credential) => ({ credential, observedAt: NOW - 60_000, windows: [{ usedPercent: 90, windowMinutes: 300, resetsAt: NOW + 2 * H }] }));
    const plan = planOf(config, { now: NOW, stamp: STAMP, usage });
    const lines = formatModels(plan.states, new Set(), NOW, new Map(), config.policy, true, plannedVerdicts(plan));
    const line = (name: string): string => lines.find((l) => l.trimStart().startsWith(`${name} `))!;
    // Without the plan the projection's word is "yes" for both claude models.
    expect(formatModels(plan.states, new Set(), NOW, new Map(), config.policy).find((l) => l.trimStart().startsWith("son "))).toMatch(/ yes: schedulable on e90/);
    expect(line("son")).toMatch(/ held: schedulable on e90 — e90 held — no credential has room \(credential claude-1: at or over its scored usage threshold/);
    expect(line("opus")).toMatch(/ held: /);
    expect(line("glm")).toMatch(/ yes: schedulable on e90 — next tick: e90 on RUNNER$/);
    expect(formatHeld(plan.holds).join("\n")).toContain("son: HELD — e90 wanted, no credential has room");
  });
});

describe("one model on two providers, as the tick and its reports read it (operator, 2026-11-16)", () => {
  const GO_BASE = "https://opencode.ai/inference/go/openai/v1";
  const twoProviders = (goOpen = true): FleetConfig =>
    fleet({
      credentials: { ...CREDENTIALS, opencodego: { provider: "opencode-go", secretEnv: "OPENCODE_KEY", slots: 2, billing: "paid", enabled: goOpen } },
      roster: {
        "ds-go": { tier: "t1", model: "deepseek-v4.1-flash", apiBase: GO_BASE },
        "ds-or": { tier: "t1", model: "deepseek/deepseek-v4.1-flash" },
      },
    });
  const goRun = (i: number): RunFact => ({ ...countedFact({ model: "deepseek-v4.1-flash", driver: "openai" }, "e90", 3, { i, now: NOW, series: SERIES }), runId: `go-${i}`, apiBase: GO_BASE, credential: "opencodego", account: "RUNNER" } as RunFact);
  const orRun = (i: number): RunFact => ({ ...countedFact({ model: "deepseek/deepseek-v4.1-flash" }, "e90", 2, { i, now: NOW, series: SERIES }), runId: `or-${i}`, credential: "or-paid", account: "RUNNER" });
  const report = (config: FleetConfig, runs: RunFact[]): { picks: string[]; lines: string[] } => {
    const plan = planOf(config, { now: NOW, stamp: STAMP, runs });
    return {
      picks: plan.picks.map((p) => `${p.job.name} on ${p.account}`),
      lines: [...formatModels(plan.states, new Set(), NOW, new Map(), config.policy, true, plannedVerdicts(plan)).slice(1), ...formatHeld(plan.holds)],
    };
  };

  test("three Go e90s are the model's three: the OpenRouter entry launches no fourth", () => {
    const { picks, lines } = report(twoProviders(), [goRun(1), goRun(2), goRun(3)]);
    expect(picks).toEqual([]);
    expect(lines).toEqual([
      "  model        billing tier      status   e90          e360         extras schedulable",
      "  ds-go        paid    t1        active   3/3 L3       -            0      free: targets met on e90 — last episode-limit 5760m ago — one model, also run as ds-or: counted runs under any fill its targets",
      "  └ ds-or      paid    t1        active   ↑            -            0      free: targets met on e90",
    ]);
  });

  test("a job in flight under one entry holds the other's e90, unless it is a probe", () => {
    const runs = [goRun(1), orRun(2)];
    const inFlight = (refs: string[], episode: "e90" | "probing") => planOf(twoProviders(), { now: NOW, stamp: STAMP, runs, running: [{ name: `${refs[0]}-${episode}`, account: "RUNNER4", refs, episode }] });
    // ds-go plays its e90: ds-or launches none beside it.
    expect(inFlight(["ds-go"], "e90").picks.map((p) => p.job.name)).toEqual([]);
    // ds-or plays a probe: ds-go's e90 goes ahead.
    expect(inFlight(["ds-or"], "probing").picks.map((p) => `${p.job.name} on ${p.account}`)).toEqual(["ds-go-e90 on RUNNER"]);
  });

  test("owing one between them, one e90 launches, under the first entry with room", () => {
    const owed = report(twoProviders(), [goRun(1), orRun(2)]);
    expect(owed.picks).toEqual(["ds-go-e90 on RUNNER"]);
    expect(owed.lines).toEqual([
      "  model        billing tier      status   e90          e360         extras schedulable",
      "  ds-go        paid    t1        active   2/3 L3       -            0      yes: schedulable on e90 — next tick: e90 on RUNNER — last episode-limit 5880m ago — one model, also run as ds-or: counted runs under any fill its targets",
      "  └ ds-or      paid    t1        active   ↑            -            0      held: schedulable on e90 — e90 launches under ds-go next tick (one model) — last episode-limit 5820m ago",
    ]);
    // The Go credential has no room (disabled here): the pick moves to the OpenRouter entry, and Go's hold says why.
    const full = report(twoProviders(false), [goRun(1), orRun(2)]);
    expect(full.picks).toEqual(["ds-or-e90 on RUNNER"]);
    expect(full.lines.slice(1)).toEqual([
      "  ds-go        paid    t1        active   2/3 L3       -            0      held: schedulable on e90 — e90 held — no enabled OpenCode Go credential carries paid models — add one under credentials — last episode-limit 5880m ago — one model, also run as ds-or: counted runs under any fill its targets",
      "  └ ds-or      paid    t1        active   ↑            -            0      yes: schedulable on e90 — next tick: e90 on RUNNER — last episode-limit 5820m ago",
      "  ds-go: HELD — e90 wanted, no enabled OpenCode Go credential carries paid models — add one under credentials",
    ]);
  });
});
