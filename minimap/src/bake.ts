#!/usr/bin/env bun
/**
 * The minimap's level-of-detail pyramid, baked from the native tiles the
 * extractor wrote. Feeds the dashboard's map at zooms where a native tile
 * would be drawn smaller than it is worth fetching; the rationale lives in
 * `minimap/README.md`.
 *
 * Reads `<root>/<mapId>/<row>_<col>.png` and writes, for z = 1..LOD_MAX,
 * `<root>/<mapId>/minimap/<z>/<row>_<col>.png`: 256x256 RGBA, each covering
 * 2^z x 2^z ADTs, box-filtered from the level below. Only tiles with content
 * are written, and an existing one is skipped unless `--force`.
 *
 *   bun minimap/src/bake.ts [--map 0,1,36,369,530,571] [--force] [--out <tile root>]
 *
 * `--out` is the tile root it both reads and writes (default `data/minimap`,
 * the tree `extract.ts --out` names). With no `--map`, every map directory
 * under it is baked.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GRID, LOD_MAX, MINIMAP_LAYER, TILE_PX, lodTileName } from "../../runner/viewer/worldmap";
import { decodePng, encodePng } from "./png";

/** RGBA, `TILE_PX` square. */
export type Pixels = Uint8Array;

/**
 * Four children — top-left, top-right, bottom-left, bottom-right, any of them
 * absent — into the one parent tile that covers them, or null when nothing in
 * them is opaque.
 *
 * A 2x2 box filter, weighted by alpha: colour is the alpha-weighted mean and
 * alpha the plain one. Unweighted, a transparent pixel's black would bleed
 * into every edge it touches; the native ADT tiles are opaque, so for them
 * the two are identical, but the Deeprun Tram's composite is not (its corners
 * are transparent by design) and the weighting is what keeps its outline
 * from darkening a level up. A missing child is a transparent quadrant.
 */
export function downsampleQuad(children: readonly (Pixels | null)[], px = TILE_PX): Pixels | null {
  if (children.length !== 4) throw new Error(`a parent has 4 children, not ${children.length}`);
  const half = px >> 1;
  const row = px * 4;
  const out = new Uint8Array(px * px * 4);
  let opaque = false;
  for (let q = 0; q < 4; q++) {
    const child = children[q];
    if (child === null || child === undefined) continue;
    if (child.byteLength !== px * px * 4) throw new Error(`child is ${child.byteLength} bytes, expected ${px * px * 4}`);
    const ox = (q & 1) * half;
    const oy = (q >> 1) * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const s0 = (2 * y * px + 2 * x) * 4;
        const s1 = s0 + 4;
        const s2 = s0 + row;
        const s3 = s2 + 4;
        const a0 = child[s0 + 3] as number;
        const a1 = child[s1 + 3] as number;
        const a2 = child[s2 + 3] as number;
        const a3 = child[s3 + 3] as number;
        const sum = a0 + a1 + a2 + a3;
        if (sum === 0) continue;
        const d = ((oy + y) * px + ox + x) * 4;
        for (let k = 0; k < 3; k++) {
          const c =
            (child[s0 + k] as number) * a0 +
            (child[s1 + k] as number) * a1 +
            (child[s2 + k] as number) * a2 +
            (child[s3 + k] as number) * a3;
          out[d + k] = Math.round(c / sum);
        }
        const a = (sum + 2) >> 2;
        out[d + 3] = a;
        if (a > 0) opaque = true;
      }
    }
  }
  return opaque ? out : null;
}

export interface LevelStats {
  z: number;
  written: number;
  skipped: number;
  bytes: number;
}

const NATIVE = /^(\d+)_(\d+)\.png$/;

/** The native tiles of one map directory, `row_col` -> file, canonical names only. */
function nativeTiles(mapDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(mapDir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = NATIVE.exec(name);
    if (m === null) continue;
    const row = Number(m[1]);
    const col = Number(m[2]);
    // `043_31.png` would be a second spelling of a tile; the viewer would never
    // serve it under that name, so it is not an input either.
    if (`${row}_${col}.png` !== name || row >= GRID || col >= GRID) continue;
    out.set(`${row}_${col}`, join(mapDir, name));
  }
  return out;
}

