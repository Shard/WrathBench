/**
 * Minimap tiles, served straight off `data/minimap/`.
 *
 * Two shapes, both under `/tiles/<mapId>/`:
 *
 * - `<row>_<col>.webp`, the native tile, one per ADT, written by the extraction
 *   in `minimap/` (`nativeServedName` in `worldmap.ts`);
 * - `<layer>/<z>/<row>_<col>.webp`, a level of the downsampled pyramid baked
 *   from those by the same tooling (`lodServedName` in `worldmap.ts` owns the
 *   spelling).
 *
 * The tile root holds two trees. The masters are what the extraction and the
 * bakes write, lossless PNG at `<map>/<row>_<col>.png` and
 * `<map>/<layer>/<z>/<row>_<col>.png`; the served tree under `SERVED_DIR` is
 * what `minimap/src/transcode.ts` derives from them — a WebP per tile and a
 * per-map `index.json`. A request is answered from the served tree when its
 * file is there and no older than its master, and from the master otherwise,
 * so a machine that baked but never transcoded still draws every tile, and a
 * re-bake shows before the next transcode. The content type is the served
 * bytes' own.
 *
 * Two older spellings still answer, for the builds and served trees from
 * before them, which a tab open across a release still holds:
 *
 * - a native asked for as `<row>_<col>.png`, which every client asks for
 *   while its map's index does not say `native: "webp"` (`tileindex.ts`), is
 *   the indexed PNG an older transcode left in the served tree, or the master;
 * - a pyramid tile asked for as `.png` is the master.
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

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TILE_INDEX_NAME } from "./tileindex";
import { ART_LAYER, GRID, LOD_LAYERS, LOD_MAX, type LodLayer, lodGrid, lodServedName, lodTileName, nativeServedName, tileName } from "./worldmap";

/** The served tree's directory under the tile root (`minimap/src/transcode.ts` writes it). */
export const SERVED_DIR = "web";

/** Tiles are immutable once extracted: cache them for a year. */
export const TILE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The art layer is the exception. Its look is tuned by re-baking it at the
 * same paths, so a year-long immutable copy would keep showing a painting the
 * bake has since replaced. It is stored but checked before every use: with
 * the ETag and Last-Modified the route sends beside it, an unchanged tile
 * costs a 304, and a re-bake shows on the next load.
 */
export const ART_TILE_CACHE_CONTROL = "public, no-cache";
export const ART_TILE_PUBLIC_CACHE_CONTROL = "private, no-cache";

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

const TILE_PATH = /^\/tiles\/(\d+)\/(\d+)_(\d+)\.(png|webp)$/;
const LOD_PATH = /^\/tiles\/(\d+)\/([a-z]+)\/(\d+)\/(\d+)_(\d+)\.(png|webp)$/;
const INDEX_PATH = /^\/tiles\/(\d+)\/index\.json$/;

export interface TileRef {
  map: number;
  row: number;
  col: number;
  /** The pyramid level, absent for a native tile. */
  lod?: { layer: LodLayer; z: number };
  /** A pyramid tile asked for under its master's `.png` name rather than the served `.webp`. */
  legacy?: true;
  /** A native tile asked for as `.webp` rather than the `.png` every build before the WebP natives asks for. */
  webp?: true;
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
    return { map, row, col, ...(native[4] === "webp" ? { webp: true as const } : {}) };
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
  return { map, row, col, lod: { layer, z }, ...(m[6] === "png" ? { legacy: true as const } : {}) };
}

/** A reference's master file, relative to the tile root — the one spelling the bake writes. */
function masterPath(ref: TileRef): string {
  const name = ref.lod === undefined ? tileName(ref.row, ref.col) : lodTileName(ref.lod.layer, ref.lod.z, ref.row, ref.col);
  return `${ref.map}/${name}`;
}

/**
 * A reference's served file, relative to `SERVED_DIR`: the spelling the
 * transcode writes, or for a native asked for as `.png`, the one an older
 * transcode wrote.
 */
export function servedPath(ref: TileRef): string {
  const name =
    ref.lod !== undefined
      ? lodServedName(ref.lod.layer, ref.lod.z, ref.row, ref.col)
      : ref.webp === true
        ? nativeServedName(ref.row, ref.col)
        : tileName(ref.row, ref.col);
  return `${ref.map}/${name}`;
}

/**
 * The canonical request path for a reference. A path that parses but is not
 * this (a leading zero, say) names the same file under a second spelling,
 * which is why the tile publisher keys only canonical ones.
 */
