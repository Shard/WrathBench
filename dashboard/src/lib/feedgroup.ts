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
 * partner scrolls in. (Re-derivation is cheap; what would not be cheap is
 * re-rendering, so a settled group is returned as the previous run's object —
 * see `groupFeed`'s `prev` parameter.)
 *
 * Pairing is by adjacency, not by id, matching how the three writers append:
 *
 * - `runner/src/loop.ts` writes `tool_call` (+`snippet`) synchronously before
 *   dispatching the tool and the result after it, so anything its timers and
 *   taps emit — `state` ticks, `events_served (via:"tool")`, milestones,
 *   quest completions, whatever record kind ships next — legitimately lands
 *   in between. The search therefore skips everything EXCEPT the closed set
 *   of records that structure a turn or end an episode (`STOPPERS`): one of
 *   those means the result was never written. An allow-list of ambient types
 *   would rot each time the runner grows a record kind; the structural set is
 *   closed by design.
 * - `runner/src/adapter-claude.ts`, `runner/src/adapter-codex.ts` and
 *   `runner/src/mcp.ts` append the whole run after the call completes, so the
 *   members are strictly adjacent — and their timestamp spread is write time,
 *   not run time.
 *
 * Where turn/call/name fields exist on both sides they must agree, so a
 * result can never be glued to a stranger's call across a missing partner.
 *
 * A card's duration is the result's `ts` minus the call's `dispatchTs`, which
 * every writer stamps with the moment it handed the call to the tool. That is
 * the only reading for a stamped call: the field shapes above say how records
 * pair, never how they were timed. Trajectories from before the stamp fall
 * back to inferring the writer from shape — `turn` present and `call` absent
 * is the fixed loop, whose `ts` was taken before dispatch; a `call` index (a
 * CLI driver) or no `turn` at all (the MCP server) is post-hoc, and shows no
 * duration rather than a fabricated ~0ms.
 */

import type {
  EventsServedEntry,
  FeedEntry,
  RequestEntry,
  ResponseEntry,
  SnippetEntry,
  SnippetResultEntry,
  ToolCallEntry,
} from "@viewer/api-types";

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
  call: ToolCallEntry | null;
  snippet: SnippetEntry | null;
  result: SnippetResultEntry | null;
  /**
   * `result.ts − call.dispatchTs` (see module comment). On an unstamped
   * legacy call, `result.ts − call.ts` when the shape says the call was
   * recorded before it ran and null for the post-hoc appenders. Null for
   * orphan halves.
   */
  durationMs: number | null;
}

/** Everything else renders exactly as before. */
export interface PlainGroup {
  kind: "plain";
  entry: FeedEntry;
}

export type FeedGroup = TurnGroup | ResponseGroup | CallGroup | PlainGroup;

/**
 * The records that structure a turn or end an episode: hitting one of these
 * while searching for a call's result (or a context batch's request) means
 * the partner was never written. Everything else is ambient — emitted by
 * timers and taps while a call is in flight — and is scanned past.
 */
const STOPPERS = new Set([
  "request",
  "response",
  "tool_call",
  "snippet",
  "meta",
  "pause",
  "resume",
  "termination",
  "watchdog",
  "limit",
]);

/**
 * How far the result search may scan past interleaved ambient entries. The
 * state ticker fires every ~5s, so a minute-long snippet can bank a dozen
 * rows before its result; anything past this many is treated as unpaired
 * rather than risking a glue across half the window.
 */
const LOOKAHEAD = 50;

const isResult = (e: FeedEntry): e is SnippetResultEntry =>
  e.t === "snippet_result" || e.t === "tool_result";

/** Whether a result can belong to this call/snippet: every shared field agrees. */
function resultMatches(
  call: ToolCallEntry | null,
  snippet: SnippetEntry | null,
  r: SnippetResultEntry,
): boolean {
  // A snippet's result is always a snippet_result; a bare tool_result after a
  // snippet belongs to some other call.
  if (snippet !== null && r.t !== "snippet_result") return false;
  const src = call ?? snippet;
  if (src === null) return true;
  if (src.turn !== undefined && r.turn !== undefined && src.turn !== r.turn) return false;
  if (src.call !== undefined && r.call !== undefined && src.call !== r.call) return false;
  if (call?.name !== undefined && r.name !== undefined && call.name !== r.name) return false;
  return true;
}

/** Whether a snippet entry is this call's code (they are appended together). */
function snippetMatches(call: ToolCallEntry, s: SnippetEntry): boolean {
  if (call.turn !== undefined && s.turn !== undefined && call.turn !== s.turn) return false;
  if (call.call !== undefined && s.call !== undefined && call.call !== s.call) return false;
  return true;
}

/**
 * Consume one tool call starting at `i` (a tool_call, an orphan snippet, or an
 * orphan result). `skipped` are the ambient entries scanned past on the way to
 * a matched result, in file order, for the caller to emit before the card so
 * nothing vanishes.
 */
