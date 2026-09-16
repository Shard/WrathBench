/**
 * Map replay as a position feed (item 22).
 *
 * The live map draws `AgentPosition[]` and asks nothing about where they came
 * from. Replay is therefore not a second renderer: it is the same feed, filled
 * from one run's recorded track plus a time cursor. Everything here is pure —
 * the cursor maths and the route the map traces are testable with no canvas.
 */

import type { AgentPosition, TrackPoint, TrackResponse } from "@viewer/api-types";
import { intentAt } from "./mapintent";

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
      character: track.characterName,
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
      // The player frame as that sample recorded it (item 104); a track
      // from before the columns existed carries nulls and draws unobserved.
      health: p.health ?? null,
      maxHealth: p.maxHealth ?? null,
      power: p.power ?? null,
      maxPower: p.maxPower ?? null,
      powerType: p.powerType ?? null,
      nextLevelXp: p.nextLevelXp ?? null,
      harnessVersion: track.harnessVersion,
      // The intention standing at the cursor. Its own cadence, so it is looked
      // up by time rather than taken from the track point beside it.
      move: intentAt(track.moves, ts),
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
  // The cursor's index is a binary search, so the walk is bounded by the route
  // actually drawn rather than by the length of the track.
  const end = indexAt(points, ts);
  for (let i = 0; i <= end; i++) {
    const p = points[i]!;
    if (p.map !== map) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * The next sample strictly after the cursor, or nothing when the cursor has
 * reached the end. This is playback's per-tick step: a linear scan here costs
 * the whole track on every one of four ticks a second, which a six-hour run
 * feels. `indexAt` returns the *last* index sharing a timestamp, so one past it
 * is strictly later even when two samples land in the same millisecond.
 */
export function nextSampleAfter(
  points: readonly TrackPoint[],
  ts: number,
): TrackPoint | undefined {
  return points[indexAt(points, ts) + 1];
}

/** Every map the track visits, in the order it first visits them. */
export function mapsVisited(points: readonly TrackPoint[]): number[] {
  const out: number[] = [];
  for (const p of points) if (!out.includes(p.map)) out.push(p.map);
  return out;
}

/**
 * The `?run=` search parameter as a run id.
 *
 * A URL is an external boundary: the parameter can be absent, empty (`?run=`),
 * or repeated, and only a non-empty single value names a run. Empty means live
 * rather than "a run called nothing", so the map shows the live feed.
 */
export function runParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
