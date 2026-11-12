/**
 * The benchmark's own signal off the sandbox child: the turn's event window,
 * latched in the child by the runner's child extension (`child-extension.ts`)
 * and asked for by the runner's `SandboxHost` (`host.ts`). The death, flight
 * and party transitions are the stack's now (`@wrathbench/mcp/record`), part
 * of the session record it writes.
 */

import type { EventSummary } from "@wrathbench/mcp";

export type { DeathSignal, FlightSignal, PartySignal } from "@wrathbench/mcp/record";

/**
 * The events a turn's context is built from: the last N events that are not
 * ambient (`isAmbientEvent` in context.ts) nor a bystander's
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
