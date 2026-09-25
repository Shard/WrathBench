import { describe, expect, test } from "bun:test";
import {
  CONTEXT_POLICY,
  assembleContext,
  foldUiOpenWindows,
  formatEventLine,
  formatStateSummary,
  messageWindow,
  messageWindowCut,
  lastTurnGrowth,
  trimExpected,
  type ChatMessage,
  type ContextInputs,
} from "../src/context";
import type { EventSummary } from "../src/sandbox/ipc";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_LISTING_HEADER, Workspace } from "../src/workspace";

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
    workspace: {
      files: [
        { path: "lib/nav.ts", bytes: 64, firstLine: "// walking helpers" },
        { path: "notes.md", bytes: 18, firstLine: "# plan" },
      ],
      notes: "# plan\n- do quests",
    },
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

  test("with a workspace: the listing, then notes.md verbatim, close the message — byte for byte", () => {
    const text = assembleContext(makeInputs());
    expect(text.endsWith(
      "\n\n<workspace>\n" +
        `${WORKSPACE_LISTING_HEADER}\n` +
        "lib/nav.ts  64 bytes  // walking helpers\n" +
        "notes.md  18 bytes  # plan\n" +
        "</workspace>\n\n" +
        '<notes path="notes.md" usage="0% 18/32000">\n' +
        "# plan\n- do quests\n" +
        "</notes>",
    )).toBe(true);
    // Read off a real workspace, the same bytes come back.
    const ws = new Workspace(join(mkdtempSync(join(tmpdir(), "wrathbench-ctx-")), "workspace"));
    ws.write("notes.md", "# plan\n- do quests");
    ws.write("lib/nav.ts", `// walking helpers\n${"x".repeat(45)}`);
    const fromDisk = assembleContext({ ...makeInputs(), workspace: ws.view() });
    expect(fromDisk).toBe(text);
    expect(assembleContext({ ...makeInputs(), workspace: ws.view() })).toBe(fromDisk);
  });

  test("includes exactly the last EVENT_WINDOW events", () => {
    const text = assembleContext(makeInputs());
    expect(text).toContain(`[events: last ${CONTEXT_POLICY.EVENT_WINDOW}, newest last]`);
    expect(text).toContain("#69 ");
    expect(text).toContain(`#${70 - CONTEXT_POLICY.EVENT_WINDOW} `);
    expect(text).not.toContain(`#${69 - CONTEXT_POLICY.EVENT_WINDOW} `);
  });

  test("carries notices, notes, turn and summary", () => {
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
      workspace: { files: [{ path: "notes.md", bytes: 0, firstLine: "" }], notes: "" },
      notices: [],
      turn: 1,
    });
    expect(text).toContain("no sandbox state yet");
    expect(text).toContain("[events]\nnone yet");
    expect(text).toContain("notes.md  0 bytes\n</workspace>");
    expect(text.endsWith('<notes path="notes.md" usage="0% 0/32000">\n</notes>')).toBe(true);
  });

  test("entrypoint loop: the [wake] block sits right after the goal line and before the notices, and nothing else moves", () => {
    const wake = "[wake 3 · request 1 of 20 in this wake · asleep 5m00s · woke for: fallback]\nprogram: none";
    const plain = assembleContext(makeInputs());
    const woken = assembleContext({ ...makeInputs(), wake });
    const [goal, ...rest] = woken.split("\n\n");
    expect(goal).toBe(
      "[turn 7] Goal: survive and level as far as you can. Act via tools and your program; end your turn by replying without a tool call.",
    );
    expect(rest[0]).toBe(wake);
    expect(rest[1]!.startsWith("[harness notices]")).toBe(true);
    // Everything after the block is the snippet loop's message, byte for byte.
    expect(rest.slice(1).join("\n\n")).toBe(plain.split("\n\n").slice(1).join("\n\n"));
    expect(assembleContext({ ...makeInputs(), wake })).toBe(woken);
  });
});

