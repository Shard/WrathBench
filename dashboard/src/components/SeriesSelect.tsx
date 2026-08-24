/*
 * The harness-series selector, in the top bar next to the status badge.
 *
 * One control for the whole dashboard (ADR-0046): the series is the
 * comparability group (ADR-0034), so every page that shows runs is a view of
 * one, and the operator chose to say which one once rather than on each page.
 *
 * A `<select>` rather than the chips the episode filter uses: the set of series
 * grows with every minor bump and would eventually wrap the header, and this is
 * a setting the reader changes rarely, not a comparison they flick between.
 */

import { For, Show } from "solid-js";
import { useFeeds } from "../lib/feeds";
import { type SeriesChoice, seriesOptions } from "../lib/harness";

export function SeriesSelect() {
  const feeds = useFeeds();
  return (
    <label
      class="series"
      title="Harness series (ADR-0034): the comparability group every page filters to. `latest` follows the newest series rather than pinning to it."
    >
      <span class="dim">series</span>
      <select
        value={feeds.seriesChoice()}
        onChange={(e) => feeds.setSeriesChoice(e.currentTarget.value as SeriesChoice)}
      >
        <For each={seriesOptions(feeds.seriesAvailable(), feeds.seriesChoice())}>
          {(o) => <option value={o.value}>{o.label}</option>}
        </For>
      </select>
    </label>
  );
}

/**
 * What the shell's series filter removed from this page.
 *
 * A page that silently drops rows is a lie of omission — the rule
 * `EpisodeFilterNote` already states for the tier filter. It matters more here,
 * because the control doing the dropping is in the header rather than on the
 * page the reader is looking at.
 */
export function SeriesFilterNote(props: { series: string | null; filteredOut: number }) {
  return (
    <Show when={props.series !== null && props.filteredOut > 0}>
      <p class="dim">
        {props.filteredOut} run{props.filteredOut === 1 ? "" : "s"} not shown: not on harness series{" "}
        {props.series} — the series selector in the header decides this, and{" "}
        <span class="mono">all</span> shows every series, including runs whose stamp names none.
      </p>
    </Show>
  );
}
