/**
 * `/api/campaigns`, end to end: a seeded config store holding published
 * definitions and rows, a runs directory holding probe runs, and the response
 * the page builds against (`CampaignsResponse`).
 *
 * What is under test here is the seam, not the arithmetic
 * (`viewer-campaign-grid.test.ts` has that): the published definitions come
 * from the store as the supervisor reads them, every refusal reaches
 * `refused[]` rather than being swallowed, a run reaches its square by its own
 * stamps, and a run from before arms leaves the page while staying on the
 * runs listing with its stamps intact.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { ConfigStore, splitFleet } from "../src/config-store";
import type { CampaignsResponse, RunsResponse } from "../viewer/api-types";
import { checkedIn, defsBlock, definition, seedPublished } from "./fixtures/campaigns";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Probe {
  runId: string;
  model?: string;
  campaign: string | null;
  campaignVersion?: number;
  cell: string | null;
  arm?: string;
  ref?: string;
  race?: number;
  class?: number;
  level?: number;
  ended?: boolean;
}

/** Seed a store with a document AS WRITTEN, past the validator, for the shapes the validator would refuse. */
function seedRaw(dbPath: string, doc: unknown): void {
  const store = new ConfigStore(dbPath);
  const at = Date.now();
  for (const r of splitFleet(doc)) {
    store.db.run("INSERT INTO config (key, ord, json, updated_at) VALUES (?, ?, ?, ?)", [r.key, r.ord, JSON.stringify(r.value), at]);
  }
  store.close();
}

