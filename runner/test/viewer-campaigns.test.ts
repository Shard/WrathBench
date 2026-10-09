/**
 * `/api/campaigns`: the probe lane, grouped by what commissioned each run.
 *
 * The property under test is the one the design rests on: this page is built
 * from the RUN DIRECTORY and only annotated from the checked-in definitions and
 * the store, so a campaign that was completed, switched off and dropped from
 * the store still has a row — and so does one no definition claims. Runs are
 * attributed at read time and never rewritten: the nine hand-launched spike
 * probes become loop-spike@1's, class-probe's unversioned runs become v1's,
 * and a run that was not its cell's start is flagged rather than relabelled.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { ConfigStore, splitFleet } from "../src/config-store";
import type { CampaignsResponse, RunsResponse } from "../viewer/api-types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Probe {
  runId: string;
  model?: string;
  campaign: string | null;
  /** Stamped on runs launched since definitions were versioned; absent on older ones. */
  campaignVersion?: number;
  cell: string | null;
  race?: number;
  class?: number;
  level?: number;
  ended?: boolean;
  /** `pause_reason` on an unended run: what makes its model unhealthy. */
  paused?: string;
}


/**
 * Seed a store with a document AS WRITTEN, past the validator: these fixtures
 * are the viewer's own loose roster shapes (a `character`, a tierless entry)
 * that `parseFleet` would refuse, and what is under test is how the page
 * labels them, not whether the supervisor would take them.
 */
function seedRaw(dbPath: string, doc: unknown): void {
  const store = new ConfigStore(dbPath);
  const at = Date.now();
  for (const r of splitFleet(doc)) {
    store.db.run("INSERT INTO config (key, ord, json, updated_at) VALUES (?, ?, ?, ?)", [r.key, r.ord, JSON.stringify(r.value), at]);
  }
  store.close();
}

/** A runs directory holding probe runs, and optionally a seeded config store beside it. */
function fixture(probes: Probe[], fleet?: unknown): { runs: string; fleetPath: string | undefined } {
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
        // A real tuple: `comparabilitySchema` is all-or-nothing, and a partial
        // stamp parses to null — which would make every run here untiered and
        // quietly hide whether the orphan check works at all.
        comparability: {
          harnessVersion: "harness-test",
          promptHash: "abc",
          promptChars: 10,
          harness: "wrathbench",
          effort: null,
          objective: p.campaign !== null,
          episode: "probing",
          serverBuild: null,
          budget: {
            maxTurns: null,
            maxToolCalls: 3000,
            idleMs: 1_200_000,
            noXpMs: null,
            episodeMs: 5_400_000,
            maxSandboxRestarts: 3,
          },
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
      p.ended === false ? null : 2000, p.ended === false ? null : "episode-limit", p.paused ?? null, null,
      JSON.stringify(config),
    ]);
    db.run(`CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
       x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER, quests_completed INTEGER)`);
    db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      p.runId, 1500, p.level ?? 2, 100, 0, 0, 0, 0, 1, 1, 0, 0,
    ]);
    db.close();
  }
  let fleetPath: string | undefined;
  if (fleet !== undefined) {
    fleetPath = join(root, "config.sqlite");
    seedRaw(fleetPath, fleet);
  }
  return { runs, fleetPath };
}

async function campaigns(probes: Probe[], fleet?: unknown): Promise<CampaignsResponse> {
  const { runs, fleetPath } = fixture(probes, fleet);
  const handle = createApi({
    runsDir: runs,
    tilesDir: join(runs, "..", "minimap"),
    publicMode: false,
    moduleUrl: "http://127.0.0.1:1",
    ...(fleetPath !== undefined ? { configDbPath: fleetPath } : {}),
  });
  const res = await handle(new Request("http://x/api/campaigns"));
  expect(res.status).toBe(200);
  return (await res.json()) as CampaignsResponse;
}

/** The same fixture's `/api/runs`, for what the listing says about one run. */
async function runsOf(probes: Probe[]): Promise<RunsResponse> {
  const { runs } = fixture(probes);
  const handle = createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), publicMode: false, moduleUrl: "http://127.0.0.1:1" });
  const res = await handle(new Request("http://x/api/runs"));
  return (await res.json()) as RunsResponse;
}

const row = (body: CampaignsResponse, key: string) => body.campaigns.find((c) => `${c.campaign}@${c.version ?? "?"}` === key)!;

const CONFIG = {
  accounts: { pool: ["RUNNER"] },
  roster: { m: { tier: "t1", model: "test/model" } },
  campaigns: {
    "race-probe": { version: 1, assignments: [{ model: "m", runsPerCell: 1 }] },
  },
};

