/**
 * The state samples a v1 run's scorer reads, derived from its trace.
 *
 * A 0.5 run sampled the state cache every 60 seconds into run.sqlite's
 * `state` table, beside a trace that held the same readings at the client's
 * own cadence. A v1 run has the trace alone (`wrath-mcp/docs/SESSION-FORMAT.md`,
 * "trace": "there is no coarser state table beside it"), and the operator's
 * decision of 2026-11-11 is that the scorer reads it: the level curve, XP,
 * money, quests, position and the rest are folded from the trace's `key` and
 * `state` rows (docs/METHODOLOGY.md, "The harness records a signal vector").
 *
 * The fold yields rows in the `state` table's shape, so every derivation
 * downstream (`viewer/results.ts`, the store's `states`, the run page's
 * curves and replay) reads a v1 run exactly as it read a 0.5 one. Two things
 * differ, and both are the cadence, not the meaning:
 *
 * - **A sample per change, not per minute.** A row is emitted whenever a
 *   scored reading changes (level, XP, its bar's length, money, the turn-in
 *   count, map, zone, area, what is carried), plus one per minute of travel
 *   or health between them, so a curve's step is at the change itself rather
 *   than at the next 60-second sample after it. "First observation" stays the
 *   rule; the observation is the client's.
 * - **The turn-in count is the run's.** 0.5's `quests_completed` was the
 *   cache's count, which started again at every sandbox restart, and every
 *   reader summed its stretches (`questTally`). Here it is the run's own
 *   running count of the trace's `qdone` receipts, which those readers sum to
 *   the same total.
 *
 * `event_count` and `last_seq` (the child's stream cursor) are not on the
 * trace and read null. `turn` is the turn in flight at the sample, joined by
 * timestamp against the trajectory (`TurnIndex`), never stamped by the stack.
 */

import { SHEET_KEY_LEN, applySheetPatch, type TraceDict, type TraceRow, type TraceSheet, type TraceState } from "@wrathbench/mcp/record";
import type { ItemSample } from "./trajectory";

/** One sample, in the `state` table's columns. */
export interface StateSample {
  ts: number;
  /** The sample's ordinal in the run's derivation, from 1: the store's tiebreaker, stable across re-derivations. */
  seq: number;
  level: number | null;
  xp: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  event_count: number | null;
  last_seq: number | null;
  money: number | null;
  quests_completed: number | null;
  turn: number | null;
  zone: number | null;
  area: number | null;
  /** `ItemSample[]` as JSON, on the samples where what is carried changed; null on the rest. */
  items: string | null;
  health: number | null;
  max_health: number | null;
  power: number | null;
  max_power: number | null;
  power_type: number | null;
  next_level_xp: number | null;
}

/** At most this long between two samples while the character moves or its health changes. */
export const SAMPLE_HEARTBEAT_MS = 60_000;

/** Worn: inventory slots 0-18 (19-22 are the bags themselves). */
const EQUIPMENT_LAST_SLOT = 18;
/** The backpack (`bag` 255) holds slots 23-38; the worn bags are 19-22. */
const BACKPACK = 255;
const BACKPACK_FIRST_SLOT = 23;
const BACKPACK_LAST_SLOT = 38;
const BAG_FIRST_SLOT = 19;
const BAG_LAST_SLOT = 22;

const SHEET_LISTS = Object.keys(SHEET_KEY_LEN) as (keyof typeof SHEET_KEY_LEN)[];

const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The trace folded row by row: the character's unit state, its sheet, its
 * position and the run's turn-in count, as of the last row applied.
 */
export class TraceFold {
  state: Partial<TraceState> = {};
  sheet: Partial<TraceSheet> = {};
  map: number | null = null;
  x: number | null = null;
  y: number | null = null;
  z: number | null = null;
  /** Every `qdone` receipt so far: the run's turn-ins. */
  questsDone = 0;
  /** Item names and qualities, from every dictionary entry seen. */
  readonly items = new Map<number, { quality: number | null; name: string }>();
  /** Random properties' name suffixes by signed id, from every dictionary entry seen. */
  readonly rands = new Map<number, string>();

  learn(dict: TraceDict | undefined): void {
    for (const [id, quality, name] of dict?.items ?? []) this.items.set(id, { quality, name });
    for (const [id, suffix] of dict?.rands ?? []) this.rands.set(id, suffix);
  }

