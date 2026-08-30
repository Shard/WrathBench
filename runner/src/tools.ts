/**
 * The nine Phase-0 tools, defined once and dispatched from two places: the MCP
 * server (external model drives them over stdio) and the agent loop (the
 * OpenAI-compatible adapter drives them in-process). Schemas are deliberately
 * tight — few parameters, all described — because a confused tool call costs a
 * live-world turn.
 */

import { z } from "zod";
import type { Database } from "bun:sqlite";
import { parseIdQuery, searchReference } from "@wrathbench/wiki/search";
import { bundleHasIds } from "@wrathbench/wiki/bundle";
import { CONTEXT_POLICY, formatEventLine, formatStateSummary, type SnapshotLike } from "./context";
import { EPISODIC_PAGE_DEFAULT, EPISODIC_PAGE_MAX, type EpisodicEntry, type EpisodicLog } from "./episodic";
import { READ_LOG_CLOSED, restingOf, type ReflectGate } from "./reflect";
import type { ActionHintNote, EventSummary } from "./sandbox/ipc";
import type { SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema, for MCP and OpenAI tools
}

/**
 * The one sentence of the `search_reference` description that depends on the
 * run's `wikiCoords` dimension. Model-agnostic and fixed per
 * value, so a model never searches for numbers a names-first run withholds,
 * and a coords run is told what the numbers are (reference notes, not a
 * live observation).
 */
export const WIKI_COORDS_SENTENCE = {
  withheld:
    "This run serves no coordinates: results name places, zones and NPCs but carry no map x/y, so do not search for numbers — find things by name, by asking NPCs, and by looking.",
  served:
    "Some hits carry wiki-recorded coordinates (zone plus map x/y); these are reference notes from the wiki page, not a live observation and not proof anything is at that spot now.",
} as const;

/**
 * The standing era sentence on `search_reference`, fixed for every run.
 *
 * The bundle is built from the Wrath-era revisions of a 2020 dump and drops
 * what it can identify as later, so the tool no longer warns about
 * labels in the result text — there are none. What it still cannot catch is a
 * 2010 page describing an announced expansion without naming it, which is why
 * "prefer what you can observe in game" stays.
 */
export const WIKI_ERA_SENTENCE =
  "The reference bundle is a snapshot of the wiki from the Wrath of the Lich King era (patch 3.3.5a) and describes this world, so prefer what you can observe in game.";

/**
 * The tool list for a run: `TOOLS` with the `search_reference` description
 * stating whether coordinates are served. `TOOLS` itself is the names-first
 * (default) rendering.
 */
export function toolsFor(opts: { wikiCoords?: boolean | undefined }): ToolDef[] {
  if (opts.wikiCoords !== true) return TOOLS;
  return TOOLS.map((t) =>
    t.name === "search_reference"
      ? { ...t, description: t.description.replace(WIKI_COORDS_SENTENCE.withheld, WIKI_COORDS_SENTENCE.served) }
      : t,
  );
}

