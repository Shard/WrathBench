/**
 * `/api/models`: the roster's rows, the ids behind their counts, and the one
 * thing the route is allowed to add — the text a model died of.
 *
 * The projection itself is tested in `models.test.ts`; what is asserted here is
 * that the route serves it rather than recomputing it, that the counted and
 * stillborn id lists agree with the counts they sit beside, and that an error
 * message carrying a bearer token does not reach a client. The leak assertion
 * is on the token's *value*, like `viewer-api.test.ts`: a message interpolates
 * a secret into prose, where a field-name rule cannot see it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { ERROR_MAX_CHARS, currentSeries, lastErrorOf, readFleetRoster } from "../viewer/models";
import type { ModelsResponse } from "../viewer/api-types";

const SENTINEL = "sentinel-bearer-9d31ff";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const roots: string[] = [];

interface Synth {
  harnessVersion?: string;
  id: string;
  model: string;
  effort?: string;
  episode?: string;
  responses: number;
  level?: number;
  reason?: string | null;
  detail?: string;
  startedAt: number;
  endedAt: number;
}

function writeRun(runsDir: string, r: Synth): void {
  const dir = join(runsDir, r.id);
  mkdirSync(dir, { recursive: true });
  const config = { model: r.model, token: SENTINEL, ...(r.effort !== undefined ? { effort: r.effort } : {}) };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId: r.id,
      // This checkout's series, so the route counts the run (ADR-0034 keys on the series).
      harnessVersion: r.harnessVersion ?? `harness-${currentSeries() ?? "0.0"}-test`,
      startedAt: r.startedAt,
      config,
      comparability: { effort: r.effort ?? null, episode: r.episode ?? "e90" },
    }),
  );
  const lines: string[] = [`{"t":"meta","ts":${r.startedAt}}`];
  for (let i = 0; i < r.responses; i++) {
    lines.push(JSON.stringify({ ts: r.startedAt + 1 + i, t: "response", text: "x" }));
  }
  if (r.reason !== undefined && r.reason !== null) {
    lines.push(JSON.stringify({ ts: r.endedAt, t: "termination", reason: r.reason, detail: r.detail ?? "" }));
  }
  writeFileSync(join(dir, "trajectory.jsonl"), lines.join("\n") + "\n");
  const secs = r.endedAt / 1000;
  utimesSync(join(dir, "trajectory.jsonl"), secs, secs);

  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, adapter TEXT, shakeout TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    r.id, r.model, "openai", "openai", null, "harness-test", r.startedAt, r.endedAt,
    r.reason ?? null, r.detail ?? null, null, JSON.stringify(config),
  ]);
  db.run(
    `CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
       x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
       quests_completed INTEGER)`,
  );
  if (r.level !== undefined) {
    db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      r.id, r.startedAt + 60_000, r.level, 100, 0, 1, 2, 3, 1, 1, 0, 0,
    ]);
  }
  db.close();
}

/** A runs directory and a fleet config beside it. */
function fixture(fleet: unknown): { runsDir: string; fleetPath: string } {
  const root = mkdtempSync(join(tmpdir(), "viewer-models-"));
  roots.push(root);
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const fleetPath = join(root, "fleet.json");
  writeFileSync(fleetPath, JSON.stringify(fleet));
  return { runsDir, fleetPath };
}

const ROSTER = {
  roster: {
    alpha: { model: "vendor/alpha", character: "A" },
    "alpha-low": { model: "vendor/alpha", effort: "low" },
    beta: { model: "vendor/beta", apiBase: "https://openrouter.ai/api/v1" },
  },
  policy: { runsPerEpisode: { e90: 3, e360: 3 } },
};

