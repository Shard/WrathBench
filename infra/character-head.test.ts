/**
 * Two questions the supervisor asks about a paused freeplay character, answered
 * the way the operator decided them (2026-09-25):
 *
 * - Which run is the character's head, when two of its runs are paused at once?
 *   Newest START, at every site that asks: the character head, the model hold
 *   and the resume planner. The planner used to order by pause time, so it
 *   could resume a run the other two did not treat as the head.
 * - How long does a paused run cool? By its pause STREAK — the ladder pauses
 *   since its last segment that made a turn — so a character that paused nine
 *   times across weeks of good play still resumes, and one its provider has
 *   refused through the whole ladder is listed instead of hammered.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FleetConfig, FleetRosterEntry } from "./run-fleet-config";
import { charactersFrom, planResumes, resumeNotBefore } from "./run-fleet-plan";
import { backoffMs } from "./run-roster";
import { loadRunConfig, type PauseReason } from "../runner/src/config";
import { byNewestStart, DEFAULT_POLICY, newestStarted, projectModel, readRunFact, type RosterModel, type RunFact } from "../runner/src/models";
import { Trajectory, type RunMeta } from "../runner/src/trajectory";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const MODEL = "vendor/durable-model:free";
const roster: Record<string, FleetRosterEntry> = { fp: { model: MODEL, tier: "t1", idle: "unlimited" } };
const config: Pick<FleetConfig, "jobs" | "roster" | "policy" | "accounts"> = {
  jobs: [],
  roster,
  policy: DEFAULT_POLICY,
  accounts: { pinned: {}, pool: ["RUNNER3", "RUNNER4"], paid: [], local: [] },
};
const held = (): string | undefined => undefined;

function paused(runId: string, startedAt: number, pausedAt: number): RunFact {
  return {
    runId,
    model: MODEL,
    effort: null,
    episode: "freeplay",
    episodeOverride: false,
    harnessVersion: "harness-0.5-1-gabc",
    harnessSeries: "0.5",
    extra: true,
    startedAt,
    endedAt: pausedAt,
    terminationReason: null,
    modelResponses: 400,
    bestLevel: 9,
    live: false,
    pause: { reason: "operator-pause", at: pausedAt, count: 1, episodeElapsedMs: 4 * H },
    account: "RUNNER3",
    character: "Bromdir",
    episodeMs: null,
    campaign: null,
    cell: null,
    subscription: null,
  };
}

describe("the head of a character is its newest-started run, at every site", () => {
  // The later-started run paused EARLIER: the case where newest start and
  // newest pause disagree.
  const older = paused("fleet-fp-freeplay-vendor-durable-model-free-20260920-a2", NOW - 10 * H, NOW - H);
  const newer = paused("fleet-fp-freeplay-vendor-durable-model-free-20260920-a3", NOW - 5 * H, NOW - 3 * H);

  test("the comparator: newest start first, ties to the higher run id", () => {
    expect([older, newer].sort(byNewestStart).map((f) => f.runId)).toEqual([newer.runId, older.runId]);
    const tie = { ...older, startedAt: newer.startedAt };
    expect(newestStarted([tie, newer])!.runId).toBe(newer.runId); // "-a3" > "-a2"
    expect(newestStarted([])).toBeUndefined();
  });

  test("character head, model hold and resume planner all name the same run", () => {
    // Input order deliberately not by start: nothing may lean on the caller's sort.
    const runs = [newer, older];
    expect(charactersFrom(runs, roster).get("fp")?.runId).toBe(newer.runId);

    const model: RosterModel = { name: "fp", model: MODEL, tier: "t1", idle: "unlimited" };
    const state = projectModel(model, runs, DEFAULT_POLICY, { now: NOW });
    expect(state.paused?.runId).toBe(newer.runId);

    const plan = planResumes({ runs, config, running: new Map(), held, now: NOW });
    expect(plan.resume.map((r) => r.runId)).toEqual([newer.runId]);
    expect(plan.listed.map((l) => [l.runId, l.why])).toEqual([
      [older.runId, "a later-started paused run of this model is ahead of it — resume by hand or archive"],
    ]);
  });
});

describe("the resume cadence reads the pause streak", () => {
  let runs: string;
  beforeAll(() => {
    runs = mkdtempSync(join(tmpdir(), "wb-character-streak-"));
  });
  afterAll(() => {
    rmSync(runs, { recursive: true, force: true });
  });

  /** A run on disk: `segments` pauses of `reason`, each after `turns` turns, a resume between them. */
  function writeRun(runId: string, segments: number, turns: number, reason: PauseReason): RunFact {
    const t = new Trajectory(join(runs, runId));
    t.writeMeta({
      runId,
      harnessVersion: "harness-0.5-1-gabc",
      startedAt: NOW - 30 * 24 * H,
      config: loadRunConfig({ runId, driver: "openai", model: MODEL, episode: "freeplay", account: "RUNNER3" }),
      comparability: { episode: "freeplay" } as unknown as RunMeta["comparability"],
    });
    for (let s = 0; s < segments; s++) {
      if (s > 0) t.append({ t: "resume", after: reason });
      for (let n = 1; n <= turns; n++) t.append({ t: "response", turn: n, message: { role: "assistant", content: "…" } });
      if (s === segments - 1) t.setPause(runId, reason, "fixture");
      else t.append({ t: "pause", reason, detail: "fixture" });
    }
    t.close();
    return readRunFact(runs, runId)!;
  }

  test("nine spread-out rate limits with play between them: rung 1, not past the ladder", () => {
    const f = writeRun("fleet-fp-freeplay-spread", 10, 25, "rate-limited");
    expect(f.pause).toMatchObject({ reason: "rate-limited", count: 1 });
    expect(resumeNotBefore(f.pause!)).toBe(f.pause!.at + backoffMs(1));
  });

  test("ten refusals in a row with no turn between them are past the ladder", () => {
    const f = writeRun("fleet-fp-freeplay-refused", 10, 0, "quota-exhausted");
    expect(f.pause!.count).toBe(10);
    expect(resumeNotBefore(f.pause!)).toBe("never");
  });

  test("the exempt pauses stay exempt whatever the streak reads", () => {
    const at = NOW - H;
    expect(resumeNotBefore({ reason: "operator-pause", at, count: 12, episodeElapsedMs: null })).toBeNull();
    expect(resumeNotBefore({ reason: "offline", at, count: 12, episodeElapsedMs: null, notBefore: at + 5 })).toBe(at + 5);
  });
});
