import { describe, expect, test } from "bun:test";
import {
  ADT_FRAME_ORIGIN,
  WMO_PX_PER_YARD,
  WMO_TILE_SIZE,
  type WmoPlacement,
  groupPixelToModel,
  isUprightPlacement,
  parseAdtWmoPlacements,
  parseWdtGlobalWmo,
  parseWmoGroupBoxes,
  placementToWorld,
  wmoModelStem,
  wmoTrsSection,
} from "../src/wmo";
import { buildAdtWithWmos, buildGlobalWmoWdt, buildWmoRoot, chunk } from "./fixtures";

const NAME = "World\\wmo\\Dungeon\\AZ_Subway\\Subway.wmo";

describe("parseWdtGlobalWmo", () => {
  test("reads the model name and its placement", () => {
    const p = parseWdtGlobalWmo(buildGlobalWmoWdt(NAME, { min: [-2565, -135, -195], max: [39, 34, 215] }));
    expect(p).not.toBeNull();
    expect(p?.name).toBe(NAME);
    expect(p?.position).toEqual([0, 0, 0]);
    expect(p?.extentMin[0]).toBeCloseTo(-2565, 3);
    expect(p?.extentMax[2]).toBeCloseTo(215, 3);
  });

  test("refuses a WDT with no MODF", () => {
    expect(parseWdtGlobalWmo(chunk("MVER", new Uint8Array(4)))).toBeNull();
  });

  test("refuses more than one model, which would need a transform each", () => {
    const parts = [
      chunk("MVER", new Uint8Array(4)),
      chunk("MWMO", new TextEncoder().encode("a.wmo\0b.wmo\0")),
      chunk("MODF", new Uint8Array(64)),
    ];
    const two = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    parts.reduce((at, p) => (two.set(p, at), at + p.byteLength), 0);
    expect(parseWdtGlobalWmo(two)).toBeNull();
  });

  test("survives a truncated trailing chunk rather than reading past the end", () => {
    const wdt = buildGlobalWmoWdt(NAME);
    expect(parseWdtGlobalWmo(wdt.subarray(0, wdt.byteLength - 8))).toBeNull();
  });
});

describe("parseAdtWmoPlacements", () => {
  const adt = buildAdtWithWmos(
    ["WORLD\\WMO\\A.WMO", "WORLD\\WMO\\DUNGEON\\AZ_DEADMINES\\AZ_DEADMINES_B.WMO"],
    [
      { nameId: 1, uniqueId: 170633, position: [17718.262, 29.85, 17223.072], rotation: [0, -91, 0] },
      { nameId: 0, uniqueId: 7, position: [1, 2, 3] },
      { nameId: 9, uniqueId: 8, position: [0, 0, 0] },
    ],
  );

  test("names each placement through MWID, not by position in MWMO", () => {
    const placed = parseAdtWmoPlacements(adt);
    expect(placed.map((p) => p.name)).toEqual(["WORLD\\WMO\\DUNGEON\\AZ_DEADMINES\\AZ_DEADMINES_B.WMO", "WORLD\\WMO\\A.WMO"]);
    expect(placed[0]?.uniqueId).toBe(170633);
    expect(placed[0]?.rotation[1]).toBeCloseTo(-91, 3);
    expect(placed[1]?.position).toEqual([1, 2, 3]);
  });

  test("drops an entry whose name id is out of range rather than misnaming it", () => {
    expect(parseAdtWmoPlacements(adt)).toHaveLength(2);
  });

  test("an ADT that places no model has no placements", () => {
    expect(parseAdtWmoPlacements(chunk("MVER", new Uint8Array(4)))).toEqual([]);
  });
});

