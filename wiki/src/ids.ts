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

/** `{{templatename` — the opening of a template call, with its name. */
const TEMPLATE_OPEN = /\{\{\s*([A-Za-z][A-Za-z0-9 _/-]{0,40})?/g;

/** Brace events: every `{{` and `}}` in source order. */
const BRACE = /\{\{|\}\}/g;

/**
 * `| id = 783` and its named variants. Deliberately not anchored to a line
 * start: real pages write `| name=Foo|id=16123` on one line.
 */
const ID_FIELD = /\|\s*([A-Za-z]{2,12})\s*=\s*(\d{1,9})\b/g;

function kindForTemplate(name: string): IdKind | undefined {
  const n = name.toLowerCase().replace(/[\s_/-]/g, "");
  for (const { pattern, kind } of TEMPLATE_KIND) {
    if (pattern.test(n)) return kind;
  }
  return undefined;
}

/** One `{{…}}` call: where it opens, where it closes, and the kind it implies. */
interface Frame {
  from: number;
  /** Exclusive end; `text.length` for a template left unclosed at EOF. */
  to: number;
  kind: IdKind | undefined;
}

/**
 * Every template call in the text, brace-matched, innermost last among the
 * frames that contain a given offset only by virtue of the stack order they
 * were closed in — so callers scan the list and keep the *narrowest* match.
 *
 * Unbalanced input is tolerated rather than rejected: a `}}` with nothing open
 * is ignored, and a `{{` never closed runs to the end of the text. No window
 * clips a frame: a closed frame provably encloses what is inside it however
 * long its fields run, and real infoboxes do run long before reaching `| id =`.
 */
function templateFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  const stack: { from: number; kind: IdKind | undefined }[] = [];
  BRACE.lastIndex = 0;
  for (let m = BRACE.exec(text); m !== null; m = BRACE.exec(text)) {
    if (m[0] === "{{") {
      TEMPLATE_OPEN.lastIndex = m.index;
      const open = TEMPLATE_OPEN.exec(text);
      const name = open !== null && open.index === m.index ? (open[1] ?? "") : "";
      stack.push({ from: m.index, kind: kindForTemplate(name) });
    } else {
      const open = stack.pop();
      if (open === undefined) continue;
      frames.push({ from: open.from, to: m.index + 2, kind: open.kind });
    }
  }
  for (const open of stack) frames.push({ from: open.from, to: text.length, kind: open.kind });
  return frames;
}

/**
 * The kind of the template that actually encloses `offset`: the narrowest
 * frame containing it, widening outward past frames whose name implies no kind
 * — `{{#if:`, `{{PAGENAME}}` and other wrappers sit between an infobox and its
 * fields, and the infobox is still what the id belongs to.
 */
function enclosingKind(frames: Frame[], offset: number): IdKind {
  let best: IdKind | undefined;
  let width = Number.POSITIVE_INFINITY;
  for (const f of frames) {
    if (f.from > offset || f.to <= offset) continue;
    if (f.kind === undefined) continue;
    const w = f.to - f.from;
    if (w < width) {
      width = w;
      best = f.kind;
    }
  }
  return best ?? "unknown";
}

/**
 * Every numeric entity id the page states about itself, in source order.
 * Deduplicated on (kind, id) and capped.
 */
export function extractIds(wikitext: string): WikiId[] {
  if (!wikitext.includes("=")) return [];
  const frames = templateFrames(wikitext);

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
    const kind = fromField ?? enclosingKind(frames, m.index);
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id });
  }
  return out;
}
