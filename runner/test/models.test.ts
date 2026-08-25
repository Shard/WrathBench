import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountClassOf,
  DEFAULT_POLICY,
  LADDER_MS,
  countModelResponses,
  isCounted,
  isNoProgress,
  isStalePause,
  stillbornOf,
  modelStates,
  nextJobs,
  planNextJobs,
  DEFAULT_PAID,
  TIER_TABLE,
  effectiveTier,
  type SchedulingPolicy,
  parseModelsSidecar,
  projectModel,
  readRunFacts,
  schedulability,
  schedulableView,
  wantsIdle,
  serializeModelsSidecar,
  type RosterModel,
  type RunFact,
  type ModelState,
  outstandingWork,
  formatOutstanding,
  concurrencyKeyOf,
  isConcurrencyKey,
  CONCURRENCY_KEYS,
  parsePolicyBlock,
} from "../src/models";
import type { EpisodeId } from "../src/episodes";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

interface SynthRun {
  id: string;
  model: string;
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
  { name: "ox", model: "stealth/ox-alpha", tier: "t1" },
  { name: "glm", model: "z-ai/glm:free", apiBase: "https://openrouter.ai/api/v1", tier: "t1" },
  { name: "sonnet", model: "sonnet", driver: "claude-code", tier: "t1" },
  // t0 is the one-run trial tier: the same budget the old per-entry override spelled.
  { name: "sonnet-low", model: "sonnet", effort: "low", driver: "claude-code", tier: "t0" },
  { name: "local", model: "qwen/q", apiBase: "http://192.168.1.20:1234/v1", tier: "t1", idle: "unlimited" },
];

