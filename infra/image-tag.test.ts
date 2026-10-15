/**
 * infra/image-tag.sh against throwaway git trees, so this repository's own
 * tags and state never decide whether the suite passes.
 *
 * The property that matters is the one a campaign leans on: whatever names an
 * image (a release or a hand build via build-images.sh, or the branch-image
 * workflow's master and feat/** builds) names it
 * `harness-0.5-<n>-g<sha>[-<branch slug>]`, and the comparability layer reads
 * every one of those as series 0.5. A bare SHA (no tag reachable) names no
 * series, which is why the workflow checks it before pushing.
 *
 * Children get a bare environment (never this process's, which `bun test`
 * fills from the repository's .env) and git runs with no global or system
 * config.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessSeries } from "../runner/src/comparability";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

const SCRIPT = join(import.meta.dir, "image-tag.sh");

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(tree: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", tree, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function commit(tree: string, content: string): string {
  writeFileSync(join(tree, "a.txt"), content);
  git(tree, "add", "a.txt");
  git(tree, "commit", "-q", "-m", content);
  return git(tree, "rev-parse", "HEAD");
}

/** A tree with an annotated `harness-0.5` on its first commit and `after` commits past it. */
function tree(opts: { tag?: boolean; after?: number } = {}): string {
  const dir = tempDir("wb-image-tag-");
  git(dir, "init", "-q", "-b", "master");
  commit(dir, "base\n");
  if (opts.tag !== false) git(dir, "tag", "-a", "harness-0.5", "-m", "harness 0.5");
  for (let i = 0; i < (opts.after ?? 0); i++) commit(dir, `change ${i}\n`);
  return dir;
}

function run(args: string[], cwd: string): { exitCode: number; out: string; err: string } {
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { exitCode: p.exitCode ?? -1, out: p.stdout.toString().trim(), err: p.stderr.toString() };
}

describe("image-tag.sh", () => {
  test("a commit past the tag describes as harness-0.5-<n>-g<sha>, series 0.5", () => {
    const dir = tree({ after: 2 });
    const head = git(dir, "rev-parse", "HEAD");
    const r = run([], dir);
    expect(r.exitCode).toBe(0);
    const m = /^harness-0\.5-2-g([0-9a-f]{7,})$/.exec(r.out);
    expect(m).not.toBeNull();
    expect(head.startsWith(m![1]!)).toBe(true);
    expect(harnessSeries(r.out)).toBe("0.5");
  });

  test("the tagged commit itself is the bare tag", () => {
    const r = run([], tree());
    expect(r.out).toBe("harness-0.5");
    expect(harnessSeries(r.out)).toBe("0.5");
  });

  test("--branch appends the branch's slug, past its prefix, and the series still reads 0.5", () => {
    const dir = tree({ after: 1 });
    const base = run([], dir).out;
    const r = run(["--branch", "feat/campaign-arms"], dir);
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe(`${base}-campaign-arms`);
    expect(r.out).toMatch(/^harness-0\.5-1-g[0-9a-f]{7,}-campaign-arms$/);
    expect(harnessSeries(r.out)).toBe("0.5");
  });

  test("the slug is lowercase a-z0-9 runs joined by single dashes, whatever the branch is spelled", () => {
    const dir = tree();
    const slug = (branch: string) => run(["--branch", branch], dir).out.replace(/^harness-0\.5-/, "");
    expect(slug("refs/heads/feat/Wake_On--Event")).toBe("wake-on-event");
    expect(slug("feat/a/b.c")).toBe("a-b-c");
    expect(slug("feat/-x-")).toBe("x");
    expect(slug("hotfix")).toBe("hotfix");
  });

  test("a long branch is cut to a 48-character slug with no trailing dash, well inside a registry tag's 128", () => {
    const dir = tree({ after: 1 });
    const long = `feat/${"abcdefghi-".repeat(10)}`;
    const r = run(["--branch", long], dir);
    const slug = r.out.replace(/^harness-0\.5-1-g[0-9a-f]+-/, "");
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
    expect(r.out.length).toBeLessThanOrEqual(128);
  });

  test("refuses a --branch that leaves no slug, before asking git anything", () => {
    for (const bad of ["feat/", "feat/---", "feat/_/"]) {
      const r = run(["--branch", bad], tempDir("wb-image-tag-bare-"));
      expect(r.exitCode).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toContain("leaves no slug");
    }
    expect(run(["--branch"], tree()).exitCode).toBe(2);
  });

  test("a changed tracked file appends -dirty; an untracked one does not", () => {
    const dir = tree({ after: 1 });
    writeFileSync(join(dir, "scratch.txt"), "untracked\n");
    expect(run([], dir).out).not.toContain("dirty");
    writeFileSync(join(dir, "a.txt"), "edited\n");
    const r = run([], dir);
    expect(r.out).toMatch(/^harness-0\.5-1-g[0-9a-f]{7,}-dirty$/);
    expect(harnessSeries(r.out)).toBe("0.5");
  });

  test("a staged change is dirty too", () => {
    const dir = tree({ after: 1 });
    writeFileSync(join(dir, "a.txt"), "staged\n");
    git(dir, "add", "a.txt");
    expect(run([], dir).out).toEndWith("-dirty");
  });

  test("a commit-ish describes that commit and is never -dirty", () => {
    const dir = tree({ after: 3 });
    const base = git(dir, "rev-parse", "HEAD~2");
    writeFileSync(join(dir, "a.txt"), "edited\n");
    const r = run([base], dir);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/^harness-0\.5-1-g[0-9a-f]{7,}$/);
    expect(base.startsWith(r.out.replace(/^.*-g/, ""))).toBe(true);
    expect(run(["--branch", "feat/x", base], dir).out).toBe(`${r.out}-x`);
  });

  test("-C reads another repository than the current directory", () => {
    const dir = tree({ after: 1 });
    const elsewhere = tempDir("wb-image-tag-cwd-");
    expect(run(["-C", dir], elsewhere).out).toBe(run([], dir).out);
  });

  test("no reachable tag falls back to a bare SHA, which names no series", () => {
    const dir = tree({ tag: false, after: 1 });
    const r = run([], dir);
    expect(r.exitCode).toBe(0);
    expect(git(dir, "rev-parse", "HEAD").startsWith(r.out)).toBe(true);
    expect(harnessSeries(r.out)).toBeNull();
  });

  test("outside a repository it prints no tag and fails", () => {
    const r = run([], tempDir("wb-image-tag-bare-"));
    expect(r.exitCode).toBe(1);
    expect(r.out).toBe("");
  });

  test("an unknown commit-ish fails rather than printing something else", () => {
    const r = run(["no-such-ref"], tree());
    expect(r.exitCode).toBe(1);
    expect(r.out).toBe("");
  });
});
