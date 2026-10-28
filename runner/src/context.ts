/**
 * The fixed context policy. This file IS the policy; the prose version is
 * docs/METHODOLOGY.md ("Context policy"). Do not tune per model.
 *
 * Per model request the conversation is rebuilt as:
 *
 *   [ system prompt ]
 *   [ the message window: recent assistant / tool messages, each capped at
 *     WINDOW_MESSAGE_CHARS, cut at assistant boundaries so tool-call pairs
 *     stay intact; the tool results of its older block folded to one-line
 *     records (`foldToolResult`), its most recent block verbatim ]
 *   [ one fresh user message assembled by `assembleContext`:
 *       the turn number, harness notices, state summary, last EVENT_WINDOW
 *       events, scratchpad ]
 *
 * The window grows to MESSAGE_WINDOW_MAX and is then cut back by one block of
 * MESSAGE_WINDOW_TRIM messages, rather than sliding one message per turn. The
 * point is prompt caching: providers cache by longest byte-identical prefix, so
 * a per-turn slide diverges the prefix right after the system prompt on every
 * turn and pays a full recompute each call. Block trimming keeps the prefix
 * byte-stable for a whole block and pays one deliberate miss per block. The cut
 * is applied one turn after the crossing that earns it (`laggedLength`), so the
 * turn before a trim can be told that it is the last one; the window therefore
 * sits at most one turn's growth above the ceiling, for that one turn.
 *
 * The fold rides the same block grid (operator, 2026-10-19). Once a trim has
 * happened, the window's older block — the messages before the raw cut plus one
 * MESSAGE_WINDOW_TRIM, snapped back to a turn's start — keeps its assistant
 * messages as they were and replaces each tool result with one deterministic
 * line naming the tool, its arguments cut short, ok or error, and the
 * snippet's duration (`messageWindowFold`). The boundary moves only when the
 * cut does, so the folded prefix is as byte-stable as the cut and costs no
 * cache miss of its own; and the snap back keeps a result verbatim on the turn
 * it arrives and the turn after, the trim turn included. Nothing is summarised:
 * the line is a pure function of the call and the result.
 *
 * Older per-turn user context messages are dropped entirely — they are
 * regenerated, never accumulated. Determinism: `assembleContext` is a pure
 * function of its inputs and the tests require byte-identical output;
 * `messageWindow` is a pure function of the *whole* stored history, so a
 * rebuilt history reproduces the same boundaries as an in-memory one.
 */

import { inventoryResultText } from "@wrathbench/sdk";

import { compactJson } from "@wrathbench/mcp";
import { scratchpadSizeLabel } from "@wrathbench/mcp";
import type { EventSummary, MoveIntentNote } from "@wrathbench/mcp";
import type { HarnessNotice } from "./sandbox/host";

export const CONTEXT_POLICY = {
  /** Last N non-ambient events included in every turn's context (see EVENT_WINDOW_EXCLUDE; bystanders' spell lines are left out too, `spellLogShown`). */
  EVENT_WINDOW: 64,
  /** Max chars of one event's data rendering. */
  EVENT_DATA_CHARS: 220,
  /**
   * The message window is hysteretic: it grows to MESSAGE_WINDOW_MAX, then a
   * single block of MESSAGE_WINDOW_TRIM oldest messages is dropped, cutting it
   * back to MESSAGE_WINDOW_MAX - MESSAGE_WINDOW_TRIM. The floor is the old
   * fixed window (24 messages ≈ 8–12 tool exchanges); the ceiling
   * buys a byte-stable prefix for a full block of turns.
   */
  MESSAGE_WINDOW_MAX: 48,
  MESSAGE_WINDOW_TRIM: 24,
  /**
   * Max chars of one window message's content, in the same spirit as
   * EVENT_DATA_CHARS: a single 27k-char snippet result was observed sitting in
   * the window for a dozen turns, crowding out the summary it was supposed to
   * inform. The full text is always in the trajectory; the model is told how
   * much was cut so it can print less and re-run.
   */
  WINDOW_MESSAGE_CHARS: 4_000,
  /**
   * Max chars of a call's arguments on a folded tool result's line
   * (`foldToolResult`). Short on purpose: the call itself stays in the window
   * as the model sent it, so the line only has to say which call it answers.
   */
  FOLD_ARGS_CHARS: 80,
  /**
   * Chat / notification tail lengths inside the state summary. `CHAT_TAIL`
   * counts lines from players and the system; creature speech and emotes get
   * their own `NPC_CHAT_TAIL`, so a dungeon's barks cannot push party chat out
   * of the window (the 2026-10-20 party runs).
   */
  CHAT_TAIL: 10,
  NPC_CHAT_TAIL: 3,
  NOTIFICATION_TAIL: 5,
  /** Own auras listed on the summary's `auras` line before "+N more". */
  AURA_TAIL: 10,
  /**
   * Ambient-motion opcodes excluded from the model-visible event window (they
   * still fold into the state cache, whose nearby/motion the summary reflects).
   * Measured on gate2-ox-1: SMSG_MONSTER_MOVE alone was 69% of served events
   * while combat/quest signal was 1.8% — the window exists for signal.
   * WB_TRANSPORT_PROGRESS is the same kind of motion: each transport in view
   * range reports once a second (every transport on the map did, wherever
   * the character stood, which came to about four-fifths of the window's
   * characters and read to models as noise), while the cache already keeps
   * each car's position and `docked`.
   *
   * Excluded first, then counted (operator decision, 2026-10-05): the window
   * is the last EVENT_WINDOW events that are NOT ambient, however many ambient
   * ones arrived among them, and the line above it says how many ambient
   * events the span it covers held. It used to be the other way round — the
   * last EVENT_WINDOW events of any kind, ambient ones then dropped — and on a
   * continent whose transports report every second that left a median of 4
   * events, about 2.6 seconds of play, in a window the prompt calls "the most
   * recent events", with 17% of turns showing none at all; whatever the
   * previous half-minute of combat, loot and quest updates had said was gone
   * before the model's next turn. The sandbox child keeps the non-ambient
   * events in a ring of their own (`contextEvents` in sandbox/entry.ts), so
   * the window's reach is the last EVENT_WINDOW signal events since the
   * child started — independent of the ambient rate, and emptied by a
   * sandbox restart like everything else the child holds.
   *
   * SMSG_PARTY_MEMBER_STATS and its _FULL answer (the prefix matches both) are
   * ambient too (operator decision, Mark, 2026-10-21). They are the party
   * frames of a member out of sight, and the server sends one per update of
   * that member: about two a second while it walks, plus one for each regen
   * tick and each hit. Four far members would turn the 64-event window over
   * in about seven seconds. The state cache keeps each member's latest values
   * (`group().members[i].stats`), and the HUD's party line reads them there.
   */
  EVENT_WINDOW_EXCLUDE: /^(SMSG_MONSTER_MOVE|MSG_MOVE|WB_TRANSPORT_PROGRESS|SMSG_PARTY_MEMBER_STATS)/,
} as const;

// ------------------------------------------------------------ state summary

interface ObservedLike {
  value?: unknown;
  seq?: number;
  /** The cache's wall-clock stamp for the observation; on the wire, undeclared until now. */
  ts?: number;
}

/** One nearby object as the sandbox flattens `state.units()` into the rpc JSON. */
export interface UnitLike {
  guid?: unknown;
  name?: unknown;
  type?: unknown;
  level?: unknown;
  distance?: unknown;
  /** `true` only when health was observed and is 0. See the HUD caveat below. */
  dead?: unknown;
  /** A creature's rank as the SDK names it (`normal`, `elite`, `rareelite`, `worldboss`, `rare`); absent until its query answered. */
  rank?: unknown;
  /** Corpses only: the owning player's name, once its name query (or the party roster) has given it. */
  ownerName?: unknown;
  /** `UNIT_NPC_FLAGS` decoded to role words by the SDK (`questGiver`, `vendor`, …). */
  roles?: unknown;
  /**
   * The questgiver marker the client draws over it, as the SDK names it
   * (`available`, `reward`, `incomplete`, `none`, …); absent until a status
   * packet named this guid.
   */
  questGiver?: unknown;
  /** What it has selected (`UNIT_FIELD_TARGET`), when observed. */
  targetGuid?: unknown;
  /** Party members only: the unit's own health, as the party frame reads it. Never carried for a mob. */
  health?: unknown;
  maxHealth?: unknown;
  /** Party members only: `PLAYER_FLAGS_GHOST` on its `playerFlags`. */
  ghost?: unknown;
  /** Party members only: the unit's power bar, and the raw `powerType` that picks it (0 mana, 1 rage, 2 focus, 3 energy, 6 runic power). */
  power?: unknown;
  maxPower?: unknown;
  powerType?: unknown;
}

/** One `state.group().members` row as the sandbox serialises it. */
export interface GroupMemberLike {
  guid?: unknown;
  name?: unknown;
  /** From `SMSG_GROUP_LIST`. */
  online?: unknown;
  inView?: unknown;
  /** The party frame while out of sight (SDK `PartyMemberStats`). */
  stats?: {
    online?: unknown;
    dead?: unknown;
    ghost?: unknown;
    health?: unknown;
    maxHealth?: unknown;
    /** The SDK's name for it ("mana", "rage", ...). */
    powerType?: unknown;
    power?: unknown;
    maxPower?: unknown;
    zone?: { id?: unknown; name?: unknown };
    position?: { x?: unknown; y?: unknown };
    /** The stream seq of the last party-frame packet for this member. */
    seq?: unknown;
  };
}

/** The carried inventory as `state.bag()` shapes it, flattened into the rpc JSON. */
interface BagLike {
  freeSlots?: unknown;
  /** Backpack (16) plus every worn bag's slots; absent on a pre-item-50 snapshot. */
  totalSlots?: unknown;
  items?: { bag?: unknown; slot?: unknown; itemId?: unknown; name?: unknown; count?: unknown; quality?: unknown }[];
}

/**
 * The "open window" fold the HUD shows on its `ui` line. Every field is an
 * honest fold over the event stream (or self fields) — never a guess. A kind
 * that cannot be proven open is simply absent, so the line omits it.
 */
export interface UiOpenWindows {
  /** Gossip menu open: the last SMSG_GOSSIP_MESSAGE has no later SMSG_GOSSIP_COMPLETE. */
  gossip?: { options: number };
  /** Loot window open: the last SMSG_LOOT_RESPONSE has no later SMSG_LOOT_RELEASE_RESPONSE. */
  loot?: boolean;
  /** Vendor list open: SMSG_LIST_INVENTORY is the most recent window event of the three. */
  vendor?: boolean;
}

