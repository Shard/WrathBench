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

/** Remove `{{templates}}` and `{|tables|}`, including their contents, nesting-aware. */
function removeBraced(input: string): string {
  if (!input.includes("{")) return input;
  const out: string[] = [];
  let segStart = 0;
  let depth = 0;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input.charCodeAt(i);
    if (c === 0x7b /* { */) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x7b || next === 0x7c /* | */) {
        if (depth === 0) out.push(input.slice(segStart, i));
        depth++;
        i += 2;
        continue;
      }
    } else if (depth > 0 && (c === 0x7d /* } */ || c === 0x7c /* | */)) {
      const next = input.charCodeAt(i + 1);
      if ((c === 0x7d && next === 0x7d) || (c === 0x7c && next === 0x7d)) {
        depth--;
        i += 2;
        if (depth === 0) segStart = i;
        continue;
      }
    }
    i++;
  }
  if (depth === 0) out.push(input.slice(segStart));
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
const CONTAINER_TAGS = /<(ref|gallery|imagemap|score|math|timeline)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
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
