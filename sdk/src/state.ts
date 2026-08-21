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
 * is legible — which matters most for position: our own is written by the login
 * verify, then by our create block, then by every `WB_MOVE_PROGRESS` while we
 * walk, and a reader can always see which.
 *
 * ### The update-object fold
 *
 * `SMSG_UPDATE_OBJECT` is already delta-shaped on the wire (full object on
 * first sight, sparse field deltas after), and the fold preserves that rather
 * than flattening it: `create` populates a `NearbyObject`, `values` merges
 * field by field with each field keeping the seq/ts of the block that carried
 * it, `outOfRange` and `SMSG_DESTROY_OBJECT` prune. Everything writes through
 * one seam, `upsertNearby`.
 *
 * The typed groups (`health`, `power`, `level`) are *derived* from the raw
 * `fields` record and only when the derivation is complete — see
 * `deriveGauges`. Name resolution is a join, not an observation: query answers
 * land in `names`/`creatures` and are attached to whatever is in view.
 */

import {
  guidKey,
  isDecodeError,
  isMoveOpcode,
  type CreateBlock,
  type GuidKey,
  type MoveUpdateData,
  type PositionData,
  type UpdateBlock,
  type UpdateFields,
} from "./protocol";
import { STREAM_GAP, type StreamEvent } from "./events";

/** A value together with the event that carried it. */
export interface Observed<T> {
  readonly value: T;
  readonly seq: number;
  readonly ts: number;
}

/**
 * A position as movement packets and update blocks carry it. No map id: no
 * whitelisted packet gives one for another object, so this type cannot pretend
 * to have one.
 */
export interface UnitPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly o: number;
}

/**
 * Own position. `map` only ever comes from `SMSG_LOGIN_VERIFY_WORLD`; the x/y/z/o
 * of later self updates are paired with the last map that packet reported,
 * which is what a client does. If no map has been observed yet, a self position
 * update is refused and recorded as an anomaly rather than defaulted.
 */
export interface WorldPosition extends UnitPosition {
  readonly map: number;
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
/**
 * Everything an update block's `fields` can write to. `self` and a nearby
 * object share it, so one merge path serves both.
 *
 * `fields` is the raw per-field record: every named numeric field the module
 * decoded, each with the seq/ts of the block that carried it. The typed groups
 * above it are *derived* from those fields, and only when the derivation is
 * complete — see `deriveGauges`.
 */
export interface UnitFieldsState {
  level: Observed<number> | undefined;
  health: Observed<Gauge> | undefined;
  power: Observed<Gauge> | undefined;
  fields: Map<string, Observed<number>>;
}

export interface SelfState extends UnitFieldsState {
  guid: bigint | undefined;
  name: string | undefined;
  position: Observed<WorldPosition> | undefined;
}

/** What a creature query answered about one creature entry. */
export interface CreatureInfo {
  readonly entry: number;
  readonly name: string;
  readonly subname: string | undefined;
  readonly type: number | undefined;
  readonly rank: number | undefined;
}

/**
 * A world object the update stream has put in view: created by a `create`
 * block, refreshed by `values`/`movement` blocks and `MSG_MOVE_*`, removed by
 * an `outOfRange` list or `SMSG_DESTROY_OBJECT`.
 */
export interface NearbyObject extends UnitFieldsState {
  readonly guid: bigint;
  /** `unit`, `player`, `gameObject`, … Only a `create` block carries it. */
  objectType: Observed<string> | undefined;
  /** Creature/gameobject template id, from `OBJECT_FIELD_ENTRY`. */
  entry: Observed<number> | undefined;
  /** Joined from a name query (players) or a creature query (units). Never guessed. */
  name: Observed<string> | undefined;
  position: Observed<UnitPosition> | undefined;
  targetGuid: Observed<bigint> | undefined;
  /** Seq of the event that first put this object in view. */
  firstSeq: number;
  /** Seq of the most recent event that touched this object. */
  lastSeq: number;
}

/**
 * Something the stream said that the cache could not reconcile. Recorded rather
 * than resolved: silently picking a winner would make the cache disagree with
 * the trajectory log.
 */
export interface Anomaly {
  readonly seq: number;
  readonly ts: number;
  readonly kind: "self_guid_mismatch" | "self_position_without_map" | (string & {});
  readonly detail: string;
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
  readonly creatures: ReadonlyMap<number, Observed<CreatureInfo>>;
  readonly nearby: ReadonlyMap<GuidKey, NearbyObject>;
  readonly chat: readonly ChatEntry[];
  readonly notifications: readonly NotificationEntry[];
  readonly motd: Observed<string[]> | undefined;
  readonly gaps: readonly GapRecord[];
  readonly anomalies: readonly Anomaly[];
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
    fields: new Map<string, Observed<number>>(),
  };

