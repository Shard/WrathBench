/**
 * A v1 run's game side in its run page's feed.
 *
 * A 0.5 run's trajectory carried the game side beside the model's turns: the
 * milestones, the turn-ins, the action log, the movement intentions and the
 * event batches a tool served. A v1 trajectory is the model side only, and
 * those are the session record's (`wrath-mcp/docs/SESSION-FORMAT.md`): the
 * `events` stream and the `calls` stream's `actions`, `move` and `events`
 * rows. `RecordFollower` reads them on from where it left off, and
 * `feedRecordOf` restates each in the trajectory record shape the feed has
 * always drawn, with the turn in flight joined by timestamp (decision 9 of
 * wrath-mcp#29). `TrajectoryTail` merges them into its entries by time.
 *
 * A session read from a wrath-mcp store (`runner/src/session-store.ts`) has
 * no trajectory, so nothing else holds its tool calls: there the record's
 * `call` and `result` rows are the feed's calls too (`pairStoreCalls`,
 * `storeCallRecordsOf`), drawn as the cards a CLI driver's are.
 *
 * Each line is kept as a locator (stream, segment, byte range), never as
 * text, so a long run's feed costs no more memory than its trajectory's; the
 * raw view reads the segment again. Read-only.
 */

import { listSegments, readSegmentBytes, type CallRow, type EventRow } from "@wrathbench/mcp/record";
import { milestoneOfEvent } from "../runner/src/run-reader";

/** The two streams the feed reads; `trace` is the map's and `nearby` the ring's. */
export type FeedStream = "events" | "calls";

/** Where one record line is: its stream, its segment by stem, and its byte range in the segment's plain bytes. */
export interface RecordLoc {
  stream: FeedStream;
  stem: string;
  start: number;
  end: number;
}

export interface RecordLine {
  loc: RecordLoc;
  row: EventRow | CallRow;
  /** A store session's `result` row: its `call` row and where that is (`pairStoreCalls`); absent when the record holds none. */
  call?: HeldCall;
}

type CallRowOf<K extends CallRow["kind"]> = Extract<CallRow, { kind: K }>;

/** A `call` row and where it is (its own line, or a segment's `key` that restates it), and its place among the session's calls, from 1. */
export interface HeldCall {
  row: CallRowOf<"call">;
  loc: RecordLoc;
  n: number;
}

/** What `pairStoreCalls` keeps between reads: the calls without a result yet, by id, and how many calls it has read. */
export interface StoreCalls {
  held: Map<number, HeldCall>;
  count: number;
}

const decoder = new TextDecoder();

/** The complete lines of `bytes` from `offset`, each with its byte range; and where the next read starts. */
function linesFrom(bytes: Uint8Array, offset: number): { lines: { start: number; end: number; text: string }[]; consumed: number } {
  const lines: { start: number; end: number; text: string }[] = [];
  let at = offset;
  for (;;) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0) break;
    if (nl > at) lines.push({ start: at, end: nl, text: decoder.decode(bytes.subarray(at, nl)) });
    at = nl + 1;
  }
  return { lines, consumed: at };
}

/** Follow a session's `events` and `calls` streams, line by line, from where the last read stopped. */
export class RecordFollower {
  private readonly cursors: Record<FeedStream, { stem: string; offset: number } | null> = { events: null, calls: null };

  constructor(readonly sessionDir: string) {}

  /** Every complete line written since the last read, both streams, in the order written within each. */
  read(): RecordLine[] {
    return [...this.readStream("events"), ...this.readStream("calls")];
  }

  private readStream(stream: FeedStream): RecordLine[] {
    const out: RecordLine[] = [];
    let segs;
    try {
      segs = listSegments(this.sessionDir, stream);
    } catch {
      return out;
    }
    const cursor = this.cursors[stream];
    for (const seg of segs) {
      if (cursor !== null && seg.stem < cursor.stem) continue;
      let bytes: Uint8Array;
      try {
        bytes = readSegmentBytes(seg.path);
      } catch {
        break;
      }
      const from = cursor !== null && seg.stem === cursor.stem ? cursor.offset : 0;
      const { lines, consumed } = linesFrom(bytes, from);
      for (const l of lines) {
        let row: EventRow | CallRow;
        try {
          row = JSON.parse(l.text) as EventRow | CallRow;
        } catch {
          continue; // a torn line is skipped, as every reader of the format skips it
        }
        if (typeof row !== "object" || row === null || typeof row.ts !== "number") continue;
        out.push({ loc: { stream, stem: seg.stem, start: l.start, end: l.end }, row });
      }
      this.cursors[stream] = { stem: seg.stem, offset: consumed };
    }
    return out;
  }
}

/** The row a locator points at, read again from its segment; null when it is gone or unreadable. */
export function readRecordRow(sessionDir: string, loc: RecordLoc): EventRow | CallRow | null {
  try {
    const seg = listSegments(sessionDir, loc.stream).find((s) => s.stem === loc.stem);
    if (seg === undefined) return null;
    return JSON.parse(decoder.decode(readSegmentBytes(seg.path).subarray(loc.start, loc.end))) as EventRow | CallRow;
  } catch {
    return null;
  }
}

/**
 * A session record row as the trajectory record the feed draws, or null for a
 * row the feed does not show: a `key`, and a tool call or its result, which
 * the trajectory already holds as the model saw them (a store session's are
 * `storeCallRecordsOf`'s).
 *
 * - `events` rows: a milestone (`milestoneOfEvent`), or a `quest` as the
 *   `quest_complete` record.
 * - `calls` `actions`: the action log record, `callTs` the call's id (its
 *   dispatch stamp, which the trajectory's `tool_call` carries as
 *   `dispatchTs`), `routine` when a call's routine sent it.
 * - `calls` `move`: the intention, the target by its client-cache name, with
 *   the same `callTs` and `routine` as an `actions` record.
 * - `calls` `events`: the batch a tool served, `via: "tool"`.
 */
