/**
 * The feed's two tiers (`lib/feedtier.ts`): which rows are decisions and which
 * are actions, where a run of actions starts and stops, what its counts are,
 * that nothing that failed inside one goes uncounted, and that a public
 * window's program error reads from its own words.
 */

import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "../../viewer/api-types";
import { groupFeed } from "../src/lib/feedgroup";
import { lineOf, programErrorLine } from "../src/lib/feedline";
import { entryKind, tallyLabel, tallyRun, tierFeed, tierOf, toolKind, type ActionRun, type FeedRow } from "../src/lib/feedtier";

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
});

describe("a program's errors", () => {
  const repeat = (signature: string, count: number, ts = 50, extra: Record<string, unknown> = {}) => e("program_error", ts, { kind: "repeat", signature, count, ...extra });

  test("a wake's repeats fold with the wake around them, counted by occurrence and never as failed", () => {
    const rows = tierFeed(
      groupFeed([
        ...call("write_file", 1),
        e("program_error", 20, { kind: "refusal", signature: "grind||castSpell|not_ready", name: "grind", action: "castSpell", status: "not_ready", deploy: 2, at: 20 }),
        ...move(1, 30),
        e("wake", 50, { sleptMs: 300_000, reasons: [] }),
        repeat("grind||castSpell|not_ready", 12),
        repeat("grind|TypeError|routines/grind.ts:42", 3),
        e("state", 60, { level: 7 }),
      ]),
    );
    expect(shape(rows)).toEqual(["call:write_file", "program_error", "run:6"]);
    const run = runs(rows)[0]!;
    expect(run.tally.failed).toBe(0);
    expect(tallyLabel(run.tally)).toBe("1 move · 1 state sample · 1 wait · 15 repeated failures");
  });

  test("a public window reads a program error from its words and counts, never a placeholder (operator, 2026-11-18)", () => {
    const text = (entry: FeedEntry) => {
      const l = programErrorLine(entry);
      return l.text.length > 0 ? `${l.label}: ${l.text}` : l.label;
    };
    // What the publisher ships: kind, count, since, at, action, status.
    expect(text(e("program_error", 1, { kind: "repeat", action: "castSpell", status: "not_ready", count: 13, since: 1, at: 2 }))).toBe("refused: castSpell not_ready ×13 more");
    expect(text(e("program_error", 1, { kind: "repeat", count: 2, since: 1, at: 2 }))).toBe("repeated: ×2 more");
    expect(text(e("program_error", 1, { kind: "refusal", action: "castSpell", status: "not_ready", at: 1 }))).toBe("refused: castSpell not_ready");
    expect(text(e("program_error", 1, { kind: "refusal", at: 1 }))).toBe("refused");
    expect(text(e("program_error", 1, { kind: "error", at: 1 }))).toBe("program error");
    // The private viewer still names the routine and the character off the signature beside the fields.
    expect(text(repeat("party|Tankpartyb|moveTo|superseded", 3, 50, { action: "moveTo", status: "superseded" }))).toBe("refused: moveTo superseded ×3 more (routine party, Tankpartyb)");
    expect(text(repeat("grind||castSpell|not_ready", 3, 50, { action: "castSpell", status: "not_ready" }))).toBe("refused: castSpell not_ready ×3 more (routine grind)");
    for (const entry of [e("program_error", 1, { kind: "repeat", count: 2 }), e("program_error", 1, { kind: "refusal" }), e("program_error", 1, { kind: "error" })]) {
      expect(text(entry)).not.toContain("?");
    }
  });
});
