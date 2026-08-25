#!/usr/bin/env bun
/**
 * Park runs the listings should stop counting. Moving, never deleting.
 *
 *   bun runner/src/archive.ts --pre-series 0.4 [--release-paused] [--dry-run]
 *
 * `--pre-series X.Y` parks every run whose recorded harness version is not a
 * build of the `harness-X.Y` series: an older series,
 * or no `harness-` tag at all. The series is the comparability floor; a run
 * below it is history, not a row. Report directories and anything still live
 * are left alone.
 *
 * There is no zero-response mode any more. A run that terminates without a
 * single model response is archived **by the runner itself**, at termination
 * (`archiveIfNoResponses`, called from `run.ts`): a launch that did not happen
 * never reaches a listing in the first place, so nothing has to sweep it up
 * afterwards. The old `--stillborn` sweep could not tell a terminated
 * zero-response run from a *paused* one — every zero-response directory on
 * disk when it was removed was a resumable paused run — and that is precisely
 * the distinction the in-process check has for free.
 *
 * Moving, never deleting. The directory goes to `data/runs/archive/<run-id>/`,
 * which the viewer skips by name, so the evidence survives and the dashboard
 * stops reading it. The scheduler's projection still reads it
 * (`readRunFacts`, `includeArchived`): the defer ladder is fed by launches
 * that did not happen, and attempt numbers must stay unique on disk.
 *
 * A run the fleet may still be holding is never moved by the CLI, and says so.
 * Two signals, either of which is enough to refuse:
 *
 * - its own files were written inside `HELD_MS` (the one signal that always
 *   exists, and the reason it is the primary test);
 * - a fleet job's jsonl named it inside the same window. `fleet-state.json`
 *   records jobs, not runs, so the job logs are where a run id appears.
 *
 * Ten minutes rather than the viewer's two: a listing that is wrong for two
 * minutes redraws, where a directory moved out from under a live writer does
 * not come back. The runner's own call skips those guards on purpose — it is
 * the writer, and it has just stopped writing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { listRuns, runDir } from "../viewer/runs";
import { ARCHIVE_DIR } from "../viewer/archive-dir";
import { countModelResponses } from "./models";

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
 * Run ids a fleet job mentioned inside the window.
 *
 * The supervisor's own state file records jobs — pid, account, roster — and
 * never a run id, so the job jsonl (one record per launch decision) is the
 * only place the fleet names a run. Only recent records count: a job log
 * holds every run the job ever started.
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
      // A job log that has not been written in the window cannot hold a
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
 * Whether a recorded harness version belongs to the given series. The series
 * is what groups results, so a `-dirty` build of it still counts:
 * `harness-0.4`, `harness-0.4-25-g1fe3951`, `harness-0.4-25-g1fe3951-dirty`
 * pass; `harness-0.3-…`, a bare commit hash or the phase-0 placeholder do not.
 */
export function inSeries(version: string | null, series: string): boolean {
  if (version === null) return false;
  const esc = series.replace(/\./g, "\\.");
  return new RegExp(`^harness-${esc}(?:$|-)`).test(version);
}

/**
 * Whether some process on this host names the run on its command line — a
 * `run.ts --resume <id>` or `--run-id <id>`. Host-side only (`/proc`); inside
 * a container it sees that container's processes, which is the same answer
 * when the archive runs where the runner does.
 */
export function processHoldsRun(runId: string): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return false;
  }
  for (const pid of pids) {
    try {
      const args = readFileSync(join("/proc", pid, "cmdline"), "utf8").split("\0");
      if (args.includes(runId) && args.some((a) => a.endsWith("run.ts"))) return true;
    } catch {
      /* gone, or not ours to read */
    }
  }
  return false;
}

/** Whether meta.json records a pause — the run is parked, not being written. */
function pausedInMeta(dir: string): boolean {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { pause?: unknown };
    return meta.pause !== null && typeof meta.pause === "object";
  } catch {
    return false;
  }
}

