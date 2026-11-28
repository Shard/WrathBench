/**
 * The party eval's loadouts (docs/proposals/GROUP-PLAY.md §3): five
 * Alliance characters at level 20, a warrior tank, a priest healer, and a
 * mage, a rogue and a paladin, in quest-level greens, with talents preset
 * per role and standing in Moonbrook. The third damage dealer was a hunter
 * until the operator's call of 2026-10-19 made it a Retribution paladin, so
 * no pet ever needs staging (a pet is a `character_pet` row numbered from a
 * generator the server seeds at boot, the same class of problem as item
 * guids). Data plus the pure checks over it; the
 * stager (`stage-party.ts`) is what puts a character into one.
 *
 * Operator tooling, like the rest of this directory: nothing in `runner/` or
 * `sdk/` imports it, and the agent never sees anything here but the character
 * it is handed.
 *
 * Where the numbers come from. Every id below was read off the pinned core's
 * base world SQL (`item_template`, `quest_template`, `trainer_spell`,
 * `playercreateinfo`, `playercreateinfo_skills`) and the client's own
 * `Talent.dbc` / `TalentTab.dbc` / `Spell.dbc` on the data volume, not typed
 * from memory; the names ride along so a reader can check them.
 *
 * - Gear is uncommon (green) quest rewards of Alliance-reachable quests of
 *   level 15-26, item level 16-27, without a random suffix. GROUP-PLAY.md
 *   asked for "required level 15-20"; nearly every quest green of this band
 *   carries required level 0, so item level and quest level are the
 *   constraint instead. Every piece is wearable by its class and race at 20
 *   with the proficiencies the character starts with (`playercreateinfo_skills`:
 *   the warrior and paladin have mail, the warrior shields, the paladin
 *   two-handed maces, the rogue daggers, the priest and mage staves and wands).
 * - Spells are the class trainer's, read from the world DB at staging time
 *   (`trainer_spell` for `trainerId` up to the party level: the table the
 *   pinned core loads, `ObjectMgr::LoadTrainers`; the design named the
 *   pre-port `npc_trainer`, which the core no longer reads), plus the spells
 *   the class quests teach by level 20, which no trainer lists: the warrior's
 *   Defensive Stance, Taunt and Sunder Armor (the level-10 quests' reward
 *   spell 8121) and the paladin's Redemption (7328, the level-12 quest). A
 *   trainer entry can be a learn-effect spell that teaches others rather
 *   than being one; the pod mounts no client data to tell, so each such entry
 *   up to level 20 was resolved against Spell.dbc offline and is listed in
 *   `trainerLearns`. Only the paladin's trainer has any: Judgement (10321),
 *   which teaches Judgement of Light and Seal of Righteousness, and Summon
 *   Warhorse (13820), which teaches the mount and Apprentice Riding and is
 *   left out (`trainerExclude`): no other member rides at 20.
 * - Talents: eleven points (levels 10-20), one tree per role, every tier and
 *   prerequisite legal, each row the spell of the rank taken.
 *
 * A party staged above 20 wears the same loadout with its level's extension
 * (`LEVEL_EXTENSIONS`, `loadoutAt`): the extra talent points, the trainer's
 * spells up to that level, and nothing else.
 */

import { accountFixtureName } from "../smoke/lib/fixture";
import type { Scenario } from "./scenarios";

/**
 * The five loadouts, one per class. A loadout id is not a party role: the
 * fleet's party definition gives each member one of three role words (`tank`,
 * `healer`, `damage`, runner/src/party.ts) and a race and class, and the
 * stager picks the loadout by race and class (`loadoutFor`).
 */
export const LOADOUT_IDS = ["tank", "healer", "mage", "rogue", "paladin"] as const;
export type LoadoutId = (typeof LOADOUT_IDS)[number];
/** The party definition's role words (runner/src/party.ts PARTY_ROLES). */
export type PartyRoleWord = "tank" | "healer" | "damage";

