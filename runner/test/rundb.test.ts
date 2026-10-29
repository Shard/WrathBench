/**
 * The contention `openRunDb` and the run's writer exist to survive.
 *
 * A live run is written and read at the same time — the runner appending state
 * rows while the viewer, the fleet supervisor, the collector and the
 * publisher read the same file. The writer keeps the file in WAL while it
 * writes, so a reader never holds it up; every handle carries a busy timeout
 * for the locks WAL still takes; and a write that meets one anyway is retried
 * with waits the event loop runs through, then thrown (runner/src/rundb.ts).
 *
 * Lock holders run in child processes, never on a timer here: `bun:sqlite` is
 * synchronous, so a blocking statement on this thread would never let a
 * `setTimeout` that releases the lock fire. Each child touches a sentinel file
 * so the parent knows the lock is held rather than guessing at a delay.
 *
 * Everything lives in an `os.tmpdir()` directory made per run. Nothing here
 * reads `data/`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyRunDb,
  isTransientRunDbError,
  journalMode,
  openRunDb,
  retryRunDbWrite,
  RUN_DB_BUSY_TIMEOUT_MS,
  RUN_DB_RETRY_WAITS_MS,
  runDbStat,
} from "../src/rundb";
import { HEARTBEAT_DEAD_MS, readTrajectory, Trajectory } from "../src/trajectory";

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

let sentinels = 0;

/** Spawn `script` with `args` plus a fresh sentinel, wait until it has touched it, run `fn`, then wait the child out. */
async function whileChild<T>(script: string, args: string[], fn: () => T | Promise<T>): Promise<T> {
  const sentinel = join(dir, `sentinel-${++sentinels}`);
  const child = Bun.spawn([process.execPath, script, args[0]!, sentinel, ...args.slice(1)], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(sentinel)) {
      if (Date.now() > deadline) throw new Error(`child never started: ${await new Response(child.stderr).text()}`);
      await Bun.sleep(5);
    }
    return await fn();
  } finally {
    await child.exited;
  }
}

/** Run `fn` while a child process holds the (rollback-mode) seed store exclusively. */
function whileLocked<T>(holdMs: number, fn: () => T): Promise<T> {
  return whileChild(holdScript, [dbPath, String(holdMs)], fn);
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

test("every handle waits the same five seconds: the writer's waits come from its retries, not one long busy wait", () => {
  expect(RUN_DB_BUSY_TIMEOUT_MS).toBe(5000);
  for (const readonly of [true, false]) {
    const db = openRunDb(dbPath, { readonly });
    try {
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: RUN_DB_BUSY_TIMEOUT_MS });
    } finally {
      db.close();
    }
  }
});

test("the worst case — four attempts' busy waits and the three retry waits — stays inside the cold-heartbeat window", () => {
  expect(RUN_DB_RETRY_WAITS_MS).toEqual([5_000, 10_000, 15_000]);
  const worst = (RUN_DB_RETRY_WAITS_MS.length + 1) * RUN_DB_BUSY_TIMEOUT_MS + RUN_DB_RETRY_WAITS_MS.reduce((a, b) => a + b, 0);
  expect(worst).toBe(50_000);
  expect(worst).toBeLessThan(HEARTBEAT_DEAD_MS);
});

// ------------------------------------------------- WAL: a reader never holds up the writer

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

/** Run `fn` while a child process holds a read transaction on `path`. */
function whileReading<T>(path: string, holdMs: number, fn: () => T | Promise<T>): Promise<T> {
  return whileChild(readHoldScript, [path, String(holdMs)], fn);
}

