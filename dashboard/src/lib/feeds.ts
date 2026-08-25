/**
 * The feeds the whole shell shares.
 *
 * `/api/fleet` is polled once, from the Layout, because two things read it on
 * every page: the status badge in the top bar, and the fleet page when it is
 * the page. One poller rather than one per consumer keeps the dashboard's polling
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
  /** True once the served dashboard build differs from the one this tab loaded. */
  stale: () => boolean;
}

/**
 * Whether this tab is running a bundle the server has since replaced.
 *
 * Vite empties `dist/` on every build, so an open tab keeps executing whatever
 * it loaded — possibly hours and several commits old — while any lazy chunk it
 * has not yet fetched is now a 404. The cost is not the crash: it is that a
 * report of "X is broken" can describe code that no longer exists, and half an
 * hour goes into establishing that (item 64).
 *
 * `first` is the build id the tab saw on its FIRST successful poll, which is
 * its own: `index.html` is served `no-store`, so a tab that loaded ran the
 * build that was current when it loaded. A null on either side is "cannot
 * tell" and never stale — an unidentifiable build must not nag.
 */
export function isStaleBuild(first: string | null | undefined, current: string | null | undefined): boolean {
  if (first === null || first === undefined) return false;
  if (current === null || current === undefined) return false;
  return first !== current;
}

export const FeedsContext = createContext<Feeds>();

/** Start the shared pollers; called once, in the shell. */
export function createFeeds(): Feeds {
  const info = poll(() => api.info(), 60_000);
  // Captured once, on the first poll that carries a build id, and never
  // rewritten: the whole comparison is "what I loaded" against "what is served
  // now", so letting it follow the newest value would make it always equal.
  let first: string | null | undefined;
  return {
    fleet: poll(() => api.fleet(), 5_000),
    info,
    stale: (): boolean => {
      const now = info.latest?.dashboardBuild;
      if (first === undefined && now !== undefined) first = now;
      return isStaleBuild(first, now);
    },
  };
}

export function useFeeds(): Feeds {
  const feeds = useContext(FeedsContext);
  if (feeds === undefined) throw new Error("useFeeds outside the Layout");
  return feeds;
}
