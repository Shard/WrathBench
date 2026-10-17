/**
 * The tile publisher's two jobs: read nothing but tiles out of `data/minimap`,
 * and upload nothing a re-run does not have to. Both are asserted against a
 * temp directory and a fake bucket, so this suite is green from a bare clone
 * with no `data/`.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePng } from "../minimap/src/png";
import { bakeMap } from "../minimap/src/bake";
import { parseTilePath, resolveTilePath } from "../runner/viewer/tiles";
import { MINIMAP_LAYER, TILE_PX } from "../runner/viewer/worldmap";
import { levelTilePath } from "../dashboard/src/lib/tiles";
import {
  TILE_MANIFEST_KEY,
  TILE_PREFIX,
  parseTileManifest,
  planTileUploads,
  publishTiles,
  renderTileManifest,
  scanTiles,
  type TileStore,
} from "./publish-tiles";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

function root(files: Record<string, string>): string {
  const dir = tempDir("wb-tiles-");
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

interface Fake extends TileStore {
  objects: Map<string, { body: string; contentType: string }>;
  puts: string[];
}

function fakeStore(seed: Record<string, string> = {}): Fake {
  const objects = new Map<string, { body: string; contentType: string }>();
  for (const [k, v] of Object.entries(seed)) objects.set(k, { body: v, contentType: "application/json" });
  const puts: string[] = [];
  return {
    objects,
    puts,
    async put(key, body, contentType) {
      puts.push(key);
      objects.set(key, { body: new TextDecoder().decode(body), contentType });
    },
    async putText(key, body, contentType) {
      puts.push(key);
      objects.set(key, { body, contentType });
    },
    async getText(key) {
      return objects.get(key)?.body ?? null;
    },
  };
}

describe("scanTiles", () => {
  test("finds tiles under integer map directories and keys them as the viewer's path", () => {
    const dir = root({
      "0/43_31.png": "a",
      "0/44_31.png": "b",
      "571/10_20.png": "c",
    });
    expect(scanTiles(dir).map((t) => t.key)).toEqual([
      `${TILE_PREFIX}0/43_31.png`,
      `${TILE_PREFIX}0/44_31.png`,
      `${TILE_PREFIX}571/10_20.png`,
    ]);
  });

  test("reads nothing that is not a tile — no notes, no logs, no half-written temp files", () => {
    const dir = root({
      "0/43_31.png": "a",
      "0/README.md": "notes",
      "0/43_31.png.tmp": "half",
      "0/-1_0.png": "no",
      "0/43_31.jpg": "no",
      "notes/thing.png": "no",
      "index.json": "no",
    });
    expect(scanTiles(dir).map((t) => t.key)).toEqual([`${TILE_PREFIX}0/43_31.png`]);
  });

  test("finds the baked pyramid levels under each listed layer, keyed as the viewer's path", () => {
    const dir = root({
      "0/43_31.png": "a",
      "0/minimap/1/21_15.png": "b",
      "0/minimap/6/0_0.png": "c",
      "571/minimap/3/2_5.png": "d",
    });
    expect(scanTiles(dir).map((t) => t.key)).toEqual([
      `${TILE_PREFIX}0/43_31.png`,
      `${TILE_PREFIX}0/minimap/1/21_15.png`,
      `${TILE_PREFIX}0/minimap/6/0_0.png`,
      `${TILE_PREFIX}571/minimap/3/2_5.png`,
    ]);
  });

  test("uploads nothing the viewer would not serve under that exact name", () => {
    const dir = root({
      "0/minimap/1/21_15.png": "ok",
      "0/minimap/1/32_0.png": "row outside level 1's 32x32 grid",
      "0/minimap/6/0_1.png": "level 6 is one tile",
      "0/minimap/7/0_0.png": "no level 7",
      "0/minimap/0/43_31.png": "level 0 is the native path only",
      "0/minimap/1/21_15.png.tmp": "half-written",
      "0/minimap/1/021_15.png": "a second spelling",
      "0/minimap/01/21_15.png": "a second spelling",
      "0/minimap/notes.txt": "no",
      "0/art/1/0_0.png": "not a layer the viewer serves",
      "0/64_0.png": "outside the world grid",
      "0/043_31.png": "a second spelling",
      "007/43_31.png": "a second spelling of map 7",
    });
    expect(scanTiles(dir).map((t) => t.key)).toEqual([`${TILE_PREFIX}0/minimap/1/21_15.png`]);
  });

  test("a machine that never ran the extraction scans empty rather than throwing", () => {
    expect(scanTiles(join(tmpdir(), "wb-tiles-does-not-exist"))).toEqual([]);
  });
});

/*
 * The four places that know a pyramid tile's path — the bake that writes it,
 * this script that keys it, the viewer that serves it and the dashboard that
 * asks for it — checked against each other on one baked fixture rather than
 * each against its own copy of the shape.
 */
