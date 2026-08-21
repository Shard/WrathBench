/**
 * Wire protocol of mod-wrathbench, transcribed from module/PROTOCOL.md.
 *
 * This is the one external boundary in the SDK, so it is the one place Zod is
 * used (CLAUDE.md). Everything downstream of `parseEventFrame` / the response
 * parsers deals in plain TypeScript types.
 *
 * Two rules keep this file additive-friendly, because PROTOCOL.md is expected
 * to grow (update-object events, more actions):
 *   - every `data` shape is a *loose* object: unknown fields pass through
 *     instead of being stripped, so a module that starts sending more does not
 *     silently lose it on the way to the state cache;
 *   - an unknown opcode is not an error. It becomes an `UnknownEvent` with its
 *     `data` unvalidated, so an SDK built against today's whitelist keeps
 *     streaming when the whitelist widens.
 */

import { z } from "zod";

/**
 * The protocol revision this file was written against. Bump deliberately: the
 * SDK surface is part of the harness surface (see sdk/README.md).
 */
export const PROTOCOL_REVISION = "phase0-stage2+movement";

// ---------------------------------------------------------------- primitives

/**
 * ObjectGuids are u64, and the module serialises every one of them as a decimal
 * *string* (PROTOCOL.md, "u64 values are decimal strings"): creature guids carry
 * a high part (0xF130…) far above `Number.MAX_SAFE_INTEGER`, so a bare JSON
 * number would already be corrupted by `JSON.parse` before this schema ran.
 *
 * Numbers are still accepted, because the Stage-2 slice's small player guids
 * were emitted that way and a fixture may still use them — but a string is the
 * only form that round-trips, which is what the 2^63 test pins down.
 */
export const guidSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx): bigint => {
    try {
      return typeof v === "number" ? BigInt(Math.trunc(v)) : BigInt(v);
    } catch {
      ctx.addIssue({ code: "custom", message: `not a guid: ${String(v)}` });
      return z.NEVER;
    }
  });

/** A guid rendered as a decimal string; the key type for guid-keyed maps. */
export type GuidKey = string;

export function guidKey(guid: bigint): GuidKey {
  return guid.toString(10);
}

/**
 * A move's correlation id. A per-session counter that cannot approach 2^53, so
 * unlike a guid it is a plain number on the wire; a string is tolerated.
 */
export const moveIdSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: `not a moveId: ${String(v)}` });
      return z.NEVER;
    }
    return n;
  });

/**
 * A position as the movement packets carry it: no map id, because no movement
 * or update block on the wire has one. Own map comes from
 * `SMSG_LOGIN_VERIFY_WORLD` and nowhere else.
 */
export const positionSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  o: z.number(),
});
export type PositionData = z.infer<typeof positionSchema>;

// ------------------------------------------------------------ HTTP responses

