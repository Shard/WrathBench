/**
 * The record scanner searches for its needles instead of walking every byte
 * (`RecordCountScanner.foldLines`). It has to give exactly the answers the
 * byte loop gave, because the scheduler reads them: a model's turns, the
 * stillborn test and the pause streak are all counted here.
 *
 * The reference is that byte loop itself, kept below as it was in
 * `runner/src/models.ts` before the change (`ByteLoopScanner`). Every case runs
 * both over the same bytes, through the same reads, and compares the counts,
 * the streak and how far each has read: one-shot, resumable across appends cut
 * anywhere, from a starting byte, and through a read that fails. Chunk sizes
 * down to one byte put every boundary the files have on a read edge: a record
 * split across reads, a needle split across reads, a multi-byte character
 * split across reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_RESPONSE_RECORD,
  PAUSE_RECORD,
  pauseCountsOnLadder,
  RecordCountScanner,
  type ReadAt,
  type RecordTally,
  RESUME_RECORD,
} from "../src/models";

// ------------------------------------------------- the byte loop, as it was

interface StreakFold {
  closed: number;
  turn: boolean;
  pause: boolean;
}
function streakOf(s: StreakFold): number {
  const own = s.pause ? 1 : 0;
  return s.turn ? own : s.closed + own;
}
function foldStreak(s: StreakFold, rec: { t: string; reason?: unknown; notBefore?: unknown }): void {
  if (rec.t === MODEL_RESPONSE_RECORD) s.turn = true;
  else if (rec.t === PAUSE_RECORD) s.pause ||= pauseCountsOnLadder(rec);
  else if (rec.t === RESUME_RECORD) {
    s.closed = streakOf(s);
    s.turn = false;
    s.pause = false;
  }
}
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/** `RecordCountScanner` before the needle search: every byte walked, every line taken. */
class ByteLoopScanner {
  readonly path: string;
  readonly kinds: readonly string[];
  readonly pauseStreak: boolean;
  private readonly watched: ReadonlySet<string>;
  private readonly needles: Buffer[];
  private readonly counts: Map<string, number>;
  private readonly streak: StreakFold = { closed: 0, turn: false, pause: false };
  private consumed = 0;
  private pending: Buffer = EMPTY;
  private readonly chunk: number;
  private readonly read: ReadAt;
  private failed: unknown = undefined;

  constructor(path: string, kinds: readonly string[], opts: { pauseStreak?: boolean; from?: number; chunk?: number; read?: ReadAt } = {}) {
    this.path = path;
    this.kinds = [...kinds];
    this.pauseStreak = opts.pauseStreak === true;
    this.watched = new Set([...this.kinds, ...(this.pauseStreak ? [MODEL_RESPONSE_RECORD, PAUSE_RECORD, RESUME_RECORD] : [])]);
    this.needles = [...this.watched].map((k) => Buffer.from(`"${k}"`, "utf8"));
    this.counts = new Map<string, number>(this.kinds.map((k) => [k, 0]));
    this.consumed = opts.from ?? 0;
    this.chunk = opts.chunk ?? 1 << 22;
    this.read = opts.read ?? readSync;
  }

  get size(): number {
    return this.consumed + this.pending.length;
  }

  get failure(): unknown {
    return this.failed;
  }

  private recordOf(line: Buffer): { t: string; reason?: unknown; notBefore?: unknown } | null {
    if (line.length === 0) return null;
    if (!this.needles.some((n) => line.includes(n))) return null;
    let rec: { t?: unknown; reason?: unknown; notBefore?: unknown } | null;
    try {
      rec = JSON.parse(line.toString("utf8")) as { t?: unknown; reason?: unknown; notBefore?: unknown } | null;
    } catch {
      return null;
    }
    const t = rec?.t;
    return typeof t === "string" && this.watched.has(t) ? { t, reason: rec!.reason, notBefore: rec!.notBefore } : null;
  }

  private apply(line: Buffer, counts: Map<string, number>, streak: StreakFold): void {
    const rec = this.recordOf(line);
    if (rec === null) return;
    const n = counts.get(rec.t);
    if (n !== undefined) counts.set(rec.t, n + 1);
    if (this.pauseStreak) foldStreak(streak, rec);
  }

  private take(line: Buffer): void {
    this.apply(line, this.counts, this.streak);
  }