export function tileRefPath(ref: TileRef): string {
  return `/tiles/${ref.legacy === true ? masterPath(ref) : servedPath(ref)}`;
}

/** The media type of a tile or index file, by its extension. */
export function tileContentType(file: string): string {
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".json")) return "application/json";
  return "image/png";
}

function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The file a tile request names and what it is, or null if the path is
 * invalid or no such tile was extracted. The served file when it exists and
 * is no older than its master, the master otherwise (see the header). The
 * file path is built from the parsed integers and the layer list, not from
 * the request string.
 */
export function resolveTile(root: string, path: string): { file: string; ref: TileRef; contentType: string } | null {
  const ref = parseTilePath(path);
  if (ref === null) return null;
  const master = join(root, masterPath(ref));
  const masterAt = mtime(master);
  if (masterAt === null) return null;
  let file = master;
  if (ref.legacy !== true) {
    const served = join(root, SERVED_DIR, servedPath(ref));
    const servedAt = mtime(served);
    if (servedAt !== null && servedAt >= masterAt) file = served;
  }
  return { file, ref, contentType: tileContentType(file) };
}

/** The map an index request names, or null if the path is not one. */
export function parseTileIndexPath(path: string): number | null {
  const m = INDEX_PATH.exec(path);
  if (m === null) return null;
  const map = Number(m[1]!);
  return Number.isSafeInteger(map) && map >= 0 ? map : null;
}

/** An index's file, relative to `SERVED_DIR`. */
export function servedIndexPath(map: number): string {
  return `${map}/${TILE_INDEX_NAME}`;
}

/**
 * The index file a request names, or null when there is none or it is older
 * than the masters it describes. A bake writes through a temp file and a
 * rename, so every write moves its directory's mtime; an index older than any
 * of the map's master directories may be missing a tile the bake has since
 * added, and serving it would hide that tile. Null sends the page back to
 * asking for every cell, which is always correct.
 */
export function resolveTileIndex(root: string, path: string): string | null {
  const map = parseTileIndexPath(path);
  if (map === null) return null;
  const file = join(root, SERVED_DIR, servedIndexPath(map));
  const at = mtime(file);
  const newest = newestMasterDir(root, map);
  if (at === null || newest === null) return null;
  return at >= newest ? file : null;
}

/**
 * The latest mtime among a map's master directories — the map's own and
 * each layer's level directories — or null when the map has none. An index
 * is current when it is at least this new; the transcode keeps it so.
 */
export function newestMasterDir(root: string, map: number): number | null {
  const dir = join(root, String(map));
  let newest = mtime(dir);
  if (newest === null) return null;
  for (const layer of LOD_LAYERS) {
    let levels: string[] = [];
    try {
      levels = readdirSync(join(dir, layer));
    } catch {
      continue;
    }
    newest = Math.max(newest, mtime(join(dir, layer)) ?? 0);
    for (const z of levels) newest = Math.max(newest, mtime(join(dir, layer, z)) ?? 0);
  }
  return newest;
}

/** `resolveTile`'s file alone. */
export function resolveTilePath(root: string, path: string): string | null {
  return resolveTile(root, path)?.file ?? null;
}

/** Whether a tile is re-baked in place and so revalidated rather than cached for good. */
export function isRevalidatedTile(ref: TileRef): boolean {
  return ref.lod?.layer === ART_LAYER;
}

/**
 * Validators for a tile file, from its size and modification time. A bake
 * writes through a temp file and a rename, so a re-bake always moves the
 * mtime and with it the tag; reading the bytes to hash them on every request
 * would buy nothing more.
 */
export function tileValidators(stat: { size: number; mtimeMs: number }): { etag: string; lastModified: string } {
  return {
    etag: `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    lastModified: new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString(),
  };
}

/**
 * Whether a conditional request already holds the current tile. If-None-Match
 * wins over If-Modified-Since when both are sent, as RFC 9110 has it; tags
 * compare weakly, which is all a GET needs.
 */
export function tileNotModified(headers: Headers, v: { etag: string; lastModified: string }): boolean {
  const inm = headers.get("if-none-match");
  if (inm !== null) {
    const strip = (t: string): string => t.trim().replace(/^W\//, "");
    const want = strip(v.etag);
    return inm.split(",").some((t) => t.trim() === "*" || strip(t) === want);
  }
  const ims = headers.get("if-modified-since");
  if (ims === null) return false;
  const since = Date.parse(ims);
  return Number.isFinite(since) && Date.parse(v.lastModified) <= since;
}
