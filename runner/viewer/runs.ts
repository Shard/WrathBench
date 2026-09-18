/**
 * Read-only view over `data/runs/`. Nothing here ever writes: the databases are
 * opened readonly so a live run's writer is never disturbed and an old run dir
 * never gains a schema it did not have.
 *
 * This is no longer the viewer's listing path. `/api/runs`, `/api/results`,
 * `/api/models` and the run page read the derived store instead
 * (`clickhouse.ts`), which is why the memoisation that used to live at the
 * bottom of this file is gone: a query is not a thousand file opens, and a
 * cache in front of one would only be a second thing that can be wrong about a
 * live run. What still reads files directly, and must, is everything that asks
 * about a process writing *right now*: the fleet supervisor's own polling
 * (`runner/src/archive.ts`), the account ledger on `/api/fleet`, and the live
 * map (`positions.ts`).
 *
 * The first two prefilter to the handful of runs whose files moved inside
 * their window. `readPositions` does not — it calls `listRuns` over the whole
 * tree on every poll, which is the one 1,148-file fan-out the derived store has
 * not taken away. It stays for now because the live map is the one page whose
 * whole subject is where a character is *this second*, and the store's state
 * series is a five-second poll behind; it goes when the store carries the live
 * state series, which is the same step that retires the per-run sqlite.
 */

import type { Database } from "bun:sqlite";
import { openRunDb } from "../src/rundb";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ComparabilityView, ItemSample, MoveIntentView, RunRow, StateItemsRow, StatePoint } from "./api-types";
import { characterLabel, className, raceName } from "./characters";
import { isArchiveDir } from "./archive-dir";
import { harnessOfRun, parseComparability } from "../src/index";
import { platformOf as sharedPlatformOf } from "../src/platform";

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
    return openRunDb(path, { readonly: true });
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
  resolved?: { model?: unknown; cliVersion?: unknown };
  config?: {
    model?: string;
    extra?: boolean;
    driver?: string;
    character?: string;
    race?: number;
    class?: number;
    apiBase?: string;
    objective?: string;
    campaign?: string;
    cell?: string;
    continuedFrom?: string;
  };
}

/**
 * Name the platform a run's model came from, for a run that did not record
 * one. The rule lives in `runner/src/platform.ts` — the same one the writer
 * stamps into the `platform` column — so a historical run and
 * a stamped one are labelled alike, and a LAN box reads `local` here exactly
 * where `billingOf` calls it free.
 */
