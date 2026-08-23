/**
 * Episodes: the per-run grain, under the tier that defines it.
 *
 * One page per grain (ADR-0022 amendment, 2026-08-23). The fleet page answers
 * "what is running"; this one answers "what has run" — every recorded run of
 * one tier, with the character it was played on, what it earned, how long it
 * was actually driven, what it cost, and how it ended. It is where the fleet
 * page's run table went, and it is where an aggregate row on the results page
 * drills down to.
 *
 * Two feeds, because the two questions are different. `/api/episodes` is the
 * tier definitions and how many runs sit against each; `/api/results` is the
 * runs themselves, filtered by the same `?episode=` the results and ladder
 * pages use. The membership rule (ADR-0030) lives in the API, once, so this
 * page cannot disagree with a chart about what "e90" selects.
 *
 * Three counts per tier, kept apart on purpose. **Members** are runs stamped
 * with the id and given the leash the id describes — the only ones a chart may
 * compare, and the only ones the table below lists unless overridden runs are
 * asked for by name. **Overridden** are stamped but were run on a different
 * leash, which is harness development rather than a result. **Labeled** are
 * older runs the reader recognises as looking like the tier; ADR-0030 is
 * explicit that they are never back-labeled into membership, because they ran
 * under the watchdog defaults of their day.
 *
 * The prose comes off the API rather than being written here, so the rules a
 * reader sees are the rules the runner enforces.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, on } from "solid-js";
import { api, type EpisodesResponse, type ResultRun, type ResultsResponse } from "../api/client";
import { EpisodeFilterNote, EpisodePicker, HarnessPicker, HarnessTag } from "../components/EpisodePicker";
import { episodeParam, harnessParam } from "../lib/episodes";
import { fmtDuration, fmtMoney, fmtTokens, fmtUsd, fmtWhen, num, shortHarness, stamp } from "../lib/format";
import { poll } from "../lib/poll";

/** Tier definitions never move; the counts move when a run ends. */
const POLL_MS = 30_000;

