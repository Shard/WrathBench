import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { MpqArchive, MpqChain, bufferSource } from "../src/mpq";
import { parseTrs } from "../src/trs";
import { extractMap } from "../src/extract";
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
