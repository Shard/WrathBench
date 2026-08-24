/*
 * The shell: one nav, the service status badge, one scroll container. The map
 * opts out of scrolling. The shell owns the shared feeds (`lib/feeds.ts`) so
 * the badge and the fleet page read one `/api/fleet` poller between them.
 */

import { A, useLocation } from "@solidjs/router";
import type { ParentProps } from "solid-js";
import { FeedsContext, createFeeds } from "../lib/feeds";
import { StatusBadge } from "./StatusBadge";

export function Layout(props: ParentProps) {
  const location = useLocation();
  const flush = (): boolean => location.pathname === "/map";
  const feeds = createFeeds();
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
          <A href="/results" activeClass="on">
            results
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
        <StatusBadge />
      </header>
      <main class={flush() ? "flush" : ""}>{props.children}</main>
    </div>
    </FeedsContext.Provider>
  );
}
