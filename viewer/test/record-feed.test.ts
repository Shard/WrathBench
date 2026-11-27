/**
 * A v1 run's game side in its run page's feed (`viewer/record-feed.ts`): the
 * session record's milestones, turn-ins, actions, moves and served event
 * batches, merged into the trajectory's entries by time, each with the turn
 * in flight, and read back whole by `raw`. Over the frozen phase-1 run, whose
 * trajectory still carries the loop's mirrors of the same things: those are
 * not shown twice.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionWriter, type CallRow } from "@wrathbench/mcp/record";
import { feedRecordOf, pairStoreCalls, storeCallRecordsOf, type RecordLine, type StoreCalls } from "../record-feed";
import { TrajectoryTail } from "../tail";
import type { EntrySummary } from "../api-types";
import { materialiseV1p1, V1P1_RUN } from "../../runner/test/fixtures/v1p1";
import { recordDrain } from "../../runner/test/fixtures/v1-session";
import { tempDirs } from "../../runner/test/fixtures/temp-dirs";

const tempDir = tempDirs();

describe("the run page's feed over a v1 run", () => {
  test("the record's milestones are merged in by time, with the joined turn; the trajectory's mirrors are not shown", async () => {
    const dir = materialiseV1p1(tempDir("record-feed-"));
    const tail = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await tail.scan();
    // A first-build run's 60-second state lines are its own (nothing in the record mirrors them).
    expect(tail.entries.filter((e) => e.t === "state")).toHaveLength(20);
    // Every milestone is the record's: the zone, area and level baselines twice (the restart), the gains once.
    const milestones = tail.entries.filter((e) => e.t === "milestone");
    expect(milestones.length).toBeGreaterThan(10);
    expect(tail.entries.filter((e) => e.t === "quest_complete")).toHaveLength(3);
    // In time order across the merge.
    const ts = tail.entries.map((e) => e.ts);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    // A gain carries the turn it fell in, by the timestamp join.
    const raw = JSON.parse((await tail.raw(milestones.find((e) => e["kind"] === "level" && e["from"] === 5)!.i))!) as Record<string, unknown>;
    expect(raw).toMatchObject({ t: "milestone", kind: "level", from: 5, to: 6, turn: 4 });
    // The run page's facts read the same rows.
    expect(tail.leveling?.levelUps).toBe(2);
    expect(tail.achievements?.earned).toBe(2);
  });

  test("a later scan adds only what the record and the trajectory gained, and a new tail reads the same feed", async () => {
    const dir = materialiseV1p1(tempDir("record-feed-"), { as: V1P1_RUN });
    const a = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await a.scan();
    expect(await a.scan()).toEqual([]);
    const b = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await b.scan();
    expect(b.entries.map((e) => [e.t, e.ts])).toEqual(a.entries.map((e) => [e.t, e.ts]));
  });
});

describe("a move row as the feed's record", () => {
  const row = { ts: 2000, kind: "move" as const, at: 1990, moveId: 4, map: 0, x: 1, y: 2, z: 3, target: null, status: "arrived" };

  test("it says whose move it is, as an action log does: the call's stamp, and a routine's mark", () => {
    expect(feedRecordOf({ ...row, origin: { type: "tool", call: 1000 } }, 7, "calls")).toEqual({
      t: "move", ts: 2000, turn: 7, callTs: 1000, moveId: 4, map: 0, x: 1, y: 2, z: 3, target: null, status: "arrived",
    });
    expect(feedRecordOf({ ...row, origin: { type: "routine", call: 1000 } }, null, "calls")).toMatchObject({ callTs: 1000, routine: true });
    expect(feedRecordOf({ ...row, origin: { type: "program", call: 1000, routine: "patrol" } }, null, "calls")).toMatchObject({ callTs: 1000, routine: true });
    // The SDK's own traffic belongs to no call.
    const own = feedRecordOf({ ...row, origin: { type: "client" } }, null, "calls")!;
    expect("callTs" in own || "routine" in own).toBe(false);
  });
});

/*
 * A session read from a wrath-mcp store (`runner/src/session-store.ts`) has no
 * trajectory: its record's `call` and `result` rows are its feed's calls, as
 * the records a CLI driver writes for one, each drawn where it returned.
 */
