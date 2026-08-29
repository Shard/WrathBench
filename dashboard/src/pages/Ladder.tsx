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
 * whole active field, one row per durable stream, paused and in-progress
 * included. `streamRows` in `lib/ladder.ts` is that derivation; the scored
 * ladders below are untouched by it.
 *
 * Above the table, one scatter for the tier: average cost per run against
 * average XP earned, one point per roster entry (`components/LadderChart`).
 * Freeplay gets its own graph in that place instead — `components/StreamChart`,
 * one stepped series per stream, level against cumulative active playtime; the
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
import { StreamChart } from "../components/StreamChart";
import { ModelIcon } from "../components/ModelIcon";
import { SeriesFilterNote, useSeriesFilter } from "../components/SeriesSelect";
import { EPISODE_CHOICES, episodeParam } from "../lib/episodes";
import {
  RUNGS,
  billingKnown,
  classOptions,
  filterRuns,
  harnessOptions,
  ladderRows,
  raceOptions,
  resolveChoice,
  streamRows,
  type FilterChoice,
  type LadderCell,
  type LadderRow,
  type StreamRow,
} from "../lib/ladder";
import { resolvedSummary } from "../lib/models";
import { fmtMoney, fmtWhen } from "../lib/format";
import { poll } from "../lib/poll";
import { readBoolPref, readChoicePref, writeBoolPref, writeChoicePref } from "../lib/prefs";

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
   * top characters on freeplay right now, one row per durable stream
   * (operator, 2026-08-29). It reads no rungs, so it shows neither the scatter
   * nor the rung table. The shell's series filter still does not apply, and
   * that is not a convenience: a stream is durable *across* series, so cutting
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
   * BEFORE the rows are derived — `ladderRows` on a scored tier, `streamRows`
   * on freeplay — so the ranking is computed over exactly the rows on screen;
   * the order itself is untouched (highest rung, XP, gold). On freeplay that
   * ordering is before the lineage walk, so a chain whose ancestor the filter
   * drops re-roots on its survivor; billing follows the endpoint and a stream
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
  const streams = createMemo(() => streamRows(runs()));
  // A viewer that predates `billing` reports it on no run at all, and a toggle
  // that excludes nothing is worse than one that is obviously off (the rule
  // `SeriesFilterNote` states for the series filter).
  const billingUnknown = (): boolean =>
    excludeFree() && all().length > 0 && !billingKnown(all());
  const rows = createMemo(() => ladderRows(runs()));

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{String(feed.error)}</div>
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
          disagree about which runs are on screen. */}
      <div class="ladder-controls">
        <span class="dim">
          <A href="/episodes">what these mean</A>
        </span>
        <FilterSelect label="race" options={races()} value={resolveChoice(races(), race())} onPick={pick(setRace, RACE_KEY)} />
        <FilterSelect label="class" options={classes()} value={resolveChoice(classes(), klass())} onPick={pick(setKlass, CLASS_KEY)} />
        <FilterSelect
          label="harness"
          options={harnesses()}
          value={resolveChoice(harnesses(), harness())}
          onPick={pick(setHarness, HARNESS_KEY)}
          title="The harness tag. A tag on the row, not a partition — filtering by it is the reader's choice, not a comparability rule."
        />
        <label class="filter check" title="Keep only the runs that cost money. A claude-code run counts as paid: a subscription is a bill (runner/src/billing.ts).">
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
      </div>
      <Show when={billingUnknown()}>
        <p class="dim">
          Nothing excluded: this viewer predates <span class="mono">billing</span> and reports it on
          no run, so "exclude free" has nothing to go on. It starts filtering after the viewer
          restarts — a filter that silently keeps everything would be worse than one that says so.
        </p>
      </Show>

      <Show when={feed.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <Show when={freeplay()}>
          {/* The same rows and the same runs the table reads, so the chart and
              the table can never disagree about which streams are on screen. */}
          <StreamChart rows={streams()} runs={runs()} />
          <StreamTable rows={streams()} />
        </Show>
        <Show when={!freeplay()}>
        <LadderChart runs={runs()} episode={episode()} />

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
                      {row.model}
                      {/* The ids the row's runs actually resolved to. Two of
                          them is one alias that resolved two ways across the
                          row — drift the ladder must show, not average. */}
                      <Show when={resolvedSummary(row.model, row.resolvedModels)}>
                        {(seen) => (
                          <div
                            class="dim"
                            title={
                              seen().mixed
                                ? "this row's runs were not all on the same model"
                                : "the id the provider actually served"
                            }
                          >
                            {seen().ids.join(", ")}
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
                    <For each={row.cells}>{(cell) => <RungCell cell={cell} />}</For>
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
 * The freeplay field: one row per durable stream, latest attempt first by what
 * the character has reached.
 *
 * Everything not deleted and not stillborn is here, in progress included — a
 * live stream is the point of the page, not an exclusion. The lineage column
 * is why a stream that has been through twelve attempts appears once
 * (FOLLOW-UPS 92): the row is the character, and `attempts` is how many run
 * ids are behind it.
 */
function StreamTable(props: { rows: readonly StreamRow[] }) {
  return (
    <div class="scroller">
      <table>
        <thead>
          <tr>
            <th>model</th>
            <th>character</th>
            <th>status</th>
            <th class="right" title="attempts in this stream; the row is the character, not the run">
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
                  {row.model}
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
                No freeplay streams recorded yet.
              </td>
            </tr>
          </Show>
        </tbody>
      </table>
    </div>
  );
}

/** The furthest a model's run got: `L14 · 4,120 xp`, or what was recorded of it. */
function Furthest(props: { row: LadderRow }) {
  const r = (): LadderRow => props.row;
  return (
    <Show when={r().bestLevel !== null} fallback={<span>—</span>}>
      <span>
        L{r().bestLevel}
        <Show when={r().bestXp !== null}>
          <span class="dim"> · {r().bestXp!.toLocaleString()} xp</span>
        </Show>
      </span>
    </Show>
  );
}

function RungCell(props: { cell: LadderCell }) {
  const c = (): LadderCell => props.cell;
  return (
    <td class="right">
      <Show when={c().status === "reached"} fallback={<Unreached cell={c()} />}>
        <A href={`/run/${encodeURIComponent(c().runId ?? "")}`} title={c().runId ?? ""}>
          <span class="ok">✓</span>
        </A>
      </Show>
    </td>
  );
}

function Unreached(props: { cell: LadderCell }) {
  return (
    <span
      class="dim"
      title={props.cell.status === "not-instrumented" ? "not instrumented" : "not reached"}
    >
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
