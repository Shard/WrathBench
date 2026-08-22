import { describe, expect, test } from "bun:test";
import {
  CONTEXT_POLICY,
  assembleContext,
  foldUiOpenWindows,
  formatStateSummary,
  messageWindow,
  messageWindowCut,
  type ChatMessage,
  type ContextInputs,
} from "../src/context";
import type { EventSummary } from "../src/sandbox/ipc";

function makeInputs(): ContextInputs {
  const events: EventSummary[] = Array.from({ length: 70 }, (_, i) => ({
    seq: i,
    ts: 1_000 + i,
    opcode: i % 2 === 0 ? "SMSG_MESSAGECHAT" : "SMSG_NOTIFICATION",
    data: { i, guid: "12345678901234567890" },
  }));
  return {
    stateSummary: formatStateSummary(
      {
        self: {
          guid: "42",
          name: "Benchy",
          level: { value: 3, seq: 10 },
          position: { value: { map: 0, x: 1.5, y: -2.5, z: 3 }, seq: 5 },
        },
        chat: [{ senderGuid: "42", message: "hello" }],
        notifications: [{ text: "You are muted" }],
        gaps: [],
        lastSeq: 69,
        eventCount: 70,
      },
      { sessionLive: true },
    ),
    events,
    scratchpad: "# plan\n- do quests",
    notices: [{ ts: 1, kind: "sandbox_restarted", text: "restarted" }],
    turn: 7,
  };
}

describe("assembleContext", () => {
  test("deterministic: same inputs give byte-identical output", () => {
    const a = assembleContext(makeInputs());
    const b = assembleContext(makeInputs());
    expect(a).toBe(b);
  });

  test("includes exactly the last EVENT_WINDOW events", () => {
    const text = assembleContext(makeInputs());
    expect(text).toContain(`[events: last ${CONTEXT_POLICY.EVENT_WINDOW}, newest last]`);
    expect(text).toContain("#69 ");
    expect(text).toContain(`#${70 - CONTEXT_POLICY.EVENT_WINDOW} `);
    expect(text).not.toContain(`#${69 - CONTEXT_POLICY.EVENT_WINDOW} `);
  });

  test("carries notices, scratchpad, turn and summary", () => {
    const text = assembleContext(makeInputs());
    expect(text).toContain("[turn 7]");
    expect(text).toContain("- sandbox_restarted: restarted");
    expect(text).toContain("# plan");
    expect(text).toContain("character: Benchy (guid 42) level 3");
    expect(text).toContain("session: in world");
  });

  test("empty inputs render honest placeholders", () => {
    const text = assembleContext({
      stateSummary: formatStateSummary(null, { sessionLive: false }),
      events: [],
      scratchpad: "",
      notices: [],
      turn: 1,
    });
    expect(text).toContain("no sandbox state yet");
    expect(text).toContain("[events]\nnone yet");
    expect(text).toContain("(empty — write your plan");
  });
});

