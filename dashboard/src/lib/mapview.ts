/**
 * The map's view maths, with no canvas and no DOM.
 *
 * ADR-0019 keeps the world→tile transform in `runner/viewer/worldmap.ts` and
 * this module imports it rather than copying it — the reason the hand-written
 * map page duplicated those constants was that it was a string with no module
 * loader, which the SPA is not. Everything here is pure so pip placement and
 * hit testing are testable without a browser.
 *
 * The view is one affine transform on both axes:
 *
 *     screen = worldPixel * scale + offset
 */

import type { AgentPosition } from "@viewer/api-types";
import { GRID, TILE_PX, TILE_SIZE, worldToPixel } from "@viewer/worldmap";

export const MIN_SCALE = 0.01;
export const MAX_SCALE = 8;

/** How stale a reading may be before its pip is drawn dimmed. */
export const STALE_MS = 120_000;

/** Below this on-screen tile size a 256px tile carries no information. */
export const TILE_MIN_PX = 96;

export interface View {
  scale: number;
  ox: number;
  oy: number;
}

export interface Screen {
  w: number;
  h: number;
}

/** Anything with a world position. The map draws these and asks nothing else. */
export interface Placeable {
  x: number;
  y: number;
}

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** World (x, y) → screen pixels under a view. */
export function project(view: View, x: number, y: number): { sx: number; sy: number } {
  const p = worldToPixel(x, y);
  return { sx: p.px * view.scale + view.ox, sy: p.py * view.scale + view.oy };
}

/** A view centred on a world-pixel point at a given scale. */
export function centreOn(screen: Screen, px: number, py: number, scale: number): View {
  const s = clampScale(scale);
  return { scale: s, ox: screen.w / 2 - px * s, oy: screen.h / 2 - py * s };
}

/**
 * A view that fits everything given, with padding.
 *
 * An empty list has no box to fit and gets the whole world at a readable zoom;
 * a single agent has a zero-size box and gets a close-up rather than a division
 * by zero.
 */
export function fitTo(screen: Screen, list: readonly Placeable[], pad = 240): View {
  if (list.length === 0) return centreOn(screen, (GRID * TILE_PX) / 2, (GRID * TILE_PX) / 2, 0.06);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of list) {
    const q = worldToPixel(p.x, p.y);
    x0 = Math.min(x0, q.px);
    x1 = Math.max(x1, q.px);
    y0 = Math.min(y0, q.py);
    y1 = Math.max(y1, q.py);
  }
  const bw = x1 - x0 + pad * 2;
  const bh = y1 - y0 + pad * 2;
  const scale = clampScale(Math.min(screen.w / bw, screen.h / bh));
  return centreOn(screen, (x0 + x1) / 2, (y0 + y1) / 2, Math.min(scale, 1.5));
}

/** Zoom about a screen point, keeping the world point under it in place. */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const next = clampScale(view.scale * factor);
  return {
    scale: next,
    ox: sx - (sx - view.ox) * (next / view.scale),
    oy: sy - (sy - view.oy) * (next / view.scale),
  };
}

/** The inclusive tile range a view puts on screen, clamped to the world grid. */
export function visibleGrid(
  view: View,
  screen: Screen,
): { row0: number; row1: number; col0: number; col1: number; size: number } {
  const size = TILE_PX * view.scale;
  const clamp = (v: number): number => Math.min(GRID - 1, Math.max(0, v));
  return {
    col0: clamp(Math.floor(-view.ox / size)),
    col1: clamp(Math.floor((screen.w - view.ox) / size)),
    row0: clamp(Math.floor(-view.oy / size)),
    row1: clamp(Math.floor((screen.h - view.oy) / size)),
    size,
  };
}

/**
 * The fallback lattice as two runs of lines rather than one rect per cell.
 *
 * Below `TILE_MIN_PX` no tile is drawn, so no cell can be covered and the whole
 * lattice is one stroked path: the 64x64 world used to put up to 4096
 * `strokeRect` calls into a pan's frame budget, and this is at most 130
 * segments (FOLLOW-UPS 60). Above the threshold the caller still strokes per
 * cell, because there a drawn tile must suppress its own cell's outline.
 *
 * `x0`/`x1` and `y0`/`y1` are the extent to span: the lines cover exactly the
 * clamped grid box `visibleGrid` reports, so the lattice stops at the world's
 * edge rather than running off into empty space.
 *
 * The 0.5 offset is kept — a 1px stroke lands on a pixel centre or it blurs.
 * One difference from the per-cell rects is deliberate: those were inset by a
 * pixel, so every interior boundary carried *two* lines a pixel apart. A shared
 * boundary is now one line, which reads thinner and cleaner at this zoom.
 */
export function latticeLines(
  view: View,
  screen: Screen,
): { xs: number[]; ys: number[]; x0: number; x1: number; y0: number; y1: number } {
  const g = visibleGrid(view, screen);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let col = g.col0; col <= g.col1 + 1; col++) xs.push(col * g.size + view.ox + 0.5);
  for (let row = g.row0; row <= g.row1 + 1; row++) ys.push(row * g.size + view.oy + 0.5);
  return {
    xs,
    ys,
    x0: xs[0]!,
    x1: xs[xs.length - 1]!,
    y0: ys[0]!,
    y1: ys[ys.length - 1]!,
  };
}

/**
 * World yards that project to one screen pixel under a scale.
 *
 * Both axes carry the same factor — `worldToPixel` is `TILE_PX / TILE_SIZE` on
 * each — so a world Euclidean distance maps to a screen distance by this one
 * number. That is what lets `decimateRoute` measure in world units instead of
 * projecting every point; if the axes ever diverged, it would go anisotropic
 * without saying so.
 */
