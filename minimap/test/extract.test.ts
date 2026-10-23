import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { MpqArchive, MpqChain, bufferSource } from "../src/mpq";
import { parseTrs, parseWmoTrs } from "../src/trs";
import { DEFAULT_MAPS, type PlacedWmo, type WmoPaint, compositeWmoMap, extractMap, paintWmos } from "../src/extract";
import { TILED_MAPS } from "../../runner/viewer/worldmap";
import { ADT_FRAME_ORIGIN, type WmoGroupBox, type WmoPlacement, placementToWorld } from "../src/wmo";
import { buildDxtBlp, buildMpq, dxt1Block, rgb565of } from "./fixtures";

const scratch = mkdtempSync(join(tmpdir(), "wrathbench-minimap-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A 256x256 DXT1 tile of one flat colour. */
function solidTile(r: number, g: number, b: number): Uint8Array {
  const blocks = new Uint8Array(64 * 64 * 8);
  const block = dxt1Block(rgb565of(r, g, b), 0);
  for (let i = 0; i < 64 * 64; i++) blocks.set(block, i * 8);
  return buildDxtBlp(256, 256, 1, blocks);
}

const trsText = [
  "dir: Azeroth",
  "Azeroth\\map31_43.blp\taaaa.blp",
  "Azeroth\\map32_48.blp\tbbbb.blp",
  "Azeroth\\map33_49.blp\tcccc.blp", // deliberately absent from the archive
  "",
].join("\n");

const archive = buildMpq([
  {
    name: "textures\\Minimap\\md5translate.trs",
    data: new TextEncoder().encode(trsText),
  },
  { name: "textures\\Minimap\\aaaa.blp", data: solidTile(255, 0, 0) },
  { name: "textures\\Minimap\\bbbb.blp", data: solidTile(0, 0, 255) },
]);

function chain(): MpqChain {
  return new MpqChain([MpqArchive.fromSource("fixture", bufferSource(archive))]);
}

function pixelAt(pngPath: string, x: number, y: number, width = 256): number[] {
  const png = new Uint8Array(readFileSync(pngPath));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  const parts: Uint8Array[] = [];
  while (at < png.byteLength) {
    const len = view.getUint32(at, false);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === "IDAT") parts.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  parts.reduce((to, p) => (joined.set(p, to), to + p.byteLength), 0);
  const raw = new Uint8Array(inflateSync(joined));
  // The encoder writes filter 0 on every row, which keeps this a plain index.
  const stride = width * 4 + 1;
  const off = y * stride + 1 + x * 4;
  return [raw[off], raw[off + 1], raw[off + 2], raw[off + 3]] as number[];
}

function firstPixel(pngPath: string): number[] {
  const png = new Uint8Array(readFileSync(pngPath));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at < png.byteLength) {
    const len = view.getUint32(at, false);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    if (type === "IDAT") {
      const raw = new Uint8Array(inflateSync(png.subarray(at + 8, at + 8 + len)));
      return [raw[1], raw[2], raw[3], raw[4]] as number[];
    }
    at += 12 + len;
  }
  throw new Error("no IDAT");
}

function placement(position: number[], yaw: number): WmoPlacement {
  return {
    name: "World\\wmo\\Dungeon\\Fixture\\Fixture.wmo",
    uniqueId: 1,
    position: position as [number, number, number],
    rotation: [0, yaw, 0],
    extentMin: [0, 0, 0],
    extentMax: [0, 0, 0],
  };
}

describe("extractMap", () => {
  const c = chain();
  const tiles = parseTrs(new TextDecoder().decode(c.read("textures\\Minimap\\md5translate.trs")!)).get(
    "azeroth",
  )!;
  const outDir = join(scratch, "0");

  test("writes <row>_<col>.png and counts tiles the archive lacks", () => {
    const stats = extractMap(c, tiles, outDir, { force: false, limit: Infinity });
    expect(stats).toMatchObject({ written: 2, skipped: 0, missing: 1, failed: 0 });
    // trs entry map31_43 -> column 31, row 43 -> file 43_31.png
    expect(statSync(join(outDir, "43_31.png")).size).toBeGreaterThan(0);
    expect(statSync(join(outDir, "48_32.png")).size).toBeGreaterThan(0);
  });

  test("decodes the tile through BLP2 and PNG intact", () => {
    const px = firstPixel(join(outDir, "43_31.png"));
    expect(px[3]).toBe(255);
    expect(px[0]).toBeGreaterThan(240); // red tile
    expect(px[2]).toBeLessThan(16);
    expect(firstPixel(join(outDir, "48_32.png"))[2]).toBeGreaterThan(240); // blue tile
  });

  test("is idempotent: a second pass skips everything", () => {
    const stats = extractMap(c, tiles, outDir, { force: false, limit: Infinity });
    expect(stats).toMatchObject({ written: 0, skipped: 2, missing: 1, failed: 0 });
    expect(stats.bytes).toBeGreaterThan(0);
  });

  test("--force rewrites", () => {
    const stats = extractMap(c, tiles, outDir, { force: true, limit: Infinity });
    expect(stats).toMatchObject({ written: 2, skipped: 0 });
  });

  test("--limit caps the number of tiles considered", () => {
    const limited = join(scratch, "limited");
    const stats = extractMap(c, tiles, limited, { force: false, limit: 1 });
    expect(stats.written).toBe(1);
  });
});

describe("compositeWmoMap", () => {
  /*
   * Two one-tile groups, placed so each lands in a different world tile: a
   * global model at the origin puts a group tile's pixel (0, 0) at world
   * (-min.x, -max.y + 128), so a group at min.x = 0 sits on row 32 and one at
   * min.x = -533.33325 (a whole ADT north) on row 31. Both are at max.y = 128,
   * which puts their east edge on the col 32 boundary.
   */
  const trsText = [
    "dir: WMO\\Dungeon\\Fixture",
    "WMO\\Dungeon\\Fixture\\Fixture_000_00_00.blp\tred.blp",
    "WMO\\Dungeon\\Fixture\\Fixture_001_00_00.blp\tblue.blp",
    "",
  ].join("\n");
  const wmoArchive = buildMpq([
    { name: "textures\\Minimap\\md5translate.trs", data: new TextEncoder().encode(trsText) },
    { name: "textures\\Minimap\\red.blp", data: solidTile(255, 0, 0) },
    { name: "textures\\Minimap\\blue.blp", data: solidTile(0, 0, 255) },
  ]);
  const boxes: WmoGroupBox[] = [
    { min: [0, 0, 0], max: [0, 128, 0] },
    { min: [-533.33325, 0, 0], max: [0, 128, 0] },
  ];

  const c = new MpqChain([MpqArchive.fromSource("fixture", bufferSource(wmoArchive))]);
  const tiles = parseWmoTrs(new TextDecoder().decode(c.read("textures\\Minimap\\md5translate.trs")!)).get(
    "wmo\\dungeon\\fixture",
  )!;
  const outDir = join(scratch, "369");
  const toWorld = placementToWorld(placement([0, 0, 0], 0), "wdt");
  const placed = (b: WmoGroupBox[] = boxes): PlacedWmo[] => [{ tiles, boxes: b, toWorld }];

  test("writes one world tile per group, named the way the viewer asks", () => {
    const stats = compositeWmoMap(c, placed(), outDir, { force: false, limit: Infinity });
    expect(stats).toMatchObject({ written: 2, skipped: 0, missing: 0, failed: 0 });
    expect(statSync(join(outDir, "32_32.png")).size).toBeGreaterThan(0);
    expect(statSync(join(outDir, "31_32.png")).size).toBeGreaterThan(0);
  });

  test("the colour survives the 4:1 resample", () => {
    const red = pixelAt(join(outDir, "32_32.png"), 0, 0);
    expect(red[0]).toBeGreaterThan(240);
    expect(red[2]).toBeLessThan(16);
    expect(red[3]).toBe(255);
    expect(pixelAt(join(outDir, "31_32.png"), 0, 0)[2]).toBeGreaterThan(240);
  });

  test("what no source pixel covered stays transparent", () => {
    // The group is 128 yards across; a world tile is 533, so most of it is
    // untouched and must stay see-through for the lattice underneath.
    expect(pixelAt(join(outDir, "32_32.png"), 200, 200)[3]).toBe(0);
  });

  test("is idempotent, and --force rewrites", () => {
    expect(compositeWmoMap(c, placed(), outDir, { force: false, limit: Infinity })).toMatchObject({
      written: 0,
      skipped: 2,
    });
    expect(compositeWmoMap(c, placed(), outDir, { force: true, limit: Infinity })).toMatchObject({
      written: 2,
      skipped: 0,
    });
  });

  test("counts a group the model does not have rather than throwing", () => {
    const stats = compositeWmoMap(c, placed([boxes[0] as WmoGroupBox]), join(scratch, "369-partial"), {
      force: false,
      limit: Infinity,
    });
    expect(stats.failed).toBe(1);
    expect(stats.written).toBe(1);
  });
});

describe("an instance's placed models over its terrain", () => {
  /*
   * A model placed by an ADT, turned 90 degrees, its one 64x64 group tile
   * green: 32 yards square. The ADT tile it lands on is red. The paint goes
   * over the terrain where the group is and nowhere else.
   */
  const trsText = [
    "dir: Azeroth",
    "Azeroth\\map32_32.blp\tred.blp",
    "dir: WMO\\Dungeon\\Fixture",
    "WMO\\Dungeon\\Fixture\\Fixture_000_00_00.blp\tgreen.blp",
    "WMO\\Dungeon\\Fixture\\Other_000_00_00.blp\tblue.blp",
    "",
  ].join("\n");
  const green = (() => {
    const blocks = new Uint8Array(16 * 16 * 8);
    const block = dxt1Block(rgb565of(0, 255, 0), 0);
    for (let i = 0; i < 16 * 16; i++) blocks.set(block, i * 8);
    return buildDxtBlp(64, 64, 1, blocks);
  })();
  const archive = buildMpq([
    { name: "textures\\Minimap\\md5translate.trs", data: new TextEncoder().encode(trsText) },
    { name: "textures\\Minimap\\red.blp", data: solidTile(255, 0, 0) },
    { name: "textures\\Minimap\\green.blp", data: green },
    { name: "textures\\Minimap\\blue.blp", data: solidTile(0, 0, 255) },
  ]);
  const c = new MpqChain([MpqArchive.fromSource("fixture", bufferSource(archive))]);
  const text = new TextDecoder().decode(c.read("textures\\Minimap\\md5translate.trs")!);
  const adtTiles = parseTrs(text).get("azeroth")!;
  const wmoTiles = parseWmoTrs(text).get("wmo\\dungeon\\fixture")!.filter((t) => t.model === "fixture");
  // Model box x [0, 32], y [-32, 0]; placed 100 yards south and 100 east of
  // the world origin (inside tile 32_32), turned +90 degrees.
  const box: WmoGroupBox = { min: [0, -32, 0], max: [32, 0, 0] };
  const at = placement([ADT_FRAME_ORIGIN + 100, 0, ADT_FRAME_ORIGIN + 100], 90);
  const toWorld = placementToWorld(at, "adt");
  const outDir = join(scratch, "36");

  test("the stem filter keeps another model's tiles out", () => {
    expect(wmoTiles).toHaveLength(1);
    expect(wmoTiles[0]?.hash).toBe("green.blp");
  });

  test("a turned model lands where its placement says", () => {
    const stats = { written: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 };
    const paint: WmoPaint = paintWmos(c, [{ tiles: wmoTiles, boxes: [box], toWorld }], { limit: Infinity }, stats);
    expect([...paint.keys()]).toEqual(["32_32"]);
    // Turned +90 then negated: model (x, y) -> world (-100 + y, -100 - x), so
    // the box covers world x [-132, -100] and y [-132, -100]. That is south
    // and east of the origin; the last sample in is half a yard short of 132.
    const hits = paint.get("32_32")!.hits;
    const lit: number[] = [];
    for (let i = 0; i < hits.length; i++) if ((hits[i] as number) > 0) lit.push(i);
    const rows = lit.map((i) => Math.floor(i / 256));
    const cols = lit.map((i) => i % 256);
    const px = (yards: number): number => Math.floor((yards / 533.33325) * 256);
    expect(Math.min(...rows)).toBe(px(100));
    expect(Math.max(...rows)).toBe(px(131.5));
    expect(Math.min(...cols)).toBe(px(100));
    expect(Math.max(...cols)).toBe(px(131.5));
  });

  test("the paint goes over the terrain tile, which keeps its own pixels elsewhere", () => {
    const stats = { written: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 };
    const paint = paintWmos(c, [{ tiles: wmoTiles, boxes: [box], toWorld }], { limit: Infinity }, stats);
    expect(extractMap(c, adtTiles, outDir, { force: false, limit: Infinity }, paint)).toMatchObject({ written: 1 });
    const inside = pixelAt(join(outDir, "32_32.png"), 55, 55);
    expect(inside[1]).toBeGreaterThan(240);
    expect(inside[0]).toBeLessThan(16);
    expect(inside[3]).toBe(255);
    const outside = pixelAt(join(outDir, "32_32.png"), 10, 10);
    expect(outside[0]).toBeGreaterThan(240);
    expect(outside[1]).toBeLessThan(16);
  });

  test("is idempotent: the composite is written once and then skipped", () => {
    const paint = paintWmos(c, [{ tiles: wmoTiles, boxes: [box], toWorld }], { limit: Infinity }, {
      written: 0,
      skipped: 0,
      missing: 0,
      failed: 0,
      bytes: 0,
    });
    expect(extractMap(c, adtTiles, outDir, { force: false, limit: Infinity }, paint)).toMatchObject({
      written: 0,
      skipped: 1,
    });
    expect(pixelAt(join(outDir, "32_32.png"), 55, 55)[1]).toBeGreaterThan(240);
  });
});

describe("the default maps", () => {
  test("are exactly the maps the dashboard names, so none is drawn as a bare number", () => {
    expect([...DEFAULT_MAPS].sort((a, b) => a - b)).toEqual(Object.keys(TILED_MAPS).map(Number).sort((a, b) => a - b));
  });

  test("still cover every map already published", () => {
    for (const id of [0, 1, 36, 369, 530, 571]) expect(DEFAULT_MAPS).toContain(id);
  });

  test("take in the dungeons and raids, and leave out what has no place to draw", () => {
    for (const id of [33, 230, 429, 540, 574, 668, 249, 533, 631]) expect(DEFAULT_MAPS).toContain(id);
    // Unused in Map.dbc (44, 598), a test map (169), no client minimap (624, 649, 650).
    for (const id of [44, 169, 598, 624, 649, 650]) expect(DEFAULT_MAPS).not.toContain(id);
  });
});
