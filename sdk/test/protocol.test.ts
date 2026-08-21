import { describe, expect, test } from "bun:test";

import {
  actionResponseSchema,
  deleteSessionResponseSchema,
  errorBodySchema,
  guidKey,
  healthResponseSchema,
  isDecodeError,
  isEvent,
  isKnownOpcode,
  KNOWN_OPCODES,
  parseEventFrame,
  sessionResponseSchema,
} from "../src/protocol";
import {
  chatEcho,
  fullStream,
  futureUpdateObject,
  healthResponseFixture,
  loginSequence,
  malformedChat,
  sessionResponseFixture,
  undecodableChat,
} from "./fixtures";

describe("HTTP response schemas", () => {
  test("health round-trips every documented field", () => {
    const parsed = healthResponseSchema.parse(healthResponseFixture);
    expect(parsed).toEqual(healthResponseFixture);
  });

  test("session response decodes guid to bigint", () => {
    const parsed = sessionResponseSchema.parse(sessionResponseFixture);
    expect(parsed.guid).toBe(7n);
    expect(parsed.character).toBe("Fenwick");
    expect(parsed.inWorld).toBe(true);
  });

  test("session response accepts a guid sent as a string", () => {
    const parsed = sessionResponseSchema.parse({
      ...sessionResponseFixture,
      guid: "18446744073709551000",
    });
    expect(parsed.guid).toBe(18446744073709551000n);
  });

  test("action and delete acks round-trip", () => {
    expect(actionResponseSchema.parse({ ok: true, action: "say", token: "t" })).toEqual({
      ok: true,
      action: "say",
      token: "t",
    });
    expect(deleteSessionResponseSchema.parse({ ok: true, token: "t" })).toEqual({
      ok: true,
      token: "t",
    });
  });

  test("unknown fields on a response survive instead of being stripped", () => {
    const parsed = healthResponseSchema.parse({ ...healthResponseFixture, uptimeMs: 99 });
    expect((parsed as { uptimeMs?: number }).uptimeMs).toBe(99);
  });

  test("error bodies accept codes this SDK revision does not know", () => {
    const parsed = errorBodySchema.parse({ ok: false, error: "some_future_code", extra: 1 });
    expect(parsed.error).toBe("some_future_code");
  });

  test("a success shape does not parse as an error body", () => {
    expect(errorBodySchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe("event frames", () => {
  test("every whitelisted opcode in PROTOCOL.md has a schema", () => {
    expect(KNOWN_OPCODES).toEqual([
      "SMSG_AUTH_RESPONSE",
      "SMSG_CHAR_ENUM",
      "SMSG_CHAR_CREATE",
      "SMSG_CHARACTER_LOGIN_FAILED",
      "SMSG_LOGIN_VERIFY_WORLD",
      "SMSG_MOTD",
      "SMSG_NOTIFICATION",
      "SMSG_NAME_QUERY_RESPONSE",
      "SMSG_MESSAGECHAT",
    ]);
    expect(isKnownOpcode("SMSG_MESSAGECHAT")).toBe(true);
    expect(isKnownOpcode("SMSG_UPDATE_OBJECT")).toBe(false);
  });

  test("every fixture frame parses, envelope intact", () => {
    for (const frame of fullStream) {
      const result = parseEventFrame(JSON.stringify(frame));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const source = frame as { seq: number; opcode: string; opcodeId: number; ts: number };
      expect(result.event.seq).toBe(source.seq);
      expect(result.event.opcode).toBe(source.opcode);
      expect(result.event.opcodeId).toBe(source.opcodeId);
      expect(result.event.ts).toBe(source.ts);
    }
  });

  test("char enum decodes rows with bigint guids", () => {
    const result = parseEventFrame(JSON.stringify(loginSequence[1]));
    expect(result.ok).toBe(true);
    if (!result.ok || !isEvent(result.event, "SMSG_CHAR_ENUM")) throw new Error("wrong opcode");
    const data = result.event.data;
    if (isDecodeError(data)) throw new Error("unexpected decode error");
    expect(data.count).toBe(2);
    expect(data.characters[0]?.guid).toBe(7n);
    expect(data.characters[1]?.name).toBe("Quilby");
  });

  test("chat decodes senderGuid as bigint", () => {
    const result = parseEventFrame(JSON.stringify(chatEcho));
    if (!result.ok || !isEvent(result.event, "SMSG_MESSAGECHAT")) throw new Error("wrong opcode");
    const data = result.event.data;
    if (isDecodeError(data)) throw new Error("unexpected decode error");
    expect(data.senderGuid).toBe(7n);
    expect(guidKey(data.senderGuid)).toBe("7");
    expect(data.message).toBe("ping from the fixture");
  });

  test("a module decode failure is preserved, not dropped", () => {
    const result = parseEventFrame(JSON.stringify(undecodableChat));
    if (!result.ok) throw new Error("frame should still parse");
    expect(isDecodeError(result.event.data)).toBe(true);
  });

  test("a malformed data payload downgrades to schemaError but keeps the event", () => {
    const result = parseEventFrame(JSON.stringify(malformedChat));
    if (!result.ok) throw new Error("frame should still parse");
    expect(result.event.opcode).toBe("SMSG_MESSAGECHAT");
    expect((result.event as { schemaError?: string }).schemaError).toBeDefined();
  });

  test("an opcode added after this revision passes through with raw data", () => {
    const result = parseEventFrame(JSON.stringify(futureUpdateObject));
    if (!result.ok) throw new Error("unknown opcodes must not fail");
    expect(result.event.opcode).toBe("SMSG_UPDATE_OBJECT");
    expect((result.event.data as { blockCount: number }).blockCount).toBe(1);
  });

  test("a broken envelope is a parse failure, not a silent drop", () => {
    expect(parseEventFrame("not json").ok).toBe(false);
    expect(parseEventFrame(JSON.stringify({ opcode: "SMSG_MOTD" })).ok).toBe(false);
  });
});
