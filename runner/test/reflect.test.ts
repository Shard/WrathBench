/**
 * The reflection gate, the episodic log, and the two notices the message
 * window raises around a block trim. Fixture-driven: no live stack, no model.
 *
 * The decisions under test are docs/METHODOLOGY.md, "Reflection is the model's
 * to take, and only at rest" and "An episodic log, written before each trim,
 * read back at rest".
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StubAdapter } from "../src/adapter";
import { loadRunConfig } from "../src/config";
import {
  CONTEXT_POLICY,
  assembleContext,
  formatStateSummary,
  lastTurnGrowth,
  messageWindowCut,
  messageWindowRawCut,
  trimExpected,
  type ChatMessage,
} from "../src/context";
import { EpisodicLog, EPISODIC_TEXT_CHARS, capEntryText, formatEntry } from "../src/episodic";
import { ContextBuilder, runLoop } from "../src/loop";
import {
  READ_LOG_CLOSED,
  REFLECT_ALREADY_USED,
  REFLECT_BREAKER_NOTICE,
  REFLECT_MAX_TURNS,
  REFLECT_NOT_RESTING,
  REFLECTION_PROMPT,
  ReflectGate,
  ClosedWindowReflectGate,
  restingOf,
} from "../src/reflect";
import { Scratchpad } from "../src/scratchpad";
import { callTool, TOOLS, type ToolContext } from "../src/tools";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";

/** A sandbox whose snapshot is whatever the test last set. */
function fakeSandbox(state: { resting?: boolean; level?: number; zone?: string }): SandboxHost {
  return {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () =>
      Promise.resolve({
        self: {
          ...(state.resting === undefined ? {} : { resting: { value: state.resting, seq: 1, ts: 1 } }),
          ...(state.level === undefined ? {} : { level: { value: state.level, seq: 1, ts: 1 } }),
          ...(state.zone === undefined ? {} : { zone: { value: { id: 1, name: state.zone }, seq: 1, ts: 1 } }),
        },
        lastSeq: -1,
        eventCount: 0,
      }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

function makeCtx(state: { resting?: boolean; level?: number; zone?: string } = {}): {
  ctx: ToolContext;
  state: typeof state;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-reflect-"));
  const ctx: ToolContext = {
    sandbox: fakeSandbox(state),
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    reflect: new ReflectGate(),
    turn: () => 7,
    sessionLive: () => true,
  };
  return { ctx, state, dir };
}

describe("the resting decode", () => {
  test("restingOf reads the SDK's decoded flag, and nothing else", () => {
    expect(restingOf({ self: { resting: { value: true } } })).toBe(true);
    expect(restingOf({ self: { resting: { value: false } } })).toBe(false);
    expect(restingOf({ self: {} })).toBeUndefined();
    expect(restingOf(null)).toBeUndefined();
  });

  test("the HUD prints `resting` only when the flag is true", () => {
    const base = { self: {}, lastSeq: 1, eventCount: 1 };
    // Byte-stable for a snapshot that never carried playerFlags: no ui line.
    expect(formatStateSummary(base, { sessionLive: true })).not.toContain("ui:");
    expect(
      formatStateSummary({ ...base, self: { resting: { value: false } } }, { sessionLive: true }),
    ).not.toContain("resting");
    expect(
      formatStateSummary({ ...base, self: { resting: { value: true } } }, { sessionLive: true }),
    ).toContain("ui: resting");
  });
});

describe("the reflect gate", () => {
  test("refuses when the character is not resting, with the world fact as the hint", async () => {
    const { ctx } = makeCtx({ resting: false });
    const res = await callTool(ctx, "reflect", {});
    expect(res.isError).toBe(true);
    expect(res.text).toBe(REFLECT_NOT_RESTING);
  });

  test("an unobserved resting flag reads as not resting", async () => {
    const { ctx } = makeCtx({});
    expect((await callTool(ctx, "reflect", {})).text).toBe(REFLECT_NOT_RESTING);
  });

  test("resting yields the fixed prompt; a second call in the same visit refuses", async () => {
    const { ctx } = makeCtx({ resting: true });
    const first = await callTool(ctx, "reflect", {});
    expect(first.isError).toBeUndefined();
    expect(first.text).toBe(REFLECTION_PROMPT);
    const second = await callTool(ctx, "reflect", {});
    expect(second.isError).toBe(true);
    expect(second.text).toBe(REFLECT_ALREADY_USED);
  });

  test("leaving the rest area and returning re-arms it", async () => {
    const { ctx, state } = makeCtx({ resting: true });
    expect((await callTool(ctx, "reflect", {})).text).toBe(REFLECTION_PROMPT);
    // The context builder's sample sees the character leave; that is the only
    // thing that re-arms, and it happens without any reflect call.
    state.resting = false;
    ctx.reflect.note(false);
    expect((await callTool(ctx, "reflect", {})).text).toBe(REFLECT_NOT_RESTING);
    state.resting = true;
    ctx.reflect.note(true);
    expect((await callTool(ctx, "reflect", {})).text).toBe(REFLECTION_PROMPT);
  });

  test("the reflect answer names the log's entry count only when there is one", async () => {
    const { ctx } = makeCtx({ resting: true });
    expect((await callTool(ctx, "reflect", {})).text).toBe(REFLECTION_PROMPT);
    ctx.reflect.note(false);
    ctx.reflect.note(true);
    ctx.episodic.append({ turn: 1, text: "still in the valley" });
    const again = await callTool(ctx, "reflect", {});
    expect(again.text).toContain(REFLECTION_PROMPT);
    expect(again.text).toContain("1 status entry in your episodic log; read them with read_log.");
  });

  test("the breaker closes the window after REFLECT_MAX_TURNS and refuses after it", () => {
    const gate = new ReflectGate();
    gate.note(true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.drainEvents();
    for (let i = 0; i < REFLECT_MAX_TURNS - 1; i++) {
      gate.noteTurn();
      expect(gate.isOpen).toBe(true);
    }
    gate.noteTurn();
    expect(gate.isOpen).toBe(false);
    expect(gate.drainEvents()).toEqual([{ event: "close", reason: "breaker" }]);
    // Still the same rest visit: reflect stays spent until the character leaves.
    expect(gate.request().text).toBe(REFLECT_ALREADY_USED);
    gate.note(false);
    gate.note(true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
  });

  test("leaving the rest area closes an open window", () => {
    const gate = new ReflectGate();
    gate.note(true);
    gate.request();
    gate.drainEvents();
    gate.note(false);
    expect(gate.isOpen).toBe(false);
    expect(gate.drainEvents()).toEqual([{ event: "close", reason: "left_rest" }]);
  });
});

describe("read_log", () => {
  test("refuses outside a reflection window", async () => {
    const { ctx } = makeCtx({ resting: true });
    ctx.episodic.append({ turn: 1, text: "one" });
    const res = await callTool(ctx, "read_log", {});
    expect(res.isError).toBe(true);
    expect(res.text).toBe(READ_LOG_CLOSED);
  });

  test("is usable on every turn of an open window, and refused once rest ends", async () => {
    const { ctx } = makeCtx({ resting: true });
    ctx.episodic.append({ turn: 1, level: 3, zone: "Elwynn Forest", text: "one" });
    await callTool(ctx, "reflect", {});
    for (let i = 0; i < 3; i++) {
      ctx.reflect.noteTurn();
      const res = await callTool(ctx, "read_log", {});
      expect(res.isError).toBeUndefined();
      expect(res.text).toContain("[turn 1, L3, Elwynn Forest] one");
    }
    ctx.reflect.note(false);
    expect((await callTool(ctx, "read_log", {})).isError).toBe(true);
  });

  test("pages oldest first and clamps the page", async () => {
    const { ctx } = makeCtx({ resting: true });
    for (let i = 1; i <= 5; i++) ctx.episodic.append({ turn: i, text: `entry ${i}` });
    await callTool(ctx, "reflect", {});
    const page = await callTool(ctx, "read_log", { offset: 2, limit: 2 });
    expect(page.text.split("\n")[0]).toBe("showing 3–4 of 5");
    expect(page.text).toContain("entry 3");
    expect(page.text).toContain("entry 4");
    expect(page.text).not.toContain("entry 5");
    // A limit past the cap is clamped, not refused.
    const all = await callTool(ctx, "read_log", { limit: 999 });
    expect(all.text.split("\n")[0]).toBe("showing 1–5 of 5");
  });
});

describe("log_status", () => {
  test("appends an entry stamped by the harness, not by the model", async () => {
    const { ctx } = makeCtx({ resting: false, level: 4, zone: "Dun Morogh" });
    const written: unknown[] = [];
    ctx.onEpisodicEntry = (e) => written.push(e);
    const res = await callTool(ctx, "log_status", { text: "  heading to Kharanos  " });
    expect(res.isError).toBeUndefined();
    expect(ctx.episodic.read()).toEqual([
      expect.objectContaining({ turn: 7, level: 4, zone: "Dun Morogh", text: "heading to Kharanos" }),
    ]);
    expect(written).toHaveLength(1);
  });

  test("truncates deterministically at the cap", () => {
    const long = "x".repeat(EPISODIC_TEXT_CHARS + 10);
    const capped = capEntryText(long);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe(`${"x".repeat(EPISODIC_TEXT_CHARS)}…[truncated 10 chars]`);
    expect(capEntryText(long)).toEqual(capped);
  });

  test("an unobserved level or zone renders as ?", () => {
    expect(formatEntry({ ts: 0, turn: 2, text: "hi" })).toBe("[turn 2, L?, ?] hi");
  });

  test("the log is append-only across reopenings", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-episodic-"));
    const path = join(dir, "episodic.jsonl");
    new EpisodicLog(path).append({ turn: 1, text: "first" });
    new EpisodicLog(path).append({ turn: 2, text: "second" });
    expect(new EpisodicLog(path).read().map((e) => e.text)).toEqual(["first", "second"]);
  });
});

describe("the window-trim notices", () => {
  const assistant = (): ChatMessage => ({ role: "assistant", content: "x" });
  const tool = (): ChatMessage => ({ role: "tool", content: "y", tool_call_id: "1" });

  test("lastTurnGrowth counts the assistant message and its tool results", () => {
    expect(lastTurnGrowth([])).toBe(1);
    expect(lastTurnGrowth([assistant()])).toBe(1);
    expect(lastTurnGrowth([assistant(), tool(), tool()])).toBe(3);
  });

  test("under variable per-turn growth, every trim is preceded by exactly one prompt", () => {
    // The case the previous, predictive formulation got wrong: a turn that
    // adds more messages than the one before it crossed the boundary without
    // ever raising the prompt. Growth is driven by the model's tool-call count,
    // so it varies turn to turn — here 1, 3, 2, 4 and around again.
    const history: ChatMessage[] = [];
    const announced: number[] = [];
    const trimmed: number[] = [];
    let lastCut = 0;
    for (let turn = 0; turn < 120; turn++) {
      if (trimExpected(history)) announced.push(turn);
      const cut = messageWindowCut(history);
      if (cut > lastCut) {
        trimmed.push(turn);
        lastCut = cut;
      }
      history.push(assistant());
      for (let k = 0; k < [0, 2, 1, 3][turn % 4]!; k++) history.push(tool());
    }
    expect(announced.length).toBeGreaterThan(3);
    // Exactly one prompt per trim, on the immediately preceding turn: never
    // two, never zero, whatever the growth did across the boundary.
    expect(trimmed).toEqual(announced.map((t) => t + 1));
    expect(messageWindowRawCut(CONTEXT_POLICY.MESSAGE_WINDOW_MAX + 1)).toBe(
      CONTEXT_POLICY.MESSAGE_WINDOW_TRIM,
    );
  });

  test("the loop raises trim_pending before the trim and window_trimmed at it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-trim-"));
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1 }),
      runId: "run-trim",
      token: "run-trim",
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
    // Variable tool-call count per turn, so the message growth varies with it:
    // the crossing turn is routinely bigger or smaller than the one before,
    // which is exactly what a predictive trigger got wrong.
    const script = Array.from({ length: 60 }, (_, i) => ({
      content: "acting",
      toolCalls: Array.from({ length: [1, 3, 2, 1][i % 4]! }, () => ({
        name: "run_snippet",
        arguments: { code: "1" },
      })),
    }));
    await runLoop({
      config,
      adapter: new StubAdapter(script),
      sandbox: fakeSandbox({ resting: false }),
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    });
    const requests = readTrajectory(dir).filter((r) => r.t === "request");
    const lastContent = (r: (typeof requests)[number]): string =>
      (r["messages"] as { content: string }[]).slice(-1)[0]!.content;
    const noticeTurns = (kind: string): number[] =>
      requests.flatMap((r, i) => (lastContent(r).includes(`- ${kind}:`) ? [i] : []));
    const pending = noticeTurns("trim_pending");
    const trimmed = noticeTurns("window_trimmed");
    // Several block boundaries over the run, each announced on the turn before
    // it and on no other turn.
    expect(pending.length).toBeGreaterThanOrEqual(3);
    // The last prompt of the run has no following turn to carry its trim.
    expect(trimmed).toEqual(pending.filter((t) => t + 1 < requests.length).map((t) => t + 1));
    expect(lastContent(requests[pending[0]!]!)).toContain(
      "Older conversation will be trimmed after this turn. Record a short status entry",
    );
    expect(lastContent(requests[trimmed[0]!]!)).toContain("your scratchpad is your memory");
    trajectory.close();
  });

  test("the trim notices are ordinary context inputs — assembleContext stays pure", () => {
    const inputs = {
      stateSummary: "== state ==",
      events: [],
      scratchpad: "",
      notices: [{ ts: 1, kind: "trim_pending" as const, text: "t" }],
      turn: 3,
    };
    expect(assembleContext(inputs)).toBe(assembleContext(inputs));
    expect(assembleContext(inputs)).toContain("- trim_pending: t");
  });
});