let runsDir: string;

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), "wb-models-"));
  const t0 = NOW - 48 * HOUR;
  // ox: two good e90 runs, one reaching level 5 -> promoted; one overridden run (not counted).
  writeRun(runsDir, { id: "ox-1", model: "stealth/ox-alpha", episode: "e90", responses: 40, level: 5, reason: "episode-limit", startedAt: t0, endedAt: t0 + HOUR });
  writeRun(runsDir, { id: "ox-2", model: "stealth/ox-alpha", episode: "e90", responses: 12, level: 3, reason: "idle", startedAt: t0 + 2 * HOUR, endedAt: t0 + 3 * HOUR });
  writeRun(runsDir, { id: "ox-3", model: "stealth/ox-alpha", episode: "e90", override: true, responses: 30, level: 6, reason: "episode-limit", startedAt: t0 + 4 * HOUR, endedAt: t0 + 5 * HOUR });
  // glm: one stillborn, then a second stillborn 30m ago -> rung 2 (3m) already expired; then a fresh stillborn 1m ago -> rung 3 cooling.
  writeRun(runsDir, { id: "glm-1", model: "z-ai/glm:free", episode: "e90", responses: 0, reason: "adapter-error", startedAt: t0, endedAt: t0 + 60_000 });
  writeRun(runsDir, { id: "glm-2", model: "z-ai/glm:free", episode: "e90", responses: 0, reason: null, startedAt: NOW - 40 * 60_000, endedAt: null, mtime: NOW - 30 * 60_000 });
  writeRun(runsDir, { id: "glm-3", model: "z-ai/glm:free", episode: "e90", responses: 0, reason: "adapter-error", startedAt: NOW - 5 * 60_000, endedAt: NOW - 60_000 });
  // sonnet: one counted run, no level 5; a pre-tier run (no episode stamp) that must be invisible.
  writeRun(runsDir, { id: "sonnet-1", model: "sonnet", episode: "e90", responses: 50, level: 4, reason: "episode-limit", startedAt: t0, endedAt: t0 + HOUR });
  writeRun(runsDir, { id: "sonnet-old", model: "sonnet", responses: 50, level: 9, reason: "episode-limit", startedAt: t0 - HOUR, endedAt: t0 });
  // sonnet-low: an answered run that is LIVE (mtime just now, no termination) -> counted, not stillborn.
  writeRun(runsDir, { id: "sonnet-low-1", model: "sonnet", effort: "low", episode: "e90", responses: 3, level: 1, reason: null, startedAt: NOW - 60_000, endedAt: null, mtime: NOW - 10_000 });
  // local: one run from the previous series and one extra run this series — both visible, neither counted.
  writeRun(runsDir, { id: "local-old", model: "qwen/q", episode: "e90", responses: 20, level: 7, reason: "episode-limit", startedAt: t0, endedAt: t0 + HOUR, harnessVersion: "harness-0.2-33-gabc" });
  writeRun(runsDir, { id: "local-x", model: "qwen/q", episode: "e90", responses: 20, level: 2, reason: "episode-limit", startedAt: t0 + 6 * HOUR, endedAt: t0 + 7 * HOUR, extra: true });
  // a non-run directory and a directory without meta.json
  mkdirSync(join(runsDir, "night-report"), { recursive: true });
  writeRun(runsDir, { id: "nometa", model: "x", responses: 2, startedAt: t0, noMeta: true });
  // An archived run: the runner parks a launch that produced no response.
  // Invisible to a listing, visible to the scheduler (attempt numbers, ladder).
  mkdirSync(join(runsDir, "archive", "ox-archived"), { recursive: true });
  writeFileSync(join(runsDir, "archive", "ox-archived", "meta.json"), JSON.stringify({ harnessVersion: "harness-0.3-1-gabc", config: { model: "stealth/ox-alpha" }, comparability: { episode: "e90" } }));
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

    // ox is t1 and earned rung 1, so it climbed to t2 — which is what unlocks
    // e360 at all. The declared tier is unchanged: the config is not rewritten.
    expect(by["ox"]).toMatchObject({ status: "promoted", declaredTier: "t1", tier: "t2", earnedRung1: true, eligible: ["e90", "e360"], platform: "openrouter", ladder: 0 });
    // attempts 4: the archived ox run is an attempt — it numbers the next run id.
    expect(by["ox"]!.perEpisode.e90).toMatchObject({ counted: 2, stillborn: 0, attempts: 4, target: 3, bestLevel: 6, reachedL5: true, lastReason: "episode-limit" });
    expect(by["ox"]!.perEpisode.e360).toMatchObject({ counted: 0, target: 1, bestLevel: null, reachedL5: false, lastEnded: null, lastReason: null });

    expect(by["glm"]!.status).toBe("cooling");
    expect(by["glm"]!.ladder).toBe(3);
    expect(by["glm"]!.cooling).toMatchObject({ rung: 3, until: NOW - 60_000 + LADDER_MS[2]! });
    expect(by["glm"]!.cooling!.reason).toContain("glm-3");
    expect(by["glm"]!.perEpisode.e90).toMatchObject({ counted: 0, stillborn: 3, attempts: 3, lastReason: "stillborn" });

    expect(by["sonnet"]).toMatchObject({ status: "active", eligible: ["e90"], platform: "claude-code", harness: "claude-code" });
    // The old driver spelling in a roster reads as the same harness.
    expect(by["sonnet-low"]).toMatchObject({ platform: "claude-code", harness: "claude-code" });
    expect(by["ox"]).toMatchObject({ harness: "wrathbench" });
    expect(by["sonnet"]!.perEpisode.e90).toMatchObject({ counted: 1, bestLevel: 4, reachedL5: false });

    // A live, answered run counts; t0 buys exactly one of them.
    expect(by["sonnet-low"]!.perEpisode.e90).toMatchObject({ counted: 1, stillborn: 0, target: 1 });
    // No series on the policy: the 0.2 run is an attempt like any other; the extra is an attempt, never counted.
    expect(by["local"]).toMatchObject({ status: "promoted", platform: "local", billing: "free" });
    expect(by["local"]!.perEpisode.e90).toMatchObject({ counted: 1, attempts: 2, extras: 1, otherSeries: 0, target: 3, bestLevel: 7 });
    expect(by["local"]).toMatchObject({ declaredTier: "t1", tier: "t2", idle: "unlimited" });
    expect(by["ox"]!.billing).toBe("free"); // allowlisted stealth id
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
    expect(s!.eligible).toEqual(["e90", "e360"]);
    // Hand-placed on t2: eligible, but it did not climb, so "promoted" — the
    // earned word — is not said of it, and the witness stays false.
    expect(s!.status).toBe("active");
    expect(s!.declaredTier).toBe("t2");
    expect(s!.tier).toBe("t2");
    expect(s!.earnedRung1).toBe(false);
    expect(s!.perEpisode.e90!.reachedL5).toBe(false);
  });
});

