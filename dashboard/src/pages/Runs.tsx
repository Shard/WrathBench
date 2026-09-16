/**
 * Runs: every run the viewer knows about, as a spreadsheet.
 *
 * One page per grain: the fleet page is what is running
 * *now*, the ladder is aggregates over runs, and this is the runs — probe,
 * campaign, freeplay, scored, live, paused, ended, on any harness series the
 * shell's selector admits. It opens on all of them, newest first, and the
 * reader sorts by clicking a header. The sort and every filter live in the URL
 * so a view can be handed to someone else; a row links to the run page, which
 * links back here with the same query.
 *
 * Nothing is decided here. Scorability, episode membership and the series arrive
 * decided on each row from `/api/results`, asked for with every filter lifted
 * (`episode=all`, overrides included) because an inventory that hides a run is
 * not an inventory. The only narrowing left is the shell's series selector,
 * which says what it removed, and the URL's own filters, which say the same.
 *
 * Filters are not a picker wall: a value in the table is a link that narrows
 * to it, and one line says what the view is narrowed to and how to clear it.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import { api, type ResultRun, type ResultsResponse } from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { ModelIcon } from "../components/ModelIcon";
import { SeriesFilterNote } from "../components/SeriesSelect";
import { useFeeds } from "../lib/feeds";
import { fmtDuration, fmtUsd, fmtWhen, modelDisplay, num, resolvedLabel, shortHarness, shortRunId, stamp } from "../lib/format";
import { filterBySeries, pageSeries } from "../lib/harness";
import { hasLineage, lineageIndex, type Lineage } from "@viewer/lineage";
import {
  COLUMN_TITLES,
  RUN_COLUMNS,
  columnClass,
  costOf,
  filterLabel,
  filterParams,
  filterRuns,
  isFiltered,
  kindOf,
  nextSort,
  sortParam,
  sortQuery,
  sortRuns,
  statusOf,
  statusText,
  turnsOf,
  type RunColumn,
  type RunSort,
} from "../lib/runs";
import { poll } from "../lib/poll";
import { displayError } from "../lib/errors";

/** A live run's level and duration move; the roster of runs moves when one starts or ends. */
const POLL_MS = 15_000;

