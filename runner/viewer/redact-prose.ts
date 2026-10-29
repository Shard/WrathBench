/**
 * Game-prose redaction for published trajectory entries.
 *
 * The rule (docs/DATA-AND-LEGAL.md, "Trajectory logs", operator 2026-08-30):
 * published trajectories keep names — items, quests, NPCs, zones, spells — and
 * ids; game PROSE — quest, gossip, item and mail body text — is redacted.
 *
 * Prose is found by SHAPE, never by looking at the words. Every field below
 * is enumerated from `wrath-mcp/sdk/src/protocol.ts`: the opcode whose decoded payload
 * carries it, and the discriminating keys that identify the same payload when
 * it turns up unwrapped — a snippet returning `state.lastGossip(guid)`, or a
 * `sdk.quest.details()` result — inside a tool result. A title is a name and
 * stays; a `details`, `objectives`, `greeting`, gossip option `text`, item
 * `description`, page/letter `text` or mail `body` goes.
 *
 * Four surfaces carry decoded payloads into an entry:
 * - `events_served` batches (`events[].data`, keyed by `events[].opcode`);
 * - tool results whose text IS JSON (a value the model serialised);
 * - a snippet's value and its console objects as the sandbox renders them —
 *   `Bun.inspect(value, { depth: 4 })`, multi-line, bare keys, trailing
 *   commas, cut at the sandbox's character cap — which `redactRendered`
 *   reads in place, so text that matches no shape stays byte-identical;
 * - the `recent_events` tool's line format, `#<seq> <OPCODE> <json>`, where the
 *   json may be cut short by the harness's own compaction — an uncuttable
 *   payload of a prose-carrying opcode is replaced whole.
 *
 * The SDK also quotes gossip option text inside its own hint and error
 * sentences (`[3] "…"`, `0:"…"`); those two list forms are recognised
 * wherever they appear (`redactOptionLists`).
 *
 * What this cannot see is the residual, and docs/PUBLIC-DASHBOARD.md states
 * it: text the MODEL wrote (its turn text, snippet code, scratchpad, episodic
 * log, the words of its console.log lines, objects it rebuilt under its own
 * keys) may quote game prose and is published as written.
 */

import type { EntrySummary } from "./api-types";

/** The placeholder a redacted value leaves behind, so its absence is visible. */
export const REDACTED_PROSE = "[redacted]";

/**
 * One prose-carrying payload: how to recognise it, and which of its fields go.
 *
 * `opcode` names the wrapped form (`{opcode, data}`, as an event batch carries
 * it). `keys` are the fields that together identify the unwrapped form — all
 * must be present. `redact` are paths into the payload: a bare key,
 * `list[].key` for a field on every element of an array, or `list[]` for
 * every string element of an array.
 */
export interface ProseShape {
  opcode: string | null;
  keys: readonly string[];
  redact: readonly string[];
}

/**
 * Enumerated from `wrath-mcp/sdk/src/protocol.ts`. Names (`title`, `name`, `subject`)
 * are deliberately absent from every `redact` list.
 */
