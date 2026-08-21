import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformOf, readRun } from "../viewer/runs";
import { TrajectoryTail, splitLines, summarize, tokenTotals } from "../viewer/tail";

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
    expect(platformOf(null, "claude-subscription")).toBe("claude-subscription");
    expect(platformOf(null, null)).toBeNull();
  });
});

describe("readRun", () => {
  test("renders a pre-rename pause reason in the current vocabulary", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-viewer-runs-"));
    const dir = join(runsDir, "paused-run");
    mkdirSync(dir);
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE run (run_id TEXT PRIMARY KEY, harness_version TEXT, started_at INTEGER,
      ended_at INTEGER, adapter TEXT, driver TEXT, shakeout TEXT, model TEXT,
      termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT);
      CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER,
      x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER);`);
    db.query(`INSERT INTO run (run_id, pause_reason, config_json) VALUES (?, ?, ?)`).run(
      "paused-run",
      "window-exhausted",
      "{}",
    );
    db.close();

    expect(readRun(runsDir, "paused-run").pauseReason).toBe("quota-exhausted");
  });
});
