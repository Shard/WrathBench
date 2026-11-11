/**
 * The two ignore files keep env files out of a build context at any depth.
 *
 * build-images.sh builds from a git archive, where no env file exists, so these
 * lists are the backstop for a hand-run `docker build` from a checkout. They
 * are read with moby/patternmatcher's rules (dockerignore-match.ts).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ignored, parseDockerignore } from "./dockerignore-match";

const REPO_ROOT = join(import.meta.dir, "..");
const parse = (file: string) => parseDockerignore(join(REPO_ROOT, file));

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
    for (const p of ["runner/src/env.ts", "wrath-mcp/sdk/src/index.ts", "wrath-mcp/mcp/src/index.ts", "wrath-mcp/package.json", "wrath-mcp/tsconfig.base.json", "infra/docker/runner.Dockerfile", "package.json", "bun.lock", "dashboard/src/App.tsx"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, false]);
    }
  });

  test("leaves out the stack's C++ module, its git link and any install inside it", () => {
    for (const p of ["wrath-mcp/module/src/mod_wrathbench.cpp", "wrath-mcp/.git", "wrath-mcp/node_modules/zod/index.js", "wrath-mcp/sdk/node_modules/zod/index.js"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, true]);
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
    for (const p of ["runner/src/run.ts", "wrath-mcp/sdk/src/index.ts", "wrath-mcp/mcp/src/index.ts", "wiki/src/bundle.ts"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, true]);
    }
  });

  test("keeps what server.Dockerfile copies", () => {
    for (const p of ["wrath-mcp/module/src/mod_wrathbench.cpp", "deps/azerothcore/src/server/apps/worldserver/Main.cpp", "deps/azerothcore/apps/docker/entrypoint.sh", "infra/docker/server.Dockerfile"]) {
      expect([p, ignored(patterns, p)]).toEqual([p, false]);
    }
  });
});
