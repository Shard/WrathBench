/**
 * Model identity: which family a model id belongs to (ADR-0045).
 *
 * The catalog is `infra/model-lineup.json` and this is the whole of the code
 * that reads it. Matching is data-driven and dumb on purpose — lowercase the
 * id, strip a trailing `:free`, take the first family whose glob matches, file
 * order being the precedence — so recognizing a new model is a data edit and
 * never a branch in a component. An id nothing matches gets `null` here and a
 * neutral monogram in the UI; there is no per-model special case anywhere.
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
