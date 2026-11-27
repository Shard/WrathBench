/**
 * A policy pick's run id never names a run already on disk, planned through
 * the supervisor's own tick (`planTick`) over fixture runs. The pick's attempt
 * is a count, and a run deleted by hand lowers the count under ids still on
 * disk: sub-haiku-55 e90 (2026-11-16) had its bare id and `-a3` on disk and
 * `-a2` deleted, so every tick picked `-a3` again, its roster skipped it as
 * terminated and exited, and the supervisor spawned the same no-op forever.
 */
import { describe, expect, test } from "bun:test";

import { parseFleet, type FleetConfig, type FleetJob, type JobSpawn } from "./run-fleet-config";
import { attemptPastTaken, fillEntries, planTick, spawnsOnlyEnded } from "./run-fleet-plan";
import { planOf, snapshotOf, type RunningJob } from "./fixtures/tick";
import type { RunFact } from "../runner/src/run-fact";

const NOW = Date.UTC(2026, 10, 18, 12);
const H = 3_600_000;
const STAMP = "20261116";
const MODEL = "z-ai/glm-5.2:free";
const POOL = ["RUNNER4"];
const CREDENTIALS = {
  "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 4, billing: "free", enabled: true },
};
const ROSTER = { glm: { tier: "t1", model: MODEL, idle: "none" } };
const STEM = `fleet-glm-e90-glm-5-2-${STAMP}`;

function fleet(): FleetConfig {
  return parseFleet({ _notes: ["n"], accounts: { pool: POOL }, credentials: CREDENTIALS, roster: ROSTER, queue: [] }, { env: {} });
}

/** An e90 run of the model, ended at level 6 unless `over` says otherwise. */
function e90(runId: string, series: string | null, over: Partial<RunFact> = {}): RunFact {
  return {
    runId,
    model: MODEL,
    effort: null,
    driver: "openrouter",
    episode: "e90",
    episodeOverride: false,
    harnessVersion: `harness-${series}-1-gx`,
    harnessSeries: series,
    extra: false,
    startedAt: NOW - 30 * H,
    endedAt: NOW - 28 * H,
    terminationReason: "episode-limit",
    modelResponses: 400,
    bestLevel: 6,
    live: false,
    pause: null,
    account: "RUNNER4",
    character: "Brannagh",
    episodeMs: 5_400_000,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  };
}

/** The e90 pick's spawn and every run id it launches. */
function e90Pick(cfg: FleetConfig, runs: RunFact[], running?: readonly RunningJob[]) {
  const plan = planOf(cfg, { now: NOW, stamp: STAMP, runs, ...(running !== undefined ? { running } : {}) });
  const spawn = plan.spawns.find((s) => s.name === "glm-e90");
  return { plan, spawn, ids: spawn === undefined ? [] : fillEntries(spawn, STAMP).map((e) => e.runId) };
}

