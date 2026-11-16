/**
 * The feed's two tiers (`lib/feedtier.ts`) and the one-line readings
 * (`lib/feedline.ts`): which rows are decisions and which are actions, where a
 * run of actions starts and stops, what its counts are, and that nothing that
 * failed inside one goes uncounted.
 */

import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "../../runner/viewer/api-types";
import { groupFeed, type FeedGroup } from "../src/lib/feedgroup";
import { lineOf, milestoneLine } from "../src/lib/feedline";
import {
  ACTIONS,
  KINDS,
  MILESTONES,
  RECORDS,
  TOOLS,
  entryKind,
  kindOf,
  runLines,
  tallyLabel,
  tallyNotes,
  tallyRun,
  tierFeed,
  tierOf,
  toolKind,
  type ActionRun,
  type FeedRow,
} from "../src/lib/feedtier";

let seq = 0;
function e(t: string, ts: number, extra: Record<string, unknown> = {}): FeedEntry {
  return { i: seq++, t, ts, start: 0, end: 0, ...extra } as FeedEntry;
}

/** A tool call and its result, as the fixed loop writes them. */
function call(name: string, ts: number, result: Record<string, unknown> = {}): FeedEntry[] {
  return [
    e("tool_call", ts, { turn: 1, name, args: {}, dispatchTs: ts }),
    e("tool_result", ts + 10, { turn: 1, name, isError: false, text: "ok", ...result }),
  ];
}

/** A move's two rows: its dispatch, and its verdict. */
function move(moveId: number, ts: number, status = "arrived", extra: Record<string, unknown> = {}): FeedEntry[] {
  const at = { moveId, map: 0, x: 10, y: 20, z: 0, target: null, routine: true, ...extra };
  return [e("move", ts, { ...at, status: null }), e("move", ts + 5, { ...at, status })];
}

const note = (action: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ts: 1, action, status: 200, ms: 2, ...extra });

const runs = (rows: readonly FeedRow[]): ActionRun[] => rows.filter((r): r is ActionRun => r.kind === "run");
const shape = (rows: readonly FeedRow[]): string[] => rows.map((r) => (r.kind === "run" ? `run:${r.items.length}` : r.kind === "call" ? `call:${r.call?.name}` : r.kind === "plain" ? r.entry.t : r.kind));

