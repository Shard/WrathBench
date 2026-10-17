/**
 * The server's per-ADT area and liquid grid: AzerothCore's map_extractor
 * output under `data/client/maps/`, one file per ADT. The art bake reads it
 * for which zone owns each 33-yard cell and which cells are open sea; the
 * format and the orientation evidence are in `minimap/README.md`.
 *
 * Layout (version 9, read off the bytes of the real extraction):
 *
 *   header  11 × u32: 'MAPS', version, build, then (offset, size) pairs for
 *           the area, height, liquid and holes sections — 44 bytes
 *   area    'AREA', u16 flags (1 = the whole tile is one area), u16 area,
 *           then unless flags & 1: u16[16][16] AreaTable ids
 *   liquid  'MLIQ', u8 flags (1 = no per-cell type, 2 = no heights), u8 tile
 *           liquid flags, u16 type, u8 x, y, width, height of the liquid's
 *           vertex rectangle, f32 level, then unless flags & 1: u16[16][16]
 *           liquid entries and u8[16][16] per-cell liquid flags
 *
 * Both 16×16 grids are row-major with the row running north to south and the
 * column west to east — the same orientation as a minimap tile.
 */

/** Area cells per ADT edge: one per MCNK chunk, 33.3 yards. */
export const CELLS = 16;

/** The only layout this reader knows; another version may move the sections. */
export const MAP_VERSION = 9;

/** Per-cell liquid flags. */
export const LIQUID_WATER = 0x01;
export const LIQUID_OCEAN = 0x02;

const MAGIC_MAPS = 0x5350414d; // "MAPS"
const MAGIC_AREA = 0x41455241; // "AREA"
const MAGIC_MLIQ = 0x51494c4d; // "MLIQ"
const AREA_UNIFORM = 0x01;
const LIQUID_NO_TYPE = 0x01;

export interface MapCells {
  /** AreaTable id per cell, `row * 16 + col`; 0 = no area. */
  area: Uint16Array;
  /** Liquid flags per cell (`LIQUID_*`), 0 = dry. */
  liquid: Uint8Array;
}

/** The file for one ADT: map id in three digits, then row and column in two. */
export function mapFileName(mapId: number, row: number, col: number): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(mapId, 3)}${pad(row, 2)}${pad(col, 2)}.map`;
}

export function parseMapFile(data: Uint8Array): MapCells {
  if (data.byteLength < 44) throw new Error(".map file shorter than its header");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0, true) !== MAGIC_MAPS) throw new Error("not a .map file (no MAPS magic)");
  const version = v.getUint32(4, true);
  if (version !== MAP_VERSION) throw new Error(`.map version ${version}, this reader knows ${MAP_VERSION}`);
  const n = CELLS * CELLS;
  const area = new Uint16Array(n);
  const liquid = new Uint8Array(n);

  const ao = v.getUint32(12, true);
  if (v.getUint32(ao, true) !== MAGIC_AREA) throw new Error("area section has no AREA magic");
  const aflags = v.getUint16(ao + 4, true);
  if (aflags & AREA_UNIFORM) area.fill(v.getUint16(ao + 6, true));
  else for (let i = 0; i < n; i++) area[i] = v.getUint16(ao + 8 + i * 2, true);

  const lo = v.getUint32(28, true);
  if (lo !== 0) {
    if (v.getUint32(lo, true) !== MAGIC_MLIQ) throw new Error("liquid section has no MLIQ magic");
    const lflags = data[lo + 4] as number;
    if (!(lflags & LIQUID_NO_TYPE)) {
      liquid.set(data.subarray(lo + 16 + n * 2, lo + 16 + n * 3));
    } else {
      // One type for the tile, over the liquid's vertex rectangle (8 vertices a cell).
      // Every real tile seen spans the whole 129-vertex grid, so the order of x and
      // y here is untested against data; a cell counts if its centre vertex is inside.
      const global = data[lo + 5] as number;
      const x0 = data[lo + 8] as number, y0 = data[lo + 9] as number;
      const w = data[lo + 10] as number, h = data[lo + 11] as number;
      for (let r = 0; r < CELLS; r++) {
        for (let c = 0; c < CELLS; c++) {
          const vr = r * 8 + 4, vc = c * 8 + 4;
          if (vr >= y0 && vr < y0 + h && vc >= x0 && vc < x0 + w) liquid[r * CELLS + c] = global;
        }
      }
    }
  }
  return { area, liquid };
}
