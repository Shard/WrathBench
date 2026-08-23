/**
 * The episode tiers (ADR-0030), with what each one pins and how many runs sit
 * against it.
 *
 * Three counts per tier, kept apart on purpose. **Members** are runs stamped
 * with the id and given the leash the id describes — the only ones a chart may
 * compare. **Overridden** are stamped but were run on a different leash, which
 * is harness development rather than a result. **Labeled** are older runs the
 * reader recognises as looking like the tier; ADR-0030 is explicit that they are
 * never back-labeled into membership, because they ran under the watchdog
 * defaults of their day.
 *
 * The prose comes off the API rather than being written here, so the rules a
 * reader sees are the rules the runner enforces.
 */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type EpisodesResponse } from "../api/client";
import { poll } from "../lib/poll";

/** Tier definitions never move; the counts move when a run ends. */
const POLL_MS = 30_000;

function mins(m: number | null): string {
  if (m === null) return "none";
  return m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m`;
}

export default function Episodes() {
  const feed = poll(() => api.episodes(), POLL_MS);
  const tiers = (): EpisodesResponse["episodes"] => feed.latest?.episodes ?? [];

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{String(feed.error)}</div>
      </Show>

      <h2 class="section">episodes</h2>
      <p class="dim">
        The rulesets a run can be launched under, with <code>--episode &lt;id&gt;</code>. An id is a
        comparability group: two runs may only be compared if they share an id <em>and</em> a
        harness version (ADR-0030). The id fixes the shape of the run — how long, which watchdogs,
        whether the operator may steer — and nothing about the model.
      </p>

      <Show when={feed.latest !== undefined} fallback={<p class="dim">loading…</p>}>
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
              <For each={tiers()}>
                {(t) => (
                  <tr>
                    <td>
                      <A href={`/eval?episode=${t.id}`}>{t.id}</A>
                    </td>
                    <td class="right mono">{mins(t.minutes)}</td>
                    <td class="right mono">{mins(t.idleMinutes)}</td>
                    <td class="right mono">{t.noXpMinutes === null ? "off" : mins(t.noXpMinutes)}</td>
                    <td class="right mono">{t.toolCalls === null ? "per lane" : t.toolCalls}</td>
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

        <For each={tiers()}>
          {(t) => (
            <>
              <h2 class="section">{t.id}</h2>
              <p>{t.summary}</p>
              <p class="dim">
                {t.members} member run{t.members === 1 ? "" : "s"}
                <Show when={t.overrides > 0}> · {t.overrides} with an overridden leash</Show>
                <Show when={t.derived > 0}> · {t.derived} older run(s) labeled, never enrolled</Show>
                {" · "}
                <A href={`/eval?episode=${t.id}`}>eval</A> · <A href={`/ladder?episode=${t.id}`}>ladder</A>
              </p>
            </>
          )}
        </For>

        <h2 class="section">runs that belong to no tier</h2>
        <p class="dim">
          {feed.latest!.untiered} run{feed.latest!.untiered === 1 ? "" : "s"} carry no episode id and
          cannot be given one. They ran before the ids existed, under the watchdog defaults of their
          day, and a tuple field is never recomputed after the fact (ADR-0026): saying nothing is
          more honest than asserting a comparability that was never established. See them with{" "}
          <A href="/eval?episode=all">eval across all episodes</A>.
        </p>
      </Show>
    </div>
  );
}