/** A runs directory holding probe runs, and a config store beside it. */
function fixture(probes: Probe[], fleet?: unknown, raw = false): { runs: string; fleetPath: string | undefined } {
  const root = mkdtempSync(join(tmpdir(), "wb-camp-"));
  dirs.push(root);
  const runs = join(root, "runs");
  mkdirSync(runs, { recursive: true });
  for (const p of probes) {
    const dir = join(runs, p.runId);
    mkdirSync(dir, { recursive: true });
    const config = {
      model: p.model ?? "test/model",
      episode: "probing",
      ...(p.campaign !== null ? { campaign: p.campaign } : {}),
      ...(p.campaignVersion !== undefined ? { campaignVersion: p.campaignVersion } : {}),
      ...(p.cell !== null ? { cell: p.cell } : {}),
      ...(p.arm !== undefined ? { arm: p.arm } : {}),
      ...(p.ref !== undefined ? { ref: p.ref } : {}),
      ...(p.race !== undefined ? { race: p.race } : {}),
      ...(p.class !== undefined ? { class: p.class } : {}),
    };
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        runId: p.runId,
        harnessVersion: "harness-test",
        startedAt: 1000,
        config,
        comparability: {
          harnessVersion: "harness-test",
          promptHash: "abc",
          promptChars: 10,
          harness: "wrathbench",
          effort: null,
          objective: false,
          episode: "probing",
          serverBuild: null,
          budget: { maxTurns: null, maxToolCalls: 3000, idleMs: 1_200_000, noXpMs: null, episodeMs: 5_400_000, maxSandboxRestarts: 3 },
        },
      }),
    );
    writeFileSync(
      join(dir, "trajectory.jsonl"),
      [
        JSON.stringify({ ts: 1000, t: "meta", runId: p.runId }),
        JSON.stringify({ ts: 1100, t: "response", turn: 1, message: { role: "assistant", content: "x" } }),
      ].join("\n") + "\n",
    );
    const db = new Database(join(dir, "run.sqlite"));
    db.run(
      `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT,
         harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
         termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
    );
    db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
      p.runId, config.model, "openai", null, "harness-test", 1000,
      p.ended === false ? null : 2000, p.ended === false ? null : "episode-limit", null, null,
      JSON.stringify(config),
    ]);
    db.run(`CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
       x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER, quests_completed INTEGER)`);
    db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [p.runId, 1500, p.level ?? 2, 100, 0, 0, 0, 0, 1, 1, 0, 0]);
    db.close();
  }
  let fleetPath: string | undefined;
  if (fleet !== undefined) {
    fleetPath = join(root, "config.sqlite");
    if (raw) seedRaw(fleetPath, fleet);
    else {
      const store = new ConfigStore(fleetPath);
      seedPublished(store, fleet);
      store.close();
    }
  }
  return { runs, fleetPath };
}

function handleFor(f: { runs: string; fleetPath: string | undefined }, publicMode = false): ReturnType<typeof createApi> {
  return createApi({
    runsDir: f.runs,
    tilesDir: join(f.runs, "..", "minimap"),
    publicMode,
    moduleUrl: "http://127.0.0.1:1",
    ...(f.fleetPath !== undefined ? { configDbPath: f.fleetPath } : {}),
  });
}

async function campaigns(probes: Probe[], fleet?: unknown, raw = false): Promise<CampaignsResponse> {
  const res = await handleFor(fixture(probes, fleet, raw))(new Request("http://x/api/campaigns"));
  expect(res.status).toBe(200);
  return (await res.json()) as CampaignsResponse;
}

const race = checkedIn("race-probe@1");
const CONFIG = {
  accounts: { pool: ["RUNNER"] },
  roster: { m: { tier: "t1", model: "test/model" } },
  "campaign-defs": defsBlock(race),
  campaigns: { "race-probe": { version: 1, assignments: [{ model: "m", runsPerCell: 1 }] } },
};

const stamped = (runId: string, over: Partial<Probe> = {}): Probe => ({
  runId,
  campaign: "race-probe",
  campaignVersion: 1,
  cell: "orc-warrior",
  arm: "base",
  ref: "m",
  race: 2,
  class: 1,
  ...over,
});

describe("/api/campaigns", () => {
  test("serves { now, campaigns, refused }: one entry per published version, from the store", async () => {
    const body = await campaigns([], CONFIG);
    expect(Object.keys(body).sort()).toEqual(["campaigns", "now", "refused"]);
    expect(body.refused).toEqual([]);
    expect(body.campaigns.map((c) => `${c.key}:${c.state}`)).toEqual(["race-probe@1:queued"]);
    const c = body.campaigns[0]!;
    expect(c.hash).toBe(defsBlock(race)["race-probe@1"]!.hash);
    expect(c.cells).toHaveLength(10);
    expect(c.progress.want).toBe(10);
  });

  test("a run reaches its square by its stamps; one from before arms is not on the page", async () => {
    const body = await campaigns([stamped("fleet-a"), stamped("legacy", { arm: undefined, ref: undefined }), stamped("live", { ended: false, cell: "dwarf-warrior", race: 3 })], CONFIG);
    const c = body.campaigns[0]!;
    const ids = c.grid.flatMap((g) => g.squares.flatMap((s) => s.runIds));
    expect(ids.sort()).toEqual(["fleet-a", "live"]);
    expect(c.grid.find((g) => g.cell === "orc-warrior")!.squares[0]).toMatchObject({ column: "m/base", runs: 1, counted: 1 });
    expect(c.state).toBe("running");
    expect(c.newestRunId).not.toBeNull();
  });

  test("a row naming an unpublished version reaches refused[] by its key", async () => {
    const body = await campaigns([], { ...CONFIG, campaigns: { ...CONFIG.campaigns, "nav-probe": { version: 1, enabled: true, account: "SHAKEOUT", assignments: [{ model: "m" }] } } });
    expect(body.refused).toEqual([{ key: "campaigns/nav-probe", reason: expect.stringContaining("nav-probe@1 is not published") }]);
    expect(body.campaigns.map((c) => c.key)).toEqual(["race-probe@1"]);
  });

  test("a row that does not read is refused by its key, and the published versions are still served", async () => {
    const body = await campaigns([], { ...CONFIG, campaigns: { "race-probe": { enabled: true, models: ["m"], cells: [] } } }, true);
    expect(body.refused).toEqual([{ key: "campaigns/race-probe", reason: expect.stringContaining("campaign race-probe") }]);
    expect(body.campaigns.map((c) => `${c.key}:${c.state}`)).toEqual(["race-probe@1:unassigned"]);
  });

  test("a pinned arm's pairs reach refused[] while run pods are off, and leave once they are on", async () => {
    const pinned = definition({
      id: "pin-probe",
      cells: [{ id: "c", race: 1, class: 1 }],
      arms: [
        { id: "a", image: "ghcr.io/shard/wrathbench-runner:harness-0.5-1" },
        { id: "b", image: "ghcr.io/shard/wrathbench-runner:harness-0.5-2" },
      ],
    });
    const doc = (policy: Record<string, unknown>): unknown => ({
      ...CONFIG,
      policy,
      "campaign-defs": defsBlock(race, pinned),
      campaigns: { "pin-probe": { version: 1, assignments: [{ model: "m", runsPerCell: 1 }] } },
    });
    const off = await campaigns([], doc({}));
    expect(off.refused.map((r) => r.key)).toEqual(["pin-probe@1:m:a", "pin-probe@1:m:b"]);
    expect(off.refused[0]!.reason).toContain('policy.runPods is "off"');
    const view = off.campaigns.find((c) => c.key === "pin-probe@1")!;
    expect(view.grid[0]!.squares.every((q) => q.refused?.includes("run pod") === true)).toBe(true);
    const on = await campaigns([], doc({ runPods: "probes" }));
    expect(on.refused).toEqual([]);
  });

  test("an empty config store serves no campaigns and no refusals", async () => {
    const body = await campaigns([stamped("r1")]);
    expect(body).toMatchObject({ campaigns: [], refused: [] });
  });
});

describe("/api/runs keeps every stamp, on and off the page", () => {
  test("version, arm and roster name are read as recorded; a run from before arms keeps its campaign", async () => {
    const f = fixture([stamped("fleet-a"), stamped("legacy", { arm: undefined, ref: undefined, campaignVersion: undefined })]);
    const res = await handleFor(f)(new Request("http://x/api/runs"));
    const runs = ((await res.json()) as RunsResponse).runs;
    expect(runs.find((r) => r.runId === "fleet-a")).toMatchObject({ campaign: "race-probe", campaignVersion: 1, cell: "orc-warrior", arm: "base", ref: "m" });
    expect(runs.find((r) => r.runId === "legacy")).toMatchObject({ campaign: "race-probe", campaignVersion: null, arm: null, ref: null });
  });

  test("a directory holding only launch files is a launch that never became a run: not listed", async () => {
    const f = fixture([stamped("fleet-a")]);
    const launchOnly = join(f.runs, "fleet-m-race-probe-orc-warrior-base-test-model-20261011");
    mkdirSync(launchOnly, { recursive: true });
    writeFileSync(join(launchOnly, "campaign.json"), "{}");
    const res = await handleFor(f)(new Request("http://x/api/runs"));
    expect(((await res.json()) as RunsResponse).runs.map((r) => r.runId)).toEqual(["fleet-a"]);
  });

  test("the public listing carries the version and the arm, and not the roster name", async () => {
    const f = fixture([stamped("fleet-a")]);
    const res = await handleFor(f, true)(new Request("http://x/api/runs"));
    const row = ((await res.json()) as RunsResponse).runs.find((r) => r.runId === "fleet-a")!;
    expect(row).toMatchObject({ campaign: "race-probe", campaignVersion: 1, arm: "base" });
    expect(row.ref).toBeUndefined();
  });
});
