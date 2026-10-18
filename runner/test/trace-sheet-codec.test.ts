/**
 * The character sheet in the trace codec (`runner/viewer/trace.ts`): the
 * keyframe states it whole, the event list carries patches and turn-ins, the
 * segment names exactly the ids it references, and `sheetAt` folds it at any
 * moment. Fixtures are rows in the recorder's shape; ids and names invented.
 */

import { describe, expect, test } from "bun:test";
import { applySheetPatch as writerPatch, SHEET_KEY_LEN as WRITER_KEY_LEN } from "../src/trace-row";
import {
  SEG_MS,
  STATE_KEYS,
  decodeSegment,
  emptyTraceSheet,
  emptyTraceState,
  encodeSegment,
  sheetAt,
  stateAt,
  type TraceDictLookup,
  type TraceItemName,
  type TraceQuestReq,
  type TraceRow,
  type TraceSheet,
  type TraceState,
} from "../viewer/trace";

const T0 = 1_760_000_100_000;
const W = { run: "sheet-run", t0: T0, t1: T0 + SEG_MS };

type Data = Record<string, unknown>;
const row = (ts: number, kind: string, data: Data | null): TraceRow => ({ ts, kind, map: null, x: null, y: null, z: null, o: null, data: data === null ? null : JSON.stringify(data) });
const key = (ts: number, sheet: Data, unit: Partial<TraceState> = {}): TraceRow => row(ts, "key", { ...emptyTraceState(), ...unit, ...emptyTraceSheet(), ...sheet });
const state = (ts: number, data: Data): TraceRow => row(ts, "state", data);
const pos = (ts: number, x: number): TraceRow => ({ ts, kind: "pos", map: 0, x, y: 0, z: 0, o: 0, data: null });

const SHEET = {
  money: 1000,
  equip: [[0, 501], [15, 502, -12]],
  bags: [[19, 600, 6]],
  inv: [[19, 0, 701, 3], [255, 23, 702]],
  dur: [[0, 40, 50]],
  quests: [[0, 900, 0, 2]],
  rep: [[72, 120]],
  skills: [[43, 31, 60]],
} satisfies Partial<Record<keyof TraceSheet, unknown>>;

/** A dictionary that knows some ids and not others. */
function dict(): TraceDictLookup & { asked: number[] } {
  const items = new Map<number, TraceItemName>([
    [501, [2, "Test Blade"]],
    [502, [3, "Test Bow"]],
    [600, [1, "Test Pouch"]],
    [701, [1, "Test Stone"]],
    [702, [0, "Test Scrap"]],
    [703, [1, "Test Token"]],
    [704, [1, "Test Herb"]],
    [999, [4, "Never Referenced"]],
  ]);
  const quests = new Map<number, TraceQuestReq>([
    [900, [8, 0, 0, 0, [704, 5]]],
    [901, [0, 0, 0, 0]],
    [998, [1, 0, 0, 0]],
  ]);
  const asked: number[] = [];
  return {
    asked,
    item: (id) => {
      asked.push(id);
      return items.get(id);
    },
    quest: (id) => quests.get(id),
  };
}

/** The writer's own fold, from the runner's spelling of the patch rule: what `sheetAt` must agree with. */
function writerFold(rows: TraceRow[], until: number): TraceSheet {
  let s = emptyTraceSheet();
  for (const r of rows) {
    if (r.ts > until) break;
    const d = r.data === null ? {} : (JSON.parse(r.data) as Data);
    if (r.kind === "key") s = { ...emptyTraceSheet(), ...Object.fromEntries(Object.entries(d).filter(([k]) => k in s)) } as TraceSheet;
    if (r.kind !== "state") continue;
    if (d["money"] !== undefined) s = { ...s, money: d["money"] as number };
    for (const k of Object.keys(WRITER_KEY_LEN) as (keyof typeof WRITER_KEY_LEN)[]) {
      if (d[k] !== undefined) s = { ...s, [k]: writerPatch(s[k], d[k] as number[][], WRITER_KEY_LEN[k]) };
    }
  }
  return s;
}

const sheetOnly = (s: TraceSheet & { qdone?: number[] }): TraceSheet => {
  const { qdone: _q, ...rest } = s;
  return rest;
};

