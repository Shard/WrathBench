import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { STREAM_GAP, type StreamEvent, type StreamGapEvent } from "../src/events";
import { StateCache } from "../src/state";
import {
  chatEcho,
  CREATURE_ENTRY,
  CREATURE_GUID,
  creatureCreate,
  creatureDestroy,
  creatureMove,
  creatureOutOfRange,
  creatureQuery,
  creatureValues,
  fullStream,
  loginSequence,
  moveProgress,
  moveResult,
  notification,
  PLAYER_GUID,
  playerCreate,
  playerName,
  selfCreate,
  worldStream,
} from "./fixtures";

function toEvents(frames: readonly unknown[]): GameEvent[] {
  return frames.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

const SEED = { guid: 7n, name: "Fenwick" };

describe("state cache: what it learns from events", () => {
  test("char enum populates known characters and self level", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: SEED });
    expect(cache.characters?.value).toHaveLength(2);
    expect(cache.characters?.value.map((c) => c.name)).toEqual(["Fenwick", "Quilby"]);
    expect(cache.characters?.seq).toBe(1);
    expect(cache.self.level?.value).toBe(3);
    expect(cache.self.level?.seq).toBe(1);
  });

  test("login verify world is the only source of position, and says so", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: SEED });
    expect(cache.self.position?.value).toEqual({ map: 0, x: -1234.5, y: 987.25, z: 42.125, o: 3.5 });
    expect(cache.self.position?.seq).toBe(2);
    expect(cache.self.position?.ts).toBe(1_700_000_000_020);
  });

  test("motd, chat tail and notifications come off their own opcodes", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.motd?.value).toEqual(["fixture line one", "fixture line two"]);
    expect(cache.chat).toHaveLength(1);
    expect(cache.chat[0]?.message).toBe("ping from the fixture");
    expect(cache.chat[0]?.senderGuid).toBe(7n);
    expect(cache.notifications).toEqual([
      { seq: 7, ts: 1_700_000_000_070, text: "fixture notification" },
    ]);
  });

  test("names come only from name-query hits", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.nameOf(9n)).toBe("Ordrick");
    expect(cache.nameOf(10n)).toBeUndefined();
    expect(cache.names.size).toBe(1);
  });
});

describe("state cache: what it refuses to invent", () => {
  test("health and power stay undefined — no Stage-2 opcode carries them", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.self.health).toBeUndefined();
    expect(cache.self.power).toBeUndefined();
  });

  test("a chat sender does not become a nearby object", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.nearby.size).toBe(0);
  });

  test("without a seed, self identity stays unknown", () => {
    const cache = StateCache.replay(toEvents(loginSequence));
    expect(cache.self.guid).toBeUndefined();
    expect(cache.self.level).toBeUndefined();
    expect(cache.characters?.value).toHaveLength(2);
  });

  test("seeding by name alone still resolves self from the char enum", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: { name: "Quilby" } });
    expect(cache.self.guid).toBe(8n);
    expect(cache.self.level?.value).toBe(11);
  });

  test("a decode-error packet contributes no fields", () => {
    const undecodable = toEvents([
      { seq: 0, opcode: "SMSG_MESSAGECHAT", opcodeId: 0x096, ts: 1, data: { decodeError: true } },
    ]);
    const cache = StateCache.replay(undecodable, { seed: SEED });
    expect(cache.chat).toHaveLength(0);
    expect(cache.lastSeq).toBe(0);
    expect(cache.eventCount).toBe(1);
  });

  test("an unknown opcode advances lastSeq and nothing else", () => {
    const cache = StateCache.replay(toEvents(fullStream), { seed: SEED });
    expect(cache.lastSeq).toBe(10);
    expect(cache.eventCount).toBe(11);
  });
});

