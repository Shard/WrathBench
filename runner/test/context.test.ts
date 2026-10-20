import { describe, expect, test } from "bun:test";
import {
  CONTEXT_POLICY,
  assembleContext,
  foldUiOpenWindows,
  formatEventLine,
  formatStateSummary,
  messageWindow,
  messageWindowCut,
  messageWindowFold,
  foldToolResult,
  lastTurnGrowth,
  trimExpected,
  type ChatMessage,
  type ContextInputs,
  type HistoryMessage,
} from "../src/context";
import { parseEventFrame } from "@wrathbench/sdk";
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

  test("ambient motion, transport progress included, is dropped from the window and counted", () => {
    const ev = (seq: number, opcode: string): EventSummary => ({ seq, ts: seq, opcode, data: {} });
    const text = assembleContext({
      ...makeInputs(),
      events: [
        ev(1, "SMSG_MONSTER_MOVE"),
        ev(2, "WB_TRANSPORT_PROGRESS"),
        ev(3, "SMSG_ATTACKERSTATEUPDATE"),
        ev(4, "MSG_MOVE_HEARTBEAT"),
        ev(5, "WB_TRANSPORT_PROGRESS"),
        ev(6, "WB_MOVE_PROGRESS"),
      ],
    });
    expect(text).toContain(
      "[events: last 2, newest last; 4 ambient movement events folded into state only]\n" +
        "#3 SMSG_ATTACKERSTATEUPDATE {}\n#6 WB_MOVE_PROGRESS {}",
    );
    expect(text).not.toContain("WB_TRANSPORT_PROGRESS");
  });

  test("a fetch that was all ambient says so rather than claiming no events", () => {
    const ev = (seq: number, opcode: string): EventSummary => ({ seq, ts: seq, opcode, data: {} });
    const text = assembleContext({
      ...makeInputs(),
      events: [ev(1, "WB_TRANSPORT_PROGRESS"), ev(2, "SMSG_MONSTER_MOVE"), ev(3, "WB_TRANSPORT_PROGRESS")],
    });
    expect(text).toContain("[events]\nno non-movement events; 3 ambient movement events folded into state only");
    expect(text).not.toContain("none yet");
  });
});