describe("formatStateSummary", () => {
  test("unobserved fields say so instead of inventing zeros", () => {
    const text = formatStateSummary(
      { self: { name: "Benchy", guid: "1" }, lastSeq: 3, eventCount: 4 },
      { sessionLive: false },
    );
    expect(text).toContain("level unobserved");
    expect(text).toContain("position: unobserved");
    expect(text).toContain("health: unobserved  power: unobserved");
    expect(text).toContain("xp: unobserved / unobserved     money: unobserved");
    expect(text).toContain("bag: unobserved");
    expect(text).toContain("quests: unobserved");
    expect(text).toContain("nearby: unobserved");
    expect(text).toContain("target: none");
    // Never a guessed zero on the observable-field lines, and no ui line open.
    expect(text).toContain("level unobserved");
    expect(text).not.toContain("level 0");
    expect(text).not.toContain("xp: 0");
    expect(text).not.toContain("copper"); // money unobserved, not "0 copper"
    expect(text).not.toContain("\nui:");
  });

  test("observed zeros are shown, not turned into 'unobserved'", () => {
    const text = formatStateSummary(
      {
        self: { name: "B", guid: "1", health: { value: { current: 100, max: 100 } } },
        xp: { value: 0 },
        nextLevelXp: { value: 400 },
        money: { value: 0 },
        bag: { freeSlots: 0, items: [] },
      },
      { sessionLive: true },
    );
    expect(text).toContain("xp: 0 / 400     money: 0 copper");
    expect(text).toContain("bag: 0 free / 16    items: empty");
  });

  test("gaps are surfaced", () => {
    const text = formatStateSummary({ gaps: [{}, {}] }, { sessionLive: true });
    expect(text).toContain("stream: 2 gap(s)");
  });

  test("bag, quests, nearby and gossip lines render when present", () => {
    const text = formatStateSummary(
      {
        self: { name: "B", guid: "1" },
        bag: {
          freeSlots: 12,
          items: [
            { slot: 23, itemId: 6948, name: "Hearthstone", count: 1 },
            { slot: 24, itemId: 117, name: "Tough Jerky", count: 5 },
          ],
        },
        questLog: [
          { questId: 54, complete: true },
          { questId: 82, complete: false },
        ],
        units: [
          { guid: "9", name: "Kobold Vermin", type: "unit", distance: 12.3, dead: false },
          { guid: "10", name: "Kobold Worker", type: "unit", distance: 30, dead: true },
        ],
        ui: { gossip: { options: 3 } },
      },
      { sessionLive: true },
    );
    expect(text).toContain("bag: 12 free / 16    items: Hearthstone, Tough Jerky x5");
    expect(text).toContain("quests: 54 complete, 82 progress");
    expect(text).toContain("nearby: Kobold Vermin (12.3y), Kobold Worker dead (30y)");
    expect(text).toContain("ui: gossip (3 options)");
  });

  test("bag caps the item list at 8 with a '+K more' tail", () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ slot: 23 + i, itemId: i, name: `it${i}`, count: 1 }));
    const text = formatStateSummary({ bag: { freeSlots: 5, items } }, { sessionLive: true });
    expect(text).toContain("+3 more");
    expect(text).toContain("it0, it1, it2, it3, it4, it5, it6, it7 +3 more");
  });

  test("nearby caps at 6 and never prints exact mob health", () => {
    // Even if a raw mob health leaks into the unit shape, the HUD must not print it.
    const units = Array.from({ length: 8 }, (_, i) => ({
      guid: String(i),
      name: `Mob${i}`,
      type: "unit",
      distance: i,
      dead: false,
      health: 4321,
      maxHealth: 5000,
    }));
    const text = formatStateSummary({ units }, { sessionLive: true });
    expect(text).toContain("nearby: Mob0 (0y)");
    expect(text).toContain("+2 more");
    expect(text).not.toContain("4321");
    expect(text).not.toContain("5000");
  });

  test("target resolves its name from units and hides the no-target guid '0'", () => {
    const withTarget = formatStateSummary(
      {
        self: { name: "B", guid: "1", targetGuid: { value: "9" } },
        units: [{ guid: "9", name: "Kobold Vermin", type: "unit", distance: 5 }],
      },
      { sessionLive: true },
    );
    expect(withTarget).toContain("target: Kobold Vermin (guid 9)");
    const noTarget = formatStateSummary(
      { self: { name: "B", guid: "1", targetGuid: { value: "0" } } },
      { sessionLive: true },
    );
    expect(noTarget).toContain("target: none");
  });

  test("dead and ghost fold onto the ui line from self fields", () => {
    const text = formatStateSummary(
      {
        self: {
          name: "B",
          guid: "1",
          health: { value: { current: 0, max: 100 } },
          fields: { playerFlags: { value: 0x10 } },
        },
      },
      { sessionLive: true },
    );
    expect(text).toContain("ui: dead | ghost");
  });
});

