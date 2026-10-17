/**
 * The painted world map, one zone at a time: which WorldMapArea rows exist,
 * where each one's art sits in the world, the art itself (base tiles plus
 * every overlay, fully revealed) and the part of it the zone painted as its
 * own. The art bake (`artbake.ts`) stitches these; the evidence for every
 * rule here is in `minimap/README.md` ("The painted map").
 */

import { decodeBlp } from "./blp";
import { parseWdbc } from "./dbc";

/**
 * A zone map is 1024×768 of BLP tiles (4×3 of 256), of which the top-left
 * 1002×668 is the picture and the rest padding. Both axes come out at the same
 * yards per pixel for every WorldMapArea rect, which is how the crop was found.
 */
export const ART_W = 1002;
export const ART_H = 668;
const CANVAS_W = 1024;
const CANVAS_H = 768;

/** One WorldMapArea row: a zone or continent map and the world rect its art covers. */
export interface MapArea {
  id: number;
  mapId: number;
  /** The zone's AreaTable id; 0 for a continent. */
  areaId: number;
  /** Internal name: the directory and file stem under `Interface\WorldMap\`. */
  name: string;
  /** World Y (west) at the art's left and right edges. */
  left: number;
  right: number;
  /** World X (north) at the art's top and bottom edges. */
  top: number;
  bottom: number;
}

export interface Overlay {
  mapAreaId: number;
  texture: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

export interface AreaRow {
  id: number;
  mapId: number;
  parent: number;
  flags: number;
}

/** AreaTable flag on the capital cities. */
export const AREA_CAPITAL = 0x100;

function f32(u: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setUint32(0, u, true);
  return b.getFloat32(0, true);
}

/** WorldMapArea.dbc: id, map, area, name, left, right, top, bottom, ... */
export function readWorldMapAreas(dbc: Uint8Array): MapArea[] {
  const d = parseWdbc(dbc);
  const out: MapArea[] = [];
  for (let r = 0; r < d.recordCount; r++) {
    out.push({
      id: d.u32(r, 0),
      mapId: d.u32(r, 1),
      areaId: d.u32(r, 2),
      name: d.str(r, 3),
      left: f32(d.u32(r, 4)),
      right: f32(d.u32(r, 5)),
      top: f32(d.u32(r, 6)),
      bottom: f32(d.u32(r, 7)),
    });
  }
  return out;
}

/** WorldMapOverlay.dbc: id, map area, 4 area ids, map point, texture, w, h, x, y, ... */
export function readOverlays(dbc: Uint8Array): Overlay[] {
  const d = parseWdbc(dbc);
  const out: Overlay[] = [];
  for (let r = 0; r < d.recordCount; r++) {
    const texture = d.str(r, 8);
    if (!texture) continue;
    out.push({
      mapAreaId: d.u32(r, 1),
      texture,
      width: d.u32(r, 9),
      height: d.u32(r, 10),
      offsetX: d.u32(r, 11),
      offsetY: d.u32(r, 12),
    });
  }
  return out;
}

/** AreaTable.dbc: id, map, parent, explore bit, flags, ... */
export function readAreaTable(dbc: Uint8Array): Map<number, AreaRow> {
  const d = parseWdbc(dbc);
  const out = new Map<number, AreaRow>();
  for (let r = 0; r < d.recordCount; r++) {
    const id = d.u32(r, 0);
    out.set(id, { id, mapId: d.u32(r, 1), parent: d.u32(r, 2), flags: d.u32(r, 4) });
  }
  return out;
}

/**
 * The zone an area belongs to: AreaTable parents walked to the root, which is
 * the id WorldMapArea.areaId uses. Memoised; a cycle or a missing row stops
 * the walk where it is.
 */
export function zoneResolver(areas: Map<number, AreaRow>): (areaId: number) => number {
  const memo = new Map<number, number>();
  return (areaId) => {
    const hit = memo.get(areaId);
    if (hit !== undefined) return hit;
    let cur = areaId;
    for (let i = 0; i < 16; i++) {
      const a = areas.get(cur);
      if (a === undefined || a.parent === 0 || a.parent === cur) break;
      cur = a.parent;
    }
    memo.set(areaId, cur);
    return cur;
  };
}

/** World position (X north, Y west) to a pixel of the area's 1002×668 art. */
export function worldToArt(a: MapArea, x: number, y: number): { u: number; v: number } {
  return {
    u: ((a.left - y) / (a.left - a.right)) * ART_W,
    v: ((a.top - x) / (a.top - a.bottom)) * ART_H,
  };
}

/** Float RGBA art, `ART_W × ART_H`, and the zone's own painted interior. */
export interface ZoneArt {
  rgba: Float32Array;
  /**
   * 1 where the zone painted its own ground, 0 elsewhere; null for a zone
   * with no overlays (the cities).
   */
  own: Uint8Array | null;
}

/**
 * Composite one zone's map: the twelve base tiles `<name>1..12.blp`, then every
 * overlay piece (`<texture>1..n.blp`, rows of 256) at its offset, fully
 * revealed. Returns null if any base tile is missing.
 */
export function composeZoneArt(
  read: (path: string) => Uint8Array | undefined,
  area: MapArea,
  overlays: readonly Overlay[],
): ZoneArt | null {
  const W = CANVAS_W, H = CANVAS_H;
  const buf = new Float32Array(W * H * 4);
  const alpha = new Float32Array(W * H);
  const dir = `Interface\\WorldMap\\${area.name}\\`;
  const blit = (img: { width: number; height: number; rgba: Uint8Array }, dx: number, dy: number, cw: number, ch: number, mark: boolean) => {
    for (let y = 0; y < Math.min(ch, img.height); y++) {
      for (let x = 0; x < Math.min(cw, img.width); x++) {
        const X = dx + x, Y = dy + y;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const s = (y * img.width + x) * 4, d = Y * W + X;
        const a = (img.rgba[s + 3] as number) / 255;
        for (let k = 0; k < 3; k++) buf[d * 4 + k] = (img.rgba[s + k] as number) * a + (buf[d * 4 + k] as number) * (1 - a);
        buf[d * 4 + 3] = Math.max(buf[d * 4 + 3] as number, img.rgba[s + 3] as number);
        if (mark) alpha[d] = Math.max(alpha[d] as number, a);
      }
    }
  };
  for (let i = 0; i < 12; i++) {
    const data = read(`${dir}${area.name}${i + 1}.blp`);
    if (data === undefined) return null;
    blit(decodeBlp(data), (i % 4) * 256, Math.floor(i / 4) * 256, 256, 256, false);
  }
  const base = buf.slice();
  let pieces = 0;
  for (const o of overlays) {
    if (o.mapAreaId !== area.id) continue;
    const cols = Math.ceil(o.width / 256), rows = Math.ceil(o.height / 256);
    let k = 1;
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++, k++) {
        const data = read(`${dir}${o.texture}${k}.blp`);
        if (data === undefined) continue;
        blit(decodeBlp(data), o.offsetX + cx * 256, o.offsetY + ry * 256, Math.min(256, o.width - cx * 256), Math.min(256, o.height - ry * 256), true);
        pieces++;
      }
    }
  }
  const rgba = new Float32Array(ART_W * ART_H * 4);
  for (let y = 0; y < ART_H; y++) rgba.set(buf.subarray(y * W * 4, (y * W + ART_W) * 4), y * ART_W * 4);
  if (pieces === 0) return { rgba, own: null };
  const crop = (src: Float32Array, ch: number) => {
    const out = new Float32Array(ART_W * ART_H * ch);
    for (let y = 0; y < ART_H; y++) out.set(src.subarray(y * W * ch, (y * W + ART_W) * ch), y * ART_W * ch);
    return out;
  };
  return { rgba, own: ownMask(rgba, crop(base, 4), crop(alpha, 1), ART_W, ART_H) };
}