/** The party's level, and the talent points it has: one a level from 10. */
export const PARTY_LEVEL = 20;
export const PARTY_TALENT_POINTS = PARTY_LEVEL - 9;
/** A character's talent points at `level`: one a level from 10. */
export const talentPointsAt = (level: number): number => Math.max(0, level - 9);
/** 3 gold, for repairs. */
export const PARTY_MONEY = 30_000;

/** Equipment slots (`EquipmentSlots` in the core). */
export const SLOT = {
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
  back: 14,
  mainHand: 15,
  offHand: 16,
  ranged: 17,
} as const;

export type GearLine = { item: number; name: string; slot: number; twoHand?: true };
export type StockLine = { item: number; name: string; count: number };
export type TalentPick = {
  talentId: number;
  tab: number;
  /** 0-based tier: needs 5 points per tier in the same tab before it. */
  row: number;
  col: number;
  /** Points spent here, 1..maxRank. */
  rank: number;
  maxRank: number;
  /** The rank's spell: the one `character_talent` row for this talent. */
  spell: number;
  name: string;
  /** A prerequisite talent and the points it must hold (1-based). */
  dependsOn?: { talentId: number; rank: number };
};

export type Loadout = {
  id: LoadoutId;
  /** The role word a party definition gives a member wearing this loadout. */
  partyRole: PartyRoleWord;
  race: number;
  class: number;
  /** For logs and the launch note: "Human Warrior". */
  label: string;
  /** Prefix of the member's character name. */
  namePrefix: string;
  /** `trainer.Id` whose `trainer_spell` rows up to PARTY_LEVEL the character knows. */
  trainerId: number;
  /** Spells a class quest teaches, which no trainer lists. */
  questSpells: readonly { spell: number; name: string }[];
  /** Trainer entries that are learn-effect spells, and the spells each teaches (Spell.dbc, read offline). */
  trainerLearns?: Readonly<Record<number, readonly number[]>>;
  /** Trainer entries left out on purpose, each with its reason in the loadout. */
  trainerExclude?: readonly number[];
  /** What the staging smoke checks in the spellbook (highest ranks a level-20 character holds). */
  keySpells: readonly number[];
  talents: readonly TalentPick[];
  gear: readonly GearLine[];
  /** Worn in the first free bag slots (19-22). */
  bags: readonly StockLine[];
  /** Added once the bags are worn: food, drink, potions. */
  supplies: readonly StockLine[];
};

const WOOLEN_BAG: StockLine = { item: 4240, name: "Woolen Bag", count: 1 };
const BAGS = [WOOLEN_BAG, WOOLEN_BAG] as const;
const MUTTON_CHOP = (count: number): StockLine => ({ item: 3770, name: "Mutton Chop", count });
const ICE_COLD_MILK = (count: number): StockLine => ({ item: 1179, name: "Ice Cold Milk", count });
const HEALING_POTION = (count: number): StockLine => ({ item: 929, name: "Healing Potion", count });
const LESSER_MANA_POTION = (count: number): StockLine => ({ item: 3385, name: "Lesser Mana Potion", count });

