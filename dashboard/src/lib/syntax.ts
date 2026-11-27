/**
 * A small TypeScript/JavaScript tokenizer for the run feed's code: snippets,
 * program files, diff lines, a codex `exec` script.
 *
 * Hand-rolled rather than a library: what the feed needs is a handful of
 * classes (keywords, strings, numbers, comments, calls) over code that is
 * mostly short and often cut mid-token by a writer's cap, and a tokenizer
 * that must never lose a character, because the highlighted text is the
 * record. Every character of the input lands in exactly one token, in order,
 * so joining the tokens gives the input back (pinned by a test). Unterminated
 * strings and comments run to the end of the line or the text rather than
 * failing; a regex literal is told from a division by the token before it,
 * the usual heuristic, and getting it wrong only colours a stretch of one
 * line.
 *
 * Classes, not colours: each kind is a `syn-*` class the stylesheet themes
 * with tokens it already has.
 */

export type SynKind = "kw" | "str" | "num" | "com" | "fn" | "lit" | "";

/** One run of text and its class; "" is plain. */
export type SynToken = readonly [SynKind, string];

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "declare",
  "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "is", "keyof", "let", "namespace", "new", "of", "private",
  "protected", "public", "readonly", "return", "satisfies", "set", "static", "super", "switch", "this", "throw", "try",
  "type", "typeof", "var", "void", "while", "with", "yield",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

/** After one of these (or at the start), a `/` opens a regex literal rather than dividing. */
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

const isIdStart = (c: string): boolean => /[A-Za-z_$À-￿]/.test(c);
const isId = (c: string): boolean => /[A-Za-z0-9_$À-￿]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Tokenize `src`; the tokens' texts concatenate to `src` exactly. */
export function tokenize(src: string): SynToken[] {
  const out: SynToken[] = [];
  const push = (kind: SynKind, text: string): void => {
    if (text.length === 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last[0] === kind && kind === "") out[out.length - 1] = ["", last[1] + text];
    else out.push([kind, text]);
  };
  /** The last significant (non-space, non-comment) token, for the regex heuristic. */
  let prev: { kind: SynKind; text: string } | null = null;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    // Whitespace.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i + 1;
      while (j < n && /[ \t\n\r]/.test(src[j]!)) j++;
      push("", src.slice(i, j));
      i = j;
      continue;
    }
    // Comments.
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      push("com", src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("com", src.slice(i, j));
      i = j;
      continue;
    }
    // Strings: quotes end at their match or the line's end; a template runs to its backtick.
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === c) {
          j++;
          break;
        }
        if (d === "\n" && c !== "`") break;
        j++;
      }
      j = Math.min(j, n);
      push("str", src.slice(i, j));
      prev = { kind: "str", text: "" };
      i = j;
      continue;
    }
    // Regex literal, where a value may start.
    if (c === "/" && (prev === null || (prev.kind === "" && REGEX_AFTER_PUNCT.has(prev.text)) || (prev.kind === "kw" && REGEX_AFTER_WORD.has(prev.text)))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(src[j]!)) j++;
        push("str", src.slice(i, j));
        prev = { kind: "str", text: "" };
        i = j;
        continue;
      }
      // Not a regex after all: a lone slash.
    }
    // Numbers, with a leading dot (`.85`) and the usual radix and separator forms.
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) {
        // A second dot is a member access or a spread, not part of the number.
        if (src[j] === "." && !isDigit(src[j + 1] ?? "")) break;
        j++;
      }
      push("num", src.slice(i, j));
      prev = { kind: "num", text: "" };
      i = j;
      continue;
    }
    // Words.
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(src[j]!)) j++;
      const word = src.slice(i, j);
      // A member name (`x.await`) is never a keyword.
      const member = i > 0 && src[i - 1] === "." && src[i - 2] !== ".";
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      const call = src[k] === "(";
      const kind: SynKind = !member && KEYWORDS.has(word) ? "kw" : !member && LITERALS.has(word) ? "lit" : call ? "fn" : "";
      push(kind, word);
      prev = { kind: kind === "" || kind === "fn" ? "" : kind, text: kind === "kw" ? word : "\u0000" };
      i = j;
      continue;
    }
    // Punctuation, one character at a time.
    push("", c);
    prev = { kind: "", text: c };
    i++;
  }
  return out;
}

