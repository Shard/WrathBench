/**
 * The one place a `run.sqlite` is opened.
 *
 * A run directory is read while it is being written: the runner appends state
 * and run rows for a live episode, and at the same moment the viewer, the
 * fleet supervisor, `models.ts` and the publisher's in-process render are all
 * reading the same file. SQLite's default `busy_timeout` is 0, so any overlap
 * raises `SQLITE_BUSY` on the spot instead of waiting the few milliseconds a
 * write actually takes. Every reader here is wrapped in a `catch` that returns
 * null, so the failure mode is not a crash but a run that silently reads as
 * empty — a level that blinks off the ladder, a position that vanishes from
 * the map. Routing every open through this function is what makes the pragma
 * impossible to forget at a new call site.
 *
 * Not WAL. WAL is the thing that lets a reader proceed *during* a write rather
 * than wait for it, and it would be the better fix if it were available — but
 * it is a persistent property of the database file, and a WAL-mode file cannot
 * be opened at all, not even for reading, without write access to its
 * directory (SQLite must create and map the `-shm` sidecar). The publisher
 * mounts `data/runs` read-only on purpose (infra/compose.yml) and renders the
 * viewer's handler in-process, so turning the writer's journal to WAL would
 * make every public-dashboard read of a live run throw `SQLITE_CANTOPEN` into
 * those same swallowing catches. Rollback-journal plus a real busy timeout is
 * the combination that works from a read-only mount. If that mount ever
 * becomes writable, WAL on the writer is the next step.
 */
import { Database } from "bun:sqlite";

/**
 * How long a reader waits for a writer before giving up.
 *
 * A trajectory write is a single small INSERT or UPDATE inside an implicit
 * transaction — sub-millisecond in the ordinary case, and bounded by fsync in
 * the bad one. Five seconds is far above any legitimate hold and far below
 * anything a caller would rather hang on; a wait that long means something is
 * genuinely wedged, and failing then is the correct answer.
 */
export const RUN_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * How long a WRITER waits for readers before giving up: six times a reader's.
 *
 * The lock goes both ways. On the rollback journal a reader's SHARED lock
 * lasts as long as its statement, and the writer's commit needs every one of
 * them gone. A writer that gives up is not a reader that reads as empty: the
 * runner's INSERT throws `database is locked`, the driver loop takes that for
 * a harness error, and the run is terminated by somebody having read it. A
 * live freeplay run ended that way: its writer lost a write after five
 * seconds, then lost the termination's own UPDATE five seconds later, so the
 * file was held for at least ten. A full scan of a 281 MB run.sqlite's
 * hundreds of thousands of rows, of the kind `bun wb inspect run` made, is a
 * read that can hold it that long.
 *
 * So the writer outwaits every reader. A reader that blocks the writer past
 * this long is the thing to fix, and it fails first: its own five seconds run
 * out while the writer holds PENDING, which also stops new readers from
 * starting. Bounded, not infinite, because the wait blocks the runner's one
 * thread: thirty seconds stays well inside the two minutes after which a cold
 * heartbeat reads as a dead runner and the CLI's five-minute tool timeout,
 * while being three times the longest hold seen.
 */
export const RUN_DB_WRITER_BUSY_TIMEOUT_MS = 30_000;

/**
 * Open a `run.sqlite` with a busy timeout set. `readonly` for every consumer
 * that is not the runner writing its own trajectory; a writable handle waits
 * `RUN_DB_WRITER_BUSY_TIMEOUT_MS`, a read-only one `RUN_DB_BUSY_TIMEOUT_MS`.
 * `busyTimeoutMs` overrides either, for tests.
 *
 * `busy_timeout` is connection state rather than a write to the file, so it
 * applies to a read-only handle exactly as it does to a writable one.
 */
export function openRunDb(path: string, opts: { readonly?: boolean; busyTimeoutMs?: number } = {}): Database {
  const readonly = opts.readonly === true;
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path);
  const timeout = opts.busyTimeoutMs ?? (readonly ? RUN_DB_BUSY_TIMEOUT_MS : RUN_DB_WRITER_BUSY_TIMEOUT_MS);
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