test("on the rollback journal a writer whose busy timeout is shorter than a reader's hold dies with exactly the error a live run died of", async () => {
  // The control for the test below: the seed file is a rollback-journal file,
  // as every run.sqlite was before WAL.
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

test("the run's own writer, in WAL, writes straight through a reader that holds the file far longer than the busy timeout", async () => {
  const runDir = join(dir, "wal-writer");
  // The writer as run.ts opens it, with a busy timeout too short to wait out
  // the reader: under WAL it never has to.
  const t = new Trajectory(runDir, { wal: true, retry: true, busyTimeoutMs: 100 });
  expect(t.journal).toEqual({ mode: "wal" });
  const elapsed = await whileReading(join(runDir, "run.sqlite"), 1500, async () => {
    const started = Date.now();
    for (let i = 0; i < 5; i++) await t.recordMove("r", { ts: i, moveId: i, map: 0, x: 1, y: 2, z: 3 });
    return Date.now() - started;
  });
  expect(elapsed).toBeLessThan(500);
  expect(readTrajectory(runDir).filter((r) => r.t === "harness")).toEqual([]);
  // A reader sees every commit, before any checkpoint.
  const db = openRunDb(join(runDir, "run.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT COUNT(*) AS n FROM move").get()).toEqual({ n: 5 });
  } finally {
    db.close();
  }
  expect(await t.finish()).toBe("delete");
}, 20_000);

test("a read-only open of a WAL-mode file works in a writable directory: live, after a crash, and after a clean finish", async () => {
  const runDir = join(dir, "wal-readers");
  const t = new Trajectory(runDir, { wal: true });
  await t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 });
  const count = (): number => {
    const db = openRunDb(join(runDir, "run.sqlite"), { readonly: true });
    try {
      return (db.query("SELECT COUNT(*) AS n FROM move").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  // Live: the writer's -wal and -shm are beside it.
  expect(readdirSync(runDir).filter((f) => f.startsWith("run.sqlite")).sort()).toEqual(["run.sqlite", "run.sqlite-shm", "run.sqlite-wal"]);
  expect(count()).toBe(1);
  // A clean finish leaves run.sqlite alone, on the rollback journal: a reader
  // then creates no side files.
  await t.finish();
  expect(readdirSync(runDir).filter((f) => f.startsWith("run.sqlite"))).toEqual(["run.sqlite"]);
  expect(count()).toBe(1);
  expect(readdirSync(runDir).filter((f) => f.startsWith("run.sqlite"))).toEqual(["run.sqlite"]);

  // A writer that died: its WAL holds commits the file does not, and a
  // read-only open still reads them.
  const crashDir = join(dir, "wal-crash");
  mkdirSync(crashDir);
  const crash = join(dir, "crash.ts");
  writeFileSync(
    crash,
    `import { Database } from "bun:sqlite";
const db = new Database(process.argv[2] + "/run.sqlite");
db.exec("PRAGMA journal_mode = WAL");
db.exec("CREATE TABLE move (n INTEGER)");
for (let i = 0; i < 50; i++) db.exec("INSERT INTO move VALUES (1)");
process.kill(process.pid, "SIGKILL");
`,
  );
  await Bun.spawn([process.execPath, crash, crashDir]).exited;
  expect(statSync(join(crashDir, "run.sqlite-wal")).size).toBeGreaterThan(0);
  const db = openRunDb(join(crashDir, "run.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT COUNT(*) AS n FROM move").get()).toEqual({ n: 50 });
  } finally {
    db.close();
  }
  // Any later opener that closes it with nobody else holding it heals it.
  new Trajectory(crashDir).close();
  expect(readdirSync(crashDir).filter((f) => f.startsWith("run.sqlite"))).toEqual(["run.sqlite"]);
  const healed = openRunDb(join(crashDir, "run.sqlite"), { readonly: true });
  try {
    expect(journalMode(healed)).toBe("delete");
    expect(healed.query("SELECT COUNT(*) AS n FROM move").get()).toEqual({ n: 50 });
  } finally {
    healed.close();
  }
}, 20_000);

const openHoldScript = join(dir, "open-hold.ts");
writeFileSync(
  openHoldScript,
  `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const [path, sentinel, ms] = process.argv.slice(2) as [string, string, string];
const db = new Database(path, { readonly: true });
db.query("SELECT COUNT(*) AS n FROM sqlite_master").get();
writeFileSync(sentinel, "open");
Bun.sleepSync(Number(ms));
db.close();
`,
);

test("finish waits out a reader's statement before leaving WAL", async () => {
  const runDir = join(dir, "wal-finish-read");
  const t = new Trajectory(runDir, { wal: true });
  await t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 });
  const mode = await whileReading(join(runDir, "run.sqlite"), 800, () => t.finish({ sleep: async () => undefined }));
  expect(mode).toBe("delete");
  expect(readdirSync(runDir).filter((f) => f.startsWith("run.sqlite"))).toEqual(["run.sqlite"]);
}, 20_000);

test("finish tries again while a reader holds the file open, and checkpoints when it never lets go", async () => {
  const runDir = join(dir, "wal-finish-open");
  const t = new Trajectory(runDir, { wal: true });
  await t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 });
  // An idle connection held open for the whole of finish's patience: the file
  // stays in WAL, but its commits are folded into run.sqlite and the WAL is empty.
  const sleeps: number[] = [];
  const mode = await whileChild(openHoldScript, [join(runDir, "run.sqlite"), "1500"], () =>
    t.finish({ sleep: async (ms) => void sleeps.push(ms) }),
  );
  expect(mode).toBe("wal");
  expect(sleeps.length).toBe(19);
  expect(statSync(join(runDir, "run.sqlite-wal")).size).toBe(0);
  const raw = new Database(join(runDir, "run.sqlite"), { readonly: true });
  try {
    expect(raw.query("SELECT COUNT(*) AS n FROM move").get()).toEqual({ n: 1 });
  } finally {
    raw.close();
  }
}, 20_000);

