/**
 * The homepage's fixed ladder: `e90` — ninety minutes of play from a fresh
 * level-1 character (`docs/EPISODES.md`) — over the latest harness series
 * present in the served runs, and — by default — no free run.
 *
 * Both rules are the ladder page's own, reused rather than restated: "latest"
 * is `latestSeries` over the series the runs carry (the shell's selector
 * resolves the same token the same way), and "free" is `ResultRun.billing ===
 * "free"` through `filterRuns` — the runner's own billing verdict
 * (`runner/src/billing.ts`: a `:free` endpoint or local hardware is free, a
 * claude-code or codex subscription counts as paid). No model slug is inspected here.
 */

import type { ResultRun } from "../api/client";
import { filterBySeries, latestSeries, seriesPresent } from "./harness";
import { filterRuns } from "./ladder";

export const HOME_EPISODE = "e90" as const;

export function homeLadderRuns(runs: readonly ResultRun[], excludeFree: boolean): ResultRun[] {
  const latest = latestSeries(seriesPresent(runs));
  return filterRuns(filterBySeries(runs, latest), { excludeFree });
}
