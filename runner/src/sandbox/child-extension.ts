/**
 * The runner's extension of the sandbox child (`@wrathbench/mcp`'s
 * `SandboxChildExtension`): everything the benchmark watches from inside the
 * child, latched as events arrive and drained by the runner's host
 * (`host.ts`): the spell combat-log marks, the snippet delta, the turn's
 * event window and the HUD's fields on the state snapshot. Context only: a
 * snippet reaches none of it. What the session leaves on the record (the
 * trace, the units around it, deaths, flights, the party records) is the
 * stack's own recorder, which this child runs ahead of this extension.
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
  isAmbientEvent,
  DISPEL_LOG_OPCODES,
  emoteShown,
  foldUiOpenWindows,
  SPELL_LOG_OPCODES,
  spellLogNote,
  spellLogShown,
} from "../context";
import type { ContextEvents } from "./signals";
import { SnippetDeltaRecorder } from "./snippet-delta";

export function benchmarkChildExtension({ client, summarize, forwardClientCache }: SandboxChildApi): SandboxChildExtension {
  // The stack's client-cache forward, here in the listener order, ahead of
  // the spell marks, where the child has always registered it.
  forwardClientCache();

  /**
   * What the child adds to a spell combat-log line as it arrives (context.ts,
   * `spellLogNote` and `spellLogShown`): the combat-log sentence, named from
   * what is in view at that moment — a mob killed a second later has left
   * `nearby` by the time a turn renders the window — and whether the line is a
   * bystander's, which the event window leaves out. A dispel line
   * (`DISPEL_LOG_OPCODES`) is marked by the same rule, with no sentence. A
   * unit's emote is marked the same way (`emoteShown`), from whose it is and
   * what it targets as it arrives. Keyed by the event object itself, which the
   * SDK's buffer and every listener share.
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
    // A dispel line is judged as a spell line and carries no sentence (`spellLogNote` has none for it).
    if (!SPELL_LOG_OPCODES.has(event.opcode) && !DISPEL_LOG_OPCODES.has(event.opcode)) return;
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
   * ambient (context.ts, `isAmbientEvent`). The SDK buffer holds
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
    if (isAmbientEvent(event.opcode, event.data)) {
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
      snippet_delta: () => snippetDelta.drain(),
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
