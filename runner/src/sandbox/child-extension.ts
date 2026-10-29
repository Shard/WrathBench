/**
 * The runner's extension of the sandbox child (`@wrathbench/mcp`'s
 * `SandboxChildExtension`): everything the benchmark watches from inside the
 * child, latched as events arrive and drained by the runner's host
 * (`host.ts`). The death and flight transitions, the party records, the trace
 * and nearby recorders, the spell combat-log marks, the snippet delta, the
 * turn's event window and the HUD's fields on the state snapshot. Record and
 * context only: a snippet reaches none of it.
 *
 * Installed by `entry.ts`, the child entry the runner's host spawns. Its
 * listeners run in the order they register here, after the client's own
 * state fold, so each reads a cache that already holds the event.
 */

import type { StreamEvent } from "@wrathbench/sdk";
import type { EventSummary, SandboxChildApi, SandboxChildExtension } from "@wrathbench/mcp/sandbox-child";
import { toJsonSafe } from "@wrathbench/mcp/jsonsafe";
import {
  CONTEXT_POLICY,
  emoteShown,
  foldUiOpenWindows,
  PLAYER_FLAGS_GHOST,
  SPELL_LOG_OPCODES,
  spellLogNote,
  spellLogShown,
} from "../context";
import { NearbyRecorder } from "./nearby-recorder";
import { PartyWatcher } from "./party-watch";
import type { ContextEvents, DeathSignal, FlightSignal } from "./signals";
import { SnippetDeltaRecorder } from "./snippet-delta";
import { TraceRecorder } from "./trace-recorder";

