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

import { describe, expect, test } from "bun:test";
import type { AgentPosition, TrackResponse } from "../../runner/viewer/api-types";
import { TILE_PX, TILE_SIZE, worldToPixel } from "../../runner/viewer/worldmap";
import { positionsAt } from "../src/lib/replay";
import {
  type Pip,
  MAX_SCALE,
  MIN_SCALE,
  centreOn,
  chooseMap,
  clampScale,
  colorOf,
  decimateRoute,
  fitTo,
  hitTest,
  hueOf,
  latticeLines,
  STALE_MS,
  mapCounts,
  mapName,
  positionAgeMs,
  project,
  stepPips,
  syncPips,
  visibleGrid,
  worldPerPixel,
  zoomAt,
} from "../src/lib/mapview";

/* The reactive build of solid-js stands behind this name for every dashboard
   test; `test/preload-solid.ts` installs it and says why. */
import { createComputed, createRoot, createSignal } from "solid-js";
import { clearReplayState, createMapState, replayHrefFor } from "../src/lib/mapstate";

const SCREEN = { w: 800, h: 600 };

/*
 * The canary for every graph test in the suite, this file's and the other
 * three's. They all rest on `solid-js` resolving to the reactive build, which
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

/* Anvilmar, the map view's verified known zone: map 0, x ≈ -6240, y ≈ 380 → tile row 43.70, col 31.29. */
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

  test("Anvilmar lands in the verified row/col", () => {
    const p = worldToPixel(ANVILMAR.x, ANVILMAR.y);
    expect(p.py / 256).toBeCloseTo(43.7, 1);
    expect(p.px / 256).toBeCloseTo(31.29, 1);
  });
});

