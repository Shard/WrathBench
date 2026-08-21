/**
 * Read-only view over `data/runs/`. Nothing here ever writes: the databases are
 * opened readonly so a live run's writer is never disturbed and an old run dir
 * never gains a schema it did not have.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A run counts as live when it has not terminated and its trajectory grew
 * recently. "No termination reason" alone is not enough — a killed process
 * leaves none — and a stale mtime is the only signal we have from outside the
 * container.
 */
export const LIVE_WINDOW_MS = 120_000;

export interface RunRow {
  runId: string;
  model: string | null;
  driver: string | null;
  adapter: string | null;
  shakeout: string | null;
  character: string | null;
  harnessVersion: string | null;
  startedAt: number | null;
  endedAt: number | null;
  terminationReason: string | null;
  terminationDetail: string | null;
  pauseReason: string | null;
  level: number | null;
  xp: number | null;
  mtime: number | null;
  bytes: number | null;
  live: boolean;
  error?: string;
}

export interface StatePoint {
  ts: number;
  level: number | null;
  xp: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  eventCount: number | null;
  lastSeq: number | null;
}

const RUN_ID = /^[A-Za-z0-9._-]+$/;

/** Guard against `..` and anything that would leave the runs directory. */
export function isValidRunId(id: string): boolean {
  return RUN_ID.test(id) && id !== "." && id !== "..";
}

export function runDir(runsDir: string, runId: string): string | null {
  if (!isValidRunId(runId)) return null;
  const dir = join(runsDir, runId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return dir;
}

function openReadonly(dir: string): Database | null {
  const path = join(dir, "run.sqlite");
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

interface MetaShape {
  runId?: string;
  harnessVersion?: string;
  startedAt?: number;
  shakeout?: string;
  config?: { model?: string; driver?: string; adapter?: string; character?: string };
}

function readMetaSafe(dir: string): MetaShape | null {
  const path = join(dir, "meta.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MetaShape;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function readRun(runsDir: string, runId: string, now = Date.now()): RunRow {
  const dir = join(runsDir, runId);
  const row: RunRow = {
    runId,
    model: null,
    driver: null,
    adapter: null,
    shakeout: null,
    character: null,
    harnessVersion: null,
    startedAt: null,
    endedAt: null,
    terminationReason: null,
    terminationDetail: null,
    pauseReason: null,
    level: null,
    xp: null,
    mtime: null,
    bytes: null,
    live: false,
  };

  const meta = readMetaSafe(dir);
  if (meta !== null) {
    row.harnessVersion = str(meta.harnessVersion);
    row.startedAt = num(meta.startedAt);
    row.shakeout = str(meta.shakeout);
    row.model = str(meta.config?.model);
    // `adapter` is the pre-driver name for the same thing; old runs only have it.
    row.driver = str(meta.config?.driver) ?? str(meta.config?.adapter);
    row.adapter = str(meta.config?.adapter);
    row.character = str(meta.config?.character);
  }

  const jsonl = join(dir, "trajectory.jsonl");
  if (existsSync(jsonl)) {
    const st = statSync(jsonl);
    row.mtime = st.mtimeMs;
    row.bytes = st.size;
  }

  // A single unreadable or busy database degrades one row, never the listing.
  const db = openReadonly(dir);
  if (db !== null) {
    try {
      const r = db.query(`SELECT * FROM run WHERE run_id = ?`).get(runId) as Record<string, unknown> | null;
      if (r !== null) {
        row.harnessVersion = str(r["harness_version"]) ?? row.harnessVersion;
        row.startedAt = num(r["started_at"]) ?? row.startedAt;
        row.endedAt = num(r["ended_at"]);
        row.model = str(r["model"]) ?? row.model;
        row.driver = str(r["driver"]) ?? row.driver;
        row.adapter = str(r["adapter"]) ?? row.adapter;
        row.shakeout = str(r["shakeout"]) ?? row.shakeout;
        row.terminationReason = str(r["termination_reason"]);
        row.terminationDetail = str(r["termination_detail"]);
        row.pauseReason = str(r["pause_reason"]);
      }
      const last = db
        .query(
          `SELECT level, xp FROM state WHERE run_id = ? AND level IS NOT NULL AND level > 0
           ORDER BY ts DESC LIMIT 1`,
        )
        .get(runId) as Record<string, unknown> | null;
      if (last !== null) {
        row.level = num(last["level"]);
        row.xp = num(last["xp"]);
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    } finally {
      db.close();
    }
  }

  row.live =
    row.terminationReason === null && row.mtime !== null && now - row.mtime < LIVE_WINDOW_MS;
  return row;
}

export function listRuns(runsDir: string, now = Date.now()): RunRow[] {
  if (!existsSync(runsDir)) return [];
  const ids = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isValidRunId(d.name))
    .map((d) => d.name);
  const rows = ids.map((id) => readRun(runsDir, id, now));
  rows.sort((a, b) => (b.startedAt ?? b.mtime ?? 0) - (a.startedAt ?? a.mtime ?? 0));
  return rows;
}

export function readStates(runsDir: string, runId: string): StatePoint[] {
  const dir = join(runsDir, runId);
  const db = openReadonly(dir);
  if (db === null) return [];
  try {
    const rows = db.query(`SELECT * FROM state WHERE run_id = ? ORDER BY ts`).all(runId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      ts: num(r["ts"]) ?? 0,
      level: num(r["level"]),
      xp: num(r["xp"]),
      map: num(r["map"]),
      x: num(r["x"]),
      y: num(r["y"]),
      z: num(r["z"]),
      eventCount: num(r["event_count"]),
      lastSeq: num(r["last_seq"]),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function readScratchpad(runsDir: string, runId: string): string | null {
  const path = join(runsDir, runId, "scratchpad.md");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