function busyWindow(): TraceRow[] {
  return [
    key(T0 - 200_000, SHEET, { hp: 100, hpMax: 100 }),
    // Context: before t0, folded into the keyframe.
    state(T0 - 100_000, { money: 1200, inv: [[255, 24, 703]] }),
    pos(T0 + 1_000, 1),
    state(T0 + 10_000, { inv: [[255, 24, 703, 2]], money: 1210 }),
    state(T0 + 20_000, { hp: 80 }),
    state(T0 + 30_000, { quests: [[0, 900, 0, 5]], skills: [[43, 32, 60]] }),
    // A patch that changes nothing says nothing.
    state(T0 + 40_000, { inv: [[255, 23, 702]], rep: [[72, 120]] }),
    // A turn-in, twice the same repeatable quest, then the log slot empties.
    state(T0 + 50_000, { qdone: [900], quests: [[0]] }),
    state(T0 + 60_000, { qdone: [900] }),
    state(T0 + 70_000, { quests: [[1, 901, 0]], equip: [[15]], dur: [[0, 39, 50]] }),
    // A key mid-window (the child restarted): its sheet is whole, the change is a patch.
    key(T0 + 100_000, { ...SHEET, money: 1500, inv: [[255, 23, 702]], quests: [[1, 901, 1]], equip: [[0, 501]] }),
    state(T0 + 200_000, { inv: [[255, 23]] }),
  ];
}

