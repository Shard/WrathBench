/**
 * The raid loadouts (`raid-loadouts.ts`) and their keying: every one legal at
 * 80 (71 talent points, tiers, prerequisites), every piece wearable by its
 * class at 80 and every slot filled, both tanks past the defense cap, the
 * trainer rule that drops talent-gated ranks, and a member's spec picking its
 * loadout without moving the five level-20 ones. No database, no module.
 */
import { describe, expect, test } from "bun:test";
import { PARTY_SPECS } from "../../runner/src/party";
import { buildStatements, renderStatement } from "./apply";
import { LOADOUTS, LOADOUT_IDS, SLOT, checkTalentsAgainstFrame, loadoutAt, loadoutFor, partyScenario, talentPointsAt, validateLoadout, type Loadout, type TalentFrame } from "./loadouts";
import {
  DEFENSE_CAP,
  EQUIP,
  RAID_LEVEL,
  RAID_LOADOUTS,
  RAID_LOADOUT_IDS,
  defenseSkill,
  isRaidLoadout,
  raidGearProblems,
  raidLoadoutOf,
  raidSlots,
  raidTrainerSpells,
  type RaidLoadout,
} from "./raid-loadouts";
import { ONYXIA_STAGING_SPOTS, SCENARIOS, THERAMORE_BIND, validateScenario } from "./scenarios";

const ALL = RAID_LOADOUT_IDS.map((id) => RAID_LOADOUTS[id]);

/** A frame built from the preset itself: each talent's ranks, the preset's own spell at its rank. */
function frameFor(l: Loadout, extra: TalentFrame["tabs"][number]["talents"] = []): TalentFrame {
  const tabs = new Map<number, { tabId: number; talents: { talentId: number; row: number; col: number; maxRank: number; ranks: number[] }[] }>();
  for (const t of l.talents) {
    const tab = tabs.get(t.tab) ?? tabs.set(t.tab, { tabId: t.tab, talents: [] }).get(t.tab)!;
    const ranks = Array.from({ length: t.maxRank }, (_, i) => (i === t.rank - 1 ? t.spell : 900000 + t.talentId * 10 + i));
    tab.talents.push({ talentId: t.talentId, row: t.row, col: t.col, maxRank: t.maxRank, ranks });
  }
  const first = [...tabs.values()][0]!;
  first.talents.push(...extra.map((x) => ({ ...x, ranks: [...x.ranks] })));
  return { class: l.class, tabs: [...tabs.values()] };
}

