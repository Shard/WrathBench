#!/usr/bin/env bun
/**
 * Minimap tile extractor. Feeds the dashboard's map view; the rationale lives
 * in docs/ARCHITECTURE.md (dashboard section).
 *
 * Reads the WoW 3.3.5a client archives on the host, decodes the minimap BLP2
 * tiles and writes `data/minimap/<mapId>/<tileRow>_<tileCol>.png` (256x256
 * RGBA). Idempotent: existing tiles are skipped unless `--force`.
 *
 *   bun run minimap/src/extract.ts [--map 0,1,36,369,530,571] [--force] [--limit N]
 *                                  [--data <dir>] [--out <tile root>] [--client <client Data dir>]
 *
 * `--data` is the data directory the other inputs default under (`data/`):
 * the archives in `<data>/client-source/Data`, Map.dbc in `<data>/client/dbc`
 * and the output in `<data>/minimap`. `--out` and `--client` move just one of
 * those.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TILE_PX as WORLD_TILE_PX, GRID, worldToPixel } from "../../runner/viewer/worldmap";
import { MpqChain } from "./mpq";
import { decodeBlp } from "./blp";
import { encodePng } from "./png";
import { type TrsTile, type TrsWmoIndex, type TrsWmoTile, parseTrs, parseWmoTrs } from "./trs";
import { mapDirectories, mapInstanceTypes } from "./dbc";
import {
  type ModelToWorld,
  type WmoGroupBox,
  type WmoPlacement,
  groupPixelToModel,
  isUprightPlacement,
  parseAdtWmoPlacements,
  parseWdtGlobalWmo,
  parseWmoGroupBoxes,
  placementToWorld,
  wmoModelStem,
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
const DEFAULT_MAPS = [0, 1, 36, 369, 530, 571];
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
  let data = join(root, "data");
  let out: string | null = null;
  let client: string | null = null;
  const opts = {
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
    } else if (arg === "--data" && next) {
      data = next;
      i++;
    } else if (arg === "--out" && next) {
      out = next;
      i++;
    } else if (arg === "--client" && next) {
      client = next;
      i++;
    }
  }
  return {
    ...opts,
    dataDir: out ?? join(data, "minimap"),
    clientDir: client ?? join(data, "client-source", "Data"),
    dbcDir: join(data, "client", "dbc"),
  };
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
  overlay?: WmoPaint,
): ExtractStats {
  mkdirSync(outDir, { recursive: true });
  const stats = zero();
  const budget = Math.min(tiles.length, opts.limit);
  for (let i = 0; i < budget; i++) {
    const tile = tiles[i];
    if (!tile) continue;
    const key = `${tile.row}_${tile.col}`;
    const outPath = join(outDir, `${key}.png`);
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
      const paint = overlay?.get(key);
      if (paint !== undefined && img.width === WORLD_TILE_PX && img.height === WORLD_TILE_PX) {
        paintOver(img.rgba, paint);
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

/** One placed model: its tiles, its groups' boxes, and where it stands. */
export interface PlacedWmo {
  tiles: TrsWmoTile[];
  boxes: WmoGroupBox[];
  toWorld: ModelToWorld;
}

/**
 * WMO paint resampled onto the world tile grid, per `<row>_<col>` key: the
 * sum of every source pixel that landed on each destination pixel, and how
 * many did.
 */
export type WmoPaint = Map<string, { sum: Float64Array; hits: Uint32Array }>;

/**
 * Place every group tile of every model onto the world tile grid.
 *
 * Unlike the ADT path this cannot blit: a group tile is 2 px per yard where an
 * ADT tile is 0.48, and its axes are turned against the world grid, so every
 * source pixel is placed individually and the ~17 that share a destination
 * pixel are averaged. See `wmo.ts` for where the numbers come from.
 */
