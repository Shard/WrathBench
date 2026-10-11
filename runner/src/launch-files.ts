/**
 * Files a launcher writes into a run directory before the run itself exists:
 * a probe's `campaign.json` (`campaign-file.ts`) and a run pod's `image.json`
 * (`infra/run-pod.ts`). A directory holding nothing else is not a run — a
 * launch that failed before run.ts started leaves one behind — so the runner
 * and the roster treat it as free for a fresh launch, and the run listings
 * and the collector leave it out.
 *
 * Dependency-free, because the collector reads it too.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const LAUNCH_FILES: readonly string[] = ["campaign.json", "image.json"];

/** Whether a directory is absent or holds nothing but launch files. */
export function holdsOnlyLaunchFiles(dir: string): boolean {
  if (!existsSync(dir)) return true;
  // The common case answered without a listing: every run writes meta.json.
  if (existsSync(join(dir, "meta.json"))) return false;
  try {
    return readdirSync(dir).every((name) => LAUNCH_FILES.includes(name));
  } catch {
    return false;
  }
}
