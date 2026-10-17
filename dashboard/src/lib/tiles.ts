/**
 * Whether a minimap tile can be fetched at all, and if so from where.
 *
 * The private viewer serves `/tiles/<map>/<row>_<col>.png`, and the baked
 * pyramid levels of each layer under `/tiles/<map>/<layer>/<z>/` (`minimap`,
 * `art`), off `data/minimap/`
 * (`runner/viewer/tiles.ts`), same-origin with the SPA. The Gated preview
 * served the SPA and the bucket from one Worker behind one password, so the
 * same relative path resolved there too and the map page could hard-code it.
 *
 * The Open shape ends the second of those facts. The app is
 * `wrathbench.shard.page` and the data is `wrathbench-data.shard.page`, so a
 * relative path would ask a host that has no tiles: the public build has to be
 * told where they live. That the public site shows real minimap tiles is the
 * operator's settled decision, and the Open shape does not reopen it — see
 * `docs/DATA-AND-LEGAL.md`.
 *
 * `VITE_WRATHBENCH_TILES_BASE` names that host, and it is deliberately a
 * *separate* flag from `VITE_WRATHBENCH_SNAPSHOT_BASE` rather than being
 * derived from it, because the tiles get into the bucket by a different route:
 * the snapshot loop uploads JSON on a timer and never a tile, and
 * `infra/publish-tiles.ts --upload` is an occasional hand-run act against a
 * checkout that has `data/minimap` populated. Deriving one flag from the other
 * would have a JSON pass assert that tiles are there — so a lab machine that
 * publishes the record but never ran the extraction would build a site asking
 * for textures nobody uploaded.
 *
 * Unset is therefore a real state and not a broken one: no tile is requested
 * and the map draws its labelled grid, which is a complete map view. It is what
 * `WRATHBENCH_VIEWER_PUBLIC=1` already makes the private viewer do, and what a
 * machine without the extraction draws.
 *
 * A cross-origin tile is fine for the canvas: it is only ever `drawImage`d,
 * never read back with `getImageData`/`toDataURL`, so the taint a cross-origin
 * image applies costs nothing and no `crossOrigin` attribute is set — which
 * would make every tile fail outright if a CORS policy were wrong, rather than
 * degrade to the grid.
 */

import { type LodLayer, MINIMAP_LAYER, lodTileName } from "@viewer/worldmap";

/**
 * The path a native tile lives at, under whatever host serves it. The viewer's
 * route and the bucket's key share this shape by design, so one path works in
 * both.
 */
export function tilePath(map: number, row: number, col: number): string {
  return `/tiles/${map}/${row}_${col}.png`;
}

/**
 * The path of a tile at any level of a layer's pyramid. The minimap's level 0
 * is the native tile at its original path; every other level is spelled by
 * `lodTileName`, the one function the bake, the viewer and the publisher also
 * call — which throws for level 0 of any other layer rather than guess.
 */
export function levelTilePath(map: number, layer: LodLayer, z: number, row: number, col: number): string {
  if (z === 0 && layer === MINIMAP_LAYER) return tilePath(map, row, col);
  return `/tiles/${map}/${lodTileName(layer, z, row, col)}`;
}

/**
 * The URL for a tile path, or `null` when this build must not ask for one.
 *
 * - `tilesBase` set: that host serves them, trailing slashes trimmed the way
 *   `createSnapshotClient` trims its own base.
 * - unset and `snapshotBase` set: a public build that was given no tile host —
 *   `null`, and the grid is drawn.
 * - both unset: the private viewer, same-origin.
 */
export function tileUrlFor(tilesBase: string, snapshotBase: string, path: string): string | null {
  const tiles = trim(tilesBase);
  if (tiles !== "") return `${tiles}${path}`;
  // Whether this is a public build is `client.ts`'s own test — the base
  // *trimmed of whitespace only*, so a bare `/` is a public build served from
  // its own origin and not a private one. Stripping the slash first would read
  // that as private and start requesting tiles.
  return snapshotBase.trim() === "" ? path : null;
}

/** `tileUrlFor` a native tile. */
export function tileUrl(tilesBase: string, snapshotBase: string, map: number, row: number, col: number): string | null {
  return tileUrlFor(tilesBase, snapshotBase, tilePath(map, row, col));
}

function trim(s: string): string {
  return s.trim().replace(/\/+$/, "");
}

/**
 * The build's two bases, read the way `repo.ts` reads its flag: build-time envs
 * and not runtime probes, so one flag produces one bundle and the unset case
 * dead-code-eliminates behind a constant.
 */
export function tileBasesFromEnv(env: Record<string, unknown>): { tiles: string; snapshot: string } {
  const read = (name: string): string => {
    const v = env[name];
    return typeof v === "string" ? trim(v) : "";
  };
  return { tiles: read("VITE_WRATHBENCH_TILES_BASE"), snapshot: read("VITE_WRATHBENCH_SNAPSHOT_BASE") };
}

const BASES = tileBasesFromEnv(import.meta.env as unknown as Record<string, unknown>);

/** True when no tile base is configured: this build draws the grid and asks for nothing. */
export const NO_TILE_BASE: boolean = tileUrl(BASES.tiles, BASES.snapshot, 0, 0, 0) === null;

/**
 * What the map page calls, for a tile at any level of a layer. `null` means
 * "draw the grid and make no request".
 */
export function tileSrc(map: number, layer: LodLayer, z: number, row: number, col: number): string | null {
  return tileUrlFor(BASES.tiles, BASES.snapshot, levelTilePath(map, layer, z, row, col));
}
