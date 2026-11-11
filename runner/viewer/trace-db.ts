/**
 * The trace's server half: the reads behind `/api/run/<id>/trace`, its
 * segments, the track's window list and the position feed's tail.
 *
 * The codec is `trace.ts`, import-free so the dashboard can bundle it. The
 * rows come from the run's session source (`session-source.ts`): a v1 run's
 * session record, or a 0.5 run's `run.sqlite`. A run with no trace at all
 * reads as none, never as an error.
 *
 * Every read is a range: a segment's window plus its `CONTEXT_MS` lead, or
 * the feed's last few windows.
 */

import type { PositionTrace, TraceChatKind, TraceIndexResponse, TraceSegment, TrackTrace } from "./api-types";
import { sessionSource } from "./session-source";
import {
  CONTEXT_MS,
  SEG_MS,
  encodeSegment,
  isClosed,
  packSegs,
  tailStart,
  windowOf,
  type TraceDictLookup,
  type TraceRow,
} from "./trace";

/** How many closed windows the position feed names, newest last. */
export const RECENT_WINDOWS = 3;

/**
 * The tail: everything after the last closed window, encoded so far.
 *
 * It starts at the first window that is not closed and ends with the current
 * one, so for `SETTLE_MS` after a boundary it spans two windows — the one that
 * just ended and is still settling, and the one that just began. Without that,
 * the window that just ended would be in neither the closed list nor the tail
 * until it settled, and a reader would have a five-minute hole. Null when no
 * row has landed since the last closed window.
 */
function tailOf(rows: readonly TraceRow[], runId: string, now: number, dict: TraceDictLookup | undefined): TraceSegment | null {
  const t0 = tailStart(now);
  if (!rows.some((r) => r.ts >= t0)) return null;
  return encodeSegment(rows, { run: runId, t0, t1: windowOf(now) + SEG_MS }, dict);
}

/** `GET /api/run/<id>/trace`: the closed windows that have rows, and the tail. */
export function readTraceIndex(runsDir: string, runId: string, now: number): TraceIndexResponse {
  const empty: TraceIndexResponse = { segMs: SEG_MS, segs: [], tail: null, now };
  const source = sessionSource(runsDir, runId);
  const start = tailStart(now);
  return source.withTrace(start - CONTEXT_MS, Infinity, empty, (rows, dict) => {
    const windows = source.traceWindowsBefore(start);
    if (windows === null) return empty;
    return { segMs: SEG_MS, segs: packSegs(windows), tail: tailOf(rows, runId, now, dict), now };
  });
}

/**
 * `GET /api/run/<id>/trace/<t0>`: one window, or null when it has no rows of
 * its own. `closed` says whether the answer can never change, the caller's
 * cue for an immutable cache header; a window still open or settling is
 * served as it stands so far.
 */
export function readTraceSegment(
  runsDir: string,
  runId: string,
  t0: number,
  now: number,
): { segment: TraceSegment; closed: boolean } | null {
  const t1 = t0 + SEG_MS;
  return sessionSource(runsDir, runId).withTrace<{ segment: TraceSegment; closed: boolean } | null>(t0 - CONTEXT_MS, t1, null, (rows, dict) => {
    if (!rows.some((r) => r.ts >= t0)) return null;
    return { segment: encodeSegment(rows, { run: runId, t0, t1 }, dict), closed: isClosed(t0, now) };
  });
}

/**
 * A live agent's trace for the position feed, in one range read: the windows
 * of the tail's context (`CONTEXT_MS`, the same three the index's tail reads,
 * so the two tails are one encoding) and the tail itself. Null when there is
 * nothing in that range, which leaves the field off the position.
 */
export function readPositionTrace(runsDir: string, runId: string, now: number): PositionTrace | null {
  const start = tailStart(now);
  return sessionSource(runsDir, runId).withTrace<PositionTrace | null>(start - CONTEXT_MS, Infinity, null, (rows, dict) => {
    const recent = [...new Set(rows.filter((r) => r.ts < start).map((r) => windowOf(r.ts)))].sort((a, b) => a - b);
    const tail = tailOf(rows, runId, now, dict);
    if (recent.length === 0 && tail === null) return null;
    return { segMs: SEG_MS, recent: recent.slice(-RECENT_WINDOWS), tail };
  });
}

/**
 * The closed-window list a track carries, memoised per run on two numbers
 * that move whenever its trace is written (`SessionSource.traceStat`).
 *
 * The publisher asks every run's track on every pass, and almost every run is
 * finished: without this, each pass opens every run in the tree to learn
 * again that it has no trace, or the same windows it had. An entry is reused
 * while the stat is unchanged and either the run's rows all fell in windows
 * already closed when it was read (then nothing but a write can change the
 * answer) or the tail has not moved since. A few numbers per run, so
 * `ApiHandle.release` leaves it alone: releasing it would cost a streaming
 * pass exactly the opens it exists to save.
 */
export function traceSegsMemo(): (runsDir: string, runId: string, now: number) => TrackTrace | null {
  const memo = new Map<string, { size: number; mtimeMs: number; start: number; final: boolean; value: TrackTrace | null }>();
  return (runsDir, runId, now) => {
    const key = `${runsDir}\0${runId}`;
    const source = sessionSource(runsDir, runId);
    const st = source.traceStat();
    if (st === null) {
      memo.delete(key);
      return null;
    }
    const start = tailStart(now);
    const hit = memo.get(key);
    if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs && (hit.final || hit.start === start)) return hit.value;
    // A read that failed is answered and forgotten, never remembered as "no trace".
    const windows = source.traceWindowsBefore(start);
    if (windows === null) return hit?.value ?? null;
    const segs = packSegs(windows);
    const newest = source.traceLastTs();
    const value = segs.length === 0 ? null : { segMs: SEG_MS, segs };
    memo.set(key, { size: st.size, mtimeMs: st.mtimeMs, start, final: newest === null || newest < start, value });
    return value;
  };
}

/** Every line of one chat kind the run's trace recorded, oldest first: the same sanitized lines its segments carry. */
export function readTraceChat(runsDir: string, runId: string, kind: TraceChatKind): { ts: number; text: string }[] {
  return sessionSource(runsDir, runId).traceChat(kind);
}
