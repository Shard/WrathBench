/**
 * A v1 run's game side in its run page's feed (`viewer/record-feed.ts`): the
 * session record's milestones, turn-ins, actions, moves and served event
 * batches, merged into the trajectory's entries by time, each with the turn
 * in flight, and read back whole by `raw`. Over the frozen phase-1 run, whose
 * trajectory still carries the loop's mirrors of the same things: those are
 * not shown twice.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TrajectoryTail } from "../viewer/tail";
import { materialiseV1p1, V1P1_RUN } from "./fixtures/v1p1";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

describe("the run page's feed over a v1 run", () => {
  test("the record's milestones are merged in by time, with the joined turn; the trajectory's mirrors are not shown", async () => {
    const dir = materialiseV1p1(tempDir("record-feed-"));
    const tail = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await tail.scan();
    // A first-build run's 60-second state lines are its own (nothing in the record mirrors them).
    expect(tail.entries.filter((e) => e.t === "state")).toHaveLength(20);
    // Every milestone is the record's: the zone, area and level baselines twice (the restart), the gains once.
    const milestones = tail.entries.filter((e) => e.t === "milestone");
    expect(milestones.length).toBeGreaterThan(10);
    expect(tail.entries.filter((e) => e.t === "quest_complete")).toHaveLength(3);
    // In time order across the merge.
    const ts = tail.entries.map((e) => e.ts);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    // A gain carries the turn it fell in, by the timestamp join.
    const raw = JSON.parse((await tail.raw(milestones.find((e) => e["kind"] === "level" && e["from"] === 5)!.i))!) as Record<string, unknown>;
    expect(raw).toMatchObject({ t: "milestone", kind: "level", from: 5, to: 6, turn: 4 });
    // The run page's facts read the same rows.
    expect(tail.leveling?.levelUps).toBe(2);
    expect(tail.achievements?.earned).toBe(2);
  });

  test("a later scan adds only what the record and the trajectory gained, and a new tail reads the same feed", async () => {
    const dir = materialiseV1p1(tempDir("record-feed-"), { as: V1P1_RUN });
    const a = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await a.scan();
    expect(await a.scan()).toEqual([]);
    const b = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await b.scan();
    expect(b.entries.map((e) => [e.t, e.ts])).toEqual(a.entries.map((e) => [e.t, e.ts]));
  });
});
