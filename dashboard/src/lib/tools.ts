/**
 * The homepage's tool inspector, in the pure layer: which tool is shown, and
 * the few lines about the SDK that ride under it.
 *
 * The tool list itself comes off `/api/tools` — the runner's `TOOLS` at
 * request time — so nothing here restates a description. The SDK families
 * below are dashboard prose about the shape of the surface, not a copy of the
 * prompt; the prompt (`runner/src/prompt.ts`) stays the authority on what
 * the model is told.
 */

import type { ToolView } from "../api/client";

/** The tool to show: the one named, else the first — an unknown name never blanks the pane. */
export function selectedTool(tools: readonly ToolView[], name: string | undefined): ToolView | undefined {
  if (tools.length === 0) return undefined;
  return tools.find((t) => t.name === name) ?? tools[0];
}

/** Parameter names off a tool's JSON Schema, required ones first, for the inspector's one-line signature. */
export function paramNames(schema: Record<string, unknown>): { name: string; required: boolean }[] {
  const props = schema["properties"];
  const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []);
  if (typeof props !== "object" || props === null) return [];
  return Object.keys(props)
    .map((name) => ({ name, required: required.has(name) }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

export interface SdkFamily {
  name: string;
  /** A few helper names, as the model would type them. */
  members: string;
  /** One line on what the family is for. */
  note: string;
}

/** The SDK helper families the prompt describes, one line each. */
export const SDK_FAMILIES: readonly SdkFamily[] = [
  {
    name: "movement",
    members: "moveTo, moveToAsync, face, repop, reclaimCorpse",
    note: "walk to a point, a unit or a name; long walks go async and are polled.",
  },
  {
    name: "combat",
    members: "killTarget, attackStart, attackStop, castSpell",
    note: "one helper that fights to an outcome, raw actions under it to compose.",
  },
  {
    name: "quests",
    members: "questsAvailableFrom, acceptQuestFrom, turnInQuest, waitForQuestObjective",
    note: "each waits for the server's verdict rather than reporting that a packet was sent.",
  },
  {
    name: "items",
    members: "lootCorpse, equipItem, useItem, destroyItem, state.bag()",
    note: "bag and slot, or the item's name; a refusal says why, so resending will not help.",
  },
  {
    name: "NPC windows",
    members: "gossipHello, gossipSelect, trainerList, buySpell, vendorList, buyItem",
    note: "menus by option text; the last vendor, trainer and loot windows stay readable in state.",
  },
  {
    name: "raw escape hatch",
    members: "sdk.raw(opcode, payload), events.on/waitForOpcode, state.units()",
    note: "the same opcodes a client sends and the packets it receives; helpers are earned from trajectories, never added on speculation.",
  },
];