  /** Characters on the account, from the most recent `SMSG_CHAR_ENUM`. */
  characters: Observed<CharacterSummary[]> | undefined;

  /** guid -> name, learned only from `SMSG_NAME_QUERY_RESPONSE`. Not a proximity claim. */
  readonly names = new Map<GuidKey, Observed<string>>();

  /**
   * entry -> creature template info, from `SMSG_CREATURE_QUERY_RESPONSE`.
   *
   * Never pruned when an object leaves view: the module's per-session
   * "already queried" sets mean it will *not* re-issue `CMSG_CREATURE_QUERY`
   * when the same creature comes back, so dropping this would make a
   * re-approached creature permanently nameless. Same reasoning for `names`.
   */
  readonly creatures = new Map<number, Observed<CreatureInfo>>();

  /** guid -> object in view, from `SMSG_UPDATE_OBJECT` and `MSG_MOVE_*`. */
  readonly nearby = new Map<GuidKey, NearbyObject>();

  motd: Observed<string[]> | undefined;

  /** The one input that did not come from an event. */
  readonly seed: StateSeed;

  private readonly chatBuf: ChatEntry[] = [];
  private readonly notifyBuf: NotificationEntry[] = [];
  private readonly gapBuf: GapRecord[] = [];
  private readonly anomalyBuf: Anomaly[] = [];
  private readonly chatTail: number;
  private readonly notificationTail: number;

  lastSeq = -1;
  eventCount = 0;

  /**
   * Last map id `SMSG_LOGIN_VERIFY_WORLD` reported. The only source of a map id
   * on the whole whitelist, and what later self positions are paired with.
   */
  private selfMap: number | undefined;

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

  /** Contradictions the stream contained. Non-empty means something is off. */
  get anomalies(): readonly Anomaly[] {
    return this.anomalyBuf;
  }

  /** Name for a guid, if a name query ever returned one. Never guessed. */
  nameOf(guid: bigint): string | undefined {
    if (this.self.guid !== undefined && guid === this.self.guid) return this.self.name;
    return this.names.get(guidKey(guid))?.value;
  }

