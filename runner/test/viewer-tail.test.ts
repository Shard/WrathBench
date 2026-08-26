import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformOf, readRun } from "../viewer/runs";
import {
  TrajectoryTail,
  playtimeMs,
  areaFactsFrom,
  achievementFactsFrom,
  taxiFactsFrom,
  scanRunTotals,
  segmentsFrom,
  splitLines,
  summarize,
  tokenTotals,
  tokensPerSecond,
} from "../viewer/tail";

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "wrathbench-viewer-")), "trajectory.jsonl");
}

const enc = new TextEncoder();

describe("splitLines", () => {
  test("keeps the bytes after the last newline as the remainder", () => {
    const { lines, rest } = splitLines(enc.encode('{"a":1}\n{"b":'));
    expect(lines).toHaveLength(1);
    expect(new TextDecoder().decode(lines[0]!)).toBe('{"a":1}');
    expect(new TextDecoder().decode(rest)).toBe('{"b":');
  });

  test("a fully terminated buffer leaves nothing pending", () => {
    const { lines, rest } = splitLines(enc.encode("a\nb\n"));
    expect(lines).toHaveLength(2);
    expect(rest.length).toBe(0);
  });
});

describe("TrajectoryTail", () => {
  test("emits each entry exactly once as the file grows", async () => {
    const path = tempFile();
    writeFileSync(path, '{"t":"snippet","ts":1,"code":"x"}\n');
    const tail = new TrajectoryTail(path);
    expect((await tail.scan()).map((e) => e.t)).toEqual(["snippet"]);
    expect(await tail.scan()).toHaveLength(0);

    appendFileSync(path, '{"t":"state","ts":2,"level":3}\n');
    const added = await tail.scan();
    expect(added).toHaveLength(1);
    expect(added[0]!.i).toBe(1);
    expect(added[0]!["level"]).toBe(3);
    expect(tail.entries).toHaveLength(2);
  });

  test("holds back a partial trailing line until its newline arrives", async () => {
    const path = tempFile();
    writeFileSync(path, '{"t":"state","ts":1,"level":1}\n{"t":"state","ts":2,"lev');
    const tail = new TrajectoryTail(path);
    expect(await tail.scan()).toHaveLength(1);

    appendFileSync(path, 'el":2}\n');
    const added = await tail.scan();
    expect(added).toHaveLength(1);
    expect(added[0]!["level"]).toBe(2);
    // The completed entry must not be emitted a second time.
    expect(await tail.scan()).toHaveLength(0);
    expect(tail.entries).toHaveLength(2);
  });

  test("a multi-byte character split across a write stays intact", async () => {
    const path = tempFile();
    const line = enc.encode('{"t":"harness","ts":1,"text":"Ironforge — Brächt ✧"}\n');
    const cut = 40; // lands inside the em dash / umlaut region
    writeFileSync(path, line.subarray(0, cut));
    const tail = new TrajectoryTail(path);
    expect(await tail.scan()).toHaveLength(0);

    appendFileSync(path, line.subarray(cut));
    const added = await tail.scan();
    expect(added).toHaveLength(1);
    expect(added[0]!["text"]).toBe("Ironforge — Brächt ✧");
  });

  test("a complete line that is not JSON surfaces rather than vanishing", async () => {
    const path = tempFile();
    writeFileSync(path, '{"t":"state","ts":1}\nnot json at all\n{"t":"state","ts":2}\n');
    const tail = new TrajectoryTail(path);
    const added = await tail.scan();
    expect(added.map((e) => e.t)).toEqual(["state", "unparseable-line", "state"]);
    expect(added[1]!["line"]).toBe("not json at all");
  });

  test("blank lines are skipped without shifting byte offsets", async () => {
    const path = tempFile();
    writeFileSync(path, '{"t":"state","ts":1}\n\n{"t":"state","ts":2,"level":9}\n');
    const tail = new TrajectoryTail(path);
    const added = await tail.scan();
    expect(added).toHaveLength(2);
    expect(JSON.parse((await tail.raw(1))!)["level"]).toBe(9);
  });

  test("raw() reads back exactly the bytes of one entry", async () => {
    const path = tempFile();
    const second = '{"t":"snippet","ts":2,"code":"await sdk.move()"}';
    writeFileSync(path, `{"t":"snippet","ts":1,"code":"a"}\n${second}\n`);
    const tail = new TrajectoryTail(path);
    await tail.scan();
    expect(await tail.raw(1)).toBe(second);
    expect(await tail.raw(9)).toBeNull();
  });

  test("a truncated file is re-indexed from scratch", async () => {
    const path = tempFile();
    writeFileSync(path, '{"t":"state","ts":1}\n{"t":"state","ts":2}\n');
    const tail = new TrajectoryTail(path);
    expect(await tail.scan()).toHaveLength(2);

    truncateSync(path, 0);
    appendFileSync(path, '{"t":"state","ts":3}\n');
    const added = await tail.scan();
    expect(added).toHaveLength(1);
    expect(tail.entries).toHaveLength(1);
    expect(tail.entries[0]!.ts).toBe(3);
  });
});

