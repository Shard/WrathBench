/**
 * What a run directory recorded, for every reader that is not the viewer's
 * session source: the run's own row, its state samples, its milestones and the
 * turn in flight at an instant. One module, so the scorer, the collector,
 * `bun wb inspect` and the fleet read a v1 run and a 0.5 run the same way.
 *
 * - A **v1** run (`<run>/session/session.json`) is read from its session record
 *   (`wrath-mcp/docs/SESSION-FORMAT.md`): samples are folded from the trace
 *   (`trace-samples.ts`) and milestones are the `events` stream's rows, each
 *   given the turn in flight by timestamp. Its trajectory is model-side and
 *   is read here only for that turn.
 * - A **0.5** run is read where 0.5 wrote it: run.sqlite's `state` table and
 *   the trajectory's `milestone` records. Nothing on disk is converted; a 0.5
 *   run stays readable, not comparable.
 *
 * The run row is meta.json's (`runRowOfMeta`), except in a run directory that
 * has a run.sqlite: there the `run` table holds it, as 0.5 (and the first v1
 * builds) wrote it.
 *
 * Read-only throughout: a database opens read-only through `openRunDb`, and a
 * busy or missing file reads as nothing recorded, never as an error.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionReader, type EventRow, type StreamCursor, type TraceRow } from "@wrathbench/mcp/record";
import { platformOf } from "./platform";
import { openRunDb, RUN_DB_FILE } from "./rundb";
import { TraceSampler, TurnIndex, type StateSample } from "./trace-samples";

export { TurnIndex, type StateSample } from "./trace-samples";

/** The session record's directory inside a run directory (`session-record.ts`). */
const SESSION_DIR = "session";

/** Whether a run directory holds a v1 session record. */
export function isV1RunDir(dir: string): boolean {
  return existsSync(join(dir, SESSION_DIR, "session.json"));
}

/** A run's session directory. */
export function sessionDirOfRun(dir: string): string {
  return join(dir, SESSION_DIR);
}

// --------------------------------------------------------------- the run row

/**
 * The run row, in run.sqlite's column names, so a reader that used to say
 * `SELECT * FROM run` reads the same keys.
 */