describe("state cache: the update-object fold", () => {
  test("a create block puts a typed, positioned object in view", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, creatureCreate]), { seed: SEED });
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj).toBeDefined();
    expect(obj?.objectType?.value).toBe("unit");
    expect(obj?.entry?.value).toBe(CREATURE_ENTRY);
    expect(obj?.level?.value).toBe(4);
    expect(obj?.position?.value).toEqual({ x: -1200, y: 980, z: 42, o: 1.5 });
    expect(obj?.health?.value).toEqual({ current: 120, max: 120 });
    expect(obj?.power?.value).toEqual({ current: 50, max: 100 });
    // A nearby object's map is on no packet, so its position does not claim one.
    expect((obj?.position?.value as { map?: number }).map).toBeUndefined();
  });

  test("a values delta merges per field, each keeping its own provenance", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, creatureCreate, creatureValues]),
      { seed: SEED },
    );
    const obj = cache.nearby.get(CREATURE_GUID);
    // health moved and says so; maxHealth is still the create block's word.
    expect(obj?.fields.get("health")).toEqual({ value: 60, seq: 13, ts: 1_700_000_000_130 });
    expect(obj?.fields.get("maxHealth")).toEqual({ value: 120, seq: 11, ts: 1_700_000_000_110 });
    expect(obj?.health?.value).toEqual({ current: 60, max: 120 });
    expect(obj?.health?.seq).toBe(13);
    // Untouched fields are neither refreshed nor dropped.
    expect(obj?.level?.value).toBe(4);
    expect(obj?.level?.seq).toBe(11);
    expect(obj?.lastSeq).toBe(13);
    expect(obj?.firstSeq).toBe(11);
  });

  test("a creature query names the object, by entry, whenever it arrives", () => {
    const before = StateCache.replay(
      toEvents([...loginSequence, creatureCreate, creatureQuery]),
      { seed: SEED },
    );
    expect(before.nearby.get(CREATURE_GUID)?.name?.value).toBe("Thistlebore");
    // Same answer if the query response lands before the create block.
    const after = StateCache.replay(
      toEvents([...loginSequence, creatureQuery, creatureCreate]),
      { seed: SEED },
    );
    expect(after.nearby.get(CREATURE_GUID)?.name?.value).toBe("Thistlebore");
    // An empty subname is not a subname.
    expect(before.creatures.get(CREATURE_ENTRY)?.value.subname).toBeUndefined();
  });

  test("a player is named by a name query, not a creature query", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, playerCreate, playerName]),
      { seed: SEED },
    );
    expect(cache.nearby.get(PLAYER_GUID)?.name?.value).toBe("Quilby");
  });

  test("MSG_MOVE_* moves a nearby object and nothing else", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, creatureCreate, creatureMove]),
      { seed: SEED },
    );
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj?.position?.value).toEqual({ x: -1210, y: 985, z: 42, o: 2 });
    expect(obj?.position?.seq).toBe(14);
    expect(obj?.health?.value).toEqual({ current: 120, max: 120 });
  });

  test("outOfRange and destroy prune the object, but never its name", () => {
    for (const removal of [creatureOutOfRange, creatureDestroy]) {
      const cache = StateCache.replay(
        toEvents([...loginSequence, creatureCreate, creatureQuery, removal]),
        { seed: SEED },
      );
      expect(cache.nearby.size).toBe(0);
      // The module will not re-query an entry it has already asked about, so
      // dropping this would make the creature permanently nameless on return.
      expect(cache.creatures.get(CREATURE_ENTRY)?.value.name).toBe("Thistlebore");
    }
  });

  test("a near-objects block is not a removal", () => {
    const near = {
      ...creatureOutOfRange,
      seq: 15,
      data: { blocks: 1, objects: [{ update: "near", guids: [CREATURE_GUID] }] },
    };
    const cache = StateCache.replay(toEvents([...loginSequence, creatureCreate, near]), {
      seed: SEED,
    });
    expect(cache.nearby.size).toBe(1);
  });

  test("half a gauge is not a gauge, and a power bar without powerType is a guess", () => {
    const partial = {
      ...creatureCreate,
      data: {
        blocks: 1,
        objects: [
          {
            update: "create",
            guid: CREATURE_GUID,
            objectType: "unit",
            fields: { entry: CREATURE_ENTRY, health: 40, power1: 10, maxPower1: 20 },
          },
        ],
      },
    };
    const cache = StateCache.replay(toEvents([...loginSequence, partial]), { seed: SEED });
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj?.health).toBeUndefined();
    expect(obj?.power).toBeUndefined();
    // …but what *was* observed is still there, raw.
    expect(obj?.fields.get("health")?.value).toBe(40);
    expect(obj?.fields.get("power1")?.value).toBe(10);
  });

  test("a values delta for an object never created records it without typing it", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, creatureValues]), { seed: SEED });
    const obj = cache.nearby.get(CREATURE_GUID);
    expect(obj?.objectType).toBeUndefined();
    expect(obj?.fields.get("health")?.value).toBe(60);
    expect(cache.nearbyUnits()).toHaveLength(0);
  });
});

