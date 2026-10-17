/**
 * The painted map: placement, the zone's own mask, and a whole bake over a
 * synthetic world — two zones side by side on a strip of land with ocean
 * south of it. Every texture, table and terrain file is built here; nothing
 * is read from `data/`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ART_LAYER, LOD_MAX, TILE_SIZE, lodTileName } from "../../runner/viewer/worldmap";
import { type ArtParams, type ArtSources, DEFAULT_PARAMS, renderArt, writeArtPyramid } from "../src/artbake";
import { LIQUID_OCEAN } from "../src/mapfile";
import { decodePng } from "../src/png";
import {
  ART_H,
  ART_W,
  type AreaRow,
  type MapArea,
  type Overlay,
  composeZoneArt,
  ownMask,
  readWorldMapAreas,
  worldToArt,
  zoneResolver,
} from "../src/zoneart";
import { buildRawBlp, buildWdbc, mapBytes } from "./fixtures";

const scratch = mkdtempSync(join(tmpdir(), "wrathbench-art-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Rgb = [number, number, number];
const f32bits = (f: number): number => {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, f, true);
  return v.getUint32(0, true);
};

describe("placement", () => {
  const rect: MapArea = { id: 1, mapId: 0, areaId: 1, name: "Z", left: 1500, right: -3000, top: -4000, bottom: -7000 };

  test("the rect's corners are the art's corners: left/right are world Y, top/bottom world X", () => {
    expect(worldToArt(rect, rect.top, rect.left)).toEqual({ u: 0, v: 0 });
    const br = worldToArt(rect, rect.bottom, rect.right);
    expect(br.u).toBeCloseTo(ART_W, 6);
    expect(br.v).toBeCloseTo(ART_H, 6);
  });

  test("north is up and east is right: smaller X is lower, smaller Y is further right", () => {
    const a = worldToArt(rect, -5000, 0), south = worldToArt(rect, -6000, 0), east = worldToArt(rect, -5000, -1000);
    expect(south.v).toBeGreaterThan(a.v);
    expect(east.u).toBeGreaterThan(a.u);
  });

  test("WorldMapArea rows read their four floats as left, right, top, bottom", () => {
    const strings = ["Zed"];
    const dbc = buildWdbc([[7, 0, 12, 1, f32bits(1500), f32bits(-3000), f32bits(-4000), f32bits(-7000), 0xffffffff, 0, 0]], strings, 11);
    const [a] = readWorldMapAreas(dbc);
    expect(a!.name).toBe("Zed");
    expect([a!.left, a!.right, a!.top, a!.bottom]).toEqual([1500, -3000, -4000, -7000]);
  });

  test("an area resolves to its root zone through any depth of parents, and a cycle stops", () => {
    const rows = new Map<number, AreaRow>([
      [1, { id: 1, mapId: 0, parent: 0, flags: 0 }],
      [2, { id: 2, mapId: 0, parent: 1, flags: 0 }],
      [3, { id: 3, mapId: 0, parent: 2, flags: 0 }],
      [8, { id: 8, mapId: 0, parent: 9, flags: 0 }],
      [9, { id: 9, mapId: 0, parent: 8, flags: 0 }],
    ]);
    const zoneOf = zoneResolver(rows);
    expect(zoneOf(3)).toBe(1);
    expect(zoneOf(1)).toBe(1);
    expect([8, 9]).toContain(zoneOf(8));
  });
});

describe("ownMask", () => {
  const w = 40, h = 20;
  const plane = (fill: (x: number, y: number) => number[]) => {
    const out = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(fill(x, y), (y * w + x) * 4);
    return out;
  };

  test("own is where an opaque overlay changed the base — not where it repaints the base unchanged", () => {
    const base = plane(() => [200, 160, 100, 255]);
    // overlay over x < 30: it paints x < 15 red and repaints 15..29 with the base colour
    const full = plane((x) => (x < 15 ? [220, 40, 40, 255] : [200, 160, 100, 255]));
    const alpha = new Float32Array(w * h).map((_, i) => ((i % w) < 30 ? 1 : 0));
    const own = ownMask(full, base, alpha, w, h, 18, 2);
    expect(own[10 * w + 5]).toBe(1);
    expect(own[10 * w + 22]).toBe(0);
    expect(own[10 * w + 35]).toBe(0);
  });

  test("a speck of change is dropped", () => {
    const base = plane(() => [200, 160, 100, 255]);
    const full = plane((x, y) => (x === 20 && y === 10 ? [0, 0, 0, 255] : [200, 160, 100, 255]));
    const alpha = new Float32Array(w * h).fill(1);
    expect(ownMask(full, base, alpha, w, h, 18, 2).every((v) => v === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- a synthetic world

const PARCHMENT: Rgb = [200, 160, 100];
const FRAME: Rgb = [0, 255, 0];
const LABEL: Rgb = [255, 0, 255];
const WATER: Rgb = [90, 110, 140];
const RED: Rgb = [220, 40, 40];
const YELLOW: Rgb = [230, 200, 30];
const MAP = 7;

/**
 * Land on ADT rows 32-33, cols 32-35: zone A (area 100, with a subzone 101 on
 * one ADT) owns cols 32-33 and zone B (area 200) cols 34-35. Row 34 is ocean.
 * Each zone's map is a 2400 x 1600 yard rect with a green frame, parchment,
 * water south of the coast, and an overlay painting its interior. Zone A also
 * bakes a magenta "neighbour label" on parchment inside its own territory but
 * far from its overlay — the case the own mask exists for.
 */
