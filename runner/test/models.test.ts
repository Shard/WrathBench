import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_POLICY,
  LADDER_MS,
  countModelResponses,
  modelStates,
  nextJobs,
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
}

function writeRun(runsDir: string, r: SynthRun): void {
  const dir = join(runsDir, r.id);
  mkdirSync(dir, { recursive: true });
  if (!r.noMeta) {
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        runId: r.id,
        harnessVersion: "harness-0.3-test",
        startedAt: r.startedAt,
        config: { model: r.model, ...(r.effort !== undefined ? { effort: r.effort } : {}) },
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
  { name: "sonnet", model: "sonnet", driver: "claude-subscription" },
  { name: "sonnet-low", model: "sonnet", effort: "low", driver: "claude-subscription", runsPerEpisode: { e90: 1 } },
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
    expect(facts.map((f) => f.runId)).toEqual(["glm-1", "ox-1", "sonnet-1", "ox-2", "ox-3", "glm-2", "glm-3", "sonnet-low-1"]);
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

    expect(by["sonnet"]).toMatchObject({ status: "active", eligible: ["e90"], platform: "claude-subscription" });
    expect(by["sonnet"]!.perEpisode.e90).toMatchObject({ counted: 1, bestLevel: 4, reachedL5: false });

    // A live, answered run counts; the per-entry target override applies.
    expect(by["sonnet-low"]!.perEpisode.e90).toMatchObject({ counted: 1, stillborn: 0, target: 1 });
    expect(by["local"]).toMatchObject({ status: "new", platform: "local" });
    expect(by["local"]!.perEpisode.e90).toMatchObject({ counted: 0, attempts: 0, target: 3 });
  });

  test("a forced tier is eligible without a witness; the pre-tier run never promotes", () => {
    const [s] = modelStates({ runsDir, roster: [{ name: "sonnet", model: "sonnet", driver: "claude-subscription", tiers: ["e360"] }], now: NOW, sidecar: { version: 1, cleared: {} } });
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
    startedAt: endedAt - 60_000,
    endedAt,
    terminationReason: reason,
    modelResponses: responses,
    bestLevel: null,
    live: false,
  });
  const m: RosterModel = { name: "m", model: "m" };

  test("rungs escalate with consecutive failures and the deadline is the last failure plus the rung", () => {
    const runs = [fail(1, NOW - 10 * HOUR), fail(2, NOW - 9 * HOUR), fail(3, NOW - 1000)];
    const s = projectModel(m, runs, DEFAULT_POLICY, { now: NOW });
    expect(s.status).toBe("cooling");
    expect(s.cooling).toMatchObject({ rung: 3, until: NOW - 1000 + LADDER_MS[2]! });
  });

  test("a run that got off the ground resets the ladder even if it ended badly", () => {
    const runs = [fail(1, NOW - 10 * HOUR), fail(2, NOW - 9 * HOUR), fail(3, NOW - 1000, "harness-error", 7)];
    const s = projectModel(m, runs, DEFAULT_POLICY, { now: NOW });
    expect(s.ladder).toBe(0);
    expect(s.status).toBe("active");
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
    startedAt: NOW - (100 - i) * HOUR,
    endedAt: NOW - (99 - i) * HOUR,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
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
    expect(schedulability(met)).toEqual({ ok: false, why: "targets met on e90" });
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
