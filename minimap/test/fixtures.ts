/**
 * Synthetic fixtures. Everything here is constructed byte-by-byte in code —
 * no game data ever enters the repository (CLAUDE.md hard constraint).
 */

import { deflateSync } from "node:zlib";
import {
  HASH_FILE_KEY,
  HASH_NAME_A,
  HASH_NAME_B,
  HASH_TABLE_OFFSET,
  encryptBlock,
  fileKey,
  hashString,
} from "../src/crypt";
import {
  FLAG_COMPRESS,
  FLAG_ENCRYPTED,
  FLAG_EXISTS,
  FLAG_FIX_KEY,
  FLAG_SINGLE_UNIT,
} from "../src/mpq";
import { ENC_DXT, ENC_PALETTE, ENC_RAW_BGRA, HEADER_SIZE, PALETTE_SIZE } from "../src/blp";

export interface FixtureFile {
  name: string;
  data: Uint8Array;
  /** Store the sectors verbatim instead of deflating them. */
  stored?: boolean;
  encrypted?: boolean;
  fixKey?: boolean;
  singleUnit?: boolean;
}

interface Placed {
  file: FixtureFile;
  filePos: number;
  compressedSize: number;
  flags: number;
}

/** Build a complete MPQ v1 archive in memory. */
export function buildMpq(files: FixtureFile[], sectorShift = 1): Uint8Array {
  const sectorSize = 512 << sectorShift;
  const chunks: Uint8Array[] = [];
  const placed: Placed[] = [];
  let at = 32; // header size

  for (const file of files) {
    let flags = FLAG_EXISTS;
    if (file.encrypted) flags |= FLAG_ENCRYPTED;
    if (file.fixKey) flags |= FLAG_FIX_KEY;

    let key = 0;
    if (file.encrypted) {
      key = fileKey(file.name);
      if (file.fixKey) key = (((key + at) >>> 0) ^ file.data.byteLength) >>> 0;
    }

    let body: Uint8Array;
    if (file.singleUnit) {
      flags |= FLAG_SINGLE_UNIT | FLAG_COMPRESS;
      const packed = new Uint8Array(deflateSync(file.data));
      body = new Uint8Array(1 + packed.byteLength);
      body[0] = 0x02;
      body.set(packed, 1);
      if (file.encrypted) encryptBlock(body, key);
    } else {
      const count = Math.max(1, Math.ceil(file.data.byteLength / sectorSize));
      const sectors: Uint8Array[] = [];
      for (let i = 0; i < count; i++) {
        const plain = file.data.subarray(i * sectorSize, Math.min((i + 1) * sectorSize, file.data.byteLength));
        if (file.stored) {
          sectors.push(plain.slice());
          continue;
        }
        const packed = new Uint8Array(deflateSync(plain));
        // Mirror the real format: only mark it compressed when it shrank.
        if (packed.byteLength + 1 >= plain.byteLength) {
          sectors.push(plain.slice());
        } else {
          const s = new Uint8Array(1 + packed.byteLength);
          s[0] = 0x02;
          s.set(packed, 1);
          sectors.push(s);
        }
      }
      flags |= FLAG_COMPRESS;
      const table = new Uint8Array((count + 1) * 4);
      const tv = new DataView(table.buffer);
      let off = table.byteLength;
      tv.setUint32(0, off, true);
      for (let i = 0; i < count; i++) {
        off += sectors[i]?.byteLength ?? 0;
        tv.setUint32((i + 1) * 4, off, true);
      }
      if (file.encrypted) {
        for (let i = 0; i < count; i++) {
          const s = sectors[i];
          if (s) encryptBlock(s, (key + i) >>> 0);
        }
        encryptBlock(table, (key - 1) >>> 0);
      }
      body = new Uint8Array(off);
      body.set(table, 0);
      let cursor = table.byteLength;
      for (const s of sectors) {
        body.set(s, cursor);
        cursor += s.byteLength;
      }
    }

    chunks.push(body);
    placed.push({ file, filePos: at, compressedSize: body.byteLength, flags });
    at += body.byteLength;
  }

  // Hash table: smallest power of two that holds every entry with slack.
  let hashSize = 4;
  while (hashSize < files.length * 2) hashSize *= 2;
  const hashRaw = new Uint8Array(hashSize * 16).fill(0xff);
  const hv = new DataView(hashRaw.buffer);
  for (let i = 0; i < hashSize; i++) hv.setUint16(i * 16 + 8, 0xffff, true);
  placed.forEach((p, blockIndex) => {
    let slot = hashString(p.file.name, HASH_TABLE_OFFSET) & (hashSize - 1);
    while (hv.getUint32(slot * 16 + 12, true) !== 0xffffffff) slot = (slot + 1) % hashSize;
    hv.setUint32(slot * 16, hashString(p.file.name, HASH_NAME_A), true);
    hv.setUint32(slot * 16 + 4, hashString(p.file.name, HASH_NAME_B), true);
    hv.setUint16(slot * 16 + 8, 0, true); // locale
    hv.setUint16(slot * 16 + 10, 0, true); // platform
    hv.setUint32(slot * 16 + 12, blockIndex, true);
  });

  const blockRaw = new Uint8Array(placed.length * 16);
  const bv = new DataView(blockRaw.buffer);
  placed.forEach((p, i) => {
    bv.setUint32(i * 16, p.filePos, true);
    bv.setUint32(i * 16 + 4, p.compressedSize, true);
    bv.setUint32(i * 16 + 8, p.file.data.byteLength, true);
    bv.setUint32(i * 16 + 12, p.flags, true);
  });

  encryptBlock(hashRaw, hashString("(hash table)", HASH_FILE_KEY));
  encryptBlock(blockRaw, hashString("(block table)", HASH_FILE_KEY));

  const hashPos = at;
  const blockPos = hashPos + hashRaw.byteLength;
  const total = blockPos + blockRaw.byteLength;

  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x1a51504d, true);
  ov.setUint32(4, 32, true); // header size
  ov.setUint32(8, total, true); // archive size
  ov.setUint16(12, 0, true); // format version 1
  ov.setUint16(14, sectorShift, true);
  ov.setUint32(16, hashPos, true);
  ov.setUint32(20, blockPos, true);
  ov.setUint32(24, hashSize, true);
  ov.setUint32(28, placed.length, true);

  let cursor = 32;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.byteLength;
  }
  out.set(hashRaw, hashPos);
  out.set(blockRaw, blockPos);
  return out;
}