describe("the classification", () => {
  test("every table names a kind that exists (an icon per kind is the compiler's: `ICONS` is a record over them)", () => {
    for (const table of [TOOLS, RECORDS, MILESTONES, ACTIONS]) for (const kind of Object.values(table)) expect(KINDS[kind]).toBeDefined();
  });

  test("what the model wrote or chose is a decision; what it read or was handed is an action", () => {
    const tier = (name: string) => tierOf(toolKind(name));
    for (const name of ["run_snippet", "reflect", "log_status", "write_scratchpad", "edit_scratchpad", "write_file", "edit_file", "start_routine", "stop_routine"]) {
      expect([name, tier(name)]).toEqual([name, "decision"]);
    }
    for (const name of ["state_summary", "recent_events", "read_log", "read_file", "search_reference", "list_characters", "yield"]) {
      expect([name, tier(name)]).toEqual([name, "action"]);
    }
  });

  test("a tool or a record this build has never heard of is a decision, shown in full", () => {
    expect(toolKind("teleport_home")).toBe("unknown");
    expect(tierOf(toolKind("teleport_home"))).toBe("decision");
    expect(tierOf(entryKind(e("some_new_record", 1)))).toBe("decision");
  });

  test("a surface can file a tool differently, the harness over the loop", () => {
    const overrides = { program: { state_summary: "snippet" as const }, codex: { state_summary: "log" as const } };
    expect(toolKind("state_summary", { loop: "snippet" }, overrides)).toBe("read");
    expect(toolKind("state_summary", { loop: "program" }, overrides)).toBe("snippet");
    expect(toolKind("state_summary", { loop: "program", harness: "codex" }, overrides)).toBe("log");
    expect(toolKind("run_snippet", { loop: "program", harness: "codex" }, overrides)).toBe("snippet");
  });

  test("a level, a death and a turn-in are turning points; a subzone crossed is not", () => {
    const kind = (k: string) => entryKind(e("milestone", 1, { kind: k }));
    expect(["level", "death", "zone", "achievement", "taxi"].map((k) => tierOf(kind(k)))).toEqual(["decision", "decision", "decision", "decision", "decision"]);
    expect(["area", "taxi_landed", "spell", "spells_at_login"].map((k) => tierOf(kind(k)))).toEqual(["action", "action", "action", "action"]);
    expect(tierOf(entryKind(e("quest_complete", 1, { questId: 7 })))).toBe("decision");
  });

  test("the harness speaking is a decision, its bookkeeping an action", () => {
    expect(entryKind(e("harness", 1, { kind: "session_note", text: "restarted" }))).toBe("notice");
    expect(tierOf(entryKind(e("harness", 1, { kind: "resolved_model", model: "x" })))).toBe("action");
  });

  test("the ends of a run, and a CLI driver's own records", () => {
    for (const t of ["termination", "pause", "resume", "watchdog", "limit", "meta", "character"]) expect([t, tierOf(entryKind(e(t, 1)))]).toEqual([t, "decision"]);
    for (const t of ["move", "state", "events_served", "wake", "claude_result", "codex_item", "pi_retry", "reflect_window"]) expect([t, tierOf(entryKind(e(t, 1)))]).toEqual([t, "action"]);
    // A CLI's reasoning summary is the model's own text.
    expect(tierOf(entryKind(e("codex_reasoning", 1, { text: "…" })))).toBe("decision");
  });

  test("a reply with no text is the envelope of its tool calls", () => {
    const [said, bare] = groupFeed([e("response", 1, { turn: 1, text: "Pulling the boar." }), e("response", 2, { turn: 1, text: "", tools: ["state_summary"] })]);
    expect(tierOf(kindOf(said!))).toBe("decision");
    expect(tierOf(kindOf(bare!))).toBe("action");
  });
});

