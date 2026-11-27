/**
 * HUD lines the party runs added or changed: the map beside the zone, the
 * position in flight, the portals in view, where a ghost stands and how far
 * below its corpse is, worn durability, the party frames (no auras, operator
 * decision) and a corpse named by its owner. Names and positions are
 * invented.
 */
import { describe, expect, test } from "bun:test";

import { formatStateSummary, type SnapshotLike } from "../src/context";

const at = (map: number, x: number, y: number, z: number) => ({ value: { map, x, y, z }, seq: 5 });
const ghost = { fields: { playerFlags: { value: 0x10 } }, health: { value: { current: 1, max: 100 } } };
const hud = (snap: SnapshotLike, now?: number): string => formatStateSummary(snap, { sessionLive: true, ...(now !== undefined ? { now } : {}) });

describe("position: the map's name and kind beside the zone", () => {
  test("open world outside a portal, the instance inside, the subzone first, and no stale map name after a transfer", () => {
    const self = (map: number, pos: ReturnType<typeof at>, mapName: string, instanceType: string, area = "The Fixture Mine") => ({
      self: {
        position: pos,
        zone: { value: { id: 1581, name: "The Fixture Mine" } },
        area: { value: { id: area === "The Fixture Mine" ? 1581 : 9, name: area } },
        map: { value: { id: map, name: mapName, instanceType } },
      },
    });
    expect(hud(self(0, at(0, -1201.9, 1676, 25.8), "Fixture Continent", "none"))).toContain(
      "position: The Fixture Mine, Fixture Continent (open world) — map 0 (-1201.9, 1676, 25.8) [seq 5]",
    );
    expect(hud(self(36, at(36, -16.4, -383.1, 61.8), "Fixture Depths", "party"))).toContain(
      "position: The Fixture Mine, Fixture Depths (dungeon instance) — map 36 (-16.4, -383.1, 61.8)",
    );
    expect(hud(self(0, at(0, 1, 2, 3), "Fixture Continent", "none", "Fixture Vale"))).toContain(
      "position: The Fixture Mine / Fixture Vale, Fixture Continent (open world) — map 0 (1, 2, 3)",
    );
    expect(hud({ self: { position: at(36, 1, 2, 3), map: { value: { id: 0, name: "Fixture Continent", instanceType: "none" } } } })).toContain("position: map 36 (1, 2, 3)");
  });

  test("in flight: the zone text follows the flight; the coordinates are where it took off", () => {
    const text = hud(
      {
        self: {
          position: { value: { map: 0, x: -1628.3, y: 1037.3, z: 34.1, inFlight: true }, seq: 9 },
          zone: { value: { id: 40, name: "Westfall" } },
          area: { value: { id: 918, name: "Saldean's Farm" } },
          map: { value: { id: 0, name: "Eastern Kingdoms", instanceType: "none" } },
          taxiEta: { value: { durationMs: 81_046, landsAt: 1_051_000 } },
        },
      },
      1_000_000,
    );
    expect(text).toContain(
      "position: in flight over Westfall / Saldean's Farm, Eastern Kingdoms (open world) — took off from map 0 (-1628.3, 1037.3, 34.1), lands in ~51s [seq 9]",
    );
  });
});

describe("portals: the dungeon entrances and exits in view", () => {
  test("nearest first, with the map each leads to and the distance; absent when none is in view", () => {
    const portals = {
      value: [
        { triggerId: 9002, map: 0, x: -1300, y: 1676, z: 30, to: { id: 1, name: "Fixture West", instanceType: "none" } },
        { triggerId: 9001, map: 0, x: -1208, y: 1685, z: 26, to: { id: 36, name: "Fixture Depths", instanceType: "party" } },
      ],
    };
    expect(hud({ self: { position: at(0, -1201.9, 1676, 25.8), portals } })).toContain(
      "portals: into Fixture Depths (dungeon instance, map 36) at (-1208, 1685, 26), 11y away; " +
        "to Fixture West (open world, map 1) at (-1300, 1676, 30), 98y away",
    );
    expect(hud({ self: { position: at(0, 1, 2, 3), portals: { value: [] } } })).not.toContain("portals:");
  });
});

