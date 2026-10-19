/**
 * The nearby player (`src/lib/nearbyplayer.ts`) over windows the viewer's own
 * codec encodes (`@viewer/nearby`): spline sampling at the map's playhead,
 * one dot per guid across characters, the packet-field classes, label
 * culling, the redraw throttle and the zoom gates. Units, names and guids are
 * invented.
 */
import { describe, expect, test } from "bun:test";
import { PUBLIC_NEARBY_SPAN_MS, encodeNearby, type NearbyRingRow, type NearbyRingUnit } from "@viewer/nearby";
import { cullLabels, classOf, createNearbyStore, nearbyFrameDue, placeLabel, questMark, NEARBY_FRAME_MS, NEARBY_SLACK_MS } from "../src/lib/nearbyplayer";
import { NEARBY_MIN_PX_PER_YD, NEARBY_NAME_PX_PER_YD, nearbyNamesShown, nearbyShown, pxPerYard } from "../src/lib/mapview";
import { targetReading } from "../src/lib/unitframe";
import { createLiveClock, horizonOf, liveCadence } from "../src/lib/traceplayer";
import { createSnapshotClient } from "../src/api/snapshot-client";

const T0 = 1_760_000_040_000;
const guid = (entry: number, low: number): string => ((0xf130n << 48n) | (BigInt(entry) << 24n) | BigInt(low)).toString(10);
const WOLF = guid(299, 1);
const VENDOR = guid(1250, 2);
const unit = (id: string, s: NearbyRingUnit["s"], x: number, ty: NearbyRingUnit["ty"] = "creature"): NearbyRingUnit => ({ id, ty, s, m: { k: "pos", t: T0, p: [x, 0, 0, 0] } });
const self = (guidStr: string, map = 0, target: string | null = null) => ({ guid: guidStr, map, target, down: false });

function windowOf(selfGuid: string, units: NearbyRingUnit[], extra: NearbyRingRow[] = [], horizon = T0 + 10_000, map = 0, target: string | null = null) {
  const rows: NearbyRingRow[] = [{ ts: T0, kind: "key", self: self(selfGuid, map, target), units }, ...extra, { ts: horizon, kind: "tick" }];
  return JSON.parse(JSON.stringify(encodeNearby(rows, { run: `run-${selfGuid}`, from: T0 }))) as ReturnType<typeof encodeNearby>;
}

describe("sampling at the playhead", () => {
  test("a creature on a spline is where the spline has it at the trace player's playhead", () => {
    const store = createNearbyStore();
    store.set(
      "a",
      windowOf("7", [unit(WOLF, { name: "Invented Wolf" }, 0)], [{ ts: T0 + 1500, kind: "mv", id: WOLF, m: { k: "mv", t: T0 + 1000, p: [0, 0, 0], to: [10, 0, 0], ms: 2000 } }]),
    );
    expect(store.dotsAt(T0 + 2000, 0)[0]).toMatchObject({ id: WOLF, x: 5, moving: true, name: "Invented Wolf" });
    expect(store.dotsAt(T0 + 4000, 0)[0]).toMatchObject({ x: 10, moving: false });
    // Just past the horizon it holds there (the two pods' clocks); further, and on another map, nothing.
    expect(store.dotsAt(T0 + 10_000 + NEARBY_SLACK_MS, 0)).toHaveLength(1);
    expect(store.dotsAt(T0 + 10_001 + NEARBY_SLACK_MS, 0)).toEqual([]);
    expect(store.dotsAt(T0 + 2000, 1)).toEqual([]);
  });

  test("a late answer never replaces a newer window", () => {
    const store = createNearbyStore();
    store.set("a", windowOf("7", [unit(WOLF, {}, 1)], [], T0 + 20_000));
    store.set("a", windowOf("7", [unit(WOLF, {}, 2)], [], T0 + 10_000));
    expect(store.dotsAt(T0 + 5_000, 0)[0]!.x).toBe(1);
    store.retain([]);
    expect(store.has("a")).toBe(false);
  });
});

