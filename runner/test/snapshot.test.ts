/**
 * The snapshot renderer, end to end over a real (fixture) runs directory: the
 * artifact set, the cache classes, the content addressing, and — because the
 * renderer is the last thing a byte crosses before a bucket — the same
 * value-based leak checks the projection suite makes, here against every
 * artifact body the render produces.
 *
 * The fixture is poisoned the way a real runs directory is dangerous: game-text
 * item names in the state samples, a character name in the config, free-text
 * termination/pause columns, a bearer token, a LAN api base, the operator's
 * paths in fleet-state.json, a smoke tail. None of it may appear in any body.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMMUTABLE_CACHE, MUTABLE_CACHE, renderSnapshot, type SnapshotResult } from "../viewer/snapshot";
import { PUBLIC_ATTRIBUTION } from "../viewer/public-projection";

const DEAD_RUN = "snap-run-dead";
const LIVE_RUN = "snap-run-live";

const SECRET = "sentinel-bearer-9f31ab";
const POISON = {
  itemName: "Poisoned Worn Shortsword",
  character: "Poisonedcharname",
  terminationDetail: "poison-termination-detail",
  pauseReason: "poison-pause-reason-text",
  objective: "poison-objective-text",
  apiHost: "10.66.66.66",
  wikiSource: "poison-dump-20100901.xml.bz2",
  rosterPath: "/home/operator/poison/roster.json",
  fleetConfig: "/home/operator/poison/fleet.json",
  preflightTail: "poison-smoke-tail",
} as const;
const POISON_PID = 987654321;

/** A tuple `parseComparability` accepts, with the poisoned wiki-bundle source. */
const TUPLE = {
  harnessVersion: "harness-0.5-1-gabc",
  promptHash: "sha256:0123456789abcdef",
  promptChars: 4242,
  harness: "wrathbench",
  effort: "high",
  budget: {
    maxTurns: null,
    maxToolCalls: 3000,
    idleMs: 600_000,
    noXpMs: null,
    episodeMs: 5_400_000,
    maxSandboxRestarts: 3,
  },
  objective: false,
  wikiCoords: true,
  wikiBundle: { schemaVersion: "1", builtAt: "2026-08-01", source: POISON.wikiSource, eraCutoff: "2010-09-01" },
  episode: "e90",
  episodeOverride: false,
  serverBuild: { build: "harness-0.5-1-gdef", startedAtMs: 12_345 },
};

function writeRun(
  runs: string,
  runId: string,
  opts: { terminated: boolean; stateTs: number; old: boolean },
): void {
  const dir = join(runs, runId);
  mkdirSync(dir, { recursive: true });
  const config = {
    runId,
    moduleUrl: "http://worldserver:8086",
    token: SECRET,
    character: POISON.character,
    account: "RUNNER",
    model: "test/model",
    driver: "openai",
    race: 3,
    class: 3,
    apiBase: `http://${POISON.apiHost}:1234/v1`,
    objective: POISON.objective,
    campaign: "sweep-1",
    cell: "cell-a",
    apiKeyEnv: "OPENROUTER_KEY",
  };
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ runId, harnessVersion: "harness-0.5-1-gabc", startedAt: 1000, comparability: TUPLE, config }),
  );
  const lines = [
    { ts: 1000, t: "meta", runId, harnessVersion: "harness-0.5-1-gabc", config },
    { ts: 1100, t: "response", turn: 1, message: { role: "assistant", content: "hello" } },
    { ts: 1200, t: "snippet", turn: 1, code: "await sdk.moveTo(1, 2, 3);" },
    ...(opts.terminated ? [{ ts: 2000, t: "termination", reason: "episode-limit" }] : []),
  ];
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    runId,
    "test/model",
    "openai",
    null,
    "harness-0.5-1-gabc",
    1000,
    opts.terminated ? 2000 : null,
    opts.terminated ? "episode-limit" : null,
    opts.terminated ? POISON.terminationDetail : null,
    opts.terminated ? POISON.pauseReason : null,
    JSON.stringify(config),
  ]);
  db.run(
    `CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
       x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
       quests_completed INTEGER, items TEXT)`,
  );
  db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    runId,
    opts.stateTs,
    3,
    400,
    0,
    -6240,
    380,
    385,
    12,
    99,
    1234,
    2,
    JSON.stringify([{ name: POISON.itemName, count: 1, equipped: true }]),
  ]);
  db.close();

  if (opts.old) {
    // Cold files: the run reads dead and the render is byte-stable, which is
    // what lets the version-key test re-render and land on the same address.
    const past = new Date(Date.now() - 60 * 60_000);
    for (const name of ["meta.json", "trajectory.jsonl", "run.sqlite"]) {
      utimesSync(join(dir, name), past, past);
    }
  }
}

