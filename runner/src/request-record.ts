/**
 * The fixed loop's `request` record, and the one rebuild of it.
 *
 * Every turn the loop sends `[system prompt, ...message window, fresh user
 * message]` (`context.ts`). Only the last of those is new information: the
 * system prompt is the same bytes for a whole process, and the window is a
 * slice of messages the trajectory already holds — each assistant message on
 * its `response` record, each tool result on its `tool_result` /
 * `snippet_result` record. So the record keeps what nothing else does and
 * points at the rest:
 *
 *   { t: "request", turn, adapter, slim: 1,
 *     systemHash,                 // promptHash() of the system prompt text
 *     systemText?,                // the text itself, on a segment's first request
 *                                 //   and again whenever its hash changes
 *     window: { from, to, fromTurn, cap },
 *     user,                       // the fresh user message, verbatim
 *     requestHash,                // sha256 of JSON.stringify(messages) as sent
 *     messageCount, systemChars, promptChars }
 *
 * `window` indexes the *segment's* history: the messages this process's loop
 * appended since its first request, in order. A resumed run starts a new
 * segment with an empty history (`to === 0`), so `to === 0` is what opens one,
 * read off the writer's own state rather than inferred from `meta` or `resume`
 * records. `fromTurn` is the loop turn whose response opens the window (each
 * turn appends exactly one assistant message, and the cut always lands on
 * one), which lets a reader walking backwards stop at a known record. `cap` is
 * the per-message cap the window was cut with, so a later build with another
 * cap still rebuilds this one.
 *
 * Why the system text is recorded rather than regenerated: `prompt.ts` moves
 * on, and a trajectory has to replay into what *its* build sent, years later
 * and after any number of resumes onto newer builds. Once per process segment
 * is cheap (one prompt per resume) and keeps each segment self-contained, so
 * no reader ever has to search a file backwards for it. The hash is the same
 * function comparability stamps (`promptHash`), so on a fixed-loop run it
 * equals `meta.comparability.promptHash` of the build that wrote it.
 *
 * The rebuild (`assembleRequest`) is the loop's own assembly, written once;
 * `requestHash` is the proof it is faithful. The writer checks the rebuild
 * against the bytes it is about to send before dropping them, and keeps the
 * full message array instead if they ever disagree — a slim record is only
 * written when it is known to replay.
 *
 * A build that changes how a request is put together from these parts (the
 * cap's suffix, the message shapes, their order) writes a new `slim` version
 * and keeps this one's rebuild, or every trajectory before it stops replaying.
 *
 * The claude-code and codex drivers do not write this shape: their context is
 * the CLI's own and is not ours to rebuild, so their records keep `messages`.
 */

import { promptHash } from "./comparability";
import { CONTEXT_POLICY, capWindowMessage, type ChatMessage } from "./context";

/** The shape version this build writes and knows how to rebuild. */
export const SLIM_REQUEST_VERSION = 1;

export interface RequestWindow {
  /** Index into the segment's history of the first message the window kept. */
  from: number;
  /** The history's length when the request was built; the window is `[from, to)`. */
  to: number;
  /** The loop turn whose `response` opens the window; null when the window is empty. */
  fromTurn: number | null;
  /** The per-message cap the window was cut with (`WINDOW_MESSAGE_CHARS`). */
  cap: number;
}

export interface SlimRequestRecord {
  t: "request";
  turn: number;
  adapter: string;
  slim: number;
  systemHash: string;
  systemText?: string;
  window: RequestWindow;
  user: string;
  requestHash: string;
  messageCount: number;
  systemChars: number;
  promptChars: number;
}

/** What a reader needs to know about a request record's prompt, either shape. */
export interface RequestStats {
  messageCount: number;
  systemChars: number;
  promptChars: number;
}

// ------------------------------------------------------------------ sizes

/**
 * Characters a chat message contributes to the context, tool calls included.
 * The one definition: the writer stores it on a slim record and the viewer
 * computes it off a full one, so both shapes report the same number.
 */
export function messageChars(m: unknown): number {
  if (m === null || typeof m !== "object") return 0;
  const msg = m as Record<string, unknown>;
  let n = typeof msg["role"] === "string" ? msg["role"].length : 0;
  const content = msg["content"];
  if (typeof content === "string") n += content.length;
  else if (content !== undefined && content !== null) n += JSON.stringify(content).length;
  const calls = msg["tool_calls"];
  if (Array.isArray(calls)) n += JSON.stringify(calls).length;
  return n;
}