describe("summarize", () => {
  test("drops the message array of a request but keeps its shape", () => {
    const rec = {
      t: "request",
      ts: 5,
      turn: 3,
      adapter: "openai-compatible:m",
      messages: [{ role: "system", content: "x".repeat(9000) }, { role: "user", content: "go" }],
    };
    const s = summarize(rec, 0, 0, 100);
    expect(s["messages"]).toBeUndefined();
    expect(s["messageCount"]).toBe(2);
    expect(s["systemChars"]).toBe(9000);
    expect(JSON.stringify(s).length).toBeLessThan(300);
  });

  test("collapses served events to counts by opcode", () => {
    const events = [
      { opcode: "SMSG_A", data: { name: "x" } },
      { opcode: "SMSG_A", data: { name: "y" } },
      { opcode: "SMSG_B", data: { name: "z" } },
    ];
    const s = summarize({ t: "events_served", ts: 1, via: "tool", count: 3, events }, 0, 0, 10);
    expect(s["events"]).toBeUndefined();
    expect(s["count"]).toBe(3);
    expect(s["opcodes"]).toEqual(["SMSG_A×2", "SMSG_B×1"]);
    expect(s["moreOpcodes"]).toBeUndefined();
    expect(s["folded"]).toBeUndefined();
    expect(s["ambient"]).toBeUndefined();
  });

  test("splits a context batch into model-visible and ambient movement", () => {
    const events = [
      { opcode: "SMSG_MONSTER_MOVE", data: {} },
      { opcode: "MSG_MOVE_HEARTBEAT", data: {} },
      { opcode: "SMSG_MONSTER_MOVE", data: {} },
      { opcode: "SMSG_MESSAGECHAT", data: {} },
    ];
    const s = summarize({ t: "events_served", ts: 1, via: "context", count: 4, events }, 0, 0, 10);
    expect(s["count"]).toBe(4);
    expect(s["ambient"]).toBe(3); // what the model-visible window dropped
  });

  test("cuts the opcode tally at six and carries the folded count", () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ opcode: `SMSG_${i}`, data: {} }));
    const s = summarize({ t: "events_served", ts: 1, via: "tool", count: 9, events, folded: 41 }, 0, 0, 10);
    expect((s["opcodes"] as string[]).length).toBe(6);
    expect(s["moreOpcodes"]).toBe(3);
    expect(s["folded"]).toBe(41);
  });

  test("keeps error results flagged and cuts very long text", () => {
    const s = summarize(
      { t: "snippet_result", ts: 1, name: "run_snippet", isError: true, text: "boom".repeat(5000) },
      2,
      0,
      10,
    );
    expect(s["isError"]).toBe(true);
    expect(s["clipped"]).toBe(true);
    expect((s["text"] as string).length).toBeLessThan(8200);
  });

  test("counts the whole prompt of a request, tool calls included", () => {
    const s = summarize(
      {
        t: "request",
        ts: 1,
        messages: [
          { role: "system", content: "s".repeat(100) },
          { role: "assistant", content: "", tool_calls: [{ function: { name: "run_snippet", arguments: "{}" } }] },
        ],
      },
      0,
      0,
      10,
    );
    expect(s["promptChars"]).toBeGreaterThan(100);
    expect(s["usage"]).toBeUndefined();
  });

  test("provider usage is carried through when a driver records it", () => {
    const s = summarize(
      { t: "request", ts: 1, messages: [], usage: { prompt_tokens: 900, completion_tokens: 40 } },
      0,
      0,
      10,
    );
    expect(s["usage"]).toEqual({ prompt: 900, completion: 40 });
  });

  test("unknown types fall through generically with long strings cut", () => {
    const s = summarize({ t: "watchdog", ts: 1, kind: "idle", detail: "d".repeat(5000) }, 0, 0, 10);
    expect(s["kind"]).toBe("idle");
    expect(s["clipped"]).toBe(true);
    expect((s["detail"] as string).length).toBeLessThan(2100);
  });
});

describe("tokenTotals", () => {
  const req = (i: number, chars: number) =>
    summarize({ t: "request", ts: i, messages: [{ role: "user", content: "x".repeat(chars - 4) }] }, i, 0, 1);
  const res = (i: number, chars: number) =>
    summarize({ t: "response", ts: i, message: { role: "assistant", content: "y".repeat(chars - 9) } }, i, 0, 1);

  test("estimates from characters when no usage is recorded, and says so", () => {
    const t = tokenTotals([req(0, 4000), res(1, 400), req(2, 8000), res(3, 800)]);
    expect(t.source).toBe("estimated");
    expect(t.turns).toBe(2);
    // Context is the latest prompt, not the sum of them.
    expect(t.contextTokens).toBe(2000);
    expect(t.promptTokens).toBe(3000);
    expect(t.completionTokens).toBe(300);
    expect(t.totalTokens).toBe(3300);
  });

  test("a response's reported usage replaces its turn's estimate", () => {
    // The runner logs usage on the response; the prompt it reports belongs to
    // the request just before it, which must not also be counted as an estimate.
    const t = tokenTotals([
      req(0, 40000),
      summarize(
        { t: "response", ts: 1, message: { role: "assistant", content: "hi" }, usage: { prompt_tokens: 1200, completion_tokens: 250 } },
        1,
        0,
        1,
      ),
    ]);
    expect(t.source).toBe("reported");
    expect(t.contextTokens).toBe(1200);
    expect(t.promptTokens).toBe(1200);
    expect(t.completionTokens).toBe(250);
    expect(t.totalTokens).toBe(1450);
  });

  test("a turn still awaiting its response keeps the estimated prompt", () => {
    const t = tokenTotals([
      req(0, 4000),
      summarize({ t: "response", ts: 1, message: {}, usage: { prompt_tokens: 900, completion_tokens: 30 } }, 1, 0, 1),
      req(2, 8000),
    ]);
    expect(t.turns).toBe(2);
    expect(t.contextTokens).toBe(2000);
    expect(t.promptTokens).toBe(900 + 2000);
    expect(t.completionTokens).toBe(30);
  });

  test("usage on a request is still honoured if a driver logs it there", () => {
    const t = tokenTotals([
      summarize({ t: "request", ts: 1, messages: [], usage: { prompt_tokens: 1200, completion_tokens: 0 } }, 0, 0, 1),
      summarize({ t: "response", ts: 2, message: {}, usage: { completion_tokens: 250 } }, 1, 0, 1),
    ]);
    expect(t.source).toBe("reported");
    expect(t.contextTokens).toBe(1200);
    expect(t.completionTokens).toBe(250);
    expect(t.totalTokens).toBe(1450);
  });

  test("an empty run totals to zero rather than NaN", () => {
    expect(tokenTotals([])).toMatchObject({ source: "estimated", contextTokens: 0, totalTokens: 0, turns: 0 });
  });

  test("cache figures the provider never mentions stay null, not zero", () => {
    const t = tokenTotals([
      req(0, 4000),
      summarize({ t: "response", ts: 1, message: {}, usage: { prompt_tokens: 900, completion_tokens: 30 } }, 1, 0, 1),
    ]);
    // A compat provider that reports no cache read is not a provider that read
    // nothing from cache, and the UI must be able to tell the two apart.
    expect(t.cacheReadTokens).toBeNull();
    expect(t.cacheWriteTokens).toBeNull();
  });

  test("cache reads and writes sum across turns, in either vocabulary", () => {
    const t = tokenTotals([
      // OpenAI-compat: cached_tokens, and nothing at all about writes.
      summarize(
        { t: "response", ts: 1, message: {}, usage: { prompt_tokens: 900, completion_tokens: 30, cached_tokens: 400 } },
        0, 0, 1,
      ),
      // The claude driver's normalised shape adds the writes.
      summarize(
        {
          t: "response", ts: 2, message: {},
          usage: { prompt_tokens: 1000, completion_tokens: 40, cached_tokens: 600, cache_write_tokens: 50 },
        },
        1, 0, 1,
      ),
    ]);
    expect(t.cacheReadTokens).toBe(1000);
    expect(t.cacheWriteTokens).toBe(50);
    expect(t.promptTokens).toBe(1900);
  });

  /*
   * FOLLOW-UPS 82: the claude-code driver writes one reply as several
   * `response` records, only the last of which carries usage, and that figure
   * is the running total for the whole message (`adapter-claude.ts`).
   */
  test("a reply split across envelopes counts its completion once", () => {
    const t = tokenTotals([
      req(0, 4000),
      // Two envelopes of one message: text, then the tool_use that carries the usage.
      res(1, 40000),
      summarize(
        { t: "response", ts: 2, message: { role: "assistant", content: "done" }, usage: { prompt_tokens: 900, completion_tokens: 260 } },
        2,
        0,
        1,
      ),
    ]);
    // 260, not 260 + the 10k characters of the envelope already inside it.
    expect(t.completionTokens).toBe(260);
    // Same rule on the prompt: the reported figure replaces the request's
    // estimate however many records after the request it lands.
    expect(t.promptTokens).toBe(900);
  });

  test("several messages in one span each keep their reported total", () => {
    // A span is not a message: the CLI can answer one tool result with several
    // API calls, and each carries its own running total, so they sum.
    const t = tokenTotals([
      summarize({ t: "snippet_result", ts: 1, name: "run_snippet", text: "ok" }, 0, 0, 1),
      summarize({ t: "response", ts: 2, message: {}, usage: { completion_tokens: 100 } }, 1, 0, 1),
      summarize({ t: "response", ts: 3, message: {}, usage: { completion_tokens: 250 } }, 2, 0, 1),
    ]);
    expect(t.completionTokens).toBe(350);
  });

  test("a span whose last envelope reports nothing still uses the reported total", () => {
    const t = tokenTotals([
      req(0, 4000),
      summarize(
        { t: "response", ts: 1, message: { role: "assistant", content: "x" }, usage: { completion_tokens: 260 } },
        1,
        0,
        1,
      ),
      // The held-back envelope flushed at shutdown carries no usage of its own.
      res(2, 40000),
    ]);
    expect(t.completionTokens).toBe(260);
  });

  test("a span nothing reported usage for is still estimated from characters", () => {
    const t = tokenTotals([req(0, 4000), res(1, 4000), res(2, 4000)]);
    expect(t.source).toBe("estimated");
    expect(t.completionTokens).toBe(2000);
  });

  test("the openai-compatible shape totals exactly as it did before the span fix", () => {
    // One request, one response, usage on the response: the fixed loop's whole
    // vocabulary. Every field is asserted because the span fix touches the
    // prompt as well as the completion.
    const t = tokenTotals([
      req(0, 4000),
      summarize(
        {
          t: "response", ts: 1, message: { role: "assistant", content: "hi" },
          usage: { prompt_tokens: 1200, completion_tokens: 250, cached_tokens: 400 },
        },
        1, 0, 1,
      ),
      summarize({ t: "request", ts: 2, messages: [{ role: "user", content: "y".repeat(7996) }] }, 2, 0, 1),
      summarize(
        {
          t: "response", ts: 3, message: { role: "assistant", content: "ok" },
          usage: { prompt_tokens: 1500, completion_tokens: 300, cached_tokens: 600 },
        },
        3, 0, 1,
      ),
    ]);
    expect(t).toEqual({
      source: "reported",
      contextTokens: 1500,
      promptTokens: 2700,
      completionTokens: 550,
      totalTokens: 3250,
      cacheReadTokens: 1000,
      cacheWriteTokens: null,
      turns: 2,
    });
  });
});