/**
 * The zone's own painted interior. The base tiles leave a zone's inside blank
 * parchment and the overlays paint it in, so "under an opaque overlay piece"
 * is close — but the Burning Crusade zones' overlays are large blocks that
 * repaint margins and the neighbours' baked labels unchanged. So a pixel is
 * own only where an overlay is opaque (alpha >= 0.5) *and* changed the base
 * (some channel by more than `threshold`). A box mean of radius `r`
 * thresholded at a half then drops specks and fills pinholes.
 */
export function ownMask(full: Float32Array, base: Float32Array, alpha: Float32Array, w: number, h: number, threshold = 18, r = 4): Uint8Array {
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if ((alpha[i] as number) < 0.5) continue;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs((full[i * 4 + k] as number) - (base[i * 4 + k] as number)));
    if (d > threshold) raw[i] = 1;
  }
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += raw[y * w + Math.min(w - 1, Math.max(0, x))] as number;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc;
      acc += (raw[y * w + Math.min(w - 1, x + r + 1)] as number) - (raw[y * w + Math.max(0, x - r)] as number);
    }
  }
  const out = new Uint8Array(w * h);
  const n = (2 * r + 1) * (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x] as number;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n >= 0.5 ? 1 : 0;
      acc += (tmp[Math.min(h - 1, y + r + 1) * w + x] as number) - (tmp[Math.max(0, y - r) * w + x] as number);
    }
  }
  return out;
}

/** Two-pass chamfer distance (1, √2) from every pixel where `mask` is set. */
export function distanceFrom(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : 1e9;
  const relax = (i: number, j: number, c: number) => {
    const nd = (d[j] as number) + c;
    if (nd < (d[i] as number)) d[i] = nd;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) {
        relax(i, i - w, 1);
        if (x > 0) relax(i, i - w - 1, Math.SQRT2);
        if (x < w - 1) relax(i, i - w + 1, Math.SQRT2);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, 1);
      if (y < h - 1) {
        relax(i, i + w, 1);
        if (x < w - 1) relax(i, i + w + 1, Math.SQRT2);
        if (x > 0) relax(i, i + w - 1, Math.SQRT2);
      }
    }
  }
  return d;
}
