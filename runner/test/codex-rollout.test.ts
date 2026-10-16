import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_THREAD_FILE,
  pruneRollouts,
  readCodexThread,
  removeThreadRollouts,
  rolloutThreadId,
  writeCodexThread,
  CodexLastCallReader,
  CodexRolloutFollower,
  CodexRolloutScan,
  rateLimitsOfLine,
  turnModelOfLine,
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

// ------------------------------------------------------------ usage windows

/** A `token_count` line carrying a `rate_limits` block in the CLI's shape. Synthetic figures only. */
function withLimits(rateLimits: unknown): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }, model_context_window: 475_000 },
      rate_limits: rateLimits,
    },
  });
}

const LIMITS = (primaryUsed: number, resetS = 1_900_000_000, secondary: unknown = null): Record<string, unknown> => ({
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: primaryUsed, window_minutes: 10_080, resets_at: resetS },
  secondary,
  credits: { has_credits: true, unlimited: false, balance: "12" },
  individual_limit: null,
  spend_control_reached: null,
  plan_type: "synthetic-plan",
  rate_limit_reached_type: null,
});

describe("rateLimitsOfLine", () => {
  test("keeps each window's used percent, length and reset (in ms), and nothing else", () => {
    const out = rateLimitsOfLine(withLimits(LIMITS(42.5, 1_900_000_000, { used_percent: 7, window_minutes: 300, resets_at: 1_899_990_000 })));
    expect(out).toEqual([
      { usedPercent: 42.5, windowMinutes: 10_080, resetsAt: 1_900_000_000_000 },
      { usedPercent: 7, windowMinutes: 300, resetsAt: 1_899_990_000_000 },
    ]);
    // Never the credits, the plan type or any other field of the block.
    const text = JSON.stringify(out);
    for (const word of ["credits", "plan", "synthetic-plan", "balance", "limit_id", "codex"]) expect(text).not.toContain(word);
  });

  test("a null rate_limits, a null window and a line that is not a token_count read as nothing", () => {
    expect(rateLimitsOfLine(withLimits(null))).toBeUndefined();
    expect(rateLimitsOfLine(withLimits({ limit_id: "codex", primary: null, secondary: null }))).toBeUndefined();
    expect(rateLimitsOfLine(withLimits(LIMITS(10)))).toHaveLength(1);
    expect(rateLimitsOfLine(JSON.stringify({ type: "response_item", payload: { type: "message", rate_limits: LIMITS(10) } }))).toBeUndefined();
    expect(rateLimitsOfLine("{not json")).toBeUndefined();
  });
});

describe("turnModelOfLine", () => {
  test("names the model a turn_context line carries, and nothing for any other line", () => {
    expect(turnModelOfLine(JSON.stringify({ type: "turn_context", payload: { turn_id: "t", model: "gpt-5.5", summary: "auto" } }))).toBe("gpt-5.5");
    expect(turnModelOfLine(JSON.stringify({ type: "turn_context", payload: { model: "" } }))).toBeUndefined();
    expect(turnModelOfLine(JSON.stringify({ type: "response_item", payload: { text: "the turn_context said nothing" } }))).toBeUndefined();
  });
});