export const LOADOUTS: Readonly<Record<LoadoutId, Loadout>> = {
  tank: {
    id: "tank",
    partyRole: "tank",
    race: 1,
    class: 1,
    label: "Human Warrior",
    namePrefix: "Tank",
    trainerId: 1,
    questSpells: [
      { spell: 71, name: "Defensive Stance" },
      { spell: 355, name: "Taunt" },
      { spell: 7386, name: "Sunder Armor" },
    ],
    keySpells: [71, 355, 7386, 2565, 6572, 8198],
    // Protection 11: Shield Specialization 5, Anticipation 5, Last Stand 1.
    talents: [
      { talentId: 1601, tab: 163, row: 0, col: 1, rank: 5, maxRank: 5, spell: 12727, name: "Shield Specialization" },
      { talentId: 138, tab: 163, row: 1, col: 2, rank: 5, maxRank: 5, spell: 12753, name: "Anticipation" },
      { talentId: 153, tab: 163, row: 2, col: 0, rank: 1, maxRank: 1, spell: 12975, name: "Last Stand" },
    ],
    gear: [
      { item: 6721, name: "Chestplate of Kor", slot: SLOT.chest },
      { item: 26038, name: "Segmented Girdle", slot: SLOT.waist },
      { item: 2545, name: "Malleable Chain Leggings", slot: SLOT.legs },
      { item: 2910, name: "Gold Militia Boots", slot: SLOT.feet },
      { item: 7003, name: "Beetle Clasps", slot: SLOT.wrists },
      { item: 26035, name: "Corin's Handguards", slot: SLOT.hands },
      { item: 1319, name: "Ring of Iron Will", slot: SLOT.finger1 },
      { item: 3582, name: "Acidproof Cloak", slot: SLOT.back },
      { item: 3400, name: "Lucine Longsword", slot: SLOT.mainHand },
      { item: 15207, name: "Steelcap Shield", slot: SLOT.offHand },
    ],
    bags: BAGS,
    supplies: [MUTTON_CHOP(20), HEALING_POTION(5)],
  },
  healer: {
    id: "healer",
    partyRole: "healer",
    race: 3,
    class: 5,
    label: "Dwarf Priest",
    namePrefix: "Heal",
    trainerId: 11,
    questSpells: [],
    keySpells: [2061, 2054, 2006, 600, 6075, 1244],
    // Holy 11: Healing Focus 2, Improved Renew 3, Divine Fury 5, Inspiration 1.
    talents: [
      { talentId: 410, tab: 202, row: 0, col: 0, rank: 2, maxRank: 2, spell: 15012, name: "Healing Focus" },
      { talentId: 406, tab: 202, row: 0, col: 1, rank: 3, maxRank: 3, spell: 17191, name: "Improved Renew" },
      { talentId: 1181, tab: 202, row: 1, col: 2, rank: 5, maxRank: 5, spell: 18535, name: "Divine Fury" },
      { talentId: 361, tab: 202, row: 2, col: 3, rank: 1, maxRank: 3, spell: 14892, name: "Inspiration" },
    ],
    gear: [
      { item: 5812, name: "Robes of Antiquity", slot: SLOT.chest },
      { item: 11936, name: "Relic Hunter Belt", slot: SLOT.waist },
      { item: 6659, name: "Scarab Trousers", slot: SLOT.legs },
      { item: 6998, name: "Nimbus Boots", slot: SLOT.feet },
      { item: 26009, name: "Flutterer Silk Handwraps", slot: SLOT.hands },
      { item: 6743, name: "Sustaining Ring", slot: SLOT.finger1 },
      { item: 7004, name: "Prelacy Cape", slot: SLOT.back },
      { item: 5613, name: "Staff of the Purifier", slot: SLOT.mainHand, twoHand: true },
      { item: 5240, name: "Torchlight Wand", slot: SLOT.ranged },
    ],
    bags: BAGS,
    supplies: [ICE_COLD_MILK(20), LESSER_MANA_POTION(5)],
  },
  mage: {
    id: "mage",
    partyRole: "damage",
    race: 1,
    class: 8,
    label: "Human Mage",
    namePrefix: "Mage",
    trainerId: 16,
    questSpells: [],
    keySpells: [7322, 12824, 1953, 122, 12051, 1460],
    // Frost 11: Improved Frostbolt 5, Ice Shards 3, Precision 2, Icy Veins 1.
    talents: [
      { talentId: 37, tab: 61, row: 0, col: 1, rank: 5, maxRank: 5, spell: 16766, name: "Improved Frostbolt" },
      { talentId: 73, tab: 61, row: 1, col: 0, rank: 3, maxRank: 3, spell: 15047, name: "Ice Shards" },
      { talentId: 1649, tab: 61, row: 1, col: 2, rank: 2, maxRank: 3, spell: 29439, name: "Precision" },
      { talentId: 69, tab: 61, row: 2, col: 1, rank: 1, maxRank: 1, spell: 12472, name: "Icy Veins" },
    ],
    gear: [
      { item: 10657, name: "Talbar Mantle", slot: SLOT.shoulders },
      { item: 7509, name: "Manaweave Robe", slot: SLOT.chest },
      { item: 26013, name: "Cincture of Woven Reeds", slot: SLOT.waist },
      { item: 26007, name: "Vindicator's Woolies", slot: SLOT.legs },
      { item: 6095, name: "Wandering Boots", slot: SLOT.feet },
      { item: 7738, name: "Evergreen Gloves", slot: SLOT.hands },
      { item: 1449, name: "Minor Channeling Ring", slot: SLOT.finger1 },
      { item: 26017, name: "Venomous Silk Cover", slot: SLOT.back },
      { item: 2950, name: "Icicle Rod", slot: SLOT.mainHand, twoHand: true },
      { item: 7607, name: "Sable Wand", slot: SLOT.ranged },
    ],
    bags: BAGS,
    supplies: [LESSER_MANA_POTION(5)],
  },
  rogue: {
    id: "rogue",
    partyRole: "damage",
    race: 1,
    class: 4,
    label: "Human Rogue",
    namePrefix: "Rogue",
    trainerId: 9,
    questSpells: [],
    keySpells: [2590, 1766, 6770, 1784, 674, 1943],
    // Combat 11: Improved Sinister Strike 2, Dual Wield Specialization 3, Precision 5, Endurance 1.
    talents: [
      { talentId: 201, tab: 181, row: 0, col: 1, rank: 2, maxRank: 2, spell: 13863, name: "Improved Sinister Strike" },
      { talentId: 221, tab: 181, row: 0, col: 2, rank: 3, maxRank: 5, spell: 13849, name: "Dual Wield Specialization" },
      { talentId: 181, tab: 181, row: 1, col: 3, rank: 5, maxRank: 5, spell: 13845, name: "Precision" },
      { talentId: 204, tab: 181, row: 2, col: 0, rank: 1, maxRank: 2, spell: 13742, name: "Endurance" },
    ],
    gear: [
      { item: 3585, name: "Camouflaged Tunic", slot: SLOT.chest },
      { item: 5609, name: "Steadfast Cinch", slot: SLOT.waist },
      { item: 6480, name: "Slick Deviate Leggings", slot: SLOT.legs },
      { item: 2033, name: "Ambassador's Boots", slot: SLOT.feet },
      { item: 15403, name: "Ridgeback Bracers", slot: SLOT.wrists },
      { item: 26023, name: "Ravager Hide Gloves", slot: SLOT.hands },
      { item: 5343, name: "Barkeeper's Cloak", slot: SLOT.back },
      { item: 5627, name: "Relic Blade", slot: SLOT.mainHand },
      // A one-hander in the off hand needs Dual Wield (674, trainer level 10),
      // which the loader has learned before it equips: spells load first.
      { item: 2908, name: "Thornblade", slot: SLOT.offHand },
    ],
    bags: BAGS,
    supplies: [MUTTON_CHOP(20), HEALING_POTION(5)],
  },
  paladin: {
    id: "paladin",
    partyRole: "damage",
    race: 3,
    class: 2,
    label: "Dwarf Paladin",
    namePrefix: "Pala",
    trainerId: 3,
    questSpells: [{ spell: 7328, name: "Redemption" }],
    // Judgement teaches Judgement of Light and Seal of Righteousness.
    trainerLearns: { 10321: [20271, 21084] },
    // Summon Warhorse (13820 / the Draenei trainer's 34768) teaches the mount
    // and Apprentice Riding: no other member rides at 20, so it is not staged.
    trainerExclude: [13820, 34768],
    keySpells: [20271, 26573, 879, 19750, 20217, 7328],
    // Retribution 11: Benediction 5, Heart of the Crusader 3, Improved Judgements 2, Seal of Command 1.
    talents: [
      { talentId: 1407, tab: 381, row: 0, col: 2, rank: 5, maxRank: 5, spell: 20105, name: "Benediction" },
      { talentId: 1464, tab: 381, row: 1, col: 1, rank: 3, maxRank: 3, spell: 20337, name: "Heart of the Crusader" },
      { talentId: 1631, tab: 381, row: 1, col: 0, rank: 2, maxRank: 2, spell: 25957, name: "Improved Judgements" },
      { talentId: 1481, tab: 381, row: 2, col: 2, rank: 1, maxRank: 1, spell: 20375, name: "Seal of Command" },
    ],
    gear: [
      { item: 24348, name: "Tunic of the Dragon Slayer", slot: SLOT.chest },
      { item: 15404, name: "Breakwater Girdle", slot: SLOT.waist },
      { item: 2906, name: "Darkshire Mail Leggings", slot: SLOT.legs },
      { item: 26037, name: "Lightweight Mesh Boots", slot: SLOT.feet },
      { item: 3559, name: "Night Watch Gauntlets", slot: SLOT.hands },
      { item: 3235, name: "Ring of Scorn", slot: SLOT.finger1 },
      { item: 3561, name: "Resilient Poncho", slot: SLOT.back },
      { item: 6093, name: "Orc Crusher", slot: SLOT.mainHand, twoHand: true },
    ],
    bags: BAGS,
    supplies: [MUTTON_CHOP(20), ICE_COLD_MILK(20), HEALING_POTION(5)],
  },
};