describe("the ladder", () => {
  const fail = (i: number, endedAt: number, reason: string | null = "adapter-error", responses = 0): RunFact => ({
    runId: `f-${i}`,
    model: "m",
    effort: null,
    episode: "e90",
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    extra: false,
    startedAt: endedAt - 60_000,
    endedAt,
    terminationReason: reason,
    modelResponses: responses,
    bestLevel: null,
    live: false,
    pause: null,
    account: null,
    episodeMs: null,
    campaign: null,
    cell: null,
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
    expect(s.paused).toMatchObject({ runId: "f-9", reason: "operator-pause", episodeElapsedMs: 41 * 60_000, episodeMs: 90 * 60_000 });
    const v = schedulability(s);
    expect(v.verdict).toBe("blocked");
    expect(v.why).toContain("paused run f-9 (operator-pause, 41m of 90m elapsed)");
    expect(nextJobs([s], ["A"])).toEqual([]);
    expect(isCounted(paused)).toBe(false);
    expect(isNoProgress(paused)).toBe(false);
    expect(stillbornOf(paused)).toBeNull();
  });

  test("a stale pause (older than twice the budget) no longer holds the model", () => {
    const stale: RunFact = {
      ...fail(9, NOW - 4 * HOUR, null, 30),
      pause: { reason: "rate-limited", at: NOW - 4 * HOUR, count: 3, episodeElapsedMs: 5 * 60_000 },
      episodeMs: 90 * 60_000,
      account: "RUNNER3",
    };
    expect(isStalePause(stale, NOW)).toBe(true);
    expect(isStalePause({ ...stale, pause: { ...stale.pause!, at: NOW - 2 * HOUR } }, NOW)).toBe(false);
    // No wall clock: the long tier's budget stands in.
    expect(isStalePause({ ...stale, episodeMs: null }, NOW)).toBe(false);
    const s = projectModel(m, [stale], DEFAULT_POLICY, { now: NOW });
    expect(s.paused).toBeUndefined();
    expect(schedulability(s).verdict).toBe("eval");
    // Still not counted: it has not ended.
    expect(s.perEpisode.e90).toMatchObject({ attempts: 1, counted: 0 });
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
    expect(schedulability(s).why).toContain("--clear-model m");
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
    episode: ep,
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    extra: false,
    startedAt: NOW - (100 - i) * HOUR,
    endedAt: NOW - (99 - i) * HOUR,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
    pause: null,
    account: null,
    episodeMs: null,
    campaign: null,
    cell: null,
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
    episode: ep,
    episodeOverride: false,
    harnessVersion: "harness-0.3-1-gx",
    harnessSeries: "0.3",
    extra,
    startedAt: NOW - (100 - i) * HOUR,
    endedAt: NOW - (99 - i) * HOUR,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
    pause: null,
    account: null,
    episodeMs: null,
    campaign: null,
    cell: null,
  });
  const policy: SchedulingPolicy = { ...DEFAULT_POLICY, paid: { ...DEFAULT_PAID } };
  const st = (r: Omit<RosterModel, "tier"> & { tier?: RosterModel["tier"] }, runs: RunFact[], p = policy) =>
    projectModel({ tier: "t1", ...r }, runs, p, { now: NOW });

  test("billing is derived once: slug, LAN, subscription, allowlist, override", () => {
    expect(st({ name: "p", model: "vendor/big" }, []).billing).toBe("paid");
    expect(st({ name: "f", model: "vendor/big:free" }, []).billing).toBe("free");
    expect(st({ name: "c", model: "x-contributor-free", apiBase: "https://opencode.ai/zen/v1" }, []).billing).toBe("free");
    expect(st({ name: "l", model: "vendor/big", apiBase: "http://10.0.0.5:1234/v1" }, []).billing).toBe("free");
    expect(st({ name: "s", model: "opus", driver: "claude-code" }, []).billing).toBe("free");
    expect(st({ name: "o", model: "stealth/ox-alpha" }, []).billing).toBe("free");
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
    expect(trial.earnedRung1).toBe(true);
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

  test("effectiveTier: t0 holds the ladder, t1 climbs once, t2 is the top rung", () => {
    expect(effectiveTier("t0", true)).toBe("t0");
    expect(effectiveTier("t1", false)).toBe("t1");
    expect(effectiveTier("t1", true)).toBe("t2");
    expect(effectiveTier("t2", true)).toBe("t2");
    // A climb is one rung, never two: t2 is where the ladder ends today.
    expect(TIER_TABLE[effectiveTier("t1", true)].promotesTo).toBeNull();
  });

  test("the paid cap: one paid model in flight across the pool, the next candidate takes the account, held says why", () => {
    const p1 = st({ name: "p1", model: "v/one" }, []);
    const p2 = st({ name: "p2", model: "v/two" }, []);
    const f1 = st({ name: "f1", model: "v/three:free" }, []);
    const plan = planNextJobs([p1, p2, f1], ["R1", "R2", "R3"], new Set(), { policy });
    expect(plan.jobs.map((j) => [j.name, j.account])).toEqual([
      ["p1", "R1"],
      ["f1", "R2"],
    ]);
    expect(plan.held).toEqual([{ name: "p2", episode: "e90", why: "paid cap: 1/1 paid model(s) already in flight" }]);
    // A paid model already running elsewhere fills the cap before any pick.
    expect(planNextJobs([p1, p2, f1], ["R1", "R2"], new Set(), { policy, paidRunning: 1 }).jobs.map((j) => j.name)).toEqual(["f1"]);
    // Cap of two lets both through; no paid policy is no cap.
    expect(planNextJobs([p1, p2], ["R1", "R2"], new Set(), { policy: { ...policy, paid: { ...policy.paid!, maxConcurrent: 2 } } }).jobs).toHaveLength(2);
    expect(planNextJobs([p1, p2], ["R1", "R2"], new Set(), { policy: DEFAULT_POLICY }).jobs).toHaveLength(2);
  });

  test("the paid account class: a paid pick takes a paid account and never a pool one; no paid account is held, not spilled", () => {
    const p1 = st({ name: "p1", model: "v/one" }, []);
    const f1 = st({ name: "f1", model: "v/three:free" }, []);
    // Split on: the paid model takes PAID, the free one the pool, in order.
    const plan = planNextJobs([p1, f1], ["R1", "R2"], new Set(), { policy, classAccounts: { paid: ["PAID"] } });
    expect(plan.jobs.map((j) => [j.name, j.account])).toEqual([
      ["p1", "PAID"],
      ["f1", "R1"],
    ]);
    // Configured but empty: held with the actionable reason, never on a pool account.
    const none = planNextJobs([p1, f1], ["R1", "R2"], new Set(), { policy, classAccounts: { paid: [] } });
    expect(none.jobs.map((j) => [j.name, j.account])).toEqual([["f1", "R1"]]);
    expect(none.held).toEqual([{ name: "p1", episode: "e90", why: "no paid account configured — add one to accounts.paid" }]);
    // The empty-list reason wins over the cap: it is the one the operator can act on.
    expect(planNextJobs([p1], ["R1"], new Set(), { policy, classAccounts: { paid: [] }, paidRunning: 1 }).held[0]!.why).toContain("no paid account configured");
    // Paid accounts busy, pool free: the paid pick waits rather than borrowing one.
    const busy = planNextJobs([p1, f1], ["R1"], new Set(), { policy, classAccounts: { paid: ["PAID"] }, paidRunning: 1 });
    expect(busy.jobs.map((j) => j.account)).toEqual(["R1"]);
    expect(busy.held[0]).toMatchObject({ name: "p1", why: "paid cap: 1/1 paid model(s) already in flight" });
    // A free pick never takes a paid account, even with the pool exhausted.
    expect(planNextJobs([f1], [], new Set(), { policy, classAccounts: { paid: ["PAID"] } }).jobs).toEqual([]);
    // Absent: the pre-split behaviour, paid picks share the pool.
    expect(planNextJobs([p1], ["R1"], new Set(), { policy }).jobs.map((j) => j.account)).toEqual(["R1"]);
  });

  test("held reasons: an unconfigured class and an all-busy one are different sentences", () => {
    const p1 = st({ name: "p1", model: "v/one" }, []);
    const l1 = st({ name: "l1", model: "q/one", apiBase: "http://192.168.1.20:1234/v1" }, []);
    const l2 = st({ name: "l2", model: "q/two", apiBase: "http://192.168.1.20:1234/v1" }, []);
    // Nothing free and nothing busy: the class really is empty, and the fix is
    // a line in the file.
    expect(planNextJobs([p1], ["R1"], new Set(), { policy, classAccounts: { paid: [] } }).held[0]!.why).toBe(
      "no paid account configured — add one to accounts.paid",
    );
    // Nothing free because the one account is taken: the account exists, so we
    // name it and its holder instead of asking for one that is already there.
    const busy = planNextJobs([p1], ["R1"], new Set(), {
      policy,
      classAccounts: { paid: [] },
      classBusy: { paid: [{ account: "SHAKEOUT2", by: "fleet-deepseek-flash-e90-20260823-a2" }] },
      paidRunning: 1,
    });
    expect(busy.jobs).toEqual([]);
    expect(busy.held).toEqual([
      { name: "p1", episode: "e90", why: "paid account(s) busy: SHAKEOUT2 held by fleet-deepseek-flash-e90-20260823-a2" },
    ]);
    // A holder the caller cannot name: still busy, never invented.
    expect(planNextJobs([p1], ["R1"], new Set(), { policy, classAccounts: { paid: [] }, classBusy: { paid: [{ account: "SHAKEOUT2" }] } }).held[0]!.why).toBe(
      "paid account(s) busy: SHAKEOUT2",
    );
    // Two local models, one box: the first takes it, the second is busy-by-the
    // -first — the box is configured, so "no local account" would be a lie.
    const local = planNextJobs([l1, l2], ["R1"], new Set(), { policy, classAccounts: { local: ["LOCALBOX"] } });
    expect(local.jobs.map((j) => [j.name, j.account])).toEqual([["l1", "LOCALBOX"]]);
    expect(local.held).toEqual([{ name: "l2", episode: "e90", why: "local account(s) busy: LOCALBOX held by l1" }]);
    // And with no box at all, the other sentence.
    expect(planNextJobs([l1], [], new Set(), { policy, classAccounts: { local: [] } }).held[0]!.why).toBe(
      "no local account configured — add one to accounts.local",
    );
  });

  test("the local account class: a local model lands on the box, never the pool, and is held when the box has no account", () => {
    const l1 = st({ name: "l1", model: "qwen/q", apiBase: "http://192.168.1.20:1234/v1" }, []);
    const f1 = st({ name: "f1", model: "v/three:free" }, []);
    const p1 = st({ name: "p1", model: "v/one" }, []);
    // Local is its own class even though `model-cost` prices it free.
    expect(l1.billing).toBe("free");
    expect(accountClassOf(l1)).toBe("local");
    expect(accountClassOf(f1)).toBe("pool");
    expect(accountClassOf(p1)).toBe("paid");
    const plan = planNextJobs([l1, f1, p1], ["R1", "R2"], new Set(), { policy, classAccounts: { local: ["BOX"], paid: ["PAID"] } });
    expect(plan.jobs.map((j) => [j.name, j.account])).toEqual([
      ["l1", "BOX"],
      ["f1", "R1"],
      ["p1", "PAID"],
    ]);
    // A free pick never borrows the box, even with the pool exhausted...
    expect(planNextJobs([f1], [], new Set(), { policy, classAccounts: { local: ["BOX"] } }).jobs).toEqual([]);
    // ...and the local pick never borrows a pool account when the box is busy.
    const busy = planNextJobs([l1, f1], ["R1"], new Set(), { policy, classAccounts: { local: [] } });
    expect(busy.jobs.map((j) => [j.name, j.account])).toEqual([["f1", "R1"]]);
    expect(busy.held).toEqual([{ name: "l1", episode: "e90", why: "no local account configured — add one to accounts.local" }]);
    // An extra follows its model's class: the local model's extra takes the box.
    // `idle` is the model's own axis, so what a local model does when it is
    // spent is spelled on the entry rather than inferred from a policy knob.
    const met = st({ name: "l1", model: "qwen/q", apiBase: "http://10.0.0.5:1234/v1", idle: "unlimited" }, [
      good("qwen/q", "e90", 1, 5),
      good("qwen/q", "e90", 2),
      good("qwen/q", "e90", 3),
      good("qwen/q", "e360", 4),
    ]);
    const extras = planNextJobs([met], ["R1"], new Set(), { policy, classAccounts: { local: ["BOX"] } });
    expect(extras.jobs.map((j) => [j.name, j.account, j.episode])).toEqual([["l1", "BOX", "freeplay"]]);
    expect(planNextJobs([met], ["R1"], new Set(), { policy, classAccounts: { local: [] } }).jobs).toEqual([]);
  });

  test("idle: unlimited — one freeplay session at a time, on its own class's account, never counted", () => {
    const local = { name: "l1", model: "qwen/q", apiBase: "http://10.0.0.5:1234/v1", idle: "unlimited" as const };
    // Targets met on e90 only: unpromoted (no counted run reached L5), so e360 is not open.
    const met = st(local, [good("qwen/q", "e90", 1, 3), good("qwen/q", "e90", 2, 4), good("qwen/q", "e90", 3, 2)]);
    expect(met.eligible).toEqual(["e90"]);
    const v = schedulability(met, new Set(), policy);
    expect(v.verdict).toBe("free");
    expect(wantsIdle(v, met)).toBe(true);
    expect(v.why).toContain("unlimited sessions");
    const plan = planNextJobs([met], ["R1"], new Set(), { policy, classAccounts: { local: ["BOX"] } });
    expect(plan.jobs.map((j) => [j.name, j.episode, j.account, j.extra])).toEqual([["l1", "freeplay", "BOX", undefined]]);
    expect(plan.jobs[0]!.why).toContain("unlimited session");
    // Never on a pool account, and one at a time: a running model is not picked again.
    expect(planNextJobs([met], ["R1"], new Set(), { policy, classAccounts: { local: [] } }).jobs).toEqual([]);
    expect(planNextJobs([met], ["R1"], new Set(["l1"]), { policy, classAccounts: { local: ["BOX"] } }).jobs).toEqual([]);
    // Freeplay runs are attempts, never counted, and they number the next one.
    const after = st(local, [
      good("qwen/q", "e90", 1, 3),
      good("qwen/q", "e90", 2, 4),
      good("qwen/q", "e90", 3, 2),
      good("qwen/q", "freeplay", 4, 5, true),
    ]);
    expect(after.perEpisode.freeplay).toMatchObject({ counted: 0, attempts: 1, extras: 1, target: 0 });
    expect(after.perEpisode.e90!.counted).toBe(3);
    expect(after.eligible).toEqual(["e90"]);
    const next = planNextJobs([after], [], new Set(), { policy, classAccounts: { local: ["BOX"] } }).jobs[0]!;
    expect(next).toMatchObject({ episode: "freeplay", attempt: 2, account: "BOX" });
    expect(next.why).toContain("extra #2");
    // A new harness series re-arms the scheduled runs first, freeplay after.
    const series = { ...policy, series: "0.5" };
    const rearmed = st(local, [good("qwen/q", "e90", 1, 3), good("qwen/q", "freeplay", 2, 5, true)], series);
    expect(rearmed.perEpisode.e90).toMatchObject({ counted: 0, otherSeries: 1 });
    expect(planNextJobs([rearmed], [], new Set(), { policy: series, classAccounts: { local: ["BOX"] } }).jobs[0]).toMatchObject({
      episode: "e90",
      account: "BOX",
    });
    // The axis is per model, so — unlike the old knob it replaced — a NON-local
    // model may take unlimited sessions too.
    const pooled = st({ name: "f1", model: "v/f:free", idle: "unlimited" }, [good("v/f:free", "e90", 1, 3), good("v/f:free", "e90", 2), good("v/f:free", "e90", 3)]);
    expect(planNextJobs([pooled], ["R1"], new Set(), { policy }).jobs[0]).toMatchObject({ episode: "freeplay", account: "R1" });
  });

});

describe("outstandingWork", () => {
  const good = (model: string, ep: EpisodeId, i: number, level = 3): RunFact => ({
    runId: `${model}-${ep}-${i}`,
    model,
    effort: null,
    episode: ep,
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    extra: false,
    startedAt: NOW - (100 - i) * HOUR,
    endedAt: NOW - (99 - i) * HOUR,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
    pause: null,
    account: null,
    episodeMs: null,
    campaign: null,
    cell: null,
  });
  const policy: SchedulingPolicy = { ...DEFAULT_POLICY, paid: { ...DEFAULT_PAID } };
  const st = (r: Omit<RosterModel, "tier"> & { tier?: RosterModel["tier"] }, runs: RunFact[]): ModelState =>
    projectModel({ tier: "t1", ...r }, runs, policy, { now: NOW });

  // One of each thing the metric has to tell apart: a model that climbed (owes
  // e360 now), one that has not (owes it only in the upper bound), a paid one,
  // a local one (its own single box), one placed on t2 by hand (eligible
  // without a witness), a claude-code one (the driver cap), and a pinned one
  // that owes runs nobody schedules.
  const promoted = st({ name: "promoted", model: "v/promoted:free" }, [1, 2, 3].map((i) => good("v/promoted:free", "e90", i, 5)));
  const unpromoted = st({ name: "unpromoted", model: "v/unpromoted:free" }, [good("v/unpromoted:free", "e90", 1)]);
  const paid = st({ name: "paid", model: "vendor/paid" }, []);
  const local = st({ name: "local", model: "vendor/local", apiBase: "http://192.168.1.20:1234/v1" }, []);
  const forced = st({ name: "forced", model: "v/forced:free", tier: "t2" }, []);
  const cc = st({ name: "cc", model: "opus", driver: "claude-code" }, []);
  const pinned = st({ name: "pinned", model: "v/pinned:free" }, []);
  const states = [promoted, unpromoted, paid, local, forced, cc, pinned];
  const input = {
    states,
    policy,
    excluded: ["pinned"],
    accounts: { pool: 5, paid: 1, local: 1 },
    maxConcurrent: { "claude-code": 2 },
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
    const t = outstandingWork({ states: [trial], accounts: { pool: 1 } });
    expect(t).toMatchObject({ lower: 1, upper: 1 });
  });

  test("eta: class-wise minutes over class concurrency, claude-code carved out of the pool", () => {
    const o = outstandingWork(input);
    const by = new Map(o.breakdown.map((g) => [g.group, g]));
    expect([...by.keys()].sort()).toEqual(["claude-code", "local", "paid", "pool"]);
    expect(by.get("pool")).toMatchObject({ concurrency: 5, lowerRuns: 7, lowerMinutes: 1170, upperRuns: 8, upperMinutes: 1530 });
    // The driver cap binds tighter than the five pool accounts.
    expect(by.get("claude-code")).toMatchObject({ concurrency: 2, lowerMinutes: 270, upperMinutes: 630 });
    // policy.paid.maxConcurrent caps the paid class at one in flight.
    expect(by.get("paid")).toMatchObject({ concurrency: 1, lowerRuns: 3, upperRuns: 4 });
    expect(by.get("local")).toMatchObject({ concurrency: 1, lowerRuns: 3 });
    const min = (ms: number | null): number => Math.round((ms ?? 0) / 60_000);
    expect(min(o.etaLowerMs)).toBe(1170 / 5 + 270 / 2 + 270 + 270);
    expect(min(o.etaUpperMs)).toBe(1530 / 5 + 630 / 2 + 630 + 630);
    expect(o.etaLowerMs!).toBeLessThanOrEqual(o.etaUpperMs!);
  });

  test("work with nowhere to run has no eta; nothing owed is exhausted", () => {
    expect(outstandingWork({ ...input, accounts: { pool: 5, paid: 0, local: 1 } }).etaLowerMs).toBeNull();
    const none = outstandingWork({ states: [], accounts: { pool: 5 } });
    expect(none).toMatchObject({ lower: 0, upper: 0, etaLowerMs: 0, etaUpperMs: 0 });
    expect(formatOutstanding(none)).toContain("exhausted");
    expect(formatOutstanding(outstandingWork(input))).toBe("outstanding: 16–20 scheduled runs, ≈ 15h–31h to exhaust");
  });
});

describe("concurrency lanes (cap keys on the rate-limit key)", () => {
  const key = (r: { name?: string; driver?: string; apiBase?: string }, billing: "free" | "paid") =>
    concurrencyKeyOf({ name: r.name ?? "x", ...(r.driver !== undefined ? { driver: r.driver } : {}), ...(r.apiBase !== undefined ? { apiBase: r.apiBase } : {}) }, billing);

  test("free models on a shared pool key on the platform; everything else on the driver", () => {
    // claude-code keeps its driver key (a subscription, not a shared free pool).
    expect(key({ driver: "claude-code" }, "free")).toBe("claude-code");
    // Free OpenRouter: a `:free` slug with no apiBase is the OpenRouter default.
    expect(key({}, "free")).toBe("openrouter");
    // Advisor's case: a `:free` slug pinned to driver openai, still no base — must
    // not escape the cap via the driver fallback.
    expect(key({ driver: "openai" }, "free")).toBe("openrouter");
    // Free OpenCode Zen: the opencode.ai host normalizes to the `opencode` key.
    expect(key({ apiBase: "https://opencode.ai/zen/v1" }, "free")).toBe("opencode");
    // Paid on OpenRouter (deepseek-flash): governed by policy.paid, NOT a free key.
    expect(key({}, "paid")).toBe("openai");
    // Local (qwen3-8-27b): free by billing but its one box is its limit — driver key.
    expect(key({ driver: "openai", apiBase: "http://192.168.1.20:1234/v1" }, "free")).toBe("openai");
    // Stub keeps its driver key.
    expect(key({ driver: "stub" }, "free")).toBe("stub");
  });

  test("parsePolicyBlock accepts the keys and rejects an unknown concurrency key", () => {
    expect(isConcurrencyKey("openrouter")).toBe(true);
    expect(isConcurrencyKey("opencode")).toBe(true);
    expect(isConcurrencyKey("claude-code")).toBe(true);
    expect(isConcurrencyKey("warp")).toBe(false);
    expect(CONCURRENCY_KEYS).toEqual(["openai", "claude-code", "stub", "openrouter", "opencode"]);
    expect(parsePolicyBlock({ maxConcurrent: { "claude-code": 2, openrouter: 1, opencode: 1 } }).maxConcurrent).toEqual({ "claude-code": 2, openrouter: 1, opencode: 1 });
    expect(() => parsePolicyBlock({ maxConcurrent: { warp: 1 } })).toThrow(/unknown concurrency key warp — allowed: openai, claude-code, stub, openrouter, opencode/);
    expect(() => parsePolicyBlock({ maxConcurrent: { openrouter: 0 } })).toThrow(/positive integer/);
  });
});

describe("probe campaigns in the schedule", () => {
  const NOW2 = 1_800_000_000_000;
  const H = 3_600_000;
  const done = (model: string, ep: EpisodeId, i: number, over: Partial<RunFact> = {}): RunFact => ({
    runId: `${model}-${ep}-${i}`,
    model,
    effort: null,
    episode: ep,
    episodeOverride: false,
    harnessVersion: null,
    harnessSeries: null,
    extra: false,
    startedAt: NOW2 - (100 - i) * H,
    endedAt: NOW2 - (99 - i) * H,
    terminationReason: "episode-limit",
    modelResponses: 20,
    bestLevel: 3,
    live: false,
    pause: null,
    account: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    ...over,
  });
  /** A model on t0 whose single e90 is done: owes nothing, so it is `free`. */
  const spent = (name: string): ModelState =>
    projectModel({ name, model: name, tier: "t0" }, [done(name, "e90", 1)], DEFAULT_POLICY, { now: NOW2 });
  /** A model on t1 with nothing run: still owes evidence. */
  const owing = (name: string): ModelState =>
    projectModel({ name, model: name, tier: "t1" }, [], DEFAULT_POLICY, { now: NOW2 });

  const campaign = {
    name: "class-probe",
    enabled: true,
    objective: "play this class",
    models: "all" as const,
    excludeUnhealthy: true,
    runsPerCell: 1,
    cells: [{ id: "human-warrior" }, { id: "dwarf-rogue" }],
  };

  test("a model that owes evidence is never given probe work", () => {
    // The whole priority rule, in one assertion: evals outrank probes, and the
    // rule is enforced by the verdict rather than by ordering the loops.
    const plan = planNextJobs([owing("a")], ["R1"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.length).toBe(1);
    expect(plan.jobs[0]!.episode).toBe("e90");
    expect(plan.jobs[0]!.probe).toBeUndefined();
  });

  test("a model that owes nothing takes a probe, stamped with its campaign and cell", () => {
    const plan = planNextJobs([spent("a")], ["R1"], new Set(), { campaigns: [campaign] });
    expect(plan.jobs.length).toBe(1);
    expect(plan.jobs[0]).toMatchObject({
      name: "a",
      episode: "probing",
      account: "R1",
      probe: { campaign: "class-probe", cell: "human-warrior" },
    });
    expect(plan.jobs[0]!.why).toContain("campaign class-probe cell human-warrior (0/1)");
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
    const probeRuns = [{ campaign: "class-probe", cell: "human-warrior", ref: "a" }];
    const plan = planNextJobs([spent("a")], ["R1"], new Set(), { campaigns: [campaign], probeRuns });
    expect(plan.jobs[0]!.probe).toEqual({ campaign: "class-probe", cell: "dwarf-rogue" });
  });

  test("a campaign with every cell done schedules nothing at all", () => {
    const probeRuns = [
      { campaign: "class-probe", cell: "human-warrior", ref: "a" },
      { campaign: "class-probe", cell: "dwarf-rogue", ref: "a" },
    ];
    expect(planNextJobs([spent("a")], ["R1"], new Set(), { campaigns: [campaign], probeRuns }).jobs).toEqual([]);
  });

  test("a blocked model is skipped even though the campaign wants it", () => {
    // Cooling is cooling: a campaign is exploration and burning a cell against a
    // backing-off endpoint produces no observation.
    const cooling = projectModel(
      { name: "a", model: "a", tier: "t0" },
      [done("a", "e90", 1, { modelResponses: 0, terminationReason: "adapter-error", endedAt: NOW2 - 1000 })],
      DEFAULT_POLICY,
      { now: NOW2 },
    );
    expect(schedulability(cooling).verdict).toBe("blocked");
    expect(planNextJobs([cooling], ["R1"], new Set(), { campaigns: [campaign] }).jobs).toEqual([]);
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

  test("no campaigns configured is the old behaviour exactly", () => {
    expect(planNextJobs([spent("a")], ["R1"], new Set(), {}).jobs).toEqual([]);
  });
});
