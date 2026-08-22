/**
 * MPQ sector decompression.
 *
 * A compressed sector starts with a one-byte mask of the compression methods
 * that were applied (they stack, and are undone in reverse order). In practice
 * 3.3.5 data uses a single method per sector; zlib dominates.
 */

import { inflateSync } from "node:zlib";
import { explode } from "./explode";

export const COMP_HUFFMAN = 0x01;
export const COMP_ZLIB = 0x02;
export const COMP_PKWARE = 0x08;
export const COMP_BZIP2 = 0x10;
export const COMP_SPARSE = 0x20;
export const COMP_ADPCM_MONO = 0x40;
export const COMP_ADPCM_STEREO = 0x80;

export class UnsupportedCompression extends Error {
  constructor(readonly method: number) {
    super(`unsupported MPQ compression method 0x${method.toString(16)}`);
    this.name = "UnsupportedCompression";
  }
}

function bunzip2(data: Uint8Array): Uint8Array {
  const res = Bun.spawnSync(["bunzip2", "-c"], { stdin: data });
  if (!res.success) throw new UnsupportedCompression(COMP_BZIP2);
  return new Uint8Array(res.stdout);
}

/**
 * Decompress one sector body (the byte after the method mask onwards).
 * `expectedSize` is the uncompressed size of the sector.
 */
export function decompressSector(
  body: Uint8Array,
  mask: number,
  expectedSize: number,
): Uint8Array {
  let out = body;
  // Methods are applied in a fixed order when compressing; undo in reverse.
  if (mask & COMP_BZIP2) out = bunzip2(out);
  if (mask & COMP_ZLIB) out = new Uint8Array(inflateSync(out));
  if (mask & COMP_PKWARE) out = explode(out, expectedSize);

  const unsupported = mask & ~(COMP_BZIP2 | COMP_ZLIB | COMP_PKWARE);
  if (unsupported !== 0) throw new UnsupportedCompression(unsupported);
  return out;
}
