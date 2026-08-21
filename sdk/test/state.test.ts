import { describe, expect, test } from "bun:test";

import { parseEventFrame, type GameEvent } from "../src/protocol";
import { STREAM_GAP, type StreamEvent, type StreamGapEvent } from "../src/events";
import { StateCache } from "../src/state";
import { chatEcho, fullStream, loginSequence, notification } from "./fixtures";

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

describe("state cache: replay", () => {
  test("replay from seq 0 equals the incrementally fed cache", () => {
    const events = toEvents(fullStream);
    const incremental = new StateCache({ seed: SEED });
    for (const e of events) incremental.apply(e);
    const replayed = StateCache.replay(events, { seed: SEED });
    expect(replayed.snapshot()).toEqual(incremental.snapshot());
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
