/**
 * One run directory, into the store.
 *
 * Five sources, each with its own resume rule, because they change in
 * different ways:
 *
 *   trajectory.jsonl  append-only  → tailed from a byte offset
 *   episodic.jsonl    append-only  → tailed from a byte offset
 *   run.sqlite state  append-only  → read from a rowid cursor
 *   run.sqlite move   append-only  → read from a rowid cursor
 *   run.sqlite run    mutated      → re-read whole when (size, mtime) moves
 *   meta.json         rewritten    → re-read whole when (size, mtime) moves
 *
 * Nothing here decides anything about a run. It reads what the runner wrote
 * and hands it to the sink; the runner is untouched by design (item 126) and
 * every judgement — what is live, what counts, what a level means — stays
 * where it already lives.
 *
 * The one derivation this file does own is `run_totals`, and it owns it by
 * *calling the viewer's own code*: `RunTotalsScanner` and `readRunFact`, the
 * same implementations the viewer ran in its request path. See `schema.sql`
 * for why that is not a SQL job.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { openRunDb } from "../../runner/src/rundb";
import { RunTotalsScanner } from "../../runner/viewer/tail";
import { readRunFact } from "../../runner/src/models";
import type { Batcher } from "./batch";
import type { OffsetStore } from "./offsets";
import {
  TURN_KINDS,
  episodicRow,
  eventRow,
  milestoneRow,
  parseLine,
  turnRow,
  unparseableRow,
} from "./lines";
import { tailLines } from "./tailer";

export interface IngestDeps {
  runsDir: string;
  batcher: Batcher;
  offsets: OffsetStore;
  now: () => number;
  /** Chunk size for the tailer; only a test narrows it. */
  chunkBytes?: number;
}

export interface IngestResult {
  runId: string;
  trajectoryLines: number;
  episodicLines: number;
  states: number;
  moves: number;
  /** Whether the run row was (re)written this pass. */
  run: boolean;
  totals: boolean;
}

/**
 * Resumable totals scanners, one per live run, held for the process's life.
 *
 * A live trajectory grows on every poll, and `RunTotals` is a whole-file
 * derivation, so without this the collector would re-read a 669 MB file every
 * five seconds. The scanner keeps its accumulators and folds only the bytes
 * appended since its last read. A restart loses them and the next growth
 * re-reads that run from zero — exactly the cost the viewer pays today, and
 * only for runs that are still being written.
 */
