/**
 * The served tree: the format each kind of tile is served in, what must come
 * through exact (alpha always; solid and near-solid tiles whole), that the
 * lossless masters are never touched, the incremental cache, and the per-map
 * index. Every image is synthetic and built here; nothing is read from
 * `data/`. Assertions are on properties, never on encoded bytes or sizes, so
 * a Bun upgrade that changes the encoders does not break them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { indexCovers, indexHas, parseTileIndex } from "../../runner/viewer/tileindex";
import { SERVED_DIR } from "../../runner/viewer/tiles";
import { TILE_PX } from "../../runner/viewer/worldmap";
import { decodePng, encodePng } from "../src/png";
import { TRANSCODE_STATE, artCovers, encoderId, transcodeTile, transcodeTree } from "../src/transcode";

const scratch = mkdtempSync(join(tmpdir(), "wrathbench-transcode-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const dir = join(scratch, String(n++));
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A deterministic busy picture — gradients and noise, many hundreds of colours — with alpha from `alpha(x, y)`. */
function busy(seed: number, alpha: (x: number, y: number) => number = () => 255): Uint8Array {
  const out = new Uint8Array(TILE_PX * TILE_PX * 4);
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s >>> 16) & 0xff;
  };
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const i = (y * TILE_PX + x) * 4;
      out[i] = (x + (rnd() >> 3)) & 0xff;
      out[i + 1] = (y + (rnd() >> 3)) & 0xff;
      out[i + 2] = ((x ^ y) + (rnd() >> 2)) & 0xff;
      out[i + 3] = alpha(x, y);
    }
  }
  return out;
}

function flat(rgba: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(TILE_PX * TILE_PX * 4);
  for (let i = 0; i < TILE_PX * TILE_PX; i++) out.set(rgba, i * 4);
  return out;
}

const png = (rgba: Uint8Array): Uint8Array => encodePng(rgba, TILE_PX, TILE_PX);
const decode = async (bytes: Uint8Array): Promise<Uint8Array> => decodePng(await new Bun.Image(bytes).png().bytes()).rgba;
const alphaOf = (rgba: Uint8Array): number[] => Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4 + 3] as number);
const isWebp = (b: Uint8Array): boolean => new TextDecoder().decode(b.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(b.subarray(8, 12)) === "WEBP";

function write(root: string, rel: string, bytes: Uint8Array): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), bytes);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
}

describe("a tile, native or pyramid", () => {
  test("keeps alpha exact, transparent corners and all", async () => {
    const src = busy(2, (x, y) => (x < 40 && y < 40 ? 0 : 255));
    const out = await transcodeTile(png(src));
    expect(isWebp(out)).toBe(true);
    expect(alphaOf(await decode(out))).toEqual(alphaOf(src));
  });

  test("is served as WebP, lossy where it is busy, with alpha exact through every level of it", async () => {
    const src = busy(3, (x) => x % 256);
    const out = await transcodeTile(png(src));
    expect(isWebp(out)).toBe(true);
    const back = await decode(out);
    expect(alphaOf(back)).toEqual(alphaOf(src));
    expect(back).not.toEqual(src);
  });

  test("solid, near-solid and mostly transparent ones come through exact", async () => {
    const near = flat([30, 70, 160, 255]);
    for (let i = 0; i < 300; i++) near.set([200, 190, 150, 255], (i * 211 % (TILE_PX * TILE_PX)) * 4);
    const sparse = flat([0, 0, 0, 0]);
    for (let i = 0; i < 40; i++) sparse.set([120, 80, 40, 255], (i * 997 % (TILE_PX * TILE_PX)) * 4);
    for (const src of [flat([30, 70, 160, 255]), near, sparse]) {
      const out = await transcodeTile(png(src));
      expect(isWebp(out)).toBe(true);
      expect(await decode(out)).toEqual(src);
    }
  });
});

describe("artCovers", () => {
  test("only where the art is opaque over every pixel the minimap paints", () => {
    const minimap = flat([0, 0, 0, 0]);
    minimap.set([1, 2, 3, 255], 0);
    const art = flat([9, 9, 9, 255]);
    expect(artCovers(art, minimap)).toBe(true);
    art[3] = 254;
    expect(artCovers(art, minimap)).toBe(false);
    // Transparent art over a pixel the minimap does not paint hides nothing.
    art[3] = 255;
    art[7] = 0;
    expect(artCovers(art, minimap)).toBe(true);
  });
});

