/**
 * Grouping the run feed's fixed cycle into composite rows.
 *
 * The trajectory writes a turn as separate entries — `events_served
 * (via:"context")` then `request`, and per tool call a `tool_call` →
 * `snippet` (run_snippet only) → `snippet_result`/`tool_result` run — and the
 * feed used to render each as its own card, which for run_snippet showed the
 * same code twice (the call's args and the snippet) under three headers. This
 * derives the composite view: one turn-header row per request with its context
 * events folded in, one card per tool call with the code and the result
 * together, and a latency figure wherever a pair of timestamps supports one.
 *
 * It is a pure function of the entry window, re-derived on every change,
 * because nothing else survives this feed's edges: the window loads the last
 * 200 and "load earlier" prepends, so either half of a pair can be missing off
 * the top; a live tail delivers a call before its result exists. An orphan
 * half renders as a card with the other side absent, and heals when the
 * partner scrolls in.
 *
 * Pairing is by adjacency, not by id, matching how the three writers append:
 *
 * - `runner/src/loop.ts` writes `tool_call` (+`snippet`) synchronously before
 *   dispatching the tool and the result after it, so `state` ticks and
 *   `events_served (via:"tool")` legitimately land in between — the search
 *   skips those two types and nothing else, since any other type means the
 *   result was never written.
 * - `runner/src/adapter-claude.ts` and `runner/src/mcp.ts` append the whole
 *   run after the call completes, so the members are strictly adjacent — and
 *   their timestamp spread is write time, not run time. A call entry that
 *   carries a `call` index (the claude driver) or no `turn` at all (the MCP
 *   server) is one of these, and its card shows no duration rather than a
 *   fabricated ~0ms.
 *
 * Where turn/call/name fields exist on both sides they must agree, so a
 * result can never be glued to a stranger's call across a missing partner.
 */

import type {
  EventsServedEntry,
  FeedEntry,
  RequestEntry,
  ResponseEntry,
  SnippetEntry,
  SnippetResultEntry,
} from "@viewer/api-types";

/** A `tool_call` entry, which `api-types` leaves to its generic fallback. */
export interface ToolCallView {
  i: number;
  t: "tool_call";
  ts: number;
  start: number;
  end: number;
  turn?: number;
  /** The claude driver's monotonic tool-call index; absent on the fixed loop. */
  call?: number;
  name?: string;
  args?: unknown;
  clipped?: boolean;
}

/** One request with the context events that were packed inside it. */
export interface TurnGroup {
  kind: "turn";
  request: RequestEntry;
  /** The `via:"context"` batch immediately preceding, when it is in-window. */
  events: EventsServedEntry | null;
}

export interface ResponseGroup {
  kind: "response";
  entry: ResponseEntry;
  /**
   * Time since the last thing that fed the model — the preceding request on
   * the fixed loop (pure model latency), the previous response or tool result
   * under the claude driver's 1:N stream. Null off the window's top edge.
   */
  latencyMs: number | null;
}

/** One tool call: the call, its code when it was a snippet, and its result. */
export interface CallGroup {
  kind: "call";
  call: ToolCallView | null;
  snippet: SnippetEntry | null;
  result: SnippetResultEntry | null;
  name: string;
  turn: number | undefined;
  /**
   * `result.ts − call.ts`, only when the writer recorded the call before
   * running it (see module comment); null for the post-hoc appenders and for
   * orphan halves.
   */
  durationMs: number | null;
  isError: boolean;
}

/** Everything else renders exactly as before. */
export interface PlainGroup {
  kind: "plain";
  entry: FeedEntry;
}

export type FeedGroup = TurnGroup | ResponseGroup | CallGroup | PlainGroup;

/**
 * How far the result search may scan past interleaved entries. The state
 * ticker fires every ~5s, so a minute-long snippet can bank a dozen `state`
 * rows before its result; anything past this many is treated as unpaired
 * rather than risking a glue across half the window.
 */
const LOOKAHEAD = 50;

const isResult = (e: FeedEntry): e is SnippetResultEntry =>
  e.t === "snippet_result" || e.t === "tool_result";

/** Whether a result can belong to this call/snippet: every shared field agrees. */
function resultMatches(
  call: ToolCallView | null,
  snippet: SnippetEntry | null,
  r: SnippetResultEntry,
): boolean {
  // A snippet's result is always a snippet_result; a bare tool_result after a
  // snippet belongs to some other call.
  if (snippet !== null && r.t !== "snippet_result") return false;
  const src: { turn?: number; call?: number } | null = call ?? snippet;
  if (src === null) return true;
  const rr = r as SnippetResultEntry & { call?: number };
  if (src.turn !== undefined && rr.turn !== undefined && src.turn !== rr.turn) return false;
  if (src.call !== undefined && rr.call !== undefined && src.call !== rr.call) return false;
  if (call?.name !== undefined && rr.name !== undefined && call.name !== rr.name) return false;
  return true;
}