function mins(m: number | null): string {
  if (m === null) return "none";
  return m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m`;
}

/**
 * Newest first, and a run with no start time sorts last.
 *
 * Explicit rather than inherited from the API's directory order: the order a
 * listing is read in is not a claim about time, and this page makes one.
 */
function newestFirst(runs: readonly ResultRun[]): ResultRun[] {
  return [...runs].sort((a, b) => {
    if (a.startedAt === b.startedAt) return 0;
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return b.startedAt - a.startedAt;
  });
}

export default function Episodes() {
  /*
   * The tier lives in the URL, so a link from the results page lands on the
   * runs behind the row it was clicked from, and a shared link keeps meaning
   * what it meant. `all` is the default here — this page is an inventory, not
   * a comparison, and the fleet page's "N runs recorded" points at all of them.
   */
  const [params, setParams] = useSearchParams();
  const episode = (): ReturnType<typeof episodeParam> => episodeParam(params.episode, "all");
  const overrides = (): boolean => params.overrides === "1";
  const harness = (): ReturnType<typeof harnessParam> => harnessParam(params.harness);
  /*
   * `?model=`/`?effort=` are client-side, as they are on the results page:
   * `/api/results` has no model parameter and giving it one would widen a route
   * the charts share with the ladder. `(model, effort)` is the pair the roster
   * matches runs on, so both travel together or the link over-matches.
   */
  const model = (): string | null =>
    typeof params.model === "string" && params.model.length > 0 ? params.model : null;
  const effort = (): string | null =>
    typeof params.effort === "string" && params.effort.length > 0 ? params.effort : null;

  const tiers = poll(() => api.episodes(), POLL_MS);
  const feed = poll(() => api.results(episode(), overrides(), harness()), POLL_MS);
  // `poll` is a timer, not a reactive computation: a changed filter has to ask
  // for the new data itself.
  createEffect(on([episode, overrides, harness], () => feed.refresh(), { defer: true }));

  const table = (): EpisodesResponse["episodes"] => tiers.latest?.episodes ?? [];
  const body = (): ResultsResponse | undefined => feed.latest;
  const all = (): ResultRun[] => body()?.runs ?? [];
  const rows = createMemo(() => {
    const m = model();
    const mine = m === null ? all() : all().filter((r) => r.model === m && (r.effort ?? null) === effort());
    return newestFirst(mine);
  });

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{String(feed.error)}</div>
      </Show>

      <h2 class="section">episodes</h2>
      <p class="dim">
        The rulesets a run can be launched under, with <code>--episode &lt;id&gt;</code>, and every
        run recorded against one. An id is a comparability group: two runs may only be compared if
        they share an id <em>and</em> a harness series (ADR-0030, ADR-0034). The id fixes the shape
        of the run — how long, which watchdogs, whether the operator may steer — and nothing about
        the model. Aggregates are the <A href="/results">results</A> page; this is the runs.
      </p>

      <EpisodePicker
        value={episode()}
        onChange={(v) => setParams({ episode: v }, { replace: true })}
        includeOverrides={overrides()}
        onOverridesChange={(v) => setParams({ overrides: v ? "1" : null }, { replace: true })}
      />
      <HarnessPicker
        value={harness()}
        onChange={(v) => setParams({ harness: v === "all" ? null : v }, { replace: true })}
      />

      <Show when={model() !== null}>
        <p class="dim">
          Filtered to{" "}
          <span class="mono">
            {model()}
            <Show when={effort() !== null}> ({effort()})</Show>
          </span>{" "}
          ({rows().length} of {all().length} runs in this view){" "}
          <button class="toggle" onClick={() => setParams({ model: null, effort: null }, { replace: true })}>
            clear
          </button>
        </p>
      </Show>

      <Show when={feed.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <EpisodeFilterNote
          episode={episode()}
          filteredOut={body()?.filteredOut ?? 0}
          overridesExcluded={body()?.overridesExcluded ?? 0}
        />
        <p class="dim">
          {rows().length} run{rows().length === 1 ? "" : "s"}, newest first. Every recorded run
          appears, scorable or not — a launch that never produced a model response is archived by
          the runner as it exits and never reaches a listing at all.
        </p>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>run</th>
                <th>model</th>
                <th>episode</th>
                <th>harness</th>
                <th>character</th>
                <th class="right">lvl</th>
                <th class="right">xp</th>
                <th class="right">money</th>
                <th class="right">quests</th>
                <th>started</th>
                <th class="right">playtime</th>
                <th class="right">tokens</th>
                <th class="right" title="what the provider says it charged; blank where nothing was reported">
                  cost
                </th>
                <th>ended</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>{(r) => <RunRowView row={r} />}</For>
            </tbody>
          </table>
        </div>
        <p class="dim">
          Playtime is active time: the stretches between a pause and its resume are not charged.
          Cost is the <em>actual</em> figure — what the provider reported billing — and is blank
          wherever nothing was reported rather than showing the price table's estimate in its place.
          The estimate is on the run page, next to the actual, where the two can be compared.
        </p>
      </Show>

      <h2 class="section">the tiers</h2>
      <Show when={tiers.latest !== undefined} fallback={<p class="dim">loading…</p>}>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>episode</th>
                <th class="right">wall clock</th>
                <th class="right">idle</th>
                <th class="right">no-xp</th>
                <th class="right">tool calls</th>
                <th>objective</th>
                <th>scoring</th>
                <th class="right">members</th>
                <th class="right">overridden</th>
                <th class="right">labeled</th>
              </tr>
            </thead>
            <tbody>
              <For each={table()}>
                {(t) => (
                  <tr>
                    <td>
                      <button
                        class={`toggle${t.id === episode() ? " on" : ""}`}
                        onClick={() => setParams({ episode: t.id }, { replace: true })}
                      >
                        {t.id}
                      </button>
                    </td>
                    <td class="right mono">{mins(t.minutes)}</td>
                    <td class="right mono">{mins(t.idleMinutes)}</td>
                    <td class="right mono">{t.noXpMinutes === null ? "off" : mins(t.noXpMinutes)}</td>
                    <td class="right mono">{t.toolCalls === null ? "per job" : t.toolCalls}</td>
                    <td class="dim">{t.objectiveAllowed ? "allowed" : "none"}</td>
                    <td class={t.scored ? "" : "warn"}>{t.scored ? "scored" : "unscored"}</td>
                    <td class="right mono">{t.members}</td>
                    <td class="right mono dim">{t.overrides}</td>
                    <td class="right mono dim">{t.derived}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>

        <For each={table()}>
          {(t) => (
            <>
              <h2 class="section">{t.id}</h2>
              <p>{t.summary}</p>
              <p class="dim">
                {t.members} member run{t.members === 1 ? "" : "s"}
                <Show when={t.overrides > 0}> · {t.overrides} with an overridden leash</Show>
                <Show when={t.derived > 0}> · {t.derived} older run(s) labeled, never enrolled</Show>
                {" · "}
                <A href={`/results?episode=${t.id}`}>results</A> ·{" "}
                <A href={`/ladder?episode=${t.id}`}>ladder</A>
              </p>
            </>
          )}
        </For>

        <h2 class="section">runs that belong to no tier</h2>
        <p class="dim">
          {tiers.latest!.untiered} run{tiers.latest!.untiered === 1 ? "" : "s"} carry no episode id
          and cannot be given one. They ran before the ids existed, under the watchdog defaults of
          their day, and a tuple field is never recomputed after the fact (ADR-0026): saying nothing
          is more honest than asserting a comparability that was never established. They are listed
          under{" "}
          <button class="toggle" onClick={() => setParams({ episode: "all" }, { replace: true })}>
            all
          </button>
          , above.
        </p>
      </Show>
    </div>
  );
}

/**
 * One run. The whole row is the fleet table's old row, plus the tier the page
 * is now organised by — and minus the cost estimate, which does not belong in
 * a column headed "cost" next to runs whose figure is a real bill.
 */
function RunRowView(props: { row: ResultRun }) {
  const r = (): ResultRun => props.row;
  /*
   * The actual cost only, and a blank that says which nothing it is: no price
   * reported by this provider, no usage opt-in, a session that never ended
   * cleanly. `note` is always populated for exactly this reason.
   */
  const cost = (): string =>
    r().actualCost === null || r().actualCost!.basis === "none" || r().actualCost!.usd === null
      ? "—"
      : fmtUsd(r().actualCost!.usd);
  const ended = (): string =>
    r().terminationReason ?? (r().pauseReason !== null ? `paused: ${r().pauseReason}` : "—");
  return (
    <tr>
      <td>
        <A href={`/run/${encodeURIComponent(r().runId)}`}>{r().runId}</A>
      </td>
      <td class="dim">
        {r().model ?? "—"}
        <Show when={r().effort !== null}>
          {" "}
          <span class="dim">({r().effort})</span>
        </Show>
        <Show when={r().unscored !== null}>
          {" "}
          <span class="warn" title={r().unscored ?? ""}>
            unscored
          </span>
        </Show>
        <Show when={r().extra}>
          {" "}
          <span class="dim" title="an extra run past the policy target (ADR-0034)">
            extra
          </span>
        </Show>
      </td>
      {/*
        The tier and how the run came by it: a derived label is the reader
        recognising the shape of a run, never the run claiming membership.
      */}
      <td class="dim" title={r().episodeSource === "derived" ? "labeled by the reader, never enrolled (ADR-0030)" : ""}>
        {r().episode ?? "—"}
        <Show when={r().episodeSource === "derived"}> (labeled)</Show>
        <Show when={r().episodeOverride}>
          {" "}
          <span class="warn" title="stamped with this tier but given a leash it does not describe">
            overridden
          </span>
        </Show>
      </td>
      <td>
        <HarnessTag harness={r().harness} />
        <Show when={r().harnessVersion !== null}>
          {" "}
          <span class="dim mono" title={r().harnessVersion ?? ""}>
            {shortHarness(r().harnessVersion)}
          </span>
        </Show>
      </td>
      <td class="dim" title={r().characterLabel ?? "race and class not recorded for this run"}>
        {r().character ?? "—"}
        <Show when={r().characterLabel !== null}>
          {" "}
          <span class="dim">({r().characterLabel})</span>
        </Show>
      </td>
      <td class="right mono">{num(r().maxLevel)}</td>
      <td class="right mono">{num(r().xp)}</td>
      <td class="right mono">{fmtMoney(r().money)}</td>
      <td class="right mono">{num(r().questsCompleted)}</td>
      <td class="dim" title={stamp(r().startedAt)}>
        {fmtWhen(r().startedAt)}
      </td>
      <td class="right mono dim">{fmtDuration(r().playtimeMs)}</td>
      <td class="right mono dim" title={r().tokens?.source ?? ""}>
        {fmtTokens(r().tokens?.totalTokens ?? null)}
      </td>
      <td class="right mono dim" title={r().actualCost?.note ?? "no cost recorded for this run"}>
        {cost()}
      </td>
      <td class={r().terminationReason === null ? "dim" : ""}>{ended()}</td>
    </tr>
  );
}
