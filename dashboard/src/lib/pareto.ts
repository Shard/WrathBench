/**
 * The Pareto front of the ladder scatter: the entries no other entry beats on
 * both axes at once — under the default view, cheaper (lower mean cost per
 * run, `x`) AND further (higher mean XP earned, `y`). An entry equal on both
 * axes to another is not dominated, so ties stay; a lone entry is its own
 * front.
 *
 * Over `LadderPoint`s rather than runs, because the axes are per-entry means
 * that only exist once `ladderPoints` has aggregated the runs. The chart
 * keeps every point and marks the front instead of filtering to it
 * (`paretoSteps`): the front is drawn as a step line through its members and
 * the dominated points are dimmed, so a reader sees who is on the front
 * without losing the field it was found in.
 *
 * Which way is "better" on each axis is the spec's to say (`AxisSpec.better`):
 * every offered view spends a resource on x and reaches a distance on y, so
 * the front reads the same on each, but the rule is read off the specs rather
 * than assumed, so a view that broke it could not silently invert the front.
 */

import { type Better, DEFAULT_BETTER } from "./axes";

export function paretoFront<P extends { x: number; y: number }>(rows: readonly P[], better: Better = DEFAULT_BETTER): P[] {
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

/** One axis-aligned segment of the front's step line, in the axes' own units. */
export interface FrontStep {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ParetoSteps<P> {
  /** The front, walked from the best x outward: each member spends more of x than the last and reaches further on y. */
  front: P[];
  /** The staircase through `front`: from each member, along x to the next one's x, then along y to it. */
  steps: FrontStep[];
}

/**
 * The front as a line a chart can draw. A Pareto front is a staircase, not a
 * polyline: between two neighbours the best reading achievable for the
 * resource spent is the nearer neighbour's, held flat until the further one
 * is paid for, so each hop is a run along x and then a rise along y. Every
 * segment is axis-aligned and every segment moves the same way — x towards
 * "worse", y towards "better" — which is what makes the shape legible as a
 * frontier: everything on the wrong side of the steps is dominated.
 *
 * The walk is ordered by x from the better end, so the members come out in
 * the order the line visits them. Members equal on both axes (a tie) share a
 * tread and add no segment; the order between them is by y and then input
 * order, so the result is a function of the set.
 */
export function paretoSteps<P extends { x: number; y: number }>(rows: readonly P[], better: Better = DEFAULT_BETTER): ParetoSteps<P> {
  const sx = better.x === "higher" ? 1 : -1;
  const sy = better.y === "higher" ? 1 : -1;
  const indexed = rows.map((p, i) => ({ p, i }));
  const front = paretoFront(indexed.map(({ p, i }) => ({ x: p.x, y: p.y, p, i })), better)
    .sort((a, b) => sx * (b.x - a.x) || sy * (b.y - a.y) || a.i - b.i)
    .map((m) => m.p);
  const steps: FrontStep[] = [];
  for (let k = 1; k < front.length; k++) {
    const a = front[k - 1]!;
    const b = front[k]!;
    if (a.x !== b.x) steps.push({ x1: a.x, y1: a.y, x2: b.x, y2: a.y });
    if (a.y !== b.y) steps.push({ x1: b.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return { front, steps };
}