describe("tokensPerSecond", () => {
  const req = (ts: number, turn: number) =>
    summarize({ t: "request", ts, turn, messages: [{ role: "user", content: "hi" }] }, ts, 0, 1);
  const res = (ts: number, turn: number, completion: number) =>
    summarize(
      { t: "response", ts, turn, message: { role: "assistant", content: "y" }, usage: { prompt_tokens: 10, completion_tokens: completion } },
      ts,
      0,
      1,
    );
  /** A response with no usage block at all: the estimate path. */
  const bare = (ts: number, chars: number) =>
    summarize({ t: "response", ts, turn: 1, message: { role: "assistant", content: "z".repeat(chars) } }, ts, 0, 1);
  const snippetResult = (ts: number, turn: number) =>
    summarize({ t: "snippet_result", ts, turn, text: "ok" }, ts, 0, 1);
  /** The claude-code driver's per-turn result: the only honest output count it gives. */
  const claudeResult = (
    ts: number,
    turn: number,
    usageRaw: Record<string, unknown>,
    timing: { durationMs?: number; durationApiMs?: number },
  ) => summarize({ t: "claude_result", ts, turn, isError: false, usageRaw, ...timing }, ts, 0, 1);

  test("one reply: output tokens over the wait-to-reply span", () => {
    const t = tokensPerSecond([req(1000, 1), res(3000, 1, 400)]);
    expect(t.replies).toBe(1);
    expect(t.overall).toBe(200); // 400 tokens over 2s
    expect(t.recent).toBe(200);
    expect(t.recentReplies).toBe(1);
  });

  test("a reply split across several response records is timed to its LAST one", () => {
    // The claude-code driver appends one record per content block; the span
    // runs to the final block, not the first.
    const t = tokensPerSecond([req(1000, 1), res(2000, 1, 30), res(3000, 1, 70), res(5000, 1, 300)]);
    expect(t.replies).toBe(1);
    expect(t.overall).toBe(100); // 400 tokens over 4s
  });

  test("a multi-envelope reply takes the provider's running total, never total-plus-estimate", () => {
    // adapter-claude.ts: the earlier envelopes of one message go out WITHOUT
    // usage and the last carries the running total for the whole reply, so
    // adding an estimate for the earlier ones would count their text twice.
    const t = tokensPerSecond([req(1000, 1), bare(2000, 4000), res(3000, 1, 400)]);
    expect(t.replies).toBe(1);
    expect(t.overall).toBe(200); // 400 tokens over 2s — the 1000-token estimate is not added
  });

  test("a reply with no reported usage at all is estimated from characters", () => {
    const t = tokensPerSecond([req(1000, 1), bare(3000, 400)]);
    expect(t.replies).toBe(1);
    // chars ÷ 4 over 2 seconds; `messageChars` counts the message's own text.
    expect(t.overall).toBeGreaterThan(45);
    expect(t.overall).toBeLessThan(55);
  });

  test("a request with no reply yet has no rate, and does not end the previous span", () => {
    const inflight = tokensPerSecond([req(1000, 1)]);
    expect(inflight.replies).toBe(0);
    expect(inflight.overall).toBeNull();
    expect(inflight.recent).toBeNull();

    const t = tokensPerSecond([req(1000, 1), res(3000, 1, 400), req(9000, 2)]);
    expect(t.replies).toBe(1);
    expect(t.overall).toBe(200);
  });

  test("under the claude-code driver a span opens at the result the CLI was waiting on", () => {
    // One request, many replies, each one timed from the tool result before it
    // — never from the request, which on that driver spans the whole episode.
    const result = (ts: number) => summarize({ t: "snippet_result", ts, turn: 1, text: "ok" }, ts, 0, 1);
    const t = tokensPerSecond([
      req(1000, 1),
      res(3000, 1, 400),
      summarize({ t: "tool_call", ts: 3100, turn: 1, name: "eval_snippet" }, 3, 0, 1),
      result(4000),
      res(6000, 1, 400),
    ]);
    expect(t.replies).toBe(2);
    // 800 tokens over 4s of model time — not over the 5s the run has existed.
    expect(t.overall).toBe(200);
  });

  test("an ambient record mid-reply does not restart the clock", () => {
    // A `state` sample lands on a timer while the model is still generating; on
    // the live deepseek-pro run, treating one as a boundary read a third fast.
    const sample = summarize({ t: "state", ts: 2000, level: 4 }, 2, 0, 1);
    const t = tokensPerSecond([req(1000, 1), sample, res(3000, 1, 400)]);
    expect(t.replies).toBe(1);
    expect(t.overall).toBe(200); // timed from the request, not from the sample
  });

  test("recent is the last ten replies, summed — not a mean of per-reply rates", () => {
    const entries = [];
    // Twelve replies: the first two are slow (10 tok/s), the last ten fast (100).
    for (let i = 0; i < 12; i++) {
      const start = 100_000 + i * 100_000;
      const fast = i >= 2;
      entries.push(req(start, i + 1), res(start + (fast ? 1000 : 10_000), i + 1, 100));
    }
    const t = tokensPerSecond(entries);
    expect(t.replies).toBe(12);
    expect(t.recentReplies).toBe(10);
    expect(t.recent).toBe(100); // 1000 tokens over 10s
    // The whole run: 1200 tokens over 30s, dragged down by the two slow replies.
    expect(t.overall).toBe(40);
  });

  test("a pause between a request and its reply drops that span", () => {
    const pause = summarize({ t: "pause", ts: 5000, reason: "rate-limit" }, 5, 0, 1);
    const resume = summarize({ t: "resume", ts: 3_605_000 }, 6, 0, 1);
    const t = tokensPerSecond([
      req(1000, 1),
      res(3000, 1, 400),
      req(4000, 2),
      pause,
      resume,
      // The reply that would otherwise be timed across the whole hour parked.
      res(3_606_000, 2, 400),
      req(3_607_000, 3),
      res(3_609_000, 3, 400),
    ]);
    expect(t.replies).toBe(2);
    expect(t.overall).toBe(200);
  });

  test("scanRunTotals carries the same figure off its single pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-tps-"));
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ t: "meta", ts: 1000 }),
        JSON.stringify({ t: "request", ts: 2000, turn: 1, messages: [{ role: "user", content: "hello" }] }),
        JSON.stringify({
          t: "response", ts: 4000, turn: 1, message: { role: "assistant", content: "hi" },
          usage: { prompt_tokens: 500, completion_tokens: 200 },
        }),
        // A second reply, opened by the snippet result the model was waiting on.
        JSON.stringify({ t: "snippet_result", ts: 5000, turn: 1, text: "ok" }),
        JSON.stringify({
          t: "response", ts: 7000, turn: 1, message: { role: "assistant", content: "hi again" },
          usage: { prompt_tokens: 500, completion_tokens: 400 },
        }),
        "",
      ].join("\n"),
    );
    const totals = await scanRunTotals(path);
    expect(totals.tps.replies).toBe(2);
    expect(totals.tps.overall).toBe(150); // 600 tokens over 4s of model time
    // The same entries through the incremental path the run page uses. Tokens
    // too: both derivations read the same spans, so the single pass and the
    // tail must not be able to disagree about what one reply produced.
    const tail = new TrajectoryTail(path);
    const scanned = await tail.scan();
    expect(tokensPerSecond(scanned)).toEqual(totals.tps);
    expect(tokenTotals(scanned)).toEqual(totals.tokens);
    expect(totals.tokens.completionTokens).toBe(600);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a claude-code turn is one measured reply: the result's output over the turn's span clocks", () => {
    // The envelopes' `completion_tokens` are the API's opening snapshot — a
    // token or two — and the finished count lands only on the result. The
    // CLOCK still comes from the spans: 1s waiting-to-reply plus 6s, and NOT
    // the CLI's 9s, which counts the tool round trip in between.
    const entries = [
      req(1000, 1),
      res(2000, 1, 3),
      snippetResult(3000, 1),
      res(9000, 1, 5),
      claudeResult(10_000, 1, { output_tokens: 4000 }, { durationApiMs: 2000, durationMs: 9000 }),
    ];
    const t = tokensPerSecond(entries);
    expect(t.replies).toBe(1); // the turn, not its two spans
    expect(t.overall).toBe(4000 / 7); // 4000 tokens over 7s of measured model time
    // Never the 8 the snapshots add up to, and never both.
    expect(tokenTotals(entries).completionTokens).toBe(4000);
  });

  test("a turn with nothing measurable falls back to the CLI's clocks, api first", () => {
    // A reply that arrived on the far side of a pause: `replySpans` gives it no
    // start, so there is no model-time window to divide by and the driver's own
    // figure is the only measurement left.
    const pause = summarize({ t: "pause", ts: 1500, reason: "rate-limit" }, 5, 0, 1);
    const resume = summarize({ t: "resume", ts: 3_600_000 }, 6, 0, 1);
    const withApi = [
      req(1000, 1),
      pause,
      resume,
      res(3_602_000, 1, 3),
      claudeResult(3_603_000, 1, { output_tokens: 4000 }, { durationApiMs: 2000, durationMs: 9000 }),
    ];
    expect(tokensPerSecond(withApi).overall).toBe(2000);
    // A run predating the adapter recording the API clock has only the whole
    // turn's, tool round trips included.
    const older = [
      req(1000, 1),
      pause,
      resume,
      res(3_602_000, 1, 3),
      claudeResult(3_603_000, 1, { output_tokens: 4500 }, { durationMs: 9000 }),
    ];
    expect(tokensPerSecond(older).overall).toBe(500);
  });

  test("a pause inside a claude-code turn drops that stretch from the denominator", () => {
    const pause = summarize({ t: "pause", ts: 4000, reason: "rate-limit" }, 5, 0, 1);
    const resume = summarize({ t: "resume", ts: 3_604_000 }, 6, 0, 1);
    const t = tokensPerSecond([
      req(1000, 1),
      res(3000, 1, 3), // a measured 2s span
      pause,
      resume,
      res(3_610_000, 1, 4), // no opener after the resume: times nothing
      claudeResult(3_611_000, 1, { output_tokens: 500 }, { durationMs: 3_610_000 }),
    ]);
    // 500 tokens over the 2s actually measured, not over the hour parked.
    expect(t.overall).toBe(250);
  });

  test("iterations are read per reply only when they sum to the turn's total", () => {
    // A one-call turn: the single iteration IS the turn, so the spans keep
    // their own timing and carry the real figure.
    const perReply = [
      req(1000, 1),
      res(3000, 1, 2),
      claudeResult(4000, 1, { output_tokens: 900, iterations: [{ output_tokens: 900 }] }, { durationApiMs: 100_000 }),
    ];
    const t = tokensPerSecond(perReply);
    expect(t.overall).toBe(450); // 900 over the 2s span, not over the CLI's 100s
    expect(tokenTotals(perReply).completionTokens).toBe(900);

    // The shape every real run has: one iteration, the LAST call, against a
    // turn of many. Counting them would match and be wrong; summing declines.
    const declined = [
      req(1000, 1),
      res(3000, 1, 2),
      claudeResult(5000, 1, { output_tokens: 9000, iterations: [{ output_tokens: 400 }] }, { durationApiMs: 3000 }),
    ];
    expect(tokenTotals(declined).completionTokens).toBe(9000);
    // Collapsed, and still timed by the span: 9000 over the 2s measured, not
    // over the CLI's 3s.
    expect(tokensPerSecond(declined).overall).toBe(4500);
  });

  test("a run whose turns never produced a result is labelled snapshot, not reported", () => {
    // The 21 claude-code runs of 29 on disk on 2026-08-25: a watchdog kill, so
    // no finished output count was ever emitted and what stands is the API's
    // opening usage — provider-reported and ~300x too low. It must not read
    // like a repaired run.
    const driver = summarize({ t: "driver", ts: 900, driver: "claude-code" }, 0, 0, 1);
    const killed = tokenTotals([driver, req(1000, 1), res(3000, 1, 7), req(4000, 2), res(6000, 2, 11)]);
    expect(killed.source).toBe("snapshot");
    expect(killed.completionTokens).toBe(18);

    // The same records under the fixed loop are finished counts, and say so.
    const fixedLoop = tokenTotals([req(1000, 1), res(3000, 1, 7), req(4000, 2), res(6000, 2, 11)]);
    expect(fixedLoop.source).toBe("reported");

    // And a run whose turns DID resolve stays `reported` even with an
    // in-flight turn on the end carrying a snapshot of its own.
    const repaired = tokenTotals([
      driver,
      req(1000, 1),
      res(3000, 1, 7),
      claudeResult(4000, 1, { output_tokens: 9000 }, { durationMs: 3000 }),
      req(5000, 2),
      res(7000, 2, 11),
    ]);
    expect(repaired.source).toBe("reported");
    expect(repaired.completionTokens).toBe(9011);
  });

  test("a turn with no usable result keeps the snapshot figures", () => {
    // In flight, or cut short by the watchdog: turn 2 never gets a result, and
    // a result reporting no output at all speaks for nothing.
    const t = tokenTotals([
      req(1000, 1),
      res(3000, 1, 7),
      claudeResult(4000, 1, { output_tokens: 0 }, { durationApiMs: 1000 }),
      req(5000, 2),
      res(7000, 2, 11),
    ]);
    expect(t.completionTokens).toBe(18);
  });

  test("a run with no claude_result at all is untouched", () => {
    const entries = [req(1000, 1), res(3000, 1, 400), req(4000, 2), res(6000, 2, 400)];
    expect(tokensPerSecond(entries)).toEqual({ overall: 200, recent: 200, replies: 2, recentReplies: 2 });
    expect(tokenTotals(entries).completionTokens).toBe(800);
  });

  test("scanRunTotals and the tail agree on a claude-code run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-claude-"));
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ t: "meta", ts: 1000 }),
        JSON.stringify({ t: "request", ts: 2000, turn: 1, messages: [{ role: "user", content: "hello" }] }),
        JSON.stringify({
          t: "response", ts: 3000, turn: 1, message: { role: "assistant", content: "hi" },
          usage: { prompt_tokens: 500, completion_tokens: 2 },
        }),
        JSON.stringify({ t: "snippet_result", ts: 3500, turn: 1, text: "ok" }),
        JSON.stringify({
          t: "response", ts: 5000, turn: 1, message: { role: "assistant", content: "again" },
          usage: { prompt_tokens: 700, completion_tokens: 3 },
        }),
        JSON.stringify({
          t: "claude_result", ts: 6000, turn: 1, subtype: "success", isError: false, numTurns: 2,
          durationMs: 4000, durationApiMs: 2000, costUsd: 0.5,
          usageRaw: { input_tokens: 10, output_tokens: 5000, iterations: [{ output_tokens: 900 }] },
          usage: { prompt_tokens: 1200, completion_tokens: 5000, total_tokens: 6200 },
        }),
        "",
      ].join("\n"),
    );
    const totals = await scanRunTotals(path);
    expect(totals.tokens.completionTokens).toBe(5000);
    // One reply: 5000 output over the turn's two spans (1s + 1.5s), which is
    // model time — not the CLI's 2s of API clock and not its 4s turn.
    expect(totals.tps).toEqual({ overall: 2000, recent: 2000, replies: 1, recentReplies: 1 });
    const tail = new TrajectoryTail(path);
    const scanned = await tail.scan();
    expect(tokensPerSecond(scanned)).toEqual(totals.tps);
    expect(tokenTotals(scanned)).toEqual(totals.tokens);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty run has no rate at all", () => {
    expect(tokensPerSecond([])).toEqual({ overall: null, recent: null, replies: 0, recentReplies: 0 });
  });
});

