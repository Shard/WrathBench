/**
 * A tool call's input, read for how the feed draws it instead of as JSON.
 *
 * Three shapes are worth a view of their own: an edit (`edit_file`,
 * `edit_scratchpad`), drawn as a diff; a whole file written (`write_file`,
 * `write_scratchpad`), drawn as the file under its path; and a call whose
 * arguments are a few short values (`yield`, `start_routine`, `read_file`),
 * drawn as one line; and a call whose one argument is a long string
 * (`log_status`), drawn as that text. Everything else stays the JSON it was.
 *
 * Read defensively. The tools accept their arguments under several names
 * (`old_string`, `oldString`, `search`…), so the recorded args may use any of
 * them; they may be a JSON string rather than an object; and the viewer caps
 * a long string, leaving its marker at the end. A diff of a capped string
 * would draw the cap as an edit, so a capped edit is no edit view at all and
 * falls back to the JSON, whose raw link has the rest; a capped write is
 * still the file's first part, and is drawn as one.
 */

export type ArgsView =
  | { kind: "edit"; path?: string | undefined; old: string; new: string; replaceAll: boolean }
  | { kind: "write"; path?: string | undefined; content: string }
  | { kind: "line"; text: string }
  | { kind: "text"; text: string };

const OLD_KEYS = ["old", "old_string", "oldString", "old_text", "oldText", "search"] as const;
const NEW_KEYS = ["new", "new_string", "newString", "new_text", "newText", "replace"] as const;
const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;
const CONTENT_KEYS = ["content", "text", "code"] as const;
const REPLACE_ALL_KEYS = ["replaceAll", "replace_all"] as const;

/** The marker `viewer/tail.ts` leaves where it cut a long string. */
const CLIP_MARKER = /\n… \d+ more characters$/;

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit_file", "edit_scratchpad"]);
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "write_scratchpad"]);

/** The args as an object: as recorded, or parsed from a JSON string; null for anything else. */
export function argsObject(args: unknown): Record<string, unknown> | null {
  let v = args;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pick(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}

const clipped = (s: string): boolean => CLIP_MARKER.test(s);

/** The longest a value may be and still sit on a one-line head. */
const LINE_VALUE_MAX = 60;
/** The most values a one-line head holds. */
const LINE_VALUES_MAX = 5;

/** A scalar, or a flat object or array of scalars, short enough for a line; undefined when not. */
function short(v: unknown, depth = 0): string | undefined {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.length <= LINE_VALUE_MAX && !v.includes("\n") ? v : undefined;
  if (depth > 0 || v === null || typeof v !== "object") return v === null ? "null" : undefined;
  const parts: string[] = [];
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = short(x, depth + 1);
      if (s === undefined) return undefined;
      parts.push(s);
    }
    const line = `[${parts.join(", ")}]`;
    return line.length <= LINE_VALUE_MAX ? line : undefined;
  }
  for (const [k, x] of Object.entries(v)) {
    const s = short(x, depth + 1);
    if (s === undefined) return undefined;
    parts.push(`${k}=${s}`);
  }
  const line = `{${parts.join(" ")}}`;
  return line.length <= LINE_VALUE_MAX * 2 ? line : undefined;
}

/** Seconds as the feed writes a wait: `90s`, `5m`, `2m30s`. */
function seconds(n: number): string {
  if (n < 60 || !Number.isInteger(n)) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/**
 * The one-line form of a call's args: the name a routine call is about first,
 * then the rest as `key=value`; null when any value is too long for a line.
 */
function lineOfArgs(name: string, o: Record<string, unknown>): string | null {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  if (name === "yield" && entries.length === 1 && typeof o["seconds"] === "number") return seconds(o["seconds"]);
  // One short value is the call's whole say: `search_reference kobold`, `log_status noted`.
  if (entries.length === 1 && typeof entries[0]![1] === "string") return short(entries[0]![1]) ?? null;
  const parts: string[] = [];
  // A routine's or a file's name reads as the subject, not as `name=…`.
  const subject = name.endsWith("_routine") ? "name" : PATH_KEYS.find((k) => typeof o[k] === "string");
  for (const [k, v] of entries) {
    if (k === "args" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      // A routine's own arguments, spread: `start_routine grind · questId=179 · radius=80`.
      for (const [ak, av] of Object.entries(v)) {
        const as = short(av);
        if (as === undefined) return null;
        parts.push(`${ak}=${as}`);
      }
      continue;
    }
    const s = short(v);
    if (s === undefined) return null;
    if (k === subject) parts.unshift(s);
    else parts.push(`${k}=${s}`);
  }
  if (parts.length > LINE_VALUES_MAX + 1) return null;
  return parts.join(" · ");
}

/**
 * How a call's input is drawn, or null for the JSON it was. `isClipped` is the
 * record's own flag: set, an edit or a write cannot be trusted whole.
 */
export function argsView(name: string | undefined, args: unknown, isClipped = false): ArgsView | null {
  if (name === undefined) return null;
  const o = argsObject(args);
  if (o === null) return null;
  if (EDIT_TOOLS.has(name)) {
    const before = pick(o, OLD_KEYS);
    const after = pick(o, NEW_KEYS);
    if (before === undefined || after === undefined || isClipped || clipped(before) || clipped(after)) return null;
    const all = REPLACE_ALL_KEYS.some((k) => o[k] === true);
    return { kind: "edit", path: pick(o, PATH_KEYS), old: before, new: after, replaceAll: all };
  }
  if (WRITE_TOOLS.has(name)) {
    const content = pick(o, CONTENT_KEYS);
    // A capped file is still its first part, the cap's marker at the end and the raw link on the head.
    if (content === undefined) return null;
    return { kind: "write", path: pick(o, PATH_KEYS), content };
  }
  const text = lineOfArgs(name, o);
  if (text !== null) return { kind: "line", text };
  // One argument too long for a line (a status line, a long query): its words, not its JSON.
  const entries = Object.entries(o);
  if (entries.length === 1 && typeof entries[0]![1] === "string") return { kind: "text", text: entries[0]![1] };
  return null;
}

/** A codex `file_change` item's changes, `[kind, path]` each, off its recorded body; null when it does not read as one. */
export function fileChanges(body: unknown): { kind: string; path: string }[] | null {
  const o = argsObject(body);
  if (o === null || o["type"] !== "file_change" || !Array.isArray(o["changes"])) return null;
  const out: { kind: string; path: string }[] = [];
  for (const c of o["changes"] as unknown[]) {
    if (c === null || typeof c !== "object") return null;
    const r = c as Record<string, unknown>;
    const path = typeof r["path"] === "string" ? r["path"] : undefined;
    const k = r["kind"];
    const kind = typeof k === "string" ? k : k !== null && typeof k === "object" && typeof (k as { type?: unknown }).type === "string" ? (k as { type: string }).type : "change";
    if (path === undefined) return null;
    out.push({ kind, path });
  }
  return out;
}

/**
 * A codex `exec` call's output, as the text its script printed: the output is
 * recorded as the JSON of the content parts the CLI returned, each an
 * `input_text`. Null when it does not parse as that (a cut record does not).
 */
export function execOutput(output: unknown): string | null {
  if (typeof output !== "string") return null;
  try {
    const parts = JSON.parse(output) as unknown;
    if (!Array.isArray(parts)) return null;
    const texts: string[] = [];
    for (const p of parts) {
      if (p === null || typeof p !== "object") return null;
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") texts.push(t);
    }
    return texts.join("\n");
  } catch {
    return null;
  }
}
