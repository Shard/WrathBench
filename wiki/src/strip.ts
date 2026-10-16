/**
 * Wikitext -> readable plain text.
 *
 * The consumer is a model reading search results, not a browser. Faithful
 * rendering is explicitly not the goal: templates carry infobox data we cannot
 * expand without the template namespace, so they go, and so do tables. What is
 * left is prose, headings and link labels, which is what a search index wants.
 * The one exception is a short list of inline link templates (`INLINE_LINKS`),
 * which are written as the name they link to.
 *
 * Everything here is a deterministic function of the input string.
 */

import { decodeEntities } from "./entities";
import { nameHasPostWrathQualifier } from "./post-wrath";

const DROP_LINK_PREFIX = /^\s*(?::\s*)?(file|image|category|media)\s*:/i;

/**
 * Inline link templates, written as the name they link to instead of being
 * dropped: lower-cased template name -> the 1-based positional slot that holds
 * the name. Every other template still goes, infoboxes included.
 *
 * Dropping these left holes in sentences — "sold by  in", "a reward from ." —
 * where the name was the answer a model had searched for. A survey of the kept
 * prose of a full build counted 121,199 templates sitting inline in prose, on
 * 97,074 lines of 36,502 of the 81,325 pages; these ten are 75,072 of them.
 * Each is a link to an item, NPC, quest, spell or achievement page whose text is
 * that page's name, and each was read in its Wrath-era template source:
 *
 * - `npc` (19,166 inline) and its redirect `NPC`: faction, **name**, title.
 * - `questlong` (17,995): faction, level, **name**.
 * - `loot` (16,337): quality, **name**.
 * - `item` (11,660): **name**.
 * - `quest` (3,449): **name**.
 * - `ability` (2,006): **name** — the spell link.
 * - `mob` (1,734): **name**.
 * - `npclong` (1,396): faction, level, **name**, title.
 * - `achievement` (905) and `achievementlong` (424): **name**.
 *
 * The slot is the link target, never a display override: the override slots
 * changed meaning across the wiki's history (a `quest` second argument is as
 * often `(Horde)` as a label), and the target is the title a model can search
 * for next. A template is matched case-insensitively, since `npc` and `NPC`
 * were one template by the cutoff. Rendering happens only at the top level: a
 * link template inside an infobox or a table goes with it. Zones have no link
 * template here — they are plain `[[links]]` — and `coords` is not one, so it
 * stays stripped.
 *
 * A name is this world's text only if the era rules would let it through as
 * prose. One whose qualifier places it in a later world
 * (`nameHasPostWrathQualifier`) is left out, and so is every name in a
 * paragraph or line the era rules read as the later world once its names are in
 * (`screenInlineLinks`, called from `wrath-only.ts`): either way the text is what
 * it was before link templates rendered. And a name never decides whether a page
 * is in the bundle — `build.ts` decides that with rendering off.
 */
const INLINE_LINKS: ReadonlyMap<string, number> = new Map([
  ["npc", 2],
  ["questlong", 3],
  ["loot", 2],
  ["item", 1],
  ["quest", 1],
  ["ability", 1],
  ["mob", 1],
  ["npclong", 3],
  ["achievement", 1],
  ["achievementlong", 1],
]);

