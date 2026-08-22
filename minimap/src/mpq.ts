/**
 * Minimal MPQ v1/v2 archive reader — enough to pull named files out of the
 * WoW 3.3.5a client archives. Random access only: the archives are gigabytes,
 * so nothing but the hash/block tables and the sectors of a requested file are
 * ever read into memory.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  HASH_FILE_KEY,
  HASH_NAME_A,
  HASH_NAME_B,
  HASH_TABLE_OFFSET,
  decryptBlock,
  fileKey,
  hashString,
} from "./crypt";
import { UnsupportedCompression, decompressSector } from "./compress";

export const FLAG_IMPLODE = 0x00000100;
export const FLAG_COMPRESS = 0x00000200;
export const FLAG_ENCRYPTED = 0x00010000;
export const FLAG_FIX_KEY = 0x00020000;
export const FLAG_PATCH_FILE = 0x00100000;
export const FLAG_SINGLE_UNIT = 0x01000000;
export const FLAG_DELETE_MARKER = 0x02000000;
export const FLAG_SECTOR_CRC = 0x04000000;
export const FLAG_EXISTS = 0x80000000;

const MPQ_MAGIC = 0x1a51504d; // 'MPQ\x1a' little-endian
const HASH_ENTRY_EMPTY = 0xffffffff;
const HASH_ENTRY_DELETED = 0xfffffffe;

interface HashEntry {
  nameA: number;
  nameB: number;
  locale: number;
  blockIndex: number;
}

interface BlockEntry {
  filePos: number;
  compressedSize: number;
  fileSize: number;
  flags: number;
}

/** A byte source; a real file on disk or an in-memory buffer (tests). */
export interface ByteSource {
  size: number;
  read(offset: number, length: number): Uint8Array;
  close(): void;
}

export function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read(offset, length) {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, offset + got);
        if (n <= 0) break;
        got += n;
      }
      return got === length ? buf : buf.subarray(0, got);
    },
    close() {
      closeSync(fd);
    },
  };
}

export function bufferSource(data: Uint8Array): ByteSource {
  return {
    size: data.byteLength,
    read: (offset, length) => data.subarray(offset, offset + length),
    close: () => {},
  };
}

/** Sector compression methods observed while reading, for reporting. */
export type MethodTally = Map<number, number>;

export class MpqArchive {
  private constructor(
    readonly name: string,
    private readonly src: ByteSource,
    private readonly archiveOffset: number,
    private readonly sectorSize: number,
    private readonly hashTable: HashEntry[],
    private readonly blockTable: BlockEntry[],
    readonly formatVersion: number,
  ) {}

  readonly methods: MethodTally = new Map();

  static open(path: string): MpqArchive {
    return MpqArchive.fromSource(path, fileSource(path));
  }

  static fromSource(name: string, src: ByteSource): MpqArchive {
    const archiveOffset = findHeader(src);
    const header = src.read(archiveOffset, 32);
    const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const formatVersion = hv.getUint16(12, true);
    const sectorSize = 512 << hv.getUint16(14, true);
    const hashTablePos = archiveOffset + hv.getUint32(16, true);
    const blockTablePos = archiveOffset + hv.getUint32(20, true);
    const hashTableSize = hv.getUint32(24, true);
    const blockTableSize = hv.getUint32(28, true);

    const hashRaw = src.read(hashTablePos, hashTableSize * 16);
    decryptBlock(hashRaw, hashString("(hash table)", HASH_FILE_KEY));
    const hashTable: HashEntry[] = [];
    const hrv = new DataView(hashRaw.buffer, hashRaw.byteOffset, hashRaw.byteLength);
    for (let i = 0; i < hashTableSize; i++) {
      hashTable.push({
        nameA: hrv.getUint32(i * 16, true),
        nameB: hrv.getUint32(i * 16 + 4, true),
        locale: hrv.getUint16(i * 16 + 8, true),
        blockIndex: hrv.getUint32(i * 16 + 12, true),
      });
    }

    const blockRaw = src.read(blockTablePos, blockTableSize * 16);
    decryptBlock(blockRaw, hashString("(block table)", HASH_FILE_KEY));
    const blockTable: BlockEntry[] = [];
    const brv = new DataView(blockRaw.buffer, blockRaw.byteOffset, blockRaw.byteLength);
    for (let i = 0; i < blockTableSize; i++) {
      blockTable.push({
        filePos: brv.getUint32(i * 16, true),
        compressedSize: brv.getUint32(i * 16 + 4, true),
        fileSize: brv.getUint32(i * 16 + 8, true),
        flags: brv.getUint32(i * 16 + 12, true),
      });
    }

    return new MpqArchive(
      name,
      src,
      archiveOffset,
      sectorSize,
      hashTable,
      blockTable,
      formatVersion,
    );
  }

  close(): void {
    this.src.close();
  }

  private lookup(name: string): BlockEntry | undefined {
    const size = this.hashTable.length;
    if (size === 0) return undefined;
    const start = hashString(name, HASH_TABLE_OFFSET) & (size - 1);
    const a = hashString(name, HASH_NAME_A);
    const b = hashString(name, HASH_NAME_B);
    for (let i = 0; i < size; i++) {
      const e = this.hashTable[(start + i) % size];
      if (!e) return undefined;
      if (e.blockIndex === HASH_ENTRY_EMPTY) return undefined;
      if (e.blockIndex === HASH_ENTRY_DELETED) continue;
      if (e.nameA === a && e.nameB === b) {
        return this.blockTable[e.blockIndex];
      }
    }
    return undefined;
  }

  has(name: string): boolean {
    const b = this.lookup(name);
    return b !== undefined && (b.flags & FLAG_EXISTS) !== 0 && (b.flags & FLAG_DELETE_MARKER) === 0;
  }

