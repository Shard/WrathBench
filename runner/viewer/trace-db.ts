/**
 * The trace as `run.sqlite` holds it: the reads behind `/api/run/<id>/trace`,
 * its segments, the track's window list and the position feed's tail.
 *
 * The codec is `trace.ts`, import-free so the dashboard can bundle it; this is
 * its server half, and the only place a `trace` row is selected. Read-only like
 * the rest of the viewer: every database opens through `openRunDb` with
 * `readonly`, and the table is asked for before it is read, because every run
 * recorded before the recorder shipped has none — those read as no trace at
 * all, never as an error.
 *
 * A segment's item names and quest requirements come from the run's
 * `trace_dict`, one point lookup per id the segment references; a run
 * recorded before that table existed encodes its ids without them.
 *
 * Every read is a range over the `(run_id, ts)` index: a segment's window plus
 * its `CONTEXT_MS` lead, the feed's last few windows, or — for the list of
 * closed windows — one seek per window rather than a scan of a week's rows.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openRunDb, runDbStat } from "../src/rundb";
import type { PositionTrace, TraceChatKind, TraceIndexResponse, TraceSegment, TrackTrace } from "./api-types";
import {
  CONTEXT_MS,
  SEG_MS,
  chatOfRowData,
  encodeSegment,
  isClosed,
  itemNameOf,
  packSegs,
  questReqOf,
  tailStart,
  windowOf,
  type TraceDictLookup,
  type TraceRow,
} from "./trace";

/** How many closed windows the position feed names, newest last. */
export const RECENT_WINDOWS = 3;

/** Whether this database has a `trace` table with the columns the contract fixes. */
function hasTraceTable(db: Database): boolean {
  try {
    const cols = new Set((db.query(`PRAGMA table_info(trace)`).all() as { name?: unknown }[]).map((r) => String(r.name)));
    return ["run_id", "ts", "kind", "map", "x", "y", "z", "o", "data"].every((c) => cols.has(c));
  } catch {
    return false;
  }
}

/**
 * Run `fn` over the run's trace database, or answer `none` when it has no
 * `run.sqlite` or no `trace` table, and `failed` when it cannot be read right
 * now (the same as `none` unless the caller must tell the two apart).
 */
function withTrace<T>(runsDir: string, runId: string, none: T, fn: (db: Database) => T, failed: T = none): T {
  const path = join(runsDir, runId, "run.sqlite");
  if (!existsSync(path)) return none;
  let db: Database;
  try {
    db = openRunDb(path, { readonly: true });
  } catch {
    return failed;
  }
  try {
    return hasTraceTable(db) ? fn(db) : none;
  } catch {
    return failed;
  } finally {
    db.close();
  }
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * The run's trace dictionary (`trace_dict`: item names and quest
 * requirements), answered per id for the encoder, or undefined on a run
 * recorded before it existed. Only the ids a segment references are asked.
 */
function dictOf(db: Database, runId: string): TraceDictLookup | undefined {
  try {
    const cols = new Set((db.query(`PRAGMA table_info(trace_dict)`).all() as { name?: unknown }[]).map((r) => String(r.name)));
    if (!["run_id", "kind", "id", "data"].every((c) => cols.has(c))) return undefined;
  } catch {
    return undefined;
  }
  const one = db.query(`SELECT data FROM trace_dict WHERE run_id = ? AND kind = ? AND id = ?`);
  const read = (kind: string, id: number): unknown => {
    const r = one.get(runId, kind, id) as { data?: unknown } | null;
    if (typeof r?.data !== "string") return undefined;
    try {
      return JSON.parse(r.data) as unknown;
    } catch {
      return undefined;
    }
  };
  return {
    item: (id) => itemNameOf(read("item", id)),
    quest: (id) => questReqOf(read("quest", id)),
  };
}

