/**
 * A run's sessions: the one definition the viewer and the dashboard share.
 *
 * A **session** is one stretch of a run during which the harness was actually
 * driving — an active segment. It opens at the run's first `meta` and at each
 * `resume`, and closes at a `pause` or the `termination`. A run is one or more
 * sessions: a scored run usually one; a run a rate limit paused and the fleet
 * resumed two; a freeplay run the operator paused and resumed in place days
 * later two as well, under one run id. A durable freeplay character is a chain
 * of runs (`lineage.ts`), so its sessions are every attempt's, in order.
 *
 * Everything that measures a run in time reads these. Playtime is their sum;
 * a level mark's `playtimeMs` is the active time before it (`activeMsUntil`);
 * and a chart that plots samples against time plots them on the session clock
 * (`sessionClock`), which is that same active time — so a curve, the level
 * marks under it and the playtime card cannot disagree about where a sample
 * sits, and a week a character spent paused is closed rather than drawn.
 *
 * A session boundary is found from the recorded marks, never from a gap in
 * the samples: a resume can follow a pause by a minute, and a slow stretch of
 * play can leave samples far apart.
 *
 * This module imports nothing but wire types, because the dashboard reaches it
 * over the `@viewer/*` alias and nothing server-side may follow it into the
 * browser bundle. A session's shape is declared in `api-types.ts` with every
 * other wire shape, since `/api/run/<id>` and the character's attempts serve it.
 */

import type { ActiveSegment } from "./api-types";

export type { ActiveSegment };

/** The record kinds that open or close an active segment. */
export const SEGMENT_MARKS = new Set(["meta", "resume", "pause", "termination"]);

/** The trajectory records that open and close an active segment. */
export interface SegmentMark {
  t: string;
  ts: number;
}

/**
 * Split a run into the stretches it was actually being driven.
 *
 * A run's wall clock span is not its playtime: `--resume` picks a run up hours
 * after a rate limit paused it, and the gap belongs to nobody. A segment opens
 * at `meta` (the first launch) and at each `resume`, and closes at each `pause`
 * or `termination`. The last segment stays open when the run neither paused nor
 * ended — `playtimeMs` decides what to close it at.
 *
 * Only the FIRST `meta` opens a segment. `writeMeta` appends a `meta` record
 * every time it is called, and run.ts calls it mid-file for two reasons that
 * must not count as driving: a resume that regenerates the session token
 * (which follows the `resume` mark and would otherwise open a duplicate), and
 * the pause mark itself, written milliseconds after the `pause` record (commit
 * 08cd691). That second case is what over-read every paused run at 100%+ of
 * its budget on the fleet page until 2026-08-25: pause closed the segment and
 * the pause-mark `meta` reopened it, so the whole quota wait counted as
 * playtime. Reopening after a pause is `resume`'s job alone.
 *
 * A trajectory whose first record is neither `meta` nor `resume` — an older or
 * truncated file — opens its first segment at that record, so playtime degrades
 * to the old span rather than to zero.
 */
export function segmentsFrom(marks: readonly SegmentMark[]): ActiveSegment[] {
  const out: ActiveSegment[] = [];
  let open: number | null = null;
  for (const m of marks) {
    if (m.ts <= 0) continue;
    if (m.t === "resume") {
      if (open === null) open = m.ts;
    } else if (m.t === "meta") {
      if (open === null && out.length === 0) open = m.ts;
    } else if (m.t === "pause" || m.t === "termination") {
      if (open !== null) {
        out.push({ start: open, end: m.ts });
        open = null;
      }
    } else if (open === null && out.length === 0) {
      open = m.ts;
    }
  }
  if (open !== null) out.push({ start: open, end: null });
  return out;
}

/**
 * Cumulative active time: the sum of the segments, with an open one closed at
 * `now` for a live run and at the last entry otherwise.
 *
 * A run that is paused right now has no open segment, so a fresh mtime (the
 * sqlite file still being touched) cannot make the current pause count.
 *
 * Close to, but not the same as, what the `episode-limit` watchdog measures.
 * `Watchdogs` is constructed fresh in each worker process, but since 08cd691
 * run.ts passes `elapsedBeforeMs` from the persisted `episodeElapsedMs`, so the
 * episode clock CARRIES ACROSS A PAUSE rather than resetting on every resume
 * (this comment said otherwise until). Both clocks now exclude paused
 * time and differ only in how they accumulate it: the watchdog rewinds one
 * start point by the elapsed total, this sums the observed active segments. So
 * the two track each other, and neither is a subset of the other — a run that
 * died without recording its elapsed time resumes the watchdog at zero while
 * the segments here still remember the earlier work.
 */
export function playtimeMs(
  segments: readonly ActiveSegment[],
  opts: { lastTs: number | null; live: boolean; now: number },
): number | null {
  if (segments.length === 0) return null;
  let total = 0;
  for (const seg of segments) {
    const end = seg.end ?? (opts.live ? opts.now : (opts.lastTs ?? seg.start));
    total += Math.max(0, end - seg.start);
  }
  return total;
}

/**
 * Active time from the run's start up to `ts`.
 *
 * `playtimeMs` answers "how much in total"; this answers "how much by then",
 * which is the one a level mark needs. A segment that has not closed is charged
 * only up to the cursor, and a segment that opened after it contributes
 * nothing.
 */
export function activeMsUntil(segments: readonly ActiveSegment[], ts: number): number | null {
  if (segments.length === 0) return null;
  let total = 0;
  for (const seg of segments) {
    if (seg.start > ts) continue;
    const end = Math.min(seg.end ?? ts, ts);
    total += Math.max(0, end - seg.start);
  }
  return total;
}

/** One run's samples on its session clock. */
export interface SessionClock<T extends { ts: number }> {
  /**
   * The samples with `ts` replaced by the active time before them, so a chart
   * that plots samples against a window plots these unchanged. Everything else
   * on a sample is untouched.
   */
  points: T[];
  /**
   * Where each session begins on that clock, oldest first: `[0]` for a run of
   * one session, and one more entry per resume. A seam is drawn at each entry
   * after the first.
   */
  starts: number[];
  /**
   * The wall clock each of those sessions began at, index for index — what a
   * seam's hover names.
   */
  startedAt: number[];
}

/**
 * Lay one run's samples on its session clock: active time, every paused
 * stretch closed.
 *
 * A sample in a pause (written by a process on its way out) lands on the seam
 * it precedes. A run that served no sessions — a snapshot published before the
 * field, or a trajectory nothing could be read from — is laid out as one
 * session from its first sample, which is how such a run was always drawn.
 */
export function sessionClock<T extends { ts: number }>(
  points: readonly T[],
  segments: readonly ActiveSegment[] | undefined,
): SessionClock<T> {
  if (segments === undefined || segments.length === 0) {
    let base = points.length > 0 ? points[0]!.ts : 0;
    for (const p of points) base = Math.min(base, p.ts);
    return { points: points.map((p) => ({ ...p, ts: p.ts - base })), starts: [0], startedAt: [base] };
  }
  return {
    points: points.map((p) => ({ ...p, ts: activeMsUntil(segments, p.ts) ?? 0 })),
    starts: segments.map((s) => activeMsUntil(segments, s.start) ?? 0),
    startedAt: segments.map((s) => s.start),
  };
}
