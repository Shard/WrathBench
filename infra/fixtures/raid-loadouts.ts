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
 *   A pick whose spell is an ability (Talent.dbc `addToSpellBook`, Spell.dbc
 *   neither passive nor a learn effect) carries `spellbook`, so the stager
 *   also writes the spell row a learned talent leaves; no pick is a learn
 *   effect.
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
 * - Gear: the tier the 10-player Onyxia of 3.2 is tuned for and drops,
 *   item level 226-232 (average 227-231 a set): Trial of the Crusader
 *   10-player, the Tier 9 and Emblem of Triumph vendors, the Ulduar 25-player
 *   and hard-mode caches, the Frozen Halls heroics, chosen from
 *   `item_template` by class proficiency, slot and role stat weights. Each
 *   one is a drop, a vendor item or a quest reward somewhere in the world
 *   tables, and none has a requirement the staged character could not meet at
 *   login: no reputation, profession skill or spell, honor or city rank,
 *   map, area, duration, random property or suffix, limit category,
 *   resilience (PvP), heroic (245+) or legendary quality; nothing from a
 *   holiday boss or chest or from Onyxia herself; and nothing Horde-only,
 *   by race mask or by the Horde flag (`races`, `flags2`, which
 *   `Player::CanUseItem` checks). Every weapon is one the race and class
 *   start with a skill in (`playercreateinfo_skills`, raised to 400 by
 *   `maxSkills`), or one a weapon master teaches that the loadout stages at
 *   the cap (`weaponSkills`): a weapon whose skill stood at 1 would miss
 *   against a level-83 boss. So the Combat rogue fights with swords (Hack and
 *   Slash, the Human's Sword Specialization) on One-Handed Swords staged at
 *   400, and the mages with staves. Plate comes from the trainer at 40 (Plate
 *   Mail, 750). The caps hold from the gear alone, gems and enchants aside
 *   (`RAID_CAPS`, at gtCombatRatings' level-80 ratings): both tanks at 540
 *   defense, uncrittable by a level-83 boss; melee at the 8% special-attack
 *   hit cap and the 26 expertise that removes a boss's dodge, each with its
 *   own talents and racial; the casters at the 17% spell hit cap less their
 *   own talents (Misery's 3% on the raid's target is margin, not counted).
 *   Fire resistance is not stacked.
 * - Gems and enchants: the standard choices of the tier, none needing a
 *   profession (no ring enchant, no profession-only gem): a permanent
 *   enchant on head, shoulders, back, chest, wrists, hands, legs, feet,
 *   weapon and shield, and every socket filled with a gem of its colour, so
 *   every socket bonus is on and each meta gem's condition is met
 *   (`metaGemActive`). The stager writes them as the `item_instance`
 *   enchantments a client's enchanting and socketing leave
 *   (`itemEnchantments`). Gem, enchant and condition facts are read from
 *   GemProperties.dbc, SpellItemEnchantment.dbc,
 *   SpellItemEnchantmentCondition.dbc and the enchanting spell's equipped-item
 *   masks in Spell.dbc (`GEMS`, `ENCHANTS`).
 * - Glyphs: three major and three minor of the class, the standard choices of
 *   the build, in GlyphSlot.dbc's slot order (slots 0, 3 and 5 major), each
 *   id the GlyphProperties.dbc row its class glyph item's spell applies.
 * - Money and supplies: 1000 gold (`RAID_MONEY`) for many full repairs, and
 *   reagents, food, drink, potions, flasks and poisons for many wipes
 *   (hundreds of buff reagents, twenty flasks), every stack sized from
 *   `item_template` so the set fits the four bags (`supplySlots`).
 */

import type { PartySpec } from "../../runner/src/party";
import type { GearLine, GlyphPick, Loadout, PartyRoleWord, StockLine, TalentFrame, TalentPick, WeaponSkill } from "./loadouts";

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

/** A raid piece with the `item_template` facts its checks read (`raidGearProblems`, `RAID_CAPS`). */
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
  /** `AllowableRace`, -1 for any. */
  races: number;
  /** `FlagsExtra`'s faction bits (`ITEM_FLAG2_FACTION_HORDE` 1, `_ALLIANCE` 2), when set. */
  flags2?: number;
  /** Defense rating (stat type 12), for the tanks' cap. */
  defense?: number;
  /** Hit rating (stat type 31: melee, ranged and spell), for the hit caps. */
  hit?: number;
  /** Expertise rating (stat type 37). */
  expertise?: number;
  /** `maxcount` 1 or unique-equipped: never two in one set. */
  unique?: true;
  /** `socketColor_1..3` of the sockets it has (1 meta, 2 red, 4 yellow, 8 blue), and its `socketBonus` enchant. */
  sockets?: readonly number[];
  socketBonus?: number;
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
export type RaidLoadout = Omit<Loadout, "id" | "spec" | "level" | "gear" | "supplies" | "money" | "glyphs"> & {
  id: RaidLoadoutId;
  spec: PartySpec;
  level: typeof RAID_LEVEL;
  gear: readonly RaidGearLine[];
  supplies: readonly RaidStockLine[];
  money: number;
  glyphs: readonly GlyphPick[];
};

/** A raid supply line with its `item_template.stackable`, so the set can be checked against the bags (`supplySlots`). */
export type RaidStockLine = StockLine & { stack: number };

/** 1000 gold: a level-80 full repair costs tens of gold, so many wipes' worth. */
export const RAID_MONEY = 10_000_000;

const FROSTWEAVE_BAG: StockLine = { item: 41599, name: "Frostweave Bag", count: 1 };
const BAGS = [FROSTWEAVE_BAG, FROSTWEAVE_BAG, FROSTWEAVE_BAG, FROSTWEAVE_BAG] as const;
/** Plain food and drink, eaten between pulls. */
const ROCKFIN: RaidStockLine = { item: 34759, name: "Smoked Rockfin", count: 40, stack: 20 };
const TEA: RaidStockLine = { item: 33445, name: "Honeymint Tea", count: 60, stack: 20 };
/** Well Fed food: strength, agility, spell power, mana regeneration. */
const DRAGONFIN_FILET: RaidStockLine = { item: 43000, name: "Dragonfin Filet", count: 40, stack: 20 };
const BLACKENED_DRAGONFIN: RaidStockLine = { item: 42999, name: "Blackened Dragonfin", count: 40, stack: 20 };
const FIRECRACKER_SALMON: RaidStockLine = { item: 34767, name: "Firecracker Salmon", count: 40, stack: 20 };
const RHINO_DOGS: RaidStockLine = { item: 34758, name: "Mighty Rhino Dogs", count: 40, stack: 20 };
const HEALING: RaidStockLine = { item: 33447, name: "Runic Healing Potion", count: 40, stack: 20 };
const MANA: RaidStockLine = { item: 33448, name: "Runic Mana Potion", count: 40, stack: 20 };
const TANK_MANA: RaidStockLine = { ...MANA, count: 60 };
const INDESTRUCTIBLE: RaidStockLine = { item: 40093, name: "Indestructible Potion", count: 20, stack: 20 };
/** A flask lasts an hour and survives death: twenty is more than a four-hour run drinks. */
const STONEBLOOD: RaidStockLine = { item: 46379, name: "Flask of Stoneblood", count: 20, stack: 20 };
const ENDLESS_RAGE: RaidStockLine = { item: 46377, name: "Flask of Endless Rage", count: 20, stack: 20 };
const FROST_WYRM: RaidStockLine = { item: 46376, name: "Flask of the Frost Wyrm", count: 20, stack: 20 };
/** Greater Blessings' reagent, one a class a blessing. */
const SYMBOL_OF_KINGS: RaidStockLine = { item: 21177, name: "Symbol of Kings", count: 300, stack: 100 };
/** Prayer of Fortitude, of Spirit and of Shadow Protection at 80, one a group a prayer. */
const DEVOUT_CANDLE: RaidStockLine = { item: 44615, name: "Devout Candle", count: 200, stack: 20 };
/** Arcane Brilliance. */
const ARCANE_POWDER: RaidStockLine = { item: 17020, name: "Arcane Powder", count: 200, stack: 100 };
const INSTANT_POISON: RaidStockLine = { item: 43231, name: "Instant Poison IX", count: 60, stack: 20 };
const DEADLY_POISON: RaidStockLine = { item: 43233, name: "Deadly Poison IX", count: 60, stack: 20 };

const WARRIOR_TANK_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, DRAGONFIN_FILET, HEALING, INDESTRUCTIBLE, STONEBLOOD];
const PALADIN_TANK_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, TEA, DRAGONFIN_FILET, HEALING, TANK_MANA, INDESTRUCTIBLE, STONEBLOOD, SYMBOL_OF_KINGS];
const PRIEST_HEALER_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, TEA, RHINO_DOGS, HEALING, MANA, FROST_WYRM, DEVOUT_CANDLE];
const PALADIN_HEALER_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, TEA, RHINO_DOGS, HEALING, MANA, FROST_WYRM, SYMBOL_OF_KINGS];
const MAGE_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, TEA, FIRECRACKER_SALMON, HEALING, MANA, FROST_WYRM, ARCANE_POWDER];
const SHADOW_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, TEA, FIRECRACKER_SALMON, HEALING, MANA, FROST_WYRM, DEVOUT_CANDLE];
const ROGUE_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, BLACKENED_DRAGONFIN, HEALING, ENDLESS_RAGE, INSTANT_POISON, DEADLY_POISON];
const RET_SUPPLIES: readonly RaidStockLine[] = [ROCKFIN, TEA, DRAGONFIN_FILET, HEALING, MANA, ENDLESS_RAGE, SYMBOL_OF_KINGS];

/** Bag slots: the backpack's 16 and four Frostweave Bags' 20. */
export const RAID_BAG_SLOTS = 16 + 4 * 20;
/**
 * Slots kept free of supplies for what a fresh character carries and what
 * the equipment move swaps out of its slots (starter gear, a hearthstone,
 * starter food), with room to loot.
 */
export const RAID_BAG_RESERVE = 16;
/** The bag slots a loadout's supplies take: each line's stacks. */
export function supplySlots(l: Pick<RaidLoadout, "supplies">): number {
  return l.supplies.reduce((n, s) => n + Math.ceil(s.count / ((s as Partial<RaidStockLine>).stack ?? 1)), 0);
}

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

// protwarrior: 17 pieces, average item level 229.9, defense rating 689, hit rating 194, expertise rating 221
const PROTWARRIOR_GEAR: readonly RaidGearLine[] = [
  { item: 45502, name: "Helm of the Faceless", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 226, req: 80, classes: -1, races: -1, defense: 44, sockets: [1, 8], socketBonus: 3302, gems: [41380, 40119], enchant: 3818 },
  { item: 47679, name: "Endurance of the Infernal", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 232, req: 80, classes: 32767, races: -1, flags2: 2, defense: 45, expertise: 48 },
  { item: 48448, name: "Wrynn's Pauldrons of Conquest", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 232, req: 80, classes: 1, races: 32767, flags2: 2, defense: 60, expertise: 37, sockets: [8], socketBonus: 2871, gems: [40119], enchant: 3811 },
  { item: 48436, name: "Wrynn's Breastplate of Conquest", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 232, req: 80, classes: 1, races: 32767, flags2: 2, defense: 63, sockets: [4, 8], socketBonus: 3307, gems: [40167, 40119], enchant: 3832 },
  { item: 47711, name: "Girdle of the Nether Champion", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, defense: 47 },
  { item: 40589, name: "Legplates of Sovereignty", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 226, req: 80, classes: 262143, races: 32767, defense: 86, expertise: 66, enchant: 3822 },
  { item: 47738, name: "Sabatons of the Lingering Vortex", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 232, req: 80, classes: 1535, races: -1, flags2: 2, defense: 45, hit: 40, sockets: [4], socketBonus: 2871, gems: [40167], enchant: 3232 },
  { item: 47611, name: "Dreadscale Armguards", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, defense: 34, hit: 39, enchant: 3850 },
  { item: 48449, name: "Wrynn's Handguards of Conquest", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 232, req: 80, classes: 1, races: 32767, flags2: 2, defense: 47, sockets: [4], socketBonus: 2868, gems: [40167], enchant: 3253 },
  { item: 47700, name: "Loop of the Twin Val'kyr", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 232, req: 80, classes: 262143, races: 32767, flags2: 2, defense: 31, unique: true },
  { item: 45326, name: "Platinum Band of the Aesir", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: 262143, races: 32767, defense: 46, expertise: 42, unique: true },
  { item: 45158, name: "Heart of Iron", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: -1, races: -1, unique: true },
  { item: 47727, name: "Fervor of the Frostborn", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, unique: true },
  { item: 45319, name: "Cloak of the Makers", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: -1, races: -1, defense: 43, hit: 36, enchant: 3294 },
  { item: 45110, name: "Titanguard", slot: SLOT.mainHand, itemClass: 2, subclass: 7, inv: 13, ilvl: 232, req: 80, classes: -1, races: -1, defense: 35, hit: 29, enchant: 3869 },
  { item: 45450, name: "Northern Barrier", slot: SLOT.offHand, itemClass: 4, subclass: 6, inv: 14, ilvl: 226, req: 80, classes: -1, races: -1, defense: 63, hit: 28, expertise: 28, enchant: 1952 },
  { item: 45296, name: "Twirling Blades", slot: SLOT.ranged, itemClass: 2, subclass: 16, inv: 25, ilvl: 232, req: 80, classes: -1, races: -1, hit: 22, sockets: [2], socketBonus: 2877, gems: [40139] },
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
  { talentId: 153, tab: 163, row: 2, col: 0, rank: 1, maxRank: 1, spell: 12975, name: "Last Stand", spellbook: true },
  { talentId: 147, tab: 163, row: 2, col: 1, rank: 2, maxRank: 2, spell: 12799, name: "Improved Revenge" },
  { talentId: 1654, tab: 163, row: 2, col: 2, rank: 2, maxRank: 2, spell: 29599, name: "Shield Mastery" },
  { talentId: 140, tab: 163, row: 2, col: 3, rank: 5, maxRank: 5, spell: 12764, name: "Toughness" },
  { talentId: 146, tab: 163, row: 3, col: 2, rank: 3, maxRank: 3, spell: 12811, name: "Puncture" },
  { talentId: 152, tab: 163, row: 4, col: 1, rank: 1, maxRank: 1, spell: 12809, name: "Concussion Blow", spellbook: true },
  { talentId: 149, tab: 163, row: 4, col: 2, rank: 2, maxRank: 2, spell: 12958, name: "Gag Order" },
  { talentId: 702, tab: 163, row: 5, col: 2, rank: 5, maxRank: 5, spell: 16542, name: "One-Handed Weapon Specialization" },
  { talentId: 1652, tab: 163, row: 6, col: 0, rank: 2, maxRank: 2, spell: 29594, name: "Improved Defensive Stance" },
  { talentId: 148, tab: 163, row: 6, col: 1, rank: 1, maxRank: 1, spell: 50720, name: "Vigilance", spellbook: true, dependsOn: { talentId: 152, rank: 1 } },
  { talentId: 1660, tab: 163, row: 6, col: 2, rank: 3, maxRank: 3, spell: 29792, name: "Focused Rage" },
  { talentId: 1653, tab: 163, row: 7, col: 1, rank: 3, maxRank: 3, spell: 29144, name: "Vitality" },
  { talentId: 2236, tab: 163, row: 8, col: 0, rank: 1, maxRank: 1, spell: 57499, name: "Warbringer" },
  { talentId: 1666, tab: 163, row: 8, col: 1, rank: 1, maxRank: 1, spell: 20243, name: "Devastate", spellbook: true },
  { talentId: 1893, tab: 163, row: 8, col: 2, rank: 3, maxRank: 3, spell: 47296, name: "Critical Block" },
  { talentId: 1871, tab: 163, row: 9, col: 1, rank: 3, maxRank: 3, spell: 46953, name: "Sword and Board", dependsOn: { talentId: 1666, rank: 1 } },
  { talentId: 2246, tab: 163, row: 9, col: 2, rank: 2, maxRank: 2, spell: 58874, name: "Damage Shield" },
  { talentId: 1872, tab: 163, row: 10, col: 1, rank: 1, maxRank: 1, spell: 46968, name: "Shockwave", spellbook: true },
];

