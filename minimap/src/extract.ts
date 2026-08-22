#!/usr/bin/env bun
/**
 * Minimap tile extractor (ADR-0019).
 *
 * Reads the WoW 3.3.5a client archives on the host, decodes the minimap BLP2
 * tiles and writes `data/minimap/<mapId>/<tileRow>_<tileCol>.png` (256x256
 * RGBA). Idempotent: existing tiles are skipped unless `--force`.
 *
 *   bun run minimap/src/extract.ts [--map 0,1,530,571] [--force] [--limit N]
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MpqChain } from "./mpq";
import { decodeBlp } from "./blp";
import { mapDirectories } from "./dbc";
import { encodePng } from "./png";
import { type TrsTile, parseTrs } from "./trs";

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
const DEFAULT_MAPS = [0, 1, 530, 571];
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
    clientDir: join(root, "data", "client-source", "[removed]", "Data"),
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
  const trs = parseTrs(new TextDecoder().decode(trsRaw));

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
    if (!tiles || tiles.length === 0) {
      console.log(`map ${mapId} (${dir}): no minimap tiles in md5translate.trs`);
      continue;
    }
    const stats = extractMap(chain, tiles, join(opts.dataDir, String(mapId)), opts);
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
