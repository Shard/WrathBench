/**
 * The map sidebar's quest log from the trace's character sheet: the store's
 * fold at a playhead joined with the segment's required counts (`questLog`),
 * each objective's `have / need` — a counter for a creature or gameobject, what
 * is carried for an item — the slot state's complete and failed bits, the
 * turn-ins since the window began, and every way the sheet cannot say, which
 * has no coarser reading behind it and so draws no quest button at all.
 *
 * The segments are encoded by the real codec from synthetic recorder rows,
 * and cross the real public projection. Every id, name and number here is
 * invented; nothing comes from a run.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, type TraceDictLookup, type TraceRow } from "@viewer/trace";
import type { TraceItemName, TraceQuestReq, TraceSegment } from "../../runner/viewer/api-types";
import { projectTraceSegment } from "../../runner/viewer/public-projection";
import { QUEST_STATUS_LABEL, objectiveText, questLog, questsInLog, type QuestRow } from "../src/lib/questlog";
import { createTraceStore } from "../src/lib/traceplayer";

const RUN = "run-quests";
const W = 1_760_000_100_000 - (1_760_000_100_000 % SEG_MS);
const A = W - SEG_MS;

const NAMES: Record<number, TraceItemName> = {
  1001: [2, "Fixture Helm"],
  2001: [1, "Fixture Pack"],
  5001: [1, "Fixture Pelt"],
  5002: [1, "Fixture Fang"],
  5003: [2, "Fixture Charm"],
};

/**
 * Invented quests: 900 two kill counters, 901 a pelt to collect (8), 902 a
 * fang and a charm, 903 nothing to count (a message to deliver), 904 a kill
 * counter and the pack worn as a bag. 905 has no counts in the dictionary.
 */
const REQS: Record<number, TraceQuestReq> = {
  900: [6, 0, 10, 0],
  901: [0, 0, 0, 0, [5001, 8]],
  902: [0, 0, 0, 0, [5002, 3], [5003, 1]],
  903: [0, 0, 0, 0],
  904: [4, 0, 0, 0, [2001, 1]],
};
const DICT: TraceDictLookup = { item: (id) => NAMES[id], quest: (id) => REQS[id] };