/** The run's rows with `ts` in `[from, to)`, in write order — the codec's input. */
function rowsBetween(db: Database, runId: string, from: number, to: number): TraceRow[] {
  const rows = db
    .query(
      `SELECT ts, kind, map, x, y, z, o, data FROM trace
       WHERE run_id = ? AND ts >= ? AND ts < ? ORDER BY ts, rowid`,
    )
    .all(runId, from, to) as Record<string, unknown>[];
  const out: TraceRow[] = [];
  for (const r of rows) {
    if (typeof r["ts"] !== "number" || typeof r["kind"] !== "string") continue;
    out.push({
      ts: r["ts"],
      kind: r["kind"],
      map: numOrNull(r["map"]),
      x: numOrNull(r["x"]),
      y: numOrNull(r["y"]),
      z: numOrNull(r["z"]),
      o: numOrNull(r["o"]),
      data: typeof r["data"] === "string" ? r["data"] : null,
    });
  }
  return out;
}

/**
 * Every window before `before` that has a row, by seeking to the first row at
 * or after each window found — one index lookup per window that has data,
 * whatever the run's row count.
 */
function windowsBefore(db: Database, runId: string, before: number): number[] {
  const next = db.query(`SELECT ts FROM trace WHERE run_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1`);
  const out: number[] = [];
  let cursor = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const r = next.get(runId, cursor, before) as { ts?: unknown } | null;
    if (r === null || typeof r.ts !== "number") return out;
    const w = windowOf(r.ts);
    out.push(w);
    cursor = w + SEG_MS;
  }
}

/** The newest row's stamp, or null when the run has none. */
function lastTs(db: Database, runId: string): number | null {
  const r = db.query(`SELECT ts FROM trace WHERE run_id = ? ORDER BY ts DESC LIMIT 1`).get(runId) as { ts?: unknown } | null;
  return typeof r?.ts === "number" ? r.ts : null;
}

/**
 * The tail: everything after the last closed window, encoded so far.
 *
 * It starts at the first window that is not closed and ends with the current
 * one, so for `SETTLE_MS` after a boundary it spans two windows — the one that
 * just ended and is still settling, and the one that just began. Without that,
 * the window that just ended would be in neither the closed list nor the tail
 * until it settled, and a reader would have a five-minute hole. Null when no
 * row has landed since the last closed window.
 */
function tailOf(rows: readonly TraceRow[], runId: string, now: number, dict: TraceDictLookup | undefined): TraceSegment | null {
  const t0 = tailStart(now);
  if (!rows.some((r) => r.ts >= t0)) return null;
  return encodeSegment(rows, { run: runId, t0, t1: windowOf(now) + SEG_MS }, dict);
}

/** `GET /api/run/<id>/trace`: the closed windows that have rows, and the tail. */
export function readTraceIndex(runsDir: string, runId: string, now: number): TraceIndexResponse {
  const empty: TraceIndexResponse = { segMs: SEG_MS, segs: [], tail: null, now };
  return withTrace(runsDir, runId, empty, (db) => {
    const start = tailStart(now);
    return {
      segMs: SEG_MS,
      segs: packSegs(windowsBefore(db, runId, start)),
      tail: tailOf(rowsBetween(db, runId, start - CONTEXT_MS, Number.MAX_SAFE_INTEGER), runId, now, dictOf(db, runId)),
      now,
    };
  });
}

/**
 * `GET /api/run/<id>/trace/<t0>`: one window, or null when it has no rows of
 * its own. `closed` says whether the answer can never change — the caller's
 * cue for an immutable cache header; a window still open or settling is
 * served as it stands so far.
 */
export function readTraceSegment(
  runsDir: string,
  runId: string,
  t0: number,
  now: number,
): { segment: TraceSegment; closed: boolean } | null {
  return withTrace<{ segment: TraceSegment; closed: boolean } | null>(runsDir, runId, null, (db) => {
    const t1 = t0 + SEG_MS;
    const rows = rowsBetween(db, runId, t0 - CONTEXT_MS, t1);
    if (!rows.some((r) => r.ts >= t0)) return null;
    return { segment: encodeSegment(rows, { run: runId, t0, t1 }, dictOf(db, runId)), closed: isClosed(t0, now) };
  });
}

