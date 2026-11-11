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