/** One row of `state.self.achievements.entries`, as the rpc JSON carries it. */
interface AchievementLike {
  achievementId?: unknown;
  name?: unknown;
  points?: unknown;
  categoryId?: unknown;
  /** `login` (the backlog a client gets at login) or `earned` (our own earn). */
  source?: unknown;
}

/** JSON-safe snapshot as produced by the sandbox rpc (StateCache.snapshot()). */
export interface SnapshotLike {
  /**
   * Where the character is trying to get to, as the sandbox watched the
   * dispatch (`MoveIntentNote`). Not part of the world the model is shown —
   * the HUD never prints it; the map draws it.
   */
  move?: MoveIntentNote | null;
  self?: {
    guid?: unknown;
    name?: unknown;
    level?: ObservedLike;
    position?: ObservedLike;
    /** `{ id, name }` — the zone the client names on screen (SDK `state.self.zone`, from `WB_AREA`). */
    zone?: ObservedLike;
    /** `{ id, name }` — the subzone (SDK `state.self.area`). */
    area?: ObservedLike;
    /** `{ id, name, instanceType }` — the map and its `Map.dbc` kind (SDK `state.self.map`, from `WB_AREA`). */
    map?: ObservedLike;
    /** `value` is `[{ triggerId, map, x, y, z, to: { id, name, instanceType } }]` — portals in view (SDK `state.self.portals`). */
    portals?: ObservedLike;
    /** `value` is a `{ current, max }` gauge. Self only (the player frame is numbers). */
    health?: ObservedLike;
    power?: ObservedLike;
    /** `UNIT_FIELD_TARGET` on our own block: what the client shows as selected. */
    targetGuid?: ObservedLike;
    /** Raw per-field record (a Map serialized to an object). Read for the ghost flag. */
    fields?: Record<string, ObservedLike | undefined>;
    /** Where the corpse is while dead: `{ map, x, y, z, source, instanceMap? }` (SDK `state.self.corpse`). */
    corpse?: ObservedLike;
    /** The graveyard the spirit was released to: `{ map, x, y, z }`. */
    graveyard?: ObservedLike;
    /** `{ delayMs, readyAt }` — when a reclaim becomes legal (wall-clock ms). */
    reclaimDelay?: ObservedLike;
    /**
     * `state.self.achievements`: every achievement observed for this
     * character, the login backlog first. The HUD prints a **count and a points
     * total only** — the list is tens of rows a turn of prompt for a fact the
     * agent can read with a snippet, and the ids ride the trajectory instead.
     */
    achievements?: { entries?: AchievementLike[]; points?: unknown; loginSeen?: unknown };
    /** `value` is a bool: `UNIT_FLAG_TAXI_FLIGHT` on self — the character is being flown. */
    taxiFlight?: ObservedLike;
    taxiEta?: ObservedLike;
    /** `value` is a bool: `PLAYER_FLAGS_RESTING` on self — the character is in a rest area. */
    resting?: ObservedLike;
    /** `value` is `{ reply, ok }` — the last `SMSG_ACTIVATETAXIREPLY`. */
    taxiReply?: ObservedLike;
    /** `value` is `{ map, x, y, z, area: { id, name } }` — where the Hearthstone goes (`SMSG_BINDPOINTUPDATE`). */
    bindPoint?: ObservedLike;
  };
  /** Current XP toward the next level (top level in the SDK snapshot, not under `self`). */
  xp?: ObservedLike;
  /** XP required for the next level, as the client's bar shows it. */
  nextLevelXp?: ObservedLike;
  /** Copper (top level in the SDK snapshot, like `xp`). */
  money?: ObservedLike;
  /** Confirmed turn-ins this session, oldest first. Recorded, not shown. */
  questCompletions?: { questId?: unknown; ts?: unknown }[];
  /**
   * The quest log's occupied slots: questId, the completion bit, and the title
   * and level from the quest's template answer (`SMSG_QUEST_QUERY_RESPONSE`,
   * what the client's quest log shows) once it has arrived.
   */
  questLog?: { questId?: unknown; complete?: unknown; title?: unknown; level?: unknown }[];
  characters?: ObservedLike;
  nearby?: Record<string, unknown>;
  /**
   * `state.units()` flattened by the sandbox (nearest first, items/containers
   * dropped). Mob `health`/`maxHealth` are deliberately NOT carried here and are
   * never printed — CONTRACTS.md forbids exact mob health.
   */
  units?: UnitLike[];
  /** `state.group()`: the party, each member with `inView` and its party frame (`stats`). */
  group?: { inGroup?: unknown; members?: GroupMemberLike[] };
  /** `state.bag()` shape: carried items across all bags, free and total slot counts. */
  bag?: BagLike;
  /** `state.inventory` as the sandbox serialises it; equipment is `slot < 19`. */
  inventory?: {
    slot?: unknown;
    itemId?: unknown;
    name?: unknown;
    stackCount?: unknown;
    quality?: unknown;
    /** `{ current, max }` from the item's own durability fields; absent on an item with no maximum. */
    durability?: { current?: unknown; max?: unknown };
  }[];
  /**
   * `state.spells`: the spellbook as `SMSG_INITIAL_SPELLS` /
   * `SMSG_LEARNED_SPELL` left it. The HUD never prints it — it is tens of rows
   * for a fact a snippet can read — and the ids ride the trajectory instead
   * (`spells_at_login` / `spell`).
   */
  spells?: { spellId?: unknown }[];
  /** `state.talents`: the last `SMSG_TALENTS_INFO`. Ranks are 0-based on the wire. */
  talents?: {
    unspentPoints?: unknown;
    activeSpec?: unknown;
    talents?: { talentId?: unknown; rank?: unknown }[];
  };
  /**
   * `state.trade`: the trade window. Read for `status` alone — 8 is
   * `TRADE_STATUS_TRADE_COMPLETE`, and `ts` is the cache's stamp for it.
   */
  trade?: { status?: unknown; ts?: unknown };
  /** The open-window fold the sandbox computes from the event stream. */
  ui?: UiOpenWindows;
  chat?: ChatLineLike[];
  /** Our own visible auras (`state.aurasOf(self.guid)`), named; the sandbox's derived view. */
  selfAuras?: AuraLike[];
  notifications?: { text?: unknown }[];
  /** `state.names`: name-query answers by guid (`{ value, seq, ts }`), the player senders' names. */
  names?: Record<string, { value?: unknown }>;
  gaps?: unknown[];
  lastSeq?: number;
  eventCount?: number;
  /**
   * The sandbox child's report on its own event stream, not an observation of
   * the world: the HUD prints nothing from it, and only the stall detector in
   * `loop.ts` reads it.
   */
  observation?: { connected?: boolean };
}

/** One `state.aurasOf()` row as the snapshot carries it (SDK `AuraEntry`). */
export interface AuraLike {
  spellId?: unknown;
  name?: unknown;
  flags?: unknown;
  stacks?: unknown;
  duration?: unknown;
  ts?: unknown;
}

/** `AFLAG_NEGATIVE` / `AFLAG_DURATION` on an aura slot (SpellAuraDefines.h). */
const AFLAG_NEGATIVE = 0x80;
const AFLAG_DURATION = 0x20;

/** "45s", "9m 12s", "1h 05m": what is left of a timed aura. */
function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * The buff bar a client draws for itself, as one line: each aura by name,
 * marked when it is a debuff, with its stacks and, when the aura shows a
 * timer, what is left of it now (`duration` was what was left at `ts`).
 * Undefined when no aura is observed: an empty list is not proof of an empty
 * bar, so nothing is said.
 */
export function auraLine(auras: readonly AuraLike[] | undefined, now: number): string | undefined {
  if (auras === undefined || auras.length === 0) return undefined;
  const parts = auras.slice(0, CONTEXT_POLICY.AURA_TAIL).map((a) => {
    const name = typeof a.name === "string" && a.name.length > 0 ? a.name : `spell ${fmt(a.spellId, "?")}`;
    const flags = typeof a.flags === "number" ? a.flags : 0;
    const notes: string[] = [];
    if ((flags & AFLAG_NEGATIVE) !== 0) notes.push("debuff");
    if (typeof a.stacks === "number" && a.stacks > 1) notes.push(`${a.stacks} stacks`);
    if ((flags & AFLAG_DURATION) !== 0 && typeof a.duration === "number" && typeof a.ts === "number") {
      notes.push(`${fmtLeft(a.duration - (now - a.ts))} left`);
    }
    return notes.length === 0 ? name : `${name} (${notes.join(", ")})`;
  });
  const more = auras.length > parts.length ? ` +${auras.length - parts.length} more` : "";
  return `auras: ${parts.join(", ")}${more} [state.aurasOf(state.self.guid)]`;
}

/** One `state.chat` entry as the snapshot carries it (SDK `ChatEntry`). */
export interface ChatLineLike {
  type?: unknown;
  senderGuid?: unknown;
  senderName?: unknown;
  receiverGuid?: unknown;
  receiverName?: unknown;
  channelName?: unknown;
  message?: unknown;
  achievementId?: unknown;
}

/** `CHAT_MSG_*` codes the chat lines name (SharedDefines.h). */
const CHAT_MSG_SYSTEM = 0x00;
const CHAT_MSG_WHISPER_INFORM = 0x09;
const CHAT_MSG_CHANNEL = 0x11;
const CHAT_MSG_ACHIEVEMENT = 0x30;
const CHAT_MSG_GUILD_ACHIEVEMENT = 0x31;

/**
 * The chat type as a short label, the distinction a client draws in colour
 * and in its "[Party]" / "whispers:" / "yells:" wording. Creature speech is
 * marked `npc` (`MONSTER_*`, `RAID_BOSS_*`): the packet says it, and party
 * chat must not read as a creature's bark or the other way round.
 */
const CHAT_TYPE_LABEL: Readonly<Record<number, string>> = {
  0x00: "system",
  0x01: "say",
  0x02: "party",
  0x03: "raid",
  0x04: "guild",
  0x05: "officer",
  0x06: "yell",
  0x07: "whisper",
  0x08: "whisper",
  0x09: "whisper",
  0x0a: "emote",
  0x0b: "emote",
  0x0c: "npc say",
  0x0d: "npc party",
  0x0e: "npc yell",
  0x0f: "npc whisper",
  0x10: "npc emote",
  0x27: "raid",
  0x28: "raid warning",
  0x29: "npc emote",
  0x2a: "npc whisper",
  0x30: "achievement",
  0x31: "achievement",
  0x33: "party",
};

