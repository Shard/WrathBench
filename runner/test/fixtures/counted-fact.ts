/**
 * A finished, counted run of a roster entry's on one episode: stamped with
 * the loop, routing and driver the entry launches with, so `isCounted` and
 * `countsTowardTarget` take it. What a promotion test needs to hand the
 * projection a witness at a given level.
 */
import { defaultLoopOf } from "../../src/config";
import { DEFAULT_DRIVER, driverEntry, isDriver } from "../../src/drivers";
import type { EpisodeId } from "../../src/episodes";
import type { RosterModel } from "../../src/roster-entry";
import type { RunFact } from "../../src/run-fact";
import { DEFAULT_API_BASE } from "../../src/providers";
import { routingForRun } from "../../src/routing";

export function countedFact(
  entry: Pick<RosterModel, "model" | "effort" | "driver">,
  episode: EpisodeId,
  level: number | null,
  opts: { i?: number; now?: number; series?: string } = {},
): RunFact {
  const now = opts.now ?? Date.UTC(2026, 10, 15, 12);
  const i = opts.i ?? 1;
  const driver = entry.driver !== undefined && isDriver(entry.driver) ? entry.driver : DEFAULT_DRIVER;
  const loop = defaultLoopOf({ driver });
  const apiBase = driverEntry(driver)?.endpoint === true ? DEFAULT_API_BASE : undefined;
  const routing = routingForRun({ apiBase, model: entry.model, ...(entry.effort != null ? { effort: entry.effort } : {}) });
  const series = opts.series ?? "0.5";
  return {
    runId: `${entry.model}-${episode}-${i}`,
    model: entry.model,
    effort: entry.effort ?? null,
    driver,
    episode,
    episodeOverride: false,
    harnessVersion: `harness-${series}-1-gx`,
    harnessSeries: series,
    ...(loop.loop === "program" ? { loop: "program" as const } : {}),
    ...(loop.yield ? { yield: true as const } : {}),
    ...(routing !== null ? { routing } : {}),
    extra: false,
    startedAt: now - (100 - i) * 3_600_000,
    endedAt: now - (99 - i) * 3_600_000,
    terminationReason: "episode-limit",
    modelResponses: 10,
    bestLevel: level,
    live: false,
    pause: null,
    account: null,
    character: null,
    episodeMs: null,
    campaign: null,
    cell: null,
    credential: null,
  };
}
