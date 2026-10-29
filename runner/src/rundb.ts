/**
 * The one place a `run.sqlite` is opened.
 *
 * A run directory is read while it is being written: the runner appends state
 * and run rows for a live episode, and at the same moment the viewer, the
 * fleet supervisor, `models.ts`, the collector and the publisher's in-process
 * render are all reading the same file. Routing every open through this file
 * is what keeps the busy timeout, the journal mode and the retry impossible to
 * forget at a new call site.
 *
 * **WAL while a run is live, the rollback journal at rest.** The runner's own
 * writer (`Trajectory` with `wal: true`, which `run.ts` asks for; `mcp.ts`, the
 * operator's stdio mode, stays on the rollback journal with single attempts)
 * puts the file in WAL mode when it opens it, a resumed run's existing file
 * included. Under WAL a reader never blocks the writer and the writer never
 * blocks a reader: each reads the snapshot it started on. On the rollback
 * journal a reader's SHARED lock lasted its whole statement and the writer's
 * commit waited for every one of them; a slow full scan of a 281 MB live
 * freeplay run.sqlite made the runner's INSERT throw `database is locked`,
 * and the driver loop ended a live run as a harness error.
 *
 * WAL keeps the wal-index in `run.sqlite-shm`, shared memory mapped by every
 * process that opens the file, so it is correct only when all of them run on
 * one host's kernel. They do: every pod that mounts `data/runs` is pinned to
 * one node, and the volume is a block device (RWO, ext4), not a network
 * filesystem (infra/chart/wrathbench/templates/pvc.yaml). A reader opens the
 * file read-only and never writes a page or a WAL frame, but it does create
 * and map the `-wal` and `-shm` beside the file, so the directory has to be
 * writable to it: that is why `data/runs` is mounted read-write in the viewer,
 * the publisher and the collector.
 *
 * When the writer finishes cleanly (`leaveWal`) it checkpoints and puts the
 * file back on the rollback journal, so a finished or paused run is one file
 * that stands alone, as every run before WAL was: a reader of it creates no
 * side files, and a copy of `run.sqlite` alone is the whole run. A writer that
 * dies leaves a WAL-mode file with its `-wal` and `-shm`; those are part of the
 * database until the next writer (a resume, or the supervisor ending the run)
 * opens and closes it.
 *
 * Every handle waits `RUN_DB_BUSY_TIMEOUT_MS` for a lock. WAL removes the
 * reader-versus-writer wait but not every lock: a second writer (the supervisor
 * ending a run), a checkpoint and crash recovery still take them. A write that
 * still finds the file busy is retried by the runner's writer with waits it can
 * yield across (`retryRunDbWrite`), not by one long busy wait, because a busy
 * wait blocks the runner's one thread and with it the heartbeat.
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

/**
 * How long any handle waits for a lock before the statement throws.
 *
 * Under WAL a reader never waits for the writer and the writer never waits for
 * a reader; what is left is a second writer's transaction, a checkpoint, or
 * crash recovery, all short. Five seconds is far above any of them and is
 * also each attempt's budget in the writer's retry: the wait blocks the thread
 * it runs on, so it is kept short and the retry waits in between instead.
 */
export const RUN_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * The waits between the attempts of a run.sqlite write that found the file
 * busy: three retries, five, ten, then fifteen seconds apart (operator,
 * 2026-10-29), after which the write throws as it always did and the run ends
 * as a harness error. The worst case is four attempts of
 * `RUN_DB_BUSY_TIMEOUT_MS` plus the thirty seconds of waits, about fifty
 * seconds, inside the two minutes after which a cold heartbeat reads as a dead
 * runner; and the waits are asynchronous, so the heartbeat beats through them.
 * The budget is not each write's: after a write gives up, the writes behind
 * it get one attempt each, except that a verdict write (termination, pause,
 * meta) keeps one round of its own after a minor one (state, move, trace)
 * gave up, so the run ends within about two rounds, ~105 s, with the
 * heartbeat beating through every wait (`Trajectory.write`).
 */
export const RUN_DB_RETRY_WAITS_MS: readonly number[] = [5_000, 10_000, 15_000];

/**
 * Open a `run.sqlite` with the busy timeout set. `readonly` for every consumer
 * that is not a writer of the run's own record. `busyTimeoutMs` overrides the
 * timeout, for tests.
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

/** The file's journal mode as SQLite reports it (`wal`, `delete`, …). */
export function journalMode(db: Database): string {
  return String((db.query("PRAGMA journal_mode").get() as { journal_mode?: unknown } | null)?.journal_mode ?? "");
}

/**
 * Put the writer's file in WAL mode: `{ mode: "wal" }`, or the mode it stayed in
 * and why. The switch needs the file to itself, so a resumed run whose
 * rollback-mode file a reader holds at that instant cannot take it; that run
 * stays on the rollback journal for this segment rather than failing to start,
 * and the caller says so on the record. A fresh file has no other reader.
 */
export function enterWal(db: Database): { mode: string; error?: string } {
  try {
    const mode = String((db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: unknown } | null)?.journal_mode ?? "");
    return mode === "wal" ? { mode } : { mode, error: `journal_mode stayed ${mode}` };
  } catch (e) {
    let mode = "";
    try {
      mode = journalMode(db);
    } catch {
      /* the mode is only for the message */
    }
    return { mode, error: describeRunDbError(e) };
  }
}

