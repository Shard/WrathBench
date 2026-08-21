/**
 * The fixed context policy. This file IS the policy; the prose version is
 * docs/decisions/ADR-0012-context-policy.md. Do not tune per model (ADR-0004).
 *
 * Per model request the conversation is rebuilt as:
 *
 *   [ system prompt ]
 *   [ up to MESSAGE_WINDOW most recent assistant / tool messages, verbatim,
 *     trimmed at assistant boundaries so tool-call pairs stay intact ]
 *   [ one fresh user message assembled by `assembleContext`:
 *       goal line, harness notices, state summary, last EVENT_WINDOW events,
 *       scratchpad ]
 *
 * Older per-turn user context messages are dropped entirely — they are
 * regenerated, never accumulated. Determinism: `assembleContext` is a pure
 * function of its inputs and the tests require byte-identical output.
 */

import { compactJson } from "./jsonsafe";
import type { EventSummary } from "./sandbox/ipc";
import type { HarnessNotice } from "./sandbox/host";

export const CONTEXT_POLICY = {
  /** Last N events included in every turn's context. */
  EVENT_WINDOW: 64,
  /** Max chars of one event's data rendering. */
  EVENT_DATA_CHARS: 220,
  /** Recent assistant/tool messages kept verbatim (counted in messages). */
  MESSAGE_WINDOW: 24,
  /** Chat / notification tail lengths inside the state summary. */
  CHAT_TAIL: 10,
  NOTIFICATION_TAIL: 5,
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
  return `#${e.seq} ${e.opcode}${schema} ${compactJson(e.data, CONTEXT_POLICY.EVENT_DATA_CHARS)}`;
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

  const window = inputs.events.slice(-CONTEXT_POLICY.EVENT_WINDOW);
  if (window.length === 0) {
    parts.push("[events]\nnone yet");
  } else {
    parts.push(
      `[events: last ${window.length}, newest last]\n${window.map(formatEventLine).join("\n")}`,
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
 * Trim the rolling window to MESSAGE_WINDOW messages without ever splitting an
 * assistant tool-call from its tool results: trimming only starts at an
 * assistant message boundary.
 */
export function trimMessageWindow(messages: ChatMessage[]): ChatMessage[] {
  const max = CONTEXT_POLICY.MESSAGE_WINDOW;
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start]!.role !== "assistant") start++;
  return messages.slice(start);
}
