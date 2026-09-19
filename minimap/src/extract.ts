#!/usr/bin/env bun
/**
 * Minimap tile extractor. Feeds the dashboard's map view; the rationale lives
 * in docs/ARCHITECTURE.md (dashboard section).
 *
 * Reads the WoW 3.3.5a client archives on the host, decodes the minimap BLP2
 * tiles and writes `data/minimap/<mapId>/<tileRow>_<tileCol>.png` (256x256
 * RGBA). Idempotent: existing tiles are skipped unless `--force`.
 *
 *   bun run minimap/src/extract.ts [--map 0,1,369,530,571] [--force] [--limit N]
 *                                  [--out <data dir>] [--client <client dir>]
 *
 * `--out` moves the `minimap/` output tree off `data/`; `--client` points at a
 * client install other than `data/client`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TILE_PX as WORLD_TILE_PX, GRID, worldToPixel } from "../../runner/viewer/worldmap";
import { MpqChain } from "./mpq";
import { decodeBlp } from "./blp";
import { mapDirectories } from "./dbc";
import { encodePng } from "./png";
import { type TrsTile, type TrsWmoTile, parseTrs, parseWmoTrs } from "./trs";
import {
  type WmoGroupBox,
  groupTileOrigin,
  isIdentityPlacement,
  parseWdtGlobalWmo,
  parseWmoGroupBoxes,
  tilePixelToWorld,
  wmoTrsSection,
} from "./wmo";

/** Client load order: later archives override earlier ones. */
export const ARCHIVE_ORDER = [
  "common.MPQ",
  "common-2.MPQ",
  "expansion.MPQ",
  "lichking.MPQ",
  "patch.MPQ",
  "patch-2.MPQ",
  "patch-3.MPQ",
];

const TILE_PX = 256;
const DEFAULT_MAPS = [0, 1, 369, 530, 571];
const TRS_PATH = "textures\\Minimap\\md5translate.trs";

