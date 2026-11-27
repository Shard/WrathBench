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

import type { ModelEpisodeView, ModelRowView, ModelRunView, ModelStatusView, TierView } from "@viewer/api-types-runner";
import { fmtCost, listCost } from "./format";
import type { CharacterRow } from "./ladder";
import { AUTO_WINDOW } from "./runs";
import { canonicalModelId } from "../../../infra/model-catalogue";

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
 * On the word "tier": it means a rung of the EVIDENCE ladder (t0 to t3),
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
const TIER_RANK: Record<TierView, number> = { t0: 0, t1: 1, t2: 2, t3: 3 };

/**
 * The highest tier this model has actually stood on.
 *
 * Today the server derives `tier` from `declaredTier` advanced at most once, so
 * this is usually just `tier` — but "usually" is not a contract, and a config
 * edit that lowers a model's declared tier must not make the page report that
 * it un-climbed. A max over both is the honest reading either way.
 *
 * What it is not: a tier the model could reach. `earnedPromotion` is a witness,
 * not a tier, and a witness the model has not been allowed to spend buys it nothing.
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

/** One row of the table: a model, as its first entry in table order, and its other entries. */
export interface ModelTableRow {
  /** The first entry's row, with the runs and the last error of every entry of the model. */
  row: ModelRowView;
  /** The model's other entries (`ModelRowView.siblings`): the same model on another provider. */
  also: ModelRowView[];
}

/**
 * The table's rows, one per model (operator, 2026-11-16): an entry's
 * siblings fold into the row of the first of them in table order
 * (`compareModelRows`), which keeps its own cells. Its counts are already the
 * model's, so its run list is too: every entry's runs, newest first. An entry
 * alone on its model is a row as before.
 */
export function modelTableRows(rows: readonly ModelRowView[]): ModelTableRow[] {
  const sorted = [...rows].sort(compareModelRows);
  const byName = new Map(sorted.map((r) => [r.name, r]));
  const taken = new Set<string>();
  const out: ModelTableRow[] = [];
  for (const r of sorted) {
    if (taken.has(r.name)) continue;
    taken.add(r.name);
    const also = (r.siblings ?? []).flatMap((n) => {
      const sib = byName.get(n);
      return sib === undefined || taken.has(n) ? [] : [sib];
    });
    for (const a of also) taken.add(a.name);
    if (also.length === 0) {
      out.push({ row: r, also });
      continue;
    }
    const all = [r, ...also];
    const runs = all.flatMap((x) => x.runs).sort((a, b) => b.startedAt - a.startedAt);
    const lastError = all.map((x) => x.lastError).reduce((a, b) => (b !== null && (a === null || (b.at ?? 0) > (a.at ?? 0)) ? b : a), null);
    out.push({ row: { ...r, runs, newestRunId: runs[0]?.runId ?? r.newestRunId, lastError }, also });
  }
  return out;
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
 * The `*` stays: a held witness (`holdsWitness`) is a pinned model that has
 * earned the next rung its tier will not let it climb, which is exactly the row
 * an operator scans for when deciding what to move up. It is a promotion, not a
 * second tier. The public build has no `earnedDeadmines`, so a `t2*` is the
 * operator's page's alone.
 */
export function tierOf(row: ModelRowView): string {
  const tier = highestTierOf(row);
  return holdsWitness(row) && !isPromoted(row) ? `${tier}*` : tier;
}

/**
 * Whether a model holds the witness that would move it up the ladder were its
 * declared tier not where an operator put it (operator, 2026-11-20): a `t0` with
 * a counted level-5 e90, a declared `t2` with a counted level-8 e360. Never a
 * `t1`, which climbs on its own, nor a `t3`, the top. Mirrors `holdsWitness` in
 * runner/src/models.ts.
 */
export function holdsWitness(row: Pick<ModelRowView, "declaredTier" | "earnedPromotion" | "earnedDeadmines">): boolean {
  if (row.declaredTier === "t0") return row.earnedPromotion;
  if (row.declaredTier === "t2") return row.earnedDeadmines === true;
  return false;
}

/** The tier cell's hover: what the model was admitted to, and what it earned. */
export function tierTitle(row: ModelRowView): string {
  const budget = (t: string): string => `tier ${t}`;
  const earned = row.earnedPromotion
    ? "earned promotion (a counted e90 reached the promotion level)"
    : "has not earned promotion";
  if (isPromoted(row)) return `${budget(row.declaredTier)} in the config, climbed to ${row.tier} — ${earned}`;
  // The mirror case: a config edit lowered the declared tier below where the
  // model is scheduled. The `*` still reads the highest tier reached, so the
  // hover has to say the same thing rather than naming the lower one.
  if (TIER_RANK[row.declaredTier] > TIER_RANK[row.tier]) {
    return `${budget(row.declaredTier)} in the config, scheduled on ${row.tier} — ${earned}`;
  }
  if (holdsWitness(row) && row.declaredTier === "t2") return `${budget(row.tier)} — has earned the Deadmines (a counted e360 reached the Deadmines level); move it to t3 to run them`;
  if (holdsWitness(row)) return `${budget(row.tier)} — ${earned}, but this tier holds the ladder: move it up to spend that`;
  return `${budget(row.tier)} — ${earned}`;
}

/**
 * The anchor a cross-link uses. Kept here so every caller spells it the same;
 * the run page's name comes off its detail (`rosterName`, matched server-side).
 */
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
  // Two providers' spellings of one model are one id (`canonicalModelId`,
  // operator 2026-11-16): never drift, and never news beside the row's own.
  const byModel = new Map<string, string>();
  for (const id of [...new Set((ids ?? []).filter((id) => id.length > 0))].sort()) {
    const key = canonicalModelId(id);
    if (!byModel.has(key)) byModel.set(key, id);
  }
  const seen = [...byModel.values()];
  if (seen.length === 0) return null;
  if (seen.length === 1 && model !== null && (seen[0] === model || canonicalModelId(seen[0]!) === canonicalModelId(model))) return null;
  return { ids: seen, mixed: seen.length > 1 };
}

