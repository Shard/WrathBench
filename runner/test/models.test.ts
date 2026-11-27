import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchRouting } from "./fixtures/launch-routing";
import { OPENCODE_GO_ROUTING } from "../src/routing";
import { countedFact } from "./fixtures/counted-fact";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countsTowardTarget, DEFAULT_POLICY, LADDER_MS, isCounted, isNoProgress, isStaleRun, isStandingPause, modelStates, nextJobs, planNextJobs, TIER_TABLE, effectiveTier, type SchedulingPolicy, parseModelsSidecar, projectModel, schedulability, schedulableView, wantsIdle, serializeModelsSidecar, type ModelState, outstandingWork, liveCredentials, parsePolicyBlock, entryOwnsRun, matchesRoster, modelSiblings, sameModel } from "../src/models";
import { countModelResponses, stillbornOf, readRunFacts, type RunFact } from "../src/run-fact";
import { type RosterModel, entryOwnsWindow, ownedWindows, rosterWindowKey } from "../src/roster-entry";
import { billingOf } from "../src/model-cost";
import { parseCredentials } from "../src/credential-slots";
import { rowOf } from "../../viewer/models";
import type { EpisodeId } from "../src/episodes";
import type { Campaign, ProbeRun } from "../src/campaigns";
import { definition, joined } from "./fixtures/campaigns";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

interface SynthRun {
  id: string;
  model: string;
  /** A run on the snippet loop, stamped with no loop key. */
  snippet?: boolean;
  effort?: string;
  episode?: string;
  override?: boolean;
  responses: number;
  level?: number;
  reason?: string | null;
  startedAt: number;
  endedAt?: number | null;
  /** trajectory mtime; defaults to endedAt or startedAt */
  mtime?: number;
  noMeta?: boolean;
  harnessVersion?: string;
  extra?: boolean;
  /** A run with no routing to state (a CLI, a local box): its stamp carries none. Else the default base's. */
  unrouted?: boolean;
}

function writeRun(runsDir: string, r: SynthRun): void {
  const dir = join(runsDir, r.id);
  mkdirSync(dir, { recursive: true });
  if (!r.noMeta) {
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        runId: r.id,
        harnessVersion: r.harnessVersion ?? "harness-0.3-test",
        startedAt: r.startedAt,
        config: { model: r.model, ...(r.effort !== undefined ? { effort: r.effort } : {}), ...(r.extra ? { extra: true } : {}) },
        comparability: {
          effort: r.effort ?? null,
          ...(r.episode !== undefined ? { episode: r.episode } : {}),
          ...(r.override ? { episodeOverride: true } : {}),
          // The routing a launch of its entry stamps (`countsTowardTarget`).
          ...(r.unrouted === true ? {} : launchRouting(r.model, r.effort)),
          // The loop the entry launches now, so its runs count toward its
          // targets: the program loop with yield on openai and claude-code.
          ...(r.snippet === true ? {} : { loop: "program", yield: true }),
        },
      }),
    );
  }
  const lines: string[] = [`{"t":"meta","ts":${r.startedAt}}`, `{"t":"request","ts":${r.startedAt + 1},"messages":[]}`];
  for (let i = 0; i < r.responses; i++) lines.push(`{"ts":${r.startedAt + 2 + i},"t":"response","text":"x"}`);
  lines.push(`{"t":"tool_call","ts":${r.startedAt + 99},"name":"response"}`); // decoy: "response" as a value
  writeFileSync(join(dir, "trajectory.jsonl"), lines.join("\n") + "\n");
  const db = new Database(join(dir, "run.sqlite"));
  db.run(`CREATE TABLE run (run_id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER, termination_reason TEXT)`);
  db.run(`CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER)`);
  db.run(`INSERT INTO run VALUES (?, ?, ?, ?)`, [r.id, r.startedAt, r.endedAt ?? null, r.reason ?? null]);
  if (r.level !== undefined) {
    for (let l = 1; l <= r.level; l++) db.run(`INSERT INTO state VALUES (?, ?, ?)`, [r.id, r.startedAt + l * 1000, l]);
  }
  db.close();
  const m = (r.mtime ?? r.endedAt ?? r.startedAt) / 1000;
  utimesSync(join(dir, "trajectory.jsonl"), m, m);
}

const roster: RosterModel[] = [
  { name: "ox", model: "stealth/ox-alpha:free", tier: "t1" },
  { name: "glm", model: "z-ai/glm:free", apiBase: "https://openrouter.ai/api/v1", tier: "t1" },
  { name: "sonnet", model: "sonnet", driver: "claude-code", tier: "t1" },
  // t0 is the one-run trial tier: the same budget the old per-entry override spelled.
  { name: "sonnet-low", model: "sonnet", effort: "low", driver: "claude-code", tier: "t0" },
  { name: "local", model: "qwen/q", apiBase: "http://192.168.100.20:1234/v1", tier: "t1", idle: "unlimited" },
];

let runsDir: string;

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), "wb-models-"));
  const t0 = NOW - 48 * HOUR;
  // ox: two good e90 runs, one reaching level 5 -> promoted; one overridden run (not counted).
  writeRun(runsDir, { id: "ox-1", model: "stealth/ox-alpha:free", episode: "e90", responses: 40, level: 5, reason: "episode-limit", startedAt: t0, endedAt: t0 + HOUR });
  writeRun(runsDir, { id: "ox-2", model: "stealth/ox-alpha:free", episode: "e90", responses: 12, level: 3, reason: "idle", startedAt: t0 + 2 * HOUR, endedAt: t0 + 3 * HOUR });
  writeRun(runsDir, { id: "ox-3", model: "stealth/ox-alpha:free", episode: "e90", override: true, responses: 30, level: 6, reason: "episode-limit", startedAt: t0 + 4 * HOUR, endedAt: t0 + 5 * HOUR });
  // glm: one stillborn, then a second stillborn 30m ago -> rung 2 (3m) already expired; then a fresh stillborn 1m ago -> rung 3 cooling.
  writeRun(runsDir, { id: "glm-1", model: "z-ai/glm:free", episode: "e90", responses: 0, reason: "adapter-error", startedAt: t0, endedAt: t0 + 60_000 });
  writeRun(runsDir, { id: "glm-2", model: "z-ai/glm:free", episode: "e90", responses: 0, reason: null, startedAt: NOW - 40 * 60_000, endedAt: null, mtime: NOW - 30 * 60_000 });
  writeRun(runsDir, { id: "glm-3", model: "z-ai/glm:free", episode: "e90", responses: 0, reason: "adapter-error", startedAt: NOW - 5 * 60_000, endedAt: NOW - 60_000 });
  // sonnet: one counted run, no level 5; a pre-tier run (no episode stamp) that must be invisible.
  writeRun(runsDir, { id: "sonnet-1", model: "sonnet", unrouted: true, episode: "e90", responses: 50, level: 4, reason: "episode-limit", startedAt: t0, endedAt: t0 + HOUR });
  writeRun(runsDir, { id: "sonnet-old", model: "sonnet", unrouted: true, responses: 50, level: 9, reason: "episode-limit", startedAt: t0 - HOUR, endedAt: t0 });
  // sonnet-low: an answered run that is LIVE (mtime just now, no termination) -> counted, not stillborn.
  writeRun(runsDir, { id: "sonnet-low-1", model: "sonnet", unrouted: true, effort: "low", episode: "e90", responses: 3, level: 1, reason: null, startedAt: NOW - 60_000, endedAt: null, mtime: NOW - 10_000 });
  // local: one run from the previous series and one extra run this series — both visible, neither counted.
  writeRun(runsDir, { id: "local-old", model: "qwen/q", unrouted: true, episode: "e90", responses: 20, level: 7, reason: "episode-limit", startedAt: t0, endedAt: t0 + HOUR, harnessVersion: "harness-0.2-33-gabc" });
  writeRun(runsDir, { id: "local-x", model: "qwen/q", unrouted: true, episode: "e90", responses: 20, level: 2, reason: "episode-limit", startedAt: t0 + 6 * HOUR, endedAt: t0 + 7 * HOUR, extra: true });
  // a non-run directory and a directory without meta.json
  mkdirSync(join(runsDir, "night-report"), { recursive: true });
  writeRun(runsDir, { id: "nometa", model: "x", responses: 2, startedAt: t0, noMeta: true });
  // An archived run: the runner parks a launch that produced no response.
  // Invisible to a listing, visible to the scheduler (attempt numbers, ladder).
  mkdirSync(join(runsDir, "archive", "ox-archived"), { recursive: true });
  writeFileSync(join(runsDir, "archive", "ox-archived", "meta.json"), JSON.stringify({ harnessVersion: "harness-0.3-1-gabc", config: { model: "stealth/ox-alpha:free" }, comparability: { episode: "e90" } }));
});

