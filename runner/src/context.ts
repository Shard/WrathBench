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
 *       goal line, harness notices, state summary, last EVENT_WINDOW events,
 *       scratchpad ]
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

import { compactJson } from "./jsonsafe";
import { scratchpadSizeLabel } from "./scratchpad";
import type { EventSummary, MoveIntentNote } from "./sandbox/ipc";
import type { HarnessNotice } from "./sandbox/host";

export const CONTEXT_POLICY = {
  /** Last N non-ambient events included in every turn's context (see EVENT_WINDOW_EXCLUDE). */
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
  /** Chat / notification tail lengths inside the state summary. */
  CHAT_TAIL: 10,
  NOTIFICATION_TAIL: 5,
  /**
   * Ambient-motion opcodes excluded from the model-visible event window (they
   * still fold into the state cache, whose nearby/motion the summary reflects).
   * Measured on gate2-ox-1: SMSG_MONSTER_MOVE alone was 69% of served events
   * while combat/quest signal was 1.8% — the window exists for signal.
   * WB_TRANSPORT_PROGRESS is the same kind of motion: every transport on the
   * map reports once a second wherever the character stands, which came to
   * about four-fifths of the window's characters and read to models as noise,
   * while the cache already keeps each car's position and `docked`.
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
   */
  EVENT_WINDOW_EXCLUDE: /^(SMSG_MONSTER_MOVE|MSG_MOVE|WB_TRANSPORT_PROGRESS)/,
} as const;

// ------------------------------------------------------------ state summary

interface ObservedLike {
  value?: unknown;
  seq?: number;
  /** The cache's wall-clock stamp for the observation; on the wire, undeclared until now. */
  ts?: number;
}

