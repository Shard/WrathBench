/**
 * The runner image's build, read without docker: what its Dockerfiles copy
 * before `bun install`, and what infra/image-guard.sh would say about the files
 * the build context carries. Both failed only at `docker build` or at the guard
 * on a release build before these existed: a new workspace with no manifest
 * copied ahead of the frozen install, and a tracked source file whose name the
 * guard reads as a login file.
 *
 * Children get a bare environment, never this process's, which `bun test`
 * fills from the repository's .env.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ignored, parseDockerignore } from "./dockerignore-match";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const REPO_ROOT = join(import.meta.dir, "..");
const DOCKER_DIR = join(REPO_ROOT, "infra", "docker");
const GUARD = join(REPO_ROOT, "infra", "image-guard.sh");
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
const GIT_ENV = { ...BASE_ENV, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** A Dockerfile's instructions: continuations joined, comments and blank lines dropped. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (cur === "" && (line === "" || line.startsWith("#"))) continue;
    if (cur !== "" && line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      cur += `${line.slice(0, -1)} `;
      continue;
    }
    out.push((cur + line).trim());
    cur = "";
  }
  if (cur !== "") out.push(cur.trim());
  return out;
}

/** The sources of a COPY/ADD from the build context (none for `--from=`), without flags or the destination. */
function copySources(instruction: string): string[] {
  const words = instruction.split(/\s+/);
  if (!/^(COPY|ADD)$/i.test(words[0]!)) return [];
  const args = words.slice(1);
  if (args.some((a) => a.startsWith("--from="))) return [];
  return args.filter((a) => !a.startsWith("--")).slice(0, -1).map((s) => s.replace(/^\.\//, "").replace(/\/+$/, ""));
}

const WORKSPACES: string[] = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { workspaces: string[] }).workspaces;
const DOCKERFILES = readdirSync(DOCKER_DIR).filter((f) => f.endsWith(".Dockerfile"));

describe("a Dockerfile that installs the workspace", () => {
  test("the workspace list is plain paths this test can check", () => {
    expect(WORKSPACES.length).toBeGreaterThan(0);
    for (const ws of WORKSPACES) expect([ws, /[*?[{]/.test(ws)]).toEqual([ws, false]);
  });

  const installers = DOCKERFILES.filter((f) => instructions(readFileSync(join(DOCKER_DIR, f), "utf8")).some((i) => /^RUN\b.*\bbun install\b/.test(i)));

  test("there is one, so the checks below are never vacuous", () => {
    expect(installers).toContain("runner.Dockerfile");
  });

  for (const file of installers) {
    test(`${file} copies the lockfile and every workspace's manifest before \`bun install\`, and its ignore file keeps them`, () => {
      const steps = instructions(readFileSync(join(DOCKER_DIR, file), "utf8"));
      const install = steps.findIndex((i) => /^RUN\b.*\bbun install\b/.test(i));
      const copied = new Set(steps.slice(0, install).flatMap(copySources));
      // `--frozen-lockfile` resolves every workspace the lockfile names, so every one is needed,
      // whatever the image goes on to use; a whole-tree copy ahead of it would cover them all.
      const needed = ["package.json", "bun.lock", ...WORKSPACES.map((ws) => `${ws}/package.json`)];
      const missing = copied.has(".") ? [] : needed.filter((p) => !copied.has(p));
      expect(missing).toEqual([]);

      const own = join(DOCKER_DIR, `${file}.dockerignore`);
      const patterns = parseDockerignore(existsSync(own) ? own : join(REPO_ROOT, ".dockerignore"));
      expect(needed.filter((p) => ignored(patterns, p))).toEqual([]);
    });
  }
});

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
    const paths = logins.flatMap((b) => [`wrathbench/${b}`, `wrathbench/runner/src/${b}`, `home/bun/.config/x/${b}`, `root/${b}`]);
    const r = guard(paths);
    expect(r.flagged).toEqual(paths);
    expect(r.code).toBe(1);
  });

  test("names the rule refuses: a source file called credentials is one, so the runner's slot table is not", () => {
    expect(guard(["wrathbench/runner/src/credentials.ts"]).flagged).toEqual(["wrathbench/runner/src/credentials.ts"]);
    expect(guard(["wrathbench/runner/test/credentials.test.ts"]).flagged).toEqual(["wrathbench/runner/test/credentials.test.ts"]);
    expect(guard(["wrathbench/runner/src/credential-slots.ts", "wrathbench/runner/test/credential-slots.test.ts", "wrathbench/runner/src/move-credential.ts"]).flagged).toEqual([]);
  });
});
