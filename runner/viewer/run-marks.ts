/**
 * The milestone and party marks the run page's tail folds out of a trajectory
 * record by record: the replay's travel (flights, hearths, graveyard
 * releases), a party member's map transfers, kills and group changes, the zone
 * and area names the client was told, and the reflection windows. Pure, one
 * record at a time; `TrajectoryTail` (`tail.ts`) accumulates them as it indexes.
 */

import type {
  PartyGroupMark,
  PartyInstanceMark,
  PartyKillMark,
  ReflectionWindowView,
  TrackTravelMark,
} from "./api-types";

/* --------------------------------------------------- the resolved model id */

/* ------------------------------------------------------- zone/area milestones */

/* ------------------------------------------- achievement and taxi milestones */

/* --------------------------------------------------- the replay's travel */

/**
 * What the action log calls the hearthstone: the client-cache name the SDK
 * stamped on the `use_item` dispatch (`ActionNote.names`, sandbox/ipc.ts). The
 * dispatch carries a bag and a slot, not an item id, so the name is the only
 * thing on the record that says which item it was.
 */
export const HEARTHSTONE_ITEM_NAME = "Hearthstone";
/** The hearthstone's own spell, should a dispatch cast it directly. */
export const HEARTHSTONE_SPELL_ID = 8690;

/**
 * The travel marks one trajectory record contributes to `TrackResponse.travel`,
 * or none.
 *
 * From a milestone: a flight's takeoff and landing, and a spirit's release to a
 * graveyard — including a `death` first observed already released, after which
 * no separate `release` is written (`runner/src/loop.ts`). From an `actions`
 * record: every hearthstone the module accepted, at the dispatch's own `ts`, and
 * at the last of a folded run of identical dispatches too, since any of them
 * may be the cast that landed. A refused dispatch casts nothing.
 */
export function travelMarksOf(rec: Record<string, unknown>): TrackTravelMark[] {
  const t = rec["t"];
  if (t === "milestone") {
    const ts = rec["ts"];
    if (typeof ts !== "number") return [];
    const kind = rec["kind"];
    if (kind === "taxi" || kind === "taxi_landed") {
      // A flight record latched in the sandbox carries the flip's own stamp;
      // prefer it over the sample's, as `deathMarkOf` does and for the reason
      // it gives: the producer samples on a timer.
      const observed = rec["observedTs"];
      return [{ kind, ts: typeof observed === "number" ? observed : ts }];
    }
    if (kind === "release") return [{ kind, ts }];
    if (kind === "death" && rec["released"] === true) return [{ kind: "release", ts }];
    return [];
  }
  if (t !== "actions" || !Array.isArray(rec["actions"])) return [];
  const out: TrackTravelMark[] = [];
  for (const a of rec["actions"] as unknown[]) {
    if (a === null || typeof a !== "object") continue;
    const note = a as Record<string, unknown>;
    const status = note["status"];
    if (typeof note["ts"] !== "number" || typeof status !== "number" || status < 200 || status >= 300) continue;
    const names = note["names"] as { item?: unknown } | undefined;
    const args = note["args"] as { spellId?: unknown } | undefined;
    const hearth =
      (note["action"] === "use_item" && names?.item === HEARTHSTONE_ITEM_NAME) ||
      (note["action"] === "cast_spell" && args?.spellId === HEARTHSTONE_SPELL_ID);
    if (!hearth) continue;
    out.push({ kind: "hearth", ts: note["ts"] });
    if (typeof note["lastTs"] === "number" && note["lastTs"] !== note["ts"]) {
      out.push({ kind: "hearth", ts: note["lastTs"] });
    }
  }
  return out;
}

/* ---------------------------------------------- level and death milestones */

/* ------------------------------------------------- the party milestones */

/** The stamp a party milestone was observed at: the cache's own, else the record's. */
function observedTsOf(rec: Record<string, unknown>): number {
  const observed = rec["observedTs"];
  if (typeof observed === "number") return observed;
  const ts = rec["ts"];
  return typeof ts === "number" ? ts : 0;
}

/**
 * Read one trajectory record as a map transfer into or out of an instance
 * (`instance`, docs/proposals/GROUP-PLAY.md §6), or null when it is not one.
 * Ids only, as written.
 */
export function instanceMarkOf(rec: Record<string, unknown>): PartyInstanceMark | null {
  if (rec["kind"] !== "instance") return null;
  const event = rec["event"];
  const map = rec["map"];
  const from = (rec["from"] as { map?: unknown } | undefined)?.map;
  if ((event !== "entered" && event !== "left") || typeof map !== "number" || typeof from !== "number") return null;
  return { ts: observedTsOf(rec), event, map, from };
}