describe("formatStateSummary", () => {
  test("position names the zone and subzone first, ids and coordinates kept", () => {
    const text = formatStateSummary(
      {
        self: {
          name: "Benchy",
          guid: "1",
          position: { value: { map: 0, x: -8949.9, y: -132.4, z: 83.5 }, seq: 5 },
          zone: { value: { id: 12, name: "Elwynn Forest" }, seq: 6 },
          area: { value: { id: 9, name: "Northshire Valley" }, seq: 6 },
        },
        lastSeq: 6,
        eventCount: 7,
      },
      { sessionLive: true },
    );
    expect(text).toContain("position: Elwynn Forest / Northshire Valley — map 0 (-8949.9, -132.4, 83.5) [seq 5]");
  });

  test("position collapses to the zone alone when the subzone is the zone, and omits unobserved names", () => {
    const self = {
      name: "Benchy",
      guid: "1",
      position: { value: { map: 0, x: 1, y: 2, z: 3 }, seq: 5 },
    };
    const same = formatStateSummary(
      { self: { ...self, zone: { value: { id: 1537, name: "Ironforge" } }, area: { value: { id: 1537, name: "Ironforge" } } } },
      { sessionLive: true },
    );
    expect(same).toContain("position: Ironforge — map 0 (1, 2, 3)");
    const none = formatStateSummary({ self }, { sessionLive: true });
    expect(none).toContain("position: map 0 (1, 2, 3)");
  });

  test("home is the bind point with its area name, and absent until the server has said one", () => {
    const self = { name: "Benchy", guid: "1" };
    const bound = formatStateSummary(
      { self: { ...self, bindPoint: { value: { map: 0, x: -4840.7, y: -857.1, z: 502, area: { id: 1537, name: "Ironforge" } }, seq: 9 } } },
      { sessionLive: true },
    );
    expect(bound).toContain("home: Ironforge — map 0 (-4840.7, -857.1, 502) [Hearthstone destination]");
    expect(formatStateSummary({ self }, { sessionLive: true })).not.toContain("home:");
  });

  test("achievements are a count and a points total, never the list", () => {
    const text = formatStateSummary(
      {
        self: {
          name: "Benchy",
          guid: "1",
          achievements: {
            loginSeen: true,
            points: 20,
            entries: [
              { achievementId: 6, name: "Level 10", points: 10, source: "login" },
              { achievementId: 12, name: "Explore Elwynn Forest", points: 10, source: "earned" },
            ],
          },
        },
      },
      { sessionLive: true },
    );
    expect(text).toContain("achievements: 2 (20 pts)");
    // The list is prompt every turn for something a snippet can read.
    expect(text).not.toContain("Explore Elwynn Forest");
  });

  test("no achievement packet reads unobserved, never a zero", () => {
    const text = formatStateSummary({ self: { name: "Benchy", guid: "1" } }, { sessionLive: true });
    expect(text).toContain("achievements: unobserved");
  });

  test("nearby appends NPC roles compactly: spaced words, gossip dropped, sub-kinds folded", () => {
    const text = formatStateSummary(
      {
        self: { name: "Benchy", guid: "1" },
        units: [
          { guid: "9", name: "Gryth Thurden", type: "unit", distance: 4.2, roles: ["gossip", "flightMaster"] },
          { guid: "10", name: "Brog Hamfist", type: "unit", distance: 8, roles: ["vendor", "foodVendor", "repair"] },
          { guid: "11", name: "Kobold Vermin", type: "unit", distance: 12, roles: [] },
        ],
      },
      { sessionLive: true },
    );
    expect(text).toContain(
      "nearby: Gryth Thurden (flight master, 4.2y), Brog Hamfist (vendor, repair, 8y), Kobold Vermin (12y)",
    );
  });

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

  test("the bag line totals across worn bags when the snapshot says how many slots there are", () => {
    const items = [{ bag: 255, slot: 23, name: "Hearthstone", count: 1 }, { bag: 19, slot: 0, name: "Linen Cloth", count: 3 }];
    const text = formatStateSummary({ bag: { freeSlots: 20, totalSlots: 22, items } }, { sessionLive: true });
    expect(text).toContain("bag: 20 free / 22    items: Hearthstone, Linen Cloth x3");
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
    expect(text).toContain("ghost; corpse position not observed yet");
  });

  test("a ghost is told where it stands, where its corpse is, and both ways back", () => {
    const text = formatStateSummary(
      {
        self: {
          name: "B",
          guid: "1",
          position: { value: { map: 0, x: -8600.2, y: -30.7, z: 90 } },
          health: { value: { current: 1, max: 100 } },
          fields: { playerFlags: { value: 0x10 } },
          corpse: { value: { map: 0, x: -8790, y: -160, z: 82.5, source: "corpse_query" } },
          graveyard: { value: { map: 0, x: -8600, y: -30, z: 90 } },
          reclaimDelay: { value: { delayMs: 30_000, readyAt: 1_000_000 + 12_400 } },
        },
      },
      { sessionLive: true, now: 1_000_000 },
    );
    expect(text).toContain(
      "ghost at graveyard (-8600,-30); corpse 230y away at (-8790,-160): reclaim within 39y after 13s (no sickness), " +
        "or Spirit Healer at the graveyard (-25% durability; resurrection sickness from level 11)",
    );
    const later = formatStateSummary(
      {
        self: {
          fields: { playerFlags: { value: 0x10 } },
          position: { value: { map: 0, x: 0, y: 0, z: 0 } },
          corpse: { value: { map: 1, x: 5, y: 5, z: 5, source: "death_spot" } },
        },
      },
      { sessionLive: true },
    );
    expect(later).toContain("corpse on map 1 at (5,5), you are on map 0: reclaim within 39y after the reclaim delay");
  });
});

