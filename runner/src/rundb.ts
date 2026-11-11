/**
 * The one place a 0.5 run's `run.sqlite` is opened.
 *
 * A v1 run has no run.sqlite: its run row is meta.json's and its game side is
 * its session record (`run-reader.ts`). A 0.5 run's, and the first v1
 * builds', stays readable, read-only, through here: `run-reader.ts`, the
 * viewer's `legacy05-source.ts` and the store's collector all open it with
 * `openRunDb`, and nothing in this tree writes one any more.
 *
 * A 0.5 runner kept the file in WAL while it wrote it and on the rollback
 * journal at rest. A finished run's file is one standalone file; one whose
 * writer died may still have its `-wal` and `-shm` beside it, which are part
 * of the database: `runDbStat` counts the `-wal`, `copyRunDb` folds it in, and
 * a reader's handle waits `RUN_DB_BUSY_TIMEOUT_MS` for a lock rather than
 * failing at once. A read-only open of a WAL-mode file may create `-wal` and
 * `-shm` beside it, so the directory has to be writable to the reader.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The database's own file name, and the two WAL side files beside it. */
export const RUN_DB_FILE = "run.sqlite";
export const RUN_DB_WAL_FILE = "run.sqlite-wal";
export const RUN_DB_SHM_FILE = "run.sqlite-shm";
/** The rollback journal: present only while a rollback-mode write is in flight. */
export const RUN_DB_JOURNAL_FILE = "run.sqlite-journal";

/**
 * The files whose size and mtime move when a run's database is written. Under
 * WAL a commit lands in `-wal` and `run.sqlite` itself moves only at a
 * checkpoint, so a stat signature over the database must take both: one over
 * `run.sqlite` alone sees a live run as still until the WAL is folded back.
 * Not `-shm`, which a reader writes too.
 */
export const RUN_DB_STAT_FILES = [RUN_DB_FILE, RUN_DB_WAL_FILE] as const;

/**
 * The run database's size and mtime as one pair, for a memo keyed on numbers:
 * the sizes of `RUN_DB_STAT_FILES` summed and their newest mtime, so a commit
 * that only reached the `-wal` still moves it. Null when there is no
 * `run.sqlite`.
 */
export function runDbStat(runDir: string): { size: number; mtimeMs: number } | null {
  let size = 0;
  let mtimeMs = 0;
  for (const name of RUN_DB_STAT_FILES) {
    const st = statSync(join(runDir, name), { throwIfNoEntry: false });
    if (st === undefined) {
      if (name === RUN_DB_FILE) return null;
      continue;
    }
    size += st.size;
    mtimeMs = Math.max(mtimeMs, st.mtimeMs);
  }
  return { size, mtimeMs };
}

/** Whether a file name is one of the run database's side files, never to be copied on its own. */
export function isRunDbSideFile(name: string): boolean {
  return name === RUN_DB_WAL_FILE || name === RUN_DB_SHM_FILE || name === RUN_DB_JOURNAL_FILE;
}

/**
 * A consistent copy of a run's database as one standalone file at `dest`:
 * `VACUUM INTO` from a read-only handle, which reads one snapshot, folds in
 * whatever the WAL holds and writes a rollback-mode file. A copy of
 * `run.sqlite` alone would miss every commit still in the `-wal`, and a copy
 * of all three files taken while the writer runs can tear between them. If
 * the read-only open cannot be had, the file and its `-wal` are copied as
 * they stand (never the `-shm`, which the next opener rebuilds). Returns how
 * it copied.
 */
export function copyRunDb(srcDir: string, dest: string): "vacuum" | "files" | "none" {
  const src = join(srcDir, RUN_DB_FILE);
  if (statSync(src, { throwIfNoEntry: false }) === undefined) return "none";
  rmSync(dest, { force: true });
  let db: Database | null = null;
  try {
    db = openRunDb(src, { readonly: true });
    db.query("VACUUM INTO ?").run(dest);
    return "vacuum";
  } catch {
    rmSync(dest, { force: true });
    copyFileSync(src, dest);
    if (statSync(join(srcDir, RUN_DB_WAL_FILE), { throwIfNoEntry: false }) !== undefined) copyFileSync(join(srcDir, RUN_DB_WAL_FILE), `${dest}-wal`);
    return "files";
  } finally {
    db?.close();
  }
}

/** How long any handle waits for a lock before the statement throws. */
export const RUN_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * Open a `run.sqlite` with the busy timeout set. `readonly` for every reader,
 * which is every caller now; a writable open is for a test laying a 0.5 run
 * down. `busyTimeoutMs` overrides the timeout, for tests.
 *
 * `busy_timeout` is connection state rather than a write to the file, so it
 * applies to a read-only handle exactly as it does to a writable one. A
 * read-only open of a WAL-mode file maps its `-shm` and may create `-wal` and
 * `-shm` when they are absent; it never writes the database.
 */
export function openRunDb(path: string, opts: { readonly?: boolean; busyTimeoutMs?: number } = {}): Database {
  const readonly = opts.readonly === true;
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path);
  const timeout = opts.busyTimeoutMs ?? RUN_DB_BUSY_TIMEOUT_MS;
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeout))}`);
  } catch (e) {
    // An open that cannot take the pragma is an open we do not want to hand
    // back half-configured; close it and let the caller's own catch see this.
    db.close();
    throw e;
  }
  return db;
}
