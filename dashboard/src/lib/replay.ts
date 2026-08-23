/**
 * Map replay as a position feed (FOLLOW-UPS 22, ADR-0019).
 *
 * The live map draws `AgentPosition[]` and asks nothing about where they came
 * from. Replay is therefore not a second renderer: it is the same feed, filled
 * from one run's recorded track plus a time cursor. Everything here is pure —
 * the cursor maths and the route the map traces are testable with no canvas.
 */

import type { AgentPosition, TrackPoint, TrackResponse } from "@viewer/api-types";

/** Index of the last point at or before `ts`, or -1 when the cursor precedes all. */
export function indexAt(points: readonly TrackPoint[], ts: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts <= ts) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The feed at one instant: the character where it stood, or nothing at all when
 * the cursor is before its first recorded position.
 *
 * A single-element array rather than a scalar, because that is the shape the
 * renderer consumes; a replay of several runs at once later is more elements,
 * not a different feed.
 */
export function positionsAt(track: TrackResponse, ts: number): AgentPosition[] {
  const i = indexAt(track.points, ts);
  if (i < 0) return [];
  const p = track.points[i]!;
  return [
    {
      runId: track.runId,
      character: track.character,
      model: track.model,
      map: p.map,
      x: p.x,
      y: p.y,
      // The sample's own time, so the map ages the pip against the cursor the
      // same way it ages a live one against the clock.
      ts: p.ts,
      level: p.level,
      xp: p.xp,
      money: p.money,
      questsCompleted: p.questsCompleted,
      // Track points carry no inventory; the replay popout shows none.
      items: null,
      harnessVersion: track.harnessVersion,
    },
  ];
}

/** The span a scrubber covers. Null when the run recorded no position at all. */
export function trackSpan(points: readonly TrackPoint[]): { from: number; to: number } | null {
  if (points.length === 0) return null;
  return { from: points[0]!.ts, to: points[points.length - 1]!.ts };
}

/**
 * The route walked on one map, up to the cursor.
 *
 * Split per map: a continent change is a teleport in world coordinates, and
 * joining the two would draw a line across the map that nobody walked.
 */
export function routeUpTo(
  points: readonly TrackPoint[],
  map: number,
  ts: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.ts > ts) break;
    if (p.map !== map) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Every map the track visits, in the order it first visits them. */
export function mapsVisited(points: readonly TrackPoint[]): number[] {
  const out: number[] = [];
  for (const p of points) if (!out.includes(p.map)) out.push(p.map);
  return out;
}