interface Options {
  dataDir: string;
  clientDir: string;
  dbcDir: string;
  maps: number[];
  force: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Options {
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const opts: Options = {
    dataDir: join(root, "data", "minimap"),
    clientDir: join(root, "data", "client-source", "Data"),
    dbcDir: join(root, "data", "client", "dbc"),
    maps: DEFAULT_MAPS,
    force: false,
    limit: Number.POSITIVE_INFINITY,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--force") opts.force = true;
    else if (arg === "--map" && next) {
      opts.maps = next.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      i++;
    } else if (arg === "--limit" && next) {
      opts.limit = Number(next);
      i++;
    } else if (arg === "--out" && next) {
      opts.dataDir = next;
      i++;
    } else if (arg === "--client" && next) {
      opts.clientDir = next;
      i++;
    }
  }
  return opts;
}

export interface ExtractStats {
  written: number;
  skipped: number;
  missing: number;
  failed: number;
  bytes: number;
}

const zero = (): ExtractStats => ({ written: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 });

/**
 * Decode every tile of one map directory into `outDir` as `<row>_<col>.png`.
 * Existing files are left alone unless `force`.
 */
export function extractMap(
  chain: MpqChain,
  tiles: TrsTile[],
  outDir: string,
  opts: { force: boolean; limit: number },
): ExtractStats {
  mkdirSync(outDir, { recursive: true });
  const stats = zero();
  const budget = Math.min(tiles.length, opts.limit);
  for (let i = 0; i < budget; i++) {
    const tile = tiles[i];
    if (!tile) continue;
    const outPath = join(outDir, `${tile.row}_${tile.col}.png`);
    if (!opts.force && existsSync(outPath)) {
      stats.skipped++;
      stats.bytes += statSync(outPath).size;
      continue;
    }
    let blp: Uint8Array | undefined;
    try {
      blp = chain.read(`textures\\Minimap\\${tile.hash}`);
    } catch (err) {
      console.error(`  ${tile.hash}: ${(err as Error).message}`);
      stats.failed++;
      continue;
    }
    if (!blp) {
      stats.missing++;
      continue;
    }
    try {
      const img = decodeBlp(blp);
      if (img.width !== TILE_PX || img.height !== TILE_PX) {
        console.error(
          `  map${tile.col}_${tile.row}: unexpected size ${img.width}x${img.height}, writing anyway`,
        );
      }
      const png = encodePng(img.rgba, img.width, img.height);
      writeFileSync(outPath, png);
      stats.written++;
      stats.bytes += png.byteLength;
    } catch (err) {
      console.error(`  map${tile.col}_${tile.row} (${tile.hash}): ${(err as Error).message}`);
      stats.failed++;
    }
  }
  return stats;
}

/**
 * The same job for a map that is one WMO rather than a grid of ADTs.
 *
 * Unlike the ADT path this cannot blit: a group tile is 2 px per yard where an
 * ADT tile is 0.48, and its axes are transposed against the world grid, so
 * every source pixel is placed individually and the ~17 that share a
 * destination pixel are averaged. See `wmo.ts` for where the numbers come
 * from. Output is the same `<row>_<col>.png` convention the viewer serves —
 * nothing downstream can tell the two paths apart, which is the point.
 *
 * Destination pixels no source covered stay transparent, so the map page draws
 * its lattice through the empty corners of a tile instead of a black square.
 */
export function compositeWmoMap(
  chain: MpqChain,
  tiles: TrsWmoTile[],
  boxes: WmoGroupBox[],
  outDir: string,
  opts: { force: boolean; limit: number },
): ExtractStats {
  const stats = zero();

  interface Accum {
    sum: Float64Array;
    hits: Uint32Array;
  }
  const dest = new Map<string, Accum>();

  const budget = Math.min(tiles.length, opts.limit);
  for (let i = 0; i < budget; i++) {
    const tile = tiles[i];
    if (!tile) continue;
    const box = boxes[tile.group];
    if (box === undefined) {
      console.error(`  group ${tile.group}: no MOGI entry, skipping`);
      stats.failed++;
      continue;
    }
    let blp: Uint8Array | undefined;
    try {
      blp = chain.read(`textures\\Minimap\\${tile.hash}`);
    } catch (err) {
      console.error(`  ${tile.hash}: ${(err as Error).message}`);
      stats.failed++;
      continue;
    }
    if (!blp) {
      stats.missing++;
      continue;
    }
    let img: { rgba: Uint8Array; width: number; height: number };
    try {
      img = decodeBlp(blp);
    } catch (err) {
      console.error(`  group ${tile.group} ${tile.a}_${tile.b} (${tile.hash}): ${(err as Error).message}`);
      stats.failed++;
      continue;
    }
    const origin = groupTileOrigin(box, tile.a, tile.b);
    for (let sy = 0; sy < img.height; sy++) {
      for (let sx = 0; sx < img.width; sx++) {
        const at = (sy * img.width + sx) * 4;
        if ((img.rgba[at + 3] as number) < 8) continue;
        const world = tilePixelToWorld(origin, sx, sy);
        const p = worldToPixel(world.x, world.y);
        const px = Math.floor(p.px);
        const py = Math.floor(p.py);
        const row = Math.floor(py / WORLD_TILE_PX);
        const col = Math.floor(px / WORLD_TILE_PX);
        if (row < 0 || row >= GRID || col < 0 || col >= GRID) continue;
        const key = `${row}_${col}`;
        let acc = dest.get(key);
        if (acc === undefined) {
          acc = {
            sum: new Float64Array(WORLD_TILE_PX * WORLD_TILE_PX * 3),
            hits: new Uint32Array(WORLD_TILE_PX * WORLD_TILE_PX),
          };
          dest.set(key, acc);
        }
        const to = (py - row * WORLD_TILE_PX) * WORLD_TILE_PX + (px - col * WORLD_TILE_PX);
        const sum = acc.sum;
        sum[to * 3] = (sum[to * 3] as number) + (img.rgba[at] as number);
        sum[to * 3 + 1] = (sum[to * 3 + 1] as number) + (img.rgba[at + 1] as number);
        sum[to * 3 + 2] = (sum[to * 3 + 2] as number) + (img.rgba[at + 2] as number);
        acc.hits[to] = (acc.hits[to] as number) + 1;
      }
    }
  }

  mkdirSync(outDir, { recursive: true });
  for (const key of [...dest.keys()].sort()) {
    const acc = dest.get(key) as Accum;
    const outPath = join(outDir, `${key}.png`);
    if (!opts.force && existsSync(outPath)) {
      stats.skipped++;
      stats.bytes += statSync(outPath).size;
      continue;
    }
    const rgba = new Uint8Array(WORLD_TILE_PX * WORLD_TILE_PX * 4);
    for (let i = 0; i < acc.hits.length; i++) {
      const n = acc.hits[i] as number;
      if (n === 0) continue;
      rgba[i * 4] = Math.round((acc.sum[i * 3] as number) / n);
      rgba[i * 4 + 1] = Math.round((acc.sum[i * 3 + 1] as number) / n);
      rgba[i * 4 + 2] = Math.round((acc.sum[i * 3 + 2] as number) / n);
      rgba[i * 4 + 3] = 255;
    }
    const png = encodePng(rgba, WORLD_TILE_PX, WORLD_TILE_PX);
    writeFileSync(outPath, png);
    stats.written++;
    stats.bytes += png.byteLength;
  }
  return stats;
}

/**
 * Everything the WMO path needs out of the archives for one map, or null with
 * a reason logged. Kept apart from the compositing so the compositor can be
 * tested on bytes built in a fixture.
 */
function readWmoMap(
  chain: MpqChain,
  dir: string,
  wmoTrs: ReturnType<typeof parseWmoTrs>,
): { tiles: TrsWmoTile[]; boxes: WmoGroupBox[] } | null {
  const wdt = chain.read(`World\\Maps\\${dir}\\${dir}.wdt`);
  if (!wdt) return null;
  const placement = parseWdtGlobalWmo(wdt);
  if (placement === null) return null;
  if (!isIdentityPlacement(placement)) {
    console.error(`  ${placement.name} is placed away from the origin; only identity is handled`);
    return null;
  }
  const tiles = wmoTrs.get(wmoTrsSection(placement.name));
  if (!tiles || tiles.length === 0) return null;
  const root = chain.read(placement.name);
  if (!root) {
    console.error(`  ${placement.name} not found in any archive`);
    return null;
  }
  const boxes = parseWmoGroupBoxes(root);
  if (boxes.length === 0) {
    console.error(`  ${placement.name} has no MOGI chunk`);
    return null;
  }
  return { tiles, boxes };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  const archivePaths = ARCHIVE_ORDER.map((n) => join(opts.clientDir, n)).filter((p) =>
    existsSync(p),
  );
  if (archivePaths.length === 0) {
    console.error(`no client archives found under ${opts.clientDir}`);
    process.exit(1);
  }
  const chain = MpqChain.open(archivePaths);

  const trsRaw = chain.read(TRS_PATH);
  if (!trsRaw) {
    console.error(`${TRS_PATH} not found in any archive`);
    process.exit(1);
  }
  console.log(`md5translate.trs from ${chain.provider(TRS_PATH)} (${trsRaw.byteLength} bytes)`);
  const trsText = new TextDecoder().decode(trsRaw);
  const trs = parseTrs(trsText);
  const wmoTrs = parseWmoTrs(trsText);

  const mapDbcPath = join(opts.dbcDir, "Map.dbc");
  if (!existsSync(mapDbcPath)) {
    console.error(`Map.dbc not found at ${mapDbcPath}`);
    process.exit(1);
  }
  const dirToId = mapDirectories(new Uint8Array(readFileSync(mapDbcPath)));
  const idToDir = new Map<number, string>();
  for (const [dir, id] of dirToId) idToDir.set(id, dir);

  const totals = zero();

  for (const mapId of opts.maps) {
    const dir = idToDir.get(mapId);
    if (!dir) {
      console.error(`map ${mapId}: no Map.dbc directory entry, skipping`);
      continue;
    }
    const tiles = trs.get(dir);
    let stats: ExtractStats;
    if (tiles && tiles.length > 0) {
      stats = extractMap(chain, tiles, join(opts.dataDir, String(mapId)), opts);
    } else {
      // No ADT section: the map may still be one big WMO, which has a minimap
      // of its own filed under the model rather than the map.
      const wmo = readWmoMap(chain, dir, wmoTrs);
      if (wmo === null) {
        console.log(`map ${mapId} (${dir}): no minimap tiles in md5translate.trs`);
        continue;
      }
      stats = compositeWmoMap(chain, wmo.tiles, wmo.boxes, join(opts.dataDir, String(mapId)), opts);
    }
    console.log(
      `map ${mapId} (${dir}): ${stats.written} written, ${stats.skipped} skipped, ` +
        `${stats.missing} not in archives, ${stats.failed} failed, ` +
        `${(stats.bytes / 1024 / 1024).toFixed(1)} MiB`,
    );
    totals.written += stats.written;
    totals.skipped += stats.skipped;
    totals.missing += stats.missing;
    totals.failed += stats.failed;
    totals.bytes += stats.bytes;
  }

  const methods = [...chain.methods()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `0x${m.toString(16).padStart(2, "0")}:${n}`)
    .join(" ");
  console.log(`sector compression methods seen: ${methods || "none"}`);
  console.log(
    `total: ${totals.written} written, ${totals.skipped} skipped, ` +
      `${totals.missing} missing, ${totals.failed} failed, ` +
      `${(totals.bytes / 1024 / 1024).toFixed(1)} MiB`,
  );
  chain.close();
}

if (import.meta.main) main();