export const PROSE_SHAPES: readonly ProseShape[] = [
  // Quest template: log text. `title` stays; `requiredNpcOrGo[].text` is the
  // objective's own sentence. The SDK keeps the same template as `QuestInfo`
  // (`state.quests`), where the wire's `objectives` is `objectivesText`.
  {
    opcode: "SMSG_QUEST_QUERY_RESPONSE",
    keys: ["questId", "title", "requiredNpcOrGo"],
    redact: ["details", "objectives", "objectivesText", "areaDescription", "completedText", "requiredNpcOrGo[].text"],
  },
  // One `requiredNpcOrGo` row on its own, as a snippet that walks the
  // template returns or logs it.
  { opcode: null, keys: ["entry", "count", "text"], redact: ["text"] },
  // A questgiver's greeting over its offered list (titles stay).
  { opcode: "SMSG_QUESTGIVER_QUEST_LIST", keys: ["guid", "greeting", "quests"], redact: ["greeting"] },
  // The quest offer dialogue.
  { opcode: "SMSG_QUESTGIVER_QUEST_DETAILS", keys: ["questId", "title", "details"], redact: ["details", "objectives"] },
  // The "bring me" and "well done" dialogues.
  { opcode: "SMSG_QUESTGIVER_REQUEST_ITEMS", keys: ["questId", "title", "text", "requiredItems"], redact: ["text"] },
  { opcode: "SMSG_QUESTGIVER_OFFER_REWARD", keys: ["questId", "title", "text", "rewards"], redact: ["text"] },
  // A gossip menu's option lines (the NPC's `textId` is an id and stays).
  { opcode: "SMSG_GOSSIP_MESSAGE", keys: ["menuId", "options"], redact: ["options[].text"] },
  // The same option rows unwrapped: `GossipMenuOption` / `gossipOptionSchema`.
  { opcode: null, keys: ["optionId", "text"], redact: ["text"] },
  // A trainer's greeting line (`TrainerWindow` carries it unwrapped too).
  { opcode: "SMSG_TRAINER_LIST", keys: ["trainerType", "spells"], redact: ["greeting"] },
  // An item's flavour text; its name and numbers stay.
  { opcode: "SMSG_ITEM_QUERY_SINGLE_RESPONSE", keys: ["itemId", "name", "description"], redact: ["description"] },
  // A book or letter page; a player-written letter.
  { opcode: "SMSG_PAGE_TEXT_QUERY_RESPONSE", keys: ["pageId", "nextPageId"], redact: ["text"] },
  { opcode: "SMSG_ITEM_TEXT_QUERY_RESPONSE", keys: ["found", "text"], redact: ["text"] },
  // The same pages as the SDK hands them back: `sdk.readItem()`'s result
  // (`ReadItemResult`, the pages and their join) and `state.itemTexts()`
  // (`ItemText`). The item's `name` stays.
  { opcode: null, keys: ["status", "item", "pages", "text"], redact: ["pages[]", "text"] },
  { opcode: null, keys: ["guid", "pages", "complete"], redact: ["pages[]"] },
  // Mail bodies; the subject is a title.
  { opcode: "SMSG_MAIL_LIST_RESULT", keys: ["mails"], redact: ["mails[].body"] },
  { opcode: null, keys: ["mailId", "body"], redact: ["body"] },
  // Chat: an NPC's say/yell is game prose and the packet does not say whose
  // words they are, so every message goes (arguable → withhold).
  { opcode: "SMSG_MESSAGECHAT", keys: ["senderGuid", "message", "chatTag"], redact: ["message"] },
  // The SDK's quest-log objective row (`QuestObjective` in wrath-mcp/sdk/src/state.ts):
  // the template's objective sentence, joined to counters.
  { opcode: null, keys: ["kind", "required", "have", "text"], redact: ["text"] },
];

/** Opcode → shapes, for the wrapped form. */
const BY_OPCODE: ReadonlyMap<string, ProseShape[]> = (() => {
  const m = new Map<string, ProseShape[]>();
  for (const s of PROSE_SHAPES) {
    if (s.opcode === null) continue;
    m.set(s.opcode, [...(m.get(s.opcode) ?? []), s]);
  }
  return m;
})();

/** The opcodes whose payload is replaced whole when it cannot be parsed. */
export const PROSE_OPCODES: ReadonlySet<string> = new Set(BY_OPCODE.keys());

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Apply one shape's paths to a fresh copy of `o`. Missing fields stay missing. */
function applyShape(o: Record<string, unknown>, shape: ProseShape): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  for (const path of shape.redact) {
    if (path.endsWith("[]")) {
      const rows = out[path.slice(0, -2)];
      if (Array.isArray(rows)) out[path.slice(0, -2)] = rows.map((r) => (typeof r === "string" ? REDACTED_PROSE : r));
      continue;
    }
    const arr = path.indexOf("[].");
    if (arr === -1) {
      if (typeof out[path] === "string") out[path] = REDACTED_PROSE;
      continue;
    }
    const list = path.slice(0, arr);
    const key = path.slice(arr + 3);
    const rows = out[list];
    if (!Array.isArray(rows)) continue;
    out[list] = rows.map((r) => (isRecord(r) && typeof r[key] === "string" ? { ...r, [key]: REDACTED_PROSE } : r));
  }
  return out;
}

