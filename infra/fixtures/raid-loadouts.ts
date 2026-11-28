/**
 * The raid loadouts: ten level-80 Alliance characters for a ten-player raid
 * (Onyxia's Lair, `runner/dungeons/onyxias-lair.json`), each keyed by class
 * and talent tree (`spec`) rather than class alone, because a raid carries
 * two of a class (two priest healers, two mages) and the class's role
 * variants. Data and the pure checks over it; `loadouts.ts` dispatches to it
 * (`loadoutFor`, a member with a `spec`) and the stager puts a character into
 * one exactly as it does at 20.
 *
 * Within the five classes the level-20 party staged (no hunter, warlock,
 * shaman, druid or death knight: their pets and class staging are not built):
 * two tanks (Protection warrior and paladin), three healers (Holy and
 * Discipline priests, a Holy paladin), five damage (Arcane and Frost mages, a
 * Combat rogue, a Retribution paladin, a Shadow priest). Humans and Dwarves
 * as at 20, so every proficiency is the one the level-20 member already has.
 *
 * Where the numbers come from, all read offline from the pinned core's base
 * world SQL and the client's DBC files on the data volume, never typed from
 * memory:
 *
 * - Talents: 71 points (levels 10-80) each, a standard PvE build of its tree,
 *   resolved by name against Talent.dbc / TalentTab.dbc: tab, tier, column,
 *   rank count, the rank's spell, and `dependsOn` from the talent's own
 *   prerequisite. One prerequisite is not in Talent.dbc at all
 *   (Sanctified Retribution's, talent 1409); the core skips a prerequisite it
 *   cannot look up (`Player::LearnTalent`), so the preset carries none.
 * - Spells: the class trainer's, read from the world DB at staging time as at
 *   20 (`trainer_spell` up to 80), with one rule the level-20 party never
 *   needed: a trainer row whose prerequisite (`ReqAbility1..3`) is a talent
 *   rank the build does not take, or a row dropped by that rule, is dropped
 *   (`raidTrainerSpells`), so the Holy priest never learns Mind Flay rank 2
 *   and the Frost mage never learns Pyroblast. Of the five trainers up to 80
 *   only the paladin's has learn-effect entries (Spell.dbc effect 36): the
 *   level-20 Judgement, and the mounts, which are left out with the Charger
 *   (no member rides). The class quests' spells no trainer lists
 *   (`quest_template` RewardSpell for the class, resolved through Spell.dbc):
 *   the warrior's Defensive Stance, Taunt and Sunder Armor (quest spell
 *   8121) and Berserker Stance (8616, which also teaches Intercept, which the
 *   trainer lists too); the paladin's Redemption (7329) and Sense Undead
 *   (5503); the rogue's Poisons (2995).
 * - Gear: heroic-dungeon and pre-raid epics and rares of item level 187-200
 *   (average 198-200 a set), chosen from `item_template` by class
 *   proficiency, slot and role stat weights, each one a drop, a vendor item or
 *   a quest reward somewhere in the world tables, and none with a
 *   requirement the staged character could not meet at login: no
 *   reputation, profession skill or spell, honor or city rank, map, area,
 *   duration, random property or suffix, limit category, resilience (PvP),
 *   holiday boss, or Horde-only race mask. Every weapon is one the race and
 *   class start with a skill in (`playercreateinfo_skills`, raised to 400 by
 *   `maxSkills`): a weapon whose skill is learned later would stage at skill
 *   1 and miss against a level-83 boss. So the Combat rogue fights with
 *   daggers (Close Quarters Combat, not Hack and Slash) and the mages with
 *   staves. Plate comes from the trainer at 40 (Plate Mail, 750). The two
 *   tanks are past the defense cap without gems or enchants (723 and 717
 *   defense rating, 146 and 145 defense skill over the 400 base at 4.9185
 *   rating a point, gtCombatRatings at 80; 540 is uncrittable by a level-83
 *   boss). Sockets stay empty and nothing is enchanted: `.additem` stores a
 *   plain item. Fire resistance is not stacked.
 * - Glyphs are not staged: the stager writes no `character_glyphs` row.
 */

import type { PartySpec } from "../../runner/src/party";
import type { GearLine, Loadout, PartyRoleWord, StockLine, TalentFrame, TalentPick } from "./loadouts";

/** The level a raid party is staged at, and the only level a raid loadout is built for. */
export const RAID_LEVEL = 80;

/** Equipment slots (`EquipmentSlots` in the core): `loadouts.ts` SLOT's numbers, with the trinkets. */
export const EQUIP = {
  head: 0,
  neck: 1,
  shoulders: 2,
  chest: 4,
  waist: 5,
  legs: 6,
  feet: 7,
  wrists: 8,
  hands: 9,
  finger1: 10,
  finger2: 11,
  trinket1: 12,
  trinket2: 13,
  back: 14,
  mainHand: 15,
  offHand: 16,
  ranged: 17,
} as const;
const SLOT = EQUIP;

/** A raid piece with the `item_template` facts its checks read (`raidGearProblems`). */
export type RaidGearLine = GearLine & {
  /** `class` and `subclass`: 4/0 jewellery and held items, 4/1-4 cloth to plate, 4/6 shield, 4/7 libram, 2/n a weapon. */
  itemClass: number;
  subclass: number;
  /** `InventoryType`. */
  inv: number;
  ilvl: number;
  /** `RequiredLevel`. */
  req: number;
  /** `AllowableClass`, -1 for any. */
  classes: number;
  /** Defense rating (stat type 12), for the tanks' cap. */
  defense?: number;
  /** `maxcount` 1 or unique-equipped: never two in one set. */
  unique?: true;
};

export const RAID_LOADOUT_IDS = [
  "protwarrior",
  "protpaladin",
  "holypriest",
  "discpriest",
  "holypaladin",
  "arcanemage",
  "frostmage",
  "combatrogue",
  "retpaladin",
  "shadowpriest",
] as const;
export type RaidLoadoutId = (typeof RAID_LOADOUT_IDS)[number];

/** A raid loadout: a loadout with its tree and its one level. */
export type RaidLoadout = Omit<Loadout, "id" | "spec" | "level" | "gear"> & { id: RaidLoadoutId; spec: PartySpec; level: typeof RAID_LEVEL; gear: readonly RaidGearLine[] };

const FROSTWEAVE_BAG: StockLine = { item: 41599, name: "Frostweave Bag", count: 1 };
const BAGS = [FROSTWEAVE_BAG, FROSTWEAVE_BAG, FROSTWEAVE_BAG, FROSTWEAVE_BAG] as const;
const ROCKFIN = { item: 34759, name: "Smoked Rockfin", count: 20 } as const;
const TEA = { item: 33445, name: "Honeymint Tea", count: 20 } as const;
const HEALING = { item: 33447, name: "Runic Healing Potion", count: 10 } as const;
const MANA = { item: 33448, name: "Runic Mana Potion", count: 10 } as const;
const STONEBLOOD = { item: 46379, name: "Flask of Stoneblood", count: 3 } as const;
const ENDLESS_RAGE = { item: 46377, name: "Flask of Endless Rage", count: 3 } as const;
const FROST_WYRM = { item: 46376, name: "Flask of the Frost Wyrm", count: 3 } as const;
/** Greater Blessings' reagent. */
const SYMBOL_OF_KINGS = { item: 21177, name: "Symbol of Kings", count: 100 } as const;
/** Prayer of Fortitude, of Spirit and of Shadow Protection at 80. */
const DEVOUT_CANDLE = { item: 44615, name: "Devout Candle", count: 20 } as const;
/** Arcane Brilliance. */
const ARCANE_POWDER = { item: 17020, name: "Arcane Powder", count: 20 } as const;
const INSTANT_POISON = { item: 43231, name: "Instant Poison IX", count: 20 } as const;
const DEADLY_POISON = { item: 43233, name: "Deadly Poison IX", count: 20 } as const;

const TANK_SUPPLIES: readonly StockLine[] = [ROCKFIN, HEALING, STONEBLOOD];
const PALADIN_TANK_SUPPLIES: readonly StockLine[] = [ROCKFIN, TEA, HEALING, MANA, STONEBLOOD, SYMBOL_OF_KINGS];
const PRIEST_SUPPLIES: readonly StockLine[] = [ROCKFIN, TEA, HEALING, MANA, FROST_WYRM, DEVOUT_CANDLE];
const MAGE_SUPPLIES: readonly StockLine[] = [ROCKFIN, TEA, HEALING, MANA, FROST_WYRM, ARCANE_POWDER];

/** The warrior's class-quest spells: Defensive Stance, Taunt, Sunder Armor (8121) and Berserker Stance (8616). */
const WARRIOR_QUEST = [
  { spell: 71, name: "Defensive Stance" },
  { spell: 355, name: "Taunt" },
  { spell: 7386, name: "Sunder Armor" },
  { spell: 2458, name: "Berserker Stance" },
] as const;
/** The paladin's: Redemption (7329) and Sense Undead (5503). */
const PALADIN_QUEST = [
  { spell: 7328, name: "Redemption" },
  { spell: 5502, name: "Sense Undead" },
] as const;
/** Judgement teaches Judgement of Light and Seal of Righteousness (as at 20). */
const PALADIN_LEARNS = { 10321: [20271, 21084] } as const;
/** Summon Warhorse (13820, the Draenei trainer's 34768) and Summon Charger (23214, 34767): mounts and riding, which no member has. */
const PALADIN_EXCLUDE = [13820, 34768, 23214, 34767] as const;

