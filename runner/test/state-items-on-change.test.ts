/**
 * The state row's `items`, written only when the sample changed.
 *
 * The loop leaves an unchanged inventory off the 60-second state row (the
 * trace's character sheet is the record of gear), and writes it whole on a
 * process's first row and after a sandbox restart. What has to hold for that to
 * lose nothing is on the read side: every reader takes the newest reading at or
 * before a point, so a point that falls on an item-less row reads what the
 * last item-bearing row said. Each reader path is pinned here against a run
 * written by the real `ContextBuilder`, beside the same run with the whole
 * sample on every row.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import { Scratchpad } from "@wrathbench/mcp";
import type { SandboxHost } from "../src/sandbox/host";
import { Trajectory, readTrajectory, type ItemSample, type StateLine } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { readRun, readStateItems, readStates } from "../viewer/runs";
import { trackFrom } from "../viewer/results";
import { inventoryAt } from "../viewer/track-inv";
import { latestStatesOf, localRunStore, statePointOf, type StateTableRow } from "../viewer/clickhouse";
import { projectEntry, projectTrack } from "../viewer/public-projection";
import { summarize } from "../viewer/tail";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const ROW_MS = 60_000;

/** What the character wears and carries, as the snapshot's two lists. */
interface Inv {
  inventory: { slot: number; itemId: number; name: string; stackCount?: number; quality?: number }[];
  bag: { items: { bag: number; slot: number; itemId: number; name: string; count: number; quality?: number }[] };
}

const A: Inv = {
  inventory: [{ slot: 16, itemId: 5956, name: "Worn Mace", quality: 1 }],
  bag: { items: [{ bag: 255, slot: 23, itemId: 6948, name: "Hearthstone", count: 1, quality: 1 }] },
};
const B: Inv = {
  inventory: A.inventory,
  bag: { items: [...A.bag.items, { bag: 255, slot: 24, itemId: 2589, name: "Linen Cloth", count: 3, quality: 1 }] },
};
const C: Inv = {
  inventory: [{ slot: 16, itemId: 2493, name: "Wooden Mallet", quality: 1 }],
  bag: B.bag,
};

/** The `items` a row of each inventory stores, as `itemSample` builds it. */
const SAMPLE = (inv: Inv): ItemSample[] => [
  ...inv.inventory.map((i) => ({ name: i.name, count: i.stackCount ?? 1, equipped: true, itemId: i.itemId, ...(i.quality === undefined ? {} : { quality: i.quality }), slot: i.slot })),
  ...inv.bag.items.map((i) => ({ name: i.name, count: i.count, equipped: false, itemId: i.itemId, ...(i.quality === undefined ? {} : { quality: i.quality }), slot: i.slot, bag: i.bag })),
];

interface World {
  inv: Inv | null;
  x: number;
  restarts: number;
}

/** A run directory, a clock, and a builder over a sandbox whose snapshot is `world`. */
function harness(dir: string, runId: string, world: World, clock: { t: number }) {
  const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: ROW_MS }), runId, token: runId };
  const trajectory = new Trajectory(dir, { now: () => clock.t });
  trajectory.writeMeta({ runId, harnessVersion: "t", startedAt: 1_000_000, config });
  const sandbox = {
    evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () =>
      Promise.resolve({
        self: {
          guid: "7",
          level: { value: 3, seq: 1, ts: 1 },
          position: { value: { map: 0, x: world.x, y: 2, z: 3 }, seq: 1, ts: 1 },
        },
        lastSeq: -1,
        eventCount: 0,
        ...(world.inv ?? {}),
      }),
    get totalRestarts() {
      return world.restarts;
    },
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
  const builder = (): ContextBuilder =>
    new ContextBuilder({
      config,
      sandbox,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      now: () => clock.t,
    });
  return { trajectory, builder };
}

/** One state row per call, each a row interval after the last. */
async function sample(b: ContextBuilder, clock: { t: number }, world: World, inv: Inv | null): Promise<void> {
  clock.t += ROW_MS;
  world.inv = inv;
  world.x += 1;
  await b.sampleState();
}

/** Whether each `{t:"state"}` line carried `items`, and each sqlite row's column. */
function itemsOnRows(t: Trajectory, runId: string): { jsonl: boolean[]; sqlite: (string | null)[] } {
  return {
    jsonl: readTrajectory(t.dir)
      .filter((r) => r.t === "state")
      .map((r) => "items" in r),
    sqlite: t.stateRows(runId).map((r) => r["items"] as string | null),
  };
}