/**
 * The model's freeplay character, for the column beside its scored episodes.
 *
 * Freeplay is one character per model and effort (docs/RUNBOOK.md, "Freeplay
 * characters are durable"), so the match is on those two fields and the row is the
 * ladder's own `CharacterRow` — the same status and level the freeplay ladder
 * prints, so the two pages cannot disagree about whether a character is live.
 * The character's window is its newest session's, which is any the row owns
 * (`windowsOf`). Null when the model has never had one.
 */
export function freeplayOf(
  row: Pick<ModelRowView, "model" | "effort" | "compactWindow" | "windows">,
  characters: readonly CharacterRow[],
): CharacterRow | null {
  const windows = windowsOf(row);
  return (
    characters.find(
      (s) => s.model === row.model && s.effort === row.effort && windows.includes(s.compactWindow ?? AUTO_WINDOW),
    ) ?? null
  );
}

/**
 * The windows of the runs a row owns, `auto` naming the CLI's own: the
 * server's list (`ModelRowView.windows`), or the row's declared window alone
 * on a snapshot from before it.
 */
export function windowsOf(row: Pick<ModelRowView, "compactWindow" | "windows">): string[] {
  return row.windows ?? [row.compactWindow ?? AUTO_WINDOW];
}

/**
 * The `compactWindow` a link to a row's runs carries (`runsHref`): null for a
 * row whose runs are the CLI's `auto` alone, which is how the filter reads an
 * absent window, and the list otherwise.
 */
export function windowParam(row: Pick<ModelRowView, "compactWindow" | "windows">): string | null {
  const windows = windowsOf(row);
  return windows.length === 1 && windows[0] === AUTO_WINDOW ? null : windows.join(",");
}

/**
 * A run's cost cell in a model's panel: the provider's charge, else the
 * list-price estimate (operator, 2026-11-18). The panel spells each figure out
 * with `fmtCost` ("$1.20 reported", "~$0.80 as-if-metered (list price,
 * 2026-11)"), and a figure nobody was charged wears the runs table's tilde and
 * hover (`listCost`): the list-price estimate and a claude-code run's own
 * as-if-metered figure alike.
 */
export function modelRunCost(r: Pick<ModelRunView, "cost">): { text: string; title: string } {
  const c = listCost(r.cost?.actual, r.cost?.expected, "provider reports no cost for this run");
  if (c.figure === null) return { text: "—", title: c.title };
  const spelled = fmtCost({ ...c.figure, asIfMetered: c.figure.asIfMetered === true, asOf: c.figure.asOf ?? null }, "—");
  // The tilde every listing puts on a figure nobody was charged.
  return { text: c.estimate ? `~${spelled}` : spelled, title: c.title };
}
