import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { crc32, encodePng } from "../src/png";

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
