/**
 * The server's per-ADT area and liquid grid: both area layouts and both liquid
 * layouts. All files are built here byte by byte; nothing is read from `data/`.
 */
import { describe, expect, test } from "bun:test";
import { CELLS, LIQUID_OCEAN, LIQUID_WATER, parseMapFile } from "../src/mapfile";
import { mapBytes } from "./fixtures";

describe("parseMapFile", () => {
  test("a per-cell area grid is row-major: row runs north to south, column west to east", () => {
    const area = Array.from({ length: CELLS * CELLS }, (_, i) => Math.floor(i / CELLS) * 100 + (i % CELLS));
    const m = parseMapFile(mapBytes({ area }));
    expect(m.area[3 * CELLS + 5]).toBe(305);
    expect(m.area[15 * CELLS + 0]).toBe(1500);
    expect(m.liquid.every((f) => f === 0)).toBe(true);
  });

  test("per-cell liquid flags are read in the same order as the area grid", () => {
    const liquid = Array.from({ length: CELLS * CELLS }, (_, i) => (Math.floor(i / CELLS) >= 8 ? LIQUID_OCEAN : i % CELLS === 0 ? LIQUID_WATER : 0));
    const m = parseMapFile(mapBytes({ area: 1, liquid }));
    expect(m.liquid[7 * CELLS + 3]).toBe(0);
    expect(m.liquid[8 * CELLS + 3]).toBe(LIQUID_OCEAN);
    expect(m.liquid[2 * CELLS]).toBe(LIQUID_WATER);
  });

  test("a uniform area and one liquid type for the tile cover every cell", () => {
    const m = parseMapFile(mapBytes({ area: 2400, liquid: LIQUID_OCEAN | 0x10 }));
    expect(new Set(m.area)).toEqual(new Set([2400]));
    expect(m.liquid.every((f) => f === (LIQUID_OCEAN | 0x10))).toBe(true);
  });
});
