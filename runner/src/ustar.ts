/**
 * The smallest tar the character archive needs (`character-archive.ts`):
 * POSIX ustar, regular files only, written and read a block at a time so a
 * 700 MB trajectory never has to sit in memory.
 *
 * Writing is three functions — a member's header, its padding, the end
 * marker — that the caller streams between. Reading is a push parser: feed it
 * the bytes as they arrive (a file, or a gunzip stream) and it calls back once
 * per member header, once per run of member bytes, and once at the end.
 *
 * It refuses, rather than interprets, anything the writer here never emits:
 * links, devices, directories, pax and GNU extension headers, absolute paths
 * and `..`. An archive is untrusted input the moment it has been copied
 * between hosts, and a member that could land outside the directory it is
 * extracted into is the classic way such input bites.
 */

const BLOCK = 512;

export interface TarEntry {
  /** Relative, `/`-separated, no `.` or `..` segments. */
  path: string;
  size: number;
  /** Permission bits only (`& 0o7777`). */
  mode: number;
  /** Epoch seconds. */
  mtime: number;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

/** A member path the reader would accept: relative, no empty, `.` or `..` segment, no backslash or NUL. */
export function isSafeMemberPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function putString(buf: Uint8Array, at: number, width: number, s: string): void {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > width) throw new TarError(`tar field overflow: ${JSON.stringify(s)} is longer than ${width} bytes`);
  buf.set(bytes, at);
}

function putOctal(buf: Uint8Array, at: number, width: number, n: number): void {
  // width - 1 digits and a NUL, as ustar writes them.
  const digits = Math.floor(n).toString(8);
  if (digits.length > width - 1) throw new TarError(`tar numeric field overflow: ${n} does not fit ${width - 1} octal digits`);
  putString(buf, at, width, `${digits.padStart(width - 1, "0")}\0`);
}

/**
 * Split a path into ustar's `prefix` (155 bytes) and `name` (100 bytes) at a
 * `/`, or refuse it: a path longer than both is not one this writer emits.
 */
function splitPath(path: string): { prefix: string; name: string } {
  const len = new TextEncoder().encode(path).length;
  if (len <= 100) return { prefix: "", name: path };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (new TextEncoder().encode(prefix).length <= 155 && new TextEncoder().encode(name).length <= 100) return { prefix, name };
  }
  throw new TarError(`member path too long for ustar: ${path}`);
}

/** The 512-byte ustar header for one regular file. */
export function tarHeader(e: TarEntry): Uint8Array {
  if (!isSafeMemberPath(e.path)) throw new TarError(`unsafe member path: ${JSON.stringify(e.path)}`);
  if (!Number.isSafeInteger(e.size) || e.size < 0) throw new TarError(`bad member size ${e.size} for ${e.path}`);
  const h = new Uint8Array(BLOCK);
  const { prefix, name } = splitPath(e.path);
  putString(h, 0, 100, name);
  putOctal(h, 100, 8, e.mode & 0o7777);
  putOctal(h, 108, 8, 0); // uid
  putOctal(h, 116, 8, 0); // gid
  putOctal(h, 124, 12, e.size);
  putOctal(h, 136, 12, Math.max(0, e.mtime));
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  h[156] = 0x30; // '0': regular file
  putString(h, 257, 6, "ustar\0");
  putString(h, 263, 2, "00");
  putString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  putString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** The zero bytes that pad a member of `size` bytes to a block boundary. */
export function tarPadding(size: number): Uint8Array {
  const rem = size % BLOCK;
  return new Uint8Array(rem === 0 ? 0 : BLOCK - rem);
}

/** The end-of-archive marker: two zero blocks. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}

function readString(h: Uint8Array, at: number, width: number): string {
  let end = at;
  while (end < at + width && h[end] !== 0) end++;
  return new TextDecoder("utf-8", { fatal: true }).decode(h.subarray(at, end));
}

function readOctal(h: Uint8Array, at: number, width: number, field: string): number {
  const s = readString(h, at, width).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`tar header: ${field} is not octal (${JSON.stringify(s)})`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new TarError(`tar header: ${field} out of range`);
  return n;
}

function parseHeader(h: Uint8Array): TarEntry {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  const stated = readOctal(h, 148, 8, "checksum");
  if (stated !== sum) throw new TarError("tar header checksum mismatch: the archive is damaged or not a tar");
  if (readString(h, 257, 6) !== "ustar") throw new TarError("not a ustar archive");
  const type = String.fromCharCode(h[156]!);
  if (type !== "0" && type !== "\0") throw new TarError(`tar member type ${JSON.stringify(type)} refused: only regular files are read`);
  const name = readString(h, 0, 100);
  const prefix = readString(h, 345, 155);
  const path = prefix === "" ? name : `${prefix}/${name}`;
  if (!isSafeMemberPath(path)) throw new TarError(`unsafe member path refused: ${JSON.stringify(path)}`);
  return { path, size: readOctal(h, 124, 12, "size"), mode: readOctal(h, 100, 8, "mode") & 0o7777, mtime: readOctal(h, 136, 12, "mtime") };
}

export interface TarHandler {
  /** A member begins; its bytes follow through `data`, then `close`. */
  entry(e: TarEntry): void;
  data(chunk: Uint8Array): void;
  /** The current member's bytes are all delivered. */
  close(): void;
}

/**
 * A push parser: `push` every chunk in order, then `finish`. Callbacks run
 * synchronously inside `push`; a handler that throws stops the parse.
 */
export class TarReader {
  private header = new Uint8Array(BLOCK);
  private headerFill = 0;
  /** Bytes of the current member still to deliver. */
  private remaining = 0;
  /** Padding bytes still to skip after the current member. */
  private skip = 0;
  private inMember = false;
  private ended = false;

  constructor(private readonly on: TarHandler) {}

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length) {
      if (this.ended) {
        // Anything after the end marker must be zeros (a block-size pad).
        for (; at < chunk.length; at++) if (chunk[at] !== 0) throw new TarError("data after the end of the archive");
        return;
      }
      if (this.inMember) {
        const n = Math.min(this.remaining, chunk.length - at);
        if (n > 0) this.on.data(chunk.subarray(at, at + n));
        at += n;
        this.remaining -= n;
        if (this.remaining === 0) {
          this.inMember = false;
          this.on.close();
        }
        continue;
      }
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - at);
        at += n;
        this.skip -= n;
        continue;
      }
      const n = Math.min(BLOCK - this.headerFill, chunk.length - at);
      this.header.set(chunk.subarray(at, at + n), this.headerFill);
      this.headerFill += n;
      at += n;
      if (this.headerFill < BLOCK) continue;
      this.headerFill = 0;
      if (this.header.every((b) => b === 0)) {
        this.ended = true;
        continue;
      }
      const e = parseHeader(this.header);
      this.on.entry(e);
      this.skip = tarPadding(e.size).length;
      if (e.size === 0) this.on.close();
      else {
        this.inMember = true;
        this.remaining = e.size;
      }
    }
  }

  /** The input is over: refuse a truncated archive. */
  finish(): void {
    if (this.inMember || this.headerFill !== 0 || this.skip > 0) throw new TarError("the archive is truncated");
    if (!this.ended) throw new TarError("the archive has no end marker: truncated, or not one this tool wrote");
  }
}
