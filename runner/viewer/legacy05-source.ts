/**
 * `Legacy05Source`: a 0.5 run's session-side data, read where 0.5 wrote it.
 *
 * Before the session record (`session-source.ts`), a run's trace was the
 * `trace` and `trace_dict` tables of its `run.sqlite`, its movement
 * intentions the `move` table, and its ring of nearby units one-minute files
 * in `<run>/nearby/`. Every run recorded that way stays readable through this
 * adapter and is never converted: the run files are the evidence a result
 * points at. Readable, not comparable; nothing here makes a 0.5 run a v1 one.
 *
 * These are the 0.5 viewer's own reads, moved here unchanged in what they
 * select, and `runner/test/legacy05-golden.test.ts` holds the API's answers
 * over frozen 0.5 runs to what they were. Every database opens read-only
 * through `openRunDb`, and each table is asked for before it is read, because
 * a run recorded before a table existed has none and reads as having recorded
 * nothing, never as an error.
 *
 * The 0.5 ring kept player units (`ty` 3 in the codec) and their names; the
 * codec still decodes them for these runs. No 0.5 run is live once v1 is, so
 * in practice the ring half only ever answers "nothing".
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openRunDb, runDbStat } from "../src/rundb";
import type { MoveIntentView, TraceChatKind } from "./api-types";
import { NEARBY_FRESH_MS, parseRingRow, type NearbyRingRow } from "./nearby";
import type { SessionSource } from "./session-source";
import { SEG_MS, chatOfRowData, itemNameOf, questReqOf, windowOf, type TraceDictLookup, type TraceRow } from "./trace";

/** The 0.5 ring: its directory, its file length and how far back it reached. */
export const LEGACY_RING_DIR = "nearby";
export const LEGACY_RING_FILE_MS = 60_000;
export const LEGACY_RING_REACH_MS = 15 * 60_000;

const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Whether this database has a `trace` table with the columns the 0.5 contract fixed. */
function hasTraceTable(db: Database): boolean {
  try {
    const cols = new Set((db.query(`PRAGMA table_info(trace)`).all() as { name?: unknown }[]).map((r) => String(r.name)));
    return ["run_id", "ts", "kind", "map", "x", "y", "z", "o", "data"].every((c) => cols.has(c));
  } catch {
    return false;
  }
}

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