/** `{ ok: false, error: "<code>", ... }` from any endpoint. */
export const errorBodySchema = z.looseObject({
  ok: z.literal(false),
  // Deliberately a bare string, not an enum: a new module error code must not
  // break parsing. Known codes are typed as a union in client.ts.
  error: z.string(),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** GET /health */
export const healthResponseSchema = z.looseObject({
  ok: z.literal(true),
  module: z.string(),
  worldStopped: z.boolean(),
  sessions: z.number(),
  droppedPackets: z.number(),
  droppedPacketsLive: z.number(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** POST /session */
export const sessionResponseSchema = z.looseObject({
  ok: z.literal(true),
  token: z.string(),
  account: z.string(),
  character: z.string(),
  guid: guidSchema,
  inWorld: z.boolean(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** POST /action */
export const actionResponseSchema = z.looseObject({
  ok: z.literal(true),
  action: z.string(),
  token: z.string(),
});
export type ActionResponse = z.infer<typeof actionResponseSchema>;

/**
 * POST /action with `action: "move_to"`. The ack means "queued and pathing";
 * `moveId` ties the request to its terminal `WB_MOVE_RESULT` event.
 *
 * `moveId` is a counter, not a guid, so it stays a JSON number (PROTOCOL.md's
 * u64 note exempts it explicitly, and the module writes it with the numeric
 * `Add`). A numeric string is accepted anyway, so the SDK survives the module
 * ever tightening it to the guid convention.
 */
export const moveToResponseSchema = z.looseObject({
  ok: z.literal(true),
  action: z.string(),
  token: z.string(),
  moveId: moveIdSchema,
});
export type MoveToResponse = z.infer<typeof moveToResponseSchema>;

/** POST /action with `action: "face"`. Echoes the resolved absolute orientation. */
export const faceResponseSchema = z.looseObject({
  ok: z.literal(true),
  action: z.string(),
  token: z.string(),
  orientation: z.number(),
});
export type FaceResponse = z.infer<typeof faceResponseSchema>;

/** DELETE /session */
export const deleteSessionResponseSchema = z.looseObject({
  ok: z.literal(true),
  token: z.string(),
});
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;

// ------------------------------------------------------------ HTTP requests

/** POST /session body. */
export interface CreateSessionRequest {
  token: string;
  character: string;
  account?: string;
  race?: number;
  class?: number;
  gender?: number;
}

/**
 * POST /action body. The union widens as PROTOCOL.md grows, and `action` stays
 * the discriminant.
 *
 * `face` takes *either* an absolute `orientation` in radians or a point to turn
 * toward — never both — which is why it is two members rather than one with
 * three optional fields.
 */
export type ActionRequest =
  | { token: string; action: "say"; text: string }
  | { token: string; action: "move_to"; x: number; y: number; z: number }
  | { token: string; action: "stop" }
  | { token: string; action: "face"; orientation: number }
  | { token: string; action: "face"; x: number; y: number };

/** DELETE /session body. */
export interface DeleteSessionRequest {
  token: string;
}

// ------------------------------------------------------------- event frames

/**
 * Emitted in place of the decoded fields when the module could not decode a
 * whitelisted packet. The event is still delivered so the drop is visible.
 */
export const decodeErrorSchema = z.looseObject({ decodeError: z.literal(true) });
export type DecodeErrorData = z.infer<typeof decodeErrorSchema>;

export const authResponseDataSchema = z.looseObject({ code: z.number() });
export type AuthResponseData = z.infer<typeof authResponseDataSchema>;

export const charEnumEntrySchema = z.looseObject({
  guid: guidSchema,
  name: z.string(),
  race: z.number(),
  class: z.number(),
  gender: z.number(),
  level: z.number(),
});
export type CharEnumEntry = z.infer<typeof charEnumEntrySchema>;

export const charEnumDataSchema = z.looseObject({
  count: z.number(),
  characters: z.array(charEnumEntrySchema),
});
export type CharEnumData = z.infer<typeof charEnumDataSchema>;

export const charCreateDataSchema = z.looseObject({ result: z.number() });
export type CharCreateData = z.infer<typeof charCreateDataSchema>;

export const characterLoginFailedDataSchema = z.looseObject({ reason: z.number() });
export type CharacterLoginFailedData = z.infer<typeof characterLoginFailedDataSchema>;

export const loginVerifyWorldDataSchema = z.looseObject({
  map: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  o: z.number(),
});
export type LoginVerifyWorldData = z.infer<typeof loginVerifyWorldDataSchema>;

export const motdDataSchema = z.looseObject({
  lineCount: z.number(),
  lines: z.array(z.string()),
});
export type MotdData = z.infer<typeof motdDataSchema>;

export const notificationDataSchema = z.looseObject({ text: z.string() });
export type NotificationData = z.infer<typeof notificationDataSchema>;

export const nameQueryResponseDataSchema = z.looseObject({
  guid: guidSchema,
  found: z.boolean(),
  name: z.string().optional(),
});
export type NameQueryResponseData = z.infer<typeof nameQueryResponseDataSchema>;

export const messageChatDataSchema = z.looseObject({
  type: z.number(),
  language: z.number(),
  senderGuid: guidSchema,
  message: z.string(),
  chatTag: z.number(),
});
export type MessageChatData = z.infer<typeof messageChatDataSchema>;

// ------------------------------------------- movement / observation extension

/**
 * The whitelisted update fields, decoded by name (PROTOCOL.md
 * "`SMSG_UPDATE_OBJECT.objects[]` shapes"). Every one is optional: a `values`
 * delta carries only what changed, and a block for an object the module never
 * saw a `create` for carries no named fields at all.
 *
 * The object is *loose*, so a field the module starts serving before this file
 * knows about it survives to the state cache as an unvalidated extra rather
 * than being stripped.
 */
export const updateFieldsSchema = z.looseObject({
  // all objects
  entry: z.number().optional(),
  scale: z.number().optional(),
  // units and players
  health: z.number().optional(),
  maxHealth: z.number().optional(),
  power1: z.number().optional(),
  power2: z.number().optional(),
  power3: z.number().optional(),
  power4: z.number().optional(),
  power5: z.number().optional(),
  power6: z.number().optional(),
  power7: z.number().optional(),
  maxPower1: z.number().optional(),
  maxPower2: z.number().optional(),
  maxPower3: z.number().optional(),
  maxPower4: z.number().optional(),
  maxPower5: z.number().optional(),
  maxPower6: z.number().optional(),
  maxPower7: z.number().optional(),
  level: z.number().optional(),
  faction: z.number().optional(),
  unitFlags: z.number().optional(),
  displayId: z.number().optional(),
  dynamicFlags: z.number().optional(),
  npcFlags: z.number().optional(),
  targetGuid: guidSchema.optional(),
  race: z.number().optional(),
  class: z.number().optional(),
  gender: z.number().optional(),
  powerType: z.number().optional(),
  // players
  playerFlags: z.number().optional(),
  // game objects
  goDisplayId: z.number().optional(),
  goFlags: z.number().optional(),
  goFaction: z.number().optional(),
  goLevel: z.number().optional(),
  goState: z.number().optional(),
  goType: z.number().optional(),
});
export type UpdateFields = z.infer<typeof updateFieldsSchema>;

/**
 * A full object on first sight. `pos` is present only when the packet carried a
 * position block (LIVING / POSITION / STATIONARY_POSITION); `moveFlags` and
 * `runSpeed` only for living objects; `self` only on our own block.
 */
export const createBlockSchema = z.looseObject({
  update: z.literal("create"),
  guid: guidSchema,
  objectType: z.string(),
  self: z.boolean().optional(),
  moveFlags: z.number().optional(),
  runSpeed: z.number().optional(),
  pos: positionSchema.optional(),
  targetGuid: guidSchema.optional(),
  fields: updateFieldsSchema.optional(),
});

/** Sparse field delta for an object already in view. */
export const valuesBlockSchema = z.looseObject({
  update: z.literal("values"),
  guid: guidSchema,
  fields: updateFieldsSchema.optional(),
});

/** Movement-only block: same movement payload a create block carries. */
export const movementBlockSchema = z.looseObject({
  update: z.literal("movement"),
  guid: guidSchema,
  moveFlags: z.number().optional(),
  runSpeed: z.number().optional(),
  pos: positionSchema.optional(),
  targetGuid: guidSchema.optional(),
});

/**
 * `outOfRange` — the objects left update range. `near` shares the shape and is
 * the *opposite* claim (NEAR_OBJECTS); see the note in state.ts on why only one
 * of the two prunes.
 */
export const guidListBlockSchema = z.looseObject({
  update: z.enum(["outOfRange", "near"]),
  guids: z.array(guidSchema),
});

/** A block kind added after this SDK revision. Kept, not dropped. */
export const unknownBlockSchema = z.looseObject({ update: z.string() });

export const updateBlockSchema = z.union([
  createBlockSchema,
  valuesBlockSchema,
  movementBlockSchema,
  guidListBlockSchema,
  unknownBlockSchema,
]);
export type UpdateBlock = z.infer<typeof updateBlockSchema>;
export type CreateBlock = z.infer<typeof createBlockSchema>;
export type ValuesBlock = z.infer<typeof valuesBlockSchema>;
export type MovementBlock = z.infer<typeof movementBlockSchema>;
export type GuidListBlock = z.infer<typeof guidListBlockSchema>;

export const updateObjectDataSchema = z.looseObject({
  blocks: z.number(),
  objects: z.array(updateBlockSchema),
});
export type UpdateObjectData = z.infer<typeof updateObjectDataSchema>;

export const destroyObjectDataSchema = z.looseObject({
  guid: guidSchema,
  onDeath: z.boolean(),
});
export type DestroyObjectData = z.infer<typeof destroyObjectDataSchema>;

/** `found: false` carries the entry and nothing else. */
export const creatureQueryResponseDataSchema = z.looseObject({
  entry: z.number(),
  found: z.boolean(),
  name: z.string().optional(),
  subname: z.string().optional(),
  type: z.number().optional(),
  rank: z.number().optional(),
});
export type CreatureQueryResponseData = z.infer<typeof creatureQueryResponseDataSchema>;

/** Movement of another nearby unit or player, relayed by the server. */
export const moveUpdateDataSchema = z.looseObject({
  guid: guidSchema,
  flags: z.number(),
  pos: positionSchema,
});
export type MoveUpdateData = z.infer<typeof moveUpdateDataSchema>;

/**
 * The observed `MSG_MOVE_*` opcode names, exactly the closed set the module's
 * `MoveOpcodeName` can produce — including the bare `MSG_MOVE` it falls back to
 * for a whitelisted opcode it has no name for. All share one `data` shape.
 */
export const MOVE_OPCODES = [
  "MSG_MOVE_START_FORWARD",
  "MSG_MOVE_START_BACKWARD",
  "MSG_MOVE_STOP",
  "MSG_MOVE_START_STRAFE_LEFT",
  "MSG_MOVE_START_STRAFE_RIGHT",
  "MSG_MOVE_STOP_STRAFE",
  "MSG_MOVE_JUMP",
  "MSG_MOVE_START_TURN_LEFT",
  "MSG_MOVE_START_TURN_RIGHT",
  "MSG_MOVE_STOP_TURN",
  "MSG_MOVE_SET_FACING",
  "MSG_MOVE_HEARTBEAT",
  "MSG_MOVE_FALL_LAND",
  "MSG_MOVE_START_SWIM",
  "MSG_MOVE_STOP_SWIM",
  "MSG_MOVE_SET_RUN_MODE",
  "MSG_MOVE_SET_WALK_MODE",
  "MSG_MOVE",
] as const;
export type MoveOpcode = (typeof MOVE_OPCODES)[number];

/** Terminal statuses of a `move_to`, from PROTOCOL.md. */
export const MOVE_STATUSES = [
  "arrived",
  "no_path",
  "too_far",
  "interrupted",
  "stopped",
  "superseded",
] as const;
export type KnownMoveStatus = (typeof MOVE_STATUSES)[number];
/** Widened, so a status this revision does not know still parses. */
export type MoveStatus = KnownMoveStatus | (string & {});

/** Module-synthesized: the movement engine's interpolated own position. */
export const moveProgressDataSchema = z.looseObject({
  moveId: moveIdSchema,
  pos: positionSchema,
});
export type MoveProgressData = z.infer<typeof moveProgressDataSchema>;

/**
 * Module-synthesized terminal event of a `move_to`. `pos` is read back from the
 * live character, so an `arrived` is proof the server accepted the movement.
 */
export const moveResultDataSchema = z.looseObject({
  moveId: moveIdSchema,
  // Deliberately a bare string: a new status must widen the type, not break
  // parsing (same reasoning as `errorBodySchema.error`).
  status: z.string(),
  pos: positionSchema,
});
export type MoveResultData = z.infer<typeof moveResultDataSchema>;

const moveOpcodeSchemas = Object.fromEntries(
  MOVE_OPCODES.map((op) => [op, moveUpdateDataSchema]),
) as { [K in MoveOpcode]: typeof moveUpdateDataSchema };

/**
 * Opcode name -> decoded `data` schema. Add a row when PROTOCOL.md adds one;
 * nothing else in the SDK needs to change for the event to reach the stream.
 */
export const eventDataSchemas = {
  SMSG_AUTH_RESPONSE: authResponseDataSchema,
  SMSG_CHAR_ENUM: charEnumDataSchema,
  SMSG_CHAR_CREATE: charCreateDataSchema,
  SMSG_CHARACTER_LOGIN_FAILED: characterLoginFailedDataSchema,
  SMSG_LOGIN_VERIFY_WORLD: loginVerifyWorldDataSchema,
  SMSG_MOTD: motdDataSchema,
  SMSG_NOTIFICATION: notificationDataSchema,
  SMSG_NAME_QUERY_RESPONSE: nameQueryResponseDataSchema,
  SMSG_MESSAGECHAT: messageChatDataSchema,
  // movement / observation extension
  SMSG_UPDATE_OBJECT: updateObjectDataSchema,
  SMSG_DESTROY_OBJECT: destroyObjectDataSchema,
  SMSG_CREATURE_QUERY_RESPONSE: creatureQueryResponseDataSchema,
  WB_MOVE_PROGRESS: moveProgressDataSchema,
  WB_MOVE_RESULT: moveResultDataSchema,
  ...moveOpcodeSchemas,
} as const;

export type KnownOpcode = keyof typeof eventDataSchemas;

export const KNOWN_OPCODES = Object.keys(eventDataSchemas) as KnownOpcode[];

export function isKnownOpcode(opcode: string): opcode is KnownOpcode {
  return Object.hasOwn(eventDataSchemas, opcode);
}

const MOVE_OPCODE_SET = new Set<string>(MOVE_OPCODES);

/** True for any observed `MSG_MOVE_*` opcode: they all share one `data` shape. */
export function isMoveOpcode(opcode: string): opcode is MoveOpcode {
  return MOVE_OPCODE_SET.has(opcode);
}

/** The envelope every frame carries, before `data` is interpreted. */
export const eventEnvelopeSchema = z.looseObject({
  seq: z.number(),
  opcode: z.string(),
  opcodeId: z.number(),
  ts: z.number(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

interface EventBase {
  readonly seq: number;
  readonly opcodeId: number;
  /** Unix epoch milliseconds, as the module stamped it. */
  readonly ts: number;
}

/** A whitelisted opcode whose `data` this SDK knows how to type. */
export type KnownEvent = {
  [K in KnownOpcode]: EventBase & {
    readonly opcode: K;
    readonly data: z.infer<(typeof eventDataSchemas)[K]> | DecodeErrorData;
  };
}[KnownOpcode];

/**
 * A well-formed frame carrying an opcode this SDK revision does not know, or a
 * known opcode whose `data` failed validation. Never dropped: the model can
 * still see that something happened.
 */
export interface UnknownEvent extends EventBase {
  readonly opcode: string;
  readonly data: unknown;
  /** Set when the opcode *is* whitelisted but `data` did not match its schema. */
  readonly schemaError?: string;
}

/** Any event that came off the wire. */
export type GameEvent = KnownEvent | UnknownEvent;

/**
 * Narrow an event to one opcode's decoded shape.
 *
 * Needed because `UnknownEvent.opcode` is `string`, so a plain
 * `event.opcode === "SMSG_MESSAGECHAT"` comparison cannot exclude it and
 * `data` stays `unknown`. Returns false for an event whose payload failed this
 * SDK revision's schema, so a caller that narrows is guaranteed real fields.
 */
export function isEvent<K extends KnownOpcode>(
  event: { readonly opcode: string; readonly data: unknown },
  opcode: K,
): event is Extract<KnownEvent, { opcode: K }> {
  if (event.opcode !== opcode) return false;
  const schemaError = (event as { schemaError?: string }).schemaError;
  return schemaError === undefined;
}

/** True when `data` is the module's decode-failure marker. */
export function isDecodeError(data: unknown): data is DecodeErrorData {
  return typeof data === "object" && data !== null && (data as { decodeError?: unknown }).decodeError === true;
}

export type ParseEventResult =
  | { ok: true; event: GameEvent }
  | { ok: false; error: string };

/**
 * Turn one WebSocket text frame into a typed event.
 *
 * Only a malformed *envelope* is a failure. A bad `data` payload downgrades the
 * event to `UnknownEvent` with `schemaError` set, because losing the fact that
 * the packet arrived is worse than losing its fields.
 */
export function parseEventFrame(text: string): ParseEventResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `frame is not JSON: ${String(e)}` };
  }
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, error: `frame envelope invalid: ${envelope.error.message}` };
  }
  const { seq, opcode, opcodeId, ts, data } = envelope.data;

  if (isDecodeError(data)) {
    return {
      ok: true,
      event: { seq, opcode, opcodeId, ts, data: { decodeError: true } } as GameEvent,
    };
  }
  if (!isKnownOpcode(opcode)) {
    return { ok: true, event: { seq, opcode, opcodeId, ts, data } };
  }
  const decoded = eventDataSchemas[opcode].safeParse(data);
  if (!decoded.success) {
    return {
      ok: true,
      event: { seq, opcode, opcodeId, ts, data, schemaError: decoded.error.message },
    };
  }
  return {
    ok: true,
    event: { seq, opcode, opcodeId, ts, data: decoded.data } as GameEvent,
  };
}
