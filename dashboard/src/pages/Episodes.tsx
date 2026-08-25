/**
 * Episodes: the tiers a run can be launched under, and what each fixes.
 *
 * One page per grain (ADR-0022 amendment, ADR-0047). This page is the
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
 * reader recognises as looking like the tier; ADR-0030 is explicit that they
 * are never back-labeled into membership, because they ran under the watchdog
 * defaults of their day.
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

export default function Episodes() {
  const tiers = poll(() => api.episodes(), POLL_MS);
  const table = (): EpisodesResponse["episodes"] => tiers.latest?.episodes ?? [];

  return (
    <div class="page">
      <Show when={tiers.error !== undefined}>
        <div class="banner bad">{String(tiers.error)}</div>
      </Show>

      <h2 class="section">episodes</h2>
      <p class="dim">
        The rulesets a run can be launched under, with <code>--episode &lt;id&gt;</code>. An id is a
        comparability group: two runs may only be compared if they share an id <em>and</em> a
        harness series (ADR-0030, ADR-0034). The id fixes the shape of the run — how long, which
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
                <th class="right" title="stamped with the id but never a recorded episode: ended as a failed attempt, stale, cut or a harness defect (ADR-0049)">
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
          their day, and a tuple field is never recomputed after the fact (ADR-0026): saying nothing
          is more honest than asserting a comparability that was never established. They are in the{" "}
          <A href="/runs">runs</A> table with a blank episode.
        </p>
      </Show>
    </div>
  );
}
