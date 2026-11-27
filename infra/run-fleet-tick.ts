/**
 * The supervisor's tick as three steps: gather one snapshot of everything it
 * reads (`tickSnapshot`), plan from it with no I/O (`planTick`,
 * run-fleet-plan.ts), and apply the plan (`applyTick`): the writes, the
 * lines, and the supervisor's memory. `--status` and `--dry-run` gather the
 * same snapshot from disk and the state file and print the same plan
 * (run-fleet-status.ts), so the report is the tick's own decision.
 */

import { join } from "node:path";
import { poolJobs, type FleetConfig, type FleetJob, type JobSpawn } from "./run-fleet-config";
import { type EndedRun, type JobSets, type NameSweep, type PausedListing, planTick, type QueuePlan, type SupervisorView, type TickPlan, type TickSnapshot } from "./run-fleet-plan";
import { formatEndedRun } from "./run-fleet-status";
import type { CampaignFile } from "../runner/src/campaign-file";
import { runPodsOf, type FleetGoUsage, type SlotBook, type CredentialGate, type WorldsSetting } from "./run-fleet-credentials";
import type { Credential } from "../runner/src/credential-slots";
import type { ModelsSidecar } from "../runner/src/models";
import type { RunFact, UnstampedRun } from "../runner/src/run-fact";
import type { ModelListsSidecar } from "../runner/src/model-lists";

/** The supervisor's memory the tick reads and writes; `main()` owns it. */
export interface TickMemory {
  /** The supervisor's processes: the run ids each was materialized with, and whether it has exited. */
  procs: ReadonlyMap<string, { exited: boolean; runIds: readonly string[] }>;
  assigned: Map<string, string>;
  liveJobs: Map<string, FleetJob>;
  sets: JobSets;
  /** The `repeat` each finished job was spawned with: raising it above that rearms the job (`planTick`). */
  finishedRepeat: Map<string, FleetJob["repeat"]>;
  pending: Map<string, FleetJob>;
  placedMemo: Map<string, NonNullable<FleetJob["placed"]>>;
  drainReasons: Map<string, string>;
  announcedPicks: Set<string>;
  complainedSkips: Map<string, string>;
  announcedDone: Set<string>;
  /** Paused runs ended instead of resumed, this session; for the state file. */
  endedRuns: EndedRun[];
  /** The pinned-campaign jobs the newest tick generated (`spawnJob` reads them). */
  campaignJobs: FleetJob[];
  lastPlan: QueuePlan;
  lastPaused: PausedListing[];
  pinnedDone: FleetJob[];
  policyIdle: string | undefined;
  lastCredentials: { gate: CredentialGate; book: SlotBook; credentials: readonly Credential[]; runs: readonly Pick<RunFact, "credential" | "pause">[] } | undefined;
}

/** What the tick reads and does outside its memory; `main()` hands it the real ones. */
export interface TickIO {
  evals: boolean;
  stamp: string;
  runsDir: string;
  onCluster: boolean;
  now: () => number;
  scoredWait: string | null;
  pauseSwitch: () => unknown;
  maxRunPods: () => number | undefined;
  worldsSetting: (mode: string) => WorldsSetting | undefined;
  readFacts: () => { facts: RunFact[]; unstamped: UnstampedRun[] };
  readModelsSidecar: () => ModelsSidecar;
  readModelLists: () => ModelListsSidecar;
  goUsage: Pick<FleetGoUsage, "noteOverages" | "observations" | "readHolds">;
  /** Every account's holder (`accountHoldersIn`). */
  holders: () => Map<string, string>;
  jobCooling: (job: FleetJob) => string | undefined;
  runCampaignFile: (dir: string) => CampaignFile | null;
  writeCampaignFile: (dir: string, file: CampaignFile) => void;
  hasImageRecord: (runId: string) => boolean;
  repairRecordedTerminations: (runsDir: string, runs: readonly RunFact[]) => { runId: string; error?: string }[];
  endRuns: (runsDir: string, ended: readonly EndedRun[]) => { runId: string; error?: string }[];
  releaseEndedSessions: (ended: readonly EndedRun[], say: (s: string) => void) => Promise<void>;
  sweepNames: (sweeps: readonly NameSweep[], say: (s: string) => void) => Promise<void>;
  say: (line: string) => void;
  record: (entry: { job: string; event: string; detail?: string }) => void;
}