/**
 * Decide what would move under `--pre-series`. Pure reading, like `planStillborn`.
 *
 * `releasePaused` lets a run through the activity hold when its meta records a
 * pause and no process names it: a supervisor that keeps retrying a paused
 * run rewrites its files every few minutes, so the mtime test alone would
 * hold it forever, and "paused with nobody holding it" is exactly the run the
 * floor is meant to park.
 */
export function planPreSeries(runsDir: string, series: string, now = Date.now(), releasePaused = false): ArchivePlan[] {
  const plans: ArchivePlan[] = [];
  const fleetHeld = recentFleetRunIds(runsDir, now);
  for (const row of listRuns(runsDir, now)) {
    const dir = runDir(runsDir, row.runId);
    if (dir === null) continue;
    // A directory without a trajectory was never a run (a report folder, say).
    if (!existsSync(join(dir, "trajectory.jsonl"))) continue;
    if (inSeries(row.harnessVersion, series)) continue;
    const age = runActivityAge(dir, now);
    const released = releasePaused && pausedInMeta(dir) && !processHoldsRun(row.runId);
    if (processHoldsRun(row.runId)) {
      plans.push({ runId: row.runId, held: true, reason: "a run.ts process names it" });
      continue;
    }
    if (!released && age !== null && age < HELD_MS) {
      plans.push({ runId: row.runId, held: true, reason: `files written ${Math.round(age / 1000)}s ago — may still be live` });
      continue;
    }
    if (!released && fleetHeld.has(row.runId)) {
      plans.push({ runId: row.runId, held: true, reason: "named by a fleet job log inside the last 10m" });
      continue;
    }
    const state = row.pauseReason !== null ? `paused (${row.pauseReason})` : (row.terminationReason ?? "no termination recorded");
    plans.push({ runId: row.runId, held: false, reason: `${row.harnessVersion ?? "unversioned"} is below harness-${series}, ${state}` });
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

/**
 * Archive a run that produced no model response, called by the runner as it
 * terminates. Returns the new path, or null when the run answered at least
 * once (or its trajectory could not be read — a claim that nothing happened
 * has to rest on having looked).
 *
 * The caller decides *when*: only after a termination row is written, and
 * never for a pause. A paused run with no response yet is a launch still in
 * progress — it is resumed, not buried.
 */
export function archiveIfNoResponses(runsDir: string, runId: string): string | null {
  const n = countModelResponses(join(runsDir, runId, "trajectory.jsonl"));
  if (n === null || n > 0) return null;
  return archiveRun(runsDir, runId);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const seriesAt = args.indexOf("--pre-series");
  const series = seriesAt >= 0 ? args[seriesAt + 1] : undefined;
  if (series === undefined || !/^\d+\.\d+$/.test(series)) {
    console.error(`usage: bun runner/src/archive.ts --pre-series X.Y [--release-paused] [--dry-run]`);
    console.error(`moves runs below a harness series into <runs>/${ARCHIVE_DIR}/`);
    console.error(`(zero-response runs are archived by the runner itself, at termination)`);
    process.exit(2);
  }
  const runsDir = process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
  if (!existsSync(runsDir)) {
    console.error(`no runs directory at ${runsDir} — run from the repo root, or set WRATHBENCH_RUNS_DIR.`);
    process.exit(2);
  }
  const plans = planPreSeries(runsDir, series, Date.now(), args.includes("--release-paused"));
  const what = `below harness-${series}`;
  const movable = plans.filter((p) => !p.held);
  const held = plans.filter((p) => p.held);

  for (const p of movable) console.log(`${dryRun ? "would move" : "move"}  ${p.runId}  — ${p.reason}`);
  for (const p of held) console.log(`refuse    ${p.runId}  — ${p.reason}`);

  let failed = 0;
  if (!dryRun) {
    for (const p of movable) {
      try {
        console.log(`archived  ${p.runId} -> ${archiveRun(runsDir, p.runId)}`);
      } catch (err) {
        failed += 1;
        console.error(`failed    ${p.runId} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log(
    `${plans.length} ${what}: ${movable.length - failed} ${dryRun ? "would move" : "moved"}, ${held.length} held back${failed > 0 ? `, ${failed} failed` : ""}`,
  );
}
