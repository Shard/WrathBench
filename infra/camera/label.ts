/**
 * The run label `camera: true` in meta.json (docs/METHODOLOGY.md, "Worlds":
 * a label, never part of the condition).
 *
 * The runner owns meta.json and writes the label itself, on its next rewrite
 * once the camera's frame index exists (runner/src/trajectory.ts `filmed`),
 * so a live run's meta.json is never written from here. These write it only
 * into a run with no live owner (sweep.ts): the same way the runner does (a
 * temporary file beside it, renamed into place), and not at all if the file
 * changed since it was read.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function hasCameraLabel(runDir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as { camera?: unknown }).camera === true;
  } catch {
    return false;
  }
}

/** One attempt: false when there is no meta.json to label. */
export function writeCameraLabel(runDir: string): boolean {
  const path = join(runDir, "meta.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const meta = JSON.parse(text) as Record<string, unknown>;
  if (meta["camera"] === true) return true;
  meta["camera"] = true;
  const tmp = `${path}.camera-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  // The last look before the rename, as move-credential's: a rewrite since our read is not clobbered.
  if (readFileSync(path, "utf8") !== text) {
    rmSync(tmp, { force: true });
    return false;
  }
  renameSync(tmp, path);
  return true;
}
