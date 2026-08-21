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

/** An opcode added to the whitelist after this SDK revision was written. */
export const futureUpdateObject = {
  seq: 10,
  opcode: "SMSG_UPDATE_OBJECT",
  opcodeId: 0x0a9,
  ts: 1_700_000_000_100,
  data: { blockCount: 1, blocks: [{ guid: 4242, kind: "create" }] },
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
  futureUpdateObject,
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
