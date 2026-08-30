/**
 * The tile publisher's two jobs: read nothing but tiles out of `data/minimap`,
 * and upload nothing a re-run does not have to. Both are asserted against a
 * temp directory and a fake bucket, so this suite is green from a bare clone
 * with no `data/`.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-tiles-"));
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

  test("a machine that never ran the extraction scans empty rather than throwing", () => {
    expect(scanTiles(join(tmpdir(), "wb-tiles-does-not-exist"))).toEqual([]);
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

    expect(report).toEqual({ uploaded: 2, skipped: 0, bytes: 3, orphans: 0 });
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
    expect(report).toEqual({ uploaded: 0, skipped: 1, bytes: 0, orphans: 0 });
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