describe("the sheet in a segment", () => {
  test("a run that recorded no sheet encodes as before: unit keys only in the keyframe, no dictionaries, and it decodes as not recorded", () => {
    const seg = encodeSegment([row(T0 - 1_000, "key", { ...emptyTraceState(), hp: 5 }), pos(T0 + 1, 1), state(T0 + 2, { hp: 4 })], W, dict());
    expect(Object.keys(seg.k.s)).toEqual([...STATE_KEYS]);
    expect(seg.items).toBeUndefined();
    expect(seg.qreq).toBeUndefined();
    const d = decodeSegment(JSON.parse(JSON.stringify(seg)));
    expect(d.sheet).toEqual(emptyTraceSheet());
    expect(sheetAt(d, T0 + 100)).toEqual({ ...emptyTraceSheet(), qdone: [] });
  });

  test("the keyframe states the sheet whole at t0, the events are patches, and sheetAt agrees with the writer's fold at every row", () => {
    const rows = busyWindow();
    const seg = encodeSegment(rows, W, dict());
    expect(seg.k.s.money).toBe(1200);
    expect(seg.k.s.inv).toEqual([
      [19, 0, 701, 3],
      [255, 23, 702],
      [255, 24, 703],
    ]);
    // Every list event is the change only, never the list.
    const sheetEv = seg.ev.filter((e) => !(STATE_KEYS as readonly string[]).includes(e[1]));
    expect(sheetEv).toEqual([
      [10_000, "money", 1210],
      [10_000, "inv", [[255, 24, 703, 2]]],
      [30_000, "quests", [[0, 900, 0, 5]]],
      [30_000, "skills", [[43, 32, 60]]],
      [50_000, "quests", [[0]]],
      [50_000, "qdone", [900]],
      [60_000, "qdone", [900]],
      [70_000, "equip", [[15]]],
      [70_000, "dur", [[0, 39, 50]]],
      [70_000, "quests", [[1, 901, 0]]],
      [100_000, "money", 1500],
      [100_000, "inv", [[19, 0], [255, 24]]],
      [100_000, "dur", [[0, 40, 50]]],
      [100_000, "quests", [[1, 901, 1]]],
      [100_000, "skills", [[43, 31, 60]]],
      [200_000, "inv", [[255, 23]]],
    ]);
    const d = decodeSegment(JSON.parse(JSON.stringify(seg)));
    for (const r of rows) {
      if (r.ts < T0) continue;
      expect(sheetOnly(sheetAt(d, r.ts))).toEqual(writerFold(rows, r.ts));
    }
    expect(sheetAt(d, T0 + 55_000).qdone).toEqual([900]);
    expect(sheetAt(d, T0 + 65_000).qdone).toEqual([900, 900]);
    // The unit state is untouched by the sheet.
    expect(stateAt(d, T0 + 25_000)).toEqual({ ...emptyTraceState(), hp: 80, hpMax: 100 });
    expect(d.events.every((e) => (STATE_KEYS as readonly string[]).includes(e.kind))).toBe(true);
  });

  test("the dictionaries hold exactly the ids the segment references, and the items its quests ask for", () => {
    const lookup = dict();
    const seg = encodeSegment(busyWindow(), W, lookup);
    expect(seg.items).toEqual({
      501: [2, "Test Blade"],
      502: [3, "Test Bow"],
      600: [1, "Test Pouch"],
      701: [1, "Test Stone"],
      702: [0, "Test Scrap"],
      703: [1, "Test Token"],
      704: [1, "Test Herb"],
    });
    expect(seg.qreq).toEqual({ 900: [8, 0, 0, 0, [704, 5]], 901: [0, 0, 0, 0] });
    expect(lookup.asked).not.toContain(999);
    const d = decodeSegment(JSON.parse(JSON.stringify(seg)));
    expect(d.items.get(704)).toEqual([1, "Test Herb"]);
    expect(d.qreq.get(900)).toEqual([8, 0, 0, 0, [704, 5]]);
    // Without a dictionary the ids stand alone.
    expect(encodeSegment(busyWindow(), W).items).toBeUndefined();
  });

  test("encoding is deterministic, and the dictionaries come out in id order", () => {
    const a = JSON.stringify(encodeSegment(busyWindow(), W, dict()));
    const b = JSON.stringify(encodeSegment(busyWindow(), W, dict()));
    expect(a).toBe(b);
    expect(Object.keys(JSON.parse(a).items)).toEqual(["501", "502", "600", "701", "702", "703", "704"]);
  });

  test("sheetAt is memoised: no event crossed is the same object; moving on applies only what it crossed; going back refolds", () => {
    const d = decodeSegment(encodeSegment(busyWindow(), W, dict()));
    const a = sheetAt(d, T0 + 12_000);
    expect(sheetAt(d, T0 + 15_000)).toBe(a);
    const b = sheetAt(d, T0 + 35_000);
    expect(b).not.toBe(a);
    expect(a.skills).toEqual([[43, 31, 60]]);
    expect(b.skills).toEqual([[43, 32, 60]]);
    // The earlier answer was not mutated by the later fold.
    expect(a.quests).toEqual([[0, 900, 0, 2]]);
    const back = sheetAt(d, T0 + 12_000);
    expect(back).toEqual(a);
  });

  test("malformed sheet values are dropped, never carried: a row with text, an object for a list, an out-of-shape dictionary entry", () => {
    const rows = [
      row(T0 - 1_000, "key", { ...emptyTraceState(), money: "lots", inv: { a: 1 }, equip: [[0, "Blade"], [1, 5]], quests: [[0, 900, 0, 1, 2, 3, 4, 5, 6]] }),
      state(T0 + 1, { inv: [[255, 23, 702, "x"]], skills: "none", qdone: ["Title"] }),
    ];
    const seg = encodeSegment(rows, W, { item: () => [1, "ok"], quest: () => [1, 2, 3, 4, [5, 6], ["x", 1]] as unknown as TraceQuestReq });
    expect(seg.k.s.money).toBeUndefined();
    expect(seg.k.s.inv).toBeUndefined();
    expect(seg.k.s.equip).toEqual([[1, 5]]);
    expect(seg.k.s.quests).toEqual([[0, 900, 0, 1, 2, 3, 4]]);
    expect(seg.ev).toEqual([]);
    expect(seg.qreq).toEqual({ 900: [1, 2, 3, 4, [5, 6]] });
    // A decoder reads a hand-made segment the same way.
    const d = decodeSegment({ ...seg, ev: [[5, "inv", [[255, 23, "x"]]], [6, "qdone", "x"], [7, "money", null]], items: { 5: [1, 2] as unknown as TraceItemName, x: [1, "y"] } });
    expect(d.sheetEvents).toEqual([{ t: T0 + 7, kind: "money", value: null }]);
    expect(d.items.size).toBe(0);
  });
});