// protwarrior: 17 pieces, average item level 199.2, defense rating 723
const PROTWARRIOR_GEAR: readonly RaidGearLine[] = [
  { item: 39395, name: "Thane's Tainted Greathelm", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 200, req: 80, classes: -1, defense: 40 },
  { item: 40679, name: "Chained Military Gorget", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: 32767, defense: 33 },
  { item: 44312, name: "Wapach's Spaulders of Solidarity", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 200, req: 80, classes: 262143, defense: 58 },
  { item: 39398, name: "Massive Skeletal Ribcage", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 200, req: 80, classes: 262143, defense: 52 },
  { item: 37241, name: "Ancient Aligned Girdle", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 200, req: 80, classes: -1, defense: 48 },
  { item: 47171, name: "Legguards of Abandoned Fealty", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 200, req: 80, classes: 262143, defense: 60 },
  { item: 39234, name: "Plague-Impervious Boots", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 200, req: 80, classes: 1535, defense: 44 },
  { item: 39467, name: "Minion Bracers", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 200, req: 80, classes: -1, defense: 32 },
  { item: 39197, name: "Gauntlets of the Master", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 200, req: 80, classes: 262143, defense: 38 },
  { item: 40426, name: "Signet of the Accord", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: 262143, defense: 31, unique: true },
  { item: 39141, name: "Deflection Band", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: 262143, defense: 28, unique: true },
  { item: 39292, name: "Repelling Charge", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, defense: 84, unique: true },
  { item: 36993, name: "Seal of the Pantheon", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 187, req: 78, classes: -1, defense: 65, unique: true },
  { item: 43988, name: "Gale-Proof Cloak", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1, defense: 32 },
  { item: 45076, name: "Teldrassil Protector", slot: SLOT.mainHand, itemClass: 2, subclass: 0, inv: 13, ilvl: 200, req: 80, classes: -1, defense: 44 },
  { item: 40701, name: "Crygil's Discarded Plate Panel", slot: SLOT.offHand, itemClass: 4, subclass: 6, inv: 14, ilvl: 200, req: 80, classes: -1, defense: 34 },
  { item: 43612, name: "Spineslicer", slot: SLOT.ranged, itemClass: 2, subclass: 16, inv: 25, ilvl: 200, req: 80, classes: -1 },
];
const PROTWARRIOR_TALENTS: readonly TalentPick[] = [
  { talentId: 124, tab: 161, row: 0, col: 0, rank: 3, maxRank: 3, spell: 12664, name: "Improved Heroic Strike" },
  { talentId: 130, tab: 161, row: 0, col: 1, rank: 2, maxRank: 5, spell: 16463, name: "Deflection" },
  { talentId: 126, tab: 161, row: 1, col: 0, rank: 2, maxRank: 2, spell: 12697, name: "Improved Charge" },
  { talentId: 128, tab: 161, row: 1, col: 2, rank: 3, maxRank: 3, spell: 12677, name: "Tactical Mastery" },
  { talentId: 662, tab: 161, row: 2, col: 2, rank: 2, maxRank: 2, spell: 16494, name: "Impale" },
  { talentId: 121, tab: 161, row: 2, col: 3, rank: 3, maxRank: 3, spell: 12867, name: "Deep Wounds", dependsOn: { talentId: 662, rank: 2 } },
  { talentId: 157, tab: 164, row: 0, col: 2, rank: 5, maxRank: 5, spell: 12856, name: "Cruelty" },
  { talentId: 1601, tab: 163, row: 0, col: 1, rank: 5, maxRank: 5, spell: 12727, name: "Shield Specialization" },
  { talentId: 141, tab: 163, row: 0, col: 2, rank: 2, maxRank: 3, spell: 12665, name: "Improved Thunder Clap" },
  { talentId: 144, tab: 163, row: 1, col: 1, rank: 3, maxRank: 3, spell: 50687, name: "Incite" },
  { talentId: 153, tab: 163, row: 2, col: 0, rank: 1, maxRank: 1, spell: 12975, name: "Last Stand" },
  { talentId: 147, tab: 163, row: 2, col: 1, rank: 2, maxRank: 2, spell: 12799, name: "Improved Revenge" },
  { talentId: 1654, tab: 163, row: 2, col: 2, rank: 2, maxRank: 2, spell: 29599, name: "Shield Mastery" },
  { talentId: 140, tab: 163, row: 2, col: 3, rank: 5, maxRank: 5, spell: 12764, name: "Toughness" },
  { talentId: 146, tab: 163, row: 3, col: 2, rank: 3, maxRank: 3, spell: 12811, name: "Puncture" },
  { talentId: 152, tab: 163, row: 4, col: 1, rank: 1, maxRank: 1, spell: 12809, name: "Concussion Blow" },
  { talentId: 149, tab: 163, row: 4, col: 2, rank: 2, maxRank: 2, spell: 12958, name: "Gag Order" },
  { talentId: 702, tab: 163, row: 5, col: 2, rank: 5, maxRank: 5, spell: 16542, name: "One-Handed Weapon Specialization" },
  { talentId: 1652, tab: 163, row: 6, col: 0, rank: 2, maxRank: 2, spell: 29594, name: "Improved Defensive Stance" },
  { talentId: 148, tab: 163, row: 6, col: 1, rank: 1, maxRank: 1, spell: 50720, name: "Vigilance", dependsOn: { talentId: 152, rank: 1 } },
  { talentId: 1660, tab: 163, row: 6, col: 2, rank: 3, maxRank: 3, spell: 29792, name: "Focused Rage" },
  { talentId: 1653, tab: 163, row: 7, col: 1, rank: 3, maxRank: 3, spell: 29144, name: "Vitality" },
  { talentId: 2236, tab: 163, row: 8, col: 0, rank: 1, maxRank: 1, spell: 57499, name: "Warbringer" },
  { talentId: 1666, tab: 163, row: 8, col: 1, rank: 1, maxRank: 1, spell: 20243, name: "Devastate" },
  { talentId: 1893, tab: 163, row: 8, col: 2, rank: 3, maxRank: 3, spell: 47296, name: "Critical Block" },
  { talentId: 1871, tab: 163, row: 9, col: 1, rank: 3, maxRank: 3, spell: 46953, name: "Sword and Board", dependsOn: { talentId: 1666, rank: 1 } },
  { talentId: 2246, tab: 163, row: 9, col: 2, rank: 2, maxRank: 2, spell: 58874, name: "Damage Shield" },
  { talentId: 1872, tab: 163, row: 10, col: 1, rank: 1, maxRank: 1, spell: 46968, name: "Shockwave" },
];

// protpaladin: 17 pieces, average item level 199.2, defense rating 717
const PROTPALADIN_GEAR: readonly RaidGearLine[] = [
  { item: 39395, name: "Thane's Tainted Greathelm", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 200, req: 80, classes: -1, defense: 40 },
  { item: 40679, name: "Chained Military Gorget", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: 32767, defense: 33 },
  { item: 44312, name: "Wapach's Spaulders of Solidarity", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 200, req: 80, classes: 262143, defense: 58 },
  { item: 39398, name: "Massive Skeletal Ribcage", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 200, req: 80, classes: 262143, defense: 52 },
  { item: 37241, name: "Ancient Aligned Girdle", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 200, req: 80, classes: -1, defense: 48 },
  { item: 47171, name: "Legguards of Abandoned Fealty", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 200, req: 80, classes: 262143, defense: 60 },
  { item: 39234, name: "Plague-Impervious Boots", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 200, req: 80, classes: 1535, defense: 44 },
  { item: 39467, name: "Minion Bracers", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 200, req: 80, classes: -1, defense: 32 },
  { item: 39197, name: "Gauntlets of the Master", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 200, req: 80, classes: 262143, defense: 38 },
  { item: 40426, name: "Signet of the Accord", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: 262143, defense: 31, unique: true },
  { item: 39141, name: "Deflection Band", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: 262143, defense: 28, unique: true },
  { item: 39292, name: "Repelling Charge", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, defense: 84, unique: true },
  { item: 36993, name: "Seal of the Pantheon", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 187, req: 78, classes: -1, defense: 65, unique: true },
  { item: 43988, name: "Gale-Proof Cloak", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1, defense: 32 },
  { item: 37401, name: "Red Sword of Courage", slot: SLOT.mainHand, itemClass: 2, subclass: 7, inv: 13, ilvl: 200, req: 80, classes: -1, defense: 38, unique: true },
  { item: 40701, name: "Crygil's Discarded Plate Panel", slot: SLOT.offHand, itemClass: 4, subclass: 6, inv: 14, ilvl: 200, req: 80, classes: -1, defense: 34 },
  { item: 40707, name: "Libram of Obstruction", slot: SLOT.ranged, itemClass: 4, subclass: 7, inv: 28, ilvl: 200, req: 80, classes: 2 },
];
const PROTPALADIN_TALENTS: readonly TalentPick[] = [
  { talentId: 1442, tab: 383, row: 0, col: 1, rank: 5, maxRank: 5, spell: 63650, name: "Divinity" },
  { talentId: 1748, tab: 383, row: 1, col: 0, rank: 3, maxRank: 3, spell: 53519, name: "Stoicism" },
  { talentId: 1629, tab: 383, row: 1, col: 2, rank: 5, maxRank: 5, spell: 20100, name: "Anticipation" },
  { talentId: 2280, tab: 383, row: 2, col: 0, rank: 1, maxRank: 1, spell: 64205, name: "Divine Sacrifice" },
  { talentId: 1501, tab: 383, row: 2, col: 1, rank: 3, maxRank: 3, spell: 20470, name: "Improved Righteous Fury" },
  { talentId: 1423, tab: 383, row: 2, col: 2, rank: 5, maxRank: 5, spell: 20147, name: "Toughness" },
  { talentId: 2281, tab: 383, row: 3, col: 0, rank: 2, maxRank: 2, spell: 53530, name: "Divine Guardian", dependsOn: { talentId: 2280, rank: 1 } },
  { talentId: 1431, tab: 383, row: 4, col: 1, rank: 1, maxRank: 1, spell: 20911, name: "Blessing of Sanctuary" },
  { talentId: 1750, tab: 383, row: 5, col: 0, rank: 2, maxRank: 2, spell: 31849, name: "Sacred Duty" },
  { talentId: 1429, tab: 383, row: 5, col: 2, rank: 3, maxRank: 3, spell: 20198, name: "One-Handed Weapon Specialization" },
  { talentId: 2282, tab: 383, row: 6, col: 0, rank: 1, maxRank: 2, spell: 31785, name: "Spiritual Attunement" },
  { talentId: 1430, tab: 383, row: 6, col: 1, rank: 1, maxRank: 1, spell: 20925, name: "Holy Shield", dependsOn: { talentId: 1431, rank: 1 } },
  { talentId: 1751, tab: 383, row: 6, col: 2, rank: 3, maxRank: 3, spell: 31852, name: "Ardent Defender" },
  { talentId: 1421, tab: 383, row: 7, col: 0, rank: 3, maxRank: 3, spell: 20135, name: "Redoubt" },
  { talentId: 1753, tab: 383, row: 7, col: 2, rank: 3, maxRank: 3, spell: 31860, name: "Combat Expertise" },
  { talentId: 2195, tab: 383, row: 8, col: 0, rank: 3, maxRank: 3, spell: 53592, name: "Touched by the Light" },
  { talentId: 1754, tab: 383, row: 8, col: 1, rank: 1, maxRank: 1, spell: 31935, name: "Avenger's Shield", dependsOn: { talentId: 1430, rank: 1 } },
  { talentId: 2194, tab: 383, row: 8, col: 2, rank: 2, maxRank: 2, spell: 53585, name: "Guarded by the Light" },
  { talentId: 2204, tab: 383, row: 9, col: 1, rank: 3, maxRank: 3, spell: 53711, name: "Shield of the Templar", dependsOn: { talentId: 1754, rank: 1 } },
  { talentId: 2200, tab: 383, row: 9, col: 2, rank: 2, maxRank: 2, spell: 53696, name: "Judgements of the Just" },
  { talentId: 2196, tab: 383, row: 10, col: 1, rank: 1, maxRank: 1, spell: 53595, name: "Hammer of the Righteous" },
  { talentId: 1403, tab: 381, row: 0, col: 1, rank: 5, maxRank: 5, spell: 20064, name: "Deflection" },
  { talentId: 1631, tab: 381, row: 1, col: 0, rank: 2, maxRank: 2, spell: 25957, name: "Improved Judgements" },
  { talentId: 1464, tab: 381, row: 1, col: 1, rank: 3, maxRank: 3, spell: 20337, name: "Heart of the Crusader" },
  { talentId: 1411, tab: 381, row: 2, col: 1, rank: 5, maxRank: 5, spell: 20121, name: "Conviction" },
  { talentId: 1755, tab: 381, row: 3, col: 3, rank: 3, maxRank: 3, spell: 31868, name: "Crusade" },
];