describe("one path from the bake to the browser", () => {
  test("every tile the bake writes is keyed, served and requested at the same path", () => {
    const dir = tempDir("wb-tiles-bake-");
    const opaque = new Uint8Array(TILE_PX * TILE_PX * 4).fill(255);
    mkdirSync(join(dir, "0"), { recursive: true });
    writeFileSync(join(dir, "0", "43_31.png"), encodePng(opaque, TILE_PX, TILE_PX));
    writeFileSync(join(dir, "0", "48_32.png"), encodePng(opaque, TILE_PX, TILE_PX));
    const written = bakeMap(join(dir, "0"), { force: false }).reduce((n, l) => n + l.written, 0);

    const tiles = scanTiles(dir);
    const levels = tiles.filter((t) => t.key.includes(`/${MINIMAP_LAYER}/`));
    expect(levels.length).toBe(written);
    expect(tiles.length).toBe(written + 2);
    for (const t of tiles) {
      const path = `/${t.key}`;
      expect(resolveTilePath(dir, path)).toBe(t.file);
      const ref = parseTilePath(path)!;
      expect(levelTilePath(ref.map, ref.lod?.layer ?? MINIMAP_LAYER, ref.lod?.z ?? 0, ref.row, ref.col)).toBe(path);
    }
  });
});

describe("the manifest", () => {
  test("round-trips, and refuses keys outside the tile prefix", () => {
    const json = renderTileManifest({ [`${TILE_PREFIX}0/1_2.png`]: "hash" }, 5);
    expect(parseTileManifest(json)).toEqual({ [`${TILE_PREFIX}0/1_2.png`]: "hash" });
    expect(parseTileManifest(JSON.stringify({ tiles: { "v1/manifest.json": "hash" } }))).toEqual({});
  });

  test("a missing or unreadable manifest is an empty one, not a failure", () => {
    expect(parseTileManifest(null)).toEqual({});
    expect(parseTileManifest("{{{")).toEqual({});
    expect(parseTileManifest("[]")).toEqual({});
  });
});

describe("planTileUploads", () => {
  const tile = (key: string) => ({ key, file: `/x/${key}`, size: 10 });

  test("a matching hash is skipped, a differing one is not, and an unknown key uploads", () => {
    const local = [tile("tiles/0/1_1.png"), tile("tiles/0/1_2.png"), tile("tiles/0/1_3.png")];
    const hashes = new Map([
      ["tiles/0/1_1.png", "same"],
      ["tiles/0/1_2.png", "new"],
      ["tiles/0/1_3.png", "fresh"],
    ]);
    const plan = planTileUploads(local, { "tiles/0/1_1.png": "same", "tiles/0/1_2.png": "old" }, hashes);
    expect(plan.unchanged.map((t) => t.key)).toEqual(["tiles/0/1_1.png"]);
    expect(plan.upload.map((t) => t.key)).toEqual(["tiles/0/1_2.png", "tiles/0/1_3.png"]);
    expect(plan.orphans).toEqual([]);
  });

  test("a manifest key with no file behind it is reported, never deleted", () => {
    const plan = planTileUploads([], { "tiles/0/9_9.png": "h" }, new Map());
    expect(plan.orphans).toEqual(["tiles/0/9_9.png"]);
  });
});

