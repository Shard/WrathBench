/**
 * `/api/tools`: the model-facing tools a run on the fixed `wrathbench`
 * harness is given by default, read off `toolsFor` at request time so the
 * homepage's tool inspector cannot drift from what a run is served.
 *
 * Which list that is follows the launch default (`defaultLoopOf` on
 * `DEFAULT_DRIVER`): the program loop, with `yield`. The description text
 * is the runner's (names-first rendering — the `wikiCoords` variant is a
 * per-run fact the homepage has no run to ask). The one thing added here is
 * an example call per tool, kept beside the route rather than in the
 * dashboard so the SPA carries no harness strings at all. Every example is
 * harness text — no quest, NPC or item name — so the route is safe to
 * publish as-is.
 */

import { defaultLoopOf } from "../runner/src/config";
import { DEFAULT_DRIVER } from "../runner/src/drivers";
import { toolsFor, type ProgramTools, type ToolDef } from "../runner/src/tools";
import type { ToolsResponse, ToolView } from "./api-types-runner";

/**
 * A launch's default on the default driver (the fixed harness's): the program
 * loop and its `yield`, or the snippet loop (undefined).
 */
export function servedProgramTools(): ProgramTools | undefined {
  const d = defaultLoopOf({ driver: DEFAULT_DRIVER });
  return d.loop === "program" ? { yield: d.yield } : undefined;
}

/** The list the homepage shows: what a run launched with no driver, `--loop` or `--yield` said is served. */
export function servedTools(): ToolDef[] {
  return toolsFor({ programTools: servedProgramTools() });
}

/**
 * One example call per tool that takes arguments, by name. A `{}` example says
 * nothing, so an argument-less tool has a `TOOL_RETURNS` line instead; the
 * test pins that every tool has exactly one of the two. The file and routine
 * examples tell one story: write a routine, tweak it, run it, stop it.
 */
export const TOOL_EXAMPLES: Readonly<Record<string, string>> = {
  run_snippet: `{ "code": "await sdk.killTarget(state.closest({ alive: true, maxDistance: 30 }))" }`,
  read_file: `{ "path": "main.ts" }`,
  write_file: `{ "path": "main.ts", "content": "export async function grind(args) {\\n  while (!signal.aborted) {\\n    await sdk.killTarget(state.closest({ alive: true, maxDistance: args.range }));\\n  }\\n}\\n" }`,
  edit_file: `{ "path": "main.ts", "old": "maxDistance: args.range", "new": "maxDistance: args.range ?? 30", "replaceAll": false }`,
  delete_file: `{ "path": "lib/old-route.ts" }`,
  start_routine: `{ "name": "grind", "args": { "range": 30 } }`,
  stop_routine: `{ "name": "grind" }`,
  yield: `{ "seconds": 120 }`,
  recent_events: `{ "limit": 20 }`,
  search_reference: `{ "query": "Northshire quests" }`,
  write_scratchpad: `{ "content": "# Plan\\n- turn in the two finished quests\\n- train at level 4" }`,
  edit_scratchpad: `{ "old": "- [ ] train at level 4", "new": "- [x] trained at level 4", "replaceAll": false }`,
  log_status: `{ "text": "L3, clearing the field south of the abbey; two quests ready to turn in" }`,
  read_log: `{ "offset": 0, "limit": 20 }`,
};

/** What an argument-less call gives back, one line each (see `callTool` in runner/src/tools.ts). */
export const TOOL_RETURNS: Readonly<Record<string, string>> = {
  state_summary: "the fixed-format client-HUD summary of the cached state: character, level, position, health, xp, money, bag, quests, target, nearby, open windows, whether any events were missed",
  reflect: "the fixed set of review questions, plus how many entries the episodic log holds (read with read_log) — or a refusal with why, when the character is neither resting nor in flight",
};

export function toolsResponse(): ToolsResponse {
  const tools: ToolView[] = servedTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    example: TOOL_EXAMPLES[t.name] ?? null,
    returns: TOOL_RETURNS[t.name] ?? null,
  }));
  return { tools };
}
