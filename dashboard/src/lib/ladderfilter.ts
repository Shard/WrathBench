/**
 * What the ladder's filter button offers, and the one rule it applies by
 * default.
 *
 * Three derivations, all pure, all over the rows actually on the page so the
 * option lists cannot go stale against a roster edit:
 *
 *  - `representativeEfforts` — the default-on rule that hides the effort
 *    variants a model's own better efforts already dominate.
 *  - `lineOf` — the model *line* a slug belongs to, which is the "family" a
 *    reader means when they say sonnet, fable or astra.
 *  - `companyOf` — who serves it, which the lineup catalog does record.
 *
 * On where the two dimensions come from. `infra/model-lineup.json` is the
 * model registry, and `familyOf` reads it; its `vendor` is exactly the company
 * dimension and is used verbatim. Its `name` is *not* the family dimension —
 * the catalog's families are vendor-wide ("Claude" covers sonnet, opus, haiku
 * and fable), so filtering by one would be filtering by company twice. The
 * catalog records nothing finer, so the line is **derived from the slug**, by
 * the dumbest rule that works: drop the provider prefix, drop the free marker,
 * drop every dash-separated token carrying a digit, keep the rest. That turns
 * `claude-fable-5` into `claude-fable`, `gpt-6-astra` into `gpt-astra` and
 * `deepseek/deepseek-v4-flash-0731` into `deepseek-flash`. It is a derivation
 * and the UI says so; a slug that is all version (`qwen3.8-27b`) keeps its
 * base name rather than becoming nothing.
 */

import { familyOf } from "./lineup";
import { paretoFront } from "./pareto";

/* ------------------------------------------------------------ the two keys */

/** The slug as the derivations read it: no provider prefix, no free marker. */
function baseSlug(model: string): string {
  const id = model.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  const base = slash === -1 ? id : id.slice(slash + 1);
  for (const suffix of [":free", "-free"]) {
    if (base.endsWith(suffix)) {
      const cut = base.slice(0, -suffix.length);
      if (cut.length > 0) return cut;
    }
  }
  return base;
}

/**
 * The model line a slug belongs to — `sonnet`, `claude-fable`, `gpt-astra`.
 *
 * Derived, not looked up (see the header). Every effort variant of one line
 * answers the same string, which is what makes it a filter dimension rather
 * than a second spelling of the model column.
 */
export function lineOf(model: string | null | undefined): string {
  const base = baseSlug(model ?? "");
  if (base === "") return "(unnamed)";
  const kept = base.split("-").filter((t) => t !== "" && !/\d/.test(t));
  return kept.length === 0 ? base : kept.join("-");
}

/**
 * Who serves the model: the lineup catalog's vendor, lowercased.
 *
 * An id the catalog does not claim falls back to its provider prefix — the
 * part before the slash, which is how OpenRouter spells the same fact — and to
 * `unknown` when the slug carries neither. A bucket named after nothing is
 * still a bucket a reader can tick off.
 */
export function companyOf(model: string | null | undefined): string {
  const vendor = familyOf(model)?.vendor;
  if (vendor !== undefined) return vendor.toLowerCase();
  const id = (model ?? "").trim().toLowerCase();
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "unknown";
}

/** One tickable option: its key, and how many of the rows carry it. */
export interface FilterOption {
  key: string;
  n: number;
}

/**
 * The options a set of rows offers on one dimension, commonest first.
 *
 * Derived from the rows present rather than from the catalog, so a filter can
 * never offer a box that empties the page, and a model added to the fleet
 * appears without a code edit.
 */
export function filterOptions(
  models: readonly (string | null | undefined)[],
  keyOf: (m: string | null | undefined) => string,
): FilterOption[] {
  const counts = new Map<string, number>();
  for (const m of models) {
    const key = keyOf(m);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/**
 * Whether a model survives the two selections.
 *
 * AND across the dimensions, OR within one, and an empty selection on a
 * dimension is "no opinion" rather than "nothing" — the state the button
 * starts in has to show everything.
 */
export function matchesSelection(
  model: string | null | undefined,
  sel: { lines: readonly string[]; companies: readonly string[] },
): boolean {
  const okLine = sel.lines.length === 0 || sel.lines.includes(lineOf(model));
  const okCompany = sel.companies.length === 0 || sel.companies.includes(companyOf(model));
  return okLine && okCompany;
}

/* --------------------------------------------------- the representative rule */

/** One (model, effort) entry of the ladder, as the rule reads it. */
export interface EffortEntry {
  model: string;
  effort: string | null;
  /** Mean cost per run, in USD. */
  cost: number;
  /** Mean XP earned per run. */
  xp: number;
}

/**
 * The effort variants worth showing: each base model's own xp-vs-cost front.
 *
 * A model run at six efforts puts six marks on the scatter and six entries in
 * everything derived from it, and most of them are answers nobody is asking
 * for: an effort that earned less XP *and* cost more than the same model's
 * other effort is dominated by it, and drawing it says only that the knob
 * exists. So for a model with several effort entries, keep the ones no other
 * effort of that same model beats on both axes at once — the Pareto front
 * `lib/pareto.ts` already defines, over cost (lower better) and XP (higher
 * better), computed **within one model** and never across models.
 *
 * Two deliberate non-rules, because the point is that it hides nothing a
 * reader could not predict:
 *
 *  - a model with a single entry is untouched, whatever it cost or earned. The
 *    rule is about choosing between a model's own efforts, not about ranking
 *    models, and a lone entry has nothing to be dominated by.
 *  - ties stay. Two efforts equal on both axes dominate nothing, so both are
 *    kept — `paretoFront`'s own rule, not a second one written here.
 *
 * `null` effort is an entry like any other: a run recorded without an effort
 * is a real reading of the model, and exempting it would keep a dominated mark
 * on the chart for a reason about bookkeeping.
 *
 * The axes are fixed at cost and XP rather than following the page's view
 * selector: a set of rows that changed when a reader swapped the axes would be
 * a filter that silently means something different on every view.
 */
export function representativeEfforts<E extends EffortEntry>(rows: readonly E[]): E[] {
  const byModel = new Map<string, E[]>();
  for (const row of rows) {
    const list = byModel.get(row.model);
    if (list === undefined) byModel.set(row.model, [row]);
    else list.push(row);
  }
  const keep = new Set<E>();
  for (const list of byModel.values()) {
    if (list.length === 1) {
      keep.add(list[0]!);
      continue;
    }
    for (const m of paretoFront(
      list.map((row) => ({ x: row.cost, y: row.xp, row })),
      { x: "lower", y: "higher" },
    )) {
      keep.add(m.row);
    }
  }
  // Input order, so a caller's sort survives the filter.
  return rows.filter((row) => keep.has(row));
}
