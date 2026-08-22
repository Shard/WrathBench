/**
 * Trajectory persistence for one run: `data/runs/<run-id>/`
 *
 *   trajectory.jsonl   every model request/response, snippet + result, event
 *                      batch served, tool call, periodic state line, watchdog
 *                      firings, termination. Append-only, one JSON object per
 *                      line, `{ t, ts, ... }`.
 *   run.sqlite         run metadata row + periodic state rows, for querying
 *                      across runs without parsing JSONL.
 *   meta.json          the run config + harness version, for `--resume`.
 *   scratchpad.md      owned by Scratchpad, lives in the same directory.
 *
 * Redaction: records never carry API keys by construction (headers are never
 * logged), and every string is additionally scrubbed against the secret values
 * registered via `redact()` — belt and braces for a key that leaks into a
 * message body.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonLine, toJsonSafe } from "./jsonsafe";
import type { Comparability } from "./comparability";
import type { PauseReason, RunConfig, TerminationReason } from "./config";

export interface StateLine {
  level?: number | undefined;
  xp?: number | undefined;
  map?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
  z?: number | undefined;
  eventCount?: number | undefined;
  lastSeq?: number | undefined;
  /** Copper on the character, from `PLAYER_FIELD_COINAGE`. */
  money?: number | undefined;
  /** Turn-ins the server confirmed this session, cumulative. */
  questsCompleted?: number | undefined;
  /**
   * Which driver turn was in flight when this sample was taken.
   *
   * Samples are taken on `stateIntervalMs`, not once per turn, so this is the
   * turn a value was *first observed* on, never the turn it was reached on.
   * Optional: samples written before the column existed have none, and a
   * sample taken before the first turn (or by a driver with no turn counter)
   * records nothing rather than a misleading 0.
   */
  turn?: number | undefined;
}

export interface RunMeta {
  runId: string;
  harnessVersion: string;
  startedAt: number;
  config: RunConfig;
  /**
   * Everything that has to match before two runs share a chart: harness
   * version, prompt hash, episode budget, context engine, effort, and whether
   * an operator objective steered the run (ADR-0026). Absent on runs written
   * before the stamp existed, which read as "not recorded" rather than being
   * recomputed against today's prompt.
   */
  comparability?: Comparability;
  /**
   * Set for non-scoring drivers (`SHAKEOUT_STAMP`). Present in meta.json, in
   * the `shakeout` column of run.sqlite and in the timeline header, so a run
   * driven by an external scaffold cannot be mistaken for a harness score.
   */
  shakeout?: string;
}

