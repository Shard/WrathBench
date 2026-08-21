/**
 * Synthetic protocol fixtures.
 *
 * Every one of these is hand-written from the tables in module/PROTOCOL.md.
 * Nothing here is captured from a running game: no real character names, no
 * server MOTD text, no game strings (CLAUDE.md — nothing Blizzard-derived
 * enters git). The names are invented.
 */

/** Frames as they appear on the wire: JSON objects, one per WebSocket frame. */
export const loginSequence: unknown[] = [
  { seq: 0, opcode: "SMSG_AUTH_RESPONSE", opcodeId: 0x1ee, ts: 1_700_000_000_000, data: { code: 12 } },
  {
    seq: 1,
    opcode: "SMSG_CHAR_ENUM",
    opcodeId: 0x03b,
    ts: 1_700_000_000_010,
    data: {
      count: 2,
      characters: [
        { guid: 7, name: "Fenwick", race: 1, class: 1, gender: 0, level: 3 },
        { guid: 8, name: "Quilby", race: 4, class: 3, gender: 1, level: 11 },
      ],
    },
  },
  {
    seq: 2,
    opcode: "SMSG_LOGIN_VERIFY_WORLD",
    opcodeId: 0x236,
    ts: 1_700_000_000_020,
    data: { map: 0, x: -1234.5, y: 987.25, z: 42.125, o: 3.5 },
  },
  {
    seq: 3,
    opcode: "SMSG_MOTD",
    opcodeId: 0x33d,
    ts: 1_700_000_000_030,
    data: { lineCount: 2, lines: ["fixture line one", "fixture line two"] },
  },
];

export const chatEcho = {
  seq: 4,
  opcode: "SMSG_MESSAGECHAT",
  opcodeId: 0x096,
  ts: 1_700_000_000_040,
  data: { type: 1, language: 7, senderGuid: 7, message: "ping from the fixture", chatTag: 0 },
};

export const nameQuery = {
  seq: 5,
  opcode: "SMSG_NAME_QUERY_RESPONSE",
  opcodeId: 0x051,
  ts: 1_700_000_000_050,
  data: { guid: 9, found: true, name: "Ordrick" },
};

export const nameQueryMiss = {
  seq: 6,
  opcode: "SMSG_NAME_QUERY_RESPONSE",
  opcodeId: 0x051,
  ts: 1_700_000_000_060,
  data: { guid: 10, found: false },
};

export const notification = {
  seq: 7,
  opcode: "SMSG_NOTIFICATION",
  opcodeId: 0x1cb,
  ts: 1_700_000_000_070,
  data: { text: "fixture notification" },
};

/** A whitelisted packet the module could not decode. Still emitted. */
export const undecodableChat = {
  seq: 8,
  opcode: "SMSG_MESSAGECHAT",
  opcodeId: 0x096,
  ts: 1_700_000_000_080,
  data: { decodeError: true },
};

/** A whitelisted opcode whose `data` does not match this SDK's schema. */
export const malformedChat = {
  seq: 9,
  opcode: "SMSG_MESSAGECHAT",
  opcodeId: 0x096,
  ts: 1_700_000_000_090,
  data: { type: 1, language: 7 },
};

/**
 * An opcode added to the whitelist after this SDK revision was written. Not one
 * of the movement/observation opcodes any more — those are known now — so it is
 * an action-set opcode a later increment will bring.
 */
export const futureOpcode = {
  seq: 10,
  opcode: "SMSG_TRAINER_LIST",
  opcodeId: 0x1b1,
  ts: 1_700_000_000_100,
  data: { count: 1, spells: [{ spellId: 4242 }] },
};

/** The full ordered fixture stream, seq 0..10. */
export const fullStream: unknown[] = [
  ...loginSequence,
  chatEcho,
  nameQuery,
  nameQueryMiss,
  notification,
  undecodableChat,
  malformedChat,
  futureOpcode,
];

// ------------------------------------------ movement / observation extension
//
// Guids here are written the way the module writes them: decimal *strings*.
// `CREATURE_GUID` is a real-shaped 3.3.5a creature guid (high part 0xF130…),
// which is above 2^63 and therefore the exact value a JSON number would ruin.

export const CREATURE_GUID = "17365880163140632581";
export const PLAYER_GUID = "8";
export const SELF_GUID = "7";
/** Invented; nothing here is a real creature entry or a real creature name. */
export const CREATURE_ENTRY = 90210;

