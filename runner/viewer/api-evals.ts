/**
 * The evals group's side of the viewer's API (`groups.ts`): the episodes, the
 * dungeon board, the campaigns and `/api/info`'s series census, over the handle's own listing
 * (`ApiContext.resultRuns`). `createApi` (`api.ts`) imports this module only
 * with the group on. The results and ladder builder, which `/api/results`
 * shares with the ladder, is `api-results.ts`.
 */

import { harnessSeries } from "../src/comparability-tuple";
import { EPISODE_LIST, hasBoard } from "../src/episodes";
import { isNotAModelRun } from "../src/config";
import { badEvidenceReason, countedRun } from "../src/lapse";
import type {
  CampaignsResponse,
  DungeonsResponse,
  EpisodesResponse,
  ResultRun,
} from "./api-types";
import { campaignsView } from "./campaigns";
import { boardsOf, DUNGEON_BOARD_VERSION } from "./dungeons";
import { dungeonMarksOf } from "./dungeon-marks";
import { projectCampaigns, projectDungeons, projectEpisodes } from "./public-projection";
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
 * How long one series census stands in for the next.
 *
 * Minutes, not seconds: a new series appears on a deploy, never on a tick, and
 * the census opens the run metadata for every run on disk. `/api/info` is the
 * route every open tab polls — the one whose build id is already memoised for
 * exactly that reason.
 */
export const SERIES_CACHE_MS = 300_000;

/**
 * The harness series present in the run directory, newest first, with counts.
 *
 * The shell's global series selector needs this before any page has fetched
 * rows of its own, so it rides on `/api/info`. Cached on a window because that
 * route is polled by every open tab and the answer changes only when a run
 * starts; the census reads run metadata, never a trajectory. The evals
 * group's: with the group off the dashboard draws no selector, and
 * `/api/info` carries no census.
 */
export function harnessSeriesCensus(rows: readonly { harnessVersion: string | null }[]): { series: string; runs: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const s = harnessSeries(r.harnessVersion);
    if (s === null) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts]
    .map(([series, runs]) => ({ series, runs }))
    .sort((a, b) => {
      const [am, an] = a.series.split(".").map((n) => Number.parseInt(n, 10));
      const [bm, bn] = b.series.split(".").map((n) => Number.parseInt(n, 10));
      return (bm! - am!) || (bn! - an!);
    });
}

/** The evals builders over the handle's shared state (`ApiContext`). */
export function createEvalsApi(ctx: ApiContext) {
  const { runsDir, pub, fleetRoster, resultRuns, runRows } = ctx;

  // The series census for /api/info, on a window: every open tab polls that
  // route, and the answer only moves when a run starts.
  let seriesCache: { at: number; value: { series: string; runs: number }[] } | undefined;
  async function seriesCensus(): Promise<{ series: string; runs: number }[]> {
    const now = Date.now();
    if (seriesCache === undefined || now - seriesCache.at >= SERIES_CACHE_MS) {
      seriesCache = { at: now, value: harnessSeriesCensus(await runRows(now)) };
    }
    return seriesCache.value;
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

  return { episodesResponse, dungeonsResponse, campaignsResponse, seriesCensus };
}