describe("isUprightPlacement", () => {
  test("accepts a turn about the vertical and rejects a tilt", () => {
    const at = (rotation: number[]): boolean =>
      isUprightPlacement(parseWdtGlobalWmo(buildGlobalWmoWdt(NAME, { rotation }))!);
    expect(at([0, 0, 0])).toBe(true);
    expect(at([0, -91, 0])).toBe(true);
    expect(at([5, 0, 0])).toBe(false);
    expect(at([0, 0, -5])).toBe(false);
  });
});

describe("parseWmoGroupBoxes", () => {
  test("reads every MOGI entry in model order", () => {
    const boxes = parseWmoGroupBoxes(
      buildWmoRoot([
        { min: [-16.8, -348.3, -54.5], max: [57.7, -193.1, 14] },
        { min: [0, 0, 0], max: [1, 2, 3] },
      ]),
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.min[1]).toBeCloseTo(-348.3, 3);
    expect(boxes[1]?.max[2]).toBeCloseTo(3, 3);
  });

  test("a root with no MOGI is empty, not a throw", () => {
    expect(parseWmoGroupBoxes(chunk("MVER", new Uint8Array(4)))).toEqual([]);
  });
});

describe("the measured scale", () => {
  test("is two pixels per yard, 128 yards to a tile", () => {
    expect(WMO_TILE_SIZE).toBe(128);
    expect(WMO_PX_PER_YARD).toBe(2);
  });
});

describe("placementToWorld", () => {
  const placement = (position: number[], rotation: number[]): WmoPlacement => ({
    name: NAME,
    uniqueId: 0,
    position: position as [number, number, number],
    rotation: rotation as [number, number, number],
    extentMin: [0, 0, 0],
    extentMax: [0, 0, 0],
  });

  test("a global model at the origin unrotated is turned 180 degrees", () => {
    const toWorld = placementToWorld(placement([0, 0, 0], [0, 0, 0]), "wdt");
    const p = toWorld(10, -20);
    expect(p.x).toBeCloseTo(-10, 9);
    expect(p.y).toBeCloseTo(20, 9);
  });

  test("an ADT's frame puts the world origin at the middle of the grid", () => {
    const toWorld = placementToWorld(placement([ADT_FRAME_ORIGIN, 0, ADT_FRAME_ORIGIN], [0, 0, 0]), "adt");
    expect(toWorld(0, 0).x).toBeCloseTo(0, 6);
    expect(toWorld(0, 0).y).toBeCloseTo(0, 6);
    // position[2] is world x and position[0] world y, both counted from the far corner.
    const shifted = placementToWorld(placement([ADT_FRAME_ORIGIN - 5, 0, ADT_FRAME_ORIGIN - 7], [0, 0, 0]), "adt");
    expect(shifted(0, 0).x).toBeCloseTo(7, 6);
    expect(shifted(0, 0).y).toBeCloseTo(5, 6);
  });

  /*
   * The yaw's sign, from the archive: under it the model's own bounding box
   * lands on the world box its MODF declares, to a tenth of a yard, for both
   * Deadmines models — B turned -91 and D turned -55.5, an oblique angle the
   * opposite sign misses by ~37 yards. Under the opposite sign neither does.
   */
  const cases = [
    {
      model: "AZ_Deadmines_B",
      position: [17718.262, 29.85, 17223.072],
      yaw: -91,
      box: { min: [-242.1, -172.3], max: [311.4, 162.9] },
      extent: { min: [17404.025, 17045.369], max: [17963.289, 17390.137] },
    },
    {
      model: "AZ_Deadmines_D",
      position: [18024.229, 38.238, 17151.225],
      yaw: -55.5,
      box: { min: [-79.3, -18.6], max: [20.7, 64.1] },
      extent: { min: [17996.609, 17090.975], max: [18125.932, 17215.828] },
    },
  ];
  for (const c of cases) {
    test(`${c.model}'s box lands on its declared extent`, () => {
      const toWorld = placementToWorld(placement(c.position, [0, c.yaw, 0]), "adt");
      const corners = [
        toWorld(c.box.min[0]!, c.box.min[1]!),
        toWorld(c.box.min[0]!, c.box.max[1]!),
        toWorld(c.box.max[0]!, c.box.min[1]!),
        toWorld(c.box.max[0]!, c.box.max[1]!),
      ];
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      // The extent is in the placement's frame: [0] runs against world y, [1] against world x.
      expect(Math.abs(Math.min(...ys) - (ADT_FRAME_ORIGIN - c.extent.max[0]!))).toBeLessThan(0.2);
      expect(Math.abs(Math.max(...ys) - (ADT_FRAME_ORIGIN - c.extent.min[0]!))).toBeLessThan(0.2);
      expect(Math.abs(Math.min(...xs) - (ADT_FRAME_ORIGIN - c.extent.max[1]!))).toBeLessThan(0.2);
      expect(Math.abs(Math.max(...xs) - (ADT_FRAME_ORIGIN - c.extent.min[1]!))).toBeLessThan(0.2);
    });
  }
});

