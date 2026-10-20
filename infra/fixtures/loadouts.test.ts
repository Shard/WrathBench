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
  loadoutFor,
  partyCharacterName,
  partyScenario,
  validateLoadout,
  type Loadout,
  type TalentFrame,
} from "./loadouts";
import { DEADMINES_ENTRANCE_TRIGGER, DEADMINES_STAGING, DEADMINES_STAGING_SPOTS, SCENARIOS, SENTINEL_HILL_BIND, validateScenario } from "./scenarios";
import { isValidCharacterName } from "../../runner/src/config";

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
  test("are the design's five, the paladin in the hunter's place (the operator, 2026-10-19): Alliance, a warrior tank, a priest healer, a mage, a rogue and a paladin", () => {
    expect(LOADOUT_IDS).toEqual(["tank", "healer", "mage", "rogue", "paladin"]);
    expect(LOADOUT_IDS.map((r) => [r, LOADOUTS[r].class, LOADOUTS[r].partyRole])).toEqual([
      ["tank", 1, "tank"],
      ["healer", 5, "healer"],
      ["mage", 8, "damage"],
      ["rogue", 4, "damage"],
      ["paladin", 2, "damage"],
    ]);
    // Human 1, Dwarf 3: Alliance, and each pairing exists in playercreateinfo.
    for (const r of LOADOUT_IDS) expect([r, [1, 3].includes(LOADOUTS[r].race)]).toEqual([r, true]);
    // No hunter anywhere: no pet to seed, no ammunition.
    expect(Object.values(LOADOUTS).some((l) => l.class === 3)).toBe(false);
    expect(JSON.stringify(LOADOUTS)).not.toMatch(/ammo|Tame Beast|Call Pet/i);
  });

  test("loadoutFor picks by race and class and holds the role word to the loadout's", () => {
    expect((loadoutFor({ race: 3, class: 2, role: "damage" }) as { id: string }).id).toBe("paladin");
    expect((loadoutFor({ race: 1, class: 1, role: "tank" }) as { id: string }).id).toBe("tank");
    expect(loadoutFor({ race: 1, class: 2, role: "damage" })).toMatch(/Dwarf Paladin \(race 3\); the member is race 1/);
    expect(loadoutFor({ race: 3, class: 3, role: "damage" })).toMatch(/no loadout for class 3/);
    expect(loadoutFor({ race: 3, class: 5, role: "damage" })).toMatch(/plays "healer"/);
  });

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

  test("carry gear for every role and two bags each", () => {
    for (const r of LOADOUT_IDS) {
      const l = LOADOUTS[r];
      expect([r, l.gear.length >= 7]).toEqual([r, true]);
      expect([r, l.bags.length]).toEqual([r, 2]);
      expect([r, l.gear.some((g) => g.slot === 15)]).toEqual([r, true]);
    }
    // The tank wears a shield and so no two-hander; the casters and the paladin swing one.
    expect(LOADOUTS.tank.gear.find((g) => g.slot === 16)?.name).toBe("Steelcap Shield");
    for (const r of ["healer", "mage", "paladin"] as const) expect([r, LOADOUTS[r].gear.find((g) => g.slot === 15)?.twoHand]).toEqual([r, true]);
    expect(LOADOUTS.paladin.gear.find((g) => g.slot === 15)?.name).toBe("Orc Crusher");
  });

  test("the warrior and paladin get the spells their class quests teach by 20, which no trainer lists", () => {
    expect(LOADOUTS.tank.questSpells.map((s) => s.spell)).toEqual([71, 355, 7386]);
    expect(LOADOUTS.paladin.questSpells.map((s) => s.spell)).toEqual([7328]);
  });

  test("the paladin trainer's learn-effect entries are resolved, and the warhorse is not staged", () => {
    const s = partyScenario(LOADOUTS.paladin, [465, 10321, 13820, 19750], SCENARIOS["moonbrook-mine"]);
    expect(s.spells).toEqual([465, 7328, 19750, 20271, 21084]);
    // Only the paladin's trainer has learn-effect entries up to 20.
    for (const r of ["tank", "healer", "mage", "rogue"] as const) expect([r, LOADOUTS[r].trainerLearns]).toEqual([r, undefined]);
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
  test("a tier reached without its points, a rank past the talent's, an unmet prerequisite", () => {
    expect(validateLoadout({ ...tank, talents: [tank.talents[2]!] }).join()).toMatch(/tier 3, which needs 10 points/);
    expect(validateLoadout({ ...tank, talents: [{ ...tank.talents[0]!, rank: 6 }] }).join()).toMatch(/rank 6 outside 1\.\.5/);
    const tank2 = { ...tank, talents: [...tank.talents.slice(0, 2), { talentId: 9, tab: 163, row: 2, col: 3, rank: 1, maxRank: 1, spell: 1, name: "Needy", dependsOn: { talentId: 138, rank: 6 } }] };
    expect(validateLoadout(tank2).join()).toMatch(/Needy needs talent 138 at 6 points/);
  });
  test("a slot filled twice, a two-hander beside an off hand", () => {
    expect(validateLoadout({ ...tank, gear: [...tank.gear, { item: 1, name: "x", slot: 4 }] }).join()).toMatch(/slot 4 filled twice/);
    const healer = LOADOUTS.healer;
    expect(validateLoadout({ ...healer, gear: [...healer.gear, { item: 1, name: "orb", slot: 16 }] }).join()).toMatch(/two-handed weapon and an off hand/);
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
  test("level 20 where the request's scenario stands (Moonbrook by the mine, facing the trigger, hearth at Sentinel Hill), the trainer's and the quests' spells, talents, skills", () => {
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

  test("the staging spot is inside one move's 250y of the trigger, with margin, the way the cap measures (2D)", () => {
    const d = Math.hypot(DEADMINES_ENTRANCE_TRIGGER.x - DEADMINES_STAGING.x, DEADMINES_ENTRANCE_TRIGGER.y - DEADMINES_STAGING.y);
    expect(d).toBeLessThanOrEqual(230);
    expect(d).toBeGreaterThan(150);
  });

  test("each of the five members stands on its own spot, apart from the others and facing the trigger", () => {
    const base = SCENARIOS["moonbrook-mine"];
    const placed = [0, 1, 2, 3, 4].map((i) => partyScenario(LOADOUTS.tank, [], base, 20, i).position);
    expect(placed).toHaveLength(DEADMINES_STAGING_SPOTS.length);
    for (const [i, p] of placed.entries()) {
      expect(p).toMatchObject({ map: 0, x: DEADMINES_STAGING_SPOTS[i]!.x, y: DEADMINES_STAGING_SPOTS[i]!.y });
      expect(Math.hypot(p.x - DEADMINES_STAGING.x, p.y - DEADMINES_STAGING.y)).toBeLessThan(8); // the smokes' staged-member check
      expect(Math.hypot(DEADMINES_ENTRANCE_TRIGGER.x - p.x, DEADMINES_ENTRANCE_TRIGGER.y - p.y)).toBeLessThanOrEqual(230);
      for (const q of placed.slice(0, i)) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(2);
      const toTrigger = Math.atan2(DEADMINES_ENTRANCE_TRIGGER.y - p.y, DEADMINES_ENTRANCE_TRIGGER.x - p.x);
      expect(Math.abs(Math.atan2(Math.sin(p.o - toTrigger), Math.cos(p.o - toTrigger)))).toBeLessThan(1e-6);
    }
    expect(partyScenario(LOADOUTS.tank, [], base, 20).position).toEqual(base.position); // the first member, the default
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

describe("partyCharacterName", () => {
  test("one stable, valid, distinct name per role and account", () => {
    const names = LOADOUT_IDS.map((r, i) => partyCharacterName(r, `PARTY${i + 1}`));
    expect(names).toEqual(["Tankpartyb", "Healpartyc", "Magepartyd", "Roguepartye", "Palapartyf"]);
    for (const n of names) expect([n, isValidCharacterName(n)]).toEqual([n, true]);
    expect(partyCharacterName("tank", "PARTY1")).toBe("Tankpartyb");
    expect(new Set(LOADOUT_IDS.flatMap((r) => ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"].map((a) => partyCharacterName(r, a)))).size).toBe(25);
  });
});
