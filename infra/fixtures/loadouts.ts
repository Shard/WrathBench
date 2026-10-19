/**
 * The party eval's loadouts (docs/proposals/GROUP-PLAY.md §3): five
 * Alliance characters at level 20, a warrior tank, a priest healer, and a
 * mage, a rogue and a hunter, in quest-level greens, with talents preset per
 * role and standing in Moonbrook. Data plus the pure checks over it; the
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
 *   the warrior has mail and shields, the hunter leather until 40, the rogue
 *   daggers, the priest and mage staves and wands).
 * - Spells are the class trainer's, read from the world DB at staging time
 *   (`trainer_spell` for `trainerId` up to the party level: the table the
 *   pinned core loads, `ObjectMgr::LoadTrainers`; the design named the
 *   pre-port `npc_trainer`, which the core no longer reads), plus the spells
 *   the class's level-10 quests teach, which no trainer lists: the warrior's
 *   Defensive Stance, Taunt and Sunder Armor (quest reward spell 8121) and the
 *   hunter's Tame Beast, Call Pet, Dismiss Pet, Revive Pet and Feed Pet (1579,
 *   5300). None of these trainers' entries up to level 20 is a learn-effect
 *   spell (checked against Spell.dbc offline), so every row the query returns
 *   is the spell itself; the stager cannot re-check that in the pod, which
 *   mounts no client data.
 * - Talents: eleven points (levels 10-20), one tree per role, every tier and
 *   prerequisite legal, each row the spell of the rank taken.
 * - The hunter has no pet. A pet is a `character_pet` row numbered from a
 *   generator the server seeds at boot, the same class of problem as item
 *   guids, so none is staged; the hunter knows Tame Beast and may tame one.
 */

import { accountFixtureName } from "../smoke/lib/fixture";
import type { Scenario } from "./scenarios";
import { DEADMINES_ENTRANCE_TRIGGER, MOONBROOK, SENTINEL_HILL_BIND, WESTFALL_ZONE, facing } from "./scenarios";

export const PARTY_ROLES = ["tank", "healer", "mage", "rogue", "hunter"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

export const isPartyRole = (s: string): s is PartyRole => (PARTY_ROLES as readonly string[]).includes(s);

/** The party's level, and the talent points it has: one a level from 10. */
export const PARTY_LEVEL = 20;
export const PARTY_TALENT_POINTS = PARTY_LEVEL - 9;
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
  role: PartyRole;
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
  /** What the staging smoke checks in the spellbook (highest ranks a level-20 character holds). */
  keySpells: readonly number[];
  talents: readonly TalentPick[];
  gear: readonly GearLine[];
  /** Worn in the first free bag slots (19-22). */
  bags: readonly StockLine[];
  /** Added once the bags are worn: food, drink, potions, ammunition. */
  supplies: readonly StockLine[];
  /** `characters.ammoId` for a ranged class that fires ammunition. */
  ammoId?: number;
};

const WOOLEN_BAG: StockLine = { item: 4240, name: "Woolen Bag", count: 1 };
const BAGS = [WOOLEN_BAG, WOOLEN_BAG] as const;
const MUTTON_CHOP = (count: number): StockLine => ({ item: 3770, name: "Mutton Chop", count });
const ICE_COLD_MILK = (count: number): StockLine => ({ item: 1179, name: "Ice Cold Milk", count });
const HEALING_POTION = (count: number): StockLine => ({ item: 929, name: "Healing Potion", count });
const LESSER_MANA_POTION = (count: number): StockLine => ({ item: 3385, name: "Lesser Mana Potion", count });
const HEAVY_SHOT = 2519;