export default function Runs() {
  const [params, setParams] = useSearchParams();
  const sort = (): RunSort => sortParam(params.sort, params.dir);
  const filter = createMemo(() => filterParams(params));
  const feed = poll(() => api.results("all", true, "all"), POLL_MS);
  const body = (): ResultsResponse | undefined => feed.latest;

  // The shell's harness series: the one filter this page does not own.
  const feeds = useFeeds();
  const served = (): ResultRun[] => body()?.runs ?? [];
  const series = (): string | null => pageSeries(feeds.seriesChoice(), feeds.seriesAvailable(), served());
  const inSeries = (): ResultRun[] => filterBySeries(served(), series());
  const rows = createMemo(() => sortRuns(filterRuns(inSeries(), filter()), sort()));
  /*
   * Freeplay lineage (`runner/viewer/lineage.ts`), so a12 does not read as an unrelated
   * row beside a11. Indexed over everything the server served rather than over
   * the rows on screen: a character that crossed a minor bump has its predecessor
   * outside the shell's series filter, and that is exactly where the reader
   * most needs to be told what the run continues. The link still resolves —
   * the run page takes any id.
   *
   * Stillborn launches drop out inside `lineageIndex`; their rows still list,
   * because an inventory shows every launch.
   */
  const lineage = createMemo(() => lineageIndex(served()));

  const setSort = (column: RunColumn): void => setParams(sortQuery(nextSort(sort(), column)), { replace: true });
  const clear = (): void =>
    setParams({ model: null, effort: null, episode: null, harness: null, character: null, campaign: null }, { replace: true });
  /*
   * The query a row carries to the run page, so its "← runs" comes back to this
   * exact view. The location's own search string, verbatim: the run page reads
   * no params of its own, and rebuilding the query here would be a second
   * spelling of it.
   */
  const query = (): string => (typeof window === "undefined" ? "" : window.location.search);
  const live = createMemo(() => rows().filter((r) => statusOf(r) === "live").length);

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>

      <h2 class="section">runs</h2>
      <p class="dim">
        Every recorded run, newest first. Click a header to sort; click a model, episode, character
        or kind to narrow to it. Aggregates are the <A href="/ladder">ladder</A>; what the episodes
        mean is on <A href="/about">about</A>. A launch that never produced a model response is
        archived by the runner as it exits and never reaches this table.
      </p>

      <SeriesFilterNote series={series()} filteredOut={served().length - inSeries().length} />

      <Show when={isFiltered(filter())}>
        <p class="dim">
          Filtered to <span class="mono">{filterLabel(filter())}</span> ({rows().length} of{" "}
          {inSeries().length} runs){" "}
          <button class="toggle" onClick={clear}>
            clear
          </button>
        </p>
      </Show>

      <Show when={feed.latest !== undefined} fallback={<p class="dim loading-page">loading…</p>}>
        <p class="dim">
          {rows().length} run{rows().length === 1 ? "" : "s"}
          <Show when={live() > 0}> · {live()} live</Show>
          {" · sorted by "}
          <span class="mono">
            {sort().column} {sort().dir}
          </span>
        </p>
        <div class="scroller">
          <table class="runs">
            <thead>
              <tr>
                <For each={RUN_COLUMNS}>
                  {(c) => (
                    /*
                      `aria-sort` belongs on the cell and the control belongs
                      inside it: a click handler on a bare <th> is unreachable
                      from the keyboard and announces nothing, and a button is
                      the one element that is both focusable and named without
                      inventing roles for a table header.
                    */
                    <th
                      class={`sortable ${columnClass(c)}${sort().column === c ? " sorted" : ""}`}
                      aria-sort={
                        sort().column === c ? (sort().dir === "asc" ? "ascending" : "descending") : "none"
                      }
                    >
                      <button
                        type="button"
                        class="sortbutton"
                        title={COLUMN_TITLES[c] ?? `sort by ${c}`}
                        onClick={() => setSort(c)}
                      >
                        {c}
                        <Show when={sort().column === c}>
                          <span class="sortmark" aria-hidden="true">
                            {sort().dir === "asc" ? "▲" : "▼"}
                          </span>
                        </Show>
                      </button>
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(r) => <RunRowView row={r} query={query()} lineage={lineage().get(r.runId)} />}
              </For>
              {/* "No runs match" is only true when something is doing the
                  matching; with no filter set it is an empty record, not a
                  narrow one. */}
              <Show when={rows().length === 0}>
                <tr>
                  <td colSpan={RUN_COLUMNS.length} class="dim">
                    {isFiltered(filter()) || series() !== null
                      ? "No runs match."
                      : "No runs recorded yet."}
                  </td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>
        <p class="dim">
          Duration is active time: stretches between a pause and its resume are not charged. Cost is
          the <em>actual</em> figure — what the provider reported billing — and is blank wherever
          nothing was reported rather than showing the price table's estimate; the estimate is on
          the run page, next to the actual. Turns are the driver turns the provider reported usage
          for, or model responses where it reported none.
        </p>
      </Show>
    </div>
  );
}

/**
 * One run. Every cell is rendered off `RUN_COLUMNS`, so a column cannot exist
 * in the header and not here: that drift is what the constant exists to stop.
 */