describe("the ten raid loadouts", () => {
  test("two tanks, three healers, five damage, within the five staged classes, each keyed by a distinct class and spec", () => {
    expect(ALL.map((l) => l.partyRole).sort()).toEqual(["damage", "damage", "damage", "damage", "damage", "healer", "healer", "healer", "tank", "tank"]);
    expect(new Set(ALL.map((l) => l.class))).toEqual(new Set([1, 2, 4, 5, 8]));
    expect(new Set(ALL.map((l) => `${l.class}/${l.spec}`)).size).toBe(10);
    for (const l of ALL) {
      expect([l.id, (PARTY_SPECS as readonly string[]).includes(l.spec), l.level, isRaidLoadout(l)]).toEqual([l.id, true, RAID_LEVEL, true]);
      expect(raidLoadoutOf(l.class, l.spec)).toBe(l);
    }
  });

  test("every one is legal at 80 and spends exactly 71 points", () => {
    expect(talentPointsAt(RAID_LEVEL)).toBe(71);
    for (const l of ALL) {
      expect([l.id, validateLoadout(l as Loadout, RAID_LEVEL)]).toEqual([l.id, []]);
      expect([l.id, l.talents.reduce((n, t) => n + t.rank, 0)]).toEqual([l.id, 71]);
      expect([l.id, checkTalentsAgainstFrame(l as Loadout, frameFor(l as Loadout))]).toEqual([l.id, []]);
      // Every tier is reached in order and every prerequisite is met (validateLoadout says which if not).
      for (const t of l.talents) if (t.dependsOn) expect(l.talents.find((x) => x.talentId === t.dependsOn!.talentId)!.rank).toBeGreaterThanOrEqual(t.dependsOn.rank);
    }
  });

  test("a talent out of tier order or short of its prerequisite is caught", () => {
    const w = RAID_LOADOUTS.protwarrior;
    const early = { ...w, talents: w.talents.filter((t) => t.name !== "Shield Specialization") };
    expect(validateLoadout(early as Loadout, RAID_LEVEL).join()).toMatch(/needs \d+ points in its tree first/);
    const short = { ...w, talents: w.talents.map((t) => (t.name === "Impale" ? { ...t, rank: 1, spell: 12289 } : t)) };
    expect(validateLoadout(short as Loadout, RAID_LEVEL).join()).toMatch(/Deep Wounds needs talent 662 at 2 points/);
  });

  test("every piece is wearable by its class at 80 and every slot but the shirt is filled (the off hand empty under a two-hander)", () => {
    for (const l of ALL) {
      expect([l.id, raidGearProblems(l)]).toEqual([l.id, []]);
      expect([l.id, [...new Set(l.gear.map((g) => g.slot))].sort((a, b) => a - b)]).toEqual([l.id, raidSlots(l).sort((a, b) => a - b)]);
      for (const g of l.gear) expect([l.id, g.item, Number.isInteger(g.item) && g.item > 0 && g.name.length > 0]).toEqual([l.id, g.item, true]);
    }
    expect(RAID_LOADOUTS.retpaladin.gear.some((g) => g.twoHand && g.slot === SLOT.mainHand)).toBe(true);
    expect(raidSlots(RAID_LOADOUTS.retpaladin)).not.toContain(EQUIP.offHand);
  });

  test("the checks refuse a piece the class cannot wear, a wrong slot, a missing slot and a unique piece twice", () => {
    const mage = RAID_LOADOUTS.arcanemage;
    const plate = { ...mage, gear: mage.gear.map((g) => (g.slot === EQUIP.head ? { ...g, subclass: 4 } : g)) };
    expect(raidGearProblems(plate).join()).toMatch(/armor subclass 4 is not a class 8 proficiency/);
    const sword = { ...mage, gear: mage.gear.map((g) => (g.slot === EQUIP.mainHand ? { ...g, subclass: 7, inv: 13, twoHand: undefined } : g)) } as RaidLoadout;
    expect(raidGearProblems(sword).join()).toMatch(/weapon subclass 7 is not a class 8 skill/);
    const feetOnHead = { ...mage, gear: mage.gear.map((g) => (g.slot === EQUIP.head ? { ...g, inv: 8 } : g)) };
    expect(raidGearProblems(feetOnHead).join()).toMatch(/inventory type 8 does not go in slot 0/);
    const bare = { ...mage, gear: mage.gear.filter((g) => g.slot !== EQUIP.neck) };
    expect(raidGearProblems(bare).join()).toMatch(/slot 1 is empty/);
    const ring = mage.gear.find((g) => g.slot === EQUIP.finger1)!;
    const twice = { ...mage, gear: mage.gear.map((g) => (g.slot === EQUIP.finger2 ? { ...ring, slot: EQUIP.finger2 } : g)) };
    expect(raidGearProblems(twice).join()).toMatch(new RegExp(`unique item ${ring.item} twice`));
    const high = { ...mage, gear: mage.gear.map((g) => (g.slot === EQUIP.head ? { ...g, req: 81 } : g)) };
    expect(raidGearProblems(high).join()).toMatch(/needs level 81/);
    const warriorOnly = { ...mage, gear: mage.gear.map((g) => (g.slot === EQUIP.head ? { ...g, classes: 1 } : g)) };
    expect(raidGearProblems(warriorOnly).join()).toMatch(/not for class 8/);
    // A one-hander in the off hand is the rogue's alone (Dual Wield).
    const dw = RAID_LOADOUTS.protwarrior;
    const twoWeapons = { ...dw, gear: dw.gear.map((g) => (g.slot === EQUIP.offHand ? { ...dw.gear.find((x) => x.slot === EQUIP.mainHand)!, slot: EQUIP.offHand } : g)) };
    expect(raidGearProblems(twoWeapons).join()).toMatch(/needs Dual Wield/);
    expect(raidGearProblems(RAID_LOADOUTS.combatrogue)).toEqual([]);
  });

  test("pre-raid gear around item level 200, and both tanks past the defense cap without gems or enchants", () => {
    for (const l of ALL) {
      const avg = l.gear.reduce((n, g) => n + g.ilvl, 0) / l.gear.length;
      expect([l.id, avg >= 195 && avg <= 205, Math.min(...l.gear.map((g) => g.ilvl)) >= 187, Math.max(...l.gear.map((g) => g.ilvl)) <= 213]).toEqual([l.id, true, true, true]);
    }
    for (const l of ALL.filter((x) => x.partyRole === "tank")) expect([l.id, defenseSkill(l) >= DEFENSE_CAP]).toEqual([l.id, true]);
    expect([defenseSkill(RAID_LOADOUTS.protwarrior), defenseSkill(RAID_LOADOUTS.protpaladin)]).toEqual([546, 545]);
  });

  test("four bags and the class's reagents: Symbol of Kings for paladins, Devout Candles for priests, Arcane Powder for mages, poisons for the rogue", () => {
    const has = (l: RaidLoadout, item: number) => l.supplies.some((s) => s.item === item);
    for (const l of ALL) expect([l.id, l.bags.length, l.bags.every((b) => b.item === 41599)]).toEqual([l.id, 4, true]);
    for (const l of ALL) {
      if (l.class === 2) expect([l.id, has(l, 21177)]).toEqual([l.id, true]);
      if (l.class === 5) expect([l.id, has(l, 44615)]).toEqual([l.id, true]);
      if (l.class === 8) expect([l.id, has(l, 17020)]).toEqual([l.id, true]);
    }
    expect(has(RAID_LOADOUTS.combatrogue, 43231) && has(RAID_LOADOUTS.combatrogue, 43233)).toBe(true);
  });
});

