/**
 * The dungeon registry (`runner/src/dungeons.ts`, `runner/dungeons/`) against
 * what already pins the Deadmines: the stager's fixtures (read here, never
 * written), the task episodes' definitions and the camera's and timeline's
 * boss rule. The Deadmines entry is the facts every Deadmines run was read
 * by, so it must equal them exactly; the other entries are probe targets and
 * hold together on their own. Every entry is staged: its scenario is a
 * fixture scenario with room for its party, at its level.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BOSS_ENTRIES, DUNGEONS, bossName, dungeonById, dungeonByMap, dungeonByStaged, dungeonSchema, optionalOf, routeOf } from "../runner/src/dungeons";
import { TASK_EPISODE_IDS } from "../runner/src/episodes";
import { taskDefinition } from "../runner/src/task-episodes";
import { checkedIn, checkedInFiles } from "../runner/test/fixtures/campaigns";
import { DEADMINES_ENTRANCE_TRIGGER, SCENARIOS, isScenarioName, type Scenario } from "./fixtures/scenarios";
import { PARTY_DUNGEONS } from "./smoke/lib/party";

const DIR = join(import.meta.dir, "..", "runner", "dungeons");

describe("the registry", () => {
  test("is one file per instance, each named by its id, all loaded", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(DUNGEONS.map((d) => `${d.id}.json`).sort());
  });

  test("every instance's end is the last boss on its route, and no entry is two bosses' or two instances'", () => {
    for (const d of DUNGEONS) expect({ id: d.id, last: routeOf(d).at(-1) }).toEqual({ id: d.id, last: d.end });
    const all = DUNGEONS.flatMap((d) => d.bosses.map((b) => b.entry));
    expect(new Set(all).size).toBe(all.length);
    expect(BOSS_ENTRIES.size).toBe(all.length);
    expect(new Set(DUNGEONS.map((d) => d.map)).size).toBe(DUNGEONS.length);
    expect(new Set(DUNGEONS.map((d) => d.staged)).size).toBe(DUNGEONS.length);
  });

  test("the schema refuses an end off the route and a boss listed twice", () => {
    const dm = dungeonById("deadmines")!;
    expect(dungeonSchema.safeParse({ ...dm, end: 645 }).success).toBe(false);
    expect(dungeonSchema.safeParse({ ...dm, end: 1 }).success).toBe(false);
    expect(dungeonSchema.safeParse({ ...dm, bosses: [...dm.bosses, dm.bosses[0]] }).success).toBe(false);
    expect(dungeonSchema.safeParse({ ...dm, entrance: { ...dm.entrance, box: { length: 1, width: 1, height: 1, orientation: 0 } } }).success).toBe(false);
  });

  test("finds an instance by its map and by the scenario a staged start names", () => {
    expect(dungeonByMap(36)?.id).toBe("deadmines");
    expect(dungeonByMap(33)?.id).toBe("shadowfang-keep");
    expect(dungeonByMap(34)?.id).toBe("stockade");
    expect(dungeonByMap(0)).toBeNull();
    expect(dungeonByStaged("moonbrook-mine")?.id).toBe("deadmines");
    expect(dungeonByStaged("nowhere")).toBeNull();
    expect(bossName(4275)).toBe("Archmage Arugal");
    expect(bossName(1)).toBeNull();
  });
});

describe("the Deadmines entry is today's facts", () => {
  const dm = dungeonById("deadmines")!;

  test("map 36, the eight bosses in the order the timeline and the camera have always held them, Cookie the one optional, VanCleef the end", () => {
    expect(dm).toMatchObject({ map: 36, kind: "dungeon", size: 5, level: 20, staged: "moonbrook-mine", end: 639 });
    expect(dm.bosses.map((b) => b.entry)).toEqual([644, 643, 642, 1763, 646, 647, 639, 645]);
    expect(routeOf(dm)).toEqual([644, 643, 642, 1763, 646, 647, 639]);
    expect(optionalOf(dm)).toEqual([645]);
    // The names the board has always shown.
    expect(dm.bosses.map((b) => b.name)).toEqual(["Rhahk'Zor", "Sneed", "Sneed's Shredder", "Gilnid", "Mr. Smite", "Captain Greenskin", "Edwin VanCleef", "Cookie"]);
  });

  test("its entrance is the stager's trigger, and its scenario is a fixture scenario", () => {
    const { id, ...at } = DEADMINES_ENTRANCE_TRIGGER;
    expect(dm.entrance).toEqual({ trigger: id, ...at });
    expect(isScenarioName(dm.staged)).toBe(true);
  });

  test("both task episodes start staged on it and end on its end", () => {
    for (const id of TASK_EPISODE_IDS) {
      const def = taskDefinition(id);
      expect({ id, start: def.start }).toEqual({ id, start: { staged: dm.staged, level: dm.level } });
      expect({ id, end: def.end }).toEqual({ id, end: [{ kill: { entry: dm.end } }] });
    }
  });
});

describe("every entry is staged", () => {
  // An instance is registered with the scenario that stages its party: the
  // stager can put a full party outside it, at the entry's level, which is
  // the level the party smokes and every checked-in definition staged there use.
  test("its scenario exists, with a spot for every member of a full party", () => {
    for (const d of DUNGEONS) {
      const spots = isScenarioName(d.staged) ? ((SCENARIOS[d.staged] as Scenario).partySpots?.length ?? 0) : null;
      expect({ id: d.id, staged: d.staged, spots: spots !== null && spots >= d.size }).toEqual({ id: d.id, staged: d.staged, spots: true });
    }
  });

  test("its level is the party smokes' and every checked-in definition's staged on its scenario", () => {
    const defs = checkedInFiles().map((f) => checkedIn(f.replace(/\.json$/, "")));
    for (const d of DUNGEONS) {
      expect({ id: d.id, smoke: PARTY_DUNGEONS[d.staged]?.level }).toEqual({ id: d.id, smoke: d.level });
      for (const def of defs) {
        if (typeof def.start !== "object" || def.start.staged !== d.staged) continue;
        expect({ id: d.id, def: `${def.id}@${def.version}`, level: def.start.level }).toEqual({ id: d.id, def: `${def.id}@${def.version}`, level: d.level });
      }
    }
  });
});

describe("the other entries", () => {

  test("Shadowfang Keep ends on Arugal and the Stockade on Bazil Thredd, both off map 0 triggers", () => {
    expect(dungeonById("shadowfang-keep")).toMatchObject({ map: 33, level: 20, end: 4275, entrance: { trigger: 145, map: 0 } });
    expect(dungeonById("stockade")).toMatchObject({ map: 34, level: 24, end: 1716, entrance: { trigger: 101, map: 0 } });
    expect(BOSS_ENTRIES.has(4275) && BOSS_ENTRIES.has(1716)).toBe(true);
  });
});
