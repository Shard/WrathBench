/**
 * The party loadouts and the pure checks over them: every shipped loadout is
 * legal (talent points, tiers, prerequisites, one row per talent, slots), the
 * checks catch what would crash or silently reset a character, the frame
 * cross-check refuses a preset the module's Talent.dbc reading disagrees with,
 * and the member scenario is what the design says. No database, no module.
 */
import { describe, expect, test } from "bun:test";
import { buildStatements, renderStatement } from "./apply";
import {
  LOADOUTS,
  LOADOUT_IDS,
  PARTY_LEVEL,
  PARTY_TALENT_POINTS,
  checkTalentsAgainstFrame,
  partyScenario,
  validateLoadout,
  type Loadout,
  type TalentFrame,
} from "./loadouts";
import { DEADMINES_STAGING, SCENARIOS, SENTINEL_HILL_BIND, validateScenario } from "./scenarios";

/** The frame a module would answer for a loadout, built from the preset itself. */
function frameFor(l: Loadout): TalentFrame {
  const tabs = new Map<number, { tabId: number; talents: { talentId: number; row: number; col: number; maxRank: number; ranks: number[] }[] }>();
  for (const t of l.talents) {
    const tab = tabs.get(t.tab) ?? tabs.set(t.tab, { tabId: t.tab, talents: [] }).get(t.tab)!;
    const ranks = Array.from({ length: t.maxRank }, (_, i) => (i === t.rank - 1 ? t.spell : 900000 + t.talentId * 10 + i));
    tab.talents.push({ talentId: t.talentId, row: t.row, col: t.col, maxRank: t.maxRank, ranks });
  }
  return { class: l.class, tabs: [...tabs.values()] };
}

describe("the shipped loadouts", () => {
  test("every one is legal", () => {
    for (const r of LOADOUT_IDS) expect([r, validateLoadout(LOADOUTS[r])]).toEqual([r, []]);
  });

  test("spend exactly the level's talent points, one tree each, with every tier reached", () => {
    expect(PARTY_TALENT_POINTS).toBe(11);
    for (const r of LOADOUT_IDS) {
      const l = LOADOUTS[r];
      expect([r, l.talents.reduce((n, t) => n + t.rank, 0)]).toEqual([r, 11]);
      expect([r, new Set(l.talents.map((t) => t.tab)).size]).toEqual([r, 1]);
      expect([r, Math.max(...l.talents.map((t) => t.row))]).toEqual([r, 2]);
    }
  });
});

describe("validateLoadout catches what would crash or silently reset a character", () => {
  const tank = LOADOUTS.tank;
  test("too many points (InitTalentForLevel resets the tree)", () => {
    const over = { ...tank, talents: [...tank.talents, { talentId: 147, tab: 163, row: 2, col: 1, rank: 1, maxRank: 2, spell: 12797, name: "Improved Revenge" }] };
    expect(validateLoadout(over).join()).toMatch(/12 talent points, a level 20 character has 11/);
  });
  test("two rows for one talent (the loader adds both ranks' points)", () => {
    const dup = { ...tank, talents: [tank.talents[0]!, { ...tank.talents[0]!, rank: 4, spell: 12726 }] };
    expect(validateLoadout(dup).join()).toMatch(/listed twice/);
  });
});

describe("checkTalentsAgainstFrame", () => {
  test("a preset that matches the frame passes", () => {
    for (const r of LOADOUT_IDS) expect([r, checkTalentsAgainstFrame(LOADOUTS[r], frameFor(LOADOUTS[r]))]).toEqual([r, []]);
  });
  test("refuses a spell the frame does not have at that rank, a talent not in the class's frame, and another class's frame", () => {
    const tank = LOADOUTS.tank;
    const frame = frameFor(tank);
    const typo = { ...tank, talents: tank.talents.map((t, i) => (i === 0 ? { ...t, spell: t.spell + 1 } : t)) };
    expect(checkTalentsAgainstFrame(typo, frame).join()).toMatch(/Shield Specialization rank 5 is spell 12727 in the frame, the preset says 12728/);
    const missing = { ...tank, talents: [...tank.talents, { talentId: 999999, tab: 163, row: 0, col: 0, rank: 1, maxRank: 1, spell: 1, name: "Nope" }] };
    expect(checkTalentsAgainstFrame(missing, frame).join()).toMatch(/talent 999999 \(Nope\) is not in tab 163/);
    expect(checkTalentsAgainstFrame(tank, { ...frame, class: 5 }).join()).toMatch(/frame is for class 5/);
    const moved = { ...frame, tabs: frame.tabs.map((t) => ({ ...t, talents: t.talents.map((x) => ({ ...x, row: x.row + 1 })) })) };
    expect(checkTalentsAgainstFrame(tank, moved).join()).toMatch(/sits at tier/);
  });
});

describe("the member scenario", () => {
  test("level 20 where the request's scenario stands (beside the Deadmines portal, facing the trigger, hearth at Sentinel Hill), the trainer's and the quests' spells, talents, skills", () => {
    const s = partyScenario(LOADOUTS.tank, [100, 772, 6343, 772], SCENARIOS["moonbrook-mine"], 20);
    validateScenario(s);
    expect(s.level).toBe(PARTY_LEVEL);
    expect(s.position).toMatchObject({ map: 0, x: DEADMINES_STAGING.x, y: DEADMINES_STAGING.y });
    expect(s.position.o).toBeCloseTo(SCENARIOS["moonbrook-mine"].position.o, 6);
    expect(s.homebind).toEqual(SENTINEL_HILL_BIND);
    expect(s.clearQuests).toBe(true);
    expect(s.spells).toEqual([71, 100, 355, 772, 6343, 7386]);
    expect(s.talents).toEqual([12727, 12753, 12975]);
    expect(s.maxSkills).toBe(true);
    // The base scenario's own level 80 and money are not the member's.
    expect(SCENARIOS["moonbrook-mine"].level).toBe(80);
    expect(s.money).toBe(30_000);
  });

  test("its statements write one talent row per talent at specMask 1 after clearing the old ones, cap the level-ranged skills, and insert no item", () => {
    const rendered = buildStatements(4242, partyScenario(LOADOUTS.tank, [100, 772], SCENARIOS["moonbrook-mine"])).map(renderStatement);
    const del = rendered.indexOf("DELETE FROM character_talent WHERE guid = 4242");
    expect(del).toBeGreaterThan(0);
    const talentRows = rendered.filter((s) => s.startsWith("INSERT INTO character_talent"));
    expect(talentRows).toEqual([
      "INSERT INTO character_talent (guid, spell, specMask) VALUES (4242, 12727, 1)",
      "INSERT INTO character_talent (guid, spell, specMask) VALUES (4242, 12753, 1)",
      "INSERT INTO character_talent (guid, spell, specMask) VALUES (4242, 12975, 1)",
    ]);
    expect(rendered.findIndex((s) => s.startsWith("INSERT INTO character_talent"))).toBeGreaterThan(del);
    expect(rendered).toContain("UPDATE character_skills SET value = 100, max = 100 WHERE guid = 4242 AND max > 1 AND max < 300");
    expect(rendered).toContain("INSERT IGNORE INTO character_spell (guid, spell, specMask) VALUES (4242, 71, 255)");
    expect(rendered.join("\n")).not.toMatch(/item_instance|INSERT INTO character_inventory|ammoId/);
  });
});

