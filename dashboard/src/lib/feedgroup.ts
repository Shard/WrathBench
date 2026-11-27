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
 * The action log is the exception to adjacency: an `actions` record carries
 * the `dispatchTs` of the call whose snippet dispatched it (`callTs`), and the
 * writers put it on opposite sides of the call — before the `tool_call` on the
 * post-hoc appenders, between the snippet and its result on the fixed loop — so
 * it is joined by that value, wherever in the window it sits. A record whose
 * call is not in the window (or that no call owns: actions outside every
 * snippet) stays a row of its own, and so does a routine's: it is flushed on
 * an idle timer for as long as the routine runs, so on its launching call's
 * card it would grow without end under a result written hours earlier.
 *
 * A `move` record is joined the same way where it says whose it is: the
 * viewer stamps it with the `callTs` of the call that dispatched it and marks
 * a routine's (`viewer/record-feed.ts`), and a call's own moves are
 * already on its card, as the action log's `move to …` lines with their
 * verdicts. So they are held on the group (`moves`) rather than drawn again
 * under it. A routine's moves, a move whose call is off the window, and every
 * move of a run recorded without the stamp stay rows.
 *
 * A `watchdog` record whose `termination` follows with the same reason is
 * not a row: the termination says the same thing (`foldedWatchdogs`).
 *
 * Joined by time: a `deploy` a write set off and the `wake` a `yield` ended
 * on are drawn on that call's card, not as rows: the deploy says on the card
 * what the write's result already half says, and the wake's block is the
 * yield's result text. Their stamp inside the call's `[dispatchTs, result]`
 * is what joins them (`indexJoins`).
 *
 * Envelopes: a reply with no text that only called tools is the envelope its
 * calls came in, and the calls have cards. It is not a row. What it alone
 * says moves onto its card as the card's `lead`: pi's reasoning size, stop
 * reason, error and output tokens, the fixed loop's output tokens. The
 * writers put it on different sides of its call — before it on pi and the
 * fixed loop, which write the reply before the tool runs and the call after;
 * after it on claude-code, which holds a message until the next one starts,
 * and on codex, which writes an item's when the next item lands — so the
 * harness says which way to look. An envelope no card claims (a call the CLI
 * never ran, one still in flight) stays a row. claude-code's thinking
 * estimate, which the viewer sums onto the reply record after the markers
 * (`ResponseEntry.thinkingTokens`), is the model's next output's, card or
 * reply in words. A card's think time is its dispatch minus the last thing
 * that fed the model, except on codex, where code mode dispatches from a
 * script.
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
  ActionsEntry,
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
   * under the claude driver's 1:N stream. Null off the window's top edge, and
   * on a codex run, whose driver writes a reply when the CLI's next item
   * arrives, so the gap is that item's, not the model's.
   */
  latencyMs: number | null;
  /** What led to this reply; null when nothing did. See `Lead`. */
  lead: Lead | null;
}

/**
 * What a model output carried besides itself, taken off the records around
 * it that are not rows of their own (the module comment, "Envelopes").
 */
export interface Lead {
  /**
   * The model's time before this call: its dispatch minus the last thing that
   * fed the model (a result, the turn's request, a reply). Null on a codex
   * run, where code mode dispatches calls from a script with no model between
   * them, and under `THINK_MIN_MS`, where it is a script's or one reply's
   * calls following one another.
   */
  thinkMs: number | null;
  /** claude-code: the thinking tokens the CLI estimated while the model worked towards this output. */
  thinkingTokens: number | null;
  /** The envelope of tool calls this call came in, where the writer puts it before its call (pi, the fixed loop). */
  envelope: ResponseEntry | null;
}

/** One tool call: the call, its code when it was a snippet, and its result. */
export interface CallGroup {
  kind: "call";
  call: ToolCallEntry | null;
  snippet: SnippetEntry | null;
  result: SnippetResultEntry | null;
  /** The action log of this call's snippet, joined by `callTs`; empty for runs without one. */
  actions: ActionsEntry[];
  /** The `move` records of this call's own moves, which its action lines already show; see the module comment. */
  moves: FeedEntry[];
  /** The program deploys this call's write set off (`deploy` records), joined by time; see "Joined by time". */
  deploys: FeedEntry[];
  /** The `wake` record of a `yield`, whose block is the call's result text. */
  wake: FeedEntry | null;
  /** What led to the call; null when nothing did. */
  lead: Lead | null;
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
  actionsByCall: ReadonlyMap<number, ActionsEntry[]>,
  movesByCall: ReadonlyMap<number, FeedEntry[]>,
  joins: Joins,
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