/** A create block for a nearby creature: type, position, and the unit fields. */
export const creatureCreate = {
  seq: 11,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_110,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: CREATURE_GUID,
        objectType: "unit",
        moveFlags: 0,
        runSpeed: 7.5,
        pos: { x: -1200.0, y: 980.0, z: 42.0, o: 1.5 },
        fields: {
          entry: CREATURE_ENTRY,
          health: 120,
          maxHealth: 120,
          level: 4,
          faction: 7,
          unitFlags: 0,
          displayId: 111,
          powerType: 0,
          power1: 50,
          maxPower1: 100,
          race: 0,
          class: 0,
          gender: 0,
        },
      },
    ],
  },
};

/** The answer to the creature query the module fired on first sight. */
export const creatureQuery = {
  seq: 12,
  opcode: "SMSG_CREATURE_QUERY_RESPONSE",
  opcodeId: 0x061,
  ts: 1_700_000_000_120,
  data: { entry: CREATURE_ENTRY, found: true, name: "Thistlebore", subname: "", type: 1, rank: 0 },
};

/** A sparse delta: it lost health, and nothing else changed. */
export const creatureValues = {
  seq: 13,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_130,
  data: {
    blocks: 1,
    objects: [{ update: "values", guid: CREATURE_GUID, fields: { health: 60 } }],
  },
};

/** Another unit moved; only nearby positions come from these. */
export const creatureMove = {
  seq: 14,
  opcode: "MSG_MOVE_HEARTBEAT",
  opcodeId: 0x0ee,
  ts: 1_700_000_000_140,
  data: { guid: CREATURE_GUID, flags: 1, pos: { x: -1210.0, y: 985.0, z: 42.0, o: 2.0 } },
};

/** Left update range. */
export const creatureOutOfRange = {
  seq: 15,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_150,
  data: { blocks: 1, objects: [{ update: "outOfRange", guids: [CREATURE_GUID] }] },
};

/** Destroyed (killed, despawned, or gone for any client-visible reason). */
export const creatureDestroy = {
  seq: 16,
  opcode: "SMSG_DESTROY_OBJECT",
  opcodeId: 0x0aa,
  ts: 1_700_000_000_160,
  data: { guid: CREATURE_GUID, onDeath: true },
};

/** Our own create block, the only one flagged `self`. */
export const selfCreate = {
  seq: 17,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_170,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: SELF_GUID,
        objectType: "player",
        self: true,
        moveFlags: 0,
        runSpeed: 7.0,
        pos: { x: -1234.5, y: 987.25, z: 42.125, o: 3.5 },
        fields: {
          entry: 0,
          health: 80,
          maxHealth: 100,
          level: 3,
          powerType: 0,
          power1: 40,
          maxPower1: 90,
          playerFlags: 0,
        },
      },
    ],
  },
};

export const moveProgress = {
  seq: 18,
  opcode: "WB_MOVE_PROGRESS",
  opcodeId: 0xff02,
  ts: 1_700_000_000_180,
  data: { moveId: 1, pos: { x: -1220.0, y: 985.0, z: 42.0, o: 1.0 } },
};

export function moveResult(status: string, moveId = 1, seq = 19): unknown {
  return {
    seq,
    opcode: "WB_MOVE_RESULT",
    opcodeId: 0xff01,
    ts: 1_700_000_000_190,
    data: { moveId, status, pos: { x: -1205.0, y: 981.0, z: 42.0, o: 1.2 } },
  };
}

/** A player create block, named by a name query rather than a creature query. */
export const playerCreate = {
  seq: 20,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_200,
  data: {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid: PLAYER_GUID,
        objectType: "player",
        pos: { x: -1240.0, y: 990.0, z: 42.0, o: 0.5 },
        fields: { health: 200, maxHealth: 200, level: 11 },
      },
    ],
  },
};

export const playerName = {
  seq: 21,
  opcode: "SMSG_NAME_QUERY_RESPONSE",
  opcodeId: 0x051,
  ts: 1_700_000_000_210,
  data: { guid: PLAYER_GUID, found: true, name: "Quilby" },
};

/** Login, then our own create block: the ordinary start of an observed world. */
export const worldStream: unknown[] = [
  ...loginSequence,
  selfCreate,
  creatureCreate,
  creatureQuery,
  creatureValues,
];

export const sessionResponseFixture = {
  ok: true as const,
  token: "test-token",
  account: "RUNNER",
  character: "Fenwick",
  guid: 7,
  inWorld: true,
};

export const healthResponseFixture = {
  ok: true as const,
  module: "mod-wrathbench",
  worldStopped: false,
  sessions: 1,
  droppedPackets: 4213,
  droppedPacketsLive: 37,
};

export function frames(objects: readonly unknown[]): string[] {
  return objects.map((o) => JSON.stringify(o));
}
