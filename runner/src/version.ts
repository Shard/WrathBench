/**
 * Harness version stamp for run metadata. Phase 0 is 0.x: runs are harness
 * validation, not results. `git describe` gives the honest marker;
 * outside a git checkout (or without git) the fallback says so explicitly.
 */

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
