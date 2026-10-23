/**
 * The CLI drivers' compaction: the episodic-log ask it drives, the thresholds
 * it is predicted against, and the records parsed off each CLI's own files.
 * Synthetic throughout — the rollout and transcript lines are built here in
 * the shapes the pinned CLIs write, never copied from a run.
 *
 * The decision under test is docs/METHODOLOGY.md, "An episodic log, asked for
 * at each trim or compaction, read back at rest or in flight".
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codexCompactionRecord } from "../src/adapter-codex";
import {
  COMPACTED_NOTICE,
  COMPACTION_ASK_LOOKAHEAD_TURNS,
  COMPACTION_PENDING_NOTICE,
  COMPACTION_SUMMARY_MAX_CHARS,
  CompactionAsk,
  claudeAutoCompactLimit,
  claudeCompactSummary,
  claudeModelWindow,
  claudeWindowCapRefusal,
  codexAutoCompactLimit,
  codexWindowCapRefusal,
  compactionNotice,
  compactWindowTokens,
  summaryFields,
  summaryInTranscript,
} from "../src/cli-compaction";
import { CodexRolloutFollower, CodexRolloutScan, tokenCountOfLine } from "../src/codex-rollout";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/* ---------------------------------------------------------------- the ask --- */

/** Feed a run of turn-end contexts with no compaction; the asks that came out, by turn index. */
function feed(ask: CompactionAsk, contexts: (number | undefined)[], threshold?: number): Map<number, string> {
  const out = new Map<number, string>();
  contexts.forEach((context, i) => {
    const d = ask.noteTurn({ context, threshold, compactions: [] });
    if (d !== null) out.set(i, d.ask);
  });
  return out;
}

describe("CompactionAsk", () => {
  test("asks once, before, when the context plus two turns of the largest growth reaches the threshold", () => {
    const ask = new CompactionAsk();
    // 100k, +14k a turn, one turn growing 20k: the lookahead uses the largest.
    const contexts = [100_000, 114_000, 128_000, 148_000, 162_000];
    expect(feed(ask, contexts, 450_000).size).toBe(0);
    // 162k + 2 × 20k = 202k: still far. Climb to just under the line.
    let c = 162_000;
    let asked: number | null = null;
    for (let turn = 0; turn < 30; turn++) {
      c += 14_000;
      const d = ask.noteTurn({ context: c, threshold: 450_000, compactions: [] });
      if (d !== null) {
        expect(asked).toBeNull();
        expect(d).toEqual({ ask: "before", context: c, threshold: 450_000, growth: 20_000 });
        asked = c;
      }
    }
    expect(asked).not.toBeNull();
    // The first context at which c + 2 × 20k ≥ 450k.
    expect(asked! + COMPACTION_ASK_LOOKAHEAD_TURNS * 20_000).toBeGreaterThanOrEqual(450_000);
    expect(asked! - 14_000 + COMPACTION_ASK_LOOKAHEAD_TURNS * 20_000).toBeLessThan(450_000);
  });

  test("a compaction after the ask asks nothing more; the next cycle asks again", () => {
    const ask = new CompactionAsk();
    // 410k + 2 × 30k ≥ 450k.
    expect(feed(ask, [380_000, 410_000], 450_000)).toEqual(new Map([[1, "before"]]));
    expect(ask.noteTurn({ context: 98_000, threshold: 450_000, compactions: [447_305] })).toBeNull();
    // The new cycle measures growth from the compacted context.
    expect(feed(ask, [112_000, 126_000], 450_000).size).toBe(0);
    const later = feed(ask, [400_000, 420_000], 450_000);
    expect([...later.values()]).toEqual(["before"]);
  });

  test("a compaction no ask preceded is asked about after, once, however many the turn held", () => {
    const ask = new CompactionAsk();
    feed(ask, [100_000, 114_000], undefined);
    const d = ask.noteTurn({ context: 60_000, compactions: [400_000, 380_000] });
    expect(d).toEqual({ ask: "after", context: 60_000, threshold: 380_000, growth: 14_000 });
    // Nothing more until the next compaction.
    expect(ask.noteTurn({ context: 70_000, compactions: [] })).toBeNull();
  });

  test("the run's own compactions cap the derived threshold", () => {
    const ask = new CompactionAsk();
    // Derived 980k-ish (a 1M window), but the CLI compacted at 200k.
    ask.noteTurn({ context: 50_000, threshold: 967_000, compactions: [] });
    expect(ask.noteTurn({ context: 30_000, threshold: 967_000, compactions: [200_000] })?.ask).toBe("after");
    const asks = feed(ask, [60_000, 90_000, 120_000, 150_000], 967_000);
    // 150k + 2 × 30k = 210k ≥ the learned 200k.
    expect(asks).toEqual(new Map([[3, "before"]]));
  });

  test("no prediction without a measured growth or a threshold; an unread context changes nothing", () => {
    const one = new CompactionAsk();
    // Past the threshold on the very first reading: no growth yet, so no prediction.
    expect(one.noteTurn({ context: 460_000, threshold: 450_000, compactions: [] })).toBeNull();
    const none = new CompactionAsk();
    expect(feed(none, [100_000, 300_000, 440_000], undefined).size).toBe(0);
    const gap = new CompactionAsk();
    expect(feed(gap, [100_000, undefined, 114_000, undefined], 450_000).size).toBe(0);
    expect(gap.noteTurn({ context: 440_000, threshold: 450_000, compactions: [] })?.growth).toBe(326_000);
  });

  test("a replay shaped like the GPT-6.1 Sol run asks before every compaction, never after", () => {
    // Turn-end contexts growing 11–18k a turn; the CLI compacts on the turn
    // whose context crosses 450k, down to about 98k.
    const ask = new CompactionAsk();
    let context = 98_000;
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const asks: string[] = [];
    let compactions = 0;
    for (let turn = 0; turn < 1_800; turn++) {
      const next = context + 11_000 + Math.round(rand() * 7_000);
      const compacted = next >= 450_000;
      if (compacted) compactions++;
      context = compacted ? 98_000 : next;
      const d = ask.noteTurn({ context, threshold: codexAutoCompactLimit(475_000), compactions: compacted ? [next] : [] });
      if (d !== null) asks.push(d.ask);
    }
    expect(compactions).toBeGreaterThan(50);
    expect(asks.filter((a) => a === "after")).toHaveLength(0);
    expect(asks.filter((a) => a === "before")).toHaveLength(compactions);
  });

  test("the notices are the same bytes on both CLIs and name no vendor", () => {
    expect(compactionNotice("before", 5)).toEqual({ ts: 5, kind: "compaction_pending", text: COMPACTION_PENDING_NOTICE });
    expect(compactionNotice("after", 6)).toEqual({ ts: 6, kind: "compacted", text: COMPACTED_NOTICE });
    for (const t of [COMPACTION_PENDING_NOTICE, COMPACTED_NOTICE]) {
      expect(t).toContain("with log_status");
      expect(t).not.toMatch(/codex|claude|openai|anthropic/i);
    }
  });
});