/** One nearby object as the sandbox flattens `state.units()` into the rpc JSON. */
interface UnitLike {
  guid?: unknown;
  name?: unknown;
  type?: unknown;
  level?: unknown;
  distance?: unknown;
  /** `true` only when health was observed and is 0. See the HUD caveat below. */
  dead?: unknown;
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
   * from the quest's template answer (`SMSG_QUEST_QUERY_RESPONSE`, what the
   * client's quest log shows) once it has arrived.
   */
  questLog?: { questId?: unknown; complete?: unknown; title?: unknown }[];
  characters?: ObservedLike;
  nearby?: Record<string, unknown>;
  /**
   * `state.units()` flattened by the sandbox (nearest first, items/containers
   * dropped). Mob `health`/`maxHealth` are deliberately NOT carried here and are
   * never printed — CONTRACTS.md forbids exact mob health.
   */
  units?: UnitLike[];
  /** `state.bag()` shape: carried items across all bags, free and total slot counts. */
  bag?: BagLike;
  /** `state.inventory` as the sandbox serialises it; equipment is `slot < 19`. */
  inventory?: { slot?: unknown; itemId?: unknown; name?: unknown; stackCount?: unknown; quality?: unknown }[];
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

/** `CHAT_MSG_ACHIEVEMENT` / `CHAT_MSG_GUILD_ACHIEVEMENT` (SharedDefines.h). */
const CHAT_MSG_ACHIEVEMENT = 0x30;
const CHAT_MSG_GUILD_ACHIEVEMENT = 0x31;

/**
 * One chat line the way the client's chat frame would show it: the speaker's
 * name where one is known — the packet's own (`senderName`, creature speech)
 * or the name query's answer for a player guid — and the guid otherwise. A
 * channel line carries its channel. The achievement broadcast arrives as the
 * client's raw template (`%s has earned the achievement $a!`), which the
 * client fills from the sender and `achievementId`; filled here the same way,
 * with the id where the client would link the title (Achievement.dbc is not
 * served for other players' achievements).
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
  if (c.type === CHAT_MSG_ACHIEVEMENT || c.type === CHAT_MSG_GUILD_ACHIEVEMENT) {
    const id = typeof c.achievementId === "number" ? `achievement ${c.achievementId}` : "an achievement";
    message = message.replace("%s", name).replace("$a", id);
  }
  const channel = typeof c.channelName === "string" && c.channelName.length > 0 ? `[${c.channelName}] ` : "";
  return `  ${channel}<${name}> ${message}`;
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

/** One quest as the quest line names it: id, then the title, cut if long. */
function questLabel(q: { questId?: unknown; title?: unknown }): string {
  const id = fmt(q.questId, "?");
  if (typeof q.title !== "string" || q.title.length === 0) return id;
  const title = q.title.length > QUEST_TITLE_CHARS ? `${q.title.slice(0, QUEST_TITLE_CHARS - 1)}…` : q.title;
  return `${id} ${title}`;
}

/**
 * The quest line: ids with their titles, completed quests first. The ids alone
 * meant nothing once the notes that named them were gone — a model with three
 * complete quests could not tell which they were. The two states are grouped
 * rather than worded per quest, which pays for part of the titles: on a
 * twenty-quest log the line grew by about 200 characters, against a turn's
 * context of about 40,000. A title not yet answered prints as the bare id.
 */
function questLine(ql: NonNullable<SnapshotLike["questLog"]>): string {
  const complete = ql.filter((q) => q.complete === true).map(questLabel);
  const open = ql.filter((q) => q.complete !== true).map(questLabel);
  const parts: string[] = [];
  if (complete.length > 0) parts.push(`complete — ${complete.join(", ")}`);
  if (open.length > 0) parts.push(`in progress — ${open.join(", ")}`);
  return `quests: ${parts.join("; ")}`;
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

/** One nearby entry: name, dead-when-known, roles with the quest marker, distance. */
function nearbyLabel(u: UnitLike): string {
  const name = u.name != null ? String(u.name) : "(unnamed)";
  const dead = u.dead === true ? " dead" : "";
  const dist = typeof u.distance === "number" ? `${u.distance}y` : "?y";
  const offer = questOffer(u);
  const roles = fmtRoles(u.roles)
    .split(", ")
    .filter((r) => r !== "" && !(offer !== undefined && r === "quest giver"));
  if (offer !== undefined) roles.unshift(`quest giver: ${offer}`);
  return `${name}${dead} (${roles.length === 0 ? "" : `${roles.join(", ")}, `}${dist})`;
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
/**
 * One sentence for a released ghost: where it stands, where its corpse is, and
 * the two ways back with their prices — the facts a client shows on its map
 * and in its tooltips, no more. Distances are straight-line
 * and rounded; "after Ns" is the server's own reclaim delay. The healer's
 * price is a paraphrased rule, not client text.
 */
function ghostLine(
  s: NonNullable<SnapshotLike["self"]>,
  pos: { map?: number; x?: number; y?: number } | undefined,
  now: number,
): string {
  const xy = (p: { x?: unknown; y?: unknown } | undefined): string =>
    p !== undefined && typeof p.x === "number" && typeof p.y === "number"
      ? `${Math.round(p.x)},${Math.round(p.y)}`
      : "?,?";
  const grave = s.graveyard?.value as { x?: number; y?: number } | undefined;
  const corpse = s.corpse?.value as { map?: number; x?: number; y?: number; instanceMap?: number } | undefined;
  const delay = s.reclaimDelay?.value as { readyAt?: number } | undefined;
  const where = grave !== undefined ? `ghost at graveyard (${xy(grave)})` : "ghost";
  const healer = "or Spirit Healer at the graveyard (-25% durability; resurrection sickness from level 11)";
  const away = (): string =>
    pos !== undefined && typeof pos.x === "number" && typeof pos.y === "number" && typeof corpse?.x === "number" && typeof corpse.y === "number"
      ? `${Math.round(Math.hypot(corpse.x - pos.x, corpse.y - pos.y))}y away `
      : "";
  // A corpse inside a dungeon, asked about from outside it: the position is
  // the entrance the server substitutes, and no reclaim reaches the corpse.
  if (corpse !== undefined && typeof corpse.instanceMap === "number" && pos?.map !== corpse.instanceMap) {
    return (
      `${where}; corpse inside instance map ${corpse.instanceMap}, entrance marker ${away()}at (${xy(corpse)}): ` +
      `walk into the dungeon's portal as a ghost to come back to life inside (no sickness), ${healer}`
    );
  }
  let corpsePart: string;
  if (corpse === undefined) {
    corpsePart = "corpse position not observed yet (state.self.corpse)";
  } else if (pos !== undefined && typeof pos.map === "number" && typeof corpse.map === "number" && corpse.map !== pos.map) {
    corpsePart = `corpse on map ${corpse.map} at (${xy(corpse)}), you are on map ${pos.map}`;
  } else {
    corpsePart = `corpse ${away()}at (${xy(corpse)})`;
  }
  const secs = typeof delay?.readyAt === "number" ? Math.max(0, Math.ceil((delay.readyAt - now) / 1000)) : undefined;
  const when = secs === undefined ? "after the reclaim delay" : secs === 0 ? "now" : `after ${secs}s`;
  return `${where}; ${corpsePart}: reclaim within 39y ${when} (no sickness), ${healer}`;
}

/**
 * "Elwynn Forest / Northshire Valley — " from `self.zone` / `self.area`, the
 * names the game's own zone text shows; the zone alone when the subzone is the
 * zone; empty when neither has been observed (the ids ride in the SDK state).
 */
function fmtPlace(s: NonNullable<SnapshotLike["self"]>): string {
  const zone = s.zone?.value as { id?: number; name?: string } | undefined;
  const area = s.area?.value as { id?: number; name?: string } | undefined;
  const zoneName = zone?.name ? String(zone.name) : undefined;
  const areaName = area?.name ? String(area.name) : undefined;
  if (zoneName === undefined && areaName === undefined) return "";
  if (zoneName === undefined) return `${areaName} — `;
  if (areaName === undefined || areaName === zoneName) return `${zoneName} — `;
  return `${zoneName} / ${areaName} — `;
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
  lines.push(
    pos === undefined
      ? "position: unobserved"
      : `position: ${fmtPlace(s)}map ${fmt(pos.map)} (${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)}) [seq ${fmt(s.position?.seq, "?")}]`,
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

  // health / power (self only — the player frame is numbers)
  lines.push(`health: ${fmtGauge(s.health)}  power: ${fmtGauge(s.power)}`);

  // xp / money
  const money = snapshot.money?.value;
  const moneyStr = money === undefined || money === null ? "unobserved" : `${fmt(money)} copper`;
  lines.push(`xp: ${fmt(snapshot.xp?.value)} / ${fmt(snapshot.nextLevelXp?.value)}     money: ${moneyStr}`);

  // bag
  lines.push(snapshot.bag === undefined ? "bag: unobserved" : bagLine(snapshot.bag));

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
  const chat = (snapshot.chat ?? []).slice(-CONTEXT_POLICY.CHAT_TAIL);
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
 */
export function eventWindow(events: readonly EventSummary[], folded = 0): { window: EventSummary[]; folded: number } {
  const eligible = events.filter((e) => !CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(e.opcode));
  return {
    window: eligible.slice(-CONTEXT_POLICY.EVENT_WINDOW),
    folded: folded + (events.length - eligible.length),
  };
}

/** Pure. Same inputs, byte-identical output — tests enforce it. */
export function assembleContext(inputs: ContextInputs): string {
  const parts: string[] = [];
  parts.push(`[turn ${inputs.turn}] Goal: survive and level as far as you can. Act via tools.`);

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
    parts.push(`[events]\nno non-movement events; ${excluded} ambient movement events folded into state only`);
  } else {
    const note = excluded > 0 ? `; ${excluded} ambient movement events folded into state only` : "";
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
