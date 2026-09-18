#!/usr/bin/env bun
/**
 * Park runs the listings should stop counting. Moving, never deleting.
 *
 *   bun runner/src/archive.ts --pre-series 0.4 [--release-paused] [--dry-run]
 *   bun runner/src/archive.ts --run-ids a,b,c [--release-paused] [--dry-run]
 *
 * `--pre-series X.Y` parks every run whose recorded harness version is not a
 * build of the `harness-X.Y` series: an older series,
 * or no `harness-` tag at all. The series is the comparability floor; a run
 * below it is history, not a row. Report directories and anything still live
 * are left alone.
 *
 * `--run-ids <comma-list-or-@file>` parks exactly the runs the operator names.
 * The floor is a rule about comparability; a named list is a judgement the
 * rule cannot make — that a freeplay ladder should show one live character per
 * model rather than every dead character that model ever rolled. Same held
 * guards, same `--release-paused`, same `--dry-run`; an id that names nothing
 * is reported rather than thrown, so a typo costs a line and not the run.
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
 * pass; `harness-0.3-…`, a bare commit hash or the untagged placeholder do not.
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
 * The one held test, shared by every planner. Null when the run may move.
 *
 * Ordering is the point: a `run.ts` process naming the run is never released,
 * because a process is the writer itself; the other two — warm files, a fleet
 * job log — are what `releasePaused` lifts for a run whose meta records a
 * pause and which nothing holds, since a supervisor that keeps retrying a
 * paused run rewrites its files every few minutes and the mtime test alone
 * would hold it forever.
 */
function heldReason(
  runId: string,
  dir: string,
  now: number,
  fleetHeld: ReadonlySet<string>,
  releasePaused: boolean,
): { held: true; reason: string } | null {
  if (processHoldsRun(runId)) return { held: true, reason: "a run.ts process names it" };
  const released = releasePaused && pausedInMeta(dir);
  const age = runActivityAge(dir, now);
  if (!released && age !== null && age < HELD_MS) {
    return { held: true, reason: `files written ${Math.round(age / 1000)}s ago — may still be live` };
  }
  if (!released && fleetHeld.has(runId)) {
    return { held: true, reason: "named by a fleet job log inside the last 10m" };
  }
  return null;
}

/**
 * Decide what would move under `--pre-series`. Pure reading.
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
    const held = heldReason(row.runId, dir, now, fleetHeld, releasePaused);
    if (held !== null) {
      plans.push({ runId: row.runId, ...held });
      continue;
    }
    const state = row.pauseReason !== null ? `paused (${row.pauseReason})` : (row.terminationReason ?? "no termination recorded");
    plans.push({ runId: row.runId, held: false, reason: `${row.harnessVersion ?? "unversioned"} is below harness-${series}, ${state}` });
  }
  return plans;
}

/** What `planRunIds` decided about a named list: what moves, what is held, what is not there. */
export interface RunIdPlan {
  plans: ArchivePlan[];
  /** Ids that named no run this CLI may move, each with why. */
  unknown: { runId: string; reason: string }[];
}

/**
 * Parse a `--run-ids` value: a comma-separated list, or `@path` to read one id
 * per line (blank lines and `#` comments skipped). Order is preserved and
 * duplicates are dropped — renaming the same directory twice would throw on
 * the second and read as a failure that never happened.
 */
export function parseRunIds(value: string): string[] {
  const text = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const id = raw.trim();
    if (id.length === 0 || id.startsWith("#")) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Decide what would move under `--run-ids`: the operator naming the runs
 * instead of a series floor deciding for them. The held guards are the same
 * three, in the same order — an operator's list is not a reason to move a
 * directory out from under a live writer.
 *
 * An id that names nothing this CLI may move is REPORTED, never thrown and
 * never silently skipped: a selector that swallows a typo would report
 * eighteen of nineteen as a success.
 */
export function planRunIds(runsDir: string, ids: readonly string[], now = Date.now(), releasePaused = false): RunIdPlan {
  const plans: ArchivePlan[] = [];
  const unknown: { runId: string; reason: string }[] = [];
  const fleetHeld = recentFleetRunIds(runsDir, now);
  const rows = new Map(listRuns(runsDir, now).map((r) => [r.runId, r]));
  for (const runId of ids) {
    const dir = runDir(runsDir, runId);
    if (dir === null) {
      const archived = existsSync(join(runsDir, ARCHIVE_DIR, runId));
      unknown.push({ runId, reason: archived ? "already under archive/" : `no run directory under ${runsDir}` });
      continue;
    }
    if (!existsSync(join(dir, "trajectory.jsonl"))) {
      unknown.push({ runId, reason: "no trajectory.jsonl — not a run directory" });
      continue;
    }
    const held = heldReason(runId, dir, now, fleetHeld, releasePaused);
    if (held !== null) {
      plans.push({ runId, ...held });
      continue;
    }
    const row = rows.get(runId);
    const state =
      row === undefined
        ? "named by the operator"
        : row.pauseReason !== null
          ? `paused (${row.pauseReason})`
          : (row.terminationReason ?? "no termination recorded");
    plans.push({ runId, held: false, reason: `named by the operator, ${state}` });
  }
  return { plans, unknown };
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
  const releasePaused = args.includes("--release-paused");
  const seriesAt = args.indexOf("--pre-series");
  const series = seriesAt >= 0 ? args[seriesAt + 1] : undefined;
  const idsAt = args.indexOf("--run-ids");
  const idsArg = idsAt >= 0 ? args[idsAt + 1] : undefined;
  const usage = (): never => {
    console.error(`usage: bun runner/src/archive.ts --pre-series X.Y [--release-paused] [--dry-run]`);
    console.error(`       bun runner/src/archive.ts --run-ids <id,id,...|@file> [--release-paused] [--dry-run]`);
    console.error(`moves runs below a harness series, or the runs you name, into <runs>/${ARCHIVE_DIR}/`);
    console.error(`(zero-response runs are archived by the runner itself, at termination)`);
    process.exit(2);
  };
  if ((series === undefined) === (idsArg === undefined)) usage();
  if (series !== undefined && !/^\d+\.\d+$/.test(series)) usage();
  const runsDir = process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
  if (!existsSync(runsDir)) {
    console.error(`no runs directory at ${runsDir} — run from the repo root, or set WRATHBENCH_RUNS_DIR.`);
    process.exit(2);
  }

  let plans: ArchivePlan[];
  let unknown: { runId: string; reason: string }[] = [];
  let what: string;
  if (series !== undefined) {
    plans = planPreSeries(runsDir, series, Date.now(), releasePaused);
    what = `below harness-${series}`;
  } else {
    const ids = parseRunIds(idsArg!);
    const planned = planRunIds(runsDir, ids, Date.now(), releasePaused);
    plans = planned.plans;
    unknown = planned.unknown;
    what = `named (${ids.length})`;
  }
  const movable = plans.filter((p) => !p.held);
  const held = plans.filter((p) => p.held);

  for (const p of movable) console.log(`${dryRun ? "would move" : "move"}  ${p.runId}  — ${p.reason}`);
  for (const p of held) console.log(`refuse    ${p.runId}  — ${p.reason}`);
  for (const u of unknown) console.log(`unknown   ${u.runId}  — ${u.reason}`);

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
    `${plans.length} ${what}: ${movable.length - failed} ${dryRun ? "would move" : "moved"}, ${held.length} held back` +
      `${unknown.length > 0 ? `, ${unknown.length} unknown` : ""}${failed > 0 ? `, ${failed} failed` : ""}`,
  );
}
