/**
 * The viewer's session-side reads of one run, by run id: the inspector's
 * readout (`@wrathbench/inspector`) over the run's session
 * (`runner/viewer/runs-source.ts`), as the API makes them. For tests that
 * ask one question of one run without going through a route.
 */

import { closedWindowsMemo, nearbyFresh as freshOf, nearbyWindow, recentTrace, traceChat, traceIndex, traceSegment, type TrackTrace } from "@wrathbench/inspector";
import type { TraceChatKind } from "@wrathbench/inspector/wire";
import { isV1Run, runSession } from "../../viewer/runs-source";

/** Which reader a run is read through: its v1 session record, or the 0.5 adapter. */
export const sessionKind = (runsDir: string, runId: string): "v1" | "legacy-0.5" => (isV1Run(runsDir, runId) ? "v1" : "legacy-0.5");

export const readTraceIndex = (runsDir: string, runId: string, now: number) => traceIndex(runSession(runsDir, runId), now);
export const readTraceSegment = (runsDir: string, runId: string, t0: number, now: number) => traceSegment(runSession(runsDir, runId), t0, now);
export const readPositionTrace = (runsDir: string, runId: string, now: number) => recentTrace(runSession(runsDir, runId), now);
export const readTraceChat = (runsDir: string, runId: string, kind: TraceChatKind) => traceChat(runSession(runsDir, runId), kind);
export const readNearbyWindow = (runsDir: string, runId: string, spanMs: number, now: number) => nearbyWindow(runSession(runsDir, runId), spanMs, now);
export const nearbyFresh = (runsDir: string, runId: string, now: number) => freshOf(runSession(runsDir, runId), now);

/** The track's closed-window list, memoised as the API memoises it. */
export function traceSegsMemo(): (runsDir: string, runId: string, now: number) => Promise<TrackTrace | null> {
  const memo = closedWindowsMemo();
  return (runsDir, runId, now) => memo(`${runsDir}\0${runId}`, runSession(runsDir, runId), now);
}
