/**
 * `Legacy05Source`: a 0.5 run's session-side data, read where 0.5 wrote it
 * and handed to the inspector as the v1 record's rows.
 *
 * Before the session record (`runs-source.ts`), a run's trace was the
 * `trace` and `trace_dict` tables of its `run.sqlite`, its movement
 * intentions the `move` table, and its ring of nearby units one-minute files
 * in `<run>/nearby/`. Every run recorded that way stays readable through this
 * adapter and is never converted: the run files are the evidence a result
 * points at. Readable, not comparable; nothing here makes a 0.5 run a v1 one.
 *
 * It implements the inspector's `SessionHandle` (`@wrathbench/inspector`):
 * a `trace` segment per five-minute window that has rows, each led by a
 * `dict` row holding the run's whole `trace_dict`; the ring's one-minute files
 * as `nearby` segments; the `move` table as one `calls` segment of `move`
 * rows. No `session.json`, no `live.json`, no `events`, and nothing to tail:
 * no 0.5 run is live once v1 is. `runner/test/legacy05-golden.test.ts` holds
 * the API's answers over frozen 0.5 runs to what the 0.5 viewer gave. Every
 * database opens read-only through `openRunDb`, and each table is asked for
 * before it is read, because a run recorded before a table existed has none
 * and reads as having recorded nothing, never as an error.
 *
 * The 0.5 ring kept player units (`ty` 3 in the codec) and their names; the
 * codec still decodes them for these runs, and only these runs can hold one:
 * the stack's write gate keeps them out of every v1 record.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SegmentInfo, SessionHandle, StreamStat, TailBatch, TimeRange } from "@wrathbench/inspector";
import { SEG_MS, windowOf } from "@wrathbench/inspector/codec/trace";
import type { CallRow, StreamName, StreamRows, TraceRow } from "@wrathbench/mcp/record";
import { openRunDb, runDbStat } from "../src/rundb";

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


/** Whether this database has a table at all: a run recorded before it existed has none. */
function hasTable(db: Database, name: string): boolean {
  try {
    return db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== null;
  } catch {
    return false;
  }
}

/** A row's `data` column as the record's object, or undefined when it is not one. */
function dataOf(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const o = JSON.parse(v) as unknown;
    return o !== null && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run's whole trace dictionary (`trace_dict`: item names and quest
 * requirements) as one `dict` row, or null on a run recorded before it
 * existed. A segment carries only the entries its rows reference, so handing
 * every window the whole table changes no segment.
 */
