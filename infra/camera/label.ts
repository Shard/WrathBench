/**
 * The run label `camera: true` in meta.json (docs/METHODOLOGY.md, "Worlds":
 * a label, never part of the condition).
 *
 * The runner owns meta.json and rewrites it whole and atomically
 * (runner/src/trajectory.ts `writeMetaFile`); `writeMeta` carries `camera`
 * over from the file it replaces, as it does the verdict fields, so a
 * launch or a resume keeps the label. A read-modify-write of the runner's
 * (`updateMeta`) racing this one can still drop it, so the label is written
 * the same way (a temporary file beside it, renamed into place), read back
 * after a pause, and written again until it holds.
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

/** Label the run and confirm it held, a few times over. */
export async function labelRun(runDir: string, o: { attempts?: number; settleMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let i = 0; i < (o.attempts ?? 5); i++) {
    writeCameraLabel(runDir);
    await sleep(o.settleMs ?? 3_000);
    if (hasCameraLabel(runDir)) return true;
  }
  return false;
}
