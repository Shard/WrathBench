/**
 * The state cache: a pure fold over the event stream.
 *
 * Two rules, both from docs/CONTRACTS.md, and both load-bearing:
 *
 *  1. **Nothing is invented.** A field exists on the cache only if an event
 *     carried it. Nothing that no whitelisted opcode carries gets a default —
 *     `health` is `undefined`, not `0`, and `nearby` is empty rather than
 *     guessed from chat senders. A model reading `undefined` knows it has not
 *     observed the thing; a model reading `0` believes something false.
 *  2. **Replayable.** `StateCache.replay(events, seed)` over the same events
 *     produces the same cache as feeding them live. That is what makes the
 *     trajectory log sufficient to reconstruct what the model could see.
 *
 * Every observed field group carries the `seq`/`ts` it came from, so staleness
 * is legible: in the Stage-2 slice `self.position` is written exactly once by
 * `SMSG_LOGIN_VERIFY_WORLD` and then never updated, and the reader can tell.
 *
 * ### Extension point for update-object events
 *
 * `nearby` is a guid-keyed map of `NearbyObject`, each of whose field groups is
 * an `Observed<T>`, and `apply()` is a switch on opcode. When the module starts
 * emitting object updates the change is: add the opcode's schema in
 * protocol.ts, add one `case` here that calls `upsertNearby()` / `applySelf()`,
 * and add fields to `NearbyObject` / `SelfState`. No existing shape moves, and
 * `self` is already the same `Observed<T>` shape a nearby object uses, so the
 * update-object handler can write to either through the same helpers.
 */

import { guidKey, isDecodeError, type GuidKey } from "./protocol";
import { STREAM_GAP, type StreamEvent } from "./events";

/** A value together with the event that carried it. */
export interface Observed<T> {
  readonly value: T;
  readonly seq: number;
  readonly ts: number;
}

export interface WorldPosition {
  readonly map: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly o: number;
}

/** Current/max pair, as a client would display it. */
export interface Gauge {
  readonly current: number;
  readonly max: number;
}

/** One row of `SMSG_CHAR_ENUM`. */
export interface CharacterSummary {
  readonly guid: bigint;
  readonly name: string;
  readonly race: number;
  readonly class: number;
  readonly gender: number;
  readonly level: number;
}

export interface ChatEntry {
  readonly seq: number;
  readonly ts: number;
  readonly type: number;
  readonly language: number;
  readonly senderGuid: bigint;
  readonly message: string;
  readonly chatTag: number;
}

export interface NotificationEntry {
  readonly seq: number;
  readonly ts: number;
  readonly text: string;
}

/**
 * Own character. Fields are `undefined` until an event supplies them.
 *
 * `guid` and `name` are *seeded* from the `POST /session` response rather than
 * derived from events, because no whitelisted opcode says "you are guid N".
 * They are recorded separately (`seed`) so a replay is explicit about the one
 * input that did not come off the wire.
 */
export interface SelfState {
  guid: bigint | undefined;
  name: string | undefined;
  level: Observed<number> | undefined;
  position: Observed<WorldPosition> | undefined;
  /** No Stage-2 opcode carries these. Reserved for update-object. */
  health: Observed<Gauge> | undefined;
  power: Observed<Gauge> | undefined;
}

/**
 * A world object the events have put in view. Nothing in the Stage-2 whitelist
 * does that, so this map is empty today; the shape exists so update-object
 * slots in without reshaping the cache.
 */
export interface NearbyObject {
  readonly guid: bigint;
  name: Observed<string> | undefined;
  level: Observed<number> | undefined;
  position: Observed<WorldPosition> | undefined;
  health: Observed<Gauge> | undefined;
  /** Seq of the most recent event that touched this object. */
  lastSeq: number;
}

/** A hole in the stream the cache knows it did not see. */
export interface GapRecord {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly missing: number;
  readonly ts: number;
}

export interface StateSeed {
  guid?: bigint;
  name?: string;
}

export interface StateCacheOptions {
  /** How many chat lines to retain. Default 200. */
  chatTail?: number;
  /** How many notifications to retain. Default 50. */
  notificationTail?: number;
  seed?: StateSeed;
}

