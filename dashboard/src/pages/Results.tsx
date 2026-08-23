/**
 * The results charts: what a level costs, per model, per harness version.
 *
 * Two axes and both are qualified on the page rather than in a footnote. Turns
 * are *driver* turns at first observation — state is sampled on a 60s clock, so
 * a level is credited to the turn that was in flight when it was first seen.
 * Time is active time, pause stretches removed, which is the same figure the
 * run page calls playtime.
 *
 * Runs that cannot be scored never appear: a scripted stub is not a model, and
 * an objective run was steered (ADR-0033). The harness (ADR-0035) is a tag on
 * the row, never an exclusion: claude-code and wrathbench rows share the
 * chart, and the column says which loop each group's runs came from. The
 * count of what was excluded is shown, because a chart that silently drops
 * three quarters of the runs is a lie of omission.
 *
 * The same rule governs the episode filter (ADR-0030). A tier is a
 * comparability group and the page shows one at a time — e90 by default — and
 * says how many rows that filter removed. Older runs that merely *look* like a
 * tier are labeled, never enrolled, so they show up under `all` and nowhere
 * else.
 *
 * Drawn by hand in SVG. A charting library would be a dependency for two bar
 * charts, and ADR-0022's exception was for a component model, not for widgets.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { api, type ResultsResponse, type ResultRun, type ModelRowView } from "../api/client";
import { EpisodeFilterNote, EpisodePicker, HarnessPicker, HarnessTag, episodeParam, harnessParam } from "../components/EpisodePicker";
import { CHART_LEVELS, byCharacter, characterOptions, groupsForLevel, scored, type ResultGroup } from "../lib/results";
import { modelsHref, rosterNameFor } from "../lib/models";
import { fmtDuration, shortHarness } from "../lib/format";
import { poll } from "../lib/poll";

/** Results data is historical; it moves when a run ends, not second to second. */
const POLL_MS = 30_000;

const BAR_H = 18;
const BAR_GAP = 6;
const LABEL_W = 260;
const CHART_W = 720;