  private fold(buf: Buffer): Buffer {
    let from = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== NEWLINE) continue;
      this.take(buf.subarray(from, i));
      this.consumed += i - from + 1;
      from = i + 1;
    }
    return buf.subarray(from);
  }

  scan(): RecordTally | null {
    this.failed = undefined;
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch (e) {
      this.failed = e;
      return null;
    }
    if (size <= this.size) return this.snapshot();
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      const chunk = Buffer.allocUnsafe(this.chunk);
      let carry = this.pending;
      this.pending = EMPTY;
      let pos = this.consumed + carry.length;
      while (pos < size) {
        const n = this.read(fd, chunk, 0, Math.min(this.chunk, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const fresh = chunk.subarray(0, n);
        const rest = this.fold(carry.length === 0 ? fresh : Buffer.concat([carry, fresh]));
        carry = rest.length === 0 ? EMPTY : Buffer.from(rest);
      }
      this.pending = carry;
    } catch (e) {
      this.failed = e;
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return this.snapshot();
  }

  countOnce(): RecordTally | null {
    const tally = this.scan();
    if (tally === null) return null;
    if (this.pending.length > 0) {
      this.take(this.pending);
      this.consumed += this.pending.length;
      this.pending = EMPTY;
    }
    return this.snapshot();
  }

  scanAsWhole(): RecordTally | null {
    const tally = this.scan();
    if (tally === null || this.pending.length === 0) return tally;
    const streak = { ...this.streak };
    this.apply(this.pending, tally.counts, streak);
    return { counts: tally.counts, pauseStreak: this.pauseStreak ? streakOf(streak) : null };
  }

  private snapshot(): RecordTally {
    return { counts: new Map(this.counts), pauseStreak: this.pauseStreak ? streakOf(this.streak) : null };
  }
}

// ------------------------------------------------------------- the corpus

/** A small deterministic PRNG, so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lines a trajectory has, and the traps around them. No line carries a newline; the file adds them. */
const LINES: readonly string[] = [
  JSON.stringify({ t: "response", ts: 1, message: { content: "hi" } }),
  JSON.stringify({ t: "response", ts: 2, text: 'the model wrote "pause" and "resume" in a string' }),
  JSON.stringify({ t: "response", ts: 3, text: "héllo — 日本語 🎉 ünïcödé" }),
  JSON.stringify({ text: "the t key last, after multi-byte text: 🎉🎉", t: "response" }),
  JSON.stringify({ t: "pause", ts: 4, reason: "rate-limited" }),
  JSON.stringify({ t: "pause", ts: 5, reason: "operator-pause" }),
  JSON.stringify({ t: "pause", ts: 6, reason: "rate-limited", notBefore: 1_800_000_000_000 }),
  JSON.stringify({ t: "resume", ts: 7 }),
  JSON.stringify({ t: "events_served", ts: 8, events: [{ note: 'a value that says "response"' }] }),
  JSON.stringify({ t: "snippet", ts: 9, code: 'log("pause")' }),
  JSON.stringify({ t: "meta", ts: 10, note: "日本語のテキスト" }),
  '{"t":"response", broken',
  '{"t":"respons\\u0065","ts":11}', // decodes to a response, but carries no needle: never counted
  `${JSON.stringify({ t: "response", ts: 12 })}\r`, // CRLF: JSON allows the trailing \r
  `   ${JSON.stringify({ t: "response", ts: 13 })}`,
  "",
  "   ",
  "\r",
  "not json at all, but it says \"response\"",
  JSON.stringify({ t: "response", ts: 14, filler: "x".repeat(700) }),
  JSON.stringify({ t: "events_served", ts: 15, filler: "y".repeat(900), tail: '"response"' }),
];

/** A file of `n` lines drawn from the corpus; `tail` decides how it ends. */
function corpus(seed: number, n: number, tail: "newline" | "whole" | "torn" | "crlf"): string {
  const r = rng(seed);
  const lines = Array.from({ length: n }, () => LINES[Math.floor(r() * LINES.length)]!);
  const body = lines.join("\n");
  if (tail === "newline") return `${body}\n`;
  if (tail === "whole") return `${body}\n${JSON.stringify({ t: "response", ts: 99 })}`;
  if (tail === "torn") return `${body}\n{"t":"respo`;
  return `${lines.join("\r\n")}\r\n`;
}

const KIND_SETS: readonly { kinds: string[]; pauseStreak: boolean }[] = [
  { kinds: [MODEL_RESPONSE_RECORD], pauseStreak: true }, // readRunFact
  { kinds: [MODEL_RESPONSE_RECORD], pauseStreak: false }, // turnsSince, countModelResponses
  { kinds: ["response", "pause"], pauseStreak: false },
  { kinds: ["snippet", "events_served"], pauseStreak: true },
];
const CHUNKS: readonly number[] = [1, 2, 3, 5, 7, 16, 61, 256, 4096, 1 << 22];

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-count-parity-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fileNo = 0;
function fileOf(text: string): string {
  const p = join(dir, `t${fileNo++}.jsonl`);
  writeFileSync(p, text);
  return p;
}

/** What a scanner answered, as a comparable value. */
const view = (t: RecordTally | null) => (t === null ? null : { counts: [...t.counts], pauseStreak: t.pauseStreak });

/** Both scanners over one file with one set of options, every way of asking. */
function expectParity(path: string, opts: { kinds: string[]; pauseStreak: boolean; chunk?: number; from?: number }): void {
  const { kinds, ...rest } = opts;
  const old = new ByteLoopScanner(path, kinds, rest);
  const now = new RecordCountScanner(path, kinds, rest);
  expect(view(now.scanAsWhole())).toEqual(view(old.scanAsWhole()));
  expect(now.size).toBe(old.size);
  expect(view(now.scan())).toEqual(view(old.scan()));
  expect(view(now.countOnce())).toEqual(view(old.countOnce()));
  expect(now.size).toBe(old.size);
}

// ------------------------------------------------------------------ cases

describe("the needle search answers what the byte loop answered", () => {
  test("generated trajectories, every read size, every kind set, every ending", () => {
    for (let seed = 1; seed <= 12; seed++) {
      for (const tail of ["newline", "whole", "torn", "crlf"] as const) {
        const path = fileOf(corpus(seed, 6 + (seed % 9) * 3, tail));
        for (const ks of KIND_SETS) for (const chunk of CHUNKS) expectParity(path, { ...ks, chunk });
      }
    }
  });

  test("CRLF line endings: the \\r stays on the line and JSON reads it as whitespace", () => {
    const path = fileOf(`${JSON.stringify({ t: "response" })}\r\n\r\n${JSON.stringify({ t: "pause", reason: "rate-limited" })}\r\n`);
    const n = new RecordCountScanner(path, ["response", "pause"]).countOnce()!;
    expect([...n.counts]).toEqual([
      ["response", 1],
      ["pause", 1],
    ]);
    for (const chunk of CHUNKS) expectParity(path, { kinds: ["response", "pause"], pauseStreak: true, chunk });
  });

  test("a final line with no newline: whole counts once one-shot and as-whole, never on a resumable scan; torn counts nowhere", () => {
    const whole = fileOf(`${JSON.stringify({ t: "response", ts: 1 })}\n${JSON.stringify({ t: "response", ts: 2 })}`);
    const s = new RecordCountScanner(whole, ["response"]);
    expect(s.scan()!.counts.get("response")).toBe(1);
    expect(s.scanAsWhole()!.counts.get("response")).toBe(2);
    expect(s.countOnce()!.counts.get("response")).toBe(2);
    const torn = fileOf(`${JSON.stringify({ t: "response", ts: 1 })}\n{"t":"response","ts`);
    expect(new RecordCountScanner(torn, ["response"]).countOnce()!.counts.get("response")).toBe(1);
    for (const path of [whole, torn]) for (const chunk of CHUNKS) expectParity(path, { kinds: ["response"], pauseStreak: true, chunk });
  });

  test("a record split across reads, and a needle split across reads, at every cut", () => {
    const rec = JSON.stringify({ t: "response", ts: 1, text: "spans the read edge" });
    const text = `${JSON.stringify({ t: "meta" })}\n${rec}\n${rec}\n`;
    const path = fileOf(text);
    // Every chunk size from one byte to past the file: each puts a read edge somewhere else in the records and their needles.
    for (let chunk = 1; chunk <= text.length + 1; chunk++) {
      expect(new RecordCountScanner(path, ["response"], { chunk }).countOnce()!.counts.get("response")).toBe(2);
      expectParity(path, { kinds: ["response"], pauseStreak: true, chunk });
    }
  });

  test("lines several reads long are joined once and counted once", () => {
    const filler = "z".repeat(50_000);
    const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ t: i % 3 === 0 ? "response" : "events_served", i, filler }));
    const path = fileOf(`${lines.join("\n")}\n`);
    // ~50 reads a line at 997 bytes; one byte at a time is the other tests' job (the reference is quadratic in it).
    for (const chunk of [997, 4096, 1 << 22]) {
      expect(new RecordCountScanner(path, ["response"], { chunk }).countOnce()!.counts.get("response")).toBe(4);
      expectParity(path, { kinds: ["response"], pauseStreak: true, chunk });
    }
  });

  test("empty and whitespace-only lines count nothing and move the byte count all the same", () => {
    const path = fileOf(`\n\n${JSON.stringify({ t: "response" })}\n\n   \n\r\n\n`);
    const s = new RecordCountScanner(path, ["response"]);
    expect(s.countOnce()!.counts.get("response")).toBe(1);
    expect(s.size).toBe(statSync(path).size);
    for (const chunk of CHUNKS) expectParity(path, { kinds: ["response"], pauseStreak: true, chunk });
  });

  test("multi-byte UTF-8 split across a read edge decodes whole, before and after the needle", () => {
    const rec = JSON.stringify({ pre: "日本語🎉é", t: "response", post: "🎉日本語é" });
    const path = fileOf(`${rec}\n${rec}\n${JSON.stringify({ t: "pause", reason: "ünïcödé-limit" })}\n`);
    const bytes = statSync(path).size;
    for (let chunk = 1; chunk <= bytes; chunk++) {
      const s = new RecordCountScanner(path, ["response"], { pauseStreak: true, chunk });
      const t = s.countOnce()!;
      expect(t.counts.get("response")).toBe(2);
      expect(t.pauseStreak).toBe(1); // a ladder reason, after the turns
      expectParity(path, { kinds: ["response"], pauseStreak: true, chunk });
    }
  });

  test("from a starting byte, anywhere in the file, including mid-line and mid-character", () => {
    const text = corpus(7, 20, "whole");
    const path = fileOf(text);
    const bytes = Buffer.byteLength(text);
    for (let from = 0; from <= bytes; from += 29) {
      for (const chunk of [1, 5, 4096]) expectParity(path, { kinds: [MODEL_RESPONSE_RECORD], pauseStreak: false, from, chunk });
    }
  });

  test("resumable across appends cut anywhere: the same tally and the same size after every poll", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const text = Buffer.from(corpus(seed * 31, 25, seed % 2 === 0 ? "whole" : "torn"));
      const r = rng(seed);
      for (const chunk of [1, 3, 64, 1 << 22]) {
        const path = join(dir, `live-${seed}-${chunk}.jsonl`);
        writeFileSync(path, "");
        const old = new ByteLoopScanner(path, [MODEL_RESPONSE_RECORD], { pauseStreak: true, chunk });
        const now = new RecordCountScanner(path, [MODEL_RESPONSE_RECORD], { pauseStreak: true, chunk });
        let at = 0;
        while (at < text.length) {
          // Cuts land mid-record, mid-needle and mid-character as often as not.
          const cut = Math.min(text.length, at + 1 + Math.floor(r() * 90));
          appendFileSync(path, text.subarray(at, cut));
          at = cut;
          expect(view(now.scanAsWhole())).toEqual(view(old.scanAsWhole()));
          expect(now.size).toBe(old.size);
        }
        expect(view(now.countOnce())).toEqual(view(old.countOnce()));
      }
    }
  });

  test("a read that fails part-way: null and the same reason, then the same resume", () => {
    const text = corpus(5, 30, "newline");
    const path = fileOf(text);
    for (const failAt of [1, 2, 5, 9]) {
      const failing = (): ReadAt => {
        let calls = 0;
        return (fd, buf, off, len, pos) => {
          calls++;
          if (calls === failAt) throw new Error("EIO: i/o error, read");
          return readSync(fd, buf, off, len, pos);
        };
      };
      const old = new ByteLoopScanner(path, [MODEL_RESPONSE_RECORD], { pauseStreak: true, chunk: 97, read: failing() });
      const now = new RecordCountScanner(path, [MODEL_RESPONSE_RECORD], { pauseStreak: true, chunk: 97, read: failing() });
      expect(view(now.scan())).toEqual(view(old.scan()));
      expect(String(now.failure)).toBe(String(old.failure));
      expect(now.size).toBe(old.size);
      // The next poll resumes from the last whole line, as before.
      expect(view(now.scan())).toEqual(view(old.scan()));
      expect(now.size).toBe(old.size);
      expect(view(now.countOnce())).toEqual(view(old.countOnce()));
    }
  });
});
