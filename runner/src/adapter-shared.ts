/**
 * What the two CLI drivers do identically.
 *
 * `adapter-claude.ts` and `adapter-codex.ts` mirror each other invariant for
 * invariant and differ only where the CLIs do (runner/README.md, "The codex
 * driver"). Where the code is the same code, it lives here once, so a fix to
 * process teardown cannot land on one driver and miss the other.
 */

/**
 * Signal the CLI's whole process group, falling back to the process itself.
 *
 * The group is the point: the CLI spawns the MCP bridge, and killing only the
 * CLI leaves that grandchild reparented to init. `process.kill(-pid)` needs the
 * child to lead its own group, which is what `detached` buys.
 */
export function signalGroup(
  proc: { pid: number; kill: (sig: NodeJS.Signals) => void },
  sig: NodeJS.Signals,
): void {
  try {
    process.kill(-proc.pid, sig);
    return;
  } catch {
    // no such group (already reaped, or not detached): fall through
  }
  try {
    proc.kill(sig);
  } catch {
    // already gone
  }
}
