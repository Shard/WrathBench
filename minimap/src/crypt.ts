/**
 * MPQ cryptography: the Blizzard crypt table, string hash and block decryption.
 *
 * The crypt table is 0x500 u32 values generated from a fixed LCG seed; every
 * MPQ hash and every encrypted table in the archive derives from it.
 */

function buildCryptTable(): Uint32Array {
  const table = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let index1 = 0; index1 < 0x100; index1++) {
    for (let index2 = index1, i = 0; i < 5; i++, index2 += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const temp1 = (seed & 0xffff) << 0x10;
      seed = (seed * 125 + 3) % 0x2aaaab;
      const temp2 = seed & 0xffff;
      table[index2] = (temp1 | temp2) >>> 0;
    }
  }
  return table;
}

export const CRYPT_TABLE: Uint32Array = buildCryptTable();

/** Hash types used by {@link hashString}. */
export const HASH_TABLE_OFFSET = 0;
export const HASH_NAME_A = 1;
export const HASH_NAME_B = 2;
export const HASH_FILE_KEY = 3;

/**
 * Normalise an MPQ path the way the game does before hashing: forward slashes
 * become backslashes and everything is upper-cased (ASCII).
 */
export function normalizePath(name: string): string {
  return name.replace(/\//g, "\\").toUpperCase();
}

/** The Blizzard string hash. `name` is normalised internally. */
export function hashString(name: string, hashType: number): number {
  const s = normalizePath(name);
  let seed1 = 0x7fed7fed;
  let seed2 = 0xeeeeeeee;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i) & 0xff;
    const t = CRYPT_TABLE[(hashType << 8) + ch] ?? 0;
    seed1 = (t ^ (seed1 + seed2)) >>> 0;
    seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
  }
  return seed1 >>> 0;
}

/**
 * Decrypt an encrypted MPQ block in place. `data` is interpreted as an array of
 * little-endian u32; trailing bytes that do not fill a u32 are left untouched
 * (that is what the reference implementation does too).
 */
export function decryptBlock(data: Uint8Array, key: number): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const words = Math.floor(data.byteLength / 4);
  let k = key >>> 0;
  let seed2 = 0xeeeeeeee;
  for (let i = 0; i < words; i++) {
    seed2 = (seed2 + (CRYPT_TABLE[0x400 + (k & 0xff)] ?? 0)) >>> 0;
    const ch = (view.getUint32(i * 4, true) ^ ((k + seed2) >>> 0)) >>> 0;
    k = ((((~k << 0x15) >>> 0) + 0x11111111) | (k >>> 0x0b)) >>> 0;
    seed2 = (ch + seed2 + (seed2 << 5) + 3) >>> 0;
    view.setUint32(i * 4, ch, true);
  }
}

/** Encrypt a block in place (inverse of {@link decryptBlock}); used by tests. */
export function encryptBlock(data: Uint8Array, key: number): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const words = Math.floor(data.byteLength / 4);
  let k = key >>> 0;
  let seed2 = 0xeeeeeeee;
  for (let i = 0; i < words; i++) {
    seed2 = (seed2 + (CRYPT_TABLE[0x400 + (k & 0xff)] ?? 0)) >>> 0;
    const plain = view.getUint32(i * 4, true);
    const enc = (plain ^ ((k + seed2) >>> 0)) >>> 0;
    k = ((((~k << 0x15) >>> 0) + 0x11111111) | (k >>> 0x0b)) >>> 0;
    seed2 = (plain + seed2 + (seed2 << 5) + 3) >>> 0;
    view.setUint32(i * 4, enc, true);
  }
}

/** The base decryption key of a file is the hash of its *basename*. */
export function fileKey(archivePath: string): number {
  const norm = normalizePath(archivePath);
  const idx = norm.lastIndexOf("\\");
  const base = idx >= 0 ? norm.slice(idx + 1) : norm;
  return hashString(base, HASH_FILE_KEY);
}
