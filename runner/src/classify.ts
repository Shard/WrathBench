#!/usr/bin/env bun
/**
 * Manually (re)classify a finished run's termination reason — chiefly
 * `environment-defect`, which no watchdog can detect (PHASE-0: a broken quest
 * looks like a stuck model until a human reads the trajectory).
 *
 *   bun runner/src/classify.ts <run-id> <reason> [note...]
 */

import { join } from "node:path";
import { TERMINATION_REASONS, type TerminationReason } from "./config";
import { Trajectory } from "./trajectory";

if (import.meta.main) {
  const [runId, reason, ...note] = Bun.argv.slice(2);
  if (runId === undefined || reason === undefined || !TERMINATION_REASONS.includes(reason as TerminationReason)) {
    console.error(`usage: bun runner/src/classify.ts <run-id> <reason> [note]`);
    console.error(`reasons: ${TERMINATION_REASONS.join(", ")}`);
    process.exit(2);
  }
  const runsDir = process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
  const trajectory = new Trajectory(join(runsDir, runId));
  const detail = note.length > 0 ? `manually classified: ${note.join(" ")}` : "manually classified";
  trajectory.setTermination(runId, reason as TerminationReason, detail);
  trajectory.close();
  console.log(`${runId} classified as ${reason}`);
}
