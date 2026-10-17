/**
 * Minimap tiles, served straight off `data/minimap/`.
 *
 * Two shapes, both under `/tiles/<mapId>/`:
 *
 * - `<row>_<col>.png`, the native tile, one per ADT, written by the extraction
 *   in `minimap/`;
 * - `<layer>/<z>/<row>_<col>.png`, a level of the downsampled pyramid baked
 *   from those by the same tooling (`lodTileName` in `worldmap.ts` owns the
 *   spelling). The native path is the minimap layer's level 0 and never moves:
 *   the bucket and every deployed build already address it.
 *
 * Nothing here creates or expects them. A missing tile — or a missing
 * extraction entirely — is a normal state: the client draws a labelled grid
 * square instead, so the map works on a machine that has never run the
 * extraction. That is why there is no startup check for the directory.
 *
 * These are the only Blizzard-derived bytes the viewer serves and they never
 * leave `data/`. Path segments are matched as bare integers, the layer against
 * a closed list, and the file path is re-joined from the parsed numbers and
 * that list's own constant, so nothing a request says can address a file
 * outside the tile root.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { GRID, LOD_LAYERS, LOD_MAX, type LodLayer, lodGrid, lodTileName, tileName } from "./worldmap";

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
const LOD_PATH = /^\/tiles\/(\d+)\/([a-z]+)\/(\d+)\/(\d+)_(\d+)\.png$/;

export interface TileRef {
  map: number;
  row: number;
  col: number;
  /** The pyramid level, absent for a native tile. */
  lod?: { layer: LodLayer; z: number };
}

/**
 * Parse a request path into a tile reference, or null if it is not one.
 *
 * Strict on purpose: bare digits only, so `..`, a leading `-`, a decimal point
 * and an encoded separator all fail the match rather than being sanitised. A
 * pyramid path must name a listed layer and a level 1..`LOD_MAX` — level 0
 * exists only as the native path — and its row and column must fall inside
 * that level's smaller grid.
 */
export function parseTilePath(path: string): TileRef | null {
  const native = TILE_PATH.exec(path);
  if (native !== null) {
    const map = Number(native[1]!);
    const row = Number(native[2]!);
    const col = Number(native[3]!);
    if (!Number.isSafeInteger(map) || map < 0) return null;
    if (row < 0 || row >= GRID || col < 0 || col >= GRID) return null;
    return { map, row, col };
  }
  const m = LOD_PATH.exec(path);
  if (m === null) return null;
  const map = Number(m[1]!);
  const layer = LOD_LAYERS.find((l) => l === m[2]);
  const z = Number(m[3]!);
  const row = Number(m[4]!);
  const col = Number(m[5]!);
  if (!Number.isSafeInteger(map) || map < 0 || layer === undefined) return null;
  if (!Number.isSafeInteger(z) || z < 1 || z > LOD_MAX) return null;
  const n = lodGrid(z);
  if (row < 0 || row >= n || col < 0 || col >= n) return null;
  return { map, row, col, lod: { layer, z } };
}

/** A reference's file, relative to the tile root — the one spelling the bake writes. */
function relativePath(ref: TileRef): string {
  const name = ref.lod === undefined ? tileName(ref.row, ref.col) : lodTileName(ref.lod.layer, ref.lod.z, ref.row, ref.col);
  return `${ref.map}/${name}`;
}

/**
 * The canonical request path for a reference. A path that parses but is not
 * this (a leading zero, say) names the same file under a second spelling,
 * which is why the tile publisher keys only canonical ones.
 */
export function tileRefPath(ref: TileRef): string {
  return `/tiles/${relativePath(ref)}`;
}

/**
 * The file a tile request names, or null if the path is invalid or no such
 * tile was extracted. The returned path is built from the parsed integers and
 * the layer list, not from the request string.
 */
export function resolveTilePath(root: string, path: string): string | null {
  const ref = parseTilePath(path);
  if (ref === null) return null;
  const file = join(root, relativePath(ref));
  return existsSync(file) ? file : null;
}
