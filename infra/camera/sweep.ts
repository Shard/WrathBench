/**
 * The camera's housekeeping over the runs tree, for runs no camera is
 * following any more (docs/RUNBOOK.md, "Camera"). A world per eval's pod is
 * removed at the verdict with no grace, so its director rarely gets to
 * assemble; the shared world's director, which lives as long as the release,
 * runs this every ten minutes instead. For each run with a camera:
 *
 * - **label** an ended run `camera: true` in meta.json if the runner has not
 *   (`label.ts`; a paused or ownerless run may be resumed, and its meta.json
 *   rewritten, at any moment, so it is left to its runner);
 * - **assemble** its clips when its frame index is newer than its clips.json
 *   (`assemble.ts`; idempotent), and a live run's every twelve hours;
 * - **prune** still frames `--keep-hours` (24) after the assembly that covers
 *   them, live run or not (a live run's, that long after they were taken).
 *   The clips are kept, an event clip whose frames are gone stays listed, and
 *   a run whose frames are all pruned is not assembled again.
 *
 *   bun infra/camera/sweep.ts [<runs-dir>] [--interval-seconds 10] [--keep-hours 24]
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { assembleRun } from "./assemble";
import { hasCameraLabel, writeCameraLabel } from "./label";
import { CLIPS_FILE, FRAMES_DIR, FRAMES_INDEX, cameraDir, type ClipsFile } from "./layout";
import { notLive } from "./subjects";

/** How long still frames outlive the assembly that covers them (values.yaml `camera.frameKeepHours`). */
export const KEEP_FRAMES_HOURS = 24;
/** A live run's clips are rebuilt this often, so its frames are always in one before they go. */
export const REFRESH_LIVE_MS = 12 * 3_600_000;

export interface SweepOptions {
  intervalMs: number;
  keepFramesMs?: number;
  refreshLiveMs?: number;
  assemble?: (runDir: string) => ClipsFile | null;
  log?: (line: string) => void;
}

export interface SweepResult {
  labelled: string[];
  assembled: string[];
  prunedFrames: number;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function sweepCameraRuns(runsDir: string, now: number, o: SweepOptions): SweepResult {
  const log = o.log ?? (() => {});
  const keep = o.keepFramesMs ?? KEEP_FRAMES_HOURS * 3_600_000;
  const refreshLive = o.refreshLiveMs ?? REFRESH_LIVE_MS;
  const assemble = o.assemble ?? ((dir: string) => assembleRun(dir, { intervalMs: o.intervalMs, log }));
  const out: SweepResult = { labelled: [], assembled: [], prunedFrames: 0 };
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return out;
  }
  for (const runId of names) {
    const runDir = join(runsDir, runId);
    const cam = cameraDir(runDir);
    const index = join(cam, FRAMES_INDEX);
    if (!existsSync(index)) continue;
    let meta: Parameters<typeof notLive>[1] = null;
    try {
      meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    } catch {
      continue;
    }
    const live = notLive(runDir, meta, now) === null;
    // Only an ended run: a paused or ownerless one may be resumed, and its
    // runner rewrite meta.json, at any moment. The runner labels every run it
    // rewrites once the frame index exists, so this is only for a run that
    // ended within the camera's first minute.
    if (meta?.termination != null && !hasCameraLabel(runDir) && writeCameraLabel(runDir)) out.labelled.push(runId);
    const clips = join(cam, CLIPS_FILE);
    const clipsAt = mtime(clips);
    // A run no camera follows, once its frames are newer than its clips; a
    // live one twice a day, so every frame is in an assembly before it is pruned.
    const due = mtime(index) > clipsAt && (!live || now - clipsAt > refreshLive);
    if (due) {
      try {
        if (assemble(runDir) !== null) out.assembled.push(runId);
      } catch (e) {
        log(`${runId}: assembly failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const covered = mtime(clips);
    const frames = join(cam, FRAMES_DIR);
    let entries: string[] = [];
    try {
      entries = readdirSync(frames);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jpg")) continue;
      const p = join(frames, f);
      const at = mtime(p);
      // In an assembly made after it was taken, and `keep` past it: for a
      // run no camera follows, past its clips' assembly; for a live one,
      // past its own taking (its clips are rebuilt every twelve hours).
      if (at < covered && (now - covered > keep || (live && now - at > keep))) {
        rmSync(p, { force: true });
        out.prunedFrames++;
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? Number(args[i + 1]) : undefined;
  };
  const runsDir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]!.startsWith("--"))) ?? join("data", "runs");
  const r = sweepCameraRuns(runsDir, Date.now(), {
    intervalMs: (flag("--interval-seconds") ?? 10) * 1000,
    keepFramesMs: (flag("--keep-hours") ?? KEEP_FRAMES_HOURS) * 3_600_000,
    log: (l) => console.log(l),
  });
  console.log(`camera sweep: ${r.labelled.length} labelled, ${r.assembled.length} assembled, ${r.prunedFrames} frame(s) pruned`);
}