/**
 * The types whose text is a template the client fills with the sender's
 * name: the emotes (`EMOTE`, `TEXT_EMOTE`, `MONSTER_EMOTE`, `RAID_BOSS_EMOTE`)
 * and the achievement broadcast. Anything else prints `%s` as typed.
 */
const NAME_TEMPLATE_TYPES: ReadonlySet<number> = new Set([0x0a, 0x0b, 0x10, 0x29, CHAT_MSG_ACHIEVEMENT, CHAT_MSG_GUILD_ACHIEVEMENT]);

/**
 * The types a player addresses to our group or to us: `PARTY`/`PARTY_LEADER`,
 * `RAID`/`RAID_LEADER`/`RAID_WARNING`, and a whisper received (`WHISPER`,
 * `WHISPER_FOREIGN`). Not our own whisper's echo (`WHISPER_INFORM`), whose
 * sender is the recipient; whether the line is our own is the caller's check.
 */
const GROUP_OR_WHISPER_TYPES: ReadonlySet<number> = new Set([0x02, 0x33, 0x03, 0x27, 0x28, 0x07, 0x08]);

/** A party, raid or whisper line by `type` (`GROUP_OR_WHISPER_TYPES`). */
export function isGroupOrWhisperChat(c: ChatLineLike): boolean {
  return typeof c.type === "number" && GROUP_OR_WHISPER_TYPES.has(c.type);
}

/** Creature speech and emotes (`MONSTER_SAY`..`MONSTER_EMOTE`, `RAID_BOSS_EMOTE`/`_WHISPER`). */
export function isCreatureChat(c: ChatLineLike): boolean {
  return typeof c.type === "number" && ((c.type >= 0x0c && c.type <= 0x10) || c.type === 0x29 || c.type === 0x2a);
}

/**
 * One chat line the way the client's chat frame would show it: the type, and
 * the speaker's name where one is known — the packet's own (`senderName`,
 * creature speech), the SDK's name-query join, or the snapshot's `names` —
 * and the guid otherwise. A channel line carries its channel. Our own
 * whisper's echo (`WHISPER_INFORM`) names the recipient in the sender's
 * place, as the core builds it, and reads "to <name>:" as a client prints
 * it. A text carrying `%s` (a creature emote) has the sender's name put in
 * its place, as the client does, and then needs no name in front. The
 * achievement broadcast never takes one: the SDK's `state.chat` has already
 * filled it (`Tankfriend has earned the achievement [Deadmines]!`), and a raw
 * line is filled here the same way, its `$a` the bracketed id where no
 * achievement packet named it.
 */
export function formatChatLine(c: ChatLineLike, names?: Record<string, { value?: unknown }>): string {
  const guid = c.senderGuid === undefined || c.senderGuid === null ? undefined : String(c.senderGuid);
  const queried = guid !== undefined ? names?.[guid]?.value : undefined;
  const name =
    typeof c.senderName === "string" && c.senderName.length > 0
      ? c.senderName
      : typeof queried === "string" && queried.length > 0
        ? queried
        : (guid ?? "?");
  let message = fmt(c.message, "");
  const achievement = c.type === CHAT_MSG_ACHIEVEMENT || c.type === CHAT_MSG_GUILD_ACHIEVEMENT;
  if (achievement) {
    const id = typeof c.achievementId === "number" ? `[achievement ${c.achievementId}]` : "an achievement";
    message = message.replaceAll("$a", id);
  }
  const label =
    c.type === CHAT_MSG_CHANNEL && typeof c.channelName === "string" && c.channelName.length > 0
      ? c.channelName
      : typeof c.type === "number"
        ? (CHAT_TYPE_LABEL[c.type] ?? `type ${c.type}`)
        : "chat";
  if (c.type === CHAT_MSG_SYSTEM) return `  [${label}] ${message}`;
  if (c.type === CHAT_MSG_WHISPER_INFORM) return `  [${label}] to <${name}>: ${message}`;
  if (achievement || (typeof c.type === "number" && NAME_TEMPLATE_TYPES.has(c.type) && message.includes("%s"))) {
    return `  [${label}] ${message.replaceAll("%s", name)}`;
  }
  return `  [${label}] <${name}> ${message}`;
}

/**
 * The chat lines the summary shows, oldest first: the last `CHAT_TAIL` from
 * players and the system, and the last `NPC_CHAT_TAIL` creature lines among
 * them, so a run of barks and emotes cannot push party chat out.
 */
export function chatTail(chat: readonly ChatLineLike[]): ChatLineLike[] {
  const out: ChatLineLike[] = [];
  let players = 0;
  let creatures = 0;
  for (let i = chat.length - 1; i >= 0; i--) {
    const c = chat[i]!;
    if (isCreatureChat(c)) {
      if (creatures >= CONTEXT_POLICY.NPC_CHAT_TAIL) continue;
      creatures++;
    } else {
      if (players >= CONTEXT_POLICY.CHAT_TAIL) continue;
      players++;
    }
    out.push(c);
    if (players >= CONTEXT_POLICY.CHAT_TAIL && creatures >= CONTEXT_POLICY.NPC_CHAT_TAIL) break;
  }
  return out.reverse();
}

function fmt(v: unknown, fallback = "unobserved"): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "object") return compactJson(v, 120);
  return String(v);
}

/** Render a `{ current, max }` gauge, or "unobserved" if the gauge is absent. */
function fmtGauge(o?: ObservedLike): string {
  const v = o?.value as { current?: unknown; max?: unknown } | null | undefined;
  if (v === undefined || v === null) return "unobserved";
  if (typeof v === "object" && "current" in v) return `${fmt(v.current)}/${fmt(v.max)}`;
  return fmt(v);
}

/**
 * PLAYER_FLAGS_GHOST on 3.3.5a — set while the character is a corpse-run ghost.
 * Exported because the death milestone producer reads the same bit off the same
 * raw field record, and two copies of a wire constant is one too many.
 */
export const PLAYER_FLAGS_GHOST = 0x10;

/** Backpack size (16 slots): the bag line's total when the snapshot carries none. */
const BACKPACK_SIZE = 16;
/** How many of the most numerous items the bag line names (stacks of one item counted together). */
const BAG_MOST = 4;
/** How many uncommon-or-better items the bag line names. */
const BAG_BEST = 3;
/** Item quality (`ItemQualities`): 0 poor (grey), 2 uncommon (green) and up. */
const QUALITY_POOR = 0;
const QUALITY_UNCOMMON = 2;
/** How many nearby objects the HUD names before collapsing the rest to "+K more". */
const NEARBY_CAP = 6;
/** Nearby slots kept for the nearest objects whatever they are (see `pickNearby`). */
const NEARBY_NEAREST = 2;
/** Longest quest title the quest line prints; a longer one is cut and ends in "…". */
const QUEST_TITLE_CHARS = 24;

/**
 * The bag line: room first, then a summary rather than a listing. It used to
 * name the first eight slots in bag order, which are the same eight from turn
 * to turn (a hearthstone, a pick, whatever was looted first) and say nothing
 * about the rest. The summary answers what the line is read for, in the same
 * room or less: how full the bags are, how much of it is grey junk a vendor
 * takes, which items are worth something (uncommon or better — equip it or
 * sell it), and what the big stacks are (consumables, trade goods, quest
 * items). Stacks of one item are counted together. Quality unobserved is
 * neither junk nor uncommon: an item whose template has not answered is not
 * guessed at.
 */
function bagLine(bag: BagLike): string {
  const items = bag.items ?? [];
  const free = bag.freeSlots;
  const total = typeof bag.totalSlots === "number" ? bag.totalSlots : BACKPACK_SIZE;
  const room = typeof free === "number" ? `${free} free / ${total}` : "unobserved";
  if (items.length === 0) return `bag: ${room}, empty`;
  let grey = 0;
  const byItem = new Map<string, { label: string; count: number; quality: number | undefined }>();
  for (const it of items) {
    if (it.quality === QUALITY_POOR) {
      grey++;
      continue;
    }
    const label =
      it.name != null ? String(it.name) : it.itemId != null ? `item ${String(it.itemId)}` : `slot ${String(it.slot)}`;
    const key = it.itemId != null ? `id ${String(it.itemId)}` : `name ${label}`;
    const count = typeof it.count === "number" && it.count > 0 ? it.count : 1;
    const quality = typeof it.quality === "number" ? it.quality : undefined;
    const seen = byItem.get(key);
    if (seen === undefined) byItem.set(key, { label, count, quality });
    else seen.count += count;
  }
  const all = [...byItem.values()];
  const show = (i: { label: string; count: number }): string => (i.count > 1 ? `${i.label} x${i.count}` : i.label);
  // Ties keep bag order (the sort is stable), so a bag of single items reads
  // as the old line did, its first slots first.
  const best = all
    .filter((i) => i.quality !== undefined && i.quality >= QUALITY_UNCOMMON)
    .sort((a, b) => b.quality! - a.quality! || b.count - a.count)
    .slice(0, BAG_BEST);
  const most = all
    .filter((i) => !best.includes(i))
    .sort((a, b) => b.count - a.count)
    .slice(0, BAG_MOST);
  const parts = [grey > 0 ? `bag: ${room}, ${grey} grey` : `bag: ${room}`];
  if (most.length > 0) parts.push(`most: ${most.map(show).join(", ")}`);
  if (best.length > 0) parts.push(`green+: ${best.map(show).join(", ")}`);
  return parts.join("; ");
}

/** Equipment slots 0-18 by the names a character sheet gives them. */
const EQUIP_SLOT_NAME: readonly string[] = [
  "head", "neck", "shoulders", "shirt", "chest", "waist", "legs", "feet", "wrists", "hands",
  "finger", "finger", "trinket", "trinket", "back", "main hand", "off hand", "ranged", "tabard",
];

/**
 * The share of its maximum at or under which a worn item reads as low: a
 * quarter, which is what one Spirit Healer resurrection takes off every
 * equipped item, so a low item is one such resurrection from broken. The
 * harness's own line, not a client threshold.
 */
const DURABILITY_LOW_FRACTION = 0.25;

