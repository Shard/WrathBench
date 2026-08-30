/*
 * The shell: one nav, the service status badge, one scroll container. The map
 * opts out of scrolling. The shell owns the shared feeds (`lib/feeds.ts`) so
 * the badge and the fleet page read one `/api/fleet` poller between them.
 *
 * The public build adds two things nothing else can carry: how stale the
 * published data is, and the attribution every published artifact needs. Both
 * are properties of the whole view rather than of any page, which is what puts
 * them here beside the badge and the build notice.
 */

import { A, useLocation, useSearchParams } from "@solidjs/router";
import { For, Show, createSignal, onCleanup, type ParentProps } from "solid-js";
import { snapshotSource } from "../api/client";
import { snapshotBanner, type SnapshotBanner, type SnapshotSource } from "../api/snapshot-client";
import { useClock } from "../lib/clock";
import { NAV } from "../lib/nav";
import { FeedsContext, createFeeds } from "../lib/feeds";
import { SeriesSelect } from "./SeriesSelect";
import { StatusBadge } from "./StatusBadge";

/**
 * The public build's freshness line, and the attribution that must ride with
 * any published artifact (docs/DATA-AND-LEGAL.md).
 *
 * Only the public build has either, so the signal, the subscription and the
 * one-second clock behind "Ns ago" are all created inside this branch rather
 * than sitting unused in the private one.
 */
function snapshotShell(source: SnapshotSource): { banner: () => SnapshotBanner | null; attribution: () => string | null } {
  const [state, setState] = createSignal(source.state());
  onCleanup(source.subscribe((next) => setState(next)));
  const now = useClock();
  return {
    banner: () => snapshotBanner(state(), now()),
    attribution: () => state().attribution,
  };
}

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
  const snapshot = snapshotSource === null ? null : snapshotShell(snapshotSource);
  return (
    <FeedsContext.Provider value={feeds}>
    <div class="app">
      <header class="top">
        <h1>
          <A href="/">WrathBench</A>
        </h1>
        <nav>
          <For each={NAV}>{(n) => <A href={n.href} activeClass="on">{n.label}</A>}</For>
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
          * Beside the build notice for the same reasons: it reports on the
          * service rather than on any page, and the map's flush layout has no
          * room to spare. It is its own clock — the heartbeat in the status
          * badge is the supervisor's silence, this is the publisher's, and
          * three clocks the reader could conflate is exactly what the public
          * build must not ship (docs/PUBLIC-DASHBOARD.md).
          */}
        <Show when={snapshot?.banner()}>
          {(b) => (
            <span
              class={`snapshot-age ${b().tone}`}
              title="This dashboard reads published snapshots, not the live harness. The age is how long ago the lab last pushed one."
            >
              {b().text}
            </span>
          )}
        </Show>
        {/*
          * The one series filter for the whole dashboard, next to
          * the badge for the same reason the badge is here: it is a property of
          * the whole view rather than of any page, and a per-page copy of it
          * was four controls that could disagree.
          */}
        <SeriesSelect />
        <StatusBadge />
      </header>
      <main class={flush() ? "flush" : ""}>{props.children}</main>
      {/* Required of every published artifact; see docs/DATA-AND-LEGAL.md. */}
      <Show when={snapshot?.attribution()}>{(a) => <footer class="attribution">{a()}</footer>}</Show>
    </div>
    </FeedsContext.Provider>
  );
}
