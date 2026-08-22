/**
 * Quest infobox extraction: who gives the quest, and who takes it back.
 *
 * Wiki quest pages state both in a `{{questbox}}`:
 *
 *   {{questbox | name=… | start=[[Deputy Willem]] | end={{npc||Marshal McBride}}
 *              | category=Elwynn Forest | id=783 }}
 *
 * `stripWikitext` throws every template away, so — like coords and ids — this
 * runs on the RAW wikitext before the strip. Without it the bundle says nothing
 * about the ender at all: the page for quest 783 reduces to "Speak with ."
 * because even the inline NPC template is gone.
 *
 * That gap is what ~150 `EventTimeoutError`s across 17 of 18 runs were made of
 * (night-report 2026-08-23 §2a): a model turns a quest in to the NPC that gave
 * it, the ender is someone else, and the server simply never answers.
 *
 * Two rules keep this honest:
 *
 * - Only the named-argument infobox templates (`questbox`, `questinfo`) are
 *   read. `{{questlong|Horde|5|Package Recovery}}` is a list-item template on
 *   quest *index* pages and states no giver or ender.
 * - `end` is never inferred. 11,267 quest pages in the 2020 dump state `start`
 *   and only 7,108 state `end`; when the page does not say, the extractor says
 *   nothing and the caller tells the model the page does not say. Guessing
 *   "same NPC" would manufacture a confident wrong answer in exactly the case
 *   this exists to fix.
 *
 * Deterministic and best-effort, like its siblings. Nothing here reads the
 * server, the AzerothCore DB, DBC tables or Questie.
 */

/** What a quest page states about itself in its infobox. Fields are absent when unstated. */
export interface WikiQuest {
  /** NPC (or object) the page names as the quest giver. */
  start?: string;
  /** NPC the page names as the turn-in. Absent means the page does not say. */
  end?: string;
  /** The infobox `category` field — usually the zone the quest belongs to. */
  category?: string;
}

/** A name is a name, not an essay: anything longer is a mis-parse. */
const MAX_VALUE = 120;

/** The infobox templates that carry named `start`/`end` arguments. */
const QUEST_INFOBOX = /\{\{\s*quest(?:box|info)\b/i;

/** Templates whose positional arguments name an NPC: `{{npc||Name}}`, `{{mob|Faction|Name}}`. */
const NPC_TEMPLATE = /^(?:npc|mob|creature|boss|object)$/i;

/** A pipe inside `[[…]]` masked so a field split does not cut a piped link in two. */
const PIPE_MASK = String.fromCharCode(0xe000);

/**
 * The `{{…}}` call starting at `from`, brace-matched. Returns the slice, or the
 * rest of the text when the template is never closed.
 */
function templateBody(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length - 1; i++) {
    const two = text.slice(i, i + 2);
    if (two === "{{") {
      depth++;
      i++;
    } else if (two === "}}") {
      depth--;
      i++;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return text.slice(from);
}

/** Split on `|` at the top brace/link level only. */
function splitParams(body: string): string[] {
  const masked = body.replace(/\[\[[^\]]*\]\]/g, (link) => link.split("|").join(PIPE_MASK));
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length - 1; i++) {
    const two = masked.slice(i, i + 2);
    if (two === "{{") {
      depth++;
      i++;
    } else if (two === "}}") {
      depth--;
      i++;
    } else if (masked[i] === "|" && depth === 0) {
      out.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  out.push(masked.slice(start));
  return out.map((p) => p.split(PIPE_MASK).join("|"));
}

/** `{{npc||Marshal McBride}}` / `{{NPC|Alliance|Milo Geartwinge|icon=…}}` -> the name. */
function npcTemplateName(call: string): string | undefined {
  const inner = call.replace(/^\{\{/, "").replace(/\}\}$/, "");
  const params = splitParams(inner);
  const name = (params[0] ?? "").trim();
  if (!NPC_TEMPLATE.test(name)) return undefined;
  const positional = params
    .slice(1)
    .filter((p) => !p.includes("="))
    .map((p) => p.trim());
  // `{{npc|faction|name|…}}`: the name is the second positional, and the
  // faction slot before it is as often empty (`{{npc||Name}}`) as filled
  // (`{{NPC|Alliance|Name}}`). A one-positional call (`{{mob|Name|ah=-1}}`)
  // names the NPC in the only slot it has.
  const second = positional[1];
  if (second !== undefined && second.length > 0) return second;
  const first = positional[0];
  return first !== undefined && first.length > 0 ? first : undefined;
}

/**
 * An infobox value reduced to plain text: NPC templates give up their name,
 * links give up their label, anything else template-shaped is dropped.
 */
export function cleanQuestValue(raw: string): string | undefined {
  let s = raw;
  // Innermost-first, so a template nested in a template still resolves.
  for (let pass = 0; pass < 4 && s.includes("{{"); pass++) {
    s = s.replace(/\{\{[^{}]*\}\}/g, (call) => npcTemplateName(call) ?? " ");
  }
  s = s
    .replace(/\[\[([^\]]*)\]\]/g, (_whole, innerRaw: string) => {
      const inner = String(innerRaw);
      const bar = inner.lastIndexOf("|");
      const hash = inner.indexOf("#");
      return bar !== -1 ? inner.slice(bar + 1) : hash !== -1 ? inner.slice(0, hash) : inner;
    })
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/'{2,5}/g, "")
    .replace(/[[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // A leftover wikitext fragment is not a name.
  if (s.includes("=") || s.includes("|")) return undefined;
  return s.length > 0 && s.length <= MAX_VALUE ? s : undefined;
}

/**
 * What the page's quest infobox states about giver, ender and category, or
 * `null` when the page has no quest infobox. Never throws.
 */
export function extractQuest(wikitext: string): WikiQuest | null {
  if (typeof wikitext !== "string" || wikitext.length === 0) return null;
  const open = QUEST_INFOBOX.exec(wikitext);
  if (open === null) return null;
  const body = templateBody(wikitext, open.index);
  const out: WikiQuest = {};
  for (const param of splitParams(body.replace(/^\{\{/, "").replace(/\}\}$/, ""))) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (key !== "start" && key !== "end" && key !== "category") continue;
    if (out[key] !== undefined) continue;
    const value = cleanQuestValue(param.slice(eq + 1));
    // `| end = ` with nothing after it is the page not saying, not an empty NPC.
    if (value !== undefined) out[key] = value;
  }
  return out.start === undefined && out.end === undefined && out.category === undefined
    ? null
    : out;
}