/**
 * What a loadout gains above level 20, per level the party is staged at: kept
 * apart from LOADOUTS so the level-20 objects, which the scored Deadmines
 * groups' staging hash covers (`infra/task-launch.ts`), never move. A level
 * is the base loadout plus its extension (`loadoutAt`): the same gear, bags
 * and supplies (every piece is wearable from 20, and none has a required
 * level above it), the class trainer's spells up to the level (read at
 * staging time, as at 20), and the talents the extra points buy.
 *
 * Level 24 (the Stockade's party): 15 points, four more than
 * the 11-point preset, all in the role's own tree. With 11 spent, tier 4
 * needs 15 first, so the four go into tiers 1-3, on passive talents only, so
 * no member gains an ability the level-20 party lacks:
 *
 * - tank, Protection: Toughness 4 (armor from items).
 * - healer, Holy: Inspiration from 1 to 3, Holy Specialization 2 (heal crit).
 * - mage, Frost: Precision from 2 to 3, Piercing Ice 3.
 * - rogue, Combat: Dual Wield Specialization from 3 to 5, Close Quarters
 *   Combat 2 (which needs Dual Wield Specialization at 5).
 * - paladin, Retribution: Conviction 4.
 *
 * A raised talent keeps its one `character_talent` row, at the new rank's
 * spell (`talents` here replace the base pick of the same `talentId`). The
 * ranks and spells were read off Talent.dbc. Between 21 and 24 no class quest
 * of these five teaches a spell (quest_template), no trainer entry is a
 * learn-effect spell (Spell.dbc), and one entry needs a talent the preset
 * does not take: the mage trainer's Pyroblast rank 2 (12505, level 24)
 * requires the Fire talent Pyroblast (11366), so it is left out. `keySpells`
 * at 24 swap a level-20 key spell for the rank the trainer adds by 24, so the
 * staging smoke checks the rank the spellbook shows.
 */
