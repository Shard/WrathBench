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
 * guards themselves.
 *
 * It is deliberately a source check rather than a render check: the failure
 * being caught is "somebody removed the guard", which no fixture render of the
 * private build would notice. The repo's GitHub link is behind
 * `VITE_WRATHBENCH_REPO_URL` (`repo-link.test.ts`).
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
    const src = read("components/FeedRows.tsx");
    // The one anchor at `rawPath` lives in `RawLink`, which bails first.
    expect(src).toMatch(/function RawLink\([^)]*\)[^{]*\{\s*if \(SNAPSHOT_MODE\) return null;/);
    // And it is the only place the raw path is built into a link.
    const users = sources().filter((p) => !p.endsWith(join("api", "client.ts")) && readFileSync(p, "utf8").includes("rawPath("));
    expect(users.map((p) => p.slice(SRC.length + 1))).toEqual(["components/FeedRows.tsx"]);
  });

  test("no EventSource is opened against a bucket", () => {
    const src = read("pages/RunDetail.tsx");
    expect(src).toMatch(/if \(SNAPSHOT_MODE\) return;\s*\n\s*stop = subscribeTail\(/);
  });

  /*
   * Config drafts (GitHub issue #66). The /admin page is a lazy route in both
   * builds, so its chunk ships in the public bundle; what keeps drafts out of
   * the public site is that nothing there can reach them. The server side —
   * a public handle 404s every draft route and the publisher renders none —
   * is pinned in viewer/test/viewer-config-drafts.test.ts.
   */
  test("the public build's client has no draft surface, and the page never asks for one there", () => {
    // The client a public build reads with names no config route at all.
    const snapshot = read("api/snapshot-client.ts");
    expect(snapshot.includes("proposed")).toBe(false);
    expect(snapshot.includes("/api/config")).toBe(false);
    // The draft routes are spelled in the config client and nowhere else.
    const spelled = sources().filter((p) => readFileSync(p, "utf8").includes("/api/config/proposed"));
    expect(spelled.map((p) => p.slice(SRC.length + 1))).toEqual(["api/config-client.ts"]);
    // And the one page that calls them loads nothing in the public build ...
    const page = read("pages/Config.tsx");
    expect(page).toMatch(/onMount\(\(\) => \{\s*if \(SNAPSHOT_MODE\) return;\s*void reload\(\);/);
    // ... and renders the draft section only inside the private-build guard.
    const guard = page.indexOf("when={!SNAPSHOT_MODE");
    expect(guard).toBeGreaterThan(0);
    expect(page.slice(guard, guard + 300)).toContain("fallback={<p class=\"dim\">{SNAPSHOT_WITHHELD_TEXT}</p>}");
    const drafts = page.indexOf("<Drafts ");
    expect(drafts).toBeGreaterThan(guard);
    const callers = sources().filter((p) => /configApi\.(drafts|fetchDrafts|ignoreDraft|unignoreDraft|promoteDraft)\(/.test(readFileSync(p, "utf8")));
    expect(callers.map((p) => p.slice(SRC.length + 1))).toEqual(["pages/Config.tsx"]);
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