describe("one dot per guid", () => {
  test("a unit two characters both see draws once, from the newer window, engaged if it targets either", () => {
    const store = createNearbyStore();
    store.set("a", windowOf("7", [unit(WOLF, { name: "Invented Wolf" }, 1), unit(VENDOR, { nf: 0x80 }, 9)], [], T0 + 10_000));
    store.set("b", windowOf("8", [unit(WOLF, { name: "Invented Wolf", tg: "8", tgs: true }, 2)], [], T0 + 12_000));
    const dots = store.dotsAt(T0 + 5_000, 0);
    expect(dots.map((d) => d.id).sort()).toEqual([WOLF, VENDOR].sort());
    const wolf = dots.find((d) => d.id === WOLF)!;
    expect(wolf).toMatchObject({ runId: "b", x: 2, cls: "engaged" });
    // The older window's view of it does not undo the newer one's.
    store.set("c", windowOf("9", [unit(WOLF, { name: "Invented Wolf" }, 3)], [], T0 + 11_000));
    expect(store.dotsAt(T0 + 5_000, 0).find((d) => d.id === WOLF)).toMatchObject({ runId: "b", cls: "engaged" });
  });

  test("the count and the character's own target, by window", () => {
    const store = createNearbyStore();
    store.set("a", windowOf("7", [unit(WOLF, { name: "Invented Wolf", level: 6 }, 1), unit(VENDOR, {}, 9)], [], T0 + 10_000, 0, WOLF));
    expect(store.countAt("a", T0 + 1000)).toBe(2);
    expect(store.targetAt("a", T0 + 1000)).toEqual({ id: WOLF, name: "Invented Wolf", level: 6 });
    expect(store.countAt("a", T0 + 99_000)).toBeNull();
    // A label kept out of a character's puck and name, which the pips draw over the layer.
    expect(cullLabels([{ x: 5, y: 5, w: 40, h: 12, rank: 0 }, { x: 100, y: 5, w: 40, h: 12, rank: 4 }], 60, [{ x: 0, y: 0, w: 30, h: 30 }])).toEqual([1]);
    expect(store.countAt("nobody", T0 + 1000)).toBeNull();
    // The unit frame names the target when the layer knows it, and says what the trace says otherwise.
    expect(targetReading({ kind: "creature", entry: 299, hpPct: 50 }, "Invented Wolf")).toMatchObject({ text: "Invented Wolf", pct: 50 });
    expect(targetReading({ kind: "creature", entry: 299, hpPct: 50 })).toMatchObject({ text: "creature 299" });
  });

  test("the hovered unit's label goes beside its dot on the first side clear of the pips, else where it covers least", () => {
    const at = (box: { x: number; y: number }) => [box.x, box.y];
    // Nothing in the way: on the right, as the culled names are.
    expect(at(placeLabel(100, 100, 3, 60, 14, []))).toEqual([106, 93]);
    // A character's puck and name to the right: on the left.
    const pip = { x: 90, y: 83, w: 120, h: 34 };
    expect(at(placeLabel(100, 100, 3, 60, 14, [pip]))).toEqual([34, 93]);
    // Both sides taken: below, then above.
    const left = { x: 0, y: 83, w: 95, h: 34 };
    expect(at(placeLabel(100, 100, 3, 60, 14, [pip, left]))).toEqual([70, 106]);
    const below = { x: 0, y: 105, w: 300, h: 40 };
    expect(at(placeLabel(100, 100, 3, 60, 14, [pip, left, below]))).toEqual([70, 80]);
    // Covered on every side: the side that covers least of them.
    const everywhere = [pip, left, below, { x: 0, y: 70, w: 300, h: 12 }];
    const placed = placeLabel(100, 100, 3, 60, 14, everywhere);
    expect(at(placed)).toEqual([70, 80]);
  });
});

describe("classes come from packet fields", () => {
  test("dead, engaged, player, service, other — in that order", () => {
    expect(classOf({ hp: 0, tgs: true, nf: 1 }, "creature")).toBe("dead");
    expect(classOf({ df: 0x21 }, "creature")).toBe("dead");
    expect(classOf({ tgs: true, nf: 1 }, "creature")).toBe("engaged");
    expect(classOf({ nf: 0x80 }, "player")).toBe("player");
    expect(classOf({ nf: 0x80 }, "creature")).toBe("service");
    expect(classOf({ df: 0x4 }, "creature")).toBe("other");
    expect([7, 8].map(questMark)).toEqual(["!", "!"]);
    expect([6, 9, 10].map(questMark)).toEqual(["?", "?", "?"]);
    expect([0, 1, 2, 5, undefined].map(questMark)).toEqual([null, null, null, null, null]);
  });
});