export function feedRecordOf(row: EventRow | CallRow, turn: number | null, stream: FeedStream): Record<string, unknown> | null {
  const turnOf = turn !== null ? { turn } : {};
  if (stream === "events") {
    const e = row as EventRow;
    if (e.kind === "quest") return { t: "quest_complete", ts: e.ts, questId: e.id, ...turnOf };
    return milestoneOfEvent(e, turn);
  }
  const c = row as CallRow;
  switch (c.kind) {
    case "actions":
      return {
        t: "actions",
        ts: c.ts,
        ...turnOf,
        ...(c.origin.call !== undefined ? { callTs: c.origin.call } : {}),
        // A routine of the model's program (`program`) is a routine as the feed shows one.
        ...(c.origin.type === "routine" || c.origin.type === "program" ? { routine: true } : {}),
        actions: c.actions,
        ...(c.dropped !== undefined ? { dropped: c.dropped } : {}),
      };
    case "move":
      return {
        t: "move",
        ts: c.ts,
        ...turnOf,
        // Whose move it is, as an `actions` record says it: the feed draws a call's own moves on its card.
        ...(c.origin.call !== undefined ? { callTs: c.origin.call } : {}),
        ...(c.origin.type === "routine" || c.origin.type === "program" ? { routine: true } : {}),
        moveId: c.moveId,
        map: c.map,
        x: c.x,
        y: c.y,
        z: c.z,
        target: c.name ?? null,
        status: c.status,
      };
    case "events":
      return { t: "events_served", ts: c.ts, ...turnOf, via: "tool", count: c.count, events: c.events, ...(c.folded !== undefined ? { folded: c.folded } : {}) };
    default:
      return null;
  }
}

/**
 * A store session's `call` and `result` rows paired: each `call` row is held,
 * by id and numbered in the order read, until its `result` is read, which
 * then carries it (`RecordLine.call`). So the feed draws a call where it
 * returned, as a CLI driver's trajectory has it: the call, its code and its
 * result written together after the call ran, with its start in
 * `dispatchTs`. Calls that overlap pair by id, never by position. A `key`
 * restates the calls still in flight, and one whose `call` row was not read
 * is held from it. Every other row passes through. A call still running is
 * held and not yet in the feed; one whose process died has no result and
 * never is.
 */
export function pairStoreCalls(lines: readonly RecordLine[], calls: StoreCalls): RecordLine[] {
  const out: RecordLine[] = [];
  const hold = (row: CallRowOf<"call">, loc: RecordLoc): void => {
    if (!calls.held.has(row.id)) calls.held.set(row.id, { row, loc, n: ++calls.count });
  };
  for (const line of lines) {
    if (line.loc.stream !== "calls") {
      out.push(line);
      continue;
    }
    const row = line.row as CallRow;
    if (row.kind === "call") hold(row, line.loc);
    else if (row.kind === "key") {
      for (const c of Array.isArray(row.open) ? row.open : []) hold(c, line.loc);
    } else if (row.kind === "result") {
      const call = calls.held.get(row.id);
      calls.held.delete(row.id);
      out.push(call !== undefined ? { ...line, call } : line);
    } else out.push(line);
  }
  return out;
}

/** A held call's row read again from its locator: the `call` row there, or the one a `key` there restates. */
export function readHeldCall(sessionDir: string, loc: RecordLoc, id: number): CallRowOf<"call"> | null {
  const row = readRecordRow(sessionDir, loc) as CallRow | null;
  if (row === null) return null;
  if (row.kind === "call") return row.id === id ? row : null;
  if (row.kind === "key") return (Array.isArray(row.open) ? row.open : []).find((c) => c.id === id) ?? null;
  return null;
}

/**
 * A store session's call and its result as the trajectory records a CLI
 * driver writes for one (`runner/src/adapter-claude.ts`): a `tool_call` with
 * the tool, its args and the call's id as `dispatchTs`; for `run_snippet` a
 * `snippet` with the code; then a `snippet_result` or `tool_result` with the
 * text and `isError`. All are stamped when the call returned and carry its
 * number among the session's calls as `call`, as a CLI driver's carry its
 * index. Written side by side, they are one card however the calls overlapped
 * (`groupFeed`, `dashboard/src/lib/feedgroup.ts`). A result whose call the
 * record does not hold is drawn alone, without a name or a number.
 */
export function storeCallRecordsOf(held: { row: CallRowOf<"call">; n: number } | null, result: CallRowOf<"result">): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const ts = result.ts;
  const call = held?.row ?? null;
  const n = held !== null ? { call: held.n } : {};
  const snippet = call?.tool === "run_snippet";
  if (call !== null) {
    out.push({ t: "tool_call", ts, ...n, name: call.tool, args: call.args, dispatchTs: call.id });
    const code = snippet ? (call.args as { code?: unknown } | null)?.code : undefined;
    // A call whose args carry no code keeps them on its card instead.
    if (typeof code === "string") out.push({ t: "snippet", ts, ...n, code });
  }
  out.push({
    t: snippet ? "snippet_result" : "tool_result",
    ts,
    ...n,
    ...(call !== null ? { name: call.tool } : {}),
    isError: result.error === true,
    text: typeof result.text === "string" ? result.text : "",
  });
  return out;
}