export function platformOf(apiBase: string | null, driver: string | null): string | null {
  return sharedPlatformOf(apiBase, driver);
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

/**
 * An `items` column's JSON, parsed and shape-checked: anything that is not an
 * array of named rows reads as null, and a row without a name is dropped.
 *
 * The one place the stored shape is re-read, so the sqlite path and the
 * ClickHouse one (`itemsOf`) cannot come to different answers about what a
 * sample said. Everything past name/count/equipped is copied **only** when the
 * stored value has the right type: a row written before those fields existed
 * keeps exactly its three keys, rather than gaining `itemId: undefined` — an
 * absent field means unobserved, and a zero there would name slot 0 or a
 * poor-quality item that was never seen.
 */
export function itemSamplesOf(text: string): ItemSample[] | null {
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ItemSample[] = [];
  type Row = Record<"name" | "count" | "equipped" | "itemId" | "quality" | "slot" | "bag", unknown>;
  const opt = (key: "itemId" | "quality" | "slot" | "bag", v: unknown): { [k: string]: number } =>
    typeof v === "number" ? { [key]: v } : {};
  for (const it of parsed as Row[]) {
    if (typeof it?.name !== "string") continue;
    out.push({
      name: it.name,
      count: typeof it.count === "number" ? it.count : 1,
      equipped: it.equipped === true,
      ...opt("itemId", it.itemId),
      ...opt("quality", it.quality),
      ...opt("slot", it.slot),
      ...opt("bag", it.bag),
    });
  }
  return out;
}

/**
 * The newest `items` sample, parsed and shape-checked: a run
 * written before the column existed, or a sample that carried none, is null.
 */
function latestItems(db: Database, runId: string, cols: Set<string>): ItemSample[] | null {
  if (!cols.has("items")) return null;
  try {
    const r = db
      .query(`SELECT items AS v FROM state WHERE run_id = ? AND items IS NOT NULL ORDER BY ts DESC LIMIT 1`)
      .get(runId) as Record<string, unknown> | null;
    if (r === null || typeof r["v"] !== "string") return null;
    return itemSamplesOf(r["v"]);
  } catch {
    return null;
  }
}

export function readRun(runsDir: string, runId: string, now = Date.now()): RunRow {
  const dir = join(runsDir, runId);
  const row: RunRow = {
    runId,
    model: null,
    driver: null,
    harness: null,
    shakeout: null,
    objective: null,
    campaign: null,
    cell: null,
    extra: false,
    comparability: null,
    character: null,
    race: null,
    raceName: null,
    class: null,
    className: null,
    characterLabel: null,
    platform: null,
    resolvedModel: null,
    cliVersion: null,
    apiBase: null,
    harnessVersion: null,
    startedAt: null,
    endedAt: null,
    terminationReason: null,
    terminationDetail: null,
    pauseReason: null,
    continuedFrom: null,
    level: null,
    xp: null,
    money: null,
    questsCompleted: null,
    items: null,
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
    row.campaign = str(meta.config?.campaign);
    row.cell = str(meta.config?.cell);
    row.extra = meta.config?.extra === true;
    // The freeplay character this launch continues. Read from meta first and from
    // the run row below, the same order every other config-and-column fact
    // here is read in; `dropContinuation` clears both together, so they cannot
    // disagree about a character whose character went away.
    row.continuedFrom = str(meta.config?.continuedFrom);
    row.driver = str(meta.config?.driver);
    row.character = str(meta.config?.character);
    /*
     * Race and class are config, not comparability: they are read here beside
     * the character name and nothing recomputes or back-labels them. A run
     * written before the fields existed keeps null.
     */
    row.race = num(meta.config?.race);
    row.class = num(meta.config?.class);
    row.raceName = raceName(row.race);
    row.className = className(row.class);
    row.characterLabel = characterLabel(row.race, row.class);
    row.apiBase = str(meta.config?.apiBase);
    /*
     * What the provider actually served, promoted onto the run mid-episode
     * (`Trajectory.recordResolved`). Read here and from the columns below;
     * a run written before either existed reads null and is back-filled from
     * its trajectory by the caller, never rewritten on disk.
     */
    row.resolvedModel = str(meta.resolved?.model);
    row.cliVersion = str(meta.resolved?.cliVersion);
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
        row.shakeout = str(r["shakeout"]) ?? row.shakeout;
        row.objective = str(r["objective"]) ?? row.objective;
        // `character`/`platform` landed at 0.4-6: a 0.4-1..5 run.sqlite has
        // neither, and the meta read above / the derivation below answer.
        row.character = str(r["character"]) ?? row.character;
        row.platform = str(r["platform"]);
        // Added at 0.5: a run.sqlite that predates the columns yields undefined
        // here, which `str` reads as null — the same as "not recorded".
        row.resolvedModel = str(r["resolved_model"]) ?? row.resolvedModel;
        row.cliVersion = str(r["resolved_cli_version"]) ?? row.cliVersion;
        row.terminationReason = str(r["termination_reason"]);
        row.terminationDetail = str(r["termination_detail"]);
        row.pauseReason = str(r["pause_reason"]);
        // Added at 0.5 with the durable character: a run.sqlite that predates the
        // column has no key here, which `str` reads as null.
        row.continuedFrom = str(r["continued_from"]) ?? row.continuedFrom;
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
      row.items = latestItems(db, runId, cols);
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    } finally {
      db.close();
    }
  }

  row.harness = harnessOfRun({ comparability: row.comparability, driver: row.driver });
  // The stamped column wins; a run that predates it is derived the same way.
  if (row.platform === null) row.platform = platformOf(row.apiBase, row.driver);
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
      // The player frame's numbers, same rule.
      health: num(r["health"]),
      maxHealth: num(r["max_health"]),
      power: num(r["power"]),
      maxPower: num(r["max_power"]),
      powerType: num(r["power_type"]),
      nextLevelXp: num(r["next_level_xp"]),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * One run's `items` samples, oldest first, skipping the samples that carried
 * none — the fallback `readStates` is, for the same reason and in the same
 * place: a run the collector has not reached yet still replays.
 *
 * Separate from `readStates` because `items` is the one large column of the
 * table and nothing but a replay wants it; every other read path would be
 * paying for a whole inventory per sample to ignore it.
 */
export function readStateItems(runsDir: string, runId: string): StateItemsRow[] {
  const dir = join(runsDir, runId);
  const db = openReadonly(dir);
  if (db === null) return [];
  try {
    const rows = db
      .query(`SELECT ts, rowid AS seq, items FROM state WHERE run_id = ? AND items IS NOT NULL ORDER BY ts, rowid`)
      .all(runId) as Record<string, unknown>[];
    const out: StateItemsRow[] = [];
    for (const r of rows) {
      if (typeof r["items"] !== "string" || r["items"].length === 0) continue;
      out.push({ ts: num(r["ts"]) ?? 0, seq: num(r["seq"]) ?? 0, items: r["items"] });
    }
    return out;
  } catch {
    // A run.sqlite from before the `items` column: it recorded none.
    return [];
  } finally {
    db.close();
  }
}

/**
 * Every movement intention a run recorded, oldest first.
 *
 * The table is young: a run.sqlite written before it existed has no `move`
 * table at all, and the `catch` is what turns that into "this run recorded
 * none" rather than an error the map has to handle.
 */
export function readMoves(runsDir: string, runId: string): MoveIntentView[] {
  const dir = join(runsDir, runId);
  const db = openReadonly(dir);
  if (db === null) return [];
  try {
    const rows = db.query(`SELECT * FROM move WHERE run_id = ? ORDER BY ts`).all(runId) as Record<
      string,
      unknown
    >[];
    const out: MoveIntentView[] = [];
    for (const r of rows) {
      const x = num(r["x"]);
      const y = num(r["y"]);
      const z = num(r["z"]);
      if (x === null || y === null || z === null) continue;
      out.push({
        ts: num(r["ts"]) ?? 0,
        map: num(r["map"]),
        x,
        y,
        z,
        target: typeof r["target"] === "string" ? r["target"] : null,
        status: typeof r["status"] === "string" ? r["status"] : null,
      });
    }
    return out;
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