describe("runs of actions", () => {
  const window = (): FeedEntry[] => [
    e("request", 100, { turn: 1 }),
    e("response", 200, { turn: 1, text: "Checking, then pulling." }),
    ...call("state_summary", 300),
    ...call("recent_events", 400),
    e("events_served", 410, { via: "tool", count: 2 }),
    ...call("run_snippet", 500),
    ...move(1, 600),
    ...move(2, 700),
    e("milestone", 750, { kind: "area", from: { id: 9 }, to: { id: 10 } }),
    ...move(3, 800),
    ...call("log_status", 900),
    ...move(4, 1000),
    e("milestone", 1100, { kind: "level", from: 6, to: 7 }),
    ...move(5, 1200),
  ];

  test("consecutive actions between two decisions are one row, and a decision ends the run", () => {
    const rows = tierFeed(groupFeed(window()));
    expect(shape(rows)).toEqual(["turn", "response", "run:3", "call:run_snippet", "run:7", "call:log_status", "run:2", "milestone", "run:2"]);
  });

  test("a run counts by kind, a move once for its two rows", () => {
    const [reads, walk] = runs(tierFeed(groupFeed(window())));
    expect(tallyLabel(reads!.tally)).toBe("2 reads · 1 event batch");
    expect(tallyLabel(walk!.tally)).toBe("3 moves · 1 area change");
    expect(walk!.fromTs).toBe(600);
  });

  test("opened, a move is one line: its verdict row, the dispatch row dropped", () => {
    const walk = runs(tierFeed(groupFeed(window())))[1]!;
    const lines = runLines(walk.items).map((g) => lineOf(g));
    expect(lines.map((l) => `${l.label} ${l.text}`.trim())).toEqual([
      "routine move to (10, 20) → arrived",
      "routine move to (10, 20) → arrived",
      "area 9 → 10",
      "routine move to (10, 20) → arrived",
    ]);
    // A move still under way has only its dispatch row, which stays.
    const walking = groupFeed([e("move", 1, { moveId: 9, x: 1, y: 2, status: null }), e("state", 2)]);
    expect(runLines(walking).map((g) => lineOf(g).text)[0]).toBe("to (1, 2) · dispatched");
  });

  test("a failure does not end a run; it is counted on it", () => {
    const rows = tierFeed(
      groupFeed([
        e("response", 1, { turn: 1, text: "Walking." }),
        ...move(1, 10),
        ...move(2, 20, "too_far"),
        ...call("state_summary", 30, { isError: true, text: "error: not in world" }),
        e("actions", 40, { routine: true, actions: [note("cast_spell", { status: 400, error: "out_of_range", count: 3 }), note("loot")] }),
        ...move(3, 50),
        e("pi_error", 60, { error: "stream closed" }),
      ]),
    );
    expect(shape(rows)).toEqual(["response", "run:9"]);
    const tally = runs(rows)[0]!.tally;
    // The refused move, the errored read, three refused casts and the driver's error.
    expect(tally.failed).toBe(6);
    expect(tallyLabel(tally)).toBe("3 moves · 3 combat actions · 1 loot · 1 read · 1 record · 6 failed");
  });

  test("a harness hint under an action's result is counted, not hidden", () => {
    const text = "2 events\n--- harness ---\nrecent_events since ×4: pass the last seq\nmoveTo too_far ×2: walk it in legs";
    const rows = tierFeed(groupFeed([...call("recent_events", 1, { text }), ...call("state_summary", 20)]));
    expect(runs(rows)[0]!.tally).toMatchObject({ failed: 0, hints: 2 });
    expect(tallyLabel(runs(rows)[0]!.tally)).toBe("2 reads · 2 hints");
    // The line itself reads as the tool's own first line, without the harness's.
    expect(lineOf(runs(rows)[0]!.items[0]!).text).toBe("2 events");
  });

  test("a routine's moves are counted from their records, not again from its action log", () => {
    const log = e("actions", 90, { routine: true, actions: [note("move_to", { count: 2, moveId: 1 }), note("move_to", { status: 400, error: "too_far" }), note("loot"), note("loot_release", { auto: true })] });
    const withRecords = tallyRun(groupFeed([...move(1, 10), ...move(2, 20), log]));
    // Two walked, and the refused dispatch, which has no record of its own.
    expect(tallyLabel(withRecords)).toBe("3 moves · 1 loot · 1 failed");
    // A run with no move record (one recorded before them) counts the log's.
    expect(tallyLabel(tallyRun(groupFeed([log])))).toBe("3 moves · 1 loot · 1 failed");
  });

  test("a snippet's own log: every dispatch by kind, the SDK's own traffic left out", () => {
    const entry = e("actions", 1, {
      actions: [note("move_to"), note("set_target"), note("cast_spell", { count: 4 }), note("loot"), note("loot_item"), note("loot_release", { auto: true }), note("gossip_hello"), note("quest_accept"), note("sell_item"), note("mystery")],
      dropped: { cast_spell: 10 },
    });
    expect(tallyLabel(tallyNotes([entry as never]))).toBe("1 move · 15 combat actions · 2 loots · 1 interaction · 1 quest action · 1 trade · 1 other action");
  });

  test("a call's own moves are on its card, not a run under it; a routine's are rows", () => {
    const own = move(7, 1010, "arrived", { callTs: 1000, routine: undefined });
    const routines = move(8, 1300, "arrived", { callTs: 1000, routine: true });
    const groups = groupFeed([
      e("tool_call", 1000, { turn: 1, name: "run_snippet", args: {}, dispatchTs: 1000 }),
      e("snippet", 1000, { turn: 1, code: "await sdk.moveTo(boar)" }),
      ...own,
      e("actions", 1100, { callTs: 1000, actions: [note("move_to", { moveId: 7 })] }),
      e("snippet_result", 1200, { turn: 1, name: "run_snippet", isError: false, text: "ok" }),
      ...routines,
      e("actions", 1400, { callTs: 1000, routine: true, actions: [note("move_to", { moveId: 8 })] }),
    ]);
    const rows = tierFeed(groups);
    expect(shape(rows)).toEqual(["call:run_snippet", "run:3"]);
    const card = groups[0] as Extract<FeedGroup, { kind: "call" }>;
    expect(card.moves).toEqual(own);
    expect(card.actions).toHaveLength(1);
    expect(tallyLabel(runs(rows)[0]!.tally)).toBe("1 move");
  });

  test("a move with no call stamp, as an older run recorded it, stays a row", () => {
    const groups = groupFeed([
      e("tool_call", 1000, { turn: 1, name: "run_snippet", args: {}, dispatchTs: 1000 }),
      e("snippet", 1000, { turn: 1, code: "x" }),
      e("actions", 1100, { callTs: 1000, actions: [note("move_to", { moveId: 7 })] }),
      e("snippet_result", 1200, { turn: 1, name: "run_snippet", isError: false, text: "ok" }),
      e("move", 1210, { moveId: 7, x: 1, y: 2, status: "arrived" }),
    ]);
    expect(shape(tierFeed(groups))).toEqual(["call:run_snippet", "run:1"]);
  });
});