describe("formatStateSummary: the chat tail", () => {
  // codex-astra freeplay (2026-10): 20,150 of 20,692 HUD chat lines were a bare
  // guid with nothing after it, because the module read creature speech with
  // the player layout. The decode is the module's; this pins what the HUD does
  // with what it now serves.
  test("a speaker is named from the packet, else from the name query, else by guid", () => {
    const text = formatStateSummary(
      {
        self: { name: "Benchy", guid: "1" },
        names: { "8": { value: "Quilby" } },
        chat: [
          { type: 12, senderGuid: "17365880163140632581", senderName: "Grizzled Sentry", receiverGuid: "1", message: "Halt, traveller." },
          { type: 1, senderGuid: "8", message: "hello" },
          { type: 1, senderGuid: "9", message: "anyone there" },
        ],
      },
      { sessionLive: true },
    );
    expect(text).toContain("recent chat (3):\n  <Grizzled Sentry> Halt, traveller.\n  <Quilby> hello\n  <9> anyone there");
  });

  test("a channel line names its channel, and the achievement broadcast is filled as the client fills it", () => {
    const text = formatStateSummary(
      {
        self: { name: "Benchy", guid: "1" },
        names: { "8": { value: "Quilby" } },
        chat: [
          { type: 17, senderGuid: "8", channelName: "General", message: "anyone selling linen" },
          { type: 48, senderGuid: "8", receiverGuid: "8", message: "%s has earned the achievement $a!", achievementId: 6 },
          { type: 48, senderGuid: "11", receiverGuid: "11", message: "%s has earned the achievement $a!" },
        ],
      },
      { sessionLive: true },
    );
    expect(text).toContain("  [General] <Quilby> anyone selling linen");
    expect(text).toContain("  <Quilby> Quilby has earned the achievement achievement 6!");
    expect(text).toContain("  <11> 11 has earned the achievement an achievement!");
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
    expect(text).toContain("bag: 0 free / 16, empty");
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
    expect(text).toContain("bag: 12 free / 16; most: Tough Jerky x5, Hearthstone");
    expect(text).toContain("quests: complete — 54; in progress — 82");
    expect(text).toContain("nearby: Kobold Vermin (12.3y), Kobold Worker dead (30y)");
    expect(text).toContain("ui: gossip (3 options)");
  });

  test("the bag line totals across worn bags when the snapshot says how many slots there are", () => {
    const items = [{ bag: 255, slot: 23, name: "Hearthstone", count: 1 }, { bag: 19, slot: 0, name: "Linen Cloth", count: 3 }];
    const text = formatStateSummary({ bag: { freeSlots: 20, totalSlots: 22, items } }, { sessionLive: true });
    expect(text).toContain("bag: 20 free / 22; most: Linen Cloth x3, Hearthstone");
  });

  test("a bag of single items names its first four slots", () => {
    // Ties keep bag order, so with nothing stacked the line reads as the old
    // one did, cut to BAG_MOST.
    const items = Array.from({ length: 11 }, (_, i) => ({ slot: 23 + i, itemId: i, name: `it${i}`, count: 1 }));
    const text = formatStateSummary({ bag: { freeSlots: 5, items } }, { sessionLive: true });
    expect(text).toContain("bag: 5 free / 16; most: it0, it1, it2, it3\n");
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

  test("a ghost whose corpse is inside a dungeon is pointed at the portal, not at a reclaim", () => {
    const text = formatStateSummary(
      {
        self: {
          fields: { playerFlags: { value: 0x10 } },
          position: { value: { map: 0, x: -1102, y: 1598.5, z: 52 } },
          corpse: { value: { map: 0, x: -1100.5, y: 1600.25, z: 50.5, source: "corpse_query", instanceMap: 36 } },
          graveyard: { value: { map: 0, x: -1102, y: 1598.5, z: 52 } },
          reclaimDelay: { value: { delayMs: 30_000, readyAt: 1_000_000 } },
        },
      },
      { sessionLive: true, now: 1_000_000 },
    );
    expect(text).toContain(
      "ghost at graveyard (-1102,1599); corpse inside the dungeon on map 36: " +
        "walk into its portal as a ghost to come back to life inside, " +
        "or Spirit Healer at the graveyard (-25% durability; resurrection sickness from level 11)",
    );
    expect(text).not.toContain("reclaim within 39y");
  });
});

/**
 * The three HUD lines reworked by operator decision (2026-10-14), each to fix
 * what a freeplay run showed it hiding, under the condition that the HUD not
 * grow much: quest titles, a nearby line that prefers what can be acted on,
 * and a bag summary in place of the first eight slots. Names are invented.
 */
describe("formatStateSummary: quest titles, nearby priority, bag summary", () => {
  const line = (text: string, prefix: string): string | undefined => text.split("\n").find((l) => l.startsWith(prefix));

  test("quests carry their titles, complete ones grouped first, long titles cut", () => {
    const text = formatStateSummary(
      {
        questLog: [
          { questId: 11, complete: false, title: "Mossy Errands" },
          { questId: 12, complete: true, title: "The Unreasonably Long Expedition Title" },
          { questId: 13, complete: false },
          { questId: 14, complete: true, title: "Boar Ribs" },
        ],
      },
      { sessionLive: true },
    );
    expect(line(text, "quests: ")).toBe(
      "quests: complete — 12 The Unreasonably Long E…, 14 Boar Ribs; in progress — 11 Mossy Errands, 13",
    );
  });

  test("a log with one state names only that group", () => {
    const open = formatStateSummary({ questLog: [{ questId: 5, complete: false, title: "Lost Lantern" }] }, { sessionLive: true });
    expect(line(open, "quests: ")).toBe("quests: in progress — 5 Lost Lantern");
    const done = formatStateSummary({ questLog: [{ questId: 5, complete: true, title: "Lost Lantern" }] }, { sessionLive: true });
    expect(line(done, "quests: ")).toBe("quests: complete — 5 Lost Lantern");
  });

  // Eight guards nearer than anything else, then the NPCs worth walking to.
  const town = (extra: Record<string, unknown>[] = []): Record<string, unknown>[] => [
    ...Array.from({ length: 8 }, (_, i) => ({ guid: `g${i}`, name: `Gate Warden`, type: "unit", distance: i + 1, roles: [] })),
    { guid: "q1", name: "Elder Pell", type: "unit", distance: 20, roles: ["gossip", "questGiver"], questGiver: "reward" },
    { guid: "q2", name: "Scout Arvi", type: "unit", distance: 22, roles: ["questGiver"], questGiver: "available" },
    { guid: "q3", name: "Brother Odo", type: "unit", distance: 24, roles: ["questGiver"], questGiver: "incomplete" },
    { guid: "v1", name: "Tamsin Reed", type: "unit", distance: 30, roles: ["vendor", "foodVendor"] },
    { guid: "f1", name: "Wing Keeper Ilsa", type: "unit", distance: 40, roles: ["flightMaster"] },
    ...extra,
  ];

  test("nearby keeps the two nearest, then prefers what can be acted on, shown nearest first", () => {
    const text = formatStateSummary({ self: { guid: "1" }, units: town() }, { sessionLive: true });
    expect(line(text, "nearby: ")).toBe(
      "nearby: Gate Warden (1y), Gate Warden (2y), Elder Pell (quest giver: reward, 20y), " +
        "Scout Arvi (quest giver: available, 22y), Tamsin Reed (vendor, 30y), " +
        "Wing Keeper Ilsa (flight master, 40y) +7 more",
    );
    // A questgiver whose marker says it has nothing for you now is not preferred.
    expect(text).not.toContain("Brother Odo");
  });

  test("anything that has you targeted is never crowded out", () => {
    const text = formatStateSummary(
      {
        self: { guid: "1" },
        units: town([
          { guid: "m1", name: "Rabid Thornpaw", type: "unit", distance: 60, roles: [], targetGuid: "1" },
          { guid: "m2", name: "Dead Thornpaw", type: "unit", distance: 61, roles: [], targetGuid: "1", dead: true },
        ]),
      },
      { sessionLive: true },
    );
    const nearby = line(text, "nearby: ")!;
    expect(nearby).toContain("Rabid Thornpaw (60y)");
    // The corpse's stale target is not a threat; the two nearest stay.
    expect(nearby).not.toContain("Dead Thornpaw");
    expect(nearby.startsWith("nearby: Gate Warden (1y), Gate Warden (2y), ")).toBe(true);
    // Six entries, the farthest preferred NPC dropped for the threat.
    expect(nearby).not.toContain("Wing Keeper Ilsa");
    expect(nearby.endsWith("+9 more")).toBe(true);
  });

  test("six or fewer in view are all shown in distance order, a quest object's marker included", () => {
    const text = formatStateSummary(
      {
        units: [
          { guid: "1", name: "Grubby Boar", type: "unit", distance: 3, roles: [] },
          { guid: "2", name: "Notice Board", type: "gameObject", distance: 5, roles: [], questGiver: "available" },
        ],
      },
      { sessionLive: true },
    );
    expect(line(text, "nearby: ")).toBe("nearby: Grubby Boar (3y), Notice Board (quest giver: available, 5y)");
  });

  test("the bag line counts grey junk, merges stacks, and names the best and the biggest", () => {
    const items = [
      { bag: 255, slot: 23, itemId: 1, name: "Homestone", count: 1, quality: 1 },
      { bag: 255, slot: 24, itemId: 2, name: "Cracked Tusk", count: 1, quality: 0 },
      { bag: 255, slot: 25, itemId: 3, name: "Rough Cloth", count: 20, quality: 1 },
      { bag: 255, slot: 26, itemId: 3, name: "Rough Cloth", count: 12, quality: 1 },
      { bag: 255, slot: 27, itemId: 4, name: "Broken Buckle", count: 1, quality: 0 },
      { bag: 19, slot: 0, itemId: 5, name: "Mossweave Gloves", count: 1, quality: 2 },
      { bag: 19, slot: 1, itemId: 6, name: "Starlit Pendant", count: 1, quality: 3 },
      { bag: 19, slot: 2, itemId: 7, name: "Bright Pebble", count: 6, quality: 2 },
      { bag: 19, slot: 3, itemId: 8, name: "Trail Bread", count: 9, quality: 1 },
      { bag: 19, slot: 4, itemId: 9, count: 3 },
      { bag: 19, slot: 5, itemId: 10, name: "Spare Twine", count: 4 },
    ];
    const text = formatStateSummary({ bag: { freeSlots: 9, totalSlots: 20, items } }, { sessionLive: true });
    expect(line(text, "bag: ")).toBe(
      "bag: 9 free / 20, 2 grey; most: Rough Cloth x32, Trail Bread x9, Spare Twine x4, item 9 x3; " +
        "green+: Starlit Pendant, Bright Pebble x6, Mossweave Gloves",
    );
  });

  test("an item whose quality is unobserved is neither junk nor green", () => {
    const text = formatStateSummary(
      { bag: { freeSlots: 14, items: [{ slot: 23, itemId: 9, name: "Odd Trinket", count: 1 }] } },
      { sessionLive: true },
    );
    expect(line(text, "bag: ")).toBe("bag: 14 free / 16; most: Odd Trinket");
  });
});

describe("assembleContext: the scratchpad's size against its cap", () => {
  const withPad = (scratchpad: string): string => assembleContext({ ...makeInputs(), scratchpad });

  test("the header shows the size, rounded down so it never reads as full early", () => {
    expect(withPad("x".repeat(31_234))).toContain("\n\n[scratchpad 31.2k/32k]\nxxx");
    expect(withPad("x".repeat(31_999))).toContain("[scratchpad 31.9k/32k]\n");
    expect(withPad("x".repeat(32_000))).toContain("[scratchpad 32.0k/32k]\n");
    expect(withPad("# plan")).toContain("[scratchpad 0.0k/32k]\n# plan");
  });

  test("a pad past the cap says so", () => {
    expect(withPad("x".repeat(32_040))).toContain("[scratchpad 32.0k/32k, over the cap]\n");
  });

  test("an empty pad keeps its placeholder", () => {
    expect(withPad("")).toContain("[scratchpad]\n(empty — write your plan");
  });
});

describe("formatEventLine: cast failures carry the SDK's reason", () => {
  test("a decoded SMSG_CAST_FAILED renders its result code and the name of it", () => {
    const parsed = parseEventFrame(
      JSON.stringify({ seq: 40, opcode: "SMSG_CAST_FAILED", opcodeId: 0x130, ts: 1, data: { spellId: 20271, result: 97 } }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const e = parsed.event;
    const out = formatEventLine({ seq: e.seq, ts: e.ts, opcode: e.opcode, data: e.data } as EventSummary);
    expect(out).toContain('"result":97');
    expect(out).toContain('"reason":"out_of_range"');
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

  test("a refused loot and an undecodable one open nothing", () => {
    expect(
      foldUiOpenWindows([{ opcode: "SMSG_LOOT_RESPONSE", seq: 3, data: { guid: "7", lootType: 0, error: 4 } }])
        .loot,
    ).toBeUndefined();
    expect(foldUiOpenWindows([{ opcode: "SMSG_LOOT_RESPONSE", seq: 3, data: { decodeError: true } }]).loot).toBeUndefined();
    // A refusal after a real window neither opens nor closes anything.
    expect(
      foldUiOpenWindows([
        { opcode: "SMSG_LOOT_RESPONSE", seq: 3, data: { guid: "7", lootType: 1, gold: 0, items: [] } },
        { opcode: "SMSG_LOOT_RESPONSE", seq: 4, data: { guid: "8", lootType: 0, error: 0 } },
      ]).loot,
    ).toBe(true);
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
    // before the trim (docs/METHODOLOGY.md, "An episodic log, asked for at
    // each trim"). `pairs` is one assistant + one tool result a turn, so a turn
    // boundary is an even length.
    const h = pairs(4 * MESSAGE_WINDOW_MAX);
    const crossing = h.slice(0, MESSAGE_WINDOW_MAX + 2);
    expect(messageWindowCut(crossing)).toBe(0);
    expect(messageWindow(crossing)).toEqual(crossing);
    expect(trimExpected(crossing)).toBe(true);

    const after = h.slice(0, MESSAGE_WINDOW_MAX + 4);
    expect(messageWindowCut(after)).toBe(MESSAGE_WINDOW_TRIM);
    // The trim also folds the block behind the verbatim one (see the fold's own
    // tests below); the window's messages are the same ones, in the same order.
    expect(messageWindow(after).length).toBe(after.length - MESSAGE_WINDOW_TRIM);
    expect(messageWindow(after).map((m) => m.role)).toEqual(after.slice(MESSAGE_WINDOW_TRIM).map((m) => m.role));
    expect(messageWindow(after).slice(MESSAGE_WINDOW_TRIM)).toEqual(after.slice(2 * MESSAGE_WINDOW_TRIM));
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

describe("the fold: aged tool results become one-line records", () => {
  const FOLDED = "[folded by harness] ";
  const HINT = "snippet timed out: the sandbox abandoned it after 30000ms. ".repeat(16);
  const CAP = CONTEXT_POLICY.WINDOW_MESSAGE_CHARS;

  /**
   * One turn: an assistant message with `calls` snippet calls and their
   * results. Every seventh call errors with a long hint, as a timeout does.
   */
  const turn = (i: number, calls: number): HistoryMessage[] => {
    const out: HistoryMessage[] = [
      {
        role: "assistant",
        content: `thinking ${i}`,
        ...(calls > 0
          ? {
              tool_calls: Array.from({ length: calls }, (_, k) => ({
                // Repeated across turns on purpose: the fold matches by position.
                id: `call_${k}`,
                type: "function" as const,
                function: { name: "run_snippet", arguments: JSON.stringify({ code: `await step(${i}, ${k})` }) },
              })),
            }
          : {}),
      },
    ];
    for (let k = 0; k < calls; k++) {
      const error = (i * 5 + k) % 7 === 0;
      out.push({
        role: "tool",
        content: error ? `error (30000ms)\n${HINT}` : `ok (${10 + i}ms)\n=> ${i}.${k}`,
        tool_call_id: `call_${k}`,
        isError: error,
      });
    }
    return out;
  };

  /** Varied turn sizes, an empty turn, and one resume-shaped jump of 30 calls. */
  const SIZES = Array.from({ length: 70 }, (_, i) => (i === 41 ? 30 : i === 17 ? 0 : [1, 3, 2, 1, 4][i % 5]!));

  interface Boundary {
    history: HistoryMessage[];
    /** Where each turn so far starts in `history`. */
    turns: number[];
    window: ChatMessage[];
  }

  /** The request window at every turn boundary, with the history it was cut from. */
  const boundaries = (): Boundary[] => {
    const history: HistoryMessage[] = [];
    const starts: number[] = [];
    const out: Boundary[] = [];
    SIZES.forEach((n, i) => {
      starts.push(history.length);
      history.push(...turn(i, n));
      const h = history.slice();
      out.push({ history: h, turns: starts.slice(), window: messageWindow(h) });
    });
    return out;
  };

  const isFolded = (m: ChatMessage): boolean => m.role === "tool" && String(m.content).startsWith(FOLDED);

  /** A history message as it is sent verbatim: capped, without the history's flag. */
  const sentVerbatim = (m: HistoryMessage): ChatMessage => {
    const { isError: _e, ...sent } = m;
    return typeof sent.content === "string" && sent.content.length > CAP
      ? { ...sent, content: `${sent.content.slice(0, CAP)}\n…[truncated ${sent.content.length - CAP} chars]` }
      : sent;
  };

  test("the line names the tool, the arguments cut short, ok or error, and a snippet's duration", () => {
    const call = (name: string, args: string) => ({ name, arguments: args });
    const ok: HistoryMessage = { role: "tool", content: "ok (412ms)\n=> 3", tool_call_id: "c", isError: false };
    expect(foldToolResult(call("run_snippet", '{"code":"state.self.level"}'), ok)).toEqual({
      role: "tool",
      content: '[folded by harness] run_snippet {"code":"state.self.level"}: ok, 412ms, 15 chars',
      tool_call_id: "c",
    });
    const err: HistoryMessage = { role: "tool", content: `error (30012ms)\n${HINT}`, tool_call_id: "c", isError: true };
    const code = JSON.stringify({ code: "await sdk.moveTo(-8913, -136, 81)" });
    expect(foldToolResult(call("run_snippet", code), err).content).toBe(
      `[folded by harness] run_snippet {"code":"await sdk.moveTo(-8913, -136, 81)"}: error, 30012ms, ${err.content!.length} chars`,
    );
    // Past FOLD_ARGS_CHARS the arguments end in "…"; a whitespace run is one space.
    const long = `{"query":  "${"Northshire  ".repeat(12)}"}`;
    const line = foldToolResult(call("search_reference", long), { role: "tool", content: "no results", isError: false }).content!;
    const shown = line.slice(FOLDED.length + "search_reference ".length, line.indexOf("…") + 1);
    expect(shown.length).toBe(CONTEXT_POLICY.FOLD_ARGS_CHARS);
    expect(shown).not.toContain("  ");
    expect(line.endsWith(": ok, 10 chars")).toBe(true);
    // Only a snippet's result opens with a duration; empty arguments show nothing.
    expect(foldToolResult(call("reflect", "{}"), { role: "tool", content: "ok (5ms) is not a header here", isError: true }).content).toBe(
      "[folded by harness] reflect {}: error, 29 chars",
    );
    expect(foldToolResult(call("state_summary", ""), { role: "tool", content: "== state ==", isError: false }).content).toBe(
      "[folded by harness] state_summary: ok, 11 chars",
    );
  });

  test("nothing folds before the first trim, and after it the boundary moves only with the cut", () => {
    let lastCut = -1;
    let lastFold = -1;
    let trims = 0;
    for (const { history, window } of boundaries()) {
      const cut = messageWindowCut(history);
      const fold = messageWindowFold(history);
      if (cut === 0) {
        expect(fold).toBe(0);
        expect(window.some(isFolded)).toBe(false);
      }
      expect(fold).toBeGreaterThanOrEqual(cut);
      if (fold < history.length) expect(history[fold]!.role).toBe("assistant"); // whole turns only
      if (cut === lastCut) expect(fold).toBe(lastFold);
      else if (lastCut >= 0) trims++;
      // The folded part is exactly the window's first `fold - cut` messages' results.
      window.forEach((m, i) => expect(isFolded(m)).toBe(i < fold - cut && m.role === "tool"));
      lastCut = cut;
      lastFold = fold;
    }
    expect(trims).toBeGreaterThanOrEqual(4);
  });

  test("a result is verbatim on the request it arrives in and on the one after, trim requests included", () => {
    // Boundary k holds turns 0..k: turns k and k-1 must be verbatim in it.
    let trimRequests = 0;
    let previousCut = 0;
    for (const { history, turns, window } of boundaries()) {
      const cut = messageWindowCut(history);
      const recent = turns.length >= 2 ? turns[turns.length - 2]! : 0;
      expect(recent).toBeGreaterThanOrEqual(cut);
      expect(window.slice(recent - cut)).toEqual(history.slice(recent).map(sentVerbatim));
      if (cut > previousCut) trimRequests++;
      previousCut = cut;
    }
    expect(trimRequests).toBeGreaterThanOrEqual(4);
  });

  test("between trims the request is byte-stable to the end of the window", () => {
    // The provider-cache property: while the cut holds, the window only grows
    // at its tail, folded part and all, so the whole of it stays a cached prefix.
    const all = boundaries();
    let compared = 0;
    for (let k = 1; k < all.length; k++) {
      const prev = all[k - 1]!;
      const next = all[k]!;
      if (messageWindowCut(next.history) !== messageWindowCut(prev.history)) continue;
      expect(JSON.stringify(next.window.slice(0, prev.window.length))).toBe(JSON.stringify(prev.window));
      compared++;
    }
    expect(compared).toBeGreaterThan(40);
    expect(all.some(({ window }) => window.some(isFolded))).toBe(true);
  });

  test("errors stay visible as errors, and the history's own flag is never sent", () => {
    const all = boundaries();
    const folded = all.flatMap(({ window }) => window.filter(isFolded));
    const timeout = `error (30000ms)\n${HINT}`;
    expect(folded.some((m) => String(m.content).endsWith(`: error, 30000ms, ${timeout.length} chars`))).toBe(true);
    expect(folded.some((m) => /: ok, \d+ms, \d+ chars$/.test(String(m.content)))).toBe(true);
    for (const { window } of all) for (const m of window) expect("isError" in m).toBe(false);
    // A folded line is a fraction of the hint it stands for.
    expect(Math.max(...folded.map((m) => String(m.content).length))).toBeLessThan(timeout.length / 5);
  });

  test("deterministic, and a history rebuilt from records folds to the same bytes", () => {
    for (const { history, window } of boundaries()) {
      const rebuilt = JSON.parse(JSON.stringify(history)) as HistoryMessage[];
      expect(JSON.stringify(messageWindow(rebuilt))).toBe(JSON.stringify(window));
      expect(JSON.stringify(messageWindow(history))).toBe(JSON.stringify(window));
      expect(messageWindowFold(rebuilt)).toBe(messageWindowFold(history));
    }
  });
});
