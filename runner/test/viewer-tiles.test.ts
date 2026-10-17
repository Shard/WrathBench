/**
 * The tile route, and the one flag that opens it on a public deployment.
 *
 * `WRATHBENCH_VIEWER_TILES_PUBLIC=1` is opt-in and only ever loosens public
 * mode: without it a public viewer answers 403 as it always has, and a private
 * viewer is untouched either way — including its cache header, which a client
 * has been told is good for a year. A pyramid level is the same bytes by
 * another route, so it takes every one of those rules unchanged.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import {
  ART_TILE_CACHE_CONTROL,
  ART_TILE_PUBLIC_CACHE_CONTROL,
  TILE_CACHE_CONTROL,
  TILE_PUBLIC_CACHE_CONTROL,
  tileNotModified,
  tileValidators,
} from "../viewer/tiles";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A runs directory and a tile root with one extracted tile in it. */
function fixture(): { runsDir: string; tilesDir: string } {
  const root = tempDir("viewer-tiles-");
  const runsDir = join(root, "runs");
  const tilesDir = join(root, "minimap");
  mkdirSync(runsDir);
  mkdirSync(join(tilesDir, "0"), { recursive: true });
  writeFileSync(join(tilesDir, "0", "43_31.png"), PNG);
  mkdirSync(join(tilesDir, "0", "minimap", "3"), { recursive: true });
  writeFileSync(join(tilesDir, "0", "minimap", "3", "5_3.png"), PNG);
  mkdirSync(join(tilesDir, "0", "art", "3"), { recursive: true });
  writeFileSync(join(tilesDir, "0", "art", "3", "5_3.png"), PNG);
  return { runsDir, tilesDir };
}

function handleFor(
  opts: { publicMode: boolean; tilesPublic?: boolean },
  { runsDir, tilesDir } = fixture(),
): (req: Request) => Promise<Response> {
  return createApi({
    runsDir,
    tilesDir,
    publicMode: opts.publicMode,
    ...(opts.tilesPublic === undefined ? {} : { tilesPublic: opts.tilesPublic }),
    moduleUrl: "http://127.0.0.1:1",
  });
}

/** A native tile and a pyramid level: every rule below holds for both. */
const TILES = ["/tiles/0/43_31.png", "/tiles/0/minimap/3/5_3.png"];

const ART = "/tiles/0/art/3/5_3.png";

const get = async (
  handle: (req: Request) => Promise<Response>,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> => await handle(new Request(`http://viewer.local${path}`, { headers }));

describe("tiles in public mode", () => {
  test("withheld by default, exactly as before", async () => {
    for (const handle of [handleFor({ publicMode: true }), handleFor({ publicMode: true, tilesPublic: false })]) {
      for (const path of TILES) {
        const res = await get(handle, path);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "withheld in public mode" });
      }
    }
  });

  test("served with private caching and noindex when the flag is on", async () => {
    const handle = handleFor({ publicMode: true, tilesPublic: true });
    for (const path of TILES) {
      const res = await get(handle, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe(TILE_PUBLIC_CACHE_CONTROL);
      expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    }
  });

  test("the flag opens no listing and no path outside the tile root", async () => {
    const handle = handleFor({ publicMode: true, tilesPublic: true });
    // (`..` is normalised away by the URL parser before the route sees it;
    // path validation itself is pinned in viewer-map.test.ts and unchanged.)
    for (const path of [
      "/tiles/",
      "/tiles/0/",
      "/tiles/0",
      "/tiles/0/64_0.png",
      "/tiles/0/44_31.png",
      "/tiles/0/minimap/",
      "/tiles/0/minimap/3/",
      "/tiles/0/minimap/0/43_31.png",
      "/tiles/0/minimap/3/8_0.png",
      "/tiles/0/minimap/3/5_4.png",
    ]) {
      const res = await get(handle, path);
      expect(res.status).toBe(404);
      // A miss must never be cached: the extraction may write that tile next.
      expect(res.headers.get("cache-control")).toBeNull();
    }
  });
});

