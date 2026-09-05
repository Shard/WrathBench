/**
 * The replay transport's arithmetic: everything the playback bar computes and
 * nothing it draws.
 *
 * The bar is one control strip at the bottom of the map that exists in both of
 * the page's modes — a live pill on `/map`, a transport on `/map?run=<id>` — so
 * the move between them is a change of state in one place rather than a
 * different set of controls appearing somewhere else. Its numbers live here
 * because they are the kind that go quietly wrong: a cursor between two
 * samples, a track with one reading, a step backward from a cursor that sits
 * exactly on a sample. Pure over `TrackPoint[]`, testable with no canvas.
 */

import type { TrackPoint } from "@viewer/api-types";
import { fmtElapsed } from "./format";
import { indexAt } from "./replay";

/** The tick at 1×: one recorded sample every quarter second, so a 6h run scrubs in ~30s. */
export const BASE_TICK_MS = 250;

/**
 * The speeds playback offers, as multiples of the base tick. Ticks rather than
 * wall time: a track's samples are spaced by the harness's state cadence, not
 * evenly, and "one sample per tick" is the only rate that reads the same across
 * two runs an operator is comparing.
 */
export const SPEEDS = [1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** The interval between samples at a given speed. */
export function tickMs(speed: Speed): number {
  return Math.round(BASE_TICK_MS / speed);
}

/** The next speed in the cycle; 8× wraps to 1×. */
export function nextSpeed(speed: Speed): Speed {
  const i = SPEEDS.indexOf(speed);
  return SPEEDS[(i + 1) % SPEEDS.length]!;
}

/**
 * The last sample strictly before the cursor, or nothing at the start.
 *
 * `indexAt` answers "at or before", which is right for the feed and wrong for a
 * step backward: a cursor sitting exactly on a sample has to move to the one
 * before it, and a cursor between two samples moves to the earlier of the two.
 */
export function prevSampleBefore(points: readonly TrackPoint[], ts: number): TrackPoint | undefined {
  const i = indexAt(points, ts);
  if (i < 0) return undefined;
  return points[i]!.ts < ts ? points[i] : points[i - 1];
}

export interface Span {
  from: number;
  to: number;
}

/** Where the cursor sits in the span, 0..1. Zero across a degenerate span. */
export function progressOf(span: Span | null, cursor: number): number {
  if (span === null || span.to <= span.from) return 0;
  return Math.min(1, Math.max(0, (cursor - span.from) / (span.to - span.from)));
}

/**
 * The transport's clock: how far into the recording the cursor is, and how
 * long the recording is, both on the run's own clock (`fmtElapsed`). A wall
 * clock answers a question nobody scrubbing a replay has; it stays available
 * as a hover.
 */
export function playbackClock(span: Span | null, cursor: number): { elapsed: string; total: string } {
  if (span === null) return { elapsed: "—", total: "—" };
  return {
    elapsed: fmtElapsed(Math.min(cursor, span.to) - span.from),
    total: fmtElapsed(span.to - span.from),
  };
}

export type PlaybackKey = "toggle" | "back" | "forward" | "start" | "end";

/**
 * The transport's keyboard, as a table: space plays and pauses, the arrows
 * step a sample, Home and End jump. Null for every other key so the caller
 * lets the browser have it.
 */
export function playbackKey(key: string): PlaybackKey | null {
  switch (key) {
    case " ":
    case "k":
      return "toggle";
    case "ArrowLeft":
    case "j":
      return "back";
    case "ArrowRight":
    case "l":
      return "forward";
    case "Home":
      return "start";
    case "End":
      return "end";
    default:
      return null;
  }
}

/**
 * Whether a key press belongs to the element that has focus rather than to the
 * transport. A space on a focused button is that button's click; typing in a
 * field is typing. The transport takes what is left.
 */
export function keyBelongsToTarget(tag: string | undefined): boolean {
  switch ((tag ?? "").toLowerCase()) {
    case "input":
    case "textarea":
    case "select":
    case "button":
    case "a":
      return true;
    default:
      return false;
  }
}
