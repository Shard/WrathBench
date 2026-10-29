/**
 * Harness version stamp for run metadata. The 0.x series: runs are harness
 * validation, not results. `git describe` gives the honest marker;
 * outside a git checkout (or without git) the fallback says so explicitly.
 */

import { realpathSync } from "node:fs";
import { dirname } from "node:path";

export const HARNESS_VERSION_FALLBACK = "0.0.0-phase0-unversioned";

/**
 * `WRATHBENCH_HARNESS_VERSION` wins when set. The runner normally executes in
 * a container that has the repo mounted but no git binary and no `.git` write
 * access; `infra/run-episode.sh` computes `git describe` on the host and passes
 * it in, so containerised trajectories carry a real version instead of the
 * "unversioned" fallback.
 */
export function harnessVersion(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env["WRATHBENCH_HARNESS_VERSION"];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const proc = Bun.spawnSync(["git", "describe", "--tags", "--always", "--dirty"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) {
      const out = proc.stdout.toString().trim();
      if (out.length > 0) return `0.0.0-phase0+g${out}`;
    }
  } catch {
    // fall through
  }
  return HARNESS_VERSION_FALLBACK;
}

/**
 * The wrath-mcp commit the stack this process runs came from, for `meta.json`
 * beside `sdkVersion`: a label, outside the comparability tuple (operator
 * decision). `SDK_VERSION` moves on the stack's own cadence, so two
 * stack commits can share one; this names the commit.
 *
 * The submodule's own git first, so a checkout (compose's bind mount, a dev
 * worktree) stamps what it actually runs, `-dirty` when tracked files in it
 * differ from that commit. Only when `wrath-mcp/` is not a repository of its
 * own does the image's `WRATHBENCH_STACK_COMMIT` answer: build-images.sh bakes
 * the gitlink there, and an image has no `.git`. Undefined when neither knows.
 */
export function stackCommit(
  env: Record<string, string | undefined> = process.env,
  stackDir: string = stackRoot(),
): string | undefined {
  const git = (...args: string[]): string | null => {
    try {
      const p = Bun.spawnSync(["git", "-C", stackDir, ...args], { stdout: "pipe", stderr: "ignore" });
      return p.exitCode === 0 ? p.stdout.toString().trim() : null;
    } catch {
      return null;
    }
  };
  // A stack dir with no .git of its own sits inside some other repository's
  // tree (the superproject's, or an image's parent), whose HEAD is not the stack's.
  const top = git("rev-parse", "--show-toplevel");
  if (top !== null && realpathOrNull(top) === realpathOrNull(stackDir)) {
    const head = git("rev-parse", "HEAD");
    if (head !== null && /^[0-9a-f]{40}$/.test(head)) {
      const dirty = git("status", "--porcelain", "--untracked-files=no");
      return dirty === null || dirty.length === 0 ? head : `${head}-dirty`;
    }
  }
  const fromEnv = env["WRATHBENCH_STACK_COMMIT"]?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

/** The stack's checkout root: the directory above the resolved `@wrathbench/sdk` package. */
function stackRoot(): string {
  return dirname(dirname(Bun.resolveSync("@wrathbench/sdk/package.json", import.meta.dir)));
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