describe("scanRunTotals", () => {
  test("totals a whole file and reports the wall clock it spans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-scan-"));
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ t: "meta", ts: 1000 }),
        JSON.stringify({ t: "request", ts: 1100, messages: [{ role: "user", content: "hello" }] }),
        JSON.stringify({
          t: "response", ts: 1200, message: { role: "assistant", content: "hi" },
          usage: { prompt_tokens: 500, completion_tokens: 20, cached_tokens: 100 },
        }),
        JSON.stringify({ t: "state", ts: 5000, level: 2 }),
        "",
      ].join("\n"),
    );
    const totals = await scanRunTotals(path);
    expect(totals.entries).toBe(4);
    expect(totals.segments).toEqual([{ start: 1000, end: null }]);
    expect(totals.firstTs).toBe(1000);
    expect(totals.lastTs).toBe(5000);
    expect(totals.tokens.source).toBe("reported");
    expect(totals.tokens.totalTokens).toBe(520);
    expect(totals.tokens.cacheReadTokens).toBe(100);
    expect(totals.tokens.cacheWriteTokens).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("back-fills the resolved model from a claude-code run's init record", async () => {
    // The backlog case: nothing on meta.json or in the run row, and the only
    // record of which Claude this was is the CLI's own first word.
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-scan-"));
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ t: "meta", ts: 1000 }),
        JSON.stringify({
          t: "claude_system", ts: 1050, turn: 1, type: "system", subtype: "init",
          model: "claude-sonnet-5", claude_code_version: "2.1.239",
        }),
        JSON.stringify({ t: "request", ts: 1100, messages: [{ role: "user", content: "hello" }] }),
        // A later session that resolved differently must not overwrite the
        // answer the run's score was earned under: first observation wins.
        JSON.stringify({
          t: "claude_system", ts: 9000, turn: 9, type: "system", subtype: "init",
          model: "claude-opus-5", claude_code_version: "2.2.0",
        }),
        "",
      ].join("\n"),
    );
    const totals = await scanRunTotals(path);
    expect(totals.resolved).toEqual({ model: "claude-sonnet-5", cliVersion: "2.1.239" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("back-fills the served model from an openai run's response, and says nothing when none named one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-scan-"));
    const path = join(dir, "trajectory.jsonl");
    const responded = (model: string | null): string =>
      JSON.stringify({
        t: "response", ts: 1200, message: { role: "assistant", content: "hi" },
        ...(model === null ? {} : { model }),
      });
    writeFileSync(path, [JSON.stringify({ t: "meta", ts: 1000 }), responded("z-ai/glm-5.2"), ""].join("\n"));
    const totals = await scanRunTotals(path);
    // No CLI drove it, so there is no version to report — null, not a guess.
    expect(totals.resolved).toEqual({ model: "z-ai/glm-5.2", cliVersion: null });

    // A run written before the field existed reads "not recorded" rather than
    // being labelled with the string it was launched under.
    const old = join(dir, "old.jsonl");
    writeFileSync(old, [JSON.stringify({ t: "meta", ts: 1000 }), responded(null), ""].join("\n"));
    expect((await scanRunTotals(old)).resolved).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing file is an empty run, not a crash", async () => {
    const totals = await scanRunTotals(join(tmpdir(), "wrathbench-no-such-run", "trajectory.jsonl"));
    expect(totals.entries).toBe(0);
    expect(totals.firstTs).toBeNull();
    expect(totals.tokens.totalTokens).toBe(0);
  });
});