describe("publishTiles", () => {
  test("a first run uploads every tile as a PNG and writes the manifest last", async () => {
    const dir = root({ "0/43_31.png": "a", "0/44_31.png": "bb" });
    const store = fakeStore();
    const report = await publishTiles(scanTiles(dir), store, { now: 7 });

    expect(report).toEqual({ uploaded: 2, skipped: 0, bytes: 3, orphans: 0, manifestEntries: null });
    expect(store.puts.at(-1)).toBe(TILE_MANIFEST_KEY);
    expect(store.objects.get(`${TILE_PREFIX}0/43_31.png`)?.contentType).toBe("image/png");
    // Keys are the viewer's path verbatim: no hash in the key, because the SPA
    // and the gate both address a tile by map/row/col.
    expect([...store.objects.keys()].filter((k) => k !== TILE_MANIFEST_KEY).every((k) => /^tiles\/\d+\/\d+_\d+\.png$/.test(k))).toBe(true);
  });

  test("a re-run with nothing changed uploads nothing at all", async () => {
    const dir = root({ "0/43_31.png": "a" });
    const store = fakeStore();
    await publishTiles(scanTiles(dir), store, { now: 7 });
    store.puts.length = 0;

    const report = await publishTiles(scanTiles(dir), store, { now: 8 });
    expect(report).toEqual({ uploaded: 0, skipped: 1, bytes: 0, orphans: 0, manifestEntries: 1 });
    // Not even the manifest is spared a re-read, but nothing is re-PUT except
    // it — the whole point is that a no-op run costs no class-A ops per tile.
    expect(store.puts).toEqual([TILE_MANIFEST_KEY]);
  });

  test("a re-extraction that changes bytes re-uploads only what changed", async () => {
    const dir = root({ "0/43_31.png": "a", "0/44_31.png": "b" });
    const store = fakeStore();
    await publishTiles(scanTiles(dir), store, { now: 7 });
    writeFileSync(join(dir, "0/44_31.png"), "changed");
    store.puts.length = 0;

    const report = await publishTiles(scanTiles(dir), store, { now: 8 });
    expect(report.uploaded).toBe(1);
    expect(report.skipped).toBe(1);
    expect(store.puts).toEqual([`${TILE_PREFIX}0/44_31.png`, TILE_MANIFEST_KEY]);
  });

  test("a first run is distinguishable from an unreadable manifest", async () => {
    // The dry run's whole value is that "everything would upload" means a
    // first run and nothing else; a manifest that exists but reads as empty
    // must not look the same.
    const dir = root({ "0/43_31.png": "a" });
    const fresh = await publishTiles(scanTiles(dir), fakeStore(), { dryRun: true });
    expect(fresh.manifestEntries).toBeNull();
    const seeded = await publishTiles(scanTiles(dir), fakeStore({ [TILE_MANIFEST_KEY]: "{}" }), { dryRun: true });
    expect(seeded.manifestEntries).toBe(0);
  });

  test("a dry run reports the plan and touches the bucket not at all", async () => {
    const dir = root({ "0/43_31.png": "a" });
    const store = fakeStore();
    const report = await publishTiles(scanTiles(dir), store, { dryRun: true, now: 7 });
    expect(report.uploaded).toBe(1);
    expect(store.puts).toEqual([]);
    expect(store.objects.size).toBe(0);
  });

  test("nothing is written outside the tiles prefix", async () => {
    const dir = root({ "0/43_31.png": "a", "530/12_34.png": "b" });
    const store = fakeStore({ "v1/manifest.json": "{}" });
    await publishTiles(scanTiles(dir), store, { now: 7 });
    for (const key of store.puts) expect(key.startsWith(TILE_PREFIX)).toBe(true);
    expect(store.objects.get("v1/manifest.json")?.body).toBe("{}");
  });
});
