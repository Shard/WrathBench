/**
 * `/api/campaigns`: the probe lane, grouped by what commissioned each run.
 *
 * The property under test is the one the design rests on: this page is built
 * from the RUN DIRECTORY and only annotated from the config, so a campaign that
 * was completed, switched off and deleted from the file still has a row. That is
 * what makes "a finished campaign is not archived" mean something —
 * switching a campaign off must not be a way of losing its results, and neither
 * must deleting its entry.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import type { CampaignsResponse } from "../viewer/api-types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Probe {
  runId: string;
  model?: string;
  campaign: string | null;
  cell: string | null;
  level?: number;
  ended?: boolean;
  /** `pause_reason` on an unended run: what makes its model unhealthy. */
  paused?: string;
}

/** A runs directory holding probe runs, and optionally a fleet config beside it. */
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
      ...(p.cell !== null ? { cell: p.cell } : {}),
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
    fleetPath = join(root, "fleet.json");
    writeFileSync(fleetPath, JSON.stringify(fleet));
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
    ...(fleetPath !== undefined ? { fleetConfigPath: fleetPath } : {}),
  });
  const res = await handle(new Request("http://x/api/campaigns"));
  expect(res.status).toBe(200);
  return (await res.json()) as CampaignsResponse;
}

const CONFIG = {
  accounts: { pool: ["RUNNER"] },
  roster: { m: { tier: "t1", model: "test/model" } },
  campaigns: {
    "class-probe": { models: ["m"], cells: [{ id: "human-warrior" }, { id: "dwarf-rogue" }] },
  },
};