async function models(runsDir: string, fleetPath: string | undefined): Promise<ModelsResponse> {
  const handle = createApi({ runsDir, tilesDir: join(runsDir, "tiles"), fleetConfigPath: fleetPath });
  const res = await handle(new Request("http://x/api/models"));
  expect(res.status).toBe(200);
  return (await res.json()) as ModelsResponse;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("readFleetRoster", () => {
  test("reads the ADR-0031 roster map, with effort and policy", () => {
    const { fleetPath } = fixture(ROSTER);
    const read = readFleetRoster(fleetPath);
    expect(read.shape).toBe("roster");
    expect(read.models.map((m) => m.name)).toEqual(["alpha", "alpha-low", "beta"]);
    expect(read.models[1]!.effort).toBe("low");
    expect(read.policy.runsPerEpisode.e90).toBe(3);
  });

  test("a policy block overrides the default targets", () => {
    const { fleetPath } = fixture({ ...ROSTER, policy: { runsPerEpisode: { e90: 5 } } });
    const read = readFleetRoster(fleetPath);
    expect(read.policy.runsPerEpisode.e90).toBe(5);
    expect(read.policy.runsPerEpisode.e360).toBe(3);
  });

  // FOLLOW-UPS 52: the same predicate the supervisor schedules on.
  test("names the entries the policy does not schedule, with why", () => {
    const { fleetPath } = fixture({
      ...ROSTER,
      roster: { ...ROSTER.roster, probe: { model: "vendor/alpha", objective: "ride the tram" } },
      queue: [
        { ref: "probe", episode: "freeplay", account: "SHAKEOUT", repeat: "loop", enabled: true },
        { ref: "alpha", episode: "e90" },
      ],
      policy: { ...ROSTER.policy, maxConcurrent: { "claude-code": 2 } },
    });
    const read = readFleetRoster(fleetPath);
    // Pinned wins the sentence: the account is spoken for either way.
    expect(read.excluded).toEqual([
      { name: "probe", reason: "pinned to SHAKEOUT by job probe-freeplay" },
    ]);
    // A pool job holds its ref without pinning it: still the policy's to schedule.
    expect(read.models.map((m) => m.name)).toContain("alpha");
    expect(read.maxConcurrent).toEqual({ "claude-code": 2 });
  });

  test("an objective excludes an entry no job names", () => {
    const { fleetPath } = fixture({
      ...ROSTER,
      roster: { ...ROSTER.roster, probe: { model: "vendor/alpha", objective: "ride the tram" } },
    });
    expect(readFleetRoster(fleetPath).excluded).toEqual([
      { name: "probe", reason: "carries an objective (unscored probe)" },
    ]);
  });

  test("a pre-roster config is legacy and empty, never a synthesised roster", () => {
    const { fleetPath } = fixture({ lanes: [{ name: "l", entries: [{ model: "vendor/alpha" }] }] });
    const read = readFleetRoster(fleetPath);
    expect(read.shape).toBe("legacy");
    expect(read.models).toEqual([]);
  });

  test("absent and unreadable are labelled, not thrown", () => {
    expect(readFleetRoster(undefined).shape).toBe("missing");
    expect(readFleetRoster("/nope/fleet.json").shape).toBe("missing");
    const root = mkdtempSync(join(tmpdir(), "viewer-models-bad-"));
    roots.push(root);
    const p = join(root, "fleet.json");
    writeFileSync(p, "{ not json");
    expect(readFleetRoster(p).shape).toBe("unreadable");
  });
});

describe("/api/models", () => {
  test("one row per roster entry, with the ids behind the counts", async () => {
    const { runsDir, fleetPath } = fixture(ROSTER);
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 4, level: 3, reason: "episode-limit", startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR });
    writeRun(runsDir, { id: "a-2", model: "vendor/alpha", responses: 2, level: 2, reason: "idle", startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR });
    // Never produced a response: a launch that did not happen.
    writeRun(runsDir, { id: "a-3", model: "vendor/alpha", responses: 0, reason: "adapter-error", detail: "provider said no", startedAt: NOW - HOUR, endedAt: NOW - HOUR + 1000 });
    writeRun(runsDir, { id: "lo-1", model: "vendor/alpha", effort: "low", responses: 3, level: 4, reason: "episode-limit", startedAt: NOW - 6 * HOUR, endedAt: NOW - 5 * HOUR });

    const body = await models(runsDir, fleetPath);
    expect(body.models.map((m) => m.name)).toEqual(["alpha", "alpha-low", "beta"]);
    expect(body.roster.shape).toBe("roster");

    const alpha = body.models[0]!;
    const e90 = alpha.perEpisode.e90!;
    expect(e90.counted).toBe(2);
    expect(e90.runIds).toEqual(["a-2", "a-1"]);
    expect(e90.stillborn).toBe(1);
    expect(e90.stillbornRunIds).toEqual(["a-3"]);
    expect(e90.counted).toBe(e90.runIds.length);
    expect(e90.stillborn).toBe(e90.stillbornRunIds.length);
    expect(e90.target).toBe(3);
    expect(e90.bestLevel).toBe(3);
    expect(alpha.runs.map((r) => r.runId)).toEqual(["a-3", "a-2", "a-1"]);
    expect(alpha.runs[1]!.durationMs).toBe(HOUR);
    expect(alpha.newestRunId).toBe("a-3");

    // Effort separates the two rows: the projection matches on (model, effort).
    const low = body.models[1]!;
    expect(low.effort).toBe("low");
    expect(low.perEpisode.e90!.runIds).toEqual(["lo-1"]);
    // A model with no runs is `new`, and its platform comes off the api base.
    const beta = body.models[2]!;
    expect(beta.status).toBe("new");
    expect(beta.platform).toBe("openrouter");
    expect(beta.runs).toEqual([]);
    expect(beta.lastError).toBeNull();
  });

  test("promotion and eligibility come from the projection, not the route", async () => {
    const { runsDir, fleetPath } = fixture(ROSTER);
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 5, level: 7, reason: "episode-limit", startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR });
    const body = await models(runsDir, fleetPath);
    const alpha = body.models[0]!;
    expect(alpha.perEpisode.e90!.reachedL5).toBe(true);
    expect(alpha.eligible).toEqual(["e90", "e360"]);
    expect(alpha.status).toBe("promoted");
    expect(alpha.perEpisode.e360!.counted).toBe(0);
    expect(body.policy.promoteAtLevel).toBe(5);
    expect(body.ladderMs.length).toBeGreaterThan(0);
  });

  test("a run that just failed leaves the model cooling, with the reason", async () => {
    const { runsDir, fleetPath } = fixture(ROSTER);
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 0, reason: "adapter-error", detail: "402 credits", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 });
    const body = await models(runsDir, fleetPath);
    const alpha = body.models[0]!;
    expect(alpha.status).toBe("cooling");
    expect(alpha.cooling!.rung).toBe(1);
    expect(alpha.ladder).toBe(1);
  });

  test("lastError is the newest failed run's message, truncated and scrubbed", async () => {
    const { runsDir, fleetPath } = fixture(ROSTER);
    const long = `HTTP 500 from https://api.example/v1?key=${SENTINEL} — ${"x".repeat(600)}`;
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 1, reason: "adapter-error", detail: long, startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR });
    // The newest run is fine; the row still owes the operator the earlier text.
    writeRun(runsDir, { id: "a-2", model: "vendor/alpha", responses: 3, level: 2, reason: "episode-limit", startedAt: NOW - HOUR, endedAt: NOW });

    const body = await models(runsDir, fleetPath);
    const err = body.models[0]!.lastError!;
    expect(err.runId).toBe("a-1");
    expect(err.reason).toBe("adapter-error");
    expect(err.message.length).toBeLessThanOrEqual(ERROR_MAX_CHARS + 1);
    expect(err.message).toContain("HTTP 500");
    // The bearer token was interpolated into the message; it must not come back.
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(err.message).toContain("[redacted]");
  });

  test("lastErrorOf ignores a clean termination and a run with none", () => {
    const { runsDir } = fixture(ROSTER);
    writeRun(runsDir, { id: "ok-1", model: "vendor/alpha", responses: 2, reason: "episode-limit", detail: "90m", startedAt: NOW, endedAt: NOW + HOUR });
    writeRun(runsDir, { id: "none-1", model: "vendor/alpha", responses: 2, reason: null, startedAt: NOW, endedAt: NOW + HOUR });
    expect(lastErrorOf(join(runsDir, "ok-1"), "ok-1")).toBeNull();
    expect(lastErrorOf(join(runsDir, "none-1"), "none-1")).toBeNull();
    expect(lastErrorOf(join(runsDir, "gone"), "gone")).toBeNull();
  });

  test("a legacy fleet config serves an empty, labelled roster", async () => {
    const { runsDir, fleetPath } = fixture({ lanes: [{ name: "l", entries: [{ model: "vendor/alpha" }] }] });
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 2, reason: "idle", startedAt: NOW, endedAt: NOW + HOUR });
    const body = await models(runsDir, fleetPath);
    expect(body.models).toEqual([]);
    expect(body.roster.shape).toBe("legacy");
    expect(body.roster.count).toBe(0);
  });

  /*
   * FOLLOW-UPS 52: `probe` is `vendor/alpha` under an objective, so a row for
   * it would show alpha's counts a second time under another name. It is named
   * in `roster.excluded`, with the concurrency cap the file sets, and rowed
   * nowhere.
   */
  test("pinned and objective entries are named, not rowed", async () => {
    const { runsDir, fleetPath } = fixture({
      ...ROSTER,
      roster: { ...ROSTER.roster, probe: { model: "vendor/alpha", objective: "ride the tram" } },
      queue: [{ ref: "probe", episode: "freeplay", account: "SHAKEOUT", repeat: "loop", enabled: true }],
      policy: { ...ROSTER.policy, maxConcurrent: { "claude-code": 2 } },
    });
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 4, level: 3, reason: "episode-limit", startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR });

    const body = await models(runsDir, fleetPath);
    expect(body.models.map((m) => m.name)).toEqual(["alpha", "alpha-low", "beta"]);
    expect(body.roster.count).toBe(4);
    expect(body.roster.excluded.map((e) => e.name)).toEqual(["probe"]);
    expect(body.policy.maxConcurrent).toEqual({ "claude-code": 2 });
  });

  test("no fleet config at all is a normal answer, not a 500", async () => {
    const { runsDir } = fixture(ROSTER);
    const body = await models(runsDir, undefined);
    expect(body.roster.shape).toBe("missing");
    expect(body.roster.path).toBeNull();
    expect(body.models).toEqual([]);
  });

  test("unstamped runs are invisible: the tiers are never back-labeled", async () => {
    const { runsDir, fleetPath } = fixture(ROSTER);
    const dir = join(runsDir, "old-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ runId: "old-1", startedAt: NOW, config: { model: "vendor/alpha" } }),
    );
    writeFileSync(join(dir, "trajectory.jsonl"), `{"t":"response","ts":${NOW}}\n`);
    const body = await models(runsDir, fleetPath);
    expect(body.models[0]!.runs).toEqual([]);
    expect(body.models[0]!.perEpisode.e90!.attempts).toBe(0);
  });
});
