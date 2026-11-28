/**
 * Named scenarios for smoke characters.
 *
 * A scenario is the state a logged-out smoke character is put into so that a
 * smoke can prove a late-game claim in seconds instead of playing minutes to
 * reach it. This file is data plus the pure
 * helpers that validate it; `apply.ts` is what talks to the database.
 *
 * Operator tooling only. Nothing here is reachable from `runner/` or `sdk/`,
 * so the agent-facing contract in wrath-mcp/docs/CONTRACTS.md is untouched: the agent
 * still only observes what a client could observe, and still only acts through
 * the module. A fixture is the operator arranging the world before the run,
 * the same way an operator picks which account a smoke logs into.
 *
 * NO ITEMS, deliberately. `item_instance` guids come from an in-memory
 * sequence generator seeded once at worldserver boot from
 * `SELECT MAX(guid) FROM item_instance` (ObjectMgr.cpp SetHighestGuids). Rows
 * inserted from outside while the server is up are above that watermark, so
 * they collide with guids the running server hands out — and worse, the next
 * boot *deletes* everything at or above its own watermark:
 * ObjectMgr.cpp:7583-7586 runs one-time DELETEs against `character_inventory`,
 * `mail_items`, `auctionhouse` and `guild_bank_item`. Externally written items
 * are therefore both racy now and silently reaped later. If a smoke ever needs
 * gear, it has to come through the module (a vendor purchase, a quest reward),
 * not through this tool. The party stager (`stage-party.ts`) is the one
 * exception to "through the module", and it still inserts nothing: its gear
 * comes from the running server's own `.additem` over SOAP, and the only item
 * write here is the offline equipment move (`buildEquipStatements` in
 * apply.ts), which changes `bag`/`slot` on rows the server saved and never a
 * guid.
 */

/** A map position with a facing. */
export type Position = {
  map: number;
  zone: number;
  x: number;
  y: number;
  z: number;
  o: number;
};

/** Where the character's hearthstone and resurrection point sit. */
export type Homebind = {
  map: number;
  zone: number;
  x: number;
  y: number;
  z: number;
};

export type Scenario = {
  /** One line, for the operator reading `--dry-run` output. */
  description: string;
  level: number;
  /** Experience into the current level. Defaults to 0. */
  xp?: number;
  /** Copper. 1 gold = 10000. Defaults to 0. */
  money?: number;
  position: Position;
  /**
   * A party scenario's member spots, in member order (`partyScenario`): a
   * member past the list stands at `position`.
   */
  partySpots?: Position[];
  homebind?: Homebind;
  /** Spell ids to add (INSERT IGNORE; never removes what is already known). */
  spells?: number[];
  quests?: {
    /** Quest ids to put in the log as QUEST_STATUS_INCOMPLETE. */
    inProgress?: number[];
    /** Quest ids to mark as already turned in. */
    rewarded?: number[];
    /**
     * Quests in the log with their creature objectives already counted:
     * `mobcount` is mobcount1..4 in order (missing ones are 0), and `complete`
     * writes QUEST_STATUS_COMPLETE instead of INCOMPLETE, the state of a player
     * who finished the objectives and logged out. `Player::_LoadQuestStatus`
     * serves the counts as the slot's counters and sets a complete slot's
     * State bit. Written whole (REPLACE), so last run's progress never leaks.
     */
    counted?: QuestProgress[];
  };
  /** Wipe the quest log and the rewarded list first. Makes the scenario a reset. */
  clearQuests?: boolean;
  /**
   * TaxiNodes.dbc ids to mark as visited (replaces `characters.taximask`,
   * 14 space-separated u32 words in 3.3.5). A flight can only be activated
   * between nodes the character has visited, so a scenario that ends at a
   * flight master names both ends here.
   */
  taxiNodes?: number[];
  /**
   * Achievement.dbc ids to mark as earned (`character_achievement` rows, dated
   * ACHIEVEMENT_FIXTURE_DATE). The core loads them at login and lists them in
   * SMSG_ALL_ACHIEVEMENT_DATA, which is how a smoke proves the decode names.
   */
  achievements?: number[];
  /**
   * Talent rank spells to write as `character_talent` rows, ONE PER TALENT and
   * at its current rank's spell (`Player::addTalent` counts a row as rank + 1
   * points, so two rows for one talent double-count). DANGEROUS: the loader
   * (`Player::_LoadTalents`) ASSERTs that every row is a talent rank spell, so
   * a wrong id aborts the worldserver at that character's login. Only the
   * party stager writes these, from presets `loadouts.ts` validates and checks
   * against the module's own Talent.dbc reading before any write.
   */
  talents?: number[];
  /**
   * Raise every level-ranged skill row the character already has (weapons,
   * defense, the class's own lines) to the level's maximum, 5 x level. Rows
   * with max 1 (armor, mono skills) and 300 (languages) are untouched, and no
   * skill is added: the loader keeps the stored value and recomputes the max.
   */
  maxSkills?: boolean;
};

/** One quest-log row with its kill counts standing (`Scenario.quests.counted`). */
export type QuestProgress = {
  quest: number;
  mobcount: number[];
  complete?: boolean;
};

/** QUEST_OBJECTIVES_COUNT: character_queststatus carries mobcount1..4. */
export const QUEST_MOBCOUNT_COLUMNS = 4;

/** 2010-01-01 00:00 UTC: a fixed, obviously-fixture date, so builds stay pure. */
export const ACHIEVEMENT_FIXTURE_DATE = 1262304000;
/** Achievement.dbc 6 = "Level 10", category 92, 10 points. */
export const ACHIEVEMENT_LEVEL_10 = 6;

/**
 * Facing from one point toward another, normalised to [0, 2*PI).
 *
 * WoW orientation is the standard atan2(dy, dx) with +x east and +y north; the
 * client and the core both store it in radians on that convention.
 */
function facing(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const o = Math.atan2(to.y - from.y, to.x - from.x);
  return o < 0 ? o + 2 * Math.PI : o;
}

// The Deeprun Tram portal mouth in Tinker Town. The player stands just short of
// the areatrigger and faces it, so a smoke need only walk forward a few yards
// to cross. Areatrigger 2175 ("Deeprun Tram - Ironforge Instance") sits at
// (-4840.26, -1330.46, 508.17) and teleports to map 369; the target row is in
// acore_world.areatrigger_teleport, the trigger's own coordinates are DBC.
const TRAM_MOUTH = { x: -4838.95, y: -1318.46, z: 501.87 };

