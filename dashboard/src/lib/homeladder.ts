/**
 * The homepage's ladder: `e90` — ninety minutes of play from a fresh level-1
 * character (`docs/EPISODES.md`) — under the shell's harness-series selection,
 * and — by default — no free run.
 *
 * Every rule is the ladder page's own, reused rather than restated. The series
 * is `pageSeries` over the shell's choice, the series the shell knows and the
 * series the runs carry, exactly as `useSeriesFilter` resolves it on `/ladder`:
 * with no choice made that is `latest`, and `latest` is `defaultSeries`, so a
 * preview series the operator has named is not the default view here either.
 * "free" is `ResultRun.billing === "free"` through `filterRuns` — the runner's
 * own billing verdict (`runner/src/billing.ts`: free means literally free — a
 * `:free`/`-free`/contributor-free endpoint, local hardware or an openai run
 * whose roster entry declared `billing: "free"`; a claude-code, codex or
 * OpenCode Go subscription counts as paid). No model slug is inspected here.
 *
 * Then the ladder page's opening view (`defaultLadderRuns`): every condition
 * its own row, on the chart holding the most entries, so the homepage never
 * draws conditions that may not share a chart on one either.
 */

import type { ResultRun } from "../api/client";
import { SERIES_LATEST, type SeriesChoice, filterBySeries, pageSeries } from "./harness";
import { filterRuns } from "./ladder";
import { defaultLadderRuns } from "./ladderfilter";

export const HOME_EPISODE = "e90" as const;

/** The shell's series selection (`Feeds.seriesChoice`, `seriesAvailable`); absent is `latest` over the runs alone. */
export interface HomeSeriesSelection {
  choice?: SeriesChoice;
  available?: readonly string[];
}

export function homeLadderRuns(
  runs: readonly ResultRun[],
  excludeFree: boolean,
  preview?: string | null,
  selection: HomeSeriesSelection = {},
): ResultRun[] {
  const series = pageSeries(selection.choice ?? SERIES_LATEST, selection.available ?? [], runs, preview);
  return defaultLadderRuns(filterRuns(filterBySeries(runs, series), { excludeFree }));
}

/** The full ladder of this tier, under the same series choice, so the link opens on what the homepage drew. */
export function homeLadderHref(choice: SeriesChoice): string {
  return `/ladder?${new URLSearchParams({ episode: HOME_EPISODE, series: choice }).toString()}`;
}
