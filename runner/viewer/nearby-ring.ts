/**
 * The ring of nearby units: the reads behind `/api/run/<id>/nearby` and the
 * position feed's `nearby` flag.
 *
 * The codec is `nearby.ts`, import-free so the dashboard can bundle it; the
 * rows come from the run's session source (`session-source.ts`): the `nearby`
 * stream of a v1 run's session record, or a 0.5 run's one-minute files.
 * Read-only like the rest of the viewer. The ring is judged by age as well
 * as by what is in it, so a run that was killed hard serves nothing stale.
 */

import type { NearbyWindow } from "./api-types";
import { NEARBY_SPAN_MAX_MS, emptyNearbyWindow, encodeNearby } from "./nearby";
import { sessionSource } from "./session-source";

/**
 * `GET /api/run/<id>/nearby?span=`: the last `spanMs` (at most the ring's
 * reach) as one window, keyed at `now − spanMs`, or at the ring's first key
 * when the ring is younger than that. A run with no ring answers an empty
 * window rather than an error: no units is a state, not a fault.
 */
export function readNearbyWindow(runsDir: string, runId: string, spanMs: number, now: number): NearbyWindow {
  const span = Math.max(0, Math.min(NEARBY_SPAN_MAX_MS, spanMs));
  const from = now - span;
  const rows = sessionSource(runsDir, runId).nearbyRows(from, now);
  if (rows.length === 0) return emptyNearbyWindow(runId, from);
  return encodeNearby(rows, { run: runId, from });
}

/** Whether the run's ring is being written: its newest file was touched within `NEARBY_FRESH_MS`. */
export function nearbyFresh(runsDir: string, runId: string, now: number): boolean {
  return sessionSource(runsDir, runId).nearbyFresh(now);
}
