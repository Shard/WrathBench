/**
 * The nine tools, defined once and dispatched from two places: the MCP
 * server (external model drives them over stdio) and the agent loop (the
 * OpenAI-compatible adapter drives them in-process).
 *
 * Five are the stack's core tools (`@wrathbench/mcp`'s `coreTools`: the
 * snippet, the event and state views, the scratchpad pair), rendered here the
 * benchmark's way — its event line, its HUD, its ambient opcodes and, on a
 * driver that asks for it, the snippet delta. Four are the benchmark's own:
 * `search_reference` over the wiki bundle, and `reflect`, `log_status` and
 * `read_log` over the episodic log. All nine go through the stack's one
 * dispatcher (`ToolSet`), in the order they are served.
 */

import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  appendPendingActionHints as appendPending,
  coreTools,
  toolCallCount,
  ToolSet,
  type CallOrigin,
  type CoreToolContext,
  type ToolDef,
  type ToolResult,
  type ToolSpec,
} from "@wrathbench/mcp";
import { parseIdQuery, searchReference } from "@wrathbench/wiki/search";
import { bundleHasIds } from "@wrathbench/wiki/bundle";
import { CONTEXT_POLICY, formatEventLine, formatStateSummary, type SnapshotLike } from "./context";
import {
  EPISODIC_ORDERS,
  EPISODIC_PAGE_DEFAULT,
  EPISODIC_PAGE_MAX,
  type EpisodicEntry,
  type EpisodicLog,
  type EpisodicQuery,
} from "./episodic";
import { READ_LOG_CLOSED, restingOf, taxiFlightOf, type ReflectGate } from "./reflect";
import type { SandboxHost } from "./sandbox/host";
import { renderSnippetDelta } from "./sandbox/snippet-delta";

export {
  ACTION_HINT_RENDER,
  parseToolArgsText,
  renderActionHints,
  stripTrailingCommas,
} from "@wrathbench/mcp";
export type { CallOrigin, ToolDef, ToolResult } from "@wrathbench/mcp";

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

export interface ToolContext extends CoreToolContext {
  sandbox: SandboxHost;
  /** Wiki bundle; absent means search_reference reports unavailability. */
  wiki?: Database | undefined;
  /**
   * Whether search_reference serves wiki-recorded coordinates.
   * Absent reads as false: names-first is the default everywhere.
   */
  wikiCoords?: boolean | undefined;
  /**
   * Whether this run has `search_reference` at all (`config.wiki`). Absent
   * reads as true. False is a run configured without the reference surface, so
   * the tool is not offered and calling it answers as an unknown tool —
   * distinct from `wiki` above being undefined, which is the bundle failing to
   * load on a run that does have the tool.
   */
  wikiSearch?: boolean | undefined;
  /**
   * The episode's reflection gate. Required, not optional: every dispatcher
   * builds one context per episode, and a missing gate would leave `reflect`
   * with a silent no-gate branch that behaves differently per driver.
   */
  reflect: ReflectGate;
  /** The run's append-only episodic log (`log_status` / `read_log`). */
  episodic: EpisodicLog;
  /** Called with every episodic entry written, so the driver can log it. */
  onEpisodicEntry?: (entry: EpisodicEntry) => void;
  /**
   * The run's secret registry: the trajectory, which holds the lease secret
   * and every other value registered with it (`redact.ts`). Every result
   * `callTool` and `appendPendingActionHints` return has passed its `scrub`.
   */
  secrets: { scrub(text: string): string };
  /**
   * Whether a `run_snippet` result ends with what changed since the previous
   * one (`sandbox/snippet-delta.ts`). Set from the driver's registry entry
   * (`DriverEntry.snippetDelta`) by the scaffold adapters; absent reads as
   * false, which is the fixed loop's case: it rebuilds the HUD every turn.
   */
  snippetDelta?: boolean | undefined;
}

/**
 * The snippet delta block, or undefined when nothing changed. Never throws: a
 * drain that fails (the sandbox mid-restart, a child not answering in time)
 * reads as nothing changed, since the delta must never cost the model the
 * result it asked for.
 */
async function drainSnippetDelta(ctx: ToolContext): Promise<string | undefined> {
  try {
    const d = await ctx.sandbox.snippetDelta();
    return d === null ? undefined : renderSnippetDelta(d);
  } catch {
    return undefined;
  }
}

/** The core tools as the benchmark renders them (docs/METHODOLOGY.md, "Context policy"). */
const CORE = coreTools<ToolContext>({
  eventLine: formatEventLine,
  isAmbient: (opcode) => CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(opcode),
  stateSummary: (snapshot, o) => formatStateSummary(snapshot as SnapshotLike, o),
  afterSnippet: (ctx) => (ctx.snippetDelta === true ? drainSnippetDelta(ctx) : Promise.resolve(undefined)),
});

