/**
 * The six Phase-0 tools, defined once and dispatched from two places: the MCP
 * server (external model drives them over stdio) and the agent loop (the
 * OpenAI-compatible adapter drives them in-process). Schemas are deliberately
 * tight — few parameters, all described — because a confused tool call costs a
 * live-world turn.
 */

import { z } from "zod";
import type { Database } from "bun:sqlite";
import { searchReference } from "@wrathbench/wiki/search";
import { formatEventLine, formatStateSummary, type SnapshotLike } from "./context";
import type { SandboxHost } from "./sandbox/host";
import type { Scratchpad } from "./scratchpad";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema, for MCP and OpenAI tools
}

export const TOOLS: ToolDef[] = [
  {
    name: "run_snippet",
    description:
      "Execute a TypeScript snippet in the persistent game sandbox. Top-level bindings persist across snippets; `sdk`, `state`, `events`, `connect()`, `sleep(ms)` and `scratchpad` are ambient. A single expression returns its value. This is the only way to act in the world.",
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
      "Return the most recent game events (server packets as JSON), oldest first. Use after acting to see what the server said.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "How many events to return. Default 50.",
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
      "Full-text search over the game reference wiki (quests, NPCs, zones, items, mechanics). Query with a page title or a few keywords, not a sentence.",
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
];

// Strict on purpose: the advertised inputSchema says `additionalProperties:
// false`, and a plain z.object would silently *strip* unknown keys — a model
// that sent { snippet: "..." } got an empty object and a confusing "code
// required" instead of being told about its unknown key. Aliases are
// normalized (normalizeToolArgs) BEFORE this validation runs.
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
    })
    .default({ limit: 50 }),
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
} as const;

/** Prose restatement of each tool's parameters, for validation error replies. */
const TOOL_PARAM_HELP: Record<keyof typeof argSchemas, string> = {
  run_snippet: "run_snippet expects { code: string } — the TypeScript source to evaluate.",
  recent_events: "recent_events expects { limit?: number } — how many events to return, 1-200, default 50.",
  state_summary: "state_summary takes no parameters ({}).",
  search_reference:
    "search_reference expects { query: string, limit?: number } — title or keywords, and max results 1-20 (default 8).",
  read_scratchpad: "read_scratchpad takes no parameters ({}).",
  write_scratchpad: "write_scratchpad expects { content: string } — the full new scratchpad markdown.",
};

/**
 * Alias keys models actually sent, mapped to the canonical parameter. Applied
 * only when the canonical key is absent, and before strict validation.
 */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  run_snippet: { cmd: "code", snippet: "code", source: "code", script: "code", ts: "code" },
  write_scratchpad: { text: "content", markdown: "content" },
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
 * Parse a tool-arguments *string* leniently, in this order: (a) plain
 * JSON.parse; (b) strip one wrapping markdown code fence and re-parse; (c) one
 * conservative repair pass — trailing commas before `}` or `]` — and re-parse.
 * On final failure the error echoes what was received (first ~200 chars).
 */
export function parseToolArgsText(raw: string): { ok: true; args: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, args: {} };
  const candidates: string[] = [trimmed];
  const fence = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  for (const c of [...candidates]) {
    const repaired = c.replace(/,\s*([}\]])/g, "$1");
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

export interface ToolContext {
  sandbox: SandboxHost;
  scratchpad: Scratchpad;
  /** Wiki bundle; absent means search_reference reports unavailability. */
  wiki?: Database | undefined;
  /** Whether a game session has been established (for the summary header). */
  sessionLive: () => boolean;
  /** Called with every event batch actually served to the model. */
  onEventsServed?: (events: unknown[]) => void;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export function isKnownTool(name: string): name is keyof typeof argSchemas {
  return name in argSchemas;
}

/** Dispatch one tool call. Never throws: errors come back as `isError` text. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
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
        if (res.error !== undefined) lines.push(res.error);
        if (res.logs.length > 0) {
          lines.push("--- console ---");
          for (const l of res.logs) lines.push(`[${l.level}] ${l.text}`);
        }
        return { text: lines.join("\n"), isError: !res.ok };
      }
      case "recent_events": {
        const { limit } = parsed.data as { limit: number };
        const events = await ctx.sandbox.recentEvents(limit);
        ctx.onEventsServed?.(events);
        if (events.length === 0) return { text: "no events yet" };
        return { text: events.map(formatEventLine).join("\n") };
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
        const hits = searchReference(ctx.wiki, query, { limit });
        if (hits.length === 0) return { text: "no results" };
        return {
          text: hits
            .map((h) => {
              const via = h.redirectedFrom !== undefined ? ` (redirected from ${h.redirectedFrom})` : "";
              return `# ${h.title}${via}\n${h.snippet}`;
            })
            .join("\n\n"),
        };
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
