/**
 * The roster's count of one attempt's turns, which decides whether a rate
 * pause is early saturation (defer) or a mid-episode pause (retry in place).
 *
 * It used to read the whole trajectory as one string. Past ~2 GiB Bun will not
 * decode a string that long, the read threw, and the count answered 0: early
 * saturation, so every later pause of a long freeplay stream climbed the defer
 * ladder. Nothing here writes gigabytes. A small read size makes a small file
 * span hundreds of reads, a reader that throws stands in for the failure, and a
 * reader that refuses any position before the launch offset shows that the
 * earlier attempts' bytes, however many there are, are never read at all.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, readSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadAt } from "../runner/src/models";
import { earlySaturation, launchOffset, turnsSince, type Uncounted } from "./run-roster";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

const rec = (t: string, ts: number, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ t, ts, ...extra })}\n`;

/** Records of a few hundred bytes with multi-byte UTF-8 in them, so a small read size cuts inside characters too. */
function attempt(responses: number, from: number): string {
  let out = rec("resume", from);
  for (let i = 0; i < responses; i++) {
    out += rec("snippet", from + i, { code: "await moveTo(1, 2, 3) // héllo — 世界 🐉".repeat(4) });
    out += rec("response", from + i, { message: { content: `turn ${i}: "response" is the record, 🐉 is not`.repeat(3) } });
  }
  return out;
}

function uncounted(r: number | Uncounted): string {
  if (typeof r === "number") throw new Error(`expected an uncounted result, got ${r}`);
  return r.unknown;
}

const realRead: ReadAt = (fd, buf, off, len, pos) => readSync(fd, buf, off, len, pos);

describe("turnsSince", () => {
  test("an ordinary trajectory: response records by `t`, nothing else", () => {
    const path = join(tempDir("wb-turns-"), "trajectory.jsonl");
    writeFileSync(
      path,
      rec("meta", 1, { note: 'a value that says "response" is not one' }) +
        rec("response", 2) +
        rec("events_served", 3, { events: [] }) +
        rec("response", 4) +
        '{"t":"response", torn\n' +
        rec("pause", 5, { reason: "rate-limited" }) +
        // No newline: the runner has exited, so a final whole record counts.
        JSON.stringify({ t: "response", ts: 6 }),
    );
    expect(turnsSince(path, 0)).toBe(3);
  });

  test("no trajectory before or after the attempt is zero turns, not unknown", () => {
    const path = join(tempDir("wb-turns-"), "trajectory.jsonl");
    expect(launchOffset(path)).toBe(0);
    expect(turnsSince(path, 0)).toBe(0);
  });

  test("a file that grows between attempts: each counts only what it appended", () => {
    const path = join(tempDir("wb-turns-"), "trajectory.jsonl");
    // Attempt 1 launches onto no file and makes one turn.
    const first = launchOffset(path);
    expect(first).toBe(0);
    appendFileSync(path, attempt(1, 100));
    expect(turnsSince(path, first)).toBe(1);

    // Attempt 2 resumes the same run and makes one more. A whole-file count
    // would read "one turn, twice" as a healthy two-turn attempt.
    const second = launchOffset(path);
    expect(second).toBeGreaterThan(0);
    appendFileSync(path, attempt(1, 200));
    expect(turnsSince(path, second)).toBe(1);

    // Attempt 3 is refused before its first turn: genuinely early.
    const third = launchOffset(path);
    appendFileSync(path, rec("resume", 300) + rec("pause", 301, { reason: "rate-limited" }));
    expect(turnsSince(path, third)).toBe(0);
    expect(earlySaturation(0)).toBe(true);

    // And attempt 4 is a long one.
    const fourth = launchOffset(path);
    appendFileSync(path, attempt(40, 400));
    expect(turnsSince(path, fourth)).toBe(40);
  });

  test("records spanning read boundaries count once, at every read size", () => {
    const path = join(tempDir("wb-turns-"), "trajectory.jsonl");
    writeFileSync(path, attempt(3, 100));
    const from = launchOffset(path) as number;
    appendFileSync(path, attempt(5, 200) + JSON.stringify({ t: "response", ts: 299, message: { content: "终" } }));
    for (const chunk of [1, 2, 3, 7, 13, 64, 257, 1 << 22]) {
      expect({ chunk, turns: turnsSince(path, 0, { chunk }) }).toEqual({ chunk, turns: 9 });
      expect({ chunk, turns: turnsSince(path, from, { chunk }) }).toEqual({ chunk, turns: 6 });
    }
  });

  test("the bytes before the launch offset are never read", () => {
    const path = join(tempDir("wb-turns-"), "trajectory.jsonl");
    // The earlier attempts: as far as this count is concerned, they could be 2 GiB.
    writeFileSync(path, attempt(50, 100));
    const from = launchOffset(path) as number;
    appendFileSync(path, attempt(2, 200));
    const positions: number[] = [];
    const guarded: ReadAt = (fd, buf, off, len, pos) => {
      if (pos < from) throw new Error(`read at ${pos}, before the launch offset ${from}`);
      positions.push(pos);
      return realRead(fd, buf, off, len, pos);
    };
    expect(turnsSince(path, from, { chunk: 64, read: guarded })).toBe(2);
    expect(positions[0]).toBe(from);
  });

  test("a read that fails is uncounted: not 0, and not the partial count", () => {
    const path = join(tempDir("wb-turns-"), "trajectory.jsonl");
    writeFileSync(path, attempt(10, 100));
    const size = launchOffset(path) as number;
    let folded = 0;
    // Bun's own failure on an over-long string is a misleading ENOMEM; any
    // read error must land the same way. Halfway in, several whole records
    // have already been folded.
    const failing: ReadAt = (fd, buf, off, len, pos) => {
      if (pos >= size / 2) throw Object.assign(new Error("ENOMEM: not enough memory, read"), { code: "ENOMEM" });
      folded = pos + len;
      return realRead(fd, buf, off, len, pos);
    };
    const r = turnsSince(path, 0, { chunk: 256, read: failing });
    expect(folded).toBeGreaterThan(size / 3);
    expect(uncounted(r)).toContain("ENOMEM");
    expect(uncounted(r)).toContain(path);
    // The same file read without the failure has ten.
    expect(turnsSince(path, 0, { chunk: 256 })).toBe(10);
  });

  test("a trajectory that shrank or vanished since launch is uncounted", () => {
    const path = join(tempDir("wb-turns-"), "trajectory.jsonl");
    writeFileSync(path, attempt(3, 100));
    const from = launchOffset(path) as number;
    truncateSync(path, from - 10);
    expect(uncounted(turnsSince(path, from))).toContain("under the");
    rmSync(path);
    expect(uncounted(turnsSince(path, from))).toContain("under the");
  });

  test("an offset that could not be taken at launch leaves the count unknown", () => {
    const dir = tempDir("wb-turns-");
    const notADir = join(dir, "file");
    writeFileSync(notADir, "");
    // A path through a regular file: the stat fails, and not with ENOENT.
    const launched = launchOffset(join(notADir, "trajectory.jsonl"));
    expect(uncounted(launched)).toContain("would not stat");
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(path, attempt(3, 100));
    expect(uncounted(turnsSince(path, launched))).toContain("size at launch is not known");
  });
});

describe("earlySaturation", () => {
  test("a counted attempt is judged exactly as before: under two turns is early", () => {
    expect([0, 1, 2, 3, 100].map(earlySaturation)).toEqual([true, true, false, false, false]);
  });

  test("an uncounted attempt is not early, so its pause is retried in place rather than deferred", () => {
    expect(earlySaturation(null)).toBe(false);
  });
});
