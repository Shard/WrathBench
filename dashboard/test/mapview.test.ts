/**
 * The map's view maths. Pure functions, so pip placement is checked here rather
 * than by looking at a canvas.
 *
 * The transform itself is `viewer/worldmap.ts` and is tested there; what
 * these pin is the layer the SPA adds — projection under a view, a fit that
 * never lands on NaN, a tile level that never overruns the cache, and the
 * derived state the page hangs off its feed. The last of those is a
 * regression: the derivation used to write back into signals it read, and the
 * map recursed.
 */

import { describe, expect, test } from "bun:test";
import type { AgentPosition, TrackResponse } from "../../viewer/api-types";
import { LOD_MAX, TILE_PX, worldToPixel } from "../../viewer/worldmap";
import {
  type Pip,
  MAX_SCALE,
  MIN_SCALE,
  DEFAULT_MAP,
  chooseMap,
  fitTo,
  TILE_CACHE_MAX,
  artLevel,
  TILE_MIN_PX,
  levelCells,
  project,
  syncPips,
  tileLevel,
} from "../src/lib/mapview";

/* The reactive build of solid-js stands behind this name for every dashboard
   test; `test/preload-solid.ts` installs it and says why. */
import { createComputed, createRoot, createSignal } from "solid-js";
import { createMapState } from "../src/lib/mapstate";
import { MEMBER_SLOTS, fanoutTrack, memberClass, memberToken } from "../src/lib/party";

const SCREEN = { w: 800, h: 600 };

/*
 * The canary for every graph test in the suite, this file's and the others'.
 * They all rest on `solid-js` resolving to the reactive build, which
 * `test/preload-solid.ts` arranges and `bunfig.toml` has to reach; without it
 * signals never notify and the derivation tests fail scattered and far from the
 * cause, which is exactly how this went unnoticed once already. Asserted here
 * so the first thing a reader sees is the reason.
 */
describe("the test run's solid-js", () => {
  test("is the reactive build, not the server one", () => {
    let notified = 0;
    createRoot((dispose) => {
      const [value, setValue] = createSignal(0);
      createComputed(() => {
        notified++;
        value();
      });
      setValue(1);
      dispose();
    });
    expect(notified).toBe(2);
  });
});

/* Anvilmar, in Dun Morogh: map 0, x ≈ -6240, y ≈ 380. */
const ANVILMAR = { x: -6240, y: 380 };

describe("project", () => {
  test("agrees with the shared transform under an identity view", () => {
    const p = worldToPixel(ANVILMAR.x, ANVILMAR.y);
    const s = project({ scale: 1, ox: 0, oy: 0 }, ANVILMAR.x, ANVILMAR.y);
    expect(s.sx).toBeCloseTo(p.px, 5);
    expect(s.sy).toBeCloseTo(p.py, 5);
  });
});

describe("fitTo", () => {
  test("a position that is not a number is left out, and the camera never lands on NaN", () => {
    const v = fitTo(SCREEN, [{ x: Number.NaN, y: 0 }, ANVILMAR, { x: 0, y: Number.POSITIVE_INFINITY }]);
    expect(v).toEqual(fitTo(SCREEN, [ANVILMAR]));
    const none = fitTo(SCREEN, [{ x: Number.NaN, y: Number.NaN }]);
    expect(none).toEqual(fitTo(SCREEN, []));
    for (const n of [none.scale, none.ox, none.oy]) expect(Number.isFinite(n)).toBe(true);
  });
});

/*
 * Which pyramid level a frame draws. The two promises are that the native
 * tiles draw exactly where they used to on an ordinary screen, and that no
 * level ever puts more on screen than the tile cache holds — together with the
 * coarser level drawn under it while it loads — on any screen at any zoom.
 */
describe("tileLevel", () => {
  const SCREENS = {
    phone: { w: 360, h: 740 },
    laptop: { w: 1280, h: 800 },
    hd: { w: 1920, h: 1080 },
    qhd: { w: 2560, h: 1440 },
    uhd: { w: 3840, h: 2160 },
    uhd8k: { w: 7680, h: 4320 },
  };
  const SCALES: number[] = [];
  for (let s = MIN_SCALE; s <= MAX_SCALE; s *= 1.07) SCALES.push(s);
  SCALES.push(MAX_SCALE, TILE_MIN_PX / TILE_PX);

  test("a level and the one above it always fit the cache, on every screen at every zoom", () => {
    for (const screen of Object.values(SCREENS)) {
      for (const s of SCALES) {
        const z = tileLevel(s, screen);
        expect(z).toBeGreaterThanOrEqual(0);
        expect(z).toBeLessThanOrEqual(LOD_MAX);
        expect(levelCells(z, s, screen) + levelCells(z + 1, s, screen)).toBeLessThanOrEqual(TILE_CACHE_MAX);
      }
    }
  });

  test("with the art drawn too, both layers and both underlays share the one cache", () => {
    for (const screen of Object.values(SCREENS)) {
      for (const s of SCALES) {
        const z = tileLevel(s, screen, true);
        const a = artLevel(z);
        const total =
          levelCells(z, s, screen) + levelCells(z + 1, s, screen) + levelCells(a, s, screen) + levelCells(a + 1, s, screen);
        expect(total).toBeLessThanOrEqual(TILE_CACHE_MAX);
      }
    }
  });
});

