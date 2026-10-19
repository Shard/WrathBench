/*
 * The harness-series selector, in the top bar next to the status badge.
 *
 * One control for the whole dashboard: the series is the comparability
 * group, so every page that shows runs is a view of one, and the operator
 * chose to say which one once rather than on each page.
 *
 * A `<select>` rather than the chips the episode filter uses: the set of series
 * grows with every minor bump and would eventually wrap the header, and this is
 * a setting the reader changes rarely, not a comparison they flick between.
 */

import { For } from "solid-js";
import { useFeeds } from "../lib/feeds";
import {
  type SeriesChoice,
  displayedChoice,
  filterBySeries,
  pageSeries,
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
      title={'Harness series — the harness version line a run was played on; runs are only comparable within one. "latest" follows the newest version rather than pinning to it.'}
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
 * What the shell's series filter left of this page's rows. No count of what
 * it removed: the control doing the dropping is in the header, labelled, and
 * says what it does in its own hover.
 */
export interface SeriesFilterResult<T> {
  /** What the shell's choice resolves to for this page's rows, or null for "all". */
  series: () => string | null;
  /** The rows that survive the filter. */
  kept: () => T[];
}

/**
 * The shell's series filter, applied to one page's rows: `pageSeries` then
 * `filterBySeries` as one hook. `active` lets a page keep the shell's series
 * available without applying it — the ladder's freeplay view, where a
 * character is durable across series.
 */
export function useSeriesFilter<
  T extends { harnessSeries?: string | null; harnessVersion?: string | null },
>(rows: () => readonly T[], active: () => boolean = () => true): SeriesFilterResult<T> {
  const feeds = useFeeds();
  const series = (): string | null =>
    active() ? pageSeries(feeds.seriesChoice(), feeds.seriesAvailable(), rows()) : null;
  const kept = (): T[] => filterBySeries(rows(), series());
  return { series, kept };
}
