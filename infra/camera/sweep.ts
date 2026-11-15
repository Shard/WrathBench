/**
 * The camera's housekeeping over the runs tree, for runs no camera is
 * following any more (docs/RUNBOOK.md, "Camera"). A world per eval's pod is
 * removed at the verdict with no grace, so its director rarely gets to
 * assemble; a CronJob runs this every ten minutes instead. For each run with
 * a camera:
 *
 * - **label** an ended run `camera: true` in meta.json if the runner has not
 *   (`label.ts`; a paused or ownerless run may be resumed, and its meta.json
 *   rewritten, at any moment, so it is left to its runner);
 * - **assemble** its video when its frame index is newer than its clips.json
 *   (`assemble.ts`), a live run's at most hourly, and any run whose
 *   clips.json is not version 2. Only the open part is ever encoded again;
 * - **prune** still frames `--keep-hours` (24) after the assembly that covers
 *   them, live run or not (a live run's, that long after they were taken),
 *   but never a frame of the open part, which the next assembly encodes
 *   again, until the run has ended. The video is kept.
 *
 *   bun infra/camera/sweep.ts [<runs-dir>] [--interval-seconds 10] [--keep-hours 24]
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { assembleRun, previousDoc } from "./assemble";
import { hasCameraLabel, writeCameraLabel } from "./label";
import { CLIPS_FILE, FRAMES_DIR, FRAMES_INDEX, cameraDir, type ClipsFile } from "./layout";
import { notLive } from "./subjects";

/** How long still frames outlive the assembly that covers them (values.yaml `camera.frameKeepHours`). */
export const KEEP_FRAMES_HOURS = 24;
/** A live run's open part is encoded again at most this often: one part's encode and upload an hour. */
export const REFRESH_LIVE_MS = 3_600_000;

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
    const doc = clipsAt > 0 ? previousDoc(cam) : null;
    // A run no camera follows, once its frames are newer than its video; a
    // live one at most hourly; any run whose clips.json is not version 2.
    const due = (mtime(index) > clipsAt && (!live || now - clipsAt > refreshLive)) || (clipsAt > 0 && doc === null);
    let after = doc;
    if (due) {
      try {
        after = assemble(runDir);
        if (after !== null) out.assembled.push(runId);
      } catch (e) {
        log(`${runId}: assembly failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const covered = mtime(clips);
    const ended = meta?.termination != null;
    // The open part's frames are encoded again by the next assembly: kept until the run has ended.
    const openFrom = ended ? Number.POSITIVE_INFINITY : after === null ? Number.NEGATIVE_INFINITY : Date.parse(after.parts.at(-1)?.from ?? "") || Number.NEGATIVE_INFINITY;
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
      // In an assembly made after it was taken, before the open part (its
      // mtime is at or after its taking), and `keep` past it: for a run no
      // camera follows, past the assembly; for a live one, past its taking.
      if (at < covered && at < openFrom && (now - covered > keep || (live && now - at > keep))) {
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
