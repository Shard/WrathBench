/**
 * What the viewer asks the derived store for, and how often.
 *
 * - The corpus-wide latest-readings aggregate the listing routes and the map
 *   read never names `items`, the column that is nearly all of `states`; only
 *   one run's own page asks for its inventory. No listing row shows one, the
 *   public `/api/runs` included (`projectRunListRow`).
 * - `runFacts` reads the liveness columns and the fact, not `SELECT *`.
 * - Corpus-wide reads are shared over `STORE_SHARE_MS` across routes and tabs.
 * - `/api/fleet` stats only the run directories the store cannot rule out.
 * - `/api/positions` opens only runs whose trajectory could hold a position.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Trajectory } from "../src/trajectory";
import { STORE_SHARE_MS, coldRuns, createApi, fleetRunIds, heldAccounts, withoutRuns } from "../viewer/api";
import { projectRunFacts } from "../viewer/public-projection";
import type { FleetResponse, RunsResponse } from "../viewer/api-types";
import {
  clickhouseStore,
  localRunStore,
  withoutItems,
  type RunListingRow,
  type RunStore,
} from "../viewer/clickhouse";
import { positionsFromStore, readLatestMove, readLatestStatus, readPositions } from "../viewer/positions";
import { readMoves } from "../viewer/runs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** One run as the runner writes it, holding `account`, with an inventory on its newest sample. */
function writeRun(runsDir: string, runId: string, opts: { terminated?: boolean; account?: string } = {}): void {
  const dir = join(runsDir, runId);
  const traj = new Trajectory(dir);
  traj.writeMeta({
    runId,
    harnessVersion: "harness-test",
    startedAt: Date.now() - 60_000,
    config: { runId, driver: "openai", model: "a-model", apiBase: "https://openrouter.ai/api/v1", account: opts.account ?? "RUNNER" } as never,
  });
  traj.setCharacter(runId, "Brakk");
  traj.append({ t: "request", turn: 1, ts: Date.now() - 50_000, messages: [{ role: "user", content: "go" }] });
  traj.recordState(runId, {
    level: 4, xp: 120, map: 0, x: 4, y: 5, z: 6, money: 71, questsCompleted: 3, turn: 1,
    items: [{ name: "Tough Jerky", count: 4, equipped: false }],
  });
  if (opts.terminated === true) traj.setTermination(runId, "episode-elapsed" as never, "done");
  traj.close();
}

/** The local store, counting each corpus-wide read. */
function countingStore(runsDir: string): { store: RunStore; reads: Record<string, number> } {
  const inner = localRunStore(runsDir);
  const reads: Record<string, number> = { runRows: 0, totalsRows: 0, latestStates: 0, latestReadings: 0, runListing: 0, factRows: 0 };
  const count = <K extends keyof RunStore>(k: K): RunStore[K] =>
    ((...args: unknown[]) => {
      reads[k] = (reads[k] ?? 0) + 1;
      return (inner[k] as (...a: unknown[]) => unknown)(...args);
    }) as RunStore[K];
  return {
    reads,
    store: {
      ...inner,
      runRows: count("runRows"),
      totalsRows: count("totalsRows"),
      latestStates: count("latestStates"),
      latestReadings: count("latestReadings"),
      runListing: count("runListing"),
      factRows: count("factRows"),
    },
  };
}

function handleOf(runsDir: string, store: RunStore, publicMode = false): ReturnType<typeof createApi> {
  return createApi({ runsDir, tilesDir: join(runsDir, "..", "minimap"), moduleUrl: "http://127.0.0.1:1", store, publicMode, configDbPath: join(runsDir, "..", "config.sqlite") });
}

