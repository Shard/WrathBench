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
  SERVED_DIR,
  TILE_PUBLIC_CACHE_CONTROL,
  tileNotModified,
  tileValidators,
} from "../viewer/tiles";
import { buildTileIndex, parseTileIndex, renderTileIndex } from "../viewer/tileindex";
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

/*
 * The served tree (`minimap/src/transcode.ts`) beside the masters: the route
 * answers from it while it is current, falls back to the master when it is
 * missing or older, and types every answer by the bytes it actually sends.
 */
describe("the served tree", () => {
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const PNG8 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 8]);
  const LEVEL = "/tiles/0/minimap/3/5_3.webp";

  function served(): { runsDir: string; tilesDir: string } {
    const dirs = fixture();
    const web = join(dirs.tilesDir, SERVED_DIR, "0");
    mkdirSync(join(web, "minimap", "3"), { recursive: true });
    mkdirSync(join(web, "art", "3"), { recursive: true });
    writeFileSync(join(web, "43_31.png"), PNG8);
    writeFileSync(join(web, "minimap", "3", "5_3.webp"), WEBP);
    writeFileSync(join(web, "art", "3", "5_3.webp"), WEBP);
    writeFileSync(join(web, "index.json"), renderTileIndex(buildTileIndex([{ layer: "minimap", z: 0, row: 43, col: 31 }], [])));
    return dirs;
  }

  test("a pyramid tile is the WebP and a native the indexed PNG, each typed by what it is", async () => {
    const handle = handleFor({ publicMode: false }, served());
    const level = await get(handle, LEVEL);
    expect(level.status).toBe(200);
    expect(level.headers.get("content-type")).toBe("image/webp");
    expect(level.headers.get("cache-control")).toBe(TILE_CACHE_CONTROL);
    expect(new Uint8Array(await level.arrayBuffer())).toEqual(WEBP);
    const art = await get(handle, "/tiles/0/art/3/5_3.webp");
    expect(art.headers.get("content-type")).toBe("image/webp");
    expect(art.headers.get("cache-control")).toBe(ART_TILE_CACHE_CONTROL);
    const native = await get(handle, "/tiles/0/43_31.png");
    expect(native.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(PNG8);
  });

  test("an older build's .png pyramid path is still the master", async () => {
    const res = await get(handleFor({ publicMode: false }, served()), "/tiles/0/minimap/3/5_3.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("with no served file, or one older than its master, the master answers, typed as a PNG", async () => {
    const bare = await get(handleFor({ publicMode: false }), LEVEL);
    expect(bare.status).toBe(200);
    expect(bare.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await bare.arrayBuffer())).toEqual(PNG);

    const dirs = served();
    // A re-bake after the last transcode: the master is newer.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dirs.tilesDir, "0", "minimap", "3", "5_3.png"), later, later);
    const stale = await get(handleFor({ publicMode: false }, dirs), LEVEL);
    expect(stale.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(PNG);
  });

  test("a served file with no master behind it is not a tile", async () => {
    const dirs = served();
    const web = join(dirs.tilesDir, SERVED_DIR, "0", "minimap", "3");
    writeFileSync(join(web, "6_3.webp"), WEBP);
    expect((await get(handleFor({ publicMode: false }, dirs), "/tiles/0/minimap/3/6_3.webp")).status).toBe(404);
  });

  test("the index is JSON, revalidated, and behind the same public gate as the tiles", async () => {
    const dirs = served();
    const res = await get(handleFor({ publicMode: false }, dirs), "/tiles/0/index.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe(ART_TILE_CACHE_CONTROL);
    expect(parseTileIndex(await res.json())).not.toBeNull();
    const etag = res.headers.get("etag")!;
    expect((await get(handleFor({ publicMode: false }, dirs), "/tiles/0/index.json", { "if-none-match": etag })).status).toBe(304);
    expect((await get(handleFor({ publicMode: true }, dirs), "/tiles/0/index.json")).status).toBe(403);
    const pub = await get(handleFor({ publicMode: true, tilesPublic: true }, dirs), "/tiles/0/index.json");
    expect(pub.headers.get("cache-control")).toBe(ART_TILE_PUBLIC_CACHE_CONTROL);
    expect(pub.headers.get("x-robots-tag")).toBe("noindex");
  });

  test("an index older than a bake is withheld, so the page asks for every cell instead", async () => {
    const dirs = served();
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dirs.tilesDir, "0", "art", "3"), later, later);
    expect((await get(handleFor({ publicMode: false }, dirs), "/tiles/0/index.json")).status).toBe(404);
    expect((await get(handleFor({ publicMode: false }), "/tiles/0/index.json")).status).toBe(404);
    expect((await get(handleFor({ publicMode: false }, dirs), "/tiles/7/index.json")).status).toBe(404);
  });
});

/*
 * The transcode and the route together: a re-bake that rewrites masters with
 * the same bytes moves only their mtimes, and the served tree must still be
 * what the route answers with afterwards.
 */
describe("a no-op re-bake", () => {
  test("leaves the WebP and the index served", async () => {
    const { transcodeTree } = await import("../../minimap/src/transcode");
    const { encodePng } = await import("../../minimap/src/png");
    const dirs = fixture();
    const opaque = encodePng(new Uint8Array(256 * 256 * 4).fill(200), 256, 256);
    for (const rel of ["0/43_31.png", "0/minimap/3/5_3.png", "0/art/3/5_3.png"]) writeFileSync(join(dirs.tilesDir, rel), opaque);
    await transcodeTree(dirs.tilesDir);
    // The re-bake: same bytes, written later, through the directories.
    const later = new Date(Date.now() + 60_000);
    for (const rel of ["0/43_31.png", "0/minimap/3/5_3.png", "0/art/3/5_3.png", "0/art/3", "0/minimap/3", "0"]) {
      utimesSync(join(dirs.tilesDir, rel), later, later);
    }
    const handle = handleFor({ publicMode: false }, dirs);
    // Before the next transcode the masters answer, as they must.
    expect((await get(handle, "/tiles/0/minimap/3/5_3.webp")).headers.get("content-type")).toBe("image/png");
    expect((await get(handle, "/tiles/0/index.json")).status).toBe(404);
    const again = await transcodeTree(dirs.tilesDir);
    expect(Object.values(again.layers).reduce((s, l) => s + l.encoded, 0)).toBe(0);
    expect((await get(handle, "/tiles/0/minimap/3/5_3.webp")).headers.get("content-type")).toBe("image/webp");
    expect((await get(handle, "/tiles/0/art/3/5_3.webp")).headers.get("content-type")).toBe("image/webp");
    expect((await get(handle, "/tiles/0/index.json")).status).toBe(200);
    // And a pass with nothing re-baked moves no validator.
    const etag = (await get(handle, "/tiles/0/art/3/5_3.webp")).headers.get("etag");
    await transcodeTree(dirs.tilesDir);
    expect((await get(handle, "/tiles/0/art/3/5_3.webp")).headers.get("etag")).toBe(etag);
  });
});
