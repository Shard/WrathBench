/**
 * The seventh batch of harness feedback from the 2026-10-21 Deadmines party
 * runs (attempt a2): an open group roll said where the loot window and the
 * harness block can see it, the trade window folded the way a client's
 * reads, the cast refusals a client explains, the character's own cast in
 * progress, and `moveToAsync`'s refusals answered as values. Packet sequences
 * follow the runs' own audit records; names, guids and positions are
 * invented.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { CREATURE_GUID, creatureCreate, creatureQuery, frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));
const SEED = { guid: SELF_GUID, name: "Fenwick" };

const toEvents = (list: readonly unknown[]): GameEvent[] =>
  list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function folded(client: WrathClient, opcode: string, seq: number): Promise<void> {
  await client.events.waitFor((e) => e.opcode === opcode && e.seq === seq, { timeout: 2000 });
}

async function untilAction(stub: StubServer, action: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.filter((a) => a.action === action).length >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

// ------------------------------------------------------------- loot rolls

const ROLL_GUID = "4611686018427461302";
const CAPE = 5193;
const startRoll = (seq: number, mask = 0x03, countdownMs = 60_000) =>
  frame(seq, "SMSG_LOOT_START_ROLL", {
    rollGuid: ROLL_GUID,
    slot: 2,
    itemId: CAPE,
    count: 1,
    countdownMs,
    voteMask: mask,
    canNeed: (mask & 1) !== 0,
    canGreed: (mask & 2) !== 0,
    canDisenchant: (mask & 4) !== 0,
  });
const capeQuery = (seq: number) => frame(seq, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: CAPE, found: true, name: "Brigand's Cape", quality: 2 });

// a2 VanCleef, 03:43:48: the start-roll and the window in the same
// millisecond, the cape on slot 2 as slotType 1 (ROLL_ONGOING) beside two
// free-for-all slots.
describe("an open group roll is said where the window and the harness block show it", () => {
  test("lootCorpse names the roll, its seconds left and the lootRoll call; the harness block carries the frame opening", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, capeQuery(30)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", 30);
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    push(stub, startRoll(70));
    push(stub, frame(71, "SMSG_LOOT_RESPONSE", {
      guid: CREATURE_GUID,
      lootType: 1,
      gold: 160,
      items: [{ slot: 0, itemId: 2874, count: 1, slotType: 0 }, { slot: 2, itemId: CAPE, count: 1, slotType: 1 }],
    }, TS + 70));
    push(stub, frame(72, "SMSG_ITEM_PUSH_RESULT", { playerGuid: SELF_GUID, itemId: 2874, count: 1, totalCount: 1, bagSlot: 255, itemSlot: 23, looted: true, created: false }, TS + 70));
    push(stub, frame(73, "SMSG_LOOT_RELEASE_RESPONSE", { guid: CREATURE_GUID }, TS + 2070));
    const loot = await pending;
    const LINE =
      'a group loot roll is open on "Brigand\'s Cape" (need/greed/pass, 58s left): vote with await sdk.lootRoll("Brigand\'s Cape", "need"), ' +
      "the choice one of the buttons listed. state.pendingRolls() holds each frame and its deadline; a frame left unvoted at its deadline counts as a pass";
    expect(loot).toMatchObject({ ok: true, status: "looted", items: [{ itemId: 2874, count: 1 }], hint: LINE });
    const hints = client.drainActionHints();
    expect(hints.map((h) => `${h.action} ${h.status}`)).toEqual(["lootRoll open"]);
    expect(hints[0]?.hint).toBe(LINE.replace("58s left", "60s left"));
    client.close();
    await stub.stop();
  });

  test("a roll whose item is not yet named is voted on by its id; a window without a roll slot has no hint", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery]) });
    const client = await inWorld(stub);
    push(stub, startRoll(40, 0x02));
    await folded(client, "SMSG_LOOT_START_ROLL", 40);
    expect(client.drainActionHints()[0]?.hint).toStartWith(
      'a group loot roll is open on "item 5193" (greed/pass, 60s left): vote with await sdk.lootRoll(5193, "greed"),',
    );
    const pending = client.lootCorpse(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "loot_all");
    push(stub, frame(71, "SMSG_LOOT_RESPONSE", { guid: CREATURE_GUID, lootType: 1, gold: 5, items: [] }));
    push(stub, frame(72, "SMSG_LOOT_RELEASE_RESPONSE", { guid: CREATURE_GUID }));
    const loot = await pending;
    expect(loot.status).toBe("looted");
    expect("hint" in loot).toBe(false);
    client.close();
    await stub.stop();
  });

  // The core writes ObjectGuid::Empty as the source of every counted vote
  // and of the verdict (Group::CountRollVote / CountTheRoll), as the a2 audit
  // shows: the start-roll carried 4611686018427461302, both votes and the
  // win "0". Slot and item name the roll.
  test("the vote echo and the verdict with rollGuid 0 still close the frame they name by slot and item", () => {
    const base = [...loginSequence, startRoll(10), capeQuery(11)];
    const voted = StateCache.replay(
      toEvents([...base, frame(12, "SMSG_LOOT_ROLL", { rollGuid: "0", slot: 2, playerGuid: SELF_GUID, itemId: CAPE, roll: 128, rollType: 2, autoPass: false })]),
      { seed: SEED },
    );
    expect(voted.pendingRolls(TS + 13)).toEqual([]);
    const won = StateCache.replay(
      toEvents([...base, frame(12, "SMSG_LOOT_ROLL_WON", { rollGuid: "0", slot: 2, itemId: CAPE, winnerGuid: "978", roll: 36, rollType: 2 })]),
      { seed: SEED },
    );
    expect(won.pendingRolls(TS + 13)).toEqual([]);
  });
});

// ------------------------------------------------------------ moveToAsync

describe("moveToAsync answers the refusals moveTo answers, with nothing sent", () => {
  test("a name nothing in view answers to is unknown_target, resolved and tallied", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    const moved = await client.moveTo("Nobody Here");
    const queued = await client.moveToAsync("Nobody Here");
    expect(moved.status).toBe("unknown_target");
    expect(queued).toEqual({ ok: false, status: "unknown_target", hint: moved.hint as string });
    expect(stub.actions.filter((a) => a.action === "move_to")).toEqual([]);
    expect(client.drainActionHints().map((h) => `${h.action} ${h.status}`).sort()).toEqual(["moveTo unknown_target", "moveToAsync unknown_target"]);
    client.close();
    await stub.stop();
  });
});