  const actions = typeof call?.dispatchTs === "number" ? (actionsByCall.get(call.dispatchTs) ?? []) : [];
  const moves = typeof call?.dispatchTs === "number" ? (movesByCall.get(call.dispatchTs) ?? NO_MOVES) : NO_MOVES;
  const byTime = call !== null ? joins.byCall.get(call.i) : undefined;
  return {
    group: {
      kind: "call",
      call,
      snippet,
      result,
      actions,
      moves,
      deploys: byTime?.deploys ?? NO_MOVES,
      wake: byTime?.wake ?? null,
      lead: null,
      durationMs: callDuration(call, result),
    },
    // Joined records render inside the card, not before it.
    skipped: skipped.filter((s) => !joined(s, actionsByCall) && !ownMove(s, movesByCall) && !joins.claimed.has(s)),
    next,
  };
}

/**
 * The window's action-log records by the call they belong to — only for calls
 * that are in the window, so a record whose call is off the top still renders.
 */
function indexActions(entries: readonly FeedEntry[]): Map<number, ActionsEntry[]> {
  const calls = new Set<number>();
  for (const e of entries) {
    const ts = (e as ToolCallEntry).dispatchTs;
    if (e.t === "tool_call" && typeof ts === "number") calls.add(ts);
  }
  const out = new Map<number, ActionsEntry[]>();
  for (const e of entries) {
    if (e.t !== "actions") continue;
    const callTs = (e as ActionsEntry).callTs;
    // A routine's log is flushed on its own clock, long after the call that started it returned: a row of its own.
    if (typeof callTs !== "number" || !calls.has(callTs) || (e as ActionsEntry).routine === true) continue;
    const list = out.get(callTs) ?? [];
    list.push(e as ActionsEntry);
    out.set(callTs, list);
  }
  return out;
}

const NO_MOVES: FeedEntry[] = [];

/**
 * The window's `move` records by the call that dispatched them: only a call
 * that is in the window and has an action log there, whose lines are where
 * the move is read, and never a routine's.
 */
function indexMoves(entries: readonly FeedEntry[], actionsByCall: ReadonlyMap<number, ActionsEntry[]>): Map<number, FeedEntry[]> {
  const out = new Map<number, FeedEntry[]>();
  for (const e of entries) {
    if (e.t !== "move") continue;
    const r = e as unknown as Record<string, unknown>;
    const callTs = r["callTs"];
    if (typeof callTs !== "number" || r["routine"] === true || !actionsByCall.has(callTs)) continue;
    const list = out.get(callTs) ?? [];
    list.push(e);
    out.set(callTs, list);
  }
  return out;
}

/** Whether an entry is a `move` record a call in the window has claimed. */
function ownMove(e: FeedEntry, movesByCall: ReadonlyMap<number, FeedEntry[]>): boolean {
  if (e.t !== "move") return false;
  const callTs = (e as unknown as Record<string, unknown>)["callTs"];
  return typeof callTs === "number" && (movesByCall.get(callTs)?.includes(e) ?? false);
}

/** Whether an entry is an action-log record a call in the window has claimed. */
function joined(e: FeedEntry, actionsByCall: ReadonlyMap<number, ActionsEntry[]>): boolean {
  if (e.t !== "actions") return false;
  const callTs = (e as ActionsEntry).callTs;
  return typeof callTs === "number" && (actionsByCall.get(callTs)?.includes(e as ActionsEntry) ?? false);
}

/** The records joined to a call by time, by the call's entry index, and every record so claimed. */
interface Joins {
  byCall: Map<number, { deploys: FeedEntry[]; wake: FeedEntry | null }>;
  claimed: Set<FeedEntry>;
}

/** The tools whose call can set a deploy off: a write to the program. */
const DEPLOYING_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file", "delete_file"]);

/**
 * How far before a call a record it set off may sit. The post-hoc writers
 * append the call after it ran, so what it caused (a deploy, a yield's wake)
 * is on the file first; a handful of rows covers the envelope and markers
 * that can land between.
 */
const JOIN_BEHIND = 8;

