import { describe, expect, test } from "bun:test";
import { MpqArchive, MpqChain, bufferSource } from "../src/mpq";
import { buildMpq } from "./fixtures";

function textFile(name: string, text: string, extra: Record<string, boolean> = {}) {
  return { name, data: new TextEncoder().encode(text), ...extra };
}

function decode(data: Uint8Array | undefined): string {
  expect(data).toBeDefined();
  return new TextDecoder().decode(data);
}

describe("MpqArchive", () => {
  test("round-trips every sector layout: zlib multi-sector, stored, single-unit, encrypted, FIX_KEY", () => {
    // Random-ish bytes: deflate cannot shrink them, so the writer stores them.
    const noise = new Uint8Array(3000);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff;
    const files = {
      zlib: "minimap tile line\n".repeat(500),
      single: "single unit payload ".repeat(40),
      secret: "encrypted payload ".repeat(200),
      fixed: "fixed key payload ".repeat(200),
    };
    const mpq = buildMpq([
      textFile("textures\\Minimap\\md5translate.trs", files.zlib),
      { name: "noise.bin", data: noise, stored: true },
      textFile("single.txt", files.single, { singleUnit: true }),
      textFile("dir\\secret.txt", files.secret, { encrypted: true }),
      textFile("dir\\fixed.txt", files.fixed, { encrypted: true, fixKey: true }),
    ]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    // Names are looked up case- and separator-insensitively.
    expect(decode(a.read("TEXTURES/minimap/MD5TRANSLATE.trs"))).toBe(files.zlib);
    expect(a.read("noise.bin")).toEqual(noise);
    expect(decode(a.read("single.txt"))).toBe(files.single);
    expect(decode(a.read("dir\\secret.txt"))).toBe(files.secret);
    expect(decode(a.read("dir\\fixed.txt"))).toBe(files.fixed);
    // Multi-sector: every sector reported zlib.
    expect(a.methods.get(0x02)).toBeGreaterThan(1);
  });
});

describe("MpqChain", () => {
  test("later archives override earlier ones", () => {
    const base = buildMpq([textFile("shared.txt", "base"), textFile("only-base.txt", "kept")]);
    const patch = buildMpq([textFile("shared.txt", "patched")]);
    const chain = new MpqChain([
      MpqArchive.fromSource("common", bufferSource(base)),
      MpqArchive.fromSource("patch", bufferSource(patch)),
    ]);
    expect(decode(chain.read("shared.txt"))).toBe("patched");
    expect(chain.provider("shared.txt")).toBe("patch");
    expect(decode(chain.read("only-base.txt"))).toBe("kept");
    expect(chain.provider("only-base.txt")).toBe("common");
    expect(chain.read("absent.txt")).toBeUndefined();
  });
});
