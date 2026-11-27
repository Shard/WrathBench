/**
 * The ladders, one episode id at a time — e90 by default — because a level
 * reached in six hours is not the same claim as the same level reached in
 * ninety minutes. There is no "all" and no overridden view: neither is a
 * comparability group, so neither can be a ladder, and there is no `probing`
 * either (a sweep varies its cells on purpose, so ranking its runs ranks the
 * sweep). The runs page lists every run regardless.
 *
 * `freeplay` is the one id that shows something else entirely: **the top
 * characters on freeplay right now** — the whole active field, one row per
 * durable character, paused and in-progress included — with the milestone
 * rungs each has reached and the playtime it reached each at
 * (`characterRows`, `characterMilestones` in `lib/ladder.ts`).
 *
 * Above the table, one scatter for the tier: average cost per run against
 * average XP earned, one point per roster entry (`components/LadderChart`),
 * with a row of curated views that swap the axes (`lib/axes.ts`; the view is
 * `?view=` so a reading is linkable, and the default is the cost/xp chart)
 * and a toggle that draws the Pareto front over the field (`lib/pareto.ts`;
 * `?pareto=1`, for the same reason). `?chart=lines` swaps the scatter for
 * every run as a line of xp against active playtime
 * (`components/RunLinesChart`), the freeplay chart's reading for a tier.
 * Freeplay gets its own graph in that place instead — `components/CharacterChart`,
 * one stepped series per character, level against cumulative active playtime; the
 * axis argument is in `lib/ladder.ts`.
 *
 * Scored rows are ordered by level, then xp within it, then gold (operator,
 * 2026-11-15) — a stated derivation over recorded signals, versioned with
 * `lib/ladder.ts`, each key in its own column, and none added to another:
 * there is no aggregate score. The rungs order nothing on these ladders; they
 * are freeplay achievements, and the freeplay view prints the rule each
 * applies, with "not instrumented" where nothing recorded can answer one.
 *
 * The Deadmines eval, `deadmines-solo`, is a tab of this page too, labelled
 * "deadmines", and reads something else again: the dungeon board
 * (`/api/dungeons`, derived in `viewer/dungeons.ts`), a row per model
 * condition on its best attempt. Above the table, the scatter's idiom for an
 * attempt (`components/DungeonChart`), with the tier's row of axis views in
 * its own vocabulary (`DUNGEON_VIEWS` in `lib/dungeons.ts`, on the same
 * `?view=`): time from launch against bosses killed by default, or the best
 * attempt's cost against bosses or, for the attempts that got furthest,
 * against time. The tier's filters and the Pareto toggle are not shown: a
 * board row is a condition's best attempt, not a mean over an entry's runs,
 * and the chart already names its fronts. The shell's series still applies. The five-agent id has no tab (operator, 2026-11-15), and
 * an old `?episode=deadmines` link lands on this one (`dungeonRedirect`).
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { api, type DungeonBoardView, type DungeonRowView, type ResultsResponse, type ResultRun } from "../api/client";
import { DungeonChart } from "../components/DungeonChart";
import { HarnessTag } from "../components/HarnessTag";
import { LadderChart } from "../components/LadderChart";
import { CharacterChart } from "../components/CharacterChart";
import { RunLinesChart } from "../components/RunLinesChart";
import { ModelIcon } from "../components/ModelIcon";
import { FilterPopover, type FilterGroup } from "../components/FilterPopover";
import { Coins, LevelXp } from "../components/CharacterFacts";
import { InfoHint } from "../components/InfoHint";
import { useSeriesFilter } from "../components/SeriesSelect";
import { COST, LADDER_VIEWS, XP, type LadderView, viewParam } from "../lib/axes";
import { DUNGEON_CHOICES, type DungeonChoice, EPISODE_CHOICES, dungeonLabel, dungeonParam, dungeonRedirect, episodeParam } from "../lib/episodes";
import {
  DUNGEON_VIEWS,
  type DungeonView,
  attemptHref,
  attemptTitle,
  boardHint,
  boardRowKey,
  bossesText,
  bossesTitle,
  clearTimeText,
  clearedText,
  COOKIE_TITLE,
  cookieText,
  dungeonViewParam,
} from "../lib/dungeons";
import {
  RUNGS,
  billingKnown,
  entryKeyOf,
  filterRuns,
  ladderPoints,
  ladderRows,
  characterRows,
  type LadderRow,
  type CharacterRow,
  type MilestoneReach,
} from "../lib/ladder";
import {
  chartGroups,
  companyOf,
  currentModels,
  inChartGroup,
  pickChartGroup,
  filterOptions,
  lineOf,
  matchesSelection,
  modelEntries,
  representativeEfforts,
  weightsOf,
} from "../lib/ladderfilter";
import { resolvedSummary } from "../lib/models";
import { type ReferenceMark, type ReferenceScale, scriptedReference, scriptedReferenceScale } from "../lib/reference";
import { effortLabel, fmtDuration, fmtWhen, modelDisplay, shortRunId, titleOf, windowNote } from "../lib/format";
import { statusTitle, statusTone } from "../lib/runs";
import { poll } from "../lib/poll";
import { readBoolPref, writeBoolPref } from "../lib/prefs";
import { displayError } from "../lib/errors";

const POLL_MS = 30_000;

/*
 * Where the controls live, and why they are not all in one place.
 *
 * The narrowing filters are in the URL, beside the tier, the axes and the
 * front (`?episode=`, `?view=`, `?pareto=`): a reading of the ladder that
 * cannot be linked is a reading nobody can be shown, and these say which slice
 * of the field a claim was made over. They are derived from the rows on screen
 * (`filterOptions`), so a link naming a line or a company no run carries
 * narrows to nothing visible rather than silently meaning something else.
 *
 * "exclude free" stays the per-viewer preference it has always been. It is not
 * a slice of the field but a standing opinion about what counts as evidence,
 * and a reader who holds one holds it on every tier.
 *
 * Race, class and harness are gone. Every scored run is
 * the same baseline character, so race and class asked a question an episode
 * cannot answer differently; the harness select duplicated the series
 * selector the shell already carries for every page. An old link or a
 * remembered choice naming any of them is simply ignored.
 */
