/**
 * The episode and harness filter values, as pure functions of a URL.
 *
 * Apart from the picker that renders them so they can be tested without a DOM
 * (dashboard/README.md) — and because three pages parse the same two query
 * parameters, and must not be able to disagree about what a shared link means.
 */

import type { EpisodeIdView, HarnessView } from "../api/client";

export type EpisodeChoice = EpisodeIdView | "all";

export const EPISODE_CHOICES: readonly EpisodeChoice[] = ["e90", "e360", "probing", "freeplay", "all"];

/**
 * The `?episode=` search param, defaulted and validated.
 *
 * Anything unrecognised falls back to the page's own default rather than being
 * sent to the API, which would answer 400 and blank the page over a typo in a
 * shared link. The chips always show what is actually selected, so the fallback
 * is visible. The default is per page on purpose: a chart must not silently mix
 * tiers, so the aggregate pages open on `e90`; the episodes page is an
 * inventory of runs rather than a comparison, so it opens on `all`.
 */
export function episodeParam(
  raw: string | string[] | undefined,
  fallback: EpisodeChoice = "e90",
): EpisodeChoice {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return EPISODE_CHOICES.includes(v as EpisodeChoice) ? (v as EpisodeChoice) : fallback;
}

export type HarnessChoice = HarnessView | "all";

export const HARNESS_CHOICES: readonly HarnessChoice[] = ["all", "wrathbench", "claude-code"];

/**
 * The `?harness=` search param (ADR-0035). Defaults to `all`: the harness is
 * a tag on every row, and the operator chose not to partition on it, so the
 * filter is an optional narrowing rather than the default view.
 */
export function harnessParam(raw: string | string[] | undefined): HarnessChoice {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return HARNESS_CHOICES.includes(v as HarnessChoice) ? (v as HarnessChoice) : "all";
}
