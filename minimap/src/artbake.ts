#!/usr/bin/env bun
/**
 * The painted map layer: every zone's world-map art stitched into one picture
 * over the minimap's grid, so a zoomed-out map can show the painted world and
 * cross-fade to minimap ground further in. The method and the evidence behind
 * each rule are in `minimap/README.md` ("The painted map").
 *
 * Writes `<tile root>/<mapId>/art/<z>/<row>_<col>.png` for z = 1..LOD_MAX:
 * 256x256 RGBA over 2^z x 2^z ADTs (z1 = 128 px per ADT), transparent where
 * there is no terrain, only tiles with content, byte-deterministic. An
 * existing tile is skipped unless `--force`; every level is still computed.
 *
 *   bun minimap/src/artbake.ts [--map 0,1,530,571] [--force] [--data <dir>]
 *                              [--client <dir>] [--locale enUS] [--out <tile root>]
 *                              [--gap paper|minimap] [--cities]
 *
 * `--data` is the data root the other inputs default under: the client
 * archives at `client-source/Data`, the DBCs at `client/dbc`, the server's
 * area grid at `client/maps`, and the tile root (which must already hold the
 * native minimap tiles: the art is opaque over every one of them) at `minimap`.
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ART_LAYER, GRID, LOD_MAX, TILE_PX, TILE_SIZE, lodTileName } from "../../runner/viewer/worldmap";
import { type Pixels, downsampleQuad, writeTile } from "./bake";
import { CELLS, LIQUID_OCEAN, LIQUID_WATER, type MapCells, mapFileName, parseMapFile } from "./mapfile";
import { MpqChain } from "./mpq";
import { decodePng, encodePng } from "./png";
import {
  ART_H,
  ART_W,
  AREA_CAPITAL,
  type AreaRow,
  type MapArea,
  type Overlay,
  composeZoneArt,
  distanceFrom,
  readAreaTable,
  readOverlays,
  readWorldMapAreas,
  worldToArt,
  zoneResolver,
} from "./zoneart";

/** z1: a 256px tile over 2x2 ADTs. */
export const ART_PPA = TILE_PX / 2;
const CELL_YARDS = TILE_SIZE / CELLS;

export interface ArtParams {
  /** Territory blur, in area cells (33.3 yd), before sharpening. */
  territorySigma: number;
  /** Exponent that sharpens the blurred territories back into a smooth-edged partition. */
  sharpen: number;
  /** How far a zone's art may reach out over open sea from its land, yards. */
  extYards: number;
  /** Unclaimed ground is paper out to this many yards from a zone's land, then fades to clear over `gapFade`. */
  gapReach: number;
  gapFade: number;
  /**
   * The sea fill: full out to `seaReach` yards from the coast, then fading to clear over
   * `seaFade` — and opaque over every ADT with a native minimap tile, fading over `seaFade`
   * beyond those.
   */
  seaReach: number;
  seaFade: number;
  /** How far from its own painted interior a zone's art is trusted, art px: on land, at sea. */
  ownLand: number;
  ownSea: number;
  /** Width of the fade before those limits, art px. */
  ownFeather: number;
  /**
   * The painted frame (burnt edge, corner ornaments): insets left, right, top, bottom and
   * corner radius, art px. Set by inspection of the frame — it is not a pixel-identical
   * template across zone maps, so it cannot be measured by comparing them.
   */
  frame: [number, number, number, number];
  corner: number;
  /** Width of the fade inside the frame, and how far noise pulls it inward, art px. */
  frameFeather: number;
  frameWave: number;
  /**
   * Unpainted land: parchment-coloured noise, or the minimap's ground graded to the parchment.
   * Parchment is the default: unpainted land is exactly where the minimap is unfinished (flat
   * placeholder fills with chunk-staircase edges), and grading carries those edges over.
   */
  gap: "minimap" | "paper";
  /** Draw the capitals' own maps (off: the surrounding zone's art paints them). */
  cities: boolean;
}

export const DEFAULT_PARAMS: ArtParams = {
  territorySigma: 2,
  sharpen: 3,
  extYards: 450,
  gapReach: 450,
  gapFade: 450,
  seaReach: 3 * TILE_SIZE,
  seaFade: 2 * TILE_SIZE,
  ownLand: 110,
  ownSea: 35,
  ownFeather: 30,
  frame: [10, 10, 10, 26],
  corner: 80,
  frameFeather: 56,
  frameWave: 18,
  gap: "paper",
  cities: false,
};

/** Everything a bake reads, so tests can hand it synthetic data. */
export interface ArtSources {
  /** A file from the client archives, or undefined. */
  read(path: string): Uint8Array | undefined;
  areas: readonly MapArea[];
  overlays: readonly Overlay[];
  areaTable: ReadonlyMap<number, AreaRow>;
  /** The server's `.map` file for one ADT, or undefined where there is no terrain. */
  mapFile(mapId: number, row: number, col: number): Uint8Array | undefined;
  /** The native minimap tile (256px RGBA), or null. */
  minimap(mapId: number, row: number, col: number): Pixels | null;
  /** Whether the map has a native minimap tile for this ADT (cheap; no decode). */
  hasMinimap(mapId: number, row: number, col: number): boolean;
}

/** Colours the bake measured from the art; printed so a bake can be judged. */
export interface Measured {
  paper: [number, number, number];
  paperRelStd: number;
  water: [number, number, number];
  groundMean: number;
  groundStd: number;
}

export interface ArtResult {
  /** z1 tiles with content, keyed `row_col` on the z1 grid. */
  tiles: Map<string, Pixels>;
  measured: Measured | null;
  zones: string[];
}

