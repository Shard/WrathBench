/**
 * Write 0.5 session-side rows into a run directory, the way the 0.5 runner
 * left them, for tests of the viewer's 0.5 half (`viewer/legacy05-source.ts`).
 *
 * The 0.5 writers are gone (the trace, the moves and the ring are the stack's
 * session record now), so this writes the 0.5 layout straight: the `trace`,
 * `trace_dict` and `move` tables of `run.sqlite`, with the DDL 0.5's
 * `Trajectory` created them by, and the ring's one-minute `<t0>.jsonl` files
 * under `<run>/nearby/`. It imports nothing from the runner, so a later change
 * to the runner cannot change what a 0.5 fixture holds; the frozen 0.5 runs in
 * `legacy05/` are the whole-run counterpart.
 *
 * A test that also holds a `Trajectory` on the same directory writes these
 * first, or after closing it: two writers on one file is a lock, not a fixture.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 0.5's `run.sqlite` tables for the trace and the moves, as `trajectory.ts` declared them. */
export const LEGACY05_SESSION_DDL = `
CREATE TABLE IF NOT EXISTS move (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  move_id INTEGER,
  map INTEGER,
  x REAL, y REAL, z REAL,
  target TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS trace (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  map INTEGER, x REAL, y REAL, z REAL, o REAL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS trace_run_ts ON trace(run_id, ts);
CREATE TABLE IF NOT EXISTS trace_dict (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, id)
);
`;

/** The 0.5 ring's contract (`runner/src/nearby-row.ts` at 0.5): its directory, its file length and its reach. */
export const LEGACY05_RING = { dir: "nearby", fileMs: 60_000, reachMs: 15 * 60_000 } as const;

/** One 0.5 trace row: `data` parsed, as 0.5's `recordTrace` was handed it. */
export interface Legacy05TraceRow {
  ts: number;
  kind: "key" | "pos" | "state" | "flight";
  map?: number | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  o?: number | null;
  data?: unknown;
}

/** 0.5's trace dictionary: `[itemId, quality, name]` and `[questId, req]`. */
export interface Legacy05TraceDict {
  items?: [number, number, string][];
  quests?: [number, number[]][];
}

/** One 0.5 `move` row. */
export interface Legacy05Move {
  ts: number;
  moveId?: number | null;
  map?: number | null;
  x: number;
  y: number;
  z: number;
  target?: string | null;
  status?: string | null;
}

function withLegacyDb(runDir: string, fn: (db: Database) => void): void {
  mkdirSync(runDir, { recursive: true });
  const db = new Database(join(runDir, "run.sqlite"), { create: true });
  try {
    db.exec(LEGACY05_SESSION_DDL);
    db.transaction(() => fn(db))();
  } finally {
    db.close();
  }
}