describe("the writer", () => {
  test("an unchanged sample is left off both the line and the column; a changed one is written whole", async () => {
    const dir = tempDir("state-items-");
    const world: World = { inv: null, x: 0, restarts: 0 };
    const clock = { t: 1_000_000 };
    const { trajectory, builder } = harness(dir, "run-w", world, clock);
    const b = builder();
    for (const inv of [A, A, B, B, B, C]) await sample(b, clock, world, inv);
    const rows = itemsOnRows(trajectory, "run-w");
    expect(rows.jsonl).toEqual([true, false, true, false, false, true]);
    expect(rows.sqlite).toEqual([JSON.stringify(SAMPLE(A)), null, JSON.stringify(SAMPLE(B)), null, null, JSON.stringify(SAMPLE(C))]);
    trajectory.close();
  });

  test("a sample with no inventory writes none, and does not count as a change", async () => {
    const dir = tempDir("state-items-");
    const world: World = { inv: null, x: 0, restarts: 0 };
    const clock = { t: 1_000_000 };
    const { trajectory, builder } = harness(dir, "run-n", world, clock);
    const b = builder();
    for (const inv of [null, A, null, A]) await sample(b, clock, world, inv);
    expect(itemsOnRows(trajectory, "run-n").jsonl).toEqual([false, true, false, false]);
    trajectory.close();
  });

  test("the first row after a sandbox restart carries the whole sample", async () => {
    const dir = tempDir("state-items-");
    const world: World = { inv: null, x: 0, restarts: 0 };
    const clock = { t: 1_000_000 };
    const { trajectory, builder } = harness(dir, "run-r", world, clock);
    const b = builder();
    await sample(b, clock, world, A);
    await sample(b, clock, world, A);
    world.restarts++;
    await sample(b, clock, world, A);
    await sample(b, clock, world, A);
    expect(itemsOnRows(trajectory, "run-r").jsonl).toEqual([true, false, true, false]);
    trajectory.close();
  });

  test("a new process's first row carries the whole sample, though the last one written matches it", async () => {
    // A start, a resume and a runner restart are each a fresh builder: the
    // comparison lives in memory only, so nothing carries over.
    const dir = tempDir("state-items-");
    const world: World = { inv: null, x: 0, restarts: 0 };
    const clock = { t: 1_000_000 };
    const { trajectory, builder } = harness(dir, "run-p", world, clock);
    const first = builder();
    await sample(first, clock, world, A);
    await sample(first, clock, world, A);
    const second = builder();
    await sample(second, clock, world, A);
    await sample(second, clock, world, A);
    expect(itemsOnRows(trajectory, "run-p").jsonl).toEqual([true, false, true, false]);
    trajectory.close();
  });

  test("a row whose write gave up is written again on the next sample", async () => {
    // The ticker swallows a sample's failure; had the key advanced anyway,
    // run.sqlite's newest inventory would stay behind what this process saw.
    const dir = tempDir("state-items-");
    const world: World = { inv: null, x: 0, restarts: 0 };
    const clock = { t: 1_000_000 };
    const { trajectory, builder } = harness(dir, "run-f", world, clock);
    const b = builder();
    await sample(b, clock, world, A);
    const real = trajectory.recordState.bind(trajectory);
    trajectory.recordState = (runId: string, s: StateLine) => {
      trajectory.recordState = real;
      trajectory.append({ t: "state", ...s });
      return Promise.reject(new Error("database is locked"));
    };
    await expect(sample(b, clock, world, B)).rejects.toThrow("database is locked");
    await sample(b, clock, world, B);
    await sample(b, clock, world, B);
    expect(trajectory.stateRows("run-f").map((r) => r["items"])).toEqual([JSON.stringify(SAMPLE(A)), JSON.stringify(SAMPLE(B)), null]);
    trajectory.close();
  });
});