// ---------------------------------------------------------------- small numerics

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function hash(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in [0, 1). */
function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** Separable Gaussian, clamped at the edges. */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src.slice();
  const rad = Math.ceil(3 * sigma), k = new Float32Array(2 * rad + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) sum += k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const tmp = new Float32Array(w * h), dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -rad; i <= rad; i++) a += src[y * w + Math.min(w - 1, Math.max(0, x + i))]! * k[i + rad]!;
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -rad; i <= rad; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]! * k[i + rad]!;
      dst[y * w + x] = a;
    }
  }
  return dst;
}

/** Two-pass chamfer distance in yards from every cell where `src` is set (1e9 where none reach). */
function chamfer(src: Uint8Array, w: number, h: number, step: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = src[i] ? 0 : 1e9;
  const diag = step * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = d[i]!;
        if (x > 0) v = Math.min(v, d[i - 1]! + step);
        if (y > 0) {
          v = Math.min(v, d[i - w]! + step);
          if (x > 0) v = Math.min(v, d[i - w - 1]! + diag);
          if (x < w - 1) v = Math.min(v, d[i - w + 1]! + diag);
        }
        d[i] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = d[i]!;
        if (x < w - 1) v = Math.min(v, d[i + 1]! + step);
        if (y < h - 1) {
          v = Math.min(v, d[i + w]! + step);
          if (x < w - 1) v = Math.min(v, d[i + w + 1]! + diag);
          if (x > 0) v = Math.min(v, d[i + w - 1]! + diag);
        }
        d[i] = v;
      }
    }
  }
  return d;
}

/** Bilinear read of a cell field at fractional cell coordinates (cell centres on integers). */
function bilinear(f: Float32Array, w: number, h: number, y: number, x: number): number {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  return (f[y0 * w + x0]! * (1 - fx) + f[y0 * w + x1]! * fx) * (1 - fy) + (f[y1 * w + x0]! * (1 - fx) + f[y1 * w + x1]! * fx) * fy;
}

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

function median(a: number[]): number {
  if (a.length === 0) return Number.NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1]!;
}

// ---------------------------------------------------------------- art sampling

interface Mip {
  w: number;
  h: number;
  rgba: Float32Array;
}

function halve(m: Mip): Mip {
  const w = Math.max(1, m.w >> 1), h = Math.max(1, m.h >> 1);
  const out = new Float32Array(w * h * 4);
  const at = (y: number, x: number, k: number) => m.rgba[(Math.min(m.h - 1, y) * m.w + Math.min(m.w - 1, x)) * 4 + k]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 4; k++) {
        out[(y * w + x) * 4 + k] = (at(2 * y, 2 * x, k) + at(2 * y, 2 * x + 1, k) + at(2 * y + 1, 2 * x, k) + at(2 * y + 1, 2 * x + 1, k)) / 4;
      }
    }
  }
  return { w, h, rgba: out };
}