describe("ghost line: where the ghost is now", () => {
  test("a ghost that walked off names its own position and the release point beside it", () => {
    const text = hud(
      {
        self: {
          ...ghost,
          position: at(0, -1208, 1685, 26),
          corpse: { value: { map: 0, x: -2648.8, y: 113.5, z: 50, source: "corpse_query" } },
          graveyard: { value: { map: 0, x: -2606.8, y: 294, z: 60 } },
        },
      },
      1_000_000,
    );
    expect(text).toContain("ghost at (-1208,1685), released at graveyard (-2607,294); corpse 2132y away at (-2649,114)");
  });

  test("the graveyard is named where the zone text named it, at it and walked off", () => {
    const graveyard = { value: { map: 0, x: -1546.9, y: 1197.2, z: 31.7, zone: { id: 40, name: "Westfall" }, area: { id: 108, name: "Sentinel Hill" } } };
    expect(hud({ self: { ...ghost, position: at(0, -1546, 1197, 31.7), graveyard } })).toContain(
      "ghost at graveyard (-1547,1197) in Westfall / Sentinel Hill; corpse position not observed yet",
    );
    expect(hud({ self: { ...ghost, position: at(0, -1246, 1197, 31.7), graveyard } })).toContain(
      "ghost at (-1246,1197), released at graveyard (-1547,1197) in Westfall / Sentinel Hill;",
    );
  });

  test("a corpse close across the ground and far below says how far below", () => {
    const text = hud(
      { self: { ...ghost, position: at(0, -1205.8, 1651.2, 84.4), corpse: { value: { map: 0, x: -1211.9, y: 1655.4, z: 26.2, source: "corpse_query" } } } },
      1_000_000,
    );
    expect(text).toContain("corpse 7y away and 58y below you at (-1212,1655): reclaim within 39y");
  });
});

describe("durability: a line only when something worn is broken or low", () => {
  test("broken first, then low, each in slot order; nothing when all is well", () => {
    const inventory = [
      { slot: 4, itemId: 91002, name: "Patched Vest", durability: { current: 9, max: 60 } },
      { slot: 15, itemId: 91001, name: "Rusted Cleaver", durability: { current: 0, max: 40 } },
      { slot: 7, itemId: 91003, name: "Worn Boots", durability: { current: 30, max: 40 } },
      { slot: 23, itemId: 91004, name: "Spare Blade", durability: { current: 0, max: 40 } },
    ];
    expect(hud({ self: { position: at(0, 1, 2, 3) }, inventory })).toContain(
      "durability: broken main hand Rusted Cleaver (0/40); low chest Patched Vest (9/60) — a broken item gives no stats",
    );
    expect(hud({ self: { position: at(0, 1, 2, 3) }, inventory: [{ slot: 7, name: "Worn Boots", durability: { current: 30, max: 40 } }] })).not.toContain("durability:");
  });
});