// holypriest: 16 pieces, average item level 198.4, defense rating 0
const HOLYPRIEST_GEAR: readonly RaidGearLine[] = [
  { item: 44408, name: "Cowl of the Vindictive Captain", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 187, req: 0, classes: -1 },
  { item: 40681, name: "Lattice Choker of Light", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: 32767 },
  { item: 47226, name: "Mantle of Inconsolable Fear", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 200, req: 80, classes: 262143 },
  { item: 44404, name: "Bauble-Woven Gown", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 187, req: 0, classes: -1 },
  { item: 47218, name: "The Confessor's Binding", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 200, req: 80, classes: 32767 },
  { item: 47185, name: "Leggings of the Haggard Apprentice", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 200, req: 80, classes: -1 },
  { item: 39254, name: "Saltarello Shoes", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 200, req: 80, classes: 262143 },
  { item: 47173, name: "Bindings of the Wicked", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 200, req: 80, classes: -1 },
  { item: 47230, name: "Handwraps of Surrendered Hope", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 200, req: 80, classes: -1 },
  { item: 47200, name: "Signet of Purity", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 43408, name: "Solitaire of Reflecting Beams", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 42988, name: "Darkmoon Card: Illusion", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 39229, name: "Embrace of the Spider", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: 262143, unique: true },
  { item: 43283, name: "Subterranean Waterfall Shroud", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1 },
  { item: 37360, name: "Staff of Draconic Combat", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 200, req: 80, classes: -1 },
  { item: 37619, name: "Wand of Ahn'kahet", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 200, req: 80, classes: -1 },
];
const HOLYPRIEST_TALENTS: readonly TalentPick[] = [
  { talentId: 1898, tab: 201, row: 0, col: 2, rank: 5, maxRank: 5, spell: 52803, name: "Twin Disciplines" },
  { talentId: 346, tab: 201, row: 1, col: 1, rank: 3, maxRank: 3, spell: 14771, name: "Improved Inner Fire" },
  { talentId: 344, tab: 201, row: 1, col: 2, rank: 2, maxRank: 2, spell: 14767, name: "Improved Power Word: Fortitude" },
  { talentId: 347, tab: 201, row: 2, col: 0, rank: 3, maxRank: 3, spell: 14777, name: "Meditation" },
  { talentId: 406, tab: 202, row: 0, col: 1, rank: 3, maxRank: 3, spell: 17191, name: "Improved Renew" },
  { talentId: 401, tab: 202, row: 0, col: 2, rank: 5, maxRank: 5, spell: 15011, name: "Holy Specialization" },
  { talentId: 1181, tab: 202, row: 1, col: 2, rank: 5, maxRank: 5, spell: 18535, name: "Divine Fury" },
  { talentId: 442, tab: 202, row: 2, col: 0, rank: 1, maxRank: 1, spell: 19236, name: "Desperate Prayer" },
  { talentId: 361, tab: 202, row: 2, col: 3, rank: 3, maxRank: 3, spell: 15363, name: "Inspiration" },
  { talentId: 408, tab: 202, row: 3, col: 1, rank: 3, maxRank: 3, spell: 15014, name: "Improved Healing" },
  { talentId: 1561, tab: 202, row: 4, col: 1, rank: 1, maxRank: 1, spell: 20711, name: "Spirit of Redemption" },
  { talentId: 402, tab: 202, row: 4, col: 2, rank: 5, maxRank: 5, spell: 15031, name: "Spiritual Guidance" },
  { talentId: 1766, tab: 202, row: 5, col: 0, rank: 2, maxRank: 2, spell: 33154, name: "Surge of Light" },
  { talentId: 404, tab: 202, row: 5, col: 2, rank: 5, maxRank: 5, spell: 15356, name: "Spiritual Healing" },
  { talentId: 1768, tab: 202, row: 6, col: 0, rank: 3, maxRank: 3, spell: 34860, name: "Holy Concentration" },
  { talentId: 1637, tab: 202, row: 6, col: 1, rank: 1, maxRank: 1, spell: 724, name: "Lightwell", dependsOn: { talentId: 1561, rank: 1 } },
  { talentId: 1767, tab: 202, row: 7, col: 1, rank: 5, maxRank: 5, spell: 33162, name: "Empowered Healing" },
  { talentId: 1904, tab: 202, row: 7, col: 2, rank: 3, maxRank: 3, spell: 63737, name: "Serendipity" },
  { talentId: 1902, tab: 202, row: 8, col: 0, rank: 3, maxRank: 3, spell: 63543, name: "Empowered Renew" },
  { talentId: 1815, tab: 202, row: 8, col: 1, rank: 1, maxRank: 1, spell: 34861, name: "Circle of Healing" },
  { talentId: 1903, tab: 202, row: 8, col: 2, rank: 3, maxRank: 3, spell: 47560, name: "Test of Faith" },
  { talentId: 1905, tab: 202, row: 9, col: 1, rank: 5, maxRank: 5, spell: 47567, name: "Divine Providence" },
  { talentId: 1911, tab: 202, row: 10, col: 1, rank: 1, maxRank: 1, spell: 47788, name: "Guardian Spirit" },
];

// discpriest: 16 pieces, average item level 198.4, defense rating 0
const DISCPRIEST_GEAR: readonly RaidGearLine[] = [
  { item: 44408, name: "Cowl of the Vindictive Captain", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 187, req: 0, classes: -1 },
  { item: 40681, name: "Lattice Choker of Light", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: 32767 },
  { item: 47226, name: "Mantle of Inconsolable Fear", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 200, req: 80, classes: 262143 },
  { item: 44404, name: "Bauble-Woven Gown", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 187, req: 0, classes: -1 },
  { item: 47218, name: "The Confessor's Binding", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 200, req: 80, classes: 32767 },
  { item: 47185, name: "Leggings of the Haggard Apprentice", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 200, req: 80, classes: -1 },
  { item: 39254, name: "Saltarello Shoes", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 200, req: 80, classes: 262143 },
  { item: 47173, name: "Bindings of the Wicked", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 200, req: 80, classes: -1 },
  { item: 47230, name: "Handwraps of Surrendered Hope", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 200, req: 80, classes: -1 },
  { item: 47200, name: "Signet of Purity", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 43408, name: "Solitaire of Reflecting Beams", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 42988, name: "Darkmoon Card: Illusion", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 39229, name: "Embrace of the Spider", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: 262143, unique: true },
  { item: 43283, name: "Subterranean Waterfall Shroud", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1 },
  { item: 37360, name: "Staff of Draconic Combat", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 200, req: 80, classes: -1 },
  { item: 37238, name: "Rod of the Fallen Monarch", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 200, req: 80, classes: -1 },
];
const DISCPRIEST_TALENTS: readonly TalentPick[] = [
  { talentId: 1898, tab: 201, row: 0, col: 2, rank: 5, maxRank: 5, spell: 52803, name: "Twin Disciplines" },
  { talentId: 346, tab: 201, row: 1, col: 1, rank: 3, maxRank: 3, spell: 14771, name: "Improved Inner Fire" },
  { talentId: 344, tab: 201, row: 1, col: 2, rank: 2, maxRank: 2, spell: 14767, name: "Improved Power Word: Fortitude" },
  { talentId: 347, tab: 201, row: 2, col: 0, rank: 3, maxRank: 3, spell: 14777, name: "Meditation" },
  { talentId: 348, tab: 201, row: 2, col: 1, rank: 1, maxRank: 1, spell: 14751, name: "Inner Focus" },
  { talentId: 343, tab: 201, row: 2, col: 2, rank: 3, maxRank: 3, spell: 14769, name: "Improved Power Word: Shield" },
  { talentId: 1769, tab: 201, row: 3, col: 0, rank: 3, maxRank: 3, spell: 33172, name: "Absolution" },
  { talentId: 341, tab: 201, row: 3, col: 1, rank: 3, maxRank: 3, spell: 14781, name: "Mental Agility" },
  { talentId: 1201, tab: 201, row: 4, col: 1, rank: 5, maxRank: 5, spell: 18555, name: "Mental Strength" },
  { talentId: 351, tab: 201, row: 4, col: 2, rank: 1, maxRank: 1, spell: 63574, name: "Soul Warding", dependsOn: { talentId: 343, rank: 3 } },
  { talentId: 1771, tab: 201, row: 5, col: 0, rank: 2, maxRank: 2, spell: 33190, name: "Focused Power" },
  { talentId: 1772, tab: 201, row: 5, col: 2, rank: 3, maxRank: 3, spell: 34910, name: "Enlightenment" },
  { talentId: 322, tab: 201, row: 6, col: 1, rank: 1, maxRank: 1, spell: 10060, name: "Power Infusion", dependsOn: { talentId: 1201, rank: 5 } },
  { talentId: 1773, tab: 201, row: 6, col: 2, rank: 3, maxRank: 3, spell: 63506, name: "Improved Flash Heal" },
  { talentId: 2235, tab: 201, row: 7, col: 0, rank: 2, maxRank: 2, spell: 57472, name: "Renewed Hope" },
  { talentId: 1896, tab: 201, row: 7, col: 1, rank: 3, maxRank: 3, spell: 47537, name: "Rapture" },
  { talentId: 1894, tab: 201, row: 7, col: 2, rank: 2, maxRank: 2, spell: 47508, name: "Aspiration" },
  { talentId: 1895, tab: 201, row: 8, col: 0, rank: 3, maxRank: 3, spell: 47515, name: "Divine Aegis" },
  { talentId: 1774, tab: 201, row: 8, col: 1, rank: 1, maxRank: 1, spell: 33206, name: "Pain Suppression" },
  { talentId: 1901, tab: 201, row: 8, col: 2, rank: 2, maxRank: 2, spell: 47517, name: "Grace" },
  { talentId: 1202, tab: 201, row: 9, col: 1, rank: 5, maxRank: 5, spell: 52800, name: "Borrowed Time" },
  { talentId: 1897, tab: 201, row: 10, col: 1, rank: 1, maxRank: 1, spell: 47540, name: "Penance" },
  { talentId: 406, tab: 202, row: 0, col: 1, rank: 3, maxRank: 3, spell: 17191, name: "Improved Renew" },
  { talentId: 401, tab: 202, row: 0, col: 2, rank: 5, maxRank: 5, spell: 15011, name: "Holy Specialization" },
  { talentId: 1181, tab: 202, row: 1, col: 2, rank: 5, maxRank: 5, spell: 18535, name: "Divine Fury" },
  { talentId: 442, tab: 202, row: 2, col: 0, rank: 1, maxRank: 1, spell: 19236, name: "Desperate Prayer" },
];