// protpaladin: 17 pieces, average item level 229.9, defense rating 709, hit rating 166, expertise rating 226
const PROTPALADIN_GEAR: readonly RaidGearLine[] = [
  { item: 50311, name: "Second Helm of the Executioner", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 232, req: 80, classes: 262143, races: 2147483647, defense: 82, expertise: 53, sockets: [1, 8], socketBonus: 3302, gems: [41380, 40119], enchant: 3818 },
  { item: 50310, name: "Fossilized Ammonite Choker", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 232, req: 80, classes: 32767, races: -1, defense: 35 },
  { item: 48636, name: "Turalyon's Shoulderguards of Conquest", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 232, req: 80, classes: 2, races: 32767, flags2: 2, defense: 60, expertise: 37, sockets: [8], socketBonus: 2871, gems: [40119], enchant: 3811 },
  { item: 48632, name: "Turalyon's Breastplate of Conquest", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 232, req: 80, classes: 2, races: 32767, flags2: 2, defense: 63, sockets: [4, 8], socketBonus: 3307, gems: [40167, 40119], enchant: 3832 },
  { item: 47711, name: "Girdle of the Nether Champion", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, defense: 47 },
  { item: 40589, name: "Legplates of Sovereignty", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 226, req: 80, classes: 262143, races: 32767, defense: 86, expertise: 66, enchant: 3822 },
  { item: 47738, name: "Sabatons of the Lingering Vortex", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 232, req: 80, classes: 1535, races: -1, flags2: 2, defense: 45, hit: 40, sockets: [4], socketBonus: 2871, gems: [40167], enchant: 3232 },
  { item: 47611, name: "Dreadscale Armguards", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, defense: 34, hit: 39, enchant: 3850 },
  { item: 48633, name: "Turalyon's Handguards of Conquest", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 232, req: 80, classes: 2, races: 32767, flags2: 2, defense: 47, sockets: [4], socketBonus: 2868, gems: [40167], enchant: 3253 },
  { item: 47700, name: "Loop of the Twin Val'kyr", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 232, req: 80, classes: 262143, races: 32767, flags2: 2, defense: 31, unique: true },
  { item: 45326, name: "Platinum Band of the Aesir", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: 262143, races: 32767, defense: 46, expertise: 42, unique: true },
  { item: 45158, name: "Heart of Iron", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: -1, races: -1, unique: true },
  { item: 47727, name: "Fervor of the Frostborn", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, unique: true },
  { item: 45319, name: "Cloak of the Makers", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: -1, races: -1, defense: 43, hit: 36, enchant: 3294 },
  { item: 45876, name: "Shiver", slot: SLOT.mainHand, itemClass: 2, subclass: 4, inv: 13, ilvl: 232, req: 80, classes: 32767, races: -1, defense: 27, hit: 23, sockets: [2], socketBonus: 2873, gems: [40139], enchant: 3869 },
  { item: 45450, name: "Northern Barrier", slot: SLOT.offHand, itemClass: 4, subclass: 6, inv: 14, ilvl: 226, req: 80, classes: -1, races: -1, defense: 63, hit: 28, expertise: 28, enchant: 1952 },
  { item: 45145, name: "Libram of the Sacred Shield", slot: SLOT.ranged, itemClass: 4, subclass: 7, inv: 28, ilvl: 226, req: 80, classes: 32767, races: -1 },
];
const PROTPALADIN_TALENTS: readonly TalentPick[] = [
  { talentId: 1442, tab: 383, row: 0, col: 1, rank: 5, maxRank: 5, spell: 63650, name: "Divinity" },
  { talentId: 1748, tab: 383, row: 1, col: 0, rank: 3, maxRank: 3, spell: 53519, name: "Stoicism" },
  { talentId: 1629, tab: 383, row: 1, col: 2, rank: 5, maxRank: 5, spell: 20100, name: "Anticipation" },
  { talentId: 2280, tab: 383, row: 2, col: 0, rank: 1, maxRank: 1, spell: 64205, name: "Divine Sacrifice", spellbook: true },
  { talentId: 1501, tab: 383, row: 2, col: 1, rank: 3, maxRank: 3, spell: 20470, name: "Improved Righteous Fury" },
  { talentId: 1423, tab: 383, row: 2, col: 2, rank: 5, maxRank: 5, spell: 20147, name: "Toughness" },
  { talentId: 2281, tab: 383, row: 3, col: 0, rank: 2, maxRank: 2, spell: 53530, name: "Divine Guardian", dependsOn: { talentId: 2280, rank: 1 } },
  { talentId: 1431, tab: 383, row: 4, col: 1, rank: 1, maxRank: 1, spell: 20911, name: "Blessing of Sanctuary", spellbook: true },
  { talentId: 1750, tab: 383, row: 5, col: 0, rank: 2, maxRank: 2, spell: 31849, name: "Sacred Duty" },
  { talentId: 1429, tab: 383, row: 5, col: 2, rank: 3, maxRank: 3, spell: 20198, name: "One-Handed Weapon Specialization" },
  { talentId: 2282, tab: 383, row: 6, col: 0, rank: 2, maxRank: 2, spell: 33776, name: "Spiritual Attunement" },
  { talentId: 1430, tab: 383, row: 6, col: 1, rank: 1, maxRank: 1, spell: 20925, name: "Holy Shield", spellbook: true, dependsOn: { talentId: 1431, rank: 1 } },
  { talentId: 1751, tab: 383, row: 6, col: 2, rank: 3, maxRank: 3, spell: 31852, name: "Ardent Defender" },
  { talentId: 1421, tab: 383, row: 7, col: 0, rank: 3, maxRank: 3, spell: 20135, name: "Redoubt" },
  { talentId: 1753, tab: 383, row: 7, col: 2, rank: 3, maxRank: 3, spell: 31860, name: "Combat Expertise" },
  { talentId: 2195, tab: 383, row: 8, col: 0, rank: 3, maxRank: 3, spell: 53592, name: "Touched by the Light" },
  { talentId: 1754, tab: 383, row: 8, col: 1, rank: 1, maxRank: 1, spell: 31935, name: "Avenger's Shield", spellbook: true, dependsOn: { talentId: 1430, rank: 1 } },
  { talentId: 2194, tab: 383, row: 8, col: 2, rank: 2, maxRank: 2, spell: 53585, name: "Guarded by the Light" },
  { talentId: 2204, tab: 383, row: 9, col: 1, rank: 3, maxRank: 3, spell: 53711, name: "Shield of the Templar", dependsOn: { talentId: 1754, rank: 1 } },
  { talentId: 2200, tab: 383, row: 9, col: 2, rank: 2, maxRank: 2, spell: 53696, name: "Judgements of the Just" },
  { talentId: 2196, tab: 383, row: 10, col: 1, rank: 1, maxRank: 1, spell: 53595, name: "Hammer of the Righteous", spellbook: true },
  { talentId: 1403, tab: 381, row: 0, col: 1, rank: 5, maxRank: 5, spell: 20064, name: "Deflection" },
  { talentId: 1631, tab: 381, row: 1, col: 0, rank: 2, maxRank: 2, spell: 25957, name: "Improved Judgements" },
  { talentId: 1464, tab: 381, row: 1, col: 1, rank: 3, maxRank: 3, spell: 20337, name: "Heart of the Crusader" },
  { talentId: 1411, tab: 381, row: 2, col: 1, rank: 5, maxRank: 5, spell: 20121, name: "Conviction" },
  { talentId: 1755, tab: 381, row: 3, col: 3, rank: 2, maxRank: 3, spell: 31867, name: "Crusade" },
];