/** Counts over a message array as it was sent. */
export function requestStats(messages: readonly unknown[]): RequestStats {
  const system = messages.find((m) => (m as { role?: unknown } | null)?.role === "system") as
    | { content?: unknown }
    | undefined;
  return {
    messageCount: messages.length,
    systemChars: typeof system?.content === "string" ? system.content.length : 0,
    promptChars: messages.reduce((n: number, m) => n + messageChars(m), 0),
  };
}

/**
 * A request record's stats, whichever shape it is: stored on a slim record,
 * computed off the message array of a full one (the claude-code and codex
 * drivers', and every fixed-loop record written before the slim shape).
 */
export function requestStatsOf(rec: Record<string, unknown>): RequestStats {
  if (isSlimRequest(rec)) {
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return { messageCount: n(rec["messageCount"]), systemChars: n(rec["systemChars"]), promptChars: n(rec["promptChars"]) };
  }
  return requestStats(Array.isArray(rec["messages"]) ? (rec["messages"] as unknown[]) : []);
}

// ----------------------------------------------------------------- hashing

/**
 * `sha256:<64 hex>` of the message array exactly as handed to the adapter.
 * Full length on purpose: `promptHash` identifies, this seals. The adapter
 * serialises the same array into its request body with `JSON.stringify`, so
 * these are the bytes of the body's `messages`; the tool list and any field
 * the adapter adds around them are outside it, as they were outside the full
 * record.
 */