export function worldPerPixel(scale: number): number {
  return TILE_SIZE / (TILE_PX * scale);
}

/**
 * Drop route points that would land within `minDist` of the previously kept
 * one, in world units.
 *
 * A six-hour track is one `lineTo` per recorded sample every frame the operator
 * drags (FOLLOW-UPS 60); at a screen-pixel tolerance the dropped points are
 * points that had nowhere of their own to be drawn. The comparison is against
 * the last *kept* point, not the last input point: comparing against the input
 * would let a slow drift accumulate an unbounded error, because every step is
 * small even when the walk is long.
 *
 * The first and last points always survive. The last is where the pip sits, and
 * dropping it detaches the route's tail from the character.
 *
 * Measuring in world units rather than on screen is what makes the result
 * independent of the view's offset: a pan reuses it, and only a zoom (a new
 * `minDist`) or a new prefix rebuilds. The caller owns that cache.
 */
export function decimateRoute<T extends Placeable>(points: readonly T[], minDist: number): T[] {
  if (points.length < 3 || !(minDist > 0)) return [...points];
  const min2 = minDist * minDist;
  const out: T[] = [points[0]!];
  let anchor = points[0]!;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const dx = p.x - anchor.x;
    const dy = p.y - anchor.y;
    if (dx * dx + dy * dy < min2) continue;
    out.push(p);
    anchor = p;
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** The nearest placeable within `radius` screen pixels, or null. */
export function hitTest<T extends Placeable>(
  view: View,
  list: readonly T[],
  sx: number,
  sy: number,
  radius = 18,
): T | null {
  let best: T | null = null;
  let bestD = radius * radius;
  for (const item of list) {
    const p = project(view, item.x, item.y);
    const d = (p.sx - sx) * (p.sx - sx) + (p.sy - sy) * (p.sy - sy);
    if (d <= bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/**
 * A stable colour per run: the same run gets the same dot across reloads and
 * machines, which is what makes a pip recognisable between sessions. FNV-1a
 * over the id, folded onto the hue circle.
 */
export function hueOf(runId: string): number {
  let h = 2166136261;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

export function colorOf(runId: string): string {
  return `hsl(${hueOf(runId)} 70% 60%)`;
}

/* --- the renderer's pip state, kept pure so Solid never has to own it --- */

/**
 * A drawn agent: its newest reading, and where it is *currently drawn*, which
 * lags the reading while the pip walks toward it.
 */
export interface Pip extends Placeable {
  runId: string;
  data: AgentPosition;
}

/**
 * Fold a feed into the renderer's pip map, in place.
 *
 * The point of this being a plain function over a plain `Map` is that it touches
 * no signal. It used to be a method on the component that read `activeMap` and
 * `selected` and wrote both back, which made every feed tick re-enter its own
 * effect; the derived state now hangs off the feed instead (see `mapstate.ts`)
 * and this does nothing but move pips.
 *
 * Identity is stable: a run already on the map keeps its `Pip` object, so a
 * re-run with the same feed is a no-op rather than a fresh set of objects.
 */
export function syncPips(
  pips: Map<string, Pip>,
  list: readonly AgentPosition[],
  snap = false,
): void {
  const seen = new Set<string>();
  for (const p of list) {
    seen.add(p.runId);
    const existing = pips.get(p.runId);
    if (existing === undefined) {
      pips.set(p.runId, { runId: p.runId, data: p, x: p.x, y: p.y });
      continue;
    }
    existing.data = p;
    // Scrubbing: the pip belongs where the cursor says, now. Walking there at
    // 0.18/frame would trail every drag of the slider.
    if (snap) {
      existing.x = p.x;
      existing.y = p.y;
    }
  }
  for (const id of [...pips.keys()]) if (!seen.has(id)) pips.delete(id);
}

/** A plain lerp toward the newest reading: a pip walks rather than teleports. */
export function stepPips(list: readonly Pip[], rate = 0.18): boolean {
  let moving = false;
  for (const pip of list) {
    const dx = pip.data.x - pip.x;
    const dy = pip.data.y - pip.y;
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
      pip.x = pip.data.x;
      pip.y = pip.data.y;
      continue;
    }
    pip.x += dx * rate;
    pip.y += dy * rate;
    moving = true;
  }
  return moving;
}

/** How many of a feed stand on each map, busiest first, ties broken by map id. */
export function mapCounts(list: readonly { map: number }[]): [number, number][] {
  const counts = new Map<number, number>();
  for (const p of list) counts.set(p.map, (counts.get(p.map) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/**
 * Which map the canvas shows, given everything that has an opinion.
 *
 * Sticky by construction, and a pure function of its inputs — the previous
 * answer is an *argument*, not state read back out of a signal. That is what
 * lets the caller express "stay on this map while it still has an agent"
 * without a derivation that writes to what it reads.
 *
 * Precedence: an operator's chip click, then the replay cursor's own map, then
 * where we already were, then the busiest map in the feed.
 */
export function chooseMap(
  maps: readonly [number, number][],
  prev: number | null,
  pinned: number | null,
  cursor: number | null,
): number | null {
  const has = (m: number): boolean => maps.some(([id]) => id === m);
  if (pinned !== null && has(pinned)) return pinned;
  if (cursor !== null) return cursor;
  if (prev !== null && has(prev)) return prev;
  return maps.length > 0 ? maps[0]![0] : null;
}