function matches(o: Record<string, unknown>, shape: ProseShape): boolean {
  return shape.keys.every((k) => k in o);
}

/** One decoded payload under its opcode, prose fields replaced. Unknown opcodes pass. */
export function redactOpcodeData(opcode: string, data: Record<string, unknown>): Record<string, unknown> {
  let out = data;
  for (const s of BY_OPCODE.get(opcode) ?? []) out = applyShape(out, s);
  return out;
}

/**
 * Deep copy of `v` with every prose field on every recognised payload
 * replaced. Pure; arrays, nesting, the `{opcode, data}` wrapper and strings
 * that are themselves JSON included — a snippet routinely returns
 * `JSON.stringify(events)`, and the sandbox then encodes that string once
 * more, so a payload can sit two string levels down.
 */
export function redactProseValue(v: unknown): unknown {
  if (typeof v === "string") return redactProseString(v);
  if (Array.isArray(v)) return v.map(redactProseValue);
  if (!isRecord(v)) return v;
  let o: Record<string, unknown> = v;
  // The wrapped form first: the opcode says exactly which shape this is.
  if (typeof o["opcode"] === "string" && isRecord(o["data"])) {
    o = { ...o, data: redactOpcodeData(o["opcode"], o["data"]) };
  }
  for (const s of PROSE_SHAPES) if (matches(o, s)) o = applyShape(o, s);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) out[k] = redactProseValue(val);
  return out;
}

/**
 * Every key any shape above redacts, bare (`pages[]` and `list[].key` give
 * `pages` and `key`), for the cut-fragment fallbacks.
 */
export const PROSE_KEYS: readonly string[] = [
  ...new Set(
    PROSE_SHAPES.flatMap((s) =>
      s.redact.map((path) => {
        const bare = path.endsWith("[]") ? path.slice(0, -2) : path;
        return bare.slice(bare.lastIndexOf(".") + 1);
      }),
    ),
  ),
];
const PROSE_KEY_SET: ReadonlySet<string> = new Set(PROSE_KEYS);

/**
 * A cut JSON fragment: `{"` or its escaped form, somewhere in the string. A
 * model's own `.slice(0, 500)` over a stringified batch is the usual cause.
 */
const JSON_ISH = /[{[]\s*\\*"/;

/**
 * `"details":"` at any escape depth — `\"details\":\"` one level down, and so
 * on — or `"pages":["` for a list of prose strings.
 */
const CUT_PROSE = new RegExp(`(\\\\*)"(?:${PROSE_KEYS.join("|")})\\1":\\[?\\1"`);

/**
 * A string value: JSON inside it is walked; anything else is read as rendered
 * text (`redactRendered`). Text that matches nothing passes.
 */
function redactProseString(s: string): string {
  const parsed = tryParse(s);
  if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
    return JSON.stringify(redactProseValue(parsed));
  }
  if (typeof parsed === "string") return JSON.stringify(redactProseString(parsed));
  if (parsed !== undefined) return s;
  return redactRendered(s);
}

/**
 * Text that is not JSON as a whole: the sandbox's `Bun.inspect` rendering, a
 * JSON fragment inside the model's words, or a fragment cut short.
 *
 * Structures in it are read in place (`redactInspected`) and their prose
 * fields replaced by shape, which leaves every other byte as it was. Where the
 * text was cut inside a structure — the sandbox's character cap, a model's
 * own `.slice` — the shape cannot be seen whole, so a cut object loses every
 * prose-keyed field it got as far as; and a JSON-ish fragment is redacted from
 * its first prose key to the end, since which fields the cut left open is
 * unknowable. A single line takes that last rule whether or not anything was
 * cut, as it always has: a JSON fragment inside one line of free text is
 * withheld from its first prose key on.
 */
function redactRendered(s: string): string {
  const { text, cut } = redactInspected(s);
  let out = text;
  if ((cut || !s.includes("\n")) && JSON_ISH.test(out)) {
    const m = CUT_PROSE.exec(out);
    if (m !== null) out = `${out.slice(0, m.index + m[0].length)}${REDACTED_PROSE}`;
  }
  return redactOptionLists(out);
}

/**
 * The SDK's own option lists, which quote gossip option text inside a hint or
 * an error (`wrath-mcp/sdk/src/client.ts`): `[3] "…"` (`gossipSelect` by text), and
 * `0:"…"` after `pick one of: ` (`resetTalents`, `bindAtInnkeeper`) or
 * `Options: ` (`showTaxiNodes`, with ` (icon 2)` after each). The id stays.
 * The bare `id:"…"` form is not enough on its own: the SDK's name lists
 * (`guid:"name"`, `spellId:"name"`) share it, and names stay.
 */
const BRACKET_OPTION = /(\[\d+\] )"(?:[^"\\\n]|\\.)*"/g;
const COLON_OPTION_LIST = /((?:pick one of|Options): )((?:\d+:"(?:[^"\\\n]|\\.)*"(?: \(icon \d+\))?(?:, )?)+)/g;
const COLON_OPTION = /(\d+:)"(?:[^"\\\n]|\\.)*"/g;

