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
 *
 * A hundred rows to a page (operator, 2026-10-24; `PAGE_SIZE`). The filter and
 * the sort run over every row before the page is cut, so the counts are the
 * whole set's and page 1 of a sort is its true top; the page is a URL param
 * like the rest, a new filter or sort starts again at page 1, and a poll never
 * moves the reader off the page they are on.
 *
 * The table's links are plain anchors: the router already client-routes any
 * same-origin `<a>` click from one listener on the document, leaving modified
 * and middle clicks to the browser, and its `<A>` cost ~7,000 component setups
 * per render for an `active` class this table never draws.
 */

import { useLocation, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, on } from "solid-js";
import { api, type ResultRun, type ResultsResponse } from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { ModelIcon } from "../components/ModelIcon";
import { useFeeds } from "../lib/feeds";
import { costMark, effortLabel, fmtDuration, fmtUsd, fmtWhen, modelDisplay, num, resolvedLabel, shortHarness, shortRunId, stamp } from "../lib/format";
import { filterBySeries, pageSeries } from "../lib/harness";
import { hasLineage, lineageIndex, type Lineage } from "@viewer/lineage";
import {
  COLUMN_TITLES,
  RUN_COLUMNS,
  clampPage,
  columnClass,
  costOf,
  filterLabel,
  filterParams,
  filterRuns,
  isFiltered,
  keepRowIdentity,
  kindOf,
  nextSort,
  pageCount,
  pageParam,
  pageQuery,
  pageSlice,
  pagerItems,
  sortParam,
  sortQuery,
  sortRuns,
  statusOf,
  statusText,
  statusTitle,
  statusTone,
  turnsOf,
  type RunColumn,
  type RunSort,
} from "../lib/runs";
import { LevelXp } from "../components/CharacterFacts";
import { InfoHint } from "../components/InfoHint";
import { poll } from "../lib/poll";
import { displayError } from "../lib/errors";
import { groupParties, memberClass, partyHref } from "../lib/party";

/** A live run's level and duration move; the roster of runs moves when one starts or ends. */
const POLL_MS = 15_000;

export default function Runs() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const sort = (): RunSort => sortParam(params.sort, params.dir);
  const filter = createMemo(() => filterParams(params));
  const feed = poll(() => api.results("all", true, "all"), POLL_MS);
  const body = (): ResultsResponse | undefined => feed.latest;

  // The shell's harness series: the one filter this page does not own.
  const feeds = useFeeds();
  /* Each unchanged run stays the object it was, so a poll redraws only the rows that moved (`keepRowIdentity`). */
  const served = createMemo<ResultRun[]>((prev) => keepRowIdentity(prev, body()?.runs ?? []), []);
  const series = (): string | null => pageSeries(feeds.seriesChoice(), feeds.seriesAvailable(), served());
  const inSeries = createMemo((): ResultRun[] => filterBySeries(served(), series()));
  // A party's members together wherever the sort put the first of them (`groupParties`).
  const rows = createMemo(() => groupParties(sortRuns(filterRuns(inSeries(), filter()), sort())));
  /* The page is cut from the whole sorted set, never the other way round. */
  const pages = (): number => pageCount(rows().length);
  const page = (): number => clampPage(pageParam(params.page), rows().length);
  const shown = createMemo(() => pageSlice(rows(), page()));
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

  // A new sort or filter is a new list, so it opens at its top.
  const setSort = (column: RunColumn): void =>
    setParams({ ...sortQuery(nextSort(sort(), column)), ...pageQuery(1) }, { replace: true });
  const clear = (): void =>
    setParams(
      { model: null, effort: null, compactWindow: null, episode: null, harness: null, character: null, campaign: null, ...pageQuery(1) },
      { replace: true },
    );
  // The shell's series selector is a filter too; its choice, not what it
  // resolves to, so a poll that brings a new series moves no one.
  createEffect(
    on(
      () => feeds.seriesChoice(),
      () => {
        if (params.page !== undefined) setParams(pageQuery(1), { replace: true });
      },
      { defer: true },
    ),
  );
  let tableTop: HTMLDivElement | undefined;
  const goPage = (n: number): void => {
    setParams(pageQuery(n), { replace: true });
    // `main` scrolls, not the window, so the router's own scroll-to-top never
    // reaches it: a reader paging from the foot of the table is taken to its head.
    const above = tableTop?.closest("main")?.getBoundingClientRect().top ?? 0;
    if (tableTop !== undefined && tableTop.getBoundingClientRect().top < above) tableTop.scrollIntoView({ block: "start" });
  };
  /*
   * The query a row carries to the run page, so its "← runs" comes back to this
   * exact view. The location's own search string, verbatim: the run page reads
   * no params of its own, and rebuilding the query here would be a second
   * spelling of it. Read through the router so a sort or a page turn reaches
   * the rows already on screen.
   */
  const query = (): string => location.search;
  const live = createMemo(() => rows().filter((r) => statusOf(r) === "live").length);

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>

      <h1>
        runs
        <InfoHint
          label="about this table"
          text={
            "Every recorded run, newest first. Click a header to sort; click a model, episode, character or kind to narrow to it. A launch that never produced a model response is archived by the runner as it exits and never reaches this table.\n" +
            "Duration is active time: stretches between a pause and its resume are not charged. Cost is the actual figure — what the provider reported billing — and is blank wherever nothing was reported rather than showing the price table's estimate.\n" +
            "Turns are the driver turns the provider reported usage for, or model responses where it reported none."
          }
        />
      </h1>

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
        <Pager page={page()} count={pages()} go={goPage} />
        <div class="scroller runs-scroller" ref={tableTop}>
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
              <For each={shown()}>
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
        <Pager page={page()} count={pages()} go={goPage} />
      </Show>
    </div>
  );
}

