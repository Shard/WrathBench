/**
 * Where the viewer reads what a run's session recorded: its trace, the ring
 * of nearby units and its movement intentions. One interface, two homes.
 *
 * - A **v1** run has a session record in `<run>/session/`, written by the
 *   stack (`wrath-mcp/docs/SESSION-FORMAT.md`). `V1Source` reads it through
 *   the stack's own reader.
 * - A **0.5** run has none: its trace and moves are tables of `run.sqlite`
 *   and its ring is one-minute files in `<run>/nearby/`.
 *   `legacy05-source.ts` reads those, with the readers the 0.5 viewer had.
 *   Nothing on disk is converted; a 0.5 run stays readable, not comparable.
 *
 * `sessionSource` picks by what the run directory holds, and everything above
 * it (`trace-db.ts`, `nearby-ring.ts`, `runs.ts`, `positions.ts`) asks the
 * source and never a file, so the codecs and the API are the same for both.
 * Read-only like the rest of the viewer.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SEGMENT_MS, SessionReader, parseLines, readSegmentBytes, type CallRow, type NearbyRow, type SegmentRef, type StreamName, type TraceRow as RecordedTraceRow } from "@wrathbench/mcp/record";
import type { MoveIntentView, TraceChatKind } from "./api-types";
import { legacy05Source } from "./legacy05-source";
import { NEARBY_FRESH_MS, parseRingRow, type NearbyRingRow } from "./nearby";
import { chatOfRowData, itemNameOf, questReqOf, type TraceDictLookup, type TraceRow } from "./trace";

/** The session record's directory inside a run directory (`runner/src/session-record.ts`). */
export const SESSION_DIR = "session";

export interface SessionSource {
  readonly kind: "v1" | "legacy-0.5";

  /**
   * Run `fn` over the trace rows with `ts` in `[from, to)`, in written order,
   * and the dictionary their ids are shown by. `none` when the run has no
   * trace at all, `failed` when it cannot be read right now.
   */
  withTrace<T>(from: number, to: number, none: T, fn: (rows: TraceRow[], dict: TraceDictLookup | undefined) => T, failed?: T): T;
  /** Every trace window before `before` that has a row, oldest first; null when the read failed. */
  traceWindowsBefore(before: number): number[] | null;
  /** The newest trace row's stamp, or null when there is none. */
  traceLastTs(): number | null;
  /** Every line of one chat kind the trace recorded, oldest first. */
  traceChat(kind: TraceChatKind): { ts: number; text: string }[];
  /** Two numbers that move whenever the trace is written, for a memo; null when there is no trace. */
  traceStat(): { size: number; mtimeMs: number } | null;

  /** The ring's rows from the files that can hold `from` onward, parsed. */
  nearbyRows(from: number, now: number): NearbyRingRow[];
  /** Whether the ring is being written. */
  nearbyFresh(now: number): boolean;

  /** Every movement intention the run recorded, oldest first. */
  moves(): MoveIntentView[];
  /** The newest of them, or null. */
  latestMove(): MoveIntentView | null;
}

/** Whether a run directory holds a v1 session record. */
export function isV1Run(runsDir: string, runId: string): boolean {
  return existsSync(join(runsDir, runId, SESSION_DIR, "session.json"));
}

/** The source for a run: its session record when it has one, else the 0.5 readers. */
export function sessionSource(runsDir: string, runId: string): SessionSource {
  return isV1Run(runsDir, runId) ? new V1Source(join(runsDir, runId, SESSION_DIR)) : legacy05Source(runsDir, runId);
}

// --------------------------------------------------------------------- v1

/**
 * What was derived from a closed segment, by its path. A compressed segment
 * never changes, so whatever was decoded from one stays right for as long as
 * the file exists; the live one is read every time. Bounded: the newest
 * entries win.
 */
class SegmentMemo<T> {
  private readonly entries = new Map<string, T>();
  constructor(private readonly max: number) {}

  get(seg: SegmentRef, derive: () => T): T {
    if (!seg.compressed) return derive();
    const hit = this.entries.get(seg.path);
    if (hit !== undefined) {
      this.entries.delete(seg.path);
      this.entries.set(seg.path, hit);
      return hit;
    }
    const value = derive();
    this.entries.set(seg.path, value);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
    return value;
  }
}

const traceMemo = new SegmentMemo<RecordedTraceRow[]>(64);
const moveMemo = new SegmentMemo<MoveIntentView[]>(4096);
const chatMemo = new SegmentMemo<{ ts: number; kind: TraceChatKind; text: string }[]>(4096);

/** A segment's lines that contain `needle`, parsed: a scan that parses only what it is looking for. */
function linesWith<T>(seg: SegmentRef, needle: string): T[] {
  let text: string;
  try {
    const bytes = readSegmentBytes(seg.path);
    const end = bytes.lastIndexOf(0x0a);
    if (end < 0) return [];
    text = new TextDecoder().decode(bytes.subarray(0, end));
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a torn line: skipped */
    }
  }
  return out;
}

function moveView(r: Extract<CallRow, { kind: "move" }>): MoveIntentView | null {
  if (typeof r.x !== "number" || typeof r.y !== "number" || typeof r.z !== "number") return null;
  return { ts: r.ts, map: typeof r.map === "number" ? r.map : null, x: r.x, y: r.y, z: r.z, target: typeof r.name === "string" ? r.name : null, status: typeof r.status === "string" ? r.status : null };
}

export class V1Source implements SessionSource {
  readonly kind = "v1" as const;
  private readonly reader: SessionReader;

  constructor(readonly dir: string) {
    this.reader = new SessionReader(dir);
  }