export type LoadoutExtension = {
  talents: readonly TalentPick[];
  trainerExclude?: readonly number[];
  keySpells?: readonly number[];
};

export const LEVEL_EXTENSIONS: Readonly<Record<number, Readonly<Record<LoadoutId, LoadoutExtension>>>> = {
  24: {
    tank: {
      talents: [{ talentId: 140, tab: 163, row: 2, col: 3, rank: 4, maxRank: 5, spell: 12763, name: "Toughness" }],
      // Revenge rank 2 (6574) at 24.
      keySpells: [71, 355, 7386, 2565, 6574, 8198],
    },
    healer: {
      talents: [
        { talentId: 361, tab: 202, row: 2, col: 3, rank: 3, maxRank: 3, spell: 15363, name: "Inspiration" },
        { talentId: 401, tab: 202, row: 0, col: 2, rank: 2, maxRank: 5, spell: 15008, name: "Holy Specialization" },
      ],
      // Heal rank 2 (2055), Resurrection rank 2 (2010), Power Word: Shield rank 4 (3747), Power Word: Fortitude rank 3 (1245).
      keySpells: [2061, 2055, 2010, 3747, 6075, 1245],
    },
    mage: {
      talents: [
        { talentId: 1649, tab: 61, row: 1, col: 2, rank: 3, maxRank: 3, spell: 29440, name: "Precision" },
        { talentId: 61, tab: 61, row: 2, col: 0, rank: 3, maxRank: 3, spell: 12953, name: "Piercing Ice" },
      ],
      trainerExclude: [12505],
    },
    rogue: {
      talents: [
        { talentId: 221, tab: 181, row: 0, col: 2, rank: 5, maxRank: 5, spell: 13852, name: "Dual Wield Specialization" },
        { talentId: 182, tab: 181, row: 2, col: 2, rank: 2, maxRank: 5, spell: 13804, name: "Close Quarters Combat", dependsOn: { talentId: 221, rank: 5 } },
      ],
    },
    paladin: {
      talents: [{ talentId: 1411, tab: 381, row: 2, col: 1, rank: 4, maxRank: 5, spell: 20120, name: "Conviction" }],
      // Redemption rank 2 (10322) at 24.
      keySpells: [20271, 26573, 879, 19750, 20217, 10322],
    },
  },
};