afterAll(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

describe("reading runs", () => {
  test("counts only `t: response` records; a value that says response is not one", () => {
    expect(countModelResponses(join(runsDir, "ox-1", "trajectory.jsonl"))).toBe(40);
    expect(countModelResponses(join(runsDir, "glm-1", "trajectory.jsonl"))).toBe(0);
    expect(countModelResponses(join(runsDir, "nope", "trajectory.jsonl"))).toBeNull();
  });

  test("only stamped runs become facts; archive/ and report dirs are skipped; oldest first", () => {
    const facts = readRunFacts(runsDir, NOW);
    // The archive is the scheduler's to read, and only when it asks.
    expect(readRunFacts(runsDir, NOW, { includeArchived: true }).map((f) => f.runId)).toContain("ox-archived");
    expect(facts.map((f) => f.runId)).toEqual(["glm-1", "local-old", "ox-1", "sonnet-1", "ox-2", "ox-3", "local-x", "glm-2", "glm-3", "sonnet-low-1"]);
    expect(facts.find((f) => f.runId === "local-old")).toMatchObject({ harnessSeries: "0.2", extra: false });
    expect(facts.find((f) => f.runId === "local-x")).toMatchObject({ harnessSeries: "0.3", extra: true });
    const ox3 = facts.find((f) => f.runId === "ox-3")!;
    expect(ox3).toMatchObject({ episode: "e90", episodeOverride: true, bestLevel: 6, terminationReason: "episode-limit", modelResponses: 30, live: false });
    const glm2 = facts.find((f) => f.runId === "glm-2")!;
    // Killed process: no termination row, stale trajectory -> not live, ended at the mtime.
    expect(glm2.live).toBe(false);
    expect(glm2.endedAt).toBe(NOW - 30 * 60_000);
    expect(facts.find((f) => f.runId === "sonnet-low-1")!.live).toBe(true);
  });
});

describe("modelStates", () => {
  test("the projection: counted, stillborn, promotion, cooling, new", () => {
    const states = modelStates({ runsDir, roster, now: NOW, sidecar: { version: 1, cleared: {} } });
    const by = Object.fromEntries(states.map((s) => [s.name, s]));

    // ox is t1 and earned promotion (a counted e90 at level 5), so it climbed
    // to t2 — which is what unlocks e360 at all. The declared tier is
    // unchanged: the config is not rewritten. No counted e360 reached level 8,
    // so the Deadmines evals t2 buys stay shut (operator, 2026-11-15).
    expect(by["ox"]).toMatchObject({ status: "promoted", declaredTier: "t1", tier: "t2", earnedPromotion: true, earnedDeadmines: false, eligible: ["e90", "e360"], platform: "openrouter", ladder: 0 });
    // attempts 4: the archived ox run is an attempt — it numbers the next run id.
    expect(by["ox"]!.perEpisode.e90).toMatchObject({ counted: 2, stillborn: 0, attempts: 4, target: 3, bestLevel: 6, countedLevel: 5, lastReason: "episode-limit" });
    expect(by["ox"]!.perEpisode.e360).toMatchObject({ counted: 0, target: 1, bestLevel: null, countedLevel: null, lastEnded: null, lastReason: null });

    expect(by["glm"]!.status).toBe("cooling");
    expect(by["glm"]!.ladder).toBe(3);
    expect(by["glm"]!.cooling).toMatchObject({ rung: 3, until: NOW - 60_000 + LADDER_MS[2]! });
    expect(by["glm"]!.cooling!.reason).toContain("glm-3");
    expect(by["glm"]!.perEpisode.e90).toMatchObject({ counted: 0, stillborn: 3, attempts: 3, lastReason: "stillborn" });

    expect(by["sonnet"]).toMatchObject({ status: "active", eligible: ["e90"], platform: "claude-code", harness: "claude-code" });
    // The old driver spelling in a roster reads as the same harness.
    expect(by["sonnet-low"]).toMatchObject({ platform: "claude-code", harness: "claude-code" });
    expect(by["ox"]).toMatchObject({ harness: "wrathbench" });
    expect(by["sonnet"]!.perEpisode.e90).toMatchObject({ counted: 1, bestLevel: 4, countedLevel: 4 });

    // A live, answered run is still in progress and cannot become score evidence.
    expect(by["sonnet-low"]!.perEpisode.e90).toMatchObject({ counted: 0, stillborn: 0, target: 1 });
    // No series on the policy: the 0.2 run is an attempt like any other; the extra is an attempt, never counted.
    expect(by["local"]).toMatchObject({ status: "promoted", platform: "local", billing: "free" });
    expect(by["local"]!.perEpisode.e90).toMatchObject({ counted: 1, attempts: 2, extras: 1, otherSeries: 0, target: 3, bestLevel: 7 });
    expect(by["local"]).toMatchObject({ declaredTier: "t1", tier: "t2", idle: "unlimited" });
    expect(by["ox"]!.billing).toBe("free"); // a `:free` slug
    expect(by["glm"]!.billing).toBe("free");
    expect(by["sonnet"]!.billing).toBe("free"); // subscription
  });

  test("series keying: runs from another series are shown, not counted", () => {
    const policy: SchedulingPolicy = { ...DEFAULT_POLICY, series: "0.3" };
    const states = modelStates({ runsDir, roster, policy, now: NOW, sidecar: { version: 1, cleared: {} } });
    const local = states.find((s) => s.name === "local")!;
    expect(local.status).toBe("new");
    expect(local.perEpisode.e90).toMatchObject({ counted: 0, attempts: 2, extras: 1, otherSeries: 1, bestLevel: 2 });
    // Everything else in the fixture is 0.3 and unchanged.
    expect(states.find((s) => s.name === "ox")!.perEpisode.e90).toMatchObject({ counted: 2, attempts: 4, otherSeries: 0 });
    // A policy keyed on a series nothing ran under: every model is new, but
    // attempts still number every run on disk so the next run id is unique.
    const none = modelStates({ runsDir, roster, policy: { ...policy, series: "0.4" }, now: NOW, sidecar: { version: 1, cleared: {} } });
    expect(none.every((s) => s.status === "new" && s.perEpisode.e90!.counted === 0)).toBe(true);
    expect(none.find((s) => s.name === "ox")!.perEpisode.e90!.attempts).toBe(4);
    expect(none.find((s) => s.name === "ox")!.perEpisode.e90!.otherSeries).toBe(4);
  });

  test("a hand-set tier is eligible without a witness, and never reads as earned", () => {
    const [s] = modelStates({ runsDir, roster: [{ name: "sonnet", model: "sonnet", driver: "claude-code", tier: "t2" }], now: NOW, sidecar: { version: 1, cleared: {} } });
    // e360 by the tier alone; the Deadmines evals only on the e360 witness, which no tier stands in for.
    expect(s!.eligible).toEqual(["e90", "e360"]);
    expect(s!.earnedDeadmines).toBe(false);
    // Hand-placed on t2: eligible, but it did not climb, so "promoted" — the
    // earned word — is not said of it, and the witness stays false.
    expect(s!.status).toBe("active");
    expect(s!.declaredTier).toBe("t2");
    expect(s!.tier).toBe("t2");
    expect(s!.earnedPromotion).toBe(false);
    expect(s!.perEpisode.e90!.countedLevel).toBe(4);
  });
});

describe("the ladder", () => {
  const fail = (i: number, endedAt: number, reason: string | null = "adapter-error", responses: number | null = 0): RunFact => ({
    runId: `f-${i}`,
    model: "m",
    effort: null,
    ...launchRouting("m"),
    episode: "e90",
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: endedAt - 60_000,
    endedAt,
    terminationReason: reason,
    modelResponses: responses,
    bestLevel: null,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
  });
  const m: RosterModel = { name: "m", model: "m", tier: "t1" };

  test("rungs escalate with consecutive failures and the deadline is the last failure plus the rung", () => {
    const runs = [fail(1, NOW - 10 * HOUR), fail(2, NOW - 9 * HOUR), fail(3, NOW - 1000)];
    const s = projectModel(m, runs, DEFAULT_POLICY, { now: NOW });
    expect(s.status).toBe("cooling");
    expect(s.cooling).toMatchObject({ rung: 3, until: NOW - 1000 + LADDER_MS[2]! });
  });

  test("an operator cut or a harness error numbers an attempt but never counts toward the target", () => {
    const runs = [fail(1, NOW - 2 * HOUR, "manual", 40), fail(2, NOW - HOUR, "harness-error", 12), fail(3, NOW - 1000, "episode-limit", 90)];
    const s = projectModel(m, runs, DEFAULT_POLICY, { now: NOW });
    expect(s.perEpisode.e90).toMatchObject({ attempts: 3, counted: 1 });
  });

  test("a run that got off the ground resets the ladder even if it ended badly", () => {
    const runs = [fail(1, NOW - 10 * HOUR), fail(2, NOW - 9 * HOUR), fail(3, NOW - 1000, "harness-error", 7)];
    const s = projectModel(m, runs, DEFAULT_POLICY, { now: NOW });
    expect(s.ladder).toBe(0);
    // It got off the ground, so the ladder resets — but a harness error is not
    // the model's result, so nothing is counted yet and the model is still new.
    expect(s.status).toBe("new");
  });

  test("a paused run is an attempt, never counted, never a rung, and holds the model", () => {
    const paused: RunFact = {
      ...fail(9, NOW - 1000, null, 30),
      pause: { reason: "operator-pause", at: NOW - 1000, count: 1, episodeElapsedMs: 41 * 60_000 },
      episodeMs: 90 * 60_000,
      account: "RUNNER3",
    };
    // Two stillborn failures, then the pause: the ladder reads the failures
    // (rung 2, still cooling? no — long ago) and the pause neither adds nor resets.
    const runs = [fail(1, NOW - 10 * HOUR), fail(2, NOW - 9 * HOUR), paused];
    const s = projectModel(m, runs, DEFAULT_POLICY, { now: NOW });
    expect(s.perEpisode.e90).toMatchObject({ attempts: 3, counted: 0, stillborn: 2 });
    expect(s.ladder).toBe(2);
    expect(s.paused).toMatchObject({ runId: "f-9", episode: "e90", reason: "operator-pause", episodeElapsedMs: 41 * 60_000, episodeMs: 90 * 60_000 });
    const v = schedulability(s);
    expect(v.verdict).toBe("blocked");
    expect(v.why).toContain("paused run f-9 (operator-pause, 41m of 90m elapsed)");
    expect(nextJobs([s], ["A"])).toEqual([]);
    expect(isCounted(paused)).toBe(false);
    expect(isNoProgress(paused)).toBe(false);
    expect(stillbornOf(paused)).toBeNull();
  });

  test("isCounted rejects paused, empty, unknown, live, and environment-defect evidence", () => {
    const cases: RunFact[] = [
      { ...fail(10, NOW - 1000, "episode-limit", 2), pause: { reason: "rate-limited", at: NOW - 1000, count: 1, episodeElapsedMs: 1_000 } },
      fail(11, NOW - 1000, "episode-limit", 0),
      fail(12, NOW - 1000, "episode-limit", null),
      { ...fail(13, NOW - 1000, null, 2), endedAt: null, live: true },
      { ...fail(15, NOW - 1000, null, 2), endedAt: null, live: false },
      fail(14, NOW - 1000, "environment-defect", 2),
    ];
    for (const fact of cases) expect(isCounted(fact)).toBe(false);
  });

  test("a freeplay pause never goes stale: it holds its model's freeplay however long it sits, so no session is started over it, and never its scored episodes", () => {
    const old: RunFact = {
      ...fail(9, NOW - 30 * HOUR, null, 30),
      episode: "freeplay",
      extra: true,
      // Past the defer ladder, so the supervisor lists it rather than resuming
      // it — exactly the run the policy used to pick fresh over after 12 h.
      pause: { reason: "quota-exhausted", at: NOW - 30 * HOUR, count: 11, episodeElapsedMs: null },
      episodeMs: null,
      account: "RUNNER3",
      character: "Aurelian",
    };
    expect(isStaleRun(old, NOW)).toBe(false);
    expect(isStandingPause(old, NOW)).toBe(true);
    // The same silence on a scored lane is stale, as it always was.
    expect(isStaleRun({ ...old, episode: "e90" }, NOW)).toBe(true);
    expect(isStandingPause({ ...old, episode: "e90" }, NOW)).toBe(false);
    const s = projectModel({ ...m, idle: "unlimited" }, [old], DEFAULT_POLICY, { now: NOW });
    expect(s.paused).toMatchObject({ runId: "f-9", episode: "freeplay", reason: "quota-exhausted" });
    // It owes e90s, and the paused run plays nothing: the e90 is picked.
    expect(schedulability(s)).toEqual({ verdict: "eval", why: "schedulable on e90" });
    expect(nextJobs([s], ["A"]).map((j) => [j.name, j.episode])).toEqual([["m", "e90"]]);
    // Targets met: free, but no fresh freeplay session over the paused character.
    const counted = [1, 2, 3].map((n) => fail(n, NOW - (10 - n) * HOUR, "episode-limit", 90));
    const met = projectModel({ ...m, idle: "unlimited" }, [...counted, old], DEFAULT_POLICY, { now: NOW });
    const v = schedulability(met);
    expect(v.verdict).toBe("free");
    expect(v.why).toBe("targets met on e90 — no freeplay session: paused run f-9 (quota-exhausted, ?m elapsed) is resumed, never started over");
    expect(wantsIdle(v, met)).toBe(false);
    expect(nextJobs([met], ["A"])).toEqual([]);
    // Without the pause the same entry takes its unlimited session.
    const free = projectModel({ ...m, idle: "unlimited" }, counted, DEFAULT_POLICY, { now: NOW });
    expect(nextJobs([free], ["A"]).map((j) => [j.name, j.episode])).toEqual([["m", "freeplay"]]);
  });

  test("a stale pause (older than its own budget) no longer holds the model", () => {
    const stale: RunFact = {
      ...fail(9, NOW - 4 * HOUR, null, 30),
      pause: { reason: "rate-limited", at: NOW - 4 * HOUR, count: 3, episodeElapsedMs: 5 * 60_000 },
      episodeMs: 90 * 60_000,
      account: "RUNNER3",
    };
    expect(isStaleRun(stale, NOW)).toBe(true);
    expect(isStaleRun({ ...stale, pause: { ...stale.pause!, at: NOW - 30 * 60_000 } }, NOW)).toBe(false);
    // No wall clock: twice the long tier's budget stands in.
    expect(isStaleRun({ ...stale, episodeMs: null }, NOW)).toBe(false);
    const s = projectModel(m, [stale], DEFAULT_POLICY, { now: NOW });
    expect(s.paused).toBeUndefined();
    expect(schedulability(s).verdict).toBe("eval");
    // Still not counted: it has not ended.
    expect(s.perEpisode.e90).toMatchObject({ attempts: 1, counted: 0 });
  });

  test("a provider-refused attempt is a rung of the cooling ladder, not a strike; an operator-pause or an offline gap is none", () => {
    // Strikes are folded into the cooling ladder (operator, 2026-11-14): one
    // stop mechanism per model, cleared one way.
    const failed = (i: number, reason: string): RunFact => ({
      ...fail(i, NOW - (4 - i) * 60_000, reason, 12),
      runId: `fleet-m-e90-m-2026082${i}`,
      bestLevel: 3,
    });
    const three = projectModel(m, [failed(1, "attempt-failed"), failed(2, "attempt-failed"), failed(3, "attempt-failed")], DEFAULT_POLICY, { now: NOW });
    expect(three.ladder).toBe(3);
    expect(three.status).toBe("cooling");
    const v = schedulability(three);
    expect(v.verdict).toBe("blocked");
    expect(v.why).toContain("cooling rung 3/9");
    expect(nextJobs([three], ["A"])).toEqual([]);
    // A deploy between two refusals breaks the streak, as any run that is not
    // the provider's refusal does: one rung, served by now.
    const deploy = projectModel(m, [failed(1, "attempt-failed"), failed(2, "manual"), failed(3, "attempt-failed")], DEFAULT_POLICY, { now: NOW });
    expect(deploy.ladder).toBe(1);
    expect(schedulability(deploy).verdict).toBe("eval");
    // An offline gap is no rung either.
    const offline = projectModel(m, [failed(1, "attempt-failed"), failed(2, "stale"), failed(3, "attempt-failed")], DEFAULT_POLICY, { now: NOW });
    expect(offline.ladder).toBe(1);
    // Neither reason is ever counted or scored, and both still number attempts.
    expect(isCounted(failed(1, "attempt-failed"))).toBe(false);
    expect(isCounted(failed(2, "stale"))).toBe(false);
    expect(three.perEpisode.e90).toMatchObject({ counted: 0, attempts: 3 });
    expect("failed" in three.perEpisode.e90!).toBe(false);
    // A clear forgives the rungs before it.
    const cleared = projectModel(m, [failed(1, "attempt-failed"), failed(2, "attempt-failed"), failed(3, "attempt-failed")], DEFAULT_POLICY, {
      now: NOW,
      clearedAt: NOW - 2.5 * 60_000,
    });
    expect(cleared.ladder).toBe(2);
  });

  test("at the ceiling one more no-progress attempt retires the model; a clear forgives it", () => {
    const n = LADDER_MS.length;
    const atCeiling = Array.from({ length: n }, (_, i) => fail(i, NOW - (n - i) * 10 * HOUR + 9 * HOUR));
    let s = projectModel(m, atCeiling, DEFAULT_POLICY, { now: NOW });
    expect(s.status).toBe("cooling");
    expect(s.cooling!.rung).toBe(n);
    expect(s.cooling!.until).toBe(NOW - HOUR + 6 * HOUR);
    expect(schedulability(s).why).toContain("cooling");
    // Once that cooling expires it may run; suppose the next attempt fails too.
    const oneMore = [...atCeiling, fail(99, NOW - 1000)];
    s = projectModel(m, oneMore, DEFAULT_POLICY, { now: NOW });
    expect(s.status).toBe("retired");
    expect(s.retired).toMatchObject({ at: NOW - 1000 });
    expect(s.retired!.reason).toContain("f-99");
    expect(schedulability(s).why).toContain("bun wb fleet clear-model m");
    expect(nextJobs([s], ["RUNNER"])).toEqual([]);
    // Cleared after the last failure: the ladder starts over and it is schedulable.
    s = projectModel(m, oneMore, DEFAULT_POLICY, { now: NOW, clearedAt: NOW - 500 });
    expect(s.status).toBe("new");
    expect(s.ladder).toBe(0);
    expect(nextJobs([s], ["RUNNER"])).toHaveLength(1);
    // Cleared before the last failure: that failure still counts as rung 1.
    s = projectModel(m, oneMore, DEFAULT_POLICY, { now: NOW, clearedAt: NOW - 5000 });
    expect(s.ladder).toBe(1);
    expect(s.status).toBe("cooling");
  });

  test("the sidecar round-trips and tolerates garbage", () => {
    const text = serializeModelsSidecar({ version: 1, cleared: { m: 5 } });
    expect(parseModelsSidecar(text)).toEqual({ version: 1, cleared: { m: 5 } });
    expect(parseModelsSidecar("{nope")).toEqual({ version: 1, cleared: {} });
    expect(parseModelsSidecar(JSON.stringify({ cleared: { m: "x", n: 2 } }))).toEqual({ version: 1, cleared: { n: 2 } });
  });
});

describe("nextJobs", () => {
  const st = (name: string, over: Partial<Parameters<typeof projectModel>[1][number]>[] | RunFact[], tier: "t0" | "t1" | "t2" = "t1") =>
    projectModel({ name, model: name, tier }, over as RunFact[], DEFAULT_POLICY, { now: NOW });
  const good = (model: string, ep: "e90" | "e360", i: number, level = 3): RunFact => ({
    runId: `${model}-${ep}-${i}`,
    model,
    effort: null,
    ...launchRouting(model),
    episode: ep,
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: NOW - (100 - i) * HOUR,
    endedAt: NOW - (99 - i) * HOUR,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
  });

  test("priority: never-run first, then e90 before e360, then fewest counted, then roster order", () => {
    const a = st("a", [good("a", "e90", 1), good("a", "e90", 2)]); // 2/3 on e90
    const b = st("b", []); // new
    const c = st("c", [good("c", "e90", 1, 5)]); // promoted: 1/3 e90, 0/3 e360
    const d = st("d", [good("d", "e90", 1, 5), good("d", "e90", 2), good("d", "e90", 3)]); // e90 met, e360 0/3
    const e = st("e", []); // new, later in roster
    const picks = nextJobs([a, b, c, d, e], ["R1", "R2", "R3", "R4", "R5", "R6"]);
    expect(picks.map((p) => [p.name, p.episode, p.account])).toEqual([
      ["b", "e90", "R1"],
      ["e", "e90", "R2"],
      ["c", "e90", "R3"], // 1 counted on e90 beats a's 2
      ["a", "e90", "R4"],
      ["d", "e360", "R5"], // the only model whose open episode is e360
    ]);
    expect(picks[0]!.attempt).toBe(1);
    expect(picks[3]!.attempt).toBe(3);
    expect(picks[4]!.why).toContain("promoted");
  });

  test("one job per model, accounts are the limit, running models and met targets are skipped", () => {
    const c = st("c", [good("c", "e90", 1, 5)]);
    const b = st("b", []);
    expect(nextJobs([c, b], ["R1"]).map((p) => p.name)).toEqual(["b"]);
    expect(nextJobs([c, b], ["R1", "R2"], new Set(["b"])).map((p) => p.name)).toEqual(["c"]);
    expect(nextJobs([c, b], [])).toEqual([]);
    const met = st("m", [good("m", "e90", 1), good("m", "e90", 2), good("m", "e90", 3)]);
    expect(schedulability(met)).toEqual({ verdict: "free", why: "targets met on e90" });
    // The wire shape the dashboard reads is a projection of the verdict, and
    // `ok` still means exactly "owes a counted run".
    expect(schedulableView(schedulability(met), met)).toEqual({ ok: false, extras: false, why: "targets met on e90" });
    expect(nextJobs([met], ["R1"])).toEqual([]);
    expect(schedulability(b, new Set(["b"])).why).toContain("running");
  });

  test("a stillborn attempt does not count toward the target but does number the next attempt", () => {
    const runs: RunFact[] = [
      { ...good("s", "e90", 1), runId: "s-1", modelResponses: 0, terminationReason: "adapter-error", endedAt: NOW - 50 * HOUR },
      good("s", "e90", 2),
    ];
    const s = st("s", runs);
    expect(s.perEpisode.e90).toMatchObject({ counted: 1, stillborn: 1, attempts: 2 });
    expect(nextJobs([s], ["R1"])[0]).toMatchObject({ name: "s", episode: "e90", attempt: 3 });
  });
});

describe("paid and free", () => {
  const good = (model: string, ep: EpisodeId, i: number, level = 3, extra = false): RunFact => ({
    runId: `${model}-${ep}-${i}`,
    model,
    effort: null,
    ...launchRouting(model),
    episode: ep,
    episodeOverride: false,
    harnessVersion: "harness-0.3-1-gx",
    harnessSeries: "0.3",
    loop: "program",
    yield: true,
    extra,
    startedAt: NOW - (100 - i) * HOUR,
    endedAt: NOW - (99 - i) * HOUR,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
  });
  const policy: SchedulingPolicy = { ...DEFAULT_POLICY };
  const st = (r: Omit<RosterModel, "tier"> & { tier?: RosterModel["tier"] }, runs: RunFact[], p = policy) =>
    projectModel({ tier: "t1", ...r }, runs, p, { now: NOW });

  test("billing is derived once: slug, LAN, subscription, override", () => {
    expect(st({ name: "p", model: "vendor/big" }, []).billing).toBe("paid");
    expect(st({ name: "f", model: "vendor/big:free" }, []).billing).toBe("free");
    expect(st({ name: "c", model: "x-contributor-free", apiBase: "https://opencode.ai/zen/v1" }, []).billing).toBe("free");
    expect(st({ name: "l", model: "vendor/big", apiBase: "http://10.0.0.5:1234/v1" }, []).billing).toBe("free");
    expect(st({ name: "s", model: "opus", driver: "claude-code" }, []).billing).toBe("free");
    // A suffixless id — however free it looks — is paid unless its entry says otherwise.
    expect(st({ name: "o", model: "stealth/ox-preview" }, []).billing).toBe("paid");
    expect(st({ name: "o", model: "stealth/ox-preview", billing: "free" }, []).billing).toBe("free");
    expect(st({ name: "x", model: "vendor/big:free", billing: "paid" }, []).billing).toBe("paid");
  });

  test("a target is the tier and only the tier — billing buys no runs and costs none", () => {
    // The same tier means the same budget whoever is paying. This is the whole
    // point of the split: billing says where a run may execute, never how many.
    for (const model of ["vendor/big", "vendor/big:free"]) {
      const t1 = st({ name: "m", model, tier: "t1" }, [good(model, "e90", 1, 5)]);
      expect(t1.perEpisode.e90!.target).toBe(3);
      expect(t1.tier).toBe("t2");
      expect(t1.perEpisode.e360!.target).toBe(1);
      expect(st({ name: "m", model, tier: "t0" }, []).perEpisode.e90!.target).toBe(1);
    }
    // A tier that buys no e360 is not eligible for one: the target and the
    // eligibility are one statement, so `promoted, 0/0` cannot be said again.
    const trial = st({ name: "p", model: "vendor/big", tier: "t0" }, [good("vendor/big", "e90", 1, 5)]);
    expect(trial.earnedPromotion).toBe(true);
    expect(trial.tier).toBe("t0");
    expect(trial.eligible).toEqual(["e90"]);
    expect(trial.perEpisode.e360!.target).toBe(0);
    expect(trial.status).not.toBe("promoted");
    // And the witness it kept is what makes the move to t1 free: same runs, and
    // it lands on t2 immediately without re-running anything.
    const moved = st({ name: "p", model: "vendor/big", tier: "t1" }, [good("vendor/big", "e90", 1, 5)]);
    expect(moved.tier).toBe("t2");
    expect(moved.status).toBe("promoted");
    const met = st({ name: "p", model: "vendor/big", tier: "t0" }, [good("vendor/big", "e90", 1)]);
    // Free, not blocked: it owes nothing and its idle axis buys nothing either.
    expect(schedulability(met, new Set(), policy).verdict).toBe("free");
    expect(wantsIdle(schedulability(met, new Set(), policy), met)).toBe(false);
    expect(planNextJobs([met], ["R1"], new Set(), { policy })).toEqual({ jobs: [], held: [] });
  });

  test("effectiveTier: t0 holds the ladder, t1 climbs a rung per witness, a declared t2 or t3 is a pin (operator, 2026-11-20)", () => {
    const all = { promotion: true, deadmines: true };
    expect(effectiveTier("t0", all)).toBe("t0");
    expect(effectiveTier("t1", { promotion: false, deadmines: false })).toBe("t1");
    expect(effectiveTier("t1", { promotion: true, deadmines: false })).toBe("t2");
    expect(effectiveTier("t1", all)).toBe("t3");
    // Rung by rung: the e360 witness alone does not skip the e90 one.
    expect(effectiveTier("t1", { promotion: false, deadmines: true })).toBe("t1");
    expect(effectiveTier("t2", all)).toBe("t2");
    expect(effectiveTier("t3", all)).toBe("t3");
    expect(TIER_TABLE[effectiveTier("t1", all)].promotesTo).toBeNull();
    // t2 buys the e360 and no Deadmines; t3 buys both.
    expect(TIER_TABLE.t2.runsPerEpisode).toEqual({ e90: 3, e360: 1, deadmines: 0, "deadmines-solo": 0 });
    expect(TIER_TABLE.t3.runsPerEpisode).toEqual({ e90: 3, e360: 1, deadmines: 3, "deadmines-solo": 3 });
  });

  test("a refused scored launch leaves the projection as it was, so an open gate re-picks it every tick; a closed one holds it and says why", () => {
    const owing = st({ name: "o", model: "v/owing", tier: "t1", idle: "unlimited" }, []);
    // run.ts refuses the launch before a run directory exists: no fact, so the
    // next tick's projection is this one, and the pick is the same pick.
    const first = planNextJobs([owing], ["R1"], new Set(), { policy });
    expect(first.jobs.map((j) => [j.name, j.episode])).toEqual([["o", "e90"]]);
    expect(planNextJobs([owing], ["R1"], new Set(), { policy }).jobs).toEqual(first.jobs);
    // Closed: held with the reason, and the model does what one owing nothing does.
    const gate = "scored episodes are held for this test";
    const closed = planNextJobs([owing], ["R1"], new Set(), { policy, scoredGate: gate });
    expect(closed.held).toEqual([{ name: "o", episode: "e90", why: gate }]);
    expect(closed.jobs.map((j) => [j.name, j.episode])).toEqual([["o", "freeplay"]]);
    // A model that owes nothing is not held by it.
    const quiet = st({ name: "q", model: "v/quiet", tier: "t0" }, [good("v/quiet", "e90", 1)]);
    expect(planNextJobs([quiet], ["R1"], new Set(), { policy, scoredGate: gate })).toEqual({ jobs: [], held: [] });
  });

  test("one pool: paid, free and local picks all draw from it, in priority order; a reserved pool says why", () => {
    const p1 = st({ name: "p1", model: "v/one" }, []);
    const l1 = st({ name: "l1", model: "qwen/q", apiBase: "http://192.168.100.20:1234/v1" }, []);
    const f1 = st({ name: "f1", model: "v/three:free" }, []);
    // Which credential carries a pick, and whether it has a slot, is the
    // caller's (`planPolicyHeld`); the projection only hands out accounts.
    const plan = planNextJobs([p1, l1, f1], ["R1", "R2", "R3"], new Set(), { policy });
    expect(plan.jobs.map((j) => [j.name, j.account])).toEqual([
      ["p1", "R1"],
      ["l1", "R2"],
      ["f1", "R3"],
    ]);
    expect(plan.held).toEqual([]);
    // Fewer accounts than picks: the rest wait in silence, as a busy pool always has.
    expect(planNextJobs([p1, l1, f1], ["R1"], new Set(), { policy }).jobs.map((j) => j.name)).toEqual(["p1"]);
    // A pool a waiting manual job reserves names the reservation.
    const reserved = planNextJobs([p1], [], new Set(), { policy, poolHeld: "pool reserved for waiting manual job(s): q-e90" });
    expect(reserved.held).toEqual([{ name: "p1", episode: "e90", why: "pool reserved for waiting manual job(s): q-e90" }]);
  });

  test("the evals group off: no scored pick, and an unlimited model owing evidence gets its freeplay session", () => {
    const owes = st({ name: "u1", model: "v/u", idle: "unlimited" }, []);
    const none = st({ name: "n1", model: "v/n" }, []);
    // On: both owe an e90, and that is what they get.
    expect(planNextJobs([owes, none], ["R1", "R2"], new Set(), { policy }).jobs.map((j) => [j.name, j.episode])).toEqual([
      ["u1", "e90"],
      ["n1", "e90"],
    ]);
    // Off: nothing scored, the unlimited one plays freeplay, the other idles.
    const off = planNextJobs([owes, none], ["R1", "R2"], new Set(), { policy, evals: false });
    expect(off.jobs.map((j) => [j.name, j.episode, j.account])).toEqual([["u1", "freeplay", "R1"]]);
    // The counts are untouched: owing is a fact about the runs, not the group.
    expect(owes.perEpisode.e90!.counted).toBe(0);
  });

  test("idle: unlimited — one freeplay session at a time, on a pool account, never counted", () => {
    const local = { name: "l1", model: "qwen/q", apiBase: "http://10.0.0.5:1234/v1", idle: "unlimited" as const };
    // Targets met on e90 only: unpromoted (no counted run reached L5), so e360 is not open.
    // A local box's runs stamp no routing: nothing to state on one machine.
    const onBox = (f: RunFact): RunFact => {
      const { routing: _none, ...rest } = f;
      return rest;
    };
    const met = st(local, [good("qwen/q", "e90", 1, 3), good("qwen/q", "e90", 2, 4), good("qwen/q", "e90", 3, 2)].map(onBox));
    expect(met.eligible).toEqual(["e90"]);
    const v = schedulability(met, new Set(), policy);
    expect(v.verdict).toBe("free");
    expect(wantsIdle(v, met)).toBe(true);
    expect(v.why).toContain("unlimited sessions");
    const plan = planNextJobs([met], ["R1"], new Set(), { policy });
    expect(plan.jobs.map((j) => [j.name, j.episode, j.account])).toEqual([["l1", "freeplay", "R1"]]);
    expect(plan.jobs[0]!.why).toContain("unlimited session");
    // One at a time: a running model is not picked again.
    expect(planNextJobs([met], ["R1"], new Set(["l1"]), { policy }).jobs).toEqual([]);
    // Freeplay runs are attempts, never counted, and they number the next one.
    const after = st(local, [
      good("qwen/q", "e90", 1, 3),
      good("qwen/q", "e90", 2, 4),
      good("qwen/q", "e90", 3, 2),
      good("qwen/q", "freeplay", 4, 5, true),
    ].map(onBox));
    expect(after.perEpisode.freeplay).toMatchObject({ counted: 0, attempts: 1, extras: 1, target: 0 });
    expect(after.perEpisode.e90!.counted).toBe(3);
    expect(after.eligible).toEqual(["e90"]);
    const next = planNextJobs([after], ["R1"], new Set(), { policy }).jobs[0]!;
    expect(next).toMatchObject({ episode: "freeplay", attempt: 2, account: "R1" });
    expect(next.why).toContain("extra #2");
    // A new harness series re-arms the scheduled runs first, freeplay after.
    const series = { ...policy, series: "0.5" };
    const rearmed = st(local, [good("qwen/q", "e90", 1, 3), good("qwen/q", "freeplay", 2, 5, true)], series);
    expect(rearmed.perEpisode.e90).toMatchObject({ counted: 0, otherSeries: 1 });
    expect(planNextJobs([rearmed], ["R1"], new Set(), { policy: series }).jobs[0]).toMatchObject({
      episode: "e90",
      account: "R1",
    });
    // The axis is per model, so a non-local model may take unlimited sessions too.
    const pooled = st({ name: "f1", model: "v/f:free", idle: "unlimited" }, [good("v/f:free", "e90", 1, 3), good("v/f:free", "e90", 2), good("v/f:free", "e90", 3)]);
    expect(planNextJobs([pooled], ["R1"], new Set(), { policy }).jobs[0]).toMatchObject({ episode: "freeplay", account: "R1" });
  });
});

describe("outstandingWork", () => {
  const good = (model: string, ep: EpisodeId, i: number, level = 3): RunFact => ({
    runId: `${model}-${ep}-${i}`,
    model,
    effort: null,
    ...launchRouting(model),
    episode: ep,
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: NOW - (100 - i) * HOUR,
    endedAt: NOW - (99 - i) * HOUR,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
  });
  const policy: SchedulingPolicy = { ...DEFAULT_POLICY };
  const st = (r: Omit<RosterModel, "tier"> & { tier?: RosterModel["tier"] }, runs: RunFact[]): ModelState =>
    projectModel({ tier: "t1", ...r }, runs, policy, { now: NOW });

  // One of each thing the metric has to tell apart: a model that climbed (owes
  // e360 now), one that has not (owes it only in the upper bound), a paid one
  // (its own credential's slot), a local one (the box's one-slot credential),
  // one placed on t2 by hand (eligible without a witness), a claude-code one
  // (two credential slots under a host cap of one), and a pinned one that
  // owes runs nobody schedules.
  const promoted = st({ name: "promoted", model: "v/promoted:free" }, [1, 2, 3].map((i) => good("v/promoted:free", "e90", i, 5)));
  const unpromoted = st({ name: "unpromoted", model: "v/unpromoted:free" }, [good("v/unpromoted:free", "e90", 1)]);
  const paid = st({ name: "paid", model: "vendor/paid" }, []);
  const local = st({ name: "local", model: "vendor/local", apiBase: "http://192.168.100.20:1234/v1" }, []);
  const forced = st({ name: "forced", model: "v/forced:free", tier: "t2" }, []);
  const cc = st({ name: "cc", model: "opus", driver: "claude-code" }, []);
  const pinned = st({ name: "pinned", model: "v/pinned:free" }, []);
  const states = [promoted, unpromoted, paid, local, forced, cc, pinned];
  const credentials = parseCredentials({
    "or-free": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 3, billing: "free", enabled: true },
    "or-paid": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, billing: "paid", enabled: true },
    box: { provider: "local", secretEnv: "LMSTUDIO_KEY", slots: 1, billing: "free", enabled: true },
    "claude-1": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN", slots: 1, billing: "paid", enabled: true },
    "claude-2": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", slots: 1, billing: "paid", enabled: true },
    "claude-3": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_3", slots: 4, billing: "paid", enabled: false },
  });
  const input = {
    states,
    excluded: ["pinned"],
    accounts: 5,
    credentials,
    maxSessions: { "claude-code": 1 },
  };

  test("bounds: promotion is the only unknown, and extras and excluded models are not work", () => {
    const o = outstandingWork(input);
    // lower: promoted 1xe360, unpromoted 2xe90, forced 3xe90 + 1xe360, cc 3xe90, paid 3xe90, local 3xe90.
    expect(o.lower).toBe(16);
    // upper adds the e360 a climb would buy, for everyone who could still climb:
    // unpromoted, cc, local, paid — one each, because t2 buys one e360.
    expect(o.upper).toBe(20);
    expect(o.upper).toBeGreaterThanOrEqual(o.lower);
    // The pinned model owes 3 e90 runs and contributes none of them.
    expect(pinned.perEpisode.e90!.target - pinned.perEpisode.e90!.counted).toBe(3);
    expect(outstandingWork({ ...input, excluded: [] }).lower).toBe(19);
    // A retired model is not work either, however much it still owes.
    const dead = { ...pinned, name: "dead", retired: { at: NOW, reason: "gave up" } };
    expect(outstandingWork({ ...input, states: [...states, dead] }).lower).toBe(16);
    // A t0 model's ladder is held, so the upper bound makes no bet on it:
    // a trial is one run, and the metric says so rather than hinting at four.
    const trial = st({ name: "trial", model: "v/trial:free", tier: "t0" }, []);
    const t = outstandingWork({ states: [trial], accounts: 1, credentials });
    expect(t).toMatchObject({ lower: 1, upper: 1 });
  });
});

