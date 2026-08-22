/**
 * Entity id extraction.
 *
 * Wiki pages record the game's numeric ids in their infobox templates:
 *
 *   {{questbox | name=… | start=[[…]] | id=11479 | level=71 }}
 *   {{npcbox   | name=… | id=16123 | level=37 }}
 *   {{itembox  | … | itemid=49859 }}
 *
 * `stripWikitext` throws templates away, so — like coords — this runs on the
 * RAW wikitext before the strip. Without it a query for "quest 783" can only
 * be answered by matching "783" somewhere in body prose, which is how a
 * damage-formula page came back above the quest page (FOLLOW-UPS 25).
 *
 * Deterministic and best-effort: a malformed field yields nothing rather than
 * a bad row, and the same input always gives the same output. Nothing here
 * reads the server, the AzerothCore DB, DBC tables or Questie.
 */

/** The entity kinds worth distinguishing. Anything else is `"unknown"`. */
export type IdKind = "quest" | "npc" | "item" | "object" | "spell" | "unknown";

/** A numeric id the wiki page records for itself. */
export interface WikiId {
  kind: IdKind;
  id: number;
}

/** Bound the array: a page describes one entity, not a catalogue. */
const MAX_IDS_PER_PAGE = 8;

/** Ids are small integers; anything longer is a version string or a typo. */
const MAX_ID = 99_999_999;

/** `{{questbox`, `{{npcbox`, `{{Item box` … -> the kind it describes. */
const TEMPLATE_KIND: { pattern: RegExp; kind: IdKind }[] = [
  { pattern: /^(quest|questbox|questlong|questinfo)/, kind: "quest" },
  { pattern: /^(npc|mob|creature|boss)/, kind: "npc" },
  { pattern: /^(item|loot)/, kind: "item" },
  { pattern: /^(object|gameobject|node)/, kind: "object" },
  { pattern: /^(spell|ability|talent)/, kind: "spell" },
];

/** Field names that carry a kind of their own, whatever template they sit in. */
const FIELD_KIND: Record<string, IdKind> = {
  questid: "quest",
  npcid: "npc",
  mobid: "npc",
  creatureid: "npc",
  itemid: "item",
  objectid: "object",
  spellid: "spell",
};

/** `{{templatename` — the opening of a template call. */
const TEMPLATE_OPEN = /\{\{\s*([A-Za-z][A-Za-z0-9 _/-]{0,40})/g;

/**
 * `| id = 783` and its named variants. Deliberately not anchored to a line
 * start: real pages write `| name=Foo|id=16123` on one line.
 */
const ID_FIELD = /\|\s*([A-Za-z]{2,12})\s*=\s*(\d{1,9})\b/g;

/** How far past a `{{template` opening a field still counts as inside it. */
const TEMPLATE_WINDOW = 2_000;

function kindForTemplate(name: string): IdKind | undefined {
  const n = name.toLowerCase().replace(/[\s_/-]/g, "");
  for (const { pattern, kind } of TEMPLATE_KIND) {
    if (pattern.test(n)) return kind;
  }
  return undefined;
}

/**
 * The kind of the innermost enclosing infobox-ish template at `offset`, by
 * nearest preceding opening within the window. Approximate on purpose: full
 * template parsing buys nothing here, and a wrong *kind* only costs a small
 * ranking preference, never a wrong id.
 */
function enclosingKind(openings: { at: number; kind: IdKind | undefined }[], offset: number): IdKind {
  let best: IdKind | undefined;
  for (const o of openings) {
    if (o.at > offset) break;
    if (offset - o.at > TEMPLATE_WINDOW) continue;
    if (o.kind !== undefined) best = o.kind;
  }
  return best ?? "unknown";
}

/**
 * Every numeric entity id the page states about itself, in source order.
 * Deduplicated on (kind, id) and capped.
 */
export function extractIds(wikitext: string): WikiId[] {
  if (!wikitext.includes("=")) return [];
  const openings: { at: number; kind: IdKind | undefined }[] = [];
  TEMPLATE_OPEN.lastIndex = 0;
  for (let m = TEMPLATE_OPEN.exec(wikitext); m !== null; m = TEMPLATE_OPEN.exec(wikitext)) {
    openings.push({ at: m.index, kind: kindForTemplate(m[1] ?? "") });
  }

  const out: WikiId[] = [];
  const seen = new Set<string>();
  ID_FIELD.lastIndex = 0;
  for (let m = ID_FIELD.exec(wikitext); m !== null; m = ID_FIELD.exec(wikitext)) {
    if (out.length >= MAX_IDS_PER_PAGE) break;
    const field = (m[1] ?? "").toLowerCase();
    const fromField = FIELD_KIND[field];
    if (fromField === undefined && field !== "id" && field !== "entry") continue;
    const id = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isInteger(id) || id <= 0 || id > MAX_ID) continue;
    const kind = fromField ?? enclosingKind(openings, m.index);
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id });
  }
  return out;
}
