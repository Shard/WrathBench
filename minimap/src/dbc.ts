/**
 * WDBC reader, plus the one lookup this pipeline needs: Map.dbc's internal
 * directory name (field 1, e.g. "Azeroth") to map id (field 0).
 */

export interface Wdbc {
  recordCount: number;
  fieldCount: number;
  recordSize: number;
  /** Read field `f` of record `r` as u32. */
  u32(r: number, f: number): number;
  /** Read field `f` of record `r` as an offset into the string block. */
  str(r: number, f: number): string;
}

export function parseWdbc(data: Uint8Array): Wdbc {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0, false) !== 0x57444243) throw new Error("not a WDBC file");
  const recordCount = v.getUint32(4, true);
  const fieldCount = v.getUint32(8, true);
  const recordSize = v.getUint32(12, true);
  const stringBlockSize = v.getUint32(16, true);
  const recordsAt = 20;
  const stringsAt = recordsAt + recordCount * recordSize;
  const strings = data.subarray(stringsAt, stringsAt + stringBlockSize);
  const decoder = new TextDecoder();

  const u32 = (r: number, f: number): number => v.getUint32(recordsAt + r * recordSize + f * 4, true);
  return {
    recordCount,
    fieldCount,
    recordSize,
    u32,
    str(r, f) {
      const off = u32(r, f);
      let end = off;
      while (end < strings.byteLength && strings[end] !== 0) end++;
      return decoder.decode(strings.subarray(off, end));
    },
  };
}

/** Lower-cased internal directory name -> map id. */
export function mapDirectories(mapDbc: Uint8Array): Map<string, number> {
  const dbc = parseWdbc(mapDbc);
  const out = new Map<string, number>();
  for (let r = 0; r < dbc.recordCount; r++) {
    out.set(dbc.str(r, 1).toLowerCase(), dbc.u32(r, 0));
  }
  return out;
}