describe("the policy block", () => {
  test("maxSessions caps a driver's host sessions; the retired knobs are refused by name", () => {
    expect(parsePolicyBlock(undefined).maxSessions).toEqual({});
    expect(parsePolicyBlock({ maxSessions: { "claude-code": 2, codex: 1 } }).maxSessions).toEqual({ "claude-code": 2, codex: 1 });
    expect(() => parsePolicyBlock({ maxSessions: { warp: 1 } })).toThrow(/warp is not a driver/);
    expect(() => parsePolicyBlock({ maxSessions: { reference: 1 } })).toThrow(/not a driver/);
    expect(() => parsePolicyBlock({ maxSessions: { "claude-code": 0 } })).toThrow(/positive integer/);
    expect(() => parsePolicyBlock({ maxConcurrent: { openrouter: 1 } })).toThrow(/credentials\/<id>.slots/);
    expect(() => parsePolicyBlock({ paid: { maxConcurrent: 1 } })).toThrow(/paid credentials/);
    expect(() => parsePolicyBlock({ subscriptions: ["CLAUDE_CODE_OAUTH_TOKEN"] })).toThrow(/each subscription is a credential/);
  });
});

describe("a run's credential", () => {
  test("a live or paused run's own credential is read back off the run, so a restart does not lose it", () => {
    const fact = (over: Partial<RunFact>): RunFact => ({
      runId: "r",
      model: "opus",
      effort: null,
      episode: "e90",
      episodeOverride: false,
      harnessVersion: null,
      harnessSeries: null,
      loop: "program",
      yield: true,
      extra: false,
      startedAt: 0,
      endedAt: null,
      terminationReason: null,
      modelResponses: 1,
      bestLevel: 1,
      live: true,
      pause: null,
      account: null,
      character: null,
      episodeMs: null,
      campaign: null,
      cell: null,
      credential: null,
      ...over,
    });
    const roster = [
      { name: "sub-opus", model: "opus", driver: "claude-code" },
      { name: "sub-opus-low", model: "opus", effort: "low", driver: "claude-code" },
      { name: "sonnet", model: "sonnet", driver: "claude-code" },
    ];
    const creds = liveCredentials(
      [
        fact({ runId: "a", credential: "claude-2" }),
        // Same model, different effort: a different entry, and its own credential.
        fact({ runId: "b", effort: "low", credential: "claude-1" }),
        // A paused run still holds its credential — it is resumed onto that one.
        fact({ runId: "c", model: "sonnet", live: false, pause: { reason: "quota-exhausted", at: 1, count: 1, episodeElapsedMs: null }, credential: "claude-2" }),
        // A finished run holds nothing.
        fact({ runId: "d", model: "sonnet", live: false, terminationReason: "episode-limit", credential: "claude-1" }),
      ],
      roster,
    );
    expect(creds.get("sub-opus")).toBe("claude-2");
    expect(creds.get("sub-opus-low")).toBe("claude-1");
    expect(creds.get("sonnet")).toBe("claude-2");
    // A run that recorded none (0.5, or launched by hand) says nothing.
    expect(liveCredentials([fact({})], roster).size).toBe(0);
  });
});

