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
import type { EpisodeIdView } from "../api/client";

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

export function EpisodePicker(props: {
  value: EpisodeChoice;
  onChange: (v: EpisodeChoice) => void;
  includeOverrides: boolean;
  onOverridesChange: (v: boolean) => void;
  /** Stillborn runs the current filter is hiding. Omit where none can be. */
  stillborn?: number;
  includeStillborn?: boolean;
  onStillbornChange?: (v: boolean) => void;
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
      <Show when={props.onStillbornChange !== undefined && (props.stillborn ?? 0) > 0}>
        <button
          class={props.includeStillborn === true ? "on" : ""}
          title="Runs that never produced a model response — a dead provider on the first request, a refused key. They never got off the ground; shown greyed."
          onClick={() => props.onStillbornChange?.(props.includeStillborn !== true)}
        >
          show stillborn ({props.stillborn})
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
  /** Stillborn runs in this tier, and whether they are currently shown. */
  stillborn?: number;
  includeStillborn?: boolean;
}) {
  return (
    <>
    <Show when={(props.stillborn ?? 0) > 0}>
      <p class="dim">
        {props.stillborn} stillborn run{props.stillborn === 1 ? "" : "s"}{" "}
        {props.includeStillborn === true ? "shown" : "hidden"}: never produced a model response, so
        the launch never happened.
      </p>
    </Show>
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