/* ------------------------------------------------------------ thresholds --- */

describe("auto-compaction thresholds", () => {
  test("codex: 90% of the catalogue window, from the 95% the CLI reports", () => {
    expect(codexAutoCompactLimit(475_000)).toBe(450_000);
    expect(codexAutoCompactLimit(258_400)).toBe(244_800);
  });

  test("codex: a run's window is the limit when it is the smaller, as the CLI takes it", () => {
    expect(codexAutoCompactLimit(475_000, "200k")).toBe(200_000);
    expect(codexAutoCompactLimit(258_400, "200k")).toBe(200_000);
    // Past the CLI's own 90% the CLI's limit wins (and the run is refused, below).
    expect(codexAutoCompactLimit(258_400, "300k")).toBe(244_800);
    expect(codexAutoCompactLimit(475_000, undefined)).toBe(450_000);
  });

  test("a window the CLI would cap is refused, on both CLIs, at or above the cap", () => {
    // codex: 258,400 reported is a 272,000 catalogue window and a 244,800 limit.
    expect(codexWindowCapRefusal("300k", 258_400)).toContain("compactWindow 300k (300000 tokens) is at or above the Codex CLI's own auto-compaction limit");
    expect(codexWindowCapRefusal("300k", 258_400)).toContain("272000-token catalogue window");
    expect(codexWindowCapRefusal("200k", 258_400)).toBeNull();
    expect(codexWindowCapRefusal("450k", 475_000)).not.toBeNull();
    expect(codexWindowCapRefusal("449k", 475_000)).toBeNull();
    expect(codexWindowCapRefusal(undefined, 258_400)).toBeNull();
    expect(codexWindowCapRefusal("300k", 0)).toBeNull();
    // claude-code: the model's context window; at it is as capped as above it.
    expect(claudeWindowCapRefusal("1M", 1_000_000)).toContain("is at or above the model's context window");
    expect(claudeWindowCapRefusal("300k", 200_000)).not.toBeNull();
    expect(claudeWindowCapRefusal("200k", 200_000)).not.toBeNull();
    expect(claudeWindowCapRefusal("300k", 1_000_000)).toBeNull();
    expect(claudeWindowCapRefusal(undefined, 200_000)).toBeNull();
  });

  test("claude-code: the window less the summary reserve less 13,000", () => {
    expect(claudeAutoCompactLimit({ contextWindow: 1_000_000, maxOutputTokens: 64_000 })).toBe(967_000);
    expect(claudeAutoCompactLimit({ contextWindow: 1_000_000, maxOutputTokens: 64_000, compactWindow: "100k" })).toBe(67_000);
    expect(claudeAutoCompactLimit({ contextWindow: 200_000, maxOutputTokens: 8_000 })).toBe(179_000);
    // A configured window past the model's own is the model's.
    expect(claudeAutoCompactLimit({ contextWindow: 200_000, compactWindow: "1M" })).toBe(167_000);
    expect(claudeAutoCompactLimit({ contextWindow: 0 })).toBeUndefined();
    expect(compactWindowTokens("300k")).toBe(300_000);
    expect(compactWindowTokens("1M")).toBe(1_000_000);
    expect(compactWindowTokens(undefined)).toBeUndefined();
  });

  test("claude-code: the window is the resolved model's, never a side model's", () => {
    const usage = {
      "claude-haiku-5-5": { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
      "claude-side-model": { contextWindow: 200_000, maxOutputTokens: 8_000 },
    };
    expect(claudeModelWindow(usage, "claude-haiku-5-5")).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 64_000 });
    expect(claudeModelWindow(usage, undefined)).toBeUndefined();
    expect(claudeModelWindow({ only: { contextWindow: 200_000 } }, "other")).toEqual({ contextWindow: 200_000 });
    expect(claudeModelWindow({ only: { inputTokens: 5 } }, "only")).toBeUndefined();
    expect(claudeModelWindow(null, "x")).toBeUndefined();
  });
});

