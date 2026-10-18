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
import { LOD_MAX, TILE_PX, TILE_SIZE, lodGrid, worldToPixel } from "../../runner/viewer/worldmap";
import { positionsAt } from "../src/lib/replay";
import {
  type Pip,
  MAX_SCALE,
  MIN_SCALE,
  DEFAULT_MAP,
  DEFAULT_SCALE,
  centreOn,
  chooseMap,
  clampScale,
  colorOf,
  decimateRoute,
  defaultView,
  emptySideNote,
  fitTo,
  headingOnScreen,
  hitTest,
  hueOf,
  latticeLines,
  STALE_MS,
  ART_FADE_END_PX,
  ART_FADE_START_PX,
  TILE_CACHE_MAX,
  artLevel,
  frameLevels,
  minimapAlpha,
  pxPerAdt,
  TILE_MIN_PX,
  levelCellPx,
  levelCells,
  mapChips,
  mapCounts,
  mapParam,
  worldView,
  mapName,
  pipName,
  positionAgeMs,
  project,
  stepPips,
  syncPips,
  tileLevel,
  visibleGrid,
  worldPerPixel,
  zoomAt,
  pinchView,
  isDoubleTap,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_PX,
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

  test("a position that is not a number is left out, and the camera never lands on NaN", () => {
    const v = fitTo(SCREEN, [{ x: Number.NaN, y: 0 }, ANVILMAR, { x: 0, y: Number.POSITIVE_INFINITY }]);
    expect(v).toEqual(fitTo(SCREEN, [ANVILMAR]));
    const none = fitTo(SCREEN, [{ x: Number.NaN, y: Number.NaN }]);
    expect(none).toEqual(fitTo(SCREEN, []));
    for (const n of [none.scale, none.ox, none.oy]) expect(Number.isFinite(n)).toBe(true);
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

describe("pinchView", () => {
  const v = { scale: 0.4, ox: 33, oy: -12 };
  const world = (view: { scale: number; ox: number; oy: number }, p: { x: number; y: number }) => ({ px: (p.x - view.ox) / view.scale, py: (p.y - view.oy) / view.scale });

  test("the ground under each finger stays under it as they spread", () => {
    const from = [{ x: 100, y: 200 }, { x: 200, y: 200 }] as const;
    const to = [{ x: 50, y: 200 }, { x: 250, y: 200 }] as const;
    const next = pinchView(v, from, to);
    expect(next.scale).toBeCloseTo(0.8, 9);
    for (const i of [0, 1] as const) {
      expect(world(next, to[i]).px).toBeCloseTo(world(v, from[i]).px, 6);
      expect(world(next, to[i]).py).toBeCloseTo(world(v, from[i]).py, 6);
    }
  });

  test("two fingers moving together pan without zooming", () => {
    const from = [{ x: 100, y: 100 }, { x: 160, y: 140 }] as const;
    const to = [{ x: 130, y: 90 }, { x: 190, y: 130 }] as const;
    const next = pinchView(v, from, to);
    expect(next.scale).toBe(v.scale);
    expect(next.ox).toBeCloseTo(v.ox + 30, 9);
    expect(next.oy).toBeCloseTo(v.oy - 10, 9);
  });

  test("the midpoint's ground follows the midpoint when the zoom hits the clamp", () => {
    const top = { scale: MAX_SCALE, ox: 0, oy: 0 };
    const from = [{ x: 100, y: 100 }, { x: 110, y: 100 }] as const;
    const to = [{ x: 0, y: 150 }, { x: 400, y: 150 }] as const;
    const next = pinchView(top, from, to);
    expect(next.scale).toBe(MAX_SCALE);
    expect(world(next, { x: 200, y: 150 }).px).toBeCloseTo(world(top, { x: 105, y: 100 }).px, 6);
  });

  test("fingers that start on one spot do not divide by zero", () => {
    const p = { x: 10, y: 10 };
    const next = pinchView(v, [p, p], [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    expect(next.scale).toBe(v.scale);
    expect(Number.isFinite(next.ox) && Number.isFinite(next.oy)).toBe(true);
  });
});

describe("isDoubleTap", () => {
  test("a second tap soon after and close by is a double tap", () => {
    const first = { x: 100, y: 100, t: 1000 };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { x: 110, y: 95, t: 1000 + DOUBLE_TAP_MS })).toBe(true);
    expect(isDoubleTap(first, { x: 110, y: 95, t: 1001 + DOUBLE_TAP_MS })).toBe(false);
    expect(isDoubleTap(first, { x: 100 + DOUBLE_TAP_PX + 1, y: 100, t: 1100 })).toBe(false);
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

  test("at a pyramid level it counts that level's cells and clamps to that level's grid", () => {
    const view = { scale: 0.05, ox: -200, oy: -300 };
    const g = visibleGrid(view, SCREEN, 3);
    expect(g.size).toBeCloseTo(TILE_PX * 8 * 0.05, 9);
    expect(g.row1).toBeLessThan(lodGrid(3));
    expect(g.col1).toBeLessThan(lodGrid(3));
    // The level-3 cell under a screen point holds the native cell under it.
    const native = visibleGrid(view, SCREEN, 0);
    expect(g.row0).toBe(native.row0 >> 3);
    expect(g.col0).toBe(native.col0 >> 3);
    const world = visibleGrid({ scale: 0.01, ox: 0, oy: 0 }, SCREEN, LOD_MAX);
    expect(world).toMatchObject({ row0: 0, row1: 0, col0: 0, col1: 0 });
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

  test("native tiles from TILE_MIN_PX up on an ordinary screen, as before the pyramid", () => {
    for (const screen of [SCREENS.phone, SCREENS.laptop, SCREENS.hd]) {
      for (const s of SCALES) {
        if (s * TILE_PX >= TILE_MIN_PX) expect(tileLevel(s, screen)).toBe(0);
        else expect(tileLevel(s, screen)).toBeGreaterThan(0);
      }
    }
  });

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

  test("it is the finest level that does: a finer one is too small or too many", () => {
    for (const screen of Object.values(SCREENS)) {
      for (const s of SCALES) {
        const z = tileLevel(s, screen);
        if (z === 0) continue;
        const finer = z - 1;
        const tooSmall = levelCellPx(s, finer) < TILE_MIN_PX;
        const tooMany = levelCells(finer, s, screen) + levelCells(z, s, screen) > TILE_CACHE_MAX;
        expect(tooSmall || tooMany).toBe(true);
      }
    }
  });

  test("a pyramid level's cells stay at least TILE_MIN_PX until the world is one tile", () => {
    for (const screen of Object.values(SCREENS)) {
      for (const s of SCALES) {
        const z = tileLevel(s, screen);
        if (z < LOD_MAX) expect(levelCellPx(s, z)).toBeGreaterThanOrEqual(TILE_MIN_PX);
      }
    }
  });

  test("the worst case it budgets for bounds every pan", () => {
    // levelCells is offset-free on purpose (a pan never changes the level);
    // check it really is an upper bound of what visibleGrid hands the renderer.
    for (const screen of Object.values(SCREENS)) {
      for (const s of [0.011, 0.03, 0.1, 0.2, 0.38, 1, 3]) {
        const z = tileLevel(s, screen);
        for (const [ox, oy] of [
          [0, 0],
          [-1234.5, -987.25],
          [-7000.3, -4000.9],
          [313.7, -2222.2],
        ] as [number, number][]) {
          const g = visibleGrid({ scale: s, ox: ox * s * 10, oy: oy * s * 10 }, screen, z);
          const n = (g.row1 - g.row0 + 1) * (g.col1 - g.col0 + 1);
          expect(n).toBeLessThanOrEqual(levelCells(z, s, screen));
        }
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

  test("the art's share does not move the native switch on an ordinary screen", () => {
    for (const screen of [SCREENS.phone, SCREENS.laptop, SCREENS.hd]) {
      expect(tileLevel(TILE_MIN_PX / TILE_PX, screen, true)).toBe(0);
    }
  });

  test("zoomed right out the whole world is one tile, and a continent overview is real ground", () => {
    expect(tileLevel(MIN_SCALE, SCREENS.laptop)).toBe(LOD_MAX);
    // Eastern Kingdoms (~42 tiles tall) fills a laptop stage at about 0.07:
    // level 3, eight ADTs a tile, not the bare lattice this used to be.
    expect(tileLevel(0.07, SCREENS.laptop)).toBe(3);
  });
});

/*
 * The crossfade between the painted map and the minimap. Its two numbers are
 * the tuning knobs; these pin the shape, not the numbers, so retuning them is
 * a one-line edit that keeps this suite green.
 */
describe("the art/minimap crossfade", () => {
  test("all art at and below the start, all minimap at and above the end", () => {
    expect(minimapAlpha(0)).toBe(0);
    expect(minimapAlpha(ART_FADE_START_PX)).toBe(0);
    expect(minimapAlpha(ART_FADE_START_PX / 2)).toBe(0);
    expect(minimapAlpha(ART_FADE_END_PX)).toBe(1);
    expect(minimapAlpha(ART_FADE_END_PX * 10)).toBe(1);
    expect(minimapAlpha(Number.NaN)).toBe(0);
  });

  test("rises monotonically and smoothly, halfway at the geometric mean of the ends", () => {
    let prev = 0;
    for (let p = ART_FADE_START_PX; p <= ART_FADE_END_PX; p *= 1.01) {
      const a = minimapAlpha(p);
      expect(a).toBeGreaterThanOrEqual(prev);
      // Smooth: no step bigger than a gentle notch anywhere along the way.
      expect(a - prev).toBeLessThan(0.02);
      prev = a;
    }
    expect(minimapAlpha(Math.sqrt(ART_FADE_START_PX * ART_FADE_END_PX))).toBeCloseTo(0.5, 9);
    // Flat at both ends, so neither end of the fade shows as a kink.
    expect(minimapAlpha(ART_FADE_START_PX * 1.01)).toBeLessThan(0.001);
    expect(minimapAlpha(ART_FADE_END_PX / 1.01)).toBeGreaterThan(0.999);
  });

  test("pixels per ADT is a native tile's on-screen size", () => {
    expect(pxPerAdt(1)).toBe(TILE_PX);
    expect(pxPerAdt(0.25)).toBe(64);
  });

  test("the art is never asked for at level 0: its finest is z1, scaled up at the native zoom", () => {
    expect(artLevel(0)).toBe(1);
    expect(artLevel(1)).toBe(1);
    expect(artLevel(4)).toBe(4);
  });

  test("a frame draws the minimap always and the art only while it has weight", () => {
    // Every scale here is derived from the two fade constants, so retuning
    // them is a one-line edit that leaves this test meaning the same thing.
    const screen = { w: 1280, h: 800 };
    const zoomedIn = frameLevels(ART_FADE_END_PX / TILE_PX, screen);
    expect(zoomedIn.art).toBeNull();
    expect(zoomedIn.minimapAlpha).toBe(1);
    // Halfway through the fade both layers draw, the art at its own level.
    const mid = frameLevels(Math.sqrt(ART_FADE_START_PX * ART_FADE_END_PX) / TILE_PX, screen);
    expect(mid.minimapAlpha).toBeGreaterThan(0);
    expect(mid.minimapAlpha).toBeLessThan(1);
    expect(mid.art).toBe(artLevel(mid.minimap));
    // Zoomed out past the start: the art covers everything it paints, and the
    // minimap still draws under it for wherever it does not.
    const continent = frameLevels(ART_FADE_START_PX / 2 / TILE_PX, screen);
    expect(continent.minimapAlpha).toBe(0);
    expect(continent.art).toBe(artLevel(continent.minimap));
    expect(continent.minimap).toBeGreaterThan(0);
    // At the native zoom, while the art is still fading out, it draws z1 scaled up.
    if (TILE_MIN_PX < ART_FADE_END_PX) {
      const native = frameLevels(TILE_MIN_PX / TILE_PX, screen);
      expect(native.minimap).toBe(0);
      expect(native.art).toBe(1);
    }
  });
});

describe("headingOnScreen", () => {
  // WoW's facing: 0 is north (+x), and it turns west (+y) from there.
  const view = { scale: 0.4, ox: 17, oy: -9 };
  test("north is up the screen and west is to its left, at any view", () => {
    const n = headingOnScreen(view, 100, 200, 0);
    expect(n.dx).toBeCloseTo(0, 6);
    expect(n.dy).toBeCloseTo(-1, 6);
    const w = headingOnScreen(view, 100, 200, Math.PI / 2);
    expect(w.dx).toBeCloseTo(-1, 6);
    expect(w.dy).toBeCloseTo(0, 6);
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

/*
 * The empty state: what the page shows before anything is live. Its two halves
 * are the framing and the sentence, and both are pure, so neither needs a
 * canvas to pin.
 */
describe("the empty map's default view", () => {
  /** Anvilmar in Dun Morogh and Northshire in Elwynn: where characters start. */
  const STARTERS = [ANVILMAR, { x: -8949, y: -136 }, { x: -8913, y: 554 }];
  const DESKTOP = { w: 1280, h: 800 };
  const PHONE = { w: 360, h: 740 };

  test("draws the native tiles, the full-detail map of where characters start", () => {
    // Every zoom draws real ground now; this frame is the one where it is the
    // native tiles rather than a baked level.
    expect(DEFAULT_SCALE * TILE_PX).toBeGreaterThanOrEqual(TILE_MIN_PX);
    expect(defaultView(DESKTOP).scale).toBe(DEFAULT_SCALE);
    expect(tileLevel(DEFAULT_SCALE, DESKTOP)).toBe(0);
    expect(tileLevel(DEFAULT_SCALE, PHONE)).toBe(0);
  });

  test("holds the starter zones on screen at both sizes", () => {
    for (const screen of [DESKTOP, PHONE]) {
      const v = defaultView(screen);
      for (const a of STARTERS) {
        const s = project(v, a.x, a.y);
        expect(s.sx).toBeGreaterThanOrEqual(0);
        expect(s.sx).toBeLessThanOrEqual(screen.w);
        expect(s.sy).toBeGreaterThanOrEqual(0);
        expect(s.sy).toBeLessThanOrEqual(screen.h);
      }
    }
  });

  test("is a finite view on a real stage", () => {
    const v = defaultView(PHONE);
    expect(Number.isFinite(v.ox)).toBe(true);
    expect(Number.isFinite(v.oy)).toBe(true);
  });

  test("the sidebar says nobody is live, and what is on screen instead", () => {
    const note = emptySideNote(0, false, DEFAULT_MAP);
    expect(note).toContain("live");
    expect(note).toContain(mapName(DEFAULT_MAP));
  });

  test("a populated map keeps the selection prompt, and a replay its own", () => {
    expect(emptySideNote(3, false, 0)).toBe("no character selected");
    expect(emptySideNote(0, true, 0)).not.toContain("live");
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

  test("a stale previous map is dropped for the default, not kept", () => {
    expect(chooseMap([], 530, null, null)).toBe(DEFAULT_MAP);
  });

  test("stays where it was while that map still has an agent", () => {
    expect(chooseMap(MAPS, 1, null, null)).toBe(1);
    expect(chooseMap([[0, 2]], 1, null, null)).toBe(0);
  });

  test("a chip click outranks both stickiness and the busiest map", () => {
    expect(chooseMap(MAPS, 0, 1, null)).toBe(1);
  });

  test("a pin holds on a map nobody is on: a `/map?map=530` link on any fleet", () => {
    // Every map draws — its tiles, or the lattice — so an empty pinned map is
    // a map to look at, not the blank canvas this once guarded against.
    expect(chooseMap(MAPS, 0, 530, null)).toBe(530);
    expect(chooseMap([], null, 1, null)).toBe(1);
    expect(chooseMap([], 1, 1, null)).toBe(1);
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

describe("the map link", () => {
  test("?map=<id> is bare digits or no pin at all", () => {
    expect(mapParam("1")).toBe(1);
    expect(mapParam("0")).toBe(0);
    expect(mapParam("571")).toBe(571);
    expect(mapParam(["530", "1"])).toBe(530);
    for (const bad of [undefined, "", "-1", "1.5", "abc", "1a", " 1", "0x1f", "1e3", "1234567890"]) {
      expect(mapParam(bad)).toBeNull();
    }
  });

  test("the chips keep a way back from a pinned map nobody is on", () => {
    const busy: [number, number][] = [
      [0, 3],
      [1, 1],
    ];
    expect(mapChips(busy, 1)).toEqual(busy);
    expect(mapChips([[0, 3]], 571)).toEqual([
      [0, 3],
      [571, 0],
    ]);
    // Alone on a quiet fleet there is nothing to switch to: one chip, which the page hides.
    expect(mapChips([], 1)).toEqual([[1, 0]]);
  });

  test("another map opens on the whole grid; the default map keeps its starter frame", () => {
    for (const screen of [
      { w: 1280, h: 800 },
      { w: 360, h: 740 },
    ]) {
      const v = defaultView(screen, 1);
      expect(v).toEqual(worldView(screen));
      const side = 64 * TILE_PX;
      expect(side * v.scale).toBeLessThanOrEqual(Math.min(screen.w, screen.h) + 1e-9);
      // The grid's corners are on screen.
      expect(v.ox).toBeGreaterThanOrEqual(-1e-9);
      expect(v.oy).toBeGreaterThanOrEqual(-1e-9);
      expect(v.ox + side * v.scale).toBeLessThanOrEqual(screen.w + 1e-9);
      expect(v.oy + side * v.scale).toBeLessThanOrEqual(screen.h + 1e-9);
      expect(defaultView(screen, DEFAULT_MAP)).toEqual(defaultView(screen));
      expect(defaultView(screen).scale).toBe(DEFAULT_SCALE);
    }
  });

  test("a pinned map with nobody on it is the active map, on an empty feed and a busy one", () => {
    createRoot((dispose) => {
      const [feed] = createSignal<readonly AgentPosition[]>([]);
      const [pinned] = createSignal<number | null>(530);
      const state = createMapState({ feed, track: () => undefined, pinned, selectedId: () => null });
      expect(state.activeMap()).toBe(530);
      dispose();
    });
    createRoot((dispose) => {
      const [feed] = createSignal<readonly AgentPosition[]>([agent("a", 0, 0, 0)]);
      const [pinned] = createSignal<number | null>(1);
      const state = createMapState({ feed, track: () => undefined, pinned, selectedId: () => null });
      expect(state.activeMap()).toBe(1);
      expect(mapChips(state.maps(), state.activeMap())).toEqual([
        [0, 1],
        [1, 0],
      ]);
      dispose();
    });
  });
});

describe("createMapState", () => {
  const TRACK: TrackResponse = {
    runId: "run-1",
    characterName: "Benchy",
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
    characterName: "Benchy",
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
    // The continent the replay ended on is forgotten, not merely unpinned —
    // it falls back to the default rather than to "no map".
    expect(g.state.activeMap()).toBe(DEFAULT_MAP);
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
    characterName: "Benchy",
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
 * The two costs of the map redraw, both of which scaled with the thing being
 * drawn rather than with the screen. The canvas calls themselves are not tested
 * — there is no canvas here — but the geometry they are handed is, because that
 * is where the picture is decided.
 */

describe("latticeLines", () => {
  test("at a pyramid level the lines are that level's cell boundaries", () => {
    const view = { scale: 0.05, ox: 0, oy: 0 };
    const l = latticeLines(view, SCREEN, 2);
    const size = TILE_PX * 4 * 0.05;
    expect(l.xs[1]! - l.xs[0]!).toBeCloseTo(size, 9);
    expect(l.ys[1]! - l.ys[0]!).toBeCloseTo(size, 9);
    // The whole level-2 world is 16 cells a side: never more than 17 lines.
    expect(latticeLines({ scale: 0.01, ox: 0, oy: 0 }, SCREEN, 2).xs.length).toBe(17);
  });

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

  test("an instance with tiles and traffic of its own is named too", () => {
    expect(mapName(369)).toBe("Deeprun Tram");
  });

  test("anything else keeps its number rather than being guessed at", () => {
    // An instance, a battleground, a map the tooling has never seen: a wrong
    // name would be worse than the id, which is at least the server's answer.
    expect(mapName(33)).toBe("map 33");
    expect(mapName(-1)).toBe("map -1");
  });
});

describe("pipName", () => {
  const at = (over: Partial<AgentPosition>): AgentPosition =>
    ({ runId: "fleet-sub-fable-none-freeplay-claude-fable-5-none-20260829-a2", character: null, model: null, map: 0, x: 0, y: 0, ts: 0, level: null, xp: null, money: null, questsCompleted: null, items: null, harnessVersion: null, ...over }) as AgentPosition;

  test("the character's name is what the map calls a pip", () => {
    expect(pipName(at({ character: "Thorgrima", model: "claude-fable-5" }))).toBe("Thorgrima");
  });

  test("before a name exists it is the short model and its effort, never the run id", () => {
    expect(pipName(at({ model: "claude-fable-5", effort: "none" }))).toBe("claude-fable-5 · none");
    expect(pipName(at({ model: "nvidia/nemotron-3-super-120b-a12b:free" }))).toBe("nemotron-3-super-120b-a12b (free)");
    // A claude-code entry's compaction window rides after the effort.
    expect(pipName(at({ model: "claude-haiku-5-5", effort: "max", compactWindow: "100k" }))).toBe("claude-haiku-5-5 · max · 100k");
  });

  test("a feed that recorded no model at all still names the pip something", () => {
    expect(pipName(at({}))).toBe("fleet-sub-fable-none-freeplay-claude-fable-5-none-20260829-a2");
  });
});
