/**
 * The supervisor's tick: what it spawns, drains, ends and announces, given its
 * memory and the reads it makes (`effectiveJobs`). Lifted out of `main()` in
 * run-fleet.ts as it was, so it can be driven over fixture states; `main()`
 * hands it the supervisor's own memory and I/O.
 */

import { join } from "node:path";
import { eligibleFrom, healthyFrom, type FleetConfig, type FleetJob, type JobSpawn, pinnedCampaignJobs, probeRunsOf, pinnedJobs, policyRefs, poolJobs, rosterModels, scheduledAccounts, unpinnedCampaigns, withoutEvals } from "./run-fleet-config";
import {
  affinityFrom,
  affinityOf,
  applyEnded,
  characterAffinity,
  characterKey,
  charactersFrom,
  characterStanding,
  countedFrom,
  countJob,
  countOutsideRuns,
  countUnownedRuns,
  describeStanding,
  type EndedRun,
  episodeSessions,
  evalPoolDraw,
  evalPoolTaken,
  implicitPauses,
  isExtraJob,
  type JobSets,
  jobSpawn,
  keepFor,
  type NameSweep,
  type Occupant,
  outsideRuns,
  owedCopies,
  owesNothing,
  type PausedListing,
  pausesOnDrain,
  placeJob,
  planContinuations,
  planNameSweeps,
  planPolicy,
  planQueue,
  planResumes,
  planStaleRuns,
  policyJobDropped,
  progressLabel,
  type QueuePlan,
  type QueueSkip,
  type ResumePlan,
  runnableRefs,
  scoredHold,
  taskDraw,
  unownedLiveRuns,
  unyieldedDrainReason,
  withResumesPlaying,
  withTakenRunIds,
} from "./run-fleet-plan";
import { formatEndedRun } from "./run-fleet-status";
import { worldUsedBy } from "./world";
import type { CampaignFile } from "../runner/src/campaign-file";
import { credentialGate, gateSpawns, placeRef, resumeHoldOf, runPodsOf, SlotBook, type CredentialGate, type FleetGoUsage, type WorldsSetting } from "./run-fleet-credentials";
import type { Credential } from "../runner/src/credential-slots";
import { ineligibleWhy, liveCredentials, modelStates, type RunFact, type UnstampedRun } from "../runner/src/models";