/* ---------------------------------------------------------- codex rollout --- */

const THREAD = "01a12f6d-ecb2-7320-8fe7-cca0d507d176";

function tokenCount(total: number, input = total - 100, window = 475_000): string {
  return JSON.stringify({
    timestamp: "2026-10-12T10:36:01.083Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 9 * total, output_tokens: 900, total_tokens: 9 * total + 900 },
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: total - input, reasoning_output_tokens: 0, total_tokens: total },
        model_context_window: window,
      },
      rate_limits: null,
    },
  });
}

function compacted(o: { message?: string; turns?: number[]; encrypted?: string; input?: number } = {}): string {
  const history: unknown[] = (o.turns ?? [28, 29]).map((t) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `[turn ${t}] Goal: survive and level as far as you can. Act via tools. — état` }],
  }));
  history.push({ type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] });
  if (o.encrypted !== undefined) history.push({ type: "compaction", id: "cmp_1", encrypted_content: o.encrypted });
  return JSON.stringify({
    timestamp: "2026-10-12T10:38:00.002Z",
    type: "compacted",
    payload: {
      message: o.message ?? "",
      replacement_history: history,
      guardian_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(5_000) }] }],
      window_number: 1,
      latest_token_usage_record: { usage: { input_tokens: o.input ?? 447_305, output_tokens: 3_706, total_tokens: 451_011 } },
    },
  });
}

function compactionItem(started: number, completed: number): string {
  return JSON.stringify({
    timestamp: "2026-10-12T10:38:00.023Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: THREAD,
      item: { type: "ContextCompaction", id: "c1" },
      started_at_ms: started,
      completed_at_ms: completed,
    },
  });
}

/** A zeroed token_count, as the CLI writes right after a compaction: only the total is set. */
function postCount(total: number): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
        model_context_window: 475_000,
      },
    },
  });
}

