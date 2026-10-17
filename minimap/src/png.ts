/**
 * Minimal PNG codec. The encoder writes 8-bit RGBA (colour type 6), no
 * interlacing, filter type 0 on every scanline — enough to write minimap
 * tiles without a dependency. The decoder reads that same format back, with
 * any of the five scanline filters and the image data split across several
 * chunks, which is what the LOD bake needs to read the tiles the extractor
 * wrote; anything else (palette, 16-bit, interlaced) is refused by name.
 */

import { deflateSync, inflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.byteLength; i++) {
    c = ((CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.byteLength, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.byteLength, crc32(out.subarray(4, 8 + body.byteLength)), false);
  return out;
}

/** Encode `rgba` (width*height*4 bytes) as a PNG file. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.byteLength !== width * height * 4) {
    throw new Error(`pixel buffer is ${rgba.byteLength} bytes, expected ${width * height * 4}`);
  }
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + width * 4);
    raw[dst] = 0; // filter type 0 (None)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), dst + 1);
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The Paeth predictor, as the PNG spec defines it. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit RGBA, non-interlaced PNG into its pixels. Throws on anything else. */
export function decodePng(png: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  if (png.byteLength < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let sawEnd = false;
  for (let at = 8; at < png.byteLength && !sawEnd; ) {
    if (at + 12 > png.byteLength) throw new Error("truncated chunk header");
    const len = view.getUint32(at, false);
    if (at + 12 + len > png.byteLength) throw new Error("truncated chunk");
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + len);
    if (crc32(png.subarray(at + 4, at + 8 + len)) !== view.getUint32(at + 8 + len, false)) {
      throw new Error(`bad CRC on ${type}`);
    }
    if (type === "IHDR") {
      const iv = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = iv.getUint32(0, false);
      height = iv.getUint32(4, false);
      const [depth, colour, compression, filter, interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || colour !== 6) throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colour}`);
      if (compression !== 0 || filter !== 0 || interlace !== 0) throw new Error("unsupported PNG: interlaced or non-standard");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") sawEnd = true;
    at += 12 + len;
  }
  if (width === 0 || height === 0) throw new Error("no IHDR");
  if (idat.length === 0) throw new Error("no IDAT");

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of idat) {
    joined.set(c, off);
    off += c.byteLength;
  }
  const raw = new Uint8Array(inflateSync(joined));
  const stride = width * 4;
  if (raw.byteLength !== height * (1 + stride)) {
    throw new Error(`image data is ${raw.byteLength} bytes, expected ${height * (1 + stride)}`);
  }

  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    const src = y * (1 + stride) + 1;
    const dst = y * stride;
    // Every row the encoder above writes is filter 0: copy it whole.
    if (filter === 0) {
      rgba.set(raw.subarray(src, src + stride), dst);
      continue;
    }
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x] as number;
      const a = x >= 4 ? (rgba[dst + x - 4] as number) : 0;
      const b = y > 0 ? (rgba[dst - stride + x] as number) : 0;
      const c = x >= 4 && y > 0 ? (rgba[dst - stride + x - 4] as number) : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = v;
          break;
        case 1:
          out = v + a;
          break;
        case 2:
          out = v + b;
          break;
        case 3:
          out = v + ((a + b) >> 1);
          break;
        case 4:
          out = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown scanline filter ${filter} on row ${y}`);
      }
      rgba[dst + x] = out & 0xff;
    }
  }
  return { rgba, width, height };
}
