/**
 * `stackCommit()`, the wrath-mcp commit stamped on meta.json beside
 * `sdkVersion`: the submodule's own git when it is a repository of its own,
 * the image's baked `WRATHBENCH_STACK_COMMIT` otherwise, and never the HEAD of
 * some enclosing repository.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stackCommit } from "../src/version";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const GIT_ENV = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function repo(): { dir: string; sha: string } {
  const dir = tempDir("wb-stack-commit-");
  git(dir, "init", "-q", "-b", "master");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "one");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

describe("stackCommit", () => {
  test("in this checkout, it is the wrath-mcp submodule's HEAD", () => {
    const head = Bun.spawnSync(["git", "-C", join(import.meta.dir, "..", "..", "wrath-mcp"), "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
    expect(stackCommit({})).toMatch(new RegExp(`^${head}(-dirty)?$`));
  });

  test("a repository of its own stamps its HEAD, -dirty with tracked edits, and wins over the image's value", () => {
    const { dir, sha } = repo();
    expect(stackCommit({ WRATHBENCH_STACK_COMMIT: "baked" }, dir)).toBe(sha);
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    expect(stackCommit({}, dir)).toBe(sha);
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect(stackCommit({}, dir)).toBe(`${sha}-dirty`);
  });

  test("a directory inside another repository is not that repository's commit: the image's value answers", () => {
    const { dir } = repo();
    const inner = join(dir, "wrath-mcp");
    mkdirSync(inner);
    expect(stackCommit({ WRATHBENCH_STACK_COMMIT: " abc123 " }, inner)).toBe("abc123");
    expect(stackCommit({}, inner)).toBeUndefined();
  });

  test("no repository and no baked value is not recorded", () => {
    expect(stackCommit({ WRATHBENCH_STACK_COMMIT: "" }, tempDir("wb-stack-commit-bare-"))).toBeUndefined();
  });
});
