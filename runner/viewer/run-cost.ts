/**
 * What one run cost, as the ladder reads it: the one definition the tier
 * scatter's cost axis (`dashboard/src/lib/axes.ts`, which re-exports it) and
 * the dungeon board's attempts (`dungeons.ts`) both take, so a cost on either
 * chart is the same reading of the same fields.
 */

import type { ResultRun, TokenTotals } from "./api-types";

/** What one run cost, and on what basis; null when nothing prices it. */
export interface RunCostReading {
  usd: number;
  basis: "reported" | "list-price";
  /** A figure nobody paid: a free tier, local hardware, a subscription. */
  asIfMetered: boolean;
  /** Set only on a reported figure that is partly a backfill (`CostFigure.backfill`). */
  backfilled?: true;
}

/** What the reading takes of a run: its two figures, and how its tokens were counted. */
export type CostedRun = Pick<ResultRun, "actualCost" | "expectedCost"> & { tokens?: Pick<TokenTotals, "source"> | null };

/**
 * The cost of one run: what the provider charged when it said, else the price
 * table applied to the run's own tokens.
 *
 * The same fallback the runs table's cost cell takes (`listCost`), which marks
 * the estimate with a `~`. A free or local model has no provider figure ever:
 * its honest cost is the $0 the price table says. The reading carries its
 * basis so a caption can say which runs were priced how. A list price over
 * `snapshot` tokens is no reading, as a snapshot token total is none
 * (`runMetrics`).
 */
export function runCostReading(r: CostedRun): RunCostReading | null {
  const a = r.actualCost;
  if (a !== null && a.basis !== "none" && a.usd !== null) {
    return { usd: a.usd, basis: "reported", asIfMetered: a.asIfMetered, ...(a.backfill !== undefined ? { backfilled: true as const } : {}) };
  }
  // A price over snapshot tokens is a floor with most of its output missing
  // (`expectedCost`): the run's own page shows it, a chart does not plot it.
  if (r.tokens?.source === "snapshot") return null;
  const e = r.expectedCost;
  if (e !== null && e !== undefined && e.basis !== "none" && e.usd !== null) {
    return { usd: e.usd, basis: "list-price", asIfMetered: e.asIfMetered };
  }
  return null;
}