// holypaladin: 17 pieces, average item level 200.0, defense rating 0
const HOLYPALADIN_GEAR: readonly RaidGearLine[] = [
  { item: 47172, name: "Helm of the Bested Gallant", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 200, req: 80, classes: 262143 },
  { item: 40681, name: "Lattice Choker of Light", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: 32767 },
  { item: 39631, name: "Heroes' Redemption Spaulders", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 200, req: 80, classes: 2 },
  { item: 39188, name: "Chivalric Chestguard", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 200, req: 80, classes: 1535 },
  { item: 40691, name: "Magroth's Meditative Cincture", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 200, req: 80, classes: 1535 },
  { item: 39630, name: "Heroes' Redemption Greaves", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 200, req: 80, classes: 2 },
  { item: 47199, name: "Greaves of the Grand Paladin", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 200, req: 80, classes: 1535 },
  { item: 37240, name: "Flamebeard's Bracers", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 200, req: 80, classes: -1 },
  { item: 45182, name: "Gauntlets of Shattered Pride", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 200, req: 80, classes: -1 },
  { item: 47200, name: "Signet of Purity", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 43408, name: "Solitaire of Reflecting Beams", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 42988, name: "Darkmoon Card: Illusion", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 44255, name: "Darkmoon Card: Greatness", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 39415, name: "Shroud of the Citadel", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: 32767 },
  { item: 45129, name: "Gnomeregan Bonechopper", slot: SLOT.mainHand, itemClass: 2, subclass: 7, inv: 21, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 44313, name: "Zom's Crackling Bulwark", slot: SLOT.offHand, itemClass: 4, subclass: 6, inv: 14, ilvl: 200, req: 80, classes: -1 },
  { item: 40705, name: "Libram of Renewal", slot: SLOT.ranged, itemClass: 4, subclass: 7, inv: 28, ilvl: 200, req: 80, classes: 2 },
];
const HOLYPALADIN_TALENTS: readonly TalentPick[] = [
  { talentId: 1432, tab: 382, row: 0, col: 1, rank: 5, maxRank: 5, spell: 20208, name: "Spiritual Focus" },
  { talentId: 1444, tab: 382, row: 1, col: 0, rank: 3, maxRank: 3, spell: 20239, name: "Healing Light" },
  { talentId: 1449, tab: 382, row: 1, col: 1, rank: 5, maxRank: 5, spell: 20261, name: "Divine Intellect" },
  { talentId: 1435, tab: 382, row: 2, col: 0, rank: 1, maxRank: 1, spell: 31821, name: "Aura Mastery" },
  { talentId: 1461, tab: 382, row: 2, col: 1, rank: 5, maxRank: 5, spell: 20215, name: "Illumination" },
  { talentId: 1443, tab: 382, row: 2, col: 2, rank: 2, maxRank: 2, spell: 20235, name: "Improved Lay on Hands" },
  { talentId: 1450, tab: 382, row: 3, col: 0, rank: 1, maxRank: 3, spell: 20254, name: "Improved Concentration Aura" },
  { talentId: 1433, tab: 382, row: 4, col: 1, rank: 1, maxRank: 1, spell: 20216, name: "Divine Favor", dependsOn: { talentId: 1461, rank: 5 } },
  { talentId: 1465, tab: 382, row: 4, col: 2, rank: 3, maxRank: 3, spell: 20361, name: "Sanctified Light" },
  { talentId: 1627, tab: 382, row: 5, col: 2, rank: 5, maxRank: 5, spell: 25829, name: "Holy Power" },
  { talentId: 1745, tab: 382, row: 6, col: 0, rank: 3, maxRank: 3, spell: 31836, name: "Light's Grace" },
  { talentId: 1502, tab: 382, row: 6, col: 1, rank: 1, maxRank: 1, spell: 20473, name: "Holy Shock", dependsOn: { talentId: 1433, rank: 1 } },
  { talentId: 1746, tab: 382, row: 7, col: 2, rank: 5, maxRank: 5, spell: 31841, name: "Holy Guidance" },
  { talentId: 1747, tab: 382, row: 8, col: 0, rank: 1, maxRank: 1, spell: 31842, name: "Divine Illumination" },
  { talentId: 2199, tab: 382, row: 8, col: 2, rank: 5, maxRank: 5, spell: 54155, name: "Judgements of the Pure" },
  { talentId: 2193, tab: 382, row: 9, col: 1, rank: 2, maxRank: 2, spell: 53576, name: "Infusion of Light", dependsOn: { talentId: 1502, rank: 1 } },
  { talentId: 2191, tab: 382, row: 9, col: 2, rank: 2, maxRank: 2, spell: 53557, name: "Enlightened Judgements" },
  { talentId: 2192, tab: 382, row: 10, col: 1, rank: 1, maxRank: 1, spell: 53563, name: "Beacon of Light" },
  { talentId: 1442, tab: 383, row: 0, col: 1, rank: 5, maxRank: 5, spell: 63650, name: "Divinity" },
  { talentId: 1748, tab: 383, row: 1, col: 0, rank: 3, maxRank: 3, spell: 53519, name: "Stoicism" },
  { talentId: 1425, tab: 383, row: 1, col: 1, rank: 2, maxRank: 2, spell: 20175, name: "Guardian's Favor" },
  { talentId: 2280, tab: 383, row: 2, col: 0, rank: 1, maxRank: 1, spell: 64205, name: "Divine Sacrifice" },
  { talentId: 1423, tab: 383, row: 2, col: 2, rank: 4, maxRank: 5, spell: 20146, name: "Toughness" },
  { talentId: 2281, tab: 383, row: 3, col: 0, rank: 2, maxRank: 2, spell: 53530, name: "Divine Guardian", dependsOn: { talentId: 2280, rank: 1 } },
  { talentId: 1422, tab: 383, row: 3, col: 2, rank: 3, maxRank: 3, spell: 20140, name: "Improved Devotion Aura" },
];

