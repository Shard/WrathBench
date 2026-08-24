/**
 * The map's view maths. Pure functions, so pip placement is checked here rather
 * than by looking at a canvas.
 *
 * The transform itself is `runner/viewer/worldmap.ts` and is tested there; what
 * these pin is the layer the SPA adds — projection under a view, fitting,
 * cursor-anchored zoom, hit testing, the pip fold, and the derived state the
 * page hangs off its feed. The last of those is a regression: the derivation
 * used to write back into signals it read, and the map recursed.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentPosition, TrackResponse } from "../../runner/viewer/api-types";
import { worldToPixel } from "../../runner/viewer/worldmap";
import { positionsAt } from "../src/lib/replay";
import {
  type Pip,
  MAX_SCALE,
  MIN_SCALE,
  centreOn,
  chooseMap,
  clampScale,
  colorOf,
  fitTo,
  hitTest,
  hueOf,
  mapCounts,
  project,
  stepPips,
  syncPips,
  visibleGrid,
  zoomAt,
} from "../src/lib/mapview";

/*
 * `bun test` resolves `solid-js` under the node condition, which is the server
 * build: its signals never notify, so a test of the derivation graph would pass
 * against it no matter what the graph did. Point the name at the same reactive
 * build the browser gets, then load the derivation — dynamically, because a
 * static import would be hoisted above the redirect and get the server build.
 */
const solid = await import("solid-js/dist/solid.js");
mock.module("solid-js", () => solid);
const { createComputed, createRoot, createSignal } = solid;
const { createMapState, clearReplayState, replayHrefFor } = await import("../src/lib/mapstate");

const SCREEN = { w: 800, h: 600 };

/* Anvilmar, from ADR-0019: map 0, x ≈ -6240, y ≈ 380 → tile row 43.70, col 31.29. */
const ANVILMAR = { x: -6240, y: 380 };

describe("project", () => {
  test("agrees with the shared transform under an identity view", () => {
    const p = worldToPixel(ANVILMAR.x, ANVILMAR.y);
    const s = project({ scale: 1, ox: 0, oy: 0 }, ANVILMAR.x, ANVILMAR.y);
    expect(s.sx).toBeCloseTo(p.px, 5);
    expect(s.sy).toBeCloseTo(p.py, 5);
  });

  test("scale and offset apply on both axes", () => {
    const p = worldToPixel(ANVILMAR.x, ANVILMAR.y);
    const s = project({ scale: 0.5, ox: 10, oy: -20 }, ANVILMAR.x, ANVILMAR.y);
    expect(s.sx).toBeCloseTo(p.px * 0.5 + 10, 5);
    expect(s.sy).toBeCloseTo(p.py * 0.5 - 20, 5);
  });

  test("Anvilmar lands in the row/col the ADR names", () => {
    const p = worldToPixel(ANVILMAR.x, ANVILMAR.y);
    expect(p.py / 256).toBeCloseTo(43.7, 1);
    expect(p.px / 256).toBeCloseTo(31.29, 1);
  });
});

describe("centreOn and fitTo", () => {
  test("centreOn puts the point in the middle of the screen", () => {
    const v = centreOn(SCREEN, 1000, 2000, 0.5);
    expect(1000 * v.scale + v.ox).toBeCloseTo(SCREEN.w / 2, 5);
    expect(2000 * v.scale + v.oy).toBeCloseTo(SCREEN.h / 2, 5);
  });

  test("an empty list gets the whole world, not a NaN view", () => {
    const v = fitTo(SCREEN, []);
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(Number.isFinite(v.ox)).toBe(true);
    expect(v.scale).toBeGreaterThan(0);
  });

  test("a single agent gets a close-up rather than a division by zero", () => {
    const v = fitTo(SCREEN, [ANVILMAR]);
    const s = project(v, ANVILMAR.x, ANVILMAR.y);
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(s.sx).toBeCloseTo(SCREEN.w / 2, 5);
    expect(s.sy).toBeCloseTo(SCREEN.h / 2, 5);
  });

  test("every agent in a spread lands on screen", () => {
    const list = [ANVILMAR, { x: -5000, y: -1200 }, { x: -7000, y: 900 }];
    const v = fitTo(SCREEN, list);
    for (const a of list) {
      const s = project(v, a.x, a.y);
      expect(s.sx).toBeGreaterThanOrEqual(0);
      expect(s.sx).toBeLessThanOrEqual(SCREEN.w);
      expect(s.sy).toBeGreaterThanOrEqual(0);
      expect(s.sy).toBeLessThanOrEqual(SCREEN.h);
    }
  });
});

