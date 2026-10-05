/**
 * The action log as the feed reads it: one short line per dispatched action.
 *
 * An `actions` record (`runner/src/trajectory.ts`, `ActionsLine`) is what one
 * snippet put on the wire as `POST /action`, with the module's HTTP answer to
 * each. This turns a note into "cast Holy Light on Redridge Gnoll" or
 * "buy 5× Melon Juice", using the names the run's own client cache had at
 * dispatch (`names`) and falling back to the ids when it had none.
 *
 * What a line may claim is exactly what the record holds: the dispatch, and
 * whether the module took it. A `200` is "queued", so an accepted cast reads
 * as just the cast — whether the spell landed arrived later as an event, and
 * is not on this line. The one outcome drawn is a `move_to`'s, and only from
 * the `move` record the run wrote for that move id (`moveVerdicts`).
 *
 * Pure, so it is pinned by tests; `RunDetail.tsx` only lays the lines out.
 */

import type { ActionNoteView, ActionsEntry, FeedEntry } from "@viewer/api-types";

export interface ActionLineView {
  text: string;
  /** The module refused it, or never answered. */
  failed: boolean;
  /** The SDK's own client-parity traffic, not something the snippet asked for. */
  auto: boolean;
  /** The hover: the module's hint, the status and timing. */
  title: string;
}

/** A move verdict as the `move` record carries it, for the line of the `move_to` it ends. */
export interface MoveVerdict {
  ts: number;
  status: string;
}

/**
 * Move verdicts in the window, by move id. A move id is a per-session counter,
 * so one id can recur across a run's sessions; every verdict is kept and
 * `verdictFor` takes the first one at or after the dispatch.
 */
export function moveVerdicts(entries: readonly FeedEntry[]): Map<number, MoveVerdict[]> {
  const out = new Map<number, MoveVerdict[]>();
  for (const e of entries) {
    if (e.t !== "move") continue;
    const r = e as unknown as Record<string, unknown>;
    const id = r["moveId"];
    const status = r["status"];
    if (typeof id !== "number" || typeof status !== "string") continue;
    const list = out.get(id) ?? [];
    list.push({ ts: e.ts, status });
    out.set(id, list);
  }
  return out;
}

