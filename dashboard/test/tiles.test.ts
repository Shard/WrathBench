/**
 * Whether a build may ask for a minimap tile, and from where.
 *
 * The Open shape (2026-09-11) put the app and the bucket on
 * two hostnames, so a relative `/tiles/...` would ask a host that has none: a
 * public build has to be told where the tiles live, which is
 * `VITE_WRATHBENCH_TILES_BASE`. That flag is separate from the snapshot base on
 * purpose — the tiles reach the bucket by a hand-run `publish-tiles --upload`
 * and never by a snapshot pass, so a JSON pass must not assert they are there.
 * This pins that a build told nothing asks for nothing and draws its grid, that
 * the private viewer is unaffected, and that naming a host works.
 *
 * The last test is a source scan in the house style of `public-links.test.ts`:
 * the failure being caught is "somebody wrote the literal path back into a
 * page", which no render of the private build would notice, because there the
 * literal is correct.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tileBasesFromEnv, tilePath, tileUrl } from "../src/lib/tiles";

const SRC = join(import.meta.dir, "..", "src");
const DATA = "https://wrathbench-data.shard.page";

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [path] : [];
  });
}

describe("the public build withholds tiles by default", () => {
  test("a snapshot build with no tiles base asks for nothing", () => {
    expect(tileUrl("", DATA, 0, 43, 31)).toBeNull();
  });

  test("publishing the JSON does not publish the textures", () => {
    // The two flags are independent, which is the whole decision: setting the
    // snapshot base must never be what turns tiles on.
    expect(tileUrl("", DATA, 0, 0, 0)).toBeNull();
    expect(tileUrl("", "/", 0, 0, 0)).toBeNull();
  });

  test("the private viewer is unaffected — same-origin, as before", () => {
    expect(tileUrl("", "", 0, 43, 31)).toBe("/tiles/0/43_31.png");
  });
});

describe("when the operator turns them on, the base is where they come from", () => {
  test("the tiles base wins over everything else", () => {
    expect(tileUrl(DATA, DATA, 571, 12, 7)).toBe(`${DATA}/tiles/571/12_7.png`);
    // Even in a private build, if someone points it at a host on purpose.
    expect(tileUrl(DATA, "", 0, 1, 2)).toBe(`${DATA}/tiles/0/1_2.png`);
  });

  test("trailing slashes are trimmed, the way the snapshot client trims its base", () => {
    expect(tileUrl(`${DATA}/`, DATA, 0, 1, 2)).toBe(`${DATA}/tiles/0/1_2.png`);
    expect(tileUrl("///", "", 1, 0, 0)).toBe("/tiles/1/0_0.png");
  });

  test("the key the publisher writes is the path a build asks for", () => {
    // infra/publish-tiles.ts keys objects `tiles/<map>/<row>_<col>.png`.
    expect(tilePath(0, 43, 31).slice(1)).toBe("tiles/0/43_31.png");
  });
});

describe("both bases come from the build's env, and nothing else", () => {
  test("unset, blank and non-string are all empty", () => {
    expect(tileBasesFromEnv({})).toEqual({ tiles: "", snapshot: "" });
    expect(tileBasesFromEnv({ VITE_WRATHBENCH_TILES_BASE: 7 })).toEqual({ tiles: "", snapshot: "" });
    expect(tileBasesFromEnv({ VITE_WRATHBENCH_TILES_BASE: "  " })).toEqual({ tiles: "", snapshot: "" });
  });

  test("each is read from its own name", () => {
    expect(
      tileBasesFromEnv({ VITE_WRATHBENCH_TILES_BASE: ` ${DATA}/ `, VITE_WRATHBENCH_SNAPSHOT_BASE: `${DATA}/` }),
    ).toEqual({ tiles: DATA, snapshot: DATA });
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

  test("the map honours the withheld case rather than firing requests that 404", () => {
    // Two guards, and the outer one is what keeps a withheld build from
    // creating an Image per visible cell on every pan.
    const src = readFileSync(join(SRC, "pages", "MapPage.tsx"), "utf8");
    expect(src).toContain("const useTiles = !NO_TILE_BASE && g.size >= TILE_MIN_PX;");
    expect(src).toMatch(/const src = tileSrc\(map, row, col\);\s*\n\s*if \(src !== null\) \{/);
  });
});
