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
import { SNAPSHOT_MODE, snapshotSource } from "../api/client";
import { snapshotBanner, type SnapshotBanner, type SnapshotSource } from "../api/snapshot-client";
import { useClock } from "../lib/clock";
import { navItems, surface } from "../lib/nav";
import { FeedsContext, createFeeds } from "../lib/feeds";
import { REPO_URL, repoLabel } from "../lib/repo";
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
function snapshotShell(source: SnapshotSource): { banner: () => SnapshotBanner; attribution: () => string } {
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
  /*
   * Which site this is. One derivation for the badge and the config nav item
   * (`lib/nav.ts`), so the two can never disagree; null until `/api/info` has
   * settled on a private build, and nothing is drawn in the meantime.
   */
  const which = (): ReturnType<typeof surface> => surface(SNAPSHOT_MODE, feeds.info.latest?.publicMode);
  /* Required of every published artifact; see docs/DATA-AND-LEGAL.md. Null on
     the private build, which publishes nothing and so attributes nothing. */
  const attribution = () => {
    const text = snapshot?.attribution();
    return text === undefined || text === "" ? null : attributionFooter(text);
  };
  return (
    <FeedsContext.Provider value={feeds}>
    <div class="app">
      <header class="top">
        {/*
          The wordmark is not this page's heading: every page under it has one
          of its own, and two h1s on a document is two answers to "what is
          this". A div with the same rule, so nothing about it moved
          (operator, 2026-09-18).
        */}
        <div class="wordmark">
          <A href="/">WrathBench</A>
          {/*
            Which of the two sites this is, set as a superscript on the wordmark
            the way an exponent sits on a number (operator, 2026-09-18): the
            public preview and the operator's own admin view are otherwise
            identical, and the difference is worth one small word right where
            the name is. Its own two colours, neither an accent used elsewhere,
            so it reads as an identity rather than a status.
          */}
          <Show when={which()}>
            {(w) => (
              <sup
                class={`surface ${w().toLowerCase()}`}
                title={w() === "ADMIN" ? "the operator's own view: the config page is live here" : "the published preview: no config page, and no write surface at all"}
              >
                {w()}
              </sup>
            )}
          </Show>
        </div>
        <nav>
          {/*
            The operator's config page is in the bar only on a private build
            served by a private viewer — the routes behind it are not mounted
            in public mode, and `=== false` rather than `!publicMode` keeps the
            link from flashing on before the first `/api/info` settles.
          */}
          <For each={navItems(which() === "ADMIN")}>
            {(n) => (
              <A href={n.href} activeClass="on">
                {n.label}
              </A>
            )}
          </For>
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
        {/* From the build's own constants first: the line is a fact about this build, not about a fetch. */}
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
      {/*
        * The footer rides INSIDE the scroll container on every page that
        * scrolls, so it sits at the end of the content rather than pinned to
        * the bottom of the viewport — on a phone the pinned strip cost two or
        * three permanent lines (operator, 2026-09-18). The map is the one page
        * that cannot take it: `main.flush` is a canvas sized to the viewport
        * and does not scroll, so there is no end of the page to put it at, and
        * the attribution is required on every published view rather than
        * optional per page. There it stays a sibling of `main`, where it was.
        */}
      <main class={flush() ? "flush" : ""}>
        {props.children}
        <Show when={!flush()}>{attribution()}</Show>
      </main>
      <Show when={flush()}>{attribution()}</Show>
    </div>
    </FeedsContext.Provider>
  );
}

/**
 * The attribution footer itself, as one function called from the two places
 * the shell can put it — never rendered twice, because the two `Show`s are on
 * opposite sides of the same condition.
 */
function attributionFooter(text: string) {
  return (
    <footer class="attribution">
      {/* Only once there is a public repository to send a reader to; see lib/repo.ts. */}
      <Show when={REPO_URL}>
        {(url) => (
          <a class="repo" href={url()} rel="noopener" target="_blank">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
              />
            </svg>
            {repoLabel(url())}
          </a>
        )}
      </Show>
      <span class="legal">{text}</span>
    </footer>
  );
}
