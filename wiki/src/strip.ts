/**
 * Wikitext -> readable plain text.
 *
 * The consumer is a model reading search results, not a browser. Faithful
 * rendering is explicitly not the goal: templates carry infobox data we cannot
 * expand without the template namespace, so they go, and so do tables. What is
 * left is prose, headings and link labels, which is what a search index wants.
 *
 * Everything here is a deterministic function of the input string.
 */

import { decodeEntities } from "./entities";

const DROP_LINK_PREFIX = /^\s*(?::\s*)?(file|image|category|media)\s*:/i;

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
 * swallow the whole rest of a page (FOLLOW-UPS 63):
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
 */
function removeBraced(input: string, guard = 0): string {
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
        while (closes > 0 && stack.length > 0) {
          // A `}}` closes the nearest template; a table opened inside it and
          // never closed goes with it rather than outliving the page.
          if (stack.pop()?.table === false) closes--;
        }
        i += run;
        if (stack.length === 0) segStart = i;
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
    out.push(removeBraced(rest.slice(boundary.index + boundary[0].length), guard + 1));
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
 * the whole page (FOLLOW-UPS 63). A self-closing tag is left to `SELF_CLOSING`.
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
 */
export function stripWikitext(input: string): string {
  let s = input;
  s = s.replace(COMMENT, "").replace(OPEN_COMMENT, "");
  s = s.replace(CONTAINER_TAGS, " ");
  s = s.replace(SELF_CLOSING, " ");
  s = removeBraced(s);
  s = s.replace(TABLE_LEFTOVER, "");
  s = processLinks(s);
  s = s.replace(EXTERNAL_LINK, (_whole, label?: string) => (label ? label : " "));
  s = s.replace(HEADING, (_whole, _eq: string, title: string) => title);
  s = s.replace(HR, "");
  s = s.replace(LIST_MARKER, "");
  s = s.replace(BOLD_ITALIC, "");
  s = s.replace(ANY_TAG, " ");
  s = decodeEntities(s);
  s = s.replace(/[{}]/g, "");
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
