/**
 * PKWARE DCL "implode" decompression (MPQ compression method 0x08).
 *
 * Not implemented: no sector of any file this pipeline reads out of the 3.3.5
 * archives uses it (see minimap/README.md — the extractor tallies sector
 * compression methods and only ever observes zlib). Rather than ship ~150
 * lines of untestable table-driven format code, the reader reports the method
 * and skips the file. If a future archive does use implode, implement it here.
 */

import { UnsupportedCompression } from "./compress";

export function explode(_data: Uint8Array, _expectedSize: number): Uint8Array {
  throw new UnsupportedCompression(0x08);
}
