/**
 * The ladder's episode choice, as a pure function of a URL.
 *
 * Kept apart from the page so it can be tested without a DOM
 * (dashboard/README.md), and so any future page reading `?episode=` cannot
 * disagree with the ladder about what a shared link means.
 *
 * Three ids are offered. There is no `all` and no "+ overridden":
 * a level reached in six hours is not the same claim as one reached in ninety
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
 *
 * The Deadmines ids are tabs of the same page (`DUNGEON_CHOICES`) but not
 * ladder choices: their runs are read on the dungeon board (`/api/dungeons`),
 * a table per id, and `/api/ladder` refuses them. So `episodeParam` never
 * yields one, and the ladder's own request never names one.
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

/** The dungeon board's ids, offered as tabs beside the ladder's: five agents, then one agent driving five. */
export const DUNGEON_CHOICES = ["deadmines", "deadmines-solo"] as const satisfies readonly EpisodeIdView[];

export type DungeonChoice = (typeof DUNGEON_CHOICES)[number];

/** The `?episode=` search param when it names a dungeon board's id, else null. */
export function dungeonParam(raw: string | string[] | undefined): DungeonChoice | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (DUNGEON_CHOICES as readonly string[]).includes(v ?? "") ? (v as DungeonChoice) : null;
}

/**
 * The dungeon tabs to offer: the five-agent id always, the one-agent id only
 * where the viewer serves its table, as a public handle does too since the
 * one-agent table was published (operator delegated, 2026-11-15); `served`
 * is undefined until `/api/dungeons` answers.
 */
export function dungeonChoices(served: readonly EpisodeIdView[] | undefined): DungeonChoice[] {
  return DUNGEON_CHOICES.filter((id) => id === "deadmines" || (served ?? []).includes(id));
}
