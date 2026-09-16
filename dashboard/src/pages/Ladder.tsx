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
import { SeriesFilterNote, useSeriesFilter } from "../components/SeriesSelect";
import { LADDER_VIEWS, type LadderView, viewParam } from "../lib/axes";
import { EPISODE_CHOICES, episodeParam } from "../lib/episodes";
import {
  RUNGS,
  billingKnown,
  scored,
  classOptions,
  filterRuns,
  harnessOptions,
  ladderRows,
  raceOptions,
  resolveChoice,
  characterRows,
  type FilterChoice,
  type LadderCell,
  type LadderRow,
  type LevelRange,
  type CharacterRow,
} from "../lib/ladder";
import {
  type ReferenceMark,
  type ReferenceScale,
  empiricalCeiling,
  referenceScale,
  speedrunBand,
} from "../lib/reference";
import { resolvedSummary } from "../lib/models";
import { fmtMoney, fmtWhen, modelDisplay } from "../lib/format";
import { poll } from "../lib/poll";
import { readBoolPref, readChoicePref, writeBoolPref, writeChoicePref } from "../lib/prefs";
import { displayError } from "../lib/errors";

const POLL_MS = 30_000;

/*
 * The controls are remembered per viewer, not put in the URL. The episode is
 * the page's address and stays a query parameter; race, class, harness and the
 * free toggle are how one reader likes to look at it, and a link that carried
 * them would send someone else's filter along with the tier. A remembered
 * choice the current runs cannot honour resolves back to "all"
 * (`resolveChoice`), so nothing empties the table invisibly.
 *
 * The `?character=` chip filter these replace is gone; an old link carrying it
 * lands on "all", which is the view it would have shown anyway before someone
 * clicked a chip.
 */
