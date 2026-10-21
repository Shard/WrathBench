/**
 * A party's end, handed to a member's runner: the roster asks it to end on
 * another member's end reason (`infra/party-fate.ts`) rather than signalling
 * it, so the member ends the way its own end would end it — the watchdog
 * verdict, the driver's wind-down, the CLI's closing `result` with its cost
 * and tokens — and not as a SIGTERM pause the roster rewrites afterwards,
 * which kills the CLI at once and loses all three.
 *
 * The channel is one file in the run directory, `end-request.json`, because
 * the run directory is the one thing a child process and a run pod both share
 * with the roster (docs/ARCHITECTURE.md, "the run contract"): SIGTERM already
 * means pause, SIGINT `manual`, and a pod can only be deleted. The runner
 * polls for it (`watchEndRequest`) and latches it into its watchdogs
 * (`Watchdogs.noteEndRequest`); every driver already ends on a watchdog
 * verdict. A harness that ignores the file is stopped by the roster's usual
 * SIGTERM once the grace for a wind-down has passed, and ended as before.
 *
 * Only an end reason (`level-target`, `kill-target`) travels this way, with
 * the detail the party machine writes (`<member>: <reason>`): the verdict and
 * its detail are exactly what the roster would otherwise write itself.
 * Import-light (zod and node:fs) so the roster can write it.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { END_REASONS, type EndReason } from "./end-conditions";

export const END_REQUEST_FILE = "end-request.json";

/** How often a runner looks for the file: well inside a state tick, and a stat is all it costs. */
export const END_REQUEST_POLL_MS = 2_000;

/**
 * How long the roster waits for a member it asked to end before stopping it
 * (`PartyFateDeps.endGraceMs`): the poll, a state tick for the check that
 * acts on it (`DEFAULT_STATE_TICK_MS`, 5 s), a whole wind-down (each agentic
 * driver's `DEFAULT_WIND_DOWN_GRACE_MS`, 90 s), the CLI's SIGTERM grace (5 s)
 * and the session release after it. A fixed-loop member ends at its next
 * turn boundary; one that has not by then is stopped as before.
 */
export const PARTY_END_GRACE_MS = 120_000;

const endRequestSchema = z
  .object({
    reason: z.enum(END_REASONS),
    detail: z.string().min(1),
    /** When the roster wrote it (epoch ms). */
    at: z.number().int().nonnegative(),
  })
  .strict();
export type EndRequest = z.infer<typeof endRequestSchema>;

/** Write the request where the member's runner will find it; whole or not at all. */
export function writeEndRequest(runDir: string, req: { reason: EndReason; detail: string; at?: number }): void {
  const body: EndRequest = { reason: req.reason, detail: req.detail, at: req.at ?? Date.now() };
  const path = join(runDir, END_REQUEST_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, "utf8");
  renameSync(tmp, path);
}

/** The request in a run directory, or null: none, unreadable, or not one this runner honours. */
export function readEndRequest(runDir: string): EndRequest | null {
  const path = join(runDir, END_REQUEST_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = endRequestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Poll the run directory and hand the first request written at or after
 * `since` (this process segment's start: a request left from an earlier
 * segment is not this one's) to `onRequest`, once. Unref'd; the returned stop
 * must be called when the episode ends.
 */
export function watchEndRequest(o: {
  runDir: string;
  since: number;
  onRequest: (req: EndRequest) => void;
  intervalMs?: number;
}): () => void {
  let done = false;
  const look = (): void => {
    if (done) return;
    const req = readEndRequest(o.runDir);
    if (req === null || req.at < o.since) return;
    done = true;
    clearInterval(timer);
    o.onRequest(req);
  };
  const timer = setInterval(look, o.intervalMs ?? END_REQUEST_POLL_MS);
  timer.unref?.();
  return () => {
    done = true;
    clearInterval(timer);
  };
}
