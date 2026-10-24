/**
 * What the ladder's filter button offers, and the one rule it applies by
 * default.
 *
 * Three derivations, all pure, all over the rows actually on the page so the
 * option lists cannot go stale against a roster edit:
 *
 *  - `representativeEfforts` — the default-on rule that hides the effort
 *    variants a model's own better efforts already dominate.
 *  - `currentModels` — the default-on rule that hides every model of a line
 *    but its newest, unless the field's front keeps it.
 *  - `lineOf` — the model *line* a slug belongs to, which is the "family" a
 *    reader means when they say sonnet, fable or astra.
 *  - `companyOf` — who makes it, which the model catalogue records.
 *  - `weightsOf` — whether its weights are published, which the catalogue
 *    records model by model (`infra/model-catalogue.ts`); `open`, `closed` or
 *    `unknown`, the last a bucket like any other so a reader can tick it off.
 *
 * On where the dimensions come from. `infra/model-catalogue.json` is the model
 * registry, and `familyOf` reads it; its family's `company` is exactly the
 * company dimension and is used verbatim. The family's `name` is *not* the
 * family dimension — the catalogue's families are vendor-wide ("Claude" covers
 * sonnet, opus, haiku and fable), so filtering by one would be filtering by
 * company twice. The line is instead **derived from the slug**, by the dumbest
 * rule that works: drop the provider prefix, drop the free marker, drop every
 * dash-separated token carrying a digit, keep the rest. That turns
 * `claude-fable-5` into `claude-fable`, `gpt-6-astra` into `gpt-astra` and
 * `deepseek/deepseek-v4-flash-0731` into `deepseek-flash`. It is a rule rather
 * than a catalogue field because it must answer the same way for an id nobody
 * has catalogued yet as for one somebody has, and the UI says it is derived; a
 * slug that is all version (`qwen3.8-27b`) keeps its base name rather than
 * becoming nothing.
 */

import { catalogueKeyOf, familyOf, weightsOf } from "../../../infra/model-catalogue";

export { weightsOf };
import type { ResultRun } from "@viewer/api-types";
import { COST, XP } from "./axes";
import { ladderPoints, pointKey, scored } from "./ladder";
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
 * Who makes the model: the catalogue family's company, lowercased.
 *
 * An id the catalogue cannot place falls back to its provider prefix — the
 * part before the slash, which is how OpenRouter spells the same fact — and to
 * `unknown` when the slug carries neither. A bucket named after nothing is
 * still a bucket a reader can tick off.
 */
export function companyOf(model: string | null | undefined): string {
  const company = familyOf(model)?.company;
  if (company !== undefined) return company.toLowerCase();
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
 * Derived from the rows present rather than from the catalogue, so a filter can
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
  sel: { lines: readonly string[]; companies: readonly string[]; weights: readonly string[] },
): boolean {
  const okLine = sel.lines.length === 0 || sel.lines.includes(lineOf(model));
  const okCompany = sel.companies.length === 0 || sel.companies.includes(companyOf(model));
  const okWeights = sel.weights.length === 0 || sel.weights.includes(weightsOf(model));
  return okLine && okCompany && okWeights;
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

/* ------------------------------------------------------ the current-models rule */

/**
 * A model id's version, as the numbers it is spelled with: `claude-opus-4-8`
 * is [4, 8], `gpt-6.1-sol` [6, 1], `deepseek-v4.1-flash` [4, 1],
 * `qwen3.8-27b` [3, 8], `claude-haiku-4-5-20251001` [4, 5]. Null for an id
 * that carries none (`deepseek-flash`, `gpt-oss-120b`, `sonnet`).
 *
 * The first dash-separated token that is a number, a dotted number, or one
 * after a name (`v4.1`, `k3.1`, `m3`, `qwen3.8`), then any one- or two-digit
 * tokens straight after it — Anthropic's ids spell 4.8 as `4-8`. A size
 * (`27b`, `a12b`) is not a version, and neither is a date (`0731`,
 * `20251001`): four digits or more ends a version and never starts one.
 */
export function modelVersion(model: string | null | undefined): number[] | null {
  const tokens = baseSlug(model ?? "").split("-");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^[a-z]*(\d+(?:\.\d+)*)$/.exec(tokens[i]!);
    if (m === null || /^\d{4,}$/.test(m[1]!)) continue;
    const version = m[1]!.split(".").map(Number);
    for (let j = i + 1; j < tokens.length && /^\d{1,2}$/.test(tokens[j]!); j++) version.push(Number(tokens[j]));
    return version;
  }
  return null;
}

