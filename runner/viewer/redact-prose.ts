/**
 * Game-prose redaction for published trajectory entries.
 *
 * The rule (docs/DATA-AND-LEGAL.md, "Trajectory logs", operator 2026-08-30):
 * published trajectories keep names — items, quests, NPCs, zones, spells — and
 * ids; game PROSE — quest, gossip, item and mail body text — is redacted.
 *
 * Prose is found by SHAPE, never by looking at the words. Every field below
 * is enumerated from `sdk/src/protocol.ts`: the opcode whose decoded payload
 * carries it, and the discriminating keys that identify the same payload when
 * it turns up unwrapped — a snippet returning `state.lastGossip(guid)`, or a
 * `sdk.quest.details()` result — inside a tool result. A title is a name and
 * stays; a `details`, `objectives`, `greeting`, gossip option `text`, item
 * `description`, page/letter `text` or mail `body` goes.
 *
 * Three surfaces carry decoded payloads into an entry:
 * - `events_served` batches (`events[].data`, keyed by `events[].opcode`);
 * - tool results whose text IS JSON (a snippet's `=> {...}` line, or a value
 *   the model serialised);
 * - the `recent_events` tool's line format, `#<seq> <OPCODE> <json>`, where the
 *   json may be cut short by the harness's own compaction — an uncuttable
 *   payload of a prose-carrying opcode is replaced whole.
 *
 * What this cannot see is the residual, and docs/PUBLIC-DASHBOARD.md states
 * it: text the MODEL wrote (its turn text, snippet code, scratchpad, episodic
 * log, console.log lines) may quote game prose and is published as written.
 */

import type { EntrySummary } from "./api-types";

/** The placeholder a redacted value leaves behind, so its absence is visible. */
export const REDACTED_PROSE = "[redacted]";

/**
 * One prose-carrying payload: how to recognise it, and which of its fields go.
 *
 * `opcode` names the wrapped form (`{opcode, data}`, as an event batch carries
 * it). `keys` are the fields that together identify the unwrapped form — all
 * must be present. `redact` are paths into the payload: a bare key, or
 * `list[].key` for a field on every element of an array.
 */
export interface ProseShape {
  opcode: string | null;
  keys: readonly string[];
  redact: readonly string[];
}

/**
 * Enumerated from `sdk/src/protocol.ts`. Names (`title`, `name`, `subject`)
 * are deliberately absent from every `redact` list.
 */
export const PROSE_SHAPES: readonly ProseShape[] = [
  // Quest template: log text. `title` stays; `requiredNpcOrGo[].text` is the
  // objective's own sentence.
  {
    opcode: "SMSG_QUEST_QUERY_RESPONSE",
    keys: ["questId", "title", "requiredNpcOrGo"],
    redact: ["details", "objectives", "areaDescription", "completedText", "requiredNpcOrGo[].text"],
  },
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
  // Mail bodies; the subject is a title.
  { opcode: "SMSG_MAIL_LIST_RESULT", keys: ["mails"], redact: ["mails[].body"] },
  { opcode: null, keys: ["mailId", "body"], redact: ["body"] },
  // Chat: an NPC's say/yell is game prose and the packet does not say whose
  // words they are, so every message goes (arguable → withhold).
  { opcode: "SMSG_MESSAGECHAT", keys: ["senderGuid", "message", "chatTag"], redact: ["message"] },
  // The SDK's quest-log objective row (`QuestObjective` in sdk/src/state.ts):
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

/** Every key any shape above redacts, for the cut-fragment fallback. */
export const PROSE_KEYS: readonly string[] = [
  ...new Set(PROSE_SHAPES.flatMap((s) => s.redact.map((path) => path.slice(path.lastIndexOf(".") + 1)))),
];

/**
 * A cut JSON fragment: `{"` or its escaped form, somewhere in the string. A
 * model's own `.slice(0, 500)` over a stringified batch is the usual cause.
 */
const JSON_ISH = /[{[]\s*\\*"/;

/** `"details":"` at any escape depth — `\"details\":\"` one level down, and so on. */
const CUT_PROSE = new RegExp(`(\\\\*)"(?:${PROSE_KEYS.join("|")})\\1":\\1"`);

/**
 * A string value: JSON inside it is walked; a JSON-ish fragment that will not
 * parse (cut mid-payload) is redacted from its first prose key to the end,
 * since which fields the cut left open is unknowable; anything else is the
 * model's or the harness's own text and passes.
 */
function redactProseString(s: string): string {
  const parsed = tryParse(s);
  if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
    return JSON.stringify(redactProseValue(parsed));
  }
  if (typeof parsed === "string") return JSON.stringify(redactProseString(parsed));
  if (parsed !== undefined || !JSON_ISH.test(s)) return s;
  const m = CUT_PROSE.exec(s);
  return m === null ? s : `${s.slice(0, m.index + m[0].length)}${REDACTED_PROSE}`;
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
 * Redact a tool result's text. Structure the harness itself wrote is parsed
 * (`runner/src/tools.ts`): the whole text as JSON; a snippet's `=> value`
 * line and its console lines as JSON (strings included, see
 * `redactProseString`); `recent_events` lines by opcode; a `state_summary`'s
 * `recent chat` block (the same chat words `SMSG_MESSAGECHAT` carries). What
 * does not parse passes through — that is the documented residual.
 */
export function redactProseText(text: string): string {
  const whole = tryParse(text);
  if (whole !== undefined && typeof whole === "object" && whole !== null) {
    return JSON.stringify(redactProseValue(whole));
  }
  let inChat = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^recent chat \(\d+\):$/.test(line)) {
        inChat = true;
        return line;
      }
      if (inChat) {
        const chat = /^(  <[^>]*> )(.*)$/.exec(line);
        if (chat !== null) return `${chat[1]}${REDACTED_PROSE}`;
        inChat = false;
      }
      if (line.startsWith("#")) return redactEventLine(line);
      if (line.startsWith("=> ")) return `=> ${redactProseString(line.slice(3))}`;
      const con = CONSOLE_LINE.exec(line);
      if (con !== null) return `${con[1]}${redactProseString(con[2]!)}`;
      return line;
    })
    .join("\n");
}

/**
 * The reference tool's result is wiki text — "Never" published
 * (docs/DATA-AND-LEGAL.md), so the whole body goes, not just prose fields.
 */
const WITHHELD_TOOLS: ReadonlySet<string> = new Set(["search_reference"]);

/**
 * One entry, with its game prose redacted. Pure: returns a new object.
 *
 * Only two things are touched. `events` (a raw `events_served` batch, when an
 * entry still carries one) is walked as decoded payloads; a `snippet_result` /
 * `tool_result` `text` is parsed as above. Every other field — the model's
 * turn text, its snippet code, harness notices — is the model's or the
 * harness's own writing and passes verbatim.
 */
export function redactGameProse<T extends EntrySummary>(entry: T): T {
  let out: Record<string, unknown> = entry;
  if (Array.isArray(out["events"])) out = { ...out, events: redactProseValue(out["events"]) };
  if ((entry.t === "snippet_result" || entry.t === "tool_result") && typeof out["text"] === "string") {
    const name = typeof out["name"] === "string" ? out["name"] : "";
    out = { ...out, text: WITHHELD_TOOLS.has(name) ? REDACTED_PROSE : redactProseText(out["text"]) };
  }
  return out as T;
}
