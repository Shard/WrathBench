/**
 * Record counting over a trajectory, one-shot and resumable.
 *
 * The resumable form is what a poller uses on a live run — the file grows
 * between every poll and re-reading it whole is what made `/api/models` block
 * the viewer for seconds. Its two load-bearing properties are that a
 * half-written trailing line is held rather than counted (so a resume never
 * double-counts) and that a file which shrank is not resumed at all. Both are
 * asserted here against a whole-file read, which is the definition of right.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RecordCountScanner,
  countModelResponses,
  countRecords,
  countRecordsCached,
  readRunFact,
  readRunFacts,
  type CountCache,
} from "../src/models";

const KINDS = ["response", "pause"] as const;

let dir: string;

/** A trajectory with a mix of kinds, plus the traps: a value that says response, a torn line. */
function lines(): string[] {
  return [
    JSON.stringify({ t: "meta", ts: 1, note: "a value that says \"response\" is not one" }),
    JSON.stringify({ t: "response", ts: 2, message: { content: "hi" } }),
    JSON.stringify({ t: "events_served", ts: 3, events: [] }),
    JSON.stringify({ t: "response", ts: 4, message: { content: "again" } }),
    '{"t":"response", broken',
    JSON.stringify({ t: "pause", ts: 5, reason: "quota" }),
    // Both prefilter needles on one line: only `t` decides, so this is one response.
    JSON.stringify({ t: "response", ts: 6, text: 'the model wrote "pause" in a string' }),
  ];
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-counts-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("countRecords (one-shot)", () => {
  test("counts by `t`, once per line, and pre-seeds every kind asked for", () => {
    const p = join(dir, "a.jsonl");
    writeFileSync(p, `${lines().join("\n")}\n`);
    const n = countRecords(p, KINDS)!;
    expect([...n]).toEqual([
      ["response", 3],
      ["pause", 1],
    ]);
    expect(countModelResponses(p)).toBe(3);
    // A kind nothing carries is zero, never absent.
    expect(countRecords(p, ["snippet"])!.get("snippet")).toBe(0);
  });

  test("an absent file is null, and an empty one is zeros", () => {
    expect(countRecords(join(dir, "nope.jsonl"), KINDS)).toBeNull();
    expect(countModelResponses(join(dir, "nope.jsonl"))).toBeNull();
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(countRecords(empty, KINDS)!.get("response")).toBe(0);
  });

  test("a final record with no terminating newline is still counted", () => {
    const p = join(dir, "b.jsonl");
    writeFileSync(p, `${JSON.stringify({ t: "response", ts: 1 })}\n${JSON.stringify({ t: "response", ts: 2 })}`);
    expect(countRecords(p, KINDS)!.get("response")).toBe(2);
  });

  test("the counts handed back are a copy, not the scanner's own state", () => {
    const p = join(dir, "c.jsonl");
    writeFileSync(p, `${JSON.stringify({ t: "response", ts: 1 })}\n`);
    const scanner = new RecordCountScanner(p, KINDS);
    const first = scanner.countOnce()!;
    first.counts.set("response", 999);
    expect(scanner.scan()!.counts.get("response")).toBe(1);
  });

  test("lines longer than one read chunk are not split mid-record", () => {
    const p = join(dir, "big.jsonl");
    const filler = "x".repeat(300_000);
    const out: string[] = [];
    for (let i = 0; i < 40; i++) out.push(JSON.stringify({ t: i % 4 === 0 ? "response" : "events_served", ts: i, filler }));
    writeFileSync(p, `${out.join("\n")}\n`);
    expect(countRecords(p, KINDS)!.get("response")).toBe(10);
  });
});

describe("countRecordsCached (resumable)", () => {
  /** Fold a file in pieces, cutting deliberately mid-line, and answer the counts. */
  function foldInPieces(p: string, whole: string, cuts: number[]): Map<string, number> {
    const cache: CountCache = new Map();
    writeFileSync(p, "");
    let at = 0;
    let last = countRecordsCached(cache, p, KINDS)!;
    for (const cut of [...cuts, whole.length]) {
      appendFileSync(p, whole.slice(at, cut));
      at = cut;
      last = countRecordsCached(cache, p, KINDS)!;
    }
    return last;
  }

  test("resuming across mid-line cuts equals a whole-file read", () => {
    const whole = `${lines().join("\n")}\n`;
    const p = join(dir, "live.jsonl");
    // Cuts inside the second record, inside the torn line, and just after a newline.
    const nl = whole.indexOf("\n");
    const cuts = [nl + 12, nl + 13, whole.indexOf('"pause"') + 3, whole.lastIndexOf("\n") + 1];
    const resumed = foldInPieces(p, whole, cuts);
    writeFileSync(join(dir, "whole.jsonl"), whole);
    expect([...resumed]).toEqual([...countRecords(join(dir, "whole.jsonl"), KINDS)!]);
  });

  test("a half-written trailing record is held, then counted exactly once", () => {
    const p = join(dir, "half.jsonl");
    const cache: CountCache = new Map();
    const rec = JSON.stringify({ t: "response", ts: 1 });
    writeFileSync(p, rec.slice(0, 10));
    // Held: an incomplete line is not a record.
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(0);
    appendFileSync(p, `${rec.slice(10)}\n`);
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(1);
    // And not again on a poll that appends nothing, nor on one that appends more.
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(1);
    appendFileSync(p, `${JSON.stringify({ t: "response", ts: 2 })}\n`);
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(2);
  });

  test("a file that shrank is re-read from zero, not folded into the old counts", () => {
    const p = join(dir, "trunc.jsonl");
    const cache: CountCache = new Map();
    const rec = (ts: number): string => `${JSON.stringify({ t: "response", ts })}\n`;
    writeFileSync(p, rec(1) + rec(2) + rec(3));
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(3);
    // Truncation: the same path, fewer bytes than the scanner has read.
    truncateSync(p, rec(1).length);
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(1);
    // Replacement by a shorter file with different content, same shape of trap.
    writeFileSync(p, rec(9));
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(1);
    // And it keeps resuming from there.
    appendFileSync(p, rec(10));
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(2);
  });

  test("a cache entry is not reused for a different set of kinds", () => {
    const p = join(dir, "kinds.jsonl");
    const cache: CountCache = new Map();
    writeFileSync(p, `${lines().join("\n")}\n`);
    expect([...countRecordsCached(cache, p, ["response"])!]).toEqual([["response", 3]]);
    expect([...countRecordsCached(cache, p, KINDS)!]).toEqual([
      ["response", 3],
      ["pause", 1],
    ]);
    expect([...countRecordsCached(cache, p, ["response"])!]).toEqual([["response", 3]]);
  });

  test("a whole final record with no newline counts as the one-shot counts it, and once", () => {
    const p = join(dir, "tail.jsonl");
    const cache: CountCache = new Map();
    const rec = (ts: number): string => JSON.stringify({ t: "response", ts });
    writeFileSync(p, `${rec(1)}\n${rec(2)}`);
    expect(countRecords(p, KINDS)!.get("response")).toBe(2);
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(2);
    // The newline that completes it does not count it again.
    appendFileSync(p, "\n");
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(2);
    appendFileSync(p, `${rec(3)}\n`);
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(3);
    expect(countRecords(p, KINDS)!.get("response")).toBe(3);
  });

  test("a vanished file is null and drops its scanner", () => {
    const p = join(dir, "gone.jsonl");
    const cache: CountCache = new Map();
    writeFileSync(p, `${JSON.stringify({ t: "response", ts: 1 })}\n`);
    expect(countRecordsCached(cache, p, KINDS)!.get("response")).toBe(1);
    rmSync(p);
    expect(countRecordsCached(cache, p, KINDS)).toBeNull();
    expect(cache.size).toBe(0);
  });
});

describe("readRunFact with a scanner cache", () => {
  /** A live run: growing trajectory, no termination row, no sqlite. */
  function writeLive(runs: string, id: string, responses: number): void {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(
      join(runs, id, "meta.json"),
      JSON.stringify({ harnessVersion: "harness-0.5-1-gabc", startedAt: 1, config: { model: "m" }, comparability: { episode: "freeplay" } }),
    );
    writeFileSync(
      join(runs, id, "trajectory.jsonl"),
      Array.from({ length: responses }, (_, i) => `${JSON.stringify({ t: "response", ts: i })}\n`).join(""),
    );
  }

  test("a live run's count moves with the file, never served stale", () => {
    const runs = mkdtempSync(join(tmpdir(), "wb-fact-"));
    try {
      writeLive(runs, "live-1", 3);
      const counts: CountCache = new Map();
      expect(readRunFact(runs, "live-1", Date.now(), { counts })!.modelResponses).toBe(3);
      appendFileSync(join(runs, "live-1", "trajectory.jsonl"), `${JSON.stringify({ t: "response", ts: 99 })}\n`);
      expect(readRunFact(runs, "live-1", Date.now(), { counts })!.modelResponses).toBe(4);
      // The cache is an optimisation, never a different answer.
      expect(readRunFact(runs, "live-1")!.modelResponses).toBe(4);
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });
});

describe("readRunFacts with a scanner cache", () => {
  const NOW = 2_000_000_000_000;
  const rec = (t: string, ts: number): string => JSON.stringify({ t, ts });

  function writeRun(runs: string, id: string, body: string): void {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(
      join(runs, id, "meta.json"),
      JSON.stringify({ harnessVersion: "harness-0.5-1-gabc", startedAt: 1, config: { model: "m" }, comparability: { episode: "freeplay" } }),
    );
    writeFileSync(join(runs, id, "trajectory.jsonl"), body);
  }

  /** The cached read against the uncached one, over the same tree at the same moment. */
  function same(runs: string, counts: CountCache): void {
    const cached = readRunFacts(runs, NOW, { includeArchived: true, counts });
    expect(cached).toEqual(readRunFacts(runs, NOW, { includeArchived: true }));
  }

  test("the same facts as a fresh read, across appends, tails and an archive move", () => {
    const runs = mkdtempSync(join(tmpdir(), "wb-facts-"));
    try {
      writeRun(runs, "live-1", `${rec("response", 1)}\n${rec("pause", 2)}\n`);
      writeRun(runs, "done-1", `${rec("response", 1)}\n${rec("response", 2)}\n`);
      const counts: CountCache = new Map();
      same(runs, counts);
      expect(readRunFacts(runs, NOW, { counts }).find((f) => f.runId === "live-1")!.modelResponses).toBe(1);

      const traj = join(runs, "live-1", "trajectory.jsonl");
      appendFileSync(traj, `${rec("response", 3)}\n`);
      same(runs, counts);
      // A torn tail, then a whole one with no newline yet, then its newline.
      appendFileSync(traj, '{"t":"respo');
      same(runs, counts);
      appendFileSync(traj, `nse","ts":4}`);
      same(runs, counts);
      expect(readRunFacts(runs, NOW, { counts }).find((f) => f.runId === "live-1")!.modelResponses).toBe(3);
      appendFileSync(traj, "\n");
      same(runs, counts);

      // Archived by a rename, as the runner archives: the fact follows the run
      // into archive/, and the scanner for the path it left is dropped.
      mkdirSync(join(runs, "archive"));
      renameSync(join(runs, "done-1"), join(runs, "archive", "done-1"));
      same(runs, counts);
      expect([...counts.keys()].sort()).toEqual(
        [join(runs, "archive", "done-1", "trajectory.jsonl"), join(runs, "live-1", "trajectory.jsonl")].sort(),
      );
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });
});