// ---------------------------------------------------------------------------
// BLP2 fixtures
// ---------------------------------------------------------------------------

function blpHeader(
  colorEncoding: number,
  alphaSize: number,
  alphaEncoding: number,
  width: number,
  height: number,
  mip0Offset: number,
  mip0Size: number,
): Uint8Array {
  const h = new Uint8Array(HEADER_SIZE);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x424c5032, false); // "BLP2"
  v.setUint32(4, 1, true);
  v.setUint8(8, colorEncoding);
  v.setUint8(9, alphaSize);
  v.setUint8(10, alphaEncoding);
  v.setUint8(11, 0);
  v.setUint32(12, width, true);
  v.setUint32(16, height, true);
  v.setUint32(20, mip0Offset, true);
  v.setUint32(84, mip0Size, true);
  return h;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Palettised BLP2. `palette` is BGRA entries, `indices` is one byte per pixel,
 * `alpha` (optional) is a raw 8-bit alpha plane.
 */
export function buildPaletteBlp(
  width: number,
  height: number,
  palette: Uint8Array,
  indices: Uint8Array,
  alpha?: Uint8Array,
): Uint8Array {
  const pal = new Uint8Array(PALETTE_SIZE);
  pal.set(palette.subarray(0, PALETTE_SIZE));
  const mip = alpha ? join(indices, alpha) : indices;
  const header = blpHeader(
    ENC_PALETTE,
    alpha ? 8 : 0,
    0,
    width,
    height,
    HEADER_SIZE + PALETTE_SIZE,
    mip.byteLength,
  );
  return join(header, pal, mip);
}

