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
import { GRID, TILE_PX, worldToPixel } from "@viewer/worldmap";

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