/**
 * Join each `deploy` to the write that set it off and each yield's `wake` to
 * its `yield`, by time: the record's stamp falls inside the call's
 * `[dispatchTs, result.ts]`. The writers put these records on either side of
 * the call (before it on the post-hoc appenders, between the call and its
 * result on the fixed loop), so position alone cannot say whose they are;
 * the window can, and it is tight. A codex wake (`via: "turn-end"`) has no
 * call and is never joined: it is the only record of that wait.
 */
function indexJoins(entries: readonly FeedEntry[]): Joins {
  const out: Joins = { byCall: new Map(), claimed: new Set() };
  for (let c = 0; c < entries.length; c++) {
    const call = entries[c]!;
    if (call.t !== "tool_call") continue;
    const name = (call as ToolCallEntry).name;
    const dispatched = (call as ToolCallEntry).dispatchTs;
    if (typeof dispatched !== "number" || (name !== "yield" && !DEPLOYING_TOOLS.has(name ?? ""))) continue;
    let r = c + 1;
    while (r < entries.length && r - c <= LOOKAHEAD && !(isResult(entries[r]!) && resultMatches(call as ToolCallEntry, null, entries[r] as SnippetResultEntry))) {
      if (entries[r]!.t === "tool_call" || entries[r]!.t === "request") break;
      r++;
    }
    const result = entries[r];
    if (result === undefined || !isResult(result)) continue;
    let deploys: FeedEntry[] | undefined;
    let wake: FeedEntry | null = null;
    for (let k = Math.max(0, c - JOIN_BEHIND); k < r; k++) {
      const e = entries[k]!;
      if (out.claimed.has(e) || e.ts < dispatched || e.ts > result.ts) continue;
      if (e.t === "deploy" && name !== "yield") (deploys ??= []).push(e);
      else if (e.t === "wake" && name === "yield" && wake === null && (e as { via?: unknown }).via !== "turn-end") wake = e;
      else continue;
      out.claimed.add(e);
    }
    if (deploys !== undefined || wake !== null) out.byCall.set(call.i, { deploys: deploys ?? NO_MOVES, wake });
  }
  return out;
}

/** The records that end a search for a watchdog's termination: the run went on, so it was not this one's. */
const WATCHDOG_STOP: ReadonlySet<string> = new Set(["request", "response", "tool_call", "snippet", "meta", "pause", "resume"]);

/**
 * Watchdog records whose termination follows with the same reason. The
 * watchdog writes its verdict and the episode ends on it, so on an idle stop
 * the two say the same reason and detail back to back; the termination says
 * it once. Only ambient records (a wind-down, the last state sample) may sit
 * between.
 */
function foldedWatchdogs(entries: readonly FeedEntry[]): Set<FeedEntry> {
  const out = new Set<FeedEntry>();
  for (let w = 0; w < entries.length; w++) {
    const dog = entries[w]!;
    if (dog.t !== "watchdog") continue;
    const reason = (dog as unknown as Record<string, unknown>)["reason"];
    for (let k = w + 1; k < entries.length && k - w <= LOOKAHEAD; k++) {
      const e = entries[k]!;
      if (e.t === "termination") {
        if ((e as unknown as Record<string, unknown>)["reason"] === reason) out.add(dog);
        break;
      }
      if (WATCHDOG_STOP.has(e.t) || e.t === "watchdog") break;
    }
  }
  return out;
}

/* ---------------------------------------------------------- envelopes */

/** A model time this short is calls following one another, not the model. */
export const THINK_MIN_MS = 500;

/**
 * The prefix a CLI puts on the run's own tools. A name without it, on such a
 * run, is a tool the CLI did not route to the run (the model asked for one
 * that does not exist, say), so it can never be one of the run's calls.
 */
const CLI_PREFIX: Readonly<Record<string, string>> = {
  "claude-code": "mcp__wrathbench__",
  codex: "wrathbench.",
  pi: "mcp__wrathbench__",
};