/**
 * Per-episode memory of what has already been searched.
 *
 * laguna issued 11 searches and nemotron 13 near-identical ones inside a single
 * episode, reading the same list each time as if it were new.
 * The memo says so in the result: same query, this many tool calls ago, and
 * whether anything actually changed.
 *
 * Keyed on the ToolContext, which is constructed once per episode by the loop,
 * the claude driver and the MCP server alike — so this state lives exactly as
 * long as the episode and is never written to disk. A restarted episode starts
 * with an empty memo, which is the honest thing: the model's context restarted
 * with it. Elapsed activity is the dispatcher's own count of tool calls
 * (`toolCallCount`), every tool counted.
 */
interface SearchMemoEntry {
  /** Tool-call ordinal of the last time this query was asked. */
  at: number;
  /** How many times it has been asked this episode. */
  count: number;
  /** Top titles it returned, for the "did anything change" comparison. */
  titles: string[];
}

const SEARCHES = new WeakMap<ToolContext, Map<string, SearchMemoEntry>>();

function searchesOf(ctx: ToolContext): Map<string, SearchMemoEntry> {
  let searches = SEARCHES.get(ctx);
  if (searches === undefined) {
    searches = new Map();
    SEARCHES.set(ctx, searches);
  }
  return searches;
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
  const searches = searchesOf(ctx);
  const calls = toolCallCount(ctx);
  const key = normalizeSearchQuery(query);
  const top = titles.slice(0, MEMO_TITLES);
  const previous = searches.get(key);
  searches.set(key, {
    at: calls,
    count: (previous?.count ?? 0) + 1,
    titles: top,
  });
  if (previous === undefined) return undefined;
  const ago = Math.max(0, calls - previous.at);
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

const searchReferenceTool: ToolSpec<ToolContext> = {
  def: {
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
  schema: z.strictObject({
    query: z.string().min(1),
    limit: z.coerce
      .number()
      .transform((n) => Math.min(20, Math.max(1, Math.round(n))))
      .default(8),
  }),
  help: "search_reference expects { query: string, limit?: number } — title or keywords, and max results 1-20 (default 8).",
  aliases: { q: "query" },
  // A run configured without the reference wiki (`wiki: false`, issue #61)
  // is not served the tool, and a call to it answers as an unknown tool.
  enabled: (ctx) => ctx.wikiSearch !== false,
  run: async (ctx, args) => {
    const { query, limit } = args as { query: string; limit: number };
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
  },
};

const reflectTool: ToolSpec<ToolContext> = {
  def: {
    name: "reflect",
    description:
      "Spend this turn thinking instead of acting. Returns a fixed set of questions to review your own record against; " +
      "nothing is summarised for you and nothing is remembered unless you write it to the scratchpad. " +
      "Available only while your character is resting — the state summary shows `resting` when it applies — or in flight, and once per rest visit and once per flight.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  schema: z.strictObject({}).default({}),
  help: "reflect takes no parameters ({}).",
  run: async (ctx) => {
    // Sample the world first, exactly as `state_summary` does: the gate is
    // also fed by the context builder's own samples, but a model that walks
    // into an inn and reflects in the same turn should not have to wait for
    // the next tick to be believed.
    try {
      const snapshot = (await ctx.sandbox.stateSnapshot()) as SnapshotLike;
      ctx.reflect.note(restingOf(snapshot), taxiFlightOf(snapshot));
    } catch {
      // A sandbox mid-restart tells us nothing new; the gate keeps the last
      // reading it was fed, which is the honest state of the observation.
    }
    const answer = ctx.reflect.request();
    if (answer.isError === true) return answer;
    // The count only; the entries themselves come from `read_log`. Omitted
    // when the log is empty, and when this gate's window cannot open (the
    // standalone MCP server), so the line never points at a page the caller
    // would be refused.
    const n = ctx.reflect.isOpen ? ctx.episodic.count : 0;
    return n === 0
      ? answer
      : {
          text: `${answer.text}\n\n${n} status ${n === 1 ? "entry" : "entries"} in your episodic log; read them with read_log.`,
        };
  },
};

const logStatusTool: ToolSpec<ToolContext> = {
  def: {
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
  schema: z.strictObject({ text: z.string().min(1) }),
  help: "log_status expects { text: string } — one short status entry.",
  aliases: { content: "text", status: "text", entry: "text", note: "text" },
  run: async (ctx, args) => {
    const { text } = args as { text: string };
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
  },
};

const readLogTool: ToolSpec<ToolContext> = {
  def: {
    name: "read_log",
    description:
      "Read your episodic log, newest first. Usable only while reflecting — see the reflect tool. " +
      'Filter by level range or zone; page with offset, or set order to "oldest" to start from the first entry. ' +
      `Returns "showing a-b of N" and one line per entry.`,
    inputSchema: {
      type: "object",
      properties: {
        order: { type: "string", enum: [...EPISODIC_ORDERS], description: "Which end to start from. Default newest." },
        offset: { type: "integer", minimum: 0, description: "Entries to skip from that end. Default 0." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: EPISODIC_PAGE_MAX,
          description: `How many entries to return. Default ${EPISODIC_PAGE_DEFAULT}.`,
        },
        minLevel: { type: "integer", minimum: 1, description: "Only entries written at this level or above." },
        maxLevel: { type: "integer", minimum: 1, description: "Only entries written at this level or below." },
        zone: { type: "string", description: "Only entries whose zone name contains this text, ignoring case." },
      },
      additionalProperties: false,
    },
  },
  // Lenient by declaration, like `recent_events`: a clamped page is an answer,
  // and a validation error inside a reflection window costs a turn of it.
  // The order word is matched ignoring case and surrounding space, the one
  // deterministic repair; any other word is refused with the parameter help.
  // An empty zone filters nothing, so it reads as no filter.
  schema: z
    .strictObject({
      order: z
        .string()
        .transform((v) => v.trim().toLowerCase())
        .pipe(z.enum(EPISODIC_ORDERS))
        .default("newest"),
      offset: z.coerce
        .number()
        .transform((n) => Math.max(0, Math.round(n)))
        .default(0),
      limit: z.coerce
        .number()
        .transform((n) => Math.min(EPISODIC_PAGE_MAX, Math.max(1, Math.round(n))))
        .default(EPISODIC_PAGE_DEFAULT),
      minLevel: z.coerce
        .number()
        .transform((n) => Math.round(n))
        .optional(),
      maxLevel: z.coerce
        .number()
        .transform((n) => Math.round(n))
        .optional(),
      zone: z
        .string()
        .transform((v) => (v.trim().length > 0 ? v.trim() : undefined))
        .optional(),
    })
    .prefault({}),
  help:
    `read_log expects { order?: "newest" | "oldest", offset?: number, limit?: number, minLevel?: number, ` +
    `maxLevel?: number, zone?: string } — which end to start from (default newest), entries to skip from ` +
    `that end (default 0), how many to return (1-${EPISODIC_PAGE_MAX}, default ${EPISODIC_PAGE_DEFAULT}), ` +
    `an optional level range, and text the zone name must contain (ignoring case).`,
  aliases: { start: "offset", count: "limit", n: "limit" },
  run: async (ctx, args) => {
    if (!ctx.reflect.isOpen) return { text: READ_LOG_CLOSED, isError: true };
    return { text: ctx.episodic.page(args as EpisodicQuery) };
  },
};

/** The benchmark's nine, in the order they are served. */
const RUNNER_TOOLS = new ToolSet<ToolContext>([
  CORE.run_snippet,
  CORE.recent_events,
  CORE.state_summary,
  searchReferenceTool,
  CORE.write_scratchpad,
  CORE.edit_scratchpad,
  reflectTool,
  logStatusTool,
  readLogTool,
]);

export const TOOLS: ToolDef[] = RUNNER_TOOLS.defs;

/**
 * The tool list for a run: `TOOLS` with the `search_reference` description
 * stating whether coordinates are served — or, on a run configured without the
 * reference wiki, without `search_reference` at all. `TOOLS` itself is the
 * names-first, wiki-on (default) rendering.
 */
export function toolsFor(opts: { wikiCoords?: boolean | undefined; wikiSearch?: boolean | undefined }): ToolDef[] {
  // A run configured without the reference wiki (`wiki: false`, issue #61) is
  // not handed the tool at all. Absent reads as true: the reference surface is
  // a capability every run has unless the run said otherwise.
  if (opts.wikiSearch === false) return TOOLS.filter((t) => t.name !== "search_reference");
  if (opts.wikiCoords !== true) return TOOLS;
  return TOOLS.map((t) =>
    t.name === "search_reference"
      ? { ...t, description: t.description.replace(WIKI_COORDS_SENTENCE.withheld, WIKI_COORDS_SENTENCE.served) }
      : t,
  );
}

export function isKnownTool(name: string): boolean {
  return RUNNER_TOOLS.isKnown(name);
}

/** Rename known alias keys to their canonical names. Deterministic, model-agnostic. */
export function normalizeToolArgs(name: string, args: unknown): unknown {
  return RUNNER_TOOLS.normalize(name, args);
}

/**
 * The one entry point drivers use for raw tool arguments (string or object).
 * A string is parsed leniently; the final failure message restates the tool's
 * expected parameters in prose.
 */
export function coerceToolArgs(name: string, raw: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
  return RUNNER_TOOLS.coerce(name, raw);
}

/** Nearest valid tool for a misspelled/mangled name, or undefined. */
export function nearestTool(name: string): string | undefined {
  return RUNNER_TOOLS.nearest(name);
}

/**
 * Dispatch one tool call. Never throws: errors come back as `isError` text.
 * Pending action hints ride the result, whichever tool it is; an evaluated
 * snippet's result already carries its own. Either way the result is scrubbed
 * of registered secrets.
 */
export function callTool(ctx: ToolContext, name: string, args: unknown, origin: CallOrigin = {}): Promise<ToolResult> {
  return RUNNER_TOOLS.call(ctx, name, args, origin);
}

/** `result` with the pending hint block at its foot (the stack's `appendPendingActionHints`). */
export function appendPendingActionHints(ctx: ToolContext, result: ToolResult): Promise<ToolResult> {
  return appendPending(ctx, result);
}