// holypriest: 17 pieces, average item level 229.5, defense rating 0, hit rating 0, expertise rating 0
const HOLYPRIEST_GEAR: readonly RaidGearLine[] = [
  { item: 47914, name: "Velen's Cowl of Conquest", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 232, req: 80, classes: 16, races: 32767, flags2: 2, sockets: [1, 8], socketBonus: 3753, gems: [41401, 40133], enchant: 3819 },
  { item: 45447, name: "Watchful Eye of Fate", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 226, req: 80, classes: -1, races: -1, sockets: [4], socketBonus: 2864, gems: [40155] },
  { item: 46068, name: "Amice of Inconceivable Horror", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [2, 4], socketBonus: 3311, gems: [40113, 40155], enchant: 3809 },
  { item: 48075, name: "Velen's Raiments of Conquest", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, sockets: [2, 8], socketBonus: 3602, gems: [40113, 40133], enchant: 3832 },
  { item: 50263, name: "Braid of Salt and Fire", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 232, req: 80, classes: 32767, races: -1 },
  { item: 47980, name: "Velen's Leggings of Conquest", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, sockets: [2, 8], socketBonus: 3602, gems: [40113, 40133], enchant: 3719 },
  { item: 50286, name: "Prelate's Snowshoes", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 232, req: 80, classes: 262143, races: 32767, enchant: 3232 },
  { item: 44008, name: "Unsullied Cuffs", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [2], socketBonus: 2890, gems: [40113], enchant: 2332 },
  { item: 47982, name: "Velen's Gloves of Conquest", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, sockets: [4], socketBonus: 3752, gems: [40155], enchant: 3246 },
  { item: 46046, name: "Nebula Band", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [4], socketBonus: 2952, gems: [40155] },
  { item: 46096, name: "Signet of Soft Lament", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [8], socketBonus: 2890, gems: [40133] },
  { item: 50259, name: "Nevermelting Ice Crystal", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, unique: true },
  { item: 47728, name: "Binding Light", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, unique: true },
  { item: 46321, name: "Sunglimmer Drape", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [8], socketBonus: 3752, gems: [40133], enchant: 3831 },
  { item: 46035, name: "Aesuga, Hand of the Ardent Champion", slot: SLOT.mainHand, itemClass: 2, subclass: 4, inv: 21, ilvl: 232, req: 80, classes: 32767, races: -1, sockets: [4], socketBonus: 2864, gems: [40155], enchant: 3834 },
  { item: 45271, name: "Ironmender", slot: SLOT.offHand, itemClass: 4, subclass: 0, inv: 23, ilvl: 226, req: 80, classes: -1, races: -1 },
  { item: 45170, name: "Scepter of Creation", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 232, req: 80, classes: -1, races: -1 },
];
const HOLYPRIEST_TALENTS: readonly TalentPick[] = [
  { talentId: 1898, tab: 201, row: 0, col: 2, rank: 5, maxRank: 5, spell: 52803, name: "Twin Disciplines" },
  { talentId: 346, tab: 201, row: 1, col: 1, rank: 3, maxRank: 3, spell: 14771, name: "Improved Inner Fire" },
  { talentId: 344, tab: 201, row: 1, col: 2, rank: 2, maxRank: 2, spell: 14767, name: "Improved Power Word: Fortitude" },
  { talentId: 347, tab: 201, row: 2, col: 0, rank: 3, maxRank: 3, spell: 14777, name: "Meditation" },
  { talentId: 406, tab: 202, row: 0, col: 1, rank: 3, maxRank: 3, spell: 17191, name: "Improved Renew" },
  { talentId: 401, tab: 202, row: 0, col: 2, rank: 5, maxRank: 5, spell: 15011, name: "Holy Specialization" },
  { talentId: 1181, tab: 202, row: 1, col: 2, rank: 5, maxRank: 5, spell: 18535, name: "Divine Fury" },
  { talentId: 442, tab: 202, row: 2, col: 0, rank: 1, maxRank: 1, spell: 19236, name: "Desperate Prayer", spellbook: true },
  { talentId: 361, tab: 202, row: 2, col: 3, rank: 3, maxRank: 3, spell: 15363, name: "Inspiration" },
  { talentId: 408, tab: 202, row: 3, col: 1, rank: 3, maxRank: 3, spell: 15014, name: "Improved Healing" },
  { talentId: 1561, tab: 202, row: 4, col: 1, rank: 1, maxRank: 1, spell: 20711, name: "Spirit of Redemption" },
  { talentId: 402, tab: 202, row: 4, col: 2, rank: 5, maxRank: 5, spell: 15031, name: "Spiritual Guidance" },
  { talentId: 1766, tab: 202, row: 5, col: 0, rank: 2, maxRank: 2, spell: 33154, name: "Surge of Light" },
  { talentId: 404, tab: 202, row: 5, col: 2, rank: 5, maxRank: 5, spell: 15356, name: "Spiritual Healing" },
  { talentId: 1768, tab: 202, row: 6, col: 0, rank: 3, maxRank: 3, spell: 34860, name: "Holy Concentration" },
  { talentId: 1637, tab: 202, row: 6, col: 1, rank: 1, maxRank: 1, spell: 724, name: "Lightwell", spellbook: true, dependsOn: { talentId: 1561, rank: 1 } },
  { talentId: 1767, tab: 202, row: 7, col: 1, rank: 5, maxRank: 5, spell: 33162, name: "Empowered Healing" },
  { talentId: 1904, tab: 202, row: 7, col: 2, rank: 3, maxRank: 3, spell: 63737, name: "Serendipity" },
  { talentId: 1902, tab: 202, row: 8, col: 0, rank: 3, maxRank: 3, spell: 63543, name: "Empowered Renew" },
  { talentId: 1815, tab: 202, row: 8, col: 1, rank: 1, maxRank: 1, spell: 34861, name: "Circle of Healing", spellbook: true },
  { talentId: 1903, tab: 202, row: 8, col: 2, rank: 3, maxRank: 3, spell: 47560, name: "Test of Faith" },
  { talentId: 1905, tab: 202, row: 9, col: 1, rank: 5, maxRank: 5, spell: 47567, name: "Divine Providence" },
  { talentId: 1911, tab: 202, row: 10, col: 1, rank: 1, maxRank: 1, spell: 47788, name: "Guardian Spirit", spellbook: true },
];

// discpriest: 17 pieces, average item level 229.2, defense rating 0, hit rating 0, expertise rating 0
const DISCPRIEST_GEAR: readonly RaidGearLine[] = [
  { item: 47914, name: "Velen's Cowl of Conquest", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 232, req: 80, classes: 16, races: 32767, flags2: 2, sockets: [1, 8], socketBonus: 3753, gems: [41401, 40133], enchant: 3819 },
  { item: 50211, name: "Arcane Loops of Anger", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 232, req: 80, classes: 32767, races: -1 },
  { item: 46068, name: "Amice of Inconceivable Horror", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [2, 4], socketBonus: 3311, gems: [40113, 40155], enchant: 3809 },
  { item: 48075, name: "Velen's Raiments of Conquest", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, sockets: [2, 8], socketBonus: 3602, gems: [40113, 40133], enchant: 3832 },
  { item: 50314, name: "Strip of Remorse", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 232, req: 80, classes: 32767, races: -1 },
  { item: 47980, name: "Velen's Leggings of Conquest", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, sockets: [2, 8], socketBonus: 3602, gems: [40113, 40133], enchant: 3719 },
  { item: 46050, name: "Starlight Treads", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [8, 4], socketBonus: 3311, gems: [40133, 40155], enchant: 3232 },
  { item: 44008, name: "Unsullied Cuffs", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [2], socketBonus: 2890, gems: [40113], enchant: 2332 },
  { item: 47982, name: "Velen's Gloves of Conquest", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, sockets: [4], socketBonus: 3752, gems: [40155], enchant: 3246 },
  { item: 46096, name: "Signet of Soft Lament", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [8], socketBonus: 2890, gems: [40133] },
  { item: 46046, name: "Nebula Band", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [4], socketBonus: 2952, gems: [40155] },
  { item: 45466, name: "Scale of Fates", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: 262143, races: 32767, unique: true },
  { item: 45490, name: "Pandora's Plea", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: -1, races: -1, unique: true },
  { item: 44005, name: "Pennant Cloak", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [8], socketBonus: 3752, gems: [40133], enchant: 3831 },
  { item: 46035, name: "Aesuga, Hand of the Ardent Champion", slot: SLOT.mainHand, itemClass: 2, subclass: 4, inv: 21, ilvl: 232, req: 80, classes: 32767, races: -1, sockets: [4], socketBonus: 2864, gems: [40155], enchant: 3834 },
  { item: 50309, name: "Shriveled Heart", slot: SLOT.offHand, itemClass: 4, subclass: 0, inv: 23, ilvl: 232, req: 80, classes: -1, races: -1 },
  { item: 47612, name: "Rod of Imprisoned Souls", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2 },
];
const DISCPRIEST_TALENTS: readonly TalentPick[] = [
  { talentId: 1898, tab: 201, row: 0, col: 2, rank: 5, maxRank: 5, spell: 52803, name: "Twin Disciplines" },
  { talentId: 346, tab: 201, row: 1, col: 1, rank: 3, maxRank: 3, spell: 14771, name: "Improved Inner Fire" },
  { talentId: 344, tab: 201, row: 1, col: 2, rank: 2, maxRank: 2, spell: 14767, name: "Improved Power Word: Fortitude" },
  { talentId: 347, tab: 201, row: 2, col: 0, rank: 3, maxRank: 3, spell: 14777, name: "Meditation" },
  { talentId: 348, tab: 201, row: 2, col: 1, rank: 1, maxRank: 1, spell: 14751, name: "Inner Focus", spellbook: true },
  { talentId: 343, tab: 201, row: 2, col: 2, rank: 3, maxRank: 3, spell: 14769, name: "Improved Power Word: Shield" },
  { talentId: 1769, tab: 201, row: 3, col: 0, rank: 3, maxRank: 3, spell: 33172, name: "Absolution" },
  { talentId: 341, tab: 201, row: 3, col: 1, rank: 3, maxRank: 3, spell: 14781, name: "Mental Agility" },
  { talentId: 1201, tab: 201, row: 4, col: 1, rank: 5, maxRank: 5, spell: 18555, name: "Mental Strength" },
  { talentId: 351, tab: 201, row: 4, col: 2, rank: 1, maxRank: 1, spell: 63574, name: "Soul Warding", dependsOn: { talentId: 343, rank: 3 } },
  { talentId: 1771, tab: 201, row: 5, col: 0, rank: 2, maxRank: 2, spell: 33190, name: "Focused Power" },
  { talentId: 1772, tab: 201, row: 5, col: 2, rank: 3, maxRank: 3, spell: 34910, name: "Enlightenment" },
  { talentId: 322, tab: 201, row: 6, col: 1, rank: 1, maxRank: 1, spell: 10060, name: "Power Infusion", spellbook: true, dependsOn: { talentId: 1201, rank: 5 } },
  { talentId: 1773, tab: 201, row: 6, col: 2, rank: 3, maxRank: 3, spell: 63506, name: "Improved Flash Heal" },
  { talentId: 2235, tab: 201, row: 7, col: 0, rank: 2, maxRank: 2, spell: 57472, name: "Renewed Hope" },
  { talentId: 1896, tab: 201, row: 7, col: 1, rank: 3, maxRank: 3, spell: 47537, name: "Rapture" },
  { talentId: 1894, tab: 201, row: 7, col: 2, rank: 2, maxRank: 2, spell: 47508, name: "Aspiration" },
  { talentId: 1895, tab: 201, row: 8, col: 0, rank: 3, maxRank: 3, spell: 47515, name: "Divine Aegis" },
  { talentId: 1774, tab: 201, row: 8, col: 1, rank: 1, maxRank: 1, spell: 33206, name: "Pain Suppression", spellbook: true },
  { talentId: 1901, tab: 201, row: 8, col: 2, rank: 2, maxRank: 2, spell: 47517, name: "Grace" },
  { talentId: 1202, tab: 201, row: 9, col: 1, rank: 5, maxRank: 5, spell: 52800, name: "Borrowed Time" },
  { talentId: 1897, tab: 201, row: 10, col: 1, rank: 1, maxRank: 1, spell: 47540, name: "Penance", spellbook: true },
  { talentId: 406, tab: 202, row: 0, col: 1, rank: 3, maxRank: 3, spell: 17191, name: "Improved Renew" },
  { talentId: 401, tab: 202, row: 0, col: 2, rank: 5, maxRank: 5, spell: 15011, name: "Holy Specialization" },
  { talentId: 1181, tab: 202, row: 1, col: 2, rank: 5, maxRank: 5, spell: 18535, name: "Divine Fury" },
  { talentId: 442, tab: 202, row: 2, col: 0, rank: 1, maxRank: 1, spell: 19236, name: "Desperate Prayer", spellbook: true },
];

