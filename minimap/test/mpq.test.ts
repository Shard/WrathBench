import { describe, expect, test } from "bun:test";
import { MpqArchive, MpqChain, bufferSource } from "../src/mpq";
import { hashString, normalizePath } from "../src/crypt";
import { buildMpq } from "./fixtures";

function textFile(name: string, text: string, extra: Record<string, boolean> = {}) {
  return { name, data: new TextEncoder().encode(text), ...extra };
}

function decode(data: Uint8Array | undefined): string {
  expect(data).toBeDefined();
  return new TextDecoder().decode(data);
}

describe("crypt", () => {
  test("normalises separators and case before hashing", () => {
    expect(normalizePath("textures/Minimap/a.blp")).toBe("TEXTURES\\MINIMAP\\A.BLP");
    expect(hashString("textures/Minimap/a.blp", 0)).toBe(hashString("TEXTURES\\MINIMAP\\A.BLP", 0));
  });

  test("the three hash types disagree for the same name", () => {
    const name = "textures\\Minimap\\md5translate.trs";
    const [a, b, c] = [hashString(name, 0), hashString(name, 1), hashString(name, 2)];
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("MpqArchive", () => {
  test("round-trips a zlib-compressed multi-sector file", () => {
    const body = "minimap tile line\n".repeat(500);
    const mpq = buildMpq([textFile("textures\\Minimap\\md5translate.trs", body)]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    expect(a.has("textures\\Minimap\\md5translate.trs")).toBe(true);
    expect(decode(a.read("textures\\Minimap\\md5translate.trs"))).toBe(body);
    // Multi-sector: every sector reported zlib.
    expect(a.methods.get(0x02)).toBeGreaterThan(1);
  });

  test("looks names up case- and separator-insensitively", () => {
    const mpq = buildMpq([textFile("textures\\Minimap\\Tile.blp", "x")]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    expect(a.has("TEXTURES/minimap/tile.BLP")).toBe(true);
  });

  test("returns undefined for names the archive does not hold", () => {
    const mpq = buildMpq([textFile("a.txt", "a")]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    expect(a.read("b.txt")).toBeUndefined();
  });

  test("reads stored (uncompressed) sectors", () => {
    // Random-ish bytes: deflate cannot shrink them, so the writer stores them.
    const raw = new Uint8Array(3000);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff;
    const mpq = buildMpq([{ name: "noise.bin", data: raw, stored: true }]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    expect(a.read("noise.bin")).toEqual(raw);
  });

  test("reads single-unit files", () => {
    const body = "single unit payload ".repeat(40);
    const mpq = buildMpq([textFile("single.txt", body, { singleUnit: true })]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    expect(decode(a.read("single.txt"))).toBe(body);
  });

  test("decrypts encrypted files", () => {
    const body = "encrypted payload ".repeat(200);
    const mpq = buildMpq([textFile("dir\\secret.txt", body, { encrypted: true })]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    expect(decode(a.read("dir\\secret.txt"))).toBe(body);
  });

  test("decrypts FIX_KEY files", () => {
    const body = "fixed key payload ".repeat(200);
    const mpq = buildMpq([textFile("dir\\fixed.txt", body, { encrypted: true, fixKey: true })]);
    const a = MpqArchive.fromSource("fixture", bufferSource(mpq));
    expect(decode(a.read("dir\\fixed.txt"))).toBe(body);
  });

  test("rejects a non-MPQ buffer", () => {
    expect(() => MpqArchive.fromSource("junk", bufferSource(new Uint8Array(2048)))).toThrow(
      /not an MPQ archive/,
    );
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

  test("tallies sector compression methods across the chain", () => {
    const a = buildMpq([textFile("a.txt", "aaaa".repeat(500))]);
    const chain = new MpqChain([MpqArchive.fromSource("a", bufferSource(a))]);
    chain.read("a.txt");
    expect([...chain.methods().keys()]).toEqual([0x02]);
  });
});