/** Immutable view handed to callers by `snapshot()`. */
export interface StateSnapshot {
  readonly self: SelfState;
  readonly characters: Observed<CharacterSummary[]> | undefined;
  readonly names: ReadonlyMap<GuidKey, Observed<string>>;
  readonly nearby: ReadonlyMap<GuidKey, NearbyObject>;
  readonly chat: readonly ChatEntry[];
  readonly notifications: readonly NotificationEntry[];
  readonly motd: Observed<string[]> | undefined;
  readonly gaps: readonly GapRecord[];
  readonly lastSeq: number;
  readonly eventCount: number;
}

export class StateCache {
  readonly self: SelfState = {
    guid: undefined,
    name: undefined,
    level: undefined,
    position: undefined,
    health: undefined,
    power: undefined,
  };

  /** Characters on the account, from the most recent `SMSG_CHAR_ENUM`. */
  characters: Observed<CharacterSummary[]> | undefined;

  /** guid -> name, learned only from `SMSG_NAME_QUERY_RESPONSE`. Not a proximity claim. */
  readonly names = new Map<GuidKey, Observed<string>>();

  /** guid -> object in view. Empty until update-object events exist. */
  readonly nearby = new Map<GuidKey, NearbyObject>();

  motd: Observed<string[]> | undefined;

  /** The one input that did not come from an event. */
  readonly seed: StateSeed;

  private readonly chatBuf: ChatEntry[] = [];
  private readonly notifyBuf: NotificationEntry[] = [];
  private readonly gapBuf: GapRecord[] = [];
  private readonly chatTail: number;
  private readonly notificationTail: number;

  lastSeq = -1;
  eventCount = 0;

  constructor(options: StateCacheOptions = {}) {
    this.chatTail = options.chatTail ?? 200;
    this.notificationTail = options.notificationTail ?? 50;
    this.seed = { ...options.seed };
    if (this.seed.guid !== undefined) this.self.guid = this.seed.guid;
    if (this.seed.name !== undefined) this.self.name = this.seed.name;
  }

  /** Rebuild a cache by replaying events from seq 0. */
  static replay(events: Iterable<StreamEvent>, options: StateCacheOptions = {}): StateCache {
    const cache = new StateCache(options);
    for (const e of events) cache.apply(e);
    return cache;
  }

  /**
   * Record what the `POST /session` response told us about our own character.
   * Kept separate from `apply` so the event-derived and response-derived parts
   * of the cache never blur.
   */
  seedSelf(seed: StateSeed): void {
    if (seed.guid !== undefined) {
      this.seed.guid = seed.guid;
      this.self.guid = seed.guid;
    }
    if (seed.name !== undefined) {
      this.seed.name = seed.name;
      this.self.name = seed.name;
    }
    this.adoptOwnCharacter();
  }

  /** Chat lines, oldest first. */
  get chat(): readonly ChatEntry[] {
    return this.chatBuf;
  }

  /** Client-visible notifications (the game-error channel), oldest first. */
  get notifications(): readonly NotificationEntry[] {
    return this.notifyBuf;
  }

  /** Holes the cache knows about. Non-empty means the cache is incomplete. */
  get gaps(): readonly GapRecord[] {
    return this.gapBuf;
  }

  /** Name for a guid, if a name query ever returned one. Never guessed. */
  nameOf(guid: bigint): string | undefined {
    if (this.self.guid !== undefined && guid === this.self.guid) return this.self.name;
    return this.names.get(guidKey(guid))?.value;
  }

  snapshot(): StateSnapshot {
    return {
      // `self`'s field groups are always *replaced*, never mutated in place, so
      // a shallow copy is a real snapshot. `nearby` entries are mutated in
      // place by `upsertNearby`, so they have to be copied one level deeper.
      self: { ...this.self },
      characters: this.characters,
      names: new Map(this.names),
      nearby: new Map([...this.nearby].map(([k, v]) => [k, { ...v }])),
      chat: [...this.chatBuf],
      notifications: [...this.notifyBuf],
      motd: this.motd,
      gaps: [...this.gapBuf],
      lastSeq: this.lastSeq,
      eventCount: this.eventCount,
    };
  }

