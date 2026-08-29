/**
 * Group loot rolls (item 102) and item text (item 103): the state folds and
 * the two helpers, against the stub module. Kept in its own file so the
 * shared client/state suites stay untouched.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import {
  BACKPACK_SLOT,
  CREATURE_GUID,
  creatureCreate,
  creatureQuery,
  frames,
  inventorySlot,
  ITEM_ENTRY,
  ITEM_GUID,
  itemCreate,
  itemQuery,
  loginSequence,
  SELF_GUID,
  selfCreate,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const ROLL_GUID = "4611686018427387905";
const OTHER_ROLL_GUID = "4611686018427387906";
const OTHER_PLAYER = "9";
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const startRoll = (seq: number, rollGuid = ROLL_GUID, itemId = 17922, mask = 0x03) =>
  frame(seq, "SMSG_LOOT_START_ROLL", {
    rollGuid,
    slot: 2,
    itemId,
    count: 1,
    countdownMs: 60_000,
    voteMask: mask,
    canNeed: (mask & 1) !== 0,
    canGreed: (mask & 2) !== 0,
    canDisenchant: (mask & 4) !== 0,
  });
const lionfur = (seq: number) => frame(seq, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: 17922, found: true, name: "Lionfur Armor", quality: 2 });
const guidHex = (g: string) => BigInt(g).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
const u32Hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0").match(/../g)!.reverse().join("");

function toEvents(list: readonly unknown[]): GameEvent[] {
  return list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function untilAction(stub: StubServer, action: string, from = 0): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const at = stub.actions.findIndex((a, idx) => idx >= from && a.action === action);
    if (at >= 0) return at;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}; saw ${stub.actions.map((a) => a.action).join(",")}`);
}

const SEED = { guid: SELF_GUID, name: "Fenwick" };

describe("state: group loot rolls (item 102)", () => {
  test("a start-roll opens a frame named from the item query, with the buttons the mask allows and a deadline", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, startRoll(10), lionfur(11)]), { seed: SEED });
    const rolls = cache.pendingRolls(TS + 11);
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ rollGuid: ROLL_GUID, itemId: 17922, name: "Lionfur Armor", quality: 2, slot: 2, count: 1, deadline: TS + 10 + 60_000 });
    expect(rolls[0]?.allowed).toEqual(["need", "greed", "pass"]);
    // Need withheld (the per-player form), disenchant offered.
    const noNeed = StateCache.replay(toEvents([...loginSequence, startRoll(10, ROLL_GUID, 17922, 0x06)]), { seed: SEED });
    expect(noNeed.pendingRolls(TS + 11)[0]?.allowed).toEqual(["greed", "disenchant", "pass"]);
  });

  test("the frame closes on our own counted vote, on the verdict, or at its deadline — never on another voter's roll", () => {
    const base = [...loginSequence, startRoll(10), lionfur(11)];
    const theirs = StateCache.replay(
      toEvents([...base, frame(12, "SMSG_LOOT_ROLL", { rollGuid: ROLL_GUID, slot: 2, playerGuid: OTHER_PLAYER, itemId: 17922, roll: 77, rollType: 2, autoPass: false })]),
      { seed: SEED },
    );
    expect(theirs.pendingRolls(TS + 13)).toHaveLength(1);
    const mine = StateCache.replay(
      toEvents([...base, frame(12, "SMSG_LOOT_ROLL", { rollGuid: ROLL_GUID, slot: 2, playerGuid: SELF_GUID, itemId: 17922, roll: 41, rollType: 1, autoPass: false })]),
      { seed: SEED },
    );
    expect(mine.pendingRolls(TS + 13)).toHaveLength(0);
    const won = StateCache.replay(
      toEvents([...base, frame(12, "SMSG_LOOT_ROLL_WON", { rollGuid: ROLL_GUID, slot: 2, itemId: 17922, winnerGuid: OTHER_PLAYER, roll: 77, rollType: 2 })]),
      { seed: SEED },
    );
    expect(won.pendingRolls(TS + 13)).toHaveLength(0);
    const passed = StateCache.replay(toEvents([...base, frame(12, "SMSG_LOOT_ALL_PASSED", { rollGuid: ROLL_GUID, slot: 2, itemId: 17922 })]), { seed: SEED });
    expect(passed.pendingRolls(TS + 13)).toHaveLength(0);
    const late = StateCache.replay(toEvents(base), { seed: SEED });
    expect(late.pendingRolls(TS + 10 + 60_001)).toHaveLength(0);
  });
});

describe("state: item text (item 103)", () => {
  const withPages = [
    ...loginSequence,
    selfCreate,
    inventorySlot,
    itemCreate,
    frame(38, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: ITEM_ENTRY, found: true, name: "Marshal McBride's Documents", quality: 1, pageText: 209 }),
  ];

  test("a book's pages are walked from the template's pageText through the cached chain, in order", () => {
    const partial = StateCache.replay(toEvents([...withPages, frame(40, "SMSG_PAGE_TEXT_QUERY_RESPONSE", { pageId: 209, text: "REPORT: Kobolds", nextPageId: 210 })]), { seed: SEED });
    expect(partial.items.get(ITEM_ENTRY)?.value.pageText).toBe(209);
    expect(partial.itemTexts()).toEqual([{ guid: ITEM_GUID, itemId: ITEM_ENTRY, name: "Marshal McBride's Documents", pages: ["REPORT: Kobolds"], complete: false }]);
    const full = StateCache.replay(
      toEvents([
        ...withPages,
        // Pages may land in any order; the walk follows nextPageId, not arrival.
        frame(40, "SMSG_PAGE_TEXT_QUERY_RESPONSE", { pageId: 210, text: "page two", nextPageId: 0 }),
        frame(41, "SMSG_PAGE_TEXT_QUERY_RESPONSE", { pageId: 209, text: "REPORT: Kobolds", nextPageId: 210 }),
      ]),
      { seed: SEED },
    );
    expect(full.itemTexts()[0]).toMatchObject({ pages: ["REPORT: Kobolds", "page two"], complete: true });
  });

  test("an unread item is absent; player-written text on a letter is one page", () => {
    const unread = StateCache.replay(toEvents([...loginSequence, selfCreate, inventorySlot, itemCreate, itemQuery]), { seed: SEED });
    expect(unread.itemTexts()).toEqual([]);
    const letter = StateCache.replay(
      toEvents([...loginSequence, selfCreate, inventorySlot, itemCreate, itemQuery, frame(40, "SMSG_ITEM_TEXT_QUERY_RESPONSE", { found: true, guid: ITEM_GUID, text: "meet me at the inn" })]),
      { seed: SEED },
    );
    expect(letter.itemTexts()).toEqual([{ guid: ITEM_GUID, itemId: ITEM_ENTRY, name: "Gritstone Charm", pages: ["meet me at the inn"], complete: true }]);
  });
});

describe("client: lootRoll", () => {
  const world = () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery]);

  test("builds the CMSG_LOOT_ROLL body for a roll named by item, and settles on the server's echo of the vote", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(startRoll(500)));
    stub.push(JSON.stringify(lionfur(501)));
    await client.events.waitFor((e) => e.seq === 501, { timeout: 2000 });
    expect(client.state.pendingRolls()).toHaveLength(1);
    const rolled = client.lootRoll("lionfur", "greed");
    const at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ action: "raw", opcode: "CMSG_LOOT_ROLL", payload: guidHex(ROLL_GUID) + u32Hex(2) + "02" });
    // Another voter's roll is not our echo.
    stub.push(JSON.stringify(frame(502, "SMSG_LOOT_ROLL", { rollGuid: ROLL_GUID, slot: 2, playerGuid: OTHER_PLAYER, itemId: 17922, roll: 77, rollType: 2, autoPass: false })));
    stub.push(JSON.stringify(frame(503, "SMSG_LOOT_ROLL", { rollGuid: ROLL_GUID, slot: 2, playerGuid: SELF_GUID, itemId: 17922, roll: 41, rollType: 2, autoPass: false })));
    expect(await rolled).toMatchObject({ ok: true, status: "rolled", rollGuid: ROLL_GUID, choice: "greed", roll: 41, item: { itemId: 17922, name: "Lionfur Armor" }, resolved: { input: "lionfur", name: "Lionfur Armor" } });
    expect(client.state.pendingRolls()).toHaveLength(0);
    client.close();
    await stub.stop();
  });

  test("a pass reads as roll undefined; refusals are values with hints and send nothing", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    expect(await client.lootRoll("anything", "need")).toMatchObject({ ok: false, status: "no_pending_roll" });
    expect(client.drainActionHints()[0]).toMatchObject({ action: "lootRoll", status: "no_pending_roll" });
    stub.push(JSON.stringify(startRoll(500, ROLL_GUID, 17922, 0x02)));
    stub.push(JSON.stringify(startRoll(501, OTHER_ROLL_GUID, 17922, 0x02)));
    stub.push(JSON.stringify(lionfur(502)));
    await client.events.waitFor((e) => e.seq === 502, { timeout: 2000 });
    expect(await client.lootRoll("Lionfur Armor", "greed")).toMatchObject({ ok: false, status: "ambiguous_roll" });
    expect(await client.lootRoll(17922, "greed")).toMatchObject({ ok: false, status: "ambiguous_roll" });
    expect(await client.lootRoll(ROLL_GUID, "need")).toMatchObject({ ok: false, status: "roll_not_allowed" });
    expect(await client.lootRoll("Thunderfury", "pass")).toMatchObject({ ok: false, status: "no_pending_roll" });
    expect(stub.actions.some((a) => a.action === "raw")).toBe(false);
    expect(client.drainActionHints().map((h) => h.status).sort()).toEqual(["ambiguous_roll", "no_pending_roll", "roll_not_allowed"]);
    const passed = client.lootRoll(OTHER_ROLL_GUID, "pass");
    const at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_LOOT_ROLL", payload: guidHex(OTHER_ROLL_GUID) + u32Hex(2) + "00" });
    stub.push(JSON.stringify(frame(503, "SMSG_LOOT_ROLL", { rollGuid: OTHER_ROLL_GUID, slot: 2, playerGuid: SELF_GUID, itemId: 17922, roll: 128, rollType: 0, autoPass: false })));
    expect(await passed).toMatchObject({ ok: true, status: "rolled", choice: "pass", roll: undefined });
    client.close();
    await stub.stop();
  });
});

describe("client: readItem", () => {
  const book = frame(38, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: ITEM_ENTRY, found: true, name: "Marshal McBride's Documents", quality: 1, pageText: 209 });
  const carrying = (query: unknown) => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, inventorySlot, itemCreate, query]);

  test("a page item goes READ_ITEM -> READ_ITEM_OK -> PAGE_TEXT_QUERY and returns the chain in order", async () => {
    const stub = startStub({ onConnect: () => carrying(book) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 38, { timeout: 2000 });
    const read = client.readItem("mcbride");
    let at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_READ_ITEM", payload: "ff" + BACKPACK_SLOT.toString(16) });
    stub.push(JSON.stringify(frame(500, "SMSG_READ_ITEM_OK", { guid: ITEM_GUID })));
    at = await untilAction(stub, "raw", at + 1);
    expect(stub.actions[at]).toMatchObject({ opcode: "CMSG_PAGE_TEXT_QUERY", payload: u32Hex(209) + guidHex(ITEM_GUID) });
    stub.push(JSON.stringify(frame(501, "SMSG_PAGE_TEXT_QUERY_RESPONSE", { pageId: 209, text: "REPORT: Kobolds", nextPageId: 210 })));
    stub.push(JSON.stringify(frame(502, "SMSG_PAGE_TEXT_QUERY_RESPONSE", { pageId: 210, text: "This progresses well.", nextPageId: 0 })));
    const result = await read;
    expect(result).toMatchObject({
      ok: true,
      status: "read",
      item: { bag: 255, slot: BACKPACK_SLOT, guid: ITEM_GUID, itemId: ITEM_ENTRY, name: "Marshal McBride's Documents" },
      pages: ["REPORT: Kobolds", "This progresses well."],
      text: "REPORT: Kobolds\n\nThis progresses well.",
      resolved: { input: "mcbride", name: "Marshal McBride's Documents" },
    });
    expect(client.state.itemTexts()[0]?.complete).toBe(true);
    client.close();
    await stub.stop();
  });

  test("a refused read is not_readable with the inventory reason; an item without pages is asked for written text", async () => {
    const stub = startStub({ onConnect: () => carrying(book) });
    const client = await inWorld(stub);
    await client.events.waitFor((e) => e.seq === 38, { timeout: 2000 });
    const read = client.readItem(255, BACKPACK_SLOT);
    await untilAction(stub, "raw");
    stub.push(JSON.stringify(frame(500, "SMSG_INVENTORY_CHANGE_FAILURE", { result: 12, itemGuid: ITEM_GUID })));
    stub.push(JSON.stringify(frame(501, "SMSG_READ_ITEM_FAILED", { guid: ITEM_GUID })));
    const refused = await read;
    expect(refused).toMatchObject({ ok: false, status: "not_readable" });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.hint).toContain("cannot be read");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "readItem", status: "not_readable" });
    client.close();
    await stub.stop();

    const stub2 = startStub({ onConnect: () => carrying(itemQuery) });
    const client2 = await inWorld(stub2);
    await client2.events.waitFor((e) => e.seq === 38, { timeout: 2000 });
    const plain = client2.readItem("Gritstone Charm");
    const at = await untilAction(stub2, "raw");
    expect(stub2.actions[at]).toMatchObject({ opcode: "CMSG_ITEM_TEXT_QUERY", payload: guidHex(ITEM_GUID) });
    stub2.push(JSON.stringify(frame(500, "SMSG_ITEM_TEXT_QUERY_RESPONSE", { found: true, guid: ITEM_GUID, text: "" })));
    expect(await plain).toMatchObject({ ok: false, status: "not_readable" });
    const letter = client2.readItem("Gritstone Charm");
    await untilAction(stub2, "raw", at + 1);
    stub2.push(JSON.stringify(frame(501, "SMSG_ITEM_TEXT_QUERY_RESPONSE", { found: true, guid: ITEM_GUID, text: "meet me at the inn" })));
    expect(await letter).toMatchObject({ ok: true, status: "read", pages: ["meet me at the inn"], text: "meet me at the inn" });
    expect(await client2.readItem("Thunderfury")).toMatchObject({ ok: false, status: "no_item" });
    expect(client2.drainActionHints().map((h) => h.status).sort()).toEqual(["no_item", "not_readable"]);
    client2.close();
    await stub2.stop();
  });
});