describe("keying a member's loadout", () => {
  test("a member that names no spec gets the level-20 object itself, so the scored staging hash cannot move", () => {
    for (const id of LOADOUT_IDS) {
      const l = LOADOUTS[id];
      expect(loadoutFor({ race: l.race, class: l.class, role: l.partyRole })).toBe(l);
      expect(loadoutFor({ race: l.race, class: l.class, role: l.partyRole }, 20)).toBe(l);
      expect(loadoutFor({ race: l.race, class: l.class, role: l.partyRole }, 24)).toBe(l);
      expect(l.spec).toBeUndefined();
      expect(l.level).toBeUndefined();
    }
  });

  test("a member that names its spec gets the raid loadout of its class and spec, at 80 only", () => {
    expect(loadoutFor({ race: 3, class: 5, role: "healer", spec: "holy" }, 80)).toBe(RAID_LOADOUTS.holypriest);
    expect(loadoutFor({ race: 3, class: 5, role: "healer", spec: "discipline" }, 80)).toBe(RAID_LOADOUTS.discpriest);
    expect(loadoutFor({ race: 3, class: 5, role: "damage", spec: "shadow" })).toBe(RAID_LOADOUTS.shadowpriest);
    expect(loadoutFor({ race: 3, class: 2, role: "tank", spec: "protection" }, 80)).toBe(RAID_LOADOUTS.protpaladin);
    expect(loadoutFor({ race: 3, class: 5, role: "healer", spec: "holy" }, 20)).toMatch(/built for level 80; the party is staged at 20/);
    expect(loadoutFor({ race: 1, class: 5, role: "healer", spec: "holy" }, 80)).toMatch(/Dwarf Priest \(Holy\) \(race 3\); the member is race 1/);
    expect(loadoutFor({ race: 1, class: 1, role: "tank" }, 80)).toMatch(/a member staged at 80 names its spec/);
    expect(loadoutAt(RAID_LOADOUTS.frostmage as Loadout, 80)).toBe(RAID_LOADOUTS.frostmage);
    expect(() => loadoutAt(RAID_LOADOUTS.frostmage as Loadout, 24)).toThrow(/built for level 80/);
  });
});

describe("raidTrainerSpells: a trainer rank past a talent the build does not take is never learned", () => {
  test("keeps baseline chains and the build's own talent chains, drops another tree's talent ranks and what hangs off them, and the exclusions", () => {
    const shadow = RAID_LOADOUTS.shadowpriest as Loadout;
    const mindFlay = shadow.talents.find((t) => t.name === "Mind Flay")!;
    // A talent the build does not take, in the same frame: Penance (rank spell 47540).
    const frame = frameFor(shadow, [{ talentId: 1897, row: 10, col: 1, maxRank: 1, ranks: [47540] }]);
    const rows = [
      { spell: 591, reqs: [585] }, // Smite 2 needs Smite 1, a starting spell: kept
      { spell: 598, reqs: [591] },
      { spell: 17311, reqs: [mindFlay.spell] }, // Mind Flay 2 needs the build's talent: kept
      { spell: 17312, reqs: [17311] },
      { spell: 53005, reqs: [47540] }, // Penance 2 needs a talent not taken: dropped
      { spell: 53006, reqs: [53005] }, // and what hangs off it
      { spell: 6346, reqs: [] },
    ];
    expect(raidTrainerSpells(shadow, rows, frame)).toEqual([591, 598, 6346, 17311, 17312]);
    const pala = RAID_LOADOUTS.retpaladin as Loadout;
    expect(raidTrainerSpells(pala, [{ spell: 13820, reqs: [] }, { spell: 23214, reqs: [13819, 33391] }, { spell: 20217, reqs: [] }], frameFor(pala))).toEqual([20217]);
  });
});

describe("a raid member's scenario", () => {
  test("level 80 on its own spot outside Onyxia's Lair, hearth at Theramore, its talents, the filtered trainer spells and its quest spells", () => {
    const tank = RAID_LOADOUTS.protwarrior as Loadout;
    const s = partyScenario(tank, [100, 47488], SCENARIOS["dustwallow-lair"], RAID_LEVEL, 9);
    validateScenario(s);
    expect(s.level).toBe(80);
    expect(s.position).toMatchObject({ map: 1, x: ONYXIA_STAGING_SPOTS[9]!.x, y: ONYXIA_STAGING_SPOTS[9]!.y });
    expect(s.homebind).toEqual(THERAMORE_BIND);
    expect(s.spells).toEqual([71, 100, 355, 2458, 7386, 47488]);
    expect(s.talents).toHaveLength(tank.talents.length);
    const rendered = buildStatements(7, s).map(renderStatement);
    expect(rendered).toContain("UPDATE character_skills SET value = 400, max = 400 WHERE guid = 7 AND max > 1 AND max < 300");
    // A paladin's Judgement entry teaches its two spells; the mounts are never learned.
    const pala = partyScenario(RAID_LOADOUTS.holypaladin as Loadout, [10321, 13820, 20217], SCENARIOS["dustwallow-lair"], RAID_LEVEL, 4);
    expect(pala.spells).toEqual([5502, 7328, 20217, 20271, 21084]);
  });
});