export const TOOLS: ToolDef[] = [
  {
    name: "run_snippet",
    description:
      "Execute a TypeScript snippet in the persistent game sandbox. Top-level bindings persist across snippets; `sdk`, `state`, `events`, `connect()`, `sleep(ms)`, `scratchpad` and `signal` (aborted if this snippet is abandoned) are ambient. A single expression returns its value. This is the only way to act in the world.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "TypeScript source to evaluate." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "recent_events",
    description:
      "Return the most recent game events (server packets as JSON), oldest first. Use after acting to see what the server said. Ambient movement packets (SMSG_MONSTER_MOVE, MSG_MOVE_*) are folded out by default — they fold into cached state instead, and a trailing note says how many were dropped. Pass includeMovement: true for the raw stream.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "How many events to return, counted AFTER the movement fold. Default 50.",
        },
        includeMovement: {
          type: "boolean",
          description:
            "Include ambient movement packets (SMSG_MONSTER_MOVE, MSG_MOVE_*). Default false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "state_summary",
    description:
      "A formatted summary of the cached game state: character, level, position, recent chat and notifications, stream continuity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_reference",
    description:
      "Full-text search over the game reference wiki (quests, NPCs, zones, items, mechanics). Query with a page title or a few keywords, not a sentence. " +
      "A quest page's result leads with what its infobox states — which NPC starts the quest and which NPC it is turned in to; these are often different NPCs, and when the page does not state an ender the line says so rather than implying the giver. " +
      WIKI_ERA_SENTENCE +
      " " +
      WIKI_COORDS_SENTENCE.withheld,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Title or keywords, e.g. 'Northshire quests'." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max results. Default 8." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_scratchpad",
    description: "Read your persistent markdown scratchpad for this run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "write_scratchpad",
    description:
      "Replace the entire scratchpad with new markdown. Keep it current: plan, progress, durable facts. It survives restarts; conversation history does not.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The full new scratchpad content (markdown)." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "reflect",
    description:
      "Spend this turn thinking instead of acting. Returns a fixed set of questions to review your own record against; " +
      "nothing is summarised for you and nothing is remembered unless you write it to the scratchpad. " +
      "Available only while your character is resting — the state summary shows `resting` when it applies — and once per rest visit.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "log_status",
    description:
      "Append one short status entry — what you are doing and how it is going — to your episodic log. " +
      "The log is append-only: each entry is stamped with the turn, your level and your zone, and nothing can edit or remove it afterwards. " +
      "It is not the scratchpad. Entries are read back with read_log while reflecting.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The entry text." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "read_log",
    description:
      "Page your episodic log, oldest first. Usable only while reflecting — see the reflect tool. " +
      `Returns "showing a-b of N" and one line per entry.`,
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "integer", minimum: 0, description: "Entries to skip from the oldest. Default 0." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: EPISODIC_PAGE_MAX,
          description: `How many entries to return. Default ${EPISODIC_PAGE_DEFAULT}.`,
        },
      },
      additionalProperties: false,
    },
  },
];

// Strict on purpose: the advertised inputSchema says `additionalProperties:
// false`, and a plain z.object would silently *strip* unknown keys — a model
// that sent { snippet: "..." } got an empty object and a confusing "code
// required" instead of being told about its unknown key. Aliases are
// normalized (normalizeToolArgs) BEFORE this validation runs.
/**
 * Booleanish, deterministically — repair only the deterministic. NOT
 * z.coerce.boolean(): that is JS truthiness, so the string "false" — which
 * models do send — would read true.
 */
const booleanish = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((v) =>
    typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : /^(true|1|yes|on)$/i.test(v.trim()),
  );

const argSchemas = {
  run_snippet: z.strictObject({ code: z.string().min(1) }),
  recent_events: z
    .strictObject({
      // Lenient by declaration ("How many events", 1-200): coerce numeric
      // strings and clamp to the documented range rather than refusing.
      limit: z.coerce
        .number()
        .transform((n) => Math.min(200, Math.max(1, Math.round(n))))
        .default(50),
      includeMovement: booleanish.default(false),
    })
    // `.prefault({})`, not `.default({ limit: 50 })`: a `default` value is
    // returned as-is, so naming only some fields would pin the rest out of
    // existence; a prefault re-parses `{}` and lets the field defaults run.
    .prefault({}),
  state_summary: z.strictObject({}).default({}),
  search_reference: z.strictObject({
    query: z.string().min(1),
    limit: z.coerce
      .number()
      .transform((n) => Math.min(20, Math.max(1, Math.round(n))))
      .default(8),
  }),
  read_scratchpad: z.strictObject({}).default({}),
  write_scratchpad: z.strictObject({ content: z.string() }),
  reflect: z.strictObject({}).default({}),
  log_status: z.strictObject({ text: z.string().min(1) }),
  // Lenient by declaration, like `recent_events`: a clamped page is an answer,
  // and a validation error inside a reflection window costs a turn of it.
  read_log: z
    .strictObject({
      offset: z.coerce
        .number()
        .transform((n) => Math.max(0, Math.round(n)))
        .default(0),
      limit: z.coerce
        .number()
        .transform((n) => Math.min(EPISODIC_PAGE_MAX, Math.max(1, Math.round(n))))
        .default(EPISODIC_PAGE_DEFAULT),
    })
    .prefault({}),
} as const;

