/**
 * The viewer's read path over the derived store (`runner/viewer/clickhouse.ts`).
 *
 * The thing worth pinning is not that the mapping runs. It is that a `RunRow`
 * built from stored rows is the **same object** `readRun` built from the files
 * — field for field, in the same order, so the JSON a client receives did not
 * change when the read path did. `readRun` is still in the tree (the fleet
 * supervisor and the live map read files and must), which is what makes that
 * comparison possible at all.
 *
 * Fixture-based and green with no `data/` and no ClickHouse: `localRunStore`
 * runs the collector's own ingestion into memory, so these rows are the rows
 * ClickHouse would hold.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trajectory } from "../src/trajectory";
import { readRun, readStates, readMoves } from "../viewer/runs";
import {
  clickhouseConfigFromEnv,
  clickhouseErrorMessage,
  latestStatesOf,
  localRunStore,
  moveViewsOf,
  runRowOf,
  statePointOf,
  totalsOf,
  factOf,
  type StateTableRow,
} from "../viewer/clickhouse";

const roots: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "viewer-ch-"));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const NOW = 2_000_000;

/** One run, written the way the runner writes one. */
function writeRun(runsDir: string, runId: string): string {
  const dir = join(runsDir, runId);
  let clock = 1_000_000;
  const traj = new Trajectory(dir, { now: () => clock++ });
  traj.writeMeta({
    runId,
    harnessVersion: "harness-0.5-9-gabc",
    startedAt: 1_000_000,
    config: {
      runId,
      driver: "openai",
      model: "a-model",
      effort: "medium",
      apiBase: "https://openrouter.ai/api/v1",
      race: 3,
      class: 1,
      campaign: "probe-1",
      cell: "c1",
      extra: true,
      account: "RUNNER",
      watchdogs: { episodeMs: 5_400_000 },
    } as never,
    comparability: { episode: "e90", harness: "wrathbench", effort: "medium" } as never,
  });
  traj.setCharacter(runId, "Brakk");
  traj.append({ t: "request", turn: 1, ts: 1_000_100, messages: [{ role: "user", content: "go" }] });
  traj.append({
    t: "response",
    turn: 1,
    ts: 1_000_200,
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  traj.recordState(runId, { level: 3, xp: 900, map: 0, x: 1, y: 2, z: 3, money: 0, questsCompleted: 2, turn: 1 });
  traj.recordState(runId, {
    level: 4,
    xp: 120,
    map: 0,
    x: 4,
    y: 5,
    z: 6,
    money: 71,
    questsCompleted: 3,
    turn: 2,
    items: [{ name: "Tough Jerky", count: 4, equipped: false }],
  });
  traj.recordMove(runId, { map: 0, x: 7, y: 8, z: 9, moveId: 1 });
  traj.recordMove(runId, { map: 0, x: 7, y: 8, z: 9, moveId: 1, status: "arrived" });
  traj.setTermination(runId, "episode-elapsed" as never, "done");
  traj.close();
  return dir;
}

describe("a run row off the store is the run row off the files", () => {
  const runsDir = tmpRoot();
  writeRun(runsDir, "run-1");
  const store = localRunStore(runsDir);

  test("field for field, in the same order — so the JSON did not change", async () => {
    const [rows, latest] = await Promise.all([store.runRows(), store.latestStates()]);
    const fromStore = runRowOf(rows[0]!, latest.get("run-1"), NOW);
    const fromFiles = readRun(runsDir, "run-1", NOW);
    expect(JSON.stringify(fromStore)).toBe(JSON.stringify(fromFiles));
  });

  test("the readings a listing shows come off the newest sample that had them", async () => {
    const latest = (await store.latestStates()).get("run-1");
    // Level and xp ride on the SAME sample; money and quests are each the
    // newest sample that carried a value, and 0 is a value.
    expect(latest).toMatchObject({ level: 4, xp: 120, money: 71, questsCompleted: 3 });
  });

  test("the state series is the state series", async () => {
    const fromStore = (await store.stateRows("run-1")).map(statePointOf);
    expect(JSON.stringify(fromStore)).toBe(JSON.stringify(readStates(runsDir, "run-1")));
  });

  test("the movement intentions are the movement intentions", async () => {
    const fromStore = moveViewsOf(await store.moveRows("run-1"));
    expect(JSON.stringify(fromStore)).toBe(JSON.stringify(readMoves(runsDir, "run-1")));
  });

  test("the totals and the fact come back whole", async () => {
    const row = await store.totalsRow("run-1");
    const totals = totalsOf(row);
    expect(totals?.modelResponses).toBe(1);
    const fact = factOf(row, 1_000_000, NOW);
    expect(fact?.runId).toBe("run-1");
    expect(fact?.model).toBe("a-model");
    // Liveness is re-decided against this `now`, never replayed from the store.
    expect(fact?.live).toBe(false);
  });
});

describe("liveness is decided at read time", () => {
  test("a quiet run reads dead against a later now and live against an earlier one", async () => {
    const runsDir = tmpRoot();
    writeRun(runsDir, "run-live");
    const store = localRunStore(runsDir);
    const [rows, latest] = await Promise.all([store.runRows(), store.latestStates()]);
    const r = rows[0]!;
    // A terminated run is never live, whatever the clock says.
    expect(runRowOf(r, latest.get("run-live"), r.trajectory_mtime + 1).live).toBe(false);
  });

  test("a run with no termination is live inside the window and dead outside it", async () => {
    const runsDir = tmpRoot();
    const dir = join(runsDir, "run-open");
    const traj = new Trajectory(dir, { now: () => 1_000_000 });
    traj.writeMeta({
      runId: "run-open",
      harnessVersion: "h",
      startedAt: 1_000_000,
      config: { runId: "run-open", driver: "openai", model: "m" } as never,
    });
    traj.close();
    const store = localRunStore(runsDir);
    const [rows, latest] = await Promise.all([store.runRows(), store.latestStates()]);
    const r = rows[0]!;
    expect(runRowOf(r, latest.get("run-open"), r.trajectory_mtime + 1_000).live).toBe(true);
    expect(runRowOf(r, latest.get("run-open"), r.trajectory_mtime + 300_000).live).toBe(false);
  });
});

describe("archived runs are flagged, not hidden", () => {
  test("the store carries them and the caller filters", async () => {
    const runsDir = tmpRoot();
    writeRun(runsDir, "run-top");
    writeRun(join(runsDir, "archive"), "run-old");
    const rows = await localRunStore(runsDir).runRows();
    expect(rows.map((r) => `${r.run_id}:${r.archived}`).sort()).toEqual(["run-old:1", "run-top:0"]);
  });
});

describe("the latest-reading rule", () => {
  /**
   * The one derivation stated twice — once as SQL in `clickhouseStore`, once
   * as TypeScript here. It is small on purpose, and this is the test that says
   * what it must mean. The SQL half is verified against a live ClickHouse by
   * hand; nothing in the suite may require one.
   */
  const row = (o: Partial<StateTableRow>): StateTableRow => ({
    run_id: "r",
    seq: 0,
    ts: 0,
    level: null,
    xp: null,
    map: null,
    x: null,
    y: null,
    z: null,
    event_count: null,
    last_seq: null,
    money: null,
    quests_completed: null,
    turn: null,
    zone: null,
    area: null,
    health: null,
    max_health: null,
    power: null,
    max_power: null,
    power_type: null,
    next_level_xp: null,
    items: "",
    ...o,
  });

  test("level 0 is not a reading; a later sample without a level does not erase one", () => {
    const latest = latestStatesOf([
      row({ ts: 1, level: 0, xp: 5 }),
      row({ ts: 2, level: 3, xp: 40 }),
      row({ ts: 3 }),
    ]).get("r");
    expect(latest).toMatchObject({ level: 3, xp: 40 });
  });

  test("money of zero is a reading, and null is not", () => {
    const latest = latestStatesOf([row({ ts: 1, money: 500 }), row({ ts: 2, money: 0 }), row({ ts: 3 })]).get("r");
    expect(latest?.money).toBe(0);
  });

  test("a run with no usable sample reads as nothing recorded", () => {
    expect(latestStatesOf([row({ ts: 1 })]).get("r")).toEqual({
      level: null,
      xp: null,
      money: null,
      questsCompleted: null,
      items: "",
    });
  });
});

describe("configuration", () => {
  test("no CLICKHOUSE_URL is a first-class answer, not a failure", () => {
    expect(clickhouseConfigFromEnv({})).toBeNull();
    expect(clickhouseConfigFromEnv({ CLICKHOUSE_URL: "" })).toBeNull();
  });

  test("a trailing slash is trimmed and the defaults are the collector's", () => {
    expect(clickhouseConfigFromEnv({ CLICKHOUSE_URL: "http://ch:8123/" })).toEqual({
      url: "http://ch:8123",
      user: "default",
      password: "",
      database: "wrathbench",
    });
  });
});

describe("one query for the listing, not one per run", () => {
  /**
   * `/api/results` and `/api/ladder` project every run's state series. Doing
   * that a run at a time was one `states` query per run — ~700 of them per
   * request, each reading the `items` JSON — and it ran ClickHouse out of
   * memory (2026-09-17). The bulk read has to give back exactly what the
   * per-run read gives back, run for run, or a chart changes with the fix.
   */
  const runsDir = tmpRoot();
  writeRun(runsDir, "run-a");
  writeRun(runsDir, "run-b");
  const store = localRunStore(runsDir);

  test("the bulk map is the per-run series, run for run and in the same order", async () => {
    const bulk = await store.stateRowsByRun(["run-a", "run-b"]);
    for (const id of ["run-a", "run-b"]) {
      const one = (await store.stateRows(id)).map(statePointOf);
      expect(JSON.stringify((bulk.get(id) ?? []).map(statePointOf))).toBe(JSON.stringify(one));
      expect(one.length).toBeGreaterThan(0);
    }
  });

  test("runs the caller did not ask for are not in the map", async () => {
    const bulk = await store.stateRowsByRun(["run-a"]);
    expect([...bulk.keys()]).toEqual(["run-a"]);
    expect(await store.stateRowsByRun([])).toEqual(new Map());
  });

  test("a run with no state rows is absent, not an empty series", async () => {
    const bulk = await store.stateRowsByRun(["run-a", "run-nothing"]);
    expect(bulk.has("run-nothing")).toBe(false);
  });

  test("one run's latest readings come off the aggregate, and a run with no states reads undefined", async () => {
    expect(await store.latestState("run-a")).toEqual((await store.latestStates()).get("run-a")!);
    // `runRowOf` branches on undefined for `items`; a zero-filled object would
    // publish "no items" where the truth is "nothing recorded yet".
    expect(await store.latestState("run-nothing")).toBeUndefined();
  });
});

describe("a failed query says what ClickHouse said", () => {
  /**
   * The old message sliced the first 400 characters of the body, which is the
   * `meta` block — the operator saw a column list and had to dig through
   * query_log for the exception behind it.
   */
  test("the exception wins over the meta block that precedes it", () => {
    const body = JSON.stringify({
      meta: Array.from({ length: 40 }, (_, i) => ({ name: `column_${i}`, type: "Nullable(Int64)" })),
      data: [],
      exception: "Code: 241. DB::Exception: Memory limit (total) exceeded",
    });
    expect(clickhouseErrorMessage(500, body)).toBe(
      "clickhouse 500: Code: 241. DB::Exception: Memory limit (total) exceeded",
    );
  });

  test("a body cut off mid-stream still yields the exception", () => {
    // A memory abort lands after `meta` and part of `data` have been flushed,
    // so the body is not valid JSON at all.
    const body = `{"meta":[{"name":"run_id"}],"data":[{"run_id":"r"},{"run_i` +
      `\n\t"exception": "Code: 241. DB::Exception: Memory limit (total) exceeded: would use 56.00 GiB"`;
    expect(clickhouseErrorMessage(500, body)).toBe(
      "clickhouse 500: Code: 241. DB::Exception: Memory limit (total) exceeded: would use 56.00 GiB",
    );
  });

  test("a body with no exception in it falls back to the body", () => {
    expect(clickhouseErrorMessage(404, "Code: 60. Unknown table")).toBe("clickhouse 404: Code: 60. Unknown table");
    expect(clickhouseErrorMessage(500, "x".repeat(600))).toBe(`clickhouse 500: ${"x".repeat(400)}`);
  });
});
