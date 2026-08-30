/**
 * About: the meta page — the episode tiers a run can be launched under, the
 * two harness groups, and how to read a score. Renamed from Episodes on
 * 2026-08-30 (`/episodes` redirects here); the homepage is the explainer for
 * a newcomer, this is the page for someone who wants to know what a row means.
 *
 * One page per grain. The tier half of this page is the
 * *episodes* — the rulesets, how many runs sit against each and how they came
 * to (members, overridden, labeled), and a link to those runs. It lists no
 * runs of its own: a tier's id and its member count link to the ladder for
 * that tier — the members are exactly what the ladder compares — and the
 * overridden count, which the ladder has no view of, links to the runs table.
 *
 * Three counts per tier, kept apart on purpose. **Members** are runs stamped
 * with the id and given the leash the id describes — the only ones a chart may
 * compare. **Overridden** are stamped but were run on a different leash, which
 * is harness development rather than a result. **Labeled** are older runs the
 * reader recognises as looking like the tier; they are never back-labeled
 * into membership, because they ran under the watchdog defaults of their
 * day.
 *
 * The prose comes off the API rather than being written here, so the rules a
 * reader sees are the rules the runner enforces.
 */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type EpisodesResponse } from "../api/client";
import { poll } from "../lib/poll";
import { runsHref } from "../lib/runs";

/** The ladder for one tier — the page a tier's member count leads to. */
function ladderHref(id: string): string {
  return `/ladder?episode=${encodeURIComponent(id)}`;
}

/** Tier definitions never move; the counts move when a run ends. */
const POLL_MS = 30_000;

function mins(m: number | null): string {
  if (m === null) return "none";
  return m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m`;
}

export default function About() {
  const tiers = poll(() => api.episodes(), POLL_MS);
  const table = (): EpisodesResponse["episodes"] => tiers.latest?.episodes ?? [];

  return (
    <div class="page">
      <Show when={tiers.error !== undefined}>
        <div class="banner bad">{String(tiers.error)}</div>
      </Show>

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

      <h2 class="section">episodes</h2>
      <p class="dim">
        The rulesets a run can be launched under, with <code>--episode &lt;id&gt;</code>. An id is a
        comparability group: two runs may only be compared if they share an id <em>and</em> a
        harness series. The id fixes the shape of the run — how long, which
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
                <th class="right" title="stamped with the id and never overridden; the number links to the tier's ladder">
                  members
                </th>
                <th class="right" title="stamped with the id but run on another leash; never on the ladder, so the number links to the runs">
                  overridden
                </th>
                <th class="right" title="stamped with the id but never a recorded episode: ended as a failed attempt, stale, cut or a harness defect">
                  lapsed
                </th>
                <th class="right">labeled</th>
              </tr>
            </thead>
            <tbody>
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
                      <A href={ladderHref(t.id)} title="the ladder for this tier">
                        {t.members}
                      </A>
                    </td>
                    <td class="right mono dim">
                      <Show when={t.overrides > 0} fallback={t.overrides}>
                        <A href={runsHref({ episode: t.id })} title="every run stamped with this tier, overridden ones included">
                          {t.overrides}
                        </A>
                      </Show>
                    </td>
                    <td class="right mono dim">
                      <Show when={t.lapsed > 0} fallback={t.lapsed}>
                        <A href={runsHref({ episode: t.id })} title="attempts spent on this tier that never became episodes">
                          {t.lapsed}
                        </A>
                      </Show>
                    </td>
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
                <Show when={t.lapsed > 0}> · {t.lapsed} spent attempt(s) that never became episodes</Show>
                <Show when={t.derived > 0}> · {t.derived} older run(s) labeled, never enrolled</Show>
                {" · "}
                <A href={runsHref({ episode: t.id })}>runs</A> ·{" "}
                <A href={ladderHref(t.id)}>ladder</A>
              </p>
            </>
          )}
        </For>

        <h2 class="section">runs that belong to no tier</h2>
        <p class="dim">
          {tiers.latest!.untiered} run{tiers.latest!.untiered === 1 ? "" : "s"} carry no episode id
          and cannot be given one. They ran before the ids existed, under the watchdog defaults of
          their day, and a tuple field is never recomputed after the fact: saying nothing is more
          honest than asserting a comparability that was never established. They are in the{" "}
          <A href="/runs">runs</A> table with a blank episode.
        </p>
      </Show>

      <h2 class="section">further reading</h2>
      <p class="dim">
        The decisions behind all of this, and what a result may and may not be read as, are in the
        repository's <code>docs/METHODOLOGY.md</code>; what the agent may see and do is{" "}
        <code>docs/CONTRACTS.md</code>; the structure is <code>docs/ARCHITECTURE.md</code>. The{" "}
        <A href="/">homepage</A> is the short version.
      </p>
      <h2 class="section">legal</h2>
      <p class="dim">
        WrathBench is a fan-made research project and is not affiliated with or endorsed by Blizzard
        Entertainment. World of Warcraft content and materials — names, maps, and other game data shown
        here — are the intellectual property of Blizzard Entertainment, Inc. World of Warcraft, Warcraft
        and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc.
        in the U.S. and/or other countries. The game server is AzerothCore, the community open-source
        reconstruction of the 3.3.5a server; WrathBench's own code and documentation are MIT-licensed.
      </p>
    </div>
  );
}
