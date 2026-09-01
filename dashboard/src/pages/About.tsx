/**
 * About: the meta page — the episode tiers a run can be launched under, the
 * two harness groups, and how to read a score. Renamed from Episodes on
 * 2026-08-30 (`/episodes` redirects here); the homepage is the explainer for
 * a newcomer, this is the page for someone who wants to know what a row means.
 *
 * One page per grain. The middle of this page is the *episodes* — the
 * rulesets, how many runs sit against each and how they came to (members,
 * overridden, labeled), and a link to those runs. It lists no runs of its own:
 * an episode's id and its member count link to the ladder for that episode —
 * the members are exactly what the ladder compares — and the overridden count,
 * which the ladder has no view of, links to the runs table.
 *
 * "Episode" here is the ruleset, never the evidence budget: a *tier* (t0/t1/t2)
 * is how many runs a model is bought, and the two words are kept apart on this
 * page because a reader who conflates them misreads every count on it.
 *
 * Three counts per episode, kept apart on purpose. **Members** are runs stamped
 * with the id and run under the limits the id describes — the only ones a chart
 * may compare. **Overridden** are stamped but were run under different limits,
 * which is harness development rather than a result. **Labeled** are older runs
 * the reader recognises as looking like the episode; they are never back-labeled
 * into membership, because they ran under the watchdog defaults of their
 * day.
 *
 * The prose comes off the API rather than being written here, so the rules a
 * reader sees are the rules the runner enforces.
 */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type EpisodesResponse } from "../api/client";
import { displayError } from "../lib/errors";
import { useFeeds } from "../lib/feeds";
import { COST_BASIS_NOTE } from "../lib/format";
import { latestSeries } from "../lib/harness";
import { poll } from "../lib/poll";
import { runsHref } from "../lib/runs";

/** The ladder for one episode — the page an episode's member count leads to. */
function ladderHref(id: string): string {
  return `/ladder?episode=${encodeURIComponent(id)}`;
}

/** Episode definitions never move; the counts move when a run ends. */
const POLL_MS = 30_000;