function verdictFor(note: ActionNoteView, verdicts: Map<number, MoveVerdict[]> | undefined): string | undefined {
  if (note.moveId === undefined || verdicts === undefined) return undefined;
  return verdicts.get(note.moveId)?.find((v) => v.ts >= note.ts)?.status;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function coord(v: number | undefined): string {
  return v === undefined ? "?" : v.toFixed(0);
}

/** What the line calls the thing an action was aimed at. */
function who(note: ActionNoteView, key: "guid" | "targetGuid" = "guid"): string {
  const name = note.names?.target;
  if (name !== undefined) return name;
  const guid = str(note.args?.[key]) ?? str(note.args?.["guid"]);
  return guid === undefined ? "?" : `#${guid}`;
}

function spell(note: ActionNoteView): string {
  return note.names?.spell ?? `spell ${n(note.args?.["spellId"]) ?? "?"}`;
}

function item(note: ActionNoteView): string {
  if (note.names?.item !== undefined) return note.names.item;
  const id = n(note.args?.["itemId"]);
  if (id !== undefined) return `item ${id}`;
  const bag = n(note.args?.["bag"]);
  const slot = n(note.args?.["slot"]);
  if (bag !== undefined && slot !== undefined) return `bag ${bag} slot ${slot}`;
  if (slot !== undefined) return `slot ${slot}`;
  return "item ?";
}

function quest(note: ActionNoteView): string {
  return note.names?.quest ?? `quest ${n(note.args?.["questId"]) ?? "?"}`;
}

function times(note: ActionNoteView): string {
  const c = n(note.args?.["count"]);
  return c !== undefined && c > 1 ? `${c}× ` : "";
}

/** The dispatch itself, in words. Unknown actions read as their name and arguments. */
export function actionPhrase(note: ActionNoteView): string {
  const a = note.args ?? {};
  switch (note.action) {
    case "say":
      return `say "${str(a["text"]) ?? ""}"`;
    case "move_to": {
      const at = `(${coord(n(a["x"]))}, ${coord(n(a["y"]))})`;
      return note.names?.target !== undefined ? `move to ${note.names.target} ${at}` : `move to ${at}`;
    }
    case "stop":
      return "stop moving";
    case "face":
      return n(a["orientation"]) !== undefined
        ? `face ${n(a["orientation"])!.toFixed(2)} rad`
        : `face (${coord(n(a["x"]))}, ${coord(n(a["y"]))})`;
    case "set_target":
      return `target ${who(note)}`;
    case "clear_target":
      return "clear target";
    case "attack_start":
      return `attack ${who(note)}`;
    case "attack_stop":
      return "stop attacking";
    case "cast_spell":
      return a["targetGuid"] === undefined ? `cast ${spell(note)}` : `cast ${spell(note)} on ${who(note, "targetGuid")}`;
    case "cancel_cast":
      return `cancel ${spell(note)}`;
    case "interact":
      return `use ${who(note)}`;
    case "gossip_hello":
      return `talk to ${who(note)}`;
    case "gossip_select":
      return `choose gossip option ${n(a["optionId"]) ?? "?"} with ${who(note)}`;
    case "quest_list":
      return `ask ${who(note)} for quests`;
    case "quest_details":
      return `ask ${who(note)} about ${quest(note)}`;
    case "quest_accept":
      return `accept ${quest(note)}`;
    case "quest_complete":
      return `complete ${quest(note)}`;
    case "quest_choose_reward":
      return `turn in ${quest(note)} (reward ${n(a["rewardIndex"]) ?? "?"})`;
    case "quest_abandon":
      return `abandon ${quest(note)}`;
    case "quest_query":
      return `query ${quest(note)}`;
    case "questgiver_status_query":
      return `query quest status of ${who(note)}`;
    case "questgiver_status_multiple_query":
      return "query quest markers";
    case "loot":
      return `loot ${who(note)}`;
    case "loot_all":
      return `loot everything from ${who(note)}`;
    case "loot_item":
      return `loot ${item(note)}`;
    case "loot_money":
      return "loot money";
    case "loot_release":
      return "close loot";
    case "vendor_list":
      return `browse ${who(note)}'s goods`;
    case "buy_item":
      return `buy ${times(note)}${item(note)}`;
    case "sell_item":
      return `sell ${times(note)}${item(note)}`;
    case "repair_all":
      return `repair at ${who(note)}`;
    case "equip_item":
      return `equip ${item(note)}`;
    case "use_item":
      return a["targetGuid"] === undefined ? `use ${item(note)}` : `use ${item(note)} on ${who(note, "targetGuid")}`;
    case "destroy_item":
      return `destroy ${times(note)}${item(note)}`;
    case "trainer_list":
      return `browse ${who(note)}'s training`;
    case "trainer_buy_spell":
      return `train ${spell(note)} from ${who(note)}`;
    case "repop":
      return "release spirit";
    case "reclaim_corpse":
      return "reclaim corpse";
    case "spirit_healer_activate":
      return `resurrect at ${who(note)}`;
    case "learn_talent":
      return `learn talent ${n(a["talentId"]) ?? "?"} rank ${n(a["rank"]) ?? "?"}`;
    case "learn_preview_talents":
      return `learn ${Array.isArray(a["talents"]) ? a["talents"].length : "?"} talents`;
    case "talent_tree":
      return "read talent tree";
    case "raw": {
      const payload = str(a["payload"]) ?? "";
      return `raw ${str(a["opcode"]) ?? "?"} (${Math.floor(payload.replace(/…\(\+\d+\)$/, "").length / 2)} bytes)`;
    }
    default: {
      const parts = Object.entries(a).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
      return parts.length === 0 ? note.action.replaceAll("_", " ") : `${note.action.replaceAll("_", " ")} · ${parts.join(" · ")}`;
    }
  }
}

/** One note as one feed line, with its answer. */
export function actionLine(note: ActionNoteView, verdicts?: Map<number, MoveVerdict[]>): ActionLineView {
  const failed = note.status === 0 || note.status < 200 || note.status >= 300;
  let text = actionPhrase(note);
  if (failed) text += ` → ${note.status === 0 ? "no answer" : "refused"}: ${note.error ?? `HTTP ${note.status}`}`;
  else {
    const verdict = verdictFor(note, verdicts);
    if (verdict !== undefined) text += ` → ${verdict.replaceAll("_", " ")}`;
  }
  if (note.count !== undefined && note.count > 1) text += ` ×${note.count}`;
  const title = [
    note.hint,
    `${note.action} · ${note.status === 0 ? "no answer" : `HTTP ${note.status}`}${note.ms !== undefined ? ` · ${note.ms}ms` : ""}`,
    note.auto === true ? "sent by the SDK itself, as a client does" : undefined,
  ]
    .filter((s): s is string => s !== undefined)
    .join("\n");
  return { text, failed, auto: note.auto === true, title };
}

/** Every line of a record, plus one for what the cap counted rather than kept. */
export function actionLines(entry: ActionsEntry, verdicts?: Map<number, MoveVerdict[]>): ActionLineView[] {
  const lines = (entry.actions ?? []).map((a) => actionLine(a, verdicts));
  const dropped = Object.entries(entry.dropped ?? {}).filter(([, c]) => typeof c === "number" && c > 0);
  if (dropped.length > 0) {
    const total = dropped.reduce((s, [, c]) => s + c, 0);
    lines.push({
      text: `+${total} more: ${dropped.map(([a, c]) => `${a.replaceAll("_", " ")} ×${c}`).join(", ")}`,
      failed: false,
      auto: false,
      title: "past the per-snippet cap: counted, not kept",
    });
  }
  return lines;
}

export function isActionsEntry(e: FeedEntry): e is ActionsEntry {
  return e.t === "actions" && Array.isArray((e as { actions?: unknown }).actions);
}
