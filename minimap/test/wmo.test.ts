import { describe, expect, test } from "bun:test";
import {
  WMO_PX_PER_YARD,
  WMO_TILE_SIZE,
  groupTileOrigin,
  isIdentityPlacement,
  parseWdtGlobalWmo,
  parseWmoGroupBoxes,
  tilePixelToWorld,
  wmoToWorld,
  wmoTrsSection,
} from "../src/wmo";
import { buildGlobalWmoWdt, buildWmoRoot, chunk } from "./fixtures";

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

describe("isIdentityPlacement", () => {
  test("accepts the origin unrotated and rejects anything else", () => {
    const at = (position: number[], rotation: number[]): boolean =>
      isIdentityPlacement(parseWdtGlobalWmo(buildGlobalWmoWdt(NAME, { position, rotation }))!);
    expect(at([0, 0, 0], [0, 0, 0])).toBe(true);
    expect(at([0, 0, 0], [0, 90, 0])).toBe(false);
    expect(at([17066, 0, 17066], [0, 0, 0])).toBe(false);
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

describe("wmoToWorld", () => {
  test("turns the model 180 degrees about the vertical", () => {
    expect(wmoToWorld(10, -20, 5)).toEqual({ x: -10, y: 20, z: 5 });
  });
});

describe("groupTileOrigin", () => {
  // Group 000 of the Deeprun Tram: two tiles on the b axis over 155.2 yards,
  // so the strip is 256 yards and 100.8 of it is the transparent remainder.
  const box = { min: [-16.8, -348.3, -54.5], max: [57.7, -193.1, 14] } as const;

  test("a counts up from min.x, b counts down from max.y", () => {
    expect(groupTileOrigin(box, 0, 0)).toEqual({ x: 16.8, y: 193.1 + 128 });
    expect(groupTileOrigin(box, 1, 0).x).toBeCloseTo(16.8 - 128, 6);
    expect(groupTileOrigin(box, 0, 1).y).toBeCloseTo(193.1 + 256, 6);
  });

  test("the strip ends flush at the group's own bound", () => {
    // Last painted pixel of tile b=0 is half a yard short of the box edge,
    // which is what "flush" means at two pixels to the yard.
    const end = tilePixelToWorld(groupTileOrigin(box, 0, 0), 0, 255);
    expect(end.y).toBeCloseTo(193.1 + 0.5, 6);
  });

  test("consecutive b tiles meet without a seam", () => {
    const lastOfB1 = tilePixelToWorld(groupTileOrigin(box, 0, 1), 0, 255).y;
    const firstOfB0 = tilePixelToWorld(groupTileOrigin(box, 0, 0), 0, 0).y;
    expect(lastOfB1 - firstOfB0).toBeCloseTo(0.5, 6);
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