export function paintWmos(
  chain: MpqChain,
  placed: PlacedWmo[],
  opts: { limit: number },
  stats: ExtractStats,
): WmoPaint {
  const dest: WmoPaint = new Map();
  let budget = opts.limit;
  for (const model of placed) {
    for (const tile of model.tiles) {
      if (budget-- <= 0) return dest;
      const box = model.boxes[tile.group];
      if (box === undefined) {
        console.error(`  ${tile.model} group ${tile.group}: no MOGI entry, skipping`);
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
        console.error(`  ${tile.model} group ${tile.group} ${tile.a}_${tile.b} (${tile.hash}): ${(err as Error).message}`);
        stats.failed++;
        continue;
      }
      for (let sy = 0; sy < img.height; sy++) {
        for (let sx = 0; sx < img.width; sx++) {
          const at = (sy * img.width + sx) * 4;
          if ((img.rgba[at + 3] as number) < 8) continue;
          const m = groupPixelToModel(box, tile, img.height, sx, sy);
          const world = model.toWorld(m.x, m.y);
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
  }
  return dest;
}

/**
 * Lay one tile's worth of WMO paint over an RGBA tile in place: every pixel
 * the paint reached becomes its average, opaque, and the rest is left alone.
 * The paint replaces rather than blends because what is under it is the
 * ground above the rooms it draws.
 */
export function paintOver(rgba: Uint8Array, paint: { sum: Float64Array; hits: Uint32Array }): void {
  for (let i = 0; i < paint.hits.length; i++) {
    const n = paint.hits[i] as number;
    if (n === 0) continue;
    rgba[i * 4] = Math.round((paint.sum[i * 3] as number) / n);
    rgba[i * 4 + 1] = Math.round((paint.sum[i * 3 + 1] as number) / n);
    rgba[i * 4 + 2] = Math.round((paint.sum[i * 3 + 2] as number) / n);
    rgba[i * 4 + 3] = 255;
  }
}

/**
 * Write WMO paint as tiles of its own over transparency, skipping `except`.
 *
 * Destination pixels no source covered stay transparent, so the map page draws
 * its lattice through the empty corners of a tile instead of a black square.
 */
export function writeWmoPaint(
  paint: WmoPaint,
  outDir: string,
  opts: { force: boolean },
  stats: ExtractStats,
  except: ReadonlySet<string> = new Set(),
): void {
  mkdirSync(outDir, { recursive: true });
  for (const key of [...paint.keys()].sort()) {
    if (except.has(key)) continue;
    const outPath = join(outDir, `${key}.png`);
    if (!opts.force && existsSync(outPath)) {
      stats.skipped++;
      stats.bytes += statSync(outPath).size;
      continue;
    }
    const rgba = new Uint8Array(WORLD_TILE_PX * WORLD_TILE_PX * 4);
    paintOver(rgba, paint.get(key) as { sum: Float64Array; hits: Uint32Array });
    const png = encodePng(rgba, WORLD_TILE_PX, WORLD_TILE_PX);
    writeFileSync(outPath, png);
    stats.written++;
    stats.bytes += png.byteLength;
  }
}

/**
 * The same job for a map that is one WMO rather than a grid of ADTs. Output
 * is the same `<row>_<col>.png` convention the viewer serves — nothing
 * downstream can tell the two paths apart, which is the point.
 */
export function compositeWmoMap(
  chain: MpqChain,
  placed: PlacedWmo[],
  outDir: string,
  opts: { force: boolean; limit: number },
): ExtractStats {
  const stats = zero();
  writeWmoPaint(paintWmos(chain, placed, opts, stats), outDir, opts, stats);
  return stats;
}

/** One model's tiles and boxes out of the archives, or null with a reason logged. */
function readWmo(
  chain: MpqChain,
  placement: WmoPlacement,
  frame: "wdt" | "adt",
  wmoTrs: TrsWmoIndex,
): PlacedWmo | null {
  if (!isUprightPlacement(placement)) {
    console.error(`  ${placement.name} is tilted; only a turn about the vertical is handled`);
    return null;
  }
  const stem = wmoModelStem(placement.name);
  const tiles = (wmoTrs.get(wmoTrsSection(placement.name)) ?? []).filter((t) => t.model === stem);
  if (tiles.length === 0) return null;
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
  return { tiles, boxes, toWorld: placementToWorld(placement, frame) };
}

/**
 * The global WMO of a terrain-less map. Kept apart from the compositing so the
 * compositor can be tested on bytes built in a fixture.
 */
function readGlobalWmo(chain: MpqChain, dir: string, wmoTrs: TrsWmoIndex): PlacedWmo | null {
  const wdt = chain.read(`World\\Maps\\${dir}\\${dir}.wdt`);
  if (!wdt) return null;
  const placement = parseWdtGlobalWmo(wdt);
  if (placement === null) return null;
  return readWmo(chain, placement, "wdt", wmoTrs);
}

/**
 * Every model the map's ADTs place that has minimap tiles of its own — in
 * practice its indoor groups, the only ones the client files a minimap for.
 * A model that straddles ADTs is listed by each of them and read once.
 */
function readPlacedWmos(
  chain: MpqChain,
  dir: string,
  tiles: TrsTile[],
  wmoTrs: TrsWmoIndex,
): PlacedWmo[] {
  const seen = new Set<number>();
  const out: PlacedWmo[] = [];
  for (const tile of tiles) {
    const adt = chain.read(`World\\Maps\\${dir}\\${dir}_${tile.col}_${tile.row}.adt`);
    if (!adt) continue;
    for (const placement of parseAdtWmoPlacements(adt)) {
      if (seen.has(placement.uniqueId)) continue;
      seen.add(placement.uniqueId);
      const wmo = readWmo(chain, placement, "adt", wmoTrs);
      if (wmo === null) continue;
      console.log(`  ${placement.name}: ${wmo.tiles.length} group tiles`);
      out.push(wmo);
    }
  }
  return out;
}

/**
 * Dungeons and raids, whose play is mostly indoors: the maps whose placed
 * models are drawn over the terrain. A continent's buildings are not — the
 * terrain minimap already paints their roofs, which is the right picture
 * from above, and there are thousands of them.
 */
function drawsPlacedWmos(instanceType: number | undefined): boolean {
  return instanceType === 1 || instanceType === 2;
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
  const mapDbc = new Uint8Array(readFileSync(mapDbcPath));
  const dirToId = mapDirectories(mapDbc);
  const instanceTypes = mapInstanceTypes(mapDbc);
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
    const out = join(opts.dataDir, String(mapId));
    if (tiles && tiles.length > 0) {
      if (drawsPlacedWmos(instanceTypes.get(mapId))) {
        // An instance's rooms are models its ADTs place, not terrain: lay
        // their own minimaps over the ground above them.
        const placed = readPlacedWmos(chain, dir, tiles, wmoTrs);
        const wmoStats = zero();
        const paint = paintWmos(chain, placed, { limit: Number.POSITIVE_INFINITY }, wmoStats);
        stats = extractMap(chain, tiles, out, opts, paint);
        writeWmoPaint(paint, out, opts, stats, new Set(tiles.map((t) => `${t.row}_${t.col}`)));
        stats.missing += wmoStats.missing;
        stats.failed += wmoStats.failed;
      } else {
        stats = extractMap(chain, tiles, out, opts);
      }
    } else {
      // No ADT section: the map may still be one big WMO, which has a minimap
      // of its own filed under the model rather than the map.
      const wmo = readGlobalWmo(chain, dir, wmoTrs);
      if (wmo === null) {
        console.log(`map ${mapId} (${dir}): no minimap tiles in md5translate.trs`);
        continue;
      }
      stats = compositeWmoMap(chain, [wmo], out, opts);
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