function dictRowOf(db: Database, runId: string, ts: number): TraceRow | null {
  try {
    const cols = new Set((db.query(`PRAGMA table_info(trace_dict)`).all() as { name?: unknown }[]).map((r) => String(r.name)));
    if (!["run_id", "kind", "id", "data"].every((c) => cols.has(c))) return null;
  } catch {
    return null;
  }
  const items: [number, number | null, string][] = [];
  const quests: [number, unknown[]][] = [];
  for (const r of db.query(`SELECT kind, id, data FROM trace_dict WHERE run_id = ? ORDER BY rowid`).all(runId) as { kind?: unknown; id?: unknown; data?: unknown }[]) {
    if (typeof r.id !== "number" || typeof r.data !== "string") continue;
    let v: unknown;
    try {
      v = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (!Array.isArray(v)) continue;
    if (r.kind === "item") items.push([r.id, v[0] as number | null, v[1] as string]);
    else if (r.kind === "quest") quests.push([r.id, v]);
  }
  return { ts, kind: "dict", dict: { items, quests } } as unknown as TraceRow;
}

/** A `move` table row as the record's `move` row: the destination, the target's name and the verdict. */
function moveRowOf(r: Record<string, unknown>): CallRow {
  const ts = numOrNull(r["ts"]) ?? 0;
  return {
    ts,
    kind: "move",
    origin: { type: "tool" },
    at: ts,
    moveId: 0,
    map: numOrNull(r["map"]),
    x: numOrNull(r["x"]),
    y: numOrNull(r["y"]),
    z: numOrNull(r["z"]),
    target: null,
    ...(typeof r["target"] === "string" ? { name: r["target"] } : {}),
    status: typeof r["status"] === "string" ? r["status"] : null,
  } as unknown as CallRow;
}

/**
 * The trace's windows per database, while its size and mtime stand: every
 * read of a window lists the windows first, and a 0.5 run is finished, so the
 * seek per window is paid once per file rather than once per request.
 */
const windowsMemo = new Map<string, { stamp: string; windows: number[] }>();

class Legacy05Session implements SessionHandle {
  private readonly path: string;

  constructor(
    private readonly runsDir: string,
    readonly id: string,
  ) {
    this.path = join(runsDir, id, "run.sqlite");
  }

  /** Run `fn` over the run's database; `none` when it has no `run.sqlite`. Throws when it cannot be opened now. */
  private withDb<T>(none: T, fn: (db: Database) => T): T {
    if (!existsSync(this.path)) return none;
    const db = openRunDb(this.path, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  async session() {
    return null;
  }

  async live() {
    return null;
  }

  private ringFiles(now: number): { t0: number; path: string }[] {
    const dir = join(this.runsDir, this.id, LEGACY_RING_DIR);
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

  /** Every five-minute window that has a trace row, one seek each, whatever the run's row count. */
  private traceWindows(): number[] {
    let stamp: string | null = null;
    try {
      const st = runDbStat(join(this.runsDir, this.id));
      stamp = st === null ? null : `${st.size}:${st.mtimeMs}`;
    } catch {
      stamp = null;
    }
    const hit = stamp === null ? undefined : windowsMemo.get(this.path);
    if (hit !== undefined && hit.stamp === stamp) return hit.windows;
    const windows = this.seekWindows();
    if (stamp !== null) {
      windowsMemo.set(this.path, { stamp, windows });
      if (windowsMemo.size > 4096) windowsMemo.delete(windowsMemo.keys().next().value as string);
    }
    return windows;
  }

  private seekWindows(): number[] {
    return this.withDb<number[]>([], (db) => {
      if (!hasTraceTable(db)) return [];
      const next = db.query(`SELECT ts FROM trace WHERE run_id = ? AND ts >= ? ORDER BY ts LIMIT 1`);
      const out: number[] = [];
      let cursor = Number.MIN_SAFE_INTEGER;
      for (;;) {
        const r = next.get(this.id, cursor) as { ts?: unknown } | null;
        if (r === null || typeof r.ts !== "number") return out;
        const w = windowOf(r.ts);
        out.push(w);
        cursor = w + SEG_MS;
      }
    });
  }

  async segments(stream: StreamName, range?: TimeRange): Promise<SegmentInfo[]> {
    let out: SegmentInfo[];
    if (stream === "trace") {
      out = this.traceWindows().map((t0) => ({ t0, t1: t0 + SEG_MS, ref: `${this.path}#trace/${t0}`, closed: false }));
    } else if (stream === "nearby") {
      out = this.ringFiles(Date.now()).map((f) => ({ t0: f.t0, t1: f.t0 + LEGACY_RING_FILE_MS, ref: f.path, closed: false }));
    } else if (stream === "calls") {
      // The `move` table, whole, as one segment over all of time: it was never cut into windows.
      out = this.withDb<SegmentInfo[]>([], (db) => (hasTable(db, "move") ? [{ t0: 0, t1: Number.MAX_SAFE_INTEGER, ref: `${this.path}#move`, closed: false }] : []));
    } else {
      out = [];
    }
    return range === undefined ? out : out.filter((s) => s.t1 > range.from && s.t0 < range.to);
  }

  async read<S extends StreamName>(stream: S, segments: readonly SegmentInfo[], o?: { kinds?: readonly string[] }): Promise<StreamRows[S][][]> {
    if (segments.length === 0) return [];
    if (stream === "nearby") return segments.map((seg) => this.ringRows(seg.ref) as StreamRows[S][]);
    if (stream === "trace") return this.traceRows(segments, o?.kinds) as StreamRows[S][][];
    if (stream === "calls") {
      return this.withDb(
        segments.map(() => []),
        (db) => {
          // The 0.5 order, and the `ts` sort stable on top of it.
          const rows = (db.query(`SELECT * FROM move WHERE run_id = ? ORDER BY ts`).all(this.id) as Record<string, unknown>[]).map(moveRowOf);
          return segments.map(() => rows as StreamRows[S][]);
        },
      );
    }
    return segments.map(() => []);
  }

  private traceRows(segments: readonly SegmentInfo[], kinds: readonly string[] | undefined): TraceRow[][] {
    return this.withDb(
      segments.map(() => []),
      (db) => {
        if (!hasTraceTable(db)) return segments.map(() => []);
        const only = kinds === undefined ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
        const q = db.query(`SELECT ts, kind, map, x, y, z, o, data FROM trace WHERE run_id = ? AND ts >= ? AND ts < ?${only} ORDER BY ts, rowid`);
        // The whole dictionary once per read, at the first window's start: every window carries it.
        const dict = kinds === undefined ? dictRowOf(db, this.id, segments[0]!.t0) : null;
        return segments.map((seg) => {
          const out: TraceRow[] = [];
          if (dict !== null) out.push(dict);
          for (const r of q.all(this.id, seg.t0, seg.t1, ...(kinds ?? [])) as Record<string, unknown>[]) {
            if (typeof r["ts"] !== "number" || typeof r["kind"] !== "string") continue;
            const data = dataOf(r["data"]);
            out.push({
              ts: r["ts"],
              kind: r["kind"],
              map: numOrNull(r["map"]),
              x: numOrNull(r["x"]),
              y: numOrNull(r["y"]),
              z: numOrNull(r["z"]),
              o: numOrNull(r["o"]),
              ...(data === undefined ? {} : { data }),
            } as TraceRow);
          }
          return out;
        });
      },
    );
  }

  /** One ring file's whole lines: a last one with no newline was still being written. */
  private ringRows(path: string): unknown[] {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n");
    lines.pop();
    const out: unknown[] = [];
    for (const line of lines) {
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as unknown);
      } catch {
        /* a torn or foreign line: skipped, never fatal */
      }
    }
    return out;
  }

  async tail<S extends StreamName>(_stream: S, cursor?: string | null): Promise<TailBatch<S>> {
    return { rows: [], cursor: cursor ?? null };
  }

  async end(): Promise<string | null> {
    return null;
  }

  async stat(stream: StreamName): Promise<StreamStat | null> {
    if (stream === "nearby") {
      const files = this.ringFiles(Date.now());
      const newest = files[files.length - 1];
      if (newest === undefined) return null;
      try {
        const st = statSync(newest.path);
        return { stamp: `${files.length}:${newest.t0}:${st.size}:${st.mtimeMs}`, touched: st.mtimeMs };
      } catch {
        return null;
      }
    }
    if (stream !== "trace" && stream !== "calls") return null;
    // The database's size and mtime (`runDbStat`: the file and its `-wal`).
    try {
      const st = runDbStat(join(this.runsDir, this.id));
      return st === null ? null : { stamp: `${st.size}:${st.mtimeMs}`, touched: st.mtimeMs };
    } catch {
      return null;
    }
  }
}

/** The 0.5 readers for one run, as the inspector's session handle. */
export function legacy05Session(runsDir: string, runId: string): SessionHandle {
  return new Legacy05Session(runsDir, runId);
}
