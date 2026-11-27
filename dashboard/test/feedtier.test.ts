/**
 * The feed's two tiers (`lib/feedtier.ts`) and the one-line readings
 * (`lib/feedline.ts`): which rows are decisions and which are actions, where a
 * run of actions starts and stops, what its counts are, and that nothing that
 * failed inside one goes uncounted.
 */

import { describe, expect, test } from "bun:test";
import type { FeedEntry } from "../../viewer/api-types";
import { groupFeed, type FeedGroup } from "../src/lib/feedgroup";
import { deployChips, endLine, leadChips, lineOf, milestoneLine, programErrorLine } from "../src/lib/feedline";
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

  test("a program's fresh error or refusal is a notice; a wake's count of its repeats is an action", () => {
    const refusal = e("program_error", 1, { kind: "refusal", signature: "grind||castSpell|not_ready", name: "grind", action: "castSpell", status: "not_ready", deploy: 2, at: 1 });
    const error = e("program_error", 1, { kind: "error", signature: "grind|TypeError|routines/grind.ts:42", name: "grind", error: "TypeError: x is undefined", frames: [], deploy: 2, at: 1 });
    const repeat = e("program_error", 1, { kind: "repeat", signature: "grind||castSpell|not_ready", count: 12 });
    expect([refusal, error].map((x) => [entryKind(x), tierOf(entryKind(x))])).toEqual([
      ["notice", "decision"],
      ["notice", "decision"],
    ]);
    expect([entryKind(repeat), tierOf(entryKind(repeat))]).toEqual(["repeat", "action"]);
    // A public window ships the skeleton alone: nothing to read, so it folds.
    const skeleton = e("program_error", 1);
    expect([entryKind(skeleton), tierOf(entryKind(skeleton))]).toEqual(["record", "action"]);
    expect(lineOf(groupFeed([skeleton])[0]!)).toMatchObject({ label: "program error", text: "", failed: false });
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

  test("a fresh refusal and a fresh error in words, with the routine and the character", () => {
    expect(programErrorLine(e("program_error", 1, { kind: "refusal", signature: "grind||castSpell|not_ready", name: "grind", action: "castSpell", status: "not_ready" }))).toEqual({
      label: "refused",
      text: "castSpell not_ready (routine grind)",
      title: "grind||castSpell|not_ready",
    });
    expect(programErrorLine(e("program_error", 1, { kind: "refusal", signature: "party|Tankpartyb|moveTo|superseded", name: "party", seat: "Tankpartyb", action: "moveTo", status: "superseded" })).text).toBe(
      "moveTo superseded (routine party, Tankpartyb)",
    );
    expect(programErrorLine(e("program_error", 1, { kind: "error", signature: "grind|TypeError|x", name: "grind", error: "TypeError: x is undefined\n    at grind (routines/grind.ts:42:7)" }))).toMatchObject({
      label: "routine error",
      text: "TypeError: x is undefined (routine grind)",
    });
    expect(programErrorLine(e("program_error", 1, { kind: "error", signature: "memory|save", error: "memory too large" }))).toMatchObject({ label: "program error", text: "memory too large" });
  });

  test("a repeat reads as more of the same, off its signature, whatever its shape", () => {
    const text = (signature: string, count = 12) => {
      const l = programErrorLine(repeat(signature, count));
      return `${l.label} ${l.text}`;
    };
    expect(text("grind||castSpell|not_ready")).toBe("refused castSpell not_ready ×12 more (routine grind)");
    expect(text("party|Tankpartyb|moveTo|superseded", 1_204)).toBe("refused moveTo superseded ×1,204 more (routine party, Tankpartyb)");
    expect(text("grind|TypeError|routines/grind.ts:42", 3)).toBe("routine error TypeError at routines/grind.ts:42 ×3 more (routine grind)");
    expect(text("|SyntaxError|", 2)).toBe("program error SyntaxError ×2 more");
    expect(text("memory|save", 5)).toBe("program error memory save ×5 more");
    expect(text("something:else", 4)).toBe("repeated something:else ×4 more");
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

  test("a repeat's line is quiet, and its hover names the span its count covers where the record says", () => {
    const one = (entry: FeedEntry) => lineOf(groupFeed([entry])[0]!);
    const old = one(repeat("grind||castSpell|not_ready", 12));
    expect(old).toMatchObject({ kind: "repeat", label: "refused", text: "castSpell not_ready ×12 more (routine grind)", failed: false, title: "grind||castSpell|not_ready" });
    const spanned = one(repeat("grind||castSpell|not_ready", 12, 50, { since: 1_000_000, at: 1_300_000 }));
    expect(spanned.title).toContain("grind||castSpell|not_ready · ");
    expect(spanned.title).toContain(" – ");
    // A fresh one is a failure in its own colour.
    expect(one(e("program_error", 1, { kind: "refusal", signature: "s", name: "grind", action: "castSpell", status: "not_ready" }))).toMatchObject({ kind: "notice", failed: true });
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

  test("the CLI's bookkeeping in words, never its type and subtype", () => {
    const one = (entries: FeedEntry[]) => lineOf(groupFeed(entries)[0]!);
    expect(one([e("claude_system", 1, { type: "system", subtype: "init", model: "claude-opus-5-5", claude_code_version: "2.1.321", tools: ["x"] })])).toMatchObject({ label: "claude", text: "session start · claude-opus-5-5 · cli 2.1.321" });
    expect(one([e("claude_system", 1, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 267_258, post_tokens: 4_105 } })]).text).toBe("compaction · auto · 267k → 4.1k tokens");
    expect(one([e("claude_system", 1, { type: "system", subtype: "thinking_tokens", estimated_tokens: 150 })]).text).toBe("thinking ~150 tokens");
    // A public window's skeleton: the subtype alone.
    expect(one([e("claude_system", 1, { type: "system", subtype: "status" })]).text).toBe("status");
    expect(one([e("claude_system", 1, { type: "system", subtype: "status", status: "compacting", session_id: "s", uuid: "u" })]).text).toBe("status · status: compacting");
  });

  test("a deploy no write claimed, and a reply with no words", () => {
    const one = (entries: FeedEntry[]) => lineOf(groupFeed(entries)[0]!);
    expect(one([e("deploy", 1, { ok: true, deploy: 9, routines: ["errand", "grind"] })])).toMatchObject({ label: "deploy", text: "9 · routines errand, grind", failed: false });
    expect(one([e("deploy", 1, { ok: false, error: "SyntaxError: x\n at main.ts:3" })])).toMatchObject({ label: "deploy", text: "failed · SyntaxError: x", failed: true });
    // An envelope no card claimed: the tools it asked for, the CLI's prefix off.
    expect(one([e("response", 1, { text: "", tools: ["mcp__wrathbench__run_snippet"] })])).toMatchObject({ kind: "record", label: "call", text: "run_snippet" });
    expect(one([e("response", 1, { text: "", tools: [], stopReason: "error", error: "upstream 500" })])).toMatchObject({ label: "response", text: "stop error · upstream 500", failed: true });
    expect(one([e("response", 1, { kind: "compaction", text: "", tools: [], usage: { prompt: 40_000, completion: 900 }, piCostUsd: 0.0123 })])).toMatchObject({ label: "compaction call", text: "40k in · 900 out · $0.012" });
    // A codex turn that wrote nothing still counted its tokens.
    expect(one([e("response", 1, { text: "", tools: [], usage: { prompt: 9_000, completion: 767 } })]).text).toBe("767 out");
  });

  test("the run's end as one line, its milliseconds a duration", () => {
    expect(endLine(e("termination", 1, { reason: "idle", detail: "no tool call for 1248527ms: 5 wakes in a row answered without one" }))).toBe(
      "idle — no tool call for 20m49s: 5 wakes in a row answered without one",
    );
    expect(endLine(e("watchdog", 1, { reason: "stall", detail: "no output for 4200ms" }))).toBe("stall — no output for 4.2s");
    // A public watchdog: its reason alone.
    expect(endLine(e("watchdog", 1, { reason: "idle" }))).toBe("idle");
    expect(lineOf(groupFeed([e("termination", 1, { reason: "episode-limit", detail: "episode wall clock 21600211ms" })])[0]!)).toMatchObject({ kind: "end", label: "termination", text: "episode-limit — episode wall clock 6h00m" });
  });

  test("codex's own tool calls and file changes", () => {
    const one = (entries: FeedEntry[]) => lineOf(groupFeed(entries)[0]!);
    expect(one([e("codex_tool_call", 1, { name: "exec", status: "completed", input: "text(await tools.mcp__wrathbench__state_summary({}));\ntext(1);" })])).toMatchObject({ label: "exec", text: "text(await tools.mcp__wrathbench__state_summary({}));", failed: false });
    expect(one([e("codex_tool_call", 1, { name: "exec", status: "failed", input: "x" })]).failed).toBe(true);
    // A public window: the skeleton alone.
    expect(one([e("codex_tool_call", 1)])).toMatchObject({ label: "codex tool", text: "" });
    expect(one([e("codex_item", 1, { type: "file_change", body: JSON.stringify({ type: "file_change", changes: [{ path: "main.ts", kind: "update" }] }) })])).toMatchObject({ label: "file change", text: "update main.ts" });
    expect(one([e("codex_item", 1, { type: "web_search", body: "{}" })]).label).toBe("codex_item");
  });
});

describe("what led to a call, as chips", () => {
  const env = (extra: Record<string, unknown>) => e("response", 1, { text: "", tools: ["mcp__wrathbench__run_snippet"], ...extra }) as never;

  test("think time, thinking and an envelope's own figures", () => {
    expect(leadChips(null)).toEqual([]);
    expect(leadChips({ thinkMs: 3_003, thinkingTokens: 150, envelope: null }).map((c) => c.text)).toEqual(["think 3.0s", "~150 thinking"]);
    expect(leadChips({ thinkMs: null, thinkingTokens: null, envelope: env({ thinkingChars: 2_280, usage: { prompt: 1, completion: 121 }, stopReason: "toolUse" }) }).map((c) => c.text)).toEqual(["2.3k chars thinking", "121 out"]);
  });

  test("an unusual ending and an error are in the error colour, the error's text on the hover", () => {
    const chips = leadChips({ thinkMs: null, thinkingTokens: null, envelope: env({ stopReason: "length", error: "max tokens" }) });
    expect(chips).toEqual([
      { text: "stop length", err: true },
      { text: "error", title: "max tokens", err: true },
    ]);
  });

  test("a deploy shows on its write's card only when it failed", () => {
    expect(deployChips([e("deploy", 1, { ok: true, deploy: 3 })])).toEqual([]);
    expect(deployChips([e("deploy", 1, { ok: false, error: "SyntaxError" })])).toEqual([{ text: "deploy failed", title: "SyntaxError", err: true }]);
    // A public window's skeleton says nothing either way.
    expect(deployChips([e("deploy", 1)])).toEqual([]);
  });
});
