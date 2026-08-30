/**
 * `/api/tools`: the nine model-facing tools, read off `TOOLS` at request time
 * so the homepage's tool inspector cannot drift from what a run is given.
 *
 * The description text is the runner's (names-first rendering — the
 * `wikiCoords` variant is a per-run fact the homepage has no run to ask). The
 * one thing added here is an example call per tool, kept beside the route
 * rather than in the dashboard so the SPA carries no harness strings at all.
 * Every example is harness text — no quest, NPC or item name — so the route
 * is safe to publish as-is.
 */

import { TOOLS } from "../src/tools";
import type { ToolsResponse, ToolView } from "./api-types";

/** One example call per tool, by name. A tool with no entry is a test failure, not a blank. */
export const TOOL_EXAMPLES: Readonly<Record<string, string>> = {
  run_snippet: `{ "code": "await sdk.killTarget(state.closest({ alive: true, maxDistance: 30 }))" }`,
  recent_events: `{ "limit": 20 }`,
  state_summary: `{}`,
  search_reference: `{ "query": "Northshire quests" }`,
  read_scratchpad: `{}`,
  write_scratchpad: `{ "content": "# Plan\\n- turn in the two finished quests\\n- train at level 4" }`,
  log_status: `{ "text": "L3, clearing the field south of the abbey; two quests ready to turn in" }`,
  reflect: `{}`,
  read_log: `{ "offset": 0, "limit": 20 }`,
};

export function toolsResponse(): ToolsResponse {
  const tools: ToolView[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    example: TOOL_EXAMPLES[t.name] ?? "",
  }));
  return { tools };
}