export const LOADOUTS: Readonly<Record<PartyRole, Loadout>> = {
  tank: {
    role: "tank",
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
    keySpells: [71, 355, 7386, 2565, 6572, 6343],
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
    role: "healer",
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
    role: "mage",
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
    role: "rogue",
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
  hunter: {
    role: "hunter",
    race: 3,
    class: 3,
    label: "Dwarf Hunter",
    namePrefix: "Hunt",
    trainerId: 7,
    questSpells: [
      { spell: 1515, name: "Tame Beast" },
      { spell: 883, name: "Call Pet" },
      { spell: 2641, name: "Dismiss Pet" },
      { spell: 982, name: "Revive Pet" },
      { spell: 6991, name: "Feed Pet" },
    ],
    keySpells: [14282, 14318, 1499, 2643, 1515, 883],
    // Marksmanship 11: Lethal Shots 5, Mortal Shots 5, Aimed Shot 1.
    talents: [
      { talentId: 1344, tab: 363, row: 0, col: 2, rank: 5, maxRank: 5, spell: 19431, name: "Lethal Shots" },
      { talentId: 1349, tab: 363, row: 1, col: 2, rank: 5, maxRank: 5, spell: 19490, name: "Mortal Shots" },
      { talentId: 1345, tab: 363, row: 2, col: 2, rank: 1, maxRank: 1, spell: 19434, name: "Aimed Shot", dependsOn: { talentId: 1349, rank: 5 } },
    ],
    gear: [
      { item: 24347, name: "Vest of the Dragon Slayer", slot: SLOT.chest },
      { item: 26026, name: "Ornately Tooled Belt", slot: SLOT.waist },
      { item: 26021, name: "Vindicator's Leather Chaps", slot: SLOT.legs },
      { item: 26025, name: "Technician's Boots", slot: SLOT.feet },
      { item: 1302, name: "Black Whelp Gloves", slot: SLOT.hands },
      { item: 3582, name: "Acidproof Cloak", slot: SLOT.back },
      { item: 6094, name: "Piercing Axe", slot: SLOT.mainHand, twoHand: true },
      { item: 15205, name: "Owlsight Rifle", slot: SLOT.ranged },
    ],
    bags: BAGS,
    supplies: [MUTTON_CHOP(20), ICE_COLD_MILK(20), { item: HEAVY_SHOT, name: "Heavy Shot", count: 1000 }],
    ammoId: HEAVY_SHOT,
  },
};

/** The member who leads, invites the others, and is named the party leader in the objective. */
export const LEADER_ROLE: PartyRole = "tank";

/**
 * A member's character name: the role's prefix and the account's letters
 * (digits as letters, 1 -> b; the smokes' `accountFixtureName`), so each
 * account holds one stable name per role: `Tankpartyb` on PARTY1. Character
 * names are realm-global; deriving from the account keeps two accounts from
 * ever asking for the same one.
 */
export function partyCharacterName(role: PartyRole, account: string): string {
  return accountFixtureName(LOADOUTS[role].namePrefix, account);
}

/**
 * The member's scenario: the party level in Moonbrook, facing the mine,
 * hearth at Sentinel Hill, an empty quest log, the trainer's spells (read at
 * staging time) and the quest-taught ones, the role's talents, skills at the
 * level's cap, and the ammunition a hunter fires.
 */
export function partyScenario(loadout: Loadout, trainerSpells: readonly number[]): Scenario {
  const spells = [...new Set([...trainerSpells, ...loadout.questSpells.map((s) => s.spell)])].sort((a, b) => a - b);
  return {
    description: `party ${loadout.role}: level ${PARTY_LEVEL} ${loadout.label} in Moonbrook facing the Deadmines entrance, homebind Sentinel Hill, ${loadout.talents.length} talents, ${spells.length} spells`,
    level: PARTY_LEVEL,
    xp: 0,
    money: PARTY_MONEY,
    position: { map: 0, zone: WESTFALL_ZONE, ...MOONBROOK, o: facing(MOONBROOK, DEADMINES_ENTRANCE_TRIGGER) },
    homebind: SENTINEL_HILL_BIND,
    clearQuests: true,
    spells,
    talents: loadout.talents.map((t) => t.spell),
    maxSkills: true,
    ...(loadout.ammoId !== undefined ? { ammoId: loadout.ammoId } : {}),
  };
}

/**
 * The structural check on a loadout, run in the tests and again by the
 * stager before it writes anything. The talent half matters most: the
 * worldserver ASSERTs on a `character_talent` row that is not a talent
 * spell, and silently resets a tree that spends more than the level gives.
 */
export function validateLoadout(l: Loadout): string[] {
  const errors: string[] = [];
  const where = `loadout ${l.role}`;
  // Talents: points, one row per talent, ranks, tiers, prerequisites.
  const total = l.talents.reduce((n, t) => n + t.rank, 0);
  if (total > PARTY_TALENT_POINTS) errors.push(`${where}: ${total} talent points, a level ${PARTY_LEVEL} character has ${PARTY_TALENT_POINTS}`);
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
  if (l.ammoId !== undefined && !l.supplies.some((s) => s.item === l.ammoId)) errors.push(`${where}: ammoId ${l.ammoId} is not among the supplies`);
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
  if (frame.class !== l.class) errors.push(`talent frame is for class ${frame.class}, the ${l.role} is class ${l.class}`);
  for (const t of l.talents) {
    const tab = frame.tabs.find((x) => x.tabId === t.tab);
    const entry = tab?.talents.find((x) => x.talentId === t.talentId);
    if (!tab || !entry) {
      errors.push(`${l.role}: talent ${t.talentId} (${t.name}) is not in tab ${t.tab} of this class's frame`);
      continue;
    }
    if (entry.row !== t.row || entry.col !== t.col) errors.push(`${l.role}: ${t.name} sits at tier ${entry.row} column ${entry.col} in the frame, the preset says ${t.row}/${t.col}`);
    if (entry.maxRank !== t.maxRank) errors.push(`${l.role}: ${t.name} has ${entry.maxRank} ranks in the frame, the preset says ${t.maxRank}`);
    const spell = entry.ranks[t.rank - 1];
    if (spell !== t.spell) errors.push(`${l.role}: ${t.name} rank ${t.rank} is spell ${spell ?? "(none)"} in the frame, the preset says ${t.spell}`);
  }
  return errors;
}