const FREE_KEY = "wb.ladder.excludeFree";

export default function Ladder() {
  const [params, setParams] = useSearchParams();
  const episode = (): ReturnType<typeof episodeParam> => episodeParam(params.episode);
  const view = (): LadderView => viewParam(params.view);
  // The front, like the view, is a way of reading the tier and rides in the
  // URL beside it: `?pareto=1` is the one truthy form, anything else is off.
  const pareto = (): boolean => (Array.isArray(params.pareto) ? params.pareto[0] : params.pareto) === "1";
  // `/api/ladder` is the same projection as `/api/results`; the row order and
  // the milestone rules stay client-side, in `lib/ladder.ts`, where their tests are.
  const feed = poll(() => api.ladder(episode()), POLL_MS);
  // The Deadmines tabs read the dungeon board.
  const dungeons = poll(() => api.dungeons(), POLL_MS);
  createEffect(on(episode, () => feed.refresh(), { defer: true }));
  /** The ids whose tables the viewer serves, once it has answered. */
  const servedBoards = () => dungeons.latest?.boards.map((b) => b.episode);
  // An old link to the five-agent tab lands on the Deadmines tab.
  createEffect(() => {
    const to = dungeonRedirect(params.episode);
    if (to !== null) setParams({ episode: to }, { replace: true });
  });
  /*
   * The dungeon tab in view, or null on a ladder tier. An id whose table is
   * not served falls back to the tier, as any other unknown id does; until
   * the board answers, a named id is taken at its word.
   */
  const dungeon = (): DungeonChoice | null => {
    const d = dungeonParam(params.episode);
    const served = servedBoards();
    return d !== null && (served === undefined || served.includes(d)) ? d : null;
  };
  const board = (): DungeonBoardView | undefined => dungeons.latest?.boards.find((b) => b.episode === dungeon());
  const body = (): ResultsResponse | undefined => feed.latest;
  // The shell's harness series, applied before anything else reads
  // the rows: a level reached on 0.4 is not evidence about 0.5.
  const served = (): ResultRun[] => body()?.runs ?? [];
  /*
   * Freeplay is a different page under the same address: an overview of the
   * top characters on freeplay right now, one row per durable character, with
   * its milestones. It shows no scatter. The shell's series applies here as on
   * every tab (operator, 2026-11-15): a character no longer carries across a
   * series, so a series' characters are its own. The runs are cut before the
   * lineage walk like every other filter below, so a chain begun before that
   * rule and spanning two series shows, under each, that series' attempts,
   * re-rooted on its first one there, with the from-start rungs left
   * uncredited (`characterRows`' `truncated`).
   *
   * "exclude free" applies too, and did not at first (an early exemption,
   * since reversed): it is the same control, the same
   * default, and the same predicate the episode ladders use, over both the
   * table and the chart.
   */
  const freeplay = (): boolean => episode() === "freeplay";
  const seriesFilter = useSeriesFilter(served);
  const all = seriesFilter.kept;
  /*
   * Three multi-selects and two toggles narrow the set, and all of them are
   * applied BEFORE the rows are derived — `ladderRows` on a scored tier,
   * `characterRows` on freeplay — so the ranking is computed over exactly the
   * rows on screen; the order itself is untouched (level, XP, gold). On
   * freeplay that ordering is before the lineage walk, so a chain whose
   * ancestor the filter drops re-roots on its survivor. A mixed chain is rare
   * but real — an entry's declared `billing` changed between two attempts of
   * one character, say, when a stealth preview starts billing — and
   * `lib/ladder.ts` pins the behaviour.
   *
   * "exclude free" keeps only the runs we paid for (`ResultRun.billing`,
   * `runner/src/billing.ts` — a `claude-code` subscription counts as paid
   * there). The model line, the company and the weights are
   * `lib/ladderfilter.ts`.
   *
   * None is a row key. A model's row is its best run whatever it was played
   * on, because the baseline character is the comparison set.
   */
  const [excludeFree, setExcludeFree] = createSignal(readBoolPref(FREE_KEY, true));
  /** A comma-separated query parameter as the set of keys it names. */
  const listParam = (raw: string | string[] | undefined): string[] => {
    const one = Array.isArray(raw) ? raw[0] : raw;
    return (one ?? "").split(",").map((k) => k.trim()).filter((k) => k !== "");
  };
  const lines = (): string[] => listParam(params.family);
  const companies = (): string[] => listParam(params.company);
  const weights = (): string[] => listParam(params.weights);
  /** A selection is dropped from the URL when it is empty: an empty `?family=` is noise. */
  const setList = (name: "family" | "company" | "weights", keys: readonly string[]): void => {
    setParams({ [name]: keys.length === 0 ? undefined : [...keys].join(",") }, { replace: true });
  };
  /*
   * The effort rule, in the URL like the filters it sits beside and ON by
   * default: `?efforts=all` is the one form that turns it off, so the default
   * reading is the short address. It is gated on a scored tier for the same
   * reason `?view=` and `?pareto=` are — freeplay draws characters, not
   * roster entries, and `ladderPoints` has nothing to say about it.
   */
  const representative = (): boolean =>
    !freeplay() && (Array.isArray(params.efforts) ? params.efforts[0] : params.efforts) !== "all";
  /** The model rule, the same way: ON by default, `?models=all` the one form that turns it off. */
  const current = (): boolean =>
    !freeplay() && (Array.isArray(params.models) ? params.models[0] : params.models) !== "all";
  /*
   * Which chart a scored tier draws: the scatter of roster entries, the
   * default, or every run as a line of xp against active playtime
   * (`?chart=lines`, `components/RunLinesChart`) — in the URL for the reason
   * the view is. The axis views and the front are the scatter's own, so they
   * step aside while the lines are up; the filters narrow both alike.
   */
  const runLinesOn = (): boolean =>
    !freeplay() && (Array.isArray(params.chart) ? params.chart[0] : params.chart) === "lines";
  /*
   * Options come from the series-filtered set, not from the mutually filtered
   * one: ticking a company must not prune the model lines under the reader's
   * cursor, and an option that vanished when it was used would be a control
   * that fights back.
   */
  const lineOptions = createMemo(() => filterOptions(all().map((r) => r.model), lineOf));
  const companyOptions = createMemo(() => filterOptions(all().map((r) => r.model), companyOf));
  const weightsOptions = createMemo(() => filterOptions(all().map((r) => r.model), weightsOf));
  /** Everything but the effort rule, which needs these runs to compute its own. */
  const narrowed = createMemo(() =>
    filterRuns(all(), { excludeFree: excludeFree() }).filter((r) =>
      matchesSelection(r.model, { lines: lines(), companies: companies(), weights: weights() }),
    ),
  );
  /*
   * The chart. Every condition is its own row (operator, 2026-11-16), so
   * nothing chooses between a model's conditions; a `?conditions=all` link
   * from when something did reads as the default. One chart group
   * (`chartGroups`), because the loop and the wiki never share a chart
   * (operator, 2026-11-14); routing does (operator, 2026-11-16). `?group=`
   * picks one (`pickChartGroup`, which reads an old `-unpinned` id as its
   * loop's); the default, and the fallback for a group the tier no longer
   * holds, is the one with the most entries. The effort and model rules
   * below judge only what is left, so neither compares across charts.
   */
  const groupsOnPage = createMemo(() => (freeplay() ? [] : chartGroups(narrowed())));
  const group = (): string | null => pickChartGroup(groupsOnPage(), Array.isArray(params.group) ? params.group[0] : params.group);
  const charted = createMemo(() => {
    const g = group();
    return g === null ? narrowed() : inChartGroup(narrowed(), g);
  });
  /*
   * The entries the effort rule hides, as entry keys (`entryKeyOf`).
   *
   * Computed as a set of what is *dropped* rather than of what is kept, which
   * is the difference between a rule and an accident: an entry `ladderPoints`
   * could not plot at all — no run of it carrying both a cost and an xp
   * reading — lands in `omitted` and not in `points`, and a kept-set would
   * therefore hide it without ever having judged it. Nothing is hidden unless
   * one of its own model's other efforts beat it on both axes.
   *
   * Cost and XP explicitly, never `view()`: a set of rows that changed when a
   * reader swapped the axes would mean something different on every view.
   */
  const hidden = createMemo((): Set<string> => {
    if (!representative()) return new Set();
    const points = ladderPoints(charted(), COST, XP).points;
    const kept = new Set(
      representativeEfforts(
        points.map((p) => ({ key: p.key, model: p.model, effort: p.effort, cost: p.x, xp: p.y })),
      ).map((k) => k.key),
    );
    return new Set(points.filter((p) => !kept.has(p.key)).map((p) => p.key));
  });
  /*
   * The entries the model rule hides (`currentModels`): every model but each
   * line's newest, unless the field's cost-against-xp front keeps it. Over
   * the same set as the effort rule and independent of it, so the two
   * compose in either order; the efforts of a kept model are still the
   * effort rule's to judge.
   */
  const outdated = createMemo((): Set<string> => {
    if (!current()) return new Set();
    const entries = modelEntries(charted());
    const kept = new Set(currentModels(entries).map((e) => e.key));
    return new Set(entries.filter((e) => !kept.has(e.key)).map((e) => e.key));
  });
  const runs = createMemo(() =>
    hidden().size === 0 && outdated().size === 0
      ? charted()
      : charted().filter((r) => {
          const key = entryKeyOf(r);
          return !hidden().has(key) && !outdated().has(key);
        }),
  );
  /*
   * What the reader is pointing at, shared by the scatter and the table so
   * hovering either end lights both. One signal at the
   * page rather than two derivations that could disagree; the key is the
   * entry (`entryKeyOf`), one model under one condition, which is what a
   * point, a mean line and a table row each are. Keyboard focus on a row sets
   * it too, so the link is not pointer-only.
   */
  const [hovered, setHovered] = createSignal<string | null>(null);
  const groups = createMemo((): FilterGroup[] => [
    {
      label: "company",
      options: companyOptions(),
      selected: companies(),
      onSelect: (keys) => setList("company", keys),
    },
    {
      label: "family",
      options: lineOptions(),
      selected: lines(),
      onSelect: (keys) => setList("family", keys),
    },
    {
      label: "weights",
      title: "Whether the model's weights can be downloaded, as infra/model-catalogue.json records it per model. unknown: not checked, or nothing to check against (a stealth or unreleased model).",
      options: weightsOptions(),
      selected: weights(),
      onSelect: (keys) => setList("weights", keys),
    },
  ]);
  const characters = createMemo(() => characterRows(runs()));
  // A viewer that predates `billing` reports it on no run at all, and a toggle
  // that excludes nothing is worse than one that is obviously off (the rule
  // `SeriesFilterNote` states for the series filter).
  const billingUnknown = (): boolean =>
    excludeFree() && all().length > 0 && !billingKnown(all());
  const rows = createMemo(() => ladderRows(runs()));
  /*
   * The scripted reference line, from the series-filtered set before the
   * reader's filters (`scriptedReference`); the rows on screen only decide how
   * far the rail stretches. Never a row: its result is unscored, so `rows`
   * above cannot hold it.
   */
  const reference = createMemo((): ReferenceScale | null =>
    freeplay()
      ? null
      : scriptedReferenceScale({
          episode: episode(),
          series: seriesFilter.series(),
          reference: scriptedReference(all(), episode(), { lines: body()?.scriptedReference, series: seriesFilter.series() }),
          reached: rows().reduce<number | null>((m, r) => (r.bestLevel === null ? m : Math.max(m ?? 0, r.bestLevel)), null),
        }),
  );
  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>

      <h1>ladder</h1>

      {/* The tier is the axis this page turns on, so it is the page's control:
          centred and large, above everything the filters then narrow. */}
      <div class="chips episodes">
        <For each={EPISODE_CHOICES}>
          {(id) => (
            <button class={dungeon() === null && id === episode() ? "on" : ""} onClick={() => setParams({ episode: id }, { replace: true })}>
              {id}
            </button>
          )}
        </For>
        <For each={DUNGEON_CHOICES}>
          {(id) => (
            <button class={id === dungeon() ? "on" : ""} title={boardHint(id)} onClick={() => setParams({ episode: id }, { replace: true })}>
              {dungeonLabel(id)}
            </button>
          )}
        </For>
      </div>

      <Show when={dungeon()}>
        {(id) => (
          <>
            <Show when={dungeons.error !== undefined}>
              <div class="banner bad">{displayError(dungeons.error)}</div>
            </Show>
            <Show when={board()} fallback={<p class="dim loading-chart">loading…</p>}>
              {(b) => (
                <DungeonBoard
                  board={b()}
                  episode={id()}
                  view={dungeonViewParam(params.view)}
                  onView={(v) => setParams({ view: v.id === DUNGEON_VIEWS[0]!.id ? undefined : v.id }, { replace: true })}
                />
              )}
            </Show>
          </>
        )}
      </Show>

      <Show when={dungeon() === null}>

      {/* One row of controls, immediately above the chart they narrow — the
          chart and the table read the same filtered set, so the two can never
          disagree about which runs are on screen. Two groups: the axes on the
          left, the filters on the right, on one line while the viewport has
          room and one above the other when it does not (`.ladder-controls`). */}
      <div class="ladder-controls">
        {/* The chart group: conditions that may never share a chart are
            offered one at a time, and only when the tier holds more than one. */}
        <Show when={groupsOnPage().length > 1}>
          <div class="chips views">
            <span class="dim">condition</span>
            <For each={groupsOnPage()}>
              {(g, i) => (
                <button
                  class={g.id === group() ? "on" : ""}
                  title={`${g.entries} ${g.entries === 1 ? "entry" : "entries"}; runs under different conditions never share a chart`}
                  onClick={() => setParams({ group: i() === 0 ? undefined : g.id }, { replace: true })}
                >
                  {g.label}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={!freeplay()}>
          <div class="chips views">
            <span class="dim">chart</span>
            <button class={runLinesOn() ? "" : "on"} title="one point per model and effort" onClick={() => setParams({ chart: undefined }, { replace: true })}>
              scatter
            </button>
            <button class={runLinesOn() ? "on" : ""} title="xp earned against active playtime, one mean line per model and effort" onClick={() => setParams({ chart: "lines" }, { replace: true })}>
              lines
            </button>
          </div>
        </Show>
        <Show when={!freeplay() && !runLinesOn()}>
          {/* The axes, as a row of the same chips the tier uses, a size down: a
              view is a way of reading the tier, not the address of the page,
              but it is in the URL so a reading can be linked. */}
          <div class="chips views">
            <span class="dim">axes</span>
            <For each={LADDER_VIEWS}>
              {(v) => (
                <button
                  class={v.id === view().id ? "on" : ""}
                  title={`${v.x.caption(episode())} against ${v.y.caption(episode())}`}
                  onClick={() => setParams({ view: v.id === LADDER_VIEWS[0]!.id ? undefined : v.id }, { replace: true })}
                >
                  {v.title}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="ladder-filters">
        <Show when={!freeplay()}>
          <FilterPopover groups={groups()} />
        </Show>
        <label class="filter check" title="Keep only the runs that cost money. A claude-code or codex run counts as paid: a subscription is a bill (runner/src/billing.ts).">
          <input
            type="checkbox"
            checked={excludeFree()}
            onChange={(e) => {
              setExcludeFree(e.currentTarget.checked);
              writeBoolPref(FREE_KEY, e.currentTarget.checked);
            }}
          />
          <span>exclude free</span>
        </label>
        {/* Not a caption: a filter that silently kept everything would be worse
            than one that says so, and this is the one state where "exclude
            free" excludes nothing (a hover, not a
            paragraph). */}
        <Show when={billingUnknown()}>
          <InfoHint
            label="exclude free"
            text="Nothing excluded: these runs predate the billing record, so this filter has nothing to go on. Runs recorded from here on carry it."
          />
        </Show>
        <Show when={!freeplay() && !runLinesOn()}>
          <label
            class="filter check"
            title="Draw the Pareto front: the entries no other entry beats on both of the axes in view. Every point stays; the dominated ones are dimmed."
          >
            <input
              type="checkbox"
              checked={pareto()}
              onChange={(e) => setParams({ pareto: e.currentTarget.checked ? "1" : undefined }, { replace: true })}
            />
            <span>pareto front</span>
          </label>
        </Show>
        <Show when={!freeplay()}>
          <label
            class="filter check"
            title="Hides efforts beaten on both cost and xp by another effort of the same model."
          >
            <input
              type="checkbox"
              checked={representative()}
              onChange={(e) => setParams({ efforts: e.currentTarget.checked ? undefined : "all" }, { replace: true })}
            />
            <span>representative efforts</span>
          </label>
          <label
            class="filter check"
            title="Hides every model but the newest of its line (Opus 4.8 behind Opus 5.5), unless nothing in the field beats it on both cost and xp."
          >
            <input
              type="checkbox"
              checked={current()}
              onChange={(e) => setParams({ models: e.currentTarget.checked ? undefined : "all" }, { replace: true })}
            />
            <span>current models</span>
          </label>
        </Show>
        </div>
      </div>

      <Show when={feed.latest !== undefined} fallback={<p class="dim loading-chart">loading…</p>}>
        <Show when={freeplay()}>
          {/* The same rows and the same runs the table reads, so the chart and
              the table can never disagree about which characters are on screen. */}
          <CharacterChart rows={characters()} runs={runs()} />
          <CharacterTable rows={characters()} />
          <RungRules />
        </Show>
        <Show when={!freeplay()}>
        {/* Below ~720px the scatter's labels are texture, not text: it keeps a
            floor width and scrolls inside itself rather than being squeezed. */}
        <div class="wide-scroll">
        <Show
          when={runLinesOn()}
          fallback={
            <LadderChart
              runs={runs()}
              episode={episode()}
              view={view()}
              pareto={pareto()}
              hovered={hovered()}
              onHover={setHovered}
            />
          }
        >
          <RunLinesChart runs={runs()} episode={episode()} hovered={hovered()} onHover={setHovered} />
        </Show>
        </div>

        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th>harness</th>
                <th title="starting race and class among this model's scored runs">character</th>
                <th class="right">runs</th>
                <th
                  class="right"
                  title="the row order's first key: the furthest a run got — level, then xp within it; nothing on this row is summed into a score"
                >
                  level · xp
                </th>
                <th class="right" title="the tie-break: the most a run ended holding">gold</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr
                    classList={{ hovered: hovered() === row.key }}
                    tabindex="0"
                    onMouseEnter={() => setHovered(row.key)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(row.key)}
                    onBlur={() => setHovered(null)}
                  >
                    <td>
                      <ModelIcon model={row.model} />
                      <span title={titleOf(row.model, windowNote(row.compactWindow))}>{modelDisplay(row.model)}</span>
                      <Show when={effortLabel(row.effort)}>
                        {(tag) => <span class="dim"> · {tag()}</span>}
                      </Show>
                      {/* A local build names itself beside the model: the quantisation and runtime it was served at. */}
                      <Show when={row.condition.serving}>
                        {(s) => (
                          <span class="dim" title={`a local build: ${s().weights}, ${s().quant}, served by ${s().runtime}`}>
                            {" "}· local {s().quant} · {s().runtime}
                          </span>
                        )}
                      </Show>
                      {/* The ids the row's runs actually resolved to. Two of
                          them is one alias that resolved two ways across the
                          row — drift the ladder must show, not average. */}
                      <Show when={resolvedSummary(row.model, row.resolvedModels)}>
                        {(seen) => (
                          <div
                            class="dim"
                            title={
                              seen().mixed
                                ? `${seen().ids.join(", ")} — this row's runs were not all on the same model`
                                : `${seen().ids.join(", ")} — the id the provider actually served`
                            }
                          >
                            {seen().ids.map(modelDisplay).join(", ")}
                            <Show when={seen().mixed}>
                              {" "}
                              <span class="warn">mixed</span>
                            </Show>
                          </div>
                        )}
                      </Show>
                    </td>
                    <td>
                      <For each={row.harnesses}>{(h) => <HarnessTag harness={h} />}</For>
                    </td>
                    <td class="dim" title={row.characters.join(", ")}>
                      {row.characters.length === 0
                        ? "—"
                        : row.characters.length === 1
                          ? row.characters[0]
                          : `${row.characters.length} characters`}
                    </td>
                    <td class="right mono dim">{row.runs}</td>
                    <td class="right mono" title={row.bestRunId ?? "not recorded"}>
                      <Furthest row={row} />
                    </td>
                    <td class="right mono dim" title={row.bestMoneyRunId ?? "not recorded"}>
                      <Coins copper={row.bestMoney} />
                    </td>
                  </tr>
                )}
              </For>
              <Show when={rows().length === 0}>
                <tr>
                  <td colSpan={6} class="dim">
                    No scorable runs recorded yet.
                  </td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>

        <Show when={reference()}>{(ref) => <ReferenceStrip scale={ref()} />}</Show>
        </Show>
      </Show>
      </Show>
    </div>
  );
}

const BOARD_NOTE =
  "The fixed Deadmines episode from a staged level-20 party, one agent driving all five characters. A row is a model condition's best attempt, with how many of its counted attempts cleared: killed all seven bosses on the route to VanCleef and ended on his kill. Cleared rows first, by time to clear from launch; the rest by bosses killed of the seven, then time to the last. Cookie, off the route, is an optional extra. Deaths, wipes and Cookie are shown and never order a row.";

/**
 * One dungeon tab: the board's table for its id, as the viewer derived and
 * ordered it, under the shell's series, with its chart above it. The chart
 * and the table share one hover, keyed on the row (`boardRowKey`).
 */
function DungeonBoard(props: { board: DungeonBoardView; episode: DungeonChoice; view: DungeonView; onView: (v: DungeonView) => void }) {
  // The shell's harness series, as every evals page applies it.
  const series = useSeriesFilter(() => props.board.rows.map((r) => ({ ...r, harnessSeries: r.series })));
  const [hovered, setHovered] = createSignal<string | null>(null);
  return (
    <>
      {/* The axes, as the tier's row of views: in the URL, the default the short address. */}
      <div class="ladder-controls">
        <div class="chips views">
          <span class="dim">axes</span>
          <For each={DUNGEON_VIEWS}>
            {(v) => (
              <button class={v.id === props.view.id ? "on" : ""} title={v.hint} onClick={() => props.onView(v)}>
                {v.title}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="wide-scroll">
        <DungeonChart rows={series.kept()} episode={props.episode} view={props.view} hovered={hovered()} onHover={setHovered} boardNote={BOARD_NOTE} />
      </div>
      <div class="scroller">
        <table>
          <thead>
            <tr>
              <th>model</th>
              <th>harness</th>
              <th class="right" title="counted attempts that cleared, of the counted attempts: all seven bosses on the route, ended on VanCleef's kill">cleared</th>
              <th class="right" title="the best attempt's time from launch to Edwin VanCleef's death">time</th>
              <th class="right" title="the best attempt's bosses killed, of the seven on the route to Edwin VanCleef">bosses</th>
              <th class="right" title={COOKIE_TITLE}>
                cookie
              </th>
              <th class="right" title="the best attempt's deaths, over every character">deaths</th>
              <th class="right" title="the best attempt's wipes: every character dead at once">wipes</th>
            </tr>
          </thead>
          <tbody>
            <Show when={series.kept().length === 0}>
              <tr>
                <td colSpan={8} class="dim">
                  no counted attempts
                </td>
              </tr>
            </Show>
            <For each={series.kept()}>{(row) => <DungeonRow row={row} hovered={hovered()} onHover={setHovered} />}</For>
          </tbody>
        </table>
      </div>
    </>
  );
}

function DungeonRow(props: { row: DungeonRowView; hovered: string | null; onHover: (key: string | null) => void }) {
  const r = (): DungeonRowView => props.row;
  const key = (): string => boardRowKey(props.row);
  const effort = (): string | null => effortLabel(r().effort);
  return (
    <tr
      classList={{ hovered: props.hovered === key() }}
      tabindex="0"
      onMouseEnter={() => props.onHover(key())}
      onMouseLeave={() => props.onHover(null)}
      onFocus={() => props.onHover(key())}
      onBlur={() => props.onHover(null)}
    >
      <td>
        <ModelIcon model={r().model} />
        <span title={titleOf(r().model, windowNote(r().compactWindow))}>{modelDisplay(r().model ?? "(unnamed)")}</span>
        <Show when={effort()}>{(e) => <span class="dim"> · {e()}</span>}</Show>
      </td>
      <td>
        <HarnessTag harness={r().harness} />
      </td>
      <td class="right mono" title="the row's best attempt">
        <A href={attemptHref(r())}>{clearedText(r())}</A>
      </td>
      <td class="right mono" title={attemptTitle(r().best)}>
        {clearTimeText(r().best)}
      </td>
      <td class="right mono" title={bossesTitle(r().best)}>
        {bossesText(r().best)}
      </td>
      <td class={r().best.cookie ? "right mono ok" : "right mono dim"} title={COOKIE_TITLE}>
        {cookieText(r().best)}
      </td>
      <td class="right mono">{r().best.deaths}</td>
      <td class="right mono">{r().best.wipes}</td>
    </tr>
  );
}

/**
 * The freeplay field: one row per durable character, latest attempt first by what
 * the character has reached.
 *
 * Everything not deleted and not stillborn is here, in progress included — a
 * live character is the point of the page, not an exclusion. The lineage column
 * is why a character that has been through twelve attempts appears once:
 * the row is the character, and `attempts` is how many run
 * ids are behind it.
 */
function CharacterTable(props: { rows: readonly CharacterRow[] }) {
  return (
    <div class="scroller">
      <table>
        <thead>
          <tr>
            <th>model</th>
            <th>character</th>
            <th>status</th>
            <th class="right" title="attempts in this character; the row is the character, not the run">
              attempts
            </th>
            <th class="right" title="the latest attempt's reading — level, then xp within it">
              level · xp
            </th>
            <th class="right">gold</th>
            <th class="right">quests</th>
            <For each={RUNGS}>
              {(rung) => (
                <th class="right" title={`milestone ${rung.n}: ${rung.title} — ${rung.rule}; the cell is the playtime it was reached at`}>
                  {rung.n}
                </th>
              )}
            </For>
            <th title="the attempt this row is reading, and when it started">latest run</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr>
                <td>
                  <ModelIcon model={row.model} />
                  <span title={row.model}>{modelDisplay(row.model)}</span>
                  <Show when={row.effort !== null}> · {row.effort}</Show>
                </td>
                {/* The freeplay row is a character, not a run, so its name
                    leads to the character page; the "latest run"
                    column is where a reader goes for one session. */}
                <td>
                  <A href={`/character/${encodeURIComponent(row.characterId)}`} title={row.characterId}>
                    {row.character ?? shortRunId(row.characterId)}
                  </A>
                  <Show when={row.characterLabel !== null}>
                    <div class="dim">{row.characterLabel}</div>
                  </Show>
                </td>
                <td>
                  <span class={statusTone(row.status)} title={statusTitle(row.status)}>
                    {row.status}
                  </span>
                  <Show when={row.statusDetail !== null}>
                    <span class="dim"> ({row.statusDetail})</span>
                  </Show>
                </td>
                <td class="right mono dim" title={row.chain.join(" → ")}>
                  {row.attempts}
                </td>
                <td class="right mono">
                  <LevelXp level={row.level} xp={row.xp} compact />
                </td>
                <td class="right mono dim">
                  <Coins copper={row.money} />
                </td>
                <td class="right mono dim">{row.questsCompleted ?? "—"}</td>
                <For each={row.milestones}>{(m) => <MilestoneCell reach={m} />}</For>
                <td class="mono">
                  <A href={`/run/${encodeURIComponent(row.latest.runId)}`}>{row.latest.runId}</A>
                  <div class="dim">{fmtWhen(row.startedAt)}</div>
                </td>
              </tr>
            )}
          </For>
          <Show when={props.rows.length === 0}>
            <tr>
              <td colSpan={8 + RUNGS.length} class="dim">
                No freeplay characters recorded yet.
              </td>
            </tr>
          </Show>
        </tbody>
      </table>
    </div>
  );
}

/**
 * The scripted reference, as a labelled line on a level scale under the table.
 *
 * The rail the withdrawn reference lines used, carrying one mark now: the
 * scripted reference run of this tier and series (`lib/reference.ts`). It sits
 * below the table rather than inside it, because the ladder table scrolls
 * sideways on a phone and a reference behind a scroll is not one. The rail is
 * percentage-positioned HTML so it needs no measuring, and the legend carries
 * the number, linked to the run, so nothing has to be read off the rail. What
 * the line is, is on the hover and in docs/PUBLIC-DASHBOARD.md, never in a
 * paragraph on the page.
 */
function ReferenceStrip(props: { scale: ReferenceScale }) {
  const span = (): number => Math.max(props.scale.max - props.scale.min, 1);
  /** A level's position along the rail, as a percentage. */
  const at = (level: number): string => `${(((level - props.scale.min) / span()) * 100).toFixed(2)}%`;
  /** Every level the rail labels: the ends and each mark. */
  const ticks = (): number[] =>
    [...new Set([props.scale.min, ...props.scale.marks.map((m) => m.low), props.scale.max])].sort((a, b) => a - b);
  const aria = (): string =>
    `A level scale from L${props.scale.min} to L${props.scale.max} carrying ${props.scale.marks
      .map((m: ReferenceMark) => `${m.label} at L${m.low}`)
      .join(" and ")}`;
  return (
    <div class="reference">
      <div class="reference-rail" role="img" aria-label={aria()} title={aria()}>
        <For each={props.scale.marks}>
          {(m) => <span class={`ref-mark line ${m.id}`} style={{ left: at(m.low) }} title={`${m.label} — ${m.provenance}`} />}
        </For>
        <For each={ticks()}>
          {(t) => (
            <span class="ref-tick mono dim" style={{ left: at(t) }}>
              L{t}
            </span>
          )}
        </For>
      </div>
      <ul class="reference-legend dim">
        <For each={props.scale.marks}>
          {(m) => (
            <li title={m.provenance}>
              <span class="swatch line" aria-hidden="true" />
              <Show when={m.runId} fallback={<span class="mono">L{m.low}</span>}>
                {(id) => (
                  <A class="mono" href={`/run/${encodeURIComponent(id())}`}>
                    L{m.low}
                  </A>
                )}
              </Show>{" "}
              {m.label}
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/**
 * The furthest a model's run got: `L14 · 4,120 xp`, or what was recorded of
 * it — and under it, where the rest of its runs finished.
 *
 * The headline stays the maximum it always was. The second line is the spread
 * the tier's evidence budget already bought (`levelRangeOf`): the median level
 * and the range, or nothing at all when one run is all there is to disperse.
 */
function Furthest(props: { row: LadderRow }) {
  const r = (): LadderRow => props.row;
  /*
   * The spread the row's runs already paid for, as the cell's hover rather
   * than a second line of text under the badge. The
   * cell draws the level and the bar and nothing else; "L6 · 2–6" beside them
   * was a third number in a column that has two.
   */
  const spread = (): string | null => {
    const lr = r().levelRange;
    if (lr === null || lr.n <= 1) return null;
    return (
      `median L${lr.median}, range L${lr.min}–L${lr.max}, over the ${lr.n} counted run${lr.n === 1 ? "" : "s"} that recorded a level` +
      (lr.n === r().runs ? "" : ` of ${r().runs} — the rest recorded none`) +
      ". The median is an observed level: on an even count it is the lower of the two middles, never a half-level nothing was at."
    );
  };
  return <LevelXp level={r().bestLevel} xp={r().bestXp} note={spread()} compact />;
}

/**
 * One milestone for one character: the cumulative active playtime it was
 * reached at, linking the attempt that completed it; a dash when not reached,
 * and the state on the hover when its records cannot say.
 */
function MilestoneCell(props: { reach: MilestoneReach }) {
  const r = (): MilestoneReach => props.reach;
  return (
    <td class="right mono">
      <Show
        when={r().status === "reached" ? r().runId : null}
        fallback={
          <span class="dim" title={r().status.replace("-", " ")}>
            {r().status === "not-reached" ? "—" : r().status === "not-recorded" ? "?" : "·"}
          </span>
        }
      >
        {(id) => (
          <A href={`/run/${encodeURIComponent(id())}`} title={`reached at ${fmtDuration(r().playtimeMs)} of play, on ${id()}`}>
            <span class="ok">{r().playtimeMs === null ? "yes" : fmtDuration(r().playtimeMs)}</span>
          </A>
        )}
      </Show>
    </td>
  );
}

/** The milestone rungs and the rule each applies, under the freeplay table. */
function RungRules() {
  return (
    <>
      <h2 class="section">milestones</h2>
      <div class="scroller">
        <table>
          <thead>
            <tr>
              <th class="right">#</th>
              <th>milestone</th>
              <th>rule applied</th>
            </tr>
          </thead>
          <tbody>
            <For each={RUNGS}>
              {(rung) => (
                <tr>
                  <td class="right mono">{rung.n}</td>
                  <td>{rung.title}</td>
                  <td class={rung.parts === null ? "warn" : "dim"}>{rung.rule}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </>
  );
}
