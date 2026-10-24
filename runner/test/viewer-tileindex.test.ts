/**
 * The per-map tile index the map page reads before it asks for a cell. What
 * matters is that a round trip loses nothing, that a reader never trusts a
 * malformed file (null means "ask for everything", which is always safe), and
 * that the same cells always give the same bytes, since the tile publisher
 * skips an unchanged index by its hash.
 */
import { describe, expect, test } from "bun:test";
import { buildTileIndex, indexCovers, indexHas, parseTileIndex, renderTileIndex } from "../viewer/tileindex";

describe("the tile index", () => {
  const cells = [
    { layer: "minimap" as const, z: 0, row: 43, col: 31 },
    { layer: "minimap" as const, z: 0, row: 0, col: 63 },
    { layer: "minimap" as const, z: 1, row: 21, col: 15 },
    { layer: "art" as const, z: 1, row: 21, col: 15 },
    { layer: "art" as const, z: 6, row: 0, col: 0 },
  ];
  const covers = [{ z: 1, row: 21, col: 15 }];

  test("round-trips every cell and nothing else", () => {
    const index = parseTileIndex(JSON.parse(renderTileIndex(buildTileIndex(cells, covers))))!;
    expect(index).not.toBeNull();
    for (const c of cells) expect(indexHas(index, c.layer, c.z, c.row, c.col)).toBe(true);
    expect(indexHas(index, "minimap", 0, 43, 30)).toBe(false);
    expect(indexHas(index, "minimap", 0, 44, 31)).toBe(false);
    expect(indexHas(index, "art", 2, 10, 7)).toBe(false);
    expect(indexHas(index, "minimap", 0, -1, 0)).toBe(false);
    expect(indexHas(index, "minimap", 0, 0, 64)).toBe(false);
    expect(indexCovers(index, 1, 21, 15)).toBe(true);
    expect(indexCovers(index, 1, 21, 14)).toBe(false);
    expect(indexCovers(index, 2, 10, 7)).toBe(false);
  });

  test("is one row of hex digits per grid row, and leaves out empty levels", () => {
    const index = buildTileIndex(cells, covers);
    expect(Object.keys(index.cells)).toEqual(["minimap/0", "minimap/1", "art/1", "art/6"]);
    expect(index.cells["minimap/0"]![43]).toBe("0000000100000000");
    expect(index.cells["minimap/0"]![0]).toBe("0000000000000001");
    expect(index.cells["art/6"]).toEqual(["8"]);
  });

  test("is deterministic whatever order the cells arrive in", () => {
    expect(renderTileIndex(buildTileIndex([...cells].reverse(), covers))).toBe(renderTileIndex(buildTileIndex(cells, covers)));
  });

  test("names the natives' format: WebP when it says so, PNG for anything else", () => {
    const webp = renderTileIndex(buildTileIndex(cells, covers, "webp"));
    expect(JSON.parse(webp)).toMatchObject({ version: 1, native: "webp" });
    expect(parseTileIndex(JSON.parse(webp))!.native).toBe("webp");
    // An index written before the field, and one naming a format nobody serves.
    const png = renderTileIndex(buildTileIndex(cells, covers));
    expect(png).not.toContain("native");
    expect(parseTileIndex(JSON.parse(png))!.native).toBe("png");
    expect(parseTileIndex({ ...JSON.parse(png), native: "avif" })!.native).toBe("png");
  });

  test("a WebP index still reads as an index to a client that predates the field", () => {
    // The parse every deployed build runs: version 1, the two grids, nothing
    // else asked about. Bumping the version would hand each of them a null
    // index and a request for every cell.
    const raw = JSON.parse(renderTileIndex(buildTileIndex(cells, covers, "webp"))) as Record<string, unknown>;
    expect(raw["version"]).toBe(1);
    const { native: _native, ...rest } = raw;
    expect(parseTileIndex(rest)).toEqual({ ...buildTileIndex(cells, covers), native: "png" });
  });

  test("anything malformed reads as no index at all", () => {
    const good = buildTileIndex(cells, covers);
    for (const bad of [
      null,
      "x",
      [],
      { ...good, version: 2 },
      { ...good, cells: { "terrain/1": good.cells["art/1"] } },
      { ...good, cells: { "minimap/7": ["0"] } },
      { ...good, cells: { "minimap/1": ["00000000"] } },
      { ...good, cells: { "minimap/6": ["g"] } },
      { ...good, covers: { "0": good.cells["minimap/0"] } },
    ]) {
      expect(parseTileIndex(bad)).toBeNull();
    }
  });
});