/**
 * A live agent's trace for the position feed, in one range read: the windows
 * of the tail's context (`CONTEXT_MS`, the same three the index's tail reads,
 * so the two tails are one encoding) and the tail itself. Null when there is
 * nothing in that range, which leaves the field off the position — the shape
 * every pre-recorder run has.
 */
export function readPositionTrace(runsDir: string, runId: string, now: number): PositionTrace | null {
  return withTrace<PositionTrace | null>(runsDir, runId, null, (db) => {
    const start = tailStart(now);
    const rows = rowsBetween(db, runId, start - CONTEXT_MS, Number.MAX_SAFE_INTEGER);
    const recent = [...new Set(rows.filter((r) => r.ts < start).map((r) => windowOf(r.ts)))].sort((a, b) => a - b);
    const tail = tailOf(rows, runId, now, dictOf(db, runId));
    if (recent.length === 0 && tail === null) return null;
    return { segMs: SEG_MS, recent: recent.slice(-RECENT_WINDOWS), tail };
  });
}

/**
 * The closed-window list a track carries, memoised per run on the database's
 * size and mtime (`runDbStat`: the file and its `-wal`, where a live run's
 * commits land until a checkpoint).
 *
 * The publisher asks every run's track on every pass, and almost every run is
 * finished: without this, each pass opens every `run.sqlite` in the tree to
 * learn again that it has no trace, or the same windows it had. An entry is
 * reused while the file is unchanged and either the run's rows all fell in
 * windows already closed when it was read — then nothing but a write can
 * change the answer — or the tail has not moved since. A few numbers per run,
 * so `ApiHandle.release` leaves it alone: releasing it would cost a streaming
 * pass exactly the opens it exists to save.
 */
export function traceSegsMemo(): (runsDir: string, runId: string, now: number) => TrackTrace | null {
  const memo = new Map<string, { size: number; mtimeMs: number; start: number; final: boolean; value: TrackTrace | null }>();
  return (runsDir, runId, now) => {
    const path = join(runsDir, runId, "run.sqlite");
    let size: number;
    let mtimeMs: number;
    try {
      const st = runDbStat(join(runsDir, runId));
      if (st === null) throw new Error("no run.sqlite");
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      memo.delete(path);
      return null;
    }
    const start = tailStart(now);
    const hit = memo.get(path);
    if (hit !== undefined && hit.size === size && hit.mtimeMs === mtimeMs && (hit.final || hit.start === start)) return hit.value;
    const read = withTrace<{ value: TrackTrace | null; final: boolean } | null>(
      runsDir,
      runId,
      { value: null, final: true },
      (db) => {
        const segs = packSegs(windowsBefore(db, runId, start));
        const newest = lastTs(db, runId);
        return { value: segs.length === 0 ? null : { segMs: SEG_MS, segs }, final: newest === null || newest < start };
      },
      // A read that failed is answered and forgotten, never remembered as "no trace".
      null,
    );
    if (read === null) return hit?.value ?? null;
    memo.set(path, { size, mtimeMs, start, final: read.final, value: read.value });
    return read.value;
  };
}

/**
 * Every line of one chat kind the run's trace recorded, oldest first: the same
 * sanitized lines its segments carry (`chatOfRowData`), read in one pass over
 * the `state` rows rather than window by window. The `LIKE` is a prefilter
 * only — every row it passes is parsed — so a line that merely mentions the
 * word costs a parse and nothing else.
 */
export function readTraceChat(runsDir: string, runId: string, kind: TraceChatKind): { ts: number; text: string }[] {
  const none: { ts: number; text: string }[] = [];
  return withTrace(runsDir, runId, none, (db) => {
    const rows = db
      .query(`SELECT ts, data FROM trace WHERE run_id = ? AND kind = 'state' AND data LIKE '%"chat"%' ORDER BY ts, rowid`)
      .all(runId) as { ts?: unknown; data?: unknown }[];
    const out: { ts: number; text: string }[] = [];
    for (const r of rows) {
      if (typeof r.ts !== "number") continue;
      for (const [k, text] of chatOfRowData(typeof r.data === "string" ? r.data : null)) {
        if (k === kind) out.push({ ts: r.ts, text });
      }
    }
    return out;
  });
}
