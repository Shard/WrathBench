/* The shell: one nav, one scroll container. The map opts out of scrolling. */

import { A, useLocation } from "@solidjs/router";
import type { ParentProps } from "solid-js";

export function Layout(props: ParentProps) {
  const location = useLocation();
  const flush = (): boolean => location.pathname === "/map";
  return (
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
          <A href="/eval" activeClass="on">
            eval
          </A>
          <A href="/ladder" activeClass="on">
            ladder
          </A>
          <A href="/episodes" activeClass="on">
            episodes
          </A>
        </nav>
        <span class="spacer" />
      </header>
      <main class={flush() ? "flush" : ""}>{props.children}</main>
    </div>
  );
}
