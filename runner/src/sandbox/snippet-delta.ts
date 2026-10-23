/**
 * The snippet delta: a short block at the foot of a `run_snippet` result
 * saying what changed since the previous snippet result — party members'
 * state, chat from others, damage taken, level and quest changes — on the
 * drivers whose registry entry turns it on (`DriverEntry.snippetDelta`,
 * drivers.ts; claude-code only, operator 2026-10-21).
 *
 * Why it exists: a CLI scaffold runs one long driver turn, and the HUD is
 * built once per driver turn. In Deadmines attempt a8 the first claude-code
 * turn lasted about two hours, so the party line, the combat-log lines and
 * the event window were seen at its start and its end only, and the members
 * looked at their party frames about five times between them while 45,620
 * party-frame packets arrived. The fixed loop rebuilds the HUD every turn,
 * so it never drains this and its results keep their exact bytes.
 *
 * Two halves. `SnippetDeltaRecorder` runs in the sandbox child and latches
 * as events arrive — the context ring and the SDK buffer both turn over in
 * seconds during a party fight, and a melee attacker's name is gone from
 * `nearby` by the time anything renders — and the host drains it once per
 * snippet result (`SandboxHost.snippetDelta`). `renderSnippetDelta` is the
 * host's pure rendering of one drain. Nothing in it is an action outcome:
 * failures and their hints are the `--- harness ---` block's, so a
 * background routine's activity is never said twice.
 *
 * Every reading is one the HUD already makes off the cache (a party member
 * through `memberState`, chat through `formatChatLine`, a quest through
 * `questLabel`); the recorder adds no observation, only remembers when it
 * changed. Bounded everywhere, because a fixed-loop child records and is
 * never drained.
 */

import {
  formatChatLine,
  isGroupOrWhisperChat,
  memberState,
  questLabel,
  type ChatLineLike,
  type GroupMemberLike,
  type UnitLike,
} from "../context";

/**
 * The block's caps. `MAX_CHARS` bounds the whole block, header included;
 * over it, the oldest chat lines go first and then whole lines from the
 * foot, with a count of what was cut. Recording bounds keep a child that is
 * never drained (any fixed-loop run) from growing.
 */
export const SNIPPET_DELTA = {
  MAX_CHARS: 600,
  LINE_CHARS: 160,
  CHAT_LINES: 5,
  DAMAGE_SOURCES: 3,
  HITS_PER_SOURCE: 2,
  MEMBER_WORDS: 4,
  TRACKED_SOURCES: 16,
} as const;

export const SNIPPET_DELTA_HEADER = "--- since your last snippet ---";

/** What one drain carries: JSON-safe, so it crosses the rpc as it is. */
export interface SnippetDelta {
  /** Members with a transition since the last drain, in the group list's order. */
  members: { name: string; words: string[]; truncated: boolean; hp?: number }[];
  /** Formatted chat lines from others, oldest first, the newest `CHAT_LINES`. */
  chat: string[];
  chatDropped: number;
  /** Damage to us by source name, in arrival order of the source. */
  damage: { name: string; total: number; hits: { what: string; count: number; total: number }[] }[];
  /** Damage from sources past `TRACKED_SOURCES`, lumped. */
  damageOther: { sources: number; total: number };
  level?: { from: number; to: number };
  quests: { complete: string[]; added: string[]; gone: string[] };
}

/** What the recorder reads off the SDK's cache, and nothing more. */
export interface SnippetDeltaState {
  selfGuid(): string | undefined;
  level(): number | undefined;
  /** `state.group()`; undefined until any group packet. */
  group(): { inGroup: boolean; members: readonly GroupMemberLike[] } | undefined;
  /** A party member's unit while in view, as the party frame reads it. */
  memberUnit(guid: string): UnitLike | undefined;
  questLog(): readonly { questId?: unknown; complete?: unknown; title?: unknown }[] | undefined;
  /** A unit's name as a client would show it. */
  nameOf(guid: string): string | undefined;
}

export interface SnippetDeltaEvent {
  opcode: string;
  seq: number;
  data: unknown;
}

/** Ambient motion: none of it changes a member's state, so it is not read. */
const AMBIENT = /^(SMSG_MONSTER_MOVE|MSG_MOVE|WB_TRANSPORT_PROGRESS)/;

type MemberStateWord = "offline" | "alive" | "dead" | "ghost";

interface MemberTrack {
  name: string;
  state: MemberStateWord | undefined;
  /** 0 at or above half health, 1 below 50%, 2 below 25%. */
  band: 0 | 1 | 2;
  zone: string | undefined;
  hp: number | undefined;
  /** The seq of the last event that saw its unit in view; a party frame no newer is stale. */
  inViewSeq: number;
  words: string[];
  truncated: boolean;
  /** Gone from the group list; kept until the drain that reports it. */
  gone: boolean;
}