// Gryth Thurden, entry 1573, the Ironforge flight master on the Great Forge
// ring. Spawn read from acore_world.creature; the start point is a few yards
// off his spot so the character is inside interaction range without standing
// in him.
const GRYTH = { x: -4821.13, y: -1152.4, z: 502.3 };
const GRYTH_FRONT = { x: -4825.5, y: -1158.5, z: 502.3 };
// TaxiNodes.dbc (read off the shipped file, not assumed): 6 = Ironforge,
// 7 = Menethil Harbor, 8 = Thelsamar (Loch Modan) — Thelsamar is the shortest
// hop out of the city. The server also lights node 100 (Honor Hold) for every
// Alliance character at any level (PlayerTaxi::InitTaxiNodesForLevel); that is
// its word, not the fixture's.
// Innkeeper Firebrew (entry 5111), The Stonefire Tavern in Ironforge's
// Commons; spawn from the world DB (guid 1745), o 4.869 — the front is 3y
// along his facing. The scenario plants the dwarf start as the homebind so a
// bind here is a visible change.
const FIREBREW = { x: -4840.67, y: -857.09, z: 502.0 };
const FIREBREW_FRONT = { x: -4840.2, y: -860.1, z: 502.0 };
// `zone` is character_homebind.zoneId, which the core sends back as the bind's
// areaId at login — a real bind there stores the subzone, 132 Coldridge Valley.
const DWARF_START_BIND = { map: 0, zone: 132, x: -6240.32, y: 331.033, z: 382.758 };
export const TAXI_IRONFORGE = 6;
export const TAXI_THELSAMAR = 8;
const TRAM_TRIGGER = { x: -4840.26, y: -1330.46, z: 508.17 };

// Brother Sammuel, entry 925, Paladin trainer in Northshire Abbey. Spawn read
// from acore_world.creature: (-8914.57, -215.016, 82.2996), orientation
// 1.20428. The fixture stands the character three yards in front of him (along
// his facing) and turns it back to face him, which is interact range.
const SAMMUEL = { x: -8914.57, y: -215.016, z: 82.2996, o: 1.20428 };
const SAMMUEL_FRONT = {
  x: SAMMUEL.x + 3 * Math.cos(SAMMUEL.o),
  y: SAMMUEL.y + 3 * Math.sin(SAMMUEL.o),
  z: 82.3,
};

// The near edge of the Northshire vineyard, verbatim from kill-credit.ts's
// proven fight position: from here the closest Kobold Vermin spawns (entry 6,
// `acore_world.creature` rows at x -8783..-8795, y -134..-171) are inside
// update range. Ground here is z 81.5..82.0 by those neighbouring spawns, so
// 82.5 is a fraction above it and the character settles on login. The facing
// looks at guid 79992 (-8783.05, -161.565), the nearest spawn.
const VINEYARD_EDGE = { x: -8790, y: -160, z: 82.5 };
const VINEYARD_NEAREST_VERMIN = { x: -8783.05, y: -161.565 };

// The human starting position, verbatim from acore_world.playercreateinfo
// race 1 (every human class shares it): map 0, zone 12 (Elwynn Forest, which
// is the zone id the core stores for Northshire Valley's parent).
const HUMAN_START = { map: 0, zone: 12, x: -8949.95, y: -132.493, z: 83.5312, o: 0 };

// The Acherus heights (map 609, Ebon Hold's top platform): one of the two Eye
// of Acherus Control Mechanisms (gameobject 191609, acore_world.gameobject
// guid 65961) and a standing spot within interaction range of it.
const ACHERUS_EYE_MECHANISM = { x: 2344.52, y: -5698.26, z: 426.03 };
const ACHERUS_EYE_STAND = { x: 2341.5, y: -5694.5, z: 426.03 };

// The Coldridge Valley road below the pass, and the tunnel's south mouth it
// faces: both are `creature` spawn rows on map 0 (a Coldridge Mountaineer and
// Wren Darkspring), the same landmarks `infra/smoke/travel.ts` leg 1 walks. A
// level-12 character here can walk the pass without the Rockjaw Raiders and
// troggs turning the walk into an `interrupted` (they killed every level-1
// attempt at that gate).
const COLDRIDGE_ROAD = { x: -6115.1, y: 372.3, z: 395.6 };
// Felix's Bucket of Bolts, `acore_world.gameobject` guid 1394 (template
// 178085, a chest with lock 43 = "Open Kneeling"), at the troll camp south of
// the Coldridge Valley lake. Its one loot row is the quest item for
// A Refugee's Quandary (3361), so the chest only opens for a character on it.
const FELIX_BUCKET = { x: -6480.01, y: 505.256, z: 385.988 };
const FELIX_BUCKET_FRONT = { x: -6477.8, y: 504.4, z: 385.988 };
const COLDRIDGE_PASS_MOUTH = { x: -6049.4, y: 383.6 };

// The Goldshire mailbox, `acore_world.gameobject` guid 142075 (template
// type 19), at (-9455.99, 45.82, 56.44). The character stands two yards
// south of it facing it: inside the mailbox's interaction range, and the
// inn's innkeeper and vendors are a few yards further along.
const GOLDSHIRE_MAILBOX = { x: -9455.99, y: 45.82, z: 56.44 };
const GOLDSHIRE_MAILBOX_FRONT = { x: -9457.8, y: 44.6, z: 56.5 };

// Bailey Stonemantle, entry 2461, banker in Ironforge's Vault; spawn from
// acore_world.creature (guid 1754): (-4886.55, -997.594, 504.024), o 2.23402.
// Three yards along his facing, turned back to face him.
const BAILEY = { x: -4886.55, y: -997.594, z: 504.024, o: 2.23402 };
const BAILEY_FRONT = { x: BAILEY.x + 3 * Math.cos(BAILEY.o), y: BAILEY.y + 3 * Math.sin(BAILEY.o), z: 504.03 };

// Marshal McBride, entry 197, the Northshire Abbey questgiver; spawn from
// acore_world.creature (guid 79970): (-8902.59, -162.606, 82.0223), o 2.04204.
// Three yards along his facing, turned back to face him: interact range for
// "Report to Goldshire" (54), whose start item is a readable letter.
const MCBRIDE = { x: -8902.59, y: -162.606, z: 82.0223, o: 2.04204 };
const MCBRIDE_FRONT = { x: MCBRIDE.x + 3 * Math.cos(MCBRIDE.o), y: MCBRIDE.y + 3 * Math.sin(MCBRIDE.o), z: 82.05 };

// Katherine the Pure, entry 5492, paladin trainer in Stormwind's Cathedral of
// Light; spawn from acore_world.creature (guid 37586): (-8565, 880.211,
// 106.519), o 3.783. Her gossip menu (4470) carries "I wish to unlearn my
// talents." (OPTION_UNLEARNTALENTS) where Brother Sammuel's (4663) has only
// "Please teach me." — the Northshire trainer cannot respec anyone, so the
// talent smoke stands here. Three yards along her facing, turned back.
const KATHERINE = { x: -8565, y: 880.211, z: 106.519, o: 3.783 };
const KATHERINE_FRONT = { x: KATHERINE.x + 3 * Math.cos(KATHERINE.o), y: KATHERINE.y + 3 * Math.sin(KATHERINE.o), z: 106.52 };

