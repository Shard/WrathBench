/**
 * The feeds the whole shell shares.
 *
 * `/api/fleet` is polled once, from the Layout, because two things read it on
 * every page: the status badge in the top bar, and the fleet page when it is
 * the page. One poller rather than one per consumer keeps ADR-0022's polling
 * budget where it was when only the fleet page read it. `/api/info` rides
 * along for the same reason — the badge names the worldserver's build.
 */

import { createContext, useContext } from "solid-js";
import type { ApiInfoResponse, FleetResponse } from "@viewer/api-types";
import { api } from "../api/client";
import { type Poll, poll } from "./poll";

export interface Feeds {
  fleet: Poll<FleetResponse>;
  /** Slow on purpose: a build stamp changes on a deploy, not on a tick. */
  info: Poll<ApiInfoResponse>;
}

export const FeedsContext = createContext<Feeds>();

/** Start the shared pollers; called once, in the shell. */
export function createFeeds(): Feeds {
  return {
    fleet: poll(() => api.fleet(), 5_000),
    info: poll(() => api.info(), 60_000),
  };
}

export function useFeeds(): Feeds {
  const feeds = useContext(FeedsContext);
  if (feeds === undefined) throw new Error("useFeeds outside the Layout");
  return feeds;
}
