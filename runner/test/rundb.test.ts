/**
 * The contention `openRunDb` exists to survive.
 *
 * A live run is written and read at the same time — the runner appending state
 * rows while the viewer, the fleet supervisor and `models.ts` read the same
 * file. SQLite's default `busy_timeout` is 0, so the reader that arrives
 * mid-write raises `SQLITE_BUSY` on the spot. Both halves are asserted against
 * the same held lock: the bare open (what every site in this repo used to do)
 * fails with `SQLITE_BUSY`, and the `openRunDb` open waits and then reads the
 * row the writer committed.
 *
 * The writer runs in a child process, not a timer. `bun:sqlite` is
 * synchronous: a blocking read on this thread would never let a `setTimeout`
 * that releases the lock fire, so an in-process holder deadlocks by
 * construction. The child sets `locking_mode = EXCLUSIVE` and writes once,
 * which takes the exclusive lock and — unlike an ordinary transaction, whose
 * exclusive phase lasts only the instant of the commit and cannot be aimed at
 * — holds it until the connection closes. It touches a sentinel file so the
 * parent knows the lock is held rather than guessing at a delay.
 *
 * Everything lives in an `os.tmpdir()` directory made per run. Nothing here
 * reads `data/`.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunDb, RUN_DB_BUSY_TIMEOUT_MS, RUN_DB_WRITER_BUSY_TIMEOUT_MS } from "../src/rundb";
import { Trajectory } from "../src/trajectory";

const dir = mkdtempSync(join(tmpdir(), "wb-rundb-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dbPath = join(dir, "run.sqlite");
const holdScript = join(dir, "hold.ts");

writeFileSync(
  holdScript,
  `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const [path, sentinel, ms] = process.argv.slice(2) as [string, string, string];
const db = new Database(path);
db.exec("PRAGMA locking_mode = EXCLUSIVE");
db.exec("INSERT INTO state (run_id, level) VALUES ('r', 1)");
writeFileSync(sentinel, "held");
Bun.sleepSync(Number(ms));
db.close();
`,
);

{
  const seed = new Database(dbPath, { create: true });
  seed.exec("CREATE TABLE state (run_id TEXT, level INTEGER)");
  seed.close();
}

/** Run `fn` while a child process holds the run store exclusively. */
async function whileLocked<T>(holdMs: number, fn: () => T): Promise<T> {
  const sentinel = join(dir, "held");
  rmSync(sentinel, { force: true });
  const child = Bun.spawn([process.execPath, holdScript, dbPath, sentinel, String(holdMs)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(sentinel)) {
      if (Date.now() > deadline) {
        throw new Error(`lock holder never started: ${await new Response(child.stderr).text()}`);
      }
      await Bun.sleep(5);
    }
    return fn();
  } finally {
    await child.exited;
  }
}

test("a reader survives a concurrent write only because openRunDb sets a busy timeout", async () => {
  const { bare, waited } = await whileLocked(500, () => {
    // The old behaviour, kept as the control: a `busy_timeout` of 0 is what
    // every open in this repo had, and it gives up the instant it is blocked.
    const raw = new Database(dbPath, { readonly: true });
    raw.exec("PRAGMA busy_timeout = 0");
    let bare: unknown = null;
    try {
      raw.query("SELECT COUNT(*) AS n FROM state").get();
    } catch (e) {
      bare = e;
    } finally {
      raw.close();
    }

    // The same read through the helper, against the same held lock: it waits
    // out the writer and returns the row the writer put there.
    const db = openRunDb(dbPath, { readonly: true });
    try {
      return { bare, waited: db.query("SELECT COUNT(*) AS n FROM state").get() as { n: number } };
    } finally {
      db.close();
    }
  });

  expect(bare).not.toBeNull();
  expect((bare as { code?: string }).code).toBe("SQLITE_BUSY");
  expect(waited.n).toBeGreaterThanOrEqual(1);
});

test("the busy timeout is set on read-only and writable handles alike", () => {
  for (const readonly of [true, false]) {
    const db = openRunDb(dbPath, { readonly });
    try {
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: readonly ? RUN_DB_BUSY_TIMEOUT_MS : RUN_DB_WRITER_BUSY_TIMEOUT_MS });
    } finally {
      db.close();
    }
  }
});