// A Battered Chest (template 2849, lock 57, groupLootRules set) on the
// Lake Everstill shore below Lakeshire, Redridge: `acore_world.gameobject`
// guid 20651 at (-9405.47, -2786.26, 37.7474), respawn 7200s, in no pool
// (the Elwynn Battered Chests, template 2843, are pooled one-of-five and
// hold only whites). Loot 2280's group 1 is 332 equal-chanced entries, every
// one uncommon, so every open yields exactly one green — the only guaranteed
// over-threshold drop reachable without a rare, an instance or a GM command.
// The nearest hostiles are level-17-19 murlocs 25y+ off, which do not aggro
// a level-30 pair. The pair stands three yards south-west of it, facing it.
const LAKESHIRE_CHEST = { x: -9405.47, y: -2786.26, z: 37.7474 };
const LAKESHIRE_CHEST_FRONT = { x: -9407.6, y: -2788.4, z: 37.8 };

// Ammen Vale, Azuremyst Isle (map 530): the spawn point of runt guid 61618,
// with four more Infected Nightstalker Runts (level 7-8, faction 14) inside
// 40y, each on a 5y wander. Level 20 is gray to them — no aggro — and still
// slow to kill one with level-1 starter gear, which is why the smoke resumes
// a timed-out fight.
const AMMEN_RUNTS = { x: -4412.43, y: -11947.3, z: 21.6033 };

// The Deadmines entrance: AreaTrigger.dbc 78 on map 0 at (-11208.5, 1685.3,
// 25.8), radius 7, at the end of the mine's tunnels under Moonbrook, which
// `areatrigger_teleport` 78 sends to map 36 (docs/proposals/GROUP-PLAY.md §4),
// and the party's staging spots beside it.
//
// The spots are the operator's (2026-10-20): in the last stretch of the
// tunnel just outside the trigger, so entry is one short deliberate move
// through the client's own path (the walk into the volume, the server's
// areatrigger handling, the transfer) without the 660y walk down the mine;
// staging inside the instance would need a server-side instance bind. They
// were Moonbrook's `game_tele` 635, 264y out and past the single-move cap,
// then a spot by the mine building 165y out. Each is on the mesh the tunnels
// are, 10-14y from the trigger's centre (outside its 7y radius, so login
// crosses nothing), and one plain moveTo of the centre walks 6-13y and ends at
// the reachable mesh 4.4y from it, inside the trigger. Nothing hostile is in
// aggro range at level 20: read from the pinned core's base world SQL
// (creature, creature_addon waypoint paths, creature_template detection_range
// and levels), the nearest Defias spawn, wander or patrol point (a Worker 27y
// down the tunnel, Watchmen on the ledge above it) is 9.6y or more past its
// aggro radius (Creature::GetAggroRange: detection_range less the 3-5 levels
// the party stands above them), counting floors above and below without the
// line of sight that would spare them. The homebind is Sentinel Hill,
// `game_tele` 824, area 108; a corpse run from a Westfall graveyard and a
// hearth both stay in the zone.
export const DEADMINES_ENTRANCE_TRIGGER = { id: 78, map: 0, x: -11208.5, y: 1685.3, z: 25.8, radius: 7 };
/**
 * Where each of the party's five members stands, in member order, 2.8y or
 * more apart so no two stand in one another, each facing the trigger.
 */
export const DEADMINES_STAGING_SPOTS: readonly { x: number; y: number; z: number }[] = [
  { x: -11201.9, y: 1676.0, z: 25.8 },
  { x: -11205.5, y: 1675.3, z: 25.0 },
  { x: -11209.5, y: 1675.3, z: 25.2 },
  { x: -11207.5, y: 1673.3, z: 25.0 },
  { x: -11202.5, y: 1672.3, z: 26.3 },
];
/** The first member's spot, and the single character's of the deadmines-entry smoke. */
export const DEADMINES_STAGING = DEADMINES_STAGING_SPOTS[0]!;
export const SENTINEL_HILL_BIND = { map: 0, zone: 108, x: -10624.5, y: 1096.66, z: 33.76 };
/** Westfall (AreaTable); the server recomputes the zone from the position at login. */
export const WESTFALL_ZONE = 40;

// The two party scenarios after the Deadmines', staged the same way (a party
// of five on the walkway outside an instance portal, one plain move of the
// trigger's centre from entry) and read off the same sources: the trigger's
// geometry from AreaTrigger.dbc, its target from `areatrigger_teleport`, the
// spots from the server's own navmesh tiles (data/client/mmaps, read offline:
// each spot is on the polygon component that holds the zone's `game_tele`
// point for the dungeon and reaches into the trigger, with mesh 0.75y around
// it on every side, z the mesh's), the aggro clearance from the pinned core's
// base world SQL (creature, creature_addon and waypoint_data paths, the SAI
// `waypoints` paths, creature_template levels, factions and detection_range,
// FactionTemplate.dbc for who is hostile to an Alliance player), and the
// homebind from `game_tele` with its area from the server's area grid
// (data/client/maps). The spots are 10-14.3y from the trigger's centre, inside
// the Deadmines' 10-14.4y, and 2.8y or more apart.
//
// Shadowfang Keep: AreaTrigger.dbc 145 on map 0 at (-229.49, 1576.35, 78.89),
// radius 7, the keep's gate in Silverpine Forest (zone 130, area 236), which
// `areatrigger_teleport` 145 sends to map 33. The gate's own polygons are an
// island; the walkway outside it, which `game_tele` 836 stands on 15.6y out,
// comes to 5.4y of the centre (inside the sphere), and a move of the centre
// ends there (the module's END_REACHABLE_RADIUS). Silverpine is Horde-held:
// no creature spawn, wander or patrol point is within 100y of the trigger, the
// nearest are the village's spawns 100y+ away and 50y below (faction
// 123, not hostile), and the nearest hostile to an Alliance player, Horde
// NPCs included, is entry 2106 at 174y (aggro radius 16y at level 20), then
// entry 2058 at 203y. The homebind is Southshore, `game_tele` 913, area 271:
// the nearest Alliance inn (Silverpine has none). A corpse run stays in the
// zone: graveyard 1256, `graveyard_zone` 130 for either faction, is 480y south.
export const SHADOWFANG_ENTRANCE_TRIGGER = { id: 145, map: 0, x: -229.49, y: 1576.35, z: 78.89, radius: 7 };
/** The Shadowfang Keep party's five spots on the walkway outside the gate, in member order, each facing the trigger. */
export const SHADOWFANG_STAGING_SPOTS: readonly { x: number; y: number; z: number }[] = [
  { x: -234.0, y: 1567.3, z: 77.0 },
  { x: -231.5, y: 1565.6, z: 77.0 },
  { x: -236.3, y: 1565.6, z: 77.0 },
  { x: -234.8, y: 1563.1, z: 77.0 },
  { x: -232.0, y: 1562.4, z: 77.0 },
];
export const SOUTHSHORE_BIND = { map: 0, zone: 271, x: -853.221, y: -533.529, z: 9.98556 };
/** Silverpine Forest (AreaTable). */
export const SILVERPINE_ZONE = 130;

