/**
 * WoW world coordinates → ADT/minimap tile grid, and back.
 *
 * This is one module on purpose: the live map and, later, the
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
 * growing column is east. The map-view decision required this to be verified against a
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

/** The file name convention the extraction writes and the tile route serves. */
export function tileName(row: number, col: number): string {
  return `${row}_${col}.png`;
}

/*
 * The downsampled pyramid over the native tiles. A level-z tile is still
 * `TILE_PX` square but covers 2^z × 2^z ADTs, so level `LOD_MAX` is the whole
 * 64×64 world in one tile. Level 0 is the native tile and keeps the path
 * `tileName` gives it under its map's directory; levels 1 and up live beside
 * it under a layer directory, `<layer>/<z>/<row>_<col>.png`.
 *
 * Two layers share those levels and that grid. `minimap` is the client's
 * minimap baked down from the native tiles. `art` is the painted world and
 * zone map stitched over the same grid, transparent where nothing is
 * painted; it has no level 0, so z1 (128 px per ADT) is its finest.
 *
 * The bake in `minimap/` writes these paths, the viewer's tile route serves
 * them, the tile publisher keys them and the dashboard requests them, all
 * through `lodTileName` — one spelling, so the four cannot drift apart.
 */

/** The coarsest pyramid level: one tile for the whole grid. */
export const LOD_MAX = 6;

/** The layers that carry a pyramid, by the directory each lives under. */
export const LOD_LAYERS = ["minimap", "art"] as const;
export type LodLayer = (typeof LOD_LAYERS)[number];

/** The layer the native tiles belong to: its level 0 is `tileName`. */
export const MINIMAP_LAYER: LodLayer = "minimap";

/** The painted map, levels 1..`LOD_MAX` only. */
export const ART_LAYER: LodLayer = "art";

/** Tiles per side at pyramid level `z` (64 at level 0, 1 at `LOD_MAX`). */
export function lodGrid(z: number): number {
  return GRID >> z;
}

/**
 * Where a pyramid tile lives, relative to its map's directory.
 *
 * Only levels 1..`LOD_MAX`, and throws on anything else, so nothing built on it
 * can write over or ask for a native tile under a pyramid name: level 0 is
 * `tileName` and only `tileName`.
 */
export function lodTileName(layer: LodLayer, z: number, row: number, col: number): string {
  if (!Number.isInteger(z) || z < 1 || z > LOD_MAX) throw new Error(`pyramid level ${z} is not 1..${LOD_MAX}`);
  const n = lodGrid(z);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= n || col >= n) {
    throw new Error(`tile ${row}_${col} is outside level ${z}'s ${n}×${n} grid`);
  }
  return `${layer}/${z}/${tileName(row, col)}`;
}

/**
 * The name a pyramid tile is *served* under: `lodTileName` with `.webp` for
 * `.png`. The bakes write lossless PNG masters at `lodTileName`; the
 * transcode in `minimap/src/transcode.ts` derives a WebP from each, and that
 * is what the viewer's route, the tile publisher's keys and the dashboard's
 * requests spell.
 */
export function lodServedName(layer: LodLayer, z: number, row: number, col: number): string {
  return `${lodTileName(layer, z, row, col).slice(0, -".png".length)}.webp`;
}

/**
 * The name a native tile is served under now: `tileName` with `.webp`. The
 * master keeps `tileName`, and so does the request a client makes when its
 * map's tile index does not say `native: "webp"` (`./tileindex.ts`) — a build
 * from before the WebP natives, or a served tree transcoded before them —
 * which the viewer answers from the master and the bucket from the `.png`
 * objects earlier passes left there.
 */
