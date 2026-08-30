/**
 * Minimap tiles, served straight off `data/minimap/<mapId>/<row>_<col>.png`.
 *
 * The extraction (see `minimap/`) writes them; nothing here creates or expects
 * them. A missing tile — or a missing extraction entirely — is a normal state:
 * the client draws a labelled grid square instead, so the map works on a
 * machine that has never run the extraction. That is why there is no startup
 * check for the directory.
 *
 * These are the only Blizzard-derived bytes the viewer serves and they never
 * leave `data/`. Path segments are matched as bare integers and re-joined from
 * the parsed numbers, so nothing a request says can address a file outside the
 * tile root.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { GRID, tileName } from "./worldmap";

/** Tiles are immutable once extracted: cache them for a year. */
export const TILE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * What a public-mode deployment sends instead, when the operator has opted
 * tiles in with `WRATHBENCH_VIEWER_TILES_PUBLIC=1`.
 *
 * `private` keeps them out of any shared cache between the viewer and the
 * browser that asked, and the hour is short enough that turning the flag back
 * off is felt the same day rather than a year from now. `X-Robots-Tag` rides
 * along on the response so a crawler that reaches one does not index it.
 */
export const TILE_PUBLIC_CACHE_CONTROL = "private, max-age=3600";
export const TILE_PUBLIC_ROBOTS = "noindex";

const TILE_PATH = /^\/tiles\/(\d+)\/(\d+)_(\d+)\.png$/;

export interface TileRef {
  map: number;
  row: number;
  col: number;
}

/**
 * Parse a request path into a tile reference, or null if it is not one.
 *
 * Strict on purpose: bare digits only, so `..`, a leading `-`, a decimal point
 * and an encoded separator all fail the match rather than being sanitised.
 */
export function parseTilePath(path: string): TileRef | null {
  const m = TILE_PATH.exec(path);
  if (m === null) return null;
  const map = Number(m[1]!);
  const row = Number(m[2]!);
  const col = Number(m[3]!);
  if (!Number.isSafeInteger(map) || map < 0) return null;
  if (row < 0 || row >= GRID || col < 0 || col >= GRID) return null;
  return { map, row, col };
}

/**
 * The file a tile request names, or null if the path is invalid or no such
 * tile was extracted. The returned path is built from the parsed integers, not
 * from the request string.
 */
export function resolveTilePath(root: string, path: string): string | null {
  const ref = parseTilePath(path);
  if (ref === null) return null;
  const file = join(root, String(ref.map), tileName(ref.row, ref.col));
  return existsSync(file) ? file : null;
}