/** The run's rows with `ts` in `[from, to)`, in write order: the codec's input. */
function rowsBetween(db: Database, runId: string, from: number, to: number): TraceRow[] {
  const rows = db
    .query(
      `SELECT ts, kind, map, x, y, z, o, data FROM trace
       WHERE run_id = ? AND ts >= ? AND ts < ? ORDER BY ts, rowid`,
    )
    .all(runId, Number.isFinite(from) ? from : Number.MIN_SAFE_INTEGER, Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER) as Record<string, unknown>[];
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

function moveOf(r: Record<string, unknown>): MoveIntentView | null {
  const x = numOrNull(r["x"]);
  const y = numOrNull(r["y"]);
  const z = numOrNull(r["z"]);
  if (x === null || y === null || z === null) return null;
  return {
    ts: numOrNull(r["ts"]) ?? 0,
    map: numOrNull(r["map"]),
    x,
    y,
    z,
    target: typeof r["target"] === "string" ? r["target"] : null,
    status: typeof r["status"] === "string" ? r["status"] : null,
  };
}

class Legacy05Source implements SessionSource {
  readonly kind = "legacy-0.5" as const;
  private readonly path: string;

  constructor(
    private readonly runsDir: string,
    private readonly runId: string,
  ) {
    this.path = join(runsDir, runId, "run.sqlite");
  }

  /** Run `fn` over the run's database, or answer `none` when it has no `run.sqlite`, `failed` when it cannot be read now. */
  private withDb<T>(none: T, fn: (db: Database) => T, failed: T = none): T {
    if (!existsSync(this.path)) return none;
    let db: Database;
    try {
      db = openRunDb(this.path, { readonly: true });
    } catch {
      return failed;
    }
    try {
      return fn(db);
    } catch {
      return failed;
    } finally {
      db.close();
    }
  }

  withTrace<T>(from: number, to: number, none: T, fn: (rows: TraceRow[], dict: TraceDictLookup | undefined) => T, failed: T = none): T {
    return this.withDb(none, (db) => (hasTraceTable(db) ? fn(rowsBetween(db, this.runId, from, to), dictOf(db, this.runId)) : none), failed);
  }

  /** One seek per window that has data, whatever the run's row count. */
  traceWindowsBefore(before: number): number[] | null {
    return this.withDb<number[] | null>(
      [],
      (db) => {
        if (!hasTraceTable(db)) return [];
        const next = db.query(`SELECT ts FROM trace WHERE run_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 1`);
        const out: number[] = [];
        let cursor = Number.MIN_SAFE_INTEGER;
        for (;;) {
          const r = next.get(this.runId, cursor, before) as { ts?: unknown } | null;
          if (r === null || typeof r.ts !== "number") return out;
          const w = windowOf(r.ts);
          out.push(w);
          cursor = w + SEG_MS;
        }
      },
      null,
    );
  }

  traceLastTs(): number | null {
    return this.withDb<number | null>(null, (db) => {
      if (!hasTraceTable(db)) return null;
      const r = db.query(`SELECT ts FROM trace WHERE run_id = ? ORDER BY ts DESC LIMIT 1`).get(this.runId) as { ts?: unknown } | null;
      return typeof r?.ts === "number" ? r.ts : null;
    });
  }

  /** The `LIKE` is a prefilter only: every row it passes is parsed. */
  traceChat(kind: TraceChatKind): { ts: number; text: string }[] {
    const none: { ts: number; text: string }[] = [];
    return this.withDb(none, (db) => {
      if (!hasTraceTable(db)) return none;
      const rows = db
        .query(`SELECT ts, data FROM trace WHERE run_id = ? AND kind = 'state' AND data LIKE '%"chat"%' ORDER BY ts, rowid`)
        .all(this.runId) as { ts?: unknown; data?: unknown }[];
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

  /** The database's size and mtime (`runDbStat`: the file and its `-wal`). */
  traceStat(): { size: number; mtimeMs: number } | null {
    try {
      return runDbStat(join(this.runsDir, this.runId));
    } catch {
      return null;
    }
  }

  private ringFiles(now: number): { t0: number; path: string }[] {
    const dir = join(this.runsDir, this.runId, LEGACY_RING_DIR);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: { t0: number; path: string }[] = [];
    for (const name of names) {
      const m = /^(\d+)\.jsonl$/.exec(name);
      if (m === null) continue;
      const t0 = Number(m[1]);
      if (!Number.isSafeInteger(t0) || t0 % LEGACY_RING_FILE_MS !== 0) continue;
      // Past the ring's reach, as the writer pruned: ignored even if it is still there.
      if (t0 + LEGACY_RING_FILE_MS <= now - LEGACY_RING_REACH_MS) continue;
      out.push({ t0, path: join(dir, name) });
    }
    return out.sort((a, b) => a.t0 - b.t0);
  }

  nearbyRows(from: number, now: number): NearbyRingRow[] {
    // The file holding `from`, and the one before it: a file's key is stamped at
    // or just after its start, so `from` early in a minute needs the minute before.
    const first = Math.floor(from / LEGACY_RING_FILE_MS) * LEGACY_RING_FILE_MS - LEGACY_RING_FILE_MS;
    const out: NearbyRingRow[] = [];
    for (const f of this.ringFiles(now)) {
      if (f.t0 < first) continue;
      let text: string;
      try {
        text = readFileSync(f.path, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      // The writer appended whole lines; a last one with no newline was still being written.
      lines.pop();
      for (const line of lines) {
        if (line === "") continue;
        try {
          const row = parseRingRow(JSON.parse(line) as unknown);
          if (row !== null) out.push(row);
        } catch {
          /* a torn or foreign line: skipped, never fatal */
        }
      }
    }
    return out;
  }

  nearbyFresh(now: number): boolean {
    const files = this.ringFiles(now);
    const newest = files[files.length - 1];
    if (newest === undefined) return false;
    try {
      return now - statSync(newest.path).mtimeMs <= NEARBY_FRESH_MS;
    } catch {
      return false;
    }
  }

  /** A run.sqlite written before the `move` table existed has none: the throw is "recorded none". */
  moves(): MoveIntentView[] {
    return this.withDb<MoveIntentView[]>([], (db) => {
      const rows = db.query(`SELECT * FROM move WHERE run_id = ? ORDER BY ts`).all(this.runId) as Record<string, unknown>[];
      const out: MoveIntentView[] = [];
      for (const r of rows) {
        const m = moveOf(r);
        if (m !== null) out.push(m);
      }
      return out;
    });
  }

  /** The row `moves` would list last, asked for as one row. */
  latestMove(): MoveIntentView | null {
    return this.withDb<MoveIntentView | null>(null, (db) => {
      const r = db
        .query(
          `SELECT ts, map, x, y, z, target, status FROM move
            WHERE run_id = ? AND x IS NOT NULL AND y IS NOT NULL AND z IS NOT NULL
            ORDER BY ts DESC, rowid DESC LIMIT 1`,
        )
        .get(this.runId) as Record<string, unknown> | null;
      return r === null ? null : moveOf(r);
    });
  }
}

/** The 0.5 readers for one run. */
export function legacy05Source(runsDir: string, runId: string): SessionSource {
  return new Legacy05Source(runsDir, runId);
}
