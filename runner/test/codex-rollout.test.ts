import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CodexLastCallReader,
  findRollout,
  lastCallOfLine,
  lastCallOfRollout,
  lastCallOfText,
} from "../src/codex-rollout";
import { tempDirs } from "./fixtures/temp-dirs";

const tmp = tempDirs();
const THREAD = "01a119da-ef89-7a63-ac51-314ac6a70a52";

/** A `token_count` line in the shape the CLI writes, trimmed of rate limits. */
function tokenCount(last: { in: number; cached: number; out: number }, window: number | null = 258_400): string {
  return JSON.stringify({
    timestamp: "2026-10-08T07:18:10.007Z",
    ordinal: 7000,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 999_999_999, cached_input_tokens: 1, output_tokens: 1, total_tokens: 1 },
        last_token_usage: {
          input_tokens: last.in,
          cached_input_tokens: last.cached,
          cache_write_input_tokens: 0,
          output_tokens: last.out,
          reasoning_output_tokens: 5,
          total_tokens: last.in + last.out,
        },
        ...(window !== null ? { model_context_window: window } : {}),
      },
      rate_limits: { limit_id: "codex" },
    },
  });
}

const filler = (n: number): string => JSON.stringify({ type: "response_item", payload: { text: "x".repeat(n) } });

function home(lines: string[], thread = THREAD): { home: string; file: string } {
  const h = tmp("codex-rollout-");
  const dir = join(h, "sessions", "2026", "10", "08");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-08T04-52-21-${thread}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  return { home: h, file };
}

describe("lastCallOfLine", () => {
  test("normalises last_token_usage the way codex-usage does, with the window", () => {
    expect(lastCallOfLine(tokenCount({ in: 240_051, cached: 238_336, out: 128 }))).toEqual({
      prompt_tokens: 240_051,
      completion_tokens: 128,
      cached_tokens: 238_336,
      context_window: 258_400,
    });
  });

  test("a missing window is absent, not zero", () => {
    expect(lastCallOfLine(tokenCount({ in: 10, cached: 0, out: 1 }, null))).toEqual({
      prompt_tokens: 10,
      completion_tokens: 1,
      cached_tokens: 0,
    });
  });

  test("a token_count with null info, or another record kind, is nothing", () => {
    const nullInfo = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } });
    expect(lastCallOfLine(nullInfo)).toBeUndefined();
    expect(lastCallOfLine(JSON.stringify({ type: "event_msg", payload: { type: "other", note: "token_count" } }))).toBeUndefined();
  });
});

describe("lastCallOfRollout", () => {
  test("takes the LAST token_count and ignores the records after it", () => {
    const { file } = home([tokenCount({ in: 100, cached: 0, out: 1 }), tokenCount({ in: 200, cached: 50, out: 2 }), filler(50)]);
    expect(lastCallOfRollout(file)?.prompt_tokens).toBe(200);
  });

  test("a malformed line, even a truncated token_count, is passed over for the one before", () => {
    const bad = tokenCount({ in: 300, cached: 0, out: 3 }).slice(0, 120);
    const { file } = home([tokenCount({ in: 200, cached: 0, out: 2 }), bad, "not json at all"]);
    expect(lastCallOfRollout(file)?.prompt_tokens).toBe(200);
  });

  test("reads only the tail: a token_count in the head, past the first read, is found by the one widening", () => {
    const { file } = home([tokenCount({ in: 111, cached: 0, out: 1 }), filler(4000), filler(4000)]);
    // 1 KiB first read holds no token_count; the widened 64 KiB read does.
    expect(lastCallOfRollout(file, { tailBytes: 1024, wideBytes: 64 * 1024 })?.prompt_tokens).toBe(111);
    // Widening is bounded: with the head out of reach there is no figure, and no whole-file read.
    expect(lastCallOfRollout(file, { tailBytes: 1024, wideBytes: 2048 })).toBeUndefined();
  });

  test("a token_count straddling the read boundary is dropped, not half-parsed, and the earlier one stands", () => {
    const early = tokenCount({ in: 100, cached: 0, out: 1 });
    const straddler = tokenCount({ in: 777, cached: 0, out: 7 });
    const tail = filler(300);
    const { file } = home([early, straddler, tail]);
    // The read starts in the middle of the straddler: its fragment is the discarded first line.
    const bytes = tail.length + 1 + Math.floor(straddler.length / 2);
    expect(lastCallOfRollout(file, { tailBytes: bytes, wideBytes: bytes })).toBeUndefined();
    // Reading far enough back to hold it whole finds it.
    expect(lastCallOfRollout(file, { tailBytes: tail.length + 1 + straddler.length + 1 })?.prompt_tokens).toBe(777);
  });

  test("lastCallOfText skips a partial head line only when told the chunk is partial", () => {
    const line = tokenCount({ in: 5, cached: 0, out: 1 });
    expect(lastCallOfText(line, false)?.prompt_tokens).toBe(5);
    expect(lastCallOfText(line, true)).toBeUndefined();
  });
});

describe("findRollout and the reader", () => {
  test("finds the thread's rollout by id under sessions/ and nothing else", () => {
    const { home: h, file } = home([tokenCount({ in: 1, cached: 0, out: 1 })]);
    expect(findRollout(h, THREAD)).toBe(file);
    expect(findRollout(h, "01a119da-0000-0000-0000-000000000000")).toBeUndefined();
    expect(findRollout(h, "*")).toBeUndefined();
    expect(findRollout(join(h, "nope"), THREAD)).toBeUndefined();
  });

  test("no file: absent figure, one note per run however many turns follow", () => {
    const h = tmp("codex-rollout-");
    const notes: string[] = [];
    const reader = new CodexLastCallReader(h, (r) => notes.push(r));
    expect(reader.read(THREAD)).toBeUndefined();
    expect(reader.read(THREAD)).toBeUndefined();
    expect(reader.read(undefined)).toBeUndefined();
    expect(notes).toHaveLength(1);
  });

  test("an onFailure that throws never reaches the caller", () => {
    const reader = new CodexLastCallReader(undefined, () => {
      throw new Error("log failed");
    });
    expect(reader.read(THREAD)).toBeUndefined();
  });

  test("caches the path per thread and reads the new tail each turn", () => {
    const { home: h, file } = home([tokenCount({ in: 100, cached: 0, out: 1 })]);
    const reader = new CodexLastCallReader(h, () => {});
    expect(reader.read(THREAD)?.prompt_tokens).toBe(100);
    writeFileSync(file, [tokenCount({ in: 100, cached: 0, out: 1 }), tokenCount({ in: 150, cached: 0, out: 1 })].join("\n") + "\n");
    expect(reader.read(THREAD)?.prompt_tokens).toBe(150);
  });

  test("an unreadable rollout is an absent figure, not a throw", () => {
    const { home: h, file } = home([tokenCount({ in: 100, cached: 0, out: 1 })]);
    const notes: string[] = [];
    const reader = new CodexLastCallReader(h, (r) => notes.push(r));
    expect(reader.read(THREAD)?.prompt_tokens).toBe(100);
    writeFileSync(file, "");
    expect(reader.read(THREAD)).toBeUndefined();
    expect(notes).toHaveLength(1);
  });
});
