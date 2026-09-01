/**
 * `/api/models`: the roster's rows, the ids behind their counts, and the one
 * thing the route is allowed to add — the text a model died of.
 *
 * The projection itself is tested in `models.test.ts`; what is asserted here is
 * that the route serves it rather than recomputing it, that the counted and
 * counted id lists agree with the counts they sit beside, and that an error
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
  /** The id the CLI's init record named, for the back-fill. */
  resolved?: string;
}

function writeRun(runsDir: string, r: Synth): void {
  const dir = join(runsDir, r.id);
  mkdirSync(dir, { recursive: true });
  const config = { model: r.model, token: SENTINEL, ...(r.effort !== undefined ? { effort: r.effort } : {}) };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId: r.id,
      // This checkout's series, so the route counts the run (the schedule keys on the series).
      harnessVersion: r.harnessVersion ?? `harness-${currentSeries() ?? "0.0"}-test`,
      startedAt: r.startedAt,
      config,
      comparability: { effort: r.effort ?? null, episode: r.episode ?? "e90" },
    }),
  );
  const lines: string[] = [`{"t":"meta","ts":${r.startedAt}}`];
  if (r.resolved !== undefined) {
    lines.push(
      JSON.stringify({
        ts: r.startedAt, t: "claude_system", type: "system", subtype: "init",
        model: r.resolved, claude_code_version: "2.1.239",
      }),
    );
  }
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
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    r.id, r.model, "openai", null, "harness-test", r.startedAt, r.endedAt,
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
    alpha: { model: "vendor/alpha", character: "A", tier: "t1" },
    "alpha-low": { model: "vendor/alpha", effort: "low", tier: "t1" },
    beta: { model: "vendor/beta", apiBase: "https://openrouter.ai/api/v1", tier: "t1" },
  },
  policy: { maxConcurrent: { openrouter: 1 } },
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
  test("reads the roster map, with effort and policy", () => {
    const { fleetPath } = fixture(ROSTER);
    const read = readFleetRoster(fleetPath);
    expect(read.shape).toBe("roster");
    expect(read.models.map((m) => m.name)).toEqual(["alpha", "alpha-low", "beta"]);
    expect(read.models[1]!.effort).toBe("low");
    expect(read.models.map((m) => m.tier)).toEqual(["t1", "t1", "t1"]);
    expect(read.maxConcurrent["openrouter"]).toBe(1);
  });

  test("an entry with no tier is not the viewer's to reject — it is skipped, not rowed", () => {
    // The supervisor is what refuses a bad config; the viewer reads one. An
    // untiered entry is either steered (outside the policy) or a mistake the
    // supervisor is already naming, and either way it owns no evidence budget.
    const { fleetPath } = fixture({ ...ROSTER, roster: { ...ROSTER.roster, nope: { model: "vendor/nope" } } });
    const read = readFleetRoster(fleetPath);
    expect(read.shape).toBe("roster");
    expect(read.models.map((m) => m.name)).toEqual(["alpha", "alpha-low", "beta"]);
  });

  // item 52: the same predicate the supervisor schedules on.
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

  test("an entry is excluded only by a pinned job, never by anything on itself", () => {
    // The viewer is deliberately lenient about a config the supervisor would
    // refuse — it reports what a file says rather than adjudicating it — so an
    // entry with a stray objective is still read. It is simply not a reason:
    // since campaigns took over steering nothing on an entry takes it out of the policy, and a
    // campaign borrows a model rather than removing it from the schedule.
    const { fleetPath } = fixture({
      ...ROSTER,
      roster: { ...ROSTER.roster, probe: { model: "vendor/alpha", tier: "t1", objective: "ride the tram" } },
    });
    expect(readFleetRoster(fleetPath).excluded).toEqual([]);
    expect(readFleetRoster(fleetPath).models.some((m) => m.name === "probe")).toBe(true);
  });

  test("a config without a roster map is unreadable and empty, never a synthesised roster", () => {
    const { fleetPath } = fixture({ queue: [{ ref: "alpha" }] });
    const read = readFleetRoster(fleetPath);
    expect(read.shape).toBe("unreadable");
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

describe("/api/models and the resolved model id", () => {
  test("a row keeps its roster grouping and shows every id its runs were really on", async () => {
    const { runsDir, fleetPath } = fixture(ROSTER);
    // One roster entry, two ids: the alias moved under it between runs. That is
    // exactly the drift the page must show rather than average into one row.
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 2, level: 3, reason: "episode-limit", resolved: "vendor/alpha-2026-05", startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR });
    writeRun(runsDir, { id: "a-2", model: "vendor/alpha", responses: 2, level: 2, reason: "idle", resolved: "vendor/alpha-2026-08", startedAt: NOW - 3 * HOUR, endedAt: NOW - 2 * HOUR });
    // A different entry, and a run that named nothing: "not recorded", never
    // back-labelled with the string it was launched under.
    writeRun(runsDir, { id: "b-1", model: "vendor/beta", responses: 2, level: 2, reason: "idle", startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR });

    const body = await models(runsDir, fleetPath);
    const alpha = body.models.find((m) => m.name === "alpha")!;
    expect(alpha.model).toBe("vendor/alpha");
    expect(alpha.resolvedModels).toEqual(["vendor/alpha-2026-05", "vendor/alpha-2026-08"]);
    expect(new Map(alpha.runs.map((r) => [r.runId, r.resolvedModel])).get("a-1")).toBe("vendor/alpha-2026-05");
    const beta = body.models.find((m) => m.name === "beta")!;
    expect(beta.resolvedModels).toEqual([]);
    expect(beta.runs[0]!.resolvedModel).toBeNull();
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
    expect(e90.counted).toBe(e90.runIds.length);
    // The API carries no zero-response state: such a run is archived at exit.
    expect("stillborn" in e90).toBe(false);
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

  test("a fleet config without a roster serves an empty, labelled roster", async () => {
    const { runsDir, fleetPath } = fixture({ queue: [{ ref: "alpha" }] });
    writeRun(runsDir, { id: "a-1", model: "vendor/alpha", responses: 2, reason: "idle", startedAt: NOW, endedAt: NOW + HOUR });
    const body = await models(runsDir, fleetPath);
    expect(body.models).toEqual([]);
    expect(body.roster.shape).toBe("unreadable");
    expect(body.roster.count).toBe(0);
  });

  /*
   * item 52: `probe` is `vendor/alpha` under an objective, so a row for
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