export default function Results() {
  // The tier lives in the URL so a link from the episodes page lands on the
  // right group and a shared link keeps meaning what it meant.
  const [params, setParams] = useSearchParams();
  const episode = (): ReturnType<typeof episodeParam> => episodeParam(params.episode);
  const overrides = (): boolean => params.overrides === "1";
  // The harness filter (ADR-0035) defaults to all; it narrows, it never partitions.
  const harness = (): ReturnType<typeof harnessParam> => harnessParam(params.harness);
  /*
   * `?model=` is a client-side filter, deliberately: `/api/results` has no model
   * parameter and giving it one would widen a route the charts share with the
   * ladder. The models page links here with it so a row's "2/3" is one click
   * from the runs behind it.
   */
  const model = (): string | null => (typeof params.model === "string" && params.model.length > 0 ? params.model : null);
  /*
   * Effort travels with the model, because `(model, effort)` is the pair the
   * projection matches runs on: without it a link from the `sonnet-low` row
   * would show `sonnet`'s runs too. Absent means "the entry with no effort",
   * which is a different row from any effort at all.
   */
  const effort = (): string | null => (typeof params.effort === "string" && params.effort.length > 0 ? params.effort : null);
  /*
   * The starting character (ADR-0034's extras cycle) is a client-side filter
   * for the same reason `?model=` is, and it is a *filter*, not a group key:
   * the baseline character is the comparison set, so a Dwarf Hunter run sits
   * in the same row as the Human Paladin runs it is being compared against
   * unless the reader asks to see one character alone.
   */
  const character = (): string | null =>
    typeof params.character === "string" && params.character.length > 0 ? params.character : null;
  const feed = poll(() => api.results(episode(), overrides(), harness()), POLL_MS);
  // The roster, only so an results row can name the model it belongs to and link
  // back to it. A failure here must not take the charts down with it.
  const roster = poll(() => api.models(), 60_000);
  const rosterRows = (): ModelRowView[] => roster.latest?.models ?? [];
  // `poll` is a timer, not a reactive computation: a changed filter has to ask
  // for the new data itself.
  createEffect(on([episode, overrides, harness], () => feed.refresh(), { defer: true }));
  const [level, setLevel] = createSignal<number>(5);
  /*
   * Active time by default. Turns only exist for runs recorded after the turn
   * column landed, so a turns-first page would greet every visitor with the
   * "no run recorded a turn index" banner until the fleet has cycled.
   */
  const [metric, setMetric] = createSignal<"turns" | "time">("time");

  const body = (): ResultsResponse | undefined => feed.latest;
  const all = (): ResultRun[] => body()?.runs ?? [];
  const runs = (): ResultRun[] => {
    const m = model();
    const mine = m === null ? all() : all().filter((r) => r.model === m && (r.effort ?? null) === effort());
    return byCharacter(mine, character());
  };
  // Options come off the unfiltered response, so choosing a chip never empties
  // the chip row it was chosen from.
  const characters = createMemo(() => characterOptions(all()));
  const groups = createMemo(() => groupsForLevel(runs(), level()));
  const excluded = createMemo(() => runs().length - scored(runs()).length);
  const withTurns = createMemo(() =>
    groups().some((g) => g.bestTurn !== null),
  );

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{String(feed.error)}</div>
      </Show>

      <h2 class="section">results</h2>
      <p class="dim">
        Cost of reaching a level, per model per harness version. Scores are comparable within a
        harness version only (ADR-0004); effort is part of the row, not averaged away (ADR-0024), and
        so is whether the wiki served coordinates (ADR-0028).
      </p>

      <EpisodePicker
        value={episode()}
        onChange={(v) => setParams({ episode: v }, { replace: true })}
        includeOverrides={overrides()}
        onOverridesChange={(v) => setParams({ overrides: v ? "1" : null }, { replace: true })}
      />
      <HarnessPicker value={harness()} onChange={(v) => setParams({ harness: v === "all" ? null : v }, { replace: true })} />

      <Show when={model() !== null}>
        <p class="dim">
          Filtered to{" "}
          <span class="mono">
            {model()}
            <Show when={effort() !== null}> ({effort()})</Show>
          </span>{" "}
          ({runs().length} of {all().length} runs in this tier){" "}
          <button class="toggle" onClick={() => setParams({ model: null, effort: null }, { replace: true })}>
            clear
          </button>
        </p>
      </Show>

      <div class="chips">
        <For each={CHART_LEVELS}>
          {(l) => (
            <button class={l === level() ? "on" : ""} onClick={() => setLevel(l)}>
              L{l}
            </button>
          )}
        </For>
        <span class="spacer" style={{ width: "16px", display: "inline-block" }} />
        <button class={metric() === "turns" ? "on" : ""} onClick={() => setMetric("turns")}>
          turns
        </button>
        <button class={metric() === "time" ? "on" : ""} onClick={() => setMetric("time")}>
          active time
        </button>
      </div>

      <Show when={characters().length > 0}>
        <div class="chips">
          <button class={character() === null ? "on" : ""} onClick={() => setParams({ character: null }, { replace: true })}>
            all characters
          </button>
          <For each={characters()}>
            {(c) => (
              <button
                class={character() === c ? "on" : ""}
                onClick={() => setParams({ character: character() === c ? null : c }, { replace: true })}
              >
                {c}
              </button>
            )}
          </For>
        </div>
        <p class="dim">
          Race and class label and filter rows; they are not a group key. The baseline character
          (Human Paladin) is the comparison set — an extras run on another character (ADR-0034)
          shares its model's row unless one character is picked here.
        </p>
      </Show>

      <Show when={feed.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <EpisodeFilterNote
          episode={episode()}
          filteredOut={body()?.filteredOut ?? 0}
          overridesExcluded={body()?.overridesExcluded ?? 0}
        />
        <p class="dim">
          {scored(runs()).length} scorable runs
          <Show when={excluded() > 0}>
            {" "}
            · {excluded()} excluded (scripted stub or operator objective)
          </Show>
        </p>

        <Show
          when={groups().some((g) => g.reached.length > 0)}
          fallback={<p class="dim">No scorable run has reached level {level()} yet.</p>}
        >
          <Show
            when={metric() === "time" || withTurns()}
            fallback={
              <div class="banner warn">
                No run that reached L{level()} recorded a turn index — those runs predate the
                column. Their time is still charted.
              </div>
            }
          >
            <Chart groups={groups()} metric={metric()} level={level()} />
          </Show>
        </Show>

        <h2 class="section">rows</h2>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th title="harness series (major.minor); hover a row for the exact builds it holds">series</th>
                <th>harness</th>
                <th>effort</th>
                <th>wiki</th>
                <th title="starting race and class; a row spanning several says so">character</th>
                <th class="right">runs</th>
                <th class="right">reached L{level()}</th>
                <th class="right">best turns</th>
                <th class="right">median turns</th>
                <th class="right">best time</th>
                <th class="right">median time</th>
                <th class="right">tool calls</th>
                <th>fastest run</th>
              </tr>
            </thead>
            <tbody>
              <For each={groups()}>
                {(g) => (
                  <tr>
                    <td>
                      <Show when={rosterNameFor(rosterRows(), g.model, g.effort)} fallback={g.model}>
                        {(name) => (
                          <A href={modelsHref(name())} title="the roster row for this model">
                            {g.model}
                          </A>
                        )}
                      </Show>
                    </td>
                    <td class="dim" title={g.harnessVersions.map(shortHarness).join(", ")}>
                      {g.harnessVersion}
                      <Show when={g.harnessVersions.length > 1}>
                        <span class="dim"> ({g.harnessVersions.length} builds)</span>
                      </Show>
                    </td>
                    <td>
                      <For each={g.harnesses}>{(h) => <HarnessTag harness={h} />}</For>
                    </td>
                    <td class="dim">{g.effort ?? "—"}</td>
                    <td class="dim">{g.wikiCoords === null ? "—" : g.wikiCoords ? "coords" : "names"}</td>
                    <td class="dim" title={g.characters.join(", ")}>
                      {g.characters.length === 0
                        ? "—"
                        : g.characters.length === 1
                          ? g.characters[0]
                          : `${g.characters.length} characters`}
                    </td>
                    <td class="right mono">{g.attempts}</td>
                    <td class="right mono">{g.reached.length}</td>
                    <td class="right mono">{g.bestTurn ?? "—"}</td>
                    <td class="right mono dim">{g.medianTurn ?? "—"}</td>
                    <td class="right mono">{fmtDuration(g.bestMs)}</td>
                    <td class="right mono dim">{fmtDuration(g.medianMs)}</td>
                    <td class="right mono dim" title="median (max) tool calls per run">
                      {g.medianToolCalls ?? "—"}
                      <Show when={g.maxToolCalls !== null}> ({g.maxToolCalls})</Show>
                    </td>
                    <td class="dim">
                      <Show when={g.reached[0]} fallback="—">
                        {(r) => <A href={`/run/${encodeURIComponent(r().runId)}`}>{r().runId}</A>}
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <p class="dim">
          Turns are the driver turn a level was <em>first observed</em> on — state is sampled every
          60s, not once per turn. Time is active time: stretches between a pause and its resume are
          not charged. Tool calls are the run's own `tool_call` records — median and, in
          parentheses, the largest single run — reported so the episode's ceiling can be sized
          against what runs actually use rather than guessed at.
        </p>
      </Show>
    </div>
  );
}

/** One horizontal bar per group. Shorter is better, so the axis starts at zero. */
function Chart(props: { groups: ResultGroup[]; metric: "turns" | "time"; level: number }) {
  const rows = createMemo(() =>
    props.groups
      .map((g) => ({
        g,
        value: props.metric === "turns" ? g.bestTurn : g.bestMs,
      }))
      .filter((r): r is { g: ResultGroup; value: number } => r.value !== null),
  );
  const max = createMemo(() => Math.max(1, ...rows().map((r) => r.value)));
  const height = createMemo(() => Math.max(1, rows().length) * (BAR_H + BAR_GAP) + 10);
  const label = (v: number): string =>
    props.metric === "turns" ? `${v} turns` : fmtDuration(v);

  return (
    <div class="scroller">
      <svg
        width={LABEL_W + CHART_W}
        height={height()}
        role="img"
        aria-label={`best ${props.metric} to level ${props.level} per model`}
      >
        <For each={rows()}>
          {(row, i) => {
            const y = (): number => i() * (BAR_H + BAR_GAP);
            const w = (): number => Math.max(2, (row.value / max()) * (CHART_W - 90));
            return (
              <>
                <text
                  x={LABEL_W - 8}
                  y={y() + BAR_H - 5}
                  text-anchor="end"
                  fill="currentColor"
                  font-size="12"
                >
                  {row.g.model}
                  {row.g.effort === null ? "" : ` (${row.g.effort})`}
                  {row.g.wikiCoords === true ? " +coords" : ""}
                </text>
                <rect
                  x={LABEL_W}
                  y={y()}
                  width={w()}
                  height={BAR_H}
                  rx="3"
                  fill="var(--accent)"
                  opacity="0.75"
                >
                  <title>
                    {row.g.model} · {row.g.harnessVersion} · {label(row.value)} ·{" "}
                    {row.g.reached.length}/{row.g.attempts} runs reached L{props.level}
                  </title>
                </rect>
                <text
                  x={LABEL_W + w() + 8}
                  y={y() + BAR_H - 5}
                  fill="currentColor"
                  font-size="12"
                  opacity="0.7"
                >
                  {label(row.value)}
                </text>
              </>
            );
          }}
        </For>
      </svg>
    </div>
  );
}
