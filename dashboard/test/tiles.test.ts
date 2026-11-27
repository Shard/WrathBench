/**
 * Whether a build may ask for a minimap tile, and from where.
 *
 * The app and the bucket are on two hostnames, so a relative `/tiles/...`
 * would ask a host that has none: a public build has to be told where the
 * tiles live, which is `VITE_WRATHBENCH_TILES_BASE`. That flag is separate from
 * the snapshot base on purpose — the tiles reach the bucket by a hand-run
 * `publish-tiles --upload` and never by a snapshot pass, so a JSON pass must
 * not assert they are there. This pins that a build told nothing asks for
 * nothing, that the private viewer is unaffected, and that the paths a build
 * asks for are the keys the publisher writes.
 */

import { describe, expect, test } from "bun:test";
import { lodServedName } from "../../viewer/worldmap";
import { buildTileIndex, parseTileIndex, renderTileIndex } from "../../viewer/tileindex";
import { levelTilePath, nativeFormat, tilePath, tileUrl, tileUrlFor } from "../src/lib/tiles";

const DATA = "https://data.example";

describe("where a tile comes from", () => {
  test("a snapshot build with no tiles base asks for nothing; the private viewer is same-origin; a named base wins", () => {
    // Setting the snapshot base must never be what turns tiles on.
    expect(tileUrl("", DATA, 0, 43, 31)).toBeNull();
    expect(tileUrlFor("", DATA, levelTilePath(1, "minimap", 3, 2, 5))).toBeNull();
    expect(tileUrl("", "", 0, 43, 31)).toBe("/tiles/0/43_31.png");
    expect(tileUrl(`${DATA}/`, DATA, 571, 12, 7)).toBe(`${DATA}/tiles/571/12_7.png`);
  });

  test("the key the publisher writes is the path a build asks for, level by level", () => {
    // infra/publish-tiles.ts keys objects `tiles/<map>/<row>_<col>.png`.
    expect(tilePath(0, 43, 31).slice(1)).toBe("tiles/0/43_31.png");
    expect(levelTilePath(0, "minimap", 0, 43, 31)).toBe(tilePath(0, 43, 31));
    expect(levelTilePath(0, "minimap", 1, 21, 15)).toBe(`/tiles/0/${lodServedName("minimap", 1, 21, 15)}`);
    expect(levelTilePath(1, "art", 6, 0, 0)).toBe(`/tiles/1/${lodServedName("art", 6, 0, 0)}`);
    // The art has no level 0: it never silently falls back to the minimap's native tile.
    expect(() => levelTilePath(0, "art", 0, 43, 31)).toThrow();
  });

  test("the natives' format is the index's: WebP where it says so, PNG for an older index or none", () => {
    const cells = [{ layer: "minimap" as const, z: 0, row: 43, col: 31 }];
    const index = (native?: "webp"): ReturnType<typeof parseTileIndex> => parseTileIndex(JSON.parse(renderTileIndex(buildTileIndex(cells, [], native))));
    expect(levelTilePath(0, "minimap", 0, 43, 31, nativeFormat(index("webp")))).toBe("/tiles/0/43_31.webp");
    expect(nativeFormat(index())).toBe("png");
    expect(nativeFormat(null)).toBe("png");
  });
});
