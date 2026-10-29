/**
 * The benchmark's own signals off the sandbox child: the death and flight
 * transitions and the turn's event window, latched in the child by the
 * runner's child extension (`child-extension.ts`) and drained by the runner's
 * `SandboxHost` (`host.ts`). The generic channel they ride is
 * `@wrathbench/mcp`'s sandbox IPC; these are the shapes this harness puts on it.
 */

import type { EventSummary } from "@wrathbench/mcp";

/**
 * A death-window transition the child latched the moment the event carrying it
 * arrived, rather than the moment the host next sampled.
 *
 * The host samples every `stateIntervalMs` (60s in the fleet); an entire death,
 * release and spirit-healer resurrection fits inside 30 seconds, so the sampled
 * window read misses whole deaths (run
 * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2`: three deaths, none
 * recorded). The child sees every event, so the transition is latched there and
 * drained from here; `ts` is the event's own timestamp, which is when the thing
 * happened.
 */
export interface DeathSignal {
  kind: "death" | "release" | "resurrect";
  /** The timestamp of the event that carried the transition. */
  ts: number;
  /** That event's stream seq, for correlation with the event log. */
  seq: number;
  /** Death only: the corpse as the cache held it at that instant; absent when only its dungeon's entrance was known. */
  position?: { map: number; x: number; y: number; z: number; source: "corpse_query" | "death_spot" };
  /** Release only: the graveyard the spirit was released to. */
  graveyard?: { map: number; x: number; y: number; z: number };
  /** Death only: the zone/area ids at the moment of death. */
  zone?: number;
  area?: number;
  /** Death only: the ghost flag as it read at that instant (usually false). */
  released?: boolean;
}

/**
 * A flight transition the child latched the moment the event carrying it
 * arrived, for the same reason `DeathSignal` exists: the host samples every
 * 60s, two legs of a chain can both land inside one sample, and the area a
 * landing is written with must be the landing's, not the sample's (a landing
 * read a minute late once placed the character in the Deeprun Tram it had
 * since walked into). `taxi` is the flag turning on after an accepted reply;
 * `taxi_landed` is it turning off. Both carry the position and zone/area ids
 * as the cache held them at that instant.
 */
export interface FlightSignal {
  kind: "taxi" | "taxi_landed";
  /** The timestamp of the event that carried the transition. */
  ts: number;
  /** That event's stream seq, for correlation with the event log. */
  seq: number;
  position?: { map: number; x: number; y: number; z: number };
  zone?: number;
  area?: number;
}

/**
 * The events a turn's context is built from: the last N events that are not
 * ambient movement (`CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE`) nor a bystander's
 * spell combat-log line or emote (`spellLogShown`, `emoteShown`, not counted
 * as ambient), oldest first, and
 * how many ambient events arrived in the span they cover — from the oldest
 * one returned to now, or since the child started when every non-ambient
 * event it has seen is in the list.
 */
export interface ContextEvents {
  events: EventSummary[];
  folded: number;
}
