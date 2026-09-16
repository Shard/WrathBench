/**
 * The collector's own small sqlite: how far it has read each file.
 *
 * This is the only thing the collector owns on disk, and it is as disposable
 * as the ClickHouse database is — delete it and the next start is a full
 * replay, which lands the same rows because every table's key is natural
 * (`schema.sql`). It exists so the ordinary restart is cheap, not so that
 * anything is correct.
 *
 * `bun:sqlite`, in WAL mode, with one writer and no readers but itself: none
 * of the reasons `runner/src/rundb.ts` keeps a run's database on a rollback
 * journal apply here, because nothing else ever opens this file.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface FileOffset {
  /** Bytes consumed as whole lines. A half-written last line is not counted. */
  offset: number;
  /** The ordinal the next whole line will get. The dedup key in ClickHouse. */
  nextLine: number;
}

export interface TableCursor {
  /** The highest sqlite rowid already ingested from a run.sqlite table. */
  rowid: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_offset (
  run_id TEXT NOT NULL,
  file TEXT NOT NULL,
  offset INTEGER NOT NULL,
  next_line INTEGER NOT NULL,
  PRIMARY KEY (run_id, file)
);
CREATE TABLE IF NOT EXISTS table_cursor (
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rowid_max INTEGER NOT NULL,
  PRIMARY KEY (run_id, name)
);
-- The (size, mtime) signature of a file whose whole contents are re-read on
-- any change: meta.json and the run.sqlite run row. Nothing is appended to
-- either, so an offset would mean nothing and a signature means everything.
CREATE TABLE IF NOT EXISTS file_signature (
  run_id TEXT NOT NULL,
  file TEXT NOT NULL,
  sig TEXT NOT NULL,
  PRIMARY KEY (run_id, file)
);
`;

export class OffsetStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  fileOffset(runId: string, file: string): FileOffset {
    const r = this.db
      .query(`SELECT offset, next_line FROM file_offset WHERE run_id = ? AND file = ?`)
      .get(runId, file) as { offset?: number; next_line?: number } | null;
    return { offset: r?.offset ?? 0, nextLine: r?.next_line ?? 0 };
  }

  setFileOffset(runId: string, file: string, at: FileOffset): void {
    this.db
      .query(
        `INSERT INTO file_offset (run_id, file, offset, next_line) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id, file) DO UPDATE SET offset = excluded.offset, next_line = excluded.next_line`,
      )
      .run(runId, file, at.offset, at.nextLine);
  }

  cursor(runId: string, name: string): number {
    const r = this.db
      .query(`SELECT rowid_max FROM table_cursor WHERE run_id = ? AND name = ?`)
      .get(runId, name) as { rowid_max?: number } | null;
    return r?.rowid_max ?? 0;
  }

  setCursor(runId: string, name: string, rowid: number): void {
    this.db
      .query(
        `INSERT INTO table_cursor (run_id, name, rowid_max) VALUES (?, ?, ?)
         ON CONFLICT(run_id, name) DO UPDATE SET rowid_max = excluded.rowid_max`,
      )
      .run(runId, name, rowid);
  }

  signature(runId: string, file: string): string | null {
    const r = this.db
      .query(`SELECT sig FROM file_signature WHERE run_id = ? AND file = ?`)
      .get(runId, file) as { sig?: string } | null;
    return r?.sig ?? null;
  }

  setSignature(runId: string, file: string, sig: string): void {
    this.db
      .query(
        `INSERT INTO file_signature (run_id, file, sig) VALUES (?, ?, ?)
         ON CONFLICT(run_id, file) DO UPDATE SET sig = excluded.sig`,
      )
      .run(runId, file, sig);
  }

  /** Forget everything about every run: what `--replay` does before a pass. */
  reset(): void {
    this.db.exec(`DELETE FROM file_offset; DELETE FROM table_cursor; DELETE FROM file_signature;`);
  }

  close(): void {
    this.db.close();
  }
}
