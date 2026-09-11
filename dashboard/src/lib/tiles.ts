/**
 * Where a minimap tile is fetched from — which is not the same host in both
 * builds, and was not always two hosts at all.
 *
 * The private viewer serves `/tiles/<map>/<row>_<col>.png` off
 * `data/minimap/` (`runner/viewer/tiles.ts`), same-origin with the SPA. The
 * Gated preview served the SPA and the bucket from one Worker, so the same
 * relative path resolved there too, and the map page could hard-code it.
 *
 * The Open shape (2026-09-11) splits the two: the app is
 * `wrathbench.shard.page` and the data is `wrathbench-data.shard.page`, the R2
 * bucket behind its own custom domain, with the tiles under the same `tiles/`
 * prefix `infra/publish-tiles.ts` writes. A relative `/tiles/...` would ask the
 * app hostname, where there is nothing but the built SPA — every tile would
 * 404 and the map would silently fall back to labelled grid squares, which is
 * exactly the failure a reader cannot tell from "the extraction has not been
 * run". So the URL is built from the same build-time base the snapshot client
 * reads, in one place, with the private build's empty base leaving it relative.
 *
 * A cross-origin tile is fine for the canvas: it is only ever `drawImage`d,
 * never read back with `getImageData`/`toDataURL`, so the taint that a
 * cross-origin image applies costs nothing and no `crossOrigin` attribute is
 * set (which would make every tile fail outright if the bucket's CORS policy
 * were ever wrong, rather than degrade to the grid).
 */

/**
 * The path a tile lives at, under whatever host serves it. The viewer's route
 * and the bucket's key share this shape by design, so the SPA asks for one
 * thing in every shape.
 */
export function tilePath(map: number, row: number, col: number): string {
  return `/tiles/${map}/${row}_${col}.png`;
}

/**
 * A tile URL against a snapshot base.
 *
 * `base` is `VITE_WRATHBENCH_SNAPSHOT_BASE` as the client reads it: empty in
 * the private build (same-origin), a bare `/` in the one-origin shape the
 * Gated preview used, and an absolute origin in the Open one. Trailing slashes
 * are trimmed the way `createSnapshotClient` trims them, so all three collapse
 * to one join rule.
 */
export function tileUrl(base: string, map: number, row: number, col: number): string {
  return `${base.trim().replace(/\/+$/, "")}${tilePath(map, row, col)}`;
}

/**
 * The build's base, read the way `repo.ts` reads its flag: a build-time env and
 * not a runtime probe, so one flag produces one bundle.
 */
export function tileBaseFromEnv(env: Record<string, unknown>): string {
  const configured = env["VITE_WRATHBENCH_SNAPSHOT_BASE"];
  return typeof configured === "string" ? configured.trim().replace(/\/+$/, "") : "";
}

/** This build's tile base: "" in the private viewer, the data host in the public one. */
export const TILE_BASE: string = tileBaseFromEnv(import.meta.env as unknown as Record<string, unknown>);

/** What the map page calls. */
export function tileSrc(map: number, row: number, col: number): string {
  return tileUrl(TILE_BASE, map, row, col);
}