describe("the ClickHouse queries", () => {
  /** Every SQL text `clickhouseStore` sends, answered with an empty result. */
  async function captured(read: (s: RunStore) => Promise<unknown>): Promise<string[]> {
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    try {
      await read(clickhouseStore({ url: "http://ch.invalid:8123", user: "u", password: "", database: "wrathbench" }));
    } finally {
      globalThis.fetch = realFetch;
    }
    return sent;
  }

  test("the listing's latest readings never name items; the run page's still does", async () => {
    const [readings] = await captured((s) => s.latestReadings());
    expect(readings).toContain("argMaxIf(level");
    expect(readings).not.toContain("items");
    const [states] = await captured((s) => s.latestStates());
    expect(states).toContain("argMaxIf(items");
    const [one] = await captured((s) => s.latestState("run-a"));
    expect(one).toContain("argMaxIf(items");
  });

  test("the scheduler's facts are read by column, not SELECT *", async () => {
    const [listing] = await captured((s) => s.runListing());
    const [facts] = await captured((s) => s.factRows());
    for (const sql of [listing, facts]) expect(sql).not.toContain("*");
    expect(listing).not.toMatch(/meta_json|config_json|comparability_json/);
    expect(facts).not.toContain("totals_json");
  });
});

describe("the local store's twins", () => {
  test("latestReadings is latestStates without the inventory, run for run", async () => {
    const runsDir = tempDir("viewer-reads-twin-");
    writeRun(runsDir, "run-a");
    writeRun(runsDir, "run-b", { terminated: true });
    const store = localRunStore(runsDir);
    const states = await store.latestStates();
    const readings = await store.latestReadings();
    expect(readings).toEqual(withoutItems(states));
    expect(states.get("run-a")!.items).toContain("Tough Jerky");
    for (const r of readings.values()) expect(Object.keys(r)).not.toContain("items");
    const listing = await store.runListing();
    expect(listing.map((r) => r.run_id).sort()).toEqual(["run-a", "run-b"]);
    expect(listing.find((r) => r.run_id === "run-b")!.termination_reason).toBe("episode-elapsed");
    expect((await store.factRows()).map((r) => Object.keys(r).sort())).toEqual([["fact_json", "run_id"], ["fact_json", "run_id"]]);
  });
});

describe("which routes read the inventory", () => {
  test("a private listing reads none and serves items null; the run page still has its own", async () => {
    const runsDir = tempDir("viewer-reads-private-");
    writeRun(runsDir, "run-a");
    const { store, reads } = countingStore(runsDir);
    const handle = handleOf(runsDir, store);
    const runs = (await (await handle(new Request("http://x/api/runs"))).json()) as { runs: { runId: string; items: unknown; level: number }[] };
    expect(runs.runs[0]).toMatchObject({ runId: "run-a", items: null, level: 4 });
    for (const p of ["/api/results?episode=all", "/api/positions", "/api/models", "/api/info"]) {
      expect((await handle(new Request(`http://x${p}`))).status).toBe(200);
    }
    expect(reads.latestStates).toBe(0);
    const detail = (await (await handle(new Request("http://x/api/run/run-a"))).json()) as { run: { items: { name: string }[] | null } };
    expect(detail.run.items?.[0]?.name).toBe("Tough Jerky");
  });

  test("a public handle reads none for its listings either; its run detail still publishes the inventory", async () => {
    const runsDir = tempDir("viewer-reads-public-");
    writeRun(runsDir, "run-a");
    const { store, reads } = countingStore(runsDir);
    const handle = handleOf(runsDir, store, true);
    for (const p of ["/api/runs", "/api/results?episode=all", "/api/positions"]) {
      expect((await handle(new Request(`http://x${p}`))).status).toBe(200);
    }
    expect(reads.latestStates).toBe(0);
    const detail = (await (await handle(new Request("http://x/api/run/run-a"))).json()) as { run: { items: { name: string }[] | null } };
    expect(detail.run.items?.[0]?.name).toBe("Tough Jerky");
  });
});

describe("corpus-wide reads are shared over a short window", () => {
  test("the fleet page's routes, polled together, cost one read of each table; the next window reads again", async () => {
    const runsDir = tempDir("viewer-reads-share-");
    writeRun(runsDir, "run-a");
    const { store, reads } = countingStore(runsDir);
    const handle = handleOf(runsDir, store);
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const poll = async (): Promise<void> => {
        const res = await Promise.all(
          ["/api/fleet", "/api/models", "/api/positions", "/api/runs", "/api/fleet", "/api/models"].map((p) => handle(new Request(`http://x${p}`))),
        );
        expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      };
      await poll();
      await poll();
      expect(reads).toMatchObject({ runRows: 1, totalsRows: 1, latestReadings: 1, runListing: 1, factRows: 1 });
      clock += STORE_SHARE_MS;
      await poll();
      expect(reads).toMatchObject({ runRows: 2, totalsRows: 2, latestReadings: 2, runListing: 2, factRows: 2 });
    } finally {
      Date.now = realNow;
    }
  });
});