function fixture(withLive = true): string {
  const runs = mkdtempSync(join(tmpdir(), "snapshot-"));
  writeRun(runs, DEAD_RUN, { terminated: true, stateTs: 1500, old: true });
  // A live, unterminated run with a fresh position, so live.json's positions
  // feed is non-empty and its character/items withholding is exercised. The
  // generation-stability test leaves it out: a live run's growing playtime is
  // data, and data is supposed to move the generation.
  if (withLive) writeRun(runs, LIVE_RUN, { terminated: false, stateTs: Date.now(), old: false });

  writeFileSync(
    join(runs, "fleet-state.json"),
    JSON.stringify({
      fleetPid: POISON_PID,
      startedAt: 1,
      heartbeatAt: 2,
      containerized: true,
      stamp: "20260825",
      fleetConfig: POISON.fleetConfig,
      configLoadedAt: 3,
      preflight: {
        at: 5,
        serverIdentity: "build:x@1",
        build: "harness-0.5-1-gabc",
        ok: true,
        results: [{ script: "infra/smoke/a.ts", ok: true, ms: 20_000, tail: POISON.preflightTail }],
      },
      accounts: { pool: { RUNNER: "job-a" } },
      jobs: {
        "job-a": {
          ref: "a",
          episode: "e90",
          account: "RUNNER",
          source: "policy",
          models: ["test/model"],
          pid: POISON_PID,
          rosterPath: POISON.rosterPath,
          jsonl: "j",
          log: "l",
          spawnedAt: 1,
          exitCode: null,
          draining: false,
          alive: true,
        },
      },
      paused: [],
      ended: [],
    }),
  );
  return runs;
}

const SNAP_NAMES = [
  "info.json",
  "runs.json",
  "results.json",
  "ladder-e90.json",
  "ladder-e360.json",
  "ladder-probing.json",
  "ladder-freeplay.json",
  "episodes.json",
  "models.json",
  "campaigns.json",
];

async function render(runs: string, now: number): Promise<SnapshotResult> {
  return await renderSnapshot({ runsDir: runs, now });
}