function band(hp: number): 0 | 1 | 2 {
  return hp < 25 ? 2 : hp < 50 ? 1 : 0;
}

function hpPct(health: unknown, max: unknown): number | undefined {
  return typeof health === "number" && typeof max === "number" && max > 0 ? Math.round((100 * health) / max) : undefined;
}

function transitionWord(from: MemberStateWord | undefined, to: MemberStateWord): string | undefined {
  if (to === "offline") return "offline";
  if (from === "offline") return "online";
  if (to === "dead") return "died";
  if (to === "ghost") return "released";
  if (to === "alive" && (from === "dead" || from === "ghost")) return "alive again";
  return undefined;
}

function cut(line: string, max: number = SNIPPET_DELTA.LINE_CHARS): string {
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export class SnippetDeltaRecorder {
  private readonly members = new Map<string, MemberTrack>();
  /** Whether a group reading has been taken: before it, every member seeds silently. */
  private groupSeen = false;
  private chat: string[] = [];
  private chatDropped = 0;
  private damage = new Map<string, { total: number; hits: Map<string, { count: number; total: number }> }>();
  private damageOther = { sources: 0, total: 0 };
  private readonly otherSources = new Set<string>();
  /** Level and quest log as the last drain left them; undefined until the first drain seeds them. */
  private levelBase: number | undefined;
  private questBase: Map<string, { complete: boolean; label: string }> | undefined;

  constructor(private readonly state: SnippetDeltaState) {}

  /** Read one event; call after the SDK's own fold has applied it. */
  observe(event: SnippetDeltaEvent): void {
    if (AMBIENT.test(event.opcode)) return;
    if (event.opcode === "SMSG_MESSAGECHAT") this.chatLine(event.data);
    else if (event.opcode === "SMSG_SPELLNONMELEEDAMAGELOG") this.spellHit(event.data);
    else if (event.opcode === "SMSG_ATTACKERSTATEUPDATE") this.swing(event.data);
    this.readMembers(event.seq);
  }

  /** Everything latched since the last drain; resets it. */
  drain(): SnippetDelta {
    const members: SnippetDelta["members"] = [];
    for (const [guid, t] of this.members) {
      if (t.words.length > 0) {
        // The health now, after a word about health: a fall, or back on its feet.
        const hp = t.state === "alive" && !t.gone && t.words.some((w) => w.startsWith("below") || w === "alive again") ? t.hp : undefined;
        members.push({ name: t.name, words: t.words, truncated: t.truncated, ...(hp !== undefined ? { hp } : {}) });
      }
      t.words = [];
      t.truncated = false;
      if (t.gone) this.members.delete(guid);
    }
    const damage = [...this.damage].map(([name, d]) => ({
      name,
      total: d.total,
      hits: [...d.hits].map(([what, h]) => ({ what, count: h.count, total: h.total })),
    }));
    const out: SnippetDelta = {
      members,
      chat: this.chat,
      chatDropped: this.chatDropped,
      damage,
      damageOther: this.damageOther,
      quests: { complete: [], added: [], gone: [] },
    };
    this.chat = [];
    this.chatDropped = 0;
    this.damage = new Map();
    this.damageOther = { sources: 0, total: 0 };
    this.otherSources.clear();

    const level = this.state.level();
    if (level !== undefined) {
      if (this.levelBase !== undefined && level > this.levelBase) out.level = { from: this.levelBase, to: level };
      this.levelBase = level;
    }
    // The quest slots ride the same self block as the level, and the SDK reads
    // an empty log before that block has arrived: seeding from it would print
    // the whole log as new on the next drain, after login or a restart.
    const log = level === undefined ? undefined : this.state.questLog();
    if (log !== undefined) {
      const now = new Map<string, { complete: boolean; label: string }>();
      for (const q of log) now.set(String(q.questId), { complete: q.complete === true, label: questLabel(q) });
      if (this.questBase !== undefined) {
        for (const [id, q] of now) {
          const was = this.questBase.get(id);
          if (was === undefined) out.quests.added.push(q.label);
          else if (q.complete && !was.complete) out.quests.complete.push(q.label);
        }
        for (const [id, q] of this.questBase) if (!now.has(id)) out.quests.gone.push(q.label);
      }
      this.questBase = now;
    }
    return out;
  }

  private chatLine(data: unknown): void {
    const d = (data ?? {}) as ChatLineLike;
    const me = this.state.selfGuid();
    if (me === undefined || typeof d.senderGuid !== "string" || d.senderGuid === me || !isGroupOrWhisperChat(d)) return;
    const named = typeof d.senderName === "string" && d.senderName.length > 0 ? d.senderName : this.state.nameOf(d.senderGuid);
    this.chat.push(cut(formatChatLine(named === undefined ? d : { ...d, senderName: named })));
    if (this.chat.length > SNIPPET_DELTA.CHAT_LINES) {
      this.chatDropped += this.chat.length - SNIPPET_DELTA.CHAT_LINES;
      this.chat.splice(0, this.chat.length - SNIPPET_DELTA.CHAT_LINES);
    }
  }

  private spellHit(data: unknown): void {
    const d = (data ?? {}) as { targetGuid?: unknown; casterGuid?: unknown; spellId?: unknown; name?: unknown; damage?: unknown };
    const me = this.state.selfGuid();
    if (me === undefined || d.targetGuid !== me || typeof d.casterGuid !== "string" || d.casterGuid === me) return;
    const what = typeof d.name === "string" && d.name !== "" ? d.name : `spell ${String(d.spellId)}`;
    this.took(d.casterGuid, what, typeof d.damage === "number" ? d.damage : 0);
  }

  private swing(data: unknown): void {
    const d = (data ?? {}) as { attackerGuid?: unknown; victimGuid?: unknown; damage?: unknown; miss?: unknown };
    const me = this.state.selfGuid();
    if (me === undefined || d.victimGuid !== me || typeof d.attackerGuid !== "string" || d.attackerGuid === me) return;
    if (d.miss === true || typeof d.damage !== "number" || d.damage <= 0) return;
    this.took(d.attackerGuid, "melee", d.damage);
  }

  private took(source: string, what: string, amount: number): void {
    const name = this.state.nameOf(source) ?? "an unnamed unit";
    let d = this.damage.get(name);
    if (d === undefined) {
      if (this.damage.size >= SNIPPET_DELTA.TRACKED_SOURCES) {
        if (!this.otherSources.has(name)) {
          this.otherSources.add(name);
          this.damageOther.sources++;
        }
        this.damageOther.total += amount;
        return;
      }
      d = { total: 0, hits: new Map() };
      this.damage.set(name, d);
    }
    d.total += amount;
    const h = d.hits.get(what) ?? { count: 0, total: 0 };
    h.count++;
    h.total += amount;
    d.hits.set(what, h);
  }

  private readMembers(seq: number): void {
    const g = this.state.group();
    if (g === undefined) return;
    const listed = g.inGroup ? g.members : [];
    const seen = new Set<string>();
    for (const m of listed) {
      if (m.guid === undefined || m.guid === null) continue;
      const guid = String(m.guid);
      seen.add(guid);
      const unit = this.state.memberUnit(guid);
      let t = this.members.get(guid);
      // A party frame from before the member was last in view is not news:
      // the server stops sending it while the unit is in sight, and the SDK
      // keeps the old one, so reading it would report a state long gone.
      const lastInView = t?.inViewSeq ?? -1;
      const statsSeq = typeof m.stats?.seq === "number" ? m.stats.seq : -1;
      const fresh = unit !== undefined || (m.stats !== undefined && (lastInView < 0 || statsSeq > lastInView));
      const reading = fresh ? m : { ...m, stats: undefined };
      const state = memberState(reading, unit);
      const hp = state === "alive" ? (unit !== undefined ? hpPct(unit.health, unit.maxHealth) : hpPct(m.stats?.health, m.stats?.maxHealth)) : undefined;
      // The member's zone is the one its own party frame names, read out of
      // view only, as the HUD's party line reads it. A member in view is not
      // given ours: in view says nothing of which side of a zone line it
      // stands on, and labelling it so made it flap between two sources as
      // it drifted in and out of sight at a portal, though it never moved.
      // The cached zone changes only when a packet carries a new one, so
      // every change told is the member's own; one made in our sight waits
      // for the next frame that carries it.
      const zoneRaw = unit === undefined && fresh ? m.stats?.zone?.name : undefined;
      const zone = typeof zoneRaw === "string" && zoneRaw !== "" ? zoneRaw : undefined;
      const name = typeof m.name === "string" && m.name !== "" ? m.name : guid;
      if (t === undefined) {
        t = {
          name,
          state,
          band: hp === undefined ? 0 : band(hp),
          zone,
          hp,
          inViewSeq: unit !== undefined ? seq : -1,
          words: [],
          truncated: false,
          gone: false,
        };
        this.members.set(guid, t);
        if (this.groupSeen) this.word(t, "joined the group");
        continue;
      }
      t.name = name;
      if (unit !== undefined) t.inViewSeq = seq;
      if (t.gone) {
        t.gone = false;
        this.word(t, "joined the group");
      }
      if (state !== undefined && state !== t.state) {
        const w = transitionWord(t.state, state);
        if (w !== undefined) this.word(t, w);
        t.state = state;
        // Back on its feet (or back online): its health now is a fresh start,
        // not a fall.
        if (hp !== undefined) t.band = band(hp);
      } else if (state === "alive" && hp !== undefined) {
        const b = band(hp);
        if (b > t.band) this.word(t, b === 2 ? "below 25%" : "below 50%");
        t.band = b;
      }
      if (hp !== undefined) t.hp = hp;
      if (zone !== undefined && zone !== t.zone) {
        if (t.zone !== undefined) this.word(t, `now in ${zone}`);
        t.zone = zone;
      }
    }
    if (this.groupSeen) {
      for (const [guid, t] of this.members) {
        if (!seen.has(guid) && !t.gone) {
          t.gone = true;
          this.word(t, "left the group");
        }
      }
    } else {
      this.groupSeen = true;
    }
  }

  private word(t: MemberTrack, w: string): void {
    if (t.words.at(-1) === w) return;
    t.words.push(w);
    if (t.words.length > SNIPPET_DELTA.MEMBER_WORDS) {
      t.words.splice(0, t.words.length - SNIPPET_DELTA.MEMBER_WORDS);
      t.truncated = true;
    }
  }
}

/** A tie-break by code unit, never by locale, so the bytes do not depend on where the runner runs. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `Fireball ×3` — a kind of hit and how often, the count only when more than one. */
function hitLabel(h: { what: string; count: number }): string {
  return h.count > 1 ? `${h.what} ×${h.count}` : h.what;
}

function damageLine(d: SnippetDelta): string | undefined {
  const total = d.damage.reduce((n, s) => n + s.total, 0) + d.damageOther.total;
  if (total <= 0) return undefined;
  const sources = [...d.damage].filter((s) => s.total > 0).sort((a, b) => b.total - a.total || byText(a.name, b.name));
  const shown = sources.slice(0, SNIPPET_DELTA.DAMAGE_SOURCES).map((s) => {
    const hits = [...s.hits].filter((h) => h.total > 0).sort((a, b) => b.total - a.total || byText(a.what, b.what));
    const kinds = hits.slice(0, SNIPPET_DELTA.HITS_PER_SOURCE).map(hitLabel);
    if (hits.length > kinds.length) kinds.push(`+${hits.length - kinds.length}`);
    return `${s.name} ${s.total} (${kinds.join(", ")})`;
  });
  const restSources = sources.length - shown.length + d.damageOther.sources;
  const restTotal = sources.slice(SNIPPET_DELTA.DAMAGE_SOURCES).reduce((n, s) => n + s.total, 0) + d.damageOther.total;
  if (restSources > 0) shown.push(`+${restSources} more ${restTotal}`);
  return `took ${total}: ${shown.join(", ")}`;
}

/**
 * One drain as the block the result ends with, or undefined when nothing
 * changed — no header over an empty block. Pure and deterministic: the same
 * drain renders the same bytes. At most `SNIPPET_DELTA.MAX_CHARS`.
 */
export function renderSnippetDelta(d: SnippetDelta): string | undefined {
  const lines: string[] = [];
  for (const m of d.members) {
    const words = `${m.truncated ? "…, " : ""}${m.words.join(", ")}`;
    lines.push(cut(`${m.name}: ${words}${m.hp !== undefined ? ` (now ${m.hp}%)` : ""}`));
  }
  const dmg = damageLine(d);
  if (dmg !== undefined) lines.push(cut(dmg));
  if (d.level !== undefined) lines.push(`level ${d.level.from} → ${d.level.to}`);
  const q: string[] = [];
  if (d.quests.complete.length > 0) q.push(`complete — ${d.quests.complete.join(", ")}`);
  if (d.quests.added.length > 0) q.push(`new — ${d.quests.added.join(", ")}`);
  if (d.quests.gone.length > 0) q.push(`left the log — ${d.quests.gone.join(", ")}`);
  if (q.length > 0) lines.push(cut(`quests: ${q.join("; ")}`));
  const chat = [...d.chat];
  let dropped = d.chatDropped;
  if (lines.length === 0 && chat.length === 0) return undefined;

  const chatBlock = (): string[] =>
    chat.length === 0 ? [] : [`chat${dropped > 0 ? ` (+${dropped} earlier)` : ""}:`, ...chat];
  const assemble = (body: string[], cutLines: number): string =>
    [SNIPPET_DELTA_HEADER, ...body, ...(cutLines > 0 ? [`(+${cutLines} lines cut)`] : [])].join("\n");

  // Over the cap: the oldest chat lines first, counted as earlier ones...
  while (chat.length > 1 && assemble([...lines, ...chatBlock()], 0).length > SNIPPET_DELTA.MAX_CHARS) {
    chat.shift();
    dropped++;
  }
  // ...then whole lines from the foot, counted.
  const body = [...lines, ...chatBlock()];
  let cutLines = 0;
  while (body.length > 0 && assemble(body, cutLines).length > SNIPPET_DELTA.MAX_CHARS) {
    body.pop();
    cutLines++;
  }
  return assemble(body, cutLines);
}