/** Bilinear sample at continuous pixel coordinates (centres at +0.5), rgb into `out`. */
function sample(m: Mip, u: number, v: number, out: Float32Array): void {
  const x = Math.max(0, Math.min(m.w - 1.0001, u - 0.5)), y = Math.max(0, Math.min(m.h - 1.0001, v - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i00 = (y0 * m.w + x0) * 4, i10 = i00 + 4, i01 = i00 + m.w * 4, i11 = i01 + 4, p = m.rgba;
  for (let k = 0; k < 3; k++) {
    out[k] = (p[i00 + k]! * (1 - fx) + p[i10 + k]! * fx) * (1 - fy) + (p[i01 + k]! * (1 - fx) + p[i11 + k]! * fx) * fy;
  }
}

// ---------------------------------------------------------------- the bake of one map

interface Zone {
  area: MapArea;
  art: Mip;
  /** Chamfer distance (art px) from the zone's own painted interior; null = no overlays. */
  ownDist: Float32Array | null;
  /** The art level that matches z1's density, and its scale against the full art. */
  mip: Mip;
  mipScale: number;
  seed: number;
}

/**
 * Render one map's z1 tiles. Returns only tiles with an opaque pixel.
 * Deterministic: no clock, no randomness, fixed iteration orders.
 */
export function renderArt(mapId: number, src: ArtSources, params: ArtParams = DEFAULT_PARAMS, log: (s: string) => void = () => {}): ArtResult {
  const P = params;
  const empty: ArtResult = { tiles: new Map(), measured: null, zones: [] };

  // Terrain: which ADTs exist, and their cells.
  const adts = new Map<number, MapCells>();
  let tr0 = GRID, tr1 = -1, tc0 = GRID, tc1 = -1;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const data = src.mapFile(mapId, r, c);
      if (data === undefined) continue;
      adts.set(r * GRID + c, parseMapFile(data));
      tr0 = Math.min(tr0, r); tr1 = Math.max(tr1, r); tc0 = Math.min(tc0, c); tc1 = Math.max(tc1, c);
    }
  }
  if (adts.size === 0) return empty;
  // The minimap's own tiles: wherever the art is clear the map page shows them at full
  // strength, so the art must cover every one of them (see `covered` below).
  const minimapAdts = new Set<number>();
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (!src.hasMinimap(mapId, r, c)) continue;
      minimapAdts.add(r * GRID + c);
      tr0 = Math.min(tr0, r); tr1 = Math.max(tr1, r); tc0 = Math.min(tc0, c); tc1 = Math.max(tc1, c);
    }
  }

  // The cell region: the terrain's and the minimap's bounding box, and room for the sea to fade out past it.
  const marginAdt = Math.ceil((P.seaReach + P.seaFade) / TILE_SIZE) + 1;
  const cr0 = Math.max(0, (tr0 - marginAdt) * CELLS), cc0 = Math.max(0, (tc0 - marginAdt) * CELLS);
  const cr1 = Math.min(GRID * CELLS, (tr1 + 1 + marginAdt) * CELLS), cc1 = Math.min(GRID * CELLS, (tc1 + 1 + marginAdt) * CELLS);
  const H = cr1 - cr0, W = cc1 - cc0, N = W * H;
  // `ground`: terrain that is not open sea, for the backdrop. `land`: ground a zone can claim —
  // the server gives it an area (area 0 is unused terrain, and on 530 it carries baked labels).
  const area = new Uint16Array(N), liquid = new Uint8Array(N), present = new Uint8Array(N), land = new Uint8Array(N), ground = new Uint8Array(N);
  for (const [key, cells] of adts) {
    const r = Math.floor(key / GRID), c = key % GRID;
    for (let i = 0; i < CELLS * CELLS; i++) {
      const gr = r * CELLS + Math.floor(i / CELLS) - cr0, gc = c * CELLS + (i % CELLS) - cc0;
      const j = gr * W + gc;
      area[j] = cells.area[i]!;
      liquid[j] = cells.liquid[i]!;
      present[j] = 1;
      ground[j] = cells.liquid[i]! & LIQUID_OCEAN ? 0 : 1;
      land[j] = ground[j]! && cells.area[i] !== 0 ? 1 : 0;
    }
  }
  // Open `ground` by one cell: some ocean ADTs leave their last row of cells without liquid,
  // which would draw a one-cell strip of shore across open water.
  {
    const er = new Uint8Array(N);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let all = 1;
      for (let dr = -1; dr <= 1 && all; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < H && cc < W && !ground[rr * W + cc]) { all = 0; break; }
      }
      er[r * W + c] = all;
    }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let any = 0;
      for (let dr = -1; dr <= 1 && !any; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < H && cc < W && er[rr * W + cc]) { any = 1; break; }
      }
      ground[r * W + c] = ground[r * W + c]! & any;
    }
  }

  const cellWorld = (i: number) => ({ x: (32 - (cr0 + Math.floor(i / W) + 0.5) / CELLS) * TILE_SIZE, y: (32 - (cc0 + (i % W) + 0.5) / CELLS) * TILE_SIZE });

  // Zones on this map whose art reaches the region.
  const zoneOf = zoneResolver(src.areaTable as Map<number, AreaRow>);
  const regionN = (32 - cr0 / CELLS) * TILE_SIZE, regionS = (32 - cr1 / CELLS) * TILE_SIZE;
  const regionW = (32 - cc0 / CELLS) * TILE_SIZE, regionE = (32 - cc1 / CELLS) * TILE_SIZE;
  const zones: Zone[] = [];
  const zoneByArea = new Map<number, number>();
  const candidates = [...src.areas]
    .filter((a) => a.mapId === mapId && a.areaId !== 0 && a.left !== a.right && a.top !== a.bottom)
    .filter((a) => P.cities || !((src.areaTable.get(a.areaId)?.flags ?? 0) & AREA_CAPITAL))
    .filter((a) => a.bottom < regionN && a.top > regionS && a.right < regionW && a.left > regionE)
    .sort((a, b) => a.id - b.id);
  const outPerYard = ART_PPA / TILE_SIZE;
  for (const a of candidates) {
    const composed = composeZoneArt(src.read, a, src.overlays);
    if (composed === null) {
      log(`  ${a.name}: art missing, skipped`);
      continue;
    }
    const art: Mip = { w: ART_W, h: ART_H, rgba: composed.rgba };
    const level = Math.max(0, Math.floor(Math.log2(ART_W / (a.left - a.right) / outPerYard)));
    let mip = art;
    for (let l = 0; l < level; l++) mip = halve(mip);
    zoneByArea.set(a.areaId, zones.length);
    zones.push({ area: a, art, ownDist: composed.own ? distanceFrom(composed.own, ART_W, ART_H) : null, mip, mipScale: 1 / (1 << level), seed: a.id });
  }
  if (zones.length === 0) return empty;

  // Validity: how far a zone's art can be trusted at a world point, on land and at sea.
  // Continuous in art space, so it is evaluated per output pixel, never per cell.
  const [fl, fr, ft, fb] = P.frame;
  const frameDist = (u: number, v: number): number => {
    const x0 = fl + P.corner, x1 = ART_W - fr - P.corner, y0 = ft + P.corner, y1 = ART_H - fb - P.corner;
    const dx = u < x0 ? x0 - u : u > x1 ? u - x1 : 0, dy = v < y0 ? y0 - v : v > y1 ? v - y1 : 0;
    if (dx > 0 && dy > 0) return P.corner - Math.hypot(dx, dy);
    return Math.min(u - fl, ART_W - fr - u, v - ft, ART_H - fb - v);
  };
  const ownAt = (z: Zone, u: number, v: number): number => {
    if (z.ownDist === null) return 0;
    const x = Math.max(0, Math.min(ART_W - 1, Math.floor(u))), y = Math.max(0, Math.min(ART_H - 1, Math.floor(v)));
    return z.ownDist[y * ART_W + x]!;
  };
  const seaFe = Math.min(P.ownFeather, P.ownSea / 2);
  /** Writes [land, sea] validity of zone `z` at world (x, y) into `out`. */
  const validity = (z: Zone, x: number, y: number, out: Float32Array): void => {
    out[0] = out[1] = 0;
    const { u, v } = worldToArt(z.area, x, y);
    if (u <= 0 || v <= 0 || u >= ART_W || v >= ART_H) return;
    // the frame fade, pulled inward (never outward) by noise so a cut is not a ruler line
    const pull = P.frameWave * (0.65 * vnoise(u / 47, v / 47, z.seed) + 0.35 * vnoise(u / 15, v / 15, z.seed + 7));
    const f = smooth((frameDist(u, v) - pull) / P.frameFeather);
    if (f <= 0) return;
    if (z.ownDist === null) { out[0] = f; return; } // the cities: their own land only
    const d = ownAt(z, u, v);
    out[0] = f * (1 - smooth((d - (P.ownLand - P.ownFeather)) / P.ownFeather));
    out[1] = f * (1 - smooth((d - (P.ownSea - seaFe)) / seaFe));
  };

  // Territory per cell: land by the raster's zone; sea (and area-0 ground) by the nearest
  // land's zone up to extYards.
  const terr = new Int16Array(N).fill(-1), dist = new Float32Array(N).fill(1e9);
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    const z = zoneByArea.get(zoneOf(area[i]!));
    if (z !== undefined) { terr[i] = z; dist[i] = 0; }
  }
  const steps: [number, number, number][] = [[-1, -1, Math.SQRT2], [-1, 0, 1], [-1, 1, Math.SQRT2], [0, -1, 1]];
  for (let pass = 0; pass < 2; pass++) {
    for (const dir of [1, -1]) {
      for (let r = dir > 0 ? 0 : H - 1; r >= 0 && r < H; r += dir) {
        for (let c = dir > 0 ? 0 : W - 1; c >= 0 && c < W; c += dir) {
          const i = r * W + c;
          for (const [dr, dc, cost] of steps) {
            const rr = r + dr * dir, cc = c + dc * dir;
            if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
            const j = rr * W + cc, step = cost * CELL_YARDS;
            if (!land[i] && terr[j]! >= 0 && dist[j]! + step < dist[i]! && dist[j]! + step <= P.extYards) { dist[i] = dist[j]! + step; terr[i] = terr[j]!; }
          }
        }
      }
    }
  }
  const reachRaw = new Float32Array(N);
  for (let i = 0; i < N; i++) reachRaw[i] = land[i] ? 1 : terr[i]! >= 0 ? 1 - smooth((dist[i]! - (P.extYards - 150)) / 150) : 0;

  // Fields at cell resolution, read bilinearly per pixel.
  interface Field { zi: number; r0: number; c0: number; h: number; w: number; f: Float32Array }
  const fields: Field[] = [];
  const pad = Math.ceil(3 * P.territorySigma) + 2;
  for (let zi = 0; zi < zones.length; zi++) {
    let a = H, b = -1, c = W, d = -1;
    for (let i = 0; i < N; i++) {
      if (terr[i] !== zi) continue;
      const r = Math.floor(i / W), q = i % W;
      if (r < a) a = r;
      if (r > b) b = r;
      if (q < c) c = q;
      if (q > d) d = q;
    }
    if (b < 0) continue;
    a = Math.max(0, a - pad); b = Math.min(H - 1, b + pad); c = Math.max(0, c - pad); d = Math.min(W - 1, d + pad);
    const h = b - a + 1, w = d - c + 1, ind = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) ind[r * w + q] = terr[(a + r) * W + c + q] === zi ? 1 : 0;
    fields.push({ zi, r0: a, c0: c, h, w, f: gaussBlur(ind, w, h, P.territorySigma) });
  }
  const K = 8;
  const cand = new Int16Array(N * K).fill(-1), nCand = new Uint8Array(N);
  for (let fi = 0; fi < fields.length; fi++) {
    const F = fields[fi]!;
    for (let r = 0; r < F.h; r++) {
      for (let q = 0; q < F.w; q++) {
        const m = Math.max(F.f[r * F.w + q]!, F.f[Math.min(F.h - 1, r + 1) * F.w + q]!, F.f[r * F.w + Math.min(F.w - 1, q + 1)]!, F.f[Math.min(F.h - 1, r + 1) * F.w + Math.min(F.w - 1, q + 1)]!);
        if (m < 1e-3) continue;
        const i = (F.r0 + r) * W + F.c0 + q;
        if (nCand[i]! < K) cand[i * K + nCand[i]!++] = fi;
      }
    }
  }
  // which zones' art covers each cell (and its +1 neighbours)
  const cover = new Int16Array(N * K).fill(-1), nCover = new Uint8Array(N);
  for (let zi = 0; zi < zones.length; zi++) {
    const a = zones[zi]!.area;
    const rA = Math.max(0, Math.floor((32 - a.top / TILE_SIZE) * CELLS) - cr0 - 1), rB = Math.min(H - 1, Math.ceil((32 - a.bottom / TILE_SIZE) * CELLS) - cr0);
    const cA = Math.max(0, Math.floor((32 - a.left / TILE_SIZE) * CELLS) - cc0 - 1), cB = Math.min(W - 1, Math.ceil((32 - a.right / TILE_SIZE) * CELLS) - cc0);
    for (let r = rA; r <= rB; r++) for (let q = cA; q <= cB; q++) { const i = r * W + q; if (nCover[i]! < K) cover[i * K + nCover[i]!++] = zi; }
  }
  // The backdrop. Ground no zone claims is paper only near a zone's land, fading out past
  // gapReach — so unused terrain far from any zone (Outland's void, map 0's Quel'Thalas) is
  // left clear, edged by the zones rather than by the ADT grid. Sea is where the server says
  // ocean, and the terrain-less cells near ocean, out to seaReach from the visible coast.
  // `painted`: land some zone's art can paint (a raster claim with no art behind it — territory
  // past the edge of its zone's map — counts as a gap like any other).
  const painted = new Uint8Array(N), ocean = new Uint8Array(N), vc = new Float32Array(2);
  for (let i = 0; i < N; i++) {
    ocean[i] = present[i] && liquid[i]! & LIQUID_OCEAN ? 1 : 0;
    if (!land[i]) continue;
    const { x, y } = cellWorld(i);
    for (let k = 0; k < nCover[i]! && !painted[i]; k++) {
      validity(zones[cover[i * K + k]!]!, x, y, vc);
      if (vc[0]! > 0.25) painted[i] = 1;
    }
  }
  const dClaim = chamfer(painted, W, H, CELL_YARDS), dOcean = chamfer(ocean, W, H, CELL_YARDS);
  // `covered`: cells of an ADT that has a native minimap tile. The map page draws the minimap
  // at full strength wherever the art is clear, so the backdrop is opaque over all of them and
  // fades out over seaFade beyond: unused ground there is parchment (the zone maps paint
  // Outland's void that way too), anything else sea. `coverage` is that opacity, kept unblurred
  // so it is exactly 1 on every covered cell.
  const covered = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const gr = cr0 + Math.floor(i / W), gc = cc0 + (i % W);
    covered[i] = minimapAdts.has(Math.floor(gr / CELLS) * GRID + Math.floor(gc / CELLS)) ? 1 : 0;
  }
  const dCover = chamfer(covered, W, H, CELL_YARDS), coverage = new Float32Array(N);
  // held at 1 for one cell past the covered set, so the bilinear read is exactly 1 on every covered pixel
  for (let i = 0; i < N; i++) coverage[i] = 1 - smooth((dCover[i]! - CELL_YARDS * Math.SQRT2) / P.seaFade);
  // `nearSea`: cells the sea may cover — ocean, and anything unclaimed within reach of ocean.
  // Off the terrain, ground opacity follows the distance from zone land (and the minimap's
  // coverage) alone, so it is edged by those and never by where the ADTs stop.
  const seaWide = P.seaReach + P.seaFade + 3 * TILE_SIZE;
  const landF = new Float32Array(N), groundRaw = new Float32Array(N), visible = new Uint8Array(N), nearSea = new Uint8Array(N), groundish = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    landF[i] = land[i]!;
    nearSea[i] = ocean[i] || (!painted[i] && dOcean[i]! <= seaWide) ? 1 : 0;
    groundish[i] = present[i] ? ground[i]! : nearSea[i] ? 0 : 1;
    const near = groundish[i] ? 1 - smooth((dClaim[i]! - P.gapReach) / P.gapFade) : 0;
    groundRaw[i] = groundish[i] ? Math.max(near, coverage[i]!) : 0;
    // the coast the sea is measured from: ground near zones, and real terrain under the coverage
    // (a covered tile with no terrain behind it is filled, but is not a coast)
    visible[i] = near >= 0.5 || (groundish[i] && present[i] && covered[i]) ? 1 : 0;
  }
  const shore = chamfer(visible, W, H, CELL_YARDS);
  const seaRaw = new Float32Array(N), deepRaw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const nearCoast = nearSea[i] ? 1 - smooth((shore[i]! - P.seaReach) / P.seaFade) : 0;
    seaRaw[i] = (1 - groundRaw[i]!) * (groundish[i] ? nearCoast : Math.max(nearCoast, coverage[i]!));
    deepRaw[i] = 1 - 0.15 * smooth(shore[i]! / 2500);
  }
  const claimable = gaussBlur(landF, W, H, 1.5), groundness = gaussBlur(groundRaw, W, H, 1.5), reach = gaussBlur(reachRaw, W, H, 1.5);
  // blurred wide, so the crease where two coasts' distances meet (mid-channel) draws no line
  const seaOpacity = gaussBlur(seaRaw, W, H, 6), seaDepth = gaussBlur(deepRaw, W, H, 6);

  // Measure the palette from the art itself.
  const ring = [0, 0, 0], waterS: number[][] = [[], [], []];
  let ringN = 0, ringL = 0, ringL2 = 0;
  for (const z of zones) {
    for (let v = 0; v < ART_H; v += 3) {
      for (let u = 0; u < ART_W; u += 3) {
        if (frameDist(u, v) < P.frameFeather) continue;
        const s = (v * ART_W + u) * 4, rr = z.art.rgba[s]!, gg = z.art.rgba[s + 1]!, bb = z.art.rgba[s + 2]!;
        // paper: each zone's ring — the painted border mountains around its interior
        const d = z.ownDist === null ? -1 : z.ownDist[v * ART_W + u]!;
        if (d >= 15 && d <= P.ownLand) {
          ring[0]! += rr; ring[1]! += gg; ring[2]! += bb; ringN++;
          const l = luma(rr, gg, bb); ringL += l; ringL2 += l * l;
        }
        // water: cool pixels (blue at least 0.8 of red; parchment is far warmer) over cells
        // the server says are sea or lake
        if (bb < 0.8 * rr) continue;
        const x = z.area.top - ((v + 0.5) / ART_H) * (z.area.top - z.area.bottom);
        const y = z.area.left - ((u + 0.5) / ART_W) * (z.area.left - z.area.right);
        const gr = Math.floor((32 - x / TILE_SIZE) * CELLS) - cr0, gc = Math.floor((32 - y / TILE_SIZE) * CELLS) - cc0;
        if (gr < 0 || gc < 0 || gr >= H || gc >= W) continue;
        const i = gr * W + gc;
        if (!present[i] || !(liquid[i]! & (LIQUID_OCEAN | LIQUID_WATER))) continue;
        waterS[0]!.push(rr); waterS[1]!.push(gg); waterS[2]!.push(bb);
      }
    }
  }
  // the minimap ground, for grading the gap fill: per tile, the pixels and a coarse
  // "is this textured" map (luma spread over 8px blocks — the minimap's untextured fill is flat)
  interface Ground { rgba: Pixels; tex: Float32Array }
  const groundCache = new Map<number, Ground | null>();
  const groundTile = (r: number, c: number): Ground | null => {
    const key = r * GRID + c;
    let g = groundCache.get(key);
    if (g !== undefined) return g;
    const t = r >= 0 && c >= 0 && r < GRID && c < GRID ? src.minimap(mapId, r, c) : null;
    if (t === null) { groundCache.set(key, null); return null; }
    const B = TILE_PX / 8, tex = new Float32Array(B * B);
    for (let by = 0; by < B; by++) {
      for (let bx = 0; bx < B; bx++) {
        let s1 = 0, s2 = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const q = ((by * 8 + y) * TILE_PX + bx * 8 + x) * 4, l = luma(t[q]!, t[q + 1]!, t[q + 2]!);
          s1 += l; s2 += l * l;
        }
        tex[by * B + bx] = smooth((Math.sqrt(Math.max(0, s2 / 64 - (s1 / 64) ** 2)) - 1) / 4);
      }
    }
    g = { rgba: t, tex };
    groundCache.set(key, g);
    return g;
  };
  let gN = 0, gL = 0, gL2 = 0;
  for (let i = 0; i < N; i += 3) {
    if (!ground[i] || !present[i]) continue;
    const gr = cr0 + Math.floor(i / W), gc = cc0 + (i % W);
    const g = groundTile(Math.floor(gr / CELLS), Math.floor(gc / CELLS));
    if (g === null) continue;
    const bx = (gc % CELLS) * 2, by = (gr % CELLS) * 2;
    if (g.tex[by * (TILE_PX / 8) + bx]! < 0.5) continue;
    const q = ((by * 8 + 4) * TILE_PX + bx * 8 + 4) * 4;
    const l = luma(g.rgba[q]!, g.rgba[q + 1]!, g.rgba[q + 2]!);
    gN++; gL += l; gL2 += l * l;
  }
  // unmeasurable (no zone here has overlays): a neutral grey, never a guess at the art's palette
  const paper: [number, number, number] = ringN ? [ring[0]! / ringN, ring[1]! / ringN, ring[2]! / ringN] : [128, 128, 128];
  const ringMean = ringN ? ringL / ringN : luma(...paper);
  const paperRelStd = ringN ? Math.sqrt(Math.max(0, ringL2 / ringN - ringMean * ringMean)) / ringMean : 0.15;
  const water: [number, number, number] = waterS[0]!.length ? [median(waterS[0]!), median(waterS[1]!), median(waterS[2]!)] : [128, 128, 128];
  const groundMean = gN ? gL / gN : 100, groundStd = gN ? Math.sqrt(Math.max(1, gL2 / gN - groundMean * groundMean)) : 30;
  const measured: Measured = { paper, paperRelStd, water, groundMean, groundStd };
  const paperL = luma(...paper);

  // Composite the z1 tiles.
  const tiles = new Map<string, Pixels>();
  const col = new Float32Array(3), vv = new Float32Array(2);
  const cz = new Int16Array(K), cvl = new Float32Array(K), cvs = new Float32Array(K), cw = new Float32Array(K);
  const B = TILE_PX / 8;
  const gamma = P.sharpen;
  const z1r0 = Math.floor(cr0 / CELLS / 2), z1r1 = Math.floor((cr1 - 1) / CELLS / 2);
  const z1c0 = Math.floor(cc0 / CELLS / 2), z1c1 = Math.floor((cc1 - 1) / CELLS / 2);
  for (let R = z1r0; R <= z1r1; R++) {
    for (let C = z1c0; C <= z1c1; C++) {
      const px = new Uint8Array(TILE_PX * TILE_PX * 4);
      let opaque = false;
      for (let py = 0; py < TILE_PX; py++) {
        const tRow = 2 * R + (py + 0.5) / ART_PPA, x = (32 - tRow) * TILE_SIZE;
        const fy = tRow * CELLS - cr0 - 0.5;
        if (fy < -1 || fy > H) continue;
        for (let pxx = 0; pxx < TILE_PX; pxx++) {
          const tCol = 2 * C + (pxx + 0.5) / ART_PPA, y = (32 - tCol) * TILE_SIZE;
          const fx = tCol * CELLS - cc0 - 0.5;
          if (fx < -1 || fx > W) continue;
          const ci = Math.max(0, Math.min(H - 1, Math.floor(fy))) * W + Math.max(0, Math.min(W - 1, Math.floor(fx)));

          // the zones whose art is here, and how far each can be trusted
          let n = 0, alt = 0, strength = 0;
          for (let k = 0; k < nCover[ci]!; k++) {
            const zi = cover[ci * K + k]!;
            validity(zones[zi]!, x, y, vv);
            if (vv[0]! <= 0 && vv[1]! <= 0) continue;
            cz[n] = zi; cvl[n] = vv[0]!; cvs[n] = vv[1]!; cw[n] = 0;
            alt += vv[0]! ** 4;
            if (vv[0]! > strength) strength = vv[0]!;
            n++;
          }
          // territory shares, blurred at cell scale and sharpened across zones so a
          // boundary is a smooth curve rather than the raster's 33-yard staircase
          let sumG = 0, sumT = 0, painted = 0, ownLandPaint = 0;
          const nc = nCand[ci]!;
          for (let k = 0; k < nc; k++) {
            const F = fields[cand[ci * K + k]!]!;
            const t = Math.max(0, bilinear(F.f, F.w, F.h, fy - F.r0, fx - F.c0));
            sumT += t; sumG += t ** gamma;
          }
          const none = Math.max(0, 1 - sumT);
          sumG += none ** gamma;
          const Lc = bilinear(claimable, W, H, fy, fx), rch = bilinear(reach, W, H, fy, fx);
          if (n > 0 && sumG > 0) {
            for (let k = 0; k < nc; k++) {
              const F = fields[cand[ci * K + k]!]!;
              let j = -1;
              for (let q = 0; q < n; q++) if (cz[q] === F.zi) { j = q; break; }
              if (j < 0) continue;
              const t = Math.max(0, bilinear(F.f, F.w, F.h, fy - F.r0, fx - F.c0));
              const share = t ** gamma / sumG;
              const w = share * (Lc * cvl[j]! + (1 - Lc) * cvs[j]! * rch);
              cw[j]! += w; painted += w; ownLandPaint += share * cvl[j]!;
            }
            // land its own zone cannot paint goes to the zones that can, by validity^4
            const rest = Lc * Math.max(0, 1 - ownLandPaint);
            if (rest > 0 && alt > 0) {
              for (let q = 0; q < n; q++) {
                const w = rest * (cvl[q]! ** 4 / alt) * strength;
                cw[q]! += w; painted += w;
              }
            }
          }
          const tot = Math.min(1, painted);
          const Lg = bilinear(groundness, W, H, fy, fx);
          const seaAlpha = bilinear(seaOpacity, W, H, fy, fx);
          // Lg is the ground's opacity: 1 on ground near zones or under the minimap's coverage,
          // fading to 0 on far unused terrain. Under the coverage the backdrop is opaque whatever
          // the blurred fields say.
          const wGround = Lg, wSea = (1 - Lg) * seaAlpha;
          const back = (1 - tot) * Math.min(1, Math.max(wGround + wSea, bilinear(coverage, W, H, fy, fx)));
          const alpha = tot + back;
          if (alpha < 0.5 / 255) continue;

          let r = 0, g = 0, b = 0;
          const norm = painted > 1 ? 1 / painted : 1;
          for (let q = 0; q < n; q++) {
            if (cw[q]! <= 0) continue;
            const z = zones[cz[q]!]!, { u, v } = worldToArt(z.area, x, y);
            sample(z.mip, u * z.mipScale, v * z.mipScale, col);
            const w = cw[q]! * norm;
            r += w * col[0]!; g += w * col[1]!; b += w * col[2]!;
          }
          if (back > 0) {
            const grain = 1 + 0.07 * (vnoise(x / 900, y / 900, 3) - 0.5) + 0.05 * (vnoise(x / 160, y / 160, 5) - 0.5) + 0.04 * (hash(Math.floor(x / 4.2), Math.floor(y / 4.2), 9) - 0.5);
            // sea: the art's own water colour, a shade deeper offshore
            const deep = bilinear(seaDepth, W, H, fy, fx);
            const sr = water[0] * deep * grain, sg = water[1] * deep * grain, sb = water[2] * deep * grain;
            // land no zone paints: parchment, shaded by the minimap's ground where it is textured
            let lr = paper[0] * grain, lg = paper[1] * grain, lb = paper[2] * grain;
            if (Lg > 0 && P.gap === "minimap") {
              const gt = groundTile(Math.floor(tRow), Math.floor(tCol));
              if (gt !== null) {
                const ux = (tCol - Math.floor(tCol)) * TILE_PX, uy = (tRow - Math.floor(tRow)) * TILE_PX;
                const sx = Math.min(TILE_PX - 2, Math.floor(ux)) & ~1, sy = Math.min(TILE_PX - 2, Math.floor(uy)) & ~1;
                let mr = 0, mg = 0, mb = 0;
                for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                  const q = ((sy + dy) * TILE_PX + sx + dx) * 4;
                  mr += gt.rgba[q]!; mg += gt.rgba[q + 1]!; mb += gt.rgba[q + 2]!;
                }
                mr /= 4; mg /= 4; mb /= 4;
                const textured = bilinear(gt.tex, B, B, uy / 8 - 0.5, ux / 8 - 0.5);
                const l = luma(mr, mg, mb);
                const shade = 1 + textured * Math.max(-2.5, Math.min(2.5, (l - groundMean) / groundStd)) * paperRelStd;
                const kappa = 0.15 * textured, hue = (paperL * shade) / Math.max(8, l);
                lr = paper[0] * shade * grain * (1 - kappa) + mr * hue * kappa;
                lg = paper[1] * shade * grain * (1 - kappa) + mg * hue * kappa;
                lb = paper[2] * shade * grain * (1 - kappa) + mb * hue * kappa;
              }
            }
            const den = wGround + wSea;
            const kg = den > 1e-4 ? wGround / den : 0, ks = den > 1e-4 ? wSea / den : 1;
            r += back * (kg * lr + ks * sr);
            g += back * (kg * lg + ks * sg);
            b += back * (kg * lb + ks * sb);
          }
          const a8 = Math.round(Math.min(1, alpha) * 255);
          if (a8 === 0) continue;
          const d = (py * TILE_PX + pxx) * 4;
          px[d] = Math.max(0, Math.min(255, Math.round(r / alpha)));
          px[d + 1] = Math.max(0, Math.min(255, Math.round(g / alpha)));
          px[d + 2] = Math.max(0, Math.min(255, Math.round(b / alpha)));
          px[d + 3] = a8;
          opaque = true;
        }
      }
      if (opaque) tiles.set(`${R}_${C}`, px);
    }
  }
  return { tiles, measured, zones: zones.map((z) => z.area.name) };
}

