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
import { SERIES_LATEST, type SeriesChoice, readSeriesPref, seriesParam, writeSeriesPref } from "./harness";

export interface Feeds {
  fleet: Poll<FleetResponse>;
  /** Slow on purpose: a build stamp changes on a deploy, not on a tick. */
  info: Poll<ApiInfoResponse>;
  /** True once the served dashboard build differs from the one this tab loaded. */
  stale: () => boolean;
  /**
   * The one harness-series selection, owned by the shell because the
   * operator decided it is one choice for the whole dashboard rather than a
   * control per page.
   */
  seriesChoice: () => SeriesChoice;
  setSeriesChoice: (v: SeriesChoice) => void;
  /** The series `/api/info` says have runs, newest first; empty on an older viewer. */
  seriesAvailable: () => string[];
}

/**
 * Whether this tab is running a bundle the server has since replaced.
 *
 * Vite empties `dist/` on every build, so an open tab keeps executing whatever
 * it loaded — possibly hours and several commits old — while any lazy chunk it
 * has not yet fetched is now a 404. The cost is not the crash: it is that a
 * report of "X is broken" can describe code that no longer exists, and half an
 * hour goes into establishing that.
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
/**
 * The URL half of the series selection, injected rather than read here.
 *
 * `useSearchParams` would drag `@solidjs/router` into this module, and the
 * router's entry throws on import outside a browser — which would take the
 * tests of the pure helpers in this file down with it. The shell owns the
 * router; this file owns the state.
 */
export interface SeriesUrl {
  read: () => string | string[] | undefined;
  write: (v: string) => void;
}

export function createFeeds(url: SeriesUrl): Feeds {
  const info = poll(() => api.info(), 60_000);
  const seriesAvailable = (): string[] => (info.latest?.harnessSeries ?? []).map((s) => s.series);
  /*
   * URL first, then what this browser last chose, then `latest`. The URL wins
   * so a shared link means what its sender saw; the remembered choice is a
   * convenience for the operator's own tab, and `latest` is the default the
   * operator asked for. `latest` is kept as the token rather than the series it
   * resolves to today, so it follows a minor bump instead of freezing.
   */
  const seriesChoice = (): SeriesChoice =>
    seriesParam(url.read()) ?? readSeriesPref() ?? SERIES_LATEST;
  const setSeriesChoice = (v: SeriesChoice): void => {
    writeSeriesPref(v);
    url.write(v);
  };
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
    seriesChoice,
    setSeriesChoice,
    seriesAvailable,
  };
}

export function useFeeds(): Feeds {
  const feeds = useContext(FeedsContext);
  if (feeds === undefined) throw new Error("useFeeds outside the Layout");
  return feeds;
}