export function requestHash(messages: readonly ChatMessage[]): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(messages)).digest("hex")}`;
}

// ---------------------------------------------------------------- the shape

/**
 * Any slim request, of any version: the record a reader must not read a
 * message array off. Stats are stored on every version.
 */
export function isSlimRequest(rec: Record<string, unknown>): boolean {
  return rec["t"] === "request" && rec["slim"] !== undefined && !Array.isArray(rec["messages"]);
}

/** A slim request this build can rebuild, or a reason it cannot. */
export function slimRequestV1(rec: Record<string, unknown>): SlimRequestRecord | string {
  if (rec["slim"] !== SLIM_REQUEST_VERSION) return `slim request version ${JSON.stringify(rec["slim"])} is not one this build rebuilds`;
  const w = rec["window"] as Record<string, unknown> | undefined;
  const int = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (
    typeof rec["user"] !== "string" ||
    typeof rec["systemHash"] !== "string" ||
    typeof rec["requestHash"] !== "string" ||
    (rec["systemText"] !== undefined && typeof rec["systemText"] !== "string") ||
    w === undefined ||
    w === null ||
    typeof w !== "object" ||
    !int(w["from"]) ||
    !int(w["to"]) ||
    !int(w["cap"]) ||
    (w["from"] as number) > (w["to"] as number)
  ) {
    return "malformed slim request record";
  }
  return rec as unknown as SlimRequestRecord;
}

/**
 * The request as the loop assembles it: the system prompt, the window with
 * each message capped, the fresh user message. The single definition the
 * writer's self-check, the replay and the viewer all go through.
 */
export function assembleRequest(
  systemText: string,
  window: readonly ChatMessage[],
  user: string,
  cap: number,
): ChatMessage[] {
  return [
    { role: "system", content: systemText },
    ...window.map((m) => capWindowMessage(m, cap)),
    { role: "user", content: user },
  ];
}

/** The loop turn whose assistant message sits at `from`: one assistant per turn, turns from 1. */
function turnAt(history: readonly ChatMessage[], from: number): number | null {
  if (from >= history.length) return null;
  let turns = 0;
  for (let k = 0; k < from; k++) if (history[k]!.role === "assistant") turns++;
  return turns + 1;
}

export interface FixedLoopRequest {
  turn: number;
  adapter: string;
  /** Exactly what is handed to the adapter. Never mutated. */
  messages: readonly ChatMessage[];
  /** The loop's whole stored history for this segment, uncapped. */
  history: readonly ChatMessage[];
  /** `messageWindowCut(history)`: where the window starts. */
  from: number;
  /** Whether this record carries the system prompt text (first of a segment, or changed). */
  withSystemText: boolean;
}

/**
 * The record the fixed loop writes for one request, and whether the rebuild
 * reproduced the bytes. On a mismatch the record is the full shape — the
 * whole message array, plus the window and hash so a replay can still place
 * it — because a slim record that would not replay is a record that lost what
 * the model saw. The caller logs the mismatch; it is a harness bug.
 */
export function fixedLoopRequestRecord(o: FixedLoopRequest): {
  record: Record<string, unknown>;
  mismatch: string | null;
} {
  const first = o.messages[0];
  const last = o.messages[o.messages.length - 1];
  const sent = JSON.stringify(o.messages);
  const hash = `sha256:${new Bun.CryptoHasher("sha256").update(sent).digest("hex")}`;
  const cap = CONTEXT_POLICY.WINDOW_MESSAGE_CHARS;
  const window: RequestWindow = { from: o.from, to: o.history.length, fromTurn: turnAt(o.history, o.from), cap };
  const stats = requestStats(o.messages);
  let mismatch: string | null = null;
  if (first?.role !== "system" || typeof first.content !== "string" || last?.role !== "user" || typeof last.content !== "string" || o.messages.length < 2) {
    mismatch = "the request is not [system, ...window, user]";
  } else if (JSON.stringify(assembleRequest(first.content, o.history.slice(o.from), last.content, cap)) !== sent) {
    mismatch = "the rebuild from the stored history does not reproduce the request";
  }
  if (mismatch !== null) {
    return {
      record: { t: "request", turn: o.turn, adapter: o.adapter, messages: o.messages, window, requestHash: hash, slimFallback: mismatch },
      mismatch,
    };
  }
  const systemText = first!.content as string;
  return {
    record: {
      t: "request",
      turn: o.turn,
      adapter: o.adapter,
      slim: SLIM_REQUEST_VERSION,
      systemHash: promptHash(systemText),
      ...(o.withSystemText ? { systemText } : {}),
      window,
      user: last!.content as string,
      requestHash: hash,
      ...stats,
    },
    mismatch: null,
  };
}

// --------------------------------------------------------------- the rebuild

/**
 * The segment's history, rebuilt from the records that wrote it, in file order.
 *
 * Exactly two things ever enter the loop's history: the assistant message, as
 * the `response` record's `message`, and one tool message per tool call, as a
 * `tool_result` / `snippet_result` record's `text`. The tool message's
 * `tool_call_id` is not on the result record; it is the id of the call the
 * result answers, and the loop answers a response's calls in order, so it is
 * read positionally off the preceding response — with the name and the turn
 * checked, so a result that does not line up is named rather than guessed.
 *
 * `base` is the absolute index of `messages[0]`: a long segment is replayed
 * holding only what a later window can still reach (`dropBefore`), because
 * the window start only ever moves forward within a segment.
 */
export class HistoryRebuilder {
  base = 0;
  readonly messages: ChatMessage[] = [];
  /** Results that did not line up with a call, by absolute index. */
  private readonly problems = new Map<number, string>();
  private calls: { id?: unknown; function?: { name?: unknown } }[] = [];
  private callTurn: unknown = undefined;
  private answered = 0;

  get length(): number {
    return this.base + this.messages.length;
  }

  reset(): void {
    this.base = 0;
    this.messages.length = 0;
    this.problems.clear();
    this.calls = [];
    this.callTurn = undefined;
    this.answered = 0;
  }

  /** Feed one record; a record that never entered the history is ignored. */
  take(rec: Record<string, unknown>): void {
    const t = rec["t"];
    if (t === "response") {
      const message = rec["message"] as ChatMessage | undefined;
      this.messages.push(message ?? ({ role: "assistant", content: null } as ChatMessage));
      if (message === undefined || message === null || typeof message !== "object") {
        this.problems.set(this.length - 1, "a response record with no message");
      }
      const calls = (message as { tool_calls?: unknown } | undefined)?.tool_calls;
      this.calls = Array.isArray(calls) ? (calls as typeof this.calls) : [];
      this.callTurn = rec["turn"];
      this.answered = 0;
      return;
    }
    if (t !== "tool_result" && t !== "snippet_result") return;
    const j = this.answered++;
    const call = this.calls[j];
    let problem: string | null = null;
    if (call === undefined) problem = `a ${t} with no tool call left to answer`;
    else if (call.function?.name !== rec["name"]) {
      problem = `a ${t} for ${JSON.stringify(rec["name"])} answers call ${j} of turn ${String(this.callTurn)}, which is ${JSON.stringify(call.function?.name)}`;
    } else if (rec["turn"] !== this.callTurn) {
      problem = `a ${t} of turn ${String(rec["turn"])} follows the response of turn ${String(this.callTurn)}`;
    }
    const msg = { role: "tool", content: rec["text"], tool_call_id: call?.id } as ChatMessage;
    this.messages.push(msg);
    if (problem !== null) this.problems.set(this.length - 1, problem);
  }

  /** Forget everything below absolute index `index`. */
  dropBefore(index: number): void {
    const n = Math.min(this.messages.length, Math.max(0, index - this.base));
    if (n === 0) return;
    this.messages.splice(0, n);
    this.base += n;
    for (const k of [...this.problems.keys()]) if (k < this.base) this.problems.delete(k);
  }

  /** The window `[from, to)` in absolute indices, or why it cannot be had. */
  window(from: number, to: number): ChatMessage[] | string {
    if (to !== this.length) {
      return `the record says the history held ${to} messages; the trajectory rebuilds ${this.length}`;
    }
    if (from < this.base) return `the window starts at ${from}, before the replay's held history (${this.base})`;
    for (let k = from; k < to; k++) {
      const p = this.problems.get(k);
      if (p !== undefined) return `history message ${k}: ${p}`;
    }
    return this.messages.slice(from - this.base, to - this.base);
  }
}