// holypaladin: 17 pieces, average item level 229.2, defense rating 0, hit rating 0, expertise rating 0
const HOLYPALADIN_GEAR: readonly RaidGearLine[] = [
  { item: 48564, name: "Turalyon's Headpiece of Conquest", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 232, req: 80, classes: 2, races: 2147483647, flags2: 2, sockets: [1, 8], socketBonus: 3753, gems: [41401, 40133], enchant: 3819 },
  { item: 50211, name: "Arcane Loops of Anger", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 232, req: 80, classes: 32767, races: -1 },
  { item: 48572, name: "Turalyon's Spaulders of Conquest", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 232, req: 80, classes: 2, races: 2147483647, flags2: 2, sockets: [4], socketBonus: 3752, gems: [40123], enchant: 3809 },
  { item: 50294, name: "Chestpiece of High Treason", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 232, req: 80, classes: 262143, races: 2147483647, sockets: [2], socketBonus: 3752, gems: [40151], enchant: 3832 },
  { item: 47615, name: "Belt of the Frozen Reach", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 232, req: 80, classes: 1535, races: -1, flags2: 2 },
  { item: 47836, name: "Legplates of the Immortal Spider", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, sockets: [2, 8], socketBonus: 3316, gems: [40151, 40133], enchant: 3719 },
  { item: 50215, name: "Recovered Reliquary Boots", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 232, req: 80, classes: 1535, races: -1, enchant: 3232 },
  { item: 45269, name: "Unfaltering Armguards", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 226, req: 80, classes: -1, races: -1, sockets: [8], socketBonus: 3752, gems: [40133], enchant: 2332 },
  { item: 45928, name: "Gauntlets of the Thunder God", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [8, 2], socketBonus: 3316, gems: [40133, 40151], enchant: 3246 },
  { item: 45946, name: "Fire Orchid Signet", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [4], socketBonus: 2865, gems: [40123] },
  { item: 46046, name: "Nebula Band", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [4], socketBonus: 2952, gems: [40123] },
  { item: 45466, name: "Scale of Fates", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: 262143, races: 32767, unique: true },
  { item: 46051, name: "Meteorite Crystal", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: -1, races: -1, unique: true },
  { item: 44005, name: "Pennant Cloak", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [8], socketBonus: 3752, gems: [40133], enchant: 3831 },
  { item: 46035, name: "Aesuga, Hand of the Ardent Champion", slot: SLOT.mainHand, itemClass: 2, subclass: 4, inv: 21, ilvl: 232, req: 80, classes: 32767, races: -1, sockets: [4], socketBonus: 2864, gems: [40123], enchant: 3834 },
  { item: 47812, name: "Vigilant Ward", slot: SLOT.offHand, itemClass: 4, subclass: 6, inv: 14, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, sockets: [4], socketBonus: 2865, gems: [40123], enchant: 1128 },
  { item: 45436, name: "Libram of the Resolute", slot: SLOT.ranged, itemClass: 4, subclass: 7, inv: 28, ilvl: 226, req: 80, classes: 32767, races: -1 },
];
const HOLYPALADIN_TALENTS: readonly TalentPick[] = [
  { talentId: 1432, tab: 382, row: 0, col: 1, rank: 5, maxRank: 5, spell: 20208, name: "Spiritual Focus" },
  { talentId: 1444, tab: 382, row: 1, col: 0, rank: 3, maxRank: 3, spell: 20239, name: "Healing Light" },
  { talentId: 1449, tab: 382, row: 1, col: 1, rank: 5, maxRank: 5, spell: 20261, name: "Divine Intellect" },
  { talentId: 1435, tab: 382, row: 2, col: 0, rank: 1, maxRank: 1, spell: 31821, name: "Aura Mastery", spellbook: true },
  { talentId: 1461, tab: 382, row: 2, col: 1, rank: 5, maxRank: 5, spell: 20215, name: "Illumination" },
  { talentId: 1443, tab: 382, row: 2, col: 2, rank: 2, maxRank: 2, spell: 20235, name: "Improved Lay on Hands" },
  { talentId: 1450, tab: 382, row: 3, col: 0, rank: 1, maxRank: 3, spell: 20254, name: "Improved Concentration Aura" },
  { talentId: 1433, tab: 382, row: 4, col: 1, rank: 1, maxRank: 1, spell: 20216, name: "Divine Favor", spellbook: true, dependsOn: { talentId: 1461, rank: 5 } },
  { talentId: 1465, tab: 382, row: 4, col: 2, rank: 3, maxRank: 3, spell: 20361, name: "Sanctified Light" },
  { talentId: 1627, tab: 382, row: 5, col: 2, rank: 5, maxRank: 5, spell: 25829, name: "Holy Power" },
  { talentId: 1745, tab: 382, row: 6, col: 0, rank: 3, maxRank: 3, spell: 31836, name: "Light's Grace" },
  { talentId: 1502, tab: 382, row: 6, col: 1, rank: 1, maxRank: 1, spell: 20473, name: "Holy Shock", spellbook: true, dependsOn: { talentId: 1433, rank: 1 } },
  { talentId: 1746, tab: 382, row: 7, col: 2, rank: 5, maxRank: 5, spell: 31841, name: "Holy Guidance" },
  { talentId: 1747, tab: 382, row: 8, col: 0, rank: 1, maxRank: 1, spell: 31842, name: "Divine Illumination", spellbook: true },
  { talentId: 2199, tab: 382, row: 8, col: 2, rank: 5, maxRank: 5, spell: 54155, name: "Judgements of the Pure" },
  { talentId: 2193, tab: 382, row: 9, col: 1, rank: 2, maxRank: 2, spell: 53576, name: "Infusion of Light", dependsOn: { talentId: 1502, rank: 1 } },
  { talentId: 2191, tab: 382, row: 9, col: 2, rank: 2, maxRank: 2, spell: 53557, name: "Enlightened Judgements" },
  { talentId: 2192, tab: 382, row: 10, col: 1, rank: 1, maxRank: 1, spell: 53563, name: "Beacon of Light", spellbook: true },
  { talentId: 1442, tab: 383, row: 0, col: 1, rank: 5, maxRank: 5, spell: 63650, name: "Divinity" },
  { talentId: 1748, tab: 383, row: 1, col: 0, rank: 3, maxRank: 3, spell: 53519, name: "Stoicism" },
  { talentId: 1425, tab: 383, row: 1, col: 1, rank: 2, maxRank: 2, spell: 20175, name: "Guardian's Favor" },
  { talentId: 2280, tab: 383, row: 2, col: 0, rank: 1, maxRank: 1, spell: 64205, name: "Divine Sacrifice", spellbook: true },
  { talentId: 1423, tab: 383, row: 2, col: 2, rank: 4, maxRank: 5, spell: 20146, name: "Toughness" },
  { talentId: 2281, tab: 383, row: 3, col: 0, rank: 2, maxRank: 2, spell: 53530, name: "Divine Guardian", dependsOn: { talentId: 2280, rank: 1 } },
  { talentId: 1422, tab: 383, row: 3, col: 2, rank: 3, maxRank: 3, spell: 20140, name: "Improved Devotion Aura" },
];

// arcanemage: 16 pieces, average item level 229.0, defense rating 0, hit rating 296, expertise rating 0
const ARCANEMAGE_GEAR: readonly RaidGearLine[] = [
  { item: 50298, name: "Sightless Crown of Ulmaas", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 232, req: 80, classes: 262143, races: 2147483647, hit: 62, sockets: [1, 8], socketBonus: 3314, gems: [41285, 40132], enchant: 3820 },
  { item: 45933, name: "Pendant of the Shallow Grave", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [4], socketBonus: 2952, gems: [40155] },
  { item: 46068, name: "Amice of Inconceivable Horror", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [2, 4], socketBonus: 3311, gems: [40113, 40155], enchant: 3810 },
  { item: 46130, name: "Conqueror's Kirin Tor Tunic", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 5, ilvl: 226, req: 80, classes: 128, races: 2147483647, sockets: [8, 4], socketBonus: 3316, gems: [40132, 40155], enchant: 3832 },
  { item: 50314, name: "Strip of Remorse", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 232, req: 80, classes: 32767, races: -1 },
  { item: 47750, name: "Khadgar's Leggings of Conquest", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 232, req: 80, classes: 128, races: 2147483647, flags2: 2, sockets: [4, 4], socketBonus: 3602, gems: [40155, 40155], enchant: 3721 },
  { item: 46050, name: "Starlight Treads", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [8, 4], socketBonus: 3311, gems: [40132, 40155], enchant: 3826 },
  { item: 44008, name: "Unsullied Cuffs", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [2], socketBonus: 2890, gems: [40113], enchant: 2332 },
  { item: 47752, name: "Khadgar's Gauntlets of Conquest", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 232, req: 80, classes: 128, races: 32767, flags2: 2, sockets: [2], socketBonus: 3263, gems: [40113], enchant: 3246 },
  { item: 45297, name: "Shimmering Seal", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, hit: 42, unique: true, sockets: [2], socketBonus: 3752, gems: [40113] },
  { item: 47618, name: "Firestorm Ring", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, hit: 50, unique: true },
  { item: 50259, name: "Nevermelting Ice Crystal", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, unique: true },
  { item: 45466, name: "Scale of Fates", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: 262143, races: 32767, unique: true },
  { item: 44005, name: "Pennant Cloak", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [8], socketBonus: 3752, gems: [40132], enchant: 3831 },
  { item: 50273, name: "Engraved Gargoyle Femur", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 232, req: 80, classes: -1, races: -1, hit: 113, enchant: 3854 },
  { item: 45294, name: "Petrified Ivy Sprig", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 232, req: 80, classes: -1, races: -1, hit: 29, sockets: [4], socketBonus: 2890, gems: [40155] },
];
const ARCANEMAGE_TALENTS: readonly TalentPick[] = [
  { talentId: 74, tab: 81, row: 0, col: 0, rank: 2, maxRank: 2, spell: 12592, name: "Arcane Subtlety" },
  { talentId: 76, tab: 81, row: 0, col: 1, rank: 3, maxRank: 3, spell: 12840, name: "Arcane Focus" },
  { talentId: 85, tab: 81, row: 1, col: 0, rank: 1, maxRank: 3, spell: 28574, name: "Arcane Fortitude" },
  { talentId: 75, tab: 81, row: 1, col: 2, rank: 5, maxRank: 5, spell: 12577, name: "Arcane Concentration" },
  { talentId: 81, tab: 81, row: 2, col: 1, rank: 3, maxRank: 3, spell: 12469, name: "Spell Impact" },
  { talentId: 1845, tab: 81, row: 2, col: 2, rank: 3, maxRank: 3, spell: 44399, name: "Student of the Mind" },
  { talentId: 2211, tab: 81, row: 2, col: 3, rank: 1, maxRank: 1, spell: 54646, name: "Focus Magic", spellbook: true },
  { talentId: 1142, tab: 81, row: 3, col: 2, rank: 3, maxRank: 3, spell: 18464, name: "Arcane Meditation" },
  { talentId: 2222, tab: 81, row: 3, col: 3, rank: 3, maxRank: 3, spell: 55340, name: "Torment the Weak" },
  { talentId: 86, tab: 81, row: 4, col: 1, rank: 1, maxRank: 1, spell: 12043, name: "Presence of Mind", spellbook: true },
  { talentId: 77, tab: 81, row: 4, col: 3, rank: 5, maxRank: 5, spell: 12503, name: "Arcane Mind" },
  { talentId: 421, tab: 81, row: 5, col: 1, rank: 3, maxRank: 3, spell: 15060, name: "Arcane Instability", dependsOn: { talentId: 86, rank: 1 } },
  { talentId: 1725, tab: 81, row: 5, col: 2, rank: 2, maxRank: 2, spell: 31572, name: "Arcane Potency", dependsOn: { talentId: 86, rank: 1 } },
  { talentId: 1727, tab: 81, row: 6, col: 0, rank: 3, maxRank: 3, spell: 31583, name: "Arcane Empowerment" },
  { talentId: 87, tab: 81, row: 6, col: 1, rank: 1, maxRank: 1, spell: 12042, name: "Arcane Power", spellbook: true, dependsOn: { talentId: 421, rank: 3 } },
  { talentId: 1843, tab: 81, row: 7, col: 1, rank: 2, maxRank: 2, spell: 44379, name: "Arcane Flows", dependsOn: { talentId: 87, rank: 1 } },
  { talentId: 1728, tab: 81, row: 7, col: 2, rank: 5, maxRank: 5, spell: 31588, name: "Mind Mastery" },
  { talentId: 2209, tab: 81, row: 8, col: 2, rank: 5, maxRank: 5, spell: 54490, name: "Missile Barrage" },
  { talentId: 1846, tab: 81, row: 9, col: 1, rank: 3, maxRank: 3, spell: 44403, name: "Netherwind Presence" },
  { talentId: 1826, tab: 81, row: 9, col: 2, rank: 2, maxRank: 2, spell: 35581, name: "Spell Power" },
  { talentId: 1847, tab: 81, row: 10, col: 1, rank: 1, maxRank: 1, spell: 44425, name: "Arcane Barrage", spellbook: true },
  { talentId: 1141, tab: 41, row: 0, col: 1, rank: 3, maxRank: 3, spell: 54734, name: "Incineration" },
  { talentId: 38, tab: 61, row: 0, col: 0, rank: 2, maxRank: 3, spell: 12496, name: "Frostbite" },
  { talentId: 62, tab: 61, row: 0, col: 2, rank: 3, maxRank: 3, spell: 55094, name: "Ice Floes" },
  { talentId: 1649, tab: 61, row: 1, col: 2, rank: 3, maxRank: 3, spell: 29440, name: "Precision" },
  { talentId: 65, tab: 61, row: 1, col: 3, rank: 2, maxRank: 3, spell: 12569, name: "Permafrost" },
  { talentId: 69, tab: 61, row: 2, col: 1, rank: 1, maxRank: 1, spell: 12472, name: "Icy Veins", spellbook: true },
];

