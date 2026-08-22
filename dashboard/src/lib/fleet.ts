/**
 * The lane table's pure layer: its columns, and what each derived cell says.
 *
 * The component renders its header from `FLEET_COLUMNS` rather than from a
 * hand-written `<thead>`, so the order tested here is the order shipped. The
 * rest is the same reason the run rows keep their maths in `format.ts` — the
 * tests cover the pure layer, not a DOM harness (see dashboard/README.md).
 */

import type { FleetLaneView } from "@viewer/api-types";

/** The lane table, left to right. State leads: it is what an operator scans for. */
export const FLEET_COLUMNS = ["state", "lane", "model", "account", "spawned", "exit"] as const;

export type LaneState = "exited" | "draining" | "running" | "idle";

/**
 * What a lane is doing, from what the supervisor published plus the run we
 * resolved for it. "idle" is a live lane between episodes — its account is
 * free — and is a different thing from a lane whose process is gone.
 */
export function laneState(lane: FleetLaneView): LaneState {
  if (lane.alive === false) return "exited";
  if (lane.draining) return "draining";
  return lane.runId === null ? "idle" : "running";
}

/** Only a lane holding a run has somewhere to click through to. */
export function laneRunHref(lane: FleetLaneView): string | null {
  return lane.runId === null ? null : `/run/${encodeURIComponent(lane.runId)}`;
}

/** How many roster models an idle lane names before the rest become a count. */
const ROSTER_SHOWN = 2;

/**
 * The model cell: what the lane is running, or — when it holds nothing — what
 * its roster will work through. Long rosters are truncated rather than wrapped;
 * the full list goes in the cell's title.
 */
export function laneModelLabel(lane: FleetLaneView): string {
  if (lane.model !== null) return lane.model;
  const roster = lane.rosterModels;
  if (roster.length === 0) return "—";
  if (roster.length <= ROSTER_SHOWN) return roster.join(", ");
  return `${roster.slice(0, ROSTER_SHOWN).join(", ")} +${roster.length - ROSTER_SHOWN}`;
}

/** The hover text behind that cell: the run id when there is one, else the roster. */
export function laneModelTitle(lane: FleetLaneView): string {
  return lane.runId !== null ? lane.runId : lane.rosterModels.join(", ");
}
