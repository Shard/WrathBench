#!/usr/bin/env bun
/**
 * Manually (re)classify a run's termination reason — chiefly
 * `environment-defect`, which no watchdog can detect (a broken quest
 * looks like a stuck model until a human reads the trajectory) — and the way
 * to end a verdict-less or paused run by hand, which releases the character it
 * pinned (`manual`: the release is a termination on the run's row).
 *
 *   bun runner/src/classify.ts [--force] <run-id> <reason> [note...]
 *
 * A run with neither a termination nor a pause may still be playing, and
 * ending it would write a verdict under a runner that is still writing its
 * own, so that is refused unless `--force` says the operator knows it is not.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { TERMINATION_REASONS, type TerminationReason } from "./config";
import { openRunDb } from "./rundb";
import { Trajectory } from "./trajectory";

/** Exit code for a run the guard would not classify: nothing was written. */
export const CLASSIFY_REFUSED_EXIT = 3;

/** What the run's own row says, read without writing: null when there is no such run. */
export function readVerdict(runsDir: string, runId: string): { terminationReason: string | null; pauseReason: string | null } | null {
  const dbPath = join(runsDir, runId, "run.sqlite");
  if (!existsSync(dbPath)) return null;
  const db = openRunDb(dbPath, { readonly: true });
  try {
    const row = db.query(`SELECT termination_reason, pause_reason FROM run WHERE run_id = ?`).get(runId) as {
      termination_reason?: unknown;
      pause_reason?: unknown;
    } | null;
    if (row === null) return null;
    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    return { terminationReason: str(row.termination_reason), pauseReason: str(row.pause_reason) };
  } finally {
    db.close();
  }
}

/**
 * Why classifying this run must not go ahead, or null. Pure. A run with no row
 * is refused whatever the flag (a mistyped id would otherwise become a new,
 * empty run directory); one with no termination and no pause is refused
 * unless forced, because it may be live.
 */
export function classifyRefusal(
  runId: string,
  verdict: { terminationReason: string | null; pauseReason: string | null } | null,
  force: boolean,
): string | null {
  if (verdict === null) return `no run ${runId}: no run.sqlite with its row under the runs directory`;
  if (verdict.terminationReason === null && verdict.pauseReason === null && !force) {
    return `${runId} has no termination and no pause, so it may still be live — stop it first, or pass --force if you know it is not`;
  }
  return null;
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const force = argv.includes("--force");
  const [runId, reason, ...note] = argv.filter((a) => a !== "--force");
  if (runId === undefined || reason === undefined || !TERMINATION_REASONS.includes(reason as TerminationReason)) {
    console.error(`usage: bun runner/src/classify.ts [--force] <run-id> <reason> [note]`);
    console.error(`reasons: ${TERMINATION_REASONS.join(", ")}`);
    process.exit(2);
  }
  const runsDir = process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
  const refusal = classifyRefusal(runId, readVerdict(runsDir, runId), force);
  if (refusal !== null) {
    console.error(`refused: ${refusal}`);
    process.exit(CLASSIFY_REFUSED_EXIT);
  }
  const trajectory = new Trajectory(join(runsDir, runId));
  const detail = note.length > 0 ? `manually classified: ${note.join(" ")}` : "manually classified";
  trajectory.setTermination(runId, reason as TerminationReason, detail);
  trajectory.close();
  console.log(`${runId} classified as ${reason}`);
}