const RACE_KEY = "wb.ladder.race";
const CLASS_KEY = "wb.ladder.class";
const HARNESS_KEY = "wb.ladder.harness";
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
  const series = seriesFilter.series;
  const all = seriesFilter.kept;
  /*
   * Race, class and harness narrow the set, and "exclude free" keeps only the
   * runs we paid for (`ResultRun.billing`, `runner/src/billing.ts` — a
   * `claude-code` subscription counts as paid there). All four are applied
   * BEFORE the rows are derived — `ladderRows` on a scored tier, `characterRows`
   * on freeplay — so the ranking is computed over exactly the rows on screen;
   * the order itself is untouched (highest rung, XP, gold). On freeplay that
   * ordering is before the lineage walk, so a chain whose ancestor the filter
   * drops re-roots on its survivor; billing follows the endpoint and a character
   * is one character under one config, so a mixed chain is not a shape the
   * fleet produces (`lib/ladder.ts` pins the behaviour anyway).
   *
   * None is a row key. A model's row is its best run whatever it was played
   * on, because the baseline character is the comparison set.
   */
  const [race, setRace] = createSignal<FilterChoice>(readChoicePref(RACE_KEY));
  const [klass, setKlass] = createSignal<FilterChoice>(readChoicePref(CLASS_KEY));
  const [harness, setHarness] = createSignal<FilterChoice>(readChoicePref(HARNESS_KEY));
  const [excludeFree, setExcludeFree] = createSignal(readBoolPref(FREE_KEY, true));
  const pick = (
    set: (v: FilterChoice) => void,
    key: string,
  ): ((value: string) => void) => (value: string): void => {
    const choice = value === "" ? null : value;
    set(choice);
    writeChoicePref(key, choice);
  };
  // Options come from the whole episode, not from the mutually filtered set:
  // picking a race must not prune the class list under the reader's cursor.
  const races = createMemo(() => raceOptions(all()));
  const classes = createMemo(() => classOptions(all()));
  const harnesses = createMemo(() => harnessOptions(all()));
  const runs = createMemo(() =>
    filterRuns(all(), {
      race: resolveChoice(races(), race()),
      klass: resolveChoice(classes(), klass()),
      harness: resolveChoice(harnesses(), harness()),
      excludeFree: excludeFree(),
    }),
  );
  const characters = createMemo(() => characterRows(runs()));
  // A viewer that predates `billing` reports it on no run at all, and a toggle
  // that excludes nothing is worse than one that is obviously off (the rule
  // `SeriesFilterNote` states for the series filter).
  const billingUnknown = (): boolean =>
    excludeFree() && all().length > 0 && !billingKnown(all());
  const rows = createMemo(() => ladderRows(runs()));
  /*
   * The reference lines are derived from the series-filtered *scored* set,
   * deliberately before race, class, harness and "exclude free": the ceiling
   * is labelled "best observed e90, harness 0.5", and a number that moved when
   * a reader ticked a checkbox would make its own label false. The rows on
   * screen only decide how far the scale has to stretch.
   */
  const ceiling = createMemo(() => empiricalCeiling(scored(all())));
  const reference = createMemo((): ReferenceScale | null =>
    freeplay()
      ? null
      : referenceScale({
          episode: episode(),
          series: series(),
          ceiling: ceiling(),
          reached: rows().reduce<number | null>(
            (m, r) => (r.bestLevel === null ? m : Math.max(m ?? 0, r.bestLevel)),
            null,
          ),
        }),
  );

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

      <SeriesFilterNote series={series()} filteredOut={seriesFilter.filteredOut()} />

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
        <FilterSelect label="race" options={races()} value={resolveChoice(races(), race())} onPick={pick(setRace, RACE_KEY)} />
        <FilterSelect label="class" options={classes()} value={resolveChoice(classes(), klass())} onPick={pick(setKlass, CLASS_KEY)} />
        <FilterSelect
          label="harness"
          options={harnesses()}
          value={resolveChoice(harnesses(), harness())}
          onPick={pick(setHarness, HARNESS_KEY)}
          title="The harness tag. A tag on the row, not a partition — filtering by it is the reader's choice, not a comparability rule."
        />
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
        </Show>
        </div>
      </div>
      <Show when={billingUnknown()}>
        <p class="dim">
          Nothing excluded: these runs predate the <span class="mono">billing</span> record, so
          "exclude free" has nothing to go on. Runs recorded from here on carry it — a filter that
          silently kept everything would be worse than one that says so.
        </p>
      </Show>

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
        <LadderChart runs={runs()} episode={episode()} view={view()} pareto={pareto()} />
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
                  <tr>
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
                      {row.bestMoney === null ? "—" : fmtMoney(row.bestMoney)}
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

        <Show when={reference()}>{(ref) => <ReferenceStrip scale={ref()} episode={episode()} />}</Show>

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
                <td>
                  {row.character ?? "—"}
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
                  <Show when={row.level !== null} fallback={<span class="dim">—</span>}>
                    <span>
                      L{row.level}
                      <Show when={row.xp !== null}>
                        <span class="dim"> · {row.xp!.toLocaleString()} xp</span>
                      </Show>
                    </span>
                  </Show>
                </td>
                <td class="right mono dim">{row.money === null ? "—" : fmtMoney(row.money)}</td>
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
 * The two reference lines, on a level scale under the table.
 *
 * A level reading on the ladder is otherwise legible only against other
 * models' level readings, so the page says what ninety minutes in this world
 * can contain: the best any scored run of this series actually managed, and
 * roughly where a practised human is at the same point. The operator chose
 * these two over a scripted grinder or walkthrough baseline (2026-09-16), so
 * nothing new was run for either — one is a maximum over the runs on hand and
 * the other is a constant with its sources in `lib/reference.ts`.
 *
 * Below the table rather than inside it: the rung table carries eight extra
 * columns and lives in a `.scroller`, and a reference row in there would be
 * behind a horizontal scroll on a phone. Both marks are drawn as spans — the
 * speedrun figure is a band, not a point, because one confirmed entry fixes a
 * pace and not a distribution, and reading a level off it at minute N is a
 * judgement. Provenance is on the hover and repeated in the footnote, which is
 * the whole point of drawing them.
 */