describe("groupPixelToModel", () => {
  // Group 000 of the Deeprun Tram: two tiles on the b axis over 155.2 yards,
  // so the strip is 256 yards and 100.8 of it is the transparent remainder.
  const box = { min: [-16.8, -348.3, -54.5], max: [57.7, -193.1, 14] } as const;

  test("a counts up from min.x, b counts down from max.y", () => {
    expect(groupPixelToModel(box, { a: 0, b: 0 }, 256, 0, 0)).toEqual({ x: -16.8, y: -193.1 - 128 });
    expect(groupPixelToModel(box, { a: 1, b: 0 }, 256, 0, 0).x).toBeCloseTo(-16.8 + 128, 6);
    expect(groupPixelToModel(box, { a: 0, b: 1 }, 256, 0, 0).y).toBeCloseTo(-193.1 - 256, 6);
  });

  test("the strip ends flush at the group's own bound", () => {
    // Last painted pixel of tile b=0 is half a yard short of the box edge,
    // which is what "flush" means at two pixels to the yard.
    expect(groupPixelToModel(box, { a: 0, b: 0 }, 256, 0, 255).y).toBeCloseTo(-193.1 - 0.5, 6);
  });

  test("consecutive b tiles meet without a seam", () => {
    const lastOfB1 = groupPixelToModel(box, { a: 0, b: 1 }, 256, 0, 255).y;
    const firstOfB0 = groupPixelToModel(box, { a: 0, b: 0 }, 256, 0, 0).y;
    expect(firstOfB0 - lastOfB1).toBeCloseTo(0.5, 6);
  });

  test("a short image sits flush at max.y too, not 128 yards below it", () => {
    // AZ_Deadmines_B group 000 is a 64x64 image over a 23.2-yard span: its
    // paint fills rows 18-63, so row 63 is half a yard short of max.y.
    const g0 = { min: [241.2, -7.5, 26.2], max: [261.2, 15.7, 36.4] } as const;
    expect(groupPixelToModel(g0, { a: 0, b: 0 }, 64, 0, 63).y).toBeCloseTo(15.7 - 0.5, 6);
    expect(groupPixelToModel(g0, { a: 0, b: 0 }, 64, 0, 18).y).toBeCloseTo(15.7 - 23, 6);
  });
});

describe("wmoModelStem", () => {
  test("is the file name without its extension, lower-cased", () => {
    expect(wmoModelStem(NAME)).toBe("subway");
    expect(wmoModelStem("WORLD\\WMO\\DUNGEON\\AZ_DEADMINES\\AZ_DEADMINES_B.WMO")).toBe("az_deadmines_b");
  });
});

describe("wmoTrsSection", () => {
  test("is the model's directory without the World prefix, lower-cased", () => {
    expect(wmoTrsSection(NAME)).toBe("wmo\\dungeon\\az_subway");
  });

  test("tolerates a name with no directory at all", () => {
    expect(wmoTrsSection("Subway.wmo")).toBe("");
  });
});