export interface TrajectoryRecord {
  t: string;
  ts: number;
  [key: string]: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  run_id TEXT PRIMARY KEY,
  harness_version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  adapter TEXT,
  -- The driver is its own column, not just a key inside config_json: a
  -- cross-run SELECT must be able to exclude shakeout runs without parsing.
  driver TEXT,
  shakeout TEXT,
  model TEXT,
  -- The operator objective this run was steered with, if any (ADR-0024). Its
  -- own column for the same reason the driver has one: a cross-run SELECT must
  -- be able to exclude steered runs without parsing config_json.
  objective TEXT,
  termination_reason TEXT,
  termination_detail TEXT,
  pause_reason TEXT,
  config_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level INTEGER,
  xp INTEGER,
  map INTEGER,
  x REAL, y REAL, z REAL,
  event_count INTEGER,
  last_seq INTEGER,
  -- Phase-1 signal vector groundwork: recorded, never scored here.
  money INTEGER,
  quests_completed INTEGER,
  -- The driver turn in flight when the sample was taken, so turns-to-level is
  -- derivable without replaying the JSONL. Nullable, like StateLine.turn.
  turn INTEGER
);
`;

/**
 * Columns added to `state` after the first runs were written. `CREATE TABLE IF
 * NOT EXISTS` is a no-op on an existing run.sqlite, so a resumed run would
 * otherwise write into a table that lacks them.
 */
const STATE_ADDED_COLUMNS: Record<string, string> = {
  money: "INTEGER",
  quests_completed: "INTEGER",
  turn: "INTEGER",
};

/** The same, for `run`: a resumed pre-ADR-0024 run.sqlite has no `objective`. */
const RUN_ADDED_COLUMNS: Record<string, string> = {
  objective: "TEXT",
};

export class Trajectory {
  readonly dir: string;
  readonly jsonlPath: string;
  private readonly db: Database;
  private readonly secrets: string[] = [];
  private readonly now: () => number;

  constructor(dir: string, opts: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = opts.now ?? Date.now;
    mkdirSync(dir, { recursive: true });
    this.jsonlPath = join(dir, "trajectory.jsonl");
    this.db = new Database(join(dir, "run.sqlite"));
    this.db.exec(SCHEMA);
    this.migrateState();
    this.migrateRun();
  }

  /** Additive, idempotent: add any `state` column this build knows and the file lacks. */
  private migrateState(): void {
    const have = new Set(
      (this.db.query(`PRAGMA table_info(state)`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(STATE_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE state ADD COLUMN ${name} ${type}`);
    }
  }

  /** Additive, idempotent: add any `run` column this build knows and the file lacks. */
  private migrateRun(): void {
    const have = new Set(
      (this.db.query(`PRAGMA table_info(run)`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(RUN_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE run ADD COLUMN ${name} ${type}`);
    }
  }

  /** Register a secret to scrub from every persisted string. */
  redact(secret: string | undefined): void {
    if (secret !== undefined && secret.length >= 8) this.secrets.push(secret);
  }

  private scrub(line: string): string {
    let out = line;
    for (const s of this.secrets) out = out.replaceAll(s, "[redacted]");
    return out;
  }

  /** Append one record. `ts` is stamped here unless the record carries one. */
  append(record: { t: string; ts?: number; [key: string]: unknown }): void {
    const full = { ts: this.now(), ...record };
    appendFileSync(this.jsonlPath, `${this.scrub(jsonLine(full))}\n`, "utf8");
  }

  writeMeta(meta: RunMeta): void {
    const safe = JSON.parse(this.scrub(jsonLine(meta))) as RunMeta;
    writeFileSync(join(this.dir, "meta.json"), `${JSON.stringify(toJsonSafe(safe), null, 2)}\n`, "utf8");
    this.db
      .query(
        `INSERT INTO run (run_id, harness_version, started_at, adapter, driver, shakeout, model, objective, config_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET harness_version = excluded.harness_version`,
      )
      .run(
        meta.runId,
        meta.harnessVersion,
        meta.startedAt,
        meta.config.adapter,
        meta.config.driver,
        meta.shakeout ?? null,
        meta.config.model ?? null,
        meta.config.objective ?? null,
        this.scrub(jsonLine(meta.config)),
      );
    this.append({ t: "meta", ...meta });
  }

  recordState(runId: string, s: StateLine): void {
    this.append({ t: "state", ...s });
    this.db
      .query(
        `INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        this.now(),
        s.level ?? null,
        s.xp ?? null,
        s.map ?? null,
        s.x ?? null,
        s.y ?? null,
        s.z ?? null,
        s.eventCount ?? null,
        s.lastSeq ?? null,
        s.money ?? null,
        s.questsCompleted ?? null,
        s.turn ?? null,
      );
  }

  setTermination(runId: string, reason: TerminationReason, detail?: string): void {
    this.append({ t: "termination", reason, detail });
    this.db
      .query(
        `UPDATE run SET termination_reason = ?, termination_detail = ?, ended_at = ?, pause_reason = NULL
         WHERE run_id = ?`,
      )
      .run(reason, detail ?? null, this.now(), runId);
  }

  setPause(runId: string, reason: PauseReason, detail?: string): void {
    this.append({ t: "pause", reason, detail });
    this.db.query(`UPDATE run SET pause_reason = ? WHERE run_id = ?`).run(reason, runId);
  }

  clearPause(runId: string): void {
    this.db.query(`UPDATE run SET pause_reason = NULL WHERE run_id = ?`).run(runId);
  }

  runRow(runId: string): Record<string, unknown> | null {
    return this.db.query(`SELECT * FROM run WHERE run_id = ?`).get(runId) as Record<
      string,
      unknown
    > | null;
  }

  stateRows(runId: string): Record<string, unknown>[] {
    return this.db
      .query(`SELECT * FROM state WHERE run_id = ? ORDER BY ts`)
      .all(runId) as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}

/** Read every record of a trajectory file. Bad lines surface, not vanish. */
export function readTrajectory(dir: string): TrajectoryRecord[] {
  const path = join(dir, "trajectory.jsonl");
  if (!existsSync(path)) return [];
  const out: TrajectoryRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as TrajectoryRecord);
    } catch {
      out.push({ t: "unparseable-line", ts: 0, line });
    }
  }
  return out;
}

export function readMeta(dir: string): RunMeta | null {
  const path = join(dir, "meta.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RunMeta;
}
