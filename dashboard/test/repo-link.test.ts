/**
 * The repository link is a build-time flag, and the default is off.
 *
 * A link to a private repository is a 404 wearing the project's name, in the
 * footer of the first page a stranger reads. So the URL comes from
 * `VITE_WRATHBENCH_REPO_URL` and both places that spell it — the footer anchor
 * and the BibTeX `url` line — render nothing without it. The source scan is
 * there because the failure being caught is "somebody hard-coded the URL back
 * in", which a render of a flag-less build would not notice.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bibtex, repoUrlFromEnv, stackUrlFrom } from "../src/lib/repo";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [path] : [];
  });
}

describe("the URL comes from the build's env, or nowhere", () => {
  test("unset, blank and anything not http(s) are no link; a URL is taken, trimmed", () => {
    expect(repoUrlFromEnv({})).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "   " })).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: 7 })).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "javascript:alert(1)" })).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "github.com/Shard/WrathBench" })).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: " https://example.dev/wb/ " })).toBe("https://example.dev/wb");
  });

  test("the citation drops its url line without a repository, and the stack link is absent too", () => {
    const cite = bibtex(null);
    expect(cite).not.toContain("url");
    expect(cite.endsWith("year   = {2026}\n}")).toBe(true);
    expect(bibtex("https://example.org/owner/WrathBench")).toContain("url    = {https://example.org/owner/WrathBench}");
    expect(stackUrlFrom(null)).toBeNull();
    expect(stackUrlFrom("https://example.org/owner/WrathBench")).toBe("https://example.org/owner/wrath-mcp");
  });
});

describe("nothing spells the repository URL itself", () => {
  test("no source hard-codes a repository host, anywhere under src", () => {
    for (const path of sources()) {
      const where = path.slice(SRC.length + 1);
      expect(`${where}: ${readFileSync(path, "utf8").includes("github.com")}`).toBe(`${where}: false`);
    }
  });
});
