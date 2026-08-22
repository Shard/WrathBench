/**
 * The map's view maths. Pure functions, so pip placement is checked here rather
 * than by looking at a canvas.
 *
 * The transform itself is `runner/viewer/worldmap.ts` and is tested there; what
 * these pin is the layer the SPA adds — projection under a view, fitting,
 * cursor-anchored zoom, and hit testing.
 */

import { describe, expect, test } from "bun:test";
import { worldToPixel } from "../../runner/viewer/worldmap";
import {
  MAX_SCALE,
  MIN_SCALE,
  centreOn,
  clampScale,
  colorOf,
  fitTo,
  hitTest,
  hueOf,
  project,
  visibleGrid,
  zoomAt,
} from "../src/lib/mapview";

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
