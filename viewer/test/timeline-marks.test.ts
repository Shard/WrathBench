/**
 * What a run's timeline marks, and as what (`viewer/timeline-marks.ts`): the
 * one rule the dashboard's bar, the chapter list and the camera read.
 */

import { describe, expect, test } from "bun:test";
import { BOSS_RANK, CHAPTER_KINDS, bossKillsOf, chaptersOf, isBossKill, isChapter, levelBands, levelUpsOf, markRole, runMarks, startLevelOf } from "../timeline-marks";

describe("the marker rule", () => {
  test("a level and a boss kill are chapters, a death is an event, and nothing else is marked", () => {
    expect(markRole("level")).toBe("chapter");
    expect(markRole("boss")).toBe("chapter");
    expect(markRole("death")).toBe("event");
    // What the camera once made chapters of: the bars of blue.
    expect(markRole("quest")).toBeNull();
    expect(markRole("zone")).toBeNull();
    expect(markRole("start")).toBeNull();
    expect(markRole("toString")).toBeNull();
    expect(CHAPTER_KINDS).toEqual(["level", "boss"]);
    expect(isChapter("death")).toBe(false);
  });

  test("an old clips.json keeps only its levels and bosses as chapters", () => {
    const old = [{ type: "zone" }, { type: "quest" }, { type: "level" }, { type: "death" }, { type: "boss" }, { type: "quest" }];
    expect(chaptersOf(old).map((c) => c.type)).toEqual(["level", "boss"]);
  });

  test("a boss kill is a rank-3 creature, or an entry a caller names", () => {
    expect(isBossKill({ entry: 1, rank: BOSS_RANK })).toBe(true);
    expect(isBossKill({ entry: 644, rank: 1 })).toBe(false);
    expect(isBossKill({ entry: 644, rank: 1 }, new Set([644]))).toBe(true);
    expect(isBossKill({ entry: null, rank: 1 }, new Set([644]))).toBe(false);
    expect(isBossKill({})).toBe(false);
  });
});

describe("a run's boss kills", () => {
  test("are its rank-3 and named victims, each once, oldest first, named where the cache knows the entry", () => {
    const kills = [
      { ts: 900, victimGuid: "b", entry: 7, rank: 3 },
      // A party's kill is told to every member in range, and a restarted recorder can be told again.
      { ts: 500, victimGuid: "a", entry: 644, rank: 1 },
      { ts: 520, victimGuid: "a", entry: 644, rank: 1 },
      { ts: 600, victimGuid: "c", entry: 12, rank: 1 },
      { ts: 700, victimGuid: "d", entry: null },
      { ts: 950, victimGuid: "e", entry: null, rank: 3 },
    ];
    expect(bossKillsOf(kills, new Set([644]), new Map([[644, "Invented Foreman"]]))).toEqual([
      { ts: 500, entry: 644, name: "Invented Foreman" },
      { ts: 900, entry: 7, name: null },
      { ts: 950, entry: null, name: null },
    ]);
    expect(bossKillsOf(kills, new Set()).map((b) => b.entry)).toEqual([7, null]);
    expect(bossKillsOf([], new Set([644]))).toEqual([]);
  });
});

describe("a run's marks", () => {
  test("are its levels gained, boss kills and deaths, oldest first; a baseline reading is no level", () => {
    const marks = runMarks({
      leveling: {
        marks: [
          { ts: 100, from: null, to: 5, xp: 0, turn: 1 },
          { ts: 400, from: 5, to: 6, xp: 0, turn: 4 },
          { ts: 900, from: 6, to: 7, xp: 0, turn: 9 },
        ],
      },
      deaths: { sites: [{ ts: 600 }, { ts: 400 }] },
      bosses: [{ ts: 800, entry: 644, name: null }, { ts: 850, entry: null, name: null }],
    });
    expect(marks.map((m) => [m.ts, m.kind, m.role, m.label])).toEqual([
      [400, "level", "chapter", "level 6"],
      [400, "death", "event", "died"],
      [600, "death", "event", "died"],
      [800, "boss", "chapter", "boss 644"],
      [850, "boss", "chapter", "boss killed"],
      [900, "level", "chapter", "level 7"],
    ]);
  });

  test("a detail with no level marks reads the levels off its state samples, and a death with no time is left out", () => {
    const states = [
      { ts: 0, level: null },
      { ts: 60, level: 4 },
      { ts: 120, level: 4 },
      { ts: 180, level: 6 },
      { ts: 240, level: 6 },
    ];
    expect(levelUpsOf(states)).toEqual([{ ts: 180, from: 4, to: 6 }]);
    expect(runMarks({ states, deaths: { sites: [{}] } }).map((m) => [m.ts, m.label])).toEqual([[180, "level 6"]]);
    expect(startLevelOf({ states })).toBe(4);
    expect(startLevelOf({ leveling: { startLevel: 9 }, states })).toBe(9);
    expect(startLevelOf({})).toBeNull();
    expect(runMarks({})).toEqual([]);
  });

  test("the bands are one per level, from the mark that reached it to the next", () => {
    const marks = runMarks({ leveling: { marks: [{ ts: 300, from: 5, to: 6, xp: 0, turn: 1 }, { ts: 700, from: 6, to: 7, xp: 0, turn: 2 }] }, deaths: { sites: [{ ts: 500 }] } });
    expect(levelBands(marks, { from: 0, to: 1000 }, 5)).toEqual([
      { from: 0, to: 300, level: 5 },
      { from: 300, to: 700, level: 6 },
      { from: 700, to: 1000, level: 7 },
    ]);
    // No level known before the first mark; a run with no level mark is one band.
    expect(levelBands(marks, { from: 0, to: 1000 })[0]).toEqual({ from: 0, to: 300, level: null });
    expect(levelBands([], { from: 0, to: 1000 }, 3)).toEqual([{ from: 0, to: 1000, level: 3 }]);
    // A mark outside the span is clamped to it rather than drawn past it.
    expect(levelBands(marks, { from: 400, to: 600 }, 5)).toEqual([{ from: 400, to: 600, level: 6 }]);
  });
});
