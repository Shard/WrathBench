/**
 * The tile route, and the one flag that opens it on a public deployment.
 *
 * `WRATHBENCH_VIEWER_TILES_PUBLIC=1` is opt-in and only ever loosens public
 * mode: without it a public viewer answers 403 as it always has, and a private
 * viewer is untouched either way — including its cache header, which a client
 * has been told is good for a year.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { TILE_CACHE_CONTROL, TILE_PUBLIC_CACHE_CONTROL } from "../viewer/tiles";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A runs directory and a tile root with one extracted tile in it. */
function fixture(): { runsDir: string; tilesDir: string } {
  const root = mkdtempSync(join(tmpdir(), "viewer-tiles-"));
  const runsDir = join(root, "runs");
  const tilesDir = join(root, "minimap");
  mkdirSync(runsDir);
  mkdirSync(join(tilesDir, "0"), { recursive: true });
  writeFileSync(join(tilesDir, "0", "43_31.png"), PNG);
  return { runsDir, tilesDir };
}

function handleFor(opts: { publicMode: boolean; tilesPublic?: boolean }): (req: Request) => Promise<Response> {
  const { runsDir, tilesDir } = fixture();
  return createApi({
    runsDir,
    tilesDir,
    publicMode: opts.publicMode,
    ...(opts.tilesPublic === undefined ? {} : { tilesPublic: opts.tilesPublic }),
    moduleUrl: "http://127.0.0.1:1",
  });
}

const get = async (
  handle: (req: Request) => Promise<Response>,
  path: string,
): Promise<Response> => await handle(new Request(`http://viewer.local${path}`));

describe("tiles in public mode", () => {
  test("withheld by default, exactly as before", async () => {
    for (const handle of [handleFor({ publicMode: true }), handleFor({ publicMode: true, tilesPublic: false })]) {
      const res = await get(handle, "/tiles/0/43_31.png");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "withheld in public mode" });
    }
  });

  test("served with private caching and noindex when the flag is on", async () => {
    const handle = handleFor({ publicMode: true, tilesPublic: true });
    const res = await get(handle, "/tiles/0/43_31.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(TILE_PUBLIC_CACHE_CONTROL);
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("the flag opens no listing and no path outside the tile root", async () => {
    const handle = handleFor({ publicMode: true, tilesPublic: true });
    // (`..` is normalised away by the URL parser before the route sees it;
    // path validation itself is pinned in viewer-map.test.ts and unchanged.)
    for (const path of ["/tiles/", "/tiles/0/", "/tiles/0", "/tiles/0/64_0.png", "/tiles/0/44_31.png"]) {
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
      const res = await get(handle, "/tiles/0/43_31.png");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(TILE_CACHE_CONTROL);
      // The private viewer is nobody's crawl target and gains no header.
      expect(res.headers.get("x-robots-tag")).toBeNull();
    }
  });
});
