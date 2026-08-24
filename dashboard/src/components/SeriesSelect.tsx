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
import {
  type SeriesChoice,
  displayedChoice,
  filterBySeries,
  pageSeries,
  seriesFilteredOut,
  seriesOptions,
} from "../lib/harness";

export function SeriesSelect() {
  const feeds = useFeeds();
  // What the control shows: a stale link naming a series no run carries
  // resolves to `latest`, and the control has to say so rather than the number.
  const shown = (): SeriesChoice => displayedChoice(feeds.seriesChoice(), feeds.seriesAvailable());
  return (
    <label
      class="series"
      title="Harness series (ADR-0034): the comparability group every page filters to. `latest` follows the newest series rather than pinning to it."
    >
      <span class="dim">series</span>
      {/*
        * `selected` on each option rather than `value` on the select alone:
        * `<For>` disposes and recreates every option when the series list
        * arrives on a poll, and a select whose options are all replaced resets
        * to the first one — the choice has not changed, so nothing re-runs to
        * put it back. The attribute makes the DOM say which one is current, and
        * makes it checkable without a scripted browser.
        */}
      <select onChange={(e) => feeds.setSeriesChoice(e.currentTarget.value as SeriesChoice)}>
        <For each={seriesOptions(feeds.seriesAvailable(), shown())}>
          {(o) => (
            <option value={o.value} selected={o.value === shown()}>
              {o.label}
            </option>
          )}
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
export interface SeriesFilterResult<T> {
  /** What the shell's choice resolves to for this page's rows, or null for "all". */
  series: () => string | null;
  /** The rows that survive the filter. */
  kept: () => T[];
  /** How many of the input rows the filter removed. */
  filteredOut: () => number;
}

/**
 * The shell's series filter, applied to one page's rows.
 *
 * Every page that shows runs did `pageSeries` → `filterBySeries` →
 * `seriesFilteredOut` as three separate call sites; this is that triple as one
 * hook, so a page reads its filtered rows and prints `<SeriesFilterNote>`
 * without re-deriving the same three values. `active` lets a page keep the
 * shell's series available without applying it — the map's replay mode, which
 * is one named run and must not vanish because of a header control.
 */
export function useSeriesFilter<
  T extends { harnessSeries?: string | null; harnessVersion?: string | null },
>(rows: () => readonly T[], active: () => boolean = () => true): SeriesFilterResult<T> {
  const feeds = useFeeds();
  const series = (): string | null =>
    active() ? pageSeries(feeds.seriesChoice(), feeds.seriesAvailable(), rows()) : null;
  const kept = (): T[] => filterBySeries(rows(), series());
  const filteredOut = (): number => seriesFilteredOut(rows().length, kept().length);
  return { series, kept, filteredOut };
}

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