/**
 * "durability: broken main hand Rusted Cleaver (0/40); low chest Patched
 * Vest (9/60) — a broken item gives no stats", or undefined when every worn
 * item is above `DURABILITY_LOW_FRACTION` (the ordinary case costs nothing).
 * Broken first, then low, each in slot order.
 */
function durabilityLine(inventory: SnapshotLike["inventory"]): string | undefined {
  const broken: string[] = [];
  const low: string[] = [];
  for (const it of inventory ?? []) {
    const slot = it.slot;
    if (typeof slot !== "number" || slot >= EQUIP_SLOT_NAME.length) continue;
    const cur = it.durability?.current;
    const max = it.durability?.max;
    if (typeof cur !== "number" || typeof max !== "number" || max <= 0) continue;
    if (cur > max * DURABILITY_LOW_FRACTION) continue;
    const name = it.name != null ? String(it.name) : it.itemId != null ? `item ${String(it.itemId)}` : "an item";
    (cur <= 0 ? broken : low).push(`${EQUIP_SLOT_NAME[slot]} ${name} (${cur}/${max})`);
  }
  if (broken.length === 0 && low.length === 0) return undefined;
  const parts: string[] = [];
  if (broken.length > 0) parts.push(`broken ${broken.join(", ")}`);
  if (low.length > 0) parts.push(`low ${low.join(", ")}`);
  return `durability: ${parts.join("; ")}${broken.length > 0 ? " — a broken item gives no stats" : ""}`;
}

/** One quest as the quest line names it: id, then the title, cut if long. */
export function questLabel(q: { questId?: unknown; title?: unknown }): string {
  const id = fmt(q.questId, "?");
  if (typeof q.title !== "string" || q.title.length === 0) return id;
  const title = q.title.length > QUEST_TITLE_CHARS ? `${q.title.slice(0, QUEST_TITLE_CHARS - 1)}…` : q.title;
  return `${id} ${title}`;
}

/**
 * One quest as the quest line prints it: the label, then a bracket with the
 * level and "done" when it can be turned in — `[30 done]`, `[62]`, `[done]`
 * before the level is known, and no bracket for an open quest without one.
 * The snippet delta keeps the bare label: its own words already say done.
 */
function questEntry(q: { questId?: unknown; title?: unknown; complete?: unknown; level?: unknown }): string {
  const tags: string[] = [];
  if (typeof q.level === "number") tags.push(String(q.level));
  if (q.complete === true) tags.push("done");
  return tags.length === 0 ? questLabel(q) : `${questLabel(q)} [${tags.join(" ")}]`;
}

/**
 * The quest line: ids with titles and levels, completed quests first so the
 * turn-ins read together. The ids alone meant nothing once the notes that
 * named them were gone — a model with three complete quests could not tell
 * which they were. The levels followed (operator, 2026-10-26): models at level
 * 62 kept level-30 quests in a full log and queried quests one by one to learn
 * their levels. The client colours its log from the same field; the line
 * prints the number and never a colour, whose grey cut-off is the client's
 * judgement against the character's level. Completion rides in the bracket,
 * so the line needs no group labels. A title not yet answered prints as the
 * bare id.
 */
function questLine(ql: NonNullable<SnapshotLike["questLog"]>): string {
  const complete = ql.filter((q) => q.complete === true);
  const open = ql.filter((q) => q.complete !== true);
  return `quests: ${[...complete, ...open].map(questEntry).join(", ")}`;
}

/** The marker over a questgiver when it has something for you now, else undefined. */
function questOffer(u: UnitLike): "available" | "reward" | undefined {
  const m = u.questGiver;
  if (m === "available" || m === "available_rep") return "available";
  if (typeof m === "string" && m.includes("reward")) return "reward";
  return undefined;
}

/** NPC roles a character acts on by walking up to them. Sub-kinds fold into their parent. */
const ACTIONABLE_ROLES = new Set(["vendor", "repair", "trainer", "flightMaster", "innkeeper", "banker"]);

function actionable(u: UnitLike): boolean {
  if (questOffer(u) !== undefined) return true;
  if (!Array.isArray(u.roles)) return false;
  return u.roles.some(
    (r) => typeof r === "string" && (ACTIONABLE_ROLES.has(r) || r.endsWith("Vendor") || r.endsWith("Trainer")),
  );
}

/**
 * Which NEARBY_CAP of the objects in view the nearby line names, nearest first
 * as before. In a town the nearest six were guards — a questgiver made the
 * line in a handful of a run's turns — so the slots go, in order: to anything
 * alive that has you targeted (the only hostility the snapshot shows); to the
 * NEARBY_NEAREST nearest, whatever they are, so a mob that has not picked you
 * yet is still in sight; to NPCs you can act on (a quest to take or hand in, a
 * vendor, trainer, flight master, innkeeper or banker); then to the rest by
 * distance. Only observed fields, no guessing at what an unflagged unit is.
 */
function pickNearby(units: readonly UnitLike[], selfGuid: string | undefined): UnitLike[] {
  if (units.length <= NEARBY_CAP) return [...units];
  const chosen = new Set<number>();
  const take = (want: (u: UnitLike, i: number) => boolean): void => {
    for (let i = 0; i < units.length && chosen.size < NEARBY_CAP; i++) {
      if (!chosen.has(i) && want(units[i]!, i)) chosen.add(i);
    }
  };
  take((u) => selfGuid !== undefined && u.dead !== true && u.targetGuid != null && String(u.targetGuid) === selfGuid);
  take((_u, i) => i < NEARBY_NEAREST);
  take(actionable);
  take(() => true);
  return [...chosen].sort((a, b) => a - b).map((i) => units[i]!);
}

/** One nearby entry: name, a rank other than normal, dead-when-known, roles with the quest marker, distance. */
function nearbyLabel(u: UnitLike): string {
  // A player's corpse has no name of its own and is dead by what it is: it is
  // named by its owner, as a client's tooltip names it.
  const corpse = u.type === "corpse";
  const name = corpse
    ? typeof u.ownerName === "string"
      ? `${u.ownerName}'s corpse`
      : "a corpse"
    : u.name != null
      ? String(u.name)
      : "(unnamed)";
  const rank = typeof u.rank === "string" && u.rank !== "normal" ? ` ${u.rank}` : "";
  const dead = u.dead === true && !corpse ? " dead" : "";
  const dist = typeof u.distance === "number" ? `${u.distance}y` : "?y";
  const offer = questOffer(u);
  const roles = fmtRoles(u.roles)
    .split(", ")
    .filter((r) => r !== "" && !(offer !== undefined && r === "quest giver"));
  if (offer !== undefined) roles.unshift(`quest giver: ${offer}`);
  return `${name}${rank}${dead} (${roles.length === 0 ? "" : `${roles.join(", ")}, `}${dist})`;
}

/**
 * Fold the "open window" state out of the raw event stream. Pure: the same
 * events (in any order — it compares seqs, not positions) give the same result.
 *
 * Only honest folds, each an event-*pair* statement about the stream rather than
 * a cached field (the state cache does not fold these opcodes): a window is open
 * iff its opening opcode's last seq is newer than its closing opcode's. Vendor
 * has no closing opcode, so it is trusted only when its SMSG_LIST_INVENTORY is
 * the most recent window event of the three — "provably most-recent-of-three".
 *
 * Window truncation only ever fails safe: an opening event cannot sit in a
 * bounded buffer while its (necessarily later, higher-seq) close is gone, so a
 * truncated buffer yields "unknown → omit", never a false "open".
 */
export function foldUiOpenWindows(
  events: readonly { opcode: string; seq: number; data?: unknown }[],
): UiOpenWindows {
  let gossipSeq = -1;
  let gossipOptions = 0;
  let gossipDoneSeq = -1;
  let lootSeq = -1;
  let lootReleaseSeq = -1;
  let vendorSeq = -1;
  for (const e of events) {
    switch (e.opcode) {
      case "SMSG_GOSSIP_MESSAGE":
        if (e.seq >= gossipSeq) {
          gossipSeq = e.seq;
          const opts = (e.data as { options?: unknown } | undefined)?.options;
          gossipOptions = Array.isArray(opts) ? opts.length : 0;
        }
        break;
      case "SMSG_GOSSIP_COMPLETE":
        if (e.seq > gossipDoneSeq) gossipDoneSeq = e.seq;
        break;
      case "SMSG_LOOT_RESPONSE": {
        // The refusal form (`error` in place of gold and items) and a decode
        // failure open nothing; counting either showed a "loot" window the
        // model then spent turns trying to close.
        const d = e.data as { error?: unknown; decodeError?: unknown } | undefined;
        if (d?.error !== undefined || d?.decodeError === true) break;
        if (e.seq > lootSeq) lootSeq = e.seq;
        break;
      }
      case "SMSG_LOOT_RELEASE_RESPONSE":
        if (e.seq > lootReleaseSeq) lootReleaseSeq = e.seq;
        break;
      case "SMSG_LIST_INVENTORY":
        if (e.seq > vendorSeq) vendorSeq = e.seq;
        break;
      default:
        break;
    }
  }
  const ui: UiOpenWindows = {};
  if (gossipSeq > -1 && gossipSeq > gossipDoneSeq) ui.gossip = { options: gossipOptions };
  if (lootSeq > -1 && lootSeq > lootReleaseSeq) ui.loot = true;
  if (
    vendorSeq > -1 &&
    vendorSeq > gossipSeq &&
    vendorSeq > gossipDoneSeq &&
    vendorSeq > lootSeq &&
    vendorSeq > lootReleaseSeq
  ) {
    ui.vendor = true;
  }
  return ui;
}

/**
 * The fixed client HUD. A 3.3.5a client always shows XP, bags, the quest
 * tracker, nameplates, the target frame and open windows; this presents those
 * observed fields as a stable, line-oriented summary.
 *
 * Two rules, both from docs/CONTRACTS.md: a field no event has carried reads
 * "unobserved" — never a guessed zero; and the nearby line never prints exact
 * mob health (the player frame on the health line is fine — those are numbers a
 * client shows for itself). Every line is a pure function of the snapshot, so
 * `assembleContext` stays byte-deterministic.
 */
/** The core's `CORPSE_RECLAIM_RADIUS`, which it measures in 3D. */
const RECLAIM_RADIUS = 39;

/** How near the release point a ghost still reads as standing at the graveyard. */
const GHOST_AT_GRAVEYARD_YARDS = 20;