describe("active segments and playtime", () => {
  const marks = (...pairs: [string, number][]): { t: string; ts: number }[] =>
    pairs.map(([t, ts]) => ({ t, ts }));

  test("two pause/resume gaps sum to the active stretches only", () => {
    const segs = segmentsFrom(
      marks(
        ["meta", 500],
        ["pause", 1_000],
        ["resume", 10_000],
        ["pause", 11_500],
        ["resume", 20_000],
        ["termination", 22_000],
      ),
    );
    expect(segs).toEqual([
      { start: 500, end: 1_000 },
      { start: 10_000, end: 11_500 },
      { start: 20_000, end: 22_000 },
    ]);
    // Span is 21.5s; 9s + 8.5s of it was paused.
    expect(playtimeMs(segs, { lastTs: 22_000, live: false, now: 99_999 })).toBe(4_000);
  });

  test("a live run's open segment counts to now", () => {
    const segs = segmentsFrom(marks(["meta", 1_000], ["pause", 2_000], ["resume", 5_000]));
    expect(playtimeMs(segs, { lastTs: 6_000, live: true, now: 9_000 })).toBe(1_000 + 4_000);
    // Not live: the last entry closes it, not the clock.
    expect(playtimeMs(segs, { lastTs: 6_000, live: false, now: 9_000 })).toBe(1_000 + 1_000);
  });

  test("a run that is paused right now does not count the pause it sits in", () => {
    const segs = segmentsFrom(marks(["meta", 1_000], ["resume", 1_000], ["pause", 4_000]));
    expect(playtimeMs(segs, { lastTs: 4_000, live: true, now: 99_000 })).toBe(3_000);
  });

  test("a run without pauses is its whole span", () => {
    const segs = segmentsFrom(marks(["meta", 1_000], ["termination", 8_000]));
    expect(playtimeMs(segs, { lastTs: 8_000, live: false, now: 50_000 })).toBe(7_000);
  });

  test("a second meta mid-file (a resume that regenerated its token) opens nothing", () => {
    const segs = segmentsFrom(
      marks(["meta", 1_000], ["pause", 2_000], ["resume", 5_000], ["meta", 5_100], ["termination", 6_000]),
    );
    expect(segs).toEqual([
      { start: 1_000, end: 2_000 },
      { start: 5_000, end: 6_000 },
    ]);
  });

  test("the pause-mark meta written right after a pause does not reopen the segment", () => {
    // run.ts appends `pause`, then `writeMeta({ pause })` a few ms later, which
    // appends another `meta`. The quota wait between them and `resume` is not
    // playtime (this over-read paused runs past 100% of budget until 08-25).
    const segs = segmentsFrom(
      marks(["meta", 1_000], ["pause", 2_000], ["meta", 2_005], ["resume", 9_000], ["meta", 9_001], ["pause", 9_500], ["meta", 9_510]),
    );
    expect(segs).toEqual([
      { start: 1_000, end: 2_000 },
      { start: 9_000, end: 9_500 },
    ]);
    expect(playtimeMs(segs, { lastTs: 9_510, live: true, now: 99_000 })).toBe(1_500);
  });

  test("a trajectory with no meta falls back to its first record", () => {
    expect(segmentsFrom(marks(["state", 3_000], ["termination", 4_000]))).toEqual([
      { start: 3_000, end: 4_000 },
    ]);
    expect(playtimeMs([], { lastTs: null, live: false, now: 1 })).toBeNull();
  });
});