describe("the reflection window on the record", () => {
  /** A loop run with a mutable resting state and a scripted tool sequence. */
  async function run(
    state: { resting?: boolean },
    script: { content: string | null; toolCalls: { name: string; arguments: Record<string, unknown> }[] }[],
  ): Promise<{ dir: string; records: ReturnType<typeof readTrajectory> }> {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-reflect-run-"));
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1 }),
      runId: "run-reflect",
      token: "run-reflect",
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
    await runLoop({
      config,
      adapter: new StubAdapter(script),
      sandbox: fakeSandbox(state),
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    });
    trajectory.close();
    return { dir, records: readTrajectory(dir) };
  }

  const reflectCall = { name: "reflect", arguments: {} };
  const noop = { name: "state_summary", arguments: {} };

  test("a granted reflection writes an open record, and the run's end closes it", async () => {
    const { records } = await run({ resting: true }, [
      { content: null, toolCalls: [reflectCall] },
      { content: null, toolCalls: [noop] },
    ]);
    const windows = records.filter((r) => r.t === "reflect_window");
    expect(windows.map((r) => [r["event"], r["reason"]])).toEqual([
      ["open", undefined],
      ["close", "run_end"],
    ]);
    // The reflect turn is marked and still counted as an ordinary turn.
    const marked = records.filter((r) => r.t === "tool_result" && r["reflect"] === true);
    expect(marked).toHaveLength(1);
    expect(marked[0]!["isError"]).toBe(false);
    expect(records.filter((r) => r.t === "request").length).toBeGreaterThan(2);
  });

  test("leaving the rest area closes the window through the state sample alone", async () => {
    const state = { resting: true };
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-reflect-builder-"));
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1 }),
      runId: "run-builder",
      token: "run-builder",
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
    const builder = new ContextBuilder({
      config,
      sandbox: fakeSandbox(state),
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
    });
    await builder.sampleState();
    expect(builder.reflect.request().text).toBe(REFLECTION_PROMPT);
    expect(builder.reflect.isOpen).toBe(true);
    // Nothing calls note() by hand: the world changes and the sample sees it.
    state.resting = false;
    await builder.sampleState();
    expect(builder.reflect.isOpen).toBe(false);
    expect(builder.reflect.drainEvents()).toEqual([
      { event: "open" },
      { event: "close", reason: "left_rest" },
    ]);
    // ...and coming back re-arms, again through the sample alone.
    state.resting = true;
    await builder.sampleState();
    expect(builder.reflect.request().text).toBe(REFLECTION_PROMPT);
    trajectory.close();
  });

  test("the breaker closes the window and its notice reaches the next context", async () => {
    const script = [
      { content: null, toolCalls: [reflectCall] },
      ...Array.from({ length: REFLECT_MAX_TURNS + 2 }, () => ({ content: null, toolCalls: [noop] })),
    ];
    const { records } = await run({ resting: true }, script);
    const windows = records.filter((r) => r.t === "reflect_window");
    expect(windows.map((r) => r["event"])).toEqual(["open", "close"]);
    expect(windows[1]!["reason"]).toBe("breaker");
    // The model is told, in the assembled context of the turn after it fired.
    const told = records.filter(
      (r) =>
        r.t === "request" &&
        (r["messages"] as { content: string }[]).slice(-1)[0]!.content.includes("- reflect_ended:"),
    );
    expect(told).toHaveLength(1);
    expect((told[0]!["messages"] as { content: string }[]).slice(-1)[0]!.content).toContain(
      REFLECT_BREAKER_NOTICE,
    );
  });
});

describe("the standalone MCP gate", () => {
  test("reflect answers but read_log never opens", async () => {
    const { ctx } = makeCtx({ resting: true });
    ctx.reflect = new ClosedWindowReflectGate();
    ctx.episodic.append({ turn: 1, text: "one" });
    expect((await callTool(ctx, "reflect", {})).text).toBe(REFLECTION_PROMPT);
    expect((await callTool(ctx, "read_log", {})).text).toBe(READ_LOG_CLOSED);
  });
});

describe("the tool list", () => {
  test("carries the three new tools and their descriptions add no game knowledge", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("reflect");
    expect(names).toContain("log_status");
    expect(names).toContain("read_log");
    for (const name of ["reflect", "log_status", "read_log"]) {
      const d = TOOLS.find((t) => t.name === name)!.description;
      // The refusal text names inns and cities because that is the world fact
      // the gate is; a tool description must not go beyond it into advice.
      expect(d).not.toMatch(/\bquests?\b|level up|\bkill\b|vendor|trainer/i);
    }
    expect(REFLECT_BREAKER_NOTICE).toContain(String(REFLECT_MAX_TURNS));
  });
});