describe("/api/campaigns", () => {
  test("a campaign with a config entry reports both what happened and what was asked for", async () => {
    const body = await campaigns(
      [{ runId: "r1", campaign: "class-probe", cell: "human-warrior", level: 4 }],
      CONFIG,
    );
    expect(body.campaigns).toHaveLength(1);
    const row = body.campaigns[0]!;
    expect(row.campaign).toBe("class-probe");
    expect(row.runs).toBe(1);
    expect(row.config).toMatchObject({ enabled: true, runsPerCell: 1, models: 1, complete: false });
    expect(row.cells.map((c) => [c.cell, c.runs, c.declared])).toEqual([
      ["human-warrior", 1, true],
      ["dwarf-rogue", 0, true],
    ]);
    expect(row.cells[0]!.bestLevel).toBe(4);
  });

  test("completion is derived, so a swept campaign says so without anything being written", async () => {
    const body = await campaigns(
      [
        { runId: "r1", campaign: "class-probe", cell: "human-warrior" },
        { runId: "r2", campaign: "class-probe", cell: "dwarf-rogue" },
      ],
      CONFIG,
    );
    expect(body.campaigns[0]!.config!.complete).toBe(true);
  });

  test("a campaign deleted from the config keeps its row, because its runs happened", async () => {
    // The load-bearing case. Switching a campaign off and removing its entry is
    // how a finished sweep is retired; it must not be a way of losing results.
    const body = await campaigns(
      [{ runId: "r1", campaign: "retired-sweep", cell: "cell-a", level: 6 }],
      CONFIG,
    );
    const row = body.campaigns.find((c) => c.campaign === "retired-sweep")!;
    expect(row).toBeDefined();
    expect(row.config).toBeNull();
    expect(row.runs).toBe(1);
    expect(row.cells).toEqual([
      { cell: "cell-a", declared: false, runs: 1, models: ["test/model"], bestLevel: 6 },
    ]);
  });

  test("a cell the config no longer declares is still shown, marked undeclared", async () => {
    const body = await campaigns(
      [
        { runId: "r1", campaign: "class-probe", cell: "human-warrior" },
        { runId: "r2", campaign: "class-probe", cell: "gone-cell" },
      ],
      CONFIG,
    );
    const cells = body.campaigns[0]!.cells;
    expect(cells.find((c) => c.cell === "gone-cell")).toMatchObject({ declared: false, runs: 1 });
    // Declared cells come first, in the config's own order.
    expect(cells.map((c) => c.cell)).toEqual(["human-warrior", "dwarf-rogue", "gone-cell"]);
  });

  test("config order is the page order, and an undeclared campaign follows", async () => {
    const body = await campaigns(
      [{ runId: "r1", campaign: "zzz-old", cell: "c" }],
      CONFIG,
    );
    expect(body.campaigns.map((c) => c.campaign)).toEqual(["class-probe", "zzz-old"]);
  });

  test("a live probe does not make a sweep complete, though it does stop a relaunch", async () => {
    // Two different questions. The scheduler counts a live probe as done so it
    // will not launch the same cell twice; this page must not announce the sweep
    // finished while a run could still end `manual` and re-open its cell.
    const body = await campaigns(
      [
        { runId: "r1", campaign: "class-probe", cell: "human-warrior" },
        { runId: "r2", campaign: "class-probe", cell: "dwarf-rogue", ended: false },
      ],
      CONFIG,
    );
    expect(body.campaigns[0]!.config!.complete).toBe(false);
  });

  test("a live probe is counted apart from a finished one", async () => {
    const body = await campaigns(
      [
        { runId: "r1", campaign: "class-probe", cell: "human-warrior" },
        { runId: "r2", campaign: "class-probe", cell: "dwarf-rogue", ended: false },
      ],
      CONFIG,
    );
    expect(body.campaigns[0]).toMatchObject({ runs: 1, live: 1 });
  });

  test("`runs` is the progress numerator: counted runs on declared cells by swept models, capped per cell", async () => {
    // Two models the sweep does not name and a re-swept cell: every one of
    // these is an ended run, and the page's `runs/want` read 73/8 on the live
    // class-probe until the numerator used the scheduler's own reading.
    const body = await campaigns(
      [
        { runId: "r1", campaign: "class-probe", cell: "human-warrior" },
        { runId: "r2", campaign: "class-probe", cell: "human-warrior" },
        { runId: "r3", campaign: "class-probe", cell: "human-warrior", model: "other/model" },
        { runId: "r4", campaign: "class-probe", cell: "gone-cell" },
        { runId: "r5", campaign: "class-probe", cell: "dwarf-rogue", ended: false },
      ],
      CONFIG,
    );
    const row = body.campaigns[0]!;
    // human-warrior is swept once (runsPerCell 1), whatever else landed on it.
    expect(row.runs).toBe(1);
    expect(row.live).toBe(1);
    expect(row.config!.complete).toBe(false);
    // What actually ran is still all there, per cell.
    expect(row.cells.map((c) => [c.cell, c.runs])).toEqual([
      ["human-warrior", 3],
      ["dwarf-rogue", 1],
      ["gone-cell", 1],
    ]);
    expect(row.models).toEqual(["other/model", "test/model"]);
  });

  test("a probing run naming no campaign is an orphan, counted and not invented into a row", async () => {
    // It should not be possible — probe runs are always launched stamped — so it
    // is reported as a number rather than given a row that implies a campaign.
    const body = await campaigns([{ runId: "r1", campaign: null, cell: null }], CONFIG);
    expect(body.orphans).toBe(1);
    expect(body.campaigns.every((c) => c.runs === 0)).toBe(true);
  });

  test("model health is not this page's question, so an unhealthy model still counts", async () => {
    // The scheduler passes `campaignModels`/`campaignComplete` an `eligible`
    // predicate (`verdict !== "blocked"`) so it will not launch a cell against
    // a dead endpoint. This page deliberately does NOT: `blocked` also covers
    // `running` and `paused`, which are facts about this second rather than
    // about the sweep, so wiring it here would make the count flicker with the
    // live board on every poll. If a future change passes `eligible` through,
    // this drops to 0 and the test fails — that is the point of it.
    const body = await campaigns(
      [{ runId: "r1", campaign: "class-probe", cell: "human-warrior", ended: false, paused: "operator-pause" }],
      CONFIG,
    );
    expect(body.campaigns[0]!.config!.models).toBe(1);
  });

  test("no config at all still serves the runs", async () => {
    const body = await campaigns([{ runId: "r1", campaign: "adhoc", cell: "c" }]);
    expect(body.configPath).toBeNull();
    expect(body.campaigns.map((c) => c.campaign)).toEqual(["adhoc"]);
    expect(body.campaigns[0]!.config).toBeNull();
  });
});
