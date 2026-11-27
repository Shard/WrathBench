/**
 * The results and ladder builder (`/api/results`, `/api/ladder`) with its
 * episode and harness filters, over the handle's own listing
 * (`ApiContext.resultRuns`). `/api/results` is the viewer group's route and
 * `/api/ladder` the evals group's, and they are one builder, so this module
 * is built on every handle; the evals group's own routes are `api-evals.ts`,
 * which a handle imports only with that group on.
 */

import { json } from "./http";
import { EPISODES, EPISODE_IDS, isTaskEpisode } from "../runner/src/episodes";
import { HARNESSES } from "../runner/src/config";
import type { EpisodeIdView, ResultsResponse, ResultRun } from "./api-types";
import { scriptedReferenceLines } from "./scripted-reference";
import { projectResults } from "./public-projection";
import type { ApiContext } from "./api-context";

/**
 * A results row as a deployment without the evals group serves it
 * (`groups.ts`): without the comparison condition the ladder groups rows by,
 * which only the evals group reads (`ResultRun.condition`, `ResultRun.wiki`,
 * both optional, absent is "not answered"). The run's own stamps stay: its
 * episode and why it cannot be scored are what it recorded, and a null
 * `unscored` would read as "scored", which nothing here has decided.
 */
export function withoutEvalFields(r: ResultRun): ResultRun {
  const { condition: _condition, wiki: _wiki, ...rest } = r;
  return rest;
}

/** The results builder over the handle's shared state (`ApiContext`). */
export function createResultsApi(ctx: ApiContext) {
  const { groups, pub, harnessFilter, resultRuns, allResultRuns } = ctx;

  /**
   * The `?episode=` filter, shared by `/api/results` and `/api/ladder`.
   *
   * Defaults to `e90` — the scored tier — because a chart that quietly mixes a
   * ninety-minute run with a six-hour one is the thing the tiers exist to stop.
   * `all` is a first-class value, not an escape hatch: the episodes page counts
   * every tier from one call, and a filtered page has to be able to say how
   * many rows the filter dropped. An unknown value is a 400 rather than a
   * silent fallback to the default, which would show the wrong data under the
   * right heading. With the evals group off there are no tiers to default
   * to, and an absent filter is `all`.
   */
  function episodeFilter(url: URL): EpisodeIdView | "all" | null {
    const raw = url.searchParams.get("episode");
    if (raw === null) return groups.evals ? "e90" : "all";
    if (raw === "all") return "all";
    return (EPISODE_IDS as readonly string[]).includes(raw) ? (raw as EpisodeIdView) : null;
  }

  /**
   * The episodes a ladder is offered for.
   *
   * `probing` is not one (operator, 2026-08-29). A probe campaign is a
   * commissioned sweep whose cells vary on purpose, so a table that ranks its
   * runs against each other ranks the sweep, not the models — and unlike the
   * scored ids there is no group for a row to belong to. Probe runs stay
   * visible everywhere runs are listed; they just have no ladder. It is only
   * the ladder that loses the id: `/api/results?episode=probing` still answers,
   * and `EPISODE_IDS` is untouched.
   */
  // Nor are the task episodes (operator, 2026-11-14): a staged level-20
  // dungeon run would top a level ladder, and their runs are read on the
  // dungeon board instead.
  const LADDER_EPISODES: readonly string[] = EPISODE_IDS.filter((id) => id !== "probing" && !isTaskEpisode(id));

  async function resultsResponse(url: URL, ladder = false): Promise<Response> {
    const episode = episodeFilter(url);
    if (episode === null) {
      return json({ error: `unknown episode; one of: ${[...EPISODE_IDS, "all"].join(", ")}` }, 400);
    }
    if (ladder && episode !== "all" && !LADDER_EPISODES.includes(episode)) {
      return json({ error: `no ladder for that episode; one of: ${LADDER_EPISODES.join(", ")}` }, 400);
    }
    const harness = harnessFilter(url);
    if (harness === null) {
      return json({ error: `unknown harness; one of: ${[...HARNESSES, "all"].join(", ")}` }, 400);
    }
    /*
     * An override is a membership question, and only a scored id has a
     * membership to lose: `freeplay` pins nothing but its own name and its
     * unscored reason, so a freeplay run given its own leash has not fallen
     * out of any group — the same reason `docs/EPISODES.md` gives for never
     * reporting a probe run as overridden. The freeplay ladder is the whole
     * active field (operator, 2026-08-29), so it holds them.
     */
    const unscoredLadder =
      ladder && episode !== "all" && episode !== null && !EPISODES[episode].scored;
    const includeOverrides = url.searchParams.get("includeOverrides") === "1" || unscoredLadder;
    const everything = await resultRuns();
    const all = harness === "all" ? everything : everything.filter((r) => r.harness === harness);
    /*
     * Filtering to a tier means filtering to its *members*: stamped
     * with the id and not overridden. A derived label is countable but is not
     * membership, and an overridden run is only shown when asked for by name.
     */
    const tiered =
      episode === "all"
        ? all
        : all.filter(
            (r) =>
              r.episode === episode &&
              r.episodeSource === "stamped" &&
              (includeOverrides || !r.episodeOverride),
          );
    // With evals off the rows are a listing, not a comparison: no ladder condition rides on them.
    const runs = groups.evals ? tiered : tiered.map(withoutEvalFields);
    const body: ResultsResponse = {
      runs,
      episode,
      harness,
      includeOverrides,
      filteredOut: everything.length - runs.length,
      overridesExcluded:
        episode === "all" || includeOverrides
          ? 0
          : all.filter(
              (r) => r.episode === episode && r.episodeSource === "stamped" && r.episodeOverride,
            ).length,
      now: Date.now(),
      // The ladder's reference line, as numbers, off every run: the reference
      // run is withheld from a public handle's rows, and this is all of it
      // that is published (`scripted-reference.ts`).
      ...(ladder ? { scriptedReference: scriptedReferenceLines(await allResultRuns(), episode) } : {}),
    };
    return pub(body, projectResults);
  }

  return { resultsResponse };
}
