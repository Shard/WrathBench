/**
 * The public build must offer a reader nothing that only the private viewer
 * can answer.
 *
 * The snapshot build is served from a bucket of static JSON: there is no live
 * `/api`, no SSE tail, no raw trajectory line, and no window but the one
 * published tail per run. Every control that needs one of those is guarded by
 * `SNAPSHOT_MODE` somewhere in `dashboard/src`, and a guard is easy to lose in
 * a refactor — the page still compiles, still renders, and only a public
 * reader sees the dead end. So this suite reads the sources and pins the
 * guards themselves, alongside the router's catch-all.
 *
 * It is deliberately a source check rather than a render check: the failure
 * being caught is "somebody removed the guard", which no fixture render of the
 * private build would notice. Audited 2026-09-01 (GitHub issue #30); the
 * repo's GitHub link is behind `VITE_WRATHBENCH_REPO_URL` since 2026-09-11
 * (`repo-link.test.ts`), and `/fleet` stays reachable from the
 * status popout in both builds (operator, 2026-08-30,
 * `dashboard/src/lib/nav.ts`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [path] : [];
  });
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("nothing a public reader clicks needs the live viewer", () => {
  test("the raw-line link renders nothing in the public build", () => {
    const src = read("pages/RunDetail.tsx");
    // The one anchor at `rawPath` lives in `RawLink`, which bails first.
    expect(src).toMatch(/function RawLink\([^)]*\)[^{]*\{\s*if \(SNAPSHOT_MODE\) return null;/);
    // And it is the only place the raw path is built into a link.
    const users = sources().filter((p) => !p.endsWith(join("api", "client.ts")) && readFileSync(p, "utf8").includes("rawPath("));
    expect(users.map((p) => p.slice(SRC.length + 1))).toEqual(["pages/RunDetail.tsx"]);
  });

  test("no EventSource is opened against a bucket", () => {
    const src = read("pages/RunDetail.tsx");
    expect(src).toMatch(/if \(SNAPSHOT_MODE\) return;\s*\n\s*stop = subscribeTail\(/);
  });

  test("'load earlier' is hidden where only one window is published", () => {
    const src = read("pages/RunDetail.tsx");
    const at = src.indexOf("<button onClick={loadEarlier}>");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, at - 300), at)).toContain("!SNAPSHOT_MODE");
  });

  test("the operator-only banners on the models page stay private", () => {
    const src = read("pages/Models.tsx");
    // Both name a host path or an env var the reader cannot act on.
    expect(src.match(/!SNAPSHOT_MODE/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("an unknown route renders the not-found page, not a redirect home", () => {
    const src = read("main.tsx");
    expect(src).toContain('<Route path="*" component={NotFound} />');
    // The two redirects that do exist are named renames, not a catch-all home.
    expect(src).toContain('<Route path="/results" component={ResultsRedirect} />');
    expect(src).toContain('<Route path="/episodes" component={EpisodesRedirect} />');
  });

  test("no page links at the API, opens a window, or offers a download", () => {
    for (const path of sources()) {
      const src = readFileSync(path, "utf8");
      const where = path.slice(SRC.length + 1);
      // `/api/...` belongs to the client layer, which the snapshot build
      // replaces wholesale; a page that spelled one would bypass it.
      if (where !== "api/client.ts") {
        expect(`${where}: ${src.includes('href="/api')}`).toBe(`${where}: false`);
      }
      expect(`${where}: ${/\bwindow\.open\(/.test(src)}`).toBe(`${where}: false`);
      // A download would be a file the bucket does not hold.
      expect(`${where}: ${/\bdownload\b\s*(=|:)/.test(src)}`).toBe(`${where}: false`);
    }
  });
});
