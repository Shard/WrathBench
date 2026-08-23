/**
 * The eval charts: what a level costs, per model, per harness version.
 *
 * Two axes and both are qualified on the page rather than in a footnote. Turns
 * are *driver* turns at first observation — state is sampled on a 60s clock, so
 * a level is credited to the turn that was in flight when it was first seen.
 * Time is active time, pause stretches removed, which is the same figure the
 * run page calls playtime.
 *
 * Runs that cannot be scored never appear: a shakeout driver's turns are not
 * the fixed loop's turns, and an objective run was steered (ADR-0024). The
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
import { api, type EvalResponse, type EvalRun } from "../api/client";
import { EpisodeFilterNote, EpisodePicker, episodeParam } from "../components/EpisodePicker";
import { CHART_LEVELS, groupsForLevel, scored, type EvalGroup } from "../lib/eval";
import { fmtDuration, shortHarness } from "../lib/format";
import { poll } from "../lib/poll";

/** Eval data is historical; it moves when a run ends, not second to second. */
const POLL_MS = 30_000;

const BAR_H = 18;
const BAR_GAP = 6;
const LABEL_W = 260;
const CHART_W = 720;

export default function Eval() {
  // The tier lives in the URL so a link from the episodes page lands on the
  // right group and a shared link keeps meaning what it meant.
  const [params, setParams] = useSearchParams();
  const episode = (): ReturnType<typeof episodeParam> => episodeParam(params.episode);
  const overrides = (): boolean => params.overrides === "1";
  // Stillborn runs — launches with no model response — are hidden by default;
  // the choice rides in the URL like the tier does, so a link keeps its meaning.
  const stillborn = (): boolean => params.stillborn === "1";
  const feed = poll(() => api.eval(episode(), overrides(), stillborn()), POLL_MS);
  // `poll` is a timer, not a reactive computation: a changed filter has to ask
  // for the new data itself.
  createEffect(on([episode, overrides, stillborn], () => feed.refresh(), { defer: true }));
  const [level, setLevel] = createSignal<number>(5);
  /*
   * Active time by default. Turns only exist for runs recorded after the turn
   * column landed, so a turns-first page would greet every visitor with the
   * "no run recorded a turn index" banner until the fleet has cycled.
   */
  const [metric, setMetric] = createSignal<"turns" | "time">("time");

  const body = (): EvalResponse | undefined => feed.latest;
  const runs = (): EvalRun[] => body()?.runs ?? [];
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

      <h2 class="section">eval</h2>
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
        stillborn={body()?.stillbornExcluded ?? 0}
        includeStillborn={stillborn()}
        onStillbornChange={(v) => setParams({ stillborn: v ? "1" : null }, { replace: true })}
      />

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

      <Show when={feed.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <EpisodeFilterNote
          episode={episode()}
          filteredOut={body()?.filteredOut ?? 0}
          overridesExcluded={body()?.overridesExcluded ?? 0}
          stillborn={body()?.stillbornExcluded ?? 0}
          includeStillborn={stillborn()}
        />
        <p class="dim">
          {scored(runs()).length} scorable runs
          <Show when={excluded() > 0}>
            {" "}
            · {excluded()} excluded (shakeout driver or operator objective)
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
                <th>harness</th>
                <th>effort</th>
                <th>wiki</th>
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
                    <td>{g.model}</td>
                    <td class="dim">{shortHarness(g.harnessVersion)}</td>
                    <td class="dim">{g.effort ?? "—"}</td>
                    <td class="dim">{g.wikiCoords === null ? "—" : g.wikiCoords ? "coords" : "names"}</td>
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
function Chart(props: { groups: EvalGroup[]; metric: "turns" | "time"; level: number }) {
  const rows = createMemo(() =>
    props.groups
      .map((g) => ({
        g,
        value: props.metric === "turns" ? g.bestTurn : g.bestMs,
      }))
      .filter((r): r is { g: EvalGroup; value: number } => r.value !== null),
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
                    {row.g.model} · {shortHarness(row.g.harnessVersion)} · {label(row.value)} ·{" "}
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
