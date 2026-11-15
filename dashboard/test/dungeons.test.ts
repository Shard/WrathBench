/**
 * The dungeon tabs' chart (`src/lib/dungeons.ts`): one point per board row at
 * its best attempt, placed by the ladder scatter's own layout.
 */

import { describe, expect, test } from "bun:test";
import type { DungeonAttemptView, DungeonRowView } from "../src/api/client";
import { attemptHref, boardRowKey, bossTicks, clearTimeTicks, dungeonPoints, pointTitle } from "../src/lib/dungeons";
import { ladderChartLayout, rungSixKey } from "../src/lib/ladder";

const attempt = (o: Partial<DungeonAttemptView> = {}): DungeonAttemptView => ({
  runIds: ["r1"],
  party: null,
  launchedAt: 0,
  counted: true,
  live: false,
  cleared: false,
  reason: "episode-timeout",
  timeToClearMs: null,
  bosses: [],
  lastBossMs: null,
  enteredMs: 60_000,
  deaths: 0,
  wipes: 0,
  ...o,
});

const row = (model: string, best: DungeonAttemptView, o: Partial<DungeonRowView> = {}): DungeonRowView => ({
  model,
  effort: "high",
  harness: "wrathbench",
  series: "0.5",
  condition: { loop: "program", yield: false, pinned: true, wiki: true },
  n: 2,
  cleared: best.cleared ? 1 : 0,
  best,
  ...o,
});

describe("dungeonPoints", () => {
  const cleared = row("fast", attempt({ cleared: true, reason: "kill-target", timeToClearMs: 6_000_000, bosses: [644, 643, 642, 1763, 646, 647, 639], lastBossMs: 6_000_000, party: "p1" }));
  const partway = row("slow", attempt({ bosses: [644, 643, 642], lastBossMs: 4_200_000 }));
  const none = row("none", attempt());

  test("a cleared attempt sits at its time to clear, an uncleared one at its last boss, both by bosses; no boss, no point", () => {
    const m = dungeonPoints([cleared, partway, none]);
    expect(m.points.map((p) => [p.model, p.x, p.y])).toEqual([
      ["fast", 6_000_000, 7],
      ["slow", 4_200_000, 3],
    ]);
    expect(m.omitted).toEqual([{ label: m.omitted[0]!.label, why: "no boss killed" }]);
    expect(m.omitted[0]!.label).toContain("none");
  });

  test("a point and a row light together on the key rung 6 joins on", () => {
    const [p] = dungeonPoints([cleared]).points;
    expect(p!.key).toBe(boardRowKey(cleared));
    expect(p!.key).toBe(rungSixKey(cleared));
  });

  test("the best attempt opens on its party's page, or its run's", () => {
    expect(attemptHref(cleared)).toBe("/party/p1");
    expect(attemptHref(partway)).toBe("/run/r1");
  });

  test("the time axis never ends short of a point", () => {
    expect(clearTimeTicks(0)).toEqual([0, 60_000]);
    for (const max of [59_000, 6_000_000, 14_400_000, 3 * 86_400_000]) expect(clearTimeTicks(max).at(-1)!).toBeGreaterThanOrEqual(max);
  });

  test("the hover reads the attempt the point is placed at", () => {
    const [fast, slow] = dungeonPoints([cleared, partway]).points;
    expect(pointTitle(fast!)).toContain("cleared in");
    expect(pointTitle(fast!)).toContain("7/8 bosses");
    expect(pointTitle(fast!)).toContain("1 of 2");
    expect(pointTitle(slow!)).toContain("last boss");
  });

  test("the ladder scatter's layout places them: every boss a tick, more bosses in less time top-left", () => {
    const box = { x0: 64, x1: 976, y0: 340, y1: 16 };
    const points = dungeonPoints([cleared, partway]).points;
    const layout = ladderChartLayout(points, box, { scale: "linear", ticks: clearTimeTicks, better: "lower" }, { ticks: bossTicks, better: "higher" });
    expect(layout.yTicks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // Time on the playtime axis's own steps, ending at or past the latest point: 1h40m is under the 2h tick.
    expect(layout.xTicks).toEqual([0, 1_800_000, 3_600_000, 5_400_000, 7_200_000]);
    expect(layout.placed.every((d) => d.cx <= box.x1)).toBe(true);
    expect(layout.placed.map((d) => d.point.model).sort()).toEqual(["fast", "slow"]);
    const at = new Map(layout.placed.map((d) => [d.point.model, d]));
    expect(at.get("fast")!.cy).toBeLessThan(at.get("slow")!.cy);
    expect(layout.cue.text).toBe("↖ better");
  });
});
