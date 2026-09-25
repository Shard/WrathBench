/**
 * `/api/tools`: the model-facing tools, read off `TOOLS` at request time
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

/**
 * One example call per tool that takes arguments, by name. A `{}` example says
 * nothing, so an argument-less tool has a `TOOL_RETURNS` line instead; the
 * test pins that every tool has exactly one of the two.
 */
export const TOOL_EXAMPLES: Readonly<Record<string, string>> = {
  run_snippet: `{ "code": "await sdk.killTarget(state.closest({ alive: true, maxDistance: 30 }))" }`,
  recent_events: `{ "limit": 20 }`,
  search_reference: `{ "query": "Northshire quests" }`,
  read_file: `{ "path": "lib/util.ts" }`,
  write_file: `{ "path": "notes.md", "content": "# Plan\\n- turn in the two finished quests\\n- train at level 4" }`,
  edit_file: `{ "path": "notes.md", "old_string": "- [ ] train at level 4", "new_string": "- [x] trained at level 4" }`,
  delete_file: `{ "path": "lib/old.ts" }`,
  log_status: `{ "text": "L3, clearing the field south of the abbey; two quests ready to turn in" }`,
  read_log: `{ "offset": 0, "limit": 20 }`,
};

/** What an argument-less call gives back, one line each (see `callTool` in runner/src/tools.ts). */
export const TOOL_RETURNS: Readonly<Record<string, string>> = {
  state_summary: "the fixed-format client-HUD summary of the cached state: character, level, position, health, xp, money, bag, quests, target, nearby, open windows, whether any events were missed",
  reflect: "the fixed set of review questions, plus how many entries the episodic log holds (read with read_log) — or a refusal with why, when the character is not resting",
};

export function toolsResponse(): ToolsResponse {
  const tools: ToolView[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    example: TOOL_EXAMPLES[t.name] ?? null,
    returns: TOOL_RETURNS[t.name] ?? null,
  }));
  return { tools };
}
