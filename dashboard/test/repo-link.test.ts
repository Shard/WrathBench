/**
 * The repository link is a build-time flag, and the default is off.
 *
 * A link to a private repository is a 404 wearing the project's name, in the
 * footer of the first page a stranger reads. So the URL comes from
 * `VITE_WRATHBENCH_REPO_URL` and both places that spell it — the footer anchor
 * and the BibTeX `url` line — render nothing without it (FOLLOW-UPS item 109).
 *
 * The env-reading half is unit-tested; the two call sites are pinned as a
 * source check, the way `public-links.test.ts` pins its guards, because the
 * failure being caught is "somebody hard-coded the URL back in", which a
 * render of a flag-less build would not notice.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bibtex, repoLabel, repoUrlFromEnv } from "../src/lib/repo";

const SRC = join(import.meta.dir, "..", "src");
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

describe("the URL comes from the build's env, or nowhere", () => {
  test("unset, empty and whitespace are all no link", () => {
    expect(repoUrlFromEnv({})).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "" })).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "   " })).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: 7 })).toBeNull();
  });

  test("an http(s) URL is taken, trailing slashes and all; anything else is ignored", () => {
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "https://github.com/Shard/WrathBench" })).toBe(
      "https://github.com/Shard/WrathBench",
    );
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: " https://example.dev/wb/ " })).toBe("https://example.dev/wb");
    // Not a link: a scheme in an anchor is not something a stray env may choose.
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "javascript:alert(1)" })).toBeNull();
    expect(repoUrlFromEnv({ VITE_WRATHBENCH_REPO_URL: "github.com/Shard/WrathBench" })).toBeNull();
  });

  test("the label is the last two segments", () => {
    expect(repoLabel("https://github.com/Shard/WrathBench")).toBe("Shard/WrathBench");
  });
});

describe("the citation drops the url line when there is no repository", () => {
  test("with a URL it is the entry as published", () => {
    expect(bibtex("https://github.com/Shard/WrathBench")).toBe(`@misc{beukers2026wrathbench,
  title  = {WrathBench: An Agent Workbench for World of Warcraft},
  author = {Mark Beukers},
  year   = {2026},
  url    = {https://github.com/Shard/WrathBench}
}`);
  });

  test("without one the entry is complete and names no URL", () => {
    const cite = bibtex(null);
    expect(cite).not.toContain("url");
    expect(cite).toContain("author = {Mark Beukers}");
    // No dangling comma before the closing brace.
    expect(cite.endsWith("year   = {2026}\n}")).toBe(true);
  });
});

describe("nothing spells the repository URL itself", () => {
  test("the footer anchor and the citation both go through lib/repo.ts", () => {
    const layout = read("components/Layout.tsx");
    expect(layout).toContain('<Show when={REPO_URL}>');
    expect(layout).toContain("{repoLabel(url())}");
    expect(read("pages/About.tsx")).toContain("{bibtex(REPO_URL)}");
  });

  test("no source outside lib/repo.ts hard-codes a repository host", () => {
    for (const rel of ["components/Layout.tsx", "pages/About.tsx", "pages/Home.tsx"]) {
      expect(`${rel}: ${read(rel).includes("github.com")}`).toBe(`${rel}: false`);
    }
  });
});
