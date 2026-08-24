/**
 * `/api/info`'s `dashboardBuild` (item 64).
 *
 * The id is Vite's own fingerprinted entry filename, parsed out of index.html,
 * because that name already changes exactly when the bundle does — a build id
 * nobody has to remember to stamp. The property that matters is that it MOVES
 * on a rebuild: an id that went stale with the bundle would report every tab
 * as current, which is the failure this was built to catch.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import type { ApiInfoResponse } from "../viewer/api-types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function page(entry: string | null): string {
  const script = entry === null ? "" : `<script type="module" crossorigin src="/assets/${entry}"></script>`;
  return `<!doctype html><html><head>${script}</head><body><div id="root"></div></body></html>`;
}

function fixture(entry: string | null): { runs: string; dash: string } {
  const root = mkdtempSync(join(tmpdir(), "wb-build-"));
  dirs.push(root);
  const runs = join(root, "runs");
  const dash = join(root, "dist");
  mkdirSync(runs, { recursive: true });
  mkdirSync(dash, { recursive: true });
  writeFileSync(join(dash, "index.html"), page(entry));
  return { runs, dash };
}

async function info(runs: string, dash?: string): Promise<ApiInfoResponse> {
  const handle = createApi({
    runsDir: runs,
    tilesDir: join(runs, "..", "minimap"),
    publicMode: false,
    moduleUrl: "http://127.0.0.1:1",
    ...(dash !== undefined ? { dashboardDir: dash } : {}),
  });
  const res = await handle(new Request("http://x/api/info"));
  expect(res.status).toBe(200);
  return (await res.json()) as ApiInfoResponse;
}

describe("/api/info dashboardBuild", () => {
  test("the served build is the fingerprinted entry name", async () => {
    const { runs, dash } = fixture("index-EbAbwMv4.js");
    expect((await info(runs, dash)).dashboardBuild).toBe("index-EbAbwMv4.js");
  });

  test("a rebuild moves it, which is the whole point", async () => {
    // The load-bearing case. The id is cached on mtime, so a cache that keyed
    // on anything staler — the handle's lifetime, the directory path — would
    // pass every other test here and still report every open tab as current.
    const { runs, dash } = fixture("index-AAA.js");
    const handle = createApi({ runsDir: runs, tilesDir: join(runs, ".."), publicMode: false, moduleUrl: "http://127.0.0.1:1", dashboardDir: dash });
    const first = (await (await handle(new Request("http://x/api/info"))).json()) as ApiInfoResponse;
    expect(first.dashboardBuild).toBe("index-AAA.js");
    // Vite empties dist/ and writes a new index.html; mtime moves with it.
    writeFileSync(join(dash, "index.html"), page("index-BBB.js"));
    const later = Date.now() / 1000 + 5;
    utimesSync(join(dash, "index.html"), later, later);
    const second = (await (await handle(new Request("http://x/api/info"))).json()) as ApiInfoResponse;
    expect(second.dashboardBuild).toBe("index-BBB.js");
  });

  test("no dashboard on disk, and a page with no entry script, are both null not a crash", async () => {
    const bare = fixture(null);
    expect((await info(bare.runs, bare.dash)).dashboardBuild).toBeNull();
    const none = fixture("x.js");
    expect((await info(none.runs)).dashboardBuild).toBeNull();
  });
});