describe("renderSnapshot", () => {
  test("the cache-control constants are the contract's", () => {
    expect(MUTABLE_CACHE).toBe("public, max-age=30");
    expect(IMMUTABLE_CACHE).toBe("public, max-age=31536000, immutable");
  });

  test("renders the complete artifact set with the right cache classes", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    const paths = out.artifacts.map((a) => a.path);

    expect(paths).toContain("v1/manifest.json");
    expect(paths).toContain("v1/live.json");
    for (const name of SNAP_NAMES) expect(paths).toContain(`v1/snap/${out.gen}/${name}`);
    // One detail and one track per run on disk, and nothing else.
    const runPaths = paths.filter((p) => p.startsWith("v1/run/"));
    expect(runPaths).toHaveLength(4);
    for (const id of [DEAD_RUN, LIVE_RUN]) {
      expect(runPaths.filter((p) => p.startsWith(`v1/run/${id}/`)).map((p) => p.split("/").at(-1)).sort()).toEqual([
        "detail.json",
        "track.json",
      ]);
    }
    expect(paths).toHaveLength(2 + SNAP_NAMES.length + 4);

    for (const a of out.artifacts) {
      expect(a.contentType).toBe("application/json");
      const mutable = a.path === "v1/manifest.json" || a.path === "v1/live.json";
      expect(`${a.path}: ${a.cacheControl}`).toBe(`${a.path}: ${mutable ? MUTABLE_CACHE : IMMUTABLE_CACHE}`);
    }
  });

  test("no artifact path names a withheld surface", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    for (const a of out.artifacts) {
      expect(a.path).not.toMatch(/tiles|scratchpad|entries|raw/);
      expect(a.path.startsWith("/")).toBe(false);
    }
  });

  test("every body parses and carries the envelope", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    for (const a of out.artifacts) {
      const body = JSON.parse(a.body) as { generatedAt?: unknown; attribution?: unknown };
      expect(`${a.path}: ${body.generatedAt}`).toBe(`${a.path}: 111`);
      expect(body.attribution).toBe(PUBLIC_ATTRIBUTION);
    }
    // The two mutable bodies say what they are for.
    const manifest = JSON.parse(out.artifacts.find((a) => a.path === "v1/manifest.json")!.body) as { gen: string };
    expect(manifest.gen).toBe(out.gen);
    const live = JSON.parse(out.artifacts.find((a) => a.path === "v1/live.json")!.body) as {
      fleet: { present: boolean; jobs: unknown[] };
      positions: { positions: { runId: string; character: null }[] };
    };
    expect(live.fleet.present).toBe(true);
    expect(live.positions.positions.map((p) => p.runId)).toEqual([LIVE_RUN]);
    expect(live.positions.positions[0]!.character).toBeNull();
  });

  test("no poisoned value reaches any artifact body", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    for (const a of out.artifacts) {
      for (const [name, value] of Object.entries(POISON)) {
        expect(`${a.path} ${name}: ${a.body}`).not.toContain(value);
      }
      expect(`${a.path}: ${a.body}`).not.toContain(SECRET);
      expect(`${a.path}: ${a.body}`).not.toContain(String(POISON_PID));
    }
  });

  test("runs.json rows point at the run artifacts; manifest gen addresses the snap set", async () => {
    const runs = fixture();
    const out = await render(runs, 111);
    const paths = new Set(out.artifacts.map((a) => a.path));
    const listed = JSON.parse(out.artifacts.find((a) => a.path === `v1/snap/${out.gen}/runs.json`)!.body) as {
      runs: {
        runId: string;
        character: string | null;
        pauseReason: string | null;
        terminationDetail: string | null;
        snapshot?: { detail: string; track: string };
      }[];
    };
    expect(listed.runs).toHaveLength(2);
    const dead = listed.runs.find((r) => r.runId === DEAD_RUN)!;
    expect(dead.pauseReason).toBe("paused");
    expect(dead.terminationDetail).toBeNull();
    expect(dead.character).toBeNull();
    for (const row of listed.runs) {
      expect(row.snapshot).toBeDefined();
      expect(row.snapshot!.detail).toMatch(new RegExp(`^v1/run/${row.runId}/[0-9a-f]{12}/detail\\.json$`));
      expect(row.snapshot!.track).toMatch(new RegExp(`^v1/run/${row.runId}/[0-9a-f]{12}/track\\.json$`));
      expect(paths.has(row.snapshot!.detail)).toBe(true);
      expect(paths.has(row.snapshot!.track)).toBe(true);
    }
    expect(out.gen).toMatch(/^[0-9a-f]{12}$/);
  });

  test("gen is stable across re-renders of unchanged input, and moves when the data does", async () => {
    // No live run: an idle fleet's renders must land on one generation, or the
    // publisher re-uploads the whole aggregate set every pass.
    const runs = fixture(false);
    const first = await render(runs, 111);
    const second = await render(runs, 222);
    expect(second.gen).toBe(first.gen);
    expect(second.artifacts.map((a) => a.path).sort()).toEqual(first.artifacts.map((a) => a.path).sort());
    // A data change is a new generation: the address moves with the content.
    appendFileSync(
      join(runs, DEAD_RUN, "trajectory.jsonl"),
      JSON.stringify({ ts: 2100, t: "state", level: 4 }) + "\n",
    );
    const past = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(runs, DEAD_RUN, "trajectory.jsonl"), past, past);
    const third = await render(runs, 333);
    expect(third.gen).not.toBe(first.gen);
  });

  test("a re-render of unchanged input reuses a finished run's version key", async () => {
    const runs = fixture();
    // Different clocks on purpose: the envelope timestamp moves, the address
    // must not — generatedAt is stamped after the hash, not inside it.
    const first = await render(runs, 111);
    const second = await render(runs, 222);
    const deadPaths = (r: SnapshotResult): string[] =>
      r.artifacts
        .map((a) => a.path)
        .filter((p) => p.startsWith(`v1/run/${DEAD_RUN}/`))
        .sort();
    expect(deadPaths(first)).toEqual(deadPaths(second));
    // The bodies at that address differ only by envelope; the content is one.
    const strip = (body: string): unknown => {
      const o = JSON.parse(body) as Record<string, unknown>;
      delete o["generatedAt"];
      return o;
    };
    const detailOf = (r: SnapshotResult): unknown =>
      strip(r.artifacts.find((a) => a.path === deadPaths(r)[0])!.body);
    expect(detailOf(second)).toEqual(detailOf(first));
  });
});