// ------------------------------------------------- the writer's retry

const writeHoldScript = join(dir, "write-hold.ts");
writeFileSync(
  writeHoldScript,
  `import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const [path, sentinel, ms] = process.argv.slice(2) as [string, string, string];
const db = new Database(path);
db.exec("BEGIN IMMEDIATE");
writeFileSync(sentinel, "writing");
Bun.sleepSync(Number(ms));
db.exec("COMMIT");
db.close();
`,
);

/** Run `fn` while a child process holds the write lock on a WAL-mode `path` (a second writer: what WAL still waits for). */
function whileWriting<T>(path: string, holdMs: number, fn: () => T | Promise<T>): Promise<T> {
  return whileChild(writeHoldScript, [path, String(holdMs)], fn);
}

function busy(): Error {
  return Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY", errno: 5 });
}

describe("retryRunDbWrite", () => {
  test("three retries, five, ten and fifteen seconds apart, then the last error", async () => {
    const waits: number[] = [];
    const retries: unknown[] = [];
    let attempts = 0;
    const p = retryRunDbWrite(
      () => {
        attempts++;
        throw busy();
      },
      { sleep: async (ms) => void waits.push(ms), onRetry: (r) => retries.push(r) },
    );
    await expect(p).rejects.toThrow("database is locked");
    expect(attempts).toBe(4);
    expect(waits).toEqual([5_000, 10_000, 15_000]);
    expect(retries).toEqual([
      { attempt: 1, waitMs: 5_000, error: "SQLITE_BUSY: database is locked" },
      { attempt: 2, waitMs: 10_000, error: "SQLITE_BUSY: database is locked" },
      { attempt: 3, waitMs: 15_000, error: "SQLITE_BUSY: database is locked" },
    ]);
  });

  test("a write that lands on a retry resolves, having waited only up to it", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const got = await retryRunDbWrite(
      () => {
        if (++attempts < 3) throw busy();
        return "landed";
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(got).toBe("landed");
    expect(waits).toEqual([5_000, 10_000]);
  });

  test("a non-transient error is not retried", async () => {
    for (const e of [
      Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL", errno: 13 }),
      Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT", errno: 11 }),
      Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE", errno: 2067 }),
      new Error("Cannot use a closed database"),
    ]) {
      const waits: number[] = [];
      let attempts = 0;
      const p = retryRunDbWrite(
        () => {
          attempts++;
          throw e;
        },
        { sleep: async (ms) => void waits.push(ms) },
      );
      await expect(p).rejects.toBe(e);
      expect(attempts).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  test("the first attempt runs inside the call, so a write that succeeds is on disk before it returns", () => {
    let ran = false;
    void retryRunDbWrite(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("busy and locked are transient by their primary code, extended codes included", () => {
    expect(isTransientRunDbError(busy())).toBe(true);
    expect(isTransientRunDbError({ code: "SQLITE_BUSY_RECOVERY", errno: 261 })).toBe(true);
    expect(isTransientRunDbError({ code: "SQLITE_BUSY_SNAPSHOT", errno: 517 })).toBe(true);
    expect(isTransientRunDbError({ code: "SQLITE_LOCKED", errno: 6 })).toBe(true);
    expect(isTransientRunDbError({ code: "SQLITE_LOCKED_SHAREDCACHE", errno: 262 })).toBe(true);
    expect(isTransientRunDbError({ code: "SQLITE_FULL", errno: 13 })).toBe(false);
    expect(isTransientRunDbError({ code: "SQLITE_CONSTRAINT_UNIQUE", errno: 2067 })).toBe(false);
    expect(isTransientRunDbError(new Error("database is locked"))).toBe(true);
    expect(isTransientRunDbError(null)).toBe(false);
  });
});

describe("the run's writer retries a real lock without stopping the event loop", () => {
  test("a write that meets a second writer retries, logs each retry, keeps later writes in order, and a timer keeps firing", async () => {
    const runDir = join(dir, "retry-lands");
    const waits: number[] = [];
    const t = new Trajectory(runDir, {
      wal: true,
      busyTimeoutMs: 50,
      retry: { waitsMs: [300, 300, 300], sleep: (ms) => (waits.push(ms), Bun.sleep(ms)) },
    });
    // The heartbeat's stand-in: a timer on this thread that must keep firing
    // through the retry's waits.
    let beats = 0;
    const timer = setInterval(() => beats++, 20);
    try {
      await whileWriting(join(runDir, "run.sqlite"), 500, async () => {
        const first = t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 });
        // Issued while the first is retrying: queued behind it, not raced.
        const second = t.recordMove("r", { ts: 2, moveId: 2, map: 0, x: 1, y: 2, z: 3 });
        await Promise.all([first, second]);
      });
    } finally {
      clearInterval(timer);
    }
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(beats).toBeGreaterThan(5);
    const retries = readTrajectory(runDir).filter((r) => r.t === "harness" && r["kind"] === "rundb_retry");
    expect(retries.length).toBe(waits.length);
    expect(retries[0]).toMatchObject({ write: "move", attempt: 1, waitMs: 300, error: "SQLITE_BUSY: database is locked" });
    const db = openRunDb(join(runDir, "run.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT move_id FROM move ORDER BY rowid").all()).toEqual([{ move_id: 1 }, { move_id: 2 }]);
    } finally {
      db.close();
    }
    await t.finish();
  }, 20_000);

  test("after the third retry the write throws, as it always did, and the termination record is still on file", async () => {
    const runDir = join(dir, "retry-gives-up");
    const t = new Trajectory(runDir, { wal: true, busyTimeoutMs: 30, retry: { waitsMs: [50, 50, 50] } });
    await t.writeMeta({ runId: "r", harnessVersion: "v", startedAt: 1, config: { driver: "loop" } as never });
    const err = await whileWriting(join(runDir, "run.sqlite"), 2500, () => t.setTermination("r", "harness-error", "x").then(() => null, (e: unknown) => e));
    expect(String(err)).toBe("SQLiteError: database is locked");
    const recs = readTrajectory(runDir);
    expect(recs.filter((r) => r.t === "harness" && r["kind"] === "rundb_retry").map((r) => r["attempt"])).toEqual([1, 2, 3]);
    // The record went first, so the verdict survives the row (models.ts reads it).
    expect(recs.filter((r) => r.t === "termination")).toHaveLength(1);
    expect(t.runRow("r")?.["termination_reason"]).toBeNull();
    await t.finish();
  }, 20_000);

  test("a non-transient error still throws synchronously, with no retry", () => {
    const runDir = join(dir, "retry-not-transient");
    const t = new Trajectory(runDir, { wal: true, retry: { waitsMs: [50, 50, 50] } });
    t.close();
    // A closed handle is not a lock: the call throws at once.
    expect(() => t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 })).toThrow();
    expect(readTrajectory(runDir).filter((r) => r.t === "harness")).toEqual([]);
  });

  test("without retry (every short-lived opener) a write throws at once, synchronously", async () => {
    const runDir = join(dir, "no-retry");
    const t = new Trajectory(runDir, { busyTimeoutMs: 30 });
    // A WAL file another writer holds.
    const db = openRunDb(join(runDir, "run.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.close();
    await whileWriting(join(runDir, "run.sqlite"), 500, () => {
      expect(() => t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 })).toThrow("database is locked");
    });
    t.close();
  }, 20_000);
});

// ------------------------------------------------- copies carry the WAL

test("copyRunDb carries commits still in the WAL into one standalone file", async () => {
  const runDir = join(dir, "copy-src");
  const t = new Trajectory(runDir, { wal: true });
  for (let i = 0; i < 20; i++) await t.recordMove("r", { ts: i, moveId: i, map: 0, x: 1, y: 2, z: 3 });
  // The writer is still open, so its commits are in the -wal, not the file.
  expect(statSync(join(runDir, "run.sqlite-wal")).size).toBeGreaterThan(0);
  const out = join(dir, "copy-dest");
  mkdirSync(out);
  expect(copyRunDb(runDir, join(out, "run.sqlite"))).toBe("vacuum");
  expect(readdirSync(out)).toEqual(["run.sqlite"]);
  const copy = new Database(join(out, "run.sqlite"), { readonly: true });
  try {
    expect(journalMode(copy)).toBe("delete");
    expect(copy.query("SELECT COUNT(*) AS n FROM move").get()).toEqual({ n: 20 });
  } finally {
    copy.close();
  }
  expect(copyRunDb(join(dir, "no-such-run"), join(out, "x.sqlite"))).toBe("none");
  await t.finish();
});

test("runDbStat moves when a commit reaches only the WAL", async () => {
  const runDir = join(dir, "stat");
  const t = new Trajectory(runDir, { wal: true });
  await t.recordMove("r", { ts: 1, moveId: 1, map: 0, x: 1, y: 2, z: 3 });
  const before = runDbStat(runDir)!;
  const fileBefore = statSync(join(runDir, "run.sqlite"));
  await Bun.sleep(5);
  await t.recordMove("r", { ts: 2, moveId: 2, map: 0, x: 1, y: 2, z: 3 });
  const fileAfter = statSync(join(runDir, "run.sqlite"));
  // run.sqlite itself did not move; the pair did.
  expect([fileAfter.size, fileAfter.mtimeMs]).toEqual([fileBefore.size, fileBefore.mtimeMs]);
  expect(runDbStat(runDir)).not.toEqual(before);
  expect(runDbStat(join(dir, "no-such-run"))).toBeNull();
  await t.finish();
});