describe("CodexRolloutScan usage windows", () => {
  test("keeps the newest window; a null rate_limits never erases the one before", () => {
    const scan = new CodexRolloutScan();
    scan.line(withLimits(LIMITS(20)));
    scan.line(withLimits(LIMITS(35)));
    scan.line(withLimits(null));
    expect(scan.rateLimits).toEqual([{ usedPercent: 35, windowMinutes: 10_080, resetsAt: 1_900_000_000_000 }]);
    // The token_count still counts as a context reading.
    expect(scan.context).toEqual({ total: 11, window: 475_000 });
  });

  test("the follower answers the windows and the turn model beside the context", () => {
    const { home: h } = home([JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.5" } }), withLimits(LIMITS(61))]);
    const follower = new CodexRolloutFollower(h, () => {});
    const read = follower.read(THREAD);
    expect(read.model).toBe("gpt-5.5");
    expect(read.rateLimits).toEqual([{ usedPercent: 61, windowMinutes: 10_080, resetsAt: 1_900_000_000_000 }]);
    // Nothing new appended: the newest readings stand.
    expect(follower.read(THREAD).rateLimits?.[0]?.usedPercent).toBe(61);
  });
});

describe("rollout deletion", () => {
  const LIVE = "01a1447e-cf11-7d23-9d03-31d816687f46";
  const DEAD = "01a13865-5045-7781-8109-0b9505ae9af2";
  const FRESH = "01a14447-ab85-7691-8c6a-e1c22ad6d98c";
  const NOW = Date.parse("2026-10-16T12:00:00Z");
  const HOUR = 3_600_000;

  /** A Codex home with the files the CLI keeps beside its sessions, and rollouts at the given ages. */
  function codexHome(rollouts: { day: string; thread: string; ageMs: number; bytes?: number; suffix?: string }[]): string {
    const h = tmp("wrathbench-codex-prune-");
    writeFileSync(join(h, "auth.json"), "{}\n");
    writeFileSync(join(h, "config.toml"), "\n");
    writeFileSync(join(h, "thread_history_1.sqlite"), "x");
    writeFileSync(join(h, "state_5.sqlite"), "x");
    for (const r of rollouts) {
      const dir = join(h, "sessions", ...r.day.split("/"));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-${r.day.replaceAll("/", "-")}T01-02-03-${r.thread}${r.suffix ?? ""}.jsonl`);
      writeFileSync(file, "x".repeat(r.bytes ?? 10));
      const at = new Date(NOW - r.ageMs);
      utimesSync(file, at, at);
    }
    return h;
  }
  /** Date directories age with their files, as on disk once nothing is written into them. */
  function ageDirs(h: string, day: string, ageMs: number): void {
    const at = new Date(NOW - ageMs);
    const parts = day.split("/");
    for (let i = parts.length; i > 0; i--) utimesSync(join(h, "sessions", ...parts.slice(0, i)), at, at);
  }

  test("the thread a file name belongs to, as the CLI parses it", () => {
    expect(rolloutThreadId(`rollout-2026-10-16T09-28-46-${LIVE}.jsonl`)).toBe(LIVE);
    expect(rolloutThreadId(`rollout-2026-10-16T09-28-46-${LIVE.toUpperCase()}.jsonl`)).toBe(LIVE);
    // A further rollout of the same thread names the thread first.
    expect(rolloutThreadId(`rollout-2026-10-16T09-28-46-${LIVE}_${DEAD}.jsonl`)).toBe(LIVE);
    expect(rolloutThreadId(`rollout-2026-10-16T09-28-46-${LIVE}.jsonl.zst`)).toBeUndefined();
    expect(rolloutThreadId("rollout-2026-10-16T09-28-46-fake-thread.jsonl")).toBeUndefined();
    expect(rolloutThreadId(`history-${LIVE}.jsonl`)).toBeUndefined();
  });

  test("the sweep keeps a live thread and anything recently written, deletes the rest, and leaves every other file alone", () => {
    const h = codexHome([
      { day: "2026/10/12", thread: LIVE, ageMs: 50 * HOUR, bytes: 100 },
      { day: "2026/10/12", thread: DEAD, ageMs: 50 * HOUR, bytes: 1_000 },
      { day: "2026/10/16", thread: FRESH, ageMs: 30 * 60_000, bytes: 7 },
    ]);
    mkdirSync(join(h, "sessions", "2026", "10", "12", "notes"));
    writeFileSync(join(h, "sessions", "2026", "10", "12", "README"), "keep me");
    writeFileSync(join(h, "sessions", "2026", "10", "12", `rollout-2026-10-12T00-00-00-${DEAD}.jsonl.zst`), "z");
    writeFileSync(join(h, "sessions", "session_index.jsonl"), "{}\n");
    const r = pruneRollouts(h, { keep: new Set([LIVE.toUpperCase()]), now: NOW });
    expect(r).toMatchObject({ files: 1, bytes: 1_000, errors: 0, kept: 2 });
    const day = readdirSync(join(h, "sessions", "2026", "10", "12")).sort();
    expect(day).toEqual(["README", "notes", `rollout-2026-10-12T00-00-00-${DEAD}.jsonl.zst`, `rollout-2026-10-12T01-02-03-${LIVE}.jsonl`].sort());
    expect(readdirSync(join(h, "sessions", "2026", "10", "16"))).toHaveLength(1);
    for (const f of ["auth.json", "config.toml", "thread_history_1.sqlite", "state_5.sqlite", "sessions/session_index.jsonl"]) expect(existsSync(join(h, f))).toBe(true);
  });

  test("date directories a sweep empties go once they have settled, never today's or yesterday's", () => {
    const h = codexHome([
      { day: "2026/09/30", thread: DEAD, ageMs: 400 * HOUR },
      { day: "2026/10/15", thread: DEAD, ageMs: 30 * HOUR },
    ]);
    // Nothing has touched these directories since their files were written.
    ageDirs(h, "2026/09/30", 400 * HOUR);
    ageDirs(h, "2026/10/15", 30 * HOUR);
    const first = pruneRollouts(h, { keep: new Set(), now: NOW });
    expect(first.files).toBe(2);
    // Deleting a file moved its directory's mtime: nothing is removed the same sweep.
    expect(first.dirs).toBe(0);
    ageDirs(h, "2026/09/30", 400 * HOUR);
    ageDirs(h, "2026/10/15", 30 * HOUR);
    const second = pruneRollouts(h, { keep: new Set(), now: NOW });
    expect(second.dirs).toBe(1);
    expect(existsSync(join(h, "sessions", "2026", "09", "30"))).toBe(false);
    // Its month in turn, once that has settled too.
    ageDirs(h, "2026/09", 400 * HOUR);
    expect(pruneRollouts(h, { keep: new Set(), now: NOW }).dirs).toBe(1);
    expect(existsSync(join(h, "sessions", "2026", "09"))).toBe(false);
    // Yesterday's directory, and the current month and year, stay.
    expect(existsSync(join(h, "sessions", "2026", "10", "15"))).toBe(true);
    expect(existsSync(join(h, "sessions"))).toBe(true);
  });

  test("a home with no sessions, an unwritable directory or a vanished file is counted, never thrown", () => {
    const empty = tmp("wrathbench-codex-prune-empty-");
    expect(pruneRollouts(empty, { keep: new Set(), now: NOW })).toMatchObject({ files: 0, errors: 0 });
    expect(pruneRollouts(join(empty, "missing"), { keep: new Set(), now: NOW })).toMatchObject({ files: 0, errors: 0 });
    const h = codexHome([{ day: "2026/10/01", thread: DEAD, ageMs: 300 * HOUR }]);
    const locked = join(h, "sessions", "2026", "10", "01");
    chmodSync(locked, 0o500); // listable, not writable: the unlink fails
    try {
      const r = pruneRollouts(h, { keep: new Set(), now: NOW });
      if (process.getuid?.() === 0) return; // root ignores the mode
      expect(r.files).toBe(0);
      expect(r.errors).toBe(1);
      expect(r.error).toContain("EACCES");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("the driver's deletion takes one thread's rollouts, at any age, and nothing else", () => {
    const h = codexHome([
      { day: "2026/10/16", thread: LIVE, ageMs: 1_000, bytes: 30 },
      { day: "2026/10/16", thread: LIVE, ageMs: 1_000, bytes: 5, suffix: `_${DEAD}` },
      { day: "2026/10/16", thread: DEAD, ageMs: 1_000 },
    ]);
    expect(removeThreadRollouts(h, LIVE)).toEqual({ files: 2, bytes: 35, errors: 0 });
    expect(readdirSync(join(h, "sessions", "2026", "10", "16"))).toEqual([`rollout-2026-10-16T01-02-03-${DEAD}.jsonl`]);
    // Again: nothing left. No CODEX_HOME, no sessions, or a name that is no thread id: nothing at all.
    expect(removeThreadRollouts(h, LIVE)).toEqual({ files: 0, bytes: 0, errors: 0 });
    expect(removeThreadRollouts(undefined, DEAD).files).toBe(0);
    expect(removeThreadRollouts(tmp("wrathbench-codex-none-"), DEAD).files).toBe(0);
    expect(removeThreadRollouts(h, "*").files).toBe(0);
    expect(existsSync(join(h, "auth.json"))).toBe(true);
  });

  test("the thread sidecar round-trips, and a missing or torn one reads as none", () => {
    const dir = tmp("wrathbench-codex-thread-");
    expect(readCodexThread(dir)).toBeUndefined();
    writeCodexThread(dir, LIVE, NOW);
    expect(readCodexThread(dir)).toBe(LIVE);
    expect(JSON.parse(readFileSync(join(dir, CODEX_THREAD_FILE), "utf8"))).toEqual({ threadId: LIVE, since: NOW });
    writeFileSync(join(dir, CODEX_THREAD_FILE), "{tor");
    expect(readCodexThread(dir)).toBeUndefined();
    // A run directory that cannot be written costs the record, never a throw.
    expect(() => writeCodexThread(join(dir, "missing", "deeper"), LIVE)).not.toThrow();
  });
});