describe("a policy pick's attempt never names a run on disk", () => {
  test("a1 and a3 on disk, a2 deleted: the next attempt is a4, never a3", () => {
    const cfg = fleet();
    const series = cfg.policy.series;
    const runs = [e90(STEM, series), e90(`${STEM}-a3`, series)];
    const { plan, spawn, ids } = e90Pick(cfg, runs);
    expect(spawn?.enabled).toBe(true);
    expect(ids).toEqual([`${STEM}-a4`]);
    const pick = plan.picks.find((p) => p.job.name === "glm-e90")!;
    // The number is written onto the job, so its line and the live job's re-spawn name the same run.
    expect(pick.job.attempt).toBe(4);
    // The count is untouched: two attempts on disk, whatever their ids.
    expect(plan.states.find((s) => s.name === "glm")!.perEpisode.e90!.attempts).toBe(2);
  });

  test("with nothing deleted the id is the count's, as before", () => {
    const cfg = fleet();
    const series = cfg.policy.series;
    const { ids, plan } = e90Pick(cfg, [e90(STEM, series), e90(`${STEM}-a2`, series)]);
    expect(ids).toEqual([`${STEM}-a3`]);
    expect(plan.picks.find((p) => p.job.name === "glm-e90")!.job.attempt).toBe(3);
  });

  test("under a new supervisor stamp the count's id is free and is kept", () => {
    const cfg = fleet();
    const series = cfg.policy.series;
    const plan = planOf(cfg, { now: NOW, stamp: "20261118", runs: [e90(STEM, series), e90(`${STEM}-a3`, series)] });
    const spawn = plan.spawns.find((s) => s.name === "glm-e90")!;
    expect(fillEntries(spawn, "20261118").map((e) => e.runId)).toEqual(["fleet-glm-e90-glm-5-2-20261118-a3"]);
  });

  test("the next tick keeps the live a4 job's spawn on a4, not a5, and starts nothing over it", () => {
    const cfg = fleet();
    const series = cfg.policy.series;
    const first = e90Pick(cfg, [e90(STEM, series), e90(`${STEM}-a3`, series)]);
    const pick = first.plan.picks.find((p) => p.job.name === "glm-e90")!;
    const live = e90(`${STEM}-a4`, series, { startedAt: NOW - 60_000, endedAt: null, terminationReason: null, live: true, heartbeatAt: NOW - 10_000 });
    const snap = snapshotOf(cfg, {
      now: NOW,
      stamp: STAMP,
      runs: [e90(STEM, series), e90(`${STEM}-a3`, series), live],
      running: [{ name: "glm-e90", account: pick.account, refs: ["glm"], runIds: [live.runId] }],
    });
    // The live job as the supervisor stores it: the pick's own job, attempt and all.
    const plan = planTick({ ...snap, supervisor: { ...snap.supervisor, liveJobs: new Map<string, FleetJob>([["glm-e90", pick.job]]) } });
    expect(plan.drainReasons.size).toBe(0);
    expect(plan.picks).toEqual([]);
    const spawn = plan.spawns.find((s) => s.name === "glm-e90")!;
    expect(spawn.enabled).toBe(true);
    expect(fillEntries(spawn, STAMP).map((e) => e.runId)).toEqual([live.runId]);
  });
});

describe("no spawn whose every run id already ended", () => {
  const spawn = (over: Partial<JobSpawn> = {}): JobSpawn => ({
    name: "glm-e90",
    enabled: true,
    account: "RUNNER4",
    loop: false,
    entries: [{ model: MODEL, episode: "e90", runId: `${STEM}-a3` }],
    ...over,
  });
  const ended = new Set([`${STEM}-a3`]);

  test("a fresh spawn whose only id ended launches nothing", () => {
    expect(spawnsOnlyEnded(spawn(), STAMP, ended)).toBe(true);
    expect(spawnsOnlyEnded(spawn(), STAMP, new Set())).toBe(false);
  });

  test("a loop, a resume or a disabled stand-in is never one", () => {
    expect(spawnsOnlyEnded(spawn({ loop: true }), STAMP, ended)).toBe(false);
    expect(spawnsOnlyEnded(spawn({ resumeRunId: `${STEM}-a3` }), STAMP, ended)).toBe(false);
    expect(spawnsOnlyEnded(spawn({ enabled: false }), STAMP, ended)).toBe(false);
  });

  test("one id still to launch is enough", () => {
    const two = spawn({ entries: [{ model: MODEL, episode: "e90", runId: `${STEM}-a3` }, { model: MODEL, episode: "e90", runId: `${STEM}-a3-r2` }] });
    expect(spawnsOnlyEnded(two, STAMP, ended)).toBe(false);
  });

  test("the tick emits no enabled spawn whose only id already ended", () => {
    const cfg = fleet();
    const series = cfg.policy.series;
    const runs = [e90(STEM, series), e90(`${STEM}-a3`, series)];
    const plan = planOf(cfg, { now: NOW, stamp: STAMP, runs });
    const done = new Set(runs.map((r) => r.runId));
    for (const s of plan.spawns.filter((x) => x.enabled)) {
      expect(fillEntries(s, STAMP).every((e) => done.has(e.runId!))).toBe(false);
    }
  });

  test("attemptPastTaken leaves a resume, a party's id and an unnumbered job alone", () => {
    const base = { refs: ["glm"], ref: "glm", episode: "e90" as const, repeat: 1, name: "glm-e90", enabled: true, source: "policy" as const };
    const taken = new Set([`${STEM}-a3`]);
    const ids = () => [`${STEM}-a3`];
    expect(attemptPastTaken(base, ids, taken)).toBe(base);
    const resumed = { ...base, attempt: 3, resume: { runId: `${STEM}-a3` } } as Parameters<typeof attemptPastTaken>[0];
    expect(attemptPastTaken(resumed, ids, taken)).toBe(resumed);
  });
});