/** What the supervisor's memory says of its own jobs, as the planner reads it. */
export function supervisorOf(mem: TickMemory): SupervisorView {
  return {
    ownRunIds: new Set([...mem.procs.values()].filter((p) => !p.exited).flatMap((p) => p.runIds)),
    running: mem.sets.running,
    finished: mem.sets.finished,
    finishedRepeat: mem.finishedRepeat,
    assigned: mem.assigned,
    liveJobs: mem.liveJobs,
    pending: new Set(mem.pending.keys()),
    placedMemo: mem.placedMemo,
  };
}

/** Everything this tick reads, read once (`TickSnapshot`). */
export function tickSnapshot(mem: TickMemory, io: TickIO, read: FleetConfig): TickSnapshot {
  const now = io.now();
  const onDisk = io.readFacts();
  // Go's readings note the overages the runs recorded before they are read.
  io.goUsage.noteOverages([...onDisk.facts, ...onDisk.unstamped]);
  // The reads only a run without a verdict can need: a resume's campaign file and image record.
  const open = onDisk.facts.filter((f) => f.terminationReason === null);
  return {
    config: read,
    evals: io.evals,
    stamp: io.stamp,
    now,
    scoredWait: io.scoredWait,
    paused: io.pauseSwitch() !== undefined,
    facts: onDisk.facts,
    unstamped: onDisk.unstamped,
    modelsSidecar: io.readModelsSidecar(),
    modelLists: io.readModelLists(),
    usage: io.goUsage.observations(),
    readHolds: io.goUsage.readHolds(read.credentials),
    runPods: runPodsOf(read.policy.runPods, io.onCluster, io.maxRunPods()),
    worlds: io.worldsSetting(read.policy.worlds),
    holders: io.holders(),
    cooling: new Map(poolJobs(read).flatMap((j) => ((why) => (why !== undefined ? [[j.name, why] as const] : []))(io.jobCooling(j)))),
    campaignFiles: new Map(open.map((f) => [f.runId, io.runCampaignFile(join(io.runsDir, f.runId))])),
    imageRecords: new Set(open.filter((f) => io.hasImageRecord(f.runId)).map((f) => f.runId)),
    supervisor: supervisorOf(mem),
  };
}

/**
 * The spawns the supervisor acts on this tick: gather, plan, and apply. The
 * writes a plan asks for (repairs, ends, campaign files) are made first; when
 * one fails the same snapshot is planned again without it, as the tick has
 * always gone on without a write it could not make. Then the lines are said
 * in the plan's order and the memory takes the plan's.
 */
export function effectiveJobs(mem: TickMemory, io: TickIO, read: FleetConfig): JobSpawn[] {
  const snap = tickSnapshot(mem, io, read);
  let plan = planTick(snap);
  const repaired = plan.repairs.length > 0 ? io.repairRecordedTerminations(io.runsDir, plan.repairs) : [];
  const ended = plan.ends.length > 0 ? io.endRuns(io.runsDir, plan.ends) : [];
  const fileErrors = new Map<string, string>();
  for (const step of plan.steps) {
    if (step.kind !== "campaign-file") continue;
    try {
      io.writeCampaignFile(join(io.runsDir, step.runId), step.file);
    } catch (e) {
      fileErrors.set(step.runId, e instanceof Error ? e.message : String(e));
    }
  }
  const endFailures = new Set(ended.filter((r) => r.error !== undefined).map((r) => r.runId));
  if (endFailures.size > 0 || fileErrors.size > 0) plan = planTick({ ...snap, failed: { ends: endFailures, campaignFiles: new Set(fileErrors.keys()) } });
  applyTick(mem, io, plan, { repaired, ended, fileErrors });
  return plan.spawns;
}

