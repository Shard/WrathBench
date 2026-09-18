/**
 * The fixed context policy. This file IS the policy; the prose version is
 * docs/METHODOLOGY.md ("Context policy"). Do not tune per model.
 *
 * Per model request the conversation is rebuilt as:
 *
 *   [ system prompt ]
 *   [ the message window: recent assistant / tool messages, each capped at
 *     WINDOW_MESSAGE_CHARS, cut at assistant boundaries so tool-call pairs
 *     stay intact ]
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
 * Older per-turn user context messages are dropped entirely — they are
 * regenerated, never accumulated. Determinism: `assembleContext` is a pure
 * function of its inputs and the tests require byte-identical output;
 * `messageWindow` is a pure function of the *whole* stored history, so a
 * rebuilt history reproduces the same boundaries as an in-memory one.
 */

import { inventoryResultText } from "@wrathbench/sdk";

import { compactJson } from "./jsonsafe";
import type { EventSummary, MoveIntentNote } from "./sandbox/ipc";
import type { HarnessNotice } from "./sandbox/host";

export const CONTEXT_POLICY = {
  /** Last N events included in every turn's context. */
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
  /** Chat / notification tail lengths inside the state summary. */
  CHAT_TAIL: 10,
  NOTIFICATION_TAIL: 5,
  /**
   * Ambient-motion opcodes excluded from the model-visible event window (they
   * still fold into the state cache, whose nearby/motion the summary reflects).
   * Measured on gate2-ox-1: SMSG_MONSTER_MOVE alone was 69% of served events
   * while combat/quest signal was 1.8% — the window exists for signal.
   */
  EVENT_WINDOW_EXCLUDE: /^(SMSG_MONSTER_MOVE|MSG_MOVE)/,
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
    /** Where the corpse is while dead: `{ map, x, y, z, source }` (SDK `state.self.corpse`). */
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
  /** The quest log's occupied slots: questId + completion bit only, no titles. */
  questLog?: { questId?: unknown; complete?: unknown }[];
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
   * (`spells_at_login` / `spell`, item 35).
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
  chat?: { senderGuid?: unknown; message?: unknown }[];
  notifications?: { text?: unknown }[];
  gaps?: unknown[];
  lastSeq?: number;
  eventCount?: number;
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
/** How many bag items the HUD names before collapsing the rest to "+K more". */
const BAG_ITEM_CAP = 8;
/** How many nearby objects the HUD names before collapsing the rest to "+K more". */
const NEARBY_CAP = 6;

/** One item's label for the bag line: name, else item id, else slot. */
function bagItemLabel(it: { slot?: unknown; itemId?: unknown; name?: unknown; count?: unknown }): string {
  const name =
    it.name != null ? String(it.name) : it.itemId != null ? `item ${String(it.itemId)}` : `slot ${String(it.slot)}`;
  return typeof it.count === "number" && it.count > 1 ? `${name} x${it.count}` : name;
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
      case "SMSG_LOOT_RESPONSE":
        if (e.seq > lootSeq) lootSeq = e.seq;
        break;
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
 * and in its tooltips, no more (item 53). Distances are straight-line
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
  const corpse = s.corpse?.value as { map?: number; x?: number; y?: number } | undefined;
  const delay = s.reclaimDelay?.value as { readyAt?: number } | undefined;
  const where = grave !== undefined ? `ghost at graveyard (${xy(grave)})` : "ghost";
  let corpsePart: string;
  if (corpse === undefined) {
    corpsePart = "corpse position not observed yet (state.self.corpse)";
  } else if (pos !== undefined && typeof pos.map === "number" && typeof corpse.map === "number" && corpse.map !== pos.map) {
    corpsePart = `corpse on map ${corpse.map} at (${xy(corpse)}), you are on map ${pos.map}`;
  } else {
    const d =
      pos !== undefined && typeof pos.x === "number" && typeof pos.y === "number" && typeof corpse.x === "number" && typeof corpse.y === "number"
        ? `${Math.round(Math.hypot(corpse.x - pos.x, corpse.y - pos.y))}y away `
        : "";
    corpsePart = `corpse ${d}at (${xy(corpse)})`;
  }
  const secs = typeof delay?.readyAt === "number" ? Math.max(0, Math.ceil((delay.readyAt - now) / 1000)) : undefined;
  const when = secs === undefined ? "after the reclaim delay" : secs === 0 ? "now" : `after ${secs}s`;
  return (
    `${where}; ${corpsePart}: reclaim within 39y ${when} (no sickness), ` +
    "or Spirit Healer at the graveyard (-25% durability; resurrection sickness from level 11)"
  );
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
  if (snapshot.bag === undefined) {
    lines.push("bag: unobserved");
  } else {
    const items = snapshot.bag.items ?? [];
    const free = snapshot.bag.freeSlots;
    const total = typeof snapshot.bag.totalSlots === "number" ? snapshot.bag.totalSlots : BACKPACK_SIZE;
    const freeStr = typeof free === "number" ? `${free} free / ${total}` : "unobserved";
    let itemsStr = items.length === 0 ? "empty" : items.slice(0, BAG_ITEM_CAP).map(bagItemLabel).join(", ");
    if (items.length > BAG_ITEM_CAP) itemsStr += ` +${items.length - BAG_ITEM_CAP} more`;
    lines.push(`bag: ${freeStr}    items: ${itemsStr}`);
  }

  // quests (questId + completion bit only, no titles — CONTRACTS.md / no wiki lookup)
  const ql = snapshot.questLog;
  if (ql === undefined) {
    lines.push("quests: unobserved");
  } else if (ql.length === 0) {
    lines.push("quests: none");
  } else {
    lines.push(
      `quests: ${ql.map((q) => `${fmt(q.questId, "?")} ${q.complete === true ? "complete" : "progress"}`).join(", ")}`,
    );
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
  // dropped by the sandbox). Name + distance + dead-when-known; never mob health.
  const units = snapshot.units;
  if (units === undefined) {
    lines.push("nearby: unobserved");
  } else if (units.length === 0) {
    lines.push("nearby: none");
  } else {
    const shown = units.slice(0, NEARBY_CAP).map((u) => {
      const name = u.name != null ? String(u.name) : "(unnamed)";
      const dead = u.dead === true ? " dead" : "";
      const dist = typeof u.distance === "number" ? `${u.distance}y` : "?y";
      const roles = fmtRoles(u.roles);
      return `${name}${dead} (${roles === "" ? "" : `${roles}, `}${dist})`;
    });
    let nearbyStr = shown.join(", ");
    if (units.length > NEARBY_CAP) nearbyStr += ` +${units.length - NEARBY_CAP} more`;
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
    for (const c of chat) lines.push(`  <${fmt(c.senderGuid, "?")}> ${fmt(c.message, "")}`);
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
  /** Oldest first; only the last EVENT_WINDOW are rendered. */
  events: EventSummary[];
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

  const eligible = inputs.events.filter(
    (e) => !CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(e.opcode),
  );
  const excluded = inputs.events.length - eligible.length;
  const window = eligible.slice(-CONTEXT_POLICY.EVENT_WINDOW);
  if (window.length === 0) {
    parts.push("[events]\nnone yet");
  } else {
    const note = excluded > 0 ? `; ${excluded} ambient movement events folded into state only` : "";
    parts.push(
      `[events: last ${window.length}, newest last${note}]\n${window.map(formatEventLine).join("\n")}`,
    );
  }

  parts.push(
    inputs.scratchpad.trim().length === 0
      ? "[scratchpad]\n(empty — write your plan and durable facts with write_scratchpad)"
      : `[scratchpad]\n${inputs.scratchpad}`,
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
export function messageWindowCut(history: ChatMessage[]): number {
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
 * *exact* (docs/METHODOLOGY.md, "An episodic log, written before each trim":
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
function laggedLength(history: ChatMessage[]): number {
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
export function lastTurnGrowth(history: ChatMessage[]): number {
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
export function trimExpected(history: ChatMessage[]): boolean {
  return messageWindowRawCut(history.length) > messageWindowRawCut(laggedLength(history));
}

/**
 * Cap one message's content at WINDOW_MESSAGE_CHARS with a fixed suffix.
 * Deterministic: the suffix carries only the number of characters dropped.
 */
export function capWindowMessage(m: ChatMessage): ChatMessage {
  const max = CONTEXT_POLICY.WINDOW_MESSAGE_CHARS;
  if (typeof m.content !== "string" || m.content.length <= max) return m;
  const dropped = m.content.length - max;
  return { ...m, content: `${m.content.slice(0, max)}\n…[truncated ${dropped} chars]` };
}

/**
 * The model-visible message window for a full history. Pure.
 *
 * The cap is applied here, on the way out, rather than to the stored history:
 * the trajectory records tool results in full, so capping at push time would
 * leave the in-memory history holding different bytes than a history rebuilt
 * from the log, and the two would stop windowing identically.
 */
export function messageWindow(history: ChatMessage[]): ChatMessage[] {
  const cut = messageWindowCut(history);
  return (cut === 0 ? history : history.slice(cut)).map(capWindowMessage);
}
