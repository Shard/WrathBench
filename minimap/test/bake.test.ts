/**
 * The LOD bake: orientation through every level, the alpha-weighted filter,
 * what is and is not written, and idempotence. All tiles are synthetic flat
 * colours built here; nothing is read from `data/`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOD_MAX, MINIMAP_LAYER, TILE_PX, lodTileName } from "../../runner/viewer/worldmap";
import { bakeMap, downsampleQuad } from "../src/bake";
import { decodePng, encodePng } from "../src/png";

const scratch = mkdtempSync(join(tmpdir(), "wrathbench-bake-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Rgba = [number, number, number, number];

function solid(px: number, c: Rgba): Uint8Array {
  const out = new Uint8Array(px * px * 4);
  for (let i = 0; i < px * px; i++) out.set(c, i * 4);
  return out;
}

function at(rgba: Uint8Array, px: number, x: number, y: number): number[] {
  const i = (y * px + x) * 4;
  return [...rgba.subarray(i, i + 4)];
}

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

describe("downsampleQuad", () => {
  test("children land top-left, top-right, bottom-left, bottom-right — no flip, no transpose", () => {
    const out = downsampleQuad([solid(4, RED), solid(4, GREEN), solid(4, BLUE), solid(4, WHITE)], 4)!;
    expect(at(out, 4, 0, 0)).toEqual(RED);
    expect(at(out, 4, 3, 0)).toEqual(GREEN);
    expect(at(out, 4, 0, 3)).toEqual(BLUE);
    expect(at(out, 4, 3, 3)).toEqual(WHITE);
  });

  test("a missing child is a transparent quadrant, and no child at all is no tile", () => {
    const out = downsampleQuad([null, solid(4, GREEN), null, null], 4)!;
    expect(at(out, 4, 0, 0)).toEqual(CLEAR);
    expect(at(out, 4, 2, 1)).toEqual(GREEN);
    expect(at(out, 4, 1, 3)).toEqual(CLEAR);
    expect(downsampleQuad([null, null, null, null], 4)).toBeNull();
    // A child with nothing opaque in it is no content either.
    expect(downsampleQuad([solid(4, [9, 9, 9, 0]), null, null, null], 4)).toBeNull();
  });

  test("a 2x2 block averages to the box mean", () => {
    const child = new Uint8Array([10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 41, 0, 0, 255]);
    const out = downsampleQuad([child, null, null, null], 2)!;
    // (10 + 20 + 30 + 41) / 4 = 25.25
    expect(at(out, 2, 0, 0)).toEqual([25, 0, 0, 255]);
  });

  test("colour is weighted by alpha, so a transparent neighbour does not darken an edge", () => {
    // One opaque red pixel beside three transparent black ones. A straight
    // mean would give (64, 0, 0, 64) — a dark fringe; weighted it stays red.
    const child = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = downsampleQuad([child, null, null, null], 2)!;
    expect(at(out, 2, 0, 0)).toEqual([255, 0, 0, 64]);
    // Mixed alpha: two half-transparent blues and two opaque reds.
    const mixed = new Uint8Array([0, 0, 255, 128, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 128]);
    const m = downsampleQuad([mixed, null, null, null], 2)!;
    // red weight 510, blue weight 256: r = 255*510/766, b = 255*256/766
    expect(at(m, 2, 0, 0)).toEqual([170, 0, 85, 192]);
  });
});

describe("bakeMap", () => {
  /**
   * Three natives on map 0: green and red side by side on row 43 (Dun Morogh's
   * row), blue alone at 48_32. They share no parent at level 1 and only meet
   * at the top of the pyramid.
   */
  function fixture(name: string): string {
    const dir = join(scratch, name, "0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "43_30.png"), encodePng(solid(TILE_PX, GREEN), TILE_PX, TILE_PX));
    writeFileSync(join(dir, "43_31.png"), encodePng(solid(TILE_PX, RED), TILE_PX, TILE_PX));
    writeFileSync(join(dir, "48_32.png"), encodePng(solid(TILE_PX, BLUE), TILE_PX, TILE_PX));
    return dir;
  }

  const level = (dir: string, z: number): string[] => {
    try {
      return readdirSync(join(dir, MINIMAP_LAYER, String(z))).sort();
    } catch {
      return [];
    }
  };
  const read = (dir: string, z: number, row: number, col: number): Uint8Array =>
    decodePng(new Uint8Array(readFileSync(join(dir, lodTileName(MINIMAP_LAYER, z, row, col))))).rgba;

  test("writes each level's covering tiles and nothing else, up to one tile for the world", () => {
    const dir = fixture("levels");
    const stats = bakeMap(dir, { force: false });
    expect(stats.map((s) => s.z)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(level(dir, 1)).toEqual(["21_15.png", "24_16.png"]);
    expect(level(dir, 2)).toEqual(["10_7.png", "12_8.png"]);
    expect(level(dir, 3)).toEqual(["5_3.png", "6_4.png"]);
    expect(level(dir, 4)).toEqual(["2_1.png", "3_2.png"]);
    expect(level(dir, 5)).toEqual(["1_0.png", "1_1.png"]);
    expect(level(dir, LOD_MAX)).toEqual(["0_0.png"]);
    // The natives are inputs only: the map directory gained the layer and nothing else.
    expect(readdirSync(dir).sort()).toEqual(["43_30.png", "43_31.png", "48_32.png", MINIMAP_LAYER]);
    expect(level(dir, 0)).toEqual([]);
  });

  test("level 1 places its children where they are in the world", () => {
    const dir = fixture("quadrants");
    bakeMap(dir, { force: false });
    // 21_15 covers rows 42-43 and cols 30-31: only the bottom row is present.
    const t = read(dir, 1, 21, 15);
    expect(at(t, TILE_PX, 10, 10)).toEqual(CLEAR);
    expect(at(t, TILE_PX, 200, 10)).toEqual(CLEAR);
    expect(at(t, TILE_PX, 10, 200)).toEqual(GREEN); // 43_30, bottom-left
    expect(at(t, TILE_PX, 200, 200)).toEqual(RED); // 43_31, bottom-right
  });

  test("the whole-world tile still has every native where the transform puts it", () => {
    const dir = fixture("world");
    bakeMap(dir, { force: false });
    const world = read(dir, LOD_MAX, 0, 0);
    // At level 6 one native is 4x4 px at (col*4, row*4).
    expect(at(world, TILE_PX, 30 * 4 + 1, 43 * 4 + 1)).toEqual(GREEN);
    expect(at(world, TILE_PX, 31 * 4 + 1, 43 * 4 + 1)).toEqual(RED);
    expect(at(world, TILE_PX, 32 * 4 + 1, 48 * 4 + 1)).toEqual(BLUE);
    expect(at(world, TILE_PX, 32 * 4 + 1, 43 * 4 + 1)).toEqual(CLEAR);
  });

  test("a re-run skips everything, and --force rewrites the same bytes", () => {
    const dir = fixture("idempotent");
    const first = bakeMap(dir, { force: false });
    const file = join(dir, lodTileName(MINIMAP_LAYER, 3, 5, 3));
    const bytes = readFileSync(file);
    const again = bakeMap(dir, { force: false });
    expect(again.every((s) => s.written === 0)).toBe(true);
    expect(again.map((s) => s.skipped)).toEqual(first.map((s) => s.written));
    expect(again.map((s) => s.bytes)).toEqual(first.map((s) => s.bytes));
    const forced = bakeMap(dir, { force: true });
    expect(forced.map((s) => s.written)).toEqual(first.map((s) => s.written));
    // Byte-identical, so the tile publisher's content hash skips a re-bake.
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  test("an empty native writes no parent, and only canonical in-grid names are inputs", () => {
    const dir = join(scratch, "inputs", "0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "10_10.png"), encodePng(solid(TILE_PX, [0, 0, 0, 0]), TILE_PX, TILE_PX));
    writeFileSync(join(dir, "043_31.png"), encodePng(solid(TILE_PX, RED), TILE_PX, TILE_PX));
    writeFileSync(join(dir, "64_0.png"), encodePng(solid(TILE_PX, RED), TILE_PX, TILE_PX));
    writeFileSync(join(dir, "43_31.png.tmp"), "half");
    const stats = bakeMap(dir, { force: false });
    expect(stats.every((s) => s.written === 0 && s.skipped === 0)).toBe(true);
    expect(level(dir, 1)).toEqual([]);
  });

  test("a map directory that does not exist bakes nothing rather than throwing", () => {
    const stats = bakeMap(join(scratch, "nope", "0"), { force: false });
    expect(stats.every((s) => s.written === 0)).toBe(true);
  });
});
