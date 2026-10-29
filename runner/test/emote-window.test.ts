/**
 * The second in-game wave's events on the event window: a unit's one-shot
 * emote (`SMSG_EMOTE`), which a town's NPCs play over and over to everyone in
 * range, is left out of the window when it is a creature's that does not
 * involve us (context.ts, `emoteShown`); a player's text emote, a channel
 * notice, the flight state and the landing of a jump, knockback or fall are
 * shown as they arrive (wrath-mcp/module/PROTOCOL.md, the event tables).
 *
 * Every frame is hand-written from PROTOCOL.md's tables; the names are
 * invented. Nothing here is captured from a running game (CLAUDE.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONTEXT_POLICY, emoteShown, eventWindow, formatEventLine } from "../src/context";
import { SandboxHost } from "../src/sandbox/host";
import type { EventSummary } from "@wrathbench/mcp";
import { Scratchpad } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const ME = "7";
const PLAYER = "960";
/** Creatures: high part 0xF130. */
const GUARD = "17379391048826012345";
const VENDOR = "17379391048826012346";
const QUESTGIVER = "17379391048826012347";
/** Our pet: high part 0xF140. */
const PET = "17383894561650114660";

describe("emoteShown: which emotes the window keeps", () => {
  const cases: [string, string, Parameters<typeof emoteShown>[3], boolean][] = [
    ["our own", ME, undefined, true],
    ["a player's, out of view", PLAYER, undefined, true],
    ["a player's, by its create block", GUARD, { objectType: "player" }, true],
    ["our pet's", PET, { objectType: "unit", ownerGuid: ME }, true],
    ["a creature's whose target is us", QUESTGIVER, { objectType: "unit", targetGuid: ME }, true],
    ["a creature's targeting someone else", GUARD, { objectType: "unit", targetGuid: PLAYER }, false],
    ["a creature's in view, targeting nobody", VENDOR, { objectType: "unit" }, false],
    ["a creature's out of view", GUARD, undefined, false],
  ];
  test.each(cases)("%s", (_name, guid, emoter, want) => {
    expect(emoteShown("SMSG_EMOTE", { guid, emoteId: 1 }, ME, emoter)).toBe(want);
  });

  test("every other opcode is shown, the text emote and channel notice included", () => {
    expect(emoteShown("SMSG_TEXT_EMOTE", { guid: GUARD, textEmote: 101, emoteNum: 0, targetName: "" }, ME, undefined)).toBe(true);
    expect(emoteShown("SMSG_CHANNEL_NOTIFY", { type: 2, channel: "General" }, ME, undefined)).toBe(true);
  });
});

describe("the new events' lines", () => {
  const line = (opcode: string, data: unknown): string => formatEventLine({ seq: 5, ts: 0, opcode, data });

  test("each renders as its payload, nothing added", () => {
    expect(line("SMSG_EMOTE", { guid: PLAYER, emoteId: 3 })).toBe(`#5 SMSG_EMOTE {"guid":"${PLAYER}","emoteId":3}`);
    expect(line("SMSG_TEXT_EMOTE", { guid: PLAYER, textEmote: 101, emoteNum: 0, targetName: "Fenwick" })).toBe(
      `#5 SMSG_TEXT_EMOTE {"guid":"${PLAYER}","textEmote":101,"emoteNum":0,"targetName":"Fenwick"}`,
    );
    expect(line("SMSG_CHANNEL_NOTIFY", { type: 2, channel: "Testchannel", flags: 0, channelId: 0 })).toBe(
      `#5 SMSG_CHANNEL_NOTIFY {"type":2,"channel":"Testchannel","flags":0,"channelId":0}`,
    );
    expect(line("WB_FLIGHT_STATE", { canFly: true, airborne: false })).toBe(`#5 WB_FLIGHT_STATE {"canFly":true,"airborne":false}`);
    for (const cause of ["jump", "knockback", "fall"]) {
      expect(line("WB_SELF_MOVE", { opcode: "MSG_MOVE_FALL_LAND", cause, pos: { x: 1, y: 2, z: 3, o: 0 }, fromZ: 9 })).toBe(
        `#5 WB_SELF_MOVE {"opcode":"MSG_MOVE_FALL_LAND","cause":"${cause}","pos":{"x":1,"y":2,"z":3,"o":0},"fromZ":9}`,
      );
    }
    expect(line("WB_MOVE_RESULT", { status: "knocked_back" })).toBe(`#5 WB_MOVE_RESULT {"status":"knocked_back"}`);
  });

  test("another unit's knockback relay is ambient movement", () => {
    expect(CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test("MSG_MOVE_KNOCK_BACK")).toBe(true);
    for (const op of ["SMSG_EMOTE", "SMSG_TEXT_EMOTE", "SMSG_CHANNEL_NOTIFY", "WB_FLIGHT_STATE", "WB_SELF_MOVE"]) {
      expect(CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(op)).toBe(false);
    }
  });

  test("a bystander's emote is left out of the window and not counted as ambient", () => {
    const ev = (seq: number, opcode: string, extra: Partial<EventSummary> = {}): EventSummary => ({ seq, ts: seq, opcode, data: {}, ...extra });
    const { window, folded } = eventWindow([ev(1, "SMSG_EMOTE", { bystander: true }), ev(2, "SMSG_EMOTE"), ev(3, "SMSG_MONSTER_MOVE")]);
    expect(window.map((e) => e.seq)).toEqual([2]);
    expect(folded).toBe(1);
  });
});