/**
 * One sentence for a released ghost: where it stands, where its corpse is, and
 * the two ways back with their prices — the facts a client shows on its map
 * and in its tooltips, no more. Distances are straight-line
 * and rounded; "after Ns" is the server's own reclaim delay. The healer's
 * price is a paraphrased rule, not client text.
 */
function ghostLine(
  s: NonNullable<SnapshotLike["self"]>,
  pos: { map?: number; x?: number; y?: number; z?: number } | undefined,
  now: number,
): string {
  const xy = (p: { x?: unknown; y?: unknown } | undefined): string =>
    p !== undefined && typeof p.x === "number" && typeof p.y === "number"
      ? `${Math.round(p.x)},${Math.round(p.y)}`
      : "?,?";
  const grave = s.graveyard?.value as { x?: number; y?: number; zone?: { name?: string }; area?: { name?: string } } | undefined;
  // The graveyard's own place, as the zone text read while the ghost stood
  // on it: two graveyards a few hundred yards apart read as two places.
  const graveZone = grave?.zone?.name || undefined;
  const graveArea = grave?.area?.name || undefined;
  const gravePlace =
    graveZone === undefined
      ? ""
      : ` in ${graveArea === undefined || graveArea === graveZone ? graveZone : `${graveZone} / ${graveArea}`}`;
  const corpse = s.corpse?.value as { map?: number; x?: number; y?: number; z?: number; instanceMap?: number } | undefined;
  const delay = s.reclaimDelay?.value as { readyAt?: number } | undefined;
  // Where the ghost stands now. The release point is named as the graveyard
  // while the ghost is still at it, and beside the ghost's own position once
  // it has walked off: it is where that Spirit Healer stands.
  const here = pos !== undefined && typeof pos.x === "number" && typeof pos.y === "number" ? { x: pos.x, y: pos.y } : undefined;
  const atGrave =
    here !== undefined && grave !== undefined && typeof grave.x === "number" && typeof grave.y === "number"
      ? Math.hypot(grave.x - here.x, grave.y - here.y) <= GHOST_AT_GRAVEYARD_YARDS
      : here === undefined;
  const where =
    grave !== undefined && atGrave
      ? `ghost at graveyard (${xy(grave)})${gravePlace}`
      : here === undefined
        ? "ghost"
        : grave !== undefined
          ? `ghost at (${xy(here)}), released at graveyard (${xy(grave)})${gravePlace}`
          : `ghost at (${xy(here)})`;
  const healer = "or Spirit Healer at the graveyard (-25% durability; resurrection sickness from level 11)";
  // A corpse inside a dungeon, asked about from outside it: the position is
  // the entrance the server substitutes, and no reclaim reaches the corpse.
  if (corpse !== undefined && typeof corpse.instanceMap === "number" && pos?.map !== corpse.instanceMap) {
    return (
      `${where}; corpse inside the dungeon on map ${corpse.instanceMap}: ` +
      `walk into its portal as a ghost to come back to life at its entrance, ${healer}`
    );
  }
  let corpsePart: string;
  if (corpse === undefined) {
    corpsePart = "corpse position not observed yet (state.self.corpse)";
  } else if (pos !== undefined && typeof pos.map === "number" && typeof corpse.map === "number" && corpse.map !== pos.map) {
    corpsePart = `corpse on map ${corpse.map} at (${xy(corpse)}), you are on map ${pos.map}`;
  } else {
    const across =
      pos !== undefined && typeof pos.x === "number" && typeof pos.y === "number" && typeof corpse.x === "number" && typeof corpse.y === "number"
        ? Math.hypot(corpse.x - pos.x, corpse.y - pos.y)
        : undefined;
    // The server measures the reclaim range with the height in it: a ghost on
    // a cliff over its corpse is told the height when that is what puts it out.
    const dz = across !== undefined && typeof pos?.z === "number" && typeof corpse.z === "number" ? pos.z - corpse.z : undefined;
    const height =
      across !== undefined && dz !== undefined && across <= RECLAIM_RADIUS && Math.hypot(across, dz) > RECLAIM_RADIUS
        ? `and ${Math.round(Math.abs(dz))}y ${dz > 0 ? "below" : "above"} you `
        : "";
    const d = across === undefined ? "" : `${Math.round(across)}y away ${height}`;
    corpsePart = `corpse ${d}at (${xy(corpse)})`;
  }
  const secs = typeof delay?.readyAt === "number" ? Math.max(0, Math.ceil((delay.readyAt - now) / 1000)) : undefined;
  const when = secs === undefined ? "after the reclaim delay" : secs === 0 ? "now" : `after ${secs}s`;
  return `${where}; ${corpsePart}: reclaim within ${RECLAIM_RADIUS}y ${when} (no sickness), ${healer}`;
}

/**
 * "Elwynn Forest / Northshire Valley, Eastern Kingdoms (open world) — " from
 * `self.zone` / `self.area`, the names the game's own zone text shows (the
 * zone alone when the subzone is the zone), then the map's `Map.dbc` name and
 * kind (`fmtMap`); empty when none has been observed (the ids ride in the SDK
 * state).
 */
function fmtPlace(s: NonNullable<SnapshotLike["self"]>, posMap: number | undefined): string {
  const zone = s.zone?.value as { id?: number; name?: string } | undefined;
  const area = s.area?.value as { id?: number; name?: string } | undefined;
  const zoneName = zone?.name ? String(zone.name) : undefined;
  const areaName = area?.name ? String(area.name) : undefined;
  const place =
    zoneName === undefined
      ? areaName
      : areaName === undefined || areaName === zoneName
        ? zoneName
        : `${zoneName} / ${areaName}`;
  const parts = [place, fmtMap(s, posMap)].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? "" : `${parts.join(", ")} — `;
}

/** `Map.dbc`'s `InstanceType` in the words the HUD uses for it. */
const MAP_KIND: Readonly<Record<string, string>> = {
  none: "open world",
  party: "dungeon instance",
  raid: "raid instance",
  pvp: "battleground",
  arena: "arena",
};

/** "Deadmines (dungeon instance)": a map's `Map.dbc` name and its kind, the kind left out when unknown. */
function mapLabel(name: string, instanceType: unknown): string {
  const kind = typeof instanceType === "string" ? MAP_KIND[instanceType] : undefined;
  return kind === undefined ? name : `${name} (${kind})`;
}

/**
 * "Eastern Kingdoms (open world)": the client's `Map.dbc` name and kind for
 * the map the character is on, so a zone that spans both sides of a portal
 * (The Deadmines is area 1581 in the quarry outside on map 0 and inside on
 * map 36) never reads as inside. Undefined while `self.map` is unobserved or
 * names another map than the position's (the window between a transfer and
 * the new map's `WB_AREA`).
 */
function fmtMap(s: NonNullable<SnapshotLike["self"]>, posMap: number | undefined): string | undefined {
  const map = s.map?.value as { id?: number; name?: string; instanceType?: string } | undefined;
  if (map === undefined || typeof map.name !== "string" || map.id !== posMap) return undefined;
  return mapLabel(map.name, map.instanceType);
}

/** How many portals the portals line names, nearest first. */
const PORTAL_LINE_MAX = 3;

/**
 * "portals: into Deadmines (dungeon instance, map 36) at (-11208, 1685, 26),
 * 11y away" — the map-transition portals in view (`self.portals`, the
 * module's `WB_PORTALS`), nearest first: where each stands and the map it
 * leads to. Undefined when none is in view or none was reported.
 */
function portalLine(
  s: NonNullable<SnapshotLike["self"]>,
  pos: { map?: number; x?: number; y?: number; z?: number } | undefined,
): string | undefined {
  const list = s.portals?.value;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  type PortalLike = { map?: number; x?: number; y?: number; z?: number; to?: { id?: number; name?: string; instanceType?: string } };
  const rows = (list as PortalLike[])
    .filter((p) => typeof p.x === "number" && typeof p.y === "number" && (pos?.map === undefined || p.map === pos.map))
    .map((p) => {
      const d =
        pos !== undefined && typeof pos.x === "number" && typeof pos.y === "number"
          ? Math.hypot(p.x! - pos.x, p.y! - pos.y)
          : undefined;
      return { p, d };
    })
    .sort((a, b) => (a.d ?? 0) - (b.d ?? 0));
  if (rows.length === 0) return undefined;
  const one = ({ p, d }: { p: PortalLike; d: number | undefined }): string => {
    const to = p.to ?? {};
    const kind = typeof to.instanceType === "string" ? MAP_KIND[to.instanceType] : undefined;
    const into = to.instanceType !== undefined && to.instanceType !== "none" ? "into" : "to";
    const named = typeof to.name === "string" ? `${to.name} (${kind === undefined ? "" : `${kind}, `}map ${fmt(to.id)})` : `map ${fmt(to.id)}`;
    const z = typeof p.z === "number" ? `, ${Math.round(p.z)}` : "";
    const away = d === undefined ? "" : `, ${Math.round(d)}y away`;
    return `${into} ${named} at (${Math.round(p.x!)}, ${Math.round(p.y!)}${z})${away}`;
  };
  const shown = rows.slice(0, PORTAL_LINE_MAX).map(one).join("; ");
  const more = rows.length > PORTAL_LINE_MAX ? ` +${rows.length - PORTAL_LINE_MAX} more` : "";
  return `portals: ${shown}${more}`;
}

/** "62%": health over max, rounded; undefined unless both are numbers and max is not 0. */
function pct(health: unknown, max: unknown): string | undefined {
  return typeof health === "number" && typeof max === "number" && max > 0 ? `${Math.round((100 * health) / max)}%` : undefined;
}

/** A unit's raw `powerType` as the party frame's bar names it (the SDK's `PartyPowerType` words). */
const POWER_NAMES: Readonly<Record<number, string>> = { 0: "mana", 1: "rage", 2: "focus", 3: "energy", 6: "runic power" };

/** "40% mana": power over max, named by its type ("power" when the type is unknown); undefined without both numbers. */
function powerPct(power: unknown, max: unknown, type: unknown): string | undefined {
  const p = pct(power, max);
  if (p === undefined) return undefined;
  const named = typeof type === "string" ? type : typeof type === "number" ? POWER_NAMES[type] : undefined;
  return `${p} ${named ?? "power"}`;
}