  apply(row: TraceRow): void {
    this.learn(row.dict);
    const data = (row.data ?? null) as Record<string, unknown> | null;
    switch (row.kind) {
      case "key": {
        // A key states everything whole: what it does not hold is unobserved.
        const state: Partial<TraceState> = {};
        const sheet: Partial<TraceSheet> = {};
        for (const [k, v] of Object.entries(data ?? {})) {
          if (k === "money" || (SHEET_LISTS as string[]).includes(k)) (sheet as Record<string, unknown>)[k] = v;
          else if (k !== "qdone" && k !== "chat") (state as Record<string, unknown>)[k] = v;
        }
        this.state = state;
        this.sheet = sheet;
        this.position(row);
        return;
      }
      case "pos":
      case "flight":
        this.position(row);
        return;
      case "state": {
        if (data === null) return;
        for (const [k, v] of Object.entries(data)) {
          if (k === "qdone") this.questsDone += Array.isArray(v) ? v.length : 0;
          else if (k === "chat") continue;
          else if (k === "money") this.sheet.money = v as number | null;
          else if ((SHEET_LISTS as string[]).includes(k)) {
            const list = k as keyof typeof SHEET_KEY_LEN;
            (this.sheet as Record<string, unknown>)[list] = applySheetPatch(
              (this.sheet[list] ?? null) as number[][] | null,
              v as number[][] | null,
              SHEET_KEY_LEN[list],
            );
          } else (this.state as Record<string, unknown>)[k] = v;
        }
        return;
      }
      default:
        return;
    }
  }

  private position(row: TraceRow): void {
    if (typeof row.map !== "number" || typeof row.x !== "number" || typeof row.y !== "number" || typeof row.z !== "number") return;
    this.map = row.map;
    this.x = row.x;
    this.y = row.y;
    this.z = row.z;
  }

  /**
   * What is worn and carried, as a 0.5 state row's `items` held it: worn
   * slots 0-18 by slot, then the backpack's slots 23-38, then each worn bag's
   * slots, the order `state.bag()` walks them. The sheet's `inv` also holds
   * the keyring and the currency slots, which the 0.5 sample did not, so they
   * are left out. A name is the client's, as `state.bag()` gave it: the item
   * template's (the dictionary's), then its random property's suffix when
   * the row has one the dictionary names ("Sentry's Leggings of the Bear").
   * An item the client was never told the name of is `item <id>`, and a slot
   * whose item was never seen is `slot <n>` with no id. Null when neither
   * list has been observed.
   */
  itemSamples(): ItemSample[] | null {
    const equip = this.sheet.equip ?? null;
    const inv = this.sheet.inv ?? null;
    if (equip === null && inv === null) return null;
    const out: ItemSample[] = [];
    const named = (itemId: number, slot: number, rand: number | undefined): { name: string; itemId?: number; quality?: number } => {
      if (itemId === 0) return { name: `slot ${slot}` };
      const d = this.items.get(itemId);
      const suffix = rand === undefined || rand === 0 ? undefined : this.rands.get(rand);
      const name = d === undefined ? `item ${itemId}` : suffix === undefined ? d.name : `${d.name} ${suffix}`;
      return { name, itemId, ...(typeof d?.quality === "number" ? { quality: d.quality } : {}) };
    };
    for (const [slot, itemId, rand] of [...(equip ?? [])].sort((a, b) => a[0] - b[0])) {
      if (slot > EQUIPMENT_LAST_SLOT) continue;
      const n = named(itemId, slot, rand);
      out.push({ name: n.name, count: 1, equipped: true, ...(n.itemId !== undefined ? { itemId: n.itemId } : {}), ...(n.quality !== undefined ? { quality: n.quality } : {}), slot });
    }
    const carried = (inv ?? []).filter(
      ([bag, slot]) => (bag === BACKPACK && slot >= BACKPACK_FIRST_SLOT && slot <= BACKPACK_LAST_SLOT) || (bag >= BAG_FIRST_SLOT && bag <= BAG_LAST_SLOT),
    );
    // The backpack first, then the bags in slot order: 255 sorts last numerically, so it is put first by hand.
    carried.sort((a, b) => (a[0] === BACKPACK ? -1 : a[0]) - (b[0] === BACKPACK ? -1 : b[0]) || a[1] - b[1]);
    for (const [bag, slot, itemId, count, rand] of carried) {
      const n = named(itemId, slot, rand);
      out.push({
        name: n.name,
        count: typeof count === "number" ? count : 1,
        equipped: false,
        ...(n.itemId !== undefined ? { itemId: n.itemId } : {}),
        ...(n.quality !== undefined ? { quality: n.quality } : {}),
        slot,
        bag,
      });
    }
    return out;
  }
}

/** The fields a change of which is a sample of its own. */
const SCORED = ["level", "xp", "next_level_xp", "money", "quests_completed", "map", "zone", "area"] as const;

/**
 * The trace's samples, derived incrementally: rows go in as they are read
 * (whole segments or a tail), samples come out. The same rows in the same
 * order always yield the same samples with the same `seq`, however they are
 * chunked, so a re-derivation lands on the rows it already wrote.
 */
export class TraceSampler {
  readonly fold = new TraceFold();
  private seq = 0;
  private last: StateSample | null = null;
  private lastItems: string | null = null;

  constructor(private readonly turnAt: (ts: number) => number | null = () => null) {}

  /** The newest sample emitted, or null before the first. */
  get latest(): StateSample | null {
    return this.last;
  }

