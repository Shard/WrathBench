/**
 * The Pareto front of the ladder scatter: the entries no other entry beats on
 * both axes at once — cheaper (lower mean cost per run, `x`) AND further
 * (higher mean XP earned, `y`). An entry equal on both axes to another is
 * not dominated, so ties stay; a lone entry is its own front.
 *
 * Over `LadderPoint`s rather than runs, because the axes are per-entry means
 * that only exist once `ladderPoints` has aggregated the runs. The homepage
 * narrows its runs to the keys the front keeps (`paretoRuns`), so the chart
 * still draws through the same path as the ladder page.
 */

import type { ResultRun } from "../api/client";
import { type LadderPoint, ladderPoints, pointKey } from "./ladder";

export function paretoFront<P extends { x: number; y: number }>(rows: readonly P[]): P[] {
  return rows.filter((p) => !rows.some((q) => q !== p && q.x <= p.x && q.y >= p.y && (q.x < p.x || q.y > p.y)));
}

/** The runs whose entry sits on the front; an entry the chart could not plot is not on it. */
export function paretoRuns(runs: readonly ResultRun[]): ResultRun[] {
  const keep = new Set(paretoFront<LadderPoint>(ladderPoints(runs).points).map((p) => p.key));
  return runs.filter((r) => keep.has(pointKey(r.model ?? "(unnamed)", r.effort)));
}