/** Raw BGRA BLP2. `bgra` is width*height*4 bytes. */
export function buildRawBlp(width: number, height: number, bgra: Uint8Array): Uint8Array {
  const header = blpHeader(ENC_RAW_BGRA, 8, 8, width, height, HEADER_SIZE, bgra.byteLength);
  return join(header, bgra);
}

/** DXT BLP2 from pre-built blocks. `variant` is 1, 3 or 5. */
export function buildDxtBlp(
  width: number,
  height: number,
  variant: 1 | 3 | 5,
  blocks: Uint8Array,
): Uint8Array {
  const alphaSize = variant === 1 ? 0 : 8;
  const alphaEncoding = variant === 5 ? 7 : variant === 3 ? 1 : 0;
  const header = blpHeader(ENC_DXT, alphaSize, alphaEncoding, width, height, HEADER_SIZE, blocks.byteLength);
  return join(header, blocks);
}

export function rgb565of(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/**
 * One 4x4 DXT1 colour block: every texel takes colour index 0 (c0), so the
 * whole block is `c0` expanded from 565. c0 > c1 keeps the block opaque.
 */
export function dxt1Block(c0: number, c1: number, indices = 0): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint16(0, c0, true);
  v.setUint16(2, c1, true);
  v.setUint32(4, indices >>> 0, true);
  return b;
}

/** One 4x4 DXT3 block with a constant 4-bit alpha and a DXT1-style colour half. */
export function dxt3Block(alpha4: number, c0: number, c1: number, indices = 0): Uint8Array {
  const b = new Uint8Array(16);
  const byte = (alpha4 & 0x0f) | ((alpha4 & 0x0f) << 4);
  for (let i = 0; i < 8; i++) b[i] = byte;
  b.set(dxt1Block(c0, c1, indices), 8);
  return b;
}

/** One 4x4 DXT5 block whose every texel selects alpha endpoint 0. */
export function dxt5Block(a0: number, a1: number, c0: number, c1: number, indices = 0): Uint8Array {
  const b = new Uint8Array(16);
  b[0] = a0;
  b[1] = a1;
  for (let i = 2; i < 8; i++) b[i] = 0; // all three-bit selectors = 0 -> a0
  b.set(dxt1Block(c0, c1, indices), 8);
  return b;
}

/** Build a WDBC with u32 fields plus a string block. */
export function buildWdbc(records: number[][], strings: string[], fieldCount: number): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [new Uint8Array([0])];
  let offset = 1;
  const offsets = new Map<string, number>();
  for (const s of strings) {
    offsets.set(s, offset);
    const bytes = encoder.encode(s + "\0");
    parts.push(bytes);
    offset += bytes.byteLength;
  }
  const stringBlock = join(...parts);

  const recordSize = fieldCount * 4;
  const body = new Uint8Array(records.length * recordSize);
  const bv = new DataView(body.buffer);
  records.forEach((rec, r) => {
    rec.forEach((val, f) => bv.setUint32(r * recordSize + f * 4, val >>> 0, true));
  });

  const header = new Uint8Array(20);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0x57444243, false); // "WDBC"
  hv.setUint32(4, records.length, true);
  hv.setUint32(8, fieldCount, true);
  hv.setUint32(12, recordSize, true);
  hv.setUint32(16, stringBlock.byteLength, true);
  return join(header, body, stringBlock);
}

/** Offset of a string inside a block built by {@link buildWdbc}. */
export function stringOffset(strings: string[], want: string): number {
  const encoder = new TextEncoder();
  let offset = 1;
  for (const s of strings) {
    if (s === want) return offset;
    offset += encoder.encode(s + "\0").byteLength;
  }
  throw new Error(`no such string ${want}`);
}
