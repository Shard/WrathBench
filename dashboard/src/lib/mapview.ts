/**
 * The map's view maths, with no canvas and no DOM.
 *
 * The world→tile transform lives in `runner/viewer/worldmap.ts` and
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
import { GRID, LOD_MAX, TILE_PX, TILE_SIZE, lodGrid, tileToWorld, worldToPixel } from "@viewer/worldmap";
import { effortLabel, modelDisplay } from "./format";

export const MIN_SCALE = 0.01;
export const MAX_SCALE = 8;

/** How stale a reading may be before its pip is drawn dimmed. */
export const STALE_MS = 120_000;

/** The feed's own reference clock: when the response was rendered, and when this tab received it. */
export interface FeedClock {
  /** The snapshot envelope's `generatedAt` (server clock). */
  generatedAt: number;
  /** When this browser got the body (browser clock). */
  fetchedAt: number;
}

/**
 * How old a position reading is, for the stale dimming.
 *
 * Against the browser's clock alone the public build reads healthy agents as
 * stale: the snapshot pipeline's legitimate worst case — a 60s publish cadence
 * plus 30s at the edge plus the 30s client memo — is exactly `STALE_MS`, with
 * zero margin for the reading's own age. When the feed carries its envelope,
 * the age is measured the way `snapshotBanner` separates the same two clocks:
 * how old the reading was on the server's clock when the snapshot was rendered,
 * plus how long this tab has been holding the response on its own. Without an
 * envelope (the live API, replays) the plain arithmetic stands.
 */
export function positionAgeMs(ts: number, now: number, clock: FeedClock | null): number {
  if (clock === null) return now - ts;
  return clock.generatedAt - ts + (now - clock.fetchedAt);
}

/**
 * The maps we can name by id. A map id is what the server sends and what a
 * `/map?map=1` link carries, so it stays the title and the URL; the label is
 * what a reader can act on — "map 571" names a place only to someone who has
 * read the DBCs. Anything not listed keeps its number rather than being
 * guessed at: an instance or a battleground id is a real answer and a wrong
 * name for it would not be.
 *
 * An instance earns a name when it stops being a number a reader has to look
 * up — when it has tiles of its own to draw and agents actually ride it. The
 * Deeprun Tram is the first one to qualify on both counts; the rest of the
 * hundreds of instance ids stay numbers, which is the honest answer for a
 * place nothing has been to.
 */
const MAP_NAMES: Readonly<Record<number, string>> = {
  0: "Eastern Kingdoms",
  1: "Kalimdor",
  369: "Deeprun Tram",
  530: "Outland",
  571: "Northrend",
};

export function mapName(map: number): string {
  return MAP_NAMES[map] ?? `map ${map}`;
}

/**
 * The smallest a 256px tile is drawn on screen. Below it the map draws the
 * next pyramid level up instead, whose tile covers four times the ground at
 * the same pixel count (`tileLevel`).
 */
export const TILE_MIN_PX = 96;

/**
 * Tile images the map page keeps, misses included: an LRU, so a pan does not
 * re-request what it just drew and an unextracted tile is asked for once.
 */
export const TILE_CACHE_MAX = 512;

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

/**
 * Where the map looks when it has nothing to look at.
 *
 * An empty feed is the ordinary state of a quiet fleet, and it is what a first
 * visitor hits; the page has to draw a map anyway. It frames the starter
 * country every character begins in: Dun Morogh (Anvilmar, row 43.7) and
 * Elwynn (Northshire and Stormwind, row ~48.7) sit five tiles apart on the
 * same column, and a frame centred between them holds both — on a phone as
 * well as a desktop — at a scale where the native tiles draw, so the first
 * thing a reader sees is the full-detail map of where characters start. When
 * a position arrives the ordinary fit takes over and this is forgotten.
 *
 * Zooming out from it now shows real ground at every scale, the whole
 * continent included, from the baked pyramid (`tileLevel`). That used to be
 * impossible — below `TILE_MIN_PX` the page drew a bare lattice — and was
 * then part of the reason the default frames a place and not the continent.
 * A continent overview would now be a real choice of default; this one is
 * kept for the reason above.
 */