const UNIT = { hp: 100, hpMax: 100, level: 20, auras: [] };
const SHEET = {
  money: 100,
  equip: [
    [0, 1001],
    [12, 5003],
  ],
  bags: [[19, 2001, 16]],
  inv: [
    [19, 0, 5001, 3],
    [255, 23, 5001, 2],
    [255, 24, 5002],
  ],
  dur: [[0, 20, 40]],
  // Slot order is not id order: the log reads by slot.
  quests: [
    [0, 902, 0],
    [1, 900, 0, 2],
    [3, 901, 0],
    [4, 903, 1],
    [6, 904, 2, 1],
    [9, 905, 0, 1, 2],
  ],
  rep: [],
  skills: [],
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

/** One window, encoded as the viewer would serve it, through JSON. */
function seg(rows: readonly TraceRow[], t0: number, dict: TraceDictLookup = DICT): TraceSegment {
  const inRange = rows.filter((r) => r.ts >= t0 - CONTEXT_MS && r.ts < t0 + SEG_MS);
  return JSON.parse(JSON.stringify(encodeSegment(inRange, { run: RUN, t0, t1: t0 + SEG_MS }, dict))) as TraceSegment;
}

type Store = ReturnType<typeof createTraceStore>;

const logAt = (store: Store, t: number): QuestRow[] | null => {
  const view = store.sheetAt(RUN, t);
  return view === null ? null : questLog(view.sheet, view.qreq, view.items);
};

function tailOf(rows: readonly TraceRow[], t0: number = W): Store {
  const store = createTraceStore();
  store.setTail(RUN, seg(rows, t0));
  return store;
}

describe("the quest log at the playhead", () => {
  const log = logAt(tailOf(walk(W, SHEET)), W + 1000)!;
  const quest = (id: number): QuestRow => log.find((q) => q.questId === id)!;

  test("one row per quest, in log-slot order", () => {
    expect(log.map((q) => [q.slot, q.questId])).toEqual([
      [0, 902],
      [1, 900],
      [3, 901],
      [4, 903],
      [6, 904],
      [9, 905],
    ]);
    expect(questsInLog(log)).toBe(6);
  });

  test("a counter objective is its counter against the quest's count, a trimmed counter reading 0", () => {
    // 900: counters [2] on the wire (the rest trimmed), counts [6, 0, 10, 0]: the second slot is no objective.
    expect(quest(900).objectives).toEqual([
      { have: 2, need: 6 },
      { have: 0, need: 10 },
    ]);
    expect(quest(900).objectives!.map(objectiveText)).toEqual(["2 / 6", "0 / 10"]);
  });

  test("an item objective has no counter: it is what is carried — backpack, a worn bag's slots, equipment, the worn bag itself — capped at the count needed", () => {
    // 901: 3 in the worn bag and 2 in the backpack.
    expect(quest(901).objectives).toEqual([{ have: 5, need: 8, itemId: 5001, name: "Fixture Pelt" }]);
    // 902: one fang carried; the charm is worn, and counts.
    expect(quest(902).objectives).toEqual([
      { have: 1, need: 3, itemId: 5002, name: "Fixture Fang" },
      { have: 1, need: 1, itemId: 5003, name: "Fixture Charm" },
    ]);
    // 904: a counter, then the pack the character wears as a bag.
    expect(quest(904).objectives).toEqual([
      { have: 1, need: 4 },
      { have: 1, need: 1, itemId: 2001, name: "Fixture Pack" },
    ]);
    // More carried than needed reads as the count needed, as the server keeps it.
    const more = logAt(tailOf(walk(W, { ...SHEET, inv: [[255, 23, 5001, 20]] })), W + 1000)!;
    expect(more.find((q) => q.questId === 901)!.objectives).toEqual([{ have: 8, need: 8, itemId: 5001, name: "Fixture Pelt" }]);
  });

  test("the slot state's bits: 1 complete, 2 failed, neither in progress", () => {
    expect(quest(900).status).toBe("active");
    expect(quest(903).status).toBe("complete");
    expect(quest(904).status).toBe("failed");
    // Nothing to count: the state is all there is to show.
    expect(quest(903).objectives).toEqual([]);
    expect(QUEST_STATUS_LABEL[quest(903).status]).toBe("complete");
  });

  test("a quest the segment carries no counts for has no objectives, never zeros", () => {
    expect(quest(905).objectives).toBeNull();
  });

  test("an item the dictionary does not name still counts, and has no name", () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(walk(W, SHEET), W, { item: (id) => (id === 5001 ? undefined : NAMES[id]), quest: (id) => REQS[id] }));
    expect(logAt(store, W + 1000)!.find((q) => q.questId === 901)!.objectives).toEqual([{ have: 5, need: 8, itemId: 5001 }]);
  });

  test("progress follows the playhead: a counter climbs, a pickup counts, the state flips to complete", () => {
    const rows = [
      ...walk(W, SHEET),
      row(W + 30_000, "state", { quests: [[1, 900, 0, 3]] }),
      row(W + 60_000, "state", { inv: [[255, 25, 5001, 3]] }),
      row(W + 90_000, "state", { quests: [[3, 901, 1]] }),
    ].sort((a, b) => a.ts - b.ts);
    const store = tailOf(rows);
    const at = (t: number, id: number) => logAt(store, t)!.find((q) => q.questId === id)!;
    expect(at(W + 10_000, 900).objectives![0]).toEqual({ have: 2, need: 6 });
    expect(at(W + 40_000, 900).objectives![0]).toEqual({ have: 3, need: 6 });
    expect(at(W + 40_000, 901).objectives![0]!.have).toBe(5);
    expect(at(W + 70_000, 901).objectives![0]!.have).toBe(8);
    expect(at(W + 70_000, 901).status).toBe("active");
    expect(at(W + 100_000, 901).status).toBe("complete");
  });

  test("a public segment reads the same: the log, its counts and the items' names pass the projection", () => {
    const store = createTraceStore();
    store.setTail(RUN, projectTraceSegment(seg(walk(W, SHEET), W)));
    expect(logAt(store, W + 1000)).toEqual(log);
  });
});