/**
 * `tokenize`, remembered by text. A feed re-renders its rows as the live tail
 * grows and a reader opens and closes them, and the same snippet is drawn on
 * every pass; the cache is bounded, oldest out first, because a live run's
 * code never stops arriving.
 */
const CACHE_MAX = 400;
const cache = new Map<string, SynToken[]>();
export function highlight(src: string): SynToken[] {
  const hit = cache.get(src);
  if (hit !== undefined) {
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  const t = tokenize(src);
  cache.set(src, t);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return t;
}

/** Whether a path names a file this tokenizer reads: TypeScript or JavaScript, or no extension at all (a snippet). */
export function isCodePath(path: string | undefined): boolean {
  if (path === undefined) return true;
  return /\.(m|c)?[jt]sx?$/i.test(path);
}

/** The column a laid-out JSON line keeps within, its indent and key included. */
const JSON_WIDTH = 80;

/** A key as a JavaScript literal writes it: bare where it is a name, quoted where it is not. */
function keyOf(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

function entriesOf(value: object): [string, unknown][] {
  return Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
}

/** A value on one line, spaced the way prettier spaces a literal: `[1, 2]`, `{ a: 1 }`. */
function flatJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(flatJson).join(", ")}]`;
  const entries = entriesOf(value);
  return entries.length === 0 ? "{}" : `{ ${entries.map(([k, v]) => `${keyOf(k)}: ${flatJson(v)}`).join(", ")} }`;
}

/**
 * A value laid out for reading, the way the sandbox prints one beside it: a
 * literal with its keys bare where they can be, spaced as prettier spaces
 * one. Whatever fits on its line (`JSON_WIDTH`, its indent and key counted)
 * stays on one line. An object that does not breaks to a member a line. An
 * array that does not fills its lines instead, its members packed side by
 * side up to the width with its brackets hugging the first and last of them,
 * so a quest log entry, `[183, "The Boar Hunter", [{ kind: "kill", … }]]`,
 * takes one or two lines rather than ten.
 */
function compactJson(value: unknown, indent = "", lead = 0): string {
  const one = flatJson(value);
  if (value === null || typeof value !== "object" || indent.length + lead + one.length <= JSON_WIDTH) return one;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const lines: string[] = [];
    let line = "";
    value.forEach((v, k) => {
      const comma = k < value.length - 1 ? "," : "";
      const flat = flatJson(v) + comma;
      // The first line starts after the bracket; the rest at the inner indent.
      const at = lines.length === 0 ? indent.length + lead + 1 : inner.length;
      if (line.length > 0 && at + line.length + 1 + flat.length <= JSON_WIDTH) line += ` ${flat}`;
      else {
        if (line.length > 0) lines.push(line);
        const start = lines.length === 0 ? indent.length + lead + 1 : inner.length;
        // A member too long for a line of its own is laid out by the same rule, from where it starts.
        line = start + flat.length <= JSON_WIDTH ? flat : compactJson(v, inner) + comma;
      }
    });
    if (line.length > 0) lines.push(line);
    return `[${lines.join(`\n${inner}`)}]`;
  }
  return `{\n${entriesOf(value)
    .map(([k, v]) => {
      const key = `${keyOf(k)}: `;
      return `${inner}${key}${compactJson(v, inner, key.length)}`;
    })
    .join(",\n")}\n${indent}}`;
}

/** A JSON string literal whose content is itself JSON, laid out; null for anything else. */
function prettyJsonString(literal: string): string | null {
  const t = literal.trim();
  if (t.length < 2 || t[0] !== '"' || t[t.length - 1] !== '"') return null;
  try {
    const inner = JSON.parse(t) as unknown;
    if (typeof inner !== "string") return null;
    const s = inner.trim();
    if (!(s.startsWith("{") || s.startsWith("["))) return null;
    return compactJson(JSON.parse(s));
  } catch {
    return null;
  }
}

/**
 * A snippet's result with its value laid out, where the value is JSON the
 * snippet returned as a string (`return JSON.stringify(…)`): the sandbox
 * prints a string value quoted, so it comes back as one long line of escaped
 * JSON after the `=> `. That line is replaced by the value, laid out (`compactJson`);
 * null when the result has no such line, so the caller draws the text as it
 * was.
 */
export function prettyResult(text: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith('=> "'));
  if (at === -1) return null;
  const pretty = prettyJsonString(lines[at]!.slice(3));
  if (pretty === null) return null;
  return [...lines.slice(0, at), `=> ${pretty}`, ...lines.slice(at + 1)].join("\n");
}
