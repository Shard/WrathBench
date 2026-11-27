/**
 * The per-map tile index: which cells of each layer and level exist, and
 * where the painted art hides the minimap entirely.
 *
 * `minimap/src/transcode.ts` writes one per map beside the served tiles
 * (`<map>/index.json`), the viewer serves it at `/tiles/<map>/index.json`, the
 * tile publisher uploads it under the same key, and the map page reads it so
 * that it never asks for a cell that does not exist — before it, every absent
 * cell in view was a 404 per pan — and skips the minimap wherever the art
 * covers it at full strength.
 *
 * A level's cells are a bitmap: one hex string per row, one bit per column,
 * most significant bit first, so `jq` shows the grid's shape. A level with no
 * cells is left out. `covers` holds, per level z >= 1, the cells where the art
 * tile is opaque over every pixel the minimap tile at the same cell paints:
 * there the minimap cannot show through, so a frame that gives it no weight
 * need not fetch it.
 *
 * Shared with the dashboard (the `@viewer` alias), so it imports nothing but
 * the grid's own arithmetic.
 */

import { LOD_LAYERS, LOD_MAX, type LodLayer, lodGrid } from "./worldmap";

/** The file name, under a map's directory in the served tree and under `/tiles/<map>/`. */
export const TILE_INDEX_NAME = "index.json";

/**
 * What a map's native tiles are served as. `png` is every index written
 * before the natives moved to WebP, which says nothing; `webp` is written as
 * `"native": "webp"`. The version stays 1 on purpose: a deployed client
 * parses the new index, ignores the field it does not know and keeps asking
 * for `.png`, which the viewer and the bucket both still answer.
 */
export type NativeFormat = "png" | "webp";

export interface TileIndex {
  version: 1;
  native: NativeFormat;
  /** `<layer>/<z>` -> one hex row per grid row. The native tiles are `minimap/0`. */
  cells: Record<string, string[]>;
  /** `<z>` -> one hex row per grid row: art opaque over the minimap's paint there. */
  covers: Record<string, string[]>;
}

/** A cell, in the index's terms. */
export interface IndexCell {
  layer: LodLayer;
  z: number;
  row: number;
  col: number;
}

function levelKey(layer: LodLayer, z: number): string {
  return `${layer}/${z}`;
}

function bitmap(n: number, cells: Iterable<{ row: number; col: number }>): string[] {
  const digits = Math.ceil(n / 4);
  const grid = Array.from({ length: n }, () => new Uint8Array(digits));
  for (const { row, col } of cells) {
    if (row < 0 || col < 0 || row >= n || col >= n) throw new Error(`cell ${row}_${col} is outside a ${n}x${n} grid`);
    const r = grid[row] as Uint8Array;
    r[col >> 2] = (r[col >> 2] as number) | (8 >> (col & 3));
  }
  return grid.map((r) => Array.from(r, (d) => d.toString(16)).join(""));
}

function bit(rows: string[] | undefined, row: number, col: number): boolean {
  const digit = col < 0 ? undefined : rows?.[row]?.[col >> 2];
  return digit !== undefined && (Number.parseInt(digit, 16) & (8 >> (col & 3))) !== 0;
}

/** Build an index. Deterministic: the same cells always give the same JSON. */
export function buildTileIndex(
  cells: readonly IndexCell[],
  covers: readonly { z: number; row: number; col: number }[],
  native: NativeFormat = "png",
): TileIndex {
  const byLevel = new Map<string, { z: number; cells: { row: number; col: number }[] }>();
  for (const c of cells) {
    const key = levelKey(c.layer, c.z);
    const at = byLevel.get(key) ?? { z: c.z, cells: [] };
    at.cells.push(c);
    byLevel.set(key, at);
  }
  const out: TileIndex = { version: 1, native, cells: {}, covers: {} };
  for (const layer of LOD_LAYERS) {
    for (let z = 0; z <= LOD_MAX; z++) {
      const at = byLevel.get(levelKey(layer, z));
      if (at !== undefined) out.cells[levelKey(layer, z)] = bitmap(lodGrid(z), at.cells);
    }
  }
  for (let z = 1; z <= LOD_MAX; z++) {
    const at = covers.filter((c) => c.z === z);
    if (at.length > 0) out.covers[String(z)] = bitmap(lodGrid(z), at);
  }
  return out;
}

/**
 * The index as the file holds it: one line, so a re-run that changed nothing
 * writes the same bytes. A `png` index is written without the field, exactly
 * as indexes were before it existed.
 */
export function renderTileIndex(index: TileIndex): string {
  const { native, ...rest } = index;
  return `${JSON.stringify(native === "png" ? rest : { version: rest.version, native, cells: rest.cells, covers: rest.covers })}\n`;
}

/**
 * Read an index from whatever was fetched, or null if it is not one. Null is
 * the safe answer: a page with no index asks for every cell, as it did before
 * indexes existed.
 */
export function parseTileIndex(raw: unknown): TileIndex | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r["version"] !== 1) return null;
  const grids = (v: unknown, key: (k: string) => number | null): Record<string, string[]> | null => {
    if (v === null || typeof v !== "object") return null;
    const out: Record<string, string[]> = {};
    for (const [k, rows] of Object.entries(v as Record<string, unknown>)) {
      const z = key(k);
      if (z === null) return null;
      const n = lodGrid(z);
      const hex = new RegExp(`^[0-9a-f]{${Math.ceil(n / 4)}}$`);
      if (!Array.isArray(rows) || rows.length !== n || !rows.every((s) => typeof s === "string" && hex.test(s))) return null;
      out[k] = rows as string[];
    }
    return out;
  };
  const level = (z: string): number | null => (/^\d$/.test(z) && Number(z) <= LOD_MAX ? Number(z) : null);
  const cells = grids(r["cells"], (k) => {
    const [layer, z, ...rest] = k.split("/");
    if (rest.length > 0 || !LOD_LAYERS.some((l) => l === layer) || z === undefined) return null;
    return level(z);
  });
  const covers = grids(r["covers"], (k) => ((level(k) ?? 0) >= 1 ? level(k) : null));
  if (cells === null || covers === null) return null;
  // Anything but a known "webp" is the format every server still answers.
  return { version: 1, native: r["native"] === "webp" ? "webp" : "png", cells, covers };
}

/** Whether a tile exists at that cell. */
export function indexHas(index: TileIndex, layer: LodLayer, z: number, row: number, col: number): boolean {
  return bit(index.cells[levelKey(layer, z)], row, col);
}

/** Whether the art at that cell hides every pixel of the minimap tile there. */
export function indexCovers(index: TileIndex, z: number, row: number, col: number): boolean {
  return bit(index.covers[String(z)], row, col);
}