type ScannerCache = Map<string, RunTotalsScanner>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}
function real(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** (size, mtime) of a file, or null when it is not there. */
function sigOf(path: string): { sig: string; size: number; mtime: number } | null {
  try {
    const st = statSync(path);
    return { sig: `${st.size}:${st.mtimeMs}`, size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export class Ingester {
  private readonly scanners: ScannerCache = new Map();

  constructor(private readonly deps: IngestDeps) {}

  /** Drop a finished run's scanner; called when a pass finds nothing new. */
  forget(runId: string): void {
    this.scanners.delete(runId);
  }

  async ingestRun(runId: string, dir: string, archived: boolean): Promise<IngestResult> {
    const out: IngestResult = {
      runId,
      trajectoryLines: 0,
      episodicLines: 0,
      states: 0,
      moves: 0,
      run: false,
      totals: false,
    };
    out.trajectoryLines = await this.tailTrajectory(runId, dir);
    out.episodicLines = await this.tailEpisodic(runId, dir);
    const sqlite = await this.readSqlite(runId, dir);
    out.states = sqlite.states;
    out.moves = sqlite.moves;
    out.run = await this.writeRunRow(runId, dir, archived);
    out.totals = await this.writeTotals(runId, dir);
    return out;
  }

  // ------------------------------------------------------------- trajectory

  private async tailTrajectory(runId: string, dir: string): Promise<number> {
    const path = join(dir, "trajectory.jsonl");
    const st = sigOf(path);
    if (st === null) return 0;
    const at = this.deps.offsets.fileOffset(runId, "trajectory.jsonl");
    /*
     * A file that shrank was truncated or replaced. Replaying it whole is the
     * only answer that cannot double-count: the natural keys make the re-read
     * lines land on the rows they already occupy.
     */
    const from = st.size < at.offset ? { offset: 0, nextLine: 0 } : at;
    if (st.size === from.offset) return 0;
    const ingestedAt = this.deps.now();
    let lineNo = from.nextLine;
    let offset = from.offset;
    let count = 0;
    for await (const line of tailLines(path, from.offset, st.size, this.deps.chunkBytes)) {
      const ctx = { runId, lineNo, ingestedAt };
      lineNo++;
      offset = line.endOffset;
      if (line.text.length === 0) continue;
      const parsed = parseLine(line.text);
      if (!parsed.ok) {
        await this.deps.batcher.add("events", unparseableRow(ctx, line.text));
        count++;
        continue;
      }
      if (TURN_KINDS.has(parsed.t)) {
        await this.deps.batcher.add("turns", turnRow(ctx, parsed.rec, line.text));
      } else {
        await this.deps.batcher.add("events", eventRow(ctx, parsed.rec, line.text));
        if (parsed.t === "milestone") {
          await this.deps.batcher.add("milestones", milestoneRow(ctx, parsed.rec, line.text));
        }
      }
      count++;
    }
    /*
     * The commit point. Everything read above is only in the batcher until
     * this flush returns, so a crash before it means the same bytes are read
     * again next start — which the keys make a no-op rather than a duplicate.
     */
    await this.deps.batcher.flushAll();
    this.deps.offsets.setFileOffset(runId, "trajectory.jsonl", { offset, nextLine: lineNo });
    return count;
  }

  private async tailEpisodic(runId: string, dir: string): Promise<number> {
    const path = join(dir, "episodic.jsonl");
    const st = sigOf(path);
    if (st === null) return 0;
    const at = this.deps.offsets.fileOffset(runId, "episodic.jsonl");
    const from = st.size < at.offset ? { offset: 0, nextLine: 0 } : at;
    if (st.size === from.offset) return 0;
    const ingestedAt = this.deps.now();
    let lineNo = from.nextLine;
    let offset = from.offset;
    let count = 0;
    for await (const line of tailLines(path, from.offset, st.size, this.deps.chunkBytes)) {
      const ctx = { runId, lineNo, ingestedAt };
      lineNo++;
      offset = line.endOffset;
      if (line.text.length === 0) continue;
      const parsed = parseLine(line.text);
      const rec = parsed.ok ? parsed.rec : { t: "unparseable", ts: 0 };
      await this.deps.batcher.add("episodic", episodicRow(ctx, rec, line.text));
      count++;
    }
    await this.deps.batcher.flushAll();
    this.deps.offsets.setFileOffset(runId, "episodic.jsonl", { offset, nextLine: lineNo });
    return count;
  }

  // ----------------------------------------------------------------- sqlite

  private async readSqlite(runId: string, dir: string): Promise<{ states: number; moves: number }> {
    const path = join(dir, "run.sqlite");
    if (!existsSync(path)) return { states: 0, moves: 0 };
    let db: Database | null = null;
    const ingestedAt = this.deps.now();
    let states = 0;
    let moves = 0;
    try {
      db = openRunDb(path, { readonly: true });
      states = await this.copyRows(db, runId, "state", "states", (r, seq) => ({
        run_id: runId,
        seq,
        ts: int(r["ts"]) ?? 0,
        level: int(r["level"]),
        xp: int(r["xp"]),
        map: int(r["map"]),
        x: real(r["x"]),
        y: real(r["y"]),
        z: real(r["z"]),
        event_count: int(r["event_count"]),
        last_seq: int(r["last_seq"]),
        money: int(r["money"]),
        quests_completed: int(r["quests_completed"]),
        turn: int(r["turn"]),
        zone: int(r["zone"]),
        area: int(r["area"]),
        health: int(r["health"]),
        max_health: int(r["max_health"]),
        power: int(r["power"]),
        max_power: int(r["max_power"]),
        power_type: int(r["power_type"]),
        next_level_xp: int(r["next_level_xp"]),
        items: str(r["items"]),
        ingested_at: ingestedAt,
      }));
      moves = await this.copyRows(db, runId, "move", "moves", (r, seq) => ({
        run_id: runId,
        seq,
        ts: int(r["ts"]) ?? 0,
        move_id: int(r["move_id"]),
        map: int(r["map"]),
        x: real(r["x"]),
        y: real(r["y"]),
        z: real(r["z"]),
        target: str(r["target"]),
        status: str(r["status"]),
        ingested_at: ingestedAt,
      }));
    } catch {
      /*
       * A busy, foreign or half-written run.sqlite costs this pass its state
       * rows and nothing else. The cursor is not advanced, so the next pass
       * picks up exactly where this one would have.
       */
    } finally {
      db?.close();
    }
    return { states, moves };
  }

  /**
   * Copy the rows a run.sqlite table has gained since the last pass.
   *
   * `state` and `move` are append-only — nothing in `trajectory.ts` updates or
   * deletes a row of either — so the rowid is a watermark and a pass reads
   * only what is new. A rowid also gives the ClickHouse key its tiebreaker for
   * two samples that landed in the same millisecond.
   */
  private async copyRows(
    db: Database,
    runId: string,
    table: "state" | "move",
    target: string,
    row: (r: Record<string, unknown>, seq: number) => Record<string, unknown>,
  ): Promise<number> {
    const cursor = this.deps.offsets.cursor(runId, table);
    let rows: Record<string, unknown>[];
    try {
      rows = db
        .query(`SELECT rowid AS __rowid, * FROM ${table} WHERE run_id = ? AND rowid > ? ORDER BY rowid`)
        .all(runId, cursor) as Record<string, unknown>[];
    } catch {
      // A run.sqlite written before this table existed simply has none.
      return 0;
    }
    if (rows.length === 0) return 0;
    let max = cursor;
    for (const r of rows) {
      const seq = int(r["__rowid"]) ?? 0;
      max = Math.max(max, seq);
      await this.deps.batcher.add(target, row(r, seq));
    }
    await this.deps.batcher.flushAll();
    this.deps.offsets.setCursor(runId, table, max);
    return rows.length;
  }

  // --------------------------------------------------------------- run row

  /**
   * The `runs` row: the run.sqlite `run` row merged with meta.json.
   *
   * Both are rewritten in place rather than appended to, so there is no
   * watermark to carry — the pass compares a (size, mtime) signature over the
   * two and rewrites the row when either moved. The trajectory's own size and
   * mtime ride along, because liveness is decided from that mtime and a reader
   * of this store must be able to decide it without touching the tree.
   */
  private async writeRunRow(runId: string, dir: string, archived: boolean): Promise<boolean> {
    const metaPath = join(dir, "meta.json");
    const dbPath = join(dir, "run.sqlite");
    const jsonlPath = join(dir, "trajectory.jsonl");
    const metaSig = sigOf(metaPath);
    const dbSig = sigOf(dbPath);
    const jsonlSig = sigOf(jsonlPath);
    if (metaSig === null && dbSig === null) return false;
    const sig = `${metaSig?.sig ?? "-"}|${dbSig?.sig ?? "-"}|${jsonlSig?.sig ?? "-"}|${archived ? 1 : 0}`;
    if (this.deps.offsets.signature(runId, "run") === sig) return false;

    let meta: Record<string, unknown> = {};
    let metaText = "";
    if (metaSig !== null) {
      try {
        metaText = await Bun.file(metaPath).text();
        const parsed: unknown = JSON.parse(metaText);
        if (typeof parsed === "object" && parsed !== null) meta = parsed as Record<string, unknown>;
      } catch {
        metaText = "";
      }
    }
    const config = (meta["config"] ?? {}) as Record<string, unknown>;

    let r: Record<string, unknown> = {};
    if (dbSig !== null) {
      let db: Database | null = null;
      try {
        db = openRunDb(dbPath, { readonly: true });
        r = (db.query(`SELECT * FROM run WHERE run_id = ?`).get(runId) as Record<string, unknown> | null) ?? {};
      } catch {
        return false;
      } finally {
        db?.close();
      }
    }

    const resolved = (meta["resolved"] ?? {}) as Record<string, unknown>;
    await this.deps.batcher.add("runs", {
      run_id: runId,
      archived: archived ? 1 : 0,
      // The column wins where it has an answer; meta.json fills the rest. The
      // same order `readRun` merges them in, so the two cannot disagree.
      harness_version: str(r["harness_version"]) || str(meta["harnessVersion"]),
      started_at: int(r["started_at"]) ?? int(meta["startedAt"]) ?? 0,
      ended_at: int(r["ended_at"]),
      driver: str(r["driver"]) || str(config["driver"]),
      shakeout: str(r["shakeout"]) || str(meta["shakeout"]),
      model: str(r["model"]) || str(config["model"]),
      objective: str(r["objective"]) || str(config["objective"]),
      character: str(r["character"]) || str(config["character"]),
      platform: str(r["platform"]),
      resolved_model: str(r["resolved_model"]) || str(resolved["model"]),
      resolved_cli_version: str(r["resolved_cli_version"]) || str(resolved["cliVersion"]),
      continued_from: str(r["continued_from"]) || str(config["continuedFrom"]),
      termination_reason: str(r["termination_reason"]),
      termination_detail: str(r["termination_detail"]),
      pause_reason: str(r["pause_reason"]),
      reflecting_since: int(r["reflecting_since"]),
      config_json: str(r["config_json"]) || (Object.keys(config).length > 0 ? JSON.stringify(config) : ""),
      comparability_json: meta["comparability"] === undefined ? "" : JSON.stringify(meta["comparability"]),
      meta_json: metaText,
      trajectory_bytes: jsonlSig?.size ?? 0,
      trajectory_mtime: Math.trunc(jsonlSig?.mtime ?? 0),
      ingested_at: this.deps.now(),
    });
    await this.deps.batcher.flushAll();
    this.deps.offsets.setSignature(runId, "run", sig);
    return true;
  }

  // ----------------------------------------------------------------- totals

  private async writeTotals(runId: string, dir: string): Promise<boolean> {
    const path = join(dir, "trajectory.jsonl");
    const st = sigOf(path);
    if (st === null) return false;
    const sig = st.sig;
    if (this.deps.offsets.signature(runId, "totals") === sig) return false;

    let scanner = this.scanners.get(runId);
    // A scanner that has read past the current size saw a different file.
    if (scanner === undefined || scanner.size > st.size) {
      scanner = new RunTotalsScanner(path);
      this.scanners.set(runId, scanner);
    }
    let totals: unknown;
    try {
      totals = await scanner.scan();
    } catch {
      this.scanners.delete(runId);
      return false;
    }
    /*
     * `readRunFact` is the scheduler's own reader: it is what `--status` and
     * the fleet supervisor count runs with. Storing its answer rather than a
     * SQL imitation is what lets `/api/models` keep serving the scheduler's
     * verdict after the viewer stops opening run directories.
     */
    let fact: unknown = null;
    try {
      // `readRunFact` joins (parent, runId) itself, and an archived run lives
      // one level down — so the parent of THIS directory is what it is told,
      // never the configured runs dir.
      fact = readRunFact(dirname(dir), runId, this.deps.now());
    } catch {
      fact = null;
    }
    await this.deps.batcher.add("run_totals", {
      run_id: runId,
      totals_json: JSON.stringify(totals),
      fact_json: fact === null ? "" : JSON.stringify(fact),
      trajectory_bytes: st.size,
      ingested_at: this.deps.now(),
    });
    await this.deps.batcher.flushAll();
    this.deps.offsets.setSignature(runId, "totals", sig);
    return true;
  }
}