/* --- the pip layer and the derived state over a feed --- */

function agent(runId: string, map: number, x: number, y: number): AgentPosition {
  return {
    runId,
    character: runId,
    model: "test/model",
    map,
    x,
    y,
    ts: 1000,
    level: 5,
    xp: 100,
    money: null,
    questsCompleted: null,
    harnessVersion: "harness-0.2",
  };
}

describe("syncPips", () => {
  test("keeps pip identity across a re-ingest of the same feed", () => {
    const pips = new Map<string, Pip>();
    syncPips(pips, [agent("a", 0, 10, 10)]);
    const first = pips.get("a")!;
    syncPips(pips, [agent("a", 0, 10, 10)]);
    // The bug this pins: the fold used to write its results into signals the
    // same scope read, and a fresh object every call made that a live loop.
    // Identity stability is what makes a repeated fold a no-op instead.
    expect(pips.get("a")).toBe(first);
    expect(pips.size).toBe(1);
  });
});

describe("chooseMap", () => {
  const MAPS: [number, number][] = [
    [0, 2],
    [1, 1],
  ];

  test("nothing on the map still names a map to draw", () => {
    // It answered null until 2026-09-18, and the page had no rendering for
    // that: a quiet fleet — every visitor's first sight — got a blank stage.
    expect(chooseMap([], null, null, null)).toBe(DEFAULT_MAP);
  });

  test("is a fixpoint: feeding its own answer back changes nothing", () => {
    // The sticky derivation is a memo over its own previous value, so a second
    // pass on unchanged inputs has to settle rather than oscillate.
    const first = chooseMap(MAPS, null, null, null);
    expect(chooseMap(MAPS, first, null, null)).toBe(first);
    const pinned = chooseMap(MAPS, first, 1, null);
    expect(chooseMap(MAPS, pinned, 1, null)).toBe(pinned);
  });
});

describe("createMapState", () => {
  /*
   * A live graph, driven from outside the root. Writes made *inside* the root's
   * own initialisation are batched until it returns, so a test that asserted in
   * there would only ever see the first pass.
   */
  function graph(track: TrackResponse | undefined, selectedId: string | null) {
    return createRoot((dispose) => {
      const [feed, setFeed] = createSignal<readonly AgentPosition[]>([]);
      const state = createMapState({
        feed,
        track: () => track,
        pinned: () => null,
        selectedId: () => selectedId,
      });
      // A subscriber, so every memo is pulled on every update rather than
      // sitting stale until something reads it.
      const seen = { runs: 0 };
      createComputed(() => {
        seen.runs++;
        state.maps();
        state.activeMap();
        state.selected();
        state.count();
      });
      return { state, setFeed, seen, dispose };
    });
  }

  test("a feed of fresh objects settles instead of re-entering", () => {
    /*
     * The regression. `positionsAt` mints a new object per call, so a feed tick
     * always looks like a change; the old page wrote that object into a signal
     * it read in the same effect, and Firefox reported `too much recursion`
     * under the play slider. Nothing in the derivation writes now, so a
     * downstream computation runs exactly once per update — the count is the
     * assertion, and under the old shape it did not terminate at all.
     */
    const g = graph(undefined, "a");
    expect(g.seen.runs).toBe(1);
    for (let i = 0; i < 5; i++) g.setFeed([agent("a", 0, 10, 10)]);
    expect(g.seen.runs).toBe(6);
    expect(g.state.activeMap()).toBe(0);
    expect(g.state.selected()?.runId).toBe("a");
    g.dispose();
  });
});

describe("a fan-out run's replay", () => {
  test("its transport is its characters' points on one clock, under the run's id", () => {
    const point = (ts: number) => ({ ts, map: 0, x: 0, y: 0, level: 1, xp: 0, money: null, questsCompleted: null, turn: null });
    const track = (runId: string, ts: number[]): TrackResponse => ({ runId, characterName: null, model: "m", harnessVersion: null, points: ts.map(point) });
    const t = fanoutTrack("fanout-probe", [track("fanout-probe~Alfa", [1, 3]), track("fanout-probe~Bravo", [2])]);
    expect(t.runId).toBe("fanout-probe");
    expect(t.points.map((p) => p.ts)).toEqual([1, 2, 3]);
  });

  test("ten characters, a raid's, merge onto one clock, and every one gets a member colour (the five tokens, by index modulo five)", () => {
    const point = (ts: number) => ({ ts, map: 1, x: 0, y: 0, level: 80, xp: 0, money: null, questsCompleted: null, turn: null });
    const tracks = Array.from({ length: 10 }, (_, i): TrackResponse => ({ runId: `raid~C${i}`, characterName: null, model: "m", harnessVersion: null, points: [point(10 - i), point(20 + i)] }));
    const t = fanoutTrack("raid", tracks);
    expect(t.points).toHaveLength(20);
    expect(t.points.map((p) => p.ts)).toEqual([...t.points.map((p) => p.ts)].sort((a, b) => a - b));
    const classes = Array.from({ length: 10 }, (_, i) => memberClass(i));
    expect(classes.every((c) => /^member-[1-5]$/.test(c))).toBe(true);
    expect(classes.slice(5)).toEqual(classes.slice(0, 5));
    expect(new Set(Array.from({ length: 10 }, (_, i) => memberToken(i))).size).toBe(MEMBER_SLOTS);
  });
});
