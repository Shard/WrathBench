/**
 * The map sidebar's money and inventory from the trace's character sheet:
 * the store's fold at a playhead (`TraceStore.sheetAt`), the sheet as the
 * panels' rows (`sheetItems`), and the ways the sidebar falls back to the
 * coarse reading — a segment from before the sheet, a sheet not yet observed,
 * half a sheet — so the panel never goes blank where the reading had something.
 *
 * The segments are encoded by the real codec from synthetic recorder rows,
 * and cross the real public projection. Every id, name and number here is
 * invented; nothing comes from a run.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, type TraceDictLookup, type TraceRow } from "@wrathbench/inspector/codec/trace";
import type { TraceItemName, TraceQuestReq, TraceSegment } from "../../viewer/api-types";
import { projectTraceSegment } from "../../viewer/public-projection";
import { sheetItems, sheetReading, type InvItem } from "@wrathbench/inspector/views/inventory";
import { createTraceStore } from "@wrathbench/inspector/views/traceplayer";

const RUN = "run-sheet";
const W = 1_760_000_100_000 - (1_760_000_100_000 % SEG_MS);
const A = W - SEG_MS;

/* Invented items: two worn (one with a random suffix), one worn bag, three carried. */
const NAMES: Record<number, TraceItemName> = {
  1001: [2, "Fixture Helm"],
  1002: [3, "Fixture Blade"],
  1004: [4, "Fixture Crown"],
  2001: [1, "Fixture Pack"],
  3001: [1, "Fixture Cloth"],
  3002: [2, "Fixture Ring"],
  3003: [0, "Fixture Bone"],
};
const DICT: TraceDictLookup = {
  item: (id) => NAMES[id],
  quest: (): TraceQuestReq | undefined => [4, 0, 0, 0],
};

const UNIT = { hp: 100, hpMax: 100, level: 20, auras: [] };
const SHEET = {
  money: 100,
  equip: [
    [0, 1001],
    [15, 1002, -40],
  ],
  bags: [[19, 2001, 16]],
  inv: [
    [19, 0, 3002, 5, 1106],
    [255, 23, 3001],
  ],
  dur: [
    [0, 20, 40],
    [15, 50, 75],
  ],
  quests: [[0, 900, 0, 2]],
  rep: [[72, 1200]],
  skills: [[43, 80, 100]],
};

const row = (ts: number, kind: TraceRow["kind"], data: unknown, x: number | null = null): TraceRow => ({
  ts,
  kind,
  map: x === null ? null : 0,
  x,
  y: x === null ? null : 0,
  z: x === null ? null : 0,
  o: x === null ? null : 0,
  data: data === null ? null : JSON.stringify(data),
});

/** A minute of walking per window, a key row at each window's start. */
function walk(t0: number, sheet: Record<string, unknown> | null): TraceRow[] {
  const out: TraceRow[] = [row(t0, "key", sheet === null ? UNIT : { ...UNIT, ...sheet }, 0)];
  for (let t = t0 + 1000; t < t0 + SEG_MS; t += 5000) out.push(row(t, "pos", null, (t - t0) / 1000));
  return out;
}

const ROWS: TraceRow[] = [
  ...walk(A, SHEET),
  row(A + 60_000, "state", { money: 150 }),
  row(A + 120_000, "state", { inv: [[255, 24, 3003, 2]] }),
  row(A + 180_000, "state", { inv: [[255, 23]], dur: [[0, 19, 40]] }),
  ...walk(W, {
    ...SHEET,
    money: 150,
    inv: [
      [19, 0, 3002, 5, 1106],
      [255, 24, 3003, 2],
    ],
    dur: [
      [0, 19, 40],
      [15, 50, 75],
    ],
  }),
  row(W + 30_000, "state", { equip: [[0, 1004]] }),
].sort((a, b) => a.ts - b.ts);

/** One window, encoded as the viewer would serve it, through JSON. */
function seg(rows: readonly TraceRow[], t0: number, dict: TraceDictLookup | undefined = DICT): TraceSegment {
  const inRange = rows.filter((r) => r.ts >= t0 - CONTEXT_MS && r.ts < t0 + SEG_MS);
  return JSON.parse(JSON.stringify(encodeSegment(inRange, { run: RUN, t0, t1: t0 + SEG_MS }, dict))) as TraceSegment;
}

