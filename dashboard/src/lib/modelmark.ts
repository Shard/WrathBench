/**
 * How a model is drawn when it is the row: its family's mark, or a monogram.
 *
 * Which family an id belongs to is the model catalogue's to say
 * (`infra/model-catalogue.ts`, `familyOf`), and this is only the drawing side
 * of it — no id is special-cased here, so recognising a new model is a
 * catalogue edit and never a branch in a component. An id the catalogue
 * cannot place gets a neutral monogram.
 *
 * Everything is total: null, undefined and nonsense all answer, none throw.
 */

import { familyOf } from "../../../infra/model-catalogue";

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
