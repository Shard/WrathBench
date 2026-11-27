/**
 * What a reader needs to know about a recorded request's prompt — its message
 * count, system and prompt characters — off either shape of the `request`
 * record (`request-record.ts`, which re-exports all of this unchanged). Its
 * own module because these read a record and nothing else: the run totals
 * (`run-totals.ts`), which the collector and the viewer derive from every
 * trajectory, need them and not the context renderer the rebuild of a slim
 * request is made of.
 */

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

/**
 * Any slim request, of any version: the record a reader must not read a
 * message array off. Stats are stored on every version.
 */
export function isSlimRequest(rec: Record<string, unknown>): boolean {
  return rec["t"] === "request" && rec["slim"] !== undefined && !Array.isArray(rec["messages"]);
}