// frostmage: 16 pieces, average item level 229.0, defense rating 0, hit rating 389, expertise rating 0
const FROSTMAGE_GEAR: readonly RaidGearLine[] = [
  { item: 50298, name: "Sightless Crown of Ulmaas", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 232, req: 80, classes: 262143, races: 2147483647, hit: 62, sockets: [1, 8], socketBonus: 3314, gems: [41285, 40132], enchant: 3820 },
  { item: 45933, name: "Pendant of the Shallow Grave", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [4], socketBonus: 2952, gems: [40155] },
  { item: 47751, name: "Khadgar's Shoulderpads of Conquest", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 232, req: 80, classes: 128, races: 2147483647, flags2: 2, sockets: [8], socketBonus: 3752, gems: [40132], enchant: 3810 },
  { item: 45272, name: "Robes of the Umbral Brute", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [4], socketBonus: 3752, gems: [40155], enchant: 3832 },
  { item: 50314, name: "Strip of Remorse", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 232, req: 80, classes: 32767, races: -1 },
  { item: 47750, name: "Khadgar's Leggings of Conquest", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 232, req: 80, classes: 128, races: 2147483647, flags2: 2, sockets: [4, 4], socketBonus: 3602, gems: [40155, 40155], enchant: 3721 },
  { item: 46050, name: "Starlight Treads", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [8, 4], socketBonus: 3311, gems: [40132, 40155], enchant: 3826 },
  { item: 47663, name: "Felspark Bindings", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 232, req: 80, classes: 32767, races: -1, flags2: 2, hit: 36, enchant: 2332 },
  { item: 47752, name: "Khadgar's Gauntlets of Conquest", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 232, req: 80, classes: 128, races: 32767, flags2: 2, sockets: [2], socketBonus: 3263, gems: [40113], enchant: 3246 },
  { item: 46046, name: "Nebula Band", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [4], socketBonus: 2952, gems: [40155] },
  { item: 45297, name: "Shimmering Seal", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, hit: 42, unique: true, sockets: [2], socketBonus: 3752, gems: [40113] },
  { item: 45148, name: "Living Flame", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: 262143, races: 32767, hit: 107, unique: true },
  { item: 45466, name: "Scale of Fates", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: 262143, races: 32767, unique: true },
  { item: 44005, name: "Pennant Cloak", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [8], socketBonus: 3752, gems: [40132], enchant: 3831 },
  { item: 50273, name: "Engraved Gargoyle Femur", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 232, req: 80, classes: -1, races: -1, hit: 113, enchant: 3854 },
  { item: 45294, name: "Petrified Ivy Sprig", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 232, req: 80, classes: -1, races: -1, hit: 29, sockets: [4], socketBonus: 2890, gems: [40155] },
];
const FROSTMAGE_TALENTS: readonly TalentPick[] = [
  { talentId: 74, tab: 81, row: 0, col: 0, rank: 2, maxRank: 2, spell: 12592, name: "Arcane Subtlety" },
  { talentId: 76, tab: 81, row: 0, col: 1, rank: 3, maxRank: 3, spell: 12840, name: "Arcane Focus" },
  { talentId: 75, tab: 81, row: 1, col: 2, rank: 5, maxRank: 5, spell: 12577, name: "Arcane Concentration" },
  { talentId: 81, tab: 81, row: 2, col: 1, rank: 3, maxRank: 3, spell: 12469, name: "Spell Impact" },
  { talentId: 1845, tab: 81, row: 2, col: 2, rank: 3, maxRank: 3, spell: 44399, name: "Student of the Mind" },
  { talentId: 2211, tab: 81, row: 2, col: 3, rank: 1, maxRank: 1, spell: 54646, name: "Focus Magic", spellbook: true },
  { talentId: 1142, tab: 81, row: 3, col: 2, rank: 1, maxRank: 3, spell: 18462, name: "Arcane Meditation" },
  { talentId: 37, tab: 61, row: 0, col: 1, rank: 5, maxRank: 5, spell: 16766, name: "Improved Frostbolt" },
  { talentId: 62, tab: 61, row: 0, col: 2, rank: 3, maxRank: 3, spell: 55094, name: "Ice Floes" },
  { talentId: 73, tab: 61, row: 1, col: 0, rank: 3, maxRank: 3, spell: 15047, name: "Ice Shards" },
  { talentId: 1649, tab: 61, row: 1, col: 2, rank: 3, maxRank: 3, spell: 29440, name: "Precision" },
  { talentId: 61, tab: 61, row: 2, col: 0, rank: 3, maxRank: 3, spell: 12953, name: "Piercing Ice" },
  { talentId: 69, tab: 61, row: 2, col: 1, rank: 1, maxRank: 1, spell: 12472, name: "Icy Veins", spellbook: true },
  { talentId: 66, tab: 61, row: 3, col: 1, rank: 3, maxRank: 3, spell: 12519, name: "Frost Channeling" },
  { talentId: 67, tab: 61, row: 3, col: 2, rank: 3, maxRank: 3, spell: 12983, name: "Shatter" },
  { talentId: 72, tab: 61, row: 4, col: 1, rank: 1, maxRank: 1, spell: 11958, name: "Cold Snap", spellbook: true },
  { talentId: 1737, tab: 61, row: 5, col: 0, rank: 2, maxRank: 2, spell: 55092, name: "Cold as Ice", dependsOn: { talentId: 72, rank: 1 } },
  { talentId: 68, tab: 61, row: 5, col: 2, rank: 3, maxRank: 3, spell: 28593, name: "Winter's Chill" },
  { talentId: 71, tab: 61, row: 6, col: 1, rank: 1, maxRank: 1, spell: 11426, name: "Ice Barrier", spellbook: true, dependsOn: { talentId: 72, rank: 1 } },
  { talentId: 1738, tab: 61, row: 6, col: 2, rank: 5, maxRank: 5, spell: 31678, name: "Arctic Winds" },
  { talentId: 1740, tab: 61, row: 7, col: 1, rank: 2, maxRank: 2, spell: 31683, name: "Empowered Frostbolt" },
  { talentId: 1853, tab: 61, row: 7, col: 2, rank: 2, maxRank: 2, spell: 44545, name: "Fingers of Frost" },
  { talentId: 1854, tab: 61, row: 8, col: 0, rank: 3, maxRank: 3, spell: 44549, name: "Brain Freeze" },
  { talentId: 1741, tab: 61, row: 8, col: 1, rank: 1, maxRank: 1, spell: 31687, name: "Summon Water Elemental", spellbook: true },
  { talentId: 1855, tab: 61, row: 8, col: 2, rank: 3, maxRank: 3, spell: 44561, name: "Enduring Winter", dependsOn: { talentId: 1741, rank: 1 } },
  { talentId: 1856, tab: 61, row: 9, col: 1, rank: 5, maxRank: 5, spell: 44571, name: "Chilled to the Bone" },
  { talentId: 1857, tab: 61, row: 10, col: 1, rank: 1, maxRank: 1, spell: 44572, name: "Deep Freeze", spellbook: true },
];

// combatrogue: 17 pieces, average item level 230.6, defense rating 0, hit rating 184, expertise rating 116
const COMBATROGUE_GEAR: readonly RaidGearLine[] = [
  { item: 50206, name: "Frayed Scoundrel's Cap", slot: SLOT.head, itemClass: 4, subclass: 2, inv: 1, ilvl: 232, req: 80, classes: 262143, races: 2147483647, sockets: [1, 4], socketBonus: 3303, gems: [41398, 40148], enchant: 3817 },
  { item: 47607, name: "Collar of Ceaseless Torment", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 232, req: 80, classes: 32767, races: -1, flags2: 2 },
  { item: 47832, name: "Spaulders of the Snow Bandit", slot: SLOT.shoulders, itemClass: 4, subclass: 2, inv: 3, ilvl: 232, req: 80, classes: 1535, races: -1, flags2: 2, sockets: [2], socketBonus: 3308, gems: [40130], enchant: 3808 },
  { item: 47739, name: "Armor of Shifting Shadows", slot: SLOT.chest, itemClass: 4, subclass: 2, inv: 5, ilvl: 232, req: 80, classes: 262143, races: 32767, flags2: 2, sockets: [4, 2], socketBonus: 3355, gems: [40148, 40112], enchant: 3832 },
  { item: 46095, name: "Soul-Devouring Cinch", slot: SLOT.waist, itemClass: 4, subclass: 2, inv: 6, ilvl: 226, req: 80, classes: -1, races: -1, expertise: 56, sockets: [2, 2], socketBonus: 1587, gems: [40112, 40112] },
  { item: 50269, name: "Fleshwerk Leggings", slot: SLOT.legs, itemClass: 4, subclass: 2, inv: 7, ilvl: 232, req: 80, classes: 262143, races: 2147483647, enchant: 3823 },
  { item: 50308, name: "Blighted Leather Footpads", slot: SLOT.feet, itemClass: 4, subclass: 2, inv: 8, ilvl: 232, req: 80, classes: 32767, races: -1, enchant: 3826 },
  { item: 50264, name: "Chewed Leather Wristguards", slot: SLOT.wrists, itemClass: 4, subclass: 2, inv: 9, ilvl: 232, req: 80, classes: -1, races: -1, hit: 46, enchant: 3845 },
  { item: 47719, name: "Gloves of the Silver Assassin", slot: SLOT.hands, itemClass: 4, subclass: 2, inv: 10, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, sockets: [2], socketBonus: 2877, gems: [40112], enchant: 1603 },
  { item: 46048, name: "Band of Lights", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, hit: 46, unique: true, sockets: [2], socketBonus: 2877, gems: [40112] },
  { item: 47703, name: "Planestalker Signet", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, hit: 38, unique: true, sockets: [4], socketBonus: 2877, gems: [40148] },
  { item: 46038, name: "Dark Matter", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: 262143, races: 32767, unique: true },
  { item: 50198, name: "Needle-Encrusted Scorpion", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, unique: true },
  { item: 46032, name: "Drape of the Faceless General", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: -1, races: -1, sockets: [2, 4], socketBonus: 3355, gems: [40112, 40148], enchant: 1099 },
  { item: 45947, name: "Serilas, Blood Blade of Invar One-Arm", slot: SLOT.mainHand, itemClass: 2, subclass: 7, inv: 13, ilvl: 232, req: 80, classes: -1, races: -1, hit: 32, expertise: 26, sockets: [4], socketBonus: 2864, gems: [40148], enchant: 3789 },
  { item: 50302, name: "Liar's Tongue", slot: SLOT.offHand, itemClass: 2, subclass: 7, inv: 13, ilvl: 232, req: 80, classes: -1, races: -1, expertise: 34, enchant: 3789 },
  { item: 45296, name: "Twirling Blades", slot: SLOT.ranged, itemClass: 2, subclass: 16, inv: 25, ilvl: 232, req: 80, classes: -1, races: -1, hit: 22, sockets: [2], socketBonus: 2877, gems: [40112] },
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
  { talentId: 186, tab: 181, row: 3, col: 2, rank: 3, maxRank: 3, spell: 13789, name: "Lightning Reflexes" },
  { talentId: 1122, tab: 181, row: 3, col: 3, rank: 5, maxRank: 5, spell: 61331, name: "Aggression" },
  { talentId: 223, tab: 181, row: 4, col: 1, rank: 1, maxRank: 1, spell: 13877, name: "Blade Flurry", spellbook: true },
  { talentId: 242, tab: 181, row: 4, col: 2, rank: 5, maxRank: 5, spell: 13964, name: "Hack and Slash" },
  { talentId: 1703, tab: 181, row: 5, col: 1, rank: 2, maxRank: 2, spell: 30920, name: "Weapon Expertise", dependsOn: { talentId: 223, rank: 1 } },
  { talentId: 1706, tab: 181, row: 5, col: 2, rank: 1, maxRank: 2, spell: 31124, name: "Blade Twisting" },
  { talentId: 1705, tab: 181, row: 6, col: 0, rank: 3, maxRank: 3, spell: 61329, name: "Vitality" },
  { talentId: 205, tab: 181, row: 6, col: 1, rank: 1, maxRank: 1, spell: 13750, name: "Adrenaline Rush", spellbook: true },
  { talentId: 1825, tab: 181, row: 7, col: 2, rank: 5, maxRank: 5, spell: 35553, name: "Combat Potency" },
  { talentId: 1709, tab: 181, row: 8, col: 1, rank: 1, maxRank: 1, spell: 32601, name: "Surprise Attacks", dependsOn: { talentId: 205, rank: 1 } },
  { talentId: 2074, tab: 181, row: 8, col: 2, rank: 2, maxRank: 2, spell: 58413, name: "Savage Combat" },
  { talentId: 2075, tab: 181, row: 9, col: 1, rank: 5, maxRank: 5, spell: 51689, name: "Prey on the Weak" },
  { talentId: 2076, tab: 181, row: 10, col: 1, rank: 1, maxRank: 1, spell: 51690, name: "Killing Spree", spellbook: true },
  { talentId: 2244, tab: 183, row: 0, col: 0, rank: 5, maxRank: 5, spell: 58425, name: "Relentless Strikes" },
];

