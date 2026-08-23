/**
 * The archive directory, and the one record type a reader counts.
 *
 * Import-free by construction, like `api-types.ts`: the dashboard may want
 * these too, and nothing here may drag `bun:sqlite` into a browser bundle.
 */

/**
 * The trajectory record type that counts as a model response.
 *
 * One constant so the scanner, the archive CLI and any future reader cannot
 * disagree about what they are counting.
 */
export const MODEL_RESPONSE_RECORD = "response";

/**
 * Directory under the runs directory where archived runs are parked.
 *
 * It sits *inside* `data/runs/` so an operator finds it without being told
 * where it went, which means every enumeration of the runs directory has to
 * skip it by name — `listRuns`, `runDir`, `heldAccounts`, `readPositions`.
 * The viewer never reads what is in here.
 */
export const ARCHIVE_DIR = "archive";

/** True for the one directory name the viewer must never read as a run. */
export function isArchiveDir(name: string): boolean {
  return name === ARCHIVE_DIR;
}