/** Split a template body on its own pipes, not on those inside `[[…]]` or `{{…}}`. */
function templateArgs(body: string): string[] {
  const parts: string[] = [];
  let braces = 0;
  let brackets = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const d = body.charCodeAt(i + 1);
    if (c === 0x7b && d === 0x7b) {
      braces++;
      i++;
    } else if (c === 0x7d && d === 0x7d && braces > 0) {
      braces--;
      i++;
    } else if (c === 0x5b && d === 0x5b) {
      brackets++;
      i++;
    } else if (c === 0x5d && d === 0x5d && brackets > 0) {
      brackets--;
      i++;
    } else if (c === 0x7c && braces === 0 && brackets === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * Put in front of a link template's name by `screenInlineLinks`. The name then
 * matches nothing in `INLINE_LINKS`, so the strip removes the call the way it
 * removes any other template. A dump cannot contain one: XML forbids NUL.
 */
const SCREENED = "\u0000";

/**
 * A link template call, found by its name: `{{`, optional `Template:`, an
 * `INLINE_LINKS` name, then its first pipe or its closing braces.
 */
const LINK_CALL = new RegExp(
  String.raw`\{\{(?=\s*(?:template\s*:\s*)?(?:` +
    [...INLINE_LINKS.keys()].join("|") +
    String.raw`)\s*(?:\||\}\}))`,
  "gi",
);

/**
 * The name an `INLINE_LINKS` template links to, or null when the call leaves
 * nothing: any other template, an empty name slot (the hole it always left), a
 * call the era rules screened, and a name `nameHasPostWrathQualifier` places in
 * a later world. `raw` is the whole `{{…}}`. Positional slots follow MediaWiki:
 * an argument with a non-numeric `key=` is named and skipped, and `2=Name` fills
 * slot 2. `counts`, when given, records which of those it was.
 */
function inlineLinkName(raw: string, counts?: StripCounts): string | null {
  // A parameter (`{{{1|x}}}`) is not a template call.
  if (!raw.startsWith("{{") || !raw.endsWith("}}") || raw[2] === "{") return null;
  if (raw[2] === SCREENED) {
    if (counts !== undefined && inlineLinkName(`{{${raw.slice(3)}`) !== null) counts.screenedByEra++;
    return null;
  }
  const args = templateArgs(raw.slice(2, -2));
  const name = args[0]!
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^template\s*:\s*/i, "")
    .toLowerCase();
  const slot = INLINE_LINKS.get(name);
  if (slot === undefined) return null;
  let position = 0;
  let value: string | undefined;
  for (const arg of args.slice(1)) {
    const key = /^\s*([^=]*?)\s*=/.exec(arg);
    if (key === null) {
      position++;
      if (position === slot) value = arg;
    } else if (/^\d+$/.test(key[1]!) && Number(key[1]) === slot) {
      value = arg.slice(key[0].length);
    }
  }
  if (value === undefined) return null;
  // The name may itself hold a template; it goes, or renders, by the same rule.
  const text = removeBraced(value, true).replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  if (nameHasPostWrathQualifier(text)) {
    if (counts !== undefined) counts.screenedByQualifier++;
    return null;
  }
  if (counts !== undefined) counts.inlineLinks++;
  return text;
}

/**
 * A paragraph as the era rules read it once its link templates render: every
 * innermost call becomes its name if it is a link template and a space if it
 * is anything else — `proseOf` in `wrath-only.ts`, with the names left in.
 */
export function proseWithInlineLinks(text: string): string {
  let s = text;
  for (let i = 0; i < 4 && s.includes("{{"); i++) {
    s = s.replace(/\{\{[^{}]*\}\}/g, (call) => inlineLinkName(call) ?? " ");
  }
  return s;
}

/**
 * Mark every link template in `text` so the strip removes it instead of writing
 * its name: what the era rules do to a paragraph or a line that reads as the
 * later world only once its names are in. The strip then reduces that text
 * exactly as it did before link templates rendered.
 */
export function screenInlineLinks(text: string): string {
  return text.replace(LINK_CALL, `{{${SCREENED}`);
}

/** Tallies `stripWikitext` keeps for the caller; the build turns them into `meta`. */
export interface StripCounts {
  /** `INLINE_LINKS` templates written as their name. */
  inlineLinks: number;
  /** Link templates left out because their name carries a later-world qualifier. */
  screenedByQualifier: number;
  /** Link templates left out because the era rules read their paragraph or line as the later world. */
  screenedByEra: number;
}

export interface StripOptions {
  /**
   * Write `INLINE_LINKS` templates as their name. On by default; off is the
   * strip exactly as it was before they rendered, which is what the build
   * decides a page's membership with.
   */
  inlineLinks?: boolean;
  /** Incremented with what the strip wrote and what it screened. */
  counts?: StripCounts;
}

/** One unclosed `{{` or `{|`, kept so a closer can be matched to its own kind. */
interface Opener {
  /** Index of the opening brace, for the unbalanced-input fallback below. */
  at: number;
  /** `{|` (a table) rather than `{{` (a template or a parameter). */
  table: boolean;
}

/**
 * Remove `{{templates}}` and `{|tables|}`, including their contents,
 * nesting-aware.
 *
 * Two things the obvious depth counter gets wrong, both of which used to
 * swallow the whole rest of a page:
 *
 * - **Braces come in runs.** `{{{1|Alpha}}}` is a parameter, not a template
 *   inside a table: reading two characters at a time makes the third brace of
 *   the run open a phantom `{|` that nothing ever closes. A run of braces is
 *   consumed whole and counts `floor(run / 2)` on both sides, which pairs
 *   `{{{…}}}` and `{{{{…}}}}` alike and never opens a table on a stray brace.
 * - **A closer belongs to a kind.** `}}` closes a template and `|}` closes a
 *   table; one shared counter lets a `{|` written inside a template argument
 *   eat the template's own `}}`. The stack carries the kind, a `}}` unwinds any
 *   table opened inside the template it closes, and `|}` is only a table closer
 *   when a table is actually open — otherwise it is the `|` of a last argument
 *   followed by the template's `}}`.
 *
 * **Unbalanced input never costs the page.** If an opener is still unclosed at
 * the end — a `{{` inside `<nowiki>`, a template someone never closed — the
 * text before it is kept as before and the scan resumes at the first blank line
 * after that opener, on the assumption that a malformed template does not cross
 * a paragraph boundary. Only if there is no blank line after it does the tail go
 * with it. Previously every one of these returned the empty string for the whole
 * page.
 *
 * A top-level template in `INLINE_LINKS` leaves its name behind instead of
 * nothing; one nested in anything else goes with its parent.
 */
function removeBraced(input: string, render: boolean, counts?: StripCounts, guard = 0): string {
  if (!input.includes("{")) return input;
  const out: string[] = [];
  const stack: Opener[] = [];
  let segStart = 0;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input.charCodeAt(i);
    if (c === 0x7b /* { */) {
      let run = 1;
      while (i + run < n && input.charCodeAt(i + run) === 0x7b) run++;
      const opens = run >> 1;
      if (opens > 0) {
        if (stack.length === 0) out.push(input.slice(segStart, i));
        for (let k = 0; k < opens; k++) stack.push({ at: i, table: false });
        i += run;
        continue;
      }
      if (input.charCodeAt(i + 1) === 0x7c /* | */) {
        if (stack.length === 0) out.push(input.slice(segStart, i));
        stack.push({ at: i, table: true });
        i += 2;
        continue;
      }
    } else if (stack.length > 0 && c === 0x7d /* } */) {
      let run = 1;
      while (i + run < n && input.charCodeAt(i + run) === 0x7d) run++;
      let closes = run >> 1;
      if (closes > 0) {
        const outer = stack[0]!;
        while (closes > 0 && stack.length > 0) {
          // A `}}` closes the nearest template; a table opened inside it and
          // never closed goes with it rather than outliving the page.
          if (stack.pop()?.table === false) closes--;
        }
        i += run;
        if (stack.length === 0) {
          if (render && !outer.table) {
            const name = inlineLinkName(input.slice(outer.at, i), counts);
            if (name !== null) out.push(name);
          }
          segStart = i;
        }
        continue;
      }
    } else if (stack.length > 0 && c === 0x7c /* | */ && input.charCodeAt(i + 1) === 0x7d) {
      if (stack.some((o) => o.table)) {
        while (stack.length > 0 && stack.pop()?.table === false) {
          // unwind templates left open inside the table
        }
        i += 2;
        if (stack.length === 0) segStart = i;
        continue;
      }
    }
    i++;
  }
  if (stack.length === 0) {
    out.push(input.slice(segStart));
    return out.join("");
  }
  // Unbalanced. Everything before the outermost unclosed opener is already in
  // `out`; resume after the next blank line, which is strictly shorter input.
  const rest = input.slice(stack[0]!.at);
  const boundary = /\n[ \t]*\n/.exec(rest);
  if (boundary !== null && guard < 16) {
    out.push(removeBraced(rest.slice(boundary.index + boundary[0].length), render, counts, guard + 1));
  }
  return out.join("");
}