/**
 * The page turner: previous, the first and last pages, the current one and its
 * neighbours, next. Nothing at all when everything fits on one page.
 */
function Pager(props: { page: number; count: number; go: (page: number) => void }) {
  return (
    <Show when={props.count > 1}>
      <nav class="chips pager" aria-label="pages">
        <button type="button" title="previous page" disabled={props.page <= 1} onClick={() => props.go(props.page - 1)}>
          ‹
        </button>
        <For each={pagerItems(props.page, props.count)}>
          {(p) =>
            p === null ? (
              <span class="dim">…</span>
            ) : (
              <button
                type="button"
                classList={{ on: p === props.page }}
                aria-current={p === props.page ? "page" : undefined}
                onClick={() => props.go(p)}
              >
                {p}
              </button>
            )
          }
        </For>
        <button type="button" title="next page" disabled={props.page >= props.count} onClick={() => props.go(props.page + 1)}>
          ›
        </button>
      </nav>
    </Show>
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
    q.delete("compactWindow");
    // A narrower list opens at its own top.
    q.delete("page");
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
            <a href={href()} title={r().runId}>
              {shortRunId(r().runId)}
            </a>
            {/* A durable freeplay character is one character across attempts, and
                this line is the whole of the link between them: the table sorts
                thirteen ways, so a11 is often nowhere near a12 and the text has
                to carry what adjacency cannot. */}
            <Show when={lin()}>
              {(l) => (
                <div class="dim" title="a durable freeplay character: one character, continued across attempts">
                  {/* Freeplay rows lead to the character; scored rows lead to
                      the run. The link is on the lineage line rather
                      than on the id because a reader clicking a run id means
                      that session, and only a row that HAS a chain has
                      somewhere else worth going. */}
                  <a href={`/character/${encodeURIComponent(l().characterId)}`} title={l().characterId}>
                    attempt {l().attempt} of {l().attempts}
                  </a>
                  <Show when={l().previous}>
                    {(p) => (
                      <>
                        {" · continues "}
                        <a href={runHref(p())} title={p()}>
                          {shortRunId(p())}
                        </a>
                      </>
                    )}
                  </Show>
                  <Show when={l().previous !== l().characterId && l().attempt > 2}>
                    {" · from "}
                    <a href={runHref(l().characterId)} title={l().characterId}>
                      {shortRunId(l().characterId)}
                    </a>
                  </Show>
                </div>
              )}
            </Show>
            {/* A party member: one of the runs its attempt is, and the way to
                all of them together. */}
            <Show when={r().party}>
              {(p) => (
                <div class="dim" title={p().id}>
                  <span class={`swatch ${memberClass(p().index ?? 0)}`} />
                  <a href={partyHref(p().id)}>party {shortRunId(p().id)}</a> · {p().role ?? p().member}
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
              <a
                href={narrow({
                  model: r().model!,
                  ...(r().effort !== null ? { effort: r().effort! } : {}),
                  ...(r().compactWindow != null ? { compactWindow: r().compactWindow! } : {}),
                })}
                title={`${r().model} — narrow to this model`}
              >
                {modelDisplay(r().model!)}
              </a>
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
        return <td class="dim">{effortLabel(r().effort, r().compactWindow) ?? "—"}</td>;
      case "kind":
        return (
          <td class="dim" title={r().unscored ?? ""}>
            <Show when={r().campaign !== null} fallback={kindOf(r())}>
              <a href={narrow({ campaign: r().campaign! })} title="narrow to this campaign">
                {kindOf(r())}
              </a>
            </Show>
          </td>
        );
      case "episode":
        return (
          <td class="dim" title={r().episodeSource === "derived" ? "labeled by the reader, never enrolled" : ""}>
            <Show when={r().episode !== null} fallback="—">
              <a href={narrow({ episode: r().episode! })} title="narrow to this episode">
                {r().episode}
              </a>
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
                  <a href={narrow({ character: r().characterLabel! })} title="narrow to this race and class">
                    {r().characterLabel}
                  </a>
                </div>
              </Show>
            </Show>
          </td>
        );
      case "status":
        return (
          <td class={statusTone(statusOf(r()))} title={statusTitle(statusOf(r()))}>
            {statusText(r())}
          </td>
        );
      case "level":
        return (
          <td class="right mono">
            <LevelXp level={r().maxLevel} xp={r().xp} compact />
          </td>
        );
      case "turns":
        return <td class="right mono dim">{num(turnsOf(r()))}</td>;
      case "duration":
        return <td class="right mono dim">{fmtDuration(r().playtimeMs)}</td>;
      case "cost":
        return (
          <td class="right mono dim" title={r().actualCost?.note ?? "no cost recorded for this run"}>
            {costOf(r()) === null ? "—" : `${fmtUsd(costOf(r()))}${costMark(r().actualCost)}`}
          </td>
        );
    }
  };
  /* The rail is the cheap half of the same fact: where the sort does put a
     character's attempts together, they read as one block. */
  return <tr class={lin() !== undefined || r().party !== undefined ? "character" : ""}>{RUN_COLUMNS.map(cell)}</tr>;
}
