/**
 * BLP2 decoder (WoW 3.3.5a textures), mip level 0 only.
 *
 * Header layout (little-endian):
 *   0  char[4] "BLP2"
 *   4  u32     version (1)
 *   8  u8      colorEncoding  1 = palettised, 2 = DXT, 3 = raw BGRA
 *   9  u8      alphaSize      0, 1, 4 or 8 bits
 *   10 u8      alphaEncoding  0 = DXT1, 1 = DXT3, 7 = DXT5
 *   11 u8      hasMips
 *   12 u32     width
 *   16 u32     height
 *   20 u32[16] mip offsets
 *   84 u32[16] mip sizes
 *   148         palette (256 * BGRA) when colorEncoding == 1, else mip data
 */

export const ENC_PALETTE = 1;
export const ENC_DXT = 2;
export const ENC_RAW_BGRA = 3;

export const HEADER_SIZE = 148;
export const PALETTE_SIZE = 256 * 4;

export interface BlpHeader {
  colorEncoding: number;
  alphaSize: number;
  alphaEncoding: number;
  hasMips: boolean;
  width: number;
  height: number;
  mipOffsets: number[];
  mipSizes: number[];
}

export interface BlpImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major from the top-left. */
  rgba: Uint8Array;
}

export function parseHeader(data: Uint8Array): BlpHeader {
  if (data.byteLength < HEADER_SIZE) throw new Error("BLP too short for header");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0, false) !== 0x424c5032) throw new Error("not a BLP2 file");
  const mipOffsets: number[] = [];
  const mipSizes: number[] = [];
  for (let i = 0; i < 16; i++) {
    mipOffsets.push(v.getUint32(20 + i * 4, true));
    mipSizes.push(v.getUint32(84 + i * 4, true));
  }
  return {
    colorEncoding: v.getUint8(8),
    alphaSize: v.getUint8(9),
    alphaEncoding: v.getUint8(10),
    hasMips: v.getUint8(11) !== 0,
    width: v.getUint32(12, true),
    height: v.getUint32(16, true),
    mipOffsets,
    mipSizes,
  };
}

/** Decode mip 0 of a BLP2 file to RGBA. */
export function decodeBlp(data: Uint8Array): BlpImage {
  const h = parseHeader(data);
  const { width, height } = h;
  const offset = h.mipOffsets[0] ?? 0;
  const size = h.mipSizes[0] ?? 0;
  const mip = data.subarray(offset, offset + size);
  const rgba = new Uint8Array(width * height * 4);

  switch (h.colorEncoding) {
    case ENC_PALETTE:
      decodePalette(data, mip, h, rgba);
      break;
    case ENC_DXT:
      decodeDxt(mip, h, rgba);
      break;
    case ENC_RAW_BGRA:
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = mip[i * 4 + 2] ?? 0;
        rgba[i * 4 + 1] = mip[i * 4 + 1] ?? 0;
        rgba[i * 4 + 2] = mip[i * 4] ?? 0;
        rgba[i * 4 + 3] = mip[i * 4 + 3] ?? 255;
      }
      break;
    default:
      throw new Error(`unsupported BLP colorEncoding ${h.colorEncoding}`);
  }
  return { width, height, rgba };
}