export function benchmarkChildExtension({ client, summarize, forwardClientCache }: SandboxChildApi): SandboxChildExtension {
  // ------------------------------------------------------------ death watcher

  /**
   * The death window, latched from the events that carry it.
   *
   * The host's state sample is the run's clock for milestones, and at 60s it is
   * far coarser than a death: die, `repop()`, walk to the Spirit Healer,
   * resurrect — the whole window closes in half a minute, and the state cache
   * keeps no residue afterwards (`SMSG_DEATH_RELEASE_LOC` with `map: -1` clears
   * the corpse, the graveyard and the reclaim delay). Three deaths in run
   * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2` were missed exactly that
   * way, one of them by a single second. So the transitions are read here, where
   * every event arrives, and the host drains what happened between its samples.
   *
   * The readings are the same ones the host's fallback window read uses, for the
   * same reasons: own `health` off the raw field record (the derived gauge is
   * withheld until `maxHealth` has been seen) and the ghost bit off `playerFlags`
   * exactly as the HUD reads it. Release and resurrect additionally have a
   * packet that says so outright — `SMSG_DEATH_RELEASE_LOC`, the graveyard on the
   * way in and the clear marker on the way out — and that is the primary trigger,
   * because `playerFlags` rides an update block that need not arrive with it.
   *
   * Registered after the client's own state fold (`onAny` runs in registration
   * order), so every reading below is of a cache that already holds this event.
   */
  const DEATH_SIGNAL_CAP = 64;
  const deathSignals: DeathSignal[] = [];
  /** Own health last read as zero. */
  let watchedDead = false;
  /** The spirit is released: the ghost flag, or the graveyard packet that made it one. */
  let watchedReleased = false;
  /**
   * The ghost bit was actually seen set. Separate from `watchedReleased` because
   * `playerFlags` need not ride the blocks that arrive during a death: a stale 0
   * all the way through is ordinary, so only a bit that was seen *on* can be read
   * as meaning anything when it goes off again.
   */
  let watchedGhost = false;
  /**
   * The ghost bit as the previous event left it, undefined until first seen. A
   * release read off the bit needs it to RISE: the bit is still set for an event
   * or two after the resurrect's clear marker, and reading "set" as "released"
   * there re-opened the window the resurrect had just closed — every death was
   * written as death, release, resurrect, release, resurrect.
   */
  let lastGhostRead: boolean | undefined;

  function pushDeathSignal(signal: DeathSignal): void {
    deathSignals.push(signal);
    if (deathSignals.length > DEATH_SIGNAL_CAP) deathSignals.splice(0, deathSignals.length - DEATH_SIGNAL_CAP);
  }

  /** Drain what the watcher latched since the last call. Host-only. */
  function drainDeathSignals(): DeathSignal[] {
    return deathSignals.splice(0, deathSignals.length);
  }

  function point(v: unknown): { map: number; x: number; y: number; z: number } | undefined {
    const p = v as { map?: unknown; x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (p === undefined || p === null) return undefined;
    if (typeof p.map !== "number" || typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") {
      return undefined;
    }
    return { map: p.map, x: p.x, y: p.y, z: p.z };
  }

  client.events.onAny((event) => {
    const self = client.state.self;
    const health = self.fields.get("health")?.value;
    const flags = self.fields.get("playerFlags")?.value;
    const ghost = typeof flags === "number" ? (flags & PLAYER_FLAGS_GHOST) !== 0 : undefined;
    const releaseLoc =
      event.opcode === "SMSG_DEATH_RELEASE_LOC" ? (event.data as { map?: unknown }) : undefined;
    // The window as it stood *before* this event: a resurrect is only ever read
    // against a window some earlier event opened, never against this one.
    const wasDead = watchedDead;
    const wasReleased = watchedReleased;
    const wasGhost = watchedGhost;
    const releasedTo = typeof releaseLoc?.map === "number" && releaseLoc.map >= 0;
    const cleared = typeof releaseLoc?.map === "number" && releaseLoc.map < 0;

    // The death: own health observed at zero, from a reading that was not.
    if (health === 0 && !watchedDead) {
      watchedDead = true;
      const corpse = self.corpse?.value as { source?: unknown; instanceMap?: unknown } | undefined;
      // A corpse inside a dungeon is reported at its entrance, which is not the death site.
      const at = typeof corpse?.instanceMap === "number" ? undefined : point(corpse);
      const source = corpse?.source === "corpse_query" ? "corpse_query" : corpse?.source === "death_spot" ? "death_spot" : undefined;
      const zone = (self.zone?.value as { id?: unknown } | undefined)?.id;
      const area = (self.area?.value as { id?: unknown } | undefined)?.id;
      pushDeathSignal({
        kind: "death",
        ts: event.ts,
        seq: event.seq,
        ...(at !== undefined && source !== undefined ? { position: { ...at, source } } : {}),
        ...(typeof zone === "number" ? { zone } : {}),
        ...(typeof area === "number" ? { area } : {}),
        ...(ghost === undefined ? {} : { released: ghost }),
      });
    }

    // The release: the graveyard packet, or the ghost flag turning on — an
    // edge, not a level (`lastGhostRead`).
    const ghostRose = ghost === true && lastGhostRead !== true;
    if (ghost !== undefined) lastGhostRead = ghost;
    if (!watchedReleased && (releasedTo || ghostRose)) {
      watchedReleased = true;
      const grave = point(self.graveyard?.value);
      pushDeathSignal({
        kind: "release",
        ts: event.ts,
        seq: event.seq,
        ...(grave === undefined ? {} : { graveyard: grave }),
      });
    }
    // The bit counts as "seen on" only inside a window this watcher opened: the
    // stale bit after a resurrect latched outside one would make the next
    // death's first `ghost === false` read as a resurrect.
    if (ghost === true && (watchedDead || watchedReleased)) watchedGhost = true;

    // The resurrect: the clear marker, health back above the single point a
    // released ghost carries, or the ghost flag turning off again. Read against
    // the window as it stood before this event, so the event that opened the
    // window cannot also close it — an unreleased corpse reads `ghost === false`
    // too, and `playerFlags` is usually a stale 0 all through a death.
    const alive = cleared || (typeof health === "number" && health > 1) || (ghost === false && wasGhost);
    if ((wasDead || wasReleased) && alive) {
      watchedDead = false;
      watchedReleased = false;
      watchedGhost = false;
      pushDeathSignal({ kind: "resurrect", ts: event.ts, seq: event.seq });
    }
  });

  // ----------------------------------------------------------- flight watcher

  /**
   * Flights, latched the way deaths are and for the same reason (`ipc.ts`,
   * `FlightSignal`): the takeoff is the taxi flag turning on after an accepted
   * reply, the landing is it turning off, and each carries the position and the
   * zone/area pair as the cache held them at that event — the landing's own
   * area, not the one the host's next sample finds the character in. The flag
   * is read off `taxiFlight`, which the cache derives only from a block that
   * carried `unitFlags`, so a block without it changes nothing here. The first
   * reading seeds silently: a process that opens mid-flight did not see this
   * flight begin.
   */
  const FLIGHT_SIGNAL_CAP = 64;
  const flightSignals: FlightSignal[] = [];
  let lastFlightRead: boolean | undefined;

  function pushFlightSignal(signal: FlightSignal): void {
    flightSignals.push(signal);
    if (flightSignals.length > FLIGHT_SIGNAL_CAP) flightSignals.splice(0, flightSignals.length - FLIGHT_SIGNAL_CAP);
  }

  /** Drain what the flight watcher latched since the last call. Host-only. */
  function drainFlightSignals(): FlightSignal[] {
    return flightSignals.splice(0, flightSignals.length);
  }

  client.events.onAny((event) => {
    const self = client.state.self;
    const flying = self.taxiFlight?.value;
    if (typeof flying !== "boolean") return;
    const was = lastFlightRead;
    lastFlightRead = flying;
    if (was === undefined || was === flying) return;
    const accepted = (self.taxiReply?.value as { ok?: unknown } | undefined)?.ok === true;
    if (flying && !accepted) return;
    const at = point(self.position?.value);
    const zone = (self.zone?.value as { id?: unknown } | undefined)?.id;
    const area = (self.area?.value as { id?: unknown } | undefined)?.id;
    pushFlightSignal({
      kind: flying ? "taxi" : "taxi_landed",
      ts: event.ts,
      seq: event.seq,
      ...(at === undefined ? {} : { position: at }),
      ...(typeof zone === "number" ? { zone } : {}),
      ...(typeof area === "number" ? { area } : {}),
    });
  });

  // ------------------------------------------------------------ party watcher

  /**
   * The party records — `group`, `instance`, `kill` — latched as their packets
   * arrive (`party-watch.ts`), drained by the host's state sample like the death
   * and flight signals above. Registered after the client's own state fold, so
   * `state.group()` and the unit cache already hold the event it reads.
   */
  const partyWatcher = new PartyWatcher({
    group: () => client.state.group(),
    selfGuid: () => client.state.self.guid,
    objectOf: (guid) => {
      const o = client.state.nearby.get(guid);
      return o === undefined ? undefined : { entry: o.entry?.value, type: o.objectType?.value };
    },
    rankOf: (entry) => client.state.creatures.get(entry)?.value.rank,
  });
  client.events.onAny((event) => partyWatcher.observe(event));

  // ----------------------------------------------------------- trace recorder

  /**
   * The character's own position and state, latched as they change for the
   * host's state ticker to drain (`trace-recorder.ts`; the row contract is
   * `../trace-row.ts`). Record only: a snippet cannot reach it, and nothing it
   * reads is an observation the cache did not already hold. Registered here,
   * after the client's own state fold and the watchers above, so its hooks see
   * a cache that already has each event in it. Its opening key row is this
   * child's: a restart is a new process and a new key.
   */
  const traceRecorder = new TraceRecorder({ state: client.state, events: client.events });
  traceRecorder.start();

  /**
   * The units around the character, for the live map's ring and nothing else
   * (`nearby-recorder.ts`; the row contract is `../nearby-row.ts`). The same
   * posture as the trace recorder above: record only, unreachable from a
   * snippet, a reader of the cache that sends nothing. Its opening key is this
   * child's, so a restart restates the scene.
   */
  const nearbyRecorder = new NearbyRecorder({ state: client.state, events: client.events });
  nearbyRecorder.start();

  // The stack's client-cache forward, here in the listener order, between the
  // recorders and the spell marks, where the child has always registered it.
  forwardClientCache();

  /**
   * What the child adds to a spell combat-log line as it arrives (context.ts,
   * `spellLogNote` and `spellLogShown`): the combat-log sentence, named from
   * what is in view at that moment — a mob killed a second later has left
   * `nearby` by the time a turn renders the window — and whether the line is a
   * bystander's, which the event window leaves out. A unit's emote is marked
   * the same way (`emoteShown`), from whose it is and what it targets as it
   * arrives. Keyed by the event object itself, which the SDK's buffer and
   * every listener share.
   */
  const spellLogMarks = new WeakMap<StreamEvent, { note: string | undefined; bystander: boolean }>();

  /** A unit's name as a client would show it: in view, else a name-query answer, else the party list's. */
  function observedName(guid: string): string | undefined {
    const state = client.state;
    return (
      state.nearby.get(guid)?.name?.value ??
      state.nameOf(guid) ??
      state.group()?.members.find((m) => m.guid === guid)?.name
    );
  }

  client.events.onAny((event) => {
    if (event.opcode === "SMSG_EMOTE") {
      const guid = (event.data as { guid?: unknown } | undefined)?.guid;
      const unit = guid === undefined || guid === null ? undefined : client.state.nearby.get(String(guid));
      const emoter =
        unit === undefined
          ? undefined
          : { objectType: unit.objectType?.value, ownerGuid: unit.ownerGuid?.value, targetGuid: unit.targetGuid?.value };
      if (!emoteShown(event.opcode, event.data, client.state.self.guid, emoter)) spellLogMarks.set(event, { note: undefined, bystander: true });
      return;
    }
    if (!SPELL_LOG_OPCODES.has(event.opcode)) return;
    const me = client.state.self.guid;
    const party = new Set((client.state.group()?.members ?? []).map((m) => m.guid));
    spellLogMarks.set(event, {
      note: spellLogNote(event.opcode, event.data, me, observedName),
      bystander: !spellLogShown(event.opcode, event.data, me, party),
    });
  });

  // ------------------------------------------------------------ snippet delta

  /**
   * What changed since the previous snippet result, latched as events arrive
   * (`snippet-delta.ts`) for the host to drain once per `run_snippet` result on
   * a driver that renders it. Every child records it, bounded; a fixed-loop
   * child is simply never drained. Registered after the client's own state fold
   * and the spell-log marks, so its readings are of a cache that already holds
   * the event, and a melee attacker is named while it is still in view.
   */
  const snippetDelta = new SnippetDeltaRecorder({
    selfGuid: () => client.state.self.guid,
    level: () => {
      const v = client.state.self.level?.value;
      return typeof v === "number" ? v : undefined;
    },
    group: () => client.state.group(),
    memberUnit: (guid) => {
      const o = client.state.nearby.get(guid);
      if (o === undefined) return undefined;
      const health = o.fields.get("health")?.value;
      return {
        guid,
        health,
        maxHealth: o.fields.get("maxHealth")?.value,
        dead: health === undefined ? undefined : health === 0,
        ghost: memberGhost(o.fields.get("playerFlags")?.value),
      };
    },
    questLog: () => client.state.questLog,
    nameOf: observedName,
  });
  client.events.onAny((event) => snippetDelta.observe(event));

  // ---------------------------------------------------------- context window

  /**
   * The turn's event window, kept apart from the SDK's event buffer.
   *
   * The context shows the last `CONTEXT_POLICY.EVENT_WINDOW` events that are not
   * ambient movement (context.ts, `EVENT_WINDOW_EXCLUDE`). The SDK buffer holds
   * the last 500 events of every kind, and where transports report every second
   * ambient ones are nine in ten of them, so filtering that buffer would reach
   * back only as far as the ambient rate allowed. So the non-ambient events are
   * ringed here as they arrive — O(1) per event, `EVENT_WINDOW` entries, the
   * summaries built only when a turn asks — and ambient ones only counted.
   * Each entry remembers the ambient count at its arrival, so the number folded
   * out of the span a window covers is a subtraction. The SDK buffer and the
   * model's own `events.recent()` are untouched.
   *
   * Reach: the last EVENT_WINDOW non-ambient events since this child started;
   * a sandbox restart empties it, as it does the SDK buffer.
   */
  const CONTEXT_EVENT_CAP = CONTEXT_POLICY.EVENT_WINDOW;
  const contextRing: { event: StreamEvent; ambientBefore: number }[] = [];
  let contextAmbient = 0;
  let contextSignals = 0;

  client.events.onAny((event) => {
    if (CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(event.opcode)) {
      contextAmbient++;
      return;
    }
    // A bystander's spell combat-log line or emote: off the window, and not ambient.
    if (spellLogMarks.get(event)?.bystander === true) return;
    contextSignals++;
    contextRing.push({ event, ambientBefore: contextAmbient });
    if (contextRing.length > CONTEXT_EVENT_CAP) contextRing.shift();
  });

  function contextEvents(limit: number): ContextEvents {
    const take = contextRing.slice(-Math.max(0, Math.min(limit, CONTEXT_EVENT_CAP)));
    // The span starts at the oldest event shown when older non-ambient events
    // were left out; when every one this child has seen is shown, it is the
    // child's whole life, and an all-ambient stream says so rather than "none".
    const whole = take.length === contextSignals;
    const folded = whole || take.length === 0 ? contextAmbient : contextAmbient - take[0]!.ambientBefore;
    return { events: take.map((r) => summarize(r.event)), folded };
  }

  /** `PLAYER_FLAGS_GHOST` on another player's `playerFlags`; undefined when no block has carried the field. */
  function memberGhost(playerFlags: number | undefined): boolean | undefined {
    return playerFlags === undefined ? undefined : (playerFlags & 0x10) !== 0;
  }

  /** A party member's unit as its party frame reads it: health, the power bar with the raw `powerType` that picks it, and ghost. */
  function memberFrame(guid: string, health: number | undefined, maxHealth: number | undefined): Record<string, unknown> {
    const unit = client.state.nearby.get(guid);
    return {
      health,
      maxHealth,
      power: unit?.power?.value.current,
      maxPower: unit?.power?.value.max,
      powerType: unit?.fields.get("powerType")?.value,
      ghost: memberGhost(unit?.fields.get("playerFlags")?.value),
    };
  }

  /**
   * Whose corpse it is, by the owner guid on the corpse (`CORPSE_FIELD_OWNER`):
   * the name query's answer, else the party roster's name for that member.
   * Undefined while neither has named it, or when the owner was not served.
   */
  function corpseOwnerName(owner: string | undefined, group: ReturnType<typeof client.state.group>): string | undefined {
    if (owner === undefined) return undefined;
    return client.state.nameOf(owner) ?? group?.members.find((m) => m.guid === owner)?.name;
  }

  /**
   * The state snapshot the host renders into the HUD (`formatStateSummary`).
   *
   * It is `StateCache.snapshot()` plus the derived views the HUD needs and the
   * raw snapshot does not expose flat: our own auras by name (`aurasOf`),
   * `units()` (nearest-first, items/containers
   * dropped — with mob health/maxHealth deliberately stripped, since CONTRACTS.md
   * forbids exact mob health and the HUD only needs name, distance, dead, roles,
   * questgiver marker, target and reaction; a party member in view keeps its health and
   * ghost flag for the party line), the party with its party frames
   * (`group()`), `bag()`
   * (backpack shape with freeSlots), and the open-window fold over the retained
   * event stream. All are pure reads over what the cache already holds — no
   * new observation. This JSON is consumed only by the HUD, never returned raw.
   */
  function hudSnapshot(snap: Record<string, unknown>): void {
    // The party with each member's party frame (`group().members[i].stats`),
    // whole: the snapshot's depth cut would reach into its zone and position.
    const group = client.state.group();
    snap["group"] = toJsonSafe(group, 8);
    const members = new Set((group?.members ?? []).map((m) => m.guid));
    const units = client.state.units().map((u) => ({
      guid: u.guid,
      name: u.name,
      type: u.type,
      level: u.level,
      distance: u.distance,
      dead: u.dead,
      // The elite dragon a client draws round the portrait, for the nearby line.
      rank: u.rank,
      // A player's corpse is named by its owner, as a client's tooltip names it.
      ...(u.type === "corpse" ? { ownerName: corpseOwnerName(u.ownerGuid, group) } : {}),
      roles: u.roles,
      // The marker and the target, for which six the nearby line names
      // (`pickNearby` in context.ts): both are what the client draws, a `!`/`?`
      // over the NPC and a unit's own selection.
      questGiver: u.questGiver,
      targetGuid: u.targetGuid,
      // How the unit regards us, as the client colours its name (red, yellow,
      // green), for the nearby line's hostile mark; undefined until its
      // faction rows have been served.
      reaction: u.reaction,
      // A party member in view: its health, its power and whether it is a
      // ghost, for the HUD's party line, as a client's party frame reads them
      // off the unit (the frame's bars are the player's own health and power;
      // it is mob health the contract keeps exact numbers off). Never carried
      // for anything else.
      ...(members.has(u.guid) ? memberFrame(u.guid, u.health, u.maxHealth) : {}),
    }));
    snap["units"] = toJsonSafe(units, 4);
    snap["bag"] = toJsonSafe(client.state.bag(), 4);
    // Our own buff and debuff bar, named (`aurasOf` falls back to the
    // spellbook when the module served no name), for the HUD's `auras` line.
    const selfGuid = client.state.self.guid;
    snap["selfAuras"] = selfGuid === undefined ? [] : toJsonSafe(client.state.aurasOf(selfGuid), 4);
    snap["ui"] = foldUiOpenWindows(client.events.recent());
  }

  return {
    rpc: {
      context_events: (params) => contextEvents(params.limit ?? CONTEXT_EVENT_CAP),
      death_signals: () => drainDeathSignals(),
      flight_signals: () => drainFlightSignals(),
      party_signals: () => partyWatcher.drain(),
      snippet_delta: () => snippetDelta.drain(),
      trace_drain: () => traceRecorder.drain(),
      nearby_drain: () => nearbyRecorder.drain(),
    },
    summarize: (e: StreamEvent): Partial<Pick<EventSummary, "note" | "bystander">> | undefined => {
      const mark = spellLogMarks.get(e);
      if (mark === undefined) return undefined;
      return {
        ...(mark.note !== undefined ? { note: mark.note } : {}),
        ...(mark.bystander ? { bystander: true as const } : {}),
      };
    },
    snapshot: hudSnapshot,
  };
}