/** Prose restatement of each tool's parameters, for validation error replies. */
const TOOL_PARAM_HELP: Record<keyof typeof argSchemas, string> = {
  run_snippet: "run_snippet expects { code: string } — the TypeScript source to evaluate.",
  recent_events:
    "recent_events expects { limit?: number, includeMovement?: boolean } — how many events to return " +
    "(1-200, default 50, counted after ambient movement is folded out), and whether to include ambient " +
    "movement packets (SMSG_MONSTER_MOVE, MSG_MOVE_*; default false). includeMovement is new: it used to " +
    "serve every packet unconditionally.",
  state_summary: "state_summary takes no parameters ({}).",
  search_reference:
    "search_reference expects { query: string, limit?: number } — title or keywords, and max results 1-20 (default 8).",
  read_scratchpad: "read_scratchpad takes no parameters ({}).",
  write_scratchpad: "write_scratchpad expects { content: string } — the full new scratchpad markdown.",
  reflect: "reflect takes no parameters ({}).",
  log_status: "log_status expects { text: string } — one short status entry.",
  read_log:
    `read_log expects { offset?: number, limit?: number } — entries to skip from the oldest (default 0) ` +
    `and how many to return (1-${EPISODIC_PAGE_MAX}, default ${EPISODIC_PAGE_DEFAULT}).`,
};

/**
 * Alias keys models actually sent, mapped to the canonical parameter. Applied
 * only when the canonical key is absent, and before strict validation.
 */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  run_snippet: { cmd: "code", snippet: "code", source: "code", script: "code", ts: "code" },
  write_scratchpad: { text: "content", markdown: "content" },
  log_status: { content: "text", status: "text", entry: "text", note: "text" },
  read_log: { start: "offset", count: "limit", n: "limit" },
  recent_events: { include_movement: "includeMovement", includemovement: "includeMovement" },
  search_reference: { q: "query" },
};

/** Rename known alias keys to their canonical names. Deterministic, model-agnostic. */
export function normalizeToolArgs(name: string, args: unknown): unknown {
  const aliases = ARG_ALIASES[name];
  if (aliases === undefined || args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const obj = { ...(args as Record<string, unknown>) };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in obj && !(canonical in obj)) {
      obj[canonical] = obj[alias];
      delete obj[alias];
    }
  }
  return obj;
}

/**
 * Strip trailing commas before `}` or `]`, but ONLY outside JSON string
 * literals. A naive global regex (the previous implementation) also rewrote
 * `,}`/`,]` sequences that occur *inside* a string value — so when the outer
 * JSON needed repair, a snippet whose `code` string contained e.g. `', ]'`
 * had that string silently mutated before execution, falsifying the trajectory.
 * A one-pass tokenizer that tracks whether we are inside a string (and honours
 * backslash escapes) keeps the repair to structural commas only.
 */
export function stripTrailingCommas(s: string): string {
  let out = "";
  let inString = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Look past whitespace: if the next non-space char closes an object or
      // array, this comma is trailing — drop it, keep the whitespace.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) {
        continue; // skip the comma; whitespace emits on its own iterations
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Parse a tool-arguments *string* leniently, in this order: (a) plain
 * JSON.parse; (b) strip one wrapping markdown code fence and re-parse; (c) one
 * conservative repair pass — trailing commas before `}` or `]`, outside string
 * literals — and re-parse. On final failure the error echoes what was received.
 */
export function parseToolArgsText(raw: string): { ok: true; args: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, args: {} };
  const candidates: string[] = [trimmed];
  const fence = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  for (const c of [...candidates]) {
    const repaired = stripTrailingCommas(c);
    if (repaired !== c) candidates.push(repaired);
  }
  let lastError: unknown;
  for (const c of candidates) {
    try {
      return { ok: true, args: JSON.parse(c) };
    } catch (e) {
      lastError = e;
    }
  }
  return {
    ok: false,
    error: `tool arguments were not valid JSON (${String(lastError)}); received: ${trimmed.slice(0, 200)}`,
  };
}

/**
 * The one entry point drivers use for raw tool arguments (string or object).
 * A string is parsed leniently; the final failure message restates the tool's
 * expected parameters in prose.
 */