export function nativeServedName(row: number, col: number): string {
  return `${row}_${col}.webp`;
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

/**
 * Every map that has tiles, by id, with the name the map page shows for it.
 *
 * One table for both ends on purpose. The extractor's default list is its
 * keys (`minimap/src/extract.ts`) and the dashboard's `mapName` reads it, so a
 * map cannot be drawn under a bare number or named over a blank lattice.
 * Anything not listed keeps its number: an id is still the server's answer,
 * and a guessed name would not be.
 *
 * The four continents and the Deeprun Tram, then every dungeon and raid in
 * Map.dbc (instance type 1 or 2) that the client has a minimap for, named as
 * Map.dbc names it (the Deadmines keeps the "The" it was first given). Left
 * out: the two maps Map.dbc itself marks unused (44, the old Monastery, and
 * 598, a Sunwell fix), the Emerald Dream test map (169), and the three the
 * client has no minimap for at all, neither terrain nor a model's own (624
 * Vault of Archavon, 649 Trial of the Crusader, 650 Trial of the Champion).
 */
export const TILED_MAPS: Readonly<Record<number, string>> = {
  0: "Eastern Kingdoms",
  1: "Kalimdor",
  369: "Deeprun Tram",
  530: "Outland",
  571: "Northrend",
  // Dungeons.
  33: "Shadowfang Keep",
  34: "Stormwind Stockade",
  36: "The Deadmines",
  43: "Wailing Caverns",
  47: "Razorfen Kraul",
  48: "Blackfathom Deeps",
  70: "Uldaman",
  90: "Gnomeregan",
  109: "Sunken Temple",
  129: "Razorfen Downs",
  189: "Scarlet Monastery",
  209: "Zul'Farrak",
  229: "Blackrock Spire",
  230: "Blackrock Depths",
  269: "Opening of the Dark Portal",
  289: "Scholomance",
  329: "Stratholme",
  349: "Maraudon",
  389: "Ragefire Chasm",
  429: "Dire Maul",
  540: "Hellfire Citadel: The Shattered Halls",
  542: "Hellfire Citadel: The Blood Furnace",
  543: "Hellfire Citadel: Ramparts",
  545: "Coilfang: The Steamvault",
  546: "Coilfang: The Underbog",
  547: "Coilfang: The Slave Pens",
  552: "Tempest Keep: The Arcatraz",
  553: "Tempest Keep: The Botanica",
  554: "Tempest Keep: The Mechanar",
  555: "Auchindoun: Shadow Labyrinth",
  556: "Auchindoun: Sethekk Halls",
  557: "Auchindoun: Mana-Tombs",
  558: "Auchindoun: Auchenai Crypts",
  560: "The Escape From Durnholde",
  574: "Utgarde Keep",
  575: "Utgarde Pinnacle",
  576: "The Nexus",
  578: "The Oculus",
  585: "Magister's Terrace",
  595: "The Culling of Stratholme",
  599: "Halls of Stone",
  600: "Drak'Tharon Keep",
  601: "Azjol-Nerub",
  602: "Halls of Lightning",
  604: "Gundrak",
  608: "Violet Hold",
  619: "Ahn'kahet: The Old Kingdom",
  632: "The Forge of Souls",
  658: "Pit of Saron",
  668: "Halls of Reflection",
  // Raids.
  249: "Onyxia's Lair",
  309: "Zul'Gurub",
  409: "Molten Core",
  469: "Blackwing Lair",
  509: "Ruins of Ahn'Qiraj",
  531: "Ahn'Qiraj Temple",
  532: "Karazhan",
  533: "Naxxramas",
  534: "The Battle for Mount Hyjal",
  544: "Magtheridon's Lair",
  548: "Coilfang: Serpentshrine Cavern",
  550: "Tempest Keep",
  564: "Black Temple",
  565: "Gruul's Lair",
  568: "Zul'Aman",
  580: "The Sunwell",
  603: "Ulduar",
  615: "The Obsidian Sanctum",
  616: "The Eye of Eternity",
  631: "Icecrown Citadel",
  724: "The Ruby Sanctum",
};

/** The maps `TILED_MAPS` lists, in id order. */
export function tiledMapIds(): number[] {
  return Object.keys(TILED_MAPS)
    .map(Number)
    .sort((a, b) => a - b);
}