/** The levels a party is staged at: the loadouts' own, and each level an extension is written for. */
export const PARTY_LEVELS: readonly number[] = [PARTY_LEVEL, ...Object.keys(LEVEL_EXTENSIONS).map(Number)].sort((a, b) => a - b);

export function isPartyLevel(level: number): boolean {
  return PARTY_LEVELS.includes(level);
}

/**
 * The loadout at a staged level: at PARTY_LEVEL the shipped object itself
 * (the same reference, so nothing a level-20 staging writes or hashes can
 * move), above it a new object with the level's extension applied. Throws
 * for a level no extension is written for; `checkStageRequest` refuses such
 * a level before anyone calls this.
 */
export function loadoutAt(l: Loadout, level: number): Loadout {
  if (level === PARTY_LEVEL) return l;
  const ext = LEVEL_EXTENSIONS[level]?.[l.id];
  if (!ext) throw new Error(`no level ${level} extension for the ${l.id} loadout; the party is staged at ${PARTY_LEVELS.join(" or ")}`);
  const replaced = new Set(ext.talents.map((t) => t.talentId));
  const added = ext.talents.filter((t) => !l.talents.some((b) => b.talentId === t.talentId));
  const talents = [...l.talents.map((b) => (replaced.has(b.talentId) ? ext.talents.find((t) => t.talentId === b.talentId)! : b)), ...added];
  const trainerExclude = [...(l.trainerExclude ?? []), ...(ext.trainerExclude ?? [])];
  return {
    ...l,
    talents,
    ...(trainerExclude.length ? { trainerExclude } : {}),
    keySpells: ext.keySpells ?? l.keySpells,
  };
}

/**
 * The loadout for a member of this race and class, or why there is none.
 * The gear is chosen for the race and class's starting proficiencies, so
 * race and class must both match; the role word must be the
 * loadout's, so a definition cannot stage a healer's gear on its "damage".
 */
export function loadoutFor(member: { race: number; class: number; role: string }): Loadout | string {
  const l = Object.values(LOADOUTS).find((x) => x.class === member.class);
  if (!l) return `no loadout for class ${member.class}; the loadouts are ${Object.values(LOADOUTS).map((x) => `${x.label} (race ${x.race}, class ${x.class})`).join(", ")}`;
  if (l.race !== member.race) return `the class ${member.class} loadout is a ${l.label} (race ${l.race}); the member is race ${member.race}`;
  if (l.partyRole !== member.role) return `the ${l.label} loadout plays "${l.partyRole}"; the member's role is "${member.role}"`;
  return l;
}

