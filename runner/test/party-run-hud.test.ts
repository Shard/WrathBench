/**
 * The HUD lines the second batch of 2026-10-20 Deadmines party-run fixes
 * changed: the map beside the zone on the position line, the portals in
 * view, where a ghost stands now, and worn durability. Names and positions
 * are invented.
 */
import { describe, expect, test } from "bun:test";

import { formatStateSummary } from "../src/context";

const at = (map: number, x: number, y: number, z: number) => ({ value: { map, x, y, z }, seq: 5 });

describe("position: the map's name and kind beside the zone", () => {
  test("a zone that spans a portal reads as the open world outside and the instance inside", () => {
    const outside = formatStateSummary(
      {
        self: {
          position: at(0, -1201.9, 1676, 25.8),
          zone: { value: { id: 1581, name: "The Fixture Mine" } },
          area: { value: { id: 1581, name: "The Fixture Mine" } },
          map: { value: { id: 0, name: "Fixture Continent", instanceType: "none" } },
        },
      },
      { sessionLive: true },
    );
    expect(outside).toContain("position: The Fixture Mine, Fixture Continent (open world) — map 0 (-1201.9, 1676, 25.8) [seq 5]");
    const inside = formatStateSummary(
      {
        self: {
          position: at(36, -16.4, -383.1, 61.8),
          zone: { value: { id: 1581, name: "The Fixture Mine" } },
          area: { value: { id: 1581, name: "The Fixture Mine" } },
          map: { value: { id: 36, name: "Fixture Depths", instanceType: "party" } },
        },
      },
      { sessionLive: true },
    );
    expect(inside).toContain("position: The Fixture Mine, Fixture Depths (dungeon instance) — map 36 (-16.4, -383.1, 61.8)");
  });

  test("a map name from before a transfer is not printed against the new map's position", () => {
    const text = formatStateSummary(
      { self: { position: at(36, 1, 2, 3), map: { value: { id: 0, name: "Fixture Continent", instanceType: "none" } } } },
      { sessionLive: true },
    );
    expect(text).toContain("position: map 36 (1, 2, 3)");
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
    const text = formatStateSummary({ self: { position: at(0, -1201.9, 1676, 25.8), portals } }, { sessionLive: true });
    expect(text).toContain(
      "portals: into Fixture Depths (dungeon instance, map 36) at (-1208, 1685, 26), 11y away; " +
        "to Fixture West (open world, map 1) at (-1300, 1676, 30), 98y away",
    );
    const none = formatStateSummary({ self: { position: at(0, 1, 2, 3), portals: { value: [] } } }, { sessionLive: true });
    expect(none).not.toContain("portals:");
  });
});

describe("ghost line: where the ghost is now", () => {
  const ghost = { fields: { playerFlags: { value: 0x10 } }, health: { value: { current: 1, max: 100 } } };

  test("a ghost that walked off names its own position and the release point beside it", () => {
    const text = formatStateSummary(
      {
        self: {
          ...ghost,
          position: at(0, -1208, 1685, 26),
          corpse: { value: { map: 0, x: -2648.8, y: 113.5, z: 50, source: "corpse_query" } },
          graveyard: { value: { map: 0, x: -2606.8, y: 294, z: 60 } },
        },
      },
      { sessionLive: true, now: 1_000_000 },
    );
    expect(text).toContain("ghost at (-1208,1685), released at graveyard (-2607,294); corpse 2132y away at (-2649,114)");
  });

  test("a ghost still at the graveyard reads as before", () => {
    const text = formatStateSummary(
      { self: { ...ghost, position: at(0, -2600, 290, 60), graveyard: { value: { map: 0, x: -2606.8, y: 294, z: 60 } } } },
      { sessionLive: true },
    );
    expect(text).toContain("ghost at graveyard (-2607,294); corpse position not observed yet");
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
    const text = formatStateSummary({ self: { position: at(0, 1, 2, 3) }, inventory }, { sessionLive: true });
    expect(text).toContain("durability: broken main hand Rusted Cleaver (0/40); low chest Patched Vest (9/60) — a broken item gives no stats");
    const fine = formatStateSummary(
      { self: { position: at(0, 1, 2, 3) }, inventory: [{ slot: 7, name: "Worn Boots", durability: { current: 30, max: 40 } }] },
      { sessionLive: true },
    );
    expect(fine).not.toContain("durability:");
  });
});