describe("party: the party frames", () => {
  const partyOf = (members: NonNullable<NonNullable<SnapshotLike["group"]>["members"]>, units: SnapshotLike["units"] = []): SnapshotLike => ({
    self: { name: "Fenwick", guid: "7" },
    group: { inGroup: true, members },
    units,
  });
  const partyLine = (snap: SnapshotLike): string | undefined =>
    hud(snap)
      .split("\n")
      .find((l) => l.startsWith("party: "));

  test("absent outside a group, and for a group with nobody else listed", () => {
    expect(partyLine({ self: { name: "Fenwick" } })).toBeUndefined();
    expect(partyLine({ group: { inGroup: true, members: [] } })).toBeUndefined();
  });

  test("a member in view reads off its unit: state, health, power and distance", () => {
    const line = partyLine(
      partyOf(
        [
          { guid: "941", name: "Ysolde", online: true, inView: true },
          { guid: "942", name: "Corwin", online: true, inView: true },
          { guid: "943", name: "Merrit", online: true, inView: true },
        ],
        [
          { guid: "941", name: "Ysolde", type: "player", distance: 14.4, health: 261, maxHealth: 300, power: 1200, maxPower: 3000, powerType: 0, ghost: false },
          { guid: "942", name: "Corwin", type: "player", distance: 30.2, health: 0, maxHealth: 400, power: 0, maxPower: 100, powerType: 1, dead: true, ghost: false },
          { guid: "943", name: "Merrit", type: "player", distance: 5, health: 1, maxHealth: 400, ghost: true },
        ],
      ),
    );
    expect(line).toBe("party: Ysolde alive 87% 40% mana 14y; Corwin dead 30y; Merrit ghost 5y");
  });

  test("a member out of view reads off its party frame: zone and position, no distance; offline either way", () => {
    const line = partyLine(
      partyOf([
        {
          guid: "940",
          name: "Brannoc",
          online: true,
          inView: false,
          stats: { online: true, ghost: true, dead: false, health: 1, maxHealth: 515, zone: { id: 40, name: "Westfall" }, position: { x: -10546, y: 1197 } },
        },
        {
          guid: "941",
          name: "Ysolde",
          online: true,
          inView: false,
          stats: { online: true, ghost: false, dead: false, health: 186, maxHealth: 300, powerType: "rage", power: 35, maxPower: 100, zone: { id: 1581, name: "The Fixture Mine" }, position: { x: -16, y: -383 } },
        },
        { guid: "942", name: "Corwin", online: true, inView: false, stats: { online: true, ghost: false, dead: true, health: 0, maxHealth: 400, zone: { id: 9999 } } },
      ]),
    );
    expect(line).toBe(
      "party: Brannoc ghost, Westfall (-10546, 1197), out of view; Ysolde alive 62% 35% rage, The Fixture Mine (-16, -383), out of view; Corwin dead, zone 9999, out of view",
    );
    const offline = partyLine(
      partyOf([
        { guid: "940", name: "Brannoc", online: false, inView: false },
        { guid: "941", name: "Ysolde", online: true, inView: false, stats: { online: false, health: 300, maxHealth: 300 } },
        { guid: "942", name: "Corwin", online: true, inView: false },
        { guid: "943", name: "Merrit", online: true, inView: false, stats: { position: { x: 12, y: -40 } } },
      ]),
    );
    expect(offline).toBe("party: Brannoc offline; Ysolde offline; Corwin out of view; Merrit, (12, -40), out of view");
  });

  test("a power whose type is unknown says power; a member's auras are never on the line", () => {
    const line = partyLine(
      partyOf(
        [
          { guid: "941", name: "Ysolde", online: true, inView: true },
          {
            guid: "940",
            name: "Brannoc",
            online: true,
            inView: false,
            stats: {
              online: true,
              ghost: false,
              dead: false,
              health: 515,
              maxHealth: 515,
              zone: { id: 40, name: "Westfall" },
              auras: [{ slot: 0, spellId: 6673, name: "Battle Shout", flags: 0x1b }],
            } as never,
          },
        ],
        [{ guid: "941", name: "Ysolde", type: "player", distance: 3, health: 300, maxHealth: 300, power: 50, maxPower: 100 }],
      ),
    );
    expect(line).toBe("party: Ysolde alive 100% 50% power 3y; Brannoc alive 100%, Westfall, out of view");
  });
});

describe("nearby: a corpse", () => {
  test("is named by its owner, or as a corpse", () => {
    const text = hud({
      self: { guid: { value: "7" } },
      units: [
        { guid: "11", type: "corpse", distance: 12, dead: true, ownerName: "Palafriend" },
        { guid: "12", type: "corpse", distance: 14, dead: true },
      ],
    });
    expect(text).toContain("nearby: Palafriend's corpse (12y), a corpse (14y)");
  });
});