// arcanemage: 16 pieces, average item level 199.2, defense rating 0
const ARCANEMAGE_GEAR: readonly RaidGearLine[] = [
  { item: 44408, name: "Cowl of the Vindictive Captain", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 187, req: 0, classes: -1 },
  { item: 45155, name: "Choker of Spiral Focus", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: -1 },
  { item: 47226, name: "Mantle of Inconsolable Fear", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 200, req: 80, classes: 262143 },
  { item: 43401, name: "Water-Drenched Robe", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 200, req: 80, classes: -1 },
  { item: 47181, name: "Belt of the Churning Blaze", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 200, req: 80, classes: 32767 },
  { item: 47185, name: "Leggings of the Haggard Apprentice", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 200, req: 80, classes: -1 },
  { item: 37730, name: "Cleric's Linen Shoes", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 200, req: 80, classes: -1 },
  { item: 47173, name: "Bindings of the Wicked", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 200, req: 80, classes: -1 },
  { item: 47230, name: "Handwraps of Surrendered Hope", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 200, req: 80, classes: -1 },
  { item: 47200, name: "Signet of Purity", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 43408, name: "Solitaire of Reflecting Beams", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 42988, name: "Darkmoon Card: Illusion", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 39229, name: "Embrace of the Spider", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: 262143, unique: true },
  { item: 43283, name: "Subterranean Waterfall Shroud", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1 },
  { item: 39256, name: "Sulfur Stave", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 200, req: 80, classes: -1 },
  { item: 37177, name: "Wand of the San'layn", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 200, req: 80, classes: -1 },
];
const ARCANEMAGE_TALENTS: readonly TalentPick[] = [
  { talentId: 74, tab: 81, row: 0, col: 0, rank: 2, maxRank: 2, spell: 12592, name: "Arcane Subtlety" },
  { talentId: 76, tab: 81, row: 0, col: 1, rank: 3, maxRank: 3, spell: 12840, name: "Arcane Focus" },
  { talentId: 85, tab: 81, row: 1, col: 0, rank: 1, maxRank: 3, spell: 28574, name: "Arcane Fortitude" },
  { talentId: 75, tab: 81, row: 1, col: 2, rank: 5, maxRank: 5, spell: 12577, name: "Arcane Concentration" },
  { talentId: 81, tab: 81, row: 2, col: 1, rank: 3, maxRank: 3, spell: 12469, name: "Spell Impact" },
  { talentId: 1845, tab: 81, row: 2, col: 2, rank: 3, maxRank: 3, spell: 44399, name: "Student of the Mind" },
  { talentId: 2211, tab: 81, row: 2, col: 3, rank: 1, maxRank: 1, spell: 54646, name: "Focus Magic" },
  { talentId: 1142, tab: 81, row: 3, col: 2, rank: 3, maxRank: 3, spell: 18464, name: "Arcane Meditation" },
  { talentId: 2222, tab: 81, row: 3, col: 3, rank: 3, maxRank: 3, spell: 55340, name: "Torment the Weak" },
  { talentId: 86, tab: 81, row: 4, col: 1, rank: 1, maxRank: 1, spell: 12043, name: "Presence of Mind" },
  { talentId: 77, tab: 81, row: 4, col: 3, rank: 5, maxRank: 5, spell: 12503, name: "Arcane Mind" },
  { talentId: 421, tab: 81, row: 5, col: 1, rank: 3, maxRank: 3, spell: 15060, name: "Arcane Instability", dependsOn: { talentId: 86, rank: 1 } },
  { talentId: 1725, tab: 81, row: 5, col: 2, rank: 2, maxRank: 2, spell: 31572, name: "Arcane Potency", dependsOn: { talentId: 86, rank: 1 } },
  { talentId: 1727, tab: 81, row: 6, col: 0, rank: 3, maxRank: 3, spell: 31583, name: "Arcane Empowerment" },
  { talentId: 87, tab: 81, row: 6, col: 1, rank: 1, maxRank: 1, spell: 12042, name: "Arcane Power", dependsOn: { talentId: 421, rank: 3 } },
  { talentId: 1843, tab: 81, row: 7, col: 1, rank: 2, maxRank: 2, spell: 44379, name: "Arcane Flows", dependsOn: { talentId: 87, rank: 1 } },
  { talentId: 1728, tab: 81, row: 7, col: 2, rank: 5, maxRank: 5, spell: 31588, name: "Mind Mastery" },
  { talentId: 2209, tab: 81, row: 8, col: 2, rank: 5, maxRank: 5, spell: 54490, name: "Missile Barrage" },
  { talentId: 1846, tab: 81, row: 9, col: 1, rank: 3, maxRank: 3, spell: 44403, name: "Netherwind Presence" },
  { talentId: 1826, tab: 81, row: 9, col: 2, rank: 2, maxRank: 2, spell: 35581, name: "Spell Power" },
  { talentId: 1847, tab: 81, row: 10, col: 1, rank: 1, maxRank: 1, spell: 44425, name: "Arcane Barrage" },
  { talentId: 1141, tab: 41, row: 0, col: 1, rank: 3, maxRank: 3, spell: 54734, name: "Incineration" },
  { talentId: 38, tab: 61, row: 0, col: 0, rank: 2, maxRank: 3, spell: 12496, name: "Frostbite" },
  { talentId: 62, tab: 61, row: 0, col: 2, rank: 3, maxRank: 3, spell: 55094, name: "Ice Floes" },
  { talentId: 1649, tab: 61, row: 1, col: 2, rank: 3, maxRank: 3, spell: 29440, name: "Precision" },
  { talentId: 65, tab: 61, row: 1, col: 3, rank: 2, maxRank: 3, spell: 12569, name: "Permafrost" },
  { talentId: 69, tab: 61, row: 2, col: 1, rank: 1, maxRank: 1, spell: 12472, name: "Icy Veins" },
];

// frostmage: 16 pieces, average item level 199.2, defense rating 0
const FROSTMAGE_GEAR: readonly RaidGearLine[] = [
  { item: 44408, name: "Cowl of the Vindictive Captain", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 187, req: 0, classes: -1 },
  { item: 45155, name: "Choker of Spiral Focus", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: -1 },
  { item: 47226, name: "Mantle of Inconsolable Fear", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 200, req: 80, classes: 262143 },
  { item: 43401, name: "Water-Drenched Robe", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 200, req: 80, classes: -1 },
  { item: 47181, name: "Belt of the Churning Blaze", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 200, req: 80, classes: 32767 },
  { item: 47185, name: "Leggings of the Haggard Apprentice", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 200, req: 80, classes: -1 },
  { item: 37730, name: "Cleric's Linen Shoes", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 200, req: 80, classes: -1 },
  { item: 47173, name: "Bindings of the Wicked", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 200, req: 80, classes: -1 },
  { item: 47230, name: "Handwraps of Surrendered Hope", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 200, req: 80, classes: -1 },
  { item: 47200, name: "Signet of Purity", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 43408, name: "Solitaire of Reflecting Beams", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 42988, name: "Darkmoon Card: Illusion", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 39229, name: "Embrace of the Spider", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: 262143, unique: true },
  { item: 43283, name: "Subterranean Waterfall Shroud", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1 },
  { item: 39256, name: "Sulfur Stave", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 200, req: 80, classes: -1 },
  { item: 37177, name: "Wand of the San'layn", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 200, req: 80, classes: -1 },
];
const FROSTMAGE_TALENTS: readonly TalentPick[] = [
  { talentId: 74, tab: 81, row: 0, col: 0, rank: 2, maxRank: 2, spell: 12592, name: "Arcane Subtlety" },
  { talentId: 76, tab: 81, row: 0, col: 1, rank: 3, maxRank: 3, spell: 12840, name: "Arcane Focus" },
  { talentId: 75, tab: 81, row: 1, col: 2, rank: 5, maxRank: 5, spell: 12577, name: "Arcane Concentration" },
  { talentId: 81, tab: 81, row: 2, col: 1, rank: 3, maxRank: 3, spell: 12469, name: "Spell Impact" },
  { talentId: 1845, tab: 81, row: 2, col: 2, rank: 3, maxRank: 3, spell: 44399, name: "Student of the Mind" },
  { talentId: 2211, tab: 81, row: 2, col: 3, rank: 1, maxRank: 1, spell: 54646, name: "Focus Magic" },
  { talentId: 1142, tab: 81, row: 3, col: 2, rank: 1, maxRank: 3, spell: 18462, name: "Arcane Meditation" },
  { talentId: 37, tab: 61, row: 0, col: 1, rank: 5, maxRank: 5, spell: 16766, name: "Improved Frostbolt" },
  { talentId: 62, tab: 61, row: 0, col: 2, rank: 3, maxRank: 3, spell: 55094, name: "Ice Floes" },
  { talentId: 73, tab: 61, row: 1, col: 0, rank: 3, maxRank: 3, spell: 15047, name: "Ice Shards" },
  { talentId: 1649, tab: 61, row: 1, col: 2, rank: 3, maxRank: 3, spell: 29440, name: "Precision" },
  { talentId: 61, tab: 61, row: 2, col: 0, rank: 3, maxRank: 3, spell: 12953, name: "Piercing Ice" },
  { talentId: 69, tab: 61, row: 2, col: 1, rank: 1, maxRank: 1, spell: 12472, name: "Icy Veins" },
  { talentId: 66, tab: 61, row: 3, col: 1, rank: 3, maxRank: 3, spell: 12519, name: "Frost Channeling" },
  { talentId: 67, tab: 61, row: 3, col: 2, rank: 3, maxRank: 3, spell: 12983, name: "Shatter" },
  { talentId: 72, tab: 61, row: 4, col: 1, rank: 1, maxRank: 1, spell: 11958, name: "Cold Snap" },
  { talentId: 1737, tab: 61, row: 5, col: 0, rank: 2, maxRank: 2, spell: 55092, name: "Cold as Ice", dependsOn: { talentId: 72, rank: 1 } },
  { talentId: 68, tab: 61, row: 5, col: 2, rank: 3, maxRank: 3, spell: 28593, name: "Winter's Chill" },
  { talentId: 71, tab: 61, row: 6, col: 1, rank: 1, maxRank: 1, spell: 11426, name: "Ice Barrier", dependsOn: { talentId: 72, rank: 1 } },
  { talentId: 1738, tab: 61, row: 6, col: 2, rank: 5, maxRank: 5, spell: 31678, name: "Arctic Winds" },
  { talentId: 1740, tab: 61, row: 7, col: 1, rank: 2, maxRank: 2, spell: 31683, name: "Empowered Frostbolt" },
  { talentId: 1853, tab: 61, row: 7, col: 2, rank: 2, maxRank: 2, spell: 44545, name: "Fingers of Frost" },
  { talentId: 1854, tab: 61, row: 8, col: 0, rank: 3, maxRank: 3, spell: 44549, name: "Brain Freeze" },
  { talentId: 1741, tab: 61, row: 8, col: 1, rank: 1, maxRank: 1, spell: 31687, name: "Summon Water Elemental" },
  { talentId: 1855, tab: 61, row: 8, col: 2, rank: 3, maxRank: 3, spell: 44561, name: "Enduring Winter", dependsOn: { talentId: 1741, rank: 1 } },
  { talentId: 1856, tab: 61, row: 9, col: 1, rank: 5, maxRank: 5, spell: 44571, name: "Chilled to the Bone" },
  { talentId: 1857, tab: 61, row: 10, col: 1, rank: 1, maxRank: 1, spell: 44572, name: "Deep Freeze" },
];