describe("turn-ins in the loaded window", () => {
  const rows = [
    ...walk(A, SHEET),
    // The server's receipt lands a moment before the log loses the quest.
    row(A + 100_000, "state", { qdone: [903] }),
    row(A + 100_020, "state", { quests: [[4]] }),
    ...walk(W, { ...SHEET, quests: SHEET.quests.filter((q) => q[1] !== 903) }),
  ].sort((a, b) => a.ts - b.ts);
  const segs = new Map([
    [A, seg(rows, A)],
    [W, seg(rows, W)],
  ]);
  async function loaded(): Promise<Store> {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, [...segs.keys()]);
    for (const t0 of segs.keys()) await store.load(RUN, t0, async (_r, t) => segs.get(t)!);
    return store;
  }

  test("a quest turned in shows once, after the log, and is not counted on the button", async () => {
    const store = await loaded();
    const before = logAt(store, A + 50_000)!;
    expect(before.find((q) => q.questId === 903)).toMatchObject({ slot: 4, status: "complete" });
    // Between the receipt and the log's patch the log's row stands.
    expect(logAt(store, A + 100_010)!.find((q) => q.questId === 903)).toMatchObject({ slot: 4, status: "complete" });
    const after = logAt(store, A + 150_000)!;
    expect(after.at(-1)).toEqual({ questId: 903, slot: null, status: "turnedIn", objectives: null });
    expect(after.filter((q) => q.questId === 903)).toHaveLength(1);
    expect(questsInLog(after)).toBe(5);
    expect(after.length).toBe(6);
  });

  test("the next window starts clean: a turn-in is the window's own", async () => {
    const store = await loaded();
    const next = logAt(store, W + 10_000)!;
    expect(next.some((q) => q.questId === 903)).toBe(false);
    expect(questsInLog(next)).toBe(5);
  });
});

describe("the same array while the log says the same thing", () => {
  const rows = [
    ...walk(W, SHEET),
    row(W + 30_000, "state", { money: 150 }),
    row(W + 60_000, "state", { inv: [[255, 30, 1001]] }),
    row(W + 90_000, "state", { quests: [[1, 900, 0, 3]] }),
  ].sort((a, b) => a.ts - b.ts);

  test("a frame, a money change and an item no quest asks for give back the very same array", () => {
    const store = tailOf(rows);
    const a = logAt(store, W + 10_000)!;
    expect(logAt(store, W + 20_000)).toBe(a);
    expect(logAt(store, W + 40_000)).toBe(a);
    expect(logAt(store, W + 70_000)).toBe(a);
  });

  test("a counter change: a new array, every other row the very same object", () => {
    const store = tailOf(rows);
    const a = logAt(store, W + 70_000)!;
    const b = logAt(store, W + 100_000)!;
    expect(b).not.toBe(a);
    expect(b.find((q) => q.questId === 900)).not.toBe(a.find((q) => q.questId === 900));
    for (const id of [901, 902, 903, 904, 905]) expect(b.find((q) => q.questId === id)).toBe(a.find((q) => q.questId === id));
  });

  test("the live tail polled anew, then the window arriving closed, gives back the very same array", async () => {
    const store = createTraceStore();
    store.setTail(RUN, seg(rows.filter((r) => r.ts < W + 50_000), W));
    const a = logAt(store, W + 45_000)!;
    store.setTail(RUN, seg(rows.filter((r) => r.ts < W + 55_000), W));
    expect(logAt(store, W + 45_000)).toBe(a);
    store.list(RUN, SEG_MS, [W]);
    await store.load(RUN, W, async () => seg(rows, W));
    store.setTail(RUN, null);
    expect(logAt(store, W + 45_000)).toBe(a);
  });
});

describe("where the sheet cannot say there is no quest log", () => {
  test("a segment from before the sheet: no log, rather than an empty one", () => {
    const store = tailOf(walk(W, null));
    expect(store.sheetAt(RUN, W + 1000)).not.toBeNull();
    expect(logAt(store, W + 1000)).toBeNull();
  });

  test("a sheet not observed yet (a sandbox restart before the character's create block): no log", () => {
    const nulls = { money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null };
    expect(logAt(tailOf(walk(W, nulls)), W + 1000)).toBeNull();
  });

  test("nothing loaded at the playhead: no view, so no log", async () => {
    const store = createTraceStore();
    store.list(RUN, SEG_MS, [A, W]);
    await store.load(RUN, W, async () => seg(walk(W, SHEET), W));
    expect(store.sheetAt(RUN, A + 1000)).toBeNull();
    expect(logAt(store, A + 1000)).toBeNull();
  });

  test("an observed empty log is a value: an empty list, and a 0 on the button", () => {
    const log = logAt(tailOf(walk(W, { ...SHEET, quests: [] })), W + 1000);
    expect(log).toEqual([]);
    expect(questsInLog(log!)).toBe(0);
  });

  test("a log whose carried items were not observed: an item objective's have is unknown, a counter's is not", () => {
    const log = questLog(
      { quests: [[0, 904, 0, 1]], equip: [], bags: null, inv: [] },
      new Map([[904, REQS[904]!]]),
      new Map(),
    )!;
    expect(log[0]!.objectives).toEqual([
      { have: 1, need: 4 },
      { have: null, need: 1, itemId: 2001 },
    ]);
    expect(log[0]!.objectives!.map(objectiveText)).toEqual(["1 / 4", "— / 1"]);
  });
});
