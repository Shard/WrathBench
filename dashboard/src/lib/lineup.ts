/**
 * Model identity: which family a model id belongs to.
 *
 * The catalog is `infra/model-lineup.json` and this is the whole of the code
 * that reads it. Matching is data-driven and dumb on purpose — lowercase the
 * id, strip a trailing `:free`, take the first family whose glob matches, file
 * order being the precedence — so recognizing a new model is a data edit and
 * never a branch in a component. An id nothing matches gets `null` here and a
 * neutral monogram in the UI; there is no per-model special case anywhere.
 *
 * A family also says, model by model, whether the weights are published
 * (`weightsOf`). That is a fact about one checkpoint, not about a line or a
 * vendor — Gemini is closed and Gemma under the same family is open — so a
 * family carries its own first-match rules rather than a single value, and an
 * id no rule names is `unknown` rather than inheriting a family default.
 *
 * Everything is total: null, undefined and nonsense all answer, none throw.
 */

import lineup from "../../../infra/model-lineup.json";

export interface LineupFamily {
  /** Stable id; also the logo asset's file name. */
  id: string;
  /** How the family is written in prose ("Claude", "GPT"). */
  name: string;
  vendor: string;
  /** The icon slug in the pinned icon package; the asset is named by `id`. */
  icon: string;
  /** The id globs that belong to this family, `*` matching any characters. */
  match: readonly string[];
  /**
   * Which of the family's models publish their weights, first match wins. The
   * value is read through `weightsOf`, which answers `unknown` for anything
   * that is not one of the three; `parseLineup` (`infra/model-logos.ts`) is
   * what refuses a family without rules or a rule with a bad value.
   */
  weights: readonly WeightsRule[];
}

/**
 * Whether a model's weights can be downloaded. `open` means a checkpoint of
 * that exact model is published; `closed` that it is served only; `unknown`
 * that nobody checked, or there was nothing to check against (a stealth id,
 * weights announced but not out).
 */
export type Weights = "open" | "closed" | "unknown";

export const WEIGHTS: readonly Weights[] = ["open", "closed", "unknown"];

/** One weights rule: the ids it covers, and the answer for them. */
export interface WeightsRule {
  match: readonly string[];
  /** `Weights`, as the JSON spells it; checked at parse and at read. */
  is: string;
  /** Where the answer was checked, when it is not obvious. */
  source?: string;
}

/** The catalog, in file order — which is the matching precedence. */
export const FAMILIES: readonly LineupFamily[] = lineup.families;

/**
 * A glob match anchored at both ends, `*` matching any run of characters.
 *
 * Written out rather than compiled to a RegExp: the patterns are catalog data,
 * and a pattern built into a regex by concatenation is one `+` in a model id
 * away from meaning something else.
 */
function globMatch(pattern: string, s: string): boolean {
  const parts = pattern.split("*");
  const first = parts[0]!;
  if (parts.length === 1) return s === first;
  const last = parts[parts.length - 1]!;
  if (!s.startsWith(first) || !s.endsWith(last)) return false;
  let at = first.length;
  const end = s.length - last.length;
  if (end < at) return false;
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (seg === "") continue;
    const found = s.indexOf(seg, at);
    if (found === -1 || found + seg.length > end) return false;
    at = found + seg.length;
  }
  return true;
}

/** The id as the catalog compares it: lowercase, trimmed, without a `:free` suffix. */
function normalize(model: string): string {
  const id = model.trim().toLowerCase();
  return id.endsWith(":free") ? id.slice(0, -":free".length) : id;
}

/** The first family whose pattern matches, or null for an id no family claims. */
export function familyOf(model: string | null | undefined): LineupFamily | null {
  if (model === null || model === undefined) return null;
  const id = normalize(model);
  if (id === "") return null;
  for (const family of FAMILIES) {
    for (const pattern of family.match) {
      if (globMatch(pattern.toLowerCase(), id)) return family;
    }
  }
  return null;
}

/**
 * Whether a model's weights are published: the first rule of its family whose
 * pattern matches, and `unknown` for an id no family claims or no rule of its
 * family names. Total, like `familyOf`.
 */
export function weightsOf(model: string | null | undefined): Weights {
  const family = familyOf(model);
  if (family === null) return "unknown";
  const id = normalize(model!);
  for (const rule of family.weights) {
    for (const pattern of rule.match) {
      if (globMatch(pattern.toLowerCase(), id)) return (WEIGHTS as readonly string[]).includes(rule.is) ? (rule.is as Weights) : "unknown";
    }
  }
  return "unknown";
}

/** The neutral fallback badge's letter: the first alphanumeric, or "?". */
export function monogramOf(model: string): string {
  for (const ch of model) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  return "?";
}

/**
 * Which of a job's models are worth an icon, at most `limit` of them.
 *
 * One icon per *family*, so a job rotating two Claude models shows one Claude
 * mark rather than the same logo twice. A list where nothing matched keeps its
 * first few ids so their monograms still say the row holds something — but the
 * moment any of them is recognised, the unmatched ones drop out: a row of
 * icons followed by the cell's own "+N" text already says there are more.
 */
export function iconModels(models: readonly string[], limit = 2): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const family = familyOf(model);
    if (family === null || seen.has(family.id)) continue;
    seen.add(family.id);
    out.push(model);
    if (out.length === limit) return out;
  }
  if (out.length > 0) return out;
  return [...new Set(models.filter((m) => m !== ""))].slice(0, limit);
}