/**
 * Read one trajectory record as a kill the server reported (`kill`), or null.
 * The name is not on the record: the reader attaches it from the run's own
 * client cache (`party-marks.ts`).
 */
export function killMarkOf(rec: Record<string, unknown>): PartyKillMark | null {
  if (rec["kind"] !== "kill") return null;
  const victim = rec["victimGuid"];
  if (typeof victim !== "string" || victim === "") return null;
  const entry = rec["entry"];
  const rank = rec["rank"];
  return {
    ts: observedTsOf(rec),
    victimGuid: victim,
    entry: typeof entry === "number" ? entry : null,
    name: null,
    self: rec["self"] === true,
    ...(typeof rank === "number" ? { rank } : {}),
  };
}

/** Read one trajectory record as a `group` milestone, or null. Counts only: the guids stay on the record. */
export function groupMarkOf(rec: Record<string, unknown>): PartyGroupMark | null {
  if (rec["kind"] !== "group") return null;
  const event = rec["event"];
  const count = rec["count"];
  if ((event !== "joined" && event !== "changed" && event !== "left") || typeof count !== "number") return null;
  return { ts: observedTsOf(rec), event, count };
}

/**
 * The zone and area names a line's served `WB_AREA` events carry, by id: the
 * names the client was told for the ids its state samples record. Found by a
 * substring test before any parse, because almost no line carries one and
 * every line here is already parsed once; an event whose name is empty names
 * nothing.
 */
export function areaNamesOf(text: string): { zones: [number, string][]; areas: [number, string][] } {
  const zones: [number, string][] = [];
  const areas: [number, string][] = [];
  if (!text.includes('"WB_AREA"')) return { zones, areas };
  for (const m of text.matchAll(/"opcode":"WB_AREA","data":(\{[^{}]*\})/g)) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(m[1]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof d["zoneId"] === "number" && typeof d["zoneName"] === "string" && d["zoneName"] !== "") zones.push([d["zoneId"], d["zoneName"]]);
    if (typeof d["areaId"] === "number" && typeof d["areaName"] === "string" && d["areaName"] !== "") areas.push([d["areaId"], d["areaName"]]);
  }
  return { zones, areas };
}

/* ------------------------------ spell, talent and trade milestones */

/**
 * One `reflect_window` record (`runner/src/loop.ts`), projected to what a turn
 * range needs: which turn it was written on, whether it opened or closed a
 * window, and — for a close — why.
 */
export interface ReflectMark {
  turn: number;
  event: "open" | "close";
  /** The close's `ReflectCloseReason`; null on an open, or when unrecorded. */
  reason: string | null;
}

/** Read one trajectory record as a `ReflectMark`, or null when it is not one. */
export function reflectMarkOf(rec: Record<string, unknown>): ReflectMark | null {
  if (rec["t"] !== "reflect_window") return null;
  const turn = rec["turn"];
  const event = rec["event"];
  if (typeof turn !== "number" || (event !== "open" && event !== "close")) return null;
  const reason = rec["reason"];
  return { turn, event, reason: typeof reason === "string" ? reason : null };
}

/**
 * The turns a run spent reflecting, as half-open ranges.
 *
 * Half-open because of *when* the loop writes these records. Both are drained
 * in the context builder, at the top of a turn and before the model answers it:
 * the `open` therefore names the first turn whose context was assembled with
 * the window open, and the `close` names the first turn assembled after it shut
 * — which is a turn spent acting, not reflecting. `[from, to)` is that, exactly.
 *
 * The one exception is `run_end`, written from the driver's teardown rather
 * than from a build: there is no turn after it, so the window runs to the end
 * of the run and `toTurn` is null. A window still open on a live run reads the
 * same way, for the same reason — nothing has closed it yet.
 *
 * An unpaired close (its open scrolled out of a re-read, or the run was resumed
 * mid-window, which starts a fresh gate) is dropped rather than guessed into a
 * window starting at turn zero.
 */
export type ReflectionWindow = ReflectionWindowView;

export function reflectionWindowsFrom(marks: readonly ReflectMark[]): ReflectionWindow[] {
  const out: ReflectionWindow[] = [];
  let open: number | null = null;
  for (const m of marks) {
    if (m.event === "open") {
      // A second open with none closed cannot happen (the gate is idempotent),
      // and if it ever did the first window is the one that was real.
      if (open === null) open = m.turn;
      continue;
    }
    if (open === null) continue;
    out.push({ fromTurn: open, toTurn: m.reason === "run_end" ? null : m.turn });
    open = null;
  }
  if (open !== null) out.push({ fromTurn: open, toTurn: null });
  return out;
}