/** `[[a|b]]` -> `b`, `[[a]]` -> `a`, file/category links dropped. Nesting-aware. */
function processLinks(input: string, depth = 0): string {
  if (depth > 8 || !input.includes("[[")) return input;
  const out: string[] = [];
  let i = 0;
  let segStart = 0;
  const n = input.length;
  while (i < n) {
    if (input.charCodeAt(i) === 0x5b && input.charCodeAt(i + 1) === 0x5b) {
      // Find the matching ]] accounting for nested [[ ]].
      let level = 1;
      let j = i + 2;
      while (j < n && level > 0) {
        if (input.charCodeAt(j) === 0x5b && input.charCodeAt(j + 1) === 0x5b) {
          level++;
          j += 2;
        } else if (input.charCodeAt(j) === 0x5d && input.charCodeAt(j + 1) === 0x5d) {
          level--;
          j += 2;
        } else {
          j++;
        }
      }
      if (level !== 0) break; // unbalanced: leave the tail alone
      const inner = input.slice(i + 2, j - 2);
      out.push(input.slice(segStart, i));
      if (!DROP_LINK_PREFIX.test(inner)) {
        const bar = inner.lastIndexOf("|");
        const label = bar === -1 ? inner : inner.slice(bar + 1);
        out.push(processLinks(label.replace(/^\s*:/, ""), depth + 1));
      }
      i = j;
      segStart = j;
      continue;
    }
    i++;
  }
  out.push(input.slice(segStart));
  return out.join("");
}

