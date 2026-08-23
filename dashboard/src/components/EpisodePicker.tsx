/**
 * The episode filter, shared by the eval and ladder pages.
 *
 * One control in one place, because the two pages must not be able to disagree
 * about what "e90" selects. `all` is offered alongside the three tiers: a run
 * that predates the tiers is labeled but is not a member of any group
 * (ADR-0030), so the default view is deliberately narrow and the reader needs
 * an obvious way out of it.
 */

import { For, Show } from "solid-js";
import { A } from "@solidjs/router";
import type { EpisodeIdView, HarnessView } from "../api/client";

export type EpisodeChoice = EpisodeIdView | "all";

export const EPISODE_CHOICES: readonly EpisodeChoice[] = ["e90", "e360", "freeplay", "all"];

/**
 * The `?episode=` search param, defaulted and validated.
 *
 * Anything unrecognised falls back to `e90` rather than being sent to the API,
 * which would answer 400 and blank the page over a typo in a shared link. The
 * chips always show what is actually selected, so the fallback is visible.
 */
export function episodeParam(raw: string | string[] | undefined): EpisodeChoice {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return EPISODE_CHOICES.includes(v as EpisodeChoice) ? (v as EpisodeChoice) : "e90";
}

export type HarnessChoice = HarnessView | "all";

export const HARNESS_CHOICES: readonly HarnessChoice[] = ["all", "wrathbench", "claude-code"];

/**
 * The `?harness=` search param (ADR-0035). Defaults to `all`: the harness is
 * a tag on every row, and the operator chose not to partition on it, so the
 * filter is an optional narrowing rather than the default view.
 */
export function harnessParam(raw: string | string[] | undefined): HarnessChoice {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return HARNESS_CHOICES.includes(v as HarnessChoice) ? (v as HarnessChoice) : "all";
}

/** A harness tag as every row shows it. Null reads as "not recorded". */
export function HarnessTag(props: { harness: string | null | undefined }) {
  return (
    <span
      class={`badge harness-${props.harness ?? "unknown"}`}
      title="which loop owned the run (ADR-0035): wrathbench is the fixed loop, claude-code the Claude Code CLI scaffold. A tag, not a partition."
    >
      {props.harness ?? "harness?"}
    </span>
  );
}

/** The optional harness filter, as chips. `all` is the default and the server's. */
export function HarnessPicker(props: { value: HarnessChoice; onChange: (v: HarnessChoice) => void }) {
  return (
    <div class="chips">
      <span class="dim" style={{ "align-self": "center" }}>harness</span>
      <For each={HARNESS_CHOICES}>
        {(id) => (
          <button class={id === props.value ? "on" : ""} onClick={() => props.onChange(id)}>
            {id}
          </button>
        )}
      </For>
    </div>
  );
}

export function EpisodePicker(props: {
  value: EpisodeChoice;
  onChange: (v: EpisodeChoice) => void;
  includeOverrides: boolean;
  onOverridesChange: (v: boolean) => void;
}) {
  return (
    <div class="chips">
      <For each={EPISODE_CHOICES}>
        {(id) => (
          <button class={id === props.value ? "on" : ""} onClick={() => props.onChange(id)}>
            {id}
          </button>
        )}
      </For>
      <Show when={props.value !== "all"}>
        <button
          class={props.includeOverrides ? "on" : ""}
          title="Include runs stamped with this tier whose watchdogs were overridden. They are not members of the tier's comparability group."
          onClick={() => props.onOverridesChange(!props.includeOverrides)}
        >
          + overridden
        </button>
      </Show>
      <span style={{ "margin-left": "auto" }} class="dim">
        <A href="/episodes">what these mean</A>
      </span>
    </div>
  );
}

/**
 * The line under a filtered chart saying what the filter removed.
 *
 * A chart that silently drops rows is a lie of omission — the same rule the
 * eval page already applies to unscorable runs, applied to the episode filter.
 */
export function EpisodeFilterNote(props: {
  episode: EpisodeChoice;
  filteredOut: number;
  overridesExcluded: number;
}) {
  return (
    <>
    <Show when={props.filteredOut > 0}>
      <p class="dim">
        {props.filteredOut} run{props.filteredOut === 1 ? "" : "s"} not shown: not a member of{" "}
        {props.episode === "all" ? "any tier" : props.episode}
        <Show when={props.overridesExcluded > 0}>
          {" "}
          — {props.overridesExcluded} of them stamped {props.episode} but with an overridden leash
        </Show>
        .
      </p>
    </Show>
    </>
  );
}