/** Newer first: component by component, a missing one reading as zero (5 is 5.0, older than 5.1). */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** One roster entry as the current-models rule reads it. */
export interface ModelEntry {
  /**
   * The model the entry's runs were served: the provider's `resolvedModel`
   * where it reported one, the configured id otherwise. It is what puts the
   * CLI alias `sonnet` in the `claude-sonnet` line, as the model it ran.
   */
  served: string;
  /** When that model's first run in the field started, epoch ms: the last-resort order. */
  firstRun: number | null;
  /** Mean cost and XP per run, as the effort rule reads them; null where the entry has no reading. */
  cost: number | null;
  xp: number | null;
}

/**
 * The entries of each model line's newest model, and of any older model the
 * field has not left behind.
 *
 * The operator's rule (2026-10-24): within a line (`lineOf` the served id —
 * claude-opus-4-8 and claude-opus-5-5 are both `claude-opus`), keep only the
 * newest model, so the ladder reads one Haiku, one Sonnet, one Opus and one
 * Fable rather than every release the fleet has run. The one exception is an
 * entry on the field's cost-against-XP Pareto front: an older model nothing
 * beats on both axes is still an answer, and it stays. The front is over every
 * entry given — across lines and models, unlike `representativeEfforts`,
 * whose front is one model's — on fixed axes, so the set does not change with
 * the axes chips. An entry with no cost or no XP reading can only be kept by
 * being the newest.
 *
 * "Newest" is the version the id is spelled with (`modelVersion`): the
 * catalogue records no release dates, and the ids carry the order already.
 * Two spellings of one model (`gpt-6-luna` through codex and
 * `openai/gpt-6-luna` through OpenRouter, one entry in the catalogue) are one
 * model. A line where some model's id carries no version — a platform alias
 * such as `deepseek-flash`, a stealth name — cannot be ordered that way, and is
 * ordered by when each model first ran in the field instead. Ties keep every
 * model tied.
 *
 * Pure; the page applies it beside the effort rule, to the same set, so the
 * chart and the table agree.
 */
export function currentModels<E extends ModelEntry>(rows: readonly E[]): E[] {
  const keep = new Set<E>(
    paretoFront(
      rows.flatMap((row) => (row.cost === null || row.xp === null ? [] : [{ x: row.cost, y: row.xp, row }])),
      { x: "lower", y: "higher" },
    ).map((m) => m.row),
  );
  const identity = (row: E): string => catalogueKeyOf(row.served) ?? baseSlug(row.served);
  const byLine = new Map<string, E[]>();
  for (const row of rows) {
    const line = lineOf(row.served);
    const list = byLine.get(line);
    if (list === undefined) byLine.set(line, [row]);
    else list.push(row);
  }
  for (const list of byLine.values()) {
    const models = new Map<string, { version: number[] | null; firstRun: number }>();
    for (const row of list) {
      const id = identity(row);
      const first = row.firstRun ?? Infinity;
      const have = models.get(id);
      if (have === undefined) models.set(id, { version: modelVersion(row.served), firstRun: first });
      else have.firstRun = Math.min(have.firstRun, first);
    }
    const all = [...models.values()];
    const byVersion = all.every((m) => m.version !== null);
    const newer = (a: (typeof all)[number], b: (typeof all)[number]): number =>
      byVersion ? compareVersions(a.version!, b.version!) : a.firstRun === b.firstRun ? 0 : b.firstRun - a.firstRun;
    const newest = all.reduce((best, m) => (newer(m, best) < 0 ? m : best));
    for (const row of list) {
      if (newer(models.get(identity(row))!, newest) === 0) keep.add(row);
    }
  }
  // Input order, so a caller's sort survives the filter.
  return rows.filter((row) => keep.has(row));
}

/**
 * The rule's rows for a set of runs: one per entry (`pointKey`) of the scored
 * runs, served as its most recent run was, first run at its earliest, and cost
 * and XP as the scatter's default view means them (`ladderPoints`) where the
 * entry has both readings.
 */
export function modelEntries(runs: readonly ResultRun[]): (ModelEntry & { key: string })[] {
  const means = new Map(ladderPoints(runs, COST, XP).points.map((p) => [p.key, p]));
  const entries = new Map<string, { latest: ResultRun; firstRun: number | null }>();
  for (const r of scored(runs)) {
    const key = pointKey(r.model ?? "(unnamed)", r.effort, r.compactWindow);
    const have = entries.get(key);
    if (have === undefined) {
      entries.set(key, { latest: r, firstRun: r.startedAt });
      continue;
    }
    if ((r.startedAt ?? -Infinity) > (have.latest.startedAt ?? -Infinity)) have.latest = r;
    if (r.startedAt !== null && (have.firstRun === null || r.startedAt < have.firstRun)) have.firstRun = r.startedAt;
  }
  return [...entries].map(([key, e]) => ({
    key,
    served: e.latest.resolvedModel ?? e.latest.model ?? "(unnamed)",
    firstRun: e.firstRun,
    cost: means.get(key)?.x ?? null,
    xp: means.get(key)?.y ?? null,
  }));
}