describe("platformOf", () => {
  test("names the platform from the api base", () => {
    expect(platformOf("https://openrouter.ai/api/v1", "openai")).toBe("openrouter");
    expect(platformOf("https://api.anthropic.com", "openai")).toBe("anthropic");
    expect(platformOf("https://api.openai.com/v1", "openai")).toBe("openai");
    expect(platformOf("http://127.0.0.1:9999/v1", "openai")).toBe("local");
    expect(platformOf("https://api.together.xyz/v1", "openai")).toBe("together.xyz");
  });

  test("falls back to the driver when there is no api base", () => {
    expect(platformOf(null, "claude-code")).toBe("claude-code");
    expect(platformOf(null, null)).toBeNull();
  });

  // FOLLOW-UPS 36: the LAN box is `local` — the same test `billingOf` calls
  // the operator's own hardware — while a public IPv4 is a platform like any
  // other host and is not laundered into "local".
  test("classifies the private ranges as local and leaves public hosts alone", () => {
    expect(platformOf("http://192.168.1.50:1234/v1", "openai")).toBe("local");
    expect(platformOf("http://10.0.0.4:1234/v1", "openai")).toBe("local");
    expect(platformOf("http://172.16.3.9:1234/v1", "openai")).toBe("local");
    expect(platformOf("http://studio.local:1234/v1", "openai")).toBe("local");
    expect(platformOf("http://203.0.113.7:8080/v1", "openai")).toBe("203.0.113.7");
  });
});