/**
 * "party: Brannoc ghost, Westfall (-10546, 1197), out of view; Ysolde alive
 * 87% 40% mana 14y; Corwin offline" — the party frames: each other member's
 * state, its health and power while alive (health bare, power named), and
 * where it is. No auras: those stay in `group().members[i].stats`. A member
 * in view is read off its unit, as the frame reads it, with its distance; one
 * out of view off the party frame the server sends for it (`stats`): its zone
 * and the x, y the packet carries, which names no map, so no distance is
 * worked out from it. Undefined outside a group.
 */
/**
 * One party member's state as its frame reads it: offline, or alive, dead or a
 * ghost, read off its unit while in view and off the party frame the server
 * sends (`stats`) otherwise. Undefined when neither has said. Shared by the
 * HUD's party line and the snippet delta (`sandbox/snippet-delta.ts`), so the
 * two never disagree about a member.
 */
export function memberState(m: GroupMemberLike, unit: UnitLike | undefined): "offline" | "alive" | "dead" | "ghost" | undefined {
  const st = m.stats;
  if (m.online === false || st?.online === false) return "offline";
  if (unit !== undefined) return unit.ghost === true ? "ghost" : unit.dead === true ? "dead" : "alive";
  if (st === undefined) return undefined;
  const known = st.ghost !== undefined || st.dead !== undefined || st.health !== undefined;
  return st.ghost === true ? "ghost" : st.dead === true ? "dead" : known ? "alive" : undefined;
}

function partyLine(snapshot: SnapshotLike): string | undefined {
  const g = snapshot.group;
  if (g?.inGroup !== true || !Array.isArray(g.members) || g.members.length === 0) return undefined;
  const units = snapshot.units ?? [];
  const one = (m: GroupMemberLike): string => {
    const name = fmt(m.name, "?");
    const st = m.stats;
    const u = units.find((x) => x.guid === m.guid);
    const state = memberState(m, u);
    if (state === "offline") return `${name} offline`;
    if (u !== undefined) {
      const hp = state === "alive" ? pct(u.health, u.maxHealth) : undefined;
      const mp = state === "alive" ? powerPct(u.power, u.maxPower, u.powerType) : undefined;
      const d = typeof u.distance === "number" ? `${Math.round(u.distance)}y` : undefined;
      return [name, state, hp, mp, d].filter((p) => p !== undefined).join(" ");
    }
    if (st === undefined) return `${name} out of view`;
    const hp = state === "alive" ? pct(st.health, st.maxHealth) : undefined;
    const mp = state === "alive" ? powerPct(st.power, st.maxPower, st.powerType) : undefined;
    const head = [name, state, hp, mp].filter((p) => p !== undefined).join(" ");
    const zone = typeof st.zone?.name === "string" && st.zone.name !== "" ? st.zone.name : st.zone?.id !== undefined ? `zone ${fmt(st.zone.id)}` : undefined;
    const xy = typeof st.position?.x === "number" && typeof st.position?.y === "number" ? `(${st.position.x}, ${st.position.y})` : undefined;
    const where = [zone, xy].filter((p) => p !== undefined).join(" ");
    return `${head}, ${where === "" ? "" : `${where}, `}out of view`;
  };
  return `party: ${g.members.map(one).join("; ")}`;
}

/**
 * Roles as the nearby line shows them: the SDK's role words spaced out
 * ("questGiver" → "quest giver"), `gossip` dropped (nearly every NPC has it and
 * it says nothing about what the NPC is for), and sub-kinds folded into their
 * parent (a `foodVendor` is shown as `vendor`; a `classTrainer` as `trainer`).
 * Role words only, never a recommendation.
 */
export function fmtRoles(roles: unknown): string {
  if (!Array.isArray(roles)) return "";
  const words: string[] = [];
  for (const r of roles) {
    if (typeof r !== "string" || r === "gossip") continue;
    const parent = r.endsWith("Vendor") ? "vendor" : r.endsWith("Trainer") ? "trainer" : r;
    const word = parent.replace(/([A-Z])/g, (m) => ` ${m.toLowerCase()}`);
    if (!words.includes(word)) words.push(word);
  }
  return words.join(", ");
}

export function formatStateSummary(
  snapshot: SnapshotLike | null,
  o: { sessionLive: boolean; /** Wall clock for the reclaim countdown; tests pin it. */ now?: number },
): string {
  if (snapshot === null) {
    return "== state ==\nno sandbox state yet (no snippet has connected a session)";
  }
  const s = snapshot.self ?? {};
  const pos = s.position?.value as { map?: number; x?: number; y?: number; z?: number } | undefined;
  const lines: string[] = [];

  // header + session + character + position
  lines.push(`== state (seq ${snapshot.lastSeq ?? -1}, ${snapshot.eventCount ?? 0} events seen) ==`);
  lines.push(`session: ${o.sessionLive ? "in world" : "not established"}`);
  lines.push(`character: ${fmt(s.name, "none")} (guid ${fmt(s.guid, "?")}) level ${fmt(s.level?.value)}`);
  // In flight the position is the take-off point (the SDK marks it): the
  // zone text follows the flight, the coordinates do not.
  const landsAt = (s.taxiEta?.value as { landsAt?: number } | undefined)?.landsAt;
  const landsIn =
    typeof landsAt === "number" ? `, lands in ~${Math.max(0, Math.round((landsAt - (o.now ?? Date.now())) / 1000))}s` : "";
  lines.push(
    pos === undefined
      ? "position: unobserved"
      : (pos as { inFlight?: unknown }).inFlight === true
        ? `position: in flight${fmtPlace(s, pos.map) === "" ? ", " : ` over ${fmtPlace(s, pos.map)}`}took off from map ${fmt(pos.map)} (${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)})${landsIn} [seq ${fmt(s.position?.seq, "?")}]`
        : `position: ${fmtPlace(s, pos.map)}map ${fmt(pos.map)} (${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)}) [seq ${fmt(s.position?.seq, "?")}]`,
  );

  // home: the hearthstone's destination, as the server last said it. The
  // area name is what a client shows for the bind ("Your home is now
  // Ironforge"); the position is the same packet's, so a snippet can plan
  // a hearth as a real connector rather than a guess.
  const home = s.bindPoint?.value as { map?: number; x?: number; y?: number; z?: number; area?: { id?: number; name?: string } } | undefined;
  if (home !== undefined) {
    const areaName = home.area?.name ? String(home.area.name) : undefined;
    lines.push(
      `home: ${areaName === undefined ? "" : `${areaName} — `}map ${fmt(home.map)} (${fmt(home.x)}, ${fmt(home.y)}, ${fmt(home.z)}) [Hearthstone destination]`,
    );
  }

  // portals — the dungeon entrances and exits in view, which no unit or
  // game object names; the line is absent when none is
  const portals = portalLine(s, pos);
  if (portals !== undefined) lines.push(portals);

  // health / power (self only — the player frame is numbers)
  lines.push(`health: ${fmtGauge(s.health)}  power: ${fmtGauge(s.power)}`);
  // auras — the buff and debuff bar beside the player frame
  const auras = auraLine(snapshot.selfAuras, o.now ?? Date.now());
  if (auras !== undefined) lines.push(auras);
  // party — the party frames under the player frame; absent outside a group
  const party = partyLine(snapshot);
  if (party !== undefined) lines.push(party);

  // xp / money
  const money = snapshot.money?.value;
  const moneyStr = money === undefined || money === null ? "unobserved" : `${fmt(money)} copper`;
  lines.push(`xp: ${fmt(snapshot.xp?.value)} / ${fmt(snapshot.nextLevelXp?.value)}     money: ${moneyStr}`);

  // bag
  lines.push(snapshot.bag === undefined ? "bag: unobserved" : bagLine(snapshot.bag));
  // durability — only when something worn is broken or low; the ordinary
  // case costs no line
  const worn = durabilityLine(snapshot.inventory);
  if (worn !== undefined) lines.push(worn);

  // quests — the log's ids, completion bits and titles, as the client's quest
  // log shows them; never a wiki lookup
  const ql = snapshot.questLog;
  if (ql === undefined) {
    lines.push("quests: unobserved");
  } else if (ql.length === 0) {
    lines.push("quests: none");
  } else {
    lines.push(questLine(ql));
  }

  // achievements — count and points only. The full list is tens of lines of
  // prompt every turn for something a snippet can read
  // (`state.self.achievements`), and the ids are on the trajectory. Unobserved
  // when no achievement packet has arrived: a zero here would be a guess, and a
  // run on a worldserver that predates achievement tracking never sees one.
  const ach = s.achievements;
  if (ach === undefined) {
    lines.push("achievements: unobserved");
  } else {
    const n = ach.entries?.length ?? 0;
    const pts = typeof ach.points === "number" ? ach.points : 0;
    lines.push(`achievements: ${n} (${pts} pts)`);
  }

  // target
  const targetGuid = s.targetGuid?.value;
  if (targetGuid === undefined || targetGuid === null || targetGuid === "0") {
    lines.push("target: none");
  } else {
    const unit = (snapshot.units ?? []).find((u) => u.guid === targetGuid);
    const name = unit?.name != null ? String(unit.name) : "unknown";
    lines.push(`target: ${name} (guid ${String(targetGuid)})`);
  }

  // nearby — from state.units() semantics (nearest first, items/containers
  // dropped by the sandbox), which six by `pickNearby`. Name + roles + distance
  // + dead-when-known; never mob health.
  const units = snapshot.units;
  if (units === undefined) {
    lines.push("nearby: unobserved");
  } else if (units.length === 0) {
    lines.push("nearby: none");
  } else {
    const selfGuid = s.guid === undefined || s.guid === null ? undefined : String(s.guid);
    const shown = pickNearby(units, selfGuid);
    let nearbyStr = shown.map(nearbyLabel).join(", ");
    if (units.length > shown.length) nearbyStr += ` +${units.length - shown.length} more`;
    lines.push(`nearby: ${nearbyStr}`);
  }

  // ui — honest open-window folds only; the whole line is omitted when none hold
  const uiParts: string[] = [];
  const ui = snapshot.ui;
  if (ui?.gossip) uiParts.push(`gossip (${ui.gossip.options} options)`);
  if (ui?.loot) uiParts.push("loot");
  if (ui?.vendor) uiParts.push("vendor");
  const healthVal = s.health?.value as { current?: unknown } | null | undefined;
  if (healthVal != null && typeof healthVal === "object" && healthVal.current === 0) uiParts.push("dead");
  const playerFlags = s.fields?.["playerFlags"]?.value;
  const isGhost = typeof playerFlags === "number" && (playerFlags & PLAYER_FLAGS_GHOST) !== 0;
  if (isGhost) uiParts.push("ghost");
  // The client's own resting icon, as the SDK decoded it off `playerFlags`.
  // Printed only when it is true: "not resting" is the ordinary case and
  // costs a token every turn to say, and an unobserved flag would have to be
  // distinguished from a false one for the negative to be honest at all.
  if (s.resting?.value === true) uiParts.push("resting");
  if (uiParts.length > 0) lines.push(`ui: ${uiParts.join(" | ")}`);
  if (isGhost) lines.push(ghostLine(s, pos, o.now ?? Date.now()));

  // stream
  const gaps = snapshot.gaps?.length ?? 0;
  lines.push(gaps === 0 ? "stream: continuous" : `stream: ${gaps} gap(s) — some events were missed`);

  // chat / notification tails (kept as before)
  const chat = chatTail(snapshot.chat ?? []);
  if (chat.length > 0) {
    lines.push(`recent chat (${chat.length}):`);
    for (const c of chat) lines.push(formatChatLine(c, snapshot.names));
  }
  const notes = (snapshot.notifications ?? []).slice(-CONTEXT_POLICY.NOTIFICATION_TAIL);
  if (notes.length > 0) {
    lines.push(`recent notifications (${notes.length}):`);
    for (const n of notes) lines.push(`  ${fmt(n.text, "")}`);
  }
  return lines.join("\n");
}

