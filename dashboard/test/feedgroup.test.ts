/**
 * The feed grouping (`lib/feedgroup.ts`): what may be glued together and, just
 * as load-bearing, what may not. The trajectory writers order the same entry
 * types differently (see the module comment), so each writer's shape is pinned
 * here, along with the edges the derivation must survive — a window cut
 * mid-pair and a live tail that has a call but no result yet. The per-writer
 * fixtures carry no `dispatchTs`, so their durations pin the legacy fallback
 * for trajectories written before the stamp.
 */

import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "../../viewer/api-types";
import { groupFeed } from "../src/lib/feedgroup";

let seq = 0;
function e(t: string, ts: number, extra: Record<string, unknown> = {}): FeedEntry {
  return { i: seq++, t, ts, start: 0, end: 0, ...extra } as FeedEntry;
}

/** The fixed loop's cycle for one turn with two tool calls. */
function wrathbenchTurn(turn: number, at: number): FeedEntry[] {
  return [
    e("state", at),
    e("events_served", at + 1, { via: "context", count: 64, opcodes: ["SMSG_X×3"] }),
    e("request", at + 2, { turn, messageCount: 25, promptChars: 33743, clipped: true }),
    e("response", at + 12_000, { turn, text: "thinking…", tools: ["run_snippet"] }),
    e("tool_call", at + 12_001, { turn, name: "run_snippet", args: { code: "return 1" } }),
    e("snippet", at + 12_001, { turn, code: "return 1" }),
    e("snippet_result", at + 12_450, { turn, name: "run_snippet", isError: false, text: "ok" }),
    e("tool_call", at + 12_500, { turn, name: "search_reference", args: { query: "kobold" } }),
    e("tool_result", at + 12_700, { turn, name: "search_reference", isError: false, text: "# Quest" }),
  ];
}

