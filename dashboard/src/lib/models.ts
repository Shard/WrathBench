/**
 * The models table's pure layer: its columns, its cells, and the one lookup
 * that lets any other page link back to a row.
 *
 * Nothing here decides anything about a model. The status, the counts, the
 * cooling deadline and the retirement reason all arrive decided from
 * `/api/models`, which serves the same projection the fleet supervisor
 * schedules on. What this file does is phrase them, and phrase them once, so
 * the table and the detail panel cannot word the same fact two ways.
 */

import type { ModelEpisodeView, ModelRowView, ModelStatusView, TierView } from "@viewer/api-types";
import type { CharacterRow } from "./ladder";

/**
 * The table, left to right, as the header prints it — these are labels, not
 * keys, the way `FLEET_COLUMNS` is. The page renders its header from this
 * array, so the header and the body cells cannot number their columns
 * differently.
 *
 * Status leads because it is what an operator scans for, and the tier follows
 * the name because it is the second question asked of a row. Billing is not a
 * column: it says only where a run may execute, which is the platform's
 * business, and the tier is what buys runs.
 *
 * On the word "tier": it means a rung of the EVIDENCE ladder (t0/t1/t2),
 * never an episode. The episode columns are named by their ids.
 */
export const MODEL_COLUMNS = ["status", "model", "tier", "platform", "harness", "e90", "e360", "freeplay", "extras", "note", "newest run"] as const;

/** The episodes the page shows a counted/target cell for, in policy order. */
export const EPISODE_COLUMNS = ["e90", "e360"] as const;

/** Numbers are right-aligned; the header has to say so too, or it drifts off its column. */
export function columnClass(column: (typeof MODEL_COLUMNS)[number]): string {
  return column === "extras" || (EPISODE_COLUMNS as readonly string[]).includes(column) ? "right" : "";
}

/** The ladder's order, so "higher" is a comparison rather than a string sort. */
const TIER_RANK: Record<TierView, number> = { t0: 0, t1: 1, t2: 2 };

/**
 * The highest tier this model has actually stood on.
 *
 * Today the server derives `tier` from `declaredTier` advanced at most once, so
 * this is usually just `tier` — but "usually" is not a contract, and a config
 * edit that lowers a model's declared tier must not make the page report that
 * it un-climbed. A max over both is the honest reading either way.
 *
 * What it is not: a tier the model could reach. `earnedRung1` is a rung, not a
 * tier, and a witness the model has not been allowed to spend buys it nothing.
 */
export function highestTierOf(row: Pick<ModelRowView, "tier" | "declaredTier">): TierView {
  return TIER_RANK[row.declaredTier] > TIER_RANK[row.tier] ? row.declaredTier : row.tier;
}

/**
 * The table's order: the highest tier first, then the name.
 *
 * Tier is the budget, so tier-descending puts the models the fleet spends most
 * on at the top and leaves the t0 long tail below — the order an operator reads
 * the roster in. The name breaks ties so the table is stable across polls
 * rather than reshuffling every 30 seconds on the server's iteration order.
 */
export function compareModelRows(a: ModelRowView, b: ModelRowView): number {
  const byTier = TIER_RANK[highestTierOf(b)] - TIER_RANK[highestTierOf(a)];
  return byTier !== 0 ? byTier : a.name.localeCompare(b.name);
}

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

/**
 * Extras across every episode: attempts the policy made past the target, never
 * counted. Not just the tier columns — a local model's extras are freeplay
 * runs, and they belong in the same number.
 */
export function extrasOf(row: ModelRowView): number {
  return Object.values(row.perEpisode).reduce((n, st) => n + (st?.extras ?? 0), 0);
}

/**
 * `yes: schedulable on e90` / `no: running (one character per model)` — the verdict
 * as --status prints it. The extras cell's hover, not a column: it is scheduler
 * state, and a reader who wants it is already looking at what has been spent.
 */
export function schedulableOf(row: ModelRowView): string {
  return `${row.schedulable.ok ? "yes" : "no"}: ${row.schedulable.why}`;
}