function redactOptionLists(s: string): string {
  return s
    .replace(BRACKET_OPTION, `$1"${REDACTED_PROSE}"`)
    .replace(COLON_OPTION_LIST, (_, lead: string, list: string) => lead + list.replace(COLON_OPTION, `$1"${REDACTED_PROSE}"`));
}

// ------------------------------------------------- rendered (Bun.inspect) text

/** One string literal in the text: its span, and whether it was closed. */
interface StrNode {
  readonly k: "str";
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
}
interface ObjNode {
  readonly k: "obj";
  /** Key → value, for keys the reader could name (a bare word, a number or a string). */
  readonly entries: Map<string, Node>;
  /** Every value under the object, keyed or not (a Set's members, a Map's object keys). */
  readonly children: Node[];
  closed: boolean;
}
interface ArrNode {
  readonly k: "arr";
  readonly items: Node[];
  closed: boolean;
}
type Node = StrNode | ObjNode | ArrNode | { readonly k: "atom" };

/**
 * `Bun.inspect`'s bracketed atoms — `[Object ...]` past the depth limit,
 * `[Function: f]`, `[Getter]`, `[Circular *1]` — which are not arrays.
 */
const BRACKET_ATOM = /^\[(?:Object|Array|Function|AsyncFunction|GeneratorFunction|AsyncGeneratorFunction|Getter|Setter|class|Circular)\b[^\]\n]*\]?/;

/**
 * A tolerant reader for `Bun.inspect` output and JSON alike (JSON is the
 * quoted-key, no-trailing-comma case of the same grammar): objects with bare,
 * numeric or quoted keys, `Map(2) {`/`Set(2) {`/`ClassName {` prefixes,
 * arrays inline or wrapped, double-quoted strings with JSON escapes, and
 * anything else as an atom. It records where each string literal sits rather
 * than building values, and never throws: the end of the text closes whatever
 * is open, marked as cut.
 */
class InspectReader {
  i = 0;
  readonly strings: StrNode[] = [];
  cut = false;
  constructor(readonly s: string) {}

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  value(): Node {
    this.ws();
    const c = this.s[this.i];
    if (c === '"') return this.string();
    if (c === "{") return this.object();
    if (c === "[") return this.bracket();
    return this.bare();
  }