describe("groupFeed on the fixed loop's cycle", () => {
  test("one turn folds to state · turn header · response · two call cards", () => {
    const kinds = groupFeed(wrathbenchTurn(12, 1000)).map((g) => g.kind);
    expect(kinds).toEqual(["plain", "turn", "response", "call", "call"]);
  });

  test("a snippet card holds the code and the result, with a real duration", () => {
    const g = groupFeed(wrathbenchTurn(12, 1000))[3]!;
    if (g.kind !== "call") throw new Error(g.kind);
    expect(g.call?.name).toBe("run_snippet");
    expect(g.snippet?.code).toBe("return 1");
    expect(g.result?.text).toBe("ok");
    expect(g.durationMs).toBe(449);
  });

  test("ambient records inside a call survive, ahead of the card", () => {
    // The mid-turn ticker writes state rows AND milestone/quest records while
    // a call is in flight; any non-structural type must be scanned past, not
    // treated as "the result was never written".
    const entries = [
      e("tool_call", 1_000, { turn: 3, name: "await_events", args: {} }),
      e("state", 5_000),
      e("quest_complete", 6_000, { questId: 7 }),
      e("events_served", 9_000, { via: "tool", count: 2 }),
      e("milestone", 10_000, { kind: "zone" }),
      e("tool_result", 11_000, { turn: 3, name: "await_events", isError: false, text: "2 events" }),
    ];
    const groups = groupFeed(entries);
    expect(groups.map((g) => g.kind)).toEqual(["plain", "plain", "plain", "plain", "call"]);
    const card = groups[4]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.durationMs).toBe(10_000);
  });

  test("a result from a different turn is never glued on", () => {
    const entries = [
      e("tool_call", 0, { turn: 3, name: "run_snippet", args: {} }),
      e("snippet", 0, { turn: 3, code: "x" }),
      e("snippet_result", 10, { turn: 4, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const groups = groupFeed(entries);
    expect(groups.map((g) => g.kind)).toEqual(["call", "call"]);
    const first = groups[0]!;
    if (first.kind !== "call") throw new Error(first.kind);
    expect(first.result).toBeNull();
  });
});

describe("groupFeed on the claude driver's shape", () => {
  test("post-hoc triples pair by call index and show no fabricated duration", () => {
    // The driver appends call/snippet/result together after the call ran, so
    // their timestamps are write time — a ~0ms spread that must not display.
    const entries = [
      e("events_served", 100, { via: "tool", count: 1 }),
      e("tool_call", 200, { turn: 1, call: 7, name: "run_snippet", args: {} }),
      e("snippet", 200, { turn: 1, call: 7, code: "y" }),
      e("snippet_result", 201, { turn: 1, call: 7, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const groups = groupFeed(entries);
    expect(groups.map((g) => g.kind)).toEqual(["plain", "call"]);
    const card = groups[1]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.snippet?.code).toBe("y");
    expect(card.result?.text).toBe("ok");
    expect(card.durationMs).toBeNull();
  });
});

describe("groupFeed with the writers' dispatch stamp", () => {
  // Every writer now stamps `dispatchTs`; the shape inference above is only
  // the fallback for trajectories written before it.
  test("a stamped claude-driver triple shows its real duration", () => {
    const entries = [
      e("tool_call", 9_000, { turn: 1, call: 7, name: "run_snippet", args: {}, dispatchTs: 1_000 }),
      e("snippet", 9_000, { turn: 1, call: 7, code: "y" }),
      e("snippet_result", 9_001, { turn: 1, call: 7, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const card = groupFeed(entries)[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.durationMs).toBe(8_001);
  });
});

describe("groupFeed at the window's edges", () => {
  test("a trailing call with no result yet stays open, not glued to nothing", () => {
    const groups = groupFeed([
      e("tool_call", 0, { turn: 2, name: "run_snippet", args: {} }),
      e("snippet", 0, { turn: 2, code: "while(1){}" }),
    ]);
    const card = groups[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.result).toBeNull();
    expect(card.durationMs).toBeNull();
  });
});

describe("groupFeed identity reuse", () => {
  test("settled groups keep their object identity across a tail append", () => {
    // Solid's <For> reconciles by reference: a settled row must come back as
    // the SAME object or every append rebuilds the whole feed's DOM.
    const turn = wrathbenchTurn(12, 1000);
    const first = groupFeed(turn);
    const second = groupFeed([...turn, e("state", 20_000)], first);
    for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]!);
    expect(second).toHaveLength(first.length + 1);
  });
});

/*
 * Envelopes, thinking markers and the records a call sets off, in the order
 * each writer puts them on the file (shapes copied from recorded runs).
 */
type Groups = ReturnType<typeof groupFeed>;
type Card = Extract<Groups[number], { kind: "call" }>;
const kinds = (gs: Groups): string[] => gs.map((g) => (g.kind === "plain" ? g.entry.t : g.kind));
const cards = (gs: Groups): Card[] => gs.filter((g): g is Card => g.kind === "call");

describe("groupFeed: a store session's calls", () => {
  /**
   * As the viewer serves a session read from a wrath-mcp store
   * (`viewer/record-feed.ts`): each call's records side by side where
   * it returned, its start in `dispatchTs`, the action log before it. Here the
   * snippet dispatched at 1_000 was still running when the other call
   * (1_100 to 1_200) returned, and errs at 4_000.
   */
  function storeStretch(): FeedEntry[] {
    return [
      e("tool_call", 500, { call: 1, name: "state_summary", args: {}, dispatchTs: 400 }),
      e("tool_result", 500, { name: "state_summary", isError: false, text: "{}" }),
      e("tool_call", 1_200, { call: 3, name: "recent_events", args: { limit: 5 }, dispatchTs: 1_100 }),
      e("tool_result", 1_200, { name: "recent_events", isError: false, text: "[]" }),
      e("actions", 3_000, { callTs: 1_000, actions: [{ ts: 2_900, action: "attack_start", status: 200 }] }),
      e("actions", 3_000, { callTs: 400, routine: true, actions: [{ ts: 2_950, action: "questgiver_status_query", status: 200 }] }),
      e("milestone", 3_500, { kind: "level", from: 1, to: 2 }),
      e("tool_call", 4_000, { call: 2, name: "run_snippet", args: { code: "await sdk.killTarget(g)" }, dispatchTs: 1_000 }),
      e("snippet", 4_000, { code: "await sdk.killTarget(g)" }),
      e("snippet_result", 4_000, { name: "run_snippet", isError: true, text: "error (3000ms)\nTypeError: no target" }),
    ];
  }

  test("each call is one card with its code, result, duration and action log; a routine's flush and the game's rows stay rows", () => {
    const gs = groupFeed(storeStretch(), [], null, false);
    expect(kinds(gs)).toEqual(["call", "call", "actions", "milestone", "call"]);
    const [summary, events, kill] = cards(gs);
    expect([summary!.result?.text, events!.result?.text]).toEqual(["{}", "[]"]);
    expect(kill!.snippet?.code).toBe("await sdk.killTarget(g)");
    expect(kill!.result).toMatchObject({ isError: true, text: "error (3000ms)\nTypeError: no target" });
    expect(cards(gs).map((c) => c.durationMs)).toEqual([100, 100, 3_000]);
    expect(kill!.actions.map((a) => a.ts)).toEqual([3_000]);
  });
});

describe("groupFeed: tool-call envelopes", () => {
  /**
   * claude-code: the PREVIOUS call's envelope, flushed as this message starts
   * and carrying the thinking the viewer summed off the markers before it,
   * then this call.
   */
  function claudeStretch(): FeedEntry[] {
    return [
      e("tool_call", 1_000, { turn: 1, call: 1, name: "run_snippet", args: { code: "a" }, dispatchTs: 990 }),
      e("snippet", 1_000, { turn: 1, call: 1, code: "a" }),
      e("snippet_result", 1_000, { turn: 1, call: 1, name: "run_snippet", isError: false, text: "ok" }),
      e("response", 4_000, { turn: 1, text: "", tools: ["mcp__wrathbench__run_snippet"], usage: { prompt: 13_000, completion: 8 }, thinkingTokens: 150 }),
      e("tool_call", 4_010, { turn: 1, call: 2, name: "edit_file", args: { path: "main.ts", old: "a", new: "b" }, dispatchTs: 4_003 }),
      e("tool_result", 4_010, { turn: 1, call: 2, name: "edit_file", isError: false, text: "edited main.ts" }),
    ];
  }

  test("claude-code: the envelope after its card is not a row, and the markers are the next card's thinking", () => {
    const gs = groupFeed(claudeStretch(), [], "claude-code");
    expect(kinds(gs)).toEqual(["call", "call"]);
    // The model's time before the edit: from the snippet's result to the edit's dispatch.
    expect(cards(gs)[1]!.lead).toEqual({ thinkMs: 3_003, thinkingTokens: 150, envelope: null });
  });

  test("codex: an envelope written an item late, after another card, is still claimed by name", () => {
    const gs = groupFeed(
      [
        e("tool_call", 1_000, { turn: 1, call: 1, name: "read_file", args: { path: "API.md" }, dispatchTs: 998 }),
        e("tool_result", 1_000, { turn: 1, call: 1, name: "read_file", isError: false, text: "…" }),
        e("tool_call", 2_000, { turn: 1, call: 2, name: "run_snippet", args: { code: "x" }, dispatchTs: 1_900 }),
        e("snippet", 2_000, { turn: 1, call: 2, code: "x" }),
        e("snippet_result", 2_000, { turn: 1, call: 2, name: "run_snippet", isError: false, text: "ok" }),
        e("response", 2_004, { turn: 1, text: "", tools: ["wrathbench.read_file"] }),
        e("response", 2_008, { turn: 1, text: "", tools: ["wrathbench.run_snippet"] }),
      ],
      [],
      "codex",
    );
    expect(kinds(gs)).toEqual(["call", "call"]);
    // No think time on codex: code mode dispatches calls from a script.
    expect(cards(gs).every((c) => c.lead === null)).toBe(true);
  });

  test("pi: the envelope before its call moves onto the card with its thinking, tokens and stop reason", () => {
    const env = e("response", 1_590, { turn: 1, text: "", tools: ["mcp__wrathbench__run_snippet"], stopReason: "toolUse", thinkingChars: 228, usage: { prompt: 9_000, completion: 121 } });
    const gs = groupFeed(
      [
        e("snippet_result", 10, { turn: 1, call: 1, name: "run_snippet", isError: false, text: "ok" }),
        env,
        e("actions", 1_600, { callTs: 1_599, actions: [] }),
        e("tool_call", 1_610, { turn: 1, call: 2, name: "run_snippet", args: { code: "y" }, dispatchTs: 1_599 }),
        e("snippet", 1_610, { turn: 1, call: 2, code: "y" }),
        e("snippet_result", 1_610, { turn: 1, call: 2, name: "run_snippet", isError: false, text: "ok" }),
      ],
      [],
      "pi",
    );
    expect(kinds(gs)).toEqual(["call", "call"]);
    // The model's time runs from the previous result to this call's dispatch.
    expect(cards(gs)[1]!.lead).toEqual({ thinkMs: 1_589, thinkingTokens: null, envelope: env as never });
  });
});

describe("groupFeed: records a call set off, joined by time", () => {
  test("a deploy written before the write's card (a post-hoc writer) is on that card", () => {
    const deploy = e("deploy", 5_000, { ok: true, by: "save", deploy: 3, routines: ["grind"] });
    const gs = groupFeed(
      [
        e("tool_call", 4_000, { turn: 1, call: 9, name: "write_file", args: { path: "main.ts", content: "x" }, dispatchTs: 3_000 }),
        e("tool_result", 4_000, { turn: 1, call: 9, name: "write_file", isError: false, text: "wrote main.ts" }),
        deploy,
        e("tool_call", 5_010, { turn: 1, call: 10, name: "write_file", args: { path: "main.ts", content: "y" }, dispatchTs: 4_990 }),
        e("tool_result", 5_010, { turn: 1, call: 10, name: "write_file", isError: false, text: "wrote main.ts" }),
      ],
      [],
      "claude-code",
    );
    expect(kinds(gs)).toEqual(["call", "call"]);
    const [first, second] = cards(gs);
    // The deploy's stamp is inside the second write's span, not the first's.
    expect(first!.deploys).toEqual([]);
    expect(second!.deploys).toEqual([deploy]);
  });

  test("a yield's wake is on its card and counted once; a codex turn-end wake stays a row", () => {
    const wake = e("wake", 62_941, { via: "yield", turn: 1, sleptMs: 60_000, n: 1 });
    const gs = groupFeed(
      [
        wake,
        e("tool_call", 62_942, { turn: 1, call: 15, name: "yield", args: { seconds: 60 }, dispatchTs: 2_936 }),
        e("tool_result", 62_942, { turn: 1, call: 15, name: "yield", isError: false, text: "[wake 1 · slept 1m00s]" }),
        e("wake", 70_000, { via: "turn-end", turn: 2, sleptMs: 5_000 }),
      ],
      [],
      "claude-code",
    );
    expect(kinds(gs)).toEqual(["call", "wake"]);
    expect(cards(gs)[0]!.wake).toBe(wake);
  });
});

describe("groupFeed: the run's end", () => {
  const detail = "no tool call for 1248527ms: 5 wakes in a row answered without one";

  test("a watchdog whose termination follows with the same reason folds into it", () => {
    const gs = groupFeed([
      e("watchdog", 1_000, { reason: "idle", detail }),
      e("wind-down", 1_001, { reason: "idle" }),
      e("termination", 1_002, { reason: "idle", detail }),
      // A later termination, a manual classification, is its own row.
      e("termination", 9_000, { reason: "harness-error", detail: "manually classified" }),
    ]);
    expect(kinds(gs)).toEqual(["wind-down", "termination", "termination"]);
  });
});