async function loaded(segs: Map<number, TraceSegment>) {
  const store = createTraceStore();
  store.list(RUN, SEG_MS, [...segs.keys()]);
  for (const t0 of segs.keys()) await store.load(RUN, t0, async (_r, t) => segs.get(t)!);
  return store;
}

const READING: { money: number; items: InvItem[] } = {
  money: 7,
  items: [{ name: "Reading Cloth", count: 2, equipped: false, itemId: 4000, slot: 23, bag: 255 }],
};

const itemsOf = (store: Awaited<ReturnType<typeof loaded>>, t: number): InvItem[] | null => {
  const view = store.sheetAt(RUN, t);
  return view === null ? null : sheetItems(view.sheet, view.items);
};

describe("the store folds the sheet at the playhead", () => {
  const segs = new Map([
    [A, seg(ROWS, A)],
    [W, seg(ROWS, W)],
  ]);

  test("money and what is carried move with the playhead, each from its own window's names", async () => {
    const store = await loaded(segs);
    expect(store.sheetAt(RUN, A + 30_000)?.sheet.money).toBe(100);
    expect(store.sheetAt(RUN, A + 90_000)?.sheet.money).toBe(150);
    const early = itemsOf(store, A + 30_000)!;
    expect(early.map((i) => i.name)).toEqual(["Fixture Helm", "Fixture Blade", "Fixture Ring", "Fixture Cloth"]);
    expect(itemsOf(store, A + 150_000)!.map((i) => i.name)).toContain("Fixture Bone");
    expect(itemsOf(store, A + 200_000)!.map((i) => i.name)).not.toContain("Fixture Cloth");
    // Across the boundary the second window answers, with its own dictionary.
    expect(itemsOf(store, W + 10_000)!.find((i) => i.slot === 0 && i.equipped)?.name).toBe("Fixture Helm");
    expect(itemsOf(store, W + 40_000)!.find((i) => i.slot === 0 && i.equipped)).toMatchObject({ name: "Fixture Crown", itemId: 1004, quality: 4 });
  });

  test("a public segment reads the same: the sheet and its names pass the projection", () => {
    const at = (s: TraceSegment) => {
      const store = createTraceStore();
      store.setTail(RUN, s);
      return store.sheetAt(RUN, W + 1000)!;
    };
    const priv = at(seg(walk(W, SHEET), W));
    const pub = at(projectTraceSegment(seg(walk(W, SHEET), W)));
    expect(sheetItems(pub.sheet, pub.items)).toEqual(sheetItems(priv.sheet, priv.items));
    expect(pub.sheet.money).toBe(100);
  });
});

describe("the sidebar falls back to the reading wherever the sheet cannot say", () => {
  test("a segment from before the sheet, or a sheet not observed yet: the reading stands", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(walk(W, null), W));
    const v = store.sheetAt(RUN, W + 1000);
    expect(v).not.toBeNull();
    expect(v!.sheet.inv).toBeNull();
    expect(sheetReading(v, READING)).toEqual(READING);
    // A sandbox restart before the character's create block.
    const unseen = createTraceStore();
    unseen.setTail(RUN, seg(walk(W, { money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null }), W));
    expect(sheetReading(unseen.sheetAt(RUN, W + 1000), READING)).toEqual(READING);
  });

  test("half a sheet is not an inventory: the reading's items stand, the sheet's money is used", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(walk(W, { money: 321, equip: SHEET.equip }), W));
    const shown = sheetReading(store.sheetAt(RUN, W + 1000), READING);
    expect(shown.items).toBe(READING.items);
    expect(shown.money).toBe(321);
  });

  test("an observed empty inventory and no money are values, never a fallback", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(walk(W, { money: 0, equip: [], inv: [] }), W));
    expect(sheetReading(store.sheetAt(RUN, W + 1000), READING)).toEqual({ money: 0, items: [] });
  });
});