function decodePalette(
  file: Uint8Array,
  mip: Uint8Array,
  h: BlpHeader,
  rgba: Uint8Array,
): void {
  const palette = file.subarray(HEADER_SIZE, HEADER_SIZE + PALETTE_SIZE);
  const pixels = h.width * h.height;
  for (let i = 0; i < pixels; i++) {
    const idx = (mip[i] ?? 0) * 4;
    rgba[i * 4] = palette[idx + 2] ?? 0;
    rgba[i * 4 + 1] = palette[idx + 1] ?? 0;
    rgba[i * 4 + 2] = palette[idx] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  if (h.alphaSize === 0) return;
  const alphaAt = pixels;
  for (let i = 0; i < pixels; i++) {
    let a = 255;
    if (h.alphaSize === 8) {
      a = mip[alphaAt + i] ?? 255;
    } else if (h.alphaSize === 4) {
      const byte = mip[alphaAt + (i >> 1)] ?? 0xff;
      const nib = i & 1 ? byte >> 4 : byte & 0x0f;
      a = nib * 17;
    } else if (h.alphaSize === 1) {
      const byte = mip[alphaAt + (i >> 3)] ?? 0xff;
      a = (byte >> (i & 7)) & 1 ? 255 : 0;
    }
    rgba[i * 4 + 3] = a;
  }
}

function rgb565(c: number, out: Uint8Array, at: number): void {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  out[at] = (r << 3) | (r >> 2);
  out[at + 1] = (g << 2) | (g >> 4);
  out[at + 2] = (b << 3) | (b >> 2);
}

function decodeDxt(mip: Uint8Array, h: BlpHeader, rgba: Uint8Array): void {
  // alphaEncoding selects the variant; alphaSize 0 always means DXT1.
  const variant =
    h.alphaSize === 0 ? 1 : h.alphaEncoding === 7 ? 5 : h.alphaEncoding === 1 ? 3 : 1;
  const blockBytes = variant === 1 ? 8 : 16;
  const bw = Math.max(1, Math.ceil(h.width / 4));
  const bh = Math.max(1, Math.ceil(h.height / 4));
  const view = new DataView(mip.buffer, mip.byteOffset, mip.byteLength);
  const colors = new Uint8Array(16);
  const alpha = new Uint8Array(16);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const base = (by * bw + bx) * blockBytes;
      if (base + blockBytes > mip.byteLength) return;
      let colorBase = base;

      alpha.fill(255);
      if (variant === 3) {
        for (let i = 0; i < 8; i++) {
          const byte = view.getUint8(base + i);
          alpha[i * 2] = (byte & 0x0f) * 17;
          alpha[i * 2 + 1] = (byte >> 4) * 17;
        }
        colorBase = base + 8;
      } else if (variant === 5) {
        const a0 = view.getUint8(base);
        const a1 = view.getUint8(base + 1);
        const table = new Uint8Array(8);
        table[0] = a0;
        table[1] = a1;
        if (a0 > a1) {
          for (let i = 1; i < 7; i++) table[i + 1] = ((7 - i) * a0 + i * a1) / 7;
        } else {
          for (let i = 1; i < 5; i++) table[i + 1] = ((5 - i) * a0 + i * a1) / 5;
          table[6] = 0;
          table[7] = 255;
        }
        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(view.getUint8(base + 2 + i)) << BigInt(i * 8);
        for (let i = 0; i < 16; i++) {
          alpha[i] = table[Number((bits >> BigInt(i * 3)) & 7n)] ?? 255;
        }
        colorBase = base + 8;
      }

      const c0 = view.getUint16(colorBase, true);
      const c1 = view.getUint16(colorBase + 2, true);
      rgb565(c0, colors, 0);
      rgb565(c1, colors, 4);
      const opaqueBlock = variant !== 1 || c0 > c1;
      for (let k = 0; k < 3; k++) {
        const a = colors[k] ?? 0;
        const b = colors[4 + k] ?? 0;
        if (opaqueBlock) {
          colors[8 + k] = (2 * a + b) / 3;
          colors[12 + k] = (a + 2 * b) / 3;
        } else {
          colors[8 + k] = (a + b) / 2;
          colors[12 + k] = 0;
        }
      }
      const indices = view.getUint32(colorBase + 4, true);

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= h.height) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= h.width) break;
          const i = py * 4 + px;
          const sel = (indices >>> (i * 2)) & 3;
          const dst = (y * h.width + x) * 4;
          rgba[dst] = colors[sel * 4] ?? 0;
          rgba[dst + 1] = colors[sel * 4 + 1] ?? 0;
          rgba[dst + 2] = colors[sel * 4 + 2] ?? 0;
          rgba[dst + 3] =
            variant === 1 && !opaqueBlock && sel === 3 ? 0 : (alpha[i] ?? 255);
        }
      }
    }
  }
}