const COMMENT = /<!--[\s\S]*?-->/g;
const OPEN_COMMENT = /<!--[\s\S]*$/;
/**
 * A container tag and its contents. The `(?<!\/)` matters more than it looks:
 * a wiki cites a named footnote a second time as `<ref name="x" />`, and
 * without it `[^>]*` reads that self-closing tag as an *opening* one and eats
 * everything up to the next `</ref>` — on Orgrimmar's 2010 revision, 1,486
 * characters including the `}}` that closed the infobox, which then swallowed
 * the whole page. A self-closing tag is left to `SELF_CLOSING`.
 */
const CONTAINER_TAGS = /<(ref|gallery|imagemap|score|math|timeline)\b[^>]*(?<!\/)>[\s\S]*?<\/\1\s*>/gi;
const SELF_CLOSING = /<(ref|br|hr)\b[^>]*\/?>/gi;
const ANY_TAG = /<\/?[a-zA-Z][^>]{0,400}>/g;
const EXTERNAL_LINK = /\[(?:https?:|ftp:|mailto:|\/\/)[^\s\]]*(?:\s+([^\]]*))?\]/gi;
const HEADING = /^[ \t]*(={1,6})[ \t]*(.*?)[ \t]*\1[ \t]*$/gm;
const LIST_MARKER = /^[ \t]*[*#:;]+[ \t]*/gm;
const HR = /^[ \t]*-{4,}[ \t]*$/gm;
const BOLD_ITALIC = /'{2,5}/g;
const TABLE_LEFTOVER = /^[ \t]*[|!].*$/gm;

/**
 * Reduce wikitext to plain text. Best effort, deterministic, never throws.
 * `opts` turns link-template rendering off or collects counts (`StripOptions`).
 */
export function stripWikitext(input: string, opts: StripOptions = {}): string {
  let s = input;
  s = s.replace(COMMENT, "").replace(OPEN_COMMENT, "");
  s = s.replace(CONTAINER_TAGS, " ");
  s = s.replace(SELF_CLOSING, " ");
  s = removeBraced(s, opts.inlineLinks !== false, opts.counts);
  s = s.replace(TABLE_LEFTOVER, "");
  s = processLinks(s);
  s = s.replace(EXTERNAL_LINK, (_whole, label?: string) => (label ? label : " "));
  s = s.replace(HEADING, (_whole, _eq: string, title: string) => title);
  s = s.replace(HR, "");
  s = s.replace(LIST_MARKER, "");
  s = s.replace(BOLD_ITALIC, "");
  s = s.replace(ANY_TAG, " ");
  s = decodeEntities(s);
  s = s.replace(/[{}\u0000]/g, "");
  s = s.replace(/\[\[|\]\]/g, "");

  // Whitespace: trim every line, drop empties, keep one line per paragraph.
  const lines: string[] = [];
  for (const rawLine of s.split("\n")) {
    const line = rawLine.replace(/[ \t ]+/g, " ").trim();
    if (line.length > 0) lines.push(line);
  }
  return lines.join("\n");
}

const REDIRECT = /^\s*(?:<[^>]*>\s*)*#\s*(?:redirect|redirecionamento|weiterleitung)\s*:?\s*\[\[([^\]|#]+)/i;

/** Returns the redirect target if the wikitext is a redirect, else null. */
export function redirectTarget(wikitext: string): string | null {
  const m = REDIRECT.exec(wikitext);
  if (!m || m[1] === undefined) return null;
  const target = decodeEntities(m[1]).replace(/_/g, " ").trim();
  return target.length > 0 ? target : null;
}