function world(): ArtSources {
  const files = new Map<string, Uint8Array>();
  const areas: MapArea[] = [
    { id: 1, mapId: MAP, areaId: 100, name: "ZoneA", left: 600, right: -1800, top: 300, bottom: -1300 },
    { id: 2, mapId: MAP, areaId: 200, name: "ZoneB", left: -466, right: -2866, top: 300, bottom: -1300 },
  ];
  const overlays: Overlay[] = [
    { mapAreaId: 1, texture: "AInside", width: 250, height: 445, offsetX: 250, offsetY: 125 },
    { mapAreaId: 2, texture: "BInside", width: 446, height: 445, offsetX: 250, offsetY: 125 },
  ];
  const coastV = ((300 + 2 * TILE_SIZE) / 1600) * ART_H; // art row of world X = -1066.7
  for (const [a, o, colour] of [[areas[0]!, overlays[0]!, RED], [areas[1]!, overlays[1]!, YELLOW]] as const) {
    const canvas = new Uint8Array(1024 * 768 * 4);
    for (let y = 0; y < 768; y++) {
      for (let x = 0; x < 1024; x++) {
        let c: Rgb = y >= coastV ? WATER : PARCHMENT;
        if (a.id === 1 && x >= 640 && x < 690 && y >= 300 && y < 330) c = LABEL;
        if (x < 10 || y < 10 || x >= ART_W - 10 || y >= ART_H - 26) c = FRAME;
        const i = (y * 1024 + x) * 4;
        canvas[i] = c[2]; canvas[i + 1] = c[1]; canvas[i + 2] = c[0]; canvas[i + 3] = 255; // BGRA
      }
    }
    for (let t = 0; t < 12; t++) {
      const tile = new Uint8Array(256 * 256 * 4);
      for (let y = 0; y < 256; y++) tile.set(canvas.subarray(((Math.floor(t / 4) * 256 + y) * 1024 + (t % 4) * 256) * 4, ((Math.floor(t / 4) * 256 + y) * 1024 + (t % 4) * 256 + 256) * 4), y * 1024);
      files.set(`Interface\\WorldMap\\${a.name}\\${a.name}${t + 1}.blp`, buildRawBlp(256, 256, tile));
    }
    const piece = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) piece.set([colour[2], colour[1], colour[0], 255], i * 4);
    const cols = Math.ceil(o.width / 256), rows = Math.ceil(o.height / 256);
    for (let k = 1; k <= cols * rows; k++) files.set(`Interface\\WorldMap\\${a.name}\\${o.texture}${k}.blp`, buildRawBlp(256, 256, piece));
  }
  const areaTable = new Map<number, AreaRow>([
    [100, { id: 100, mapId: MAP, parent: 0, flags: 0 }],
    [101, { id: 101, mapId: MAP, parent: 100, flags: 0 }],
    [200, { id: 200, mapId: MAP, parent: 0, flags: 0 }],
    [300, { id: 300, mapId: MAP, parent: 0, flags: 0 }],
  ]);
  const terrain = new Map<string, Uint8Array>();
  for (const c of [32, 33, 34, 35]) {
    for (const r of [32, 33]) terrain.set(`${r}_${c}`, mapBytes({ area: c >= 34 ? 200 : r === 32 && c === 32 ? 101 : 100 }));
    terrain.set(`34_${c}`, mapBytes({ area: 300, liquid: LIQUID_OCEAN }));
  }
  return {
    read: (p) => files.get(p),
    areas,
    overlays,
    areaTable,
    mapFile: (m, r, c) => (m === MAP ? terrain.get(`${r}_${c}`) : undefined),
    minimap: () => null,
  };
}