describe("foldUiOpenWindows", () => {
  test("gossip is open until a later complete, and carries the option count", () => {
    const open = foldUiOpenWindows([
      { opcode: "SMSG_GOSSIP_MESSAGE", seq: 5, data: { options: [{}, {}, {}] } },
    ]);
    expect(open.gossip).toEqual({ options: 3 });
    const closed = foldUiOpenWindows([
      { opcode: "SMSG_GOSSIP_MESSAGE", seq: 5, data: { options: [{}, {}] } },
      { opcode: "SMSG_GOSSIP_COMPLETE", seq: 7 },
    ]);
    expect(closed.gossip).toBeUndefined();
  });

  test("loot is open until its release response", () => {
    expect(foldUiOpenWindows([{ opcode: "SMSG_LOOT_RESPONSE", seq: 3 }]).loot).toBe(true);
    expect(
      foldUiOpenWindows([
        { opcode: "SMSG_LOOT_RESPONSE", seq: 3 },
        { opcode: "SMSG_LOOT_RELEASE_RESPONSE", seq: 4 },
      ]).loot,
    ).toBeUndefined();
  });

  test("vendor shows only when it is the most-recent window event of the three", () => {
    expect(
      foldUiOpenWindows([
        { opcode: "SMSG_GOSSIP_MESSAGE", seq: 2, data: { options: [] } },
        { opcode: "SMSG_LIST_INVENTORY", seq: 6 },
      ]).vendor,
    ).toBe(true);
    // A newer gossip message means we cannot prove the vendor list is still open.
    expect(
      foldUiOpenWindows([
        { opcode: "SMSG_LIST_INVENTORY", seq: 6 },
        { opcode: "SMSG_GOSSIP_MESSAGE", seq: 9, data: { options: [] } },
      ]).vendor,
    ).toBeUndefined();
  });

  test("a truncated window fails safe to closed", () => {
    // Only the complete survived in the buffer; the opening message rolled off.
    expect(foldUiOpenWindows([{ opcode: "SMSG_GOSSIP_COMPLETE", seq: 40 }]).gossip).toBeUndefined();
    expect(foldUiOpenWindows([]).gossip).toBeUndefined();
  });
});