  /** The newest items reading emitted, as JSON, or null. */
  get latestItems(): string | null {
    return this.lastItems;
  }

  /** Apply rows; return the samples they produced. */
  push(rows: readonly TraceRow[]): StateSample[] {
    const out: StateSample[] = [];
    for (const row of rows) {
      if (row.kind === "dict") {
        this.fold.learn(row.dict);
        continue;
      }
      this.fold.apply(row);
      const s = this.sampleOf(row.ts, row.kind === "key");
      if (s !== null) out.push(s);
    }
    return out;
  }

  private sampleOf(ts: number, restated: boolean): StateSample | null {
    const f = this.fold;
    const st = f.state;
    const items = f.itemSamples();
    const itemsText = items === null ? null : JSON.stringify(items);
    const hp = numOr(st.hp);
    const hpMax = numOr(st.hpMax);
    const pw = numOr(st.pw);
    const pwMax = numOr(st.pwMax);
    const next: StateSample = {
      ts,
      seq: 0,
      level: numOr(st.level),
      xp: numOr(st.xp),
      map: f.map,
      x: f.x,
      y: f.y,
      z: f.z,
      event_count: null,
      last_seq: null,
      money: numOr(f.sheet.money),
      quests_completed: f.questsDone,
      turn: null,
      zone: numOr(st.zone),
      area: numOr(st.area),
      items: null,
      // A gauge is a pair: both halves observed, or neither (the state row's rule).
      health: hp !== null && hpMax !== null ? hp : null,
      max_health: hp !== null && hpMax !== null ? hpMax : null,
      power: pw !== null && pwMax !== null ? pw : null,
      max_power: pw !== null && pwMax !== null ? pwMax : null,
      power_type: numOr(st.pwType),
      next_level_xp: numOr(st.xpMax),
    };
    const prev = this.last;
    const itemsChanged = itemsText !== null && itemsText !== this.lastItems;
    const scoredChanged = prev === null || SCORED.some((k) => next[k] !== prev[k]);
    const drifted =
      prev !== null &&
      ts - prev.ts >= SAMPLE_HEARTBEAT_MS &&
      (next.x !== prev.x || next.y !== prev.y || next.z !== prev.z || next.health !== prev.health || next.power !== prev.power);
    if (!scoredChanged && !itemsChanged && !drifted && !restated) return null;
    // Nothing observed (a key before the world, or a restarted child's before
    // its login): not a reading, so no sample, and the next is compared with
    // the last one that was.
    if (next.level === null && next.xp === null && next.money === null) return null;
    next.seq = ++this.seq;
    next.turn = this.turnAt(ts);
    if (itemsChanged) {
      next.items = itemsText;
      this.lastItems = itemsText;
    }
    this.last = next;
    return next;
  }
}

/**
 * The turn in flight at an instant, joined by timestamp against the
 * trajectory: the stack's rows carry no turn (SESSION-FORMAT.md, "calls"), so
 * a sample, a milestone or a feed line takes the turn of the newest `request`
 * record at or before it (decision 9 of wrath-mcp#29).
 *
 * A record's `turn` is the driver's count for its own process, which starts
 * again at 1 after a `--resume`. The run's turn is cumulative (what 0.5 stamped
 * on its samples), so each `resume` record moves the offset: to its own
 * `turnOffset` when it states one, else to the highest turn seen before it.
 */
export class TurnIndex {
  private readonly ts: number[] = [];
  private readonly turns: number[] = [];
  private offset = 0;
  private highest = 0;

  /** Feed one trajectory record, in file order. */
  note(rec: Record<string, unknown>): void {
    if (rec["t"] === "resume") {
      const stated = rec["turnOffset"];
      this.offset = typeof stated === "number" && Number.isInteger(stated) && stated >= 0 ? stated : this.highest;
      return;
    }
    // A turn starts with its request. Only these: other records stamp either
    // the driver's count or the cumulative one, and mixing them would bend the index.
    if (rec["t"] !== "request") return;
    const turn = rec["turn"];
    const ts = rec["ts"];
    if (typeof turn !== "number" || !Number.isInteger(turn) || turn <= 0 || typeof ts !== "number") return;
    const run = this.offset + turn;
    if (run > this.highest) this.highest = run;
    const lastTurn = this.turns[this.turns.length - 1];
    if (lastTurn === run) return;
    // Records are appended in time order; a late-stamped one keeps the index monotone in ts.
    const lastTs = this.ts[this.ts.length - 1];
    this.ts.push(lastTs !== undefined && ts < lastTs ? lastTs : ts);
    this.turns.push(run);
  }

  /** The highest turn the run has recorded, or 0: where a resumed run's numbering continues from. */
  get max(): number {
    return this.highest;
  }

  /** The turn in flight at `ts`, or null before the first. */
  at(ts: number): number | null {
    let lo = 0;
    let hi = this.ts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= ts) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? null : this.turns[found]!;
  }
}