  /** Fold one event in. Unknown opcodes advance `lastSeq` and change nothing else. */
  apply(event: StreamEvent): void {
    this.eventCount++;
    if (event.opcode !== STREAM_GAP && event.seq > this.lastSeq) this.lastSeq = event.seq;

    if (event.opcode === STREAM_GAP) {
      const d = event.data as GapRecord;
      this.gapBuf.push({ fromSeq: d.fromSeq, toSeq: d.toSeq, missing: d.missing, ts: event.ts });
      return;
    }
    // A packet the module could not decode carries no fields; the *fact* of it
    // is already in the stream, and inventing values from it is exactly what
    // rule 1 forbids.
    if (isDecodeError(event.data)) return;
    // Likewise for a payload that did not match this SDK revision's schema: the
    // opcode is known but the fields are not the ones we can read (PROTOCOL.md
    // warns that non-SAY chat sub-types vary the header). Reading them anyway
    // would write undefined into the cache and call it an observation.
    if ("schemaError" in event && event.schemaError !== undefined) return;

    switch (event.opcode) {
      case "SMSG_CHAR_ENUM": {
        const d = event.data as { characters: CharacterSummary[] };
        this.characters = {
          value: d.characters.map((c) => ({
            guid: c.guid,
            name: c.name,
            race: c.race,
            class: c.class,
            gender: c.gender,
            level: c.level,
          })),
          seq: event.seq,
          ts: event.ts,
        };
        this.adoptOwnCharacter();
        return;
      }
      case "SMSG_LOGIN_VERIFY_WORLD": {
        const d = event.data as WorldPosition;
        this.self.position = {
          value: { map: d.map, x: d.x, y: d.y, z: d.z, o: d.o },
          seq: event.seq,
          ts: event.ts,
        };
        return;
      }
      case "SMSG_NAME_QUERY_RESPONSE": {
        const d = event.data as { guid: bigint; found: boolean; name?: string };
        if (d.found && d.name !== undefined) {
          this.names.set(guidKey(d.guid), { value: d.name, seq: event.seq, ts: event.ts });
        }
        return;
      }
      case "SMSG_MESSAGECHAT": {
        const d = event.data as Omit<ChatEntry, "seq" | "ts">;
        this.chatBuf.push({
          seq: event.seq,
          ts: event.ts,
          type: d.type,
          language: d.language,
          senderGuid: d.senderGuid,
          message: d.message,
          chatTag: d.chatTag,
        });
        if (this.chatBuf.length > this.chatTail) {
          this.chatBuf.splice(0, this.chatBuf.length - this.chatTail);
        }
        return;
      }
      case "SMSG_NOTIFICATION": {
        const d = event.data as { text: string };
        this.notifyBuf.push({ seq: event.seq, ts: event.ts, text: d.text });
        if (this.notifyBuf.length > this.notificationTail) {
          this.notifyBuf.splice(0, this.notifyBuf.length - this.notificationTail);
        }
        return;
      }
      case "SMSG_MOTD": {
        const d = event.data as { lines: string[] };
        this.motd = { value: [...d.lines], seq: event.seq, ts: event.ts };
        return;
      }
      default:
        // SMSG_AUTH_RESPONSE, SMSG_CHAR_CREATE, SMSG_CHARACTER_LOGIN_FAILED and
        // anything the module adds: visible on the stream, no cached state yet.
        return;
    }
  }

  /**
   * Copy the char-enum row for our own character onto `self`. Only runs when a
   * seed identified us; matching by name alone would be a guess.
   */
  private adoptOwnCharacter(): void {
    const enumerated = this.characters;
    if (!enumerated) return;
    const { guid, name } = this.self;
    const row = enumerated.value.find(
      (c) => (guid !== undefined && c.guid === guid) || (guid === undefined && name !== undefined && c.name === name),
    );
    if (!row) return;
    if (this.self.guid === undefined) this.self.guid = row.guid;
    if (this.self.name === undefined) this.self.name = row.name;
    this.self.level = { value: row.level, seq: enumerated.seq, ts: enumerated.ts };
  }

  /**
   * Create-or-update an object in `nearby`. Unused in Stage-2; this is the seam
   * the update-object handler writes through.
   */
  protected upsertNearby(guid: bigint, seq: number, mutate: (obj: NearbyObject) => void): NearbyObject {
    const key = guidKey(guid);
    let obj = this.nearby.get(key);
    if (!obj) {
      obj = { guid, name: undefined, level: undefined, position: undefined, health: undefined, lastSeq: seq };
      this.nearby.set(key, obj);
    }
    mutate(obj);
    obj.lastSeq = Math.max(obj.lastSeq, seq);
    return obj;
  }
}