/**
 * Whether the ladder actually moved this model — the marker beside its name.
 * Not "is it eligible for e360": a model an operator placed on t2 by hand is
 * eligible without having earned anything, and must not wear the badge. A rank
 * comparison, the same one `highestTierOf` uses, so a declared tier lowered by
 * a config edit cannot read as a climb.
 */
export function isPromoted(row: Pick<ModelRowView, "tier" | "declaredTier">): boolean {
  return TIER_RANK[row.tier] > TIER_RANK[row.declaredTier];
}

/**
 * The tier cell: the highest tier the model has reached, and nothing else —
 * the climb itself moved to the hover, and the ↑ beside the name still marks a
 * row that moved.
 *
 * The `*` stays: a held witness (`t0*`) is a trial model that has earned a
 * promotion its tier will not let it spend, which is exactly the row an operator
 * scans for when deciding what to promote. It is a promotion, not a second tier. A model that
 * is both promoted and holding an unspent witness (declared t2, scheduled back
 * to t1, `earnedRung1`) shows the star: the witness is still true of it.
 */
export function tierOf(row: ModelRowView): string {
  const tier = highestTierOf(row);
  return row.earnedRung1 && !isPromoted(row) ? `${tier}*` : tier;
}

/** The tier cell's hover: what the model was admitted to, and what it earned. */
export function tierTitle(row: ModelRowView): string {
  const budget = (t: string): string => `tier ${t}`;
  const earned = row.earnedRung1
    ? "earned promotion (a counted e90 reached the promotion level)"
    : "has not earned promotion";
  if (isPromoted(row)) return `${budget(row.declaredTier)} in the config, climbed to ${row.tier} — ${earned}`;
  // The mirror case: a config edit lowered the declared tier below where the
  // model is scheduled. The `*` still reads the highest tier reached, so the
  // hover has to say the same thing rather than naming the lower one.
  if (TIER_RANK[row.declaredTier] > TIER_RANK[row.tier]) {
    return `${budget(row.declaredTier)} in the config, scheduled on ${row.tier} — ${earned}`;
  }
  if (row.earnedRung1) return `${budget(row.tier)} — ${earned}, but this tier holds the ladder: move it up to spend that`;
  return `${budget(row.tier)} — ${earned}`;
}

/**
 * The roster name for a run's `(model, effort)` pair, or null.
 *
 * This is the key `matchesRoster` in `runner/src/models.ts` uses, and the only
 * way a run page or a runs-table row can link to `/models#<name>`: a run records
 * the model string it was launched with, never the roster name that chose it. Two
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

/**
 * What a row should say about the ids its runs actually resolved to.
 *
 * A row is keyed on the model *string* — the roster's, or the one the run
 * recorded — and that string can be an alias the CLI resolves at launch. Null
 * when there is nothing to add: no run recorded an id, or the only id is the
 * string already printed. `mixed` is the case worth flagging: one key whose
 * runs were not all on the same model, which is drift a reader must see rather
 * than a difference two rows quietly average together.
 */
export function resolvedSummary(
  model: string | null,
  ids: readonly string[] | undefined,
): { ids: string[]; mixed: boolean } | null {
  const seen = [...new Set((ids ?? []).filter((id) => id.length > 0))].sort();
  if (seen.length === 0) return null;
  if (seen.length === 1 && seen[0] === model) return null;
  return { ids: seen, mixed: seen.length > 1 };
}

/**
 * The model's freeplay character, for the column beside its scored episodes.
 *
 * Freeplay is one character per model and effort (docs/OPERATIONS.md, "Freeplay
 * characters are durable"), so the match is on those two fields and the row is the
 * ladder's own `CharacterRow` — the same status and level the freeplay ladder
 * prints, so the two pages cannot disagree about whether a character is live.
 * Null when the model has never had one.
 */
export function freeplayOf(
  row: Pick<ModelRowView, "model" | "effort">,
  characters: readonly CharacterRow[],
): CharacterRow | null {
  return characters.find((s) => s.model === row.model && s.effort === row.effort) ?? null;
}

/** `live · L15` as the cell reads it; the hover carries the reason. */
export function freeplayLabel(s: CharacterRow): string {
  return s.level === null ? s.status : `${s.status} · L${s.level}`;
}
