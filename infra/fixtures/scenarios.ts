/**
 * Named scenarios for smoke characters.
 *
 * A scenario is the state a logged-out smoke character is put into so that a
 * smoke can prove a late-game claim in seconds instead of playing minutes to
 * reach it (docs/FOLLOW-UPS.md item 45). This file is data plus the pure
 * helpers that validate it; `apply.ts` is what talks to the database.
 *
 * Operator tooling only. Nothing here is reachable from `runner/` or `sdk/`,
 * so the agent-facing contract in docs/CONTRACTS.md is untouched: the agent
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
 * not through this tool.
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
  homebind?: Homebind;
  /** Spell ids to add (INSERT IGNORE; never removes what is already known). */
  spells?: number[];
  quests?: {
    /** Quest ids to put in the log as QUEST_STATUS_INCOMPLETE. */
    inProgress?: number[];
    /** Quest ids to mark as already turned in. */
    rewarded?: number[];
  };
  /** Wipe the quest log and the rewarded list first. Makes the scenario a reset. */
  clearQuests?: boolean;
};

/**
 * Facing from one point toward another, normalised to [0, 2*PI).
 *
 * WoW orientation is the standard atan2(dy, dx) with +x east and +y north; the
 * client and the core both store it in radians on that convention.
 */
export function facing(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const o = Math.atan2(to.y - from.y, to.x - from.x);
  return o < 0 ? o + 2 * Math.PI : o;
}

// The Deeprun Tram portal mouth in Tinker Town. The player stands just short of
// the areatrigger and faces it, so a smoke need only walk forward a few yards
// to cross. Areatrigger 2175 ("Deeprun Tram - Ironforge Instance") sits at
// (-4840.26, -1330.46, 508.17) and teleports to map 369; the target row is in
// acore_world.areatrigger_teleport, the trigger's own coordinates are DBC.
const TRAM_MOUTH = { x: -4838.95, y: -1318.46, z: 501.87 };
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

// The human starting position, verbatim from acore_world.playercreateinfo
// race 1 (every human class shares it): map 0, zone 12 (Elwynn Forest, which
// is the zone id the core stores for Northshire Valley's parent).
const HUMAN_START = { map: 0, zone: 12, x: -8949.95, y: -132.493, z: 83.5312, o: 0 };

export const SCENARIOS = {
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
  "northshire-fresh": {
    description: "reset: level 1, no money, human start position, empty quest log",
    level: 1,
    xp: 0,
    money: 0,
    position: { ...HUMAN_START },
    homebind: { map: HUMAN_START.map, zone: HUMAN_START.zone, x: HUMAN_START.x, y: HUMAN_START.y, z: HUMAN_START.z },
    clearQuests: true,
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

  const p = scenario.position;
  assert(p && Number.isInteger(p.map) && p.map >= 0, "position.map must be a non-negative integer");
  assert(Number.isInteger(p.zone) && p.zone >= 0, "position.zone must be a non-negative integer");
  for (const k of ["x", "y", "z", "o"] as const) {
    assert(isFiniteNumber(p[k]), `position.${k} must be a finite number`);
  }
  assert(p.o >= 0 && p.o < 2 * Math.PI, "position.o must be in [0, 2*PI)");

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
}