function takeCall(
  entries: readonly FeedEntry[],
  i: number,
): { group: CallGroup; skipped: FeedEntry[]; next: number } {
  const first = entries[i]!;
  let call: ToolCallEntry | null = null;
  let snippet: SnippetEntry | null = null;
  let result: SnippetResultEntry | null = null;
  let skipped: FeedEntry[] = [];
  let next = i + 1;

  if (first.t === "tool_call") {
    call = first as ToolCallEntry;
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
          skipped = pending;
          next = k + 1;
        }
        break;
      }
      // A structural record means the result was never written (the run died,
      // or it is off-window); anything ambient is scanned past and re-emitted.
      if (STOPPERS.has(c.t)) break;
      pending.push(c);
      k++;
    }
  }

  return { group: { kind: "call", call, snippet, result, durationMs: callDuration(call, result) }, skipped, next };
}

/** How long a paired call took; see the module comment for the two readings. */
function callDuration(call: ToolCallEntry | null, result: SnippetResultEntry | null): number | null {
  if (call === null || result === null) return null;
  // Stamped by its writer: the only reading, whatever the record's shape.
  if (typeof call.dispatchTs === "number") {
    return call.dispatchTs > 0 && result.ts >= call.dispatchTs ? result.ts - call.dispatchTs : null;
  }
  // Legacy, unstamped: genuine only when the call was recorded before dispatch
  // — the fixed loop writes `turn` and never `call`; the post-hoc writers fail
  // one of the two.
  const genuine = call.turn !== undefined && call.call === undefined;
  return genuine && call.ts > 0 && result.ts >= call.ts ? result.ts - call.ts : null;
}

/** The entry a group is anchored on — its identity across re-derivations. */
function anchorOf(g: FeedGroup): number {
  switch (g.kind) {
    case "turn":
      return g.request.i;
    case "response":
      return g.entry.i;
    case "call":
      return (g.call ?? g.snippet ?? g.result)!.i;
    default:
      return g.entry.i;
  }
}

/** Whether two derivations of a group are interchangeable, member for member. */
function sameGroup(a: FeedGroup, b: FeedGroup): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "turn":
      return a.request === (b as TurnGroup).request && a.events === (b as TurnGroup).events;
    case "response":
      return a.entry === (b as ResponseGroup).entry && a.latencyMs === (b as ResponseGroup).latencyMs;
    case "call": {
      const o = b as CallGroup;
      return a.call === o.call && a.snippet === o.snippet && a.result === o.result && a.durationMs === o.durationMs;
    }
    default:
      return a.entry === (b as PlainGroup).entry;
  }
}

/**
 * Derive the composite view.
 *
 * Pure over `entries`; `prev` (the previous derivation, if any) only recycles
 * object identity: a group whose members are the same entry objects as last
 * time is returned as the SAME group object. Solid's `<For>` reconciles by
 * reference, so without this every live-tail append would tear down and
 * rebuild the DOM (and fold state) of all ~200 settled rows to add one. The
 * scalar fields are compared too — a prepended page can give the window's
 * first response an anchor it lacked, and that row must re-render.
 */
export function groupFeed(entries: readonly FeedEntry[], prev: readonly FeedGroup[] = []): FeedGroup[] {
  const recycled = new Map<number, FeedGroup>();
  for (const g of prev) recycled.set(anchorOf(g), g);

  const out: FeedGroup[] = [];
  const emit = (g: FeedGroup): void => {
    const old = recycled.get(anchorOf(g));
    out.push(old !== undefined && sameGroup(g, old) ? old : g);
  };

  /** ts of the last entry that fed or was the model, for response latency. */
  let lastActivityTs: number | null = null;
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;

    if (e.t === "events_served" && (e as EventsServedEntry).via === "context") {
      // The request these events were packed into follows immediately; only
      // ambient records (the state ticker's pass) can land in between.
      let j = i + 1;
      const between: FeedEntry[] = [];
      while (j < entries.length && !STOPPERS.has(entries[j]!.t) && !isResult(entries[j]!) && j - i <= LOOKAHEAD) {
        between.push(entries[j]!);
        j++;
      }
      const req = entries[j];
      if (req !== undefined && req.t === "request") {
        for (const s of between) emit({ kind: "plain", entry: s });
        emit({ kind: "turn", request: req as RequestEntry, events: e as EventsServedEntry });
        if (req.ts > 0) lastActivityTs = req.ts;
        i = j + 1;
        continue;
      }
      // Live tail edge: the request hasn't arrived (or is off-window) — the
      // batch stands alone and the derivation heals when it shows up.
      emit({ kind: "plain", entry: e });
      i++;
      continue;
    }

    if (e.t === "request") {
      // Its context events are off the top of the window.
      emit({ kind: "turn", request: e as RequestEntry, events: null });
      if (e.ts > 0) lastActivityTs = e.ts;
      i++;
      continue;
    }

    if (e.t === "response") {
      const latencyMs =
        lastActivityTs !== null && e.ts > 0 && e.ts >= lastActivityTs
          ? e.ts - lastActivityTs
          : null;
      emit({ kind: "response", entry: e as ResponseEntry, latencyMs });
      if (e.ts > 0) lastActivityTs = e.ts;
      i++;
      continue;
    }

    if (e.t === "tool_call" || e.t === "snippet" || isResult(e)) {
      const taken = takeCall(entries, i);
      for (const s of taken.skipped) emit({ kind: "plain", entry: s });
      emit(taken.group);
      const r = taken.group.result;
      if (r !== null && r.ts > 0) lastActivityTs = r.ts;
      i = taken.next;
      continue;
    }

    emit({ kind: "plain", entry: e });
    i++;
  }
  return out;
}
