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
import type { FeedEntry } from "../../runner/viewer/api-types";
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
