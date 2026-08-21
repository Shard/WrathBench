/**
 * The fixed context policy. This file IS the policy; the prose version is
 * docs/decisions/ADR-0012-context-policy.md. Do not tune per model (ADR-0004).
 *
 * Per model request the conversation is rebuilt as:
 *
 *   [ system prompt ]
 *   [ the message window: recent assistant / tool messages, verbatim, cut at
 *     assistant boundaries so tool-call pairs stay intact ]
 *   [ one fresh user message assembled by `assembleContext`:
 *       goal line, harness notices, state summary, last EVENT_WINDOW events,
 *       scratchpad ]
 *
 * The window grows to MESSAGE_WINDOW_MAX and is then cut back by one block of
 * MESSAGE_WINDOW_TRIM messages, rather than sliding one message per turn. The
 * point is prompt caching: providers cache by longest byte-identical prefix, so
 * a per-turn slide diverges the prefix right after the system prompt on every
 * turn and pays a full recompute each call. Block trimming keeps the prefix
 * byte-stable for a whole block and pays one deliberate miss per block.
 *
 * Older per-turn user context messages are dropped entirely — they are
 * regenerated, never accumulated. Determinism: `assembleContext` is a pure
 * function of its inputs and the tests require byte-identical output;
 * `messageWindow` is a pure function of the *whole* stored history, so a
 * rebuilt history reproduces the same boundaries as an in-memory one.
 */

import { compactJson } from "./jsonsafe";
import type { EventSummary } from "./sandbox/ipc";
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
   * fixed window (24 messages ≈ 8–12 tool exchanges, ADR-0012); the ceiling
   * buys a byte-stable prefix for a full block of turns.
   */
  MESSAGE_WINDOW_MAX: 48,
  MESSAGE_WINDOW_TRIM: 24,
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
}

/** JSON-safe snapshot as produced by the sandbox rpc (StateCache.snapshot()). */
export interface SnapshotLike {
  self?: {
    guid?: unknown;
    name?: unknown;
    level?: ObservedLike;
    position?: ObservedLike;
    health?: ObservedLike;
    power?: ObservedLike;
  };
  /** Current XP toward the next level (top level in the SDK snapshot, not under `self`). */
  xp?: ObservedLike;
  characters?: ObservedLike;
  nearby?: Record<string, unknown>;
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

/**
 * The fixed state summary format. Every line is stable; a field no event has
 * carried yet reads "unobserved" — never a guessed zero (docs/CONTRACTS.md).
 */
export function formatStateSummary(snapshot: SnapshotLike | null, o: { sessionLive: boolean }): string {
  if (snapshot === null) {
    return "== state ==\nno sandbox state yet (no snippet has connected a session)";
  }
  const s = snapshot.self ?? {};
  const pos = s.position?.value as { map?: number; x?: number; y?: number; z?: number } | undefined;
  const lines: string[] = [];
  lines.push(`== state (seq ${snapshot.lastSeq ?? -1}, ${snapshot.eventCount ?? 0} events seen) ==`);
  lines.push(`session: ${o.sessionLive ? "in world" : "not established"}`);
  lines.push(`character: ${fmt(s.name, "none")} (guid ${fmt(s.guid, "?")}) level ${fmt(s.level?.value)}`);
  lines.push(
    pos === undefined
      ? "position: unobserved"
      : `position: map ${fmt(pos.map)} (${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)}) [seq ${fmt(s.position?.seq, "?")}]`,
  );
  lines.push(`health: ${fmt(s.health?.value)}  power: ${fmt(s.power?.value)}`);
  const nearbyCount = snapshot.nearby === undefined ? 0 : Object.keys(snapshot.nearby).length;
  lines.push(`nearby objects: ${nearbyCount}`);
  const gaps = snapshot.gaps?.length ?? 0;
  lines.push(gaps === 0 ? "stream: continuous" : `stream: ${gaps} gap(s) — some events were missed`);
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

export function formatEventLine(e: EventSummary): string {
  const schema = e.schemaError !== undefined ? " [schema mismatch]" : "";
  // A stream_gap is synthetic and carries the NEXT real event's seq; rendering
  // that number made it look like a duplicate. Mark it as the gap it is.
  const tag = e.opcode === "stream_gap" ? "#gap" : `#${e.seq}`;
  return `${tag} ${e.opcode}${schema} ${compactJson(e.data, CONTEXT_POLICY.EVENT_DATA_CHARS)}`;
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
  const { MESSAGE_WINDOW_MAX, MESSAGE_WINDOW_TRIM } = CONTEXT_POLICY;
  let cut = 0;
  while (history.length - cut > MESSAGE_WINDOW_MAX) cut += MESSAGE_WINDOW_TRIM;
  while (cut < history.length && history[cut]!.role !== "assistant") cut++;
  return cut;
}

/** The model-visible message window for a full history. Pure. */
export function messageWindow(history: ChatMessage[]): ChatMessage[] {
  const cut = messageWindowCut(history);
  return cut === 0 ? history : history.slice(cut);
}