// ---------------------------------------------------------------- pyramid and files

export interface ArtLevelStats {
  z: number;
  written: number;
  skipped: number;
  removed: number;
  bytes: number;
}

/**
 * Write z1 and every level above it (an alpha-weighted 2x2 box filter of the
 * one below, `downsampleQuad`) under `mapDir`. Existing files are skipped
 * unless `force`; every level is computed either way.
 */
export function writeArtPyramid(mapDir: string, z1: Map<string, Pixels>, opts: { force: boolean }): ArtLevelStats[] {
  const stats: ArtLevelStats[] = [];
  let level = z1;
  for (let z = 1; z <= LOD_MAX; z++) {
    if (z > 1) {
      const prev = level;
      const parents = new Map<string, [number, number]>();
      for (const key of prev.keys()) {
        const [r, c] = key.split("_").map(Number) as [number, number];
        parents.set(`${r >> 1}_${c >> 1}`, [r >> 1, c >> 1]);
      }
      level = new Map();
      for (const [r, c] of [...parents.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
        const kid = (rr: number, cc: number) => prev.get(`${rr}_${cc}`) ?? null;
        const out = downsampleQuad([kid(2 * r, 2 * c), kid(2 * r, 2 * c + 1), kid(2 * r + 1, 2 * c), kid(2 * r + 1, 2 * c + 1)]);
        if (out !== null) level.set(`${r}_${c}`, out);
      }
    }
    const s: ArtLevelStats = { z, written: 0, skipped: 0, removed: 0, bytes: 0 };
    // a forced re-bake also drops tiles this bake no longer has content for
    if (opts.force) {
      const dir = join(mapDir, dirname(lodTileName(ART_LAYER, z, 0, 0)));
      if (existsSync(dir)) {
        for (const name of readdirSync(dir).sort()) {
          const m = /^(\d+)_(\d+)\.png$/.exec(name);
          if (m === null || level.has(`${Number(m[1])}_${Number(m[2])}`)) continue;
          unlinkSync(join(dir, name));
          s.removed++;
        }
      }
    }
    const keys = [...level.keys()].map((k) => k.split("_").map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [r, c] of keys) {
      const file = join(mapDir, lodTileName(ART_LAYER, z, r, c));
      if (!opts.force && existsSync(file)) {
        s.skipped++;
        s.bytes += statSync(file).size;
        continue;
      }
      const png = encodePng(level.get(`${r}_${c}`)!, TILE_PX, TILE_PX);
      writeTile(file, png);
      s.written++;
      s.bytes += png.byteLength;
    }
    stats.push(s);
  }
  return stats;
}

// ---------------------------------------------------------------- CLI

/** Client load order for the art, lowest priority first: locale archives sit between base and patches. */
export function artArchiveOrder(locale: string): string[] {
  return [
    "common.MPQ", "common-2.MPQ", "expansion.MPQ", "lichking.MPQ",
    `${locale}/locale-${locale}.MPQ`, `${locale}/expansion-locale-${locale}.MPQ`, `${locale}/lichking-locale-${locale}.MPQ`,
    "patch.MPQ", "patch-2.MPQ", "patch-3.MPQ",
    `${locale}/patch-${locale}.MPQ`, `${locale}/patch-${locale}-2.MPQ`, `${locale}/patch-${locale}-3.MPQ`,
  ];
}

interface Options {
  data: string;
  client: string | null;
  out: string | null;
  locale: string;
  maps: number[];
  force: boolean;
  params: ArtParams;
}

function parseArgs(argv: string[]): Options {
  const repo = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const o: Options = { data: join(repo, "data"), client: null, out: null, locale: "enUS", maps: [0, 1, 530, 571], force: false, params: { ...DEFAULT_PARAMS } };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = argv[i + 1];
    if (arg === "--force") o.force = true;
    else if (arg === "--cities") o.params.cities = true;
    else if (arg === "--map" && next) { o.maps = next.split(",").map(Number).filter((n) => Number.isSafeInteger(n) && n >= 0); i++; }
    else if (arg === "--data" && next) { o.data = next; i++; }
    else if (arg === "--client" && next) { o.client = next; i++; }
    else if (arg === "--out" && next) { o.out = next; i++; }
    else if (arg === "--locale" && next) { o.locale = next; i++; }
    else if (arg === "--gap" && (next === "minimap" || next === "paper")) { o.params.gap = next; i++; }
    else {
      console.error(`bake-art: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return o;
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));
  const client = o.client ?? join(o.data, "client-source", "Data");
  const dbcDir = join(o.data, "client", "dbc"), mapsDir = join(o.data, "client", "maps"), root = o.out ?? join(o.data, "minimap");
  const archives = artArchiveOrder(o.locale).map((n) => join(client, n)).filter((p) => existsSync(p));
  if (archives.length === 0) { console.error(`bake-art: no client archives under ${client}`); process.exit(1); }
  for (const need of [dbcDir, mapsDir, root]) if (!existsSync(need)) { console.error(`bake-art: missing ${need}`); process.exit(1); }
  const chain = MpqChain.open(archives);
  const src: ArtSources = {
    read: (p) => chain.read(p),
    areas: readWorldMapAreas(new Uint8Array(readFileSync(join(dbcDir, "WorldMapArea.dbc")))),
    overlays: readOverlays(new Uint8Array(readFileSync(join(dbcDir, "WorldMapOverlay.dbc")))),
    areaTable: readAreaTable(new Uint8Array(readFileSync(join(dbcDir, "AreaTable.dbc")))),
    mapFile: (m, r, c) => {
      const f = join(mapsDir, mapFileName(m, r, c));
      return existsSync(f) ? new Uint8Array(readFileSync(f)) : undefined;
    },
    hasMinimap: (m, r, c) => existsSync(join(root, String(m), `${r}_${c}.png`)),
    minimap: (m, r, c) => {
      const f = join(root, String(m), `${r}_${c}.png`);
      if (!existsSync(f)) return null;
      const img = decodePng(new Uint8Array(readFileSync(f)));
      return img.width === TILE_PX && img.height === TILE_PX ? img.rgba : null;
    },
  };
  const mib = (b: number) => (b / 1024 / 1024).toFixed(2);
  for (const map of o.maps) {
    const t0 = performance.now();
    const res = renderArt(map, src, o.params, (s) => console.log(s));
    const t1 = performance.now();
    const m = res.measured;
    console.log(`map ${map}: ${res.zones.length} zones, ${res.tiles.size} z1 tiles in ${((t1 - t0) / 1000).toFixed(1)} s` +
      (m ? `; paper ${m.paper.map(Math.round)} ±${m.paperRelStd.toFixed(2)}, water ${m.water.map(Math.round)}, ground ${m.groundMean.toFixed(0)}±${m.groundStd.toFixed(0)}` : ""));
    const stats = writeArtPyramid(join(root, String(map)), res.tiles, { force: o.force });
    let bytes = 0;
    for (const s of stats) { console.log(`map ${map} art z${s.z}: ${s.written} written, ${s.skipped} skipped, ${s.removed} removed, ${mib(s.bytes)} MiB`); bytes += s.bytes; }
    console.log(`map ${map}: ${mib(bytes)} MiB, ${((performance.now() - t0) / 1000).toFixed(1)} s total`);
  }
  chain.close();
}

if (import.meta.main) main();
