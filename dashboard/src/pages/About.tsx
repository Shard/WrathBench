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
 * which is harness development rather than a result. **Lapsed** are attempts
 * stamped with the id that never became an episode: failed, stale, cut, or a
 * harness defect.
 *
 * The prose comes off the API rather than being written here, so the rules a
 * reader sees are the rules the runner enforces.
 */

import { A, useSearchParams } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type EpisodesResponse } from "../api/client";
import { displayError } from "../lib/errors";
import { useFeeds } from "../lib/feeds";
import { latestSeries } from "../lib/harness";
import { poll } from "../lib/poll";
import { REPO_URL, bibtex } from "../lib/repo";
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
  /*
   * The four lanes as a tab strip rather than four stacked blocks (operator,
   * 2026-09-18): each lane is a paragraph and a counts line, and one after
   * another they were most of the page's height for something a reader asks
   * one lane at a time.
   *
   * The chosen lane is `?lane=`, so a link can open one; it resolves against
   * the lanes the API actually served, which is what keeps a stale link on the
   * default rather than on an empty panel. The default is the scored default,
   * e90, falling back to the first lane there is.
   */
  const [params, setParams] = useSearchParams();
  const laneParam = (): string | null => {
    const raw = Array.isArray(params.lane) ? params.lane[0] : params.lane;
    return raw === undefined || raw === "" ? null : raw;
  };
  const lane = (): EpisodesResponse["episodes"][number] | undefined => {
    const rows = table();
    const want = laneParam();
    return (
      rows.find((t) => t.id === want) ?? rows.find((t) => t.id === "e90") ?? rows[0]
    );
  };
  const pickLane = (id: string): void => setParams({ lane: id }, { replace: true });
  /** Arrow keys walk the strip, as a tablist is expected to. */
  const onLaneKey = (ev: KeyboardEvent & { currentTarget: HTMLElement }): void => {
    const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    ev.preventDefault();
    const rows = table();
    const at = rows.findIndex((t) => t.id === lane()?.id);
    const next = rows[(at + step + rows.length) % rows.length];
    if (next === undefined) return;
    pickLane(next.id);
    const el = ev.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`button[data-lane="${next.id}"]`);
    el?.focus();
  };
  // The series the shell already knows about (`/api/info`, via `lib/feeds.ts`).
  // Hardcoding it here meant the status line went stale one bump after anyone
  // last read this file; `—` while the info feed is still in flight.
  const feeds = useFeeds();
  const series = (): string => latestSeries(feeds.seriesAvailable()) ?? "—";

  return (
    <div class="page prose">
      <Show when={tiers.error !== undefined}>
        <div class="banner bad">{displayError(tiers.error)}</div>
      </Show>

      {/*
        First on the page, and deliberately not an apology: an outside reader
        arriving from a link has no way to tell a running experiment from a
        finished one, and the ladder looks the same either way. The series is
        METHODOLOGY's harness-version rule; the
        0.6 reservation is the context-policy section's own note.
      */}
      <h2 class="section">project status</h2>
      <p>
        <span class="mono">status: early · harness {series()}</span>
      </p>
      <p>
        WrathBench is in early development. The basics are in, and on paper agents should be capable of
        progressing through most single-player content, but there are still many harness issues and
        improvements to make, including proper party and communication tools for freeplay and possible future
        ladder episodes. The data for some charts may be a bit off while more test runs land and the numbers
        are validated against other sources.
      </p>

      <h2 class="section">reading a result</h2>
      <p>
        A mark on the ladder is one model playing from a fresh level-1 character, same prompt,
        same tools, ninety minutes, measured on how far it got. Nothing is tuned per model: the
        harness is frozen per version and identical for every row, so a difference between two
        marks is a difference between the models.
      </p>
      <p>
        A mark is the mean of one to three runs, so two marks inside that noise are not a result.
        Rows tagged <code>claude-code</code> or <code>codex</code> ran through that vendor's own
        CLI, which manages its own context, so they are a different harness in the same chart.
      </p>
      <p>
        The model's only outside knowledge is a search over a 2020 wiki snapshot cut to patch
        3.3.5, with exact coordinates withheld on scored runs: it reads "in the inn at Goldshire"
        and has to find it.
      </p>
      <h2 class="section">episodes</h2>
      <p>
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
                  <td colSpan={10} class="dim">
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

        {/* The site's own segmented control (`.chips`), not a second one. */}
        <div class="chips" role="tablist">
          <For each={table()}>
            {(t) => (
              <button
                role="tab"
                data-lane={t.id}
                class={t.id === lane()?.id ? "on" : ""}
                aria-selected={t.id === lane()?.id}
                tabindex={t.id === lane()?.id ? 0 : -1}
                onKeyDown={onLaneKey}
                onClick={() => pickLane(t.id)}
              >
                {t.id}
              </button>
            )}
          </For>
        </div>
        <Show when={lane()}>
          {(t) => (
            <div role="tabpanel">
              <p>{t().summary}</p>
              <p class="dim">
                {t().members} member run{t().members === 1 ? "" : "s"}
                <Show when={t().overrides > 0}>
                  {" · "}
                  {t().overrides} run under different limits, so not a member of it
                </Show>
                <Show when={t().lapsed > 0}>
                  {" · "}
                  {t().lapsed} spent attempt{t().lapsed === 1 ? "" : "s"} that never became episodes
                </Show>
                {" · "}
                <A href={runsHref({ episode: t().id })}>runs</A> ·{" "}
                <A href={ladderHref(t().id)}>ladder</A>
              </p>
            </div>
          )}
        </Show>
      </Show>

      <h2 class="section">legal</h2>
      <p>
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
      {/* The `url` line only once the repo link is turned on; see lib/repo.ts. */}
      <pre class="cite">{bibtex(REPO_URL)}</pre>
    </div>
  );
}
