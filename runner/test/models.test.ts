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
  DEFAULT_EXTRA_CHARACTERS,
  type SchedulingPolicy,
  parseModelsSidecar,
  projectModel,
  readRunFacts,
  schedulability,
  serializeModelsSidecar,
  type RosterModel,
  type RunFact,
} from "../src/models";

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
  { name: "ox", model: "stealth/ox-alpha" },
  { name: "glm", model: "z-ai/glm:free", apiBase: "https://openrouter.ai/api/v1" },
  { name: "sonnet", model: "sonnet", driver: "claude-code" },
  { name: "sonnet-low", model: "sonnet", effort: "low", driver: "claude-code", runsPerEpisode: { e90: 1 } },
  { name: "local", model: "qwen/q", apiBase: "http://192.168.1.20:1234/v1" },
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
  mkdirSync(join(runsDir, "archive", "ox-archived"), { recursive: true });
  writeFileSync(join(runsDir, "archive", "ox-archived", "meta.json"), JSON.stringify({ config: { model: "stealth/ox-alpha" }, comparability: { episode: "e90" } }));
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

    expect(by["ox"]).toMatchObject({ status: "promoted", eligible: ["e90", "e360"], platform: "openrouter", ladder: 0 });
    expect(by["ox"]!.perEpisode.e90).toMatchObject({ counted: 2, stillborn: 0, attempts: 3, target: 3, bestLevel: 6, reachedL5: true, lastReason: "episode-limit" });
    expect(by["ox"]!.perEpisode.e360).toMatchObject({ counted: 0, target: 3, bestLevel: null, reachedL5: false, lastEnded: null, lastReason: null });

    expect(by["glm"]!.status).toBe("cooling");
    expect(by["glm"]!.ladder).toBe(3);
    expect(by["glm"]!.cooling).toMatchObject({ rung: 3, until: NOW - 60_000 + LADDER_MS[2]! });
    expect(by["glm"]!.cooling!.reason).toContain("glm-3");
    expect(by["glm"]!.perEpisode.e90).toMatchObject({ counted: 0, stillborn: 3, attempts: 3, lastReason: "stillborn" });

    expect(by["sonnet"]).toMatchObject({ status: "active", eligible: ["e90"], platform: "claude-code", harness: "claude-code" });
    // The old driver spelling in a roster reads as the same harness (ADR-0035).
    expect(by["sonnet-low"]).toMatchObject({ platform: "claude-code", harness: "claude-code" });
    expect(by["ox"]).toMatchObject({ harness: "wrathbench" });
    expect(by["sonnet"]!.perEpisode.e90).toMatchObject({ counted: 1, bestLevel: 4, reachedL5: false });

    // A live, answered run counts; the per-entry target override applies.
    expect(by["sonnet-low"]!.perEpisode.e90).toMatchObject({ counted: 1, stillborn: 0, target: 1 });
    // No series on the policy: the 0.2 run is an attempt like any other; the extra is an attempt, never counted.
    expect(by["local"]).toMatchObject({ status: "promoted", platform: "local", billing: "free" });
    expect(by["local"]!.perEpisode.e90).toMatchObject({ counted: 1, attempts: 2, extras: 1, otherSeries: 0, target: 3, bestLevel: 7 });
    expect(by["ox"]!.billing).toBe("free"); // allowlisted stealth id
    expect(by["glm"]!.billing).toBe("free");
    expect(by["sonnet"]!.billing).toBe("free"); // subscription
  });

  test("series keying: runs from another series are shown, not counted (ADR-0034)", () => {
    const policy: SchedulingPolicy = { ...DEFAULT_POLICY, series: "0.3" };
    const states = modelStates({ runsDir, roster, policy, now: NOW, sidecar: { version: 1, cleared: {} } });
    const local = states.find((s) => s.name === "local")!;
    expect(local.status).toBe("new");
    expect(local.perEpisode.e90).toMatchObject({ counted: 0, attempts: 2, extras: 1, otherSeries: 1, bestLevel: 2 });
    // Everything else in the fixture is 0.3 and unchanged.
    expect(states.find((s) => s.name === "ox")!.perEpisode.e90).toMatchObject({ counted: 2, attempts: 3, otherSeries: 0 });
    // A policy keyed on a series nothing ran under: every model is new, but
    // attempts still number every run on disk so the next run id is unique.
    const none = modelStates({ runsDir, roster, policy: { ...policy, series: "0.4" }, now: NOW, sidecar: { version: 1, cleared: {} } });
    expect(none.every((s) => s.status === "new" && s.perEpisode.e90!.counted === 0)).toBe(true);
    expect(none.find((s) => s.name === "ox")!.perEpisode.e90!.attempts).toBe(3);
    expect(none.find((s) => s.name === "ox")!.perEpisode.e90!.otherSeries).toBe(3);
  });

  test("a forced tier is eligible without a witness; the pre-tier run never promotes", () => {
    const [s] = modelStates({ runsDir, roster: [{ name: "sonnet", model: "sonnet", driver: "claude-code", tiers: ["e360"] }], now: NOW, sidecar: { version: 1, cleared: {} } });
    expect(s!.eligible).toEqual(["e90", "e360"]);
    expect(s!.status).toBe("promoted");
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
  });
  const m: RosterModel = { name: "m", model: "m" };

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

  test("a paused run is an attempt, never counted, never a rung, and holds the model (ADR-0036)", () => {
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
    expect(v.ok).toBe(false);
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
    expect(schedulability(s).ok).toBe(true);
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
  const st = (name: string, over: Partial<Parameters<typeof projectModel>[1][number]>[] | RunFact[], tiers?: ("e90" | "e360")[]) =>
    projectModel({ name, model: name, tiers: tiers as never }, over as RunFact[], DEFAULT_POLICY, { now: NOW });
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
    expect(schedulability(met)).toEqual({ ok: false, extras: false, why: "targets met on e90" });
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

describe("paid and free (ADR-0034 amendment)", () => {
  const good = (model: string, ep: "e90" | "e360", i: number, level = 3, extra = false): RunFact => ({
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
  });
  const policy: SchedulingPolicy = { ...DEFAULT_POLICY, paid: { ...DEFAULT_PAID, runsPerEpisode: { ...DEFAULT_PAID.runsPerEpisode } }, extras: { characters: [...DEFAULT_EXTRA_CHARACTERS] } };
  const st = (r: RosterModel, runs: RunFact[], p = policy) => projectModel(r, runs, p, { now: NOW });

  test("billing is derived once: slug, LAN, subscription, allowlist, override", () => {
    expect(st({ name: "p", model: "vendor/big" }, []).billing).toBe("paid");
    expect(st({ name: "f", model: "vendor/big:free" }, []).billing).toBe("free");
    expect(st({ name: "c", model: "x-contributor-free", apiBase: "https://opencode.ai/zen/v1" }, []).billing).toBe("free");
    expect(st({ name: "l", model: "vendor/big", apiBase: "http://10.0.0.5:1234/v1" }, []).billing).toBe("free");
    expect(st({ name: "s", model: "opus", driver: "claude-code" }, []).billing).toBe("free");
    expect(st({ name: "o", model: "stealth/ox-alpha" }, []).billing).toBe("free");
    expect(st({ name: "x", model: "vendor/big:free", billing: "paid" }, []).billing).toBe("paid");
  });

  test("paid targets are 3/1 by default and hard; per-entry override still wins; no paid policy means 3/3", () => {
    const p = st({ name: "p", model: "vendor/big" }, [good("vendor/big", "e90", 1, 5)]);
    expect(p.perEpisode.e90!.target).toBe(3);
    expect(p.perEpisode.e360!.target).toBe(1);
    expect(st({ name: "p", model: "vendor/big", runsPerEpisode: { e360: 2 } }, []).perEpisode.e360!.target).toBe(2);
    expect(st({ name: "p", model: "vendor/big" }, [], DEFAULT_POLICY).perEpisode.e360!.target).toBe(3);
    const met = st({ name: "p", model: "vendor/big" }, [good("vendor/big", "e90", 1), good("vendor/big", "e90", 2), good("vendor/big", "e90", 3)]);
    expect(schedulability(met, new Set(), policy)).toMatchObject({ ok: false, extras: false });
    expect(planNextJobs([met], ["R1"], new Set(), { policy })).toEqual({ jobs: [], held: [] });
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
    const met = st({ name: "l1", model: "qwen/q", apiBase: "http://10.0.0.5:1234/v1" }, [
      good("qwen/q", "e90", 1, 5),
      good("qwen/q", "e90", 2),
      good("qwen/q", "e90", 3),
      good("qwen/q", "e360", 4),
      good("qwen/q", "e360", 5),
      good("qwen/q", "e360", 6),
    ]);
    const extras = planNextJobs([met], ["R1"], new Set(), { policy, classAccounts: { local: ["BOX"] } });
    expect(extras.jobs.map((j) => [j.name, j.account, j.extra !== undefined])).toEqual([["l1", "BOX", true]]);
    expect(planNextJobs([met], ["R1"], new Set(), { policy, classAccounts: { local: [] } }).jobs).toEqual([]);
  });

  test("extras: free models past their targets get lowest-priority runs, cycling characters; e360 extras only when promoted", () => {
    const chars = policy.extras!.characters;
    const metFree = st({ name: "f", model: "v/f:free" }, [good("v/f:free", "e90", 1, 5), good("v/f:free", "e90", 2), good("v/f:free", "e90", 3), good("v/f:free", "e360", 4), good("v/f:free", "e360", 5), good("v/f:free", "e360", 6)]);
    expect(schedulability(metFree, new Set(), policy)).toMatchObject({ ok: false, extras: true });
    expect(schedulability(metFree, new Set(), policy).why).toContain("extras");
    const unpromoted = st({ name: "u", model: "v/u:free" }, [good("v/u:free", "e90", 1), good("v/u:free", "e90", 2), good("v/u:free", "e90", 3)]);
    const fresh = st({ name: "n", model: "v/n:free" }, []);
    const metPaid = st({ name: "p", model: "v/p" }, [good("v/p", "e90", 1), good("v/p", "e90", 2), good("v/p", "e90", 3)]);
    const plan = planNextJobs([metFree, unpromoted, fresh, metPaid], ["R1", "R2", "R3", "R4"], new Set(), { policy });
    // The fresh model first (a real target); then extras, e90 before e360, fewest extras first; paid never.
    expect(plan.jobs.map((j) => [j.name, j.episode, j.extra])).toEqual([
      ["n", "e90", undefined],
      ["f", "e90", chars[0]],
      ["u", "e90", chars[0]],
    ]);
    expect(plan.jobs[1]!.attempt).toBe(4);
    expect(plan.jobs[1]!.why).toContain("extra #1");
    // The cycle: with two extras already made, the third takes characters[2]; an extra is an attempt, never counted.
    const twoExtras = st({ name: "f", model: "v/f:free" }, [...[1, 2, 3].map((i) => good("v/f:free", "e90", i, 5)), good("v/f:free", "e90", 7, 2, true), good("v/f:free", "e360", 8, 2, true)]);
    expect(twoExtras.perEpisode.e90).toMatchObject({ counted: 3, attempts: 4, extras: 1 });
    expect(twoExtras.perEpisode.e360).toMatchObject({ counted: 0, attempts: 1, extras: 1, target: 3 });
    // e360 target is still open, so that is a real pick, not an extra.
    const next = planNextJobs([twoExtras], ["R1"], new Set(), { policy }).jobs[0]!;
    expect(next).toMatchObject({ episode: "e360", attempt: 2 });
    expect(next.extra).toBeUndefined();
    // With e360 met too, the next extra is the third in the cycle; accounts nothing else wants are the only ones extras take.
    const allMet = st({ name: "f", model: "v/f:free" }, [...twoExtras.perEpisode.e90!.counted > 0 ? [] : [], ...[1, 2, 3].map((i) => good("v/f:free", "e90", i, 5)), ...[4, 5, 6].map((i) => good("v/f:free", "e360", i)), good("v/f:free", "e90", 7, 2, true), good("v/f:free", "e360", 8, 2, true)]);
    expect(planNextJobs([allMet], ["R1"], new Set(), { policy }).jobs[0]!.extra).toEqual(chars[2]!);
    expect(planNextJobs([allMet, fresh], ["R1"], new Set(), { policy }).jobs.map((j) => j.name)).toEqual(["n"]);
    // No extras policy: nothing.
    expect(planNextJobs([allMet], ["R1"], new Set(), { policy: { ...policy, extras: null } }).jobs).toEqual([]);
    // An extra is a free model's run and only ever lands on a free account.
    expect(planNextJobs([allMet], [], new Set(), { policy, paidAccounts: ["PAID"] }).jobs).toEqual([]);
    expect(planNextJobs([allMet], ["R1"], new Set(), { policy, paidAccounts: ["PAID"] }).jobs.map((j) => j.account)).toEqual(["R1"]);
  });
});