// -------------------------------------------------------- context assembly

export interface ContextInputs {
  stateSummary: string;
  /** Oldest first; ambient ones are excluded, then the last EVENT_WINDOW of the rest rendered (`eventWindow`). */
  events: EventSummary[];
  /**
   * Ambient events already folded out before `events` was fetched, in the span
   * `events` covers — the sandbox's own count (`contextEvents`). Added to
   * whatever `eventWindow` folds out of `events` itself. Absent means none.
   */
  folded?: number;
  scratchpad: string;
  notices: HarnessNotice[];
  /** Model turn number, for the model's own orientation. */
  turn: number;
}

/**
 * The client-visible sentence for an inventory refusal, appended to the raw
 * event line. The packet carries only a number, and a run was observed
 * reverse-engineering "reason 60" into "in combat" from context; the number
 * still renders verbatim inside the payload, so this only
 * names what the client would have shown. Nothing else is added — no advice.
 */
function eventLineNote(e: EventSummary): string {
  if (e.note !== undefined) return ` — ${e.note}`;
  if (e.opcode !== "SMSG_INVENTORY_CHANGE_FAILURE") return "";
  const result = (e.data as { result?: unknown } | undefined)?.result;
  if (typeof result !== "number") return "";
  const named = inventoryResultText(result);
  return named === undefined ? "" : ` — ${named}`;
}

export function formatEventLine(e: EventSummary): string {
  const schema = e.schemaError !== undefined ? " [schema mismatch]" : "";
  // A stream_gap is synthetic and carries the NEXT real event's seq; rendering
  // that number made it look like a duplicate. Mark it as the gap it is.
  const tag = e.opcode === "stream_gap" ? "#gap" : `#${e.seq}`;
  return `${tag} ${e.opcode}${schema} ${compactJson(e.data, CONTEXT_POLICY.EVENT_DATA_CHARS)}${eventLineNote(e)}`;
}

/**
 * The events a turn's context renders and how many ambient events the span
 * they cover held: ambient opcodes excluded, then the last EVENT_WINDOW of what
 * remains. Pure; the loop logs exactly this as the turn's `events_served`.
 * A spell combat-log line marked `bystander` (`spellLogShown`) is left out
 * too, and not counted as ambient: it is not movement and the cache does not
 * fold it.
 */
export function eventWindow(events: readonly EventSummary[], folded = 0): { window: EventSummary[]; folded: number } {
  const ambient = events.filter((e) => CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(e.opcode)).length;
  const eligible = events.filter((e) => !CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(e.opcode) && e.bystander !== true);
  return {
    window: eligible.slice(-CONTEXT_POLICY.EVENT_WINDOW),
    folded: folded + ambient,
  };
}

// ------------------------------------------------------ spell combat log

/** The direct-spell combat-log opcodes (module/PROTOCOL.md, "Spell combat log"). */
export const SPELL_LOG_OPCODES: ReadonlySet<string> = new Set([
  "SMSG_SPELLNONMELEEDAMAGELOG",
  "SMSG_SPELLHEALLOG",
  "SMSG_SPELLENERGIZELOG",
]);

interface SpellLogData {
  targetGuid?: unknown;
  casterGuid?: unknown;
  spellId?: unknown;
  name?: unknown;
  damage?: unknown;
  amount?: unknown;
  overkill?: unknown;
  overheal?: unknown;
  schoolMask?: unknown;
  absorb?: unknown;
  resist?: unknown;
  blocked?: unknown;
  powerType?: unknown;
  crit?: unknown;
}

/**
 * Whether a spell combat-log line belongs in the event window. The core sends
 * these to every client in range, so in a party fight five members' spells
 * and heals, and every caster mob's, would otherwise turn the 64-event window
 * over in seconds. Kept: any line we cast or are the target of, and a damage
 * line whose target is a party member (a member being hit is what a healer or
 * a tank reacts to). Left out: other units' heals and power gains, and damage
 * that lands on anyone outside the party. Every other opcode is shown.
 */
export function spellLogShown(
  opcode: string,
  data: unknown,
  selfGuid: string | undefined,
  partyGuids: ReadonlySet<string>,
): boolean {
  if (!SPELL_LOG_OPCODES.has(opcode)) return true;
  const d = (data ?? {}) as SpellLogData;
  if (selfGuid !== undefined && (d.casterGuid === selfGuid || d.targetGuid === selfGuid)) return true;
  return opcode === "SMSG_SPELLNONMELEEDAMAGELOG" && typeof d.targetGuid === "string" && partyGuids.has(d.targetGuid);
}

/** `SpellSchoolMask` bits, in the client's order. */
const SCHOOL_NAMES = ["physical", "holy", "fire", "nature", "frost", "shadow", "arcane"] as const;

function schoolName(mask: unknown): string | undefined {
  if (typeof mask !== "number" || mask <= 0) return undefined;
  const names = SCHOOL_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
  return names.length > 0 ? names.join("+") : `school ${mask}`;
}

const logNumber = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * The sentence a client's combat log prints for one direct spell hit, heal or
 * power gain, from the event and the names in view as it arrived: "Defias
 * Evoker's Fireball hits you for 54 (fire)". `nameOf` answers a unit's name
 * when one has been observed. Undefined for every other opcode. Wording only:
 * every number is the wire's, and the raw payload stays on the line.
 */
export function spellLogNote(
  opcode: string,
  data: unknown,
  selfGuid: string | undefined,
  nameOf: (guid: string) => string | undefined,
): string | undefined {
  if (!SPELL_LOG_OPCODES.has(opcode)) return undefined;
  const d = (data ?? {}) as SpellLogData;
  const isSelf = (g: unknown): boolean => selfGuid !== undefined && g === selfGuid;
  const named = (g: unknown): string | undefined => (typeof g === "string" ? nameOf(g) : undefined);
  const spell = typeof d.name === "string" && d.name !== "" ? d.name : `spell ${String(d.spellId)}`;
  const caster = isSelf(d.casterGuid) ? "Your" : `${named(d.casterGuid) ?? "An unnamed unit"}'s`;
  const target = isSelf(d.targetGuid) ? "you" : (named(d.targetGuid) ?? "an unnamed unit");
  const extras = (parts: [number, string][]): string[] =>
    parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const paren = (tail: string[]): string => (tail.length > 0 ? ` (${tail.join(", ")})` : "");
  if (opcode === "SMSG_SPELLNONMELEEDAMAGELOG") {
    const school = schoolName(d.schoolMask);
    const tail = [
      ...(school === undefined ? [] : [school]),
      ...extras([
        [logNumber(d.absorb), "absorbed"],
        [logNumber(d.resist), "resisted"],
        [logNumber(d.blocked), "blocked"],
        [logNumber(d.overkill), "overkill"],
      ]),
    ];
    const verb = d.crit === true ? "crits" : "hits";
    return `${caster} ${spell} ${verb} ${target} for ${logNumber(d.damage)}${paren(tail)}`;
  }
  if (opcode === "SMSG_SPELLHEALLOG") {
    const tail = extras([
      [logNumber(d.overheal), "overheal"],
      [logNumber(d.absorb), "absorbed"],
    ]);
    const verb = d.crit === true ? "critically heals" : "heals";
    return `${caster} ${spell} ${verb} ${target} for ${logNumber(d.amount)}${paren(tail)}`;
  }
  const power = typeof d.powerType === "number" ? (POWER_NAMES[d.powerType] ?? `power ${d.powerType}`) : "power";
  return `${caster} ${spell} gives ${target} ${logNumber(d.amount)} ${power}`;
}

/** Pure. Same inputs, byte-identical output — tests enforce it. */
export function assembleContext(inputs: ContextInputs): string {
  const parts: string[] = [];
  // The turn number alone. The run's directive — the broad goal, or the
  // operator objective that replaces it — is the system prompt's, rendered at
  // one fixed place (docs/METHODOLOGY.md, "Steering is what makes a run
  // unscored"); a per-turn restatement named a statistic the broad goal
  // never names and contradicted every objective (issue #285, operator
  // 2026-10-23). The `[turn N]` prefix is parsed back (`codex-rollout.ts`).
  parts.push(`[turn ${inputs.turn}]`);

  if (inputs.notices.length > 0) {
    parts.push(
      `[harness notices]\n${inputs.notices.map((n) => `- ${n.kind}: ${n.text}`).join("\n")}`,
    );
  }

  parts.push(inputs.stateSummary);

  const { window, folded: excluded } = eventWindow(inputs.events, inputs.folded ?? 0);
  if (inputs.events.length === 0 && excluded === 0) {
    parts.push("[events]\nnone yet");
  } else if (window.length === 0) {
    // Everything fetched was ambient: say so, rather than "none yet" over a
    // stream that is plainly running.
    parts.push(`[events]\nno non-ambient events; ${excluded} ambient movement and party-frame events folded into state only`);
  } else {
    const note = excluded > 0 ? `; ${excluded} ambient movement and party-frame events folded into state only` : "";
    parts.push(
      `[events: last ${window.length}, newest last${note}]\n${window.map(formatEventLine).join("\n")}`,
    );
  }

  // The size against the cap, every turn: a write past the cap is refused
  // (scratchpad.ts), and a model should see the wall before it walks into it.
  parts.push(
    inputs.scratchpad.trim().length === 0
      ? "[scratchpad]\n(empty — write your plan and durable facts with write_scratchpad)"
      : `[scratchpad ${scratchpadSizeLabel(inputs.scratchpad.length)}]\n${inputs.scratchpad}`,
  );

  return parts.join("\n\n");
}

