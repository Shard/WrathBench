import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { MpqArchive, MpqChain, bufferSource } from "../src/mpq";
import { parseTrs, parseWmoTrs } from "../src/trs";
import { compositeWmoMap, extractMap } from "../src/extract";
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
   * Two one-tile groups, placed so each lands in a different world tile: the
   * origin of a group tile is (-min.x, -max.y + 128), so a group at min.x = 0
   * sits on row 32 and one at min.x = -533.33325 (a whole ADT north) on row 31.
   * Both are at max.y = 128, which puts their east edge on the col 32 boundary.
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
  const boxes = [
    { min: [0, 0, 0], max: [0, 128, 0] },
    { min: [-533.33325, 0, 0], max: [0, 128, 0] },
  ] as const;

  const c = new MpqChain([MpqArchive.fromSource("fixture", bufferSource(wmoArchive))]);
  const tiles = parseWmoTrs(new TextDecoder().decode(c.read("textures\\Minimap\\md5translate.trs")!)).get(
    "wmo\\dungeon\\fixture",
  )!;
  const outDir = join(scratch, "369");

  test("writes one world tile per group, named the way the viewer asks", () => {
    const stats = compositeWmoMap(c, tiles, [...boxes], outDir, { force: false, limit: Infinity });
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
    expect(compositeWmoMap(c, tiles, [...boxes], outDir, { force: false, limit: Infinity })).toMatchObject({
      written: 0,
      skipped: 2,
    });
    expect(compositeWmoMap(c, tiles, [...boxes], outDir, { force: true, limit: Infinity })).toMatchObject({
      written: 2,
      skipped: 0,
    });
  });

  test("counts a group the model does not have rather than throwing", () => {
    const stats = compositeWmoMap(c, tiles, [boxes[0]], join(scratch, "369-partial"), {
      force: false,
      limit: Infinity,
    });
    expect(stats.failed).toBe(1);
    expect(stats.written).toBe(1);
  });
});