export function coerceToolArgs(
  name: string,
  raw: unknown,
): { ok: true; args: unknown } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: true, args: raw };
  const parsed = parseToolArgsText(raw);
  if (parsed.ok) return parsed;
  const help = isKnownTool(name) ? ` ${TOOL_PARAM_HELP[name]}` : "";
  return { ok: false, error: `${parsed.error}.${help}` };
}

const VALID_TOOL_NAMES = TOOLS.map((t) => t.name);

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        tmp + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** Nearest valid tool for a misspelled/mangled name, or undefined. */
export function nearestTool(name: string): string | undefined {
  // Mangled-but-containing first: observed "connect()<tool_call>run_snippet".
  const contained = VALID_TOOL_NAMES.find((n) => name.includes(n));
  if (contained !== undefined) return contained;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const n of VALID_TOOL_NAMES) {
    const d = levenshtein(name.toLowerCase(), n);
    if (d < bestDistance) {
      bestDistance = d;
      best = n;
    }
  }
  return bestDistance <= 3 ? best : undefined;
}

/** Zod issues as sentences a model can act on, never raw issue arrays. */
function renderIssues(name: keyof typeof argSchemas, error: z.ZodError): string {
  const props = (TOOLS.find((t) => t.name === name)?.inputSchema["properties"] ?? {}) as Record<string, unknown>;
  const valid = Object.keys(props);
  return error.issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") {
        const keys = (issue as { keys: string[] }).keys.map((k) => `"${k}"`).join(", ");
        return `unknown key(s) ${keys} — valid keys for ${name}: ${valid.length > 0 ? valid.join(", ") : "(none)"}`;
      }
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * How much wider than `limit` recent_events scans so the fold still returns
 * `limit` signal events. Measured on gate2-ox-1: ambient movement was ~85% of
 * the stream, so 8x covers the observed worst case; the cap is the SDK's
 * retained event buffer (EventStream bufferSize, default 500).
 */
const RECENT_EVENTS_SCAN_FACTOR = 8;
const RECENT_EVENTS_SCAN_MAX = 500;

/**
 * Per-episode memory of what has already been searched.
 *
 * laguna issued 11 searches and nemotron 13 near-identical ones inside a single
 * episode, reading the same list each time as if it were new (FOLLOW-UPS 25).
 * The memo says so in the result: same query, this many tool calls ago, and
 * whether anything actually changed.
 *
 * Keyed on the ToolContext, which is constructed once per episode by the loop,
 * the claude driver and the MCP server alike — so this state lives exactly as
 * long as the episode and is never written to disk. A restarted episode starts
 * with an empty memo, which is the honest thing: the model's context restarted
 * with it.
 */
interface SearchMemoEntry {
  /** Tool-call ordinal of the last time this query was asked. */
  at: number;
  /** How many times it has been asked this episode. */
  count: number;
  /** Top titles it returned, for the "did anything change" comparison. */
  titles: string[];
}

interface EpisodeToolState {
  /** Tool calls dispatched this episode; the memo's unit of elapsed activity. */
  calls: number;
  searches: Map<string, SearchMemoEntry>;
}

const EPISODE_STATE = new WeakMap<ToolContext, EpisodeToolState>();

function episodeState(ctx: ToolContext): EpisodeToolState {
  let state = EPISODE_STATE.get(ctx);
  if (state === undefined) {
    state = { calls: 0, searches: new Map() };
    EPISODE_STATE.set(ctx, state);
  }
  return state;
}

/** Case, punctuation and whitespace are not what makes two searches different. */
export function normalizeSearchQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How many titles the memo remembers and quotes back. */
const MEMO_TITLES = 3;

/**
 * The repeat note, or undefined the first time a query is asked. Records the
 * new result either way. A signal, not a lecture: at most two lines.
 */
function searchRepeatNote(ctx: ToolContext, query: string, titles: string[]): string | undefined {
  const state = episodeState(ctx);
  const key = normalizeSearchQuery(query);
  const top = titles.slice(0, MEMO_TITLES);
  const previous = state.searches.get(key);
  state.searches.set(key, {
    at: state.calls,
    count: (previous?.count ?? 0) + 1,
    titles: top,
  });
  if (previous === undefined) return undefined;
  const ago = Math.max(0, state.calls - previous.at);
  const times = previous.count === 1 ? "" : ` (${previous.count + 1} times this episode)`;
  const head =
    `note: you already ran this search ${ago} tool call${ago === 1 ? "" : "s"} ago${times}.`;
  const same =
    previous.titles.length === top.length && previous.titles.every((t, i) => t === top[i]);
  const list = (ts: string[]): string => (ts.length === 0 ? "(no results)" : ts.join("; "));
  return same
    ? `${head} Same top results: ${list(top)}.`
    : `${head} The results changed — then: ${list(previous.titles)}; now: ${list(top)}.`;
}