/** The supervisor's memory the tick reads and writes; `main()` owns it. */
export interface TickMemory {
  /** The supervisor's processes: the run ids each was materialized with, and whether it has exited. */
  procs: ReadonlyMap<string, { exited: boolean; runIds: readonly string[] }>;
  assigned: Map<string, string>;
  liveJobs: Map<string, FleetJob>;
  sets: JobSets;
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
  goUsage: Pick<FleetGoUsage, "noteOverages" | "observations" | "readHolds">;
  held: (account: string) => string | undefined;
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

/**
 * The spawns the supervisor acts on this tick, every one of them a job: the
 * pinned jobs on their accounts; every pool job already running (on the
 * account it was given; `enabled` follows the file so a job flipped off or
 * deleted drains); the manual jobs the queue just handed a free account;
 * and the policy's picks for what is left. Jobs with nothing free wait.
 */
export function effectiveJobs(mem: TickMemory, io: TickIO, read: FleetConfig): JobSpawn[] {
  const { assigned, liveJobs, sets, pending, placedMemo, drainReasons, announcedPicks, complainedSkips, announcedDone, endedRuns } = mem;
  // With the evals group off, every campaign and scored or probing job reads
  // as disabled, and the policy below picks none (`withoutEvals`).
  const cfg = io.evals ? read : withoutEvals(read);
  const out: JobSpawn[] = [];
  // Rebuilt, not appended to: this runs twice a tick, and a reason must
  // describe the projection the drain is acting on.
  drainReasons.clear();
  // The run facts once a tick, shared by the projection and the resume
  // planner. Eligibility for the queue's gate and the policy's picks read
  // the same answer; resumes read the same facts. A verdict-less run on a
  // resuming lane reads as paused `offline` from here on — unless one of
  // this supervisor's own processes is playing it, or a live job holds its
  // account (the same guards the stale sweep applies, for the same reason).
  const ownRunIds = new Set([...mem.procs.values()].filter((p) => !p.exited).flatMap((p) => p.runIds));
  const ownAccounts = new Set(
    [...assigned.values(), ...pinnedJobs(cfg).filter((j) => sets.running.has(j.name)).map((j) => j.account!)].map((a) => a.toUpperCase()),
  );
  const onDisk = io.readFacts();
  const runs = implicitPauses({
    runs: onDisk.facts,
    campaigns: cfg.campaigns,
    running: ownRunIds,
    busyAccounts: ownAccounts,
    now: io.now(),
  });
  // Both are re-derived below if this tick's sweep ends anything: a failed
  // attempt written halfway down a tick has to be in the projection the queue and
  // the policy read at the bottom of it.
  let states = modelStates({ runsDir: io.runsDir, roster: rosterModels(cfg.roster), policy: cfg.policy, runs });
  let eligible = eligibleFrom(states);
  // The credentials over the same facts: each one's budget (its newest usage
  // reading, its runs and spend today) and every live session on its slots
  // and its driver's host cap, asked at every launch below
  // (`run-fleet-credentials.ts`). Every run on a credential costs it,
  // whether or not it carries an episode: a hand launch's are read too.
  const billed = [...runs, ...onDisk.unstamped];
  io.goUsage.noteOverages(billed);
  const credGate = credentialGate(
    cfg.credentials,
    [...billed.map((f) => f.credentialUsage), ...io.goUsage.observations()],
    billed,
    io.now(),
    io.goUsage.readHolds(cfg.credentials),
  );
  const book = new SlotBook(
    cfg.credentials,
    cfg.policy.maxSessions,
    runPodsOf(cfg.policy.runPods, io.onCluster, io.maxRunPods()),
    io.worldsSetting(cfg.policy.worlds),
  );
  mem.lastCredentials = { gate: credGate, book, credentials: cfg.credentials, runs: billed };
  const byName = new Map(cfg.jobs.map((j) => [j.name, j]));
  const runningRefs = new Set<string>();
  const pinnedSkips: QueueSkip[] = [];
  /**
   * The credential each roster entry's live-or-paused run is on, read back
   * off the runs. This is what makes the per-credential count survive a
   * supervisor restart: the job objects that remember where they were placed
   * die with the process, the runs do not.
   */
  const runCreds = liveCredentials(runs, rosterModels(cfg.roster));
  /** A job with where it was placed: what it carries, else what this supervisor placed it on (`placedMemo`). */
  const withPlaced = (job: FleetJob): FleetJob => {
    const placed = job.placed ?? placedMemo.get(job.name);
    return placed !== undefined ? { ...job, placed } : job;
  };
  const placing = { credentials: cfg.credentials, book, gate: credGate };
  /** Place a job that holds no session yet and commit its slots, or say why it may not start. */
  const placeFresh = (job: FleetJob): { ok: true; job: FleetJob } | { ok: false; why: string } => {
    const r = placeJob(job, cfg.roster, placing);
    if (!r.ok) return r;
    book.add(r.keys);
    if (r.job.placed !== undefined) placedMemo.set(job.name, r.job.placed);
    return { ok: true, job: r.job };
  };
  for (const n of [...placedMemo.keys()]) if (!sets.running.has(n) && !pending.has(n)) placedMemo.delete(n);
  // Pinned jobs: from the file, on their own accounts — plus a pinned
  // campaign's next cell, which is a pinned job in everything but where it
  // was written down.
  const probes = probeRunsOf(runs);
  // Every run id on disk, archive included: a job's remainder never reuses
  // one, and a campaign square's fresh attempt numbers past them.
  const takenRunIds = new Set(runs.map((f) => f.runId));
  // A party that draws its accounts takes this attempt's from the eval pool:
  // none a run without a verdict or a running job holds (`evalPoolDraw`).
  const drawHeld: { job: FleetJob; why: string }[] = [];
  const draw = evalPoolDraw({
    mode: cfg.policy.worlds,
    pool: cfg.accounts.evalPool ?? [],
    taken: evalPoolTaken(runs, [...assigned.values(), ...[...liveJobs.values()].flatMap((j) => j.accounts ?? (j.account !== undefined ? [j.account] : []))]),
    held: (a) => io.held(a),
    running: (name) => (sets.running.has(name) ? liveJobs.get(name)?.accounts : undefined),
  });
  mem.campaignJobs = withTakenRunIds(pinnedCampaignJobs(cfg, probes, healthyFrom(states), draw, drawHeld), takenRunIds);
  for (const h of drawHeld) pinnedSkips.push({ job: h.job, reason: h.why });
  // Every session already held goes on the book first — a live job of this
  // supervisor's, pinned, pooled, drained or no longer in the file — so a
  // fresh placement below never takes a slot a live run is on (the
  // 2026-08-24 spill: a draining campaign cell no loop yielded).
  for (const name of sets.running) {
    const job = liveJobs.get(name) ?? [...pinnedJobs(cfg), ...mem.campaignJobs].find((j) => j.name === name);
    if (job === undefined) continue;
    countJob(book, withPlaced(job), cfg.roster, runCreds);
  }
  // And every live run this fleet did not launch, on the credential it
  // bills: a hand launch takes a slot as surely as a job does.
  countOutsideRuns(book, outsideRuns(billed, { running: ownRunIds, busyAccounts: ownAccounts }));
  // And every live fleet run no job of this supervisor owns — a run pod
  // still playing after its roster died with this container — on its
  // credential and the run-pod cap (`countUnownedRuns`). It holds its
  // account and its model below, too.
  const unowned = unownedLiveRuns({ runs, roster: cfg.roster, campaigns: cfg.campaigns, running: ownRunIds, busyAccounts: ownAccounts });
  countUnownedRuns(book, unowned);
  const held = (a: string): string | undefined => io.held(a);
  // Resumes before anything fresh: a paused run goes back onto
  // its own account ahead of the queue and the policy, so nothing can wipe
  // its character first. A pinned job's spawn is replaced by its resume
  // spawn; a pool job's resume reserves its account like an assignment.
  const runningMap = new Map<string, string>(assigned);
  for (const job of pinnedJobs(cfg)) if (sets.running.has(job.name)) runningMap.set(job.name, job.account!);
  const resumes = planResumes({
    runs,
    config: cfg,
    running: runningMap,
    held,
    now: io.now(),
    campaignFileOf: (id) => io.runCampaignFile(join(io.runsDir, id)),
    hasImageRecord: (id) => io.hasImageRecord(id),
    credentialHold: (f) => resumeHoldOf(f, cfg, credGate),
    // What each live process plays, before its run reads live.
    inFlight: [...sets.running].flatMap((name) => {
      const job = liveJobs.get(name) ?? [...pinnedJobs(cfg), ...mem.campaignJobs].find((j) => j.name === name);
      return job === undefined ? [] : [{ name, refs: job.refs, episode: job.episode }];
    }),
  });
  mem.lastPaused = resumes.listed;
  const resumingNames = new Set(resumes.resume.filter((r) => !sets.running.has(r.job.name)).map((r) => r.job.name));
  mem.pinnedDone = [];
  for (const job of [...pinnedJobs(cfg), ...mem.campaignJobs]) {
    if (job.enabled && runnableRefs(job, cfg.roster, eligible).length === 0) {
      // A pinned job whose ref is not promoted into its tier: it waits,
      // with the reason said once, exactly like a gated queue job.
      pinnedSkips.push({ job, reason: `${job.ref} is not eligible for ${job.episode} (${ineligibleWhy(job.episode)})` });
      out.push({ name: job.name, enabled: false, account: job.account!, loop: false, entries: [{ model: "gated" }] });
      continue;
    }
    // While scored episodes are held (`SCORED_EPISODES_WAIT`), held as the
    // policy's own picks are: never spawned for the launch to refuse (`scoredHold`).
    const hold = job.enabled && !sets.running.has(job.name) ? scoredHold(job, io.scoredWait ?? undefined) : undefined;
    if (hold !== undefined) {
      pinnedSkips.push({ job, reason: hold });
      out.push({ name: job.name, enabled: false, account: job.account!, loop: false, entries: [{ model: "gated" }] });
      continue;
    }
    // A pinned job's `repeat` is met off the runs on disk, the queue's rule
    // (`owedCopies`): one that owes nothing yields no spawn, so a supervisor
    // boot cannot start it again. Only a job that is not running is asked —
    // a live roster keeps its spawn and is never drained for finishing.
    const owed = job.enabled && !sets.running.has(job.name) ? owedCopies(job, runnableRefs(job, cfg.roster, eligible), countedFrom(states)) : undefined;
    if (owesNothing(owed)) {
      mem.pinnedDone.push(job);
      continue;
    }
    const owing = owed === undefined ? job : { ...job, owed: { copies: owed, taken: takenRunIds } };
    if (sets.running.has(job.name) || !job.enabled) {
      // Live (counted above), or disabled and so a drain or a park.
      out.push(jobSpawn(withPlaced(owing), cfg.roster, job.account!, io.stamp, eligible, cfg.campaigns, cfg.campaignDefs));
      if (sets.running.has(job.name)) for (const r of job.refs) runningRefs.add(r);
      continue;
    }
    // A pinned job about to resume a paused run is placed with the resume,
    // on the credential that run is on.
    if (resumingNames.has(job.name)) {
      out.push({ ...jobSpawn(owing, cfg.roster, job.account!, io.stamp, eligible, cfg.campaigns, cfg.campaignDefs), enabled: false });
      for (const r of job.refs) runningRefs.add(r);
      continue;
    }
    // A slot on a credential with room, and a session under the driver's
    // host cap, or it waits with the reason said — a party for all of its
    // members at once. It spends no slot it will not use.
    const placed = placeFresh(owing);
    if (!placed.ok) {
      pinnedSkips.push({ job, reason: placed.why });
      out.push({ ...jobSpawn(owing, cfg.roster, job.account!, io.stamp, eligible, cfg.campaigns, cfg.campaignDefs), enabled: false });
      continue;
    }
    out.push(jobSpawn(placed.job, cfg.roster, job.account!, io.stamp, eligible, cfg.campaigns, cfg.campaignDefs));
    for (const r of job.refs) runningRefs.add(r);
  }
  // Pool jobs with a live process: keep running whatever the file now says,
  // drain if the file dropped them or their refs. Their sessions are on the
  // book already.
  for (const [name, account] of assigned) {
    const running = liveJobs.get(name);
    const fromFile = byName.get(name);
    if (running?.source === "policy") {
      const dropped = policyJobDropped(running, cfg.roster[running.ref]);
      if (dropped !== undefined) {
        // A disabled stand-in makes diffJobs drain it, and for a freeplay
        // character a drain is an immediate SIGTERM (`pausesOnDrain`): the run
        // pauses as `operator-pause` and `planResumes` leaves it listed while
        // the ref stays out of the unlimited lane, so nothing respawns it.
        // A session under SIGTERM still holds its slot until the process
        // exits (runner backstop 60s, roster SIGKILL grace 90s), which is
        // why it was counted above with the rest.
        drainReasons.set(name, dropped);
        out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
        runningRefs.add(running.ref);
      } else {
        out.push(jobSpawn(withPlaced(running), cfg.roster, account, io.stamp, undefined, cfg.campaigns, cfg.campaignDefs));
        runningRefs.add(running.ref);
      }
      continue;
    }
    if (fromFile === undefined || fromFile.account !== undefined || runnableRefs(fromFile, cfg.roster, eligible).length === 0) {
      // Removed from the queue (or pinned now, or its ref vanished): a
      // disabled stand-in makes diffJobs drain it. The process keeps its roster.
      out.push({ name, enabled: false, account, loop: false, entries: [{ model: "gone" }] });
      continue;
    }
    out.push(jobSpawn(withPlaced(running ?? fromFile), cfg.roster, account, io.stamp, eligible, cfg.campaigns, cfg.campaignDefs));
    for (const r of fromFile.refs) runningRefs.add(r);
  }
  // Live processes the file no longer YIELDS — a completed campaign cell
  // draining to its episode boundary, a job whose config entry vanished —
  // hold their model, and the drain line says why. Their sessions were
  // counted with every live one above.
  {
    const yielded = new Set([...pinnedJobs(cfg), ...mem.campaignJobs].map((j) => j.name));
    for (const name of sets.running) {
      if (yielded.has(name) || assigned.has(name)) continue;
      const job = liveJobs.get(name);
      if (job === undefined) continue;
      // Words only: what the drain line says about a job nothing yields.
      drainReasons.set(name, unyieldedDrainReason(job, cfg.campaigns, Object.keys(cfg.roster), probes));
      for (const r of job.refs) runningRefs.add(r);
    }
  }
  // A live fleet run none of this supervisor's jobs is playing — the two
  // minutes a killed runner's heartbeat stays warm after a pod recreate, a
  // runner still unwinding under an exited roster, or a run pod playing on
  // after this container restarted — holds its model as well as its account
  // (`held`), or the policy plans that model a second session on another
  // free account while its character is mid-run on the first. It is on its
  // credential and the run-pod cap (counted above), never on a driver's
  // host cap. Once it reads cold it lets go, and `implicitPauses` has made
  // it an `offline` pause on a lane that resumes.
  for (const u of unowned) {
    const refs = u.refs.filter((r) => !runningRefs.has(r));
    if (refs.length === 0) continue;
    for (const r of refs) runningRefs.add(r);
    const key = `unowned:${u.runId}`;
    if (!announcedPicks.has(key)) {
      announcedPicks.add(key);
      io.say(`hold ${refs.join("+")}: ${u.runId} is live on ${u.account} and no job of this supervisor owns it — nothing new is planned for it until the run stops or reads cold`);
    }
  }

  // A verdict the runner recorded but could not write into the row: the
  // facts already read it from the trajectory, and the row is told now.
  for (const r of io.repairRecordedTerminations(io.runsDir, runs)) {
    io.say(r.error === undefined ? `repaired ${r.runId}: the termination its trajectory records is in the run row now` : `repair ${r.runId}: could not write the recorded termination — ${r.error}`);
  }
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
      now: io.now(),
    }),
  ];
  // A lapsed run is ended through the runner's own writer, once, and leaves
  // the paused set. Its session goes back with it, so the fresh attempt this
  // record promises does not land on an account that is still held.
  const applied: EndedRun[] = [];
  for (const r of io.endRuns(io.runsDir, lapsed)) {
    const e = lapsed.find((x) => x.runId === r.runId)!;
    if (r.error !== undefined) {
      io.say(`end ${e.runId}: could not write the termination — ${r.error}`);
      io.record({ job: `${e.ref ?? e.model}-${e.episode}`, event: "end-failed", detail: `${e.detail}; ${r.error}` });
      continue;
    }
    endedRuns.push(e);
    applied.push(e);
    const line = formatEndedRun(e);
    io.say(`end ${e.runId}: ${line}`);
    io.record({ job: `${e.ref ?? e.model}-${e.episode}`, event: "ended", detail: line });
  }
  if (lapsed.length > 0) void io.releaseEndedSessions(lapsed, io.say);
  if (applied.length > 0) {
    // The queue's gate, the policy's picks and the state file all read the
    // post-sweep projection from here down, so a run this sweep ended is
    // already a cooling rung when the policy picks.
    states = modelStates({ runsDir: io.runsDir, roster: rosterModels(cfg.roster), policy: cfg.policy, runs: applyEnded(runs, applied, io.now()), now: io.now() });
    eligible = eligibleFrom(states);
  }
  const reserved = new Map<string, string>();
  /** The resumes spawned this tick: what holds their models below. */
  const resumedNow: ResumePlan[] = [];
  for (const r of resumes.resume) {
    const name = r.job.name;
    if (sets.running.has(name)) continue;
    // A probe paused before campaign files existed comes back with one
    // rebuilt from its published definition (`pausedProbeFile`); it goes
    // beside the run before the spawn, so the run carries it from here on.
    // Never over a file the run already has.
    if (r.writeCampaignFile !== undefined && io.runCampaignFile(join(io.runsDir, r.runId)) === null) {
      try {
        io.writeCampaignFile(join(io.runsDir, r.runId), r.writeCampaignFile);
        io.say(`resume ${name}: wrote ${r.runId}/campaign.json from the published ${r.writeCampaignFile.campaign}@${r.writeCampaignFile.version} (the run predates campaign files)`);
      } catch (e) {
        io.say(`resume ${name}: could not write ${r.runId}/campaign.json — ${e instanceof Error ? e.message : String(e)}; not resuming it this tick`);
        continue;
      }
    }
    // A resumed run goes back to the credential it started on: the runner
    // rebuilds its config from meta.json, and the credential is in it. It
    // needs a slot there, like a fresh start, and a paused party needs one
    // per member, whole; with none the resume waits for a tick with room.
    // Stamped on the spawn too so the count and the state file agree with
    // the run.
    const recorded = runs.find((f) => f.runId === r.runId)?.credential ?? null;
    const placedResume = placeFresh(recorded !== null ? { ...r.job, credential: recorded } : r.job);
    if (!placedResume.ok) {
      const key = `resume-held:${r.runId}:${placedResume.why}`;
      if (!announcedPicks.has(key)) {
        announcedPicks.add(key);
        io.say(`resume ${name}: held — ${placedResume.why}`);
      }
      continue;
    }
    const resumed = placedResume.job;
    resumedNow.push(r);
    const spawn = jobSpawn(resumed, cfg.roster, r.account, io.stamp, undefined, cfg.campaigns, cfg.campaignDefs);
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
      for (const ref of r.job.refs) runningRefs.add(ref);
    }
    // Once per pause, named by its instant: the streak starts over at 1
    // after every segment that made a turn, so it cannot tell two pauses of
    // one run apart. Not while the pause switch holds: nothing is spawned
    // then, and the line is said on the tick the switch clears.
    const key = `resume:${r.runId}:${runs.find((f) => f.runId === r.runId)?.pause?.at ?? r.pauseCount}`;
    if (io.pauseSwitch() === undefined && !announcedPicks.has(key)) {
      announcedPicks.add(key);
      io.say(`resume ${name}: ${r.runId} on ${r.account} — ${r.why}`);
      io.record({ job: name, event: "resume", detail: `${r.runId} on ${r.account}: ${r.why}` });
    }
  }
  // A character resuming this tick holds its model's scored episodes under
  // every entry, as one playing does (`withResumesPlaying`).
  states = withResumesPlaying(states, resumedNow, cfg.roster);
  const runningAndReserved = new Map([...assigned, ...reserved]);
  // Who holds each account this tick, for the character rule (`characterStanding`):
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
  // Where each unlimited ref's freeplay character stands; a freeplay pick
  // goes back to that account, every fresh launch keeps those characters.
  const characters = charactersFrom(runs, cfg.roster);
  const affinity = characterAffinity(characters, affinityOf(affinityMap));
  mem.lastPlan = planQueue({
    queue: poolJobs(cfg),
    roster: cfg.roster,
    pool: cfg.accounts.pool,
    maxLive: cfg.accounts.max,
    running: runningAndReserved,
    finished: sets.finished,
    held,
    cooling: (job) => io.jobCooling(job),
    // A slot on a credential with room, committed as the queue assigns.
    place: placeFresh,
    eligible,
    runningRefs,
    affinity,
    counted: countedFrom(states),
    takenRunIds,
    ...(io.scoredWait !== null ? { scoredGate: io.scoredWait } : {}),
  });
  mem.lastPlan.skipped.unshift(...pinnedSkips);
  // Every fresh launch this tick, for the cross-account name sweep below.
  const freshAssign: { ref: string; account: string }[] = [];
  for (const a of mem.lastPlan.assign) {
    const { account } = a;
    // The credential was settled by the plan (`place`), and is on the book.
    const keep = keepFor(account, characters);
    if (keep.length > 0) a.job = { ...a.job, keepCharacters: keep };
    pending.set(a.job.name, a.job);
    // A launch onto a world of its own meets no name of the shared world's.
    if (!worldUsedBy(cfg.policy.worlds, a.job.episode)) for (const r of a.job.refs) freshAssign.push({ ref: r, account });
    out.push(jobSpawn(a.job, cfg.roster, account, io.stamp, eligible, cfg.campaigns, cfg.campaignDefs));
  }
  // The policy fills what the queue left free. A gated spawn is not a
  // problem: the pick is re-made next tick from the same projection.
  if (scheduledAccounts(cfg).length > 0) {
    const allowed = policyRefs(cfg);
    const continued = planContinuations(
      planPolicy({
      states: states.filter((st) => allowed.has(st.name)),
      pool: cfg.accounts.pool,
      maxLive: cfg.accounts.max,
      running: runningAndReserved,
      held,
      queuePlan: mem.lastPlan,
      runningRefs,
      place: (n, ep) => {
        const r = placeRef(cfg.roster[n], ep, { ...placing, pin: cfg.roster[n]?.credential, sessions: episodeSessions(ep) });
        return r.ok ? { ok: true, credential: r.placement.credential, keys: r.placement.keys } : r;
      },
      take: (keys) => book.add(keys),
      policy: cfg.policy,
      drawTask: taskDraw(draw)!,
      campaigns: unpinnedCampaigns(cfg),
      probeRuns: probes,
      affinity,
      evals: io.evals,
      // While scored episodes are held: held with the reason rather than picked for a launch run.ts refuses.
      ...(io.scoredWait !== null ? { scoredGate: io.scoredWait } : {}),
      }),
      characters,
      cfg.roster,
      occupants,
    );
    const picks = continued.picks;
    for (const w of continued.waiting) {
      const key = `${w.name}:character:${w.head.runId}:${w.why}`;
      if (!announcedPicks.has(key)) {
        announcedPicks.add(key);
        io.say(`policy ${w.name}: waiting — ${w.why}; not starting fresh on ${w.offered}`);
        io.record({ job: w.name, event: "character-waiting", detail: `${w.why}; offered ${w.offered}` });
      }
    }
    for (const d of continued.dropped) {
      const key = `${d.name}:character-dropped:${d.head.runId}`;
      if (!announcedPicks.has(key)) {
        announcedPicks.add(key);
        io.say(`policy ${d.name}: ${d.head.account} is occupied by ${d.occupant}'s character — starting fresh on ${d.account}, lineage ${d.head.runId} (${d.head.character}) dropped`);
        io.record({ job: d.name, event: "character-dropped", detail: `${d.head.runId} (${d.head.character} on ${d.head.account}) account_occupied_by ${d.occupant}; fresh on ${d.account}` });
      }
    }
    // A character whose head is on another ref's account and that got NO pick
    // this tick (no free account, the cap, the gate) says so once, so the
    // wait reads as a wait for a free account and not as the item-94 hold.
    for (const [ref, st] of characters) {
      if (!allowed.has(ref) || runningRefs.has(ref)) continue;
      if (picks.some((p) => p.job.ref === ref) || continued.waiting.some((w) => w.name === `${ref}-freeplay`)) continue;
      const standing = characterStanding(ref, st, occupants);
      if (standing.kind !== "occupied") continue;
      const key = `${ref}:character-blocked:${st.runId}:${standing.occupant}`;
      if (!announcedPicks.has(key)) {
        announcedPicks.add(key);
        io.say(`policy ${ref}: ${describeStanding(st, standing)} — none free this tick`);
      }
    }
    for (const { job, account, why } of picks) {
      // Remember the credential the pick was placed on: the run does not
      // exist on disk yet, and the next tick must count it there.
      if (job.placed !== undefined) placedMemo.set(job.name, job.placed);
      pending.set(job.name, job);
      // A policy job that finished an earlier attempt is fair game again;
      // the projection, not the finished set, decides whether it runs.
      sets.finished.delete(job.name);
      const key = `${job.name}:${job.attempt}`;
      // As with a resume: a pick is announced when it can spawn, not while the switch holds.
      if (io.pauseSwitch() === undefined && !announcedPicks.has(key)) {
        announcedPicks.add(key);
        const tag = (isExtraJob(job) ? " (extra)" : "") + (job.continueFrom !== undefined ? ` (continues ${job.continueFrom})` : "");
        io.say(`policy ${job.name}: ${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account} — ${why}`);
        io.record({ job: job.name, event: "policy-pick", detail: `${job.ref} ${job.episode} attempt ${job.attempt}${tag} on ${account}: ${why}` });
      }
      if (!worldUsedBy(cfg.policy.worlds, job.episode)) for (const r of job.refs) freshAssign.push({ ref: r, account });
      out.push(jobSpawn(job, cfg.roster, account, io.stamp, undefined, cfg.campaigns, cfg.campaignDefs));
    }
    const taken = new Set([...runningAndReserved.values(), ...mem.lastPlan.assign.map((a) => a.account), ...picks.map((p) => p.account)].map((a) => a.toUpperCase()));
    const free = scheduledAccounts(cfg).filter((a) => !taken.has(a.toUpperCase()) && held(a) === undefined);
    const idle =
      free.length === 0
        ? undefined
        : mem.lastPlan.waiting.length > 0
          ? `${free.length} free account(s) but manual job(s) waiting (${mem.lastPlan.waiting.map((j) => j.name).join(", ")}) — they outrank the policy`
          : `${free.length} free account(s), nothing schedulable: ${states
              .filter((st) => allowed.has(st.name))
              .map((st) => `${st.name}=${st.status}`)
              .join(" ")}`;
    if (idle !== mem.policyIdle) {
      if (idle !== undefined) io.say(`policy: ${idle}`);
      mem.policyIdle = idle;
    }
  }
  // Cross-account name hygiene: a name the launching account's own
  // hygiene cannot see, on an account this tick calls free.
  if (freshAssign.length > 0) {
    const busy = new Set(
      [...runningAndReserved.values(), ...mem.lastPlan.assign.map((a) => a.account), ...freshAssign.map((a) => a.account)].map((a) =>
        a.toUpperCase(),
      ),
    );
    const sweeps = planNameSweeps({
      assign: freshAssign,
      affinity: affinityMap,
      isFree: (a) => !busy.has(a.toUpperCase()) && held(a) === undefined,
      // Every freeplay head, and the character of every run that has not
      // ended — whatever its lane, a run without a verdict still owns it.
      protect: new Set([
        ...[...characters.values()].map((s) => characterKey(s.account, s.character)),
        ...runs.filter((f) => f.terminationReason === null && f.account !== null && f.character !== null).map((f) => characterKey(f.account!, f.character!)),
      ]),
    });
    if (sweeps.length > 0) void io.sweepNames(sweeps, io.say);
  }
  for (const sk of mem.lastPlan.skipped) {
    if (complainedSkips.get(sk.job.name) !== sk.reason) {
      complainedSkips.set(sk.job.name, sk.reason);
      io.say(`queue ${sk.job.name}: skipped — ${sk.reason}`);
      io.record({ job: sk.job.name, event: "queue-skipped", detail: sk.reason });
    }
  }
  for (const j of cfg.jobs) if (!mem.lastPlan.skipped.some((sk) => sk.job.name === j.name)) complainedSkips.delete(j.name);
  // A job whose `repeat` is met says so once, not once a tick; raising its
  // repeat and meeting it again says so again.
  const done = [...mem.pinnedDone, ...mem.lastPlan.done];
  const counted = countedFrom(states);
  for (const j of done) {
    if (announcedDone.has(j.name)) continue;
    announcedDone.add(j.name);
    const progress = progressLabel(j, counted) ?? "met";
    io.say(`queue ${j.name}: done — ${j.ref} ${j.episode} ${progress}; nothing spawns (raise repeat for more)`);
    io.record({ job: j.name, event: "queue-done", detail: progress });
  }
  for (const n of [...announcedDone]) if (!done.some((j) => j.name === n)) announcedDone.delete(n);
  // The credentials' budgets over every spawn, last: a running job's next
  // episode on a held credential. A running freeplay job is its driver's to
  // pause; a running scored one drains to its boundary.
  const gated = gateSpawns(out, credGate, sets.running);
  for (const g of gated.gated) {
    if (g.drained) drainReasons.set(g.name, g.why);
    const key = `gate:${g.name}:${g.drained}:${g.why}`;
    if (!announcedPicks.has(key)) {
      announcedPicks.add(key);
      io.say(`${g.drained ? "drain" : "hold"} ${g.name}: ${g.why}${g.drained ? " — its live episode finishes, the next does not start" : ""}`);
      io.record({ job: g.name, event: "credential-budget", detail: g.why });
    }
  }
  return gated.spawns;
}