// combatrogue: 17 pieces, average item level 199.2, defense rating 0
const COMBATROGUE_GEAR: readonly RaidGearLine[] = [
  { item: 44409, name: "Headguard of Retaliation", slot: SLOT.head, itemClass: 4, subclass: 2, inv: 1, ilvl: 187, req: 0, classes: -1 },
  { item: 40678, name: "Pendant of the Outcast Hero", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: -1 },
  { item: 47221, name: "Shoulderpads of the Infamous Knave", slot: SLOT.shoulders, itemClass: 4, subclass: 2, inv: 3, ilvl: 200, req: 80, classes: 1535 },
  { item: 43990, name: "Blade-Scarred Tunic", slot: SLOT.chest, itemClass: 4, subclass: 2, inv: 5, ilvl: 200, req: 80, classes: 262143 },
  { item: 47170, name: "Belt of Fierce Competition", slot: SLOT.waist, itemClass: 4, subclass: 2, inv: 6, ilvl: 200, req: 80, classes: -1 },
  { item: 47202, name: "Leggings of Brazen Trespass", slot: SLOT.legs, itemClass: 4, subclass: 2, inv: 7, ilvl: 200, req: 80, classes: -1 },
  { item: 39196, name: "Boots of the Worshiper", slot: SLOT.feet, itemClass: 4, subclass: 2, inv: 8, ilvl: 200, req: 80, classes: 32767 },
  { item: 37366, name: "Drake-Champion's Bracers", slot: SLOT.wrists, itemClass: 4, subclass: 2, inv: 9, ilvl: 200, req: 80, classes: -1 },
  { item: 39560, name: "Heroes' Bonescythe Gauntlets", slot: SLOT.hands, itemClass: 4, subclass: 2, inv: 10, ilvl: 200, req: 80, classes: 8 },
  { item: 47222, name: "Uruka's Band of Zeal", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 44308, name: "Signet of Edward the Odd", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 44253, name: "Darkmoon Card: Greatness", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 37723, name: "Incisor Fragment", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 43406, name: "Cloak of the Gushing Wound", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1 },
  { item: 49120, name: "Direbrew's Bloody Shanker", slot: SLOT.mainHand, itemClass: 2, subclass: 15, inv: 13, ilvl: 200, req: 80, classes: -1 },
  { item: 49120, name: "Direbrew's Bloody Shanker", slot: SLOT.offHand, itemClass: 2, subclass: 15, inv: 13, ilvl: 200, req: 80, classes: -1 },
  { item: 43612, name: "Spineslicer", slot: SLOT.ranged, itemClass: 2, subclass: 16, inv: 25, ilvl: 200, req: 80, classes: -1 },
];
const COMBATROGUE_TALENTS: readonly TalentPick[] = [
  { talentId: 270, tab: 182, row: 0, col: 2, rank: 5, maxRank: 5, spell: 14142, name: "Malice" },
  { talentId: 273, tab: 182, row: 1, col: 0, rank: 3, maxRank: 3, spell: 14161, name: "Ruthlessness" },
  { talentId: 277, tab: 182, row: 1, col: 3, rank: 2, maxRank: 3, spell: 13865, name: "Puncturing Wounds" },
  { talentId: 269, tab: 182, row: 2, col: 2, rank: 5, maxRank: 5, spell: 14137, name: "Lethality", dependsOn: { talentId: 270, rank: 5 } },
  { talentId: 201, tab: 181, row: 0, col: 1, rank: 2, maxRank: 2, spell: 13863, name: "Improved Sinister Strike" },
  { talentId: 221, tab: 181, row: 0, col: 2, rank: 5, maxRank: 5, spell: 13852, name: "Dual Wield Specialization" },
  { talentId: 1827, tab: 181, row: 1, col: 0, rank: 2, maxRank: 2, spell: 14166, name: "Improved Slice and Dice" },
  { talentId: 181, tab: 181, row: 1, col: 3, rank: 5, maxRank: 5, spell: 13845, name: "Precision" },
  { talentId: 204, tab: 181, row: 2, col: 0, rank: 2, maxRank: 2, spell: 13872, name: "Endurance" },
  { talentId: 182, tab: 181, row: 2, col: 2, rank: 5, maxRank: 5, spell: 13807, name: "Close Quarters Combat", dependsOn: { talentId: 221, rank: 5 } },
  { talentId: 186, tab: 181, row: 3, col: 2, rank: 3, maxRank: 3, spell: 13789, name: "Lightning Reflexes" },
  { talentId: 1122, tab: 181, row: 3, col: 3, rank: 5, maxRank: 5, spell: 61331, name: "Aggression" },
  { talentId: 223, tab: 181, row: 4, col: 1, rank: 1, maxRank: 1, spell: 13877, name: "Blade Flurry" },
  { talentId: 1703, tab: 181, row: 5, col: 1, rank: 2, maxRank: 2, spell: 30920, name: "Weapon Expertise", dependsOn: { talentId: 223, rank: 1 } },
  { talentId: 1706, tab: 181, row: 5, col: 2, rank: 1, maxRank: 2, spell: 31124, name: "Blade Twisting" },
  { talentId: 1705, tab: 181, row: 6, col: 0, rank: 3, maxRank: 3, spell: 61329, name: "Vitality" },
  { talentId: 205, tab: 181, row: 6, col: 1, rank: 1, maxRank: 1, spell: 13750, name: "Adrenaline Rush" },
  { talentId: 1825, tab: 181, row: 7, col: 2, rank: 5, maxRank: 5, spell: 35553, name: "Combat Potency" },
  { talentId: 1709, tab: 181, row: 8, col: 1, rank: 1, maxRank: 1, spell: 32601, name: "Surprise Attacks", dependsOn: { talentId: 205, rank: 1 } },
  { talentId: 2074, tab: 181, row: 8, col: 2, rank: 2, maxRank: 2, spell: 58413, name: "Savage Combat" },
  { talentId: 2075, tab: 181, row: 9, col: 1, rank: 5, maxRank: 5, spell: 51689, name: "Prey on the Weak" },
  { talentId: 2076, tab: 181, row: 10, col: 1, rank: 1, maxRank: 1, spell: 51690, name: "Killing Spree" },
  { talentId: 2244, tab: 183, row: 0, col: 0, rank: 5, maxRank: 5, spell: 58425, name: "Relentless Strikes" },
];

// retpaladin: 16 pieces, average item level 200.0, defense rating 0
const RETPALADIN_GEAR: readonly RaidGearLine[] = [
  { item: 37849, name: "Planetary Helm", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 200, req: 80, classes: 32767 },
  { item: 40678, name: "Pendant of the Outcast Hero", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: -1 },
  { item: 39637, name: "Heroes' Redemption Shoulderplates", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 200, req: 80, classes: 2 },
  { item: 37722, name: "Breastplate of Undeath", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 200, req: 80, classes: -1 },
  { item: 39345, name: "Girdle of the Ascended Phantom", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 200, req: 80, classes: -1 },
  { item: 37263, name: "Legplates of the Oculus Guardian", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 200, req: 80, classes: -1 },
  { item: 39139, name: "Ravaging Sabatons", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 200, req: 80, classes: 1535 },
  { item: 39195, name: "Bracers of Lost Sentiments", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 200, req: 80, classes: 1535 },
  { item: 37363, name: "Gauntlets of Dragon Wrath", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 200, req: 80, classes: -1 },
  { item: 47222, name: "Uruka's Band of Zeal", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 39401, name: "Circle of Death", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 42987, name: "Darkmoon Card: Greatness", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 37723, name: "Incisor Fragment", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 47232, name: "Drape of the Undefeated", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1 },
  { item: 45074, name: "Claymore of the Prophet", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 8, inv: 17, ilvl: 200, req: 80, classes: -1 },
  { item: 40706, name: "Libram of Reciprocation", slot: SLOT.ranged, itemClass: 4, subclass: 7, inv: 28, ilvl: 200, req: 80, classes: 2 },
];
const RETPALADIN_TALENTS: readonly TalentPick[] = [
  { talentId: 1463, tab: 382, row: 0, col: 2, rank: 5, maxRank: 5, spell: 20332, name: "Seals of the Pure" },
  { talentId: 2185, tab: 383, row: 0, col: 2, rank: 5, maxRank: 5, spell: 20266, name: "Divine Strength" },
  { talentId: 1403, tab: 381, row: 0, col: 1, rank: 2, maxRank: 5, spell: 20061, name: "Deflection" },
  { talentId: 1407, tab: 381, row: 0, col: 2, rank: 5, maxRank: 5, spell: 20105, name: "Benediction" },
  { talentId: 1631, tab: 381, row: 1, col: 0, rank: 2, maxRank: 2, spell: 25957, name: "Improved Judgements" },
  { talentId: 1464, tab: 381, row: 1, col: 1, rank: 3, maxRank: 3, spell: 20337, name: "Heart of the Crusader" },
  { talentId: 1401, tab: 381, row: 1, col: 2, rank: 2, maxRank: 2, spell: 20045, name: "Improved Blessing of Might" },
  { talentId: 1633, tab: 381, row: 2, col: 0, rank: 2, maxRank: 2, spell: 26016, name: "Vindication" },
  { talentId: 1411, tab: 381, row: 2, col: 1, rank: 5, maxRank: 5, spell: 20121, name: "Conviction" },
  { talentId: 1481, tab: 381, row: 2, col: 2, rank: 1, maxRank: 1, spell: 20375, name: "Seal of Command" },
  { talentId: 1634, tab: 381, row: 2, col: 3, rank: 2, maxRank: 2, spell: 26023, name: "Pursuit of Justice" },
  { talentId: 1761, tab: 381, row: 3, col: 2, rank: 3, maxRank: 3, spell: 35397, name: "Sanctity of Battle" },
  { talentId: 1755, tab: 381, row: 3, col: 3, rank: 3, maxRank: 3, spell: 31868, name: "Crusade" },
  { talentId: 1410, tab: 381, row: 4, col: 0, rank: 3, maxRank: 3, spell: 20113, name: "Two-Handed Weapon Specialization" },
  { talentId: 1756, tab: 381, row: 4, col: 2, rank: 1, maxRank: 1, spell: 31869, name: "Sanctified Retribution" },
  { talentId: 1402, tab: 381, row: 5, col: 1, rank: 3, maxRank: 3, spell: 20057, name: "Vengeance", dependsOn: { talentId: 1411, rank: 5 } },
  { talentId: 1757, tab: 381, row: 5, col: 2, rank: 2, maxRank: 2, spell: 31872, name: "Divine Purpose" },
  { talentId: 2176, tab: 381, row: 6, col: 0, rank: 2, maxRank: 2, spell: 53488, name: "The Art of War" },
  { talentId: 1441, tab: 381, row: 6, col: 1, rank: 1, maxRank: 1, spell: 20066, name: "Repentance" },
  { talentId: 1758, tab: 381, row: 6, col: 2, rank: 3, maxRank: 3, spell: 31878, name: "Judgements of the Wise" },
  { talentId: 1759, tab: 381, row: 7, col: 1, rank: 3, maxRank: 3, spell: 31881, name: "Fanaticism", dependsOn: { talentId: 1441, rank: 1 } },
  { talentId: 2147, tab: 381, row: 7, col: 2, rank: 2, maxRank: 2, spell: 53376, name: "Sanctified Wrath" },
  { talentId: 2148, tab: 381, row: 8, col: 0, rank: 3, maxRank: 3, spell: 53648, name: "Swift Retribution" },
  { talentId: 1823, tab: 381, row: 8, col: 1, rank: 1, maxRank: 1, spell: 35395, name: "Crusader Strike" },
  { talentId: 2179, tab: 381, row: 8, col: 2, rank: 3, maxRank: 3, spell: 53503, name: "Sheath of Light" },
  { talentId: 2149, tab: 381, row: 9, col: 1, rank: 3, maxRank: 3, spell: 53382, name: "Righteous Vengeance" },
  { talentId: 2150, tab: 381, row: 10, col: 1, rank: 1, maxRank: 1, spell: 53385, name: "Divine Storm" },
];