export interface RunRowRecord {
  run_id: string;
  harness_version: string | null;
  started_at: number | null;
  ended_at: number | null;
  driver: string | null;
  shakeout: string | null;
  model: string | null;
  objective: string | null;
  character: string | null;
  platform: string | null;
  resolved_model: string | null;
  resolved_cli_version: string | null;
  resolved_provider: string | null;
  continued_from: string | null;
  termination_reason: string | null;
  termination_detail: string | null;
  pause_reason: string | null;
  reflecting_since: number | null;
  config_json: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The run row as meta.json holds it: the launch's identity and config, the
 * provider's answer, and the verdict the runner keeps beside them
 * (`RunMeta.termination`, `endedAt`, `pauseReason`, `reflectingSince`). The
 * config is stored without its session token, as every copy but meta.json is.
 */
export function runRowOfMeta(runId: string, meta: Record<string, unknown>): RunRowRecord {
  const config = (typeof meta["config"] === "object" && meta["config"] !== null ? meta["config"] : {}) as Record<string, unknown>;
  const resolved = (typeof meta["resolved"] === "object" && meta["resolved"] !== null ? meta["resolved"] : {}) as Record<string, unknown>;
  const termination = (typeof meta["termination"] === "object" && meta["termination"] !== null ? meta["termination"] : {}) as Record<string, unknown>;
  const { token: _token, ...safeConfig } = config;
  return {
    run_id: runId,
    harness_version: str(meta["harnessVersion"]),
    started_at: num(meta["startedAt"]),
    ended_at: num(meta["endedAt"]),
    driver: str(config["driver"]),
    shakeout: str(meta["shakeout"]),
    model: str(config["model"]),
    objective: str(config["objective"]),
    character: str(config["character"]),
    platform: platformOf(str(config["apiBase"]) ?? undefined, str(config["driver"]) ?? undefined),
    resolved_model: str(resolved["model"]),
    resolved_cli_version: str(resolved["cliVersion"]),
    resolved_provider: str(resolved["provider"]),
    continued_from: str(config["continuedFrom"]),
    termination_reason: str(termination["reason"]),
    termination_detail: str(termination["detail"]),
    pause_reason: str(meta["pauseReason"]),
    reflecting_since: num(meta["reflectingSince"]),
    config_json: Object.keys(config).length > 0 ? JSON.stringify(safeConfig) : null,
  };
}

/** A run directory's run.sqlite `run` row, or null when it has no such file or row. */
function sqliteRunRow(dir: string, runId: string): Record<string, unknown> | null {
  const path = join(dir, RUN_DB_FILE);
  if (!existsSync(path)) return null;
  let db: ReturnType<typeof openRunDb> | null = null;
  try {
    db = openRunDb(path, { readonly: true });
    return (db.query(`SELECT * FROM run WHERE run_id = ?`).get(runId) as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * The run's row: run.sqlite's `run` table where the directory has one, else
 * meta.json. Null when neither says anything about the run.
 */
export function readRunRow(dir: string, runId: string): Record<string, unknown> | null {
  if (existsSync(join(dir, RUN_DB_FILE))) return sqliteRunRow(dir, runId);
  const meta = readJson(join(dir, "meta.json"));
  return meta === null ? null : (runRowOfMeta(runId, meta) as unknown as Record<string, unknown>);
}

// ------------------------------------------------------------- turn in flight

interface KeptTurns {
  ino: number;
  size: number;
  index: TurnIndex;
  pending: string;
}
const turnMemo = new Map<string, KeptTurns>();
const TURN_MEMO_MAX = 256;
const CHUNK = 1 << 20;

/**
 * The run's turn index, read off its trajectory: only `request` and `resume`
 * lines are parsed, and a file read before is read on from where it was left.
 */
export function turnIndexOf(dir: string): TurnIndex {
  const path = join(dir, "trajectory.jsonl");
  const st = statSync(path, { throwIfNoEntry: false });
  if (st === undefined) return new TurnIndex();
  let kept = turnMemo.get(path);
  if (kept === undefined || kept.ino !== st.ino || kept.size > st.size) {
    kept = { ino: st.ino, size: 0, index: new TurnIndex(), pending: "" };
  }
  turnMemo.delete(path);
  turnMemo.set(path, kept);
  if (turnMemo.size > TURN_MEMO_MAX) turnMemo.delete(turnMemo.keys().next().value as string);
  if (kept.size === st.size) return kept.index;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    const decoder = new TextDecoder();
    while (kept.size < st.size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - kept.size), kept.size);
      if (n <= 0) break;
      kept.size += n;
      const text = kept.pending + decoder.decode(buf.subarray(0, n), { stream: true });
      const lines = text.split("\n");
      kept.pending = lines.pop() ?? "";
      for (const line of lines) noteTurnLine(kept.index, line);
    }
  } finally {
    closeSync(fd);
  }
  return kept.index;
}

/** Feed one trajectory line to a turn index, parsing only the two kinds it reads. */
export function noteTurnLine(index: TurnIndex, line: string): void {
  if (!line.includes('"t":"request"') && !line.includes('"t":"resume"')) return;
  try {
    index.note(JSON.parse(line) as Record<string, unknown>);
  } catch {
    /* a torn line */
  }
}

// ------------------------------------------------------------- state samples

interface KeptSampler {
  sampler: TraceSampler;
  cursor: StreamCursor | undefined;
  samples: StateSample[];
  /** The stream's shape when last read: its segment count and newest segment's size. */
  stat: string;
}
const samplerMemo = new Map<string, KeptSampler>();
const SAMPLER_MEMO_MAX = 64;

function streamStat(reader: SessionReader): string {
  const segs = reader.segments("trace");
  const newest = segs[segs.length - 1];
  if (newest === undefined) return "0";
  const st = statSync(newest.path, { throwIfNoEntry: false });
  return `${segs.length}:${newest.stem}:${st?.size ?? 0}`;
}

/**
 * Every sample a v1 run's trace yields, oldest first, each with the turn in
 * flight. Kept per session and read on from where it was left, so a live run
 * polled every few seconds folds only what is new.
 */
export function traceSamplesOf(dir: string): StateSample[] {
  const sessionDir = sessionDirOfRun(dir);
  const reader = new SessionReader(sessionDir);
  let stat: string;
  try {
    stat = streamStat(reader);
  } catch {
    return [];
  }
  const turns = turnIndexOf(dir);
  let kept = samplerMemo.get(sessionDir);
  if (kept === undefined) kept = { sampler: new TraceSampler((ts) => turns.at(ts)), cursor: undefined, samples: [], stat: "" };
  samplerMemo.delete(sessionDir);
  samplerMemo.set(sessionDir, kept);
  if (samplerMemo.size > SAMPLER_MEMO_MAX) samplerMemo.delete(samplerMemo.keys().next().value as string);
  if (kept.stat === stat) return kept.samples;
  try {
    const { rows, cursor } = reader.tail("trace", kept.cursor);
    kept.samples.push(...kept.sampler.push(rows));
    kept.cursor = cursor;
    kept.stat = stat;
  } catch {
    /* a segment mid-rename: the next read picks it up */
  }
  return kept.samples;
}

/** Fold a run's trace rows into samples from scratch: for a caller that holds the rows already. */
export function samplesOfRows(rows: readonly TraceRow[], turnAt: (ts: number) => number | null = () => null): StateSample[] {
  return new TraceSampler(turnAt).push(rows);
}

/** A 0.5 run's `state` rows, oldest first, as stored; empty when it has none. */
function sqliteStateRows(dir: string, runId: string): Record<string, unknown>[] {
  const path = join(dir, RUN_DB_FILE);
  if (!existsSync(path)) return [];
  let db: ReturnType<typeof openRunDb> | null = null;
  try {
    db = openRunDb(path, { readonly: true });
    return db.query(`SELECT rowid AS seq, * FROM state WHERE run_id = ? ORDER BY ts, rowid`).all(runId) as Record<string, unknown>[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * The run's state samples in the `state` table's columns, oldest first, with
 * `seq` the store's tiebreaker: a v1 run's folded from its trace, a 0.5 run's
 * as its run.sqlite holds them (`seq` its rowid).
 */
export function readStateSamples(dir: string, runId: string): Record<string, unknown>[] {
  if (isV1RunDir(dir)) return traceSamplesOf(dir) as unknown as Record<string, unknown>[];
  return sqliteStateRows(dir, runId);
}

/**
 * The newest sample's reading of each column, or null when the run recorded
 * none. A column is the newest sample that carried it (a sample with no level
 * does not hide the level before it), so `level` and `xp` are read as a pair.
 */
export function latestReading(dir: string, runId: string): { level: number | null; xp: number | null; money: number | null; questsCompleted: number | null; items: string | null; map: number | null; zone: number | null; area: number | null; ts: number | null } | null {
  const rows = readStateSamples(dir, runId);
  if (rows.length === 0) return null;
  const out = { level: null as number | null, xp: null as number | null, money: null as number | null, questsCompleted: null as number | null, items: null as string | null, map: null as number | null, zone: null as number | null, area: null as number | null, ts: null as number | null };
  let pairSeen = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    out.ts ??= num(r["ts"]);
    if (!pairSeen && typeof r["level"] === "number" && r["level"] > 0) {
      out.level = r["level"];
      out.xp = num(r["xp"]);
      pairSeen = true;
    }
    out.money ??= num(r["money"]);
    out.questsCompleted ??= num(r["quests_completed"]);
    if (out.items === null && typeof r["items"] === "string" && r["items"].length > 0) out.items = r["items"];
    if (out.map === null && typeof r["map"] === "number") {
      out.map = r["map"];
      out.zone = num(r["zone"]);
      out.area = num(r["area"]);
    }
  }
  return out;
}

/** The highest level a run's samples reached, or null when none carried one: `MAX(level)` over the samples. */
export function bestLevelOf(dir: string, runId: string): number | null {
  if (!isV1RunDir(dir)) {
    const path = join(dir, RUN_DB_FILE);
    if (!existsSync(path)) return null;
    let db: ReturnType<typeof openRunDb> | null = null;
    try {
      db = openRunDb(path, { readonly: true });
      const r = db.query(`SELECT MAX(level) AS v FROM state WHERE run_id = ? AND level > 0`).get(runId) as { v?: unknown } | null;
      return num(r?.v);
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
  let best: number | null = null;
  for (const r of traceSamplesOf(dir)) if (r.level !== null && r.level > 0 && (best === null || r.level > best)) best = r.level;
  return best;
}

// ---------------------------------------------------------------- milestones

/**
 * One `events` row as the trajectory's `milestone` record carried the same
 * transition (`MilestoneLine` in trajectory.ts), so the derivations that read
 * those (`viewer/tail.ts`) read both. Ids stay as the stack wrote them; the
 * zone and area become `{ id }` and a flight's area `{ areaId }`, the record's
 * spellings. `observedTs` is the row's own instant, which on a v1 row is the
 * event's. Null for a row that is not a milestone (`key`, `quest`).
 */
export function milestoneOfEvent(row: EventRow, turn: number | null): Record<string, unknown> | null {
  const base = { t: "milestone", ts: row.ts, observedTs: row.ts, ...(turn !== null ? { turn } : {}) };
  const ids = (v: number | undefined): { id: number } | undefined => (v === undefined ? undefined : { id: v });
  switch (row.kind) {
    case "key":
    case "quest":
      return null;
    case "zone":
    case "area":
      return { ...base, kind: row.kind, ...(row.from !== undefined ? { from: { id: row.from } } : {}), to: { id: row.to } };
    case "level":
      return { ...base, kind: "level", ...(row.from !== undefined ? { from: row.from } : {}), to: row.to, ...(row.xp !== undefined ? { xp: row.xp } : {}) };
    case "death":
      return {
        ...base,
        kind: "death",
        ...(row.position !== undefined ? { position: row.position } : {}),
        ...(row.zone !== undefined ? { zone: ids(row.zone) } : {}),
        ...(row.area !== undefined ? { area: ids(row.area) } : {}),
        ...(row.released !== undefined ? { released: row.released } : {}),
      };
    case "taxi":
      return { ...base, kind: "taxi", ...(row.position !== undefined ? { position: row.position } : {}), ...(row.area !== undefined ? { from: { areaId: row.area } } : {}) };
    case "taxi_landed":
      return { ...base, kind: "taxi_landed", ...(row.position !== undefined ? { position: row.position } : {}), ...(row.area !== undefined ? { to: { areaId: row.area } } : {}) };
    case "group": {
      const { ts: _ts, seq: _seq, kind, ...rest } = row;
      return { ...base, kind, ...rest };
    }
    default: {
      const { ts: _ts, seq: _seq, ...rest } = row as EventRow & { seq?: number };
      return { ...base, ...rest };
    }
  }
}

/** Every milestone a v1 run's `events` stream recorded, as records, each with the turn in flight; oldest first. */
export function eventMilestonesOf(dir: string): Record<string, unknown>[] {
  const reader = new SessionReader(sessionDirOfRun(dir));
  const turns = turnIndexOf(dir);
  const out: Record<string, unknown>[] = [];
  let rows: EventRow[];
  try {
    rows = reader.rows("events");
  } catch {
    return [];
  }
  for (const row of rows) {
    const m = milestoneOfEvent(row, turns.at(row.ts));
    if (m !== null) out.push(m);
  }
  return out.sort((a, b) => (a["ts"] as number) - (b["ts"] as number));
}