  private string(): StrNode {
    const start = this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === "\\") this.i += 2;
      else if (c === '"') {
        this.i++;
        return this.str(start, true);
      } else if (c === "\n") break;
      else this.i++;
    }
    this.i = Math.min(this.i, this.s.length);
    this.cut = true;
    return this.str(start, false);
  }

  private str(start: number, closed: boolean): StrNode {
    const n: StrNode = { k: "str", start, end: this.i, closed };
    this.strings.push(n);
    return n;
  }

  private bracket(): Node {
    const atom = BRACKET_ATOM.exec(this.s.slice(this.i, this.i + 200));
    if (atom !== null) {
      this.i += atom[0].length;
      return { k: "atom" };
    }
    return this.array();
  }

  private array(): ArrNode {
    const n: ArrNode = { k: "arr", items: [], closed: false };
    this.i++;
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return this.open(n);
      const c = this.s[this.i];
      if (c === "]") {
        this.i++;
        n.closed = true;
        return n;
      }
      if (c === "," || c === "}" || c === ":") {
        this.i++;
        continue;
      }
      n.items.push(this.value());
    }
  }

  private object(): ObjNode {
    const n: ObjNode = { k: "obj", entries: new Map(), children: [], closed: false };
    this.i++;
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) return this.open(n);
      const c = this.s[this.i]!;
      if (c === "}") {
        this.i++;
        n.closed = true;
        return n;
      }
      if (c === "," || c === "]" || c === ":") {
        this.i++;
        continue;
      }
      // A key — or, in a Set, a member; in a Map, possibly an object.
      let key: string | undefined;
      if (c === '"') {
        const k = this.string();
        n.children.push(k);
        if (k.closed) key = decodeLiteral(this.s.slice(k.start, k.end));
      } else if (c === "{" || c === "[") {
        n.children.push(this.value());
      } else {
        const m = /^[^:,{}[\]"\n]+/.exec(this.s.slice(this.i, this.i + 200));
        const word = m === null ? "" : m[0];
        this.i += Math.max(1, word.length);
        key = word.trim();
      }
      while (this.s[this.i] === " ") this.i++;
      if (this.s[this.i] !== ":") continue;
      this.i++;
      const v = this.value();
      n.children.push(v);
      if (key !== undefined && key !== "") n.entries.set(key, v);
    }
  }

  /** A bare value: a number, a word, `Map(2) {` (the prefix is skipped), a date. */
  private bare(): Node {
    const m = /^[^,{}[\]"\n]*/.exec(this.s.slice(this.i, this.i + 200));
    this.i += Math.max(1, m === null ? 0 : m[0].length);
    const c = this.s[this.i];
    if ((c === "{" || c === "[") && m !== null && /^[\w$.()]+ $/.test(m[0])) return this.value();
    return { k: "atom" };
  }

  private open<T extends ObjNode | ArrNode>(n: T): T {
    this.cut = true;
    return n;
  }
}

/**
 * `redactProseString` for a string literal inside rendered text, or
 * `undefined` when there was no prose in it: JSON in the string is rewritten
 * only when a field actually went, so a pretty-printed file a snippet read is
 * not re-laid-out compact for nothing.
 */
function redactIfProse(v: string): string | undefined {
  const parsed = tryParse(v);
  if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
    const after = JSON.stringify(redactProseValue(parsed));
    return after === JSON.stringify(parsed) ? undefined : after;
  }
  if (typeof parsed === "string") {
    const inner = redactIfProse(parsed);
    return inner === undefined ? undefined : JSON.stringify(inner);
  }
  if (parsed !== undefined) return undefined;
  const r = redactRendered(v);
  return r === v ? undefined : r;
}

/** A string literal's value, when it is one JSON can read. */
function decodeLiteral(raw: string): string | undefined {
  const v = tryParse(raw);
  return typeof v === "string" ? v : undefined;
}

/** Mark the string nodes a path names under one object. */
function markPaths(o: ObjNode, paths: readonly string[], marked: Set<StrNode>): void {
  for (const path of paths) {
    if (path.endsWith("[]")) {
      const rows = o.entries.get(path.slice(0, -2));
      if (rows?.k === "arr") for (const r of rows.items) if (r.k === "str") marked.add(r);
      continue;
    }
    const arr = path.indexOf("[].");
    if (arr === -1) {
      const v = o.entries.get(path);
      if (v?.k === "str") marked.add(v);
      continue;
    }
    const rows = o.entries.get(path.slice(0, arr));
    if (rows?.k !== "arr") continue;
    for (const r of rows.items) {
      const v = r.k === "obj" ? r.entries.get(path.slice(arr + 3)) : undefined;
      if (v?.k === "str") marked.add(v);
    }
  }
}