/** Whether a recorded system prompt text is the one its hash names. */
export function systemTextMatches(text: string, hash: string): boolean {
  return promptHash(text) === hash;
}

export type Rebuilt =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; error: string; messages?: ChatMessage[] };

/**
 * Rebuild one slim request from its system text and its window, and check the
 * result against the hash the writer took of what it sent. A mismatch is a
 * harness bug (or a record that was edited after the fact), never a pass.
 */
export function rebuildSlimRequest(
  rec: SlimRequestRecord,
  systemText: string | undefined,
  window: readonly ChatMessage[] | string,
): Rebuilt {
  if (systemText === undefined) return { ok: false, error: `no system prompt text recorded for ${rec.systemHash}` };
  if (!systemTextMatches(systemText, rec.systemHash)) {
    return { ok: false, error: `the recorded system prompt text does not hash to ${rec.systemHash}` };
  }
  if (typeof window === "string") return { ok: false, error: window };
  if (window.length !== rec.window.to - rec.window.from) {
    return {
      ok: false,
      error: `the window rebuilds ${window.length} messages; the record says ${rec.window.to - rec.window.from}`,
    };
  }
  const messages = assembleRequest(systemText, window, rec.user, rec.window.cap);
  if (requestHash(messages) !== rec.requestHash) {
    return { ok: false, error: "request hash mismatch: the rebuilt request is not the one that was sent", messages };
  }
  return { ok: true, messages };
}

/**
 * Which earlier entries hold a slim request's window, for a reader that has
 * the file indexed and walks it backwards (the viewer) rather than replaying
 * it forwards. `entries` are the file's records in order, typed and turned;
 * the answer is their indices in file order, or why the walk failed.
 *
 * The window is the responses and results of turns `fromTurn .. turn - 1` of
 * the request's own segment, and nothing else of the history: so the walk
 * collects those kinds back to the response of `fromTurn` and stops there.
 */
export function windowEntryIndices(
  entries: readonly { t: string; turn?: unknown }[],
  at: number,
  rec: SlimRequestRecord,
): number[] | string {
  const { fromTurn } = rec.window;
  if (rec.window.from === rec.window.to) return [];
  if (typeof fromTurn !== "number") return "a non-empty window with no opening turn";
  const out: number[] = [];
  for (let j = at - 1; j >= 0; j--) {
    const e = entries[j]!;
    if (e.t !== "response" && e.t !== "tool_result" && e.t !== "snippet_result") continue;
    const turn = e.turn;
    if (typeof turn !== "number" || turn < fromTurn || turn >= rec.turn) {
      return `record ${j} (${e.t}, turn ${String(turn)}) sits inside the window of turn ${rec.turn}, which opens at turn ${fromTurn}`;
    }
    out.push(j);
    if (e.t === "response" && turn === fromTurn) return out.reverse();
  }
  return `the response of turn ${fromTurn} that opens the window was not found`;
}