describe("positionAgeMs", () => {
  test("without an envelope the age is the browser arithmetic (live API, replays)", () => {
    expect(positionAgeMs(1_000, 61_000, null)).toBe(60_000);
  });

  test("with an envelope the two clocks never mix: reading age at render, plus time held here", () => {
    // 10s old when the snapshot was rendered (server clock), held 5s by this
    // tab (browser clock). The two clocks are wildly apart on purpose — the
    // browser arithmetic would read ~17 minutes; the honest age is 15s.
    const age = positionAgeMs(990_000, 2_005_000, { generatedAt: 1_000_000, fetchedAt: 2_000_000 });
    expect(age).toBe(15_000);
  });

  test("delivery latency is not staleness: a reading fresh at render arrives fresh however late", () => {
    // The pipeline's legitimate worst case (60s publish + 30s edge + 30s memo)
    // is exactly STALE_MS, so ageing `ts` against the browser clock dims
    // healthy agents with zero margin. Against the envelope, the lateness of
    // the snapshot itself never counts toward the reading's age.
    const fetchedAt = 5_000_000;
    const generatedAt = 1_000_000;
    const age = positionAgeMs(generatedAt, fetchedAt, { generatedAt, fetchedAt });
    expect(age).toBe(0);
    expect(age > STALE_MS).toBe(false);
  });

  test("a tab holding one response ages it on its own clock, so a dead feed still goes stale", () => {
    const clock = { generatedAt: 1_000_000, fetchedAt: 2_000_000 };
    expect(positionAgeMs(1_000_000, 2_000_000 + STALE_MS + 1, clock)).toBeGreaterThan(STALE_MS);
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

/*
 * The two costs of FOLLOW-UPS 60, both of which scaled with the thing being
 * drawn rather than with the screen. The canvas calls themselves are not tested
 * — there is no canvas here — but the geometry they are handed is, because that
 * is where the picture is decided.
 */

describe("latticeLines", () => {
  test("the whole world is 130 segments, not 4096 rects", () => {
    // Zoomed out below the tile threshold the old loop stroked every cell of the
    // 64×64 grid; one line per boundary is 65 + 65.
    const l = latticeLines({ scale: 0.02, ox: 0, oy: 0 }, SCREEN);
    expect(l.xs.length).toBe(65);
    expect(l.ys.length).toBe(65);
  });

  test("only the visible cells get lines", () => {
    const view = { scale: 1, ox: 0, oy: 0 };
    const g = visibleGrid(view, SCREEN);
    const l = latticeLines(view, SCREEN);
    expect(l.xs.length).toBe(g.col1 - g.col0 + 2);
    expect(l.ys.length).toBe(g.row1 - g.row0 + 2);
  });

  test("every cell edge the per-cell rects drew is still a line", () => {
    // The batching must not change *which* boundaries are lattice, only how
    // many calls draw them: each visible cell's left/top edge is in the runs,
    // and the extent closes the last cell on each axis.
    const view = { scale: 0.5, ox: -300, oy: -220 };
    const g = visibleGrid(view, SCREEN);
    const l = latticeLines(view, SCREEN);
    for (let col = g.col0; col <= g.col1; col++) {
      expect(l.xs).toContain(col * g.size + view.ox + 0.5);
    }
    for (let row = g.row0; row <= g.row1; row++) {
      expect(l.ys).toContain(row * g.size + view.oy + 0.5);
    }
    expect(l.x1).toBeCloseTo((g.col1 + 1) * g.size + view.ox + 0.5, 6);
    expect(l.y1).toBeCloseTo((g.row1 + 1) * g.size + view.oy + 0.5, 6);
  });

  test("the half-pixel offset is kept so a 1px line stays crisp", () => {
    const l = latticeLines({ scale: 1, ox: 0, oy: 0 }, SCREEN);
    for (const x of l.xs) expect(x - Math.floor(x)).toBeCloseTo(0.5, 9);
    for (const y of l.ys) expect(y - Math.floor(y)).toBeCloseTo(0.5, 9);
  });

  test("the lattice spans the box it covers", () => {
    const l = latticeLines({ scale: 0.02, ox: 0, oy: 0 }, SCREEN);
    expect(l.x0).toBe(l.xs[0]!);
    expect(l.y0).toBe(l.ys[0]!);
    expect(l.x1).toBe(l.xs[l.xs.length - 1]!);
    expect(l.y1).toBe(l.ys[l.ys.length - 1]!);
  });
});

describe("worldPerPixel", () => {
  test("is the transform's own factor, inverted", () => {
    expect(worldPerPixel(1)).toBeCloseTo(TILE_SIZE / TILE_PX, 9);
    expect(worldPerPixel(0.25)).toBeCloseTo(worldPerPixel(1) * 4, 9);
  });

  test("that world distance really is one screen pixel", () => {
    // The claim the decimation rests on: one factor for both axes, so a world
    // distance can stand in for a screen distance without projecting.
    const view = { scale: 0.4, ox: 17, oy: -9 };
    const d = worldPerPixel(view.scale);
    const a = project(view, ANVILMAR.x, ANVILMAR.y);
    const bx = project(view, ANVILMAR.x + d, ANVILMAR.y);
    const by = project(view, ANVILMAR.x, ANVILMAR.y + d);
    expect(Math.abs(by.sx - a.sx)).toBeCloseTo(1, 6);
    expect(Math.abs(bx.sy - a.sy)).toBeCloseTo(1, 6);
  });
});

describe("decimateRoute", () => {
  /* A 400-sample walk stepping 0.3 world units — well under a one-unit
     tolerance, and spanning 120 of them end to end. */
  const walk = Array.from({ length: 400 }, (_, i) => ({ x: i * 0.3, y: Math.sin(i * 0.05) * 4 }));

  test("a dense track collapses without collapsing to its endpoints", () => {
    const kept = decimateRoute(walk, 1);
    expect(kept.length).toBeLessThan(walk.length / 2);
    // The lower bound is the discriminating half: dropping everything between
    // the ends would satisfy the upper one and draw a straight line.
    expect(kept.length).toBeGreaterThan(20);
  });

  test("the kept points still trace the same shape within the tolerance", () => {
    // This is what catches measuring against the previous *input* point instead
    // of the last kept one: every step here is 0.3, so that variant drops the
    // whole interior and the error runs to the length of the walk.
    const kept = decimateRoute(walk, 1);
    for (const p of walk) {
      let best = Infinity;
      for (const q of kept) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
      expect(best).toBeLessThanOrEqual(1.000001);
    }
  });

  test("the first and last points always survive", () => {
    // The last is where the pip sits: drop it and the route's tail detaches
    // from the character. Here it is a hair from its predecessor, which is the
    // case a plain distance filter gets wrong.
    const track = [...walk, { x: walk[walk.length - 1]!.x + 0.001, y: walk[walk.length - 1]!.y }];
    const kept = decimateRoute(track, 1);
    expect(kept[0]).toEqual(track[0]!);
    expect(kept[kept.length - 1]).toEqual(track[track.length - 1]!);
  });

  test("real movement is never dropped", () => {
    const far = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
    ];
    expect(decimateRoute(far, 1)).toEqual(far);
  });

  test("a coarser tolerance keeps fewer points", () => {
    // Zooming out is the only thing that changes the tolerance, and it must
    // move the answer — a decimation that ignored it would be the stale-cache
    // bug wearing a different hat.
    expect(decimateRoute(walk, 8).length).toBeLessThan(decimateRoute(walk, 1).length);
  });

  test("nothing to decimate is handed back unchanged", () => {
    expect(decimateRoute([], 1)).toEqual([]);
    expect(decimateRoute([{ x: 1, y: 2 }], 1)).toEqual([{ x: 1, y: 2 }]);
    expect(decimateRoute(walk, 0)).toEqual(walk);
    expect(decimateRoute(walk, -1)).toEqual(walk);
  });
});

describe("mapName", () => {
  test("the four continents read as places, not ids", () => {
    expect(mapName(0)).toBe("Eastern Kingdoms");
    expect(mapName(1)).toBe("Kalimdor");
    expect(mapName(530)).toBe("Outland");
    expect(mapName(571)).toBe("Northrend");
  });

  test("anything else keeps its number rather than being guessed at", () => {
    // An instance, a battleground, a map the tooling has never seen: a wrong
    // name would be worse than the id, which is at least the server's answer.
    expect(mapName(33)).toBe("map 33");
    expect(mapName(-1)).toBe("map -1");
  });
});