describe("zoomAt", () => {
  test("keeps the world point under the cursor under the cursor", () => {
    const v = { scale: 0.4, ox: 33, oy: -12 };
    const sx = 210;
    const sy = 480;
    const next = zoomAt(v, sx, sy, 2.5);
    // Invert both views at the cursor: the same world pixel must come back.
    const before = { px: (sx - v.ox) / v.scale, py: (sy - v.oy) / v.scale };
    const after = { px: (sx - next.ox) / next.scale, py: (sy - next.oy) / next.scale };
    expect(after.px).toBeCloseTo(before.px, 4);
    expect(after.py).toBeCloseTo(before.py, 4);
  });

  test("scale is clamped at both ends", () => {
    expect(clampScale(1e6)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(zoomAt({ scale: MAX_SCALE, ox: 0, oy: 0 }, 0, 0, 10).scale).toBe(MAX_SCALE);
  });
});

describe("visibleGrid", () => {
  test("never asks for a tile outside the 64×64 world", () => {
    const g = visibleGrid({ scale: 0.02, ox: 500, oy: 500 }, SCREEN);
    expect(g.row0).toBeGreaterThanOrEqual(0);
    expect(g.col0).toBeGreaterThanOrEqual(0);
    expect(g.row1).toBeLessThan(64);
    expect(g.col1).toBeLessThan(64);
  });

  test("a panned-off-world view clamps rather than requesting tile −3", () => {
    const g = visibleGrid({ scale: 1, ox: 5000, oy: 5000 }, SCREEN);
    expect(g.row0).toBe(0);
    expect(g.col0).toBe(0);
  });
});

describe("hitTest", () => {
  test("picks the agent under the click and nothing further than the radius", () => {
    const v = fitTo(SCREEN, [ANVILMAR]);
    const a = { ...ANVILMAR, runId: "a" };
    const hit = hitTest(v, [a], SCREEN.w / 2 + 3, SCREEN.h / 2 - 2);
    expect(hit?.runId).toBe("a");
    expect(hitTest(v, [a], SCREEN.w / 2 + 200, SCREEN.h / 2)).toBeNull();
  });

  test("with two overlapping pips the nearer one wins", () => {
    const v = { scale: 1, ox: 0, oy: 0 };
    const near = { x: ANVILMAR.x, y: ANVILMAR.y, runId: "near" };
    const far = { x: ANVILMAR.x - 6, y: ANVILMAR.y, runId: "far" };
    const p = project(v, near.x, near.y);
    expect(hitTest(v, [far, near], p.sx, p.sy)?.runId).toBe("near");
  });
});

describe("pip colour", () => {
  test("is stable per run id and spread across the hue circle", () => {
    expect(hueOf("fleet-ox-alpha-20260822")).toBe(hueOf("fleet-ox-alpha-20260822"));
    expect(colorOf("a")).toMatch(/^hsl\(\d+ 70% 60%\)$/);
    const hues = new Set(["a", "b", "c", "d", "e", "f"].map(hueOf));
    expect(hues.size).toBe(6);
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
    items: null,
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

  test("a pip walks toward its new reading unless the caller snaps it", () => {
    const pips = new Map<string, Pip>();
    syncPips(pips, [agent("a", 0, 0, 0)]);
    syncPips(pips, [agent("a", 0, 100, 100)]);
    expect(pips.get("a")).toMatchObject({ x: 0, y: 0 });
    syncPips(pips, [agent("a", 0, 100, 100)], true);
    expect(pips.get("a")).toMatchObject({ x: 100, y: 100 });
  });

  test("a run that leaves the feed leaves the map", () => {
    const pips = new Map<string, Pip>();
    syncPips(pips, [agent("a", 0, 1, 1), agent("b", 0, 2, 2)]);
    syncPips(pips, [agent("b", 0, 2, 2)]);
    expect([...pips.keys()]).toEqual(["b"]);
    syncPips(pips, []);
    expect(pips.size).toBe(0);
  });
});

describe("stepPips", () => {
  test("converges on the reading and then reports nothing moving", () => {
    const pips = new Map<string, Pip>();
    syncPips(pips, [agent("a", 0, 0, 0)]);
    syncPips(pips, [agent("a", 0, 100, 100)]);
    const list = [...pips.values()];
    let frames = 0;
    while (stepPips(list) && frames < 500) frames++;
    expect(frames).toBeLessThan(200);
    expect(list[0]).toMatchObject({ x: 100, y: 100 });
    expect(stepPips(list)).toBe(false);
  });
});

describe("mapCounts", () => {
  test("busiest first, ties broken by map id", () => {
    const list = [agent("a", 530, 0, 0), agent("b", 0, 0, 0), agent("c", 0, 0, 0), agent("d", 1, 0, 0)];
    expect(mapCounts(list)).toEqual([
      [0, 2],
      [1, 1],
      [530, 1],
    ]);
    expect(mapCounts([])).toEqual([]);
  });
});

describe("chooseMap", () => {
  const MAPS: [number, number][] = [
    [0, 2],
    [1, 1],
  ];

  test("nothing on the map means no map", () => {
    expect(chooseMap([], null, null, null)).toBeNull();
  });

  test("stays where it was while that map still has an agent", () => {
    expect(chooseMap(MAPS, 1, null, null)).toBe(1);
    expect(chooseMap([[0, 2]], 1, null, null)).toBe(0);
  });

  test("a chip click outranks both stickiness and the busiest map", () => {
    expect(chooseMap(MAPS, 0, 1, null)).toBe(1);
    // A pin for a map nothing is on is ignored rather than blanking the canvas.
    expect(chooseMap(MAPS, 0, 530, null)).toBe(0);
  });

  test("the replay cursor's map wins over where we were", () => {
    expect(chooseMap(MAPS, 0, null, 530)).toBe(530);
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
  const TRACK: TrackResponse = {
    runId: "run-1",
    character: "Benchy",
    model: "test/model",
    harnessVersion: "harness-0.2",
    points: [
      { ts: 100, map: 0, x: 1, y: 1, level: 1, xp: 0, money: null, questsCompleted: null, turn: 1 },
      { ts: 200, map: 530, x: 9, y: 9, level: 2, xp: 5, money: null, questsCompleted: null, turn: 2 },
    ],
  };

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

  test("replay derives its chips from the track and follows the cursor", () => {
    const g = graph(TRACK, null);
    g.setFeed(positionsAt(TRACK, 100));
    // Both maps are chips even though the cursor stands on one of them.
    expect(g.state.maps()).toEqual([
      [0, 1],
      [530, 1],
    ]);
    expect(g.state.activeMap()).toBe(0);
    // The sidebar follows the cursor in replay, with no click involved.
    expect(g.state.selected()?.map).toBe(0);
    g.setFeed(positionsAt(TRACK, 200));
    expect(g.state.cursorMap()).toBe(530);
    expect(g.state.activeMap()).toBe(530);
    expect(g.state.selected()?.map).toBe(530);
    g.dispose();
  });

  test("a cursor before the first sample leaves nothing selected", () => {
    const g = graph(TRACK, null);
    g.setFeed(positionsAt(TRACK, 1));
    expect(g.state.selected()).toBeNull();
    expect(g.state.count()).toBe(0);
    // The chips still name where the run went, so the canvas keeps a map.
    expect(g.state.activeMap()).toBe(0);
    g.dispose();
  });

  test("a live selection that leaves the feed clears the sidebar", () => {
    const g = graph(undefined, "a");
    g.setFeed([agent("a", 0, 1, 1), agent("b", 0, 2, 2)]);
    expect(g.state.selected()?.runId).toBe("a");
    g.setFeed([agent("b", 0, 2, 2)]);
    expect(g.state.selected()).toBeNull();
    expect(g.state.count()).toBe(1);
    g.dispose();
  });
});

describe("returning to live", () => {
  /*
   * `/map?run=<id>` → `/map` is a state swap, not a layer. What makes it worth
   * a test on the real graph is that `activeMap` is a reducer memo: its
   * stickiness lives inside the memo rather than in any source, so clearing the
   * sources is only a reset if the empty feed goes through and the memo gets a
   * chance to reject its own previous answer. This is the assertion that fails
   * if that one line in `clearReplayState` is ever tidied away.
   */
  const TRACK: TrackResponse = {
    runId: "run-1",
    character: "Benchy",
    model: "test/model",
    harnessVersion: "harness-0.2",
    points: [
      { ts: 100, map: 0, x: 1, y: 1, level: 1, xp: 0, money: null, questsCompleted: null, turn: 1 },
      { ts: 200, map: 530, x: 9, y: 9, level: 2, xp: 5, money: null, questsCompleted: null, turn: 2 },
    ],
  };

  function replaying() {
    return createRoot((dispose) => {
      const [feed, setFeed] = createSignal<readonly AgentPosition[]>([]);
      const [track, setTrackSig] = createSignal<TrackResponse | undefined>(undefined);
      const [pinned, setPinned] = createSignal<number | null>(null);
      const [selectedId, setSelectedId] = createSignal<string | null>(null);
      const [cursor, setCursor] = createSignal(0);
      const [playing, setPlaying] = createSignal(false);
      const [error, setError] = createSignal<string | undefined>(undefined);
      const state = createMapState({ feed, track, pinned, selectedId });
      createComputed(() => {
        state.maps();
        state.activeMap();
        state.selected();
        state.count();
      });
      const writables = {
        setTrack: (t: TrackResponse | undefined): void => {
          setTrackSig(() => t);
        },
        setCursor,
        setPlaying,
        setPinned,
        setSelectedId,
        setFeed: (list: readonly AgentPosition[]): void => {
          setFeed(() => list);
        },
        setError,
      };
      const sources = { track, pinned, selectedId, cursor, playing, error };
      return { state, setFeed, writables, sources, dispose };
    });
  }

  test("the swap leaves nothing of the replay behind", () => {
    const g = replaying();
    /* Mid-replay: a track loaded, the cursor on the second continent, a pinned
       chip, a selection, a cursor and a failed sibling load still on screen. */
    g.writables.setTrack(TRACK);
    g.setFeed(positionsAt(TRACK, 200));
    g.writables.setPinned(530);
    g.writables.setSelectedId("run-1");
    g.writables.setCursor(200);
    g.writables.setPlaying(true);
    g.writables.setError("Error: no such run");
    // Read it, so the reducer memo has cached 530 as its previous answer.
    expect(g.state.activeMap()).toBe(530);
    expect(g.state.selected()?.runId).toBe("run-1");

    clearReplayState(g.writables);

    expect(g.sources.track()).toBeUndefined();
    expect(g.sources.cursor()).toBe(0);
    expect(g.sources.playing()).toBe(false);
    expect(g.sources.pinned()).toBeNull();
    expect(g.sources.selectedId()).toBeNull();
    expect(g.sources.error()).toBeUndefined();
    expect(g.state.count()).toBe(0);
    expect(g.state.maps()).toEqual([]);
    expect(g.state.selected()).toBeNull();
    // The continent the replay ended on is forgotten, not merely unpinned.
    expect(g.state.activeMap()).toBeNull();
    g.dispose();
  });

  test("the live feed then chooses its own map, not the replay's", () => {
    const g = replaying();
    g.writables.setTrack(TRACK);
    g.setFeed(positionsAt(TRACK, 200));
    expect(g.state.activeMap()).toBe(530);

    clearReplayState(g.writables);
    /* A straggler stands where the replay ended; the crowd is elsewhere. Under
       a leaked `prev` the map would sit on 530 with one pip on it. */
    g.setFeed([agent("a", 0, 1, 1), agent("b", 0, 2, 2), agent("c", 530, 9, 9)]);
    expect(g.state.activeMap()).toBe(0);
    expect(g.state.count()).toBe(3);
    g.dispose();
  });

  test("a replay swapped straight for another keeps none of the first", () => {
    const g = replaying();
    g.writables.setTrack(TRACK);
    g.setFeed(positionsAt(TRACK, 200));
    g.writables.setSelectedId("run-1");
    expect(g.state.activeMap()).toBe(530);

    /* The route effect clears before it fetches, so the second run's track
       lands on an empty page rather than on the first run's pips and chips. */
    clearReplayState(g.writables);
    expect(g.state.maps()).toEqual([]);
    const other: TrackResponse = { ...TRACK, runId: "run-2", points: [TRACK.points[0]!] };
    g.writables.setTrack(other);
    g.setFeed(positionsAt(other, 100));
    expect(g.state.maps()).toEqual([[0, 1]]);
    expect(g.state.activeMap()).toBe(0);
    expect(g.state.selected()?.runId).toBe("run-2");
    g.dispose();
  });
});

describe("replayHrefFor", () => {
  /*
   * The map's selected-agent panel offers both ways out — the run page and the
   * run's replay — so a character on the live map reaches its own replay without
   * a detour. The gate is the interesting half: in replay mode the panel is
   * showing the replayed agent, and a link back to the URL the page is already
   * on is a control that does nothing when clicked.
   */
  const TRACK: TrackResponse = {
    runId: "run-1",
    character: "Benchy",
    model: "test/model",
    harnessVersion: "harness-0.2",
    points: [],
  };

  test("a live selection gets a link into its own replay", () => {
    expect(replayHrefFor(undefined, agent("run-1", 0, 1, 1))).toBe("/map?run=run-1");
  });

  test("the run already being replayed gets none", () => {
    expect(replayHrefFor(TRACK, agent("run-1", 0, 1, 1))).toBeNull();
  });

  test("a different run during a replay still gets one", () => {
    // Not reachable today — replay shows one pip — but the gate is about the
    // selection, not about the mode, so it holds if a replay ever shows two.
    expect(replayHrefFor(TRACK, agent("run-2", 0, 1, 1))).toBe("/map?run=run-2");
  });

  test("nothing selected, nothing to link", () => {
    expect(replayHrefFor(undefined, null)).toBeNull();
    expect(replayHrefFor(TRACK, null)).toBeNull();
  });

  test("a run id with URL punctuation is encoded", () => {
    expect(replayHrefFor(undefined, agent("run/a b", 0, 1, 1))).toBe("/map?run=run%2Fa%20b");
  });
});