// shadowpriest: 16 pieces, average item level 199.2, defense rating 0
const SHADOWPRIEST_GEAR: readonly RaidGearLine[] = [
  { item: 44408, name: "Cowl of the Vindictive Captain", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 187, req: 0, classes: -1 },
  { item: 40680, name: "Encircling Burnished Gold Chains", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 200, req: 80, classes: -1 },
  { item: 47226, name: "Mantle of Inconsolable Fear", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 200, req: 80, classes: 262143 },
  { item: 43401, name: "Water-Drenched Robe", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 200, req: 80, classes: -1 },
  { item: 47181, name: "Belt of the Churning Blaze", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 200, req: 80, classes: 32767 },
  { item: 47185, name: "Leggings of the Haggard Apprentice", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 200, req: 80, classes: -1 },
  { item: 39254, name: "Saltarello Shoes", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 200, req: 80, classes: 262143 },
  { item: 47173, name: "Bindings of the Wicked", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 200, req: 80, classes: -1 },
  { item: 47230, name: "Handwraps of Surrendered Hope", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 200, req: 80, classes: -1 },
  { item: 47200, name: "Signet of Purity", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 43408, name: "Solitaire of Reflecting Beams", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 42988, name: "Darkmoon Card: Illusion", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: -1, unique: true },
  { item: 39229, name: "Embrace of the Spider", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 200, req: 80, classes: 262143, unique: true },
  { item: 43283, name: "Subterranean Waterfall Shroud", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 200, req: 80, classes: -1 },
  { item: 39256, name: "Sulfur Stave", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 200, req: 80, classes: -1 },
  { item: 37177, name: "Wand of the San'layn", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 200, req: 80, classes: -1 },
];
const SHADOWPRIEST_TALENTS: readonly TalentPick[] = [
  { talentId: 1898, tab: 201, row: 0, col: 2, rank: 5, maxRank: 5, spell: 52803, name: "Twin Disciplines" },
  { talentId: 346, tab: 201, row: 1, col: 1, rank: 3, maxRank: 3, spell: 14771, name: "Improved Inner Fire" },
  { talentId: 344, tab: 201, row: 1, col: 2, rank: 2, maxRank: 2, spell: 14767, name: "Improved Power Word: Fortitude" },
  { talentId: 347, tab: 201, row: 2, col: 0, rank: 3, maxRank: 3, spell: 14777, name: "Meditation" },
  { talentId: 465, tab: 203, row: 0, col: 0, rank: 3, maxRank: 3, spell: 15336, name: "Spirit Tap" },
  { talentId: 462, tab: 203, row: 0, col: 2, rank: 5, maxRank: 5, spell: 15310, name: "Darkness" },
  { talentId: 482, tab: 203, row: 1, col: 1, rank: 2, maxRank: 2, spell: 15317, name: "Improved Shadow Word: Pain" },
  { talentId: 463, tab: 203, row: 1, col: 2, rank: 3, maxRank: 3, spell: 15328, name: "Shadow Focus" },
  { talentId: 481, tab: 203, row: 2, col: 1, rank: 5, maxRank: 5, spell: 15316, name: "Improved Mind Blast" },
  { talentId: 501, tab: 203, row: 2, col: 2, rank: 1, maxRank: 1, spell: 15407, name: "Mind Flay" },
  { talentId: 483, tab: 203, row: 3, col: 1, rank: 2, maxRank: 2, spell: 15311, name: "Veiled Shadows" },
  { talentId: 881, tab: 203, row: 3, col: 2, rank: 2, maxRank: 2, spell: 17323, name: "Shadow Reach" },
  { talentId: 461, tab: 203, row: 3, col: 3, rank: 3, maxRank: 3, spell: 15332, name: "Shadow Weaving" },
  { talentId: 484, tab: 203, row: 4, col: 1, rank: 1, maxRank: 1, spell: 15286, name: "Vampiric Embrace" },
  { talentId: 1638, tab: 203, row: 4, col: 2, rank: 2, maxRank: 2, spell: 27840, name: "Improved Vampiric Embrace", dependsOn: { talentId: 484, rank: 1 } },
  { talentId: 1777, tab: 203, row: 4, col: 3, rank: 3, maxRank: 3, spell: 33215, name: "Focused Mind" },
  { talentId: 1781, tab: 203, row: 5, col: 0, rank: 2, maxRank: 2, spell: 33371, name: "Mind Melt" },
  { talentId: 2267, tab: 203, row: 5, col: 2, rank: 3, maxRank: 3, spell: 63627, name: "Improved Devouring Plague" },
  { talentId: 521, tab: 203, row: 6, col: 1, rank: 1, maxRank: 1, spell: 15473, name: "Shadowform", dependsOn: { talentId: 484, rank: 1 } },
  { talentId: 1778, tab: 203, row: 6, col: 2, rank: 5, maxRank: 5, spell: 33225, name: "Shadow Power" },
  { talentId: 1906, tab: 203, row: 7, col: 0, rank: 2, maxRank: 2, spell: 47570, name: "Improved Shadowform", dependsOn: { talentId: 521, rank: 1 } },
  { talentId: 1816, tab: 203, row: 7, col: 2, rank: 3, maxRank: 3, spell: 33193, name: "Misery" },
  { talentId: 1779, tab: 203, row: 8, col: 1, rank: 1, maxRank: 1, spell: 34914, name: "Vampiric Touch", dependsOn: { talentId: 521, rank: 1 } },
  { talentId: 1909, tab: 203, row: 8, col: 2, rank: 3, maxRank: 3, spell: 47582, name: "Pain and Suffering" },
  { talentId: 1907, tab: 203, row: 9, col: 2, rank: 5, maxRank: 5, spell: 51167, name: "Twisted Faith" },
  { talentId: 1910, tab: 203, row: 10, col: 1, rank: 1, maxRank: 1, spell: 47585, name: "Dispersion", dependsOn: { talentId: 1779, rank: 1 } },
];


const raid = (l: Omit<RaidLoadout, "level" | "bags"> & { bags?: readonly StockLine[] }): RaidLoadout => ({ ...l, level: RAID_LEVEL, bags: l.bags ?? BAGS });

/**
 * The ten, by id. `keySpells` are what the staging smoke can look for in the
 * spellbook at 80: the trainer's top rank of the build's own abilities, a
 * talent-taught ability, and one whose higher ranks the trainer teaches only
 * past the talent (Devastate, Avenger's Shield, Holy Shock, Circle of Healing,
 * Penance, Mind Flay, Arcane Barrage, Ice Barrier), so a staging that dropped
 * the wrong rows shows.
 */
export const RAID_LOADOUTS: Readonly<Record<RaidLoadoutId, RaidLoadout>> = {
  protwarrior: raid({
    id: "protwarrior", spec: "protection", partyRole: "tank", race: 1, class: 1, label: "Human Warrior (Protection)", namePrefix: "Tank", trainerId: 1,
    questSpells: WARRIOR_QUEST,
    // Defensive Stance, Taunt, Shield Slam 8, Revenge 9, Devastate 5, Shockwave.
    keySpells: [71, 355, 47488, 57823, 47498, 46968],
    talents: PROTWARRIOR_TALENTS, gear: PROTWARRIOR_GEAR, supplies: TANK_SUPPLIES,
  }),
  protpaladin: raid({
    id: "protpaladin", spec: "protection", partyRole: "tank", race: 3, class: 2, label: "Dwarf Paladin (Protection)", namePrefix: "Tank", trainerId: 3,
    questSpells: PALADIN_QUEST, trainerLearns: PALADIN_LEARNS, trainerExclude: PALADIN_EXCLUDE,
    // Righteous Fury, Avenger's Shield 5, Holy Shield 6, Consecration 8, Hammer of the Righteous, Redemption 7.
    keySpells: [25780, 48827, 48952, 48819, 53595, 48950],
    talents: PROTPALADIN_TALENTS, gear: PROTPALADIN_GEAR, supplies: PALADIN_TANK_SUPPLIES,
  }),
  holypriest: raid({
    id: "holypriest", spec: "holy", partyRole: "healer", race: 3, class: 5, label: "Dwarf Priest (Holy)", namePrefix: "Heal", trainerId: 11,
    questSpells: [],
    // Greater Heal 9, Renew 14, Circle of Healing 7, Prayer of Mending 3, Guardian Spirit, Resurrection 7.
    keySpells: [48063, 48068, 48089, 48113, 47788, 48171],
    talents: HOLYPRIEST_TALENTS, gear: HOLYPRIEST_GEAR, supplies: PRIEST_SUPPLIES,
  }),
  discpriest: raid({
    id: "discpriest", spec: "discipline", partyRole: "healer", race: 3, class: 5, label: "Dwarf Priest (Discipline)", namePrefix: "Heal", trainerId: 11,
    questSpells: [],
    // Power Word: Shield 14, Penance 4, Power Infusion, Pain Suppression, Flash Heal 11, Resurrection 7.
    keySpells: [48066, 53007, 10060, 33206, 48071, 48171],
    talents: DISCPRIEST_TALENTS, gear: DISCPRIEST_GEAR, supplies: PRIEST_SUPPLIES,
  }),
  holypaladin: raid({
    id: "holypaladin", spec: "holy", partyRole: "healer", race: 3, class: 2, label: "Dwarf Paladin (Holy)", namePrefix: "Heal", trainerId: 3,
    questSpells: PALADIN_QUEST, trainerLearns: PALADIN_LEARNS, trainerExclude: PALADIN_EXCLUDE,
    // Holy Light 13, Flash of Light 9, Holy Shock 7, Beacon of Light, Divine Plea, Redemption 7.
    keySpells: [48782, 48785, 48825, 53563, 54428, 48950],
    talents: HOLYPALADIN_TALENTS, gear: HOLYPALADIN_GEAR, supplies: [ROCKFIN, TEA, HEALING, MANA, FROST_WYRM, SYMBOL_OF_KINGS],
  }),
  arcanemage: raid({
    id: "arcanemage", spec: "arcane", partyRole: "damage", race: 1, class: 8, label: "Human Mage (Arcane)", namePrefix: "Mage", trainerId: 16,
    questSpells: [],
    // Arcane Blast 4, Arcane Missiles 13, Arcane Barrage 3, Arcane Power, Arcane Brilliance 3, Mage Armor 6.
    keySpells: [42897, 42846, 44781, 12042, 43002, 43024],
    talents: ARCANEMAGE_TALENTS, gear: ARCANEMAGE_GEAR, supplies: MAGE_SUPPLIES,
  }),
  frostmage: raid({
    id: "frostmage", spec: "frost", partyRole: "damage", race: 1, class: 8, label: "Human Mage (Frost)", namePrefix: "Mage", trainerId: 16,
    questSpells: [],
    // Frostbolt 16, Ice Lance 3, Ice Barrier 8, Summon Water Elemental, Deep Freeze, Arcane Brilliance 3.
    keySpells: [42842, 42914, 43039, 31687, 44572, 43002],
    talents: FROSTMAGE_TALENTS, gear: FROSTMAGE_GEAR, supplies: MAGE_SUPPLIES,
  }),
  combatrogue: raid({
    id: "combatrogue", spec: "combat", partyRole: "damage", race: 1, class: 4, label: "Human Rogue (Combat)", namePrefix: "Rogue", trainerId: 9,
    questSpells: [{ spell: 2842, name: "Poisons" }],
    // Sinister Strike 12, Eviscerate 12, Rupture 9, Blade Flurry, Adrenaline Rush, Killing Spree.
    keySpells: [48638, 48668, 48672, 13877, 13750, 51690],
    talents: COMBATROGUE_TALENTS, gear: COMBATROGUE_GEAR, supplies: [ROCKFIN, HEALING, ENDLESS_RAGE, INSTANT_POISON, DEADLY_POISON],
  }),
  retpaladin: raid({
    id: "retpaladin", spec: "retribution", partyRole: "damage", race: 3, class: 2, label: "Dwarf Paladin (Retribution)", namePrefix: "Pala", trainerId: 3,
    questSpells: PALADIN_QUEST, trainerLearns: PALADIN_LEARNS, trainerExclude: PALADIN_EXCLUDE,
    // Seal of Vengeance, Crusader Strike, Divine Storm, Exorcism 9, Hammer of Wrath 6, Blessing of Might 10.
    keySpells: [31801, 35395, 53385, 48801, 48806, 48932],
    talents: RETPALADIN_TALENTS, gear: RETPALADIN_GEAR, supplies: [ROCKFIN, TEA, HEALING, MANA, ENDLESS_RAGE, SYMBOL_OF_KINGS],
  }),
  shadowpriest: raid({
    id: "shadowpriest", spec: "shadow", partyRole: "damage", race: 3, class: 5, label: "Dwarf Priest (Shadow)", namePrefix: "Priest", trainerId: 11,
    questSpells: [],
    // Mind Blast 13, Mind Flay 9, Vampiric Touch 5, Shadowform, Shadow Word: Pain 12, Devouring Plague 9.
    keySpells: [48127, 48156, 48160, 15473, 48125, 48300],
    talents: SHADOWPRIEST_TALENTS, gear: SHADOWPRIEST_GEAR, supplies: PRIEST_SUPPLIES,
  }),
};