/**
 * A member's character name: the role's prefix and the account's letters
 * (digits as letters, 1 -> b; the smokes' `accountFixtureName`), so each
 * account holds one stable name per role: `Tankpartyb` on PARTY1. Character
 * names are realm-global; deriving from the account keeps two accounts from
 * ever asking for the same one.
 */
export function partyCharacterName(id: LoadoutId, account: string): string {
  return accountFixtureName(LOADOUTS[id].namePrefix, account);
}

/**
 * The member's scenario: the request's fixture scenario (where it stands,
 * where it hearths; `moonbrook-mine` for the Deadmines) at the party level,
 * with the loadout's money, an empty quest log, the trainer's spells (read at
 * staging time, learn-effect entries resolved) and the quest-taught ones, the
 * role's talents, and skills at the level's cap. The base scenario's own
 * level, money, spells and talents are not used: the loadout is the member.
 */
export function partyScenario(loadout: Loadout, trainerSpells: readonly number[], base: Scenario, level = PARTY_LEVEL, member = 0): Scenario {
  const exclude = new Set(loadout.trainerExclude ?? []);
  const taught = trainerSpells.filter((s) => !exclude.has(s)).flatMap((s) => loadout.trainerLearns?.[s] ?? [s]);
  const spells = [...new Set([...taught, ...loadout.questSpells.map((s) => s.spell)])].sort((a, b) => a - b);
  return {
    description: `party ${loadout.id}: level ${level} ${loadout.label} at the scenario's spot (${base.description}), ${loadout.talents.length} talents, ${spells.length} spells`,
    level,
    xp: 0,
    money: PARTY_MONEY,
    // The member's own spot (member order), so five do not stand in one another.
    position: partySpot(base, member),
    ...(base.homebind ? { homebind: base.homebind } : {}),
    clearQuests: true,
    spells,
    talents: loadout.talents.map((t) => t.spell),
    maxSkills: true,
  };
}

/**
 * A member's spot in a party scenario: its own, in member order. A member
 * past the scenario's spots is refused rather than stood on another's
 * (`checkStageRequest` refuses such a party before anything is touched).
 */
export function partySpot(base: Scenario, member: number): Scenario["position"] {
  const spot = base.partySpots?.[member];
  if (!spot) throw new Error(`the scenario (${base.description}) has ${base.partySpots?.length ?? 0} party spots; member ${member + 1} has none`);
  return spot;
}

/**
 * The structural check on a loadout at a level (the loadout as `loadoutAt`
 * gives it), run in the tests and again by the stager before it writes
 * anything. The talent half matters most: the worldserver ASSERTs on a
 * `character_talent` row that is not a talent spell, and silently resets a
 * tree that spends more than the level gives.
 */
