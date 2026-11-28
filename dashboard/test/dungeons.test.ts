/**
 * The dungeon tabs' chart (`src/lib/dungeons.ts`): one point per board row at
 * its best attempt, the route's bosses (the board's, served) counted and an
 * optional one never.
 */

import { describe, expect, test } from "bun:test";
import type { DungeonAttemptView, DungeonBossView, DungeonRowView } from "../src/api/client";
import { boardRoute, bossesText, bossesTitle, dungeonPoints, dungeonViewParam } from "../src/lib/dungeons";

/** The Deadmines board's bosses as the viewer serves them, invented names. */
const BOSSES: DungeonBossView[] = [
  ...[644, 643, 642, 1763, 646, 647, 639].map((entry, i) => ({ entry, name: `Boss ${i + 1}` })),
  { entry: 645, name: "Extra", optional: true },
];
const ROUTE = boardRoute({ bosses: BOSSES });

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
    const m = dungeonPoints([cleared, partway, none], dungeonViewParam(undefined, ROUTE));
    expect(m.points.map((p) => [p.model, p.x, p.y])).toEqual([
      ["fast", 6_000_000, 7],
      ["slow", 4_200_000, 3],
    ]);
    expect(m.omitted).toEqual([{ label: m.omitted[0]!.label, why: "no boss killed" }]);
    expect(m.omitted[0]!.label).toContain("none");
  });
});

describe("the views", () => {
  const all = [644, 643, 642, 1763, 646, 647, 639];
  const clear8 = row("eight", attempt({ cleared: true, reason: "kill-target", timeToClearMs: 7_000_000, bosses: all, cookie: true, lastBossMs: 7_000_000, costUsd: 4.2 }));
  const clear7 = row("seven", attempt({ cleared: true, reason: "kill-target", timeToClearMs: 5_000_000, bosses: all, lastBossMs: 5_000_000, costUsd: 9 }));
  const short = row("short", attempt({ bosses: [644, 643, 642], lastBossMs: 4_200_000, costUsd: 0.36 }));
  const unpriced = row("unpriced", attempt({ bosses: [644], lastBossMs: 1_000_000, costUsd: null }));

  test("cost × time plots only the cleared attempts, with or without Cookie", () => {
    const v = dungeonViewParam("cost-time", ROUTE);
    const m = dungeonPoints([clear8, clear7, short, unpriced], v);
    expect(m.points.map((p) => [p.model, p.x, p.y])).toEqual([
      ["eight", 4.2, 7_000_000],
      ["seven", 9, 5_000_000],
    ]);
    expect(m.omitted.map((o) => o.why)).toEqual(["not cleared, 3 of 7 bosses", "not cleared, 1 of 7 bosses"]);
    // Its set is the cleared set: an uncleared attempt is left off whatever its bosses.
    const notCleared = row("skip", attempt({ bosses: all.slice(0, 6), lastBossMs: 3_000_000, costUsd: 1 }));
    expect(dungeonPoints([clear8, clear7, notCleared], v).points.map((p) => p.model)).toEqual(["eight", "seven"]);
  });
});

describe("Cookie (operator, 2026-11-20)", () => {
  test("the bosses are the route's seven, and the optional one is not among them", () => {
    expect([...ROUTE.names.keys()]).toEqual([644, 643, 642, 1763, 646, 647, 639]);
    expect(ROUTE.names.has(645)).toBe(false);
    expect(bossesText(attempt({ bosses: [644, 643, 642, 1763, 646, 647, 639], cookie: true }), ROUTE)).toBe("7/7");
    expect(bossesTitle(attempt({ bosses: [644, 642] }), ROUTE)).toBe("Boss 1, Boss 3");
  });
});

describe("a board published before it carried its bosses", () => {
  test("counts with no denominator, names by entry, and still draws", () => {
    const old = boardRoute({});
    expect(old.size).toBeNull();
    expect(bossesText(attempt({ bosses: [644, 643] }), old)).toBe("2");
    expect(bossesTitle(attempt({ bosses: [644] }), old)).toBe("644");
    const v = dungeonViewParam(undefined, old);
    expect(v.y.caption).toBe("bosses killed on the route");
    expect(v.y.ticks!(3)).toEqual([0, 1, 2, 3]);
    expect(dungeonPoints([row("r", attempt({ bosses: [644], lastBossMs: 1 }))], v).points).toHaveLength(1);
  });

  test("a served route of seven reads as the board always has", () => {
    const v = dungeonViewParam(undefined, ROUTE);
    expect(v.hint).toBe("time from launch to the clear, or to the last boss against bosses killed, of 7 on the route");
    expect(v.y.ticks!(0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(dungeonViewParam("cost-time", ROUTE).hint).toBe("the best attempt's cost (USD, log) against the time from launch to the clear, for the cleared attempts: all 7 bosses on the route");
  });
});