describe("readRun", () => {
  test("reads the pause reason as stored; no platform column reads null, not a guess", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-viewer-runs-"));
    const dir = join(runsDir, "paused-run");
    mkdirSync(dir);
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
      ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT,
      termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT);
      CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
      x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER);`);
    db.query(`INSERT INTO run (run_id, pause_reason, config_json) VALUES (?, ?, ?)`).run(
      "paused-run",
      "quota-exhausted",
      "{}",
    );
    db.close();

    expect(readRun(runsDir, "paused-run").pauseReason).toBe("quota-exhausted");
    // No `platform` column (a 0.4-1..5 schema) and no api base: nothing to derive from.
    expect(readRun(runsDir, "paused-run").platform).toBeNull();
  });

  test("the stamped platform and character columns win over the derivation", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-viewer-cols-"));
    const dir = join(runsDir, "stamped-run");
    mkdirSync(dir);
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
      ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT, character TEXT,
      platform TEXT, termination_reason TEXT, termination_detail TEXT, pause_reason TEXT,
      config_json TEXT);`);
    db.query(
      `INSERT INTO run (run_id, driver, character, platform, config_json) VALUES (?, ?, ?, ?, ?)`,
    ).run("stamped-run", "openai", "Grimbold", "local", '{"apiBase":"http://192.168.1.50:1234/v1"}');
    db.close();

    const row = readRun(runsDir, "stamped-run");
    expect(row.platform).toBe("local");
    expect(row.character).toBe("Grimbold");
  });

  /** The `state` table grows columns; an old run directory never gets them. */
  function runWithState(columns: string, rows: unknown[][]): { runsDir: string; id: string } {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-viewer-state-"));
    const id = "a-run";
    const dir = join(runsDir, id);
    mkdirSync(dir);
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
      ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT,
      termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT);
      CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER${columns});`);
    db.query(`INSERT INTO run (run_id, config_json) VALUES (?, ?)`).run(id, "{}");
    const width = 4 + columns.split(",").filter((c) => c.trim().length > 0).length;
    const holes = new Array(width).fill("?").join(", ");
    for (const r of rows) db.query(`INSERT INTO state VALUES (${holes})`).run(...(r as never[]));
    db.close();
    return { runsDir, id };
  }

  test("money and quests read from a schema that has them, newest non-null wins", () => {
    const { runsDir, id } = runWithState(", money INTEGER, quests_completed INTEGER", [
      [ "a-run", 100, 2, 50, 12345, 7 ],
      // A later sample that recorded neither must not erase the last reading.
      [ "a-run", 200, 3, 90, null, null ],
    ]);
    const row = readRun(runsDir, id);
    expect(row.money).toBe(12345);
    expect(row.questsCompleted).toBe(7);
  });

  test("a recorded zero is kept, not mistaken for nothing recorded", () => {
    const { runsDir, id } = runWithState(", money INTEGER, quests_completed INTEGER", [
      ["a-run", 100, 2, 50, 0, 0],
    ]);
    const row = readRun(runsDir, id);
    expect(row.money).toBe(0);
    expect(row.questsCompleted).toBe(0);
  });

  test("a schema without the columns yields null, not an error", () => {
    const { runsDir, id } = runWithState("", [["a-run", 100, 2, 50]]);
    const row = readRun(runsDir, id);
    expect(row.money).toBeNull();
    expect(row.questsCompleted).toBeNull();
    expect(row.error).toBeUndefined();
    // The rest of the row still reads normally against the older schema.
    expect(row.level).toBe(2);
  });
});

describe("zone and area milestones (FOLLOW-UPS 35)", () => {
  const ms = (kind: "zone" | "area", to: number, from?: number) =>
    JSON.stringify({ t: "milestone", ts: 2000, kind, to: { id: to }, ...(from === undefined ? {} : { from: { id: from } }), turn: 1 });

  function fileWith(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-milestone-"));
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(path, [...lines, ""].join("\n"));
    return path;
  }

  test("a run that never left its first area records that, and it is not a blank", async () => {
    const path = fileWith([
      JSON.stringify({ t: "meta", ts: 1000 }),
      ms("zone", 12),
      ms("area", 9),
      ms("area", 9),
    ]);
    const { areas } = await scanRunTotals(path);
    expect(areas).not.toBeNull();
    expect(areas!.startArea).toBe(9);
    expect(areas!.distinctAreas).toBe(1);
    expect(areas!.leftStartArea).toBe(false);
    expect(areas!.capitalZone).toBeNull();
  });

  test("a capital zone and a departed start area are both seen", async () => {
    // 501/502 are placeholders outside every known tutorial region, so this
    // is testing plain id-inequality, not the Northshire/Coldridge grouping.
    const path = fileWith([
      JSON.stringify({ t: "meta", ts: 1000 }),
      ms("area", 501),
      ms("area", 502, 501),
      ms("area", 502, 502),
      ms("zone", 12),
      ms("zone", 1519, 12), // Stormwind
    ]);
    const { areas } = await scanRunTotals(path);
    expect(areas!.leftStartArea).toBe(true);
    expect(areas!.distinctAreas).toBe(2);
    expect(areas!.capitalZone).toBe(1519);
  });

  test("a trajectory from before the producer yields null, never false", async () => {
    const path = fileWith([
      JSON.stringify({ t: "meta", ts: 1000 }),
      JSON.stringify({ t: "state", ts: 1100, level: 3 }),
      JSON.stringify({ t: "quest_complete", ts: 1200, questId: 7 }),
    ]);
    const { areas } = await scanRunTotals(path);
    expect(areas).toBeNull();
  });

  test("a resume re-emits a `from`-less mark, and the FIRST one is the start", () => {
    // `lastAreaId` is per process, so a resumed run opens with no `from` again.
    // 501/502 are placeholders outside every known tutorial region.
    const facts = areaFactsFrom([
      { kind: "area", to: 501, from: null },
      { kind: "area", to: 502, from: 501 },
      { kind: "area", to: 502, from: null }, // the resumed process, still in 502
      { kind: "zone", to: 12, from: null },
      { kind: "zone", to: 12, from: null },
    ])!;
    expect(facts.startArea).toBe(501);
    expect(facts.leftStartArea).toBe(true);
    expect(facts.distinctAreas).toBe(2);
    expect(facts.areaMarks).toBe(3);
    expect(facts.zoneMarks).toBe(2);
  });

  test("zone marks with no area mark leave `leftStartArea` unanswered", () => {
    const facts = areaFactsFrom([{ kind: "zone", to: 1637, from: null }])!;
    expect(facts.startArea).toBeNull();
    expect(facts.leftStartArea).toBeNull();
    expect(facts.distinctAreas).toBe(0);
    expect(facts.capitalZone).toBe(1637); // Orgrimmar
  });

  test("no marks at all is null, not an empty reading", () => {
    expect(areaFactsFrom([])).toBeNull();
  });

  test("wandering the whole Northshire cluster is not leaving the start (GPT Luna, 2026-08-26)", () => {
    // Northshire Valley -> Abbey -> Vineyards -> Echo Ridge Mine, zone 12
    // throughout: every area is the same tutorial region, so this must not
    // read as having left it.
    const facts = areaFactsFrom([
      { kind: "area", to: 9, from: null },
      { kind: "area", to: 24, from: 9 },
      { kind: "area", to: 59, from: 24 },
      { kind: "area", to: 34, from: 59 },
    ])!;
    expect(facts.startArea).toBe(9);
    expect(facts.leftStartArea).toBe(false);
  });

  test("a transient step out of the cluster that returns is not a sustained exit (Sonnet-medium, 2026-08-26)", () => {
    // Coldridge Valley -> Coldridge Pass -> generic Dun Morogh area -> back
    // to Coldridge Valley: the excursion to the wider zone is undone before
    // the run ends, so this must not count as having left.
    const facts = areaFactsFrom([
      { kind: "area", to: 132, from: null },
      { kind: "area", to: 800, from: 132 },
      { kind: "area", to: 1, from: 800 },
      { kind: "area", to: 132, from: 1 },
    ])!;
    expect(facts.startArea).toBe(132);
    expect(facts.leftStartArea).toBe(false);
  });

  test("a sustained step out of the cluster into the wider zone is leaving the start (Fable, 2026-08-26)", () => {
    // Coldridge Valley -> Coldridge Pass -> generic Dun Morogh area, twice in
    // a row (and once more for good measure): unlike the Sonnet-medium run,
    // which bounces straight back, this is two-plus consecutive observations
    // outside the cluster, i.e. a sustained presence outside it, not a blip.
    const facts = areaFactsFrom([
      { kind: "area", to: 132, from: null },
      { kind: "area", to: 800, from: 132 },
      { kind: "area", to: 1, from: 800 },
      { kind: "area", to: 1, from: 1 },
      { kind: "area", to: 1, from: 1 },
    ])!;
    expect(facts.startArea).toBe(132);
    expect(facts.leftStartArea).toBe(true);
  });
});

describe("achievement and flight milestones (issue #8)", () => {
  function fileWith(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-achievement-"));
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(path, [...lines, ""].join("\n"));
    return path;
  }
  const meta = JSON.stringify({ t: "meta", ts: 1000 });
  const login = (ids: number[], points: number) =>
    JSON.stringify({ t: "milestone", ts: 1100, kind: "achievements_at_login", ids, points, turn: 1 });
  const earn = (id: number, points?: number) =>
    JSON.stringify({ t: "milestone", ts: 1200, kind: "achievement", id, ...(points === undefined ? {} : { points }), turn: 2 });
  const takeoff = JSON.stringify({ t: "milestone", ts: 1300, kind: "taxi", from: { areaId: 9 }, turn: 3 });
  const landed = JSON.stringify({ t: "milestone", ts: 1400, kind: "taxi_landed", to: { areaId: 1519 }, turn: 4 });

  test("a run from before the taps has neither reading — null, never zero", async () => {
    const { achievements, taxi } = await scanRunTotals(
      fileWith([meta, JSON.stringify({ t: "milestone", ts: 1100, kind: "area", to: { id: 9 } })]),
    );
    expect(achievements).toBeNull();
    expect(taxi).toBeNull();
  });

  test("a login backlog plus one earn: the union is what the character holds", async () => {
    const { achievements, taxi } = await scanRunTotals(fileWith([meta, login([6, 7], 25), earn(12, 10)]));
    expect(achievements).toEqual({ earned: 3, points: 35, ids: [6, 7, 12] });
    // The backlog record proves the taps were live, so zero flights is a
    // reading rather than a blank.
    expect(taxi).toEqual({ flights: 0 });
  });

  test("an earn whose points the module could not name adds none rather than a guess", async () => {
    const { achievements } = await scanRunTotals(fileWith([meta, login([], 0), earn(12)]));
    expect(achievements).toEqual({ earned: 1, points: 0, ids: [12] });
  });

  test("a resumed run's second backlog is a superset, and its points are not added twice", () => {
    const facts = achievementFactsFrom([
      { kind: "login", ids: [6], points: 10 },
      { kind: "earned", id: 12, points: 10 },
      { kind: "login", ids: [6, 12], points: 20 }, // the resumed process's backlog
      { kind: "earned", id: 15, points: 5 },
    ])!;
    expect(facts).toEqual({ earned: 3, points: 25, ids: [6, 12, 15] });
  });

  test("flights count takeoffs; a landing only witnesses that the taps were live", async () => {
    const { taxi } = await scanRunTotals(fileWith([meta, takeoff, landed, takeoff]));
    expect(taxi).toEqual({ flights: 2 });
  });

  test("landings alone still read as a recording, at zero takeoffs", () => {
    expect(taxiFactsFrom(["taxi_landed"], false)).toEqual({ flights: 0 });
    expect(taxiFactsFrom([], false)).toBeNull();
    expect(taxiFactsFrom([], true)).toEqual({ flights: 0 });
  });

  test("no achievement mark at all is null, not an empty reading", () => {
    expect(achievementFactsFrom([])).toBeNull();
  });

  test("the tail's incremental index derives the same facts as the whole-file scan", async () => {
    const path = fileWith([meta, login([6], 10), earn(12, 10), takeoff]);
    const tail = new TrajectoryTail(path);
    await tail.scan();
    const totals = await scanRunTotals(path);
    expect(tail.achievements).toEqual(totals.achievements);
    expect(tail.taxi).toEqual(totals.taxi);
    // A second scan of an unchanged file adds nothing.
    await tail.scan();
    expect(tail.achievements).toEqual(totals.achievements);
  });
});
