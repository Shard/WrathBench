/**
 * The reflection gate, the episodic log, and the two notices the message
 * window raises around a block trim. Fixture-driven: no live stack, no model.
 *
 * The decisions under test are docs/METHODOLOGY.md, "Reflection is the model's
 * to take, and only at rest or in flight" and "An episodic log, asked for at
 * each trim or compaction, read back at rest or in flight".
 */
import { describe, expect, test } from "bun:test";
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
import {
  EpisodicLog,
  EPISODIC_PAGE_DEFAULT,
  EPISODIC_PAGE_MAX,
  EPISODIC_TEXT_CHARS,
  capEntryText,
  formatEntry,
} from "../src/episodic";
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
  taxiFlightOf,
} from "../src/reflect";
import { Scratchpad } from "../src/scratchpad";
import { callTool, TOOLS, type ToolContext } from "../src/tools";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { requestsOf, userMessagesOf } from "./fixtures/requests";
import { Watchdogs } from "../src/watchdogs";
import { SecretRedactor } from "../src/redact";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** A sandbox whose snapshot is whatever the test last set. */
function fakeSandbox(state: { resting?: boolean; taxiFlight?: boolean; level?: number; zone?: string }): SandboxHost {
  return {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () =>
      Promise.resolve({
        self: {
          ...(state.resting === undefined ? {} : { resting: { value: state.resting, seq: 1, ts: 1 } }),
          ...(state.taxiFlight === undefined ? {} : { taxiFlight: { value: state.taxiFlight, seq: 1, ts: 1 } }),
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

function makeCtx(state: { resting?: boolean; taxiFlight?: boolean; level?: number; zone?: string } = {}): {
  ctx: ToolContext;
  state: typeof state;
  dir: string;
} {
  const dir = tempDir("wrathbench-reflect-");
  const ctx: ToolContext = {
    sandbox: fakeSandbox(state),
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    reflect: new ReflectGate(),
    turn: () => 7,
    secrets: new SecretRedactor(),
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

describe("the flight window (operator, 2026-10-14)", () => {
  test("taxiFlightOf reads the SDK's decoded flag, and nothing else", () => {
    expect(taxiFlightOf({ self: { taxiFlight: { value: true } } })).toBe(true);
    expect(taxiFlightOf({ self: { taxiFlight: { value: false } } })).toBe(false);
    expect(taxiFlightOf({ self: {} })).toBeUndefined();
    expect(taxiFlightOf(null)).toBeUndefined();
  });

  test("a flight yields the fixed prompt through the tool; a second call in the same flight refuses", async () => {
    const { ctx } = makeCtx({ resting: false, taxiFlight: true });
    const first = await callTool(ctx, "reflect", {});
    expect(first.isError).toBeUndefined();
    expect(first.text).toBe(REFLECTION_PROMPT);
    expect((await callTool(ctx, "reflect", {})).text).toBe(REFLECT_ALREADY_USED);
  });

  test("neither resting nor flying refuses, and so does an unobserved flight flag", async () => {
    expect((await callTool(makeCtx({ resting: false, taxiFlight: false }).ctx, "reflect", {})).text).toBe(
      REFLECT_NOT_RESTING,
    );
    expect((await callTool(makeCtx({ resting: false }).ctx, "reflect", {})).text).toBe(REFLECT_NOT_RESTING);
  });

  test("an unobserved flight flag leaves a latched flight standing", () => {
    const gate = new ReflectGate();
    gate.note(false, true);
    gate.note(undefined, undefined);
    gate.note(false);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    expect(gate.isOpen).toBe(true);
  });

  test("landing outside a rest area closes the window as `landed`, and the next flight re-arms", () => {
    const gate = new ReflectGate();
    gate.note(false, false);
    gate.note(false, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.note(false, false);
    expect(gate.isOpen).toBe(false);
    expect(gate.drainEvents()).toEqual([{ event: "open" }, { event: "close", reason: "landed" }]);
    expect(gate.request().text).toBe(REFLECT_NOT_RESTING);
    gate.note(false, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
  });

  test("a multi-hop flight is one flight while the flag holds across its legs", () => {
    const gate = new ReflectGate();
    gate.note(false, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.drainEvents();
    // Every intermediate node passes with the flag still set: nothing closes
    // and nothing re-arms.
    for (let leg = 0; leg < 3; leg++) gate.note(false, true);
    expect(gate.isOpen).toBe(true);
    expect(gate.request().text).toBe(REFLECT_ALREADY_USED);
    expect(gate.drainEvents()).toEqual([]);
  });

  test("landing in a city after a flight's reflection allows the rest visit's own", () => {
    // Both flags flipping in one sample: the flight's window closes as it
    // lands, and the city is a rest visit of its own.
    const gate = new ReflectGate();
    gate.note(false, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.note(true, false);
    expect(gate.isOpen).toBe(false);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    expect(gate.request().text).toBe(REFLECT_ALREADY_USED);
    expect(gate.drainEvents()).toEqual([
      { event: "open" },
      { event: "close", reason: "landed" },
      { event: "open" },
    ]);
  });

  test("a city's rest flag coming on before the landing is the rest visit beginning", () => {
    // The zone updates in flight, so the rest flag can precede the landing; a
    // reflection there spends the rest visit's and keeps the window open
    // through the landing until the city is left.
    const gate = new ReflectGate();
    gate.note(false, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.note(true, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.note(true, false);
    expect(gate.isOpen).toBe(true);
    expect(gate.request().text).toBe(REFLECT_ALREADY_USED);
    gate.note(false, false);
    // One window, extended rather than opened twice.
    expect(gate.drainEvents()).toEqual([{ event: "open" }, { event: "close", reason: "left_rest" }]);
  });

  test("taking off from a city where the model already reflected allows the flight's own", () => {
    const gate = new ReflectGate();
    gate.note(true, false);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.note(true, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    // Leaving the city behind does not close a window the flight also holds.
    gate.note(false, true);
    expect(gate.isOpen).toBe(true);
    expect(gate.request().text).toBe(REFLECT_ALREADY_USED);
    gate.note(false, false);
    expect(gate.drainEvents()).toEqual([{ event: "open" }, { event: "close", reason: "landed" }]);
  });

  test("a window granted at rest closes when the city is left, even in flight; the flight's own stays available", () => {
    const gate = new ReflectGate();
    gate.note(true, false);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    gate.note(true, true);
    gate.note(false, true);
    expect(gate.isOpen).toBe(false);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    expect(gate.drainEvents()).toEqual([
      { event: "open" },
      { event: "close", reason: "left_rest" },
      { event: "open" },
    ]);
  });

  test("one reflection while both flags are set spends both", () => {
    const gate = new ReflectGate();
    gate.note(true, true);
    expect(gate.request().text).toBe(REFLECTION_PROMPT);
    expect(gate.request().text).toBe(REFLECT_ALREADY_USED);
    gate.note(false, true);
    expect(gate.request().text).toBe(REFLECT_ALREADY_USED);
  });

  test("read_log follows the flight window: open in flight, refused after landing", async () => {
    const { ctx, state } = makeCtx({ resting: false, taxiFlight: true });
    ctx.episodic.append({ turn: 1, text: "flying to the harbor" });
    expect((await callTool(ctx, "read_log", {})).text).toBe(READ_LOG_CLOSED);
    await callTool(ctx, "reflect", {});
    expect((await callTool(ctx, "read_log", {})).text).toContain("flying to the harbor");
    state.taxiFlight = false;
    ctx.reflect.note(false, false);
    expect((await callTool(ctx, "read_log", {})).text).toBe(READ_LOG_CLOSED);
  });

  test("the builder's state sample alone arms a flight and closes its window on landing", async () => {
    const state: { resting: boolean; taxiFlight?: boolean } = { resting: false };
    const dir = tempDir("wrathbench-reflect-flight-");
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1 }),
      runId: "run-flight",
      token: "run-flight",
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
    expect(builder.reflect.request().text).toBe(REFLECT_NOT_RESTING);
    state.taxiFlight = true;
    await builder.sampleState();
    expect(builder.reflect.request().text).toBe(REFLECTION_PROMPT);
    state.taxiFlight = false;
    await builder.sampleState();
    expect(builder.reflect.isOpen).toBe(false);
    expect(builder.reflect.drainEvents()).toEqual([
      { event: "open" },
      { event: "close", reason: "landed" },
    ]);
    trajectory.close();
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

  /** Entry texts of a page, in the order it printed them. */
  const texts = (page: string): string[] =>
    page
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^\[[^\]]*\] /, ""));

  test("reads newest first by default, and pages back from there", async () => {
    const { ctx } = makeCtx({ resting: true });
    for (let i = 1; i <= 5; i++) ctx.episodic.append({ turn: i, text: `entry ${i}` });
    await callTool(ctx, "reflect", {});
    const first = await callTool(ctx, "read_log", {});
    expect(first.text.split("\n")[0]).toBe("showing 1–5 of 5, newest first");
    expect(texts(first.text)).toEqual(["entry 5", "entry 4", "entry 3", "entry 2", "entry 1"]);
    const page = await callTool(ctx, "read_log", { offset: 2, limit: 2 });
    expect(page.text.split("\n")[0]).toBe("showing 3–4 of 5, newest first");
    expect(texts(page.text)).toEqual(["entry 3", "entry 2"]);
  });

  test("order oldest starts from the first entry; the order word is read ignoring case", async () => {
    const { ctx } = makeCtx({ resting: true });
    for (let i = 1; i <= 5; i++) ctx.episodic.append({ turn: i, text: `entry ${i}` });
    await callTool(ctx, "reflect", {});
    const page = await callTool(ctx, "read_log", { order: " Oldest ", offset: 2, limit: 2 });
    expect(page.text.split("\n")[0]).toBe("showing 3–4 of 5, oldest first");
    expect(texts(page.text)).toEqual(["entry 3", "entry 4"]);
    const bad = await callTool(ctx, "read_log", { order: "latest" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('order?: "newest" | "oldest"');
  });

  test("the oldest entries of a long log are reachable both ways, past the page cap", async () => {
    const { ctx } = makeCtx({ resting: true });
    const n = 3 * EPISODIC_PAGE_MAX + 7;
    for (let i = 1; i <= n; i++) ctx.episodic.append({ turn: i, text: `entry ${i}` });
    await callTool(ctx, "reflect", {});
    const oldest = await callTool(ctx, "read_log", { order: "oldest", limit: 3 });
    expect(texts(oldest.text)).toEqual(["entry 1", "entry 2", "entry 3"]);
    // Newest first, the last page is the oldest entries.
    const tail = await callTool(ctx, "read_log", { offset: n - 3, limit: 3 });
    expect(tail.text.split("\n")[0]).toBe(`showing ${n - 2}–${n} of ${n}, newest first`);
    expect(texts(tail.text)).toEqual(["entry 3", "entry 2", "entry 1"]);
  });

  test("limit is clamped to its bounds; an offset past the end says so instead of showing another page", async () => {
    const { ctx } = makeCtx({ resting: true });
    for (let i = 1; i <= EPISODIC_PAGE_MAX + 10; i++) ctx.episodic.append({ turn: i, text: `entry ${i}` });
    await callTool(ctx, "reflect", {});
    const dflt = await callTool(ctx, "read_log", {});
    expect(texts(dflt.text)).toHaveLength(EPISODIC_PAGE_DEFAULT);
    const capped = await callTool(ctx, "read_log", { limit: 999 });
    expect(texts(capped.text)).toHaveLength(EPISODIC_PAGE_MAX);
    const floor = await callTool(ctx, "read_log", { limit: 0 });
    expect(texts(floor.text)).toEqual([`entry ${EPISODIC_PAGE_MAX + 10}`]);
    const past = await callTool(ctx, "read_log", { offset: 500 });
    expect(past.isError).toBeUndefined();
    expect(past.text).toBe(`offset 500 is past the end: ${EPISODIC_PAGE_MAX + 10}`);
  });

  test("filters by level range and zone on the harness's stamps; an unobserved stamp matches no filter", async () => {
    const { ctx } = makeCtx({ resting: true });
    ctx.episodic.append({ turn: 1, level: 3, zone: "Elwynn Forest", text: "a" });
    ctx.episodic.append({ turn: 2, level: 10, zone: "Westfall", text: "b" });
    ctx.episodic.append({ turn: 3, level: 12, zone: "Westfall", text: "c" });
    ctx.episodic.append({ turn: 4, text: "unstamped" });
    ctx.episodic.append({ turn: 5, level: 15, zone: "Duskwood", text: "d" });
    await callTool(ctx, "reflect", {});
    const range = await callTool(ctx, "read_log", { minLevel: 10, maxLevel: 12 });
    expect(range.text.split("\n")[0]).toBe("showing 1–2 of 2 matching level 10–12 (5 in the log), newest first");
    expect(texts(range.text)).toEqual(["c", "b"]);
    const zone = await callTool(ctx, "read_log", { zone: "  westFALL ", order: "oldest" });
    expect(texts(zone.text)).toEqual(["b", "c"]);
    expect(texts((await callTool(ctx, "read_log", { zone: "wood" })).text)).toEqual(["d"]);
    expect(texts((await callTool(ctx, "read_log", { minLevel: 12 })).text)).toEqual(["d", "c"]);
    expect(texts((await callTool(ctx, "read_log", { maxLevel: "3" })).text)).toEqual(["a"]);
    // Both filters at once, and an empty zone filters nothing.
    expect(texts((await callTool(ctx, "read_log", { zone: "westfall", minLevel: 11 })).text)).toEqual(["c"]);
    expect(texts((await callTool(ctx, "read_log", { zone: " " })).text)).toHaveLength(5);
    const none = await callTool(ctx, "read_log", { zone: "Stranglethorn", minLevel: 30 });
    expect(none.isError).toBeUndefined();
    expect(none.text).toBe('no entries match level 30+, zone "Stranglethorn" (5 in the log)');
  });

  test("an empty log says so whatever the query", async () => {
    const { ctx } = makeCtx({ resting: true });
    await callTool(ctx, "reflect", {});
    const res = await callTool(ctx, "read_log", { zone: "Westfall", order: "oldest" });
    expect(res.text).toBe("your episodic log is empty (nothing has been recorded with log_status)");
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
    const dir = tempDir("wrathbench-episodic-");
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
    const dir = tempDir("wrathbench-trim-");
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
    // Each request as the model saw it, rebuilt from the slim records.
    const requests = requestsOf(dir);
    const lastContent = (r: (typeof requests)[number]): string => String(r.messages.slice(-1)[0]!.content);
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
      "Older conversation will be trimmed, and older tool results folded to one-line records, after this turn. Record a short status entry",
    );
    expect(lastContent(requests[trimmed[0]!]!)).toContain("your scratchpad is your memory");
    // Every trim folds the block behind the verbatim one, and its notice counts
    // the results it folded: exactly the lines that were verbatim the turn before.
    for (const t of trimmed) {
      const n = Number(/, (\d+) older tool results? folded to one-line records\)/.exec(lastContent(requests[t]!))?.[1]);
      const foldedIn = (r: (typeof requests)[number]): number =>
        r.messages.filter((m) => m.role === "tool" && String(m.content).startsWith("[folded by harness] ")).length;
      const dropped = Number(/\((\d+) messages? dropped/.exec(lastContent(requests[t]!))?.[1]);
      expect(n).toBeGreaterThan(0);
      // Folded now, less what was already folded and still in the window.
      const before = requests[t - 1]!.messages.slice(1 + dropped, -1);
      const stillFolded = before.filter((m) => m.role === "tool" && String(m.content).startsWith("[folded by harness] ")).length;
      expect(foldedIn(requests[t]!) - stillFolded).toBe(n);
    }
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
    const dir = tempDir("wrathbench-reflect-run-");
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
    const dir = tempDir("wrathbench-reflect-builder-");
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
    const { dir, records } = await run({ resting: true }, script);
    const windows = records.filter((r) => r.t === "reflect_window");
    expect(windows.map((r) => r["event"])).toEqual(["open", "close"]);
    expect(windows[1]!["reason"]).toBe("breaker");
    // The model is told, in the assembled context of the turn after it fired.
    const told = userMessagesOf(dir).filter((u) => u.includes("- reflect_ended:"));
    expect(told).toHaveLength(1);
    expect(told[0]!).toContain(REFLECT_BREAKER_NOTICE);
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
