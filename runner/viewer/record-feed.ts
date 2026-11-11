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
 * Each line is kept as a locator (stream, segment, byte range), never as
 * text, so a long run's feed costs no more memory than its trajectory's; the
 * raw view reads the segment again. Read-only.
 */

import { listSegments, readSegmentBytes, type CallRow, type EventRow } from "@wrathbench/mcp/record";
import { milestoneOfEvent } from "../src/run-reader";

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
 * the trajectory already holds as the model saw them.
 *
 * - `events` rows: a milestone (`milestoneOfEvent`), or a `quest` as the
 *   `quest_complete` record.
 * - `calls` `actions`: the action log record, `callTs` the call's id (its
 *   dispatch stamp, which the trajectory's `tool_call` carries as
 *   `dispatchTs`), `routine` when a call's routine sent it.
 * - `calls` `move`: the intention, the target by its client-cache name.
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
        ...(c.origin.type === "routine" ? { routine: true } : {}),
        actions: c.actions,
        ...(c.dropped !== undefined ? { dropped: c.dropped } : {}),
      };
    case "move":
      return { t: "move", ts: c.ts, ...turnOf, moveId: c.moveId, map: c.map, x: c.x, y: c.y, z: c.z, target: c.name ?? null, status: c.status };
    case "events":
      return { t: "events_served", ts: c.ts, ...turnOf, via: "tool", count: c.count, events: c.events, ...(c.folded !== undefined ? { folded: c.folded } : {}) };
    default:
      return null;
  }
}
