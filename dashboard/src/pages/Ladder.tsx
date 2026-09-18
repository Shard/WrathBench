/**
 * The ladder of docs/VISION.md, with the highest rung each model has reached.
 *
 * Rungs are read from one episode tier at a time — e90 by default —
 * because a rung reached in six hours is not the same claim as the same rung
 * reached in ninety minutes. There is no "all" and no overridden view: neither
 * is a comparability group, so neither can be a ladder, and there is no
 * `probing` either (operator, 2026-08-29 — a sweep varies its cells on
 * purpose, so ranking its runs ranks the sweep). The runs page lists every run
 * regardless.
 *
 * `freeplay` is the one id that shows something else entirely: not rungs but
 * **the top characters on freeplay right now** (operator, 2026-08-29) — the
 * whole active field, one row per durable character, paused and in-progress
 * included. `characterRows` in `lib/ladder.ts` is that derivation; the scored
 * ladders below are untouched by it.
 *
 * Above the table, one scatter for the tier: average cost per run against
 * average XP earned, one point per roster entry (`components/LadderChart`),
 * with a row of curated views that swap the axes (`lib/axes.ts`; the view is
 * `?view=` so a reading is linkable, and the default is the cost/xp chart)
 * and a toggle that draws the Pareto front over the field (`lib/pareto.ts`;
 * `?pareto=1`, for the same reason).
 * Freeplay gets its own graph in that place instead — `components/CharacterChart`,
 * one stepped series per character, level against cumulative active playtime; the
 * axis argument is in `lib/ladder.ts`.
 *
 * Rows are ordered by highest rung reached, then total XP, then gold — a stated
 * derivation over recorded signals, versioned with `lib/ladder.ts`. The two
 * tie-breaks are printed in their own columns so the order is legible rather
 * than mysterious, and neither is added to anything: there is no aggregate
 * score.
 *
 * One of the eight rungs cannot be answered by anything the harness records
 * today — group joins and instance clears are not in the trajectory, and the
 * harness runs one character per session. It reads "not instrumented" rather
 * than being approximated by a level threshold. Rung 2 reads the zone/area
 * milestone records (FOLLOW-UPS 35) and rung 4 reads those plus the flight
 * milestones, so 4 now tests both clauses of its title. Every derived rung
 * prints the exact rule it applied so a reader can disagree with the
 * derivation.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { api, type ResultsResponse, type ResultRun } from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { LadderChart } from "../components/LadderChart";
import { CharacterChart } from "../components/CharacterChart";
import { ModelIcon } from "../components/ModelIcon";
import { FilterPopover, type FilterGroup } from "../components/FilterPopover";
import { Coins, LevelXp } from "../components/CharacterFacts";
import { InfoHint } from "../components/InfoHint";
import { useSeriesFilter } from "../components/SeriesSelect";
import { COST, LADDER_VIEWS, XP, type LadderView, viewParam } from "../lib/axes";
import { EPISODE_CHOICES, episodeParam } from "../lib/episodes";
import {
  RUNGS,
  billingKnown,
  filterRuns,
  hoverKeyOf,
  ladderPoints,
  ladderRows,
  pointKey,
  characterRows,
  type LadderCell,
  type LadderRow,
  type LevelRange,
  type CharacterRow,
} from "../lib/ladder";
import {
  companyOf,
  filterOptions,
  lineOf,
  matchesSelection,
  representativeEfforts,
} from "../lib/ladderfilter";
import { resolvedSummary } from "../lib/models";
import { fmtWhen, modelDisplay, shortRunId } from "../lib/format";
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
 * Race, class and harness are gone (operator, 2026-09-18). Every scored run is
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
  // `/api/ladder` is the same projection as `/api/results`; the rung rules stay
  // client-side, in `lib/ladder.ts`, where their tests are.
  const feed = poll(() => api.ladder(episode()), POLL_MS);
  createEffect(on(episode, () => feed.refresh(), { defer: true }));
  const body = (): ResultsResponse | undefined => feed.latest;
  // The shell's harness series, applied before anything else reads
  // the rows: a rung reached on 0.4 is not evidence about 0.5.
  const served = (): ResultRun[] => body()?.runs ?? [];
  /*
   * Freeplay is a different page under the same address: an overview of the
   * top characters on freeplay right now, one row per durable character
   * (operator, 2026-08-29). It reads no rungs, so it shows neither the scatter
   * nor the rung table. The shell's series filter still does not apply, and
   * that is not a convenience: a character is durable *across* series, so cutting
   * its older attempts would make the newest survivor the chain root and
   * report a thirteen-attempt character as attempt 1, which is the one number
   * this page exists to show. `useSeriesFilter` has the `active` hatch for
   * exactly this — the map's replay mode uses it for the same reason.
   *
   * "exclude free" *does* apply, and did not at first (operator, 2026-08-29,
   * reversing the same day's exemption): it is the same control, the same
   * default, and the same predicate the episode ladders use, over both the
   * table and the chart. Only the series exemption survives.
   */
  const freeplay = (): boolean => episode() === "freeplay";
  const seriesFilter = useSeriesFilter(served, () => !freeplay());
  const all = seriesFilter.kept;
  /*
   * Two multi-selects and two toggles narrow the set, and all of them are
   * applied BEFORE the rows are derived — `ladderRows` on a scored tier,
   * `characterRows` on freeplay — so the ranking is computed over exactly the
   * rows on screen; the order itself is untouched (highest rung, XP, gold). On
   * freeplay that ordering is before the lineage walk, so a chain whose
   * ancestor the filter drops re-roots on its survivor; billing follows the
   * endpoint and a character is one character under one config, so a mixed
   * chain is not a shape the fleet produces (`lib/ladder.ts` pins the
   * behaviour anyway).
   *
   * "exclude free" keeps only the runs we paid for (`ResultRun.billing`,
   * `runner/src/billing.ts` — a `claude-code` subscription counts as paid
   * there). The model line and the company are `lib/ladderfilter.ts`.
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
  /** A selection is dropped from the URL when it is empty: an empty `?family=` is noise. */
  const setList = (name: "family" | "company", keys: readonly string[]): void => {
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
  /*
   * Options come from the series-filtered set, not from the mutually filtered
   * one: ticking a company must not prune the model lines under the reader's
   * cursor, and an option that vanished when it was used would be a control
   * that fights back.
   */
  const lineOptions = createMemo(() => filterOptions(all().map((r) => r.model), lineOf));
  const companyOptions = createMemo(() => filterOptions(all().map((r) => r.model), companyOf));
  /** Everything but the effort rule, which needs these runs to compute its own. */
  const narrowed = createMemo(() =>
    filterRuns(all(), { excludeFree: excludeFree() }).filter((r) =>
      matchesSelection(r.model, { lines: lines(), companies: companies() }),
    ),
  );
  /*
   * The entries the effort rule hides, as `pointKey`s.
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
    const points = ladderPoints(narrowed(), COST, XP).points;
    const kept = new Set(
      representativeEfforts(
        points.map((p) => ({ key: p.key, model: p.model, effort: p.effort, cost: p.x, xp: p.y })),
      ).map((k) => k.key),
    );
    return new Set(points.filter((p) => !kept.has(p.key)).map((p) => p.key));
  });
  const runs = createMemo(() =>
    hidden().size === 0
      ? narrowed()
      : narrowed().filter((r) => !hidden().has(pointKey(r.model ?? "(unnamed)", r.effort))),
  );
  /*
   * What the reader is pointing at, shared by the scatter and the table so
   * hovering either end lights both (operator, 2026-09-18). One signal at the
   * page rather than two derivations that could disagree; the key is
   * `hoverKeyOf`, because the chart draws per (model, effort) and the table
   * per model, and the model is what the two have in common. Keyboard focus on
   * a row sets it too, so the link is not pointer-only.
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
  ]);
  const characters = createMemo(() => characterRows(runs()));
  // A viewer that predates `billing` reports it on no run at all, and a toggle
  // that excludes nothing is worse than one that is obviously off (the rule
  // `SeriesFilterNote` states for the series filter).
  const billingUnknown = (): boolean =>
    excludeFree() && all().length > 0 && !billingKnown(all());
  const rows = createMemo(() => ladderRows(runs()));
  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>

      <h2 class="section">ladder</h2>

      {/* The tier is the axis this page turns on, so it is the page's control:
          centred and large, above everything the filters then narrow. */}
      <div class="chips episodes">
        <For each={EPISODE_CHOICES}>
          {(id) => (
            <button class={id === episode() ? "on" : ""} onClick={() => setParams({ episode: id }, { replace: true })}>
              {id}
            </button>
          )}
        </For>
      </div>

      {/* One row of controls, immediately above the chart they narrow — the
          chart and the table read the same filtered set, so the two can never
          disagree about which runs are on screen. Two groups: the axes on the
          left, the filters on the right, on one line while the viewport has
          room and one above the other when it does not (`.ladder-controls`). */}
      <div class="ladder-controls">
        <Show when={!freeplay()}>
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
            free" excludes nothing (operator, 2026-09-18 — a hover, not a
            paragraph). */}
        <Show when={billingUnknown()}>
          <InfoHint
            label="exclude free"
            text="Nothing excluded: these runs predate the billing record, so this filter has nothing to go on. Runs recorded from here on carry it."
          />
        </Show>
        <Show when={!freeplay()}>
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
        </Show>
        </div>
      </div>

      <Show when={feed.latest !== undefined} fallback={<p class="dim loading-chart">loading…</p>}>
        <Show when={freeplay()}>
          {/* The same rows and the same runs the table reads, so the chart and
              the table can never disagree about which characters are on screen. */}
          <CharacterChart rows={characters()} runs={runs()} />
          <CharacterTable rows={characters()} />
        </Show>
        <Show when={!freeplay()}>
        {/* Below ~720px the scatter's labels are texture, not text: it keeps a
            floor width and scrolls inside itself rather than being squeezed. */}
        <div class="wide-scroll">
        <LadderChart
          runs={runs()}
          episode={episode()}
          view={view()}
          pareto={pareto()}
          hovered={hovered()}
          onHover={setHovered}
        />
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
                  title="the highest rung reached, and the row order's first key — nothing on this row is summed into a score"
                >
                  highest
                </th>
                <th class="right" title="first tie-break: the furthest a run got — level, then xp within it">
                  level · xp
                </th>
                <th class="right" title="second tie-break: the most a run ended holding">gold</th>
                <For each={RUNGS}>
                  {(rung) => (
                    <th class="right" title={`${rung.title} — ${rung.rule}`}>
                      {rung.n}
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr
                    classList={{ hovered: hovered() === hoverKeyOf(row.model) }}
                    tabindex="0"
                    onMouseEnter={() => setHovered(hoverKeyOf(row.model))}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(hoverKeyOf(row.model))}
                    onBlur={() => setHovered(null)}
                  >
                    <td>
                      <ModelIcon model={row.model} />
                      <span title={row.model}>{modelDisplay(row.model)}</span>
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
                    <td class="right mono">{row.highest === 0 ? "—" : row.highest}</td>
                    <td class="right mono dim" title={row.bestRunId ?? "not recorded"}>
                      <Furthest row={row} />
                    </td>
                    <td class="right mono dim" title={row.bestMoneyRunId ?? "not recorded"}>
                      <Coins copper={row.bestMoney} />
                    </td>
                    <For each={row.cells}>{(cell) => <RungCell cell={cell} runs={row.runs} />}</For>
                  </tr>
                )}
              </For>
              <Show when={rows().length === 0}>
                <tr>
                  <td colSpan={7 + RUNGS.length} class="dim">
                    No scorable runs recorded yet.
                  </td>
                </tr>
              </Show>
            </tbody>
          </table>
        </div>

        <h2 class="section">the rungs, and how each is decided</h2>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th class="right">#</th>
                <th>rung</th>
                <th>rule applied</th>
              </tr>
            </thead>
            <tbody>
              <For each={RUNGS}>
                {(rung) => (
                  <tr>
                    <td class="right mono">{rung.n}</td>
                    <td>{rung.title}</td>
                    <td class={rung.test === null ? "warn" : "dim"}>
                      {rung.test === null ? `not instrumented — ${rung.rule}` : rung.rule}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        </Show>
      </Show>
    </div>
  );
}

