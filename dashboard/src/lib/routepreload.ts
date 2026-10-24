/**
 * Each route's first requests, started by the router as soon as the route
 * matches rather than when the page's code has arrived.
 *
 * A page is lazy, so on a cold load its first poll used to wait for the route
 * chunk to download and run; on a slow link that was most of a second in
 * which the network sat idle. The router calls a route's `preload` the moment
 * it matches, before the chunk is fetched, and the calls here are the page's
 * own first calls, with the same arguments. Both clients share an in-flight
 * or recent request per URL (`api/client.ts`, `api/snapshot-client.ts`), so
 * the page's poll then picks up the request already under way rather than
 * making another. A call here the page would not make, or makes with other
 * arguments, is a wasted request, so each one mirrors its page and the tests
 * hold the two together where the arguments are computed.
 *
 * Only on a navigation. The router also preloads on a link hover, and there
 * the route's code is worth fetching early but the data, which may never be
 * looked at, is not.
 *
 * Failures are dropped here: the page's own poll makes the same call and
 * reports what it finds.
 */

import type { Client } from "../api/client";
import { episodeParam } from "./episodes";

/** The homepage's ladder tier: `HOME_EPISODE` in `lib/homeladder.ts`, restated to keep that module out of the entry chunk (a test holds them equal). */
export const HOME_PRELOAD_EPISODE = "e90";

/** What a preload reads of the router's arguments. */
export interface PreloadArgs {
  params: Readonly<Record<string, string | undefined>>;
  location: { query: Readonly<Record<string, string | string[] | undefined>> };
  intent: string;
}

export type Preload = (args: PreloadArgs) => void;

type Api = Pick<Client, "tools" | "positions" | "ladder" | "results" | "models" | "episodes" | "campaigns" | "runs" | "character">;

/** The preloads, by route, over a client. */
export function routePreloads(api: Api): Record<"home" | "ladder" | "map" | "runs" | "models" | "about" | "campaigns" | "fleet" | "character", Preload> {
  const on =
    (start: (args: PreloadArgs) => Promise<unknown>[]): Preload =>
    (args) => {
      if (args.intent === "preload") return;
      for (const p of start(args)) void p.catch(() => undefined);
    };
  return {
    home: on(() => [api.tools(), api.positions(), api.ladder(HOME_PRELOAD_EPISODE)]),
    ladder: on(({ location }) => [api.ladder(episodeParam(location.query["episode"]))]),
    // The live map only: a replay's first request depends on the run or party
    // the page resolves, which is the map's own business.
    map: on(({ location }) =>
      location.query["run"] === undefined && location.query["party"] === undefined ? [api.positions()] : [],
    ),
    runs: on(() => [api.results("all", true, "all")]),
    models: on(() => [api.models(), api.ladder("freeplay")]),
    about: on(() => [api.episodes()]),
    campaigns: on(() => [api.campaigns()]),
    fleet: on(() => [api.runs()]),
    character: on(({ params }) => (params["id"] === undefined ? [] : [api.character(params["id"])])),
  };
}
