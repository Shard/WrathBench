/**
 * The evals group's side of the viewer's API (`groups.ts`): the results and
 * ladder builder with its episode filter, the episodes, the dungeon board and
 * the campaigns, over the handle's own listing (`ApiContext.resultRuns`).
 * `/api/results` is the viewer's own route but shares the ladder's builder,
 * so `createApi` (`api.ts`) builds this module on every handle and its group
 * gate keeps the evals routes absent with the group off.
 */

import { json } from "./http";
import { EPISODES, EPISODE_IDS, EPISODE_LIST, hasBoard, isTaskEpisode } from "../src/episodes";
import { HARNESSES, isNotAModelRun } from "../src/config";
import { badEvidenceReason, countedRun } from "../src/lapse";
import type {
  CampaignsResponse,
  DungeonsResponse,
  EpisodeIdView,
  EpisodesResponse,
  ResultsResponse,
  ResultRun,
} from "./api-types";
import { scriptedReferenceLines } from "./scripted-reference";
import { campaignsView } from "./campaigns";
import { boardsOf, DUNGEON_BOARD_VERSION } from "./dungeons";
import { dungeonMarksOf } from "./dungeon-marks";
import { projectCampaigns, projectDungeons, projectEpisodes, projectResults } from "./public-projection";
import type { ApiContext } from "./api-context";

/** The one shared scoreability verdict (`badEvidenceReason`), applied to a projected result row. */
function badEvidenceOf(r: Pick<ResultRun, "live" | "pauseReason" | "modelResponses" | "terminationReason">): string | null {
  return badEvidenceReason({
    live: r.live === true,
    paused: r.pauseReason !== null,
    modelResponses: r.modelResponses,
    terminationReason: r.terminationReason,
  });
}

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

/** The evals builders over the handle's shared state (`ApiContext`). */
export function createEvalsApi(ctx: ApiContext) {
  const { runsDir, groups, pub, fleetRoster, harnessFilter, resultRuns, allResultRuns } = ctx;

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

  async function episodesResponse(): Promise<Response> {
    /*
     * Every run here is a run that happened: a launch that produced no model
     * response is archived by the runner as it terminates, so the counts below
     * cannot be padded by launches that never got off the ground.
     */
    const all = await resultRuns();
    const body: EpisodesResponse = {
      episodes: EPISODE_LIST.map((tier) => {
        // A run whose driver is not a model ran an episode's shape and is no
        // member of its group: the scripted reference is a labelled line, not
        // a run of the tier (docs/METHODOLOGY.md, "Scoring").
        const tagged = all.filter((r) => r.episode === tier.id && !isNotAModelRun(r));
        const stamped = tagged.filter((r) => r.episodeSource === "stamped");
        // An attempt that never became an episode is not a member of the tier's
        // group — the same predicate the ladder filters on, so this
        // count and that chart hold the same runs.
        const notEvidence = (r: (typeof stamped)[number]): boolean => badEvidenceOf(r) !== null;
        const lapsed = (r: (typeof stamped)[number]): boolean => r.terminationReason !== null && notEvidence(r);
        return {
          ...tier,
          members: stamped.filter((r) => !r.episodeOverride && !notEvidence(r)).length,
          lapsed: stamped.filter((r) => !r.episodeOverride && lapsed(r)).length,
          overrides: stamped.filter((r) => r.episodeOverride).length,
          derived: tagged.length - stamped.length,
        };
      }),
      untiered: all.filter((r) => r.episode === null).length,
      now: Date.now(),
    };
    return pub(body, projectEpisodes);
  }

  /**
   * The probe lane, one entry per published campaign version
   * (`campaignsView`), with every refusal the campaign parser made.
   *
   * The published definitions and the store row come from the config store,
   * read exactly as the supervisor reads them; the runs from the run
   * directory, matched by their own stamps. `counted` is the scheduler's own
   * definition (`countedRun`, lapse.ts) over a result row — never `unscored`, which is non-null for
   * every probe.
   */
  /**
   * The dungeon board (`dungeons.ts`): the runs of each Deadmines id with a
   * table (`hasBoard`, `deadmines-solo` alone), read with each character's
   * milestones. Off the handle's own listing, so a run a public handle
   * withholds is in no row.
   */
  async function dungeonsResponse(): Promise<Response> {
    const all = (await resultRuns()).filter((r) => hasBoard(r.episode) && r.episodeSource === "stamped");
    const runs = await Promise.all(
      all.map(async (run) => ({ run, characters: await dungeonMarksOf(runsDir, run.runId, { ended: run.terminationReason !== null, character: run.character }) })),
    );
    // The same table on either handle: the one-agent id's runs are the only
    // fan-out runs a public handle lists (`resultRuns`).
    const boards = boardsOf(runs);
    const body: DungeonsResponse = { version: DUNGEON_BOARD_VERSION, boards, now: Date.now() };
    return pub(body, projectDungeons);
  }

  async function campaignsResponse(): Promise<Response> {
    const all = await resultRuns();
    const roster = fleetRoster();
    const view = campaignsView(all, roster, (r) =>
      countedRun({
        extra: r.extra,
        episodeOverride: r.episodeOverride,
        notAModel: isNotAModelRun(r),
        live: r.live === true,
        paused: r.pauseReason !== null,
        modelResponses: r.modelResponses,
        terminationReason: r.terminationReason,
      }),
    );
    const body: CampaignsResponse = { now: Date.now(), campaigns: view.campaigns, refused: view.refused };
    return pub(body, projectCampaigns);
  }

  return { resultsResponse, episodesResponse, dungeonsResponse, campaignsResponse };
}