test("run stores stay on the rollback journal, which is what a read-only mount can open", () => {
  // Not an incidental fact: the publisher mounts `data/runs` read-only and
  // renders the viewer's handler in-process, and a WAL-mode file cannot be
  // opened at all — not even for reading — without write access to its
  // directory. See runner/src/rundb.ts.
  const db = openRunDb(dbPath);
  try {
    const mode = String((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
    expect(mode).not.toBe("wal");
  } finally {
    db.close();
  }
});

// ------------------------------------------------- a reader never kills the writer
//
// The other direction, and the one that costs a run. On the rollback journal a
// reader's SHARED lock lasts as long as its statement (or its transaction), and
// the writer's commit needs every SHARED lock gone. A read longer than the
// writer's busy timeout made the writer's INSERT throw `SQLiteError: database
// is locked`, the driver loop caught it as a harness error, and a live
// freeplay run was terminated by somebody reading it. The writer now waits far
// longer than any reader does, so the reader is the one that gives up first.

const readHoldScript = join(dir, "read-hold.ts");
writeFileSync(
  readHoldScript,
  `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const [path, sentinel, ms] = process.argv.slice(2) as [string, string, string];
const db = new Database(path, { readonly: true });
db.exec("BEGIN");
db.query("SELECT COUNT(*) AS n FROM sqlite_master").get();
writeFileSync(sentinel, "reading");
Bun.sleepSync(Number(ms));
db.exec("COMMIT");
db.close();
`,
);

/** Run `fn` while a child process holds a read transaction (SHARED) on `path`. */
async function whileReading<T>(path: string, holdMs: number, fn: () => T): Promise<T> {
  const sentinel = join(dir, "reading");
  rmSync(sentinel, { force: true });
  const child = Bun.spawn([process.execPath, readHoldScript, path, sentinel, String(holdMs)], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(sentinel)) {
      if (Date.now() > deadline) throw new Error(`reader never started: ${await new Response(child.stderr).text()}`);
      await Bun.sleep(5);
    }
    return fn();
  } finally {
    await child.exited;
  }
}

test("a writer whose busy timeout is shorter than a reader's hold dies with exactly the error a live run died of", async () => {
  const thrown = await whileReading(dbPath, 1500, () => {
    const db = openRunDb(dbPath, { busyTimeoutMs: 300 });
    try {
      db.exec("INSERT INTO state (run_id, level) VALUES ('r', 2)");
      return null;
    } catch (e) {
      return e;
    } finally {
      db.close();
    }
  });
  expect(String(thrown)).toBe("SQLiteError: database is locked");
});

test("the run's own writer outwaits a reader that holds the file longer than any reader's timeout", async () => {
  const runDir = join(dir, "run-writer");
  // The writer as the runner opens it: through Trajectory, with the defaults.
  const t = new Trajectory(runDir);
  try {
    const hold = RUN_DB_BUSY_TIMEOUT_MS + 700;
    const started = Date.now();
    await whileReading(join(runDir, "run.sqlite"), hold, () => {
      t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 });
    });
    // It waited the reader out instead of failing at a reader's budget.
    expect(Date.now() - started).toBeGreaterThan(RUN_DB_BUSY_TIMEOUT_MS);
  } finally {
    t.close();
  }
  const db = openRunDb(join(runDir, "run.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT COUNT(*) AS n FROM move").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
}, 20_000);

test("a writer waits several times longer than a reader, and well inside the heartbeat's two cold minutes", () => {
  expect(RUN_DB_WRITER_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * RUN_DB_BUSY_TIMEOUT_MS);
  expect(RUN_DB_WRITER_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  const w = openRunDb(dbPath);
  const r = openRunDb(dbPath, { readonly: true });
  try {
    expect(w.query("PRAGMA busy_timeout").get()).toEqual({ timeout: RUN_DB_WRITER_BUSY_TIMEOUT_MS });
    expect(r.query("PRAGMA busy_timeout").get()).toEqual({ timeout: RUN_DB_BUSY_TIMEOUT_MS });
  } finally {
    w.close();
    r.close();
  }
});