/** Append trace rows (and dictionary entries, the newest kept) to a run's `run.sqlite`, as 0.5's `recordTrace` did. */
export function writeLegacy05Trace(runDir: string, runId: string, rows: readonly Legacy05TraceRow[], dict: Legacy05TraceDict = {}): void {
  withLegacyDb(runDir, (db) => {
    const insert = db.query(`INSERT INTO trace (run_id, ts, kind, map, x, y, z, o, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const name = db.query(`INSERT OR REPLACE INTO trace_dict (run_id, kind, id, data) VALUES (?, ?, ?, ?)`);
    for (const r of rows) {
      insert.run(runId, r.ts, r.kind, r.map ?? null, r.x ?? null, r.y ?? null, r.z ?? null, r.o ?? null, r.data === undefined || r.data === null ? null : JSON.stringify(r.data));
    }
    for (const [id, quality, text] of dict.items ?? []) name.run(runId, "item", id, JSON.stringify([quality, text]));
    for (const [id, req] of dict.quests ?? []) name.run(runId, "quest", id, JSON.stringify(req));
  });
}

/** Append `move` rows to a run's `run.sqlite`, as 0.5's `recordMove(runId, m)` did. */
export function writeLegacy05Moves(runDir: string, runId: string, moves: readonly Legacy05Move[]): void {
  withLegacyDb(runDir, (db) => {
    const insert = db.query(`INSERT INTO move (run_id, ts, move_id, map, x, y, z, target, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of moves) insert.run(runId, m.ts, m.moveId ?? null, m.map ?? null, m.x, m.y, m.z, m.target ?? null, m.status ?? null);
  });
}

/**
 * 0.5's `run` and `state` tables, as its `Trajectory` created them (every
 * column it ever added folded in). A v1 run has neither: its row is meta.json's
 * and its readings are its trace's.
 */
export const LEGACY05_RUN_DDL = `
CREATE TABLE IF NOT EXISTS run (
  run_id TEXT PRIMARY KEY, harness_version TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  driver TEXT, shakeout TEXT, model TEXT, objective TEXT, character TEXT, platform TEXT,
  resolved_model TEXT, resolved_cli_version TEXT, resolved_provider TEXT, continued_from TEXT,
  termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, reflecting_since INTEGER, config_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  run_id TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER, xp INTEGER, map INTEGER, x REAL, y REAL, z REAL,
  event_count INTEGER, last_seq INTEGER, money INTEGER, quests_completed INTEGER, turn INTEGER, zone INTEGER, area INTEGER,
  items TEXT, health INTEGER, max_health INTEGER, power INTEGER, max_power INTEGER, power_type INTEGER, next_level_xp INTEGER
);
`;

/** One 0.5 `state` row, in its camelCase `StateLine` spelling; `items` as the samples (stored as JSON). */
export interface Legacy05State {
  ts: number;
  level?: number;
  xp?: number;
  map?: number;
  x?: number;
  y?: number;
  z?: number;
  eventCount?: number;
  lastSeq?: number;
  money?: number;
  questsCompleted?: number;
  turn?: number;
  zone?: number;
  area?: number;
  items?: unknown[];
  health?: number;
  maxHealth?: number;
  power?: number;
  maxPower?: number;
  powerType?: number;
  nextLevelXp?: number;
}

/**
 * Write a 0.5 run's `run` row and `state` rows into its `run.sqlite`, as 0.5's
 * `Trajectory.writeMeta` and `recordState` left them. `row` is the run row's
 * columns by name (`run_id`, `harness_version` and `started_at` at least);
 * `config_json` defaults to `{}`.
 */
export function writeLegacy05Run(runDir: string, row: Record<string, unknown>, states: readonly Legacy05State[] = []): void {
  mkdirSync(runDir, { recursive: true });
  const db = new Database(join(runDir, "run.sqlite"), { create: true });
  try {
    db.exec(LEGACY05_RUN_DDL);
    const full: Record<string, unknown> = { config_json: "{}", ...row };
    const cols = Object.keys(full);
    db.query(`INSERT OR REPLACE INTO run (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(full) as never[]));
    const insert = db.query(
      `INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of states) {
      const n = (v: number | undefined): number | null => v ?? null;
      insert.run(
        String(full["run_id"]), s.ts, n(s.level), n(s.xp), n(s.map), n(s.x), n(s.y), n(s.z), n(s.eventCount), n(s.lastSeq), n(s.money), n(s.questsCompleted), n(s.turn), n(s.zone), n(s.area),
        s.items === undefined ? null : JSON.stringify(s.items), n(s.health), n(s.maxHealth), n(s.power), n(s.maxPower), n(s.powerType), n(s.nextLevelXp),
      );
    }
  } finally {
    db.close();
  }
}

/** The ring file a row of time `ts` went to. */
export function legacy05RingFile(ts: number): number {
  return Math.floor(ts / LEGACY05_RING.fileMs) * LEGACY05_RING.fileMs;
}

/** A ring row as far as the fold below reads one: 0.5's `NearbyRow`, loosely. */
type RingRow = { ts: number; kind: string } & Record<string, unknown>;
type RingUnit = { id: string; s: Record<string, unknown>; m: unknown } & Record<string, unknown>;

/**
 * Append ring rows to a run's `nearby/`, each to the one-minute file its `ts`
 * falls in, one JSON line each. By default the rows are written as given; with
 * `keyEachFile`, every file that does not open with a key row is opened with
 * one folded from the rows before it, as 0.5's ring writer did, so each file
 * decodes alone. Returns the paths written.
 */
export function writeLegacy05Ring(runDir: string, rows: readonly ({ ts: number } & Record<string, unknown>)[], o: { keyEachFile?: boolean } = {}): string[] {
  const dir = join(runDir, LEGACY05_RING.dir);
  mkdirSync(dir, { recursive: true });
  const written = new Set<string>();
  let self: Record<string, unknown> = { guid: null, map: null, target: null, down: false };
  let units = new Map<string, RingUnit>();
  let file: number | null = null;
  for (const raw of rows) {
    const r = raw as RingRow;
    const t0 = legacy05RingFile(r.ts);
    const path = join(dir, `${t0}.jsonl`);
    if (o.keyEachFile === true && t0 !== file && r.kind !== "key" && file !== null) {
      appendFileSync(path, `${JSON.stringify({ ts: r.ts, kind: "key", self, units: [...units.values()] })}\n`);
    }
    file = t0;
    appendFileSync(path, `${JSON.stringify(r)}\n`);
    written.add(path);
    // The fold a key restates.
    if (r.kind === "key") {
      self = { ...(r["self"] as Record<string, unknown>) };
      units = new Map((r["units"] as RingUnit[]).map((u) => [u.id, structuredClone(u)]));
    } else if (r.kind === "in") {
      const u = r["u"] as RingUnit;
      units.set(u.id, structuredClone(u));
    } else if (r.kind === "out") units.delete(r["id"] as string);
    else if (r.kind === "self") self = { ...self, ...(r["self"] as Record<string, unknown>) };
    else {
      const u = units.get(r["id"] as string);
      if (u === undefined) continue;
      if (r.kind === "mv" || r.kind === "pos") u.m = r["m"];
      else if (r.kind === "st") u.s = { ...u.s, ...(r["s"] as Record<string, unknown>) };
      else if (r.kind === "nm") u.s = { ...u.s, name: r["name"], ...(r["sub"] !== undefined ? { sub: r["sub"] } : {}) };
    }
  }
  return [...written];
}