function decodeTile(file: string): Pixels {
  const img = decodePng(new Uint8Array(readFileSync(file)));
  if (img.width !== TILE_PX || img.height !== TILE_PX) {
    throw new Error(`${file} is ${img.width}x${img.height}, expected ${TILE_PX}x${TILE_PX}`);
  }
  return img.rgba;
}

/** Write via a temp name, so a reader never sees half a tile. */
export function writeTile(file: string, png: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, png);
  renameSync(tmp, file);
}

/**
 * Bake every level of one map's pyramid.
 *
 * Every level is computed from the one below it in memory, whatever is on
 * disk: `force` decides only whether an existing file is rewritten. A level
 * read back from a skipped file instead would build the next one on bytes
 * the current natives may no longer agree with. One level is held at a time
 * (a few hundred tiles at level 1 for the largest map); natives are decoded
 * on demand and dropped, since each one has exactly one parent.
 */
export function bakeMap(mapDir: string, opts: { force: boolean }): LevelStats[] {
  const natives = nativeTiles(mapDir);
  const stats: LevelStats[] = [];
  let below: Map<string, Pixels> | null = null;
  let present: Iterable<string> = natives.keys();

  for (let z = 1; z <= LOD_MAX; z++) {
    const level: LevelStats = { z, written: 0, skipped: 0, bytes: 0 };
    const parents = new Map<string, [number, number]>();
    for (const key of present) {
      const [r, c] = key.split("_").map(Number) as [number, number];
      parents.set(`${r >> 1}_${c >> 1}`, [r >> 1, c >> 1]);
    }
    const prev = below;
    const child = (r: number, c: number): Pixels | null => {
      const key = `${r}_${c}`;
      if (prev !== null) return prev.get(key) ?? null;
      const file = natives.get(key);
      return file === undefined ? null : decodeTile(file);
    };
    const here = new Map<string, Pixels>();
    const order = [...parents.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [r, c] of order) {
      const px = downsampleQuad([
        child(2 * r, 2 * c),
        child(2 * r, 2 * c + 1),
        child(2 * r + 1, 2 * c),
        child(2 * r + 1, 2 * c + 1),
      ]);
      if (px === null) continue;
      here.set(`${r}_${c}`, px);
      const file = join(mapDir, lodTileName(MINIMAP_LAYER, z, r, c));
      if (!opts.force && existsSync(file)) {
        level.skipped++;
        level.bytes += statSync(file).size;
        continue;
      }
      const png = encodePng(px, TILE_PX, TILE_PX);
      writeTile(file, png);
      level.written++;
      level.bytes += png.byteLength;
    }
    stats.push(level);
    below = here;
    present = here.keys();
  }
  return stats;
}

interface Options {
  root: string;
  maps: number[] | null;
  force: boolean;
}

function parseArgs(argv: string[]): Options {
  const repo = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const opts: Options = { root: join(repo, "data", "minimap"), maps: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--force") opts.force = true;
    else if (arg === "--map" && next) {
      opts.maps = next
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isSafeInteger(n) && n >= 0);
      i++;
    } else if (arg === "--out" && next) {
      opts.root = next;
      i++;
    } else {
      console.error(`bake: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.root)) {
    console.error(`bake: no tile root at ${opts.root} (run extract.ts first)`);
    process.exit(1);
  }
  const maps =
    opts.maps ??
    readdirSync(opts.root)
      .filter((d) => /^\d+$/.test(d) && String(Number(d)) === d)
      .map(Number)
      .sort((a, b) => a - b);
  const mib = (b: number): string => (b / 1024 / 1024).toFixed(2);
  let written = 0;
  let skipped = 0;
  let bytes = 0;
  for (const map of maps) {
    const started = performance.now();
    const levels = bakeMap(join(opts.root, String(map)), opts);
    for (const l of levels) {
      console.log(`map ${map} z${l.z}: ${l.written} written, ${l.skipped} skipped, ${mib(l.bytes)} MiB`);
      written += l.written;
      skipped += l.skipped;
      bytes += l.bytes;
    }
    console.log(`map ${map}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
  console.log(`total: ${written} written, ${skipped} skipped, ${mib(bytes)} MiB`);
}

if (import.meta.main) main();