// The Stockade: AreaTrigger.dbc 101 on map 0, a box (length 4.972, width
// 9.694, height 7.444, yaw 0.6632) centred on (-8761.85, 848.557, 87.805) at
// the foot of the ramp down from the canal in Stormwind City (zone 1519),
// which `areatrigger_teleport` 101 sends to map 34. The centre is on the
// ramp's own mesh, so a move of it walks straight in. The spots are on the
// ramp above it (z 90-91.3), on the component `game_tele` 1435 stands on 23y
// out. Every creature within 100y is friendly to an Alliance player
// (Stormwind's factions 11 and 12) or the civilian trigger creature 15384
// 14y off and 28y below (flags_extra trigger and civilian: it never engages);
// the nearest hostile is entry 3581 at 138y in the sewers. The one patrol
// path ending at the door, SAI path 1706, belongs to creature 1706's map-0
// branch, and that creature is spawned only on map 34. The homebind is the
// Trade District, `game_tele` 954, beside the city's inn.
export const STOCKADE_ENTRANCE_TRIGGER = { id: 101, map: 0, x: -8761.85, y: 848.557, z: 87.805, box: { length: 4.972, width: 9.694, height: 7.444, yaw: 0.6632 } };
/** The Stockade party's five spots on the ramp above the door, in member order, each facing the trigger. */
export const STOCKADE_STAGING_SPOTS: readonly { x: number; y: number; z: number }[] = [
  { x: -8768.0, y: 840.5, z: 90.1 },
  { x: -8771.4, y: 845.3, z: 90.1 },
  { x: -8770.9, y: 842.1, z: 90.7 },
  { x: -8770.6, y: 838.8, z: 91.3 },
  { x: -8774.1, y: 842.8, z: 91.3 },
];
export const STORMWIND_TRADE_BIND = { map: 0, zone: 1519, x: -8833.38, y: 628.628, z: 94.0066 };
/** Stormwind City (AreaTable). */
export const STORMWIND_ZONE = 1519;

// Onyxia's Lair, the first raid scenario: ten spots, read the same way.
// AreaTrigger 2848 on map 1 is a sphere of radius 16 centred at (-4768.61,
// -3752.11, 53.43) inside the cave in the Wyrmbog (Dustwallow Marsh, zone 15,
// area 511), which `areatrigger_teleport` 2848 sends to map 249. Its centre
// floats 7y over the tunnel floor (the mesh there is at z 46.1), so the spots
// are outside the sphere in three dimensions, 17.5-22.8y from its centre, on
// the tunnel floor toward the cave mouth (z 49.5-51.1): the polygon component
// `game_tele` 700 stands on 65y out at the mouth, which reaches 9y from the
// centre inside the sphere, so a walk toward the centre fires it. The mesh
// spans tiles 40,39 and 40,38 here; the component was joined across them on
// their shared edges. Leaving the instance (`areatrigger_teleport` 1064) puts
// a player at (-4747.17, -3753.27, 49.81), among the spots. Nearby, from the
// world SQL: no creature spawn, wander or patrol point (waypoint_data, SAI
// waypoints) is within 79y; the nearest hostile to an Alliance player is a
// Firemane Flamecaller (4334, level 41-42, faction 103, random wander 5y) at
// 94y and 5y below, with eight more of them and a Firemane Scalebane (4328)
// 100-140y out, and a Scorchscale Drake (23687, elite, level 42) wandering
// 20y around a point 123y away and 47y above. At level 80 every one of them
// aggroes at the 5y floor (Creature::GetAggroRange: detection range 18-20
// less a level gap of 38 or more). The approach from Theramore crosses the
// Wyrmbog's dragonkin at the same levels. The homebind is Theramore,
// `game_tele` 1121, area 513 (Theramore Isle), on the mesh at z 8.7; a ghost
// on map 1 returns to Theramore's graveyard (189), and a ghost of map 249 to
// Mudsprocket's (1265), 640y from the door.
export const ONYXIA_ENTRANCE_TRIGGER = { id: 2848, map: 1, x: -4768.61, y: -3752.11, z: 53.43, radius: 16 };
/** The Onyxia's Lair raid's ten spots in the tunnel toward the cave mouth, in member order, each facing the trigger. */
export const ONYXIA_STAGING_SPOTS: readonly { x: number; y: number; z: number }[] = [
  { x: -4752.6, y: -3758.1, z: 49.6 },
  { x: -4751.6, y: -3749.6, z: 49.5 },
  { x: -4753.6, y: -3761.1, z: 50.0 },
  { x: -4750.6, y: -3755.6, z: 49.5 },
  { x: -4750.1, y: -3752.6, z: 49.6 },
  { x: -4749.1, y: -3747.6, z: 50.5 },
  { x: -4749.6, y: -3758.6, z: 50.5 },
  { x: -4747.6, y: -3750.6, z: 50.4 },
  { x: -4747.6, y: -3754.6, z: 50.1 },
  { x: -4746.6, y: -3757.6, z: 51.1 },
];
export const THERAMORE_BIND = { map: 1, zone: 513, x: -3641.3, y: -4358.93, z: 8.35467 };
/** Dustwallow Marsh (AreaTable). */
export const DUSTWALLOW_ZONE = 15;

// The steep re-plan smoke's starts: points a freeplay character stood on when
// the module refused its move as `drop` at a 51-58 degree step, read off the
// module's own move_path rows (the route's first point), and the point each
// refused move asked for, which the start faces. Level 80 so nothing in
// Ashenvale (map 1, zone 331) or the Badlands (map 0, zone 3; the server
// recomputes the zone from the position at login) aggroes or interrupts a
// walk.
// The Thunderbrew Distillery in Kharanos (Dun Morogh, zone 1), for the
// module-navigation smoke's optional mesh-z leg: the floor a freeplay
// character stood on when its walk down the cellar's switchback stairs to
// Jarven Thunderbrew was refused as a 5.1y fall, because the core had settled
// the stair point under the landing onto the landing.
const NAV_KHARANOS_FLOOR = { x: -5586.76, y: -542.163, z: 403.541 };
export const NAV_KHARANOS_JARVEN = { x: -5606, y: -544.5, z: 392.5 };
const STEEP_ASH_LOWLAND = { x: 3200, y: 100, z: 27.99 };
const STEEP_ASH_LOWLAND_TO = { x: 3190.13, y: -106.667 };
const STEEP_ASH_CLIMB = { x: 3085.2, y: 89.96, z: 50.63 };
const STEEP_ASH_CLIMB_TO = { x: 3087.73, y: 71.2 };
const STEEP_ASH_BAND = { x: 3068.05, y: 146.45, z: 33.85 };
const STEEP_ASH_BAND_TO = { x: 3008, y: 128 };
const STEEP_BAD_PLATEAU = { x: -5840, y: -3320, z: 295.87 };
const STEEP_BAD_PLATEAU_TO = { x: -5897.6, y: -3356.8 };
const STEEP_BAD_LIP = { x: -6080, y: -3370, z: 292.96 };
const STEEP_BAD_LIP_TO = { x: -6140, y: -3370 };
const STEEP_BAD_BASIN = { x: -6050, y: -3300, z: 258.71 };
const STEEP_BAD_BASIN_TO = { x: -6121.87, y: -3482.93 };
// Dun Morogh hillsides a freeplay character was refused climbing at 56-61
// degrees, which the mesh (built to 60) planned up and the client's 50 does
// not walk (steep-replan smoke, P9-P11).
const STEEP_DM_VALLEY = { x: -5725.1, y: -409.7, z: 366.3 };
const STEEP_DM_VALLEY_TO = { x: -5644.0, y: -499.0 };
const STEEP_DM_RIDGE = { x: -5746.9, y: -371.4, z: 366.9 };
const STEEP_DM_RIDGE_TO = { x: -5917.5, y: -266.3 };
const STEEP_DM_ROAD = { x: -5832.6, y: -291.3, z: 358.4 };
const STEEP_DM_ROAD_TO = { x: -5698.1, y: -439.3 };

