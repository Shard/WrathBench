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

/**
 * The table, left to right. Status leads: it is what an operator scans for.
 * The same columns `run-fleet --status` prints — billing, the tier, status, the
 * episodes, extras, the verdict — plus where the model is served and its
 * newest run.
 *
 * On the word "tier": since ADR-0040 it means a rung of the EVIDENCE ladder
 * (t0/t1/t2), never an episode. The episode columns are named by their ids.
 */
export const MODEL_COLUMNS = ["status", "model", "billing", "tier", "platform", "harness", "e90", "e360", "extras", "schedulable", "note", "newest"] as const;

/** The episodes the page shows a counted/target cell for, in policy order. */
export const EPISODE_COLUMNS = ["e90", "e360"] as const;

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
 * counted. Not just the tier columns — a local model's extras are freeplay runs
 * (ADR-0034), and they belong in the same number.
 */
export function extrasOf(row: ModelRowView): number {
  return Object.values(row.perEpisode).reduce((n, st) => n + (st?.extras ?? 0), 0);
}

/** `yes: schedulable on e90` / `no: running (one stream per model)` — the verdict as --status prints it. */
export function schedulableOf(row: ModelRowView): string {
  return `${row.schedulable.ok ? "yes" : "no"}: ${row.schedulable.why}`;
}

/**
 * Whether the ladder actually moved this model — the marker beside its name.
 * Not "is it eligible for e360": a model an operator placed on t2 by hand is
 * eligible without having earned anything, and must not wear the badge.
 */
export function isPromoted(row: ModelRowView): boolean {
  return row.tier !== row.declaredTier;
}

/**
 * The tier cell: a climb as the move it was, a held witness as `t0*`. A trial
 * model that has earned its rung is exactly the row an operator scans for when
 * deciding what to promote, so it gets a mark of its own rather than hiding
 * behind a status word it is not allowed to have.
 */
export function tierOf(row: ModelRowView): string {
  if (row.tier !== row.declaredTier) return `${row.declaredTier}→${row.tier}`;
  return row.earnedRung1 ? `${row.tier}*` : row.tier;
}

/** The tier cell's hover: what the model was admitted to, and what it earned. */
export function tierTitle(row: ModelRowView): string {
  const budget = (t: string): string => `tier ${t}`;
  const earned = row.earnedRung1 ? "earned rung 1 (a counted e90 reached the promotion level)" : "has not earned rung 1";
  if (row.tier !== row.declaredTier) return `${budget(row.declaredTier)} in the config, climbed to ${row.tier} — ${earned}`;
  if (row.earnedRung1) return `${budget(row.tier)} — ${earned}, but this tier holds the ladder: move it up to spend that`;
  return `${budget(row.tier)} — ${earned}`;
}

/**
 * The roster name for a run's `(model, effort)` pair, or null.
 *
 * This is the key `matchesRoster` in `runner/src/models.ts` uses, and the only
 * way a run page or an results row can link to `/models#<name>`: a run records the
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

/**
 * The query every cross-page run filter is spelled with.
 *
 * One builder, because the pages that link to each other must not disagree
 * about what "this row's runs" means. `effort` travels with `model` and is not
 * optional in spirit: `(model, effort)` is the pair the projection matches runs
 * on (`matchesRoster` in `runner/src/models.ts`), so a link from a `sonnet-low`
 * row that dropped it would show `sonnet`'s runs too. Absent effort is its own
 * value — the entry with no effort — never "any effort".
 *
 * `harness` and `episode` are omitted at their server defaults, so a link is
 * the shortest URL that means what it says.
 */
export function runFilterQuery(f: {
  model?: string | null;
  effort?: string | null;
  episode?: string | null;
  harness?: string | null;
}): string {
  const q = new URLSearchParams();
  if (f.episode != null && f.episode !== "") q.set("episode", f.episode);
  if (f.model != null && f.model !== "") q.set("model", f.model);
  if (f.effort != null && f.effort !== "") q.set("effort", f.effort);
  if (f.harness != null && f.harness !== "" && f.harness !== "all") q.set("harness", f.harness);
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
}

/** The aggregate view, filtered. */
export function resultsHref(f: Parameters<typeof runFilterQuery>[0]): string {
  return `/results${runFilterQuery(f)}`;
}

/**
 * The per-run view, filtered — the drill-down under an aggregate row.
 *
 * The episodes page is the per-run grain (ADR-0022 amendment), so "show me the
 * runs behind this number" is a link there rather than an expander here.
 */
export function episodesHref(f: Parameters<typeof runFilterQuery>[0]): string {
  return `/episodes${runFilterQuery(f)}`;
}
