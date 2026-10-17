import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { crc32, decodePng, encodePng } from "../src/png";

function chunks(png: Uint8Array): { type: string; body: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; body: Uint8Array }[] = [];
  let at = 8;
  while (at < png.byteLength) {
    const len = view.getUint32(at, false);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + len);
    const stated = view.getUint32(at + 8 + len, false);
    expect(crc32(png.subarray(at + 4, at + 8 + len))).toBe(stated);
    out.push({ type, body });
    at += 12 + len;
  }
  return out;
}

describe("encodePng", () => {
  test("writes a well-formed RGBA PNG whose IDAT round-trips", () => {
    const width = 5;
    const height = 3;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xff;

    const png = encodePng(rgba, width, height);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const parsed = chunks(png);
    expect(parsed.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);

    const ihdr = parsed[0]!.body;
    const iv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
    expect(iv.getUint32(0, false)).toBe(width);
    expect(iv.getUint32(4, false)).toBe(height);
    expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    expect(parsed[2]!.body.byteLength).toBe(0);

    const raw = new Uint8Array(inflateSync(parsed[1]!.body));
    expect(raw.byteLength).toBe(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      const at = y * (1 + width * 4);
      expect(raw[at]).toBe(0); // filter type None
      expect([...raw.subarray(at + 1, at + 1 + width * 4)]).toEqual([
        ...rgba.subarray(y * width * 4, (y + 1) * width * 4),
      ]);
    }
  });

  test("rejects a mis-sized pixel buffer", () => {
    expect(() => encodePng(new Uint8Array(10), 4, 4)).toThrow(/expected/);
  });

  test("crc32 matches the known PNG test vector for IEND", () => {
    // The IEND chunk's CRC is a fixed, published value.
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });
});

/* --- the decoder ------------------------------------------------------- */

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.byteLength, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  v.setUint32(8 + body.byteLength, crc32(out.subarray(4, 8 + body.byteLength)), false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function ihdr(width: number, height: number, depth = 8, colour = 6, interlace = 0): Uint8Array {
  const b = new Uint8Array(13);
  const v = new DataView(b.buffer);
  v.setUint32(0, width, false);
  v.setUint32(4, height, false);
  b[8] = depth;
  b[9] = colour;
  b[12] = interlace;
  return b;
}

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * A PNG whose row y uses filter `filters[y % 5]`, written independently of the
 * encoder under test, with the image data split across two IDAT chunks.
 */
function filteredPng(rgba: Uint8Array, width: number, height: number, filters: number[]): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]!;
    raw[y * (1 + stride)] = f;
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x]!;
      const a = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4]! : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]!;
      raw[y * (1 + stride) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const z = new Uint8Array(deflateSync(raw));
  const cut = z.byteLength >> 1;
  return concat([
    SIG,
    pngChunk("IHDR", ihdr(width, height)),
    pngChunk("IDAT", z.subarray(0, cut)),
    pngChunk("IDAT", z.subarray(cut)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe("decodePng", () => {
  test("reads back exactly what encodePng wrote", () => {
    const rgba = noise(7 * 4 * 4, 1);
    const img = decodePng(encodePng(rgba, 7, 4));
    expect(img.width).toBe(7);
    expect(img.height).toBe(4);
    expect([...img.rgba]).toEqual([...rgba]);
  });

  test("undoes all five scanline filters, across split IDAT chunks", () => {
    const width = 9;
    const height = 10;
    const rgba = noise(width * height * 4, 7);
    const img = decodePng(filteredPng(rgba, width, height, [0, 1, 2, 3, 4]));
    expect([...img.rgba]).toEqual([...rgba]);
  });

  test("refuses what it does not decode, by name", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
    const idat = pngChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(5))));
    const end = pngChunk("IEND", new Uint8Array(0));
    expect(() => decodePng(concat([SIG, pngChunk("IHDR", ihdr(1, 1, 8, 2)), idat, end]))).toThrow(/colour type 2/);
    expect(() => decodePng(concat([SIG, pngChunk("IHDR", ihdr(1, 1, 16, 6)), idat, end]))).toThrow(/bit depth 16/);
    expect(() => decodePng(concat([SIG, pngChunk("IHDR", ihdr(1, 1, 8, 6, 1)), idat, end]))).toThrow(/interlaced/);
  });

  test("a corrupted chunk fails its CRC rather than decoding to garbage", () => {
    const png = encodePng(noise(16, 3), 2, 2);
    const bad = new Uint8Array(png);
    bad[42] = (bad[42]! ^ 0xff) & 0xff; // inside the IDAT body (IHDR ends at 33, IDAT data at 41)
    expect(() => decodePng(bad)).toThrow(/CRC/);
  });
});