export const DEFAULT_MAP = 0;
const DEFAULT_ROW = 46.2;
const DEFAULT_COL = 31.1;
/** At or above `TILE_MIN_PX / TILE_PX`, so the default frame draws the native tiles. */
export const DEFAULT_SCALE = 0.4;

export function defaultView(screen: Screen, map: number = DEFAULT_MAP): View {
  if (map !== DEFAULT_MAP) return worldView(screen);
  const w = tileToWorld(DEFAULT_ROW, DEFAULT_COL);
  const p = worldToPixel(w.x, w.y);
  return centreOn(screen, p.px, p.py, DEFAULT_SCALE);
}

/**
 * The whole 64×64 grid, fitted to the stage. It is what any other map opens
 * on with nobody to fit to (a `/map?map=1` link on a quiet fleet): nothing
 * here knows where a continent sits in its grid, and the pyramid draws real
 * ground at this zoom, so the whole of it is the honest first frame.
 */
export function worldView(screen: Screen): View {
  const side = GRID * TILE_PX;
  return centreOn(screen, side / 2, side / 2, Math.min(screen.w, screen.h) / side);
}

/**
 * The map a `/map?map=<id>` link names, or null. Bare digits only, as the
 * server's map ids are: anything else is no pin rather than a guess.
 */