// a smaller sea margin keeps the synthetic bake quick
const PARAMS: ArtParams = { ...DEFAULT_PARAMS, seaReach: TILE_SIZE, seaFade: TILE_SIZE };

/** The output pixel (rgba) at a world point, from z1 tiles. */
function pixelAt(tiles: Map<string, Uint8Array>, x: number, y: number): number[] {
  const row = 32 - x / TILE_SIZE, col = 32 - y / TILE_SIZE;
  const R = Math.floor(row / 2), C = Math.floor(col / 2);
  const t = tiles.get(`${R}_${C}`);
  if (t === undefined) return [0, 0, 0, 0];
  const py = Math.floor((row - 2 * R) * 128), px = Math.floor((col - 2 * C) * 128);
  return [...t.subarray((py * 256 + px) * 4, (py * 256 + px) * 4 + 4)];
}
const near = (p: number[], c: Rgb, tol: number) => Math.max(Math.abs(p[0]! - c[0]), Math.abs(p[1]! - c[1]), Math.abs(p[2]! - c[2])) <= tol;

describe("composeZoneArt", () => {
  test("base tiles 4x3 cropped to 1002x668, overlays at their offset, own mask under the overlay", () => {
    const src = world();
    const art = composeZoneArt(src.read, src.areas[0]!, src.overlays)!;
    const at = (u: number, v: number) => [...art.rgba.subarray((v * ART_W + u) * 4, (v * ART_W + u) * 4 + 3)];
    expect(at(300, 200)).toEqual(RED);
    expect(at(600, 200)).toEqual(PARCHMENT);
    expect(at(5, 300)).toEqual(FRAME);
    expect(art.own![200 * ART_W + 300]).toBe(1);
    expect(art.own![200 * ART_W + 600]).toBe(0);
  });

  test("a missing base tile means no art; a zone with no overlay pieces has no own mask", () => {
    const src = world();
    expect(composeZoneArt(() => undefined, src.areas[0]!, src.overlays)).toBeNull();
    expect(composeZoneArt(src.read, src.areas[0]!, [])!.own).toBeNull();
  });
});

