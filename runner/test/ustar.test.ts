/**
 * The character archive's tar (`ustar.ts`): what it writes, the system `tar`
 * reads, and what it reads back is byte for byte what went in, whatever the
 * chunking; and it refuses every member shape it never writes.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeMemberPath, tarEnd, tarHeader, tarPadding, TarError, TarReader, type TarEntry } from "../src/ustar";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

function build(members: { path: string; body: Uint8Array; mode?: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const m of members) {
    parts.push(tarHeader({ path: m.path, size: m.body.length, mode: m.mode ?? 0o644, mtime: 1_760_000_000 }), m.body, tarPadding(m.body.length));
  }
  parts.push(tarEnd());
  return Buffer.concat(parts);
}

function read(bytes: Uint8Array, chunk: number): { entry: TarEntry; body: string }[] {
  const out: { entry: TarEntry; body: string }[] = [];
  let cur: { entry: TarEntry; parts: Buffer[] } | null = null;
  const r = new TarReader({
    entry: (e) => {
      cur = { entry: e, parts: [] };
    },
    data: (c) => {
      cur!.parts.push(Buffer.from(c));
    },
    close: () => {
      out.push({ entry: cur!.entry, body: Buffer.concat(cur!.parts).toString("utf8") });
      cur = null;
    },
  });
  for (let at = 0; at < bytes.length; at += chunk) r.push(bytes.subarray(at, at + chunk));
  r.finish();
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);
const LONG = `claude-config/projects/${"-tmp-wrathbench-claude-AbCdEf".repeat(2)}/0f6c1b7e-6a0e-4a43-9f7b-3d2c1e0a9b8c.jsonl`;

describe("ustar", () => {
  const members = [
    { path: "manifest.json", body: enc('{"a":1}\n') },
    { path: "run/empty.md", body: new Uint8Array(0) },
    { path: "run/exactly-a-block", body: new Uint8Array(512).fill(65) },
    { path: `run/${LONG}`, body: enc("x".repeat(1500)), mode: 0o664 },
  ];

  test("reads back what it wrote, at any chunking", () => {
    const bytes = build(members);
    for (const chunk of [1, 7, 511, 512, 513, 4096, bytes.length]) {
      const got = read(bytes, chunk);
      expect(got.map((g) => g.entry.path)).toEqual(members.map((m) => m.path));
      expect(got.map((g) => g.body)).toEqual(members.map((m) => Buffer.from(m.body).toString("utf8")));
      expect(got[3]!.entry.mode).toBe(0o664);
      expect(got[3]!.entry.mtime).toBe(1_760_000_000);
    }
  });

  test.skipIf(Bun.which("tar") === null)("the system tar lists it, long path and all", () => {
    const file = join(tempDir("wb-ustar-"), "a.tar");
    writeFileSync(file, build(members));
    const r = Bun.spawnSync(["tar", "-tf", file], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().split("\n")).toEqual(members.map((m) => m.path));
  });

  test("refuses unsafe paths when writing and when reading", () => {
    for (const p of ["/etc/passwd", "../x", "run/../../x", "run//x", "run/./x", "", "a\\b"]) {
      expect(isSafeMemberPath(p)).toBe(false);
      expect(() => tarHeader({ path: p, size: 0, mode: 0o644, mtime: 0 })).toThrow(TarError);
    }
    // A header forged with `..`, its checksum made right: still refused.
    const h = tarHeader({ path: "run/aa/x", size: 0, mode: 0o644, mtime: 0 });
    h.set(enc("run/../x"), 0);
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    expect(() => read(Buffer.concat([h, tarEnd()]), 512)).toThrow(/unsafe member path/);
  });

  test("refuses links and other member types, a bad checksum, and a truncated archive", () => {
    const link = tarHeader({ path: "run/l", size: 0, mode: 0o777, mtime: 0 });
    link[156] = 0x32; // '2': symlink
    link.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of link) sum += b;
    link.set(enc(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    expect(() => read(Buffer.concat([link, tarEnd()]), 512)).toThrow(/only regular files/);

    const bytes = build(members);
    const damaged = Buffer.from(bytes);
    damaged[10] = damaged[10]! ^ 0xff;
    expect(() => read(damaged, 512)).toThrow(/checksum/);

    expect(() => read(bytes.subarray(0, 1024 + 100), 512)).toThrow(/truncated/);
    expect(() => read(bytes.subarray(0, bytes.length - 1024), 512)).toThrow(/no end marker/);
  });
});