export function mapParam(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || !/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

/**
 * The chips: every map with someone on it, and the map on screen when nobody
 * is — a pinned map a reader opened by link still needs a chip, or there is
 * no way back from it without editing the URL.
 */
export function mapChips(maps: readonly [number, number][], active: number): [number, number][] {
  return maps.some(([id]) => id === active) ? [...maps] : [...maps, [active, 0]];
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

/** One finger on screen, in canvas pixels. */
export interface Touch {
  x: number;
  y: number;
}

/**
 * A two-finger pinch, measured from where it started rather than frame by
 * frame, so rounding never accumulates: the view scales by how far the fingers
 * have spread, and the world point that was under their midpoint follows the
 * midpoint, which is a pan when the spread does not change.
 */
export function pinchView(start: View, from: readonly [Touch, Touch], to: readonly [Touch, Touch]): View {
  const d0 = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y);
  const d1 = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
  const factor = d0 < 1 ? 1 : d1 / d0;
  const m0 = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const m1 = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  const z = zoomAt(start, m0.x, m0.y, factor);
  return { scale: z.scale, ox: z.ox + (m1.x - m0.x), oy: z.oy + (m1.y - m0.y) };
}

/** How close in time and place a second tap must land to zoom in, as a phone map does. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 30;

export function isDoubleTap(prev: (Touch & { t: number }) | null, now: Touch & { t: number }): boolean {
  return prev !== null && now.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(now.x - prev.x, now.y - prev.y) <= DOUBLE_TAP_PX;
}

/** How wide one cell of pyramid level `z` is on screen under a scale. */
export function levelCellPx(scale: number, z: number): number {
  return TILE_PX * 2 ** z * scale;
}

/**
 * The most cells of level `z` a screen can hold at a scale, wherever it is
 * panned: an interval of length L meets at most ceil(L / cell) + 1 cells, and
 * never more than the level's grid has. Independent of the offset on purpose,
 * so a pan never changes the level and the level never flickers under a drag.
 */
export function levelCells(z: number, scale: number, screen: Screen): number {
  if (z > LOD_MAX) return 0;
  const cell = levelCellPx(scale, z);
  const n = lodGrid(z);
  const across = Math.min(n, Math.ceil(screen.w / cell) + 1);
  const down = Math.min(n, Math.ceil(screen.h / cell) + 1);
  return across * down;
}

/**
 * Which pyramid level a frame draws: the finest whose cells are at least
 * `TILE_MIN_PX` on screen and whose cells, together with the next level up's,
 * fit in the tile cache. Level 0 is the native tiles and `LOD_MAX` one tile
 * for the world, which always fits.
 *
 * The next level up is counted because it is what the page draws under a
 * level that is still loading, so both have to stay cached through a zoom in
 * either direction; with only this level counted, a large screen would evict
 * the underlay it is drawing from. On a 1280×800 or 1920×1080 stage that
 * second condition never binds and the native tiles draw from `TILE_MIN_PX`
 * up exactly as before. On a larger one it moves the switch to the native
 * tiles to a slightly closer zoom: a 4K stage at 96px cells can meet nearly
 * a thousand native cells, which overran the cache before this existed.
 *
 * With `withArt` the painted layer is drawn too, at `artLevel(z)` with its own
 * level above as underlay, and its cells count against the same cache: one
 * budget for everything a frame asks for.
 */
export function tileLevel(scale: number, screen: Screen, withArt = false): number {
  const cells = (z: number): number => levelCells(z, scale, screen) + levelCells(z + 1, scale, screen);
  for (let z = 0; z < LOD_MAX; z++) {
    if (levelCellPx(scale, z) < TILE_MIN_PX) continue;
    if (cells(z) + (withArt ? cells(artLevel(z)) : 0) <= TILE_CACHE_MAX) return z;
  }
  return LOD_MAX;
}

/*
 * The painted map and the minimap, crossfaded by zoom.
 *
 * Zoomed out, the painted world and zone map reads as a map where the minimap
 * reads as noise; zoomed in, the minimap is the ground a character actually
 * walks on. In between the two are blended by how many screen pixels one ADT
 * takes up. The art is drawn over the minimap with the complement of the
 * minimap's weight, which is the same blend as the minimap over the art
 * wherever both have paint — and where the art has none (a map with no art,
 * an unpainted corner, a tile still loading) the minimap simply shows at full
 * strength, with no per-map bookkeeping to get wrong.
 *
 * Tuning the fade is these two numbers.
 */

/** At or below this many screen pixels per ADT, the art covers the minimap entirely. */
export const ART_FADE_START_PX = 48;
/** At or above this many, the art is not drawn and the minimap stands alone. */
export const ART_FADE_END_PX = 384;

/** Screen pixels one ADT spans under a scale (a native tile's on-screen size). */
export function pxPerAdt(scale: number): number {
  return TILE_PX * scale;
}

/**
 * The minimap's weight in the blend: 0 at `ART_FADE_START_PX` and below, 1 at
 * `ART_FADE_END_PX` and above, a smoothstep between. The step runs in log
 * pixels, because zoom is multiplicative: each wheel notch moves it about the
 * same amount, and the halfway point is the geometric mean of the two ends
 * (about 136 px per ADT with the values above, near the art's own z1).
 */
export function minimapAlpha(pxPerAdtNow: number): number {
  if (!(pxPerAdtNow > ART_FADE_START_PX)) return 0;
  if (pxPerAdtNow >= ART_FADE_END_PX) return 1;
  const t = Math.log(pxPerAdtNow / ART_FADE_START_PX) / Math.log(ART_FADE_END_PX / ART_FADE_START_PX);
  return t * t * (3 - 2 * t);
}

/**
 * The art's level when the minimap draws at `z`: the same level, except that
 * the art has no level 0, so at the native zoom it draws its finest, z1 (128
 * px per ADT), scaled up as far as `ART_FADE_END_PX`, where it stops.
 */
export function artLevel(z: number): number {
  return Math.max(1, z);
}

/** What one frame draws: the minimap's level, the art's (null when it is not drawn), and the blend. */
export interface FrameLevels {
  minimap: number;
  art: number | null;
  /** The minimap's weight; the art is drawn over it at `1 - minimapAlpha`. */
  minimapAlpha: number;
}

/**
 * Both layers' levels for a frame. The minimap is always drawn — it is what
 * shows wherever the art has nothing — and the art whenever it has any weight
 * at all; both are chosen together so their cells and underlays share the one
 * cache (`tileLevel`).
 */
export function frameLevels(scale: number, screen: Screen): FrameLevels {
  const alpha = minimapAlpha(pxPerAdt(scale));
  const withArt = alpha < 1;
  const z = tileLevel(scale, screen, withArt);
  return { minimap: z, art: withArt ? artLevel(z) : null, minimapAlpha: alpha };
}

/**
 * The inclusive cell range a view puts on screen at pyramid level `z`, clamped
 * to that level's grid. Level 0 is the native ADT grid.
 */
export function visibleGrid(
  view: View,
  screen: Screen,
  z = 0,
): { row0: number; row1: number; col0: number; col1: number; size: number } {
  const size = levelCellPx(view.scale, z);
  const last = lodGrid(z) - 1;
  const clamp = (v: number): number => Math.min(last, Math.max(0, v));
  return {
    col0: clamp(Math.floor(-view.ox / size)),
    col1: clamp(Math.floor((screen.w - view.ox) / size)),
    row0: clamp(Math.floor(-view.oy / size)),
    row1: clamp(Math.floor((screen.h - view.oy) / size)),
    size,
  };
}

/**
 * The fallback lattice as two runs of lines rather than one rect per cell, at
 * pyramid level `z`'s cell size.
 *
 * Where nothing is drawn into a cell — a build with no tile host, or a
 * pyramid level, whose tiles go on top — the whole lattice is one stroked
 * path: the 64x64 world used to put up to 4096 `strokeRect` calls into a
 * pan's frame budget, and this is at most 130 segments. With native tiles the
 * caller still strokes per cell, because there a drawn tile must suppress its
 * own cell's outline.
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
  z = 0,
): { xs: number[]; ys: number[]; x0: number; x1: number; y0: number; y1: number } {
  const g = visibleGrid(view, screen, z);
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
 * drags; at a screen-pixel tolerance the dropped points are
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
 * Precedence: an operator's pin (a chip click or a `/map?map=<id>` link), then
 * the replay cursor's own map, then where we already were, then the busiest
 * map in the feed. A pin holds whether or not anyone is on that map: every map
 * draws (its tiles, or the lattice where it has none), so a pinned empty map is
 * a map to look at, not a blank canvas.
 *
 * With nothing to go on it answers `DEFAULT_MAP` rather than "no map". It used
 * to answer null, and the page has no rendering for that: the draw loop filled
 * a flat rectangle, so a quiet fleet — no live character anywhere, which is the
 * state a first visitor meets — got a blank page instead of a map. A map id is
 * always available because the map is always drawable; whether anyone is
 * standing on it is `count`'s question, not this one.
 */
export function chooseMap(
  maps: readonly [number, number][],
  prev: number | null,
  pinned: number | null,
  cursor: number | null,
): number {
  const has = (m: number): boolean => maps.some(([id]) => id === m);
  if (pinned !== null) return pinned;
  if (cursor !== null) return cursor;
  if (prev !== null && has(prev)) return prev;
  return maps.length > 0 ? maps[0]![0] : DEFAULT_MAP;
}

/**
 * What the sidebar says when no pip is selected.
 *
 * The three cases are different facts and used to be two. "No characters on the
 * map" was what an empty feed got, which reads as though the map were the
 * problem; the fact is that nobody is running right now, and naming the
 * continent on screen tells the reader what they are looking at instead — the
 * chips are hidden with fewer than two maps, so otherwise nothing does.
 */
export function emptySideNote(count: number, replaying: boolean, map: number): string {
  if (count > 0) return "no character selected";
  if (replaying) return "no character at this point in the replay";
  return `no character is live right now — showing ${mapName(map)}`;
}

/**
 * What to call a pip.
 *
 * The character's name when the run has made one — that is the thing on the
 * map. Before it has, the map used to print the run id, which is mostly job
 * bookkeeping (`fleet-sub-fable-none-freeplay-…`): a roster key and a date
 * standing where a name belongs. The model, short, with its effort, is the
 * honest answer to "who is that" — and two characters of one model are told apart
 * by the effort rather than reading as the same character twice. The run id
 * stays in the hover, which is where an id belongs.
 */
export function pipName(
  p: Pick<AgentPosition, "runId" | "character" | "model"> & { effort?: string | null; compactWindow?: string | null },
): string {
  if (p.character !== null && p.character.length > 0) return p.character;
  if (p.model === null || p.model.length === 0) return p.runId;
  const model = modelDisplay(p.model);
  const tag = effortLabel(p.effort, p.compactWindow);
  return tag === null ? model : `${model} · ${tag}`;
}