  /**
   * Read a file by archive path. Returns undefined when the archive does not
   * contain it (or holds only a deletion marker / incremental patch entry).
   * Throws {@link UnsupportedCompression} for compression methods we do not
   * implement, so callers can skip and report.
   */
  read(name: string): Uint8Array | undefined {
    const block = this.lookup(name);
    if (!block) return undefined;
    if ((block.flags & FLAG_EXISTS) === 0) return undefined;
    if (block.flags & FLAG_DELETE_MARKER) return undefined;
    // Incremental patch entries need the base file plus a BSDIFF/COPY patch
    // stream; the WotLK minimap set never uses them, so treat as absent and
    // let the caller fall back to an earlier archive.
    if (block.flags & FLAG_PATCH_FILE) return undefined;

    const base = this.archiveOffset + block.filePos;
    const compressed = (block.flags & (FLAG_COMPRESS | FLAG_IMPLODE)) !== 0;

    let key = 0;
    if (block.flags & FLAG_ENCRYPTED) {
      key = fileKey(name);
      if (block.flags & FLAG_FIX_KEY) {
        key = (((key + block.filePos) >>> 0) ^ block.fileSize) >>> 0;
      }
    }

    if (block.flags & FLAG_SINGLE_UNIT) {
      const raw = this.src.read(base, block.compressedSize).slice();
      if (block.flags & FLAG_ENCRYPTED) decryptBlock(raw, key);
      return this.inflateSectorBody(raw, block.fileSize, compressed, block.flags);
    }

    const sectorCount = Math.ceil(block.fileSize / this.sectorSize);
    let offsets: number[];
    if (compressed) {
      const tableEntries = sectorCount + 1 + ((block.flags & FLAG_SECTOR_CRC) !== 0 ? 1 : 0);
      const tableRaw = this.src.read(base, tableEntries * 4).slice();
      if (block.flags & FLAG_ENCRYPTED) decryptBlock(tableRaw, (key - 1) >>> 0);
      const tv = new DataView(tableRaw.buffer, tableRaw.byteOffset, tableRaw.byteLength);
      offsets = [];
      for (let i = 0; i <= sectorCount; i++) offsets.push(tv.getUint32(i * 4, true));
    } else {
      offsets = [];
      for (let i = 0; i <= sectorCount; i++) {
        offsets.push(Math.min(i * this.sectorSize, block.fileSize));
      }
    }

    const out = new Uint8Array(block.fileSize);
    let written = 0;
    for (let i = 0; i < sectorCount; i++) {
      const start = offsets[i] ?? 0;
      const end = offsets[i + 1] ?? 0;
      const expected = Math.min(this.sectorSize, block.fileSize - written);
      const raw = this.src.read(base + start, end - start).slice();
      if (block.flags & FLAG_ENCRYPTED) decryptBlock(raw, (key + i) >>> 0);
      const sector = this.inflateSectorBody(raw, expected, compressed, block.flags);
      out.set(sector.subarray(0, expected), written);
      written += expected;
    }
    return out;
  }

  private inflateSectorBody(
    raw: Uint8Array,
    expected: number,
    compressed: boolean,
    flags: number,
  ): Uint8Array {
    if (!compressed || raw.byteLength >= expected) {
      // Stored verbatim: MPQ writes the sector raw whenever compression did
      // not shrink it.
      return raw;
    }
    if (flags & FLAG_IMPLODE && !(flags & FLAG_COMPRESS)) {
      // IMPLODE-only files carry no method mask byte; the body is PKWARE.
      this.methods.set(0x08, (this.methods.get(0x08) ?? 0) + 1);
      return decompressSector(raw, 0x08, expected);
    }
    const mask = raw[0] ?? 0;
    this.methods.set(mask, (this.methods.get(mask) ?? 0) + 1);
    return decompressSector(raw.subarray(1), mask, expected);
  }
}

function findHeader(src: ByteSource): number {
  // The header sits at a 512-byte boundary, at or near the start of the file.
  // Bound the scan so a non-MPQ file fails fast instead of reading gigabytes.
  const limit = Math.min(src.size - 32, 512 * 1024);
  for (let offset = 0; offset <= limit; offset += 512) {
    const probe = src.read(offset, 4);
    if (probe.byteLength < 4) break;
    const v = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
    if (v.getUint32(0, true) === MPQ_MAGIC) return offset;
  }
  throw new Error("not an MPQ archive (no header found)");
}

/**
 * A stack of archives in client load order; later archives win. `read` walks
 * the stack from the top down.
 */
export class MpqChain {
  constructor(private readonly archives: MpqArchive[]) {}

  static open(paths: string[]): MpqChain {
    const archives: MpqArchive[] = [];
    for (const p of paths) archives.push(MpqArchive.open(p));
    return new MpqChain(archives);
  }

  /** Read a file, highest-priority archive first. */
  read(name: string): Uint8Array | undefined {
    for (let i = this.archives.length - 1; i >= 0; i--) {
      const a = this.archives[i];
      if (!a) continue;
      try {
        const data = a.read(name);
        if (data) return data;
      } catch (err) {
        if (err instanceof UnsupportedCompression) continue;
        throw err;
      }
    }
    return undefined;
  }

  /** Which archive would serve this name, for diagnostics. */
  provider(name: string): string | undefined {
    for (let i = this.archives.length - 1; i >= 0; i--) {
      const a = this.archives[i];
      if (a?.has(name)) return a.name;
    }
    return undefined;
  }

  methods(): MethodTally {
    const total: MethodTally = new Map();
    for (const a of this.archives) {
      for (const [m, n] of a.methods) total.set(m, (total.get(m) ?? 0) + n);
    }
    return total;
  }

  close(): void {
    for (const a of this.archives) a.close();
  }
}
