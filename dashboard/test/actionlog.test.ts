/**
 * The action log's feed lines (`lib/actionlog.ts`) and where they are drawn
 * (`lib/feedgroup.ts`): an `actions` record joins its call by `callTs`, on
 * either side of it, and a window with no such records groups exactly as
 * before.
 */

import { describe, expect, test } from "bun:test";
import type { ActionNoteView, ActionsEntry, FeedEntry } from "../../runner/viewer/api-types";
import { actionLine, actionLines, moveVerdicts } from "../src/lib/actionlog";
import { groupFeed, type CallGroup } from "../src/lib/feedgroup";

const note = (action: string, extra: Partial<ActionNoteView> = {}): ActionNoteView => ({
  ts: 1000,
  action,
  status: 200,
  ms: 3,
  ...extra,
});

describe("one dispatch, one line", () => {
  test("names from the run's own cache read as words; ids stand in where it had none", () => {
    expect(
      actionLine(note("cast_spell", { args: { spellId: 635, targetGuid: "9" }, names: { spell: "Holy Light", target: "Redridge Gnoll" } })).text,
    ).toBe("cast Holy Light on Redridge Gnoll");
    expect(actionLine(note("cast_spell", { args: { spellId: 635, targetGuid: "9" } })).text).toBe("cast spell 635 on #9");
    expect(actionLine(note("buy_item", { args: { guid: "5", itemId: 1205, slot: 3, count: 5 }, names: { item: "Melon Juice" } })).text).toBe(
      "buy 5× Melon Juice",
    );
    expect(actionLine(note("quest_accept", { args: { guid: "5", questId: 33 }, names: { quest: "Wolves Across the Border" } })).text).toBe(
      "accept Wolves Across the Border",
    );
    expect(actionLine(note("equip_item", { args: { bag: 255, slot: 24 } })).text).toBe("equip bag 255 slot 24");
    expect(actionLine(note("raw", { args: { opcode: "CMSG_TEXT_EMOTE", payload: "2200000000000000" } })).text).toBe(
      "raw CMSG_TEXT_EMOTE (8 bytes)",
    );
    // An action this build has no words for still says what it was.
    expect(actionLine(note("some_new_action", { args: { guid: "7" } })).text).toBe("some new action · guid 7");
  });

  test("a refusal reads as the module answered it, with its hint on the hover", () => {
    const l = actionLine(note("cast_spell", { args: { spellId: 999 }, status: 409, error: "spell_not_known", hint: "no spell 999" }));
    expect(l).toMatchObject({ text: "cast spell 999 → refused: spell_not_known", failed: true });
    expect(l.title).toContain("no spell 999");
    expect(l.title).toContain("HTTP 409");
    expect(actionLine(note("stop", { status: 0, error: "transport: connection refused" })).text).toBe(
      "stop moving → no answer: transport: connection refused",
    );
  });

  test("an accepted action claims nothing past the ack, except a move the run recorded the end of", () => {
    expect(actionLine(note("cast_spell", { args: { spellId: 635 } })).text).toBe("cast spell 635");
    const verdicts = moveVerdicts([
      { i: 1, t: "move", ts: 900, start: 0, end: 0, moveId: 4, status: "too_far" } as FeedEntry,
      { i: 2, t: "move", ts: 1500, start: 0, end: 0, moveId: 4, status: "arrived" } as FeedEntry,
      { i: 3, t: "move", ts: 1600, start: 0, end: 0, moveId: 5, status: null } as unknown as FeedEntry,
    ]);
    // The verdict at or after the dispatch: the earlier one is a previous session's move 4.
    expect(actionLine(note("move_to", { args: { x: -6100.4, y: 400.2, z: 380 }, moveId: 4 }), verdicts).text).toBe(
      "move to (-6100, 400) → arrived",
    );
    // Still walking: no row with a status yet, so no outcome.
    expect(actionLine(note("move_to", { args: { x: 1, y: 2, z: 3 }, moveId: 5, names: { target: "Marshal McBride" } }), verdicts).text).toBe(
      "move to Marshal McBride (1, 2)",
    );
  });

  test("folded repeats, the client's own traffic and the cap's tally", () => {
    expect(actionLine(note("attack_stop", { count: 3 })).text).toBe("stop attacking ×3");
    expect(actionLine(note("questgiver_status_multiple_query", { auto: true }))).toMatchObject({ auto: true });
    const entry = {
      i: 0, t: "actions", ts: 2000, start: 0, end: 0, callTs: 1000,
      actions: [note("say", { args: { text: "hi" } })],
      dropped: { say: 10, face: 2 },
    } as ActionsEntry;
    expect(actionLines(entry).map((l) => l.text)).toEqual(['say "hi"', "+12 more: say ×10, face ×2"]);
  });
});