// The swim smoke's shore: the open sea north of Menethil Harbor (map 0,
// Wetlands, zone 11), where a freeplay run crossed the bay at about 13 y/s
// before the module swam. Read off the server data's own terrain and liquid
// grid (data/client/maps): dry ground at about 9.5 to x -3610, the bed
// falling to 1.5y under the sea's surface (level 0) at about x -3601 and to
// 8-35y deep from x -3590 out to x -2960, open ocean the whole way (no dark
// water, so no fatigue). The swimmer stands on the shore facing the sea, the
// observer ten yards behind it, inside visibility of the swim start.
export const SWIM_SHORE = { x: -3622, y: -797.5, z: 9.54 };
export const SWIM_OBSERVER_SPOT = { x: -3632, y: -788, z: 9.9 };
export const SWIM_SEA_LEVEL = 0;
const SWIM_SEA_TOWARD = { x: -3480, y: -800 };

// The edge-drop smoke's start: the north-west rim of the Skettis plateau in
// Terokkar Forest (map 530, zone 3519), whose mesh links to nothing below — a
// freeplay ghost released at graveyard 1298 (Lake Jorune GY, EDGE_SKETTIS_GY)
// was refused every move down. The rim point and the lowland point below it
// are that ghost's own move: the edge 8y out, a 71y fall, the landing on the
// lowland mesh that held its corpse, one fall in all. A character standing on
// the rim gets no partial route to walk first (the mesh's search toward the
// lowland ends on the rim's own polygon), so the move does not depend on how
// far the core's search runs; from the graveyard it ends wherever its nodes
// run out (a shelf target sent it to a lower spur and then nowhere), and the
// line due north meets a 6y bank of 55-61 degrees under the cliff, a second
// ledge. Level 80 so the plateau's arakkoa do not end a walk.
export const EDGE_SKETTIS_GY = { x: -2433.6, y: 4661.0, z: 160.9 };
export const EDGE_SKETTIS_RIM = { x: -2529.6, y: 4774.67, z: 136.65 };
export const EDGE_SKETTIS_BELOW = { x: -2516.3, y: 4804.8, z: 61.6 };