/** Say the plan's lines in order, once each where the supervisor dedupes them, and take its memory. */
export function applyTick(
  mem: TickMemory,
  io: TickIO,
  plan: TickPlan,
  done: { repaired: readonly { runId: string; error?: string }[]; ended: readonly { runId: string; error?: string }[]; fileErrors: ReadonlyMap<string, string> },
): void {
  const { say, record } = io;
  const once = (key: string): boolean => {
    if (mem.announcedPicks.has(key)) return false;
    mem.announcedPicks.add(key);
    return true;
  };
  for (const step of plan.steps) {
    switch (step.kind) {
      case "say":
        if (step.key !== undefined && !once(step.key)) break;
        say(step.line);
        if (step.record !== undefined) record(step.record);
        break;
      case "repair":
        for (const r of done.repaired) {
          say(r.error === undefined ? `repaired ${r.runId}: the termination its trajectory records is in the run row now` : `repair ${r.runId}: could not write the recorded termination — ${r.error}`);
        }
        break;
      case "end":
        for (const r of done.ended) {
          const e = plan.ends.find((x) => x.runId === r.runId)!;
          if (r.error !== undefined) {
            say(`end ${e.runId}: could not write the termination — ${r.error}`);
            record({ job: `${e.ref ?? e.model}-${e.episode}`, event: "end-failed", detail: `${e.detail}; ${r.error}` });
            continue;
          }
          mem.endedRuns.push(e);
          const line = formatEndedRun(e);
          say(`end ${e.runId}: ${line}`);
          record({ job: `${e.ref ?? e.model}-${e.episode}`, event: "ended", detail: line });
        }
        if (plan.ends.length > 0) void io.releaseEndedSessions(plan.ends, say);
        break;
      case "campaign-file": {
        const error = done.fileErrors.get(step.runId);
        say(
          error === undefined
            ? `resume ${step.name}: wrote ${step.runId}/campaign.json from the published ${step.file.campaign}@${step.file.version} (the run predates campaign files)`
            : `resume ${step.name}: could not write ${step.runId}/campaign.json — ${error}; not resuming it this tick`,
        );
        break;
      }
      case "idle":
        if (step.idle !== mem.policyIdle) {
          if (step.idle !== undefined) say(`policy: ${step.idle}`);
          mem.policyIdle = step.idle;
        }
        break;
      case "sweep":
        void io.sweepNames(plan.sweeps, say);
        break;
      case "skip":
        if (mem.complainedSkips.get(step.name) !== step.reason) {
          mem.complainedSkips.set(step.name, step.reason);
          say(`queue ${step.name}: skipped — ${step.reason}`);
          record({ job: step.name, event: "queue-skipped", detail: step.reason });
        }
        break;
      case "done":
        if (mem.announcedDone.has(step.job.name)) break;
        mem.announcedDone.add(step.job.name);
        say(`queue ${step.job.name}: done — ${step.job.ref} ${step.job.episode} ${step.progress}; nothing spawns (raise repeat for more)`);
        record({ job: step.job.name, event: "queue-done", detail: step.progress });
        break;
    }
  }
  for (const j of plan.config.jobs) if (!plan.queue.skipped.some((sk) => sk.job.name === j.name)) mem.complainedSkips.delete(j.name);
  const doneNames = new Set([...plan.pinnedDone, ...plan.queue.done].map((j) => j.name));
  for (const n of [...mem.announcedDone]) if (!doneNames.has(n)) mem.announcedDone.delete(n);
  // The memory: what this tick handed out, where it placed it, why it drains.
  for (const [name, job] of plan.memory.pending) mem.pending.set(name, job);
  for (const name of plan.memory.unfinished) mem.sets.finished.delete(name);
  mem.placedMemo.clear();
  for (const [name, placed] of plan.memory.placedMemo) mem.placedMemo.set(name, placed);
  mem.drainReasons.clear();
  for (const [name, why] of plan.drainReasons) mem.drainReasons.set(name, why);
  mem.campaignJobs = plan.campaignJobs;
  mem.lastPlan = plan.queue;
  mem.lastPaused = plan.resumes.listed;
  mem.pinnedDone = plan.pinnedDone;
  mem.lastCredentials = plan.credentials;
}