describe("state cache: self, from the wire", () => {
  test("the self create block feeds self and stays out of nearby", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, selfCreate]), { seed: SEED });
    expect(cache.nearby.size).toBe(0);
    expect(cache.self.health?.value).toEqual({ current: 80, max: 100 });
    expect(cache.self.power?.value).toEqual({ current: 40, max: 90 });
    expect(cache.self.position?.value).toEqual({
      // map is carried from SMSG_LOGIN_VERIFY_WORLD; x/y/z/o are the block's.
      map: 0,
      x: -1234.5,
      y: 987.25,
      z: 42.125,
      o: 3.5,
    });
    expect(cache.self.position?.seq).toBe(17);
    expect(cache.anomalies).toHaveLength(0);
  });

  test("a self block whose guid contradicts the seed is an anomaly, not an overwrite", () => {
    const impostor = {
      ...selfCreate,
      data: {
        blocks: 1,
        objects: [{ ...(selfCreate.data.objects[0] as object), guid: "999", self: true }],
      },
    };
    const cache = StateCache.replay(toEvents([...loginSequence, impostor]), { seed: SEED });
    expect(cache.self.guid).toBe(7n);
    expect(cache.self.health).toBeUndefined();
    expect(cache.anomalies).toHaveLength(1);
    expect(cache.anomalies[0]?.kind).toBe("self_guid_mismatch");
    // The block is not discarded: something is in view at that guid.
    expect(cache.nearby.get("999")).toBeDefined();
  });

  test("with no seed, the self flag is what tells us who we are", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, selfCreate]));
    expect(cache.self.guid).toBe(7n);
    expect(cache.self.health?.value).toEqual({ current: 80, max: 100 });
  });

  test("own position tracks WB_MOVE_PROGRESS and the confirmed WB_MOVE_RESULT", () => {
    const cache = StateCache.replay(
      toEvents([...loginSequence, selfCreate, moveProgress, moveResult("arrived")]),
      { seed: SEED },
    );
    expect(cache.self.position?.value).toEqual({ map: 0, x: -1205, y: 981, z: 42, o: 1.2 });
    expect(cache.self.position?.seq).toBe(19);
  });

  test("own position with no map ever observed is refused, not defaulted", () => {
    const cache = StateCache.replay(toEvents([moveProgress]), { seed: SEED });
    expect(cache.self.position).toBeUndefined();
    expect(cache.anomalies[0]?.kind).toBe("self_position_without_map");
  });
});

