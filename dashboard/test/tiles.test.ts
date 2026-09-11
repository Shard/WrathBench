/**
 * Tile URLs follow the snapshot base, and are built in exactly one place.
 *
 * The Open shape (2026-09-11, FOLLOW-UPS item 85) put the app and the bucket on
 * two hostnames. A `/tiles/...` asked of the app hostname finds nothing there,
 * and the map's failure mode for a missing tile is a silent fall back to a
 * labelled grid square — so the whole map would degrade to the no-extraction
 * look with nothing in the console to say why. That is the bug this pins.
 *
 * The second test is a source scan in the house style of `public-links.test.ts`:
 * the failure being caught is "somebody wrote the literal path back into a
 * page", which a render of the private build would never notice, because the
 * private build's base is empty and the literal is correct there.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tileBaseFromEnv, tilePath, tileUrl } from "../src/lib/tiles";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [path] : [];
  });
}

describe("the tile URL is relative to the snapshot base", () => {
  test("the private build's empty base leaves it same-origin", () => {
    expect(tileUrl("", 0, 43, 31)).toBe("/tiles/0/43_31.png");
  });

  test("a bare slash — the one-origin shape — is the same URL, not a doubled one", () => {
    expect(tileUrl("/", 0, 43, 31)).toBe("/tiles/0/43_31.png");
    expect(tileUrl("///", 1, 0, 0)).toBe("/tiles/1/0_0.png");
  });

  test("the public build asks the data hostname", () => {
    expect(tileUrl("https://wrathbench-data.shard.page", 571, 12, 7)).toBe(
      "https://wrathbench-data.shard.page/tiles/571/12_7.png",
    );
  });

  test("a trailing slash on the configured base is trimmed, like the snapshot client's", () => {
    expect(tileUrl("https://wrathbench-data.shard.page/", 0, 1, 2)).toBe(
      "https://wrathbench-data.shard.page/tiles/0/1_2.png",
    );
  });

  test("the key the publisher writes is the path the page asks for", () => {
    // infra/publish-tiles.ts keys objects `tiles/<map>/<row>_<col>.png`.
    expect(tilePath(0, 43, 31).slice(1)).toBe("tiles/0/43_31.png");
  });

  test("the base comes from the build's env, and anything else is empty", () => {
    expect(tileBaseFromEnv({})).toBe("");
    expect(tileBaseFromEnv({ VITE_WRATHBENCH_SNAPSHOT_BASE: 7 })).toBe("");
    expect(tileBaseFromEnv({ VITE_WRATHBENCH_SNAPSHOT_BASE: "  " })).toBe("");
    expect(tileBaseFromEnv({ VITE_WRATHBENCH_SNAPSHOT_BASE: " https://d.example/ " })).toBe("https://d.example");
  });
});

describe("one place builds it", () => {
  test("no source outside lib/tiles.ts spells the tile path", () => {
    const users = sources().filter((p) => {
      if (p === join(SRC, "lib", "tiles.ts")) return false;
      // A string literal or an interpolated template — prose in a comment that
      // names the path is not a second place that builds it.
      return /["']\/tiles\/|`\/tiles\/\$\{/.test(readFileSync(p, "utf8"));
    });
    expect(users.map((p) => p.slice(SRC.length + 1))).toEqual([]);
  });
});
