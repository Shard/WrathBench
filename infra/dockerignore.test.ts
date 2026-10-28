/**
 * The two ignore files keep env files out of a build context at any depth.
 *
 * build-images.sh builds from a git archive, where no env file exists, so these
 * lists are the backstop for a hand-run `docker build` from a checkout. They
 * are read with the matching rules of moby/patternmatcher, which BuildKit uses
 * for .dockerignore: `**` spans any number of directories, `*` stays within
 * one, a pattern that matches a parent directory excludes everything under it,
 * and a later `!` pattern re-includes. The rules below are that algorithm
 * (compile to a regexp, then test the path and each parent prefix), checked
 * against a real `docker build` with the same sample paths when they were
 * written.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

interface Pattern {
  re: RegExp;
  exclusion: boolean;
  dirs: number;
}

function compile(raw: string): RegExp {
  let re = "^";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "*") {
      if (raw[i + 1] === "*") {
        i++;
        if (raw[i + 1] === "/") i++;
        re += i + 1 >= raw.length ? ".*" : "(.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+()|{}$^".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`${re}$`);
}

function parse(file: string): Pattern[] {
  const out: Pattern[] = [];
  for (let line of readFileSync(join(REPO_ROOT, file), "utf8").split("\n")) {
    line = line.trim();
    if (line === "" || line.startsWith("#")) continue;
    const exclusion = line.startsWith("!");
    let p = exclusion ? line.slice(1).trim() : line;
    p = p.replace(/^\/+/, "").replace(/\/+$/, "");
    out.push({ re: compile(p), exclusion, dirs: p.split("/").length });
  }
  return out;
}

/** True when the path is left out of the context. */
function ignored(patterns: Pattern[], path: string): boolean {
  const parents = path.split("/").slice(0, -1);
  let matched = false;
  for (const pat of patterns) {
    if (pat.exclusion !== matched) continue;
    let m = pat.re.test(path);
    for (let i = 0; !m && i < parents.length; i++) m = pat.re.test(parents.slice(0, i + 1).join("/"));
    if (m) matched = !pat.exclusion;
  }
  return matched;
}

const ENV_FILES = [".env", ".env.local", ".env.prod", "runner/.env", "runner/src/.env.local", "deps/azerothcore/.env.x", "a/b/c/d/.env.test"];

describe("the runner image's ignore list", () => {
  const patterns = parse("infra/docker/runner.Dockerfile.dockerignore");

  test("leaves out env files at any depth", () => {
    for (const p of ENV_FILES) expect([p, ignored(patterns, p)]).toEqual([p, true]);
  });

  test("leaves out agent worktrees, wrangler state and data at any depth", () => {
    for (const p of [".claude/worktrees/agent-x/runner/src/a.ts", ".claude/settings.json", ".wrangler/state/x", "dashboard/.wrangler/tmp/a.js", "data/runs/r/run.sqlite", "wiki/data/x"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, true]);
    }
  });

  test("keeps the workspace it is made of", () => {
    for (const p of ["runner/src/env.ts", "sdk/src/index.ts", "mcp/src/index.ts", "infra/docker/runner.Dockerfile", "package.json", "bun.lock", "dashboard/src/App.tsx"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, false]);
    }
  });
});

describe("the server image's ignore list", () => {
  const patterns = parse(".dockerignore");

  test("leaves out env files at any depth", () => {
    for (const p of ENV_FILES) expect([p, ignored(patterns, p)]).toEqual([p, true]);
  });

  test("leaves out agent worktrees at any depth", () => {
    for (const p of [".claude/worktrees/agent-x/module/src/a.cpp", "deps/azerothcore/.claude/skills/x.md"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, true]);
    }
  });

  test("leaves out the TypeScript workspaces, which the server image is not made of", () => {
    for (const p of ["runner/src/run.ts", "sdk/src/index.ts", "mcp/src/index.ts", "wiki/src/bundle.ts"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, true]);
    }
  });

  test("keeps what server.Dockerfile copies", () => {
    for (const p of ["module/src/mod_wrathbench.cpp", "deps/azerothcore/src/server/apps/worldserver/Main.cpp", "deps/azerothcore/apps/docker/entrypoint.sh", "infra/docker/server.Dockerfile"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, false]);
    }
  });
});
