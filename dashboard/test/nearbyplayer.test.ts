/**
 * The nearby player (`@wrathbench/inspector/views/nearbyplayer`) over windows the viewer's own
 * codec encodes (`@wrathbench/inspector/codec/nearby`): spline sampling at the map's playhead,
 * one dot per guid across characters, and the public window's reach. Units,
 * names and guids are invented.
 */
import { describe, expect, test } from "bun:test";
import { encodeNearby, type NearbyRingRow, type NearbyRingUnit } from "@wrathbench/inspector/codec/nearby";
import { PUBLIC_NEARBY_SPAN_MS } from "@viewer/public-keys";
import { createNearbyStore, NEARBY_SLACK_MS } from "@wrathbench/inspector/views/nearbyplayer";
import { createLiveClock, horizonOf, liveCadence } from "@wrathbench/inspector/views/traceplayer";
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
  });

  test("a unit two characters both see draws once, from the newer window, engaged if it targets either", () => {
    const store = createNearbyStore();
    store.set("a", windowOf("7", [unit(WOLF, { name: "Invented Wolf" }, 1), unit(VENDOR, { nf: 0x80 }, 9)], [], T0 + 10_000));
    store.set("b", windowOf("8", [unit(WOLF, { name: "Invented Wolf", tg: "8", tgs: true }, 2)], [], T0 + 12_000));
    const dots = store.dotsAt(T0 + 5_000, 0);
    expect(dots.map((d) => d.id).sort()).toEqual([WOLF, VENDOR].sort());
    expect(dots.find((d) => d.id === WOLF)).toMatchObject({ runId: "b", x: 2, cls: "engaged" });
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
});