describe("which run directories /api/fleet opens", () => {
  const row = (run_id: string, over: Partial<RunListingRow> = {}): RunListingRow => ({
    run_id, archived: 0, trajectory_mtime: 0, termination_reason: "", pause_reason: "", ...over,
  });

  test("coldRuns rules out terminated runs and long-quiet ones, never paused-only or unknown ones", () => {
    const now = 10_000_000_000;
    const cold = coldRuns(
      [
        row("ended", { termination_reason: "episode-elapsed", trajectory_mtime: now }),
        row("quiet", { trajectory_mtime: now - 60 * 60_000 }),
        row("paused-warm", { pause_reason: "rate-limited", trajectory_mtime: now - 60_000 }),
        row("recent", { trajectory_mtime: now - 4 * 60_000 }),
        row("unknown"),
      ],
      now,
    );
    expect([...cold].sort()).toEqual(["ended", "quiet"]);
  });

  test("a run the store rules out is not read, and a directory it has no row for still holds its account", () => {
    const runsDir = tempDir("viewer-reads-held-");
    writeRun(runsDir, "known", { account: "RUNNER" });
    writeRun(runsDir, "brand-new", { account: "OTHER" });
    expect([...heldAccounts(runsDir).keys()].sort()).toEqual(["OTHER", "RUNNER"]);
    // The store says `known` is over; `brand-new` it has never seen.
    const held = heldAccounts(runsDir, Date.now(), new Set(["known"]));
    expect([...held.entries()]).toEqual([["OTHER", { runId: "brand-new", model: "a-model" }]]);
  });
});

describe("which runs /api/positions opens", () => {
  test("a run whose trajectory the store last saw long before the window is not opened", async () => {
    const runsDir = tempDir("viewer-reads-pos-");
    writeRun(runsDir, "live-a");
    writeRun(runsDir, "live-b");
    const now = Date.now();
    expect(readPositions(runsDir, now).map((p) => p.runId).sort()).toEqual(["live-a", "live-b"]);
    const inner = localRunStore(runsDir);
    const store: RunStore = {
      ...inner,
      // As the store would hold a run parked an hour ago whose files a stray
      // write since has not reached the collector: its row says quiet.
      runRows: async () => (await inner.runRows()).map((r) => (r.run_id === "live-b" ? { ...r, trajectory_mtime: now - 60 * 60_000 } : r)),
    };
    expect((await positionsFromStore(store, runsDir, now)).map((p) => p.runId)).toEqual(["live-a"]);
  });

  test("the latest move is the row readMoves lists last, ties and position-less rows included", () => {
    const runsDir = tempDir("viewer-reads-move-");
    const dir = join(runsDir, "r");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "run.sqlite"));
    db.run(`CREATE TABLE move (run_id TEXT NOT NULL, ts INTEGER NOT NULL, move_id INTEGER, map INTEGER, x REAL, y REAL, z REAL, target TEXT, status TEXT)`);
    const ins = db.prepare(`INSERT INTO move VALUES (?,?,?,?,?,?,?,?,?)`);
    ins.run("r", 100, 1, 0, 1, 1, 1, null, null);
    ins.run("r", 300, 2, 0, 2, 2, 2, "boar", null);
    ins.run("r", 300, 2, 0, 3, 3, 3, "boar", "arrived");
    ins.run("r", 200, 3, 0, 9, 9, 9, null, null); // written late, stamped earlier
    ins.run("r", 400, 4, 0, null, null, null, null, "no_path"); // no position: never listed
    db.close();
    const all = readMoves(runsDir, "r");
    expect(readLatestMove(runsDir, "r")).toEqual(all[all.length - 1]!);
    expect(readLatestMove(runsDir, "r")).toMatchObject({ x: 3, status: "arrived" });
    // No table, and no database: nothing, not an error.
    const bare = join(runsDir, "bare");
    mkdirSync(bare);
    new Database(join(bare, "run.sqlite")).close();
    expect(readLatestMove(runsDir, "bare")).toBeNull();
    expect(readLatestMove(runsDir, "absent")).toBeNull();
  });

  test("the newest status line is read off the file's end, and the whole file when the end holds none", () => {
    const runsDir = tempDir("viewer-reads-status-");
    const dir = join(runsDir, "r");
    mkdirSync(dir, { recursive: true });
    const line = (turn: number): string => JSON.stringify({ turn, level: 5, zone: "Durotar", text: `${"x".repeat(560)} ${turn}`, ts: turn * 1000 });
    const lines = Array.from({ length: 40 }, (_, i) => line(i + 1));
    writeFileSync(join(dir, "episodic.jsonl"), lines.join("\n") + "\n");
    expect(readLatestStatus(runsDir, "r")).toMatchObject({ turn: 40, ts: 40_000 });
    // A half-written last line is skipped, as the writer's own reader skips it.
    writeFileSync(join(dir, "episodic.jsonl"), lines.join("\n") + "\n" + line(41).slice(0, 100));
    expect(readLatestStatus(runsDir, "r")).toMatchObject({ turn: 40 });
    // The whole tail window unreadable: the file is read whole, and the good line before it found.
    writeFileSync(join(dir, "episodic.jsonl"), [line(1), "{".repeat(20_000)].join("\n"));
    expect(readLatestStatus(runsDir, "r")).toMatchObject({ turn: 1 });
  });
});