export interface ToolContext {
  sandbox: SandboxHost;
  scratchpad: Scratchpad;
  /** Wiki bundle; absent means search_reference reports unavailability. */
  wiki?: Database | undefined;
  /**
   * Whether search_reference serves wiki-recorded coordinates.
   * Absent reads as false: names-first is the default everywhere.
   */
  wikiCoords?: boolean | undefined;
  /** Whether a game session has been established (for the summary header). */
  sessionLive: () => boolean;
  /**
   * The episode's reflection gate. Required, not optional: every dispatcher
   * builds one context per episode, and a missing gate would leave `reflect`
   * with a silent no-gate branch that behaves differently per driver.
   */
  reflect: ReflectGate;
  /** The run's append-only episodic log (`log_status` / `read_log`). */
  episodic: EpisodicLog;
  /** The driver turn in flight, stamped onto every episodic entry. */
  turn: () => number;
  /**
   * Called with every event batch actually served to the model (the visible
   * ones), plus how many ambient movement events were folded out of that span.
   */
  onEventsServed?: (events: unknown[], folded?: number) => void;
  /** Called with every episodic entry written, so the driver can log it. */
  onEpisodicEntry?: (entry: EpisodicEntry) => void;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export function isKnownTool(name: string): name is keyof typeof argSchemas {
  return name in argSchemas;
}

/**
 * How much of one snippet result the harness may spend on hints, and how much
 * of one hint. Both are caps, not budgets to fill: the common turn shows one
 * group of one line.
 */
export const ACTION_HINT_RENDER = {
  MAX_GROUPS: 4,
  MAX_HINT_CHARS: 320,
} as const;

/**
 * Render the SDK's hint-bearing failures for the model, or undefined when there
 * were none.
 *
 * This is the delivery the principle asks for: the hint is already in the
 * result object, but a snippet that reduces a result to `.status` throws it
 * away before the model reads it (run a11: 41 `too_far`, hint read 0 times), so
 * the harness puts it in the snippet result itself — the one place both drivers
 * share, and one the model's own code cannot strip. Rendered here rather than
 * in the turn's context block because a claude-code turn is a whole CLI
 * session: a context notice would arrive a turn late, which is the follow-up
 * inspection the principle forbids.
 *
 * Nothing is added to the hint strings. Grouping is the SDK's (action, status)
 * tally, so a status that failed 21 times costs one line and a count.
 */
export function renderActionHints(hints: readonly ActionHintNote[]): string | undefined {
  if (hints.length === 0) return undefined;
  // Most recent first. Nothing here reacts to how often a status failed — the
  // count is only the collapse marker for repeats of one hint, and no rendering
  // or ordering decision reads it.
  const ordered = [...hints].sort((a, b) => b.ts - a.ts || a.status.localeCompare(b.status));
  const shown = ordered.slice(0, ACTION_HINT_RENDER.MAX_GROUPS);
  const lines = ["--- harness ---"];
  for (const h of shown) {
    const hint =
      h.hint.length > ACTION_HINT_RENDER.MAX_HINT_CHARS
        ? `${h.hint.slice(0, ACTION_HINT_RENDER.MAX_HINT_CHARS - 1).trimEnd()}…`
        : h.hint;
    lines.push(`${h.action} ${h.status}${h.count > 1 ? ` ×${h.count}` : ""}: ${hint}`);
  }
  const rest = ordered.length - shown.length;
  if (rest > 0) lines.push(`(+${rest} other failure ${rest === 1 ? "status" : "statuses"} this snippet)`);
  return lines.join("\n");
}

/** Dispatch one tool call. Never throws: errors come back as `isError` text. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  const state = episodeState(ctx);
  state.calls++;
  try {
    if (!isKnownTool(name)) {
      const suggestion = nearestTool(name);
      return {
        text:
          `unknown tool: ${name}. Valid tools: ${VALID_TOOL_NAMES.join(", ")}.` +
          (suggestion !== undefined ? ` Did you mean ${suggestion}?` : ""),
        isError: true,
      };
    }
    const normalized = normalizeToolArgs(name, args ?? {});
    const parsed = argSchemas[name].safeParse(normalized);
    if (!parsed.success) {
      const received = JSON.stringify(normalized)?.slice(0, 200) ?? String(normalized).slice(0, 200);
      return {
        text:
          `invalid arguments for ${name}: ${renderIssues(name, parsed.error)}. ` +
          `Received: ${received}. ${TOOL_PARAM_HELP[name]}`,
        isError: true,
      };
    }

    switch (name) {
      case "run_snippet": {
        const { code } = parsed.data as { code: string };
        const res = await ctx.sandbox.evalSnippet(code);
        const lines: string[] = [];
        lines.push(res.ok ? `ok (${res.durationMs}ms)` : `error (${res.durationMs}ms)`);
        if (res.value !== undefined) lines.push(`=> ${res.value}`);
        if (res.hint !== undefined) lines.push(res.hint);
        if (res.error !== undefined) lines.push(res.error);
        if (res.logs.length > 0) {
          lines.push("--- console ---");
          for (const l of res.logs) lines.push(`[${l.level}] ${l.text}`);
        }
        // Last, and on a successful snippet too: a11's snippets returned `ok`
        // while swallowing 41 hints, so this is the main case, not the edge.
        const hints = renderActionHints(res.actionHints ?? []);
        if (hints !== undefined) lines.push(hints);
        return { text: lines.join("\n"), isError: !res.ok };
      }
      case "recent_events": {
        const { limit, includeMovement } = parsed.data as { limit: number; includeMovement: boolean };
        if (includeMovement) {
          const events = await ctx.sandbox.recentEvents(limit);
          ctx.onEventsServed?.(events, 0);
          if (events.length === 0) return { text: "no events yet" };
          return { text: events.map(formatEventLine).join("\n") };
        }
        // `limit` counts SIGNAL events, so scan a wider span and fold within it.
        const scan = Math.min(RECENT_EVENTS_SCAN_MAX, limit * RECENT_EVENTS_SCAN_FACTOR);
        const scanned = (await ctx.sandbox.recentEvents(scan)) as EventSummary[];
        const ambient = (e: EventSummary): boolean =>
          CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(e.opcode);
        const visible = scanned.filter((e) => !ambient(e)).slice(-limit);
        // The span the reply covers. When `limit` truncated the signal events,
        // it starts at the oldest visible one — reporting ambient events from
        // before it would credit the note with a span the reply never showed.
        // When it did not, the reply is everything there was, so the span is
        // the whole scan and leading ambient events still get counted (an
        // all-movement buffer must say so, not silently look empty).
        const spanStart =
          visible.length < limit ? 0 : scanned.indexOf(visible[0]!);
        const folded = scanned.slice(spanStart).filter(ambient).length;
        ctx.onEventsServed?.(visible, folded);
        const note =
          folded === 0
            ? undefined
            : `(+${folded} ambient movement events folded into state — pass {includeMovement: true} for the raw stream)`;
        if (visible.length === 0) {
          return { text: note === undefined ? "no events yet" : `no non-movement events yet\n${note}` };
        }
        const lines = visible.map(formatEventLine);
        if (note !== undefined) lines.push(note);
        return { text: lines.join("\n") };
      }
      case "state_summary": {
        const snapshot = (await ctx.sandbox.stateSnapshot()) as SnapshotLike;
        // Liveness from the snapshot just fetched, not the loop's per-turn
        // flag: claude-driver turns span many tool calls and the stale flag
        // contradicted the populated character data next to it.
        const live = (snapshot as { self?: { guid?: unknown } }).self?.guid != null;
        return { text: formatStateSummary(snapshot, { sessionLive: live }) };
      }
      case "search_reference": {
        const { query, limit } = parsed.data as { query: string; limit: number };
        if (ctx.wiki === undefined) {
          return { text: "reference bundle unavailable (data/wiki/bundle.sqlite not found)", isError: true };
        }
        const hits = searchReference(ctx.wiki, query, { limit, coords: ctx.wikiCoords === true });
        const note = searchRepeatNote(ctx, query, hits.map((h) => h.title));
        const prefix = note === undefined ? "" : `${note}\n\n`;
        if (hits.length === 0) {
          // An id query the bundle cannot answer says why, rather than letting
          // the model read "no results" as "no such quest".
          const asked = parseIdQuery(query).ids;
          let why = "";
          if (asked.length > 0) {
            const named = asked
              .map((e) => `${e.kind === undefined ? "id" : `${e.kind} id`} ${e.id}`)
              .join(", ");
            why = bundleHasIds(ctx.wiki)
              ? ` (no page in the reference records ${named}; the wiki does not state an id for every entity, so this is not evidence that it does not exist)`
              : " (this reference bundle has no entity-id index — ids resolve only after it is rebuilt)";
          }
          return { text: `${prefix}no results${why}` };
        }
        return {
          text:
            prefix +
            hits
            .map((h) => {
              const via = h.redirectedFrom !== undefined ? ` (redirected from ${h.redirectedFrom})` : "";
              const coordLine =
                h.coords !== undefined && h.coords.length > 0
                  ? `\nwiki coords (reference, not live): ${h.coords
                      .map((c) => `${c.zone !== undefined ? `${c.zone} ` : ""}(${c.x}, ${c.y})`)
                      .join("; ")}`
                  : "";
              const idLine =
                h.matchedId !== undefined
                  ? `\nmatched ${h.matchedId.kind} id ${h.matchedId.id}`
                  : "";
              return `# ${h.title}${via}${idLine}\n${h.snippet}${coordLine}`;
            })
            .join("\n\n"),
        };
      }
      case "reflect": {
        // Sample the world first, exactly as `state_summary` does: the gate is
        // also fed by the context builder's own samples, but a model that walks
        // into an inn and reflects in the same turn should not have to wait for
        // the next tick to be believed.
        try {
          const snapshot = (await ctx.sandbox.stateSnapshot()) as SnapshotLike;
          ctx.reflect.note(restingOf(snapshot));
        } catch {
          // A sandbox mid-restart tells us nothing new; the gate keeps the last
          // reading it was fed, which is the honest state of the observation.
        }
        const answer = ctx.reflect.request();
        if (answer.isError === true) return answer;
        // The count only; the entries themselves come from `read_log`. Omitted
        // when the log is empty so it never advertises a page that is not there.
        const n = ctx.episodic.count;
        return n === 0
          ? answer
          : {
              text: `${answer.text}\n\n${n} status ${n === 1 ? "entry" : "entries"} in your episodic log; read them with read_log.`,
            };
      }
      case "log_status": {
        const { text } = parsed.data as { text: string };
        const snapshot = (await ctx.sandbox.stateSnapshot().catch(() => null)) as SnapshotLike | null;
        const level = snapshot?.self?.level?.value;
        const zone = (snapshot?.self?.zone?.value as { name?: unknown } | undefined)?.name;
        // The stamps are the harness's observation, never the model's claim:
        // it supplies the text and nothing else.
        const entry = ctx.episodic.append({
          turn: ctx.turn(),
          ...(typeof level === "number" ? { level } : {}),
          ...(typeof zone === "string" ? { zone } : {}),
          text,
        });
        ctx.onEpisodicEntry?.(entry);
        return { text: `logged (entry ${ctx.episodic.count}, ${entry.text.length} chars)` };
      }
      case "read_log": {
        if (!ctx.reflect.isOpen) return { text: READ_LOG_CLOSED, isError: true };
        const { offset, limit } = parsed.data as { offset: number; limit: number };
        return { text: ctx.episodic.page(offset, limit) };
      }
      case "read_scratchpad": {
        const content = ctx.scratchpad.read();
        return { text: content.length === 0 ? "(scratchpad is empty)" : content };
      }
      case "write_scratchpad": {
        const { content } = parsed.data as { content: string };
        const res = ctx.scratchpad.write(content);
        return {
          text: res.truncated
            ? `written (${res.chars} chars, TRUNCATED at cap — keep it shorter)`
            : `written (${res.chars} chars)`,
        };
      }
    }
  } catch (err) {
    return { text: `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