// --------------------------------------------------------- message window

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * A message as the loop's history stores it: a `ChatMessage`, and on a tool
 * result whether it was an error — the `isError` its result record carries,
 * which the fold's line states. Never sent: every message leaves the window
 * through `windowMessage`, which drops it.
 */
export type HistoryMessage = ChatMessage & { isError?: boolean };

/**
 * The index into the full history at which the model-visible window starts.
 *
 * Pure in `history.length` and the message roles, and monotone non-decreasing
 * as history grows — that is what makes the sent prefix byte-stable within a
 * block. The raw cut moves in whole blocks of MESSAGE_WINDOW_TRIM, only once
 * the window would exceed MESSAGE_WINDOW_MAX (a `while`, not an `if`: one turn
 * appends an assistant message plus all of its tool results at once, so the
 * length can jump past several blocks on resume-shaped histories).
 *
 * The cut is then snapped *forward* to the next assistant message so an
 * assistant tool-call is never separated from its tool results. Snapping only
 * ever shortens the window, so the cap still holds; and because the raw cut is
 * constant within a block, the snapped cut is too.
 *
 * Computed over the whole stored history rather than over the previously
 * trimmed window on purpose: snapping shortens the window, which would delay
 * the next trim and drift the boundaries away from the block grid, so an
 * incrementally trimmed window and a rebuilt one would disagree.
 */
export function messageWindowCut(history: readonly ChatMessage[]): number {
  let cut = messageWindowRawCut(laggedLength(history));
  while (cut < history.length && history[cut]!.role !== "assistant") cut++;
  return cut;
}

/**
 * The history length as of the start of the previous turn: the current length
 * minus what that turn appended.
 *
 * The raw cut is taken here rather than at `history.length` so that the trim
 * lags one turn behind the crossing. That lag is what makes the pre-trim prompt
 * *exact* (docs/METHODOLOGY.md, "An episodic log, asked for at each trim":
 * the harness asks for a status entry on the last turn before a block-trim).
 * Predicting the crossing forward is impossible — a turn's message count is not
 * known until the model has answered it — but once the answer is in the history
 * the crossing is a fact, so the harness announces the trim on the turn after
 * the crossing and applies it on the turn after that.
 *
 * The cost is bounded and small: the window is `length - rawCut(previous
 * length)`, and the previous length was itself within the ceiling, so the
 * window exceeds MESSAGE_WINDOW_MAX by at most one turn's growth, for exactly
 * one turn per block. The prefix stays byte-stable — the cut is still a step
 * function moving in whole blocks, still monotone non-decreasing (the lagged
 * length is), and still a pure function of the stored history, so a rebuilt
 * history cuts identically.
 */
function laggedLength(history: readonly ChatMessage[]): number {
  return history.length - lastTurnGrowth(history);
}

/**
 * The raw block cut for a history of `len` messages, before the snap forward to
 * an assistant boundary. A pure function of the length alone, which is what
 * makes the *next* trim predictable at all.
 */
export function messageWindowRawCut(len: number): number {
  const { MESSAGE_WINDOW_MAX, MESSAGE_WINDOW_TRIM } = CONTEXT_POLICY;
  let cut = 0;
  while (len - cut > MESSAGE_WINDOW_MAX) cut += MESSAGE_WINDOW_TRIM;
  return cut;
}

/**
 * How many messages the previous turn appended: the assistant message plus its
 * tool results, counted back from the end. One when there is no assistant
 * message yet — the floor a turn can possibly add.
 *
 * A pure function of the history, so a rebuilt history predicts identically.
 */
export function lastTurnGrowth(history: readonly ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "assistant") return history.length - i;
  }
  return 1;
}

/**
 * Whether the block trim lands at the end of this turn. Exact, not an estimate.
 *
 * True on the turn whose *previous* turn took the history across a block
 * boundary. Because `messageWindowCut` lags by the same one turn
 * (`laggedLength`), this turn still sees the un-trimmed window and the next one
 * sees the trim — so every block-trim is preceded by exactly one such turn,
 * whatever the model's per-turn message count does. Nothing here predicts a
 * turn that has not happened yet.
 */
export function trimExpected(history: readonly ChatMessage[]): boolean {
  return messageWindowRawCut(history.length) > messageWindowRawCut(laggedLength(history));
}

/**
 * Cap one message's content at WINDOW_MESSAGE_CHARS with a fixed suffix.
 * Deterministic: the suffix carries only the number of characters dropped.
 *
 * `max` is a parameter only so a replay can apply the cap a trajectory
 * recorded rather than this build's (`request-record.ts`); the loop always
 * takes the default.
 */
export function capWindowMessage(m: ChatMessage, max: number = CONTEXT_POLICY.WINDOW_MESSAGE_CHARS): ChatMessage {
  if (typeof m.content !== "string" || m.content.length <= max) return m;
  const dropped = m.content.length - max;
  return { ...m, content: `${m.content.slice(0, max)}\n…[truncated ${dropped} chars]` };
}

/**
 * Where the folded part of the window ends: an index into the full history,
 * never below `messageWindowCut`. Messages in `[cut, fold)` have their tool
 * results folded (`foldToolResult`); from `fold` on the window is verbatim.
 * Pure in the stored history, like the cut.
 *
 * Nothing folds before the first trim. After it, the boundary is the raw cut
 * plus one MESSAGE_WINDOW_TRIM — the block the next trim will drop — snapped
 * *back* to the assistant message that opens its turn, so a turn is folded
 * whole or not at all. Both halves of the choice are load-bearing:
 *
 * - It is a step function of the raw cut, so it moves only on the request the
 *   cut moves on. Between trims the folded messages are the same messages
 *   rendered the same way and the verbatim ones are only appended to: the
 *   request is byte-stable to the end of the window, as it is without the
 *   fold, and the fold pays no cache miss of its own.
 * - Snapping back keeps the last two turns verbatim on every request. The raw
 *   cut of the lagged length `L` leaves more than MESSAGE_WINDOW_TRIM messages
 *   above it once it is past zero (`messageWindowRawCut` stops at the first
 *   multiple that fits), so `rawCut + TRIM < L`: the boundary lies inside the
 *   turn before last or earlier, and snapping back to that turn's start folds
 *   nothing of it or after it. So a result is full text on the request it
 *   arrives in and on the one after, whatever the turn sizes — a hint the
 *   model is meant to act on is never folded before it has been read twice.
 */
export function messageWindowFold(history: readonly ChatMessage[]): number {
  const raw = messageWindowRawCut(laggedLength(history));
  const cut = messageWindowCut(history);
  if (raw === 0) return cut;
  let fold = Math.min(raw + CONTEXT_POLICY.MESSAGE_WINDOW_TRIM, history.length);
  while (fold > cut && history[fold]?.role !== "assistant") fold--;
  return Math.max(fold, cut);
}

/**
 * A tool result's folded line. Deterministic, and a function of the call and
 * the result alone:
 *
 *   [folded by harness] <tool> <args>: <ok|error>[, <n>ms], <m> chars
 *
 * `<args>` is the call's argument string as the model sent it, every run of
 * whitespace made one space, cut at FOLD_ARGS_CHARS with "…"; `<n>ms` is the
 * duration a snippet result opens with (`ok (12ms)`), absent for every other
 * tool, which reports none; `<m>` is the length of the whole result. The
 * marker says the harness wrote the line, so it never reads as the tool's own
 * output. The call itself is not touched: it stays in the window as it was
 * sent.
 */
export function foldToolResult(call: { name: string; arguments: string } | undefined, m: HistoryMessage): ChatMessage {
  const max = CONTEXT_POLICY.FOLD_ARGS_CHARS;
  const text = typeof m.content === "string" ? m.content : "";
  const flat = (call?.arguments ?? "").replace(/\s+/g, " ").trim();
  const args = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  const duration = call?.name === "run_snippet" ? /^(?:ok|error) \((\d+)ms\)/.exec(text)?.[1] : undefined;
  const line =
    `[folded by harness] ${call?.name ?? "?"}${args.length > 0 ? ` ${args}` : ""}: ` +
    `${m.isError === true ? "error" : "ok"}${duration !== undefined ? `, ${duration}ms` : ""}, ${text.length} chars`;
  return { ...windowMessage(m), content: line };
}

/** A history message as it is sent: everything but the history's own `isError`. */
function windowMessage(m: HistoryMessage): ChatMessage {
  if (!("isError" in m)) return m;
  const { isError: _isError, ...sent } = m;
  return sent;
}

/**
 * A window as it is sent: the tool results among its first `fold` messages
 * folded, every other message capped, and nothing but `ChatMessage` fields.
 * The one rendering the loop, the writer's self-check and the replay share.
 *
 * A tool result is matched to its call by position after the assistant
 * message it follows, the way the loop answers calls — never by
 * `tool_call_id`, which an adapter may leave empty or repeat. A window opens
 * on an assistant message, as every cut does.
 */
export function renderWindow(
  window: readonly HistoryMessage[],
  fold: number,
  cap: number = CONTEXT_POLICY.WINDOW_MESSAGE_CHARS,
): ChatMessage[] {
  let calls: readonly { function: { name: string; arguments: string } }[] = [];
  let answered = 0;
  return window.map((m, i) => {
    if (m.role === "assistant") {
      calls = m.tool_calls ?? [];
      answered = 0;
    } else if (m.role === "tool") {
      const call = calls[answered++]?.function;
      if (i < fold) return foldToolResult(call, m);
    }
    return capWindowMessage(windowMessage(m), cap);
  });
}

/**
 * The model-visible message window for a full history. Pure.
 *
 * The cap and the fold are applied here, on the way out, rather than to the
 * stored history: the trajectory records tool results in full, so shaping
 * them at push time would leave the in-memory history holding different bytes
 * than a history rebuilt from the log, and the two would stop windowing
 * identically.
 */
export function messageWindow(history: readonly HistoryMessage[]): ChatMessage[] {
  const cut = messageWindowCut(history);
  return renderWindow(history.slice(cut), messageWindowFold(history) - cut);
}