/*
 * The fleet table's cells. The page read the whole runs index (2.4 MB) a minute
 * to fill a handful of rows; `/api/fleet` now carries those runs' figures
 * itself, off point reads per run, and the index's size for the page's link.
 */
describe("/api/fleet carries its rows' run figures", () => {
  function fleetState(runsDir: string): void {
    writeFileSync(
      join(runsDir, "fleet-state.json"),
      JSON.stringify({
        fleetPid: 7,
        startedAt: 1,
        heartbeatAt: 2,
        accounts: { pool: { RUNNER: "job-a", IDLE: null } },
        jobs: {
          "job-a": { ref: "a", episode: "e90", account: "RUNNER", source: "policy", models: ["a-model"], pid: 13, spawnedAt: 1, exitCode: null, draining: false, alive: true },
        },
        paused: [
          { runId: "run-paused", model: "a-model", account: "IDLE", reason: "rate-limited", since: 1, pauseCount: 1, resumeAfter: null, elapsedMs: 1000, budgetMs: 5_400_000, why: "waiting" },
        ],
        ended: [],
      }),
    );
  }

  async function json<T>(handle: ReturnType<typeof createApi>, path: string): Promise<T> {
    const res = await handle(new Request(`http://x${path}`));
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }

  test("the job's run and the paused run, as the runs index rows them, with no corpus-wide read", async () => {
    const runsDir = tempDir("viewer-reads-fleet-");
    writeRun(runsDir, "run-live", { account: "RUNNER" });
    writeRun(runsDir, "run-paused", { account: "IDLE" });
    writeRun(runsDir, "run-old", { terminated: true, account: "OLD" });
    fleetState(runsDir);
    const { store, reads } = countingStore(runsDir);
    const handle = handleOf(runsDir, store);
    const realNow = Date.now;
    const clock = realNow();
    Date.now = () => clock;
    try {
      const fleet = await json<FleetResponse>(handle, "/api/fleet");
      // Nothing corpus-wide but the liveness listing and the facts the route always read.
      expect(reads).toMatchObject({ runRows: 0, totalsRows: 0, latestReadings: 0, latestStates: 0 });
      expect(fleet.jobs[0]!.runId).toBe("run-live");
      const facts = new Map((fleet.runFacts ?? []).map((r) => [r.runId, r]));
      expect([...facts.keys()].sort()).toEqual(["run-live", "run-paused"]);
      expect(facts.get("run-live")).toMatchObject({ level: 4, xp: 120 });
      // The same figures the runs index serves for those runs, field for field.
      const runs = await json<RunsResponse>(handle, "/api/runs");
      for (const id of ["run-live", "run-paused"]) {
        expect(facts.get(id)).toEqual(projectRunFacts(runs.runs.find((r) => r.runId === id)!));
      }
      expect(fleet.runCount).toBe(runs.runs.length);
      expect(fleet.runCount).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  test("tabs polling together share one set of point reads a window", async () => {
    const runsDir = tempDir("viewer-reads-fleet-share-");
    writeRun(runsDir, "run-live", { account: "RUNNER" });
    writeRun(runsDir, "run-paused", { account: "IDLE" });
    fleetState(runsDir);
    const inner = localRunStore(runsDir);
    const point = { runRow: 0, totalsRow: 0 };
    const store: RunStore = {
      ...inner,
      runRow: (id) => ((point.runRow += 1), inner.runRow(id)),
      totalsRow: (id) => ((point.totalsRow += 1), inner.totalsRow(id)),
    };
    const handle = handleOf(runsDir, store);
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await Promise.all([1, 2, 3].map(() => json<FleetResponse>(handle, "/api/fleet")));
      expect(point).toEqual({ runRow: 2, totalsRow: 2 });
      clock += STORE_SHARE_MS;
      const next = await json<FleetResponse>(handle, "/api/fleet");
      expect(point).toEqual({ runRow: 4, totalsRow: 4 });
      expect(next.runFacts?.length).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  test("a public handle carries the same figures through its projection", async () => {
    const runsDir = tempDir("viewer-reads-fleet-public-");
    writeRun(runsDir, "run-live", { account: "RUNNER" });
    writeRun(runsDir, "run-paused", { account: "IDLE" });
    fleetState(runsDir);
    const handle = handleOf(runsDir, localRunStore(runsDir), true);
    const fleet = await json<FleetResponse>(handle, "/api/fleet");
    expect((fleet.runFacts ?? []).map((r) => r.runId).sort()).toEqual(["run-live", "run-paused"]);
    for (const r of fleet.runFacts ?? []) {
      expect(Object.keys(r).sort()).toEqual(["comparability", "cost", "level", "playtimeMs", "resolvedModel", "runId", "tokens", "tps", "xp"]);
    }
    expect(fleet.runCount).toBe(2);
  });

  test("only the runs the table rows: a job's run, and the first paused run on each account no job is on", () => {
    const job = (account: string, runId: string | null): FleetResponse["jobs"][number] => ({
      name: `j-${account}`, ref: "a", episode: "e90", account, accountClass: "pool", source: "policy", models: [], runId, model: null,
      pid: 1, spawnedAt: 1, exitCode: null, draining: false, alive: true,
    });
    const paused = (runId: string, account: string | null): FleetResponse["paused"][number] => ({
      runId, model: "m", account, reason: "rate-limited", since: 1, pauseCount: 1, resumeAfter: null, elapsedMs: null, budgetMs: null, why: "w",
    });
    expect(
      fleetRunIds({
        jobs: [job("RUNNER", "live-1"), job("SPARE", null)],
        accounts: [
          { account: "RUNNER", class: "pool", job: "j-RUNNER" },
          { account: "SPARE", class: "pool", job: "j-SPARE" },
          { account: "idle", class: "pool", job: null },
          { account: "EMPTY", class: "paid", job: null },
        ],
        // A long paused list: only the first on an idle account has a row.
        paused: [paused("p-busy", "RUNNER"), paused("p-idle", "IDLE"), paused("p-idle-2", "IDLE"), paused("p-none", null), paused("p-gone", "NOWHERE")],
      }).sort(),
    ).toEqual(["live-1", "p-idle"]);
  });

  test("a withheld run's figures go with its row", () => {
    const f: FleetResponse = {
      present: true,
      server: { phase: "running", since: 0, build: "", detail: "", updatedAt: 0 },
      jobs: [],
      accounts: [],
      paused: [],
      ended: [],
      runFacts: [
        { runId: "keep", resolvedModel: null, level: 1, xp: 0, playtimeMs: null, tokens: null, cost: null, comparability: null },
        { runId: "secret", resolvedModel: null, level: 9, xp: 9, playtimeMs: null, tokens: null, cost: null, comparability: null },
      ],
      now: 0,
    };
    expect(withoutRuns(f, new Set(["secret"])).runFacts!.map((r) => r.runId)).toEqual(["keep"]);
  });
});