/**
 * Checkpoint a WAL-mode file and put it back on the rollback journal, so the
 * database is `run.sqlite` alone again. Best effort and never throws: leaving
 * WAL needs every other connection gone, a reader's included. A reader in the
 * middle of a statement is waited out under the busy timeout; a connection
 * merely open is not (no busy handler runs for that), so the switch fails at
 * once while the viewer or the collector happens to hold the file open
 * between statements (`leaveWalPatiently` tries again). When the switch fails, a TRUNCATE
 * checkpoint still folds the WAL into the file (a reader mid-transaction can
 * hold that back too, and the checkpoint does wait out the busy timeout).
 * `checkpoint: false` skips it, for a short-lived opener that only means to
 * heal a file nobody holds. Returns the mode the file was left in.
 *
 * A rollback-mode file is left exactly as it is.
 */
export function leaveWal(db: Database, opts: { checkpoint?: boolean } = {}): string {
  try {
    const mode = journalMode(db);
    if (mode !== "wal") return mode;
  } catch {
    return "";
  }
  try {
    return String((db.query("PRAGMA journal_mode = DELETE").get() as { journal_mode?: unknown } | null)?.journal_mode ?? "");
  } catch {
    if (opts.checkpoint !== false) {
      try {
        db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      } catch {
        /* a checkpoint that cannot run leaves the WAL for the next writer */
      }
    }
    return "wal";
  }
}

/** `leaveWal`, tried up to `attempts` times with an awaited `sleep` between, for a writer that can wait. */
export async function leaveWalPatiently(
  db: Database,
  opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 20;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  // Each switch waits a reader's statement out under the busy timeout, which
  // blocks this thread; a short one per attempt keeps a long scan from
  // holding the runner's exit for attempts × five seconds. The waits between
  // attempts are awaited. The checkpoint at the end gets the full timeout.
  const timeout = Number((db.query("PRAGMA busy_timeout").get() as { timeout?: unknown } | null)?.timeout ?? RUN_DB_BUSY_TIMEOUT_MS);
  db.exec(`PRAGMA busy_timeout = ${LEAVE_WAL_BUSY_TIMEOUT_MS}`);
  let mode: string;
  try {
    mode = leaveWal(db, { checkpoint: false });
    for (let i = 1; i < attempts && mode === "wal"; i++) {
      await sleep(opts.waitMs ?? 250);
      mode = leaveWal(db, { checkpoint: false });
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeout))}`);
  }
  if (mode === "wal") {
    try {
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch {
      /* a checkpoint that cannot run leaves the WAL for the next writer */
    }
  }
  return mode;
}

/** Each of `leaveWalPatiently`'s attempts waits at most this long for a reader's statement. */
const LEAVE_WAL_BUSY_TIMEOUT_MS = 250;

/**
 * Whether a thrown error is a lock the next attempt may not meet: SQLITE_BUSY
 * (5) or SQLITE_LOCKED (6), extended codes included (`SQLITE_BUSY_RECOVERY`,
 * `SQLITE_BUSY_SNAPSHOT`, … share the primary code in their low byte). Disk
 * full, corruption, a constraint, a closed handle: not transient, never
 * retried.
 */
export function isTransientRunDbError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const errno = (e as { errno?: unknown }).errno;
  if (typeof errno === "number" && errno > 0) {
    const primary = errno & 0xff;
    return primary === 5 || primary === 6;
  }
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string") return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
  const message = (e as { message?: unknown }).message;
  return typeof message === "string" && /database (table )?is locked/.test(message);
}

/** An error as a short line for the record: its SQLite code and message, no path. */
export function describeRunDbError(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const code = (e as { code?: unknown }).code;
    const message = (e as { message?: unknown }).message;
    const text = typeof message === "string" ? message : String(e);
    return (typeof code === "string" && code !== "" ? `${code}: ${text}` : text).slice(0, 200);
  }
  return String(e).slice(0, 200);
}

/** One retry about to happen: the attempt that failed (1-based), the wait before the next, and why. */
export interface RunDbRetry {
  attempt: number;
  waitMs: number;
  error: string;
}

export interface RunDbRetryOptions {
  /** The waits between attempts; `RUN_DB_RETRY_WAITS_MS` by default. Its length is the number of retries. */
  waitsMs?: readonly number[];
  /** How to wait; an awaited timer by default, so the event loop (and the heartbeat) runs through it. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, for the record. */
  onRetry?: (r: RunDbRetry) => void;
  /**
   * The first attempt already ran, synchronously in the caller, and threw
   * this transient error: start at its retry instead of running it again.
   */
  firstError?: unknown;
}

/**
 * Run a run.sqlite write, retrying it on a transient lock error (`isTransientRunDbError`)
 * after each of `waitsMs`, and throwing the last error when they are spent.
 * Any other error throws at once.
 *
 * The first attempt runs synchronously, inside the call: an async function
 * runs up to its first `await`, and there is none before the first attempt.
 * So a write that succeeds first time is on disk when this returns, exactly
 * as a plain call would have it (the SIGTERM handler's pause relies on that),
 * and only a write that met a lock goes asynchronous.
 */
export async function retryRunDbWrite<T>(op: () => T, opts: RunDbRetryOptions = {}): Promise<T> {
  const waits = opts.waitsMs ?? RUN_DB_RETRY_WAITS_MS;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt === 1 && opts.firstError !== undefined) throw opts.firstError;
      return op();
    } catch (e) {
      const waitMs = waits[attempt - 1];
      if (waitMs === undefined || !isTransientRunDbError(e)) throw e;
      opts.onRetry?.({ attempt, waitMs, error: describeRunDbError(e) });
      await sleep(waitMs);
    }
  }
}
