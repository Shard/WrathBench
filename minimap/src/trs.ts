/**
 * Parser for `textures\Minimap\md5translate.trs`, the client's translation
 * table from readable minimap tile names to the hashed files that actually
 * live in the archives.
 *
 * Format: `dir: <MapDir>` starts a section; every following line is
 * `<name>\t<hash>.blp`, where `<name>` is usually `<MapDir>\mapX_Y.blp` but is
 * sometimes bare `mapX_Y.blp`.
 *
 * `mapX_Y`: X is the tile COLUMN and Y is the tile ROW — the same order ADT
 * files use. Verified empirically; see minimap/README.md.
 */

export interface TrsTile {
  col: number;
  row: number;
  /** Hashed file name as it appears in the trs, e.g. `abc123.blp`. */
  hash: string;
}

/** Lower-cased map directory name -> tiles. */
export type TrsIndex = Map<string, TrsTile[]>;

export function parseTrs(text: string): TrsIndex {
  const index: TrsIndex = new Map();
  let current: TrsTile[] | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    if (line.startsWith("dir: ")) {
      const dir = line.slice(5).trim().toLowerCase();
      current = index.get(dir);
      if (!current) {
        current = [];
        index.set(dir, current);
      }
      continue;
    }
    if (!current) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    const hash = line.slice(tab + 1).trim();
    const base = name.slice(name.lastIndexOf("\\") + 1);
    const m = /^map(\d+)_(\d+)\.blp$/i.exec(base);
    if (!m || !hash) continue;
    current.push({ col: Number(m[1]), row: Number(m[2]), hash });
  }
  return index;
}
