/**
 * The tail's incremental figures equal the whole-list derivations they stand in
 * for, at every point a live run can be read at.
 *
 * The run page and every open SSE stream used to call `tokenTotals`,
 * `tokensPerSecond`, `reportedCostUsd` and `responseCostCoverage` over every
 * entry the run ever wrote, per poll and per batch. The tail now accumulates
 * the cost as it indexes and keeps the token and speed derivations, over the
 * subset of entries they read, until it grows. Nothing may move by doing so:
 * this appends a varied trajectory one line at a time and compares after each.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEGMENT_MARKS, segmentsFrom } from "../viewer/sessions";
import { TrajectoryTail, reportedCostUsd, responseCostCoverage, tokenTotals, tokensPerSecond } from "../viewer/tail";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** A claude-code run across a pause and a second session, with every record kind the derivations read and some they skip. */
const CLAUDE: object[] = [
  { t: "meta", ts: 1000 },
  { t: "driver", ts: 1001, driver: { name: "claude-code", usage: "turn-snapshot" } },
  { t: "claude_system", ts: 1050, turn: 1, type: "system", subtype: "init", session_id: "s-1", model: "claude-x" },
  { t: "claude_system", ts: 1060, turn: 1, type: "system", subtype: "thinking_tokens", session_id: "s-1", estimated_tokens: 9 },
  { t: "request", ts: 2000, turn: 1, messages: [{ role: "user", content: "hello" }] },
  { t: "state", ts: 2100, level: 1, xp: 0 },
  { t: "response", ts: 3000, turn: 1, message: { role: "assistant", content: "hi" }, usage: { prompt_tokens: 500, completion_tokens: 2 } },
  { t: "snippet_result", ts: 3500, turn: 1, text: "ok" },
  { t: "event", ts: 3600, name: "SMSG_X" },
  { t: "response", ts: 5000, turn: 1, message: { role: "assistant", content: "again" }, usage: { prompt_tokens: 700, completion_tokens: 3 } },
  {
    t: "claude_result", ts: 6000, turn: 1, subtype: "success", isError: false, numTurns: 2,
    durationMs: 4000, durationApiMs: 2000, costUsd: 0.5,
    usageRaw: { input_tokens: 10, output_tokens: 5000, iterations: [{ output_tokens: 900 }] },
    usage: { prompt_tokens: 1200, completion_tokens: 5000, total_tokens: 6200 },
  },
  { t: "response", ts: 6500, turn: 2, message: { role: "assistant", content: "cut off" }, usage: { prompt_tokens: 800, completion_tokens: 4 } },
  { t: "pause", ts: 7000, reason: "rate-limited" },
  { t: "resume", ts: 9000 },
  { t: "claude_system", ts: 9050, turn: 3, type: "system", subtype: "init", session_id: "s-2", model: "claude-x" },
  { t: "request", ts: 9100, turn: 3, messages: [{ role: "user", content: "back" }] },
  { t: "response", ts: 9900, turn: 3, message: { role: "assistant", content: "ok" }, usage: { prompt_tokens: 900, completion_tokens: 30, cached_tokens: 400 } },
  { t: "tool_result", ts: 9950, turn: 3, text: "done" },
  { t: "response", ts: 10_400, turn: 3, message: { role: "assistant", content: "more" } },
  { t: "claude_result", ts: 11_000, turn: 3, sessionId: "s-2", costUsd: 0.2, usageRaw: { output_tokens: 70 } },
  { t: "termination", ts: 12_000, reason: "episode-complete" },
];

/** A fixed-loop OpenRouter run: per-response charges, some missing, and an estimate-only turn. */
const FIXED: (object | string)[] = [
  { t: "meta", ts: 1000 },
  { t: "request", ts: 1100, turn: 1, promptChars: 4000 },
  { t: "response", ts: 1900, turn: 1, message: { role: "assistant", content: "a" }, usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.01 } },
  { t: "snippet", ts: 2000, turn: 1, code: "1" },
  { t: "request", ts: 2100, turn: 2, promptChars: 4400 },
  { t: "response", ts: 2600, turn: 2, message: { role: "assistant", content: "bb" }, usage: { prompt_tokens: 1100, completion_tokens: 40 } },
  "not json at all",
  { t: "request", ts: 3100, turn: 3, promptChars: 4800 },
  { t: "response", ts: 3700, turn: 3, message: { role: "assistant", content: "ccc" } },
  { t: "driver", ts: 3800, driver: { name: "codex", usage: "exec-tally" } },
  { t: "request", ts: 3900, turn: 4, promptChars: 5000 },
  { t: "response", ts: 4500, turn: 4, message: { role: "assistant", content: "d" }, usage: { prompt_tokens: 1300, completion_tokens: 20, cost: 0.02 }, lastCall: { prompt_tokens: 600, context_window: 200_000 } },
];

function marksOf(entries: readonly { t: string; ts: number }[]): { t: string; ts: number }[] {
  const out: { t: string; ts: number }[] = [];
  for (const e of entries) if (e.ts > 0 && (SEGMENT_MARKS.has(e.t) || out.length === 0)) out.push({ t: e.t, ts: e.ts });
  return out;
}

function expectParity(tail: TrajectoryTail): void {
  const e = tail.entries;
  expect(tail.tokens).toEqual(tokenTotals(e));
  expect(tail.tps).toEqual(tokensPerSecond(e));
  expect(tail.reportedCostUsd).toEqual(reportedCostUsd(e));
  expect(tail.costCoverage).toEqual(responseCostCoverage(e));
  expect(tail.segmentMarks).toEqual(marksOf(e));
  expect(segmentsFrom(tail.segmentMarks)).toEqual(segmentsFrom(marksOf(e)));
}

describe("the tail's accumulated figures", () => {
  for (const [name, lines] of [["claude-code", CLAUDE], ["fixed loop", FIXED]] as const) {
    test(`equal the whole-list derivations after every appended line: ${name}`, async () => {
      const path = join(tempDir("viewer-tail-acc-"), "trajectory.jsonl");
      writeFileSync(path, "");
      const tail = new TrajectoryTail(path);
      for (const line of lines) {
        appendFileSync(path, (typeof line === "string" ? line : JSON.stringify(line)) + "\n");
        await tail.scan();
        expectParity(tail);
      }
      // Asked twice without growth: the memo answers, and still agrees.
      const first = tail.tokens;
      expect(tail.tokens).toBe(first);
      expectParity(tail);
    });
  }

  test("a truncated file rebuilds them from nothing, and bumps the generation", async () => {
    const path = join(tempDir("viewer-tail-acc-"), "trajectory.jsonl");
    writeFileSync(path, CLAUDE.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const tail = new TrajectoryTail(path);
    await tail.scan();
    const before = tail.generation;
    expect(tail.reportedCostUsd).toBeCloseTo(0.7);
    writeFileSync(path, FIXED.slice(0, 3).map((l) => JSON.stringify(l)).join("\n") + "\n");
    await tail.scan();
    expect(tail.generation).toBe(before + 1);
    expect(tail.entries.length).toBe(3);
    expectParity(tail);
    expect(tail.reportedCostUsd).toBeCloseTo(0.01);
  });
});
