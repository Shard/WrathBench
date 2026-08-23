#!/usr/bin/env bun
/**
 * Park runs that never got off the ground.
 *
 *   bun runner/src/archive.ts --stillborn [--dry-run]
 *
 * A stillborn run produced zero model responses and is no longer live: the
 * provider was dead on the first request, the key was refused, the adapter
 * threw before a turn existed (`runner/viewer/stillborn.ts` holds the one
 * definition, and the viewer reads the same one). Such a run is not a short
 * run — it is a launch that did not happen — and leaving it in `data/runs`
 * makes every listing count launches instead of runs.
 *
 * Moving, never deleting. The directory goes to `data/runs/archive/<run-id>/`,
 * which the viewer skips by name, so the evidence survives and the dashboard
 * stops reading it. Nothing inside a run directory is touched.
 *
 * A run the fleet may still be holding is never moved, and says so. Two
 * signals, either of which is enough to refuse:
 *
 * - its own files were written inside `HELD_MS` (the one signal that always
 *   exists, and the reason it is the primary test);
 * - a fleet lane's jsonl named it inside the same window. `fleet-state.json`
 *   records lanes, not runs, so the lane logs are where a run id appears.
 *
 * Ten minutes rather than the viewer's two: a listing that is wrong for two
 * minutes redraws, where a directory moved out from under a live writer does
 * not come back.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { listRuns, runDir } from "../viewer/runs";
import { stillbornOf } from "../viewer/eval";
import { ARCHIVE_DIR } from "../viewer/stillborn";
import { scanRunTotals } from "../viewer/tail";

/** How recently a run must have been touched to count as possibly live. */
export const HELD_MS = 10 * 60_000;

/** Age of the most recently written artefact of a run, or null when it has none. */
export function runActivityAge(dir: string, now: number): number | null {
  let newest: number | null = null;
  for (const name of ["trajectory.jsonl", "run.sqlite", "meta.json", "scratchpad.md"]) {
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch {
      /* not written */
    }
  }
  return newest === null ? null : now - newest;
}

/**
 * Run ids a fleet lane mentioned inside the window.
 *
 * The supervisor's own state file records lanes — pid, account, roster — and
 * never a run id, so the lane jsonl (one record per launch decision) is the
 * only place the fleet names a run. Only recent records count: a lane log
 * holds every run the lane ever started.
 */
export function recentFleetRunIds(runsDir: string, now: number, windowMs = HELD_MS): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(runsDir).filter((n) => n.startsWith("fleet-") && n.endsWith(".jsonl"));
  } catch {
    return out;
  }
  for (const name of names) {
    let text: string;
    try {
      const path = join(runsDir, name);
      // A lane log that has not been written in the window cannot hold a
      // record inside it; skipping saves reading every log of every past night.
      if (now - statSync(path).mtimeMs > windowMs) continue;
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const rec = JSON.parse(line) as { ts?: unknown; runId?: unknown };
        if (typeof rec.runId !== "string" || typeof rec.ts !== "number") continue;
        if (now - rec.ts <= windowMs) out.add(rec.runId);
      } catch {
        /* a half-written line names nothing */
      }
    }
  }
  return out;
}

export interface ArchivePlan {
  runId: string;
  /** Why it is being moved, or why it is being refused. */
  reason: string;
  /** True when the run is (or may be) live and must not be moved. */
  held: boolean;
}

/**
 * Decide what would move. Pure reading — the caller does the moving, so
 * `--dry-run` and the real thing cannot disagree about the plan.
 */
export async function planStillborn(runsDir: string, now = Date.now()): Promise<ArchivePlan[]> {
  const plans: ArchivePlan[] = [];
  const fleetHeld = recentFleetRunIds(runsDir, now);
  for (const row of listRuns(runsDir, now)) {
    const dir = runDir(runsDir, row.runId);
    if (dir === null) continue;
    const path = join(dir, "trajectory.jsonl");
    // No trajectory at all is not a claim that a run produced nothing: it is a
    // directory that was never a run (a report folder, say). Left alone.
    if (!existsSync(path)) continue;
    const totals = await scanRunTotals(path);
    if (!stillbornOf(row, totals.modelResponses)) continue;

    const age = runActivityAge(dir, now);
    if (age !== null && age < HELD_MS) {
      plans.push({
        runId: row.runId,
        held: true,
        reason: `files written ${Math.round(age / 1000)}s ago — may still be live`,
      });
      continue;
    }
    if (fleetHeld.has(row.runId)) {
      plans.push({ runId: row.runId, held: true, reason: "named by a fleet lane inside the last 10m" });
      continue;
    }
    const ended = row.terminationReason ?? "no termination recorded";
    // The driver is on the line because the definition is a claim about a
    // driver's records: an operator reading a list of eighty runs should be
    // able to see at a glance that they are not all one scaffold's.
    const driver = row.shakeout !== null ? `${row.driver ?? "?"}/shakeout` : (row.driver ?? "?");
    plans.push({
      runId: row.runId,
      held: false,
      reason: `0 model responses, ${row.model ?? "unknown model"} via ${driver}, ${ended}`,
    });
  }
  return plans;
}

/** Move one run directory under `archive/`. Never overwrites. */
export function archiveRun(runsDir: string, runId: string): string {
  const from = join(runsDir, runId);
  const root = join(runsDir, ARCHIVE_DIR);
  mkdirSync(root, { recursive: true });
  const to = join(root, runId);
  if (existsSync(to)) throw new Error(`already archived: ${to}`);
  renameSync(from, to);
  return to;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  if (!args.includes("--stillborn")) {
    console.error(`usage: bun runner/src/archive.ts --stillborn [--dry-run]`);
    console.error(`moves runs with zero model responses into <runs>/${ARCHIVE_DIR}/`);
    process.exit(2);
  }
  const runsDir = process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
  if (!existsSync(runsDir)) {
    console.error(`no runs directory at ${runsDir} — run from the repo root, or set WRATHBENCH_RUNS_DIR.`);
    process.exit(2);
  }
  const plans = await planStillborn(runsDir);
  const movable = plans.filter((p) => !p.held);
  const held = plans.filter((p) => p.held);

  for (const p of movable) console.log(`${dryRun ? "would move" : "move"}  ${p.runId}  — ${p.reason}`);
  for (const p of held) console.log(`refuse    ${p.runId}  — ${p.reason}`);

  if (!dryRun) {
    for (const p of movable) {
      try {
        console.log(`archived  ${p.runId} -> ${archiveRun(runsDir, p.runId)}`);
      } catch (err) {
        console.error(`failed    ${p.runId} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log(
    `${plans.length} stillborn: ${movable.length} ${dryRun ? "would move" : "moved"}, ${held.length} held back`,
  );
}