function mins(m: number | null): string {
  if (m === null) return "none";
  return m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m`;
}

export default function About() {
  const tiers = poll(() => api.episodes(), POLL_MS);
  const table = (): EpisodesResponse["episodes"] => tiers.latest?.episodes ?? [];
  // The series the shell already knows about (`/api/info`, via `lib/feeds.ts`).
  // Hardcoding it here meant the status line went stale one bump after anyone
  // last read this file; `—` while the info feed is still in flight.
  const feeds = useFeeds();
  const series = (): string => latestSeries(feeds.seriesAvailable()) ?? "—";

  return (
    <div class="page">
      <Show when={tiers.error !== undefined}>
        <div class="banner bad">{displayError(tiers.error)}</div>
      </Show>

      {/*
        First on the page, and deliberately not an apology: an outside reader
        arriving from a link has no way to tell a running experiment from a
        finished one, and the ladder looks the same either way. Phase 0 and the
        series are `docs/PHASE-0.md` and METHODOLOGY's harness-version rule; the
        0.6 reservation is the context-policy section's own note.
      */}
      <h2 class="section">project status</h2>
      <p class="dim">
        <span class="mono">status: pre-release · harness {series()}</span>
      </p>
      <p class="dim">
        WrathBench is currently still in early development. The basics are in and on paper agents should be capable
        of progressing through most single player content but there is probably still many harness issues and
        improvements to make including proper party and communication tools for freeplay.
      </p>
      <p class="dim">
        The data for some charts will also probably be bit off as I work through more test runs and validate the numbers
        against other sources. I will be looking to open-source the repo soon once things have been sufficently cleaned up for release.
      </p>

      <h2 class="section">reading a result</h2>
      <p class="dim">
        A score means "this harness series, this model, this episode" and nothing wider. The harness —
        SDK, loop, prompt, context policy, reference bundle — is frozen per version and identical for every
        model; a minor series bump restarts the evidence. Every scored episode starts from a freshly created
        level-1 character. Two harness groups exist: <code>wrathbench</code>, the fixed loop that rebuilds
        the model's context every turn and trims old conversation, and <code>claude-code</code>, where the
        Claude Code CLI owns the conversation and its compaction. The group is a tag on every row, never a
        partition; claude-code rows sit in the same charts, visibly tagged. The claude-code group has no trim,
        so it gets neither the pre-trim status prompt nor the episodic log entries — a documented asymmetry.
      </p>
      {/*
        Below was a list of repository filenames under "further reading",
        moved here and rewritten on 2026-08-30: a reader who has the checkout
        does not need the pointer and a reader who does not cannot follow it.
        Every claim is `docs/METHODOLOGY.md` and `docs/EPISODES.md` in plainer
        words — nothing here that those do not say, and a change to what a
        result means is made there first.
      */}
      <p class="dim">
        <strong>An episode is one run under one ruleset.</strong> The scored default is{" "}
        <code>e90</code>: ninety minutes of play, no objective, the same prompt for every
        model. Nothing carries over between episodes, and a run that pauses is a spent attempt
        rather than a shorter episode. <strong>A tier is an evidence budget</strong>, not a
        difficulty: <code>t0</code> buys one e90, <code>t1</code> three, <code>t2</code> three plus
        one six-hour <code>e360</code>. A probe campaign is steered by a human running the benchmark
        (the operator), which is what makes it unscored — it has no ladder.
      </p>
      <p class="dim">
        <strong>Effort is a run dimension</strong>, not tuning: <code>opus (low)</code> and{" "}
        <code>opus (high)</code> are two comparable rows, stamped at launch and never recomputed.{" "}
        <strong>Cost has two bases.</strong> Where a provider reported a figure, that is the
        figure. {COST_BASIS_NOTE}, shown as an estimate.
      </p>
      <p class="dim">
        <strong>n is small on purpose.</strong> A tier buys a handful of runs, so a mark on the
        ladder is the mean of one to three episodes. The harness records signals and never a score;
        every number here is a derivation over them, recomputable over past runs. Differences inside
        that much noise are not results.
      </p>
      <p class="dim">
        <strong>The reference bundle</strong> is the agent's only out-of-game knowledge: a search
        tool over a 2020 wiki dump, stripped at build time of everything that is not patch 3.3.5,
        and frozen per harness version. Exact coordinates are withheld on scored episodes, so a
        model reads "in the inn at Goldshire" and then has to walk there and look.
      </p>

      <h2 class="section">episodes</h2>
      <p class="dim">
        The rulesets a run can be launched under, with <code>--episode &lt;id&gt;</code>. An id is a
        comparability group: two runs may only be compared if they share an id <em>and</em> a
        harness version. The id fixes the shape of the run — how long, which
        watchdogs, whether the operator may steer — and nothing about the model. The runs
        themselves are the <A href="/runs">runs</A> page; aggregates over them are the{" "}
        <A href="/ladder">ladder</A>.
      </p>

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
                <th class="right" title="stamped with the id and never overridden; the number links to the episode's ladder">
                  members
                </th>
                <th class="right" title="stamped with the id but run under different limits, so not a member of it; never on the ladder, so the number links to the runs">
                  overridden
                </th>
                <th class="right" title="stamped with the id but never a recorded episode: ended as a failed attempt, stale, cut or a harness defect">
                  lapsed
                </th>
              </tr>
            </thead>
            <tbody>
              {/* An API that answers with no episodes is a fact worth printing;
                  an empty <tbody> reads as a page that failed to render. */}
              <Show when={table().length === 0}>
                <tr>
                  <td colSpan={11} class="dim">
                    No episodes defined.
                  </td>
                </tr>
              </Show>
              <For each={table()}>
                {(t) => (
                  <tr>
                    <td>
                      <A href={ladderHref(t.id)}>{t.id}</A>
                    </td>
                    <td class="right mono">{mins(t.minutes)}</td>
                    <td class="right mono">{mins(t.idleMinutes)}</td>
                    <td class="right mono">{t.noXpMinutes === null ? "off" : mins(t.noXpMinutes)}</td>
                    <td class="right mono">{t.toolCalls === null ? "per job" : t.toolCalls}</td>
                    <td class="dim">{t.objectiveAllowed ? "allowed" : "none"}</td>
                    <td class={t.scored ? "" : "warn"}>{t.scored ? "scored" : "unscored"}</td>
                    <td class="right mono">
                      <A href={ladderHref(t.id)} title="the ladder for this episode">
                        {t.members}
                      </A>
                    </td>
                    <td class="right mono dim">
                      <Show when={t.overrides > 0} fallback={t.overrides}>
                        <A href={runsHref({ episode: t.id })} title="every run stamped with this episode, overridden ones included">
                          {t.overrides}
                        </A>
                      </Show>
                    </td>
                    <td class="right mono dim">
                      <Show when={t.lapsed > 0} fallback={t.lapsed}>
                        <A href={runsHref({ episode: t.id })} title="attempts spent on this episode that never became episodes">
                          {t.lapsed}
                        </A>
                      </Show>
                    </td>
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
                <Show when={t.overrides > 0}>
                  {" · "}
                  {t.overrides} run under different limits, so not a member of it
                </Show>
                <Show when={t.lapsed > 0}>
                  {" · "}
                  {t.lapsed} spent attempt{t.lapsed === 1 ? "" : "s"} that never became episodes
                </Show>
                <Show when={t.derived > 0}>
                  {" · "}
                  {t.derived} older run{t.derived === 1 ? "" : "s"} labeled, never enrolled
                </Show>
                {" · "}
                <A href={runsHref({ episode: t.id })}>runs</A> ·{" "}
                <A href={ladderHref(t.id)}>ladder</A>
              </p>
            </>
          )}
        </For>

        <h2 class="section">runs that belong to no episode</h2>
        <p class="dim">
          {tiers.latest!.untiered} run{tiers.latest!.untiered === 1 ? "" : "s"} carry no episode id
          and cannot be given one. They ran before the ids existed, under the watchdog defaults of
          their day, and a tuple field is never recomputed after the fact: saying nothing is more
          honest than asserting a comparability that was never established. They are in the{" "}
          <A href="/runs">runs</A> table with a blank episode.
        </p>
      </Show>

      <h2 class="section">legal</h2>
      <p class="dim">
        WrathBench is a fan-made research project and is not affiliated with or endorsed by Blizzard
        Entertainment. World of Warcraft content and materials — names, maps, and other game data shown
        here — are the intellectual property of Blizzard Entertainment, Inc. World of Warcraft, Warcraft
        and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc.
        in the U.S. and/or other countries. The game server is AzerothCore, the community open-source
        reconstruction of the 3.3.5a server, and it remains under its own GPL v2 licence.
        WrathBench's own code and documentation are MIT-licensed, except the AzerothCore module
        under <span class="mono">module/</span>, which is GPL-2.0-or-later.
      </p>
      <h2 class="section">cite</h2>
      <pre class="cite">{`@misc{beukers2026wrathbench,
  title  = {WrathBench: An Agent Workbench for World of Warcraft},
  author = {Mark Beukers},
  year   = {2026},
  url    = {https://github.com/Shard/WrathBench}
}`}</pre>
    </div>
  );
}
