/**
 * The server's per-ADT area and liquid grid: file naming, both area layouts,
 * both liquid layouts, and refusal of anything else. All files are built
 * here byte by byte; nothing is read from `data/`.
 */
import { describe, expect, test } from "bun:test";
import { CELLS, LIQUID_OCEAN, LIQUID_WATER, mapFileName, parseMapFile } from "../src/mapfile";
import { mapBytes } from "./fixtures";

describe("mapFileName", () => {
  test("map in three digits, then row, then column, two digits each", () => {
    expect(mapFileName(0, 43, 31)).toBe("0004331.map");
    expect(mapFileName(571, 9, 5)).toBe("5710905.map");
  });
});

describe("parseMapFile", () => {
  test("a per-cell area grid is row-major: row runs north to south, column west to east", () => {
    const area = Array.from({ length: CELLS * CELLS }, (_, i) => Math.floor(i / CELLS) * 100 + (i % CELLS));
    const m = parseMapFile(mapBytes({ area }));
    expect(m.area[3 * CELLS + 5]).toBe(305);
    expect(m.area[15 * CELLS + 0]).toBe(1500);
    expect(m.liquid.every((f) => f === 0)).toBe(true);
  });

  test("a uniform area fills every cell", () => {
    const m = parseMapFile(mapBytes({ area: 2400 }));
    expect(new Set(m.area)).toEqual(new Set([2400]));
  });

  test("per-cell liquid flags are read in the same order as the area grid", () => {
    const liquid = Array.from({ length: CELLS * CELLS }, (_, i) => (Math.floor(i / CELLS) >= 8 ? LIQUID_OCEAN : i % CELLS === 0 ? LIQUID_WATER : 0));
    const m = parseMapFile(mapBytes({ area: 1, liquid }));
    expect(m.liquid[7 * CELLS + 3]).toBe(0);
    expect(m.liquid[8 * CELLS + 3]).toBe(LIQUID_OCEAN);
    expect(m.liquid[2 * CELLS]).toBe(LIQUID_WATER);
  });

  test("one liquid type for the tile covers every cell of a full vertex rectangle", () => {
    const m = parseMapFile(mapBytes({ area: 1, liquid: LIQUID_OCEAN | 0x10 }));
    expect(m.liquid.every((f) => f === (LIQUID_OCEAN | 0x10))).toBe(true);
  });

  test("another version or no magic is refused by name", () => {
    expect(() => parseMapFile(mapBytes({ area: 1, version: 8 }))).toThrow(/version 8/);
    const bad = mapBytes({ area: 1 });
    bad[0] = 0;
    expect(() => parseMapFile(bad)).toThrow(/MAPS/);
  });
});