describe("probe campaigns in the schedule", () => {
  const NOW2 = 1_800_000_000_000;
  const H = 3_600_000;
  const done = (model: string, ep: EpisodeId, i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `${model}-${ep}-${i}`,
    model,
    effort: null,
    ...launchRouting(model, over.effort),
    episode: ep,
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: NOW2 - (100 - i) * H,
    endedAt: NOW2 - (99 - i) * H,
    terminationReason: "episode-limit",
    modelResponses: 20,
    bestLevel: 3,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  });
  /** A model on t0 whose single e90 is done: owes nothing, so it is `free`. */
  const spent = (name: string): ModelState =>
    projectModel({ name, model: name, tier: "t0" }, [done(name, "e90", 1)], DEFAULT_POLICY, { now: NOW2 });
  /** A model on t1 with nothing run: still owes evidence. */
  const owing = (name: string): ModelState =>
    projectModel({ name, model: name, tier: "t1" }, [], DEFAULT_POLICY, { now: NOW2 });

  const campaign: Campaign = joined(
    [
      definition({
        id: "class-probe",
        version: 2,
        cells: [
          { id: "human-warrior", race: 1, class: 1 },
          { id: "dwarf-rogue", race: 3, class: 4 },
        ],
        resume: false,
        maxAttemptsPerCell: null,
      }),
    ],
    { "class-probe": { version: 2, assignments: [{ model: "a" }, { model: "b" }] } },
  ).campaigns[0]!;
  const probeRun = (cell: string): ProbeRun => ({ campaign: "class-probe", version: 2, cell, ref: "a", arm: "base", counted: true, live: false });

  test("a probe-only driver's entry owes nothing, wants no idle work, and runs only as a campaign's square", () => {
    // pi until the operator promotes it (operator, 2026-10-20): a tier and an
    // idle axis that would schedule anything else buy it nothing.
    const pi = projectModel({ name: "a", model: "deepseek-flash", driver: "pi", tier: "t2", idle: "unlimited" }, [], DEFAULT_POLICY, { now: NOW2 });
    expect(pi).toMatchObject({ probeOnly: true, eligible: [], idle: "none", harness: "pi" });
    expect(pi.perEpisode.e90!.target).toBe(0);
    expect(pi.perEpisode.e360!.target).toBe(0);
    const v = schedulability(pi);
    expect(v.verdict).toBe("free");
    expect(v.why).toContain("driver pi is probe-only");
    expect(wantsIdle(v, pi)).toBe(false);
    expect(planNextJobs([pi], ["R1"], new Set()).jobs).toEqual([]);
    const plan = planNextJobs([pi], ["R1"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.map((j) => ({ episode: j.episode, probe: j.probe?.campaign }))).toEqual([{ episode: "probing", probe: "class-probe" }]);
  });

  test("a campaignOnly entry owes nothing on any driver, and three of them, one arm each, take their squares at once", () => {
    const img = "reg.example/wrathbench/wrathbench-runner:probe-x-0123456789ab";
    const arms = [
      { id: "snippet", image: img },
      { id: "program", image: img, args: ["--loop", "program"] },
      { id: "program-yield", image: img, args: ["--loop", "program", "--yield", "true"] },
    ];
    const probe = joined(
      [definition({ id: "program-probe", version: 1, cells: [{ id: "human-paladin", race: 1, class: 2 }], arms, resume: false, maxAttemptsPerCell: 3 })],
      {
        "program-probe": {
          version: 1,
          assignments: [
            { model: "ds-snippet", arms: ["snippet"] },
            { model: "ds-program", arms: ["program"] },
            { model: "ds-yield", arms: ["program-yield"] },
          ],
        },
      },
    ).campaigns[0]!;
    const entry = (name: string): ModelState =>
      projectModel({ name, model: "deepseek/deepseek-v4.1-flash", tier: "t0", campaignOnly: true }, [], DEFAULT_POLICY, { now: NOW2 });
    const states = ["ds-snippet", "ds-program", "ds-yield"].map(entry);
    expect(states[0]).toMatchObject({ probeOnly: true, campaignOnly: true, eligible: [], idle: "none", harness: "wrathbench" });
    expect(states[0]!.perEpisode.e90!.target).toBe(0);
    const v = schedulability(states[0]!);
    expect(v).toEqual({ verdict: "free", why: "campaignOnly: it runs only as a probe campaign's assignment" });
    expect(wantsIdle(v, states[0]!)).toBe(false);
    // Nothing scored is bought: no campaign, no job.
    expect(planNextJobs(states, ["R1", "R2", "R3"], new Set()).jobs).toEqual([]);
    const plan = planNextJobs(states, ["R1", "R2", "R3"], new Set(), { campaigns: [probe] });
    expect(plan.jobs.map((j) => [j.name, j.episode, j.probe?.arm, j.account])).toEqual([
      ["ds-snippet", "probing", "snippet", "R1"],
      ["ds-program", "probing", "program", "R2"],
      ["ds-yield", "probing", "program-yield", "R3"],
    ]);
    // The same entries without the flag owe their t0 e90 first: one model, so
    // one e90 toward its one target, by the first entry (operator, 2026-11-16).
    const scored = ["ds-snippet", "ds-program", "ds-yield"].map((name) => projectModel({ name, model: "deepseek/deepseek-v4.1-flash", tier: "t0" }, [], DEFAULT_POLICY, { now: NOW2 }));
    expect(planNextJobs(scored, ["R1", "R2", "R3"], new Set(), { campaigns: [probe] }).jobs.map((j) => [j.name, j.episode])).toEqual([["ds-snippet", "e90"]]);
  });

  test("a campaignOnly entry with idle unlimited plays freeplay and nothing scored; a probe-only driver's still plays nothing", () => {
    const held = projectModel({ name: "held", model: "deepseek/deepseek-v4.1-flash", tier: "t2", idle: "unlimited", campaignOnly: true }, [], DEFAULT_POLICY, { now: NOW2 });
    expect(held).toMatchObject({ probeOnly: true, campaignOnly: true, eligible: [], idle: "unlimited" });
    const v = schedulability(held);
    // Free, with no scored hold reason: no "targets met", no Deadmines wait.
    expect(v).toEqual({ verdict: "free", why: "campaignOnly: no scored runs — unlimited sessions while its account is idle" });
    expect(wantsIdle(v, held)).toBe(true);
    const plan = planNextJobs([held], ["R1", "R2"], new Set());
    expect(plan.jobs.map((j) => [j.name, j.episode, j.account, j.why])).toEqual([
      ["held", "freeplay", "R1", "extra #1: unlimited session (campaignOnly: no targets; one continuous session, idle watchdog only)"],
    ]);
    expect(plan.held).toEqual([]);
    // Unchanged: a probe-only driver's entry, campaignOnly or not, has no idle work.
    for (const campaignOnly of [undefined, true] as const) {
      const pi = projectModel({ name: "pi", model: "deepseek/deepseek-v4.1-flash", driver: "pi", tier: "t1", idle: "unlimited", ...(campaignOnly ? { campaignOnly } : {}) }, [], DEFAULT_POLICY, { now: NOW2 });
      expect(pi.idle).toBe("none");
      expect(wantsIdle(schedulability(pi), pi)).toBe(false);
      expect(planNextJobs([pi], ["R1"], new Set()).jobs).toEqual([]);
    }
  });

  test("a pi entry and a wrathbench entry of one model and effort, no window on either, never take each other's runs", () => {
    const ds = { name: "ds", model: "deepseek-flash", effort: "high", tier: "t1" as const };
    const pi = { name: "ds-pi", model: "deepseek-flash", effort: "high", driver: "pi", tier: "t1" as const };
    const scored = done("deepseek-flash", "e90", 1, { effort: "high", driver: "openai", bestLevel: 5 });
    const paused = done("deepseek-flash", "e90", 2, { effort: "high", driver: "openai", endedAt: null, terminationReason: null, pause: { reason: "rate-limited", at: NOW2 - 1000, count: 1, episodeElapsedMs: 1000 } });
    // A hand-launched pi probe that recorded no ref: matched by identity.
    const probe = done("deepseek-flash", "probing", 3, { effort: "high", driver: "pi", campaign: "pi-vs", cell: "c", endedAt: null, terminationReason: null, pause: { reason: "rate-limited", at: NOW2 - 500, count: 1, episodeElapsedMs: 1000 } });
    const runs = [scored, paused, probe];
    const piState = projectModel(pi, runs, DEFAULT_POLICY, { now: NOW2 });
    const dsState = projectModel(ds, runs, DEFAULT_POLICY, { now: NOW2 });
    // The scored wrathbench e90 is wrathbench's; the pi entry counts nothing of it.
    expect(dsState.perEpisode.e90!.counted).toBe(1);
    expect(piState.perEpisode.e90!.attempts).toBe(0);
    // A paused wrathbench run holds wrathbench only, and the pi probe holds pi only.
    expect(dsState.paused?.runId).toBe(paused.runId);
    expect(piState.paused?.runId).toBe(probe.runId);
    expect(dsState.perEpisode.probing!.attempts).toBe(0);
    // The viewer's row is the same match.
    expect(rowOf(piState, runs, "/nowhere").runs.map((r) => r.runId)).toEqual([probe.runId]);
    expect(rowOf(dsState, runs, "/nowhere").runs.map((r) => r.runId).sort()).toEqual([scored.runId, paused.runId].sort());
    // And the identity itself, both ways; an old run with no driver is the default driver's.
    expect(entryOwnsRun({ model: "m", driver: "pi" }, { model: "m" })).toBe(false);
    expect(entryOwnsRun({ model: "m" }, { model: "m", driver: "pi" })).toBe(false);
    expect(entryOwnsRun({ model: "m", harness: "pi" }, { model: "m", driver: "pi" })).toBe(true);
    expect(entryOwnsRun({ model: "m", driver: null }, { model: "m", harness: "wrathbench" })).toBe(true);
    // Only the probe-only bit: another two harnesses still match as they always did.
    expect(entryOwnsRun({ model: "m", driver: "codex" }, { model: "m", driver: "openai" })).toBe(true);
  });

  test("a model that owes nothing takes a probe, stamped with its campaign and cell", () => {
    const plan = planNextJobs([spent("a")], ["R1"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.length).toBe(1);
    expect(plan.jobs[0]).toMatchObject({
      name: "a",
      episode: "probing",
      account: "R1",
      probe: { campaign: "class-probe", version: 2, cell: "human-warrior", arm: "base" },
    });
    expect(plan.jobs[0]!.why).toContain("campaign class-probe@2 cell human-warrior arm base (0/1)");
  });

  test("an eval outranks a probe for the same free account", () => {
    // One account, one model owing and one spent: the owed run wins, and the
    // probe simply does not happen this tick.
    const plan = planNextJobs([spent("a"), owing("b")], ["R1"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.map((j) => [j.name, j.episode])).toEqual([["b", "e90"]]);
  });

  test("with two accounts the eval and the probe both go, eval first", () => {
    const plan = planNextJobs([spent("a"), owing("b")], ["R1", "R2"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.map((j) => j.name)).toEqual(["b", "a"]);
    expect(plan.jobs[0]!.episode).toBe("e90");
    expect(plan.jobs[1]!.episode).toBe("probing");
  });

  test("a probe outranks idle work for the same account", () => {
    // `spent` with an idle axis wants both a probe and an extra; the probe wins,
    // because commissioned work is worth more than filling a spare account.
    const idle = projectModel(
      { name: "a", model: "a", tier: "t0", idle: "unlimited" },
      [done("a", "e90", 1)],
      DEFAULT_POLICY,
      { now: NOW2 },
    );
    const plan = planNextJobs([idle], ["R1"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.length).toBe(1);
    expect(plan.jobs[0]!.episode).toBe("probing");
  });

  test("idle work still happens when the campaign has nothing left", () => {
    const idle = projectModel(
      { name: "a", model: "a", tier: "t0", idle: "unlimited" },
      [done("a", "e90", 1)],
      DEFAULT_POLICY,
      { now: NOW2 },
    );
    const plan = planNextJobs([idle], ["R1"], new Set(), {
      campaigns: [{ ...campaign, enabled: false }],
    });
    expect(plan.jobs[0]!.episode).toBe("freeplay");
  });

  test("a completed cell is not re-run, and the next cell is taken instead", () => {
    const probeRuns = [probeRun("human-warrior")];
    const plan = planNextJobs([spent("a")], ["R1"], new Set(), { campaigns: [campaign], probeRuns });
    expect(plan.jobs[0]!.probe).toEqual({ campaign: "class-probe", version: 2, cell: "dwarf-rogue", arm: "base" });
  });

  test("a campaign with every cell done schedules nothing at all", () => {
    const probeRuns = [probeRun("human-warrior"), probeRun("dwarf-rogue")];
    expect(planNextJobs([spent("a")], ["R1"], new Set(), { campaigns: [campaign], probeRuns }).jobs).toEqual([]);
  });

  test("excludeUnhealthy: false widens the work list, never the schedule", () => {
    // The one configuration where the loop's own verdict check is load-bearing:
    // with the fan-out told not to filter, a cooling model reaches the loop and
    // must still be refused there. `enabled: false` on a campaign says "stop
    // scheduling"; `excludeUnhealthy: false` says "do not skip a model for being
    // unhealthy" — neither is licence to launch onto a backing-off endpoint.
    const cooling = projectModel(
      { name: "a", model: "a", tier: "t0" },
      [done("a", "e90", 1, { modelResponses: 0, terminationReason: "adapter-error", endedAt: NOW2 - 1000 })],
      DEFAULT_POLICY,
      { now: NOW2 },
    );
    expect(schedulability(cooling).verdict).toBe("blocked");
    const wide = { ...campaign, excludeUnhealthy: false };
    expect(planNextJobs([cooling], ["R1"], new Set(), { campaigns: [wide] }).jobs).toEqual([]);
  });

  test("one job per model: a model cannot take two cells in one tick", () => {
    const plan = planNextJobs([spent("a")], ["R1", "R2"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.length).toBe(1);
  });
});

describe("the claude-code compaction window is part of an entry's identity", () => {
  // Operator decision 2026-10-09: a 100k copy of an `auto` entry is its own
  // row. Matched on model + effort alone it would inherit the auto entry's
  // runs, read its e360 as already done, and never be scheduled.
  const NOW3 = 1_800_000_000_000;
  const H = 3_600_000;
  const run = (i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `haiku-e360-${i}`,
    model: "claude-haiku-5-5",
    effort: "max",
    episode: "e360",
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: NOW3 - (100 - i) * H,
    endedAt: NOW3 - (99 - i) * H,
    terminationReason: "episode-limit",
    modelResponses: 20,
    bestLevel: 5,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  });
  const auto: RosterModel = { name: "haiku-max", model: "claude-haiku-5-5", effort: "max", driver: "claude-code", tier: "t2" };
  const small: RosterModel = { ...auto, name: "haiku-max-c100k", compactWindow: "100k" };

  test("each entry owns only the runs stamped with its own window", () => {
    const runs = [run(1), run(2, { compactWindow: "100k" }), run(3, { compactWindow: null })];
    const a = projectModel(auto, runs, DEFAULT_POLICY, { now: NOW3 });
    const s = projectModel(small, runs, DEFAULT_POLICY, { now: NOW3 });
    // Absent and null are both `auto`: runs 1 and 3 are the auto entry's.
    expect(a.perEpisode.e360!.attempts).toBe(2);
    expect(s.perEpisode.e360!.attempts).toBe(1);
    expect(s.compactWindow).toBe("100k");
    expect(a.compactWindow).toBeUndefined();
    // With no run of its own, the copy still owes its evidence.
    expect(projectModel(small, [run(1)], DEFAULT_POLICY, { now: NOW3 }).perEpisode.e360?.attempts ?? 0).toBe(0);
  });

  test("a probe whose arm set the window is the entry's it ran as, by its stamp; a windowed entry's runs stay its own", () => {
    const astra: RosterModel = { name: "astra", model: "gpt-6-astra", effort: "high", driver: "codex", tier: "t1" };
    const astra200: RosterModel = { ...astra, name: "astra-200k", compactWindow: "200k" };
    const probe = (i: number, arm: string, window: string | undefined, over: Partial<RunFact> = {}): RunFact =>
      run(i, {
        model: "gpt-6-astra",
        effort: "high",
        episode: "probing",
        campaign: "compact-window",
        campaignVersion: 1,
        cell: "a",
        ref: "astra",
        arm,
        ...(window !== undefined ? { compactWindow: window } : {}),
        ...over,
      });
    const runs = [probe(1, "auto", undefined), probe(2, "w200k", "200k"), probe(3, "w300k", "300k", { live: true, terminationReason: null, endedAt: null, credential: "chatgpt-2" })];
    // Every arm's run is the entry's: the arm's window is not the entry's identity.
    expect(projectModel(astra, runs, DEFAULT_POLICY, { now: NOW3 }).perEpisode.probing!.attempts).toBe(3);
    // Not a windowed copy's, whose identity the 200k arm's run shares: the
    // stamp names the entry it ran as.
    expect(projectModel(astra200, runs, DEFAULT_POLICY, { now: NOW3 }).perEpisode.probing?.attempts ?? 0).toBe(0);
    // The copy's own probes are its, on its own window only.
    const own = [probe(5, "auto", "200k", { ref: "astra-200k" }), probe(6, "w300k", "300k", { ref: "astra-200k" })];
    expect(projectModel(astra200, own, DEFAULT_POLICY, { now: NOW3 }).perEpisode.probing!.attempts).toBe(1);
    // The live 300k arm's credential is the entry's, so a restart sees its slot taken.
    expect(liveCredentials(runs, [astra, astra200]).get("astra")).toBe("chatgpt-2");
    // A run with no roster stamp still matches by identity alone.
    expect(projectModel(astra, [probe(4, "w200k", "200k", { ref: null })], DEFAULT_POLICY, { now: NOW3 }).perEpisode.probing?.attempts ?? 0).toBe(0);
    expect(projectModel(astra200, [probe(4, "w200k", "200k", { ref: null })], DEFAULT_POLICY, { now: NOW3 }).perEpisode.probing!.attempts).toBe(1);
  });

  test("a run's window is read off its tuple, then its config, and absent stays absent", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-window-facts-"));
    try {
      const write = (runId: string, meta: Record<string, unknown>) => {
        mkdirSync(join(runsDir, runId), { recursive: true });
        writeFileSync(join(runsDir, runId, "meta.json"), JSON.stringify({ harnessVersion: "harness-0.5-1", startedAt: NOW3, ...meta }));
      };
      write("run-a", { config: { model: "m", effort: "max" }, comparability: { episode: "e360", effort: "max" } });
      write("run-b", { config: { model: "m", effort: "max", compactWindow: "100k" }, comparability: { episode: "e360", effort: "max", compactWindow: "100k" } });
      const facts = new Map(readRunFacts(runsDir, NOW3).map((f) => [f.runId, f]));
      expect(facts.get("run-a")!.compactWindow).toBeUndefined();
      expect(facts.get("run-b")!.compactWindow).toBe("100k");
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("entryOwnsRun reads absent and null alike, and nothing else", () => {
    expect(entryOwnsRun({ model: "m", effort: "max" }, { model: "m", effort: "max", compactWindow: null })).toBe(true);
    expect(entryOwnsRun({ model: "m", effort: "max" }, { model: "m", effort: "max", compactWindow: "100k" })).toBe(false);
    expect(entryOwnsRun({ model: "m", compactWindow: "1M" }, { model: "m", compactWindow: "1M" })).toBe(true);
    expect(entryOwnsRun({ model: "m", effort: "low" }, { model: "m", effort: "max" })).toBe(false);
  });
});

describe("claude-code defaults its compaction window to 300k (operator, 2026-11-10)", () => {
  // The entry did not change when its driver's default did, so the runs it
  // launched on `auto` stay its own beside the 300k runs it launches now. An
  // entry that owned only its 300k runs would read every met target as unmet
  // and relaunch it, and the supervisor would end its paused `auto` run as
  // "no longer under this ref".
  const NOW4 = 1_800_000_000_000;
  const H = 3_600_000;
  const run = (i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `sonnet-e90-${i}`,
    model: "claude-sonnet-5-5",
    effort: null,
    driver: "claude-code",
    episode: "e90",
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    loop: "program",
    yield: true,
    extra: false,
    startedAt: NOW4 - (100 - i) * H,
    endedAt: NOW4 - (99 - i) * H,
    terminationReason: "episode-limit",
    modelResponses: 20,
    bestLevel: 6,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  });
  const plain: RosterModel = { name: "sub-sonnet-55", model: "claude-sonnet-5-5", driver: "claude-code", tier: "t1" };
  const optOut: RosterModel = { ...plain, name: "sub-sonnet-55-auto", compactWindow: "auto" };
  const stated: RosterModel = { ...plain, name: "sub-sonnet-55-300k", compactWindow: "300k" };

  test("an entry with no window keeps the runs it made on auto: its met targets stay met", () => {
    const past = [run(1), run(2), run(3)];
    const st = projectModel(plain, past, DEFAULT_POLICY, { now: NOW4 });
    expect(st.perEpisode.e90!.counted).toBe(3);
    expect(st.perEpisode.e90!.target).toBe(3);
    expect(schedulability(st).why).not.toContain("e90");
    // The control: an entry that owned only 300k runs would owe all three again.
    const owing = projectModel(stated, past, DEFAULT_POLICY, { now: NOW4 });
    expect(owing.perEpisode.e90!.counted).toBe(0);
    expect(schedulability(owing)).toMatchObject({ verdict: "eval", why: "schedulable on e90" });
    // And it owns what it launches now, so a later run is not an orphan it would launch again.
    const mixed = [run(1), run(2), run(3, { compactWindow: "300k" })];
    expect(projectModel(plain, mixed, DEFAULT_POLICY, { now: NOW4 }).perEpisode.e90!.counted).toBe(3);
  });

  test("a stated window owns exactly its runs: `auto` the auto runs, 300k the 300k runs", () => {
    const runs = [run(1), run(2, { compactWindow: "300k" }), run(3, { compactWindow: "100k" })];
    expect(projectModel(optOut, runs, DEFAULT_POLICY, { now: NOW4 }).perEpisode.e90!.attempts).toBe(1);
    expect(projectModel(stated, runs, DEFAULT_POLICY, { now: NOW4 }).perEpisode.e90!.attempts).toBe(1);
    expect(projectModel(plain, runs, DEFAULT_POLICY, { now: NOW4 }).perEpisode.e90!.attempts).toBe(2);
    expect(entryOwnsWindow(optOut, "300k")).toBe(false);
    expect(entryOwnsWindow(stated, null)).toBe(false);
    expect(entryOwnsWindow(plain, "100k")).toBe(false);
    expect(ownedWindows(plain)).toEqual(["auto", "300k"]);
    expect(ownedWindows(optOut)).toEqual(["auto"]);
    expect(ownedWindows(stated)).toEqual(["300k"]);
  });

  test("the default is claude-code's alone: a codex entry with no window owns its auto runs only", () => {
    const codex = { model: "gpt-6-luna", driver: "codex" };
    expect(entryOwnsRun(codex, { model: "gpt-6-luna", driver: "codex", compactWindow: null })).toBe(true);
    expect(entryOwnsRun(codex, { model: "gpt-6-luna", driver: "codex", compactWindow: "300k" })).toBe(false);
    expect(ownedWindows(codex)).toEqual(["auto"]);
    // A projection that kept the harness tag and not the driver reads the same default.
    expect(entryOwnsRun({ model: "m", harness: "claude-code" }, { model: "m", driver: "claude-code", compactWindow: "300k" })).toBe(true);
    expect(entryOwnsRun({ model: "m", harness: "codex" }, { model: "m", driver: "codex", compactWindow: "300k" })).toBe(false);
  });

  test("a probe is still the entry's it ran as, whatever window its arm set; an opted-out entry's only on auto", () => {
    const probe = (i: number, window: string | null, ref: string): RunFact =>
      run(i, { episode: "probing", campaign: "compact-window-claude", campaignVersion: 3, cell: "a", arm: window ?? "auto", ref, compactWindow: window });
    const runs = [probe(1, null, "sub-sonnet-55"), probe(2, "100k", "sub-sonnet-55"), probe(3, "300k", "sub-sonnet-55")];
    expect(projectModel(plain, runs, DEFAULT_POLICY, { now: NOW4 }).perEpisode.probing!.attempts).toBe(3);
    const own = [probe(4, null, "sub-sonnet-55-auto"), probe(5, "300k", "sub-sonnet-55-auto")];
    expect(projectModel(optOut, own, DEFAULT_POLICY, { now: NOW4 }).perEpisode.probing!.attempts).toBe(1);
  });

  test("one key per entry for the places that group runs by model: auto and the driver's default are one", () => {
    expect(rosterWindowKey({ driver: "claude-code" })).toBe("");
    expect(rosterWindowKey({ driver: "claude-code", compactWindow: "300k" })).toBe("");
    expect(rosterWindowKey({ driver: "claude-code", compactWindow: "100k" })).toBe("100k");
    expect(rosterWindowKey({ driver: "codex", compactWindow: "300k" })).toBe("300k");
  });

  test("the viewer's row lists every run the count counted, and names the windows a link filters by", () => {
    const runs = [run(1), run(2, { compactWindow: "300k" })];
    const row = rowOf(projectModel(plain, runs, DEFAULT_POLICY, { now: NOW4 }), runs, "/nowhere");
    expect(row.runs.map((r) => r.runId).sort()).toEqual(["sonnet-e90-1", "sonnet-e90-2"]);
    expect(row.perEpisode.e90!.runIds.length).toBe(row.perEpisode.e90!.counted);
    expect(row.windows).toEqual(["auto", "300k"]);
    expect("compactWindow" in row).toBe(false);
    expect(rowOf(projectModel(optOut, runs, DEFAULT_POLICY, { now: NOW4 }), runs, "/nowhere")).toMatchObject({ compactWindow: "auto", windows: ["auto"] });
  });
});

describe("a target counts the runs of the loop its entry launches (operator, 2026-11-14)", () => {
  const NOW5 = 1_800_000_000_000;
  const done = (i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `loop-${i}`,
    model: "m",
    effort: null,
    ...launchRouting("m", over.effort),
    episode: "e90",
    episodeOverride: false,
    harnessVersion: "harness-0.5-1-gabc",
    harnessSeries: "0.5",
    extra: false,
    startedAt: NOW5 - (10 - i) * 3_600_000,
    endedAt: NOW5 - (9 - i) * 3_600_000,
    terminationReason: "episode-limit",
    modelResponses: 40,
    bestLevel: 4,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
    ...over,
  });
  const policy = { ...DEFAULT_POLICY, series: "0.5" };

  test("the rule: the loop and the yield each driver launches", () => {
    expect(countsTowardTarget({ loop: "program", yield: true }, { driver: "openai" })).toBe(true);
    expect(countsTowardTarget({ loop: "program" }, { driver: "openai" })).toBe(false);
    expect(countsTowardTarget({}, { driver: "openai" })).toBe(false);
    // codex launches with yield (operator, 2026-11-20): a run from before, without it, is another condition.
    expect(countsTowardTarget({ loop: "program", yield: true }, { driver: "codex" })).toBe(true);
    expect(countsTowardTarget({ loop: "program" }, { driver: "codex" })).toBe(false);
    expect(countsTowardTarget({ loop: "program", yield: true }, { driver: "claude-code" })).toBe(true);
    expect(countsTowardTarget({}, { driver: "claude-code" })).toBe(false);
    expect(countsTowardTarget({}, { driver: "pi" })).toBe(true);
    expect(countsTowardTarget({ loop: "program" }, { driver: "pi" })).toBe(false);
    // An entry with no driver is on the default one.
    expect(countsTowardTarget({ loop: "program", yield: true }, {})).toBe(true);
  });

  test("the wiki is the entry's condition too, and the routing is not: whichever provider ran it counts (operator, 2026-11-16)", () => {
    const program = { loop: "program" as const, yield: true as const };
    const glm = { driver: "openai" };
    // Wiki: a run without the reference wiki fills only an entry without it, and the reverse.
    expect(countsTowardTarget({ ...program, wiki: false }, glm)).toBe(false);
    expect(countsTowardTarget({ ...program, wiki: false }, { ...glm, wiki: false })).toBe(true);
    expect(countsTowardTarget(program, { ...glm, wiki: false })).toBe(false);
    // Routing: a pinned run, a Go run and a run stamped before routing was a key all count.
    const routed = (routing: object | undefined): Parameters<typeof countsTowardTarget>[0] => ({ ...program, ...(routing === undefined ? {} : { routing }) }) as Parameters<typeof countsTowardTarget>[0];
    expect(countsTowardTarget(routed(launchRouting("z-ai/glm-5.3").routing), glm)).toBe(true);
    expect(countsTowardTarget(routed({ ...OPENCODE_GO_ROUTING }), glm)).toBe(true);
    expect(countsTowardTarget(routed(undefined), glm)).toBe(true);
  });

  test("snippet-loop runs in the same series are attempts and history, never a copy of a program-loop run", () => {
    const entry: RosterModel = { name: "m", model: "m", tier: "t1" };
    const snippet = [done(1), done(2), done(3)];
    const st = projectModel(entry, snippet, policy, { now: NOW5 });
    expect(st.perEpisode.e90).toMatchObject({ attempts: 3, counted: 0, target: 3, bestLevel: 4 });
    const program = [...snippet, done(4, { loop: "program", yield: true })];
    expect(projectModel(entry, program, policy, { now: NOW5 }).perEpisode.e90).toMatchObject({ attempts: 4, counted: 1 });
  });
});

/*
 * The two thresholds (operator, 2026-11-15): a counted e90 at level 5 climbs
 * t1 to t2, which buys the e360; a counted e360 at level 8 opens the
 * Deadmines evals t2 buys. Each is read off counted runs only.
 */
describe("promotion and the Deadmines witness", () => {
  const entry = { name: "m", model: "vendor/big", tier: "t1" as const };
  const policy: SchedulingPolicy = { ...DEFAULT_POLICY, series: "0.5" };
  const at = (runs: RunFact[], tier: RosterModel["tier"] = "t1") => projectModel({ ...entry, tier }, runs, policy, { now: Date.UTC(2026, 10, 15, 12) });

  test("level 4 in a counted e90 does not promote; level 5 does", () => {
    const l4 = at([countedFact(entry, "e90", 4)]);
    expect(l4).toMatchObject({ tier: "t1", earnedPromotion: false, eligible: ["e90"] });
    expect(l4.perEpisode.e90!.countedLevel).toBe(4);
    const l5 = at([countedFact(entry, "e90", 5)]);
    expect(l5).toMatchObject({ tier: "t2", earnedPromotion: true, status: "promoted", eligible: ["e90", "e360"] });
    expect(l5.perEpisode.e360!.target).toBe(1);
    // t2 buys no Deadmines: those are t3's (operator, 2026-11-20).
    expect(l5.perEpisode["deadmines-solo"]!.target).toBe(0);
    expect(l5.perEpisode.deadmines!.target).toBe(0);
  });

  test("level 7 in a counted e360 does not open the Deadmines evals; level 8 does", () => {
    const e90 = countedFact(entry, "e90", 5, { i: 1 });
    const l7 = at([e90, countedFact(entry, "e360", 7, { i: 2 })]);
    expect(l7).toMatchObject({ tier: "t2", earnedDeadmines: false, eligible: ["e90", "e360"] });
    expect(l7.perEpisode["deadmines-solo"]!.target).toBe(0);
    const l8 = at([e90, countedFact(entry, "e360", 8, { i: 2 })]);
    // The e360 witness climbs a t1 the second rung (operator, 2026-11-20).
    expect(l8).toMatchObject({ tier: "t3", earnedDeadmines: true, status: "promoted", eligible: ["e90", "e360", "deadmines-solo"] });
    expect(l8.perEpisode["deadmines-solo"]!.target).toBe(3);
    // The five-agent id still wants the entry's opt-in.
    expect(l8.perEpisode.deadmines!.target).toBe(0);
    expect(projectModel({ ...entry, tier: "t1", deadmines: true }, [e90, countedFact(entry, "e360", 8, { i: 2 })], policy, { now: Date.UTC(2026, 10, 15, 12) }).eligible).toEqual(["e90", "e360", "deadmines-solo", "deadmines"]);
  });

  test("level 8 on e90, or on an uncounted e360, is no Deadmines witness", () => {
    const e90At8 = at([countedFact(entry, "e90", 8)]);
    expect(e90At8.earnedDeadmines).toBe(false);
    for (const spoilt of [
      { ...countedFact(entry, "e360", 9, { i: 2 }), episodeOverride: true },
      { ...countedFact(entry, "e360", 9, { i: 2 }), extra: true },
      { ...countedFact(entry, "e360", 9, { i: 2 }), modelResponses: 0 },
      countedFact(entry, "e360", 9, { i: 2, series: "0.4" }),
    ]) {
      const s = at([countedFact(entry, "e90", 5, { i: 1 }), spoilt]);
      expect(s.earnedDeadmines).toBe(false);
      expect(s.eligible).toEqual(["e90", "e360"]);
      // `bestLevel` may read the run; the witness never does.
      expect(s.perEpisode.e360!.countedLevel).toBeNull();
    }
  });

  test("no tier stands in for the e360 witness, and t0 keeps it without spending it", () => {
    const handPlaced = at([], "t2");
    expect(handPlaced).toMatchObject({ tier: "t2", earnedPromotion: false, earnedDeadmines: false, eligible: ["e90", "e360"] });
    // A declared t3 buys the Deadmines evals but spends none before the witness.
    const t3 = at([countedFact(entry, "e90", 6, { i: 1 })], "t3");
    expect(t3).toMatchObject({ tier: "t3", earnedDeadmines: false, eligible: ["e90", "e360"] });
    expect(t3.perEpisode["deadmines-solo"]!.target).toBe(0);
    expect(at([countedFact(entry, "e90", 6, { i: 1 }), countedFact(entry, "e360", 8, { i: 2 })], "t3").eligible).toEqual(["e90", "e360", "deadmines-solo"]);
    const trial = at([countedFact(entry, "e90", 6, { i: 1 }), countedFact(entry, "e360", 8, { i: 2 })], "t0");
    expect(trial).toMatchObject({ tier: "t0", earnedPromotion: true, earnedDeadmines: true, eligible: ["e90"] });
  });

  test("a declared t2 is a pin: an L8 e360 climbs it nowhere and buys no Deadmines (operator, 2026-11-20)", () => {
    const pinned = projectModel({ ...entry, tier: "t2", deadmines: true }, [countedFact(entry, "e90", 6, { i: 1 }), countedFact(entry, "e360", 8, { i: 2 })], policy, { now: Date.UTC(2026, 10, 15, 12) });
    expect(pinned).toMatchObject({ declaredTier: "t2", tier: "t2", earnedPromotion: true, earnedDeadmines: true, eligible: ["e90", "e360"] });
    expect(pinned.status).not.toBe("promoted");
    expect(pinned.perEpisode["deadmines-solo"]!.target).toBe(0);
    expect(pinned.perEpisode.deadmines!.target).toBe(0);
  });

  test("the verdict says what the Deadmines evals wait on, and stops once they are open", () => {
    const e90 = countedFact(entry, "e90", 5, { i: 1 });
    const waiting = at([e90, countedFact(entry, "e360", 7, { i: 2 })]);
    expect(schedulability(waiting, new Set(), policy).why).toContain("not yet on deadmines-solo: the Deadmines evals are t3's: a t1 climbs to t3 on level 8 in a counted e360");
    // A declared t3 waits on the same witness; a declared t2 is a pin and waits on nothing.
    expect(schedulability(at([e90, countedFact(entry, "e360", 7, { i: 2 })], "t3"), new Set(), policy).why).toContain("not yet on deadmines-solo: the Deadmines evals open on level 8 in a counted e360");
    expect(schedulability(at([e90, countedFact(entry, "e360", 7, { i: 2 })], "t2"), new Set(), policy).why).not.toContain("deadmines");
    const open = at([e90, countedFact(entry, "e360", 8, { i: 2 })]);
    expect(schedulability(open, new Set(), policy).why).not.toContain("not yet on deadmines-solo");
    // A t1 model's tier buys none, so it has nothing to wait on there.
    expect(schedulability(at([countedFact(entry, "e90", 3)]), new Set(), policy).why).not.toContain("deadmines");
  });
});

describe("one model served by two providers fills one target (operator, 2026-11-16)", () => {
  const NOW6 = Date.UTC(2026, 10, 16, 12);
  const policy = { ...DEFAULT_POLICY, series: "0.5" };
  // OpenCode Go records the bare id, OpenRouter the vendor-prefixed one.
  const go: RosterModel = { name: "ds-go", model: "deepseek-v4.1-flash", apiBase: "https://opencode.ai/inference/go/openai/v1", tier: "t1" };
  const or: RosterModel = { name: "ds-or", model: "deepseek/deepseek-v4.1-flash", tier: "t1" };
  const goRun = (i: number, over: Partial<RunFact> = {}): RunFact => ({ ...countedFact(go, "e90", 3, { i, now: NOW6 }), runId: `go-${i}`, routing: { ...OPENCODE_GO_ROUTING }, credential: "opencodego", ...over });
  const orRun = (i: number, over: Partial<RunFact> = {}): RunFact => ({ ...countedFact(or, "e90", 2, { i, now: NOW6 }), runId: `or-${i}`, credential: "openrouter-1", ...over });
  const statesOf = (runs: RunFact[], roster: RosterModel[] = [go, or]): ModelState[] =>
    modelStates({ runsDir: "/nonexistent", roster, runs, sidecar: { version: 1, cleared: {} }, policy, now: NOW6 });

  test("the two entries are one model: siblings, and each counts the other's runs", () => {
    expect(modelSiblings([go, or])).toEqual(new Map([["ds-go", ["ds-or"]], ["ds-or", ["ds-go"]]]));
    expect(sameModel(or, goRun(1))).toBe(true);
    // Another effort is another model, as before, and a free endpoint is never the paid model.
    expect(modelSiblings([go, { ...or, effort: "high" }]).size).toBe(0);
    expect(modelSiblings([go, { ...or, model: "deepseek/deepseek-v4.1-flash:free" }]).size).toBe(0);
    // Owning a run is unchanged: a Go run is resumed, its credential read and its character kept only under the Go entry.
    expect(entryOwnsRun(or, goRun(1))).toBe(false);
    expect(matchesRoster(goRun(1), or)).toBe(false);
  });

  test("a Go run counts toward the model's quota, so the OpenRouter entry does not launch a 4th e90", () => {
    const states = statesOf([goRun(1), goRun(2), goRun(3)]);
    expect(states.map((st) => [st.name, st.perEpisode.e90!.counted, st.perEpisode.e90!.target, st.perEpisode.e90!.attempts])).toEqual([
      ["ds-go", 3, 3, 3],
      ["ds-or", 3, 3, 0],
    ]);
    expect(schedulability(states[1]!).verdict).toBe("free");
    expect(planNextJobs(states, ["A1", "A2"]).jobs).toEqual([]);
    // Two runs on each side are past the target too, and a promotion witness on either side is the model's.
    const mixed = statesOf([goRun(1), orRun(2, { bestLevel: 5 })]);
    expect(mixed.map((st) => [st.perEpisode.e90!.counted, st.earnedPromotion])).toEqual([
      [2, true],
      [2, true],
    ]);
  });

  test("two entries owing one target launch one e90 between them, the first in roster order", () => {
    const states = statesOf([goRun(1), orRun(2)]);
    const plan = planNextJobs(states, ["A1", "A2"]);
    expect(plan.jobs.map((j) => [j.name, j.episode, j.why])).toEqual([["ds-go", "e90", "2/3 on e90"]]);
    // Roster order decides it, not the provider: reversed, OpenRouter goes first.
    expect(planNextJobs(statesOf([goRun(1), orRun(2)], [or, go]), ["A1", "A2"]).jobs.map((j) => j.name)).toEqual(["ds-or"]);
    // The entry passed over (its credential full, say: `planPolicyHeld` drops it and asks again) leaves the pick to the other.
    expect(planNextJobs(states.filter((st) => st.name !== "ds-go"), ["A1"]).jobs.map((j) => j.name)).toEqual(["ds-or"]);
  });

  test("while one entry runs the model, the other launches no scored episode beside it", () => {
    const states = statesOf([goRun(1)]);
    // In flight under the supervisor, before its run reads live.
    expect(schedulability(states[1]!, new Set(["ds-go"]))).toEqual({ verdict: "blocked", why: "running (one character per model): ds-go runs it" });
    expect(planNextJobs(states, ["A1", "A2"], new Set(["ds-go"])).jobs).toEqual([]);
    // Live on disk.
    const live = statesOf([goRun(1), goRun(2, { live: true, endedAt: null, terminationReason: null })]);
    expect(live[1]!.siblingPlaying).toEqual({ runId: "go-2", episode: "e90" });
    expect(schedulability(live[1]!).why).toBe("running (one character per model): go-2 plays it under another entry");
  });

  test("a sibling's probe in flight holds nothing of this entry: a probe was never one character per model", () => {
    const states = statesOf([goRun(1)]);
    // ds-or plays a probe: running, but not holding.
    expect(schedulability(states[0]!, new Set(["ds-or"]), policy, new Set()).verdict).toBe("eval");
    expect(planNextJobs(states, ["A1"], new Set(["ds-or"]), { holding: new Set() }).jobs.map((j) => [j.name, j.episode])).toEqual([["ds-go", "e90"]]);
    // A probe on disk, live, is not `siblingPlaying` either.
    const probing = statesOf([goRun(1), orRun(2, { episode: "probing", live: true, endedAt: null, terminationReason: null })]);
    expect(probing[0]!.siblingPlaying).toBeUndefined();
  });

  test("freeplay stays one character per entry: a sibling's freeplay holds this entry's scored episodes, never its freeplay", () => {
    const idle = (r: RosterModel): RosterModel => ({ ...r, idle: "unlimited" });
    const met = [goRun(1), goRun(2), goRun(3)];
    const fp = goRun(4, { episode: "freeplay", extra: true, live: true, endedAt: null, terminationReason: null });
    const states = statesOf([...met, fp], [idle(go), idle(or)]);
    expect(states[1]!.siblingPlaying).toEqual({ runId: "go-4", episode: "freeplay" });
    expect(wantsIdle(schedulability(states[1]!), states[1]!)).toBe(true);
    expect(planNextJobs(states, ["A1"]).jobs.map((j) => [j.name, j.episode])).toEqual([["ds-or", "freeplay"]]);
    // A sibling's scored run does hold it.
    const scored = statesOf([goRun(1), goRun(2, { live: true, endedAt: null, terminationReason: null })], [idle(go), idle(or)]);
    expect(wantsIdle(schedulability(scored[1]!), scored[1]!)).toBe(false);
  });

  test("the outstanding figure owes the model's runs once, not once per entry", () => {
    const states = statesOf([goRun(1)]);
    expect(outstandingWork({ states, accounts: 2 })).toMatchObject({ lower: 2 });
    expect(outstandingWork({ states: [states[0]!], accounts: 2 })).toMatchObject({ lower: 2 });
  });

  test("the viewer's row lists the model's counted runs whichever entry ran them, and names its sibling", () => {
    const runs = [goRun(1), orRun(2)];
    const states = statesOf(runs);
    const row = rowOf(states[1]!, runs, "/nowhere");
    expect(row.perEpisode.e90!.runIds).toEqual(["or-2", "go-1"]);
    expect(row.runs.map((r) => r.runId)).toEqual(["or-2"]);
    expect(row.siblings).toEqual(["ds-go"]);
  });
});
