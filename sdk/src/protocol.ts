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
export const PROTOCOL_REVISION = "phase0-stage2";

// ---------------------------------------------------------------- primitives

/**
 * ObjectGuids are u64. The module currently serialises them as JSON *numbers*
 * (WbJson.h `Add(k, uint64_t)`), so any guid above 2^53 would already have lost
 * precision before this schema sees it. Player guids in the slice are small, so
 * this is safe today; strings are accepted too so that the fix on the module
 * side needs no SDK change. See sdk/README.md "protocol ambiguities".
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
 * POST /action body. The slice supports exactly one action; the union widens as
 * PROTOCOL.md grows, and `action` stays the discriminant.
 */
export type ActionRequest = { token: string; action: "say"; text: string };

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
} as const;

export type KnownOpcode = keyof typeof eventDataSchemas;

export const KNOWN_OPCODES = Object.keys(eventDataSchemas) as KnownOpcode[];

export function isKnownOpcode(opcode: string): opcode is KnownOpcode {
  return Object.hasOwn(eventDataSchemas, opcode);
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
