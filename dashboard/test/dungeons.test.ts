/**
 * The dungeon tabs' chart (`src/lib/dungeons.ts`): one point per board row at
 * its best attempt, placed by the ladder scatter's own layout.
 */

import { describe, expect, test } from "bun:test";
import type { DungeonAttemptView, DungeonRowView } from "../src/api/client";
import { BOSS_NAMES, COOKIE_TITLE, DUNGEON_VIEWS, attemptHref, bossesText, cookieText, boardRowKey, bossTicks, clearTimeTicks, dungeonPoints, dungeonViewParam, pointTitle, standingKeys } from "../src/lib/dungeons";
import { ladderChartLayout } from "../src/lib/ladder";

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
  cookie: false,
  costUsd: null,
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

  test("a point and a row light together on one key, distinct per condition", () => {
    const [p] = dungeonPoints([cleared]).points;
    expect(p!.key).toBe(boardRowKey(cleared));
    expect(boardRowKey({ ...cleared, effort: "low" })).not.toBe(boardRowKey(cleared));
  });

  test("an uncleared attempt that got further faster never hides a cleared one's label", () => {
    // Every route boss but VanCleef in an hour, and Cookie, against a clear in 1h40m without him: 6 and 7.
    const quick = row("quick", attempt({ bosses: [644, 643, 642, 1763, 646, 647], cookie: true, lastBossMs: 3_600_000 }));
    const behind = row("behind", attempt({ bosses: [644], lastBossMs: 5_000_000 }));
    const stand = standingKeys(dungeonPoints([cleared, quick, behind]).points);
    expect(stand.has(boardRowKey(cleared))).toBe(true);
    expect(stand.has(boardRowKey(quick))).toBe(true);
    expect(stand.has(boardRowKey(behind))).toBe(false);
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
    expect(pointTitle(fast!)).toContain("7/7 bosses");
    expect(pointTitle(fast!)).not.toContain("Cookie");
    expect(pointTitle(fast!)).toContain("1 of 2");
    expect(pointTitle(slow!)).toContain("last boss");
  });

  test("the ladder scatter's layout places them: every boss a tick, more bosses in less time top-left", () => {
    const box = { x0: 64, x1: 976, y0: 340, y1: 16 };
    const points = dungeonPoints([cleared, partway]).points;
    const layout = ladderChartLayout(points, box, { scale: "linear", ticks: clearTimeTicks, better: "lower" }, { ticks: bossTicks, better: "higher" });
    expect(layout.yTicks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Time on the playtime axis's own steps, ending at or past the latest point: 1h40m is under the 2h tick.
    expect(layout.xTicks).toEqual([0, 1_800_000, 3_600_000, 5_400_000, 7_200_000]);
    expect(layout.placed.every((d) => d.cx <= box.x1)).toBe(true);
    expect(layout.placed.map((d) => d.point.model).sort()).toEqual(["fast", "slow"]);
    const at = new Map(layout.placed.map((d) => [d.point.model, d]));
    expect(at.get("fast")!.cy).toBeLessThan(at.get("slow")!.cy);
    expect(layout.cue.text).toBe("↖ better");
  });
});

