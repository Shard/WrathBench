/**
 * What "stillborn" means, in one place.
 *
 * A stillborn run never produced a single model response: the provider was
 * dead on the first request, the key was refused, the adapter threw before a
 * turn existed. It never got off the ground, and — this is the operator's
 * ruling — it never will. Such a run is not a short run; it is a launch that
 * did not happen, and counting it alongside real runs inflates every total the
 * dashboard shows.
 *
 * Two halves, and both are load-bearing:
 *
 * - **Zero `response` records.** `response` is the record the loop appends for
 *   the model's own turn (`loop.ts`, and the claude driver in
 *   `adapter-claude.ts`), so a run that answered once and called no tool has
 *   one and is *not* stillborn. `snippet` and `tool_call` records are
 *   deliberately not consulted: they are downstream of a response, and a run
 *   that produced output without acting still got off the ground.
 * - **Not live.** A run launched thirty seconds ago has no response *yet*.
 *   "Never will" is a claim about a run that is over, and `RunRow.live` — no
 *   termination row plus a trajectory that grew inside `LIVE_WINDOW_MS` — is
 *   the reading the viewer already trusts for that. Requiring a termination
 *   reason instead would be wrong in the common case: a killed process writes
 *   none, and those are exactly the runs this is meant to sweep up.
 *
 * Import-free by construction, like `api-types.ts`: the dashboard may want the
 * predicate too, and nothing here may drag `bun:sqlite` into a browser bundle.
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

/**
 * The definition. `modelResponses` is a count of `response` records, not of
 * turns: the claude driver appends one per content block of a single API reply
 * (see `adapter-claude.ts`), so the number over-counts turns and is only ever
 * read as zero-or-not.
 */
export function isStillborn(input: { modelResponses: number; live: boolean }): boolean {
  return input.modelResponses === 0 && !input.live;
}
