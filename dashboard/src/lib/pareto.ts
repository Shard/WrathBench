/**
 * The Pareto front of the ladder scatter: the entries no other entry beats on
 * both axes at once — under the default view, cheaper (lower mean cost per
 * run, `x`) AND further (higher mean XP earned, `y`). An entry equal on both
 * axes to another is not dominated, so ties stay; a lone entry is its own
 * front.
 *
 * Over `LadderPoint`s rather than runs, because the axes are per-entry means
 * that only exist once `ladderPoints` has aggregated the runs. The homepage
 * narrows its runs to the keys the front keeps (`paretoRuns`), so the chart
 * still draws through the same path as the ladder page.
 *
 * Which way is "better" on each axis is the spec's to say (`AxisSpec.better`):
 * every offered view spends a resource on x and reaches a distance on y, so
 * the front reads the same on each, but the rule is read off the specs rather
 * than assumed, so a view that broke it could not silently invert the front.
 */

import type { ResultRun } from "../api/client";
import { type AxisSpec, COST, XP } from "./axes";
import { type LadderPoint, ladderPoints, pointKey } from "./ladder";

export function paretoFront<P extends { x: number; y: number }>(
  rows: readonly P[],
  better: { x: AxisSpec["better"]; y: AxisSpec["better"] } = { x: "lower", y: "higher" },
): P[] {
  // Fold each axis onto "higher is better", so dominance is one comparison.
  const sx = better.x === "higher" ? 1 : -1;
  const sy = better.y === "higher" ? 1 : -1;
  return rows.filter(
    (p) =>
      !rows.some(
        (q) => q !== p && sx * q.x >= sx * p.x && sy * q.y >= sy * p.y && (sx * q.x > sx * p.x || sy * q.y > sy * p.y),
      ),
  );
}

/** The runs whose entry sits on the front; an entry the chart could not plot is not on it. */
export function paretoRuns(runs: readonly ResultRun[], x: AxisSpec = COST, y: AxisSpec = XP): ResultRun[] {
  const front = paretoFront<LadderPoint>(ladderPoints(runs, x, y).points, { x: x.better, y: y.better });
  const keep = new Set(front.map((p) => p.key));
  return runs.filter((r) => keep.has(pointKey(r.model ?? "(unnamed)", r.effort)));
}