/** Decide, by shape, which string nodes under `n` are prose. */
function markProse(n: Node, s: string, marked: Set<StrNode>): void {
  if (n.k === "arr") {
    for (const item of n.items) markProse(item, s, marked);
    return;
  }
  if (n.k !== "obj") return;
  // The wrapped form: the opcode says exactly which shape `data` is.
  const op = n.entries.get("opcode");
  const data = n.entries.get("data");
  if (op?.k === "str" && op.closed && data?.k === "obj") {
    const name = decodeLiteral(s.slice(op.start, op.end));
    for (const shape of name === undefined ? [] : (BY_OPCODE.get(name) ?? [])) markPaths(data, shape.redact, marked);
  }
  for (const shape of PROSE_SHAPES) if (shape.keys.every((k) => n.entries.has(k))) markPaths(n, shape.redact, marked);
  // Cut inside this object: its shape cannot be seen whole, so every
  // prose-keyed field it got as far as goes.
  if (!n.closed) {
    for (const [k, v] of n.entries) {
      if (!PROSE_KEY_SET.has(k)) continue;
      if (v.k === "str") marked.add(v);
      else if (v.k === "arr") for (const r of v.items) if (r.k === "str") marked.add(r);
    }
  }
  for (const child of n.children) markProse(child, s, marked);
}

/**
 * Every structure in `s` read in place: prose fields by shape replaced, every
 * other string literal walked as a string value (JSON inside it, an option
 * list), and nothing else touched. `cut` says the text ended inside one.
 */
