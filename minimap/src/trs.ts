/**
 * Parser for `textures\Minimap\md5translate.trs`, the client's translation
 * table from readable minimap tile names to the hashed files that actually
 * live in the archives.
 *
 * Format: `dir: <MapDir>` starts a section; every following line is
 * `<name>\t<hash>.blp`, where `<name>` is usually `<MapDir>\<tile>.blp` but is
 * sometimes bare `<tile>.blp`.
 *
 * Two kinds of section live in the same file and this module reads both:
 *
 * - **ADT sections**, keyed by a map's internal directory (`Azeroth`), whose
 *   tiles are `map<X>_<Y>.blp`. X is the tile COLUMN and Y is the tile ROW —
 *   the same order ADT files use. Verified empirically; see minimap/README.md.
 * - **WMO sections**, keyed by a *model* directory (`WMO\Dungeon\AZ_Subway`),
 *   whose tiles are `<Model>_<group>_<a>_<b>.blp`. These are how a map with no
 *   terrain — the Deeprun Tram is the one we extract — has a minimap at all.
 *   `wmo.ts` explains what the three numbers mean and where they land.
 */

export interface TrsTile {
  col: number;
  row: number;
  /** Hashed file name as it appears in the trs, e.g. `abc123.blp`. */
  hash: string;
}

/** One tile of one group of a WMO's minimap. */
export interface TrsWmoTile {
  /** Index into the model's group list, i.e. into `parseWmoGroupBoxes`. */
  group: number;
  /** Tile index along the group image's first axis. */
  a: number;
  /** Tile index along its second axis. */
  b: number;
  hash: string;
}

/** Lower-cased map directory name -> tiles. */
export type TrsIndex = Map<string, TrsTile[]>;

/** Lower-cased model directory name -> tiles. */
export type TrsWmoIndex = Map<string, TrsWmoTile[]>;

/**
 * Walk the file once, handing every tile line to `visit` with its section.
 *
 * Shared so the two parsers cannot drift on what counts as a section header or
 * a tile line — the only thing they disagree about is the shape of the name.
 */
function eachTile(text: string, visit: (dir: string, base: string, hash: string) => void): void {
  let dir: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    if (line.startsWith("dir: ")) {
      dir = line.slice(5).trim().toLowerCase();
      continue;
    }
    if (dir === null) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    const hash = line.slice(tab + 1).trim();
    if (hash.length === 0) continue;
    visit(dir, name.slice(name.lastIndexOf("\\") + 1), hash);
  }
}

function push<T>(index: Map<string, T[]>, dir: string, tile: T): void {
  const existing = index.get(dir);
  if (existing === undefined) index.set(dir, [tile]);
  else existing.push(tile);
}

export function parseTrs(text: string): TrsIndex {
  const index: TrsIndex = new Map();
  eachTile(text, (dir, base, hash) => {
    const m = /^map(\d+)_(\d+)\.blp$/i.exec(base);
    if (m) push(index, dir, { col: Number(m[1]), row: Number(m[2]), hash });
  });
  return index;
}

/**
 * The WMO half of the same file.
 *
 * The name pattern is deliberately anchored on *three* trailing numbers so an
 * ADT tile (`map31_43.blp`, two) can never be read as a group tile, whatever
 * section it turns up in.
 */
export function parseWmoTrs(text: string): TrsWmoIndex {
  const index: TrsWmoIndex = new Map();
  eachTile(text, (dir, base, hash) => {
    const m = /^.+_(\d+)_(\d+)_(\d+)\.blp$/i.exec(base);
    if (m) push(index, dir, { group: Number(m[1]), a: Number(m[2]), b: Number(m[3]), hash });
  });
  return index;
}