// retpaladin: 16 pieces, average item level 228.6, defense rating 0, hit rating 272, expertise rating 178
const RETPALADIN_GEAR: readonly RaidGearLine[] = [
  { item: 44006, name: "Obsidian Greathelm", slot: SLOT.head, itemClass: 4, subclass: 4, inv: 1, ilvl: 226, req: 80, classes: -1, races: -1, expertise: 59, sockets: [1, 8], socketBonus: 3312, gems: [41398, 40129], enchant: 3817 },
  { item: 44664, name: "Favor of the Dragon Queen", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 226, req: 0, classes: 32767, races: -1, sockets: [8], socketBonus: 2936, gems: [40129] },
  { item: 46037, name: "Shoulderplates of the Celestial Watch", slot: SLOT.shoulders, itemClass: 4, subclass: 4, inv: 3, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [4, 2], socketBonus: 3316, gems: [40142, 40111], enchant: 3808 },
  { item: 48602, name: "Turalyon's Battleplate of Conquest", slot: SLOT.chest, itemClass: 4, subclass: 4, inv: 5, ilvl: 232, req: 80, classes: 2, races: 2147483647, flags2: 2, sockets: [8, 2], socketBonus: 3357, gems: [40129, 40111], enchant: 3832 },
  { item: 47614, name: "Girdle of the Impaler", slot: SLOT.waist, itemClass: 4, subclass: 4, inv: 6, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, sockets: [4], socketBonus: 3765, gems: [40142] },
  { item: 45982, name: "Fused Alloy Legplates", slot: SLOT.legs, itemClass: 4, subclass: 4, inv: 7, ilvl: 226, req: 80, classes: -1, races: -1, hit: 76, sockets: [4, 8], socketBonus: 3351, gems: [40142, 40129], enchant: 3823 },
  { item: 50305, name: "Grinning Skull Boots", slot: SLOT.feet, itemClass: 4, subclass: 4, inv: 8, ilvl: 232, req: 80, classes: 1535, races: -1, enchant: 3826 },
  { item: 45888, name: "Bitter Cold Armguards", slot: SLOT.wrists, itemClass: 4, subclass: 4, inv: 9, ilvl: 226, req: 80, classes: 1535, races: -1, sockets: [4], socketBonus: 2892, gems: [40142], enchant: 3845 },
  { item: 47609, name: "Gauntlets of Rising Anger", slot: SLOT.hands, itemClass: 4, subclass: 4, inv: 10, ilvl: 232, req: 80, classes: 32767, races: -1, flags2: 2, hit: 46, sockets: [4], socketBonus: 2908, gems: [40142], enchant: 1603 },
  { item: 47703, name: "Planestalker Signet", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, hit: 38, unique: true, sockets: [4], socketBonus: 2877, gems: [40142] },
  { item: 45540, name: "Bladebearer's Signet", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, hit: 46, expertise: 36, unique: true },
  { item: 46038, name: "Dark Matter", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 226, req: 80, classes: 262143, races: 32767, unique: true },
  { item: 47725, name: "Victor's Call", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, expertise: 83, unique: true },
  { item: 46032, name: "Drape of the Faceless General", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: -1, races: -1, sockets: [2, 4], socketBonus: 3355, gems: [40111, 40142], enchant: 1099 },
  { item: 46067, name: "Hammer of Crushing Whispers", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 5, inv: 17, ilvl: 232, req: 80, classes: -1, races: -1, hit: 66, sockets: [4, 8], socketBonus: 3357, gems: [40142, 40129], enchant: 3789 },
  { item: 45510, name: "Libram of Discord", slot: SLOT.ranged, itemClass: 4, subclass: 7, inv: 28, ilvl: 226, req: 80, classes: 32767, races: -1 },
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
  { talentId: 1481, tab: 381, row: 2, col: 2, rank: 1, maxRank: 1, spell: 20375, name: "Seal of Command", spellbook: true },
  { talentId: 1634, tab: 381, row: 2, col: 3, rank: 2, maxRank: 2, spell: 26023, name: "Pursuit of Justice" },
  { talentId: 1761, tab: 381, row: 3, col: 2, rank: 3, maxRank: 3, spell: 35397, name: "Sanctity of Battle" },
  { talentId: 1755, tab: 381, row: 3, col: 3, rank: 3, maxRank: 3, spell: 31868, name: "Crusade" },
  { talentId: 1410, tab: 381, row: 4, col: 0, rank: 3, maxRank: 3, spell: 20113, name: "Two-Handed Weapon Specialization" },
  { talentId: 1756, tab: 381, row: 4, col: 2, rank: 1, maxRank: 1, spell: 31869, name: "Sanctified Retribution" },
  { talentId: 1402, tab: 381, row: 5, col: 1, rank: 3, maxRank: 3, spell: 20057, name: "Vengeance", dependsOn: { talentId: 1411, rank: 5 } },
  { talentId: 1757, tab: 381, row: 5, col: 2, rank: 2, maxRank: 2, spell: 31872, name: "Divine Purpose" },
  { talentId: 2176, tab: 381, row: 6, col: 0, rank: 2, maxRank: 2, spell: 53488, name: "The Art of War" },
  { talentId: 1441, tab: 381, row: 6, col: 1, rank: 1, maxRank: 1, spell: 20066, name: "Repentance", spellbook: true },
  { talentId: 1758, tab: 381, row: 6, col: 2, rank: 3, maxRank: 3, spell: 31878, name: "Judgements of the Wise" },
  { talentId: 1759, tab: 381, row: 7, col: 1, rank: 3, maxRank: 3, spell: 31881, name: "Fanaticism", dependsOn: { talentId: 1441, rank: 1 } },
  { talentId: 2147, tab: 381, row: 7, col: 2, rank: 2, maxRank: 2, spell: 53376, name: "Sanctified Wrath" },
  { talentId: 2148, tab: 381, row: 8, col: 0, rank: 3, maxRank: 3, spell: 53648, name: "Swift Retribution" },
  { talentId: 1823, tab: 381, row: 8, col: 1, rank: 1, maxRank: 1, spell: 35395, name: "Crusader Strike", spellbook: true },
  { talentId: 2179, tab: 381, row: 8, col: 2, rank: 3, maxRank: 3, spell: 53503, name: "Sheath of Light" },
  { talentId: 2149, tab: 381, row: 9, col: 1, rank: 3, maxRank: 3, spell: 53382, name: "Righteous Vengeance" },
  { talentId: 2150, tab: 381, row: 10, col: 1, rank: 1, maxRank: 1, spell: 53385, name: "Divine Storm", spellbook: true },
];

// shadowpriest: 16 pieces, average item level 229.4, defense rating 0, hit rating 370, expertise rating 0
const SHADOWPRIEST_GEAR: readonly RaidGearLine[] = [
  { item: 50298, name: "Sightless Crown of Ulmaas", slot: SLOT.head, itemClass: 4, subclass: 1, inv: 1, ilvl: 232, req: 80, classes: 262143, races: 2147483647, hit: 62, sockets: [1, 8], socketBonus: 3314, gems: [41285, 40132], enchant: 3820 },
  { item: 45447, name: "Watchful Eye of Fate", slot: SLOT.neck, itemClass: 4, subclass: 0, inv: 2, ilvl: 226, req: 80, classes: -1, races: -1, sockets: [4], socketBonus: 2864, gems: [40155] },
  { item: 46068, name: "Amice of Inconceivable Horror", slot: SLOT.shoulders, itemClass: 4, subclass: 1, inv: 3, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [2, 4], socketBonus: 3311, gems: [40113, 40155], enchant: 3810 },
  { item: 48075, name: "Velen's Raiments of Conquest", slot: SLOT.chest, itemClass: 4, subclass: 1, inv: 20, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, sockets: [2, 8], socketBonus: 3602, gems: [40113, 40132], enchant: 3832 },
  { item: 50314, name: "Strip of Remorse", slot: SLOT.waist, itemClass: 4, subclass: 1, inv: 6, ilvl: 232, req: 80, classes: 32767, races: -1 },
  { item: 48074, name: "Velen's Pants of Conquest", slot: SLOT.legs, itemClass: 4, subclass: 1, inv: 7, ilvl: 232, req: 80, classes: 16, races: 2147483647, flags2: 2, hit: 80, sockets: [2, 8], socketBonus: 3602, gems: [40113, 40132], enchant: 3721 },
  { item: 46050, name: "Starlight Treads", slot: SLOT.feet, itemClass: 4, subclass: 1, inv: 8, ilvl: 226, req: 80, classes: 262143, races: 32767, sockets: [8, 4], socketBonus: 3311, gems: [40132, 40155], enchant: 3826 },
  { item: 44008, name: "Unsullied Cuffs", slot: SLOT.wrists, itemClass: 4, subclass: 1, inv: 9, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [2], socketBonus: 2890, gems: [40113], enchant: 2332 },
  { item: 47745, name: "Gloves of Looming Shadow", slot: SLOT.hands, itemClass: 4, subclass: 1, inv: 10, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, hit: 44, sockets: [4, 2], socketBonus: 3309, gems: [40155, 40113], enchant: 3246 },
  { item: 46046, name: "Nebula Band", slot: SLOT.finger1, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, unique: true, sockets: [4], socketBonus: 2952, gems: [40155] },
  { item: 45297, name: "Shimmering Seal", slot: SLOT.finger2, itemClass: 4, subclass: 0, inv: 11, ilvl: 226, req: 80, classes: -1, races: -1, hit: 42, unique: true, sockets: [2], socketBonus: 3752, gems: [40113] },
  { item: 50259, name: "Nevermelting Ice Crystal", slot: SLOT.trinket1, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, unique: true },
  { item: 47726, name: "Talisman of Volatile Power", slot: SLOT.trinket2, itemClass: 4, subclass: 0, inv: 12, ilvl: 232, req: 80, classes: -1, races: -1, flags2: 2, unique: true },
  { item: 44005, name: "Pennant Cloak", slot: SLOT.back, itemClass: 4, subclass: 1, inv: 16, ilvl: 226, req: 80, classes: 32767, races: -1, sockets: [8], socketBonus: 3752, gems: [40132], enchant: 3831 },
  { item: 50273, name: "Engraved Gargoyle Femur", slot: SLOT.mainHand, twoHand: true, itemClass: 2, subclass: 10, inv: 17, ilvl: 232, req: 80, classes: -1, races: -1, hit: 113, enchant: 3854 },
  { item: 45294, name: "Petrified Ivy Sprig", slot: SLOT.ranged, itemClass: 2, subclass: 19, inv: 26, ilvl: 232, req: 80, classes: -1, races: -1, hit: 29, sockets: [4], socketBonus: 2890, gems: [40155] },
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
  { talentId: 501, tab: 203, row: 2, col: 2, rank: 1, maxRank: 1, spell: 15407, name: "Mind Flay", spellbook: true },
  { talentId: 483, tab: 203, row: 3, col: 1, rank: 2, maxRank: 2, spell: 15311, name: "Veiled Shadows" },
  { talentId: 881, tab: 203, row: 3, col: 2, rank: 2, maxRank: 2, spell: 17323, name: "Shadow Reach" },
  { talentId: 461, tab: 203, row: 3, col: 3, rank: 3, maxRank: 3, spell: 15332, name: "Shadow Weaving" },
  { talentId: 484, tab: 203, row: 4, col: 1, rank: 1, maxRank: 1, spell: 15286, name: "Vampiric Embrace", spellbook: true },
  { talentId: 1638, tab: 203, row: 4, col: 2, rank: 2, maxRank: 2, spell: 27840, name: "Improved Vampiric Embrace", dependsOn: { talentId: 484, rank: 1 } },
  { talentId: 1777, tab: 203, row: 4, col: 3, rank: 3, maxRank: 3, spell: 33215, name: "Focused Mind" },
  { talentId: 1781, tab: 203, row: 5, col: 0, rank: 2, maxRank: 2, spell: 33371, name: "Mind Melt" },
  { talentId: 2267, tab: 203, row: 5, col: 2, rank: 3, maxRank: 3, spell: 63627, name: "Improved Devouring Plague" },
  { talentId: 521, tab: 203, row: 6, col: 1, rank: 1, maxRank: 1, spell: 15473, name: "Shadowform", spellbook: true, dependsOn: { talentId: 484, rank: 1 } },
  { talentId: 1778, tab: 203, row: 6, col: 2, rank: 5, maxRank: 5, spell: 33225, name: "Shadow Power" },
  { talentId: 1906, tab: 203, row: 7, col: 0, rank: 2, maxRank: 2, spell: 47570, name: "Improved Shadowform", dependsOn: { talentId: 521, rank: 1 } },
  { talentId: 1816, tab: 203, row: 7, col: 2, rank: 3, maxRank: 3, spell: 33193, name: "Misery" },
  { talentId: 1779, tab: 203, row: 8, col: 1, rank: 1, maxRank: 1, spell: 34914, name: "Vampiric Touch", spellbook: true, dependsOn: { talentId: 521, rank: 1 } },
  { talentId: 1909, tab: 203, row: 8, col: 2, rank: 3, maxRank: 3, spell: 47582, name: "Pain and Suffering" },
  { talentId: 1907, tab: 203, row: 9, col: 2, rank: 5, maxRank: 5, spell: 51167, name: "Twisted Faith" },
  { talentId: 1910, tab: 203, row: 10, col: 1, rank: 1, maxRank: 1, spell: 47585, name: "Dispersion", spellbook: true, dependsOn: { talentId: 1779, rank: 1 } },
];


/**
 * A spec's glyph row in slot order from its three majors and three minors:
 * GlyphSlot.dbc orders the six slots major, minor, minor, major, minor, major
 * (TypeFlags 0, 1, 1, 0, 1, 0), and `_LoadGlyphAuras` drops a glyph whose
 * GlyphProperties.dbc TypeFlags is not its slot's.
 */
export const GLYPH_SLOT_MAJOR = [true, false, false, true, false, true] as const;
type GlyphId = { glyph: number; name: string };
function glyphRow(majors: readonly [GlyphId, GlyphId, GlyphId], minors: readonly [GlyphId, GlyphId, GlyphId]): readonly GlyphPick[] {
  const M = [...majors];
  const m = [...minors];
  return GLYPH_SLOT_MAJOR.map((major) => ({ ...(major ? M.shift()! : m.shift()!), major }));
}
const PROTWARRIOR_GLYPHS = glyphRow([{ glyph: 493, name: "Devastate" }, { glyph: 764, name: "Vigilance" }, { glyph: 502, name: "Blocking" }], [{ glyph: 483, name: "Battle" }, { glyph: 851, name: "Command" }, { glyph: 487, name: "Thunder Clap" }]);
const PROTPALADIN_GLYPHS = glyphRow([{ glyph: 561, name: "Seal of Vengeance" }, { glyph: 702, name: "Hammer of the Righteous" }, { glyph: 705, name: "Divine Plea" }], [{ glyph: 452, name: "Blessing of Kings" }, { glyph: 453, name: "Blessing of Might" }, { glyph: 455, name: "Lay on Hands" }]);
const HOLYPRIEST_GLYPHS = glyphRow([{ glyph: 251, name: "Circle of Healing" }, { glyph: 264, name: "Prayer of Healing" }, { glyph: 709, name: "Guardian Spirit" }], [{ glyph: 460, name: "Fortitude" }, { glyph: 462, name: "Shadow Protection" }, { glyph: 458, name: "Fading" }]);
const DISCPRIEST_GLYPHS = glyphRow([{ glyph: 263, name: "Power Word: Shield" }, { glyph: 710, name: "Penance" }, { glyph: 255, name: "Flash Heal" }], [{ glyph: 460, name: "Fortitude" }, { glyph: 462, name: "Shadow Protection" }, { glyph: 458, name: "Fading" }]);
const HOLYPALADIN_GLYPHS = glyphRow([{ glyph: 196, name: "Holy Light" }, { glyph: 199, name: "Seal of Wisdom" }, { glyph: 701, name: "Beacon of Light" }], [{ glyph: 454, name: "Blessing of Wisdom" }, { glyph: 455, name: "Lay on Hands" }, { glyph: 452, name: "Blessing of Kings" }]);
const ARCANEMAGE_GLYPHS = glyphRow([{ glyph: 312, name: "Arcane Missiles" }, { glyph: 651, name: "Arcane Blast" }, { glyph: 328, name: "Molten Armor" }], [{ glyph: 445, name: "Arcane Intellect" }, { glyph: 446, name: "Fire Ward" }, { glyph: 451, name: "Slow Fall" }]);
const FROSTMAGE_GLYPHS = glyphRow([{ glyph: 319, name: "Frostbolt" }, { glyph: 871, name: "Eternal Water" }, { glyph: 328, name: "Molten Armor" }], [{ glyph: 445, name: "Arcane Intellect" }, { glyph: 446, name: "Fire Ward" }, { glyph: 451, name: "Slow Fall" }]);
const COMBATROGUE_GLYPHS = glyphRow([{ glyph: 715, name: "Killing Spree" }, { glyph: 410, name: "Slice and Dice" }, { glyph: 391, name: "Adrenaline Rush" }], [{ glyph: 468, name: "Blurred Speed" }, { glyph: 467, name: "Safe Fall" }, { glyph: 464, name: "Distract" }]);
const RETPALADIN_GLYPHS = glyphRow([{ glyph: 183, name: "Judgement" }, { glyph: 561, name: "Seal of Vengeance" }, { glyph: 189, name: "Consecration" }], [{ glyph: 456, name: "Sense Undead" }, { glyph: 453, name: "Blessing of Might" }, { glyph: 455, name: "Lay on Hands" }]);
const SHADOWPRIEST_GLYPHS = glyphRow([{ glyph: 262, name: "Shadow" }, { glyph: 269, name: "Mind Flay" }, { glyph: 261, name: "Shadow Word: Pain" }], [{ glyph: 460, name: "Fortitude" }, { glyph: 462, name: "Shadow Protection" }, { glyph: 463, name: "Shadowfiend" }]);

