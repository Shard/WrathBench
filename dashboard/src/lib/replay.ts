/**
 * Map replay as a position feed.
 *
 * The live map draws `AgentPosition[]` and asks nothing about where they came
 * from. Replay is therefore not a second renderer: it is the same feed, filled
 * from one run's recorded track plus a time cursor. The cursor maths and the
 * route over a session's track are the inspector's
 * (`@wrathbench/inspector/views/replay`); what is here makes a run's position
 * of the point at the cursor, and reads the `?run=` parameter.
 */

import type { AgentPosition, TrackResponse } from "@viewer/api-types";
import { intentAt } from "@wrathbench/inspector/views/mapintent";
import { indexAt } from "@wrathbench/inspector/views/replay";

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
      // The player frame as that sample recorded it; a track
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
