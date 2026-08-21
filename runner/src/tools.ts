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

const argSchemas = {
  run_snippet: z.object({ code: z.string().min(1) }),
  recent_events: z.object({ limit: z.number().int().min(1).max(200).default(50) }).default({ limit: 50 }),
  state_summary: z.object({}).default({}),
  search_reference: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8) }),
  read_scratchpad: z.object({}).default({}),
  write_scratchpad: z.object({ content: z.string() }),
} as const;

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
    if (!isKnownTool(name)) return { text: `unknown tool: ${name}`, isError: true };
    const parsed = argSchemas[name].safeParse(args ?? {});
    if (!parsed.success) {
      return { text: `invalid arguments for ${name}: ${parsed.error.message}`, isError: true };
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
        return { text: formatStateSummary(snapshot, { sessionLive: ctx.sessionLive() }) };
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