describe("the views", () => {
  const box = { x0: 64, x1: 976, y0: 340, y1: 16 };
  const all = [644, 643, 642, 1763, 646, 647, 639];
  const clear8 = row("eight", attempt({ cleared: true, reason: "kill-target", timeToClearMs: 7_000_000, bosses: all, cookie: true, lastBossMs: 7_000_000, costUsd: 4.2 }));
  const clear7 = row("seven", attempt({ cleared: true, reason: "kill-target", timeToClearMs: 5_000_000, bosses: all, lastBossMs: 5_000_000, costUsd: 9 }));
  const short = row("short", attempt({ bosses: [644, 643, 642], lastBossMs: 4_200_000, costUsd: 0.36 }));
  const unpriced = row("unpriced", attempt({ bosses: [644], lastBossMs: 1_000_000, costUsd: null }));
  const view = (id: string) => dungeonViewParam(id);

  test("time × bosses is the default; a ladder view's id or nonsense falls back to it", () => {
    expect(DUNGEON_VIEWS.map((v) => v.id)).toEqual(["time-bosses", "cost-bosses", "cost-time"]);
    for (const raw of [undefined, "cost-xp", "nonsense", ["cost-xp"]]) expect(dungeonViewParam(raw).id).toBe("time-bosses");
    expect(dungeonViewParam(["cost-time"]).id).toBe("cost-time");
  });

  test("cost × bosses places the best attempt at its cost, on the ladder's log cost axis; an unpriced one is named, not plotted", () => {
    const m = dungeonPoints([clear8, short, unpriced], view("cost-bosses"));
    expect(m.points.map((p) => [p.model, p.x, p.y])).toEqual([
      ["eight", 4.2, 7],
      ["short", 0.36, 3],
    ]);
    expect(m.omitted.map((o) => o.why)).toEqual(["no cost recorded"]);
    const layout = ladderChartLayout(m.points, box, view("cost-bosses").x, view("cost-bosses").y);
    expect(layout.xMinorTicks.length).toBeGreaterThan(0);
    expect(layout.yTicks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(layout.cue.text).toBe("↖ better");
  });

  test("a priced attempt with no boss still has a place on cost × bosses, at zero", () => {
    const none = row("none", attempt({ costUsd: 0.1 }));
    expect(dungeonPoints([none], view("cost-bosses")).points.map((p) => [p.x, p.y])).toEqual([[0.1, 0]]);
    expect(dungeonPoints([none]).omitted.map((o) => o.why)).toEqual(["no boss killed"]);
  });

  test("cost × time plots only the cleared attempts, with or without Cookie, and less of both is better", () => {
    const v = view("cost-time");
    const m = dungeonPoints([clear8, clear7, short, unpriced], v);
    expect(m.points.map((p) => [p.model, p.x, p.y])).toEqual([
      ["eight", 4.2, 7_000_000],
      ["seven", 9, 5_000_000],
    ]);
    expect(m.omitted.map((o) => o.why)).toEqual(["not cleared, 3 of 7 bosses", "not cleared, 1 of 7 bosses"]);
    // Its set is the cleared set: an uncleared attempt is left off whatever its bosses.
    const notCleared = row("skip", attempt({ bosses: all.slice(0, 6), lastBossMs: 3_000_000, costUsd: 1 }));
    expect(dungeonPoints([clear8, clear7, notCleared], v).points.map((p) => p.model)).toEqual(["eight", "seven"]);
    // Neither beats the other on both: both stand.
    expect(standingKeys(m.points, v)).toEqual(new Set([boardRowKey(clear8), boardRowKey(clear7)]));
    const layout = ladderChartLayout(m.points, box, v.x, v.y, standingKeys(m.points, v));
    expect(layout.cue.text).toBe("↙ better");
  });

  test("the front follows the view's directions", () => {
    const dear = row("dear", attempt({ cleared: true, reason: "kill-target", timeToClearMs: 8_000_000, bosses: all, lastBossMs: 8_000_000, costUsd: 20 }));
    const v = view("cost-time");
    const stand = standingKeys(dungeonPoints([clear8, dear], v).points, v);
    expect(stand.has(boardRowKey(dear))).toBe(false);
  });

  test("the hover names the cost when the attempt has one, and Cookie when he died", () => {
    const [p] = dungeonPoints([clear8], view("cost-bosses")).points;
    expect(pointTitle(p!)).toContain("$4.20");
    expect(pointTitle(p!)).toContain("7/7 bosses and Cookie");
    const [q] = dungeonPoints([short]).points;
    expect(pointTitle({ ...q!, row: { ...short, best: { ...short.best, costUsd: null } } })).not.toContain("$");
  });
});

describe("Cookie (operator, 2026-11-20)", () => {
  test("the bosses are the route's seven, and Cookie is not among them", () => {
    expect([...BOSS_NAMES.keys()]).toEqual([644, 643, 642, 1763, 646, 647, 639]);
    expect(BOSS_NAMES.has(645)).toBe(false);
    expect(bossesText(attempt({ bosses: [644, 643, 642, 1763, 646, 647, 639], cookie: true }))).toBe("7/7");
  });

  test("the table's extra reads yes or a dash, and its tooltip says it counts toward nothing", () => {
    expect(cookieText(attempt({ cookie: true }))).toBe("yes");
    expect(cookieText(attempt())).toBe("—");
    // A board from before the field.
    expect(cookieText({} as { cookie: boolean })).toBe("—");
    expect(COOKIE_TITLE).toContain("optional");
  });
});