describe("state cache: world queries", () => {
  const events = toEvents([
    ...loginSequence,
    selfCreate,
    creatureCreate,
    creatureQuery,
    playerCreate,
    playerName,
  ]);

  test("nearbyUnits are the objects a create block typed as unit or player", () => {
    const cache = StateCache.replay(events, { seed: SEED });
    expect(cache.nearbyUnits().map((o) => o.name?.value).sort()).toEqual(["Quilby", "Thistlebore"]);
  });

  test("creaturesByEntry selects on the observed template id", () => {
    const cache = StateCache.replay(events, { seed: SEED });
    expect(cache.creaturesByEntry(CREATURE_ENTRY).map((o) => o.guid)).toEqual([BigInt(CREATURE_GUID)]);
    expect(cache.creaturesByEntry(1)).toHaveLength(0);
  });

  test("closest measures from our own last observed position", () => {
    const cache = StateCache.replay(events, { seed: SEED });
    // self is at x=-1234.5: the creature at -1200 is ~35y away, the player at
    // -1240 is ~6y away.
    expect(cache.closest()?.name?.value).toBe("Quilby");
    expect(cache.closest((o) => o.objectType?.value === "unit")?.name?.value).toBe("Thistlebore");
  });

  test("closest claims nothing when we have no position of our own", () => {
    const cache = StateCache.replay(toEvents([creatureCreate]), {});
    expect(cache.closest()).toBeUndefined();
  });
});

describe("state cache: replay", () => {
  test("replay from seq 0 equals the incrementally fed cache", () => {
    const events = toEvents(fullStream);
    const incremental = new StateCache({ seed: SEED });
    for (const e of events) incremental.apply(e);
    const replayed = StateCache.replay(events, { seed: SEED });
    expect(replayed.snapshot()).toEqual(incremental.snapshot());
  });

  test("replay equals live for the observed world too, snapshots included", () => {
    const events = toEvents([...worldStream, creatureMove, playerCreate, playerName, moveProgress]);
    const incremental = new StateCache({ seed: SEED });
    for (const e of events) incremental.apply(e);
    const replayed = StateCache.replay(events, { seed: SEED });
    expect(replayed.snapshot()).toEqual(incremental.snapshot());
  });

  test("a snapshot does not share the field maps it copied", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, creatureCreate]), { seed: SEED });
    const snap = cache.snapshot();
    for (const e of toEvents([creatureValues])) cache.apply(e);
    expect(snap.nearby.get(CREATURE_GUID)?.fields.get("health")?.value).toBe(120);
    expect(cache.nearby.get(CREATURE_GUID)?.fields.get("health")?.value).toBe(60);
  });

  test("the seed is the only non-event input, and it is recorded", () => {
    const cache = StateCache.replay(toEvents(loginSequence), { seed: SEED });
    expect(cache.seed).toEqual({ guid: 7n, name: "Fenwick" });
  });

  test("seedSelf after the fact backfills self from an already-seen char enum", () => {
    const cache = StateCache.replay(toEvents(loginSequence));
    expect(cache.self.level).toBeUndefined();
    cache.seedSelf({ guid: 7n, name: "Fenwick" });
    expect(cache.self.level?.value).toBe(3);
  });

  test("the chat tail is bounded", () => {
    const cache = new StateCache({ chatTail: 3, seed: SEED });
    for (let i = 0; i < 10; i++) {
      const [event] = toEvents([{ ...chatEcho, seq: i, data: { ...chatEcho.data, message: `line ${i}` } }]);
      cache.apply(event as StreamEvent);
    }
    expect(cache.chat.map((c) => c.message)).toEqual(["line 7", "line 8", "line 9"]);
  });

  test("a stream gap is recorded so the cache admits it is incomplete", () => {
    const cache = new StateCache({ seed: SEED });
    for (const e of toEvents(loginSequence)) cache.apply(e);
    const gap: StreamGapEvent = {
      seq: 20,
      opcode: STREAM_GAP,
      opcodeId: -1,
      ts: 1_700_000_000_500,
      synthetic: true,
      data: { fromSeq: 4, toSeq: 19, missing: 16 },
    };
    cache.apply(gap);
    for (const e of toEvents([{ ...notification, seq: 20 }])) cache.apply(e);
    expect(cache.gaps).toEqual([
      { fromSeq: 4, toSeq: 19, missing: 16, ts: 1_700_000_000_500 },
    ]);
    expect(cache.lastSeq).toBe(20);
  });
});