describe("labels", () => {
  test("greedy by rank: the first of two overlapping boxes wins, a clear one stays", () => {
    const kept = cullLabels([
      { x: 0, y: 0, w: 50, h: 12, rank: 4 },
      { x: 10, y: 4, w: 50, h: 12, rank: 1 },
      { x: 200, y: 0, w: 50, h: 12, rank: 4 },
      { x: 30, y: 2, w: 50, h: 12, rank: 0 },
    ]);
    expect(kept).toEqual([3, 2]);
  });

  test("a city's worth of names stays bounded and never overlaps", () => {
    const boxes = Array.from({ length: 300 }, (_, i) => ({ x: (i * 37) % 400, y: (i * 53) % 300, w: 60, h: 12, rank: i % 5 }));
    const kept = cullLabels(boxes, 40);
    expect(kept.length).toBeLessThanOrEqual(40);
    for (let i = 0; i < kept.length; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const a = boxes[kept[i]!]!;
        const b = boxes[kept[j]!]!;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
  });
});

describe("the throttle and the zoom gates", () => {
  test("NPC motion alone redraws at most every NEARBY_FRAME_MS", () => {
    expect(nearbyFrameDue(1000, 1000 + NEARBY_FRAME_MS - 1)).toBe(false);
    expect(nearbyFrameDue(1000, 1000 + NEARBY_FRAME_MS)).toBe(true);
  });

  test("the layer shows from about a pixel a yard, its names from further in", () => {
    const at = (pxYd: number) => pxYd / pxPerYard(1);
    expect(nearbyShown(at(NEARBY_MIN_PX_PER_YD) * 0.99)).toBe(false);
    expect(nearbyShown(at(NEARBY_MIN_PX_PER_YD))).toBe(true);
    expect(nearbyNamesShown(at(NEARBY_NAME_PX_PER_YD) * 0.99)).toBe(false);
    expect(nearbyNamesShown(at(NEARBY_NAME_PX_PER_YD))).toBe(true);
    expect(NEARBY_NAME_PX_PER_YD).toBeGreaterThan(NEARBY_MIN_PX_PER_YD);
  });
});

describe("the public layer", () => {
  /** The map's own poll (`POLL_MS` in `src/pages/MapPage.tsx`). */
  const POLL_MS = 5_000;
  const cadence = liveCadence(createSnapshotClient("https://data.invalid").feedCadence, POLL_MS);

  /**
   * Passes `periodMs` apart (± `jitterMs`), each reaching the tab `ageMs`
   * after it was rendered. From one arrival to the next, every second: how
   * far behind the pass in hand the playhead reaches, and how far past it.
   */
  function reach(periodMs: number, jitterMs: number, ageMs: (k: number) => number): { early: number; late: number } {
    const clock = createLiveClock(cadence);
    let g = 1_760_000_000_000;
    let early = 0;
    let late = -Infinity;
    for (let k = 0; k < 40; k++) {
      const at = g + ageMs(k);
      clock.arrive(horizonOf({ generatedAt: g, positions: [] }, at, at)!);
      const next = g + periodMs + (k % 2 === 0 ? jitterMs : -jitterMs);
      for (let p = at; p < next + ageMs(k + 1); p += 1_000) {
        const t = clock.at(p)!;
        early = Math.max(early, g - t);
        late = Math.max(late, t - g);
      }
      g = next;
    }
    return { early, late };
  }

  test("a pass's window reaches back as far as the public map's playhead goes before the next pass lands", () => {
    // The nominal cadence, an uneven one, and slow publishers; caches fresh, at their worst, and mixed.
    for (const [period, jitter] of [
      [420_000, 0],
      [400_000, 60_000],
      [480_000, 0],
      [600_000, 0],
    ] as const) {
      for (const age of [() => 0, () => 65_000, (k: number) => (k % 3) * 30_000]) {
        const { early, late } = reach(period, jitter, age);
        expect(early).toBeLessThanOrEqual(PUBLIC_NEARBY_SPAN_MS);
        expect(late).toBeLessThanOrEqual(0);
      }
    }
  });

  test("the same window handed in again is not decoded again; a newer one is", () => {
    let changes = 0;
    const store = createNearbyStore({ onChange: () => changes++ });
    const w = windowOf("7", [unit(WOLF, { name: "Invented Wolf" }, 0)]);
    store.set("a", w);
    store.set("a", w);
    expect(changes).toBe(1);
    store.set("a", windowOf("7", [unit(WOLF, { name: "Invented Wolf" }, 1)], [], T0 + 20_000));
    expect(changes).toBe(2);
    expect(store.dotsAt(T0 + 15_000, 0)[0]).toMatchObject({ x: 1 });
  });
});