/** The raid loadout for a class and tree, or undefined. */
export function raidLoadoutOf(cls: number, spec: string): RaidLoadout | undefined {
  return Object.values(RAID_LOADOUTS).find((l) => l.class === cls && l.spec === spec);
}

/** Whether a loadout is one of the raid's (it carries its one level). */
export function isRaidLoadout(l: Loadout): l is RaidLoadout {
  return l.level === RAID_LEVEL && l.spec !== undefined;
}

/**
 * What a class can wear and wield at 80 with the skills its race and class
 * start with (`playercreateinfo_skills`) and Plate Mail from the trainer at
 * 40: armor subclasses (0, jewellery and held items, for everyone) and
 * weapon subclasses, as `item_template` numbers them.
 */
export const PROFICIENCY: Readonly<Record<number, { armor: readonly number[]; weapons: readonly number[]; dualWield: boolean }>> = {
  // Warrior (Human): cloth to plate, shields; axes, maces, swords one- and two-handed, daggers, thrown.
  1: { armor: [0, 1, 2, 3, 4, 6], weapons: [0, 1, 4, 5, 7, 8, 15, 16], dualWield: false },
  // Paladin (Dwarf): cloth to plate, shields, librams; maces and swords one- and two-handed.
  2: { armor: [0, 1, 2, 3, 4, 6, 7], weapons: [4, 5, 7, 8], dualWield: false },
  // Rogue (Human): cloth, leather; daggers, thrown; Dual Wield from creation.
  4: { armor: [0, 1, 2], weapons: [15, 16], dualWield: true },
  // Priest (Dwarf): cloth; maces, staves, wands.
  5: { armor: [0, 1], weapons: [4, 10, 19], dualWield: false },
  // Mage (Human): cloth; staves, wands.
  8: { armor: [0, 1], weapons: [10, 19], dualWield: false },
};

/** The InventoryTypes each equipment slot takes. */
const SLOT_TAKES: Readonly<Record<number, readonly number[]>> = {
  [SLOT.head]: [1],
  [SLOT.neck]: [2],
  [SLOT.shoulders]: [3],
  [SLOT.chest]: [5, 20],
  [SLOT.waist]: [6],
  [SLOT.legs]: [7],
  [SLOT.feet]: [8],
  [SLOT.wrists]: [9],
  [SLOT.hands]: [10],
  [SLOT.finger1]: [11],
  [SLOT.finger2]: [11],
  [SLOT.trinket1]: [12],
  [SLOT.trinket2]: [12],
  [SLOT.back]: [16],
  // One-hand, two-hand, main hand.
  [SLOT.mainHand]: [13, 17, 21],
  // One-hand (dual wield), shield, off hand, held in off hand.
  [SLOT.offHand]: [13, 14, 22, 23],
  // Bow, thrown, wand, relic.
  [SLOT.ranged]: [15, 25, 26, 28],
};

/** Defense rating per point of defense skill at 80 (gtCombatRatings, CR_DEFENSE_SKILL). */
export const DEFENSE_RATING_PER_SKILL = 4.918498;
/** The defense skill a level-83 boss cannot crit through: 400 at 80 plus 140. */
export const DEFENSE_CAP = 540;

/** The defense skill a raid set gives at 80: the 400 base and the rating's points. */
export function defenseSkill(l: RaidLoadout): number {
  const rating = l.gear.reduce((n, g) => n + (g.defense ?? 0), 0);
  return 400 + Math.floor(rating / DEFENSE_RATING_PER_SKILL);
}

/** Every equipment slot a raid member fills: all but the shirt and tabard, the off hand empty under a two-hander. */
export function raidSlots(l: RaidLoadout): number[] {
  const twoHand = l.gear.some((g) => g.twoHand);
  return Object.values(SLOT).filter((s) => !(twoHand && s === SLOT.offHand));
}

/**
 * Why a raid set would not be worn as staged, or nothing: every piece wearable
 * by its class at 80 (level, class mask, proficiency, the slot's inventory
 * type, a one-hander in the off hand only with Dual Wield), every slot filled,
 * no unique piece twice, the two-hander in the main hand alone.
 */
export function raidGearProblems(l: RaidLoadout): string[] {
  const out: string[] = [];
  const prof = PROFICIENCY[l.class];
  if (!prof) return [`${l.id}: no proficiency table for class ${l.class}`];
  for (const g of l.gear) {
    const what = `${l.id}: ${g.name} (${g.item})`;
    if (g.req > RAID_LEVEL) out.push(`${what} needs level ${g.req}`);
    if (g.classes !== -1 && (g.classes & (1 << (l.class - 1))) === 0) out.push(`${what} is not for class ${l.class} (AllowableClass ${g.classes})`);
    if (g.itemClass === 4 && !prof.armor.includes(g.subclass)) out.push(`${what}: armor subclass ${g.subclass} is not a class ${l.class} proficiency`);
    if (g.itemClass === 2 && !prof.weapons.includes(g.subclass)) out.push(`${what}: weapon subclass ${g.subclass} is not a class ${l.class} skill`);
    if (g.itemClass !== 2 && g.itemClass !== 4) out.push(`${what}: item class ${g.itemClass} is not worn`);
    if (!(SLOT_TAKES[g.slot] ?? []).includes(g.inv)) out.push(`${what}: inventory type ${g.inv} does not go in slot ${g.slot}`);
    if (g.slot === SLOT.offHand && g.inv === 13 && !prof.dualWield) out.push(`${what}: a one-hander in the off hand needs Dual Wield`);
    if ((g.inv === 17) !== (g.twoHand === true)) out.push(`${what}: twoHand must mark exactly the two-handers`);
  }
  const filled = new Set(l.gear.map((g) => g.slot));
  for (const s of raidSlots(l)) if (!filled.has(s)) out.push(`${l.id}: slot ${s} is empty`);
  const uniques = l.gear.filter((g) => g.unique).map((g) => g.item);
  for (const u of new Set(uniques.filter((x, i) => uniques.indexOf(x) !== i))) out.push(`${l.id}: unique item ${u} twice`);
  return out;
}

/** One `trainer_spell` row as the raid's trainer read gives it: the spell and its prerequisites (`ReqAbility1..3`, zeros dropped). */
export type TrainerRow = { spell: number; reqs: readonly number[] };

/**
 * The trainer's rows a raid member learns: every row up to 80 except the
 * loadout's exclusions and any row whose prerequisite is a talent rank this
 * build does not take (every rank spell of the class's frame that the preset
 * does not reach), or a row this rule already dropped, to a fixed point.
 * Pure; the frame is the module's own reading of Talent.dbc, which the
 * stager asks for before anything is written.
 */
export function raidTrainerSpells(l: Loadout, rows: readonly TrainerRow[], frame: TalentFrame): number[] {
  const talentSpells = new Set(frame.tabs.flatMap((t) => t.talents.flatMap((x) => x.ranks)));
  const taken = new Set<number>();
  for (const p of l.talents) {
    const entry = frame.tabs.find((t) => t.tabId === p.tab)?.talents.find((x) => x.talentId === p.talentId);
    for (const s of entry ? entry.ranks.slice(0, p.rank) : [p.spell]) taken.add(s);
  }
  const exclude = new Set(l.trainerExclude ?? []);
  const dropped = new Set<number>([...exclude]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of rows) {
      if (dropped.has(r.spell)) continue;
      if (r.reqs.some((q) => dropped.has(q) || (talentSpells.has(q) && !taken.has(q)))) {
        dropped.add(r.spell);
        changed = true;
      }
    }
  }
  return [...new Set(rows.map((r) => r.spell).filter((s) => !dropped.has(s)))].sort((a, b) => a - b);
}
