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

  test("the turn header carries the request and its context events", () => {
    const g = groupFeed(wrathbenchTurn(12, 1000))[1]!;
    if (g.kind !== "turn") throw new Error(g.kind);
    expect(g.request.turn).toBe(12);
    expect(g.events?.count).toBe(64);
  });

  test("response latency is measured from the request", () => {
    const g = groupFeed(wrathbenchTurn(12, 1000))[2]!;
    if (g.kind !== "response") throw new Error(g.kind);
    expect(g.latencyMs).toBe(11_998);
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

  test("1:N responses each measure from the previous activity", () => {
    const entries = [
      e("request", 1_000, { turn: 1, messageCount: 1, promptChars: 100 }),
      e("response", 6_000, { turn: 1, text: "first" }),
      e("response", 10_000, { turn: 1, text: "second" }),
    ];
    const groups = groupFeed(entries);
    const [, r1, r2] = groups;
    if (r1?.kind !== "response" || r2?.kind !== "response") throw new Error("shape");
    expect(r1.latencyMs).toBe(5_000);
    expect(r2.latencyMs).toBe(4_000);
  });

  test("the MCP server's turn-less pairs group, also without a duration", () => {
    const entries = [
      e("tool_call", 50, { name: "search_reference", args: { query: "q" } }),
      e("tool_result", 51, { name: "search_reference", isError: false, text: "hit" }),
    ];
    const groups = groupFeed(entries);
    expect(groups).toHaveLength(1);
    const card = groups[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.result?.text).toBe("hit");
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

  test("a stamped MCP-server pair shows its real duration", () => {
    const entries = [
      e("tool_call", 700, { name: "search_reference", args: { query: "q" }, dispatchTs: 400 }),
      e("tool_result", 701, { name: "search_reference", isError: false, text: "hit" }),
    ];
    const card = groupFeed(entries)[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.durationMs).toBe(301);
  });

  test("the stamp wins over the record's own ts on the fixed loop's shape", () => {
    const entries = [
      e("tool_call", 1_010, { turn: 3, name: "run_snippet", args: {}, dispatchTs: 1_000 }),
      e("snippet", 1_010, { turn: 3, code: "x" }),
      e("snippet_result", 1_500, { turn: 3, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const card = groupFeed(entries)[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.durationMs).toBe(500);
  });

  test("a stamp later than the result is no duration, never a fallback", () => {
    const entries = [
      e("tool_call", 100, { turn: 3, name: "run_snippet", args: {}, dispatchTs: 900 }),
      e("snippet_result", 500, { turn: 3, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const card = groupFeed(entries)[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.result?.text).toBe("ok");
    expect(card.durationMs).toBeNull();
  });

  test("a stamped call with no result yet has no duration", () => {
    const entries = [e("tool_call", 100, { turn: 1, call: 2, name: "await_events", args: {}, dispatchTs: 50 })];
    const card = groupFeed(entries)[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.result).toBeNull();
    expect(card.durationMs).toBeNull();
  });
});

describe("groupFeed at the window's edges", () => {
  test("a leading orphan result renders as a card of its own", () => {
    const groups = groupFeed([
      e("snippet_result", 0, { turn: 2, name: "run_snippet", isError: true, text: "boom" }),
    ]);
    const card = groups[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.call).toBeNull();
    expect(card.result?.isError).toBe(true);
    expect(card.result?.name).toBe("run_snippet");
  });

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

  test("context events with no request yet stand alone and heal later", () => {
    const alone = groupFeed([e("events_served", 0, { via: "context", count: 3 })]);
    expect(alone.map((g) => g.kind)).toEqual(["plain"]);
    // The same window one tail batch later, request landed: now it is a header.
    const healed = groupFeed([
      e("events_served", 0, { via: "context", count: 3 }),
      e("request", 1, { turn: 9, messageCount: 4, promptChars: 10 }),
    ]);
    expect(healed.map((g) => g.kind)).toEqual(["turn"]);
  });

  test("a request whose context events are off-window still heads its turn", () => {
    const groups = groupFeed([e("request", 0, { turn: 5, messageCount: 2, promptChars: 4 })]);
    const g = groups[0]!;
    if (g.kind !== "turn") throw new Error(g.kind);
    expect(g.events).toBeNull();
  });

  test("a response with nothing before it shows no latency", () => {
    const groups = groupFeed([e("response", 500, { turn: 1, text: "hi" })]);
    const g = groups[0]!;
    if (g.kind !== "response") throw new Error(g.kind);
    expect(g.latencyMs).toBeNull();
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

  test("an open call group is replaced, not recycled, when its result arrives", () => {
    const call = e("tool_call", 1_000, { turn: 3, name: "run_snippet", args: {} });
    const snip = e("snippet", 1_000, { turn: 3, code: "x" });
    const first = groupFeed([call, snip]);
    const done = groupFeed(
      [call, snip, e("snippet_result", 2_000, { turn: 3, name: "run_snippet", isError: false, text: "ok" })],
      first,
    );
    expect(done).toHaveLength(1);
    expect(done[0]).not.toBe(first[0]!);
    const card = done[0]!;
    if (card.kind !== "call") throw new Error(card.kind);
    expect(card.result?.text).toBe("ok");
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

  test("with no model side no card has a think time; the same entries on a run with one do", () => {
    expect(cards(groupFeed(storeStretch(), [], null, false)).map((c) => c.lead)).toEqual([null, null, null]);
    expect(cards(groupFeed(storeStretch(), [], null)).some((c) => c.lead?.thinkMs != null)).toBe(true);
    // The run's detail can land after its entries: a derivation that timed the cards is not recycled once it is known.
    const entries = storeStretch();
    expect(cards(groupFeed(entries, groupFeed(entries, [], null), null, false)).map((c) => c.lead)).toEqual([null, null, null]);
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

  test("claude-code: an envelope naming a tool without the CLI's prefix is no card's, and stays a row", () => {
    // The model asked for `run_snippet` bare: the CLI never routed it to the run.
    const gs = groupFeed(
      [
        e("request", 0, { turn: 1, messageCount: 1 }),
        e("response", 1_000, { turn: 1, text: "", tools: ["run_snippet"] }),
        e("tool_call", 2_400, { turn: 1, call: 1, name: "run_snippet", args: { code: "a" }, dispatchTs: 1_020 }),
        e("snippet", 2_400, { turn: 1, call: 1, code: "a" }),
        e("snippet_result", 2_400, { turn: 1, call: 1, name: "run_snippet", isError: false, text: "ok" }),
        e("response", 3_800, { turn: 1, text: "", tools: ["mcp__wrathbench__run_snippet"] }),
      ],
      [],
      "claude-code",
    );
    expect(kinds(gs)).toEqual(["turn", "response", "call"]);
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

  test("codex: a reply in words keeps its latency; an envelope no card claimed draws none", () => {
    const gs = groupFeed(
      [e("request", 0, { turn: 1 }), e("response", 4_000, { turn: 1, text: "", tools: ["wrathbench.yield"] }), e("response", 9_000, { turn: 1, text: "Hunting." })],
      [],
      "codex",
    );
    expect(kinds(gs)).toEqual(["turn", "response", "response"]);
    const [, envelope, reply] = gs as Extract<Groups[number], { kind: "response" }>[];
    expect(envelope!.latencyMs).toBeNull();
    expect(reply!.latencyMs).toBe(5_000);
  });

  test("claude-code: a claimed envelope is not where the next reply's latency starts", () => {
    // The result, then the envelope stamped as the next message's first block lands, then that block's words.
    const gs = groupFeed(
      [
        e("tool_call", 1_000, { turn: 1, call: 1, name: "yield", args: { seconds: 60 }, dispatchTs: 900 }),
        e("tool_result", 1_000, { turn: 1, call: 1, name: "yield", isError: false, text: "[wake 1]" }),
        e("response", 3_000, { turn: 1, text: "", tools: ["mcp__wrathbench__yield"] }),
        e("response", 4_400, { turn: 1, text: "Selling greys." }),
      ],
      [],
      "claude-code",
    );
    expect(kinds(gs)).toEqual(["call", "response"]);
    const r = gs[1]!;
    if (r.kind !== "response") throw new Error(r.kind);
    expect(r.latencyMs).toBe(3_400);
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

  test("the fixed loop: an envelope with no text gives its card the model's time from the request", () => {
    const gs = groupFeed(
      [
        e("request", 1_000, { turn: 4, messageCount: 9 }),
        e("response", 9_000, { turn: 4, text: "", tools: ["run_snippet"], usage: { prompt: 5_000, completion: 40 } }),
        e("tool_call", 9_001, { turn: 4, name: "run_snippet", args: { code: "z" }, dispatchTs: 9_001 }),
        e("snippet", 9_001, { turn: 4, code: "z" }),
        e("snippet_result", 9_300, { turn: 4, name: "run_snippet", isError: false, text: "ok" }),
        // The same reply's second call follows at once: no think time.
        e("tool_call", 9_302, { turn: 4, name: "search_reference", args: { query: "q" }, dispatchTs: 9_302 }),
        e("tool_result", 9_400, { turn: 4, name: "search_reference", isError: false, text: "…" }),
      ],
      [],
      "wrathbench",
    );
    expect(kinds(gs)).toEqual(["turn", "call", "call"]);
    const [first, second] = cards(gs);
    expect(first!.lead?.thinkMs).toBe(8_001);
    expect(first!.lead?.envelope?.usage?.completion).toBe(40);
    expect(second!.lead).toBeNull();
  });

  test("a reply in words keeps its row and takes the thinking a claimed envelope carried before it", () => {
    // One message of words and a call: the previous call's envelope (thinking on it), the words, the call, its envelope.
    const gs = groupFeed(
      [
        e("tool_call", 1_000, { turn: 1, call: 1, name: "yield", args: { seconds: 60 }, dispatchTs: 900 }),
        e("tool_result", 1_000, { turn: 1, call: 1, name: "yield", isError: false, text: "[wake 1]" }),
        e("response", 2_000, { turn: 1, text: "", tools: ["mcp__wrathbench__yield"], thinkingTokens: 70 }),
        e("response", 2_001, { turn: 1, text: "Selling greys." }),
      ],
      [],
      "claude-code",
    );
    expect(kinds(gs)).toEqual(["call", "response"]);
    const r = gs[1]!;
    if (r.kind !== "response") throw new Error(r.kind);
    expect(r.lead?.thinkingTokens).toBe(70);
  });

  test("a pi compaction call is a row of its own, never an envelope", () => {
    const gs = groupFeed([e("response", 1_000, { turn: 2, kind: "compaction", text: "", tools: [], usage: { prompt: 40_000, completion: 900 }, piCostUsd: 0.01 })], [], "pi");
    expect(kinds(gs)).toEqual(["response"]);
  });

  test("a card whose lead arrives later is redrawn, not recycled", () => {
    const stretch = claudeStretch();
    const without = groupFeed(stretch.slice(3), [], "claude-code");
    const withLead = groupFeed(stretch, without, "claude-code");
    const before = cards(without).find((c) => c.call?.name === "edit_file")!;
    const after = cards(withLead).find((c) => c.call?.name === "edit_file")!;
    expect(after).not.toBe(before);
    expect(after.lead?.thinkingTokens).toBe(150);
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

  test("a deploy between the call and its result (the fixed loop) is on the card too", () => {
    const deploy = e("deploy", 1_050, { ok: false, by: "save", error: "SyntaxError" });
    const gs = groupFeed([
      e("tool_call", 1_000, { turn: 2, name: "edit_file", args: { path: "main.ts", old: "a", new: "b" }, dispatchTs: 1_000 }),
      deploy,
      e("tool_result", 1_100, { turn: 2, name: "edit_file", isError: false, text: "edited main.ts" }),
    ]);
    expect(kinds(gs)).toEqual(["call"]);
    expect(cards(gs)[0]!.deploys).toEqual([deploy]);
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

  test("a public window's wake, its skeleton alone, still joins by time", () => {
    const gs = groupFeed([
      e("wake", 62_941, { turn: 1 }),
      e("tool_call", 62_942, { turn: 1, call: 15, name: "yield", args: { seconds: 60 }, dispatchTs: 2_936 }),
      e("tool_result", 62_942, { turn: 1, call: 15, name: "yield", isError: false, text: "[wake 1]" }),
    ]);
    expect(kinds(gs)).toEqual(["call"]);
  });

  test("a deploy outside every write's span stays a row", () => {
    const gs = groupFeed([
      e("deploy", 500, { ok: true, deploy: 1 }),
      e("tool_call", 1_000, { turn: 2, name: "edit_file", args: {}, dispatchTs: 1_000 }),
      e("tool_result", 1_100, { turn: 2, name: "edit_file", isError: false, text: "edited" }),
    ]);
    expect(kinds(gs)).toEqual(["deploy", "call"]);
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

  test("a public window's watchdog, its reason alone, folds the same way", () => {
    expect(kinds(groupFeed([e("watchdog", 1_000, { reason: "idle" }), e("termination", 1_002, { reason: "idle", detail })]))).toEqual(["termination"]);
  });

  test("a watchdog the run went on past, or whose termination says another reason, stays a row", () => {
    expect(kinds(groupFeed([e("watchdog", 1_000, { reason: "idle" }), e("request", 1_001, { turn: 2 }), e("termination", 1_002, { reason: "idle" })]))).toEqual(["watchdog", "turn", "termination"]);
    expect(kinds(groupFeed([e("watchdog", 1_000, { reason: "no-xp" }), e("termination", 1_002, { reason: "idle" })]))).toEqual(["watchdog", "termination"]);
  });
});
