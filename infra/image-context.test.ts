/**
 * The runner image's build context, read without docker: what
 * infra/image-guard.sh would say about the files it carries. This failed only
 * at the guard on a release build before it existed: a tracked source file
 * whose name the guard reads as a login file.
 *
 * Children get a bare environment, never this process's, which `bun test`
 * fills from the repository's .env.
 */
import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { ignored, parseDockerignore } from "./dockerignore-match";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const REPO_ROOT = join(import.meta.dir, "..");
const DOCKER_DIR = join(REPO_ROOT, "infra", "docker");
const GUARD = join(REPO_ROOT, "infra", "image-guard.sh");
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const GIT_ENV = { ...BASE_ENV, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** Tracked files of a checkout, without submodule links (`ls-files -s` mode 160000). */
function trackedFiles(cwd: string): string[] {
  return git(cwd, "ls-files", "-s", "-z")
    .split("\0")
    .filter(Boolean)
    .filter((e) => !e.startsWith("160000 "))
    .map((e) => e.slice(e.indexOf("\t") + 1));
}

/**
 * The guard's matcher over tar-style paths. `root` holds the image's paths, so
 * an `.npmrc` among them is read for a token rather than refused unread.
 */
function guard(paths: string[], root?: string): { code: number; flagged: string[] } {
  const proc = Bun.spawnSync(["bash", GUARD, "--paths", ...(root !== undefined ? ["--root", root] : [])], {
    stdin: new TextEncoder().encode(`${paths.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
    env: BASE_ENV,
  });
  return { code: proc.exitCode ?? -1, flagged: proc.stdout.toString().split("\n").filter(Boolean) };
}

describe("the image guard and the runner's build context", () => {
  test("passes every tracked file the context carries, at its place under /wrathbench", () => {
    // build-images.sh's context: a git archive of the commit, plus the wrath-mcp stack exported
    // whole at the commit it pins (the reference program is private and gitignored, so not here),
    // then the runner's ignore list. The runner Dockerfile copies the context to /wrathbench.
    const files = [...trackedFiles(REPO_ROOT), ...trackedFiles(join(REPO_ROOT, "wrath-mcp")).map((p) => `wrath-mcp/${p}`)];
    const patterns = parseDockerignore(join(DOCKER_DIR, "runner.Dockerfile.dockerignore"));
    const context = files.filter((p) => !ignored(patterns, p));
    expect(context).toContain("runner/src/run.ts");
    expect(context).toContain("wrath-mcp/sdk/package.json");
    const root = tempDir("wb-image-context-");
    symlinkSync(REPO_ROOT, join(root, "wrathbench"));
    const r = guard(
      context.map((p) => `wrathbench/${p}`),
      root,
    );
    expect(r.flagged).toEqual([]);
    expect(r.code).toBe(0);
  });

  test("still refuses every real login file, wherever it lies, by the name the tool gives it", () => {
    const logins = [
      ".credentials.json", // Claude Code
      "credentials", // AWS, and the bare name others use
      "credentials.json", // gcloud and service-account keys
      "credentials.db", // gcloud's credential store
      ".git-credentials", // git's credential store
      "auth.json", // the Codex CLI
    ];
    const paths = logins.flatMap((b) => [`wrathbench/${b}`, `wrathbench/runner/src/${b}`, `home/bun/.config/x/${b}`, `home/bun/.codex/${b}`, `root/${b}`]);
    const r = guard(paths);
    expect(r.flagged).toEqual(paths);
    expect(r.code).toBe(1);
  });
});
