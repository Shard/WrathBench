/**
 * The HUD lines the third batch of 2026-10-20 Deadmines party-run fixes
 * changed: a corpse the height puts out of reach, the release graveyard's
 * own place, and the position line in flight. Names and positions are
 * invented.
 */
import { describe, expect, test } from "bun:test";

import { formatStateSummary } from "../src/context";

const at = (map: number, x: number, y: number, z: number) => ({ value: { map, x, y, z }, seq: 5 });
const ghost = { fields: { playerFlags: { value: 0x10 } }, health: { value: { current: 1, max: 100 } } };

describe("ghost line: the height, and the graveyard's place", () => {
  test("a corpse close across the ground and far below says how far below", () => {
    const text = formatStateSummary(
      { self: { ...ghost, position: at(0, -1205.8, 1651.2, 84.4), corpse: { value: { map: 0, x: -1211.9, y: 1655.4, z: 26.2, source: "corpse_query" } } } },
      { sessionLive: true, now: 1_000_000 },
    );
    expect(text).toContain("corpse 7y away and 58y below you at (-1212,1655): reclaim within 39y");
  });

  test("an ordinary corpse reads as before", () => {
    const text = formatStateSummary(
      { self: { ...ghost, position: at(0, -1205.8, 1651.2, 30), corpse: { value: { map: 0, x: -1211.9, y: 1655.4, z: 26.2, source: "corpse_query" } } } },
      { sessionLive: true, now: 1_000_000 },
    );
    expect(text).toContain("corpse 7y away at (-1212,1655): reclaim within 39y");
  });

  test("the graveyard is named where the zone text named it", () => {
    const graveyard = { value: { map: 0, x: -1546.9, y: 1197.2, z: 31.7, zone: { id: 40, name: "Westfall" }, area: { id: 108, name: "Sentinel Hill" } } };
    const atGrave = formatStateSummary({ self: { ...ghost, position: at(0, -1546, 1197, 31.7), graveyard } }, { sessionLive: true });
    expect(atGrave).toContain("ghost at graveyard (-1547,1197) in Westfall / Sentinel Hill; corpse position not observed yet");
    const walked = formatStateSummary({ self: { ...ghost, position: at(0, -1246, 1197, 31.7), graveyard } }, { sessionLive: true });
    expect(walked).toContain("ghost at (-1246,1197), released at graveyard (-1547,1197) in Westfall / Sentinel Hill;");
  });
});

describe("position in flight: the take-off point, said so", () => {
  test("the zone text follows the flight; the coordinates are where it took off", () => {
    const text = formatStateSummary(
      {
        self: {
          position: { value: { map: 0, x: -1628.3, y: 1037.3, z: 34.1, inFlight: true }, seq: 9 },
          zone: { value: { id: 40, name: "Westfall" } },
          area: { value: { id: 918, name: "Saldean's Farm" } },
          map: { value: { id: 0, name: "Eastern Kingdoms", instanceType: "none" } },
          taxiEta: { value: { durationMs: 81_046, landsAt: 1_051_000 } },
        },
      },
      { sessionLive: true, now: 1_000_000 },
    );
    expect(text).toContain(
      "position: in flight over Westfall / Saldean's Farm, Eastern Kingdoms (open world) — took off from map 0 (-1628.3, 1037.3, 34.1), lands in ~51s [seq 9]",
    );
  });
});