function redactInspected(s: string): { text: string; cut: boolean } {
  if (!/[{["]/.test(s)) return { text: s, cut: false };
  const reader = new InspectReader(s);
  const marked = new Set<StrNode>();
  const start = /[{["]/g;
  while (reader.i < s.length) {
    start.lastIndex = reader.i;
    const m = start.exec(s);
    if (m === null) break;
    reader.i = m.index;
    const node = reader.value();
    if (reader.i <= m.index) reader.i = m.index + 1;
    markProse(node, s, marked);
  }
  const edits: { start: number; end: number; text: string }[] = [];
  for (const n of reader.strings) {
    if (marked.has(n)) {
      edits.push({ start: n.start, end: n.end, text: n.closed ? `"${REDACTED_PROSE}"` : `"${REDACTED_PROSE}` });
      continue;
    }
    if (!n.closed) continue;
    const v = decodeLiteral(s.slice(n.start, n.end));
    const r = v === undefined ? undefined : redactIfProse(v);
    if (r !== undefined) edits.push({ start: n.start, end: n.end, text: JSON.stringify(r) });
  }
  if (edits.length === 0) return { text: s, cut: reader.cut };
  let out = "";
  let at = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    out += s.slice(at, e.start) + e.text;
    at = e.end;
  }
  return { text: out + s.slice(at), cut: reader.cut };
}

/** `#12 SMSG_X [schema mismatch] {...} — note` as `formatEventLine` writes it. */
const EVENT_LINE = /^(#(?:\d+|gap) )([A-Z_]+)((?: \[schema mismatch\])? )(\{.*)$/;

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

/** Redact a single `recent_events` line; anything else comes back unchanged. */
function redactEventLine(line: string): string {
  const m = EVENT_LINE.exec(line);
  if (m === null) return line;
  const [, tag, opcode, sep, rest] = m as unknown as [string, string, string, string, string];
  if (!PROSE_OPCODES.has(opcode)) return line;
  // The payload runs to the last `}` on the line; a client-facing note may follow it.
  const end = rest.lastIndexOf("}");
  const json = end === -1 ? rest : rest.slice(0, end + 1);
  const tail = end === -1 ? "" : rest.slice(end + 1);
  const parsed = tryParse(json);
  if (!isRecord(parsed)) {
    // Compacted mid-payload (`… `) or otherwise unparseable: the whole payload
    // of a prose-carrying opcode goes, since which field was cut is unknowable.
    return `${tag}${opcode}${sep}${REDACTED_PROSE}`;
  }
  return `${tag}${opcode}${sep}${JSON.stringify(redactProseValue(redactOpcodeData(opcode, parsed)))}${tail}`;
}

/** A sandbox console line, as `run_snippet` renders it. */
const CONSOLE_LINE = /^(\[(?:log|info|warn|error|debug)\] )(.*)$/;

/**
 * A line that continues the value on the line above it: `Bun.inspect` and
 * `JSON.stringify(v, null, 2)` indent everything inside a structure and put
 * only its closing bracket at the margin (`}`, `},`, `} ×3` for a folded
 * repeat).
 */
const CONTINUATION = /^(?:[ \t]|[}\]])/;

/**
 * Redact a tool result's text. Structure the harness itself wrote is parsed
 * (`runner/src/tools.ts`): the whole text as JSON; a snippet's `=> value`
 * and its console lines — one line of JSON, or the sandbox's multi-line
 * rendering running on through the indented lines below it, read in place
 * (`redactRendered`); `recent_events` lines by opcode; a `state_summary`'s
 * `recent chat` block (the same chat words `SMSG_MESSAGECHAT` carries); and on
 * any other line, the SDK's option lists (`redactOptionLists`). What does not
 * parse passes through — that is the documented residual.
 */
export function redactProseText(text: string): string {
  const whole = tryParse(text);
  if (whole !== undefined && typeof whole === "object" && whole !== null) {
    return JSON.stringify(redactProseValue(whole));
  }
  const lines = text.split("\n");
  const out: string[] = [];
  let inChat = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^recent chat \(\d+\):$/.test(line)) {
      inChat = true;
      out.push(line);
      continue;
    }
    if (inChat) {
      // `  [party] <name> text`, `  [whisper] to <name>: text`, `  [npc emote] text`
      // (formatChatLine), and the older `  <name> text`: the head stays, the words go.
      const chat = /^(  (?:\[[^\]\n]*\] (?:to <[^>\n]*>: |<[^>\n]*> )?|<[^>\n]*> ))(.*)$/.exec(line);
      if (chat !== null) {
        out.push(`${chat[1]}${REDACTED_PROSE}`);
        continue;
      }
      inChat = false;
    }
    if (line.startsWith("#")) {
      out.push(redactEventLine(line));
      continue;
    }
    const head = line.startsWith("=> ") ? "=> " : CONSOLE_LINE.exec(line)?.[1];
    if (head === undefined) {
      out.push(redactOptionLists(line));
      continue;
    }
    let end = i + 1;
    while (end < lines.length && CONTINUATION.test(lines[end]!)) end++;
    const payload = [line.slice(head.length), ...lines.slice(i + 1, end)].join("\n");
    // One line keeps the JSON reading it always had; a multi-line rendering
    // is read in place, so its layout survives.
    out.push(`${head}${end === i + 1 ? redactProseString(payload) : redactRendered(payload)}`);
    i = end - 1;
  }
  return out.join("\n");
}

/**
 * The reference tool's result is wiki text — "Never" published
 * (docs/DATA-AND-LEGAL.md), so the whole body goes, not just prose fields.
 */
const WITHHELD_TOOLS: ReadonlySet<string> = new Set(["search_reference"]);

/**
 * One entry, with its game prose redacted. Pure: returns a new object.
 *
 * Only three things are touched. `events` (a raw `events_served` batch, when
 * an entry still carries one) is walked as decoded payloads; a
 * `snippet_result` / `tool_result` `text` is parsed as above; and an `actions`
 * record's note `hint`, which is the SDK's sentence and can carry its option
 * list, loses the option text. Every other field — the model's turn text, its
 * snippet code, harness notices — is the model's or the harness's own writing
 * and passes verbatim.
 */
export function redactGameProse<T extends EntrySummary>(entry: T): T {
  let out: Record<string, unknown> = entry;
  if (Array.isArray(out["events"])) out = { ...out, events: redactProseValue(out["events"]) };
  if ((entry.t === "snippet_result" || entry.t === "tool_result") && typeof out["text"] === "string") {
    const name = typeof out["name"] === "string" ? out["name"] : "";
    out = { ...out, text: WITHHELD_TOOLS.has(name) ? REDACTED_PROSE : redactProseText(out["text"]) };
  }
  if (entry.t === "actions" && Array.isArray(out["actions"])) {
    out = {
      ...out,
      actions: (out["actions"] as unknown[]).map((n) =>
        isRecord(n) && typeof n["hint"] === "string" ? { ...n, hint: redactOptionLists(n["hint"]) } : n,
      ),
    };
  }
  return out as T;
}