describe("/api/campaigns", () => {
  test("every checked-in version has a row, store rows first, then the registry's order", async () => {
    const body = await campaigns([], CONFIG);
    expect(body.campaigns.map((c) => `${c.campaign}@${c.version}`)).toEqual([
      "race-probe@1",
      "class-probe@2",
      "class-probe@1",
      "nav-probe@1",
      "loop-spike@1",
    ]);
    expect(row(body, "class-probe@1").definition).toMatchObject({ status: "closed", stopAtLevel: null, episodeMs: null });
    expect(row(body, "race-probe@1").definition).toMatchObject({ status: "open", stopAtLevel: 10, episodeMs: 43_200_000 });
  });

  test("a store row reports what was asked for beside what happened", async () => {
    const body = await campaigns(
      [{ runId: "r1", campaign: "race-probe", campaignVersion: 1, cell: "orc-warrior", race: 2, class: 1, level: 4 }],
      CONFIG,
    );
    const r = row(body, "race-probe@1");
    expect(r.runs).toBe(1);
    expect(r.config).toMatchObject({ enabled: true, assignments: [{ model: "m", runsPerCell: 1 }], want: 10, complete: false, account: null });
    const orc = r.cells.find((c) => c.cell === "orc-warrior")!;
    expect(orc).toMatchObject({ declared: true, race: 2, class: 1, characterLabel: "Orc Warrior", runs: 1, bestLevel: 4, mismatched: 0 });
    expect(r.cells.find((c) => c.cell === "bloodelf-rogue")!.note).toContain("cannot be a warrior");
  });

  test("the grid: a column per model identity, a square per cell, the assignment's owed cells marked", async () => {
    const body = await campaigns(
      [{ runId: "r1", campaign: "race-probe", campaignVersion: 1, cell: "orc-warrior", race: 2, class: 1, level: 4 }],
      CONFIG,
    );
    const r = row(body, "race-probe@1");
    expect(r.columns).toHaveLength(1);
    expect(r.columns[0]).toMatchObject({ model: "test/model", effort: null, harness: "wrathbench", series: null, assignment: "m" });
    const at = (cell: string) => r.grid[r.cells.findIndex((c) => c.cell === cell)]![0];
    // Not at the stop level: counted, not reached, best level shown.
    expect(at("orc-warrior")).toMatchObject({ runs: 1, live: 0, counted: 1, reached: 0, minutesToTarget: null, bestLevel: 4 });
    // Assigned and not run yet: owed, not empty.
    expect(at("human-warrior")).toEqual({ runs: 0, live: 0, counted: 0, reached: 0, minutesToTarget: null, bestLevel: null, mismatched: 0 });
  });

  test("completion is derived per version, so a newer version is not done by an older one's runs", async () => {
    // class-probe@1's runs were stamped with no version; @2 reuses dwarf-rogue.
    const body = await campaigns(
      [
        { runId: "old", campaign: "class-probe", cell: "dwarf-rogue", race: 3, class: 4 },
        { runId: "new", campaign: "class-probe", campaignVersion: 2, cell: "dwarf-warrior", race: 3, class: 1 },
      ],
      { ...CONFIG, campaigns: { "class-probe": { version: 2, assignments: [{ model: "m" }] } } },
    );
    const v2 = row(body, "class-probe@2");
    expect(v2.runs).toBe(1);
    expect(v2.cells.find((c) => c.cell === "dwarf-rogue")!.runs).toBe(0);
    expect(row(body, "class-probe@1").cells.find((c) => c.cell === "dwarf-rogue")!.runs).toBe(1);
  });

  test("class-probe v1's runs are read as v1, and a run that was not its cell's start says so", async () => {
    // The three nightelf-hunter runs launched as Night Elf Rogues before the
    // cell's class was corrected under the same id: shown, flagged, never relabelled.
    const body = await campaigns([
      { runId: "a48", campaign: "class-probe", cell: "nightelf-hunter", race: 4, class: 4, level: 3 },
      { runId: "a47", campaign: "class-probe", cell: "dwarf-paladin", race: 3, class: 2, level: 2 },
    ]);
    const v1 = row(body, "class-probe@1");
    expect(v1.config).toBeNull();
    const hunter = v1.cells.find((c) => c.cell === "nightelf-hunter")!;
    expect(hunter).toMatchObject({ characterLabel: "Night Elf Hunter", runs: 1, mismatched: 1 });
    expect(v1.cells.find((c) => c.cell === "dwarf-paladin")!.mismatched).toBe(0);
    expect(v1.grid[v1.cells.indexOf(hunter)]![0]).toMatchObject({ mismatched: 1, reached: null });
    // And the listing says how it was placed.
    const listing = await runsOf([{ runId: "a48", campaign: "class-probe", cell: "nightelf-hunter", race: 4, class: 4 }]);
    expect(listing.runs[0]).toMatchObject({ campaign: "class-probe", campaignVersion: 1, cell: "nightelf-hunter", campaignSource: "unversioned" });
  });

  test("the nine hand-launched spike probes are loop-spike@1's at read time, and no longer orphans", async () => {
    const nine = [
      "probe-workspace-20260925",
      "probe-spike-20260925-1",
      "probe-spike-20260926-2b",
      "probe-spike-20260926-3",
      "probe-spike-20260926-5",
      "probe-ref05-20260926",
      "probe-05fix-20260926-1",
      "probe-05fix-20260926-2",
      "probe-05fix-20260926-3",
    ];
    const probes: Probe[] = nine.map((runId) => ({ runId, campaign: null, cell: null, race: 1, class: 2, level: 5 }));
    const body = await campaigns(probes);
    expect(body.orphans).toBe(0);
    const spike = row(body, "loop-spike@1");
    expect(spike.cells.map((c) => [c.cell, c.runs])).toEqual([
      ["workspace", 1],
      ["entrypoint", 4],
      ["reference-0.5", 1],
      ["0.5-fixes", 3],
    ]);
    // Read, never written: the listing names the rule that placed each one.
    const listing = await runsOf(probes);
    for (const r of listing.runs) expect(r).toMatchObject({ campaign: "loop-spike", campaignVersion: 1, campaignSource: "listed" });
  });

  test("a probing run nothing claims is an orphan, counted and not invented into a row", async () => {
    const body = await campaigns([{ runId: "r1", campaign: null, cell: null }], CONFIG);
    expect(body.orphans).toBe(1);
    expect(body.campaigns.every((c) => c.runs === 0)).toBe(true);
  });

  test("a campaign no definition claims keeps its row, because its runs happened", async () => {
    const body = await campaigns([{ runId: "r1", campaign: "retired-sweep", cell: "cell-a", level: 6 }], CONFIG);
    const r = row(body, "retired-sweep@?");
    expect(r).toMatchObject({ version: null, definition: null, config: null, runs: 1 });
    expect(r.cells).toEqual([
      { cell: "cell-a", declared: false, race: null, class: null, characterLabel: null, note: null, runs: 1, models: ["test/model"], bestLevel: 6, mismatched: 0 },
    ]);
  });

  test("a cell the definition does not declare is still shown, after the declared ones", async () => {
    const body = await campaigns(
      [{ runId: "r1", campaign: "nav-probe", campaignVersion: 1, cell: "loch-modan" }],
      CONFIG,
    );
    const nav = row(body, "nav-probe@1");
    expect(nav.cells.map((c) => [c.cell, c.declared])).toEqual([
      ["coldridge", true],
      ["loch-modan", false],
    ]);
  });

  test("a live probe is counted apart, and does not make a sweep complete", async () => {
    const body = await campaigns(
      [
        { runId: "r1", campaign: "nav-probe", campaignVersion: 1, cell: "coldridge", ended: false },
      ],
      { ...CONFIG, campaigns: { "nav-probe": { version: 1, account: "SHAKEOUT", assignments: [{ model: "m" }] } } },
    );
    const nav = row(body, "nav-probe@1");
    expect(nav).toMatchObject({ runs: 0, live: 1 });
    expect(nav.config!.complete).toBe(false);
    expect(nav.grid[0]![0]).toMatchObject({ runs: 0, live: 1 });
  });

  test("`runs` is the progress numerator: counted runs on declared cells by assigned models, capped per cell", async () => {
    const body = await campaigns(
      [
        { runId: "r1", campaign: "nav-probe", campaignVersion: 1, cell: "coldridge" },
        { runId: "r2", campaign: "nav-probe", campaignVersion: 1, cell: "coldridge" },
        { runId: "r3", campaign: "nav-probe", campaignVersion: 1, cell: "coldridge", model: "other/model" },
        { runId: "r4", campaign: "nav-probe", campaignVersion: 1, cell: "gone-cell" },
      ],
      { ...CONFIG, campaigns: { "nav-probe": { version: 1, enabled: false, assignments: [{ model: "m" }] } } },
    );
    const nav = row(body, "nav-probe@1");
    expect(nav.runs).toBe(1);
    expect(nav.config!.complete).toBe(true);
    expect(nav.cells.map((c) => [c.cell, c.runs])).toEqual([
      ["coldridge", 3],
      ["gone-cell", 1],
    ]);
    // Two model identities ran it: the assigned one first, then the other.
    expect(nav.columns.map((c) => [c.model, c.assignment])).toEqual([
      ["test/model", "m"],
      ["other/model", null],
    ]);
  });

  test("the live store's pre-definition rows still annotate their versions", async () => {
    const body = await campaigns([], {
      ...CONFIG,
      campaigns: {
        "nav-probe": { enabled: true, account: "SHAKEOUT", models: ["m"], runsPerCell: 1, cells: [{ id: "coldridge", race: 3, class: 2 }] },
      },
    });
    expect(row(body, "nav-probe@1").config).toMatchObject({ enabled: true, account: "SHAKEOUT", assignments: [{ model: "m", runsPerCell: 1 }], want: 1 });
  });

  test("an empty config store still serves the runs", async () => {
    const body = await campaigns([{ runId: "r1", campaign: "adhoc", cell: "c" }]);
    expect(body.configPath).toMatch(/config\.sqlite$/);
    expect(row(body, "adhoc@?").config).toBeNull();
    expect(body.campaigns.every((c) => c.config === null)).toBe(true);
  });
});