  snapshot(): StateSnapshot {
    return {
      // Field groups are always *replaced*, never mutated in place, so a
      // shallow copy is enough for them — but the `fields` map and the `nearby`
      // entries themselves are mutated in place, so both are copied.
      self: { ...this.self, fields: new Map(this.self.fields) },
      characters: this.characters,
      names: new Map(this.names),
      creatures: new Map(this.creatures),
      nearby: new Map([...this.nearby].map(([k, v]) => [k, { ...v, fields: new Map(v.fields) }])),
      chat: [...this.chatBuf],
      notifications: [...this.notifyBuf],
      motd: this.motd,
      gaps: [...this.gapBuf],
      anomalies: [...this.anomalyBuf],
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
        this.selfMap = d.map;
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
          const key = guidKey(d.guid);
          this.names.set(key, { value: d.name, seq: event.seq, ts: event.ts });
          const obj = this.nearby.get(key);
          if (obj) this.joinName(obj);
        }
        return;
      }
      case "SMSG_CREATURE_QUERY_RESPONSE": {
        const d = event.data as {
          entry: number;
          found: boolean;
          name?: string;
          subname?: string;
          type?: number;
          rank?: number;
        };
        if (!d.found || d.name === undefined) return;
        this.creatures.set(d.entry, {
          value: {
            entry: d.entry,
            name: d.name,
            // The module sends "" for a creature with no subname; an empty
            // string is not a subname, so it does not become one.
            subname: d.subname === undefined || d.subname === "" ? undefined : d.subname,
            type: d.type,
            rank: d.rank,
          },
          seq: event.seq,
          ts: event.ts,
        });
        for (const obj of this.nearby.values()) {
          if (obj.entry?.value === d.entry) this.joinName(obj);
        }
        return;
      }
      case "SMSG_UPDATE_OBJECT": {
        const d = event.data as { objects: UpdateBlock[] };
        for (const block of d.objects) this.applyUpdateBlock(block, event.seq, event.ts);
        return;
      }
      case "SMSG_DESTROY_OBJECT": {
        const d = event.data as { guid: bigint };
        this.nearby.delete(guidKey(d.guid));
        return;
      }
      case "WB_MOVE_PROGRESS":
      case "WB_MOVE_RESULT": {
        // Our own position while moving: the module's movement engine knows it
        // locally, exactly as a running client does. `WB_MOVE_RESULT.pos` is
        // read back from the live character, so it is the server's word.
        const d = event.data as { pos: PositionData };
        this.applySelfPosition(d.pos, event.seq, event.ts);
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
        // Movement of another nearby unit, relayed with the opcode its own
        // client sent. All the MSG_MOVE_* names share one payload.
        if (isMoveOpcode(event.opcode)) {
          const d = event.data as MoveUpdateData;
          if (this.self.guid !== undefined && d.guid === this.self.guid) {
            // PROTOCOL.md says our own synthesized movement is never echoed, so
            // this should not happen — but if the server ever does relay it,
            // it is still our position and belongs on `self`.
            this.applySelfPosition(d.pos, event.seq, event.ts);
            return;
          }
          this.upsertNearby(d.guid, event.seq, (obj) => {
            obj.position = { value: toUnitPosition(d.pos), seq: event.seq, ts: event.ts };
            obj.fields.set("moveFlags", { value: d.flags, seq: event.seq, ts: event.ts });
            this.joinName(obj);
          });
          return;
        }
        // SMSG_AUTH_RESPONSE, SMSG_CHAR_CREATE, SMSG_CHARACTER_LOGIN_FAILED and
        // anything the module adds: visible on the stream, no cached state yet.
        return;
    }
  }

  // --------------------------------------------------------- world queries
  //
  // Pure reads over what the cache already holds. They never widen an
  // observation: an object with no observed `objectType` is not a unit, and an
  // object with no observed position has no distance.

  /** Objects in view that a `create` block typed as a unit or a player. */
  nearbyUnits(): NearbyObject[] {
    return [...this.nearby.values()].filter(
      (o) => o.objectType?.value === "unit" || o.objectType?.value === "player",
    );
  }

  /** Units in view whose observed template entry is `entry`. */
  creaturesByEntry(entry: number): NearbyObject[] {
    return this.nearbyUnits().filter((o) => o.entry?.value === entry);
  }

  /**
   * The nearest object in view that passes `filter`, by straight-line distance
   * from our own last observed position. `undefined` when we have no position,
   * or nothing in view has one — never a guess.
   *
   * Distances mix the freshness of two observations (ours and theirs); both
   * carry their own `seq`, so a caller that cares can check.
   */
  closest(filter?: (obj: NearbyObject) => boolean): NearbyObject | undefined {
    const from = this.self.position?.value;
    if (!from) return undefined;
    let best: NearbyObject | undefined;
    let bestD2 = Infinity;
    for (const obj of this.nearby.values()) {
      const p = obj.position?.value;
      if (!p) continue;
      if (filter && !filter(obj)) continue;
      const d2 = (p.x - from.x) ** 2 + (p.y - from.y) ** 2 + (p.z - from.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = obj;
      }
    }
    return best;
  }

  // ------------------------------------------------------ update-object fold

  private applyUpdateBlock(block: UpdateBlock, seq: number, ts: number): void {
    switch (block.update) {
      case "create":
        this.applyCreate(block as CreateBlock, seq, ts);
        return;
      case "values": {
        const b = block as { guid: bigint; fields?: UpdateFields };
        if (this.isSelfGuid(b.guid)) {
          this.mergeFields(this.self, b.fields, seq, ts);
          return;
        }
        // A `values` delta for an object we never saw created still means the
        // object is in view — the module's own guid->type cache just could not
        // name its fields. The entry records that, and claims nothing more.
        this.upsertNearby(b.guid, seq, (obj) => {
          this.mergeFields(obj, b.fields, seq, ts);
          this.joinName(obj);
        });
        return;
      }
      case "movement": {
        const b = block as { guid: bigint; pos?: PositionData; moveFlags?: number };
        if (this.isSelfGuid(b.guid)) {
          if (b.pos) this.applySelfPosition(b.pos, seq, ts);
          return;
        }
        this.upsertNearby(b.guid, seq, (obj) => {
          if (b.pos) obj.position = { value: toUnitPosition(b.pos), seq, ts };
          if (b.moveFlags !== undefined) obj.fields.set("moveFlags", { value: b.moveFlags, seq, ts });
        });
        return;
      }
      case "outOfRange": {
        const b = block as { guids: bigint[] };
        for (const g of b.guids) this.nearby.delete(guidKey(g));
        return;
      }
      case "near":
        // NEAR_OBJECTS is the *opposite* of out-of-range: the module keeps its
        // guid->type cache for these guids and only prunes on OUT_OF_RANGE.
        // The block carries no fields, so there is nothing to record either.
        return;
      default:
        // A block kind added after this SDK revision. The event is still on the
        // stream; the cache simply has no rule for it.
        return;
    }
  }

  private applyCreate(block: CreateBlock, seq: number, ts: number): void {
    const flaggedSelf = block.self === true;
    if (flaggedSelf && this.self.guid !== undefined && block.guid !== this.self.guid) {
      // The module says "this is you" about a guid the session response did not
      // give us. One of the two is wrong and the cache cannot tell which, so it
      // keeps the seeded identity (the only one tied to the character we asked
      // for) and files the block as an ordinary object in view.
      this.anomalyBuf.push({
        seq,
        ts,
        kind: "self_guid_mismatch",
        detail: `create block flagged self carries guid ${guidKey(block.guid)}, seeded self is ${guidKey(this.self.guid)}`,
      });
    } else if (flaggedSelf || this.isSelfGuid(block.guid)) {
      if (this.self.guid === undefined) this.self.guid = block.guid;
      if (block.pos) this.applySelfPosition(block.pos, seq, ts);
      if (block.moveFlags !== undefined) {
        this.self.fields.set("moveFlags", { value: block.moveFlags, seq, ts });
      }
      if (block.runSpeed !== undefined) {
        this.self.fields.set("runSpeed", { value: block.runSpeed, seq, ts });
      }
      this.mergeFields(this.self, block.fields, seq, ts);
      return;
    }

    this.upsertNearby(block.guid, seq, (obj) => {
      obj.objectType = { value: block.objectType, seq, ts };
      if (block.pos) obj.position = { value: toUnitPosition(block.pos), seq, ts };
      if (block.moveFlags !== undefined) obj.fields.set("moveFlags", { value: block.moveFlags, seq, ts });
      if (block.runSpeed !== undefined) obj.fields.set("runSpeed", { value: block.runSpeed, seq, ts });
      if (block.targetGuid !== undefined) obj.targetGuid = { value: block.targetGuid, seq, ts };
      this.mergeFields(obj, block.fields, seq, ts);
      this.joinName(obj);
    });
  }

  private isSelfGuid(guid: bigint): boolean {
    return this.self.guid !== undefined && guid === this.self.guid;
  }

  /**
   * Pair an observed x/y/z/o with the last observed map. Refused — and recorded
   * — when no map has ever been observed, because `WorldPosition.map` would
   * otherwise have to be invented.
   */
  private applySelfPosition(pos: PositionData, seq: number, ts: number): void {
    if (this.selfMap === undefined) {
      this.anomalyBuf.push({
        seq,
        ts,
        kind: "self_position_without_map",
        detail: "own position arrived before any SMSG_LOGIN_VERIFY_WORLD gave a map id",
      });
      return;
    }
    this.self.position = {
      value: { map: this.selfMap, x: pos.x, y: pos.y, z: pos.z, o: pos.o },
      seq,
      ts,
    };
  }

  /**
   * Merge one block's named fields, per field, with that block's provenance.
   * `targetGuid` is a guid rather than a number, so it gets its own group.
   */
  private mergeFields(
    target: UnitFieldsState & {
      targetGuid?: Observed<bigint> | undefined;
      entry?: Observed<number> | undefined;
    },
    fields: UpdateFields | undefined,
    seq: number,
    ts: number,
  ): void {
    if (!fields) return;
    for (const [key, raw] of Object.entries(fields)) {
      if (key === "targetGuid") {
        if (typeof raw === "bigint" && "targetGuid" in target) {
          target.targetGuid = { value: raw, seq, ts };
        }
        continue;
      }
      // Unknown extras a newer module serves come through the loose schema as
      // non-numbers; only decoded numeric fields belong in the field record.
      if (typeof raw !== "number") continue;
      target.fields.set(key, { value: raw, seq, ts });
    }
    const level = target.fields.get("level");
    if (level) target.level = level;
    const entry = target.fields.get("entry");
    if (entry && "entry" in target) target.entry = entry;
    this.deriveGauges(target);
  }

  /**
   * Derive `health`/`power` from the raw fields — and only when the derivation
   * is complete.
   *
   * A `values` delta routinely carries `health` without `maxHealth`, and which
   * of `power1..7` is *the* power depends on `powerType` (the client reads
   * `UNIT_FIELD_POWER1 + powerType`). Half a gauge is not a gauge, and a power
   * bar chosen without `powerType` is a guess, so both stay `undefined` until
   * every part has actually been observed. The parts are always in `fields`.
   */
  private deriveGauges(target: UnitFieldsState): void {
    const health = target.fields.get("health");
    const maxHealth = target.fields.get("maxHealth");
    if (health && maxHealth) {
      target.health = {
        value: { current: health.value, max: maxHealth.value },
        seq: Math.max(health.seq, maxHealth.seq),
        ts: Math.max(health.ts, maxHealth.ts),
      };
    }
    const powerType = target.fields.get("powerType");
    if (!powerType) return;
    const n = powerType.value + 1;
    const power = target.fields.get(`power${n}`);
    const maxPower = target.fields.get(`maxPower${n}`);
    if (power && maxPower) {
      target.power = {
        value: { current: power.value, max: maxPower.value },
        seq: Math.max(power.seq, maxPower.seq),
        ts: Math.max(power.ts, maxPower.ts),
      };
    }
  }

  /**
   * Attach a name to an object from the query answers already received:
   * creatures by template entry, players by guid. Nothing else names anything.
   */
  private joinName(obj: NearbyObject): void {
    const type = obj.objectType?.value;
    const entry = obj.entry?.value;
    if (type !== "player" && entry !== undefined) {
      const info = this.creatures.get(entry);
      if (info) {
        obj.name = { value: info.value.name, seq: info.seq, ts: info.ts };
        return;
      }
    }
    const byGuid = this.names.get(guidKey(obj.guid));
    if (byGuid) obj.name = byGuid;
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
   * Create-or-update an object in `nearby`. Every update-object and MSG_MOVE_*
   * write goes through this one seam.
   */
  protected upsertNearby(guid: bigint, seq: number, mutate: (obj: NearbyObject) => void): NearbyObject {
    const key = guidKey(guid);
    let obj = this.nearby.get(key);
    if (!obj) {
      obj = {
        guid,
        objectType: undefined,
        entry: undefined,
        name: undefined,
        level: undefined,
        position: undefined,
        health: undefined,
        power: undefined,
        targetGuid: undefined,
        fields: new Map<string, Observed<number>>(),
        firstSeq: seq,
        lastSeq: seq,
      };
      this.nearby.set(key, obj);
    }
    mutate(obj);
    obj.lastSeq = Math.max(obj.lastSeq, seq);
    return obj;
  }
}

/** Drop everything but x/y/z/o: the wire gives a nearby object nothing else. */
function toUnitPosition(pos: PositionData): UnitPosition {
  return { x: pos.x, y: pos.y, z: pos.z, o: pos.o };
}