describe("transcodeTree", () => {
  function tree(): string {
    const root = fresh();
    write(root, "0/43_31.png", png(busy(4)));
    write(root, "0/43_32.png", png(flat([10, 20, 30, 255])));
    write(root, "0/minimap/1/21_15.png", png(busy(5, (x) => (x < 128 ? 255 : 0))));
    write(root, "0/minimap/1/21_16.png", png(busy(6)));
    write(root, "0/art/1/21_15.png", png(busy(7)));
    write(root, "0/art/1/21_16.png", png(busy(8, (x) => (x < 10 ? 0 : 255))));
    write(root, "0/README.md", new TextEncoder().encode("not a tile"));
    write(root, "36/30_30.png", png(busy(9)));
    return root;
  }

  test("writes only the served tree, and never a byte of a master", async () => {
    const root = tree();
    const before = new Map(walk(root).map((p) => [p, readFileSync(join(root, p))]));
    await transcodeTree(root);
    for (const [p, bytes] of before) expect(readFileSync(join(root, p)).equals(bytes)).toBe(true);
    const added = walk(root).filter((p) => !before.has(p));
    expect(added.every((p) => p.startsWith(`${SERVED_DIR}/`))).toBe(true);
    expect(added.map((p) => relative(SERVED_DIR, p))).toEqual(
      [
        "0/43_31.webp",
        "0/43_32.webp",
        "0/art/1/21_15.webp",
        "0/art/1/21_16.webp",
        "0/index.json",
        "0/minimap/1/21_15.webp",
        "0/minimap/1/21_16.webp",
        "36/30_30.webp",
        "36/index.json",
        TRANSCODE_STATE,
      ].sort(),
    );
  });

  test("indexes which cells exist and where the art hides the minimap", async () => {
    const root = tree();
    await transcodeTree(root);
    const index = parseTileIndex(JSON.parse(readFileSync(join(root, SERVED_DIR, "0/index.json"), "utf8")))!;
    expect(index.native).toBe("webp");
    expect(indexHas(index, "minimap", 0, 43, 31)).toBe(true);
    expect(indexHas(index, "minimap", 0, 44, 31)).toBe(false);
    expect(indexHas(index, "art", 1, 21, 16)).toBe(true);
    // Opaque art over a half-painted minimap tile covers it; art with a
    // transparent strip over a fully painted one does not.
    expect(indexCovers(index, 1, 21, 15)).toBe(true);
    expect(indexCovers(index, 1, 21, 16)).toBe(false);
    // A map with no art covers nothing.
    const instance = parseTileIndex(JSON.parse(readFileSync(join(root, SERVED_DIR, "36/index.json"), "utf8")))!;
    expect(instance.covers).toEqual({});
  });

  test("re-encodes only a changed master, everything under a new encoder, and removes what lost its master", async () => {
    const root = tree();
    const first = await transcodeTree(root);
    expect(first.layers.native.encoded).toBe(3);
    const again = await transcodeTree(root);
    expect(Object.values(again.layers).reduce((s, l) => s + l.encoded, 0)).toBe(0);

    write(root, "0/minimap/1/21_16.png", png(busy(10)));
    const changed = await transcodeTree(root);
    expect(changed.layers.minimap.encoded).toBe(1);
    expect(changed.layers.native.encoded + changed.layers.art.encoded).toBe(0);

    // A different Bun (or a changed setting) is a different encoder id.
    const state = join(root, SERVED_DIR, TRANSCODE_STATE);
    const recorded = JSON.parse(readFileSync(state, "utf8")) as { encoder: string };
    expect(recorded.encoder).toBe(encoderId());
    writeFileSync(state, JSON.stringify({ ...recorded, encoder: "bun 0.0.0" }));
    const upgraded = await transcodeTree(root);
    expect(Object.values(upgraded.layers).reduce((s, l) => s + l.encoded, 0)).toBe(7);

    rmSync(join(root, "0/art/1/21_16.png"));
    const pruned = await transcodeTree(root);
    expect(pruned.removed).toBe(1);
    expect(walk(join(root, SERVED_DIR))).not.toContain("0/art/1/21_16.webp");
  });

  test("replaces the indexed PNG natives an older transcode wrote", async () => {
    const root = tree();
    // What a served tree from before the WebP natives holds, current or not.
    write(root, `${SERVED_DIR}/0/43_31.png`, png(busy(4)));
    write(root, `${SERVED_DIR}/36/30_30.png`, png(busy(9)));
    const report = await transcodeTree(root);
    expect(report.removed).toBe(2);
    const served = walk(join(root, SERVED_DIR));
    expect(served.filter((p) => /^\d+\/\d+_\d+\./.test(p))).toEqual(["0/43_31.webp", "0/43_32.webp", "36/30_30.webp"]);
  });

  test("is byte-deterministic", async () => {
    const a = tree();
    const b = tree();
    await transcodeTree(a);
    await transcodeTree(b);
    for (const p of walk(join(a, SERVED_DIR))) expect(readFileSync(join(a, SERVED_DIR, p)).equals(readFileSync(join(b, SERVED_DIR, p)))).toBe(true);
  });
});