describe("identity across a live append", () => {
  test("a settled run is the same object; the run the tail grew keeps its anchor", () => {
    const base = [e("response", 1, { turn: 1, text: "a" }), ...move(1, 10), e("response", 20, { turn: 2, text: "b" }), ...move(2, 30)];
    const g1 = groupFeed(base);
    const r1 = tierFeed(g1);
    const g2 = groupFeed([...base, ...move(3, 40)], g1);
    const r2 = tierFeed(g2, {}, r1);
    expect(shape(r2)).toEqual(["response", "run:2", "response", "run:4"]);
    expect(r2[1]).toBe(r1[1]!);
    expect(r2[3]).not.toBe(r1[3]!);
    expect((r2[3] as ActionRun).anchor).toBe((r1[3] as ActionRun).anchor);
  });
});

describe("a row as one line", () => {
  test("milestones in words, ids where the record has no name", () => {
    expect(milestoneLine(e("milestone", 1, { kind: "level", from: 6, to: 7 }))).toBe("level 6 → 7");
    expect(milestoneLine(e("milestone", 1, { kind: "zone", from: { id: 12 }, to: { id: 40, name: "Westfall" } }))).toBe("zone 12 → Westfall");
    expect(milestoneLine(e("milestone", 1, { kind: "death", zone: { id: 12 } }))).toBe("died in zone 12");
    expect(milestoneLine(e("milestone", 1, { kind: "death" }))).toBe("died");
    expect(milestoneLine(e("quest_complete", 1, { questId: 9001 }))).toBe("turned in quest 9001");
    expect(milestoneLine(e("milestone", 1, { kind: "achievement", id: 6, name: "Level 10", points: 10 }))).toBe("achievement Level 10 · 10 points");
    expect(milestoneLine(e("milestone", 1, { kind: "start_area_exit", area: 5 }))).toBe("start area exit · area: 5");
  });

  test("an action's line: what it was, what it came to, whether it failed", () => {
    const one = (entries: FeedEntry[]) => lineOf(groupFeed(entries)[0]!);
    expect(one(call("state_summary", 1, { text: "level 7 · 62% health\nmore" }))).toMatchObject({ kind: "read", label: "state_summary", text: "level 7 · 62% health", failed: false });
    expect(one([e("tool_call", 1, { name: "read_log", args: {} })])).toMatchObject({ label: "read_log", text: "no result yet" });
    expect(one(move(1, 1, "too_far").slice(1))).toMatchObject({ kind: "move", label: "routine move", text: "to (10, 20) → too far", failed: true });
    expect(one([e("events_served", 1, { via: "tool", count: 3, opcodes: ["SMSG_X×3"] })])).toMatchObject({ kind: "events", text: "3 events · SMSG_X×3" });
    expect(one([e("harness", 1, { kind: "resolved_model", model: "a/b" })])).toMatchObject({ kind: "record", label: "harness", text: "resolved_model · model: a/b" });
    expect(one([e("actions", 1, { routine: true, actions: [note("loot"), note("say", { status: 0 })] })])).toMatchObject({ label: "routine", text: "1 loot · 1 chat line · 1 failed", failed: true });
    expect(one([e("wake", 1, { sleptMs: 90_000, reasons: ["combat", "timer"] })]).text).toContain("combat, timer");
  });
});