/**
 * The freeplay field: one row per durable character, latest attempt first by what
 * the character has reached.
 *
 * Everything not deleted and not stillborn is here, in progress included — a
 * live character is the point of the page, not an exclusion. The lineage column
 * is why a character that has been through twelve attempts appears once
 * (item 92): the row is the character, and `attempts` is how many run
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
                    leads to the character page (item 128); the "latest run"
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
                  <span class={row.status === "live" ? "ok" : row.status === "paused" ? "warn" : "dim"}>
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
                <td class="mono">
                  <A href={`/run/${encodeURIComponent(row.latest.runId)}`}>{row.latest.runId}</A>
                  <div class="dim">{fmtWhen(row.startedAt)}</div>
                </td>
              </tr>
            )}
          </For>
          <Show when={props.rows.length === 0}>
            <tr>
              <td colSpan={8} class="dim">
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
 * The furthest a model's run got: `L14 · 4,120 xp`, or what was recorded of
 * it — and under it, where the rest of its runs finished.
 *
 * The headline stays the maximum it always was. The second line is the spread
 * the tier's evidence budget already bought (`levelRangeOf`): the median level
 * and the range, or nothing at all when one run is all there is to disperse.
 */
function Furthest(props: { row: LadderRow }) {
  const r = (): LadderRow => props.row;
  const spread = (): LevelRange | null => {
    const lr = r().levelRange;
    return lr !== null && lr.n > 1 ? lr : null;
  };
  return (
    <Show when={r().bestLevel !== null} fallback={<span>—</span>}>
      <LevelXp level={r().bestLevel} xp={r().bestXp} compact />
      <Show when={spread()}>
        {(lr) => (
          <div
            class="dim spread"
            title={`median L${lr().median}, range L${lr().min}–L${lr().max}, over the ${lr().n} counted run${
              lr().n === 1 ? "" : "s"
            } that recorded a level${
              lr().n === r().runs ? "" : ` of ${r().runs} — the rest recorded none`
            }. The median is an observed level: on an even count it is the lower of the two middles, never a half-level nothing was at.`}
          >
            L{lr().median} · {lr().min}–{lr().max}
          </div>
        )}
      </Show>
    </Show>
  );
}

