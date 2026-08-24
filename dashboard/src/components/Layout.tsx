/*
 * The shell: one nav, the service status badge, one scroll container. The map
 * opts out of scrolling. The shell owns the shared feeds (`lib/feeds.ts`) so
 * the badge and the fleet page read one `/api/fleet` poller between them.
 */

import { A, useLocation, useSearchParams } from "@solidjs/router";
import { Show, type ParentProps } from "solid-js";
import { FeedsContext, createFeeds } from "../lib/feeds";
import { SeriesSelect } from "./SeriesSelect";
import { StatusBadge } from "./StatusBadge";

export function Layout(props: ParentProps) {
  const location = useLocation();
  const flush = (): boolean => location.pathname === "/map";
  // The shell owns the router, so it hands `createFeeds` the `?series=` half of
  // the selection rather than the state module reaching for the router itself.
  const [params, setParams] = useSearchParams();
  const feeds = createFeeds({
    read: () => params.series,
    write: (v) => setParams({ series: v }, { replace: true }),
  });
  return (
    <FeedsContext.Provider value={feeds}>
    <div class="app">
      <header class="top">
        <h1>
          <A href="/">WrathBench</A>
        </h1>
        <nav>
          <A href="/" end={true} activeClass="on">
            fleet
          </A>
          <A href="/map" activeClass="on">
            map
          </A>
          <A href="/runs" activeClass="on">
            runs
          </A>
          <A href="/ladder" activeClass="on">
            ladder
          </A>
          <A href="/episodes" activeClass="on">
            episodes
          </A>
          <A href="/models" activeClass="on">
            models
          </A>
          <A href="/campaigns" activeClass="on">
            campaigns
          </A>
        </nav>
        <span class="spacer" />
        {/*
          * In the header rather than as a page banner: it belongs next to the
          * other thing that reports on the service, it survives the map's flush
          * layout, and it costs no vertical space on a page that is mostly
          * canvas. A button rather than a notice because there is exactly one
          * thing to do about it, and it never dismisses itself — the tab really
          * is running replaced code until it reloads, and a notice that goes
          * away by itself is how half an hour gets spent debugging a bug that
          * no longer exists (item 64).
          */}
        <Show when={feeds.stale()}>
          <button
            type="button"
            class="update"
            title="A newer dashboard build is on the server. This tab is still running the one it loaded, so anything odd may already be fixed."
            onClick={() => window.location.reload()}
          >
            new build — reload
          </button>
        </Show>
        {/*
          * The one series filter for the whole dashboard (ADR-0046), next to
          * the badge for the same reason the badge is here: it is a property of
          * the whole view rather than of any page, and a per-page copy of it
          * was four controls that could disagree.
          */}
        <SeriesSelect />
        <StatusBadge />
      </header>
      <main class={flush() ? "flush" : ""}>{props.children}</main>
    </div>
    </FeedsContext.Provider>
  );
}
