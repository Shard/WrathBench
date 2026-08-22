/**
 * WoW world coordinates → ADT/minimap tile grid, and back.
 *
 * ADR-0019 makes this one module on purpose: the live map and, later, the
 * replay view both draw through it, and the tile extraction writes files named
 * by what it returns. It has **no imports** — that is deliberate and is what
 * the standalone-import test pins. Nothing here reads a run, a database, or a
 * clock; feed it numbers, get numbers.
 *
 * The world is a 64×64 grid of ADTs, each 533.33325 yards square, with the
 * origin at the centre (tile 32,32). World X runs north and world Y runs west,
 * both decreasing as the tile index grows — hence the subtraction:
 *
 *     tile = 32 − coord / 533.33325
 *
 * World X gives the tile **row**, world Y the tile **column**. Anvilmar
 * (map 0, x ≈ -6240, y ≈ 380) lands at row 43.70, col 31.29.
 */

/** Yards per ADT tile. The client's constant, not a rounding of it. */
export const TILE_SIZE = 533.33325;

/** Tiles per side of the world grid. */
export const GRID = 64;

/** Native minimap tile resolution, in pixels. One PNG per ADT. */
export const TILE_PX = 256;

/** Fractional tile coordinates: integer part names the tile, fraction the spot in it. */
export interface TilePoint {
  row: number;
  col: number;
}

/** Pixel coordinates in the full-world image (row-major, `TILE_PX` per tile). */
export interface PixelPoint {
  px: number;
  py: number;
}

/** One axis of the transform: world yards → fractional tile index. */
export function coordToTile(coord: number): number {
  return 32 - coord / TILE_SIZE;
}

/** The inverse: fractional tile index → world yards. */
export function tileToCoord(tile: number): number {
  return (32 - tile) * TILE_SIZE;
}

/** World (x, y) → fractional tile (row, col). */
export function worldToTile(x: number, y: number): TilePoint {
  return { row: coordToTile(x), col: coordToTile(y) };
}

/** Fractional tile (row, col) → world (x, y). */
export function tileToWorld(row: number, col: number): { x: number; y: number } {
  return { x: tileToCoord(row), y: tileToCoord(col) };
}

/**
 * World (x, y) → pixels in the unzoomed world image.
 *
 * Rows stack downward (screen Y) and columns run rightward (screen X): the
 * minimap tiles are stored north-up and west-left, so growing row is south and
 * growing column is east. ADR-0019 required this to be verified against a
 * rendered known zone before it was trusted: the extraction did that (see
 * `minimap/README.md`) and the tiles agree, so this stands as written.
 */
export function worldToPixel(x: number, y: number): PixelPoint {
  const t = worldToTile(x, y);
  return { px: t.col * TILE_PX, py: t.row * TILE_PX };
}

/** The inverse of `worldToPixel`. */
export function pixelToWorld(px: number, py: number): { x: number; y: number } {
  return tileToWorld(py / TILE_PX, px / TILE_PX);
}

/** Whether a tile index pair addresses a tile that could exist on disk. */
export function isTileInGrid(row: number, col: number): boolean {
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < GRID && col >= 0 && col < GRID;
}

/** The file name convention the extraction writes and the tile route serves. */
export function tileName(row: number, col: number): string {
  return `${row}_${col}.png`;
}

/**
 * The inclusive tile range covering a pixel rectangle, clamped to the grid.
 *
 * The renderer asks this what to fetch so a zoomed-out view never requests the
 * whole 64×64 pyramid, and a panned-off-world view never requests tile −3.
 */
export function visibleTiles(
  px0: number,
  py0: number,
  px1: number,
  py1: number,
): { row0: number; col0: number; row1: number; col1: number } {
  const clamp = (v: number): number => Math.min(GRID - 1, Math.max(0, v));
  return {
    row0: clamp(Math.floor(py0 / TILE_PX)),
    col0: clamp(Math.floor(px0 / TILE_PX)),
    row1: clamp(Math.floor(py1 / TILE_PX)),
    col1: clamp(Math.floor(px1 / TILE_PX)),
  };
}