describe("a store session's feed", () => {
  /** Just before a segment boundary, so a call can run across it. */
  const T0 = 1_795_224_000_000 + 280_000;
  const FP = "c0ffee00c0ffee00";

  /** A store session as a standalone wrath-mcp writes one, through the stack's own writer. */
  function storeSession(): { dir: string; writer: SessionWriter; clock: { now: number }; ids: Record<string, number> } {
    const dir = join(tempDir("store-feed-"), FP);
    const clock = { now: T0 };
    const writer = new SessionWriter({ dir, id: FP, stack: { version: "0.0.0-test" }, now: () => clock.now, log: () => {} });
    writer.open();
    writer.ingest(recordDrain());
    const ids: Record<string, number> = {};
    // A call with args and no code.
    ids["summary"] = writer.call("state_summary", { verbose: true });
    clock.now = T0 + 80;
    writer.result(ids["summary"], { text: '{"self":{"level":1}}' });
    // A snippet that dispatched, and a routine an earlier call left running, flushing while it ran.
    clock.now = T0 + 1_000;
    ids["accept"] = writer.call("run_snippet", { code: 'await sdk.acceptQuestFrom("Deputy Willem", 783)' });
    clock.now = T0 + 1_010;
    writer.actions({ call: ids["accept"], inCall: true }, [{ ts: T0 + 1_005, action: "quest_accept", status: 200, ms: 4 }]);
    writer.actions({ call: ids["summary"], routine: true, inCall: true }, [{ ts: T0 + 1_008, action: "questgiver_status_query", status: 200, ms: 2 }]);
    clock.now = T0 + 1_020;
    writer.result(ids["accept"], { text: "ok (20ms)" });
    // A game event between calls.
    clock.now = T0 + 2_000;
    writer.ingest(recordDrain({ events: [{ ts: T0 + 2_000, kind: "level", from: 1, to: 2, xp: 0 }] }));
    // Two calls that overlap: the snippet errs after the other returned, across the segment boundary.
    clock.now = T0 + 3_000;
    ids["kill"] = writer.call("run_snippet", { code: 'await sdk.killTarget("Rabbit")' });
    clock.now = T0 + 3_100;
    ids["events"] = writer.call("recent_events", { limit: 5 });
    clock.now = T0 + 3_200;
    writer.result(ids["events"], { text: "[]" });
    clock.now = T0 + 21_000;
    writer.result(ids["kill"], { text: 'error (18000ms)\nTypeError: killTarget(guid) got "Rabbit"', isError: true });
    // A call still running.
    clock.now = T0 + 22_000;
    ids["running"] = writer.call("state_summary", {});
    return { dir, writer, clock, ids };
  }

  const calls = (entries: EntrySummary[]): EntrySummary[] => entries.filter((e) => ["tool_call", "snippet", "snippet_result", "tool_result"].includes(e.t));

  test("each returned call is its tool_call, its code and its result, where it returned, in time with the record's rows", async () => {
    const { dir, ids } = storeSession();
    const tail = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await tail.scan();
    const fed = calls(tail.entries);
    expect(fed.map((e) => [e.t, e["name"] ?? null, e.ts])).toEqual([
      ["tool_call", "state_summary", T0 + 80],
      ["tool_result", "state_summary", T0 + 80],
      ["tool_call", "run_snippet", T0 + 1_020],
      ["snippet", null, T0 + 1_020],
      ["snippet_result", "run_snippet", T0 + 1_020],
      ["tool_call", "recent_events", T0 + 3_200],
      ["tool_result", "recent_events", T0 + 3_200],
      ["tool_call", "run_snippet", T0 + 21_000],
      ["snippet", null, T0 + 21_000],
      ["snippet_result", "run_snippet", T0 + 21_000],
    ]);
    // The call's start is its id, which the actions it sent carry: the card's duration and its action log.
    expect(fed[0]).toMatchObject({ call: 1, dispatchTs: ids["summary"], args: { verbose: true } });
    expect(fed[1]).toMatchObject({ isError: false, text: '{"self":{"level":1}}' });
    expect(fed[2]).toMatchObject({ call: 2, dispatchTs: ids["accept"] });
    expect(fed[3]).toMatchObject({ code: 'await sdk.acceptQuestFrom("Deputy Willem", 783)' });
    expect(fed[5]).toMatchObject({ call: 4, dispatchTs: ids["events"], args: { limit: 5 } });
    expect(fed[7]).toMatchObject({ call: 3, dispatchTs: ids["kill"] });
    expect(fed[9]).toMatchObject({ isError: true, text: 'error (18000ms)\nTypeError: killTarget(guid) got "Rabbit"' });
    // Each call's records side by side: one card each.
    for (const k of [0, 2, 5, 7]) expect(tail.entries[fed[k]!.i + 1]).toBe(fed[k + 1]!);
    const actions = tail.entries.filter((e) => e.t === "actions");
    expect(actions.map((a) => [a["callTs"], a["routine"] ?? false])).toEqual([
      [ids["accept"], false],
      [ids["summary"], true],
    ]);
    // The record's rows and the calls in one time order: the action log before the card it joins, the level between calls.
    expect(tail.entries.map((e) => e.ts)).toEqual([...tail.entries.map((e) => e.ts)].sort((a, b) => a - b));
    const at = (pred: (e: EntrySummary) => boolean): number => tail.entries.findIndex(pred);
    expect(at((e) => e.t === "actions")).toBeLessThan(at((e) => e.t === "tool_call" && e["dispatchTs"] === ids["accept"]));
    const level = at((e) => e.t === "milestone" && e["kind"] === "level" && e["to"] === 2);
    expect(level).toBeGreaterThan(at((e) => e.t === "tool_call" && e["dispatchTs"] === ids["accept"]) + 2);
    expect(level).toBeLessThan(at((e) => e.t === "tool_call" && e["dispatchTs"] === ids["events"]));
    // No model side: nothing claims a turn.
    expect(fed.every((e) => e["turn"] === undefined)).toBe(true);
  });

  test("a call still running is not in the feed until it returns, and then once", async () => {
    const { dir, writer, clock, ids } = storeSession();
    const tail = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await tail.scan();
    expect(calls(tail.entries).some((e) => e["dispatchTs"] === ids["running"])).toBe(false);
    expect(await tail.scan()).toEqual([]);
    clock.now = T0 + 22_500;
    writer.result(ids["running"]!, { text: "{}" });
    const added = await tail.scan();
    expect(added.map((e) => [e.t, e["name"], e["dispatchTs"]])).toEqual([
      ["tool_call", "state_summary", ids["running"]],
      ["tool_result", "state_summary", undefined],
    ]);
    // A fresh read draws the same feed.
    const again = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await again.scan();
    expect(again.entries.map((e) => [e.t, e.ts])).toEqual(tail.entries.map((e) => [e.t, e.ts]));
  });

  test("raw serves each entry as the record the feed drew, the call read again from its segment", async () => {
    const { dir, ids } = storeSession();
    const tail = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    await tail.scan();
    const first = tail.entries.findIndex((e) => e.t === "tool_call" && e["dispatchTs"] === ids["kill"]);
    const raws = await Promise.all([first, first + 1, first + 2].map(async (i) => JSON.parse((await tail.raw(i))!) as Record<string, unknown>));
    expect(raws).toEqual([
      { t: "tool_call", ts: T0 + 21_000, call: 3, name: "run_snippet", args: { code: 'await sdk.killTarget("Rabbit")' }, dispatchTs: ids["kill"] },
      { t: "snippet", ts: T0 + 21_000, call: 3, code: 'await sdk.killTarget("Rabbit")' },
      { t: "snippet_result", ts: T0 + 21_000, call: 3, name: "run_snippet", isError: true, text: 'error (18000ms)\nTypeError: killTarget(guid) got "Rabbit"' },
    ]);
  });

  test("a call a segment's key restates pairs with its result once; a result with no call is drawn alone", () => {
    const loc = (start: number) => ({ stream: "calls" as const, stem: "b", start, end: start + 1 });
    const call: Extract<CallRow, { kind: "call" }> = { ts: 1_000, kind: "call", id: 1_000, origin: { type: "tool" }, tool: "run_snippet", args: { code: "1" } };
    const lines: RecordLine[] = [
      { loc: loc(0), row: { ts: 2_000, kind: "key", open: [call] } },
      { loc: loc(10), row: { ts: 2_500, kind: "actions", origin: { type: "tool", call: 1_000 }, actions: [] } },
      { loc: loc(20), row: { ts: 3_000, kind: "result", id: 1_000, text: "ok", error: false, durationMs: 2_000 } },
      { loc: loc(30), row: { ts: 4_000, kind: "result", id: 999, text: "lost", error: false, durationMs: 1 } },
    ];
    const state: StoreCalls = { held: new Map(), count: 0 };
    const out = pairStoreCalls(lines, state);
    expect(out.map((l) => l.row.kind)).toEqual(["actions", "result", "result"]);
    expect(out[1]!.call).toEqual({ row: call, loc: loc(0), n: 1 });
    expect(out[2]!.call).toBeUndefined();
    expect(state.held.size).toBe(0);
    expect(storeCallRecordsOf(null, out[2]!.row as Extract<CallRow, { kind: "result" }>)).toEqual([{ t: "tool_result", ts: 4_000, isError: false, text: "lost" }]);
    // A run_snippet whose args carry no code keeps them on its card.
    const noCode = storeCallRecordsOf({ row: { ...call, args: { file: "a.ts" } }, n: 1 }, { ts: 3_000, kind: "result", id: 1_000, text: "ok", error: false, durationMs: 2_000 });
    expect(noCode.map((r) => r["t"])).toEqual(["tool_call", "snippet_result"]);
  });

  test("a run's own record calls stay off its feed: its trajectory holds them", () => {
    const origin = { type: "tool" };
    expect(feedRecordOf({ ts: 1_000, kind: "call", id: 1_000, origin, tool: "run_snippet", args: { code: "1" } }, 3, "calls")).toBeNull();
    expect(feedRecordOf({ ts: 1_200, kind: "result", id: 1_000, text: "ok", error: false, durationMs: 200 }, 3, "calls")).toBeNull();
  });
});
