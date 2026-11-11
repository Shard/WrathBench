/**
 * Build a v1 run's session record (`<run>/session/`, `wrath-mcp/docs/SESSION-FORMAT.md`)
 * with the stack's own `SessionWriter`, from drains written by hand, for
 * tests of what the viewer and the runner read off it. The drain shape is the
 * one the sandbox child's recorder hands the host (`RecordDrain`); the stack's
 * `record-writer.test.ts` builds them the same way.
 *
 * Every writer here runs on a clock the test owns: the ring is pruned by the
 * writer's clock, and fixture times are far from the wall clock.
 */

import { utimesSync } from "node:fs";
import {
  SessionReader,
  SessionWriter,
  emptyTraceSheet,
  emptyTraceState,
  type EventRow,
  type NearbyRow,
  type RecordDrain,
  type RecordedMove,
  type SessionCharacter,
  type SessionWriterOptions,
  type TraceRow,
} from "@wrathbench/mcp/record";
import { sessionDirOf } from "../../src/session-record";

/** A session id: 16 hex characters, as `tokenFingerprint` makes one. */
export const TEST_SESSION_ID = "5e5510aa0c0ffee1";
export const TEST_CHARACTER: SessionCharacter = { guid: "7", name: "Testwick", race: 1, class: 1 };

export interface TestSession {
  writer: SessionWriter;
  clock: { now: number };
  /** The session directory, `<runDir>/session`. */
  dir: string;
  reader: SessionReader;
}

/** Open `<runDir>/session/` with a writer on the test's clock, starting at `now`. */
export function openTestSession(runDir: string, now: number, extra: Partial<SessionWriterOptions> = {}): TestSession {
  const clock = { now };
  const dir = sessionDirOf(runDir);
  const writer = new SessionWriter({ dir, id: TEST_SESSION_ID, stack: { version: "0.0.0-test" }, now: () => clock.now, log: () => {}, ...extra });
  writer.open();
  return { writer, clock, dir, reader: new SessionReader(dir) };
}

/** A drain as the child's recorder hands it, every part defaulted to empty. */
export function recordDrain(
  o: {
    trace?: TraceRow[];
    dict?: RecordDrain["trace"]["dict"];
    events?: EventRow[];
    nearby?: NearbyRow[];
    through?: number;
    moves?: RecordedMove[];
    character?: SessionCharacter | null;
  } = {},
): RecordDrain {
  return {
    trace: { rows: o.trace ?? [], dropped: 0, ...(o.dict !== undefined ? { dict: o.dict } : {}) },
    events: { rows: o.events ?? [], dropped: 0 },
    nearby: { rows: o.nearby ?? [], dropped: 0, through: o.through ?? 0 },
    moves: o.moves ?? [],
    character: o.character === undefined ? TEST_CHARACTER : o.character,
    stream: { connected: true, events: 1, seq: 1 },
  };
}

/** A movement intention as the child notes it: a dispatch (`status` null) or its verdict. */
export function recordedMove(m: { ts: number; at?: number; moveId?: number | null; map?: number | null; x: number; y: number; z: number; target?: string | null; name?: string; status?: string | null }): RecordedMove {
  return {
    ts: m.ts,
    at: m.at ?? m.ts,
    evalId: null,
    moveId: m.moveId ?? null,
    map: m.map ?? null,
    x: m.x,
    y: m.y,
    z: m.z,
    target: m.target ?? null,
    ...(m.name !== undefined ? { name: m.name } : {}),
    status: m.status ?? null,
  };
}

/** Set a stream's newest segment's mtime, as a reader's freshness check sees it. */
export function touchNewestSegment(reader: SessionReader, stream: "nearby" | "trace" | "calls" | "events", ms: number): void {
  const segs = reader.segments(stream);
  const newest = segs[segs.length - 1];
  if (newest !== undefined) utimesSync(newest.path, ms / 1000, ms / 1000);
}

/** What a test wants the character to read at one instant, in the state row's terms. */
export interface TraceReading {
  ts: number;
  level?: number;
  xp?: number;
  xpMax?: number;
  map?: number;
  x?: number;
  y?: number;
  z?: number;
  money?: number;
  /** Turn-ins the run has made by then: that many `qdone` receipts on a state row after the key. */
  quests?: number;
  health?: number;
  maxHealth?: number;
  zone?: number;
  area?: number;
  /** Carried in the backpack: `[slot, itemId, count, name, quality]`. */
  carried?: [number, number, number, string, number][];
}

/**
 * Trace rows (a `key`, then a `state` with the turn-ins) that fold to one
 * reading, as the trace recorder would have written them: what a v1 run's
 * readers (`runner/src/trace-samples.ts`, `live.json`) take its level, XP,
 * money, position and bags from. Pass them as `recordDrain({ trace, dict })`.
 */
export function traceOfReading(r: TraceReading): { trace: TraceRow[]; dict: NonNullable<RecordDrain["trace"]["dict"]> } {
  const key: TraceRow = {
    ts: r.ts,
    kind: "key",
    map: r.map ?? null,
    x: r.x ?? null,
    y: r.y ?? null,
    z: r.z ?? null,
    o: r.map === undefined ? null : 0,
    data: {
      ...emptyTraceState(),
      ...emptyTraceSheet(),
      level: r.level ?? null,
      xp: r.xp ?? null,
      xpMax: r.xpMax ?? null,
      hp: r.health ?? null,
      hpMax: r.maxHealth ?? null,
      zone: r.zone ?? null,
      area: r.area ?? null,
      money: r.money ?? null,
      ...(r.carried !== undefined ? { equip: [], inv: r.carried.map(([slot, itemId, count]) => (count === 1 ? [255, slot, itemId] : [255, slot, itemId, count])) } : {}),
    },
  };
  const rows: TraceRow[] = [key];
  if ((r.quests ?? 0) > 0) rows.push({ ts: r.ts, kind: "state", data: { qdone: Array.from({ length: r.quests! }, (_, i) => 70_000 + i) } });
  return { trace: rows, dict: { items: (r.carried ?? []).map(([, itemId, , name, quality]) => [itemId, quality, name] as [number, number, string]) } };
}

/**
 * Lay a v1 run's readings down in its session record, as its trace would hold
 * them (`traceOfReading`, one key row each): what a test that used to write
 * 60-second state rows writes now. The session is left open, as a live
 * writer's is; its rows are on disk when this returns.
 */
export function writeReadings(runDir: string, readings: TraceReading[], character: SessionCharacter | null = TEST_CHARACTER): TestSession {
  const session = openTestSession(runDir, readings[0]?.ts ?? Date.now());
  const trace: TraceRow[] = [];
  const items: NonNullable<NonNullable<RecordDrain["trace"]["dict"]>["items"]> = [];
  for (const r of readings) {
    const t = traceOfReading(r);
    trace.push(...t.trace);
    items.push(...(t.dict.items ?? []));
  }
  session.clock.now = readings.at(-1)?.ts ?? session.clock.now;
  session.writer.ingest(recordDrain({ trace, dict: { items }, character }));
  return session;
}
