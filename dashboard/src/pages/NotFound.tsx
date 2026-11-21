import { A } from "@solidjs/router";
import { Show } from "solid-js";
import { useFeeds } from "../lib/feeds";
import { homeTarget } from "../lib/site";

/**
 * The 404. A dead end with no way out of it is the one page a reader cannot
 * act on, so it carries the way back that every other page's chrome gives.
 * The homepage is named only while `/` is the intro (`site.home`).
 */
export default function NotFound() {
  const feeds = useFeeds();
  return (
    <div class="page">
      <h1>no such page</h1>
      <p class="dim">
        Nothing is served at this address.{" "}
        <Show when={homeTarget(feeds.info.latest) === null}>
          The <A href="/">homepage</A> explains what WrathBench is;{" "}
        </Show>
        <A href="/runs">runs</A> is every recorded run.
      </p>
    </div>
  );
}