export const SCENARIOS = {
  "mcbride-report": {
    description: "level 5, no money, in front of Marshal McBride with the Northshire chain up to Skirmish at Echo Ridge (21) rewarded (for the read-item smoke: Report to Goldshire hands out a readable letter)",
    level: 5,
    money: 0,
    position: {
      map: 0,
      zone: 12,
      ...MCBRIDE_FRONT,
      o: facing(MCBRIDE_FRONT, MCBRIDE),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    clearQuests: true,
    // 54's PrevQuestID is 21, whose chain runs 783 -> 7 -> 15 -> 21
    // (quest_template_addon); every link rewarded is the whole gate.
    quests: { rewarded: [783, 7, 15, 21] },
  },
  "battered-chest-lakeshire": {
    description: "level 30, no money, facing the Battered Chest on the Lake Everstill shore below Lakeshire (for the loot-roll smoke: two of these, grouped, open it for its guaranteed green)",
    level: 30,
    money: 0,
    position: {
      map: 0,
      // 44 = Redridge Mountains (AreaTable).
      zone: 44,
      ...LAKESHIRE_CHEST_FRONT,
      o: facing(LAKESHIRE_CHEST_FRONT, LAKESHIRE_CHEST),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
  },
  "mailbox-goldshire": {
    description: "level 1, 50s, in front of the Goldshire mailbox (for the mail smoke: postage plus enclosed money)",
    level: 1,
    money: 5000,
    position: {
      map: 0,
      zone: 12,
      ...GOLDSHIRE_MAILBOX_FRONT,
      o: facing(GOLDSHIRE_MAILBOX_FRONT, GOLDSHIRE_MAILBOX),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
  },
  "bank-ironforge": {
    description: "level 1, no money, in front of Bailey Stonemantle (Ironforge banker)",
    level: 1,
    money: 0,
    position: {
      map: 0,
      zone: 1537,
      ...BAILEY_FRONT,
      o: facing(BAILEY_FRONT, BAILEY),
    },
    homebind: { map: 0, zone: 1537, x: -4918.88, y: -940.406, z: 501.564 },
  },
  "tram-ironforge": {
    description: "level 10, 1g, standing at the Deeprun Tram portal in Ironforge facing the areatrigger",
    level: 10,
    money: 10000,
    position: {
      map: 0,
      // 1537 = Ironforge (AreaTable). The Tinker Town tram entrance is inside
      // the city proper, so the whole platform is this one zone id.
      zone: 1537,
      ...TRAM_MOUTH,
      o: facing(TRAM_MOUTH, TRAM_TRIGGER),
    },
    // Ironforge homebind, so a hearth or a corpse run lands in the city rather
    // than back in Elwynn. Position from acore_world.game_tele "Ironforge".
    homebind: { map: 0, zone: 1537, x: -4918.88, y: -940.406, z: 501.564 },
  },
  "taxi-ironforge": {
    description: "level 10, 1g, in front of Gryth Thurden (Ironforge flight master) with Ironforge and Thelsamar visited",
    level: 10,
    money: 10000,
    position: {
      map: 0,
      zone: 1537,
      ...GRYTH_FRONT,
      o: facing(GRYTH_FRONT, GRYTH),
    },
    homebind: { map: 0, zone: 1537, x: -4918.88, y: -940.406, z: 501.564 },
    taxiNodes: [TAXI_IRONFORGE, TAXI_THELSAMAR],
    achievements: [ACHIEVEMENT_LEVEL_10],
  },
  "inn-ironforge": {
    description: "level 10, 1g, in front of Innkeeper Firebrew (Ironforge) with the hearthstone bound to Coldridge Valley",
    level: 10,
    money: 10000,
    position: {
      map: 0,
      zone: 1537,
      ...FIREBREW_FRONT,
      o: facing(FIREBREW_FRONT, FIREBREW),
    },
    homebind: DWARF_START_BIND,
  },
  "trainer-northshire": {
    description: "level 4, 50s, standing in front of Brother Sammuel in Northshire Abbey",
    level: 4,
    money: 5000,
    position: {
      map: 0,
      zone: 12,
      ...SAMMUEL_FRONT,
      o: facing(SAMMUEL_FRONT, SAMMUEL),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
  },
  "talents-stormwind": {
    description: "level 10, 5g, standing in front of Katherine the Pure in Stormwind's cathedral (one talent point to spend and a respec to buy — her menu has the unlearn option, Sammuel's does not)",
    level: 10,
    money: 50000,
    position: {
      map: 0,
      // 1519 = Stormwind City (AreaTable).
      zone: 1519,
      ...KATHERINE_FRONT,
      o: facing(KATHERINE_FRONT, KATHERINE),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
  },
  "northshire-fresh": {
    description: "reset: level 1, no money, human start position, empty quest log",
    level: 1,
    xp: 0,
    money: 0,
    position: { ...HUMAN_START },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    clearQuests: true,
  },
  "coldridge-valley": {
    description:
      "level 12, no money, on the Coldridge Valley road below the pass — the start of the legacy travel.ts tunnel walk",
    level: 12,
    money: 0,
    position: {
      map: 0,
      // 132 = Coldridge Valley (AreaTable), the dwarf starting subzone.
      zone: 132,
      ...COLDRIDGE_ROAD,
      o: facing(COLDRIDGE_ROAD, COLDRIDGE_PASS_MOUTH),
    },
    homebind: DWARF_START_BIND,
  },
  "felix-bucket": {
    description:
      "level 5, no money, in front of Felix's Bucket of Bolts (Coldridge Valley) with A Refugee's Quandary (3361) in the log (for the chest-loot smoke)",
    level: 5,
    money: 0,
    position: {
      map: 0,
      zone: 132,
      ...FELIX_BUCKET_FRONT,
      o: facing(FELIX_BUCKET_FRONT, FELIX_BUCKET),
    },
    homebind: DWARF_START_BIND,
    // Rebuilt every run: the smoke loots the quest item, and a log that already
    // holds it would make the chest show empty the next time.
    clearQuests: true,
    quests: { inProgress: [3361] },
  },
  "vineyard-kill-credit": {
    description:
      "level 1, no money, at the Northshire vineyard edge with Kobold Camp Cleanup (7) in the log and A Threat Within (783) already rewarded",
    level: 1,
    xp: 0,
    money: 0,
    position: {
      map: 0,
      zone: 12,
      ...VINEYARD_EDGE,
      o: facing(VINEYARD_EDGE, VINEYARD_NEAREST_VERMIN),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    // The log is rebuilt from scratch every time: `character_queststatus`
    // carries mobcount1..4, and the inProgress insert is INSERT IGNORE, so
    // without the wipe the second run would start with last run's kill already
    // counted and the `current === 1` assertion would fail.
    clearQuests: true,
    quests: {
      // 7's PrevQuestID is 783 (quest_template_addon), ExclusiveGroup 0 and no
      // other gate, so one rewarded row is the whole prerequisite. The core
      // does not re-check it when loading the log, but a character that holds
      // 7 without having finished 783 is a state a player could not reach.
      rewarded: [783],
      inProgress: [7],
    },
  },
  "vineyard-last-kill": {
    description:
      "level 1, no money, at the Northshire vineyard edge with A Threat Within (783) rewarded and Kobold Camp Cleanup (7) in the log at 7 of 8 Kobold Vermin (for the kill-credit deploy smoke: its one kill completes the objective)",
    level: 1,
    xp: 0,
    money: 0,
    position: {
      map: 0,
      zone: 12,
      ...VINEYARD_EDGE,
      o: facing(VINEYARD_EDGE, VINEYARD_NEAREST_VERMIN),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    // Rebuilt every run, as vineyard-kill-credit is: the smoke's kill takes
    // 7 to 8/8 and complete, and the next run must start at 7 again.
    clearQuests: true,
    quests: {
      rewarded: [783],
      counted: [{ quest: 7, mobcount: [7] }],
    },
  },
  "mcbride-kill-quest-done": {
    description:
      "level 1 at 300 of 400 xp, no money, in front of Marshal McBride with A Threat Within (783) rewarded and Kobold Camp Cleanup (7) complete at 8 of 8 (for the module-quest deploy smoke: the kill quest's turn-in, which levels the character to 2)",
    level: 1,
    // 300 + the turn-in's 170 crosses level 2's 400, so the reward's level-up
    // is on the stream too.
    xp: 300,
    money: 0,
    position: {
      map: 0,
      zone: 12,
      ...MCBRIDE_FRONT,
      o: facing(MCBRIDE_FRONT, MCBRIDE),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    // The turn-in rewards 7, and a rewarded quest is not offered again.
    clearQuests: true,
    quests: {
      rewarded: [783],
      counted: [{ quest: 7, mobcount: [8], complete: true }],
    },
  },
  "ammen-vale-runts": {
    description:
      "level 20, no money, empty quest log, among a cluster of Infected Nightstalker Runts (17202) in Ammen Vale (for the quest-item-start smoke: every runt drops the Faintly Glowing Crystal (23678), which starts Strange Findings (9455) and has no on-use spell)",
    level: 20,
    xp: 0,
    money: 0,
    position: {
      map: 530,
      // 3524 = Azuremyst Isle (AreaTable); the runts stand in Ammen Vale.
      zone: 3524,
      ...AMMEN_RUNTS,
      o: 0,
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    // The crystal only drops for a character who can still take 9455
    // (LootMgr: a start-quest item is hidden once the quest is in the log or
    // rewarded), so the log is wiped every run.
    clearQuests: true,
  },
  // The Death Knight start's first vehicle, for the eye-of-acherus smoke. Two
  // scenarios because a Death Knight cannot be created on an account without a
  // level-55 character (CharacterCreating.MinLevelForHeroicCharacter): the
  // sponsor is that character, placed and never played; the knight stands on
  // the Acherus heights by an Eye of Acherus Control Mechanism (gameobject
  // 191609 at 2344.52, -5698.26 on map 609), a goober that takes
  // CMSG_GAMEOBJ_USE from a character with Death Comes From On High (12641)
  // in its log and casts its spell (51888), which summons the Eye and
  // possesses it for the user. The chain before it is turned in so the log
  // is the one a player has at that point.
  "acherus-sponsor": {
    description: "level 55 at the human start with nothing else: the account's qualifying character for a Death Knight create",
    level: 55,
    xp: 0,
    money: 0,
    position: { ...HUMAN_START },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    clearQuests: true,
  },
  "acherus-eye": {
    description:
      "level 55 on the Acherus heights (map 609) within reach of an Eye of Acherus Control Mechanism, Death Comes From On High (12641) in the log and its chain turned in",
    level: 55,
    xp: 0,
    money: 0,
    position: { map: 609, zone: 4298, ...ACHERUS_EYE_STAND, o: facing(ACHERUS_EYE_STAND, ACHERUS_EYE_MECHANISM) },
    homebind: { map: 609, zone: 4298, ...ACHERUS_EYE_STAND },
    clearQuests: true,
    quests: { rewarded: [12593, 12619, 12842, 12848, 12636], inProgress: [12641] },
  },
  "vineyard-warlock": {
    description:
      "level 1, no money, at the Northshire vineyard edge knowing Summon Imp (688) (for the pet smoke: a fresh warlock is not given the imp here — 688 is a level-1 trainer spell on Drusilla La Salle — so the fixture grants it)",
    level: 1,
    xp: 0,
    money: 0,
    spells: [688],
    position: {
      map: 0,
      zone: 12,
      ...VINEYARD_EDGE,
      o: facing(VINEYARD_EDGE, VINEYARD_NEAREST_VERMIN),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
  },
  "moonbrook-mine": {
    description:
      "level 80, 1g, in the mine's last tunnel under Moonbrook facing the Deadmines entrance trigger, 11y away, homebind Sentinel Hill, empty quest log (for the deadmines-entry smoke: level 80 so nothing interrupts it; the party's five members stand on the five spots there at level 20, infra/fixtures/loadouts.ts)",
    level: 80,
    xp: 0,
    money: 10000,
    position: { map: 0, zone: WESTFALL_ZONE, ...DEADMINES_STAGING, o: facing(DEADMINES_STAGING, DEADMINES_ENTRANCE_TRIGGER) },
    partySpots: DEADMINES_STAGING_SPOTS.map((p) => ({ map: 0, zone: WESTFALL_ZONE, ...p, o: facing(p, DEADMINES_ENTRANCE_TRIGGER) })),
    homebind: SENTINEL_HILL_BIND,
    clearQuests: true,
  },
  "silverpine-keep": {
    description:
      "level 80, 1g, on the walkway outside Shadowfang Keep's gate facing its entrance trigger, 10y away, homebind Southshore, empty quest log (a party scenario: the five members stand on the five spots there at the request's level, infra/fixtures/loadouts.ts; a single character stands on the first at 80)",
    level: 80,
    xp: 0,
    money: 10000,
    position: { map: 0, zone: SILVERPINE_ZONE, ...SHADOWFANG_STAGING_SPOTS[0]!, o: facing(SHADOWFANG_STAGING_SPOTS[0]!, SHADOWFANG_ENTRANCE_TRIGGER) },
    partySpots: SHADOWFANG_STAGING_SPOTS.map((p) => ({ map: 0, zone: SILVERPINE_ZONE, ...p, o: facing(p, SHADOWFANG_ENTRANCE_TRIGGER) })),
    homebind: SOUTHSHORE_BIND,
    clearQuests: true,
  },
  "stormwind-stockade": {
    description:
      "level 80, 1g, on the ramp above the Stockade's door in Stormwind facing its entrance trigger, 10y away, homebind the Trade District, empty quest log (a party scenario: the five members stand on the five spots there at the request's level, infra/fixtures/loadouts.ts; a single character stands on the first at 80)",
    level: 80,
    xp: 0,
    money: 10000,
    position: { map: 0, zone: STORMWIND_ZONE, ...STOCKADE_STAGING_SPOTS[0]!, o: facing(STOCKADE_STAGING_SPOTS[0]!, STOCKADE_ENTRANCE_TRIGGER) },
    partySpots: STOCKADE_STAGING_SPOTS.map((p) => ({ map: 0, zone: STORMWIND_ZONE, ...p, o: facing(p, STOCKADE_ENTRANCE_TRIGGER) })),
    homebind: STORMWIND_TRADE_BIND,
    clearQuests: true,
  },
  "dustwallow-lair": {
    description:
      "level 80, 1g, in the tunnel outside Onyxia's Lair's entrance trigger in the Wyrmbog facing it, 17.5y away, homebind Theramore, empty quest log (a raid scenario: the ten members stand on the ten spots there at 80, infra/fixtures/loadouts.ts; a single character stands on the first)",
    level: 80,
    xp: 0,
    money: 10000,
    position: { map: 1, zone: DUSTWALLOW_ZONE, ...ONYXIA_STAGING_SPOTS[0]!, o: facing(ONYXIA_STAGING_SPOTS[0]!, ONYXIA_ENTRANCE_TRIGGER) },
    partySpots: ONYXIA_STAGING_SPOTS.map((p) => ({ map: 1, zone: DUSTWALLOW_ZONE, ...p, o: facing(p, ONYXIA_ENTRANCE_TRIGGER) })),
    homebind: THERAMORE_BIND,
    clearQuests: true,
  },
  "vineyard-priest": {
    description:
      "level 10, no money, at the Northshire vineyard edge knowing Resurrection (2006) (for death-recovery's resurrection leg: the priest trainer teaches rank 1 at level 10, trainer_spell 11, so the fixture grants it)",
    level: 10,
    xp: 0,
    money: 0,
    spells: [2006],
    position: {
      map: 0,
      zone: 12,
      ...VINEYARD_EDGE,
      o: facing(VINEYARD_EDGE, VINEYARD_NEAREST_VERMIN),
    },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
  },
  "nav-kharanos-floor": {
    description: "level 80, no money, on the Thunderbrew Distillery floor in Kharanos above the cellar stairs (module-navigation smoke: the optional mesh-z leg down to Jarven Thunderbrew)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 1, ...NAV_KHARANOS_FLOOR, o: facing(NAV_KHARANOS_FLOOR, NAV_KHARANOS_JARVEN) },
  },
  "steep-ashenvale-lowland": {
    description: "level 80, no money, on the Ashenvale coastal lowland below the Maestra's Post hills (steep-replan smoke: one climb refusal, one off-mesh point)",
    level: 80,
    money: 0,
    position: { map: 1, zone: 331, ...STEEP_ASH_LOWLAND, o: facing(STEEP_ASH_LOWLAND, STEEP_ASH_LOWLAND_TO) },
  },
  "steep-ashenvale-climb": {
    description: "level 80, no money, at the foot of the most-refused Ashenvale climb edge (steep-replan smoke)",
    level: 80,
    money: 0,
    position: { map: 1, zone: 331, ...STEEP_ASH_CLIMB, o: facing(STEEP_ASH_CLIMB, STEEP_ASH_CLIMB_TO) },
  },
  "steep-ashenvale-band": {
    description: "level 80, no money, below a 52 degree Ashenvale band (steep-replan smoke)",
    level: 80,
    money: 0,
    position: { map: 1, zone: 331, ...STEEP_ASH_BAND, o: facing(STEEP_ASH_BAND, STEEP_ASH_BAND_TO) },
  },
  "steep-badlands-plateau": {
    description: "level 80, no money, on the Loch Modan plateau edge above the Badlands basin (steep-replan smoke: one step down)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 3, ...STEEP_BAD_PLATEAU, o: facing(STEEP_BAD_PLATEAU, STEEP_BAD_PLATEAU_TO) },
  },
  "steep-badlands-lip": {
    description: "level 80, no money, on the lower lip of the Badlands stepped band (steep-replan smoke: one climb refusal)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 3, ...STEEP_BAD_LIP, o: facing(STEEP_BAD_LIP, STEEP_BAD_LIP_TO) },
  },
  "steep-badlands-basin": {
    description: "level 80, no money, in the Badlands basin below its south wall (steep-replan smoke: one climb refusal, one off-mesh point)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 3, ...STEEP_BAD_BASIN, o: facing(STEEP_BAD_BASIN, STEEP_BAD_BASIN_TO) },
  },
  "steep-dunmorogh-valley": {
    description: "level 80, no money, in the Dun Morogh valley west of Kharanos below a 57 degree hillside (steep-replan smoke: one climb refusal)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 1, ...STEEP_DM_VALLEY, o: facing(STEEP_DM_VALLEY, STEEP_DM_VALLEY_TO) },
  },
  "steep-dunmorogh-ridge": {
    description: "level 80, no money, in the Dun Morogh valley west of Kharanos below a 61 degree ridge (steep-replan smoke: one climb refusal)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 1, ...STEEP_DM_RIDGE, o: facing(STEEP_DM_RIDGE, STEEP_DM_RIDGE_TO) },
  },
  "steep-dunmorogh-road": {
    description: "level 80, no money, on the Dun Morogh road west of Kharanos below a 56 degree hillside (steep-replan smoke: one climb refusal)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 1, ...STEEP_DM_ROAD, o: facing(STEEP_DM_ROAD, STEEP_DM_ROAD_TO) },
  },
  "swim-menethil-shore": {
    description: "level 80, no money, on the shore north of Menethil Harbor facing the open sea (swim smoke: the swimmer)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 11, ...SWIM_SHORE, o: facing(SWIM_SHORE, SWIM_SEA_TOWARD) },
  },
  "swim-menethil-observer": {
    description: "level 80, no money, on the shore north of Menethil Harbor beside the swimmer's start (swim smoke: the observer)",
    level: 80,
    money: 0,
    position: { map: 0, zone: 11, ...SWIM_OBSERVER_SPOT, o: facing(SWIM_OBSERVER_SPOT, SWIM_SEA_TOWARD) },
  },
  "edge-drop-skettis": {
    description:
      "level 80, no money, on the Skettis plateau's north-west rim, facing the lowland 75y below (edge-drop smoke: a move off the end of the plateau's mesh)",
    level: 80,
    money: 0,
    position: { map: 530, zone: 3519, ...EDGE_SKETTIS_RIM, o: facing(EDGE_SKETTIS_RIM, EDGE_SKETTIS_BELOW) },
  },
} as const satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;

export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

export function isScenarioName(name: string): name is ScenarioName {
  return Object.hasOwn(SCENARIOS, name);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid scenario: ${message}`);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isIdList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => Number.isInteger(n) && (n as number) > 0);

/**
 * Structural check on a scenario. Cheap insurance: these values are written
 * straight into a live character row, and a NaN coordinate or a level of 0
 * produces a character the worldserver loads into nowhere.
 */
export function validateScenario(scenario: Scenario): void {
  assert(Number.isInteger(scenario.level) && scenario.level >= 1 && scenario.level <= 80, "level must be 1..80");
  assert(scenario.xp === undefined || (Number.isInteger(scenario.xp) && scenario.xp >= 0), "xp must be a non-negative integer");
  assert(
    scenario.money === undefined || (Number.isInteger(scenario.money) && scenario.money >= 0),
    "money must be a non-negative integer (copper)",
  );

  for (const [what, p] of [["position", scenario.position] as const, ...(scenario.partySpots ?? []).map((q, i) => [`partySpots[${i}]`, q] as const)]) {
    assert(p && Number.isInteger(p.map) && p.map >= 0, `${what}.map must be a non-negative integer`);
    assert(Number.isInteger(p.zone) && p.zone >= 0, `${what}.zone must be a non-negative integer`);
    for (const k of ["x", "y", "z", "o"] as const) {
      assert(isFiniteNumber(p[k]), `${what}.${k} must be a finite number`);
    }
    assert(p.o >= 0 && p.o < 2 * Math.PI, `${what}.o must be in [0, 2*PI)`);
  }

  if (scenario.homebind) {
    const h = scenario.homebind;
    assert(Number.isInteger(h.map) && h.map >= 0, "homebind.map must be a non-negative integer");
    assert(Number.isInteger(h.zone) && h.zone >= 0, "homebind.zone must be a non-negative integer");
    for (const k of ["x", "y", "z"] as const) {
      assert(isFiniteNumber(h[k]), `homebind.${k} must be a finite number`);
    }
  }

  assert(scenario.spells === undefined || isIdList(scenario.spells), "spells must be positive integer ids");
  assert(
    scenario.quests?.inProgress === undefined || isIdList(scenario.quests.inProgress),
    "quests.inProgress must be positive integer ids",
  );
  assert(
    scenario.quests?.rewarded === undefined || isIdList(scenario.quests.rewarded),
    "quests.rewarded must be positive integer ids",
  );
  for (const c of scenario.quests?.counted ?? []) {
    assert(Number.isInteger(c.quest) && c.quest > 0, "quests.counted[].quest must be a positive integer id");
    assert(
      Array.isArray(c.mobcount) &&
        c.mobcount.length >= 1 &&
        c.mobcount.length <= QUEST_MOBCOUNT_COLUMNS &&
        c.mobcount.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff),
      `quests.counted[].mobcount must be 1..${QUEST_MOBCOUNT_COLUMNS} counts in 0..65535`,
    );
    assert(
      !(scenario.quests?.inProgress ?? []).includes(c.quest) && !(scenario.quests?.rewarded ?? []).includes(c.quest),
      `quest ${c.quest} is in quests.counted and also in inProgress or rewarded`,
    );
  }
  assert(
    new Set((scenario.quests?.counted ?? []).map((c) => c.quest)).size === (scenario.quests?.counted ?? []).length,
    "quests.counted must not repeat a quest",
  );
  assert(
    scenario.taxiNodes === undefined || (isIdList(scenario.taxiNodes) && scenario.taxiNodes.every((n) => n <= TAXI_MASK_WORDS * 32)),
    `taxiNodes must be TaxiNodes.dbc ids in 1..${TAXI_MASK_WORDS * 32}`,
  );

  assert(scenario.achievements === undefined || isIdList(scenario.achievements), "achievements must be positive integer ids");
  assert(scenario.talents === undefined || isIdList(scenario.talents), "talents must be positive integer spell ids");
  assert(
    scenario.talents === undefined || new Set(scenario.talents).size === scenario.talents.length,
    "talents must not repeat a spell",
  );
}

/** `characters.taximask` is 14 u32 words in 3.3.5 (TaxiMaskSize); node n sets bit n-1. */
export const TAXI_MASK_WORDS = 14;

export function taxiMask(nodes: number[]): string {
  const words = new Array<number>(TAXI_MASK_WORDS).fill(0);
  for (const n of nodes) {
    const bit = n - 1;
    words[Math.floor(bit / 32)] = (words[Math.floor(bit / 32)]! | (1 << bit % 32)) >>> 0;
  }
  return words.join(" ");
}