export function validateLoadout(l: Loadout, level = PARTY_LEVEL): string[] {
  const errors: string[] = [];
  const where = `loadout ${l.id}`;
  // Talents: points, one row per talent, ranks, tiers, prerequisites.
  const total = l.talents.reduce((n, t) => n + t.rank, 0);
  if (total > talentPointsAt(level)) errors.push(`${where}: ${total} talent points, a level ${level} character has ${talentPointsAt(level)}`);
  const ids = new Set<number>();
  const spells = new Set<number>();
  const spentInTab = new Map<number, number>();
  for (const t of [...l.talents].sort((a, b) => a.row - b.row)) {
    if (ids.has(t.talentId)) errors.push(`${where}: talent ${t.talentId} listed twice (one row per talent, at its rank's spell)`);
    if (spells.has(t.spell)) errors.push(`${where}: spell ${t.spell} listed twice`);
    ids.add(t.talentId);
    spells.add(t.spell);
    if (!Number.isInteger(t.rank) || t.rank < 1 || t.rank > t.maxRank) errors.push(`${where}: ${t.name} rank ${t.rank} outside 1..${t.maxRank}`);
    const before = spentInTab.get(t.tab) ?? 0;
    if (before < t.row * 5) errors.push(`${where}: ${t.name} is in tier ${t.row + 1}, which needs ${t.row * 5} points in its tree first; it has ${before}`);
    spentInTab.set(t.tab, before + t.rank);
  }
  for (const t of l.talents) {
    if (!t.dependsOn) continue;
    const dep = l.talents.find((x) => x.talentId === t.dependsOn!.talentId);
    if (!dep || dep.rank < t.dependsOn.rank) errors.push(`${where}: ${t.name} needs talent ${t.dependsOn.talentId} at ${t.dependsOn.rank} points`);
  }
  // Gear: one item per slot, every slot an equipment slot, a two-hander alone.
  const slots = new Set<number>();
  for (const g of l.gear) {
    if (!Number.isInteger(g.slot) || g.slot < 0 || g.slot > 18) errors.push(`${where}: ${g.name} in slot ${g.slot}, not an equipment slot`);
    if (slots.has(g.slot)) errors.push(`${where}: slot ${g.slot} filled twice`);
    slots.add(g.slot);
    if (g.twoHand && g.slot !== SLOT.mainHand) errors.push(`${where}: two-handed ${g.name} must go in the main hand`);
  }
  if (l.gear.some((g) => g.twoHand) && slots.has(SLOT.offHand)) errors.push(`${where}: a two-handed weapon and an off hand`);
  if (l.bags.length > 4) errors.push(`${where}: ${l.bags.length} bags, there are 4 bag slots`);
  for (const s of [...l.bags, ...l.supplies]) {
    if (!Number.isInteger(s.count) || s.count < 1) errors.push(`${where}: ${s.name} count ${s.count}`);
  }
  for (const id of [...l.gear.map((g) => g.item), ...l.bags.map((b) => b.item), ...l.supplies.map((s) => s.item), ...l.keySpells, ...l.questSpells.map((s) => s.spell)]) {
    if (!Number.isInteger(id) || id <= 0) errors.push(`${where}: id ${id} is not a positive integer`);
  }
  return errors;
}

/** The parts of the module's talent frame (`queryTalentTree`, Talent.dbc as the client reads it) the cross-check reads. */
export type TalentFrame = {
  class: number;
  tabs: readonly { tabId: number; talents: readonly { talentId: number; row: number; col: number; maxRank: number; ranks: readonly number[] }[] }[];
};

/**
 * Cross-check a preset against the module's talent frame for the character's
 * class, before a single `character_talent` row is written: every talent is in
 * this class's frame, in the tab, tier and column the preset says, and the
 * spell is the frame's spell for that rank. This is what keeps a typo from
 * becoming an ASSERT in `Player::_LoadTalents` at the member's next login,
 * which would take the worldserver and every live run with it.
 */
export function checkTalentsAgainstFrame(l: Loadout, frame: TalentFrame): string[] {
  const errors: string[] = [];
  if (frame.class !== l.class) errors.push(`talent frame is for class ${frame.class}, the ${l.id} is class ${l.class}`);
  for (const t of l.talents) {
    const tab = frame.tabs.find((x) => x.tabId === t.tab);
    const entry = tab?.talents.find((x) => x.talentId === t.talentId);
    if (!tab || !entry) {
      errors.push(`${l.id}: talent ${t.talentId} (${t.name}) is not in tab ${t.tab} of this class's frame`);
      continue;
    }
    if (entry.row !== t.row || entry.col !== t.col) errors.push(`${l.id}: ${t.name} sits at tier ${entry.row} column ${entry.col} in the frame, the preset says ${t.row}/${t.col}`);
    if (entry.maxRank !== t.maxRank) errors.push(`${l.id}: ${t.name} has ${entry.maxRank} ranks in the frame, the preset says ${t.maxRank}`);
    const spell = entry.ranks[t.rank - 1];
    if (spell !== t.spell) errors.push(`${l.id}: ${t.name} rank ${t.rank} is spell ${spell ?? "(none)"} in the frame, the preset says ${t.spell}`);
  }
  return errors;
}
