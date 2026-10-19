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
  LEADER_ROLE,
  LOADOUTS,
  PARTY_LEVEL,
  PARTY_ROLES,
  PARTY_TALENT_POINTS,
  checkTalentsAgainstFrame,
  partyCharacterName,
  partyScenario,
  validateLoadout,
  type Loadout,
  type TalentFrame,
} from "./loadouts";
import { DEADMINES_ENTRANCE_TRIGGER, MOONBROOK, SCENARIOS, SENTINEL_HILL_BIND, validateScenario } from "./scenarios";
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
  test("are the design's five: Alliance, a warrior tank, a priest healer, a mage, a rogue and a hunter", () => {
    expect(PARTY_ROLES).toEqual(["tank", "healer", "mage", "rogue", "hunter"]);
    expect(PARTY_ROLES.map((r) => [r, LOADOUTS[r].class])).toEqual([["tank", 1], ["healer", 5], ["mage", 8], ["rogue", 4], ["hunter", 3]]);
    // Human 1, Dwarf 3: Alliance, and each pairing exists in playercreateinfo.
    for (const r of PARTY_ROLES) expect([r, [1, 3].includes(LOADOUTS[r].race)]).toEqual([r, true]);
    expect(LEADER_ROLE).toBe("tank");
  });

  test("every one is legal", () => {
    for (const r of PARTY_ROLES) expect([r, validateLoadout(LOADOUTS[r])]).toEqual([r, []]);
  });

  test("spend exactly the level's talent points, one tree each, with every tier reached", () => {
    expect(PARTY_TALENT_POINTS).toBe(11);
    for (const r of PARTY_ROLES) {
      const l = LOADOUTS[r];
      expect([r, l.talents.reduce((n, t) => n + t.rank, 0)]).toEqual([r, 11]);
      expect([r, new Set(l.talents.map((t) => t.tab)).size]).toEqual([r, 1]);
      expect([r, Math.max(...l.talents.map((t) => t.row))]).toEqual([r, 2]);
    }
  });

  test("carry gear for every role and two bags each, the hunter's ammunition among the supplies", () => {
    for (const r of PARTY_ROLES) {
      const l = LOADOUTS[r];
      expect([r, l.gear.length >= 7]).toEqual([r, true]);
      expect([r, l.bags.length]).toEqual([r, 2]);
      expect([r, l.gear.some((g) => g.slot === 15)]).toEqual([r, true]);
    }
    expect(LOADOUTS.hunter.ammoId).toBe(2519);
    expect(LOADOUTS.hunter.supplies.find((s) => s.item === 2519)?.count).toBe(1000);
    // The tank wears a shield and so no two-hander; the casters and the hunter swing one.
    expect(LOADOUTS.tank.gear.find((g) => g.slot === 16)?.name).toBe("Steelcap Shield");
    for (const r of ["healer", "mage", "hunter"] as const) expect([r, LOADOUTS[r].gear.find((g) => g.slot === 15)?.twoHand]).toEqual([r, true]);
  });

  test("the warrior and hunter get the spells their level-10 quests teach, which no trainer lists", () => {
    expect(LOADOUTS.tank.questSpells.map((s) => s.spell)).toEqual([71, 355, 7386]);
    expect(LOADOUTS.hunter.questSpells.map((s) => s.spell)).toEqual([1515, 883, 2641, 982, 6991]);
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
    const hunter = LOADOUTS.hunter;
    const noDep = { ...hunter, talents: hunter.talents.map((t) => (t.talentId === 1349 ? { ...t, rank: 4, spell: 19489 } : t)) };
    expect(validateLoadout(noDep).join()).toMatch(/Aimed Shot needs talent 1349 at 5 points/);
  });
  test("a slot filled twice, a two-hander beside an off hand, ammo the bags do not carry", () => {
    expect(validateLoadout({ ...tank, gear: [...tank.gear, { item: 1, name: "x", slot: 4 }] }).join()).toMatch(/slot 4 filled twice/);
    const healer = LOADOUTS.healer;
    expect(validateLoadout({ ...healer, gear: [...healer.gear, { item: 1, name: "orb", slot: 16 }] }).join()).toMatch(/two-handed weapon and an off hand/);
    expect(validateLoadout({ ...LOADOUTS.hunter, supplies: [] }).join()).toMatch(/ammoId 2519 is not among the supplies/);
  });
});

describe("checkTalentsAgainstFrame", () => {
  test("a preset that matches the frame passes", () => {
    for (const r of PARTY_ROLES) expect([r, checkTalentsAgainstFrame(LOADOUTS[r], frameFor(LOADOUTS[r]))]).toEqual([r, []]);
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
  test("level 20 in Moonbrook facing the mine, hearth at Sentinel Hill, the trainer's and the quests' spells, talents, skills, ammo", () => {
    const s = partyScenario(LOADOUTS.hunter, [75, 1130, 1978, 1130]);
    validateScenario(s);
    expect(s.level).toBe(PARTY_LEVEL);
    expect(s.position).toMatchObject({ map: 0, x: MOONBROOK.x, y: MOONBROOK.y });
    expect(s.position.o).toBeCloseTo(SCENARIOS["moonbrook-mine"].position.o, 6);
    expect(s.homebind).toEqual(SENTINEL_HILL_BIND);
    expect(s.clearQuests).toBe(true);
    expect(s.spells).toEqual([75, 883, 982, 1130, 1515, 1978, 2641, 6991]);
    expect(s.talents).toEqual([19431, 19490, 19434]);
    expect(s.maxSkills).toBe(true);
    expect(s.ammoId).toBe(2519);
    expect(partyScenario(LOADOUTS.mage, [116]).ammoId).toBeUndefined();
  });

  test("Moonbrook faces the Deadmines entrance trigger, more than one move's 250y away", () => {
    const d = Math.hypot(DEADMINES_ENTRANCE_TRIGGER.x - MOONBROOK.x, DEADMINES_ENTRANCE_TRIGGER.y - MOONBROOK.y);
    expect(d).toBeGreaterThan(250);
    expect(d).toBeLessThan(300);
  });

  test("its statements write one talent row per talent at specMask 1 after clearing the old ones, cap the level-ranged skills, set the ammo, and insert no item", () => {
    const rendered = buildStatements(4242, partyScenario(LOADOUTS.tank, [100, 772])).map(renderStatement);
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
    expect(buildStatements(4242, partyScenario(LOADOUTS.hunter, [75])).map(renderStatement)).toContain("UPDATE characters SET ammoId = 2519 WHERE guid = 4242");
  });
});

describe("partyCharacterName", () => {
  test("one stable, valid, distinct name per role and account", () => {
    const names = PARTY_ROLES.map((r, i) => partyCharacterName(r, `PARTY${i + 1}`));
    expect(names).toEqual(["Tankpartyb", "Healpartyc", "Magepartyd", "Roguepartye", "Huntpartyf"]);
    for (const n of names) expect([n, isValidCharacterName(n)]).toEqual([n, true]);
    expect(partyCharacterName("tank", "PARTY1")).toBe("Tankpartyb");
    expect(new Set(PARTY_ROLES.flatMap((r) => ["PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"].map((a) => partyCharacterName(r, a)))).size).toBe(25);
  });
});
