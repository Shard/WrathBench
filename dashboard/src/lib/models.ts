/**
 * The models table's pure layer: its columns, its cells, and the one lookup
 * that lets any other page link back to a row.
 *
 * Nothing here decides anything about a model. The status, the counts, the
 * cooling deadline and the retirement reason all arrive decided from
 * `/api/models`, which serves the same projection the fleet supervisor
 * schedules on (ADR-0032). What this file does is phrase them, and phrase them
 * once, so the table and the detail panel cannot word the same fact two ways.
 */

import type { ModelEpisodeView, ModelRowView, ModelStatusView } from "@viewer/api-types";

/** The table, left to right. Status leads: it is what an operator scans for. */
export const MODEL_COLUMNS = ["status", "model", "platform", "e90", "e360", "note", "newest"] as const;

/** The tiers the page shows a counted/target cell for, in policy order. */
export const TIER_COLUMNS = ["e90", "e360"] as const;

/** A status the CSS has a badge colour for; anything else falls back to plain. */
export function statusClass(status: ModelStatusView): string {
  switch (status) {
    case "promoted":
      return "running";
    case "cooling":
      return "draining";
    case "retired":
      return "exited";
    default:
      return "";
  }
}

/** `2/3` — counted against the target, which is the only pair worth showing. */
export function countedOf(stats: ModelEpisodeView | undefined): string {
  if (stats === undefined) return "—";
  return `${stats.counted}/${stats.target}`;
}

/**
 * The one-line reason a model is not simply working through its targets.
 *
 * Retirement outranks cooling, cooling outranks a promotion note, because that
 * is the order in which they stop a run from being scheduled. `null` means the
 * row has nothing to explain, which is the common and boring case.
 */
export function noteOf(row: ModelRowView): string | null {
  if (row.retired !== undefined) return `retired — ${row.retired.reason}`;
  if (row.cooling !== undefined) {
    return `cooling rung ${row.cooling.rung} until ${new Date(row.cooling.until).toLocaleTimeString()} (${row.cooling.reason})`;
  }
  if (row.eligible.includes("e360")) return "promoted to e360";
  return null;
}

/** Whether a row has earned the long tier — the marker beside its name. */
export function isPromoted(row: ModelRowView): boolean {
  return row.eligible.includes("e360");
}

/**
 * The roster name for a run's `(model, effort)` pair, or null.
 *
 * This is the key `matchesRoster` in `runner/src/models.ts` uses, and the only
 * way a run page or an eval row can link to `/models#<name>`: a run records the
 * model string it was launched with, never the roster name that chose it. Two
 * roster entries can legitimately share the pair, in which case the first is
 * taken — a link has to go somewhere, and both rows show the same runs anyway.
 */
export function rosterNameFor(
  rows: readonly ModelRowView[],
  model: string | null,
  effort: string | null = null,
): string | null {
  if (model === null) return null;
  const hit = rows.find((r) => r.model === model && r.effort === effort);
  if (hit !== undefined) return hit.name;
  // An effort we do not have a row for still points at the model's own row,
  // which is more useful than a dead link to nowhere.
  return rows.find((r) => r.model === model)?.name ?? null;
}

/** The anchor a cross-link uses. Kept here so both callers spell it the same. */
export function modelsHref(name: string | null): string {
  return name === null ? "/models" : `/models#${encodeURIComponent(name)}`;
}