describe("formatEventLine", () => {
  const line = (data: unknown): string =>
    formatEventLine({ seq: 12, ts: 1_000, opcode: "SMSG_INVENTORY_CHANGE_FAILURE", data } as EventSummary);

  test("an inventory refusal is named, with the server's number still there", () => {
    const out = line({ result: 60 });
    expect(out).toContain("\"result\":60");
    expect(out).toContain("not while in combat");
  });

  test("a code the SDK does not name renders bare rather than guessed at", () => {
    const out = line({ result: 999 });
    expect(out).toContain("\"result\":999");
    expect(out.endsWith("}")).toBe(true);
  });

  test("a missing or malformed result adds nothing", () => {
    expect(line({}).endsWith("}")).toBe(true);
    expect(line({ result: "60" }).endsWith("}")).toBe(true);
  });

  test("other opcodes are untouched", () => {
    const out = formatEventLine({
      seq: 3,
      ts: 1,
      opcode: "SMSG_MESSAGECHAT",
      data: { result: 60 },
    } as EventSummary);
    expect(out).not.toContain("not while in combat");
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

  test("the crossing turn keeps its whole window; the block drops one turn later", () => {
    // The cut lags one turn behind the crossing on purpose, so the turn that
    // takes the history past the ceiling can be *told* it is the last one
    // before the trim (docs/METHODOLOGY.md, "An episodic log, written before
    // each trim"). `pairs` is one assistant + one tool result a turn, so a turn
    // boundary is an even length.
    const h = pairs(4 * MESSAGE_WINDOW_MAX);
    const crossing = h.slice(0, MESSAGE_WINDOW_MAX + 2);
    expect(messageWindowCut(crossing)).toBe(0);
    expect(messageWindow(crossing)).toEqual(crossing);
    expect(trimExpected(crossing)).toBe(true);

    const after = h.slice(0, MESSAGE_WINDOW_MAX + 4);
    expect(messageWindowCut(after)).toBe(MESSAGE_WINDOW_TRIM);
    expect(messageWindow(after)).toEqual(after.slice(MESSAGE_WINDOW_TRIM));
    expect(messageWindow(after)[0]!.role).toBe("assistant");
    expect(trimExpected(after)).toBe(false);
  });

  test("trimExpected is true on exactly one turn boundary per block", () => {
    const h = pairs(8 * MESSAGE_WINDOW_MAX);
    const announced: number[] = [];
    const trimmed: number[] = [];
    let lastCut = 0;
    // Turn boundaries only, which is where the loop reads both.
    for (let n = 0; n <= h.length; n += 2) {
      const slice = h.slice(0, n);
      if (trimExpected(slice)) announced.push(n);
      const cut = messageWindowCut(slice);
      if (cut > lastCut) {
        trimmed.push(n);
        lastCut = cut;
      }
    }
    expect(announced.length).toBeGreaterThan(3);
    // Every trim is preceded by exactly one announcement, on the turn before.
    expect(trimmed).toEqual(announced.map((n) => n + 2));
  });

  test("the growing window is a stable prefix within a block", () => {
    // Boundary-agnostic: whenever the cut holds still, every later window in
    // that block must start with the first one byte for byte — that is the
    // provider-cache property the block trim exists for.
    const h = pairs(4 * MESSAGE_WINDOW_MAX);
    let cut = -1;
    let base: ChatMessage[] = [];
    let blocks = 0;
    for (let n = 0; n <= h.length; n++) {
      const slice = h.slice(0, n);
      const c = messageWindowCut(slice);
      const w = messageWindow(slice);
      if (c !== cut) {
        cut = c;
        base = w;
        blocks++;
        continue;
      }
      expect(w.slice(0, base.length)).toEqual(base); // appends only, prefix untouched
    }
    expect(blocks).toBeGreaterThan(2);
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
      const slice = h.slice(0, n);
      const w = messageWindow(slice);
      // The lag lets the window sit above the ceiling for one turn, by at most
      // that turn's own growth and never more (see `laggedLength`).
      expect(w.length).toBeLessThanOrEqual(MESSAGE_WINDOW_MAX + lastTurnGrowth(slice));
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
    expect(w.length).toBeLessThanOrEqual(MESSAGE_WINDOW_MAX + lastTurnGrowth(h));
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

  test("a read_file result survives the window whole; a snippet result of the same size is still cut", () => {
    const text = "f".repeat(20_000);
    const call = (id: string, name: string): ChatMessage => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
    });
    const h: ChatMessage[] = [
      call("c1", "read_file"),
      { role: "tool", content: text, tool_call_id: "c1" },
      call("c2", "run_snippet"),
      { role: "tool", content: text, tool_call_id: "c2" },
    ];
    const w = messageWindow(h);
    expect(w[1]).toBe(h[1]!);
    expect(w[1]!.content).toBe(text);
    expect(w[3]!.content).toBe(`${"f".repeat(CONTEXT_POLICY.WINDOW_MESSAGE_CHARS)}\n…[truncated ${20_000 - CONTEXT_POLICY.WINDOW_MESSAGE_CHARS} chars]`);
    // Keyed on the tool the call named, from the history alone: a rebuilt history windows the same.
    expect(JSON.stringify(messageWindow(JSON.parse(JSON.stringify(h)) as ChatMessage[]))).toBe(JSON.stringify(w));
    // Every other tool keeps the cap, a sibling file tool included.
    const other: ChatMessage[] = [call("c3", "write_file"), { role: "tool", content: text, tool_call_id: "c3" }];
    expect(messageWindow(other)[1]!.content!.length).toBeLessThan(text.length);
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
