/**
 * The ladder's episode choice, as a pure function of a URL.
 *
 * Kept apart from the page so it can be tested without a DOM
 * (dashboard/README.md), and so any future page reading `?episode=` cannot
 * disagree with the ladder about what a shared link means.
 *
 * Three ids are offered. There is no `all` and no "+ overridden":
 * a rung reached in six hours is not the same claim as one reached in ninety
 * minutes, and a run whose leash was overridden is not a member of the tier
 * it is stamped with — so neither can share a chart, and a choice the chart
 * cannot honour is not a choice.
 *
 * `probing` is not offered either: a campaign varies
 * its cells on purpose, so ranking its runs against each other ranks the sweep
 * rather than the models, and there is no group for a row to be a member of.
 * The viewer refuses `/api/ladder?episode=probing` for the same reason and
 * publishes no `ladder-probing.json`. Probe runs stay visible on the runs and
 * campaigns pages; they simply have no ladder. The runs page is where every
 * run is listed regardless.
 */

import type { EpisodeIdView } from "../api/client";

export type EpisodeChoice = EpisodeIdView;

export const EPISODE_CHOICES: readonly EpisodeChoice[] = ["e90", "e360", "freeplay"];

/**
 * The `?episode=` search param, defaulted and validated.
 *
 * Anything unrecognised — including the `all` older links carried — falls
 * back to the default rather than being sent to the API, which would answer
 * 400 and blank the page over a typo in a shared link. The chips always show
 * what is actually selected, so the fallback is visible. `e90` is the scored
 * tier and the one the fleet runs first, so it is the default.
 */
export function episodeParam(raw: string | string[] | undefined, fallback: EpisodeChoice = "e90"): EpisodeChoice {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return EPISODE_CHOICES.includes(v as EpisodeChoice) ? (v as EpisodeChoice) : fallback;
}