describe("every reader, at a point that falls on an item-less row", () => {
  /*
   * Two runs on one clock: `run-on-change` as the loop now writes it, and
   * `run-every-row` with the whole sample on every row, as it was written
   * before. Readers that carry the newest reading forward give them the same
   * answers, point for point.
   */
  const SERIES: Inv[] = [A, A, B, B, B, C, C];
  const runsDir = tempDir("state-items-readers-");

  async function writeBoth(): Promise<void> {
    {
      const world: World = { inv: null, x: 0, restarts: 0 };
      const clock = { t: 1_000_000 };
      const { trajectory, builder } = harness(join(runsDir, "run-on-change"), "run-on-change", world, clock);
      const b = builder();
      for (const inv of SERIES) await sample(b, clock, world, inv);
      trajectory.close();
    }
    {
      const clock = { t: 1_000_000 };
      const dir = join(runsDir, "run-every-row");
      const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: ROW_MS }), runId: "run-every-row", token: "run-every-row" };
      const trajectory = new Trajectory(dir, { now: () => clock.t });
      trajectory.writeMeta({ runId: "run-every-row", harnessVersion: "t", startedAt: 1_000_000, config });
      let x = 0;
      for (const inv of SERIES) {
        clock.t += ROW_MS;
        x += 1;
        await trajectory.recordState("run-every-row", { level: 3, map: 0, x, y: 2, z: 3, eventCount: 0, lastSeq: -1, questsCompleted: 0, items: SAMPLE(inv) });
      }
      trajectory.close();
    }
  }
  const written = writeBoth();

  test("the fixture's newest row carries no items, and only changes do", async () => {
    await written;
    const rows = readStateItems(runsDir, "run-on-change");
    expect(rows.map((r) => r.items)).toEqual([SAMPLE(A), SAMPLE(B), SAMPLE(C)].map((s) => JSON.stringify(s)));
    expect(readStates(runsDir, "run-on-change")).toHaveLength(SERIES.length);
  });

  test("sqlite: the run row's inventory is the newest reading, not the newest row's", async () => {
    await written;
    expect(readRun(runsDir, "run-on-change").items).toEqual(SAMPLE(C));
  });

  test("sqlite: the replay track joins each point to the reading at or before it", async () => {
    await written;
    const onChange = trackFrom(readStates(runsDir, "run-on-change"), readStateItems(runsDir, "run-on-change"));
    const everyRow = trackFrom(readStates(runsDir, "run-every-row"), readStateItems(runsDir, "run-every-row"));
    expect(onChange).toEqual(everyRow);
    const inv = onChange.inv!;
    expect(SERIES.map((_, i) => inventoryAt(inv, i))).toEqual(SERIES.map(SAMPLE));
  });

  test("the store (the collector's own ingestion, in memory): latest, item rows and the track", async () => {
    await written;
    const store = localRunStore(runsDir);
    const latest = await store.latestState("run-on-change");
    expect(latest?.items).toBe(JSON.stringify(SAMPLE(C)));
    expect((await store.latestStates()).get("run-on-change")?.items).toBe(JSON.stringify(SAMPLE(C)));
    // The collector stores an item-less row as the empty string, and the
    // newest non-empty one is what the aggregate keeps.
    const stored = (await store.stateRows("run-on-change")) as StateTableRow[];
    expect(stored.map((r) => r.items.length > 0)).toEqual([true, false, true, false, false, true, false]);
    expect(latestStatesOf(stored).get("run-on-change")?.items).toBe(JSON.stringify(SAMPLE(C)));
    const itemRows = await store.stateItemRows("run-on-change");
    expect(itemRows).toHaveLength(3);
    const viaStore = trackFrom(stored.map(statePointOf), itemRows);
    const everyRow = trackFrom(
      (await store.stateRows("run-every-row")).map(statePointOf),
      await store.stateItemRows("run-every-row"),
    );
    expect(viaStore).toEqual(everyRow);
  });

  test("public: the track projects the same either way, and an item-less feed entry carries no items key", async () => {
    await written;
    const track = (id: string) => ({ runId: "run", ...trackFrom(readStates(runsDir, id), readStateItems(runsDir, id)), moves: [] }) as never;
    expect(projectTrack(track("run-on-change"))).toEqual(projectTrack(track("run-every-row")));
    const lines = readTrajectory(join(runsDir, "run-on-change")).filter((r) => r.t === "state");
    const entries = lines.map((r, i) => projectEntry(summarize(r, i, 0, lines.length)));
    expect(entries.map((e) => "items" in e)).toEqual([true, false, true, false, false, true, false]);
    expect(entries[0]!["items"]).toEqual(SAMPLE(A));
  });
});