/** A rollout file for THREAD under a fresh CODEX_HOME. */
function rolloutHome(): { home: string; path: string } {
  const home = tempDir("wrathbench-codex-home-");
  const dir = join(home, "sessions", "2026", "10", "12");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-12T09-24-55-${THREAD}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n`);
  return { home, path };
}

describe("codex rollout compactions", () => {
  test("a remote compaction: counts, timing, retained turns, and an encrypted summary that is not copied", () => {
    const scan = new CodexRolloutScan();
    for (const l of [tokenCount(446_911), compacted({ encrypted: "gAAAA".repeat(8_000) }), postCount(77_759), compactionItem(1_000, 119_938), tokenCount(98_000)]) {
      scan.line(l);
    }
    const [c, ...rest] = scan.drain(true);
    expect(rest).toHaveLength(0);
    expect(c).toEqual({
      at: 1_000,
      durationMs: 118_938,
      preTokens: 447_305,
      postTokens: 77_759,
      summary: null,
      encryptedChars: 40_000,
      retainedTurns: [28, 29],
      window: 1,
    });
    expect(scan.context).toEqual({ total: 98_000, window: 475_000 });
    const record = codexCompactionRecord(36, c!);
    expect(record).toMatchObject({ t: "harness", kind: "compaction", turn: 36, trigger: null, summary: null, summaryEncrypted: true });
    // Nothing of the history arrays reaches the record.
    expect(JSON.stringify(record)).not.toContain("gAAAA");
    expect(JSON.stringify(record)).not.toContain("instructions");
  });

  test("a local compaction keeps its summary; pre falls back to the last reported total", () => {
    const scan = new CodexRolloutScan();
    const line = JSON.parse(compacted({ message: "Summary: heading to Duskwood." })) as { payload: Record<string, unknown> };
    delete line.payload["latest_token_usage_record"];
    for (const l of [tokenCount(240_000), JSON.stringify(line), tokenCount(60_000), compactionItem(5, 9)]) scan.line(l);
    const [c] = scan.drain(true);
    expect(c).toMatchObject({ summary: "Summary: heading to Duskwood.", encryptedChars: null, preTokens: 240_000, postTokens: 60_000 });
    expect(codexCompactionRecord(2, c!)).not.toHaveProperty("summaryEncrypted");
  });

  test("lines straddling two drains are one compaction; a timing item alone is none", () => {
    const scan = new CodexRolloutScan();
    scan.line(compactionItem(1, 2));
    expect(scan.drain(true)).toEqual([]);
    scan.line(tokenCount(400_000));
    scan.line(compacted({ encrypted: "x" }));
    expect(scan.drain(false)).toEqual([]);
    scan.line(postCount(50_000));
    scan.line(compactionItem(10, 30));
    expect(scan.drain(false)).toEqual([]);
    expect(scan.drain(true)).toMatchObject([{ at: 10, durationMs: 20, postTokens: 50_000 }]);
  });

  test("token_count lines read the last call's total and window; other lines are none", () => {
    expect(tokenCountOfLine(tokenCount(446_911))).toEqual({ total: 446_911, window: 475_000 });
    expect(tokenCountOfLine(postCount(77_759))).toEqual({ total: 77_759, window: 475_000 });
    expect(tokenCountOfLine(compactionItem(1, 2))).toBeUndefined();
    expect(tokenCountOfLine('{"type":"event_msg","payload":{"type":"token_count","info":null}}')).toBeUndefined();
  });

  test("the follower reads only what was appended, across lines cut by its chunk size", () => {
    const { home, path } = rolloutHome();
    const failures: string[] = [];
    // A tiny chunk: every line, and the multi-byte characters in it, is cut.
    const follower = new CodexRolloutFollower(home, (r) => failures.push(r), 37);
    appendFileSync(path, `${tokenCount(120_000)}\n${tokenCount(134_000)}\n`);
    expect(follower.read(THREAD)).toEqual({ compactions: [], context: { total: 134_000, window: 475_000 }, rateLimits: undefined, model: undefined });
    appendFileSync(path, `${tokenCount(446_911)}\n${compacted({ encrypted: "abc" })}\n${postCount(77_759)}\n${compactionItem(7, 107)}\n${tokenCount(99_000)}\n`);
    const second = follower.read(THREAD);
    expect(second.compactions).toHaveLength(1);
    expect(second.compactions[0]).toMatchObject({ preTokens: 447_305, postTokens: 77_759, durationMs: 100, retainedTurns: [28, 29] });
    expect(second.context).toEqual({ total: 99_000, window: 475_000 });
    // Nothing new: nothing again, and the same compaction is never reported twice.
    expect(follower.read(THREAD).compactions).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("the follower fails quietly, once, and starts over on a new thread", () => {
    const failures: string[] = [];
    const none = new CodexRolloutFollower(undefined, (r) => failures.push(r));
    expect(none.read(THREAD)).toEqual({ compactions: [], context: undefined, rateLimits: undefined, model: undefined });
    expect(none.read(THREAD)).toEqual({ compactions: [], context: undefined, rateLimits: undefined, model: undefined });
    expect(failures).toEqual(["no CODEX_HOME"]);
    const { home, path } = rolloutHome();
    const missing = new CodexRolloutFollower(home, (r) => failures.push(r));
    expect(missing.read("0199aaaa-0000-0000-0000-000000000000").context).toBeUndefined();
    expect(failures.at(-1)).toBe("rollout file not found");
    appendFileSync(path, `${tokenCount(200_000)}\n`);
    const f = new CodexRolloutFollower(home, () => undefined);
    expect(f.read(THREAD).context?.total).toBe(200_000);
  });
});

/* ------------------------------------------------- claude-code transcript --- */

const SESSION = "d79945d9-d777-4a26-9835-8f075947cbac";
const BOUNDARY = "7e2a3fc8-d5f7-4453-8043-f8e2493dc73a";

/**
 * A transcript around one compaction, in 2.1.293's shape: two
 * attachment lines between the boundary and its summary, the summary parented
 * on the last of them. `adjacent` is the 2.1.239 shape, parented on the
 * boundary itself.
 */
function transcriptLines(summary: unknown, adjacent = false): string[] {
  const between = adjacent
    ? []
    : [
        JSON.stringify({ type: "attachment", uuid: "t1", parentUuid: BOUNDARY, attachment: { type: "session_context" } }),
        JSON.stringify({ type: "attachment", uuid: "t2", parentUuid: "t1", attachment: { type: "date" } }),
      ];
  return [
    // An earlier compaction's summary, which is not this one's.
    JSON.stringify({ type: "user", uuid: "s0", parentUuid: "b0", isCompactSummary: true, message: { role: "user", content: "an older summary" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u0", message: { content: [{ type: "text", text: "working" }] } }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: BOUNDARY, parentUuid: null, compactMetadata: { trigger: "auto", preTokens: 967_077 } }),
    ...between,
    JSON.stringify({
      type: "user",
      uuid: "s1",
      parentUuid: adjacent ? BOUNDARY : "t2",
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      message: { role: "user", content: summary },
    }),
    JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "s1", message: { content: [{ type: "tool_use", name: "mcp__wrathbench__run_snippet" }] } }),
  ];
}

function claudeConfig(lines: string[]): string {
  const configDir = tempDir("wrathbench-claude-config-");
  const dir = join(configDir, "projects", "-tmp-wrathbench-claude-abc123");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
  return configDir;
}

describe("claude-code compaction summary", () => {
  test("found in the session transcript after the boundary with the envelope's uuid", () => {
    const text = "This session is being continued from a previous conversation that ran out of context.\n\nSummary: …";
    const dir = claudeConfig(transcriptLines(text));
    expect(claudeCompactSummary(dir, SESSION, BOUNDARY)).toBe(text);
    // The older CLI's shape, the summary right after the boundary, reads the same.
    expect(summaryInTranscript(transcriptLines("adjacent", true).join("\n"), BOUNDARY, false)).toBe("adjacent");
    // A boundary with no summary after it yet is nothing, not the older one.
    expect(summaryInTranscript(transcriptLines("x").slice(0, 3).join("\n"), BOUNDARY, false)).toBeUndefined();
    // Another boundary's summary is not this one's.
    expect(claudeCompactSummary(dir, SESSION, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
    // A session id that is not one is never globbed.
    expect(claudeCompactSummary(dir, "../*", BOUNDARY)).toBeUndefined();
    expect(claudeCompactSummary(join(dir, "missing"), SESSION, BOUNDARY)).toBeUndefined();
  });

  test("text blocks are joined, and a tail read that cuts the first line still finds it", () => {
    const lines = ["x".repeat(10_000), ...transcriptLines([{ type: "text", text: "part one" }, { type: "image" }, { type: "text", text: "part two" }])];
    const dir = claudeConfig(lines);
    expect(claudeCompactSummary(dir, SESSION, BOUNDARY, 2_000)).toBe("part one\npart two");
    expect(summaryInTranscript(lines.join("\n"), BOUNDARY, false)).toBe("part one\npart two");
  });

  test("a summary is capped deterministically on the record", () => {
    expect(summaryFields(undefined)).toEqual({ summary: null });
    expect(summaryFields("")).toEqual({ summary: null });
    expect(summaryFields("short")).toEqual({ summary: "short" });
    const long = summaryFields("y".repeat(COMPACTION_SUMMARY_MAX_CHARS + 5));
    expect(long.summaryTruncated).toBe(true);
    expect(long.summary).toBe(`${"y".repeat(COMPACTION_SUMMARY_MAX_CHARS)}…[truncated 5 chars]`);
  });
});