/* ------------------------------------------------------- the feed's join --- */

let seq = 0;
function e(t: string, ts: number, extra: Record<string, unknown> = {}): FeedEntry {
  return { i: seq++, t, ts, start: 0, end: 0, ...extra } as FeedEntry;
}

const actions = (callTs: number, ts: number): FeedEntry =>
  e("actions", ts, { callTs, actions: [note("say", { ts, args: { text: "x" } })] });

describe("the action log in the grouped feed", () => {
  test("a CLI driver's record lands before its call and is drawn inside the card", () => {
    const rec = actions(5000, 5400);
    const window = [
      rec,
      e("tool_call", 5500, { turn: 1, call: 7, name: "run_snippet", args: { code: "x" }, dispatchTs: 5000 }),
      e("snippet", 5500, { turn: 1, call: 7, code: "x" }),
      e("snippet_result", 5500, { turn: 1, call: 7, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const groups = groupFeed(window);
    expect(groups.map((g) => g.kind)).toEqual(["call"]);
    expect((groups[0] as CallGroup).actions).toEqual([rec as ActionsEntry]);
  });

  test("the fixed loop's record lands between the snippet and its result and is drawn inside the card", () => {
    const rec = actions(6000, 6300);
    const state = e("state", 6200);
    const window = [
      e("tool_call", 6000, { turn: 2, name: "run_snippet", args: { code: "y" }, dispatchTs: 6000 }),
      e("snippet", 6000, { turn: 2, code: "y" }),
      state,
      rec,
      e("snippet_result", 6400, { turn: 2, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const groups = groupFeed(window);
    // The state sample still renders where it was; the record does not.
    expect(groups.map((g) => g.kind)).toEqual(["plain", "call"]);
    expect((groups[1] as CallGroup).actions).toEqual([rec as ActionsEntry]);
  });

  test("a record whose call is off the window, or that no call owns, is a row of its own", () => {
    const offWindow = actions(1, 7100);
    const unowned = e("actions", 7200, { actions: [note("questgiver_status_query", { auto: true })] });
    const groups = groupFeed([offWindow, unowned]);
    expect(groups.map((g) => (g.kind === "plain" ? g.entry : null))).toEqual([offWindow, unowned]);
  });

  test("a window from before the action log groups exactly as it did", () => {
    const window = [
      e("tool_call", 8000, { turn: 3, name: "run_snippet", args: { code: "z" } }),
      e("snippet", 8000, { turn: 3, code: "z" }),
      e("snippet_result", 8450, { turn: 3, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const [g] = groupFeed(window) as CallGroup[];
    expect(g).toMatchObject({ kind: "call", actions: [], durationMs: 450 });
  });

  test("a settled card keeps its identity when the tail grows", () => {
    const window = [
      actions(9000, 9100),
      e("tool_call", 9200, { turn: 4, call: 1, name: "run_snippet", args: { code: "w" }, dispatchTs: 9000 }),
      e("snippet", 9200, { turn: 4, call: 1, code: "w" }),
      e("snippet_result", 9200, { turn: 4, call: 1, name: "run_snippet", isError: false, text: "ok" }),
    ];
    const first = groupFeed(window);
    const again = groupFeed([...window, e("state", 9300)], first);
    expect(again[0]).toBe(first[0]!);
  });
});
