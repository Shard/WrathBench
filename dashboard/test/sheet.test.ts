/**
 * The map sidebar's money and inventory from the trace's character sheet:
 * the store's fold at a playhead (`TraceStore.sheetAt`), the sheet as the
 * panels' rows (`sheetItems`), and every way the sidebar falls back to the
 * coarse reading — no trace at the playhead, a segment from before the sheet,
 * a sheet not yet observed, a replay playing faster than its segments are
 * fetched for — so the panel never goes blank where the reading had something.
 *
 * The segments are encoded by the real codec from synthetic recorder rows,
 * and cross the real public projection. Every id, name and number here is
 * invented; nothing comes from a run.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, type TraceDictLookup, type TraceRow } from "@viewer/trace";
import type { ItemSample, TraceItemName, TraceQuestReq, TraceSegment } from "../../runner/viewer/api-types";
import { projectTraceSegment } from "../../runner/viewer/public-projection";
import { carried, carriedCount, paperdoll, sheetItems, sheetReading, type InvItem } from "../src/lib/inventory";
import { TRACE_MAX_SPEED, traceDrives } from "../src/lib/playback";
import { createTraceStore } from "../src/lib/traceplayer";
import { itemUrl } from "../src/lib/wowhead";

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

  test("the open tail answers the same way", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(ROWS.filter((r) => r.ts < W + 45_000), W));
    expect(store.sheetAt(RUN, W + 40_000)?.sheet.money).toBe(150);
    expect(itemsOf(store, W + 40_000)!.find((i) => i.equipped && i.slot === 0)?.name).toBe("Fixture Crown");
  });

  test("a frame that crosses no list change gets the very same array, and an unchanged row its very object", async () => {
    const store = await loaded(segs);
    const a = itemsOf(store, A + 30_000)!;
    // A money change between them: a new sheet, the same lists.
    expect(store.sheetAt(RUN, A + 30_000)?.sheet).not.toBe(store.sheetAt(RUN, A + 90_000)?.sheet);
    expect(itemsOf(store, A + 90_000)).toBe(a);
    expect(itemsOf(store, A + 100_000)).toBe(a);
    // A patch: a new array, the untouched rows the same objects.
    const b = itemsOf(store, A + 150_000)!;
    expect(b).not.toBe(a);
    expect(b.find((i) => i.name === "Fixture Ring")).toBe(a.find((i) => i.name === "Fixture Ring"));
  });

  test("a window decoded again — the live tail polled anew, then arriving closed — gives back the very same array", async () => {
    const store = createTraceStore();
    const tail = (upTo: number) => seg(ROWS.filter((r) => r.ts < upTo), W);
    store.setTail(RUN, tail(W + 20_000));
    const a = itemsOf(store, W + 10_000)!;
    // The next poll: a new tail, decoded afresh, new arrays and a new dictionary.
    store.setTail(RUN, tail(W + 25_000));
    expect(itemsOf(store, W + 20_000)).toBe(a);
    // The window closes and arrives as a segment of its own.
    store.list(RUN, SEG_MS, [W]);
    await store.load(RUN, W, async () => segs.get(W)!);
    store.setTail(RUN, null);
    expect(itemsOf(store, W + 20_000)).toBe(a);
    // A change past it: a new array, the rows that did not change the same objects.
    const b = itemsOf(store, W + 40_000)!;
    expect(b).not.toBe(a);
    expect(b.find((i) => i.itemId === 3002)).toBe(a.find((i) => i.itemId === 3002));
  });

  test("a listed window still loading answers null, and the sidebar keeps the reading", async () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, [A, W]);
    await store.load(RUN, W, async () => segs.get(W)!);
    expect(store.sheetAt(RUN, A + 30_000)).toBeNull();
    expect(sheetReading(store.sheetAt(RUN, A + 30_000), READING)).toEqual(READING);
    expect(store.sheetAt("another-run", W + 1000)).toBeNull();
  });
});

describe("the sheet as the panels' rows", () => {
  const view = (over: Record<string, unknown> = {}, names: Record<number, TraceItemName> = NAMES) => {
    const store = createTraceStore();
    const rows = walk(W, { ...SHEET, ...over });
    store.setTail(RUN, seg(rows, W, { item: (id) => names[id], quest: () => undefined }));
    return store.sheetAt(RUN, W + 1000)!;
  };

  test("a random property and a worn item's durability ride the row, and the link carries the roll", () => {
    const items = sheetItems(view().sheet, view().items)!;
    const blade = items.find((i) => i.itemId === 1002)!;
    expect(blade).toMatchObject({ equipped: true, slot: 15, rand: -40, durability: [50, 75], quality: 3 });
    expect(itemUrl(blade.itemId!, blade.rand)).toBe("https://www.wowhead.com/wotlk/item=1002?rand=-40");
    const ring = items.find((i) => i.itemId === 3002)!;
    expect(ring).toMatchObject({ equipped: false, bag: 19, slot: 0, count: 5, rand: 1106 });
    expect(ring.durability).toBeUndefined();
    const helm = items.find((i) => i.itemId === 1001)!;
    expect(helm.rand).toBeUndefined();
    expect(itemUrl(helm.itemId!, helm.rand)).toBe("https://www.wowhead.com/wotlk/item=1001");
  });

  test("worn bags are not items, as they are not on the 60 s reading", () => {
    const items = sheetItems(view().sheet, view().items)!;
    expect(items.some((i) => i.itemId === 2001)).toBe(false);
    expect(items.filter((i) => !i.equipped)).toHaveLength(2);
  });

  test("the keyring and the currency slots have no square: they are not on the 60 s reading, and only a quest counts them", () => {
    const names = { ...NAMES, 3004: [1, "Fixture Key"], 3005: [1, "Fixture Token"] } as Record<number, TraceItemName>;
    const withKeys = view({ inv: [...SHEET.inv, [255, 86, 3004], [255, 117, 3004], [255, 118, 3005, 12], [255, 149, 3005]] }, names);
    const items = sheetItems(withKeys.sheet, withKeys.items)!;
    // The same rows as the sheet without them, and the bag button's count with them.
    expect(items.map((i) => [i.bag, i.slot, i.itemId])).toEqual(sheetItems(view().sheet, view().items)!.map((i) => [i.bag, i.slot, i.itemId]));
    expect(items.some((i) => i.itemId === 3004 || i.itemId === 3005)).toBe(false);
    expect(carriedCount(items)).toBe(2);
    // The sheet itself still holds them, where the quest log reads them.
    expect(withKeys.sheet.inv!.filter((r) => r[0] === 255 && r[1] >= 86)).toHaveLength(4);
  });

  test("an id the dictionary does not name reads as the state line labels it, and still links", () => {
    const v = view({ inv: [[255, 23, 3001], [255, 24, 0], [255, 25, 9999]] }, { 3001: [1, "Fixture Cloth"] });
    const items = sheetItems(v.sheet, v.items)!;
    expect(items.find((i) => i.slot === 25)).toEqual({ name: "item 9999", count: 1, equipped: false, itemId: 9999, slot: 25, bag: 255 });
    // An occupied slot whose item the cache has not seen created: no id to link.
    expect(items.find((i) => i.slot === 24)).toEqual({ name: "slot 24", count: 1, equipped: false, slot: 24, bag: 255 });
  });

  test("the panels arrange the sheet's rows as they arrange the reading's", () => {
    const v = view();
    const fromSheet = sheetItems(v.sheet, v.items)!;
    // The same character as `itemSample` (runner/src/loop.ts) writes it on the 60 s line.
    const sample: ItemSample[] = [
      { name: "Fixture Helm", count: 1, equipped: true, itemId: 1001, quality: 2, slot: 0 },
      { name: "Fixture Blade", count: 1, equipped: true, itemId: 1002, quality: 3, slot: 15 },
      { name: "Fixture Cloth", count: 1, equipped: false, itemId: 3001, quality: 1, slot: 23, bag: 255 },
      { name: "Fixture Ring", count: 5, equipped: false, itemId: 3002, quality: 2, slot: 0, bag: 19 },
    ];
    const plain = ({ name, count, equipped, itemId, quality, slot, bag }: InvItem) => ({ name, count, equipped, itemId, quality, slot, bag });
    expect(carried(fromSheet).map(plain)).toEqual(carried(sample).map(plain));
    const a = paperdoll(fromSheet);
    const b = paperdoll(sample);
    expect([...a.bySlot.entries()].map(([s, i]) => [s, plain(i)])).toEqual([...b.bySlot.entries()].map(([s, i]) => [s, plain(i)]));
    expect(a.unplaced).toEqual([]);
  });

  test("a public segment reads the same: the sheet and its names pass the projection", () => {
    const rows = walk(W, SHEET);
    const pub = projectTraceSegment(seg(rows, W));
    const store = createTraceStore();
    store.setTail(RUN, pub);
    const v = store.sheetAt(RUN, W + 1000)!;
    expect(sheetItems(v.sheet, v.items)).toEqual(sheetItems(view().sheet, view().items));
    expect(v.sheet.money).toBe(100);
  });
});

describe("the sidebar falls back to the reading wherever the sheet cannot say", () => {
  test("a segment from before the sheet: every key null, and the reading stands", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(walk(W, null), W));
    const v = store.sheetAt(RUN, W + 1000);
    expect(v).not.toBeNull();
    expect(v!.sheet.inv).toBeNull();
    expect(sheetReading(v, READING)).toEqual(READING);
  });

  test("a sheet not observed yet (a sandbox restart before the character's create block) reads as the one before it", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(walk(W, { money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null }), W));
    expect(sheetReading(store.sheetAt(RUN, W + 1000), READING)).toEqual(READING);
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

  test("no reading either: the sidebar says not recorded rather than inventing one", () => {
    expect(sheetReading(null, { money: null, items: null })).toEqual({ money: null, items: null });
  });

  test("the sheet answers live, paused and up to 60×; faster, the track's reading does", () => {
    expect(traceDrives(false, true, 3600)).toBe(true);
    expect(traceDrives(true, true, TRACE_MAX_SPEED)).toBe(true);
    expect(traceDrives(true, true, 10)).toBe(true);
    expect(traceDrives(true, true, 600)).toBe(false);
    expect(traceDrives(true, true, 3600)).toBe(false);
    expect(traceDrives(true, false, 3600)).toBe(true);
  });
});