/**
 * One rung, for one model: how many of its runs got there out of how many
 * could be asked, linking the first that did.
 *
 * `2/3` and not a tick (item 125, operator 2026-09-16): a tick made a model
 * that cleared the rung once in three tries render identically to one that
 * cleared it three times out of three. The denominator is the runs whose
 * records can answer *this* rung, not the row's runs — a run that predates the
 * area or flight taps was never asked and is not counted as a failure — and
 * the hover says so whenever the two differ.
 */
function RungCell(props: { cell: LadderCell; runs: number }) {
  const c = (): LadderCell => props.cell;
  const short = (): boolean => c().askable < props.runs;
  const title = (): string =>
    `${c().reached} of ${c().askable} run${c().askable === 1 ? "" : "s"} reached this rung` +
    (short()
      ? `; ${props.runs - c().askable} of the row's ${props.runs} predate the record this rung reads and could not be asked`
      : "") +
    (c().runId === null ? "" : ` — link goes to ${c().runId}, the first that did`);
  return (
    <td class="right">
      <Show when={c().status === "reached"} fallback={<Unreached cell={c()} runs={props.runs} />}>
        <A href={`/run/${encodeURIComponent(c().runId ?? "")}`} title={title()}>
          <span class="ok mono">
            {c().reached}/{c().askable}
          </span>
          <Show when={short()}>
            <span class="dim">*</span>
          </Show>
        </A>
      </Show>
    </td>
  );
}

function Unreached(props: { cell: LadderCell; runs: number }) {
  const asked = (): string =>
    props.cell.askable === 0
      ? "no run's records can answer this rung"
      : `0 of ${props.cell.askable} run${props.cell.askable === 1 ? "" : "s"} reached it` +
        (props.cell.askable < props.runs
          ? `; ${props.runs - props.cell.askable} of ${props.runs} could not be asked`
          : "");
  return (
    <span class="dim" title={props.cell.status === "not-instrumented" ? "not instrumented" : asked()}>
      {props.cell.status === "not-instrumented" ? "·" : "—"}
    </span>
  );
}