function RunRowView(props: { row: ResultRun; query: string; lineage: Lineage | undefined }) {
  const r = (): ResultRun => props.row;
  /** Undefined unless this run is part of a character: one attempt is not lineage. */
  const lin = (): Lineage | undefined => (hasLineage(props.lineage) ? props.lineage : undefined);
  const runHref = (id: string): string => `/run/${encodeURIComponent(id)}${props.query}`;
  const href = (): string => `/run/${encodeURIComponent(r().runId)}${props.query}`;
  const narrow = (patch: Record<string, string>): string => {
    const q = new URLSearchParams(props.query);
    q.delete("effort");
    for (const [k, v] of Object.entries(patch)) q.set(k, v);
    return `/runs?${q.toString()}`;
  };
  const cell = (c: RunColumn) => {
    switch (c) {
      case "started":
        return (
          <td class="dim" title={stamp(r().startedAt)}>
            {fmtWhen(r().startedAt)}
          </td>
        );
      case "run":
        return (
          <td>
            {/* The id's tail only: model, episode and date have their own
                columns, so the long prefix is repetition. The full id is the
                hover and the run page. */}
            <A href={href()} title={r().runId}>
              {shortRunId(r().runId)}
            </A>
            {/* A durable freeplay character is one character across attempts, and
                this line is the whole of the link between them: the table sorts
                thirteen ways, so a11 is often nowhere near a12 and the text has
                to carry what adjacency cannot. */}
            <Show when={lin()}>
              {(l) => (
                <div class="dim" title="a durable freeplay character: one character, continued across attempts">
                  {/* Freeplay rows lead to the character; scored rows lead to
                      the run (item 128). The link is on the lineage line rather
                      than on the id because a reader clicking a run id means
                      that session, and only a row that HAS a chain has
                      somewhere else worth going. */}
                  <A href={`/character/${encodeURIComponent(l().characterId)}`} title={l().characterId}>
                    attempt {l().attempt} of {l().attempts}
                  </A>
                  <Show when={l().previous}>
                    {(p) => (
                      <>
                        {" · continues "}
                        <A href={runHref(p())} title={p()}>
                          {shortRunId(p())}
                        </A>
                      </>
                    )}
                  </Show>
                  <Show when={l().previous !== l().characterId && l().attempt > 2}>
                    {" · from "}
                    <A href={runHref(l().characterId)} title={l().characterId}>
                      {shortRunId(l().characterId)}
                    </A>
                  </Show>
                </div>
              )}
            </Show>
          </td>
        );
      case "model":
        return (
          <td>
            {/* The family's mark, read from the model id; an id no
                family claims gets the neutral monogram, never a special case. */}
            <Show when={r().model !== null} fallback="—">
              <ModelIcon model={r().model} />
              <A
                href={narrow(r().effort === null ? { model: r().model! } : { model: r().model!, effort: r().effort! })}
                title={`${r().model} — narrow to this model`}
              >
                {modelDisplay(r().model!)}
              </A>
            </Show>
            {/* What the provider actually served, and only when it differs from
                what was asked for: a roster alias resolves at launch, so this
                is the one place a row says which Claude it really was. */}
            <Show when={resolvedLabel(r().model, r().resolvedModel)}>
              {(id) => (
                <div class="dim" title={`${id()} — the id the provider actually served`}>
                  {modelDisplay(id())}
                </div>
              )}
            </Show>
          </td>
        );
      case "harness":
        return (
          <td>
            <HarnessTag harness={r().harness} />
            <Show when={r().harnessVersion !== null}>
              {" "}
              <span class="dim mono" title={r().harnessVersion ?? ""}>
                {r().harnessSeries ?? shortHarness(r().harnessVersion)}
              </span>
            </Show>
          </td>
        );
      case "effort":
        return <td class="dim">{r().effort ?? "—"}</td>;
      case "kind":
        return (
          <td class="dim" title={r().unscored ?? ""}>
            <Show when={r().campaign !== null} fallback={kindOf(r())}>
              <A href={narrow({ campaign: r().campaign! })} title="narrow to this campaign">
                {kindOf(r())}
              </A>
            </Show>
          </td>
        );
      case "episode":
        return (
          <td class="dim" title={r().episodeSource === "derived" ? "labeled by the reader, never enrolled" : ""}>
            <Show when={r().episode !== null} fallback="—">
              <A href={narrow({ episode: r().episode! })} title="narrow to this episode">
                {r().episode}
              </A>
            </Show>
            <Show when={r().episodeSource === "derived"}> (labeled)</Show>
            <Show when={r().episodeOverride}>
              {" "}
              <span class="warn" title="stamped with this episode but run under different limits, so not a member of it">
                overridden
              </span>
            </Show>
          </td>
        );
      case "character":
        return (
          <td>
            <Show when={r().character !== null || r().characterLabel !== null} fallback="—">
              <Show when={r().character !== null}>
                <div>{r().character}</div>
              </Show>
              <Show when={r().characterLabel !== null}>
                <div class="dim">
                  <A href={narrow({ character: r().characterLabel! })} title="narrow to this race and class">
                    {r().characterLabel}
                  </A>
                </div>
              </Show>
            </Show>
          </td>
        );
      case "status":
        return (
          <td class={statusOf(r()) === "ended" ? "dim" : statusOf(r()) === "live" ? "ok" : "warn"}>
            {statusText(r())}
          </td>
        );
      case "level":
        return <td class="right mono">{num(r().maxLevel)}</td>;
      case "turns":
        return <td class="right mono dim">{num(turnsOf(r()))}</td>;
      case "duration":
        return <td class="right mono dim">{fmtDuration(r().playtimeMs)}</td>;
      case "cost":
        return (
          <td class="right mono dim" title={r().actualCost?.note ?? "no cost recorded for this run"}>
            {costOf(r()) === null ? "—" : fmtUsd(costOf(r()))}
          </td>
        );
    }
  };
  /* The rail is the cheap half of the same fact: where the sort does put a
     character's attempts together, they read as one block. */
  return <tr class={lin() === undefined ? "" : "character"}>{RUN_COLUMNS.map(cell)}</tr>;
}