  private traceSegment(seg: SegmentRef): RecordedTraceRow[] {
    return traceMemo.get(seg, () => this.reader.segment("trace", seg));
  }

  withTrace<T>(from: number, to: number, none: T, fn: (rows: TraceRow[], dict: TraceDictLookup | undefined) => T, failed: T = none): T {
    let segs: SegmentRef[];
    try {
      segs = this.reader.segments("trace");
    } catch {
      return failed;
    }
    if (segs.length === 0) return none;
    // A trace row's window is its segment's, so the range's segments hold all of it.
    const first = Number.isFinite(from) ? from - (((from % SEGMENT_MS) + SEGMENT_MS) % SEGMENT_MS) : -Infinity;
    const rows: TraceRow[] = [];
    const items = new Map<number, unknown>();
    const quests = new Map<number, unknown>();
    try {
      for (const seg of segs) {
        if (seg.t0 < first || seg.t0 >= to) continue;
        for (const r of this.traceSegment(seg)) {
          for (const e of r.dict?.items ?? []) items.set(e[0], [e[1], e[2]]);
          for (const e of r.dict?.quests ?? []) quests.set(e[0], e[1]);
          if (r.kind === "dict" || r.ts < from || r.ts >= to) continue;
          rows.push({
            ts: r.ts,
            kind: r.kind,
            map: typeof r.map === "number" ? r.map : null,
            x: typeof r.x === "number" ? r.x : null,
            y: typeof r.y === "number" ? r.y : null,
            z: typeof r.z === "number" ? r.z : null,
            o: typeof r.o === "number" ? r.o : null,
            data: r.data === undefined || r.data === null ? null : JSON.stringify(r.data),
          });
        }
      }
      return fn(rows, { item: (id) => itemNameOf(items.get(id)), quest: (id) => questReqOf(quests.get(id)) });
    } catch {
      return failed;
    }
  }

  traceWindowsBefore(before: number): number[] | null {
    try {
      return [...new Set(this.reader.segments("trace").map((s) => s.t0))].filter((t0) => t0 < before);
    } catch {
      return null;
    }
  }

  traceLastTs(): number | null {
    const segs = this.reader.segments("trace");
    for (let i = segs.length - 1; i >= 0; i--) {
      const rows = this.traceSegment(segs[i]!);
      for (let j = rows.length - 1; j >= 0; j--) if (rows[j]!.kind !== "dict") return rows[j]!.ts;
    }
    return null;
  }

  traceChat(kind: TraceChatKind): { ts: number; text: string }[] {
    const out: { ts: number; text: string }[] = [];
    for (const seg of this.reader.segments("trace")) {
      const lines = chatMemo.get(seg, () => {
        const found: { ts: number; kind: TraceChatKind; text: string }[] = [];
        for (const r of linesWith<RecordedTraceRow>(seg, '"chat"')) {
          if (r.kind !== "state" || typeof r.ts !== "number") continue;
          for (const [k, text] of chatOfRowData(JSON.stringify(r.data ?? null))) found.push({ ts: r.ts, kind: k, text });
        }
        return found;
      });
      for (const l of lines) if (l.kind === kind) out.push({ ts: l.ts, text: l.text });
    }
    return out;
  }

  traceStat(): { size: number; mtimeMs: number } | null {
    return this.stat("trace");
  }

  private stat(stream: StreamName): { size: number; mtimeMs: number } | null {
    const segs = this.reader.segments(stream);
    const newest = segs[segs.length - 1];
    if (newest === undefined) return null;
    const st = statSync(newest.path, { throwIfNoEntry: false });
    // The segment count moves at a rotation, the newest one's size and mtime at every write between.
    return { size: segs.length * 2 ** 32 + (st?.size ?? 0), mtimeMs: st?.mtimeMs ?? 0 };
  }

  nearbyRows(from: number, _now: number): NearbyRingRow[] {
    const out: NearbyRingRow[] = [];
    // The segment holding `from`, and the one before it: a segment's key is
    // stamped at or just after its start, so `from` early in one needs the last.
    const first = from - (((from % SEGMENT_MS) + SEGMENT_MS) % SEGMENT_MS) - SEGMENT_MS;
    for (const seg of this.reader.segments("nearby")) {
      if (seg.t0 < first) continue;
      let rows: NearbyRow[];
      try {
        rows = parseLines<NearbyRow>(readSegmentBytes(seg.path)).rows;
      } catch {
        continue;
      }
      for (const raw of rows) {
        const row = parseRingRow(raw);
        if (row !== null) out.push(row);
      }
    }
    return out;
  }

  nearbyFresh(now: number): boolean {
    const touched = this.reader.touched("nearby");
    return touched !== null && now - touched <= NEARBY_FRESH_MS;
  }

  private movesOf(seg: SegmentRef): MoveIntentView[] {
    return moveMemo.get(seg, () => {
      const out: MoveIntentView[] = [];
      for (const r of linesWith<CallRow>(seg, '"kind":"move"')) {
        if (r.kind !== "move") continue;
        const v = moveView(r);
        if (v !== null) out.push(v);
      }
      return out;
    });
  }

  moves(): MoveIntentView[] {
    const out: MoveIntentView[] = [];
    for (const seg of this.reader.segments("calls")) out.push(...this.movesOf(seg));
    return out.sort((a, b) => a.ts - b.ts);
  }

  latestMove(): MoveIntentView | null {
    const segs = this.reader.segments("calls");
    for (let i = segs.length - 1; i >= 0; i--) {
      const moves = this.movesOf(segs[i]!);
      if (moves.length === 0) continue;
      // The newest by `ts`, the later-written on a tie.
      let best = moves[0]!;
      for (const m of moves) if (m.ts >= best.ts) best = m;
      return best;
    }
    return null;
  }
}
