/**
 * Reading a 0.5 run's `run.sqlite` (runner/src/rundb.ts): nothing writes one
 * now, but a 0.5 run and a first-build v1 run stay readable, including one
 * whose writer died with commits still in its `-wal`.
 *
 * A lock holder runs in a child process, never on a timer here: `bun:sqlite`
 * is synchronous, so a blocking statement on this thread would never let a
 * `setTimeout` that releases the lock fire. The child touches a sentinel file
 * so the parent knows the lock is held rather than guessing at a delay.
 *
 * Everything lives in an `os.tmpdir()` directory made per run. Nothing here
 * reads `data/`.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRunDb, openRunDb, runDbStat } from "../src/rundb";

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

/**
 * A run.sqlite as a 0.5 runner left it mid-run: WAL mode, with commits still
 * in the `-wal` because the writer (held open here) has not checkpointed.
 */
function walRun(runDir: string, rows: number): Database {
  mkdirSync(runDir, { recursive: true });
  const db = new Database(join(runDir, "run.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec("CREATE TABLE state (run_id TEXT, level INTEGER)");
  for (let i = 0; i < rows; i++) db.query("INSERT INTO state VALUES ('r', ?)").run(i);
  return db;
}

// ------------------------------------------------- copies carry the WAL

test("copyRunDb carries commits still in the WAL into one standalone file", () => {
  const runDir = join(dir, "copy-src");
  const writer = walRun(runDir, 20);
  // The writer is still open, so its commits are in the -wal, not the file.
  expect(statSync(join(runDir, "run.sqlite-wal")).size).toBeGreaterThan(0);
  const out = join(dir, "copy-dest");
  mkdirSync(out);
  expect(copyRunDb(runDir, join(out, "run.sqlite"))).toBe("vacuum");
  expect(readdirSync(out)).toEqual(["run.sqlite"]);
  const copy = new Database(join(out, "run.sqlite"), { readonly: true });
  try {
    expect((copy.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    expect(copy.query("SELECT COUNT(*) AS n FROM state").get()).toEqual({ n: 20 });
  } finally {
    copy.close();
  }
  expect(copyRunDb(join(dir, "no-such-run"), join(out, "x.sqlite"))).toBe("none");
  writer.close();
});

test("runDbStat moves when a commit reaches only the WAL", async () => {
  const runDir = join(dir, "stat");
  const writer = walRun(runDir, 1);
  const before = runDbStat(runDir)!;
  const fileBefore = statSync(join(runDir, "run.sqlite"));
  await Bun.sleep(5);
  writer.query("INSERT INTO state VALUES ('r', 2)").run();
  const fileAfter = statSync(join(runDir, "run.sqlite"));
  // run.sqlite itself did not move; the pair did.
  expect([fileAfter.size, fileAfter.mtimeMs]).toEqual([fileBefore.size, fileBefore.mtimeMs]);
  expect(runDbStat(runDir)).not.toEqual(before);
  expect(runDbStat(join(dir, "no-such-run"))).toBeNull();
  writer.close();
});
