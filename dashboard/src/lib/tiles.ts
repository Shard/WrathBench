/**
 * Whether a minimap tile can be fetched at all, and if so from where.
 *
 * The private viewer serves `/tiles/<map>/<row>_<col>.png` off `data/minimap/`
 * (`runner/viewer/tiles.ts`), same-origin with the SPA. The Gated preview
 * served the SPA and the bucket from one Worker behind one password, so the
 * same relative path resolved there too and the map page could hard-code it.
 *
 * The Open shape (2026-09-11) ends both of those facts at once. The app is
 * `wrathbench.shard.page` and the data is `wrathbench-data.shard.page`, so a
 * relative path would ask a host that has no tiles; and there is no longer
 * anything in the read path able to keep a reader out, so publishing them would
 * make them world-readable. **Minimap tiles are Blizzard textures**
 * (`docs/DATA-AND-LEGAL.md`), and whether they go public is the operator's
 * decision and has not been taken. So the default in the public build is the
 * behaviour `WRATHBENCH_VIEWER_PUBLIC=1` already has: no tile is requested and
 * the map draws its labelled grid, which is a complete map view and not a
 * degraded one — it is what a lab machine that never ran the extraction draws.
 *
 * `VITE_WRATHBENCH_TILES_BASE` is the flip, and it is deliberately a *separate*
 * flag from `VITE_WRATHBENCH_SNAPSHOT_BASE` rather than being derived from it.
 * Deriving would mean that publishing the JSON published the textures, which is
 * exactly the coupling the decision is about. Set it to the host holding the
 * `tiles/` prefix — the data hostname, if the operator ever decides that — and
 * the map loads them; leave it unset, which is the default everywhere including
 * `infra/deploy-dashboard.sh`, and it does not.
 *
 * A cross-origin tile is fine for the canvas: it is only ever `drawImage`d,
 * never read back with `getImageData`/`toDataURL`, so the taint a cross-origin
 * image applies costs nothing and no `crossOrigin` attribute is set — which
 * would make every tile fail outright if a CORS policy were wrong, rather than
 * degrade to the grid.
 */

/**
 * The path a tile lives at, under whatever host serves it. The viewer's route
 * and the bucket's key share this shape by design, so one path works in both.
 */
export function tilePath(map: number, row: number, col: number): string {
  return `/tiles/${map}/${row}_${col}.png`;
}

/**
 * The URL for one tile, or `null` when this build must not ask for one.
 *
 * - `tilesBase` set: that host serves them, trailing slashes trimmed the way
 *   `createSnapshotClient` trims its own base.
 * - unset and `snapshotBase` set: the public build with no tiles decision —
 *   `null`, and the grid is drawn.
 * - both unset: the private viewer, same-origin.
 */
export function tileUrl(tilesBase: string, snapshotBase: string, map: number, row: number, col: number): string | null {
  const tiles = trim(tilesBase);
  if (tiles !== "") return `${tiles}${tilePath(map, row, col)}`;
  // Whether this is a public build is `client.ts`'s own test — the base
  // *trimmed of whitespace only*, so a bare `/` is a public build served from
  // its own origin and not a private one. Stripping the slash first would read
  // that as private and start requesting tiles.
  return snapshotBase.trim() === "" ? tilePath(map, row, col) : null;
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

/** True when this build draws the grid and asks for nothing. */
export const TILES_WITHHELD: boolean = tileUrl(BASES.tiles, BASES.snapshot, 0, 0, 0) === null;

/** What the map page calls. `null` means "draw the grid and make no request". */
export function tileSrc(map: number, row: number, col: number): string | null {
  return tileUrl(BASES.tiles, BASES.snapshot, map, row, col);
}