describe("renderArt over a synthetic world", () => {
  const src = world();
  const first = renderArt(MAP, src, PARAMS);
  const tiles = first.tiles;

  test("each zone's own interior shows its own art, the subzone resolved to its zone", () => {
    expect(first.zones).toEqual(["ZoneA", "ZoneB"]);
    // inside A, including the ADT whose cells carry subzone 101
    expect(near(pixelAt(tiles, -300, -300), RED, 3)).toBe(true);
    expect(near(pixelAt(tiles, -150, -150), RED, 3)).toBe(true);
    expect(near(pixelAt(tiles, -500, -1600), YELLOW, 3)).toBe(true);
    expect(pixelAt(tiles, -300, -300)[3]).toBe(255);
  });

  test("a label baked on A's territory far from A's painted interior never shows, and no frame does", () => {
    let label = 0, frame = 0;
    for (const t of tiles.values()) {
      for (let i = 0; i < t.length; i += 4) {
        if (t[i + 3]! < 16) continue;
        const p = [t[i]!, t[i + 1]!, t[i + 2]!];
        if (near(p, LABEL, 60)) label++;
        if (near(p, FRAME, 60)) frame++;
      }
    }
    expect(label).toBe(0);
    expect(frame).toBe(0);
  });

  test("the sea takes the art's own water colour, and fades to clear away from the coast", () => {
    expect(first.measured!.water).toEqual(WATER);
    const sea = pixelAt(tiles, (32 - 34.4) * TILE_SIZE, (32 - 33.5) * TILE_SIZE);
    expect(sea[3]!).toBeGreaterThan(200);
    expect(sea[2]!).toBeGreaterThan(sea[0]!);
    expect(pixelAt(tiles, (32 - 29.2) * TILE_SIZE, (32 - 29.2) * TILE_SIZE)[3]).toBe(0);
  });

  test("only tiles with content are returned, and the bake is deterministic", () => {
    for (const t of tiles.values()) {
      let opaque = false;
      for (let i = 3; i < t.length && !opaque; i += 4) opaque = t[i]! > 0;
      expect(opaque).toBe(true);
    }
    const again = renderArt(MAP, world(), PARAMS).tiles;
    expect([...again.keys()]).toEqual([...tiles.keys()]);
    for (const [k, t] of tiles) expect(Buffer.compare(Buffer.from(again.get(k)!), Buffer.from(t))).toBe(0);
  });

  test("a map with no terrain renders nothing", () => {
    expect(renderArt(MAP + 1, src, PARAMS).tiles.size).toBe(0);
  });
});

describe("writeArtPyramid", () => {
  const z1 = renderArt(MAP, world(), PARAMS).tiles;
  const dir = join(scratch, String(MAP));

  test("writes z1..LOD_MAX under the art layer's spelling, one tile at the top", () => {
    const stats = writeArtPyramid(dir, z1, { force: false });
    expect(stats.map((s) => s.z)).toEqual(Array.from({ length: LOD_MAX }, (_, i) => i + 1));
    expect(stats[0]!.written).toBe(z1.size);
    expect(stats[LOD_MAX - 1]!.written).toBe(1);
    for (const key of z1.keys()) {
      const [r, c] = key.split("_").map(Number) as [number, number];
      expect(existsSync(join(dir, lodTileName(ART_LAYER, 1, r, c)))).toBe(true);
    }
    const top = decodePng(new Uint8Array(readFileSync(join(dir, lodTileName(ART_LAYER, LOD_MAX, 0, 0)))));
    expect([top.width, top.height]).toEqual([256, 256]);
  });

  test("an existing tile is skipped without --force; --force rewrites and drops stale tiles", () => {
    expect(writeArtPyramid(dir, z1, { force: false }).every((s) => s.written === 0)).toBe(true);
    const stale = join(dir, lodTileName(ART_LAYER, 1, 0, 0));
    mkdirSync(join(dir, "art", "1"), { recursive: true });
    writeFileSync(stale, new Uint8Array([1, 2, 3]));
    const forced = writeArtPyramid(dir, z1, { force: true });
    expect(forced[0]!.written).toBe(z1.size);
    expect(forced[0]!.removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(join(dir, "art", "1")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});