/** One-Handed Swords (spell 201, skill 43, item subclass 7), which a Human rogue does not start with: a weapon master's. */
const ONE_HANDED_SWORDS: WeaponSkill = { spell: 201, skill: 43, subclass: 7, name: "One-Handed Swords" };

const raid = (l: Omit<RaidLoadout, "level" | "bags" | "money"> & { bags?: readonly StockLine[] }): RaidLoadout => ({ ...l, level: RAID_LEVEL, bags: l.bags ?? BAGS, money: RAID_MONEY });

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
    talents: PROTWARRIOR_TALENTS, gear: PROTWARRIOR_GEAR, supplies: WARRIOR_TANK_SUPPLIES, glyphs: PROTWARRIOR_GLYPHS,
  }),
  protpaladin: raid({
    id: "protpaladin", spec: "protection", partyRole: "tank", race: 3, class: 2, label: "Dwarf Paladin (Protection)", namePrefix: "Tank", trainerId: 3,
    questSpells: PALADIN_QUEST, trainerLearns: PALADIN_LEARNS, trainerExclude: PALADIN_EXCLUDE,
    // Righteous Fury, Avenger's Shield 5, Holy Shield 6, Consecration 8, Hammer of the Righteous, Redemption 7,
    // and Divine Plea, which this tank's mana leans on (its gear carries no intellect).
    keySpells: [25780, 48827, 48952, 48819, 53595, 48950, 54428],
    talents: PROTPALADIN_TALENTS, gear: PROTPALADIN_GEAR, supplies: PALADIN_TANK_SUPPLIES, glyphs: PROTPALADIN_GLYPHS,
  }),
  holypriest: raid({
    id: "holypriest", spec: "holy", partyRole: "healer", race: 3, class: 5, label: "Dwarf Priest (Holy)", namePrefix: "Heal", trainerId: 11,
    questSpells: [],
    // Greater Heal 9, Renew 14, Circle of Healing 7, Prayer of Mending 3, Guardian Spirit, Resurrection 7.
    keySpells: [48063, 48068, 48089, 48113, 47788, 48171],
    talents: HOLYPRIEST_TALENTS, gear: HOLYPRIEST_GEAR, supplies: PRIEST_HEALER_SUPPLIES, glyphs: HOLYPRIEST_GLYPHS,
  }),
  discpriest: raid({
    id: "discpriest", spec: "discipline", partyRole: "healer", race: 3, class: 5, label: "Dwarf Priest (Discipline)", namePrefix: "Heal", trainerId: 11,
    questSpells: [],
    // Power Word: Shield 14, Penance 4, Power Infusion, Pain Suppression, Flash Heal 11, Resurrection 7.
    keySpells: [48066, 53007, 10060, 33206, 48071, 48171],
    talents: DISCPRIEST_TALENTS, gear: DISCPRIEST_GEAR, supplies: PRIEST_HEALER_SUPPLIES, glyphs: DISCPRIEST_GLYPHS,
  }),
  holypaladin: raid({
    id: "holypaladin", spec: "holy", partyRole: "healer", race: 3, class: 2, label: "Dwarf Paladin (Holy)", namePrefix: "Heal", trainerId: 3,
    questSpells: PALADIN_QUEST, trainerLearns: PALADIN_LEARNS, trainerExclude: PALADIN_EXCLUDE,
    // Holy Light 13, Flash of Light 9, Holy Shock 7, Beacon of Light, Divine Plea, Redemption 7.
    keySpells: [48782, 48785, 48825, 53563, 54428, 48950],
    talents: HOLYPALADIN_TALENTS, gear: HOLYPALADIN_GEAR, supplies: PALADIN_HEALER_SUPPLIES, glyphs: HOLYPALADIN_GLYPHS,
  }),
  arcanemage: raid({
    id: "arcanemage", spec: "arcane", partyRole: "damage", race: 1, class: 8, label: "Human Mage (Arcane)", namePrefix: "Mage", trainerId: 16,
    questSpells: [],
    // Arcane Blast 4, Arcane Missiles 13, Arcane Barrage 3, Arcane Power, Arcane Brilliance 3, Mage Armor 6.
    keySpells: [42897, 42846, 44781, 12042, 43002, 43024],
    talents: ARCANEMAGE_TALENTS, gear: ARCANEMAGE_GEAR, supplies: MAGE_SUPPLIES, glyphs: ARCANEMAGE_GLYPHS,
  }),
  frostmage: raid({
    id: "frostmage", spec: "frost", partyRole: "damage", race: 1, class: 8, label: "Human Mage (Frost)", namePrefix: "Mage", trainerId: 16,
    questSpells: [],
    // Frostbolt 16, Ice Lance 3, Ice Barrier 8, Summon Water Elemental, Deep Freeze, Arcane Brilliance 3.
    keySpells: [42842, 42914, 43039, 31687, 44572, 43002],
    talents: FROSTMAGE_TALENTS, gear: FROSTMAGE_GEAR, supplies: MAGE_SUPPLIES, glyphs: FROSTMAGE_GLYPHS,
  }),
  combatrogue: raid({
    id: "combatrogue", spec: "combat", partyRole: "damage", race: 1, class: 4, label: "Human Rogue (Combat)", namePrefix: "Rogue", trainerId: 9,
    questSpells: [{ spell: 2842, name: "Poisons" }],
    // Sinister Strike 12, Eviscerate 12, Rupture 9, Blade Flurry, Adrenaline Rush, Killing Spree.
    keySpells: [48638, 48668, 48672, 13877, 13750, 51690],
    talents: COMBATROGUE_TALENTS, gear: COMBATROGUE_GEAR, supplies: ROGUE_SUPPLIES, glyphs: COMBATROGUE_GLYPHS,
    weaponSkills: [ONE_HANDED_SWORDS],
  }),
  retpaladin: raid({
    id: "retpaladin", spec: "retribution", partyRole: "damage", race: 3, class: 2, label: "Dwarf Paladin (Retribution)", namePrefix: "Pala", trainerId: 3,
    questSpells: PALADIN_QUEST, trainerLearns: PALADIN_LEARNS, trainerExclude: PALADIN_EXCLUDE,
    // Seal of Vengeance, Crusader Strike, Divine Storm, Exorcism 9, Hammer of Wrath 6, Blessing of Might 10.
    keySpells: [31801, 35395, 53385, 48801, 48806, 48932],
    talents: RETPALADIN_TALENTS, gear: RETPALADIN_GEAR, supplies: RET_SUPPLIES, glyphs: RETPALADIN_GLYPHS,
  }),
  shadowpriest: raid({
    id: "shadowpriest", spec: "shadow", partyRole: "damage", race: 3, class: 5, label: "Dwarf Priest (Shadow)", namePrefix: "Priest", trainerId: 11,
    questSpells: [],
    // Mind Blast 13, Mind Flay 9, Vampiric Touch 5, Shadowform, Shadow Word: Pain 12, Devouring Plague 9.
    keySpells: [48127, 48156, 48160, 15473, 48125, 48300],
    talents: SHADOWPRIEST_TALENTS, gear: SHADOWPRIEST_GEAR, supplies: SHADOW_SUPPLIES, glyphs: SHADOWPRIEST_GLYPHS,
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
 * weapon subclasses, as `item_template` numbers them. A loadout's
 * `weaponSkills` add theirs (the rogue's swords).
 */
export const PROFICIENCY: Readonly<Record<number, { armor: readonly number[]; weapons: readonly number[]; dualWield: boolean }>> = {
  // Warrior (Human): cloth to plate, shields; axes, maces, swords one- and two-handed, daggers, thrown.
  1: { armor: [0, 1, 2, 3, 4, 6], weapons: [0, 1, 4, 5, 7, 8, 15, 16], dualWield: false },
  // Paladin (Dwarf): cloth to plate, shields, librams; maces and swords one- and two-handed.
  2: { armor: [0, 1, 2, 3, 4, 6, 7], weapons: [4, 5, 7, 8], dualWield: false },
  // Rogue (Human): cloth, leather; daggers, thrown; Dual Wield from creation. Swords are a weapon master's (`weaponSkills`).
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
 * by its class and race at 80 (level, class and race masks, never Horde-only,
 * proficiency or a staged weapon skill, the slot's inventory type, a
 * one-hander in the off hand only with Dual Wield, the checks
 * `Player::CanUseItem` and `CanEquipItem` make), every slot filled, no unique
 * piece twice, the two-hander in the main hand alone; every enchant one its
 * enchanting spell puts on that piece, and every socket holding a known gem
 * of its colour, a meta gem only in a meta socket, the set's meta gem active.
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
    if (g.races !== -1 && (g.races & (1 << (l.race - 1))) === 0) out.push(`${what} is not for race ${l.race} (AllowableRace ${g.races})`);
    if (((g.flags2 ?? 0) & ITEM_FLAG2_FACTION_HORDE) !== 0) out.push(`${what} is Horde-only; the raid is Alliance`);
    if (g.itemClass === 2 && !prof.weapons.includes(g.subclass) && !(l.weaponSkills ?? []).some((w) => w.subclass === g.subclass)) {
      out.push(`${what}: weapon subclass ${g.subclass} is not a class ${l.class} skill`);
    }
    if (g.itemClass !== 2 && g.itemClass !== 4) out.push(`${what}: item class ${g.itemClass} is not worn`);
    if (!(SLOT_TAKES[g.slot] ?? []).includes(g.inv)) out.push(`${what}: inventory type ${g.inv} does not go in slot ${g.slot}`);
    if (g.slot === SLOT.offHand && g.inv === 13 && !prof.dualWield) out.push(`${what}: a one-hander in the off hand needs Dual Wield`);
    if ((g.inv === 17) !== (g.twoHand === true)) out.push(`${what}: twoHand must mark exactly the two-handers`);
    out.push(...enchantProblems(g).map((p) => `${what}: ${p}`));
  }
  if (!metaGemActive(l)) out.push(`${l.id}: its meta gem's condition is not met by the gems it wears`);
  const filled = new Set(l.gear.map((g) => g.slot));
  for (const s of raidSlots(l)) if (!filled.has(s)) out.push(`${l.id}: slot ${s} is empty`);
  const uniques = l.gear.filter((g) => g.unique).map((g) => g.item);
  for (const u of new Set(uniques.filter((x, i) => uniques.indexOf(x) !== i))) out.push(`${l.id}: unique item ${u} twice`);
  return out;
}

/** `ITEM_FLAG2_FACTION_HORDE`: only a Horde character can use the item. */
export const ITEM_FLAG2_FACTION_HORDE = 1;

/** Gem colours (GemProperties.dbc `color`, and `socketColor_n`): a hybrid gem carries two bits and fits either socket. */
export const GEM_COLOR = { meta: 1, red: 2, yellow: 4, blue: 8 } as const;

/**
 * The cut gems the raid wears: the item, the SpellItemEnchantment.dbc id its
 * GemProperties.dbc row puts in a socket, and its colour. All crafted by a
 * jewelcrafter and usable by anyone: none unique, none limited, none a
 * jewelcrafter's own.
 */
export const GEMS: Readonly<Record<number, { name: string; enchant: number; color: number }>> = {
  40111: { name: "Bold Cardinal Ruby", enchant: 3518, color: 2 },
  40112: { name: "Delicate Cardinal Ruby", enchant: 3519, color: 2 },
  40113: { name: "Runed Cardinal Ruby", enchant: 3520, color: 2 },
  40119: { name: "Solid Majestic Zircon", enchant: 3532, color: 8 },
  40123: { name: "Brilliant King's Amber", enchant: 3526, color: 4 },
  40129: { name: "Sovereign Dreadstone", enchant: 3536, color: 10 },
  40130: { name: "Shifting Dreadstone", enchant: 3537, color: 10 },
  40132: { name: "Glowing Dreadstone", enchant: 3538, color: 10 },
  40133: { name: "Purified Dreadstone", enchant: 3545, color: 10 },
  40139: { name: "Defender's Dreadstone", enchant: 3541, color: 10 },
  40142: { name: "Inscribed Ametrine", enchant: 3549, color: 6 },
  40148: { name: "Glinting Ametrine", enchant: 3555, color: 6 },
  40151: { name: "Luminous Ametrine", enchant: 3558, color: 6 },
  40155: { name: "Reckless Ametrine", enchant: 3563, color: 6 },
  40167: { name: "Enduring Eye of Zul", enchant: 3575, color: 12 },
  41285: { name: "Chaotic Skyflare Diamond", enchant: 3621, color: 1 },
  41380: { name: "Austere Earthsiege Diamond", enchant: 3637, color: 1 },
  41398: { name: "Relentless Earthsiege Diamond", enchant: 3628, color: 1 },
  41401: { name: "Insightful Earthsiege Diamond", enchant: 3627, color: 1 },
};

/**
 * Each meta gem's activation condition (SpellItemEnchantmentCondition.dbc,
 * every clause "at least `count` gems of `color`", comparator 5): what
 * `Player::EnchantmentFitsRequirements` counts over the worn sockets.
 */
export const META_CONDITIONS: Readonly<Record<number, readonly { color: number; atLeast: number }[]>> = {
  // Chaotic Skyflare Diamond (condition 142): two blue.
  41285: [{ color: 8, atLeast: 2 }],
  // Austere Earthsiege Diamond (152): two blue and one red.
  41380: [{ color: 8, atLeast: 2 }, { color: 2, atLeast: 1 }],
  // Relentless and Insightful Earthsiege Diamond (149, 147): one each of red, yellow and blue.
  41398: [{ color: 2, atLeast: 1 }, { color: 4, atLeast: 1 }, { color: 8, atLeast: 1 }],
  41401: [{ color: 2, atLeast: 1 }, { color: 4, atLeast: 1 }, { color: 8, atLeast: 1 }],
};

/**
 * The permanent enchants the raid wears, each with the equipped-item masks of
 * the spell that applies it (Spell.dbc `EquippedItemClass`,
 * `EquippedItemSubClassMask`, `EquippedItemInventoryTypeMask`, 0 for any
 * slot): what the enchant goes on. None needs a profession
 * (SpellItemEnchantment.dbc `requiredSkill` 0), none more than level 80.
 */
export const ENCHANTS: Readonly<Record<number, { name: string; itemClass: number; subclassMask: number; invTypeMask: number }>> = {
  1099: { name: "Enchant Cloak - Major Agility", itemClass: 4, subclassMask: 30, invTypeMask: 65536 },
  1128: { name: "Enchant Shield - Greater Intellect", itemClass: 4, subclassMask: 64, invTypeMask: 0 },
  1603: { name: "Enchant Gloves - Crusher", itemClass: 4, subclassMask: 30, invTypeMask: 1024 },
  1952: { name: "Enchant Shield - Defense", itemClass: 4, subclassMask: 64, invTypeMask: 0 },
  2332: { name: "Enchant Bracers - Superior Spellpower", itemClass: 4, subclassMask: 30, invTypeMask: 512 },
  3232: { name: "Enchant Boots - Tuskarr's Vitality", itemClass: 4, subclassMask: 30, invTypeMask: 256 },
  3246: { name: "Enchant Gloves - Exceptional Spellpower", itemClass: 4, subclassMask: 30, invTypeMask: 1024 },
  3253: { name: "Enchant Gloves - Armsman", itemClass: 4, subclassMask: 31, invTypeMask: 1024 },
  3294: { name: "Enchant Cloak - Mighty Armor", itemClass: 4, subclassMask: 30, invTypeMask: 65536 },
  3719: { name: "Brilliant Spellthread", itemClass: 4, subclassMask: 31, invTypeMask: 128 },
  3721: { name: "Sapphire Spellthread", itemClass: 4, subclassMask: 31, invTypeMask: 128 },
  3789: { name: "Enchant Weapon - Berserking", itemClass: 2, subclassMask: 173555, invTypeMask: 0 },
  3808: { name: "Greater Inscription of the Axe", itemClass: 4, subclassMask: 31, invTypeMask: 8 },
  3809: { name: "Greater Inscription of the Crag", itemClass: 4, subclassMask: 31, invTypeMask: 8 },
  3810: { name: "Greater Inscription of the Storm", itemClass: 4, subclassMask: 31, invTypeMask: 8 },
  3811: { name: "Greater Inscription of the Pinnacle", itemClass: 4, subclassMask: 31, invTypeMask: 8 },
  3817: { name: "Arcanum of Torment", itemClass: 4, subclassMask: 31, invTypeMask: 2 },
  3818: { name: "Arcanum of the Stalwart Protector", itemClass: 4, subclassMask: 31, invTypeMask: 2 },
  3819: { name: "Arcanum of Blissful Mending", itemClass: 4, subclassMask: 31, invTypeMask: 2 },
  3820: { name: "Arcanum of Burning Mysteries", itemClass: 4, subclassMask: 31, invTypeMask: 2 },
  3822: { name: "Frosthide Leg Armor", itemClass: 4, subclassMask: 31, invTypeMask: 128 },
  3823: { name: "Icescale Leg Armor", itemClass: 4, subclassMask: 31, invTypeMask: 128 },
  3826: { name: "Enchant Boots - Icewalker", itemClass: 4, subclassMask: 30, invTypeMask: 256 },
  3831: { name: "Enchant Cloak - Greater Speed", itemClass: 4, subclassMask: 30, invTypeMask: 65536 },
  3832: { name: "Enchant Chest - Powerful Stats", itemClass: 4, subclassMask: 30, invTypeMask: 1048608 },
  3834: { name: "Enchant Weapon - Mighty Spellpower", itemClass: 2, subclassMask: 177651, invTypeMask: 0 },
  3845: { name: "Enchant Bracers - Greater Assault", itemClass: 4, subclassMask: 30, invTypeMask: 512 },
  3850: { name: "Enchant Bracers - Major Stamina", itemClass: 4, subclassMask: 30, invTypeMask: 512 },
  3854: { name: "Enchant Staff - Greater Spellpower", itemClass: 2, subclassMask: 1024, invTypeMask: 0 },
  3869: { name: "Enchant Weapon - Blade Ward", itemClass: 2, subclassMask: 189939, invTypeMask: 0 },
};

/** Why a piece's enchant or gems would not be what a client could put on it, or nothing. */
export function enchantProblems(g: RaidGearLine): string[] {
  const out: string[] = [];
  if (g.enchant !== undefined) {
    const e = ENCHANTS[g.enchant];
    if (!e) out.push(`enchant ${g.enchant} is not one of ENCHANTS`);
    else {
      const fits = e.itemClass === g.itemClass && (e.subclassMask & (1 << g.subclass)) !== 0 && (e.invTypeMask === 0 || (e.invTypeMask & (1 << g.inv)) !== 0);
      if (!fits) out.push(`${e.name} (${g.enchant}) does not go on item class ${g.itemClass}/${g.subclass}, inventory type ${g.inv}`);
    }
  }
  const sockets = g.sockets ?? [];
  const gems = g.gems ?? [];
  if (gems.length !== sockets.length) out.push(`${gems.length} gems for ${sockets.length} sockets`);
  gems.forEach((gem, i) => {
    const info = GEMS[gem];
    const socket = sockets[i] ?? 0;
    if (!info) out.push(`gem ${gem} is not one of GEMS`);
    else if ((info.color & socket) === 0) out.push(`${info.name} (colour ${info.color}) does not fit socket ${i + 1} (colour ${socket})`);
    else if ((info.color === GEM_COLOR.meta) !== (socket === GEM_COLOR.meta)) out.push(`${info.name}: a meta gem goes in the meta socket only`);
  });
  return out;
}

/** Whether every socket holds a gem of its colour, so the socket bonus is on (`Item::GemsFitSockets`). */
export function gemsFitSockets(g: RaidGearLine): boolean {
  const sockets = g.sockets ?? [];
  return sockets.length > 0 && sockets.every((socket, i) => ((GEMS[g.gems?.[i] ?? 0]?.color ?? 0) & socket) !== 0);
}

/** Whether the set's meta gem (if any) is active: each clause of its condition met by the colours of every gem worn. */
export function metaGemActive(l: Pick<RaidLoadout, "gear">): boolean {
  const gems = l.gear.flatMap((g) => g.gems ?? []);
  const count = (bit: number) => gems.filter((gem) => ((GEMS[gem]?.color ?? 0) & bit) !== 0).length;
  return gems.filter((gem) => GEMS[gem]?.color === GEM_COLOR.meta).every((meta) => (META_CONDITIONS[meta] ?? [{ color: 0, atLeast: 1 }]).every((c) => count(c.color) >= c.atLeast));
}

/** The enchantment slots (`EnchantmentSlot`) a client's enchanting and socketing write. */
export const ENCHANT_SLOT = { perm: 0, socket1: 2, socket2: 3, socket3: 4, bonus: 5 } as const;

/**
 * The `item_instance.enchantments` text for a piece, in `Item::SaveToDB`'s form
 * (twelve slots of id, duration and charges, each number followed by a
 * space), or undefined for a piece with neither enchant nor gems. The
 * permanent enchant goes in slot 0 and each gem's enchant in its socket's
 * slot (2-4), duration and charges 0, as `Spell::EffectEnchantItemPerm` and
 * `WorldSession::HandleSocketOpcode` set them; the item's socket bonus in slot 5
 * when every socket holds a gem of its colour, as the socket handler does.
 */
export function itemEnchantments(g: RaidGearLine): string | undefined {
  if (g.enchant === undefined && !(g.gems ?? []).length) return undefined;
  const ids = new Array<number>(12).fill(0);
  if (g.enchant !== undefined) ids[ENCHANT_SLOT.perm] = g.enchant;
  (g.gems ?? []).forEach((gem, i) => {
    const info = GEMS[gem];
    if (!info) throw new Error(`gem ${gem} on ${g.name} (${g.item}) is not one of GEMS`);
    ids[ENCHANT_SLOT.socket1 + i] = info.enchant;
  });
  if (g.socketBonus && gemsFitSockets(g)) ids[ENCHANT_SLOT.bonus] = g.socketBonus;
  return ids.map((id) => `${id} 0 0 `).join("");
}

/** Melee hit, spell hit and expertise rating per point at 80 (gtCombatRatings: CR_HIT_MELEE, CR_HIT_SPELL, CR_EXPERTISE). */
export const HIT_RATING_PER_PCT = 32.79;
export const SPELL_HIT_RATING_PER_PCT = 26.232;
export const EXPERTISE_RATING_PER_POINT = 8.1975;

/**
 * What each loadout's gear alone must reach, before gems and enchants, as a
 * rating: the tanks' 540 defense (140 skill, 689 rating); the melee's 8%
 * special-attack hit against a level-83 boss and 26 expertise (a boss's 6.5%
 * dodge); the casters' 17% spell hit. Each less what the build's own talents
 * and racial give, which is why each figure is what it is:
 *
 * - protwarrior: 26 expertise less Vitality's 6 and the Human's Sword
 *   Specialization 3 (a one-handed sword) = 17.
 * - protpaladin: 26 less Combat Expertise's 6 and the Dwarf's Mace
 *   Specialization 5 (a one-handed mace) = 15.
 * - combatrogue: 8% hit less Precision's 5% = 3%; 26 expertise less Weapon
 *   Expertise's 10 and Sword Specialization's 3 = 13.
 * - retpaladin: 8% hit; 26 expertise less Mace Specialization's 5 (a
 *   two-handed mace) = 21.
 * - arcanemage: 17% less Arcane Focus's 3% (its arcane spells) and
 *   Precision's 3% = 11%.
 * - frostmage: 17% less Precision's 3% = 14%.
 * - shadowpriest: 17% less Shadow Focus's 3% = 14%.
 *
 * Healers have none: a heal does not miss.
 */
export const RAID_CAPS: Readonly<Partial<Record<RaidLoadoutId, { defense?: number; hit?: number; expertise?: number }>>> = {
  protwarrior: { defense: 689, expertise: Math.ceil(17 * EXPERTISE_RATING_PER_POINT) },
  protpaladin: { defense: 689, expertise: Math.ceil(15 * EXPERTISE_RATING_PER_POINT) },
  combatrogue: { hit: Math.ceil(3 * HIT_RATING_PER_PCT), expertise: Math.ceil(13 * EXPERTISE_RATING_PER_POINT) },
  retpaladin: { hit: Math.ceil(8 * HIT_RATING_PER_PCT), expertise: Math.ceil(21 * EXPERTISE_RATING_PER_POINT) },
  arcanemage: { hit: Math.ceil(11 * SPELL_HIT_RATING_PER_PCT) },
  frostmage: { hit: Math.ceil(14 * SPELL_HIT_RATING_PER_PCT) },
  shadowpriest: { hit: Math.ceil(14 * SPELL_HIT_RATING_PER_PCT) },
};

/** A raid set's total of one rating, from the gear alone. */
export function gearRating(l: Pick<RaidLoadout, "gear">, stat: "defense" | "hit" | "expertise"): number {
  return l.gear.reduce((n, g) => n + (g[stat] ?? 0), 0);
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
