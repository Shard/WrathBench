/**
 * Read-only view over `data/runs/`. Nothing here ever writes: the databases are
 * opened readonly so a live run's writer is never disturbed and an old run dir
 * never gains a schema it did not have.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ComparabilityView, RunRow, StatePoint } from "./api-types";
import { isArchiveDir } from "./stillborn";
import { harnessOfRun, normalizePauseReason, parseComparability } from "../src/index";
import { normalizeDriver, readUnscoredStamp } from "../src/config";

/**
 * A run counts as live when it has not terminated and its trajectory grew
 * recently. "No termination reason" alone is not enough — a killed process
 * leaves none — and a stale mtime is the only signal we have from outside the
 * container.
 */
export const LIVE_WINDOW_MS = 120_000;

/*
 * The row and sample shapes live in `api-types.ts` — the type-only contract the
 * dashboard imports too — and are re-exported here so every existing importer
 * of this module keeps working.
 */
export type { ComparabilityView, RunRow, StatePoint } from "./api-types";

const RUN_ID = /^[A-Za-z0-9._-]+$/;

/** Guard against `..` and anything that would leave the runs directory. */
export function isValidRunId(id: string): boolean {
  return RUN_ID.test(id) && id !== "." && id !== "..";
}

export function runDir(runsDir: string, runId: string): string | null {
  if (!isValidRunId(runId)) return null;
  // `archive` is a directory of runs, not a run; the viewer never reads inside it.
  if (isArchiveDir(runId)) return null;
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
  comparability?: unknown;
  config?: {
    model?: string;
    extra?: boolean;
    driver?: string;
    adapter?: string;
    character?: string;
    apiBase?: string;
    objective?: string;
  };
}

/**
 * Name the platform a run's model came from. The api base is the honest source
 * — the driver only says how we talked to it, not who served the weights.
 */
export function platformOf(apiBase: string | null, driver: string | null): string | null {
  if (apiBase !== null) {
    let host = apiBase;
    try {
      host = new URL(apiBase).hostname;
    } catch {
      /* a malformed base still tells us something; fall through with the raw string */
    }
    if (host.includes("openrouter.ai")) return "openrouter";
    if (host.includes("api.anthropic.com")) return "anthropic";
    if (host.includes("api.openai.com")) return "openai";
    if (host.includes("localhost") || host.startsWith("127.")) return "local";
    return host.replace(/^api\./, "");
  }
  return driver;
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

/**
 * Which columns a run's `state` table actually has.
 *
 * The table gains signals over time and an old run directory never gains them
 * retroactively — the databases here are opened readonly precisely so that
 * stays true. Asking the schema first is what lets one viewer read both, and
 * keeps a column that does not exist yet from turning into an error the whole
 * listing pays for.
 */
function stateColumns(db: Database): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(state)`).all() as { name?: unknown }[];
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set();
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
    harness: null,
    shakeout: null,
    objective: null,
    extra: false,
    comparability: null,
    character: null,
    platform: null,
    apiBase: null,
    harnessVersion: null,
    startedAt: null,
    endedAt: null,
    terminationReason: null,
    terminationDetail: null,
    pauseReason: null,
    level: null,
    xp: null,
    money: null,
    questsCompleted: null,
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
    row.objective = str(meta.config?.objective);
    row.extra = meta.config?.extra === true;
    // `adapter` is the pre-driver name for the same thing; old runs only have it.
    row.driver = str(meta.config?.driver) ?? str(meta.config?.adapter);
    row.adapter = str(meta.config?.adapter);
    row.character = str(meta.config?.character);
    row.apiBase = str(meta.config?.apiBase);
    /*
     * Validated, not trusted: meta.json is written by whatever build launched
     * the run, and a shape this build does not recognise reads as "not
     * recorded" rather than reaching a chart as a half-filled tuple.
     */
    row.comparability = parseComparability(meta.comparability) as ComparabilityView | null;
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
        // `objective` is a late column: a run.sqlite written before ADR-0024
        // simply does not have it, and meta.json (read above) is the fallback.
        row.objective = str(r["objective"]) ?? row.objective;
        row.terminationReason = str(r["termination_reason"]);
        row.terminationDetail = str(r["termination_detail"]);
        // Stored reasons predate the rename; normalise so one vocabulary shows.
        const pause = str(r["pause_reason"]);
        row.pauseReason = pause === null ? null : normalizePauseReason(pause);
        if (row.apiBase === null && typeof r["config_json"] === "string") {
          try {
            row.apiBase = str((JSON.parse(r["config_json"]) as { apiBase?: unknown }).apiBase);
          } catch {
            /* a run row with unparseable config still lists */
          }
        }
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

      /*
       * The newest sample that actually carried a value. Zero is a real
       * reading — a broke character has 0 copper — so only NULL is treated as
       * "nothing recorded", and a column the schema lacks stays null rather
       * than becoming a misleading 0.
       */
      const cols = stateColumns(db);
      const latest = (column: string): number | null => {
        if (!cols.has(column)) return null;
        try {
          const r = db
            .query(
              // The column name is one of our own literals, never user input.
              `SELECT ${column} AS v FROM state WHERE run_id = ? AND ${column} IS NOT NULL
               ORDER BY ts DESC LIMIT 1`,
            )
            .get(runId) as Record<string, unknown> | null;
          return r === null ? null : num(r["v"]);
        } catch {
          return null;
        }
      };
      row.money = latest("money");
      row.questsCompleted = latest("quests_completed");
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    } finally {
      db.close();
    }
  }

  /*
   * Read in today's vocabulary (ADR-0035): `claude-subscription` is spelled
   * `claude-code`, the old scaffold stamp is no longer an unscored reason, and
   * the harness tag is derived from whatever the run did record. The stored
   * files are never rewritten.
   */
  const storedStamp = row.shakeout;
  if (row.driver !== null) row.driver = normalizeDriver(row.driver) ?? row.driver;
  if (row.adapter !== null) row.adapter = normalizeDriver(row.adapter) ?? row.adapter;
  row.shakeout = readUnscoredStamp(storedStamp);
  row.harness = harnessOfRun({ comparability: row.comparability, driver: row.driver, shakeout: storedStamp });
  row.platform = platformOf(row.apiBase, row.driver);
  row.live =
    row.terminationReason === null && row.mtime !== null && now - row.mtime < LIVE_WINDOW_MS;
  return row;
}

export function listRuns(runsDir: string, now = Date.now()): RunRow[] {
  if (!existsSync(runsDir)) return [];
  const ids = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isValidRunId(d.name) && !isArchiveDir(d.name))
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
      // `SELECT *` on a database that predates the column simply has no key
      // here, which `num` turns into null — no schema guard needed.
      turn: num(r["turn"]),
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