function ReferenceStrip(props: { scale: ReferenceScale; episode: string }) {
  const span = (): number => Math.max(props.scale.max - props.scale.min, 1);
  /** A level's position along the rail, as a percentage — so the strip is fluid and needs no measuring. */
  const at = (level: number): string => `${(((level - props.scale.min) / span()) * 100).toFixed(2)}%`;
  const width = (m: ReferenceMark): string =>
    `${(((m.high - m.low) / span()) * 100).toFixed(2)}%`;
  /** Every level the rail labels: the ends, and each mark's own edges. */
  const ticks = (): number[] =>
    [...new Set([props.scale.min, ...props.scale.marks.flatMap((m) => [m.low, m.high]), props.scale.max])].sort(
      (a, b) => a - b,
    );
  return (
    <div class="reference">
      <div class="reference-rail" role="img" aria-label={ariaOf(props.scale)} title={ariaOf(props.scale)}>
        <For each={props.scale.marks}>
          {(m) => (
            <Show
              when={m.high > m.low}
              fallback={<span class={`ref-mark line ${m.id}`} style={{ left: at(m.low) }} title={`${m.label} — ${m.provenance}`} />}
            >
              <span
                class={`ref-mark band ${m.id}`}
                style={{ left: at(m.low), width: width(m) }}
                title={`${m.label} — ${m.provenance}`}
              />
            </Show>
          )}
        </For>
        <For each={ticks()}>
          {(t) => (
            <span class="ref-tick mono dim" style={{ left: at(t) }}>
              L{t}
            </span>
          )}
        </For>
      </div>
      {/* The legend carries the numbers, because the rail is squeezed on a
          phone and a label that has to be measured off a rail is not a label. */}
      <ul class="reference-legend dim">
        <For each={props.scale.marks}>
          {(m) => (
            <li title={m.provenance}>
              <span class={m.id === "ceiling" ? "swatch line" : "swatch band"} aria-hidden="true" />
              <span class="mono">{m.low === m.high ? `L${m.low}` : `L${m.low}–${m.high}`}</span> {m.label}
            </li>
          )}
        </For>
      </ul>
      <p class="dim reference-note">
        Neither line is a score and neither enters the row order. The ceiling is derived at read time
        from this tier's scored runs on the selected series — it is not a target and not a constant, and
        it moves the moment a run beats it.{" "}
        <Show when={speedrunBand(props.episode)}>
          {(band) => (
            <>
              The band is a committed constant: roughly L{band().low}–{band().high} by {band().minutes} minutes, read off{" "}
              <For each={band().sources}>
                {(src, i) => (
                  <>
                    <Show when={i() > 0}>, </Show>
                    <Show
                      when={src.url}
                      fallback={<span title={`${src.what} — ${src.note}`}>{src.what}</span>}
                    >
                      <a href={src.url} rel="noreferrer" title={`${src.what} — ${src.note}`}>
                        {src.what}
                      </a>
                    </Show>
                  </>
                )}
              </For>
              . speedrun.com's Wrath of the Lich King Classic Archive board carries one entry in
              each of the categories the bands rest on, both confirmed in a browser by the operator
              on 2026-09-16; the Classic Era and Cataclysm Classic records run different XP rates and
              are context, not the figure. One entry per category is thin, and a Hunter speedrun
              route with death warps is an upper bound on what WrathBench's Dwarf Paladin can do, not
              a par score.{" "}
            </>
          )}
        </Show>
        The notes travel with the constant in{" "}
        <span class="mono">dashboard/src/lib/reference.ts</span>.
      </p>
    </div>
  );
}

function ariaOf(scale: ReferenceScale): string {
  return `A level scale from L${scale.min} to L${scale.max} carrying ${scale.marks
    .map((m: ReferenceMark) => `${m.label} at ${m.low === m.high ? `L${m.low}` : `L${m.low}–${m.high}`}`)
    .join(" and ")}`;
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
      <span>
        L{r().bestLevel}
        <Show when={r().bestXp !== null}>
          <span class="dim"> · {r().bestXp!.toLocaleString()} xp</span>
        </Show>
      </span>
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

/**
 * One filter select: "all" plus the values this episode's runs actually carry.
 *
 * `selected` on each option rather than `value` on the select, for the reason
 * `SeriesSelect` gives: `<For>` recreates every option when a poll returns, and
 * a select whose options are all replaced resets to the first one. The
 * attribute makes the DOM say which one is current, and makes it checkable
 * without a scripted browser.
 */
function FilterSelect(props: {
  label: string;
  options: readonly string[];
  value: FilterChoice;
  onPick: (value: string) => void;
  title?: string;
}) {
  return (
    <label class="filter" title={props.title}>
      <span class="dim">{props.label}</span>
      <select onChange={(e) => props.onPick(e.currentTarget.value)}>
        <option value="" selected={props.value === null}>
          all
        </option>
        <For each={props.options}>
          {(o) => (
            <option value={o} selected={o === props.value}>
              {o}
            </option>
          )}
        </For>
      </select>
    </label>
  );
}