describe("messageWindow", () => {
  const { MESSAGE_WINDOW_MAX, MESSAGE_WINDOW_TRIM } = CONTEXT_POLICY;
  const FLOOR = MESSAGE_WINDOW_MAX - MESSAGE_WINDOW_TRIM;

  const assistant = (i: number, calls = 1): ChatMessage => ({
    role: "assistant",
    content: `a${i}`,
    tool_calls: Array.from({ length: calls }, (_, k) => ({
      id: `t${i}.${k}`,
      type: "function" as const,
      function: { name: "x", arguments: "{}" },
    })),
  });
  const tool = (i: number, k = 0): ChatMessage => ({
    role: "tool",
    content: `r${i}.${k}`,
    tool_call_id: `t${i}.${k}`,
  });

  /** `n` messages of one-call turns: even indices assistant, odd indices tool. */
  const pairs = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? assistant(i / 2) : tool((i - 1) / 2)));

  /** No tool result is left without the assistant message that called it. */
  const pairsIntact = (w: ChatMessage[]): boolean => {
    const ids = new Set(
      w.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [])),
    );
    return w.every((m) => m.role !== "tool" || ids.has(m.tool_call_id!));
  };

  test("grows untouched up to the ceiling", () => {
    for (const n of [0, 2, FLOOR, MESSAGE_WINDOW_MAX - 1, MESSAGE_WINDOW_MAX]) {
      const h = pairs(n);
      expect(messageWindowCut(h)).toBe(0);
      expect(messageWindow(h)).toEqual(h);
    }
  });

  test("one message past the ceiling drops exactly one block", () => {
    const h = pairs(MESSAGE_WINDOW_MAX + 1);
    expect(messageWindowCut(h)).toBe(MESSAGE_WINDOW_TRIM);
    const w = messageWindow(h);
    expect(w.length).toBe(FLOOR + 1);
    expect(w).toEqual(h.slice(MESSAGE_WINDOW_TRIM));
    expect(w[0]!.role).toBe("assistant");
  });

  test("the growing window is a stable prefix within a block", () => {
    const h = pairs(4 * MESSAGE_WINDOW_MAX);
    const base = messageWindow(h.slice(0, MESSAGE_WINDOW_MAX + 1));
    for (let n = MESSAGE_WINDOW_MAX + 1; n <= MESSAGE_WINDOW_MAX + MESSAGE_WINDOW_TRIM; n++) {
      const w = messageWindow(h.slice(0, n));
      expect(w.slice(0, base.length)).toEqual(base); // appends only, prefix untouched
    }
  });

  test("the cut moves once per block, not once per turn", () => {
    const h = pairs(4 * MESSAGE_WINDOW_MAX);
    const cuts: number[] = [];
    for (let n = 0; n <= h.length; n++) {
      const cut = messageWindowCut(h.slice(0, n));
      if (cuts[cuts.length - 1] !== cut) cuts.push(cut);
    }
    // one distinct cut per block, each a whole multiple of the trim: over 192
    // messages (~96 turns) the prefix is invalidated 6 times, not ~96.
    const expected = Array.from(
      { length: 1 + (h.length - MESSAGE_WINDOW_MAX) / MESSAGE_WINDOW_TRIM },
      (_, i) => i * MESSAGE_WINDOW_TRIM,
    );
    expect(cuts).toEqual(expected);
  });

  test("stays within the ceiling and never splits a tool-call pair", () => {
    const h = pairs(10 * MESSAGE_WINDOW_MAX);
    for (let n = 0; n <= h.length; n++) {
      const w = messageWindow(h.slice(0, n));
      expect(w.length).toBeLessThanOrEqual(MESSAGE_WINDOW_MAX);
      expect(pairsIntact(w)).toBe(true);
      if (w.length > 0) expect(w[0]!.role).toBe("assistant");
    }
  });

  test("a boundary landing mid-turn moves forward to the next assistant", () => {
    // Turns of one assistant + three tool results: index 24 is a tool message,
    // so the block boundary must snap forward off it.
    const h: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) h.push(assistant(i, 3), tool(i, 0), tool(i, 1), tool(i, 2));
    const cut = messageWindowCut(h);
    expect(cut).toBeGreaterThan(MESSAGE_WINDOW_TRIM);
    expect(h[cut]!.role).toBe("assistant");
    const w = messageWindow(h);
    expect(w.length).toBeLessThanOrEqual(MESSAGE_WINDOW_MAX);
    expect(pairsIntact(w)).toBe(true);
  });

  test("caps an oversized message content, and leaves the rest alone", () => {
    const cap = CONTEXT_POLICY.WINDOW_MESSAGE_CHARS;
    const big: ChatMessage = { role: "tool", content: "x".repeat(cap + 137), tool_call_id: "t0.0" };
    const h = [assistant(0), big, assistant(1), tool(1)];
    const w = messageWindow(h);
    expect(w[1]!.content).toBe(`${"x".repeat(cap)}\n…[truncated 137 chars]`);
    expect(w[0]).toEqual(h[0]!); // untouched messages are passed through
    expect(w[3]).toEqual(h[3]!);
    expect(h[1]!.content!.length).toBe(cap + 137); // the stored history is not mutated
  });

  test("the cap boundary is exact", () => {
    const cap = CONTEXT_POLICY.WINDOW_MESSAGE_CHARS;
    const at: ChatMessage = { role: "tool", content: "y".repeat(cap), tool_call_id: "t0.0" };
    const over: ChatMessage = { role: "tool", content: "y".repeat(cap + 1), tool_call_id: "t0.0" };
    expect(messageWindow([assistant(0), at])[1]!.content).toBe("y".repeat(cap));
    expect(messageWindow([assistant(0), over])[1]!.content).toBe(
      `${"y".repeat(cap)}\n…[truncated 1 chars]`,
    );
  });

  test("capping is deterministic and carries nothing turn-dependent", () => {
    const big: ChatMessage = {
      role: "tool",
      content: "z".repeat(CONTEXT_POLICY.WINDOW_MESSAGE_CHARS * 3),
      tool_call_id: "t0.0",
    };
    const h = [assistant(0), big];
    expect(JSON.stringify(messageWindow(h))).toBe(JSON.stringify(messageWindow(h)));
    // and identical however many messages precede it in the window
    const later = messageWindow([...pairs(20), assistant(50), big]);
    expect(later[later.length - 1]!.content).toBe(messageWindow(h)[1]!.content);
  });

  test("deterministic: same history, byte-identical window", () => {
    const h = pairs(3 * MESSAGE_WINDOW_MAX + 7);
    expect(JSON.stringify(messageWindow(h))).toBe(JSON.stringify(messageWindow(h.slice())));
  });

  test("a rebuilt history windows identically to an incrementally grown one", () => {
    // The resume-shaped case: the cut is a function of stored history alone, so
    // a history rebuilt from persisted records (JSON round-trip) windows to the
    // same bytes as the in-memory one, at every turn including mid-block.
    const live: ChatMessage[] = [];
    for (let i = 0; i < 60; i++) {
      live.push(assistant(i, 2), tool(i, 0), tool(i, 1));
      const rebuilt = JSON.parse(JSON.stringify(live)) as ChatMessage[];
      expect(messageWindowCut(rebuilt)).toBe(messageWindowCut(live));
      expect(JSON.stringify(messageWindow(rebuilt))).toBe(JSON.stringify(messageWindow(live)));
    }
  });
});