describe("tiles outside public mode", () => {
  test("served with the year-long immutable cache, flag or no flag", async () => {
    for (const tilesPublic of [undefined, true, false]) {
      const handle = handleFor({ publicMode: false, ...(tilesPublic === undefined ? {} : { tilesPublic }) });
      for (const path of TILES) {
        const res = await get(handle, path);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe(TILE_CACHE_CONTROL);
        // The private viewer is nobody's crawl target and gains no header.
        expect(res.headers.get("x-robots-tag")).toBeNull();
      }
    }
  });
});

/*
 * The art layer is re-baked in place while its look is tuned, so it must not
 * be cached for good the way every other tile is: stored, revalidated before
 * each use, and answered 304 while unchanged.
 */
describe("the art layer revalidates", () => {
  test("served with no-cache and both validators, while every other tile stays immutable", async () => {
    const handle = handleFor({ publicMode: false });
    const art = await get(handle, ART);
    expect(art.status).toBe(200);
    expect(art.headers.get("cache-control")).toBe(ART_TILE_CACHE_CONTROL);
    expect(art.headers.get("etag")).toMatch(/^W\/".+"$/);
    expect(art.headers.get("last-modified")).not.toBeNull();
    expect(new Uint8Array(await art.arrayBuffer())).toEqual(PNG);
    for (const path of TILES) {
      const res = await get(handle, path);
      expect(res.headers.get("cache-control")).toBe(TILE_CACHE_CONTROL);
      expect(res.headers.get("etag")).toBeNull();
    }
  });

  test("an unchanged tile is a 304 by tag or by date, and a re-bake is a 200 again", async () => {
    const dirs = fixture();
    const handle = handleFor({ publicMode: false }, dirs);
    const first = await get(handle, ART);
    const etag = first.headers.get("etag")!;
    const lastModified = first.headers.get("last-modified")!;
    const byTag = await get(handle, ART, { "if-none-match": etag });
    expect(byTag.status).toBe(304);
    expect(byTag.headers.get("etag")).toBe(etag);
    expect(byTag.headers.get("cache-control")).toBe(ART_TILE_CACHE_CONTROL);
    expect((await byTag.arrayBuffer()).byteLength).toBe(0);
    expect((await get(handle, ART, { "if-modified-since": lastModified })).status).toBe(304);
    // A re-bake writes a new file: a later mtime, so a new tag and a full answer.
    const file = join(dirs.tilesDir, "0", "art", "3", "5_3.png");
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const after = await get(handle, ART, { "if-none-match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect((await get(handle, ART, { "if-modified-since": lastModified })).status).toBe(200);
  });

  test("public mode with tiles opted in keeps it private, revalidated and noindex", async () => {
    const res = await get(handleFor({ publicMode: true, tilesPublic: true }), ART);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(ART_TILE_PUBLIC_CACHE_CONTROL);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("etag")).not.toBeNull();
    const withheld = await get(handleFor({ publicMode: true }), ART);
    expect(withheld.status).toBe(403);
  });

  test("the conditional check: a tag list, a wildcard, weak against strong, and a stale date", () => {
    const v = tileValidators({ size: 4096, mtimeMs: 1_790_000_000_123 });
    const h = (o: Record<string, string>): Headers => new Headers(o);
    expect(tileNotModified(h({ "if-none-match": `"x", ${v.etag}` }), v)).toBe(true);
    expect(tileNotModified(h({ "if-none-match": v.etag.replace(/^W\//, "") }), v)).toBe(true);
    expect(tileNotModified(h({ "if-none-match": "*" }), v)).toBe(true);
    expect(tileNotModified(h({ "if-none-match": `W/"other"` }), v)).toBe(false);
    // If-None-Match decides alone when both are sent.
    expect(tileNotModified(h({ "if-none-match": `W/"other"`, "if-modified-since": v.lastModified }), v)).toBe(false);
    expect(tileNotModified(h({ "if-modified-since": new Date(0).toUTCString() }), v)).toBe(false);
    expect(tileNotModified(h({ "if-modified-since": "not a date" }), v)).toBe(false);
    expect(tileNotModified(h({}), v)).toBe(false);
  });
});