/** Whether a snippet entry is this call's code (they are appended together). */
function snippetMatches(call: ToolCallView, s: SnippetEntry): boolean {
  const ss = s as SnippetEntry & { call?: number };
  if (call.turn !== undefined && ss.turn !== undefined && call.turn !== ss.turn) return false;
  if (call.call !== undefined && ss.call !== undefined && call.call !== ss.call) return false;
  return true;
}

/**
 * Consume one tool call starting at `i` (a tool_call, an orphan snippet, or an
 * orphan result). `skipped` are the state/events entries scanned past on the
 * way to a matched result, in file order, for the caller to emit before the
 * card so nothing vanishes.
 */
function takeCall(
  entries: readonly FeedEntry[],
  i: number,
): { group: CallGroup; skipped: FeedEntry[]; next: number } {
  const first = entries[i]!;
  let call: ToolCallView | null = null;
  let snippet: SnippetEntry | null = null;
  let result: SnippetResultEntry | null = null;
  const skipped: FeedEntry[] = [];
  let next = i + 1;

  if (first.t === "tool_call") {
    call = first as unknown as ToolCallView;
    // The code is appended in the same tick as its call, so it is strictly next.
    const after = entries[next];
    if (after !== undefined && after.t === "snippet" && snippetMatches(call, after as SnippetEntry)) {
      snippet = after as SnippetEntry;
      next++;
    }
  } else if (first.t === "snippet") {
    snippet = first as SnippetEntry;
  } else {
    result = first as SnippetResultEntry;
  }

  if (result === null) {
    let k = next;
    const pending: FeedEntry[] = [];
    while (k < entries.length && k - next < LOOKAHEAD) {
      const c = entries[k]!;
      if (isResult(c)) {
        if (resultMatches(call, snippet, c)) {
          result = c;
          skipped.push(...pending);
          next = k + 1;
        }
        break;
      }
      // Only what the fixed loop can interleave mid-call; anything else means
      // the result was never written (the run died, or it is off-window).
      if (c.t === "state" || c.t === "events_served") {
        pending.push(c);
        k++;
        continue;
      }
      break;
    }
  }

  const name =
    call?.name ?? result?.name ?? (snippet !== null ? "run_snippet" : "?");
  const turn = (call ?? snippet ?? result)?.turn;
  // Genuine only when the call was recorded before dispatch: the fixed loop
  // writes `turn` and never `call`; both post-hoc writers fail one of the two.
  const genuine =
    call !== null && result !== null && call.turn !== undefined && call.call === undefined;
  const durationMs =
    genuine && call!.ts > 0 && result!.ts >= call!.ts ? result!.ts - call!.ts : null;

  return {
    group: {
      kind: "call",
      call,
      snippet,
      result,
      name: typeof name === "string" ? name : "?",
      turn,
      durationMs,
      isError: result?.isError === true,
    },
    skipped,
    next,
  };
}

/** Derive the composite view. Pure; safe to re-run on every entries change. */
export function groupFeed(entries: readonly FeedEntry[]): FeedGroup[] {
  const out: FeedGroup[] = [];
  /** ts of the last entry that fed or was the model, for response latency. */
  let lastActivityTs: number | null = null;
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;

    if (e.t === "events_served" && (e as EventsServedEntry).via === "context") {
      // The request these events were packed into follows immediately; only
      // the state ticker can land in between.
      let j = i + 1;
      const between: FeedEntry[] = [];
      while (j < entries.length && entries[j]!.t === "state" && j - i <= LOOKAHEAD) {
        between.push(entries[j]!);
        j++;
      }
      const req = entries[j];
      if (req !== undefined && req.t === "request") {
        for (const s of between) out.push({ kind: "plain", entry: s });
        out.push({ kind: "turn", request: req as RequestEntry, events: e as EventsServedEntry });
        if (req.ts > 0) lastActivityTs = req.ts;
        i = j + 1;
        continue;
      }
      // Live tail edge: the request hasn't arrived (or is off-window) — the
      // batch stands alone and the derivation heals when it shows up.
      out.push({ kind: "plain", entry: e });
      i++;
      continue;
    }

    if (e.t === "request") {
      // Its context events are off the top of the window.
      out.push({ kind: "turn", request: e as RequestEntry, events: null });
      if (e.ts > 0) lastActivityTs = e.ts;
      i++;
      continue;
    }

    if (e.t === "response") {
      const latencyMs =
        lastActivityTs !== null && e.ts > 0 && e.ts >= lastActivityTs
          ? e.ts - lastActivityTs
          : null;
      out.push({ kind: "response", entry: e as ResponseEntry, latencyMs });
      if (e.ts > 0) lastActivityTs = e.ts;
      i++;
      continue;
    }

    if (e.t === "tool_call" || e.t === "snippet" || isResult(e)) {
      const taken = takeCall(entries, i);
      for (const s of taken.skipped) out.push({ kind: "plain", entry: s });
      out.push(taken.group);
      const r = taken.group.result;
      if (r !== null && r.ts > 0) lastActivityTs = r.ts;
      i = taken.next;
      continue;
    }

    out.push({ kind: "plain", entry: e });
    i++;
  }
  return out;
}