// ------------------------------------------------------------ the child

const tempDir = tempDirs();
const hosts: SandboxHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

function makeHost(): SandboxHost {
  const dir = tempDir("wrathbench-emote-window-");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

/** Us, a guard and a vendor idling, a quest giver facing us, and our pet. */
const PRELUDE = `
state.seedSelf({ guid: "${ME}", name: "Fenwick" });
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: Date.now(), data }));
};
feed("SMSG_UPDATE_OBJECT", 0x0a9, { blocks: 4, objects: [
  { update: "create", guid: "${GUARD}", objectType: "unit", pos: { x: 1, y: 0, z: 0, o: 0 }, fields: { entry: 1, health: 100, maxHealth: 100, level: 30 } },
  { update: "create", guid: "${VENDOR}", objectType: "unit", pos: { x: 2, y: 0, z: 0, o: 0 }, fields: { entry: 2, health: 100, maxHealth: 100, level: 30 } },
  { update: "create", guid: "${QUESTGIVER}", objectType: "unit", pos: { x: 3, y: 0, z: 0, o: 0 }, fields: { entry: 3, health: 100, maxHealth: 100, level: 30, targetGuid: "${ME}" } },
  { update: "create", guid: "${PET}", objectType: "unit", pos: { x: 4, y: 0, z: 0, o: 0 }, fields: { entry: 4, health: 100, maxHealth: 100, level: 5, summonedByGuid: "${ME}" } },
] });
"ready";
`;

describe("the sandbox child marks emotes as they arrive", () => {
  test("idle creatures' emotes stay on the raw stream; ours, a player's, the quest giver's and the pet's reach the window", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    const before = await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW);
    const fed = await host.evalSnippet(`
      feed("SMSG_EMOTE", 0x103, { guid: "${GUARD}", emoteId: 1 });
      feed("SMSG_EMOTE", 0x103, { guid: "${VENDOR}", emoteId: 5 });
      feed("SMSG_EMOTE", 0x103, { guid: "${QUESTGIVER}", emoteId: 2 });
      feed("SMSG_EMOTE", 0x103, { guid: "${PET}", emoteId: 3 });
      feed("SMSG_EMOTE", 0x103, { guid: "${PLAYER}", emoteId: 4 });
      feed("SMSG_EMOTE", 0x103, { guid: "${ME}", emoteId: 10 });
      feed("SMSG_TEXT_EMOTE", 0x105, { guid: "${PLAYER}", textEmote: 101, emoteNum: 0, targetName: "Fenwick" });
      "fed";
    `);
    expect(fed.ok).toBe(true);
    const { events, folded } = await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW);
    const shown = events.filter((e) => e.opcode === "SMSG_EMOTE").map((e) => (e.data as { guid: string }).guid);
    expect(shown).toEqual([QUESTGIVER, PET, PLAYER, ME]);
    expect(events.filter((e) => e.opcode === "SMSG_TEXT_EMOTE")).toHaveLength(1);
    expect(folded).toBe(before.folded);
    const raw = await host.recentEvents(50);
    const marked = raw.filter((e) => e.opcode === "SMSG_EMOTE" && e.bystander === true).map((e) => (e.data as { guid: string }).guid);
    expect(marked).toEqual([GUARD, VENDOR]);
  });
});