/** A tool name as a call card names it, or null when on this run it cannot be one of the run's calls. */
export function envelopeTool(name: string, harness: string | null): string | null {
  const prefix = harness !== null ? CLI_PREFIX[harness] : undefined;
  if (prefix === undefined) return name;
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

/** A reply with no text that only called tools: the envelope the calls came in, which have cards of their own. */
export function isEnvelope(e: ResponseEntry): boolean {
  return (e.text ?? "").trim().length === 0 && (e.tools ?? []).length > 0 && e.kind !== "compaction";
}

/** Whether a reply's envelope names this card's tool. */
function envelopeNames(e: ResponseEntry, g: CallGroup, harness: string | null): boolean {
  const name = g.call?.name ?? g.result?.name ?? (g.snippet !== null ? "run_snippet" : undefined);
  return name !== undefined && (e.tools ?? []).some((t) => envelopeTool(t, harness) === name);
}

/**
 * Where a harness writes a call's envelope: before the call (pi, the fixed
 * loop: the reply is on the file before the tool runs and the call is
 * appended after) or after it (claude-code holds an assistant message until
 * the next one arrives; codex writes an item's when the next item lands).
 */
const ENVELOPE_AFTER: ReadonlySet<string> = new Set(["claude-code", "codex"]);
/** How many of the latest cards an after-the-call envelope may belong to: codex can finish items out of order. */
const ENVELOPE_BEHIND = 3;

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
export function anchorOf(g: FeedGroup): number {
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

function sameLead(a: Lead | null, b: Lead | null): boolean {
  if (a === null || b === null) return a === b;
  return a.thinkMs === b.thinkMs && a.thinkingTokens === b.thinkingTokens && a.envelope === b.envelope;
}

/** Whether two derivations of a group are interchangeable, member for member. */
function sameGroup(a: FeedGroup, b: FeedGroup): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "turn":
      return a.request === (b as TurnGroup).request && a.events === (b as TurnGroup).events;
    case "response":
      return a.entry === (b as ResponseGroup).entry && a.latencyMs === (b as ResponseGroup).latencyMs && sameLead(a.lead, (b as ResponseGroup).lead);
    case "call": {
      const o = b as CallGroup;
      return (
        a.call === o.call &&
        a.snippet === o.snippet &&
        a.result === o.result &&
        a.durationMs === o.durationMs &&
        a.wake === o.wake &&
        sameLead(a.lead, o.lead) &&
        a.deploys.length === o.deploys.length &&
        a.deploys.every((x, k) => x === o.deploys[k]) &&
        a.actions.length === o.actions.length &&
        a.actions.every((x, k) => x === o.actions[k]) &&
        a.moves.length === o.moves.length &&
        a.moves.every((x, k) => x === o.moves[k])
      );
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
 *
 * `harness` is the run's (`wrathbench`, `claude-code`, `codex`, `pi`), which
 * says where a call's envelope sits and whether a gap before a call is the
 * model's ("Envelopes", the module comment). `modelSide` false is a run with
 * no record of its model (`hasModelSide`, `lib/runview.ts`): a session read
 * from a wrath-mcp store, whose calls are its record's. A gap before one of
 * its calls is nobody's to name, so no card has a think time.
 */
export function groupFeed(entries: readonly FeedEntry[], prev: readonly FeedGroup[] = [], harness: string | null = null, modelSide = true): FeedGroup[] {
  const recycled = new Map<number, FeedGroup>();
  for (const g of prev) recycled.set(anchorOf(g), g);

  /** Rows in order; a slot is nulled when what it held turns out to belong to a card. */
  const out: (FeedGroup | null)[] = [];
  const emit = (g: FeedGroup): number => {
    const old = recycled.get(anchorOf(g));
    out.push(old !== undefined && sameGroup(g, old) ? old : g);
    return out.length - 1;
  };

  const actionsByCall = indexActions(entries);
  const movesByCall = indexMoves(entries, actionsByCall);
  const joins = indexJoins(entries);
  const dogs = foldedWatchdogs(entries);
  const hidden = (s: FeedEntry): boolean => joined(s, actionsByCall) || ownMove(s, movesByCall) || joins.claimed.has(s) || dogs.has(s);

  const after = harness !== null && ENVELOPE_AFTER.has(harness);
  const timed = modelSide && harness !== "codex";

  /** ts of the last entry that fed or was the model, for response latency. */
  let lastActivityTs: number | null = null;
  /** ts of the last thing that fed the model — a result, a request, a reply — for a call's think time. */
  let lastFedTs: number | null = null;
  /** claude-code's thinking estimate not yet given to an output (`ResponseEntry.thinkingTokens`). */
  let thinking = null as number | null;
  /** An envelope written before its call, waiting for that call's card (pi, the fixed loop). */
  let pending: { slot: number; entry: ResponseEntry; latencyMs: number | null } | null = null;
  /** The latest cards since the turn began, for an envelope written after its call; claimed ones are taken out. */
  let recent: CallGroup[] = [];

  const takeThinking = (): number | null => {
    const n = thinking;
    thinking = null;
    return n;
  };

  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;

    // Drawn inside its call's card, wherever it sits.
    if (hidden(e)) {
      i++;
      continue;
    }

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
        for (const s of between) if (!hidden(s)) emit({ kind: "plain", entry: s });
        emit({ kind: "turn", request: req as RequestEntry, events: e as EventsServedEntry });
        if (req.ts > 0) lastActivityTs = lastFedTs = req.ts;
        pending = null;
        recent = [];
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
      if (e.ts > 0) lastActivityTs = lastFedTs = e.ts;
      pending = null;
      recent = [];
      i++;
      continue;
    }

    if (e.t === "response") {
      const r = e as ResponseEntry;
      // A codex envelope is written when the CLI's next item lands: its gap is that item's, not the model's.
      const latencyMs =
        !(harness === "codex" && isEnvelope(r)) && lastActivityTs !== null && e.ts > 0 && e.ts >= lastActivityTs
          ? e.ts - lastActivityTs
          : null;
      i++;
      // The thinking that led to the model's next output, whichever record that turns out to be.
      if (typeof r.thinkingTokens === "number" && r.thinkingTokens > 0) thinking = (thinking ?? 0) + r.thinkingTokens;
      if (isEnvelope(r)) {
        if (after) {
          // Its call's card is already drawn: the latest that names its tool, and no other envelope has.
          let hit = -1;
          for (let k = recent.length - 1; k >= 0 && k >= recent.length - ENVELOPE_BEHIND; k--) {
            if (envelopeNames(r, recent[k]!, harness)) {
              hit = k;
              break;
            }
          }
          if (hit !== -1) {
            // Not a row, so not where the next reply's latency is measured from: a claude-code
            // envelope is stamped as the next message starts, and the reply after it would read
            // only the gap between two blocks of one message.
            recent.splice(hit, 1);
            continue;
          }
        }
        if (!after) {
          if (e.ts > 0) lastActivityTs = e.ts;
          // Its card comes next; held in place, a row only if none does.
          pending = { slot: emit({ kind: "response", entry: r, latencyMs, lead: null }), entry: r, latencyMs };
          continue;
        }
      }
      // A reply in words, or an envelope no card claims (a call the CLI never ran, or one still running).
      if (e.ts > 0) lastActivityTs = e.ts;
      const tokens = takeThinking();
      emit({ kind: "response", entry: r, latencyMs, lead: tokens === null ? null : { thinkMs: null, thinkingTokens: tokens, envelope: null } });
      if (!isEnvelope(r) && (r.text ?? "").trim().length > 0 && e.ts > 0) lastFedTs = e.ts;
      continue;
    }

    if (e.t === "tool_call" || e.t === "snippet" || isResult(e)) {
      const taken = takeCall(entries, i, actionsByCall, movesByCall, joins);
      for (const s of taken.skipped) emit({ kind: "plain", entry: s });
      let group = taken.group;
      if (group.call !== null) {
        let envelope: ResponseEntry | null = null;
        let fallbackMs: number | null = null;
        if (pending !== null && envelopeNames(pending.entry, group, harness)) {
          out[pending.slot] = null;
          envelope = pending.entry;
          fallbackMs = pending.latencyMs;
        }
        pending = null;
        const dispatched = group.call.dispatchTs;
        const gap = typeof dispatched === "number" && lastFedTs !== null ? dispatched - lastFedTs : fallbackMs;
        const thinkMs = timed && gap !== null && gap >= THINK_MIN_MS ? gap : null;
        const thinkingTokens = takeThinking();
        if (thinkMs !== null || thinkingTokens !== null || envelope !== null) group = { ...group, lead: { thinkMs, thinkingTokens, envelope } };
      }
      emit(group);
      if (group.call !== null) recent.push(group);
      const r = group.result;
      if (r !== null && r.ts > 0) lastActivityTs = lastFedTs = r.ts;
      else if (r === null) lastFedTs = null;
      i = taken.next;
      continue;
    }

    emit({ kind: "plain", entry: e });
    i++;
  }
  return out.filter((g): g is FeedGroup => g !== null);
}
