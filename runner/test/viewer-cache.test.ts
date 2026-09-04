/**
 * The viewer's read caches, and the one thing they must never do.
 *
 * Every listing route reads every run directory, and two of those reads are
 * expensive enough to have been the whole reason the API was slow: a live run's
 * `trajectory.jsonl` runs to hundreds of megabytes and misses the (size, mtime)
 * totals cache on every poll, and 330 run directories mean 330 SQLite opens per
 * request. Both are memoised now, and the tests that matter are the ones that
 * pin what a memo is not allowed to do: serve a stale row for a run that is
 * being written *right now*, or count the same appended bytes twice.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunsCached, readRunCached, readStatesCached, type RunReadCacheEntry } from "../viewer/runs";
import { RunTotalsScanner, scanRunTotals } from "../viewer/tail";

const NOW = 1_700_000_000_000;

function line(ts: number, t: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, t, ...extra }) + "\n";
}

/** The three records a run row and a totals scan are read from. */
function trajectory(runId: string): string {
  return (
    line(1000, "meta", { runId, harnessVersion: "harness-test" }) +
    line(1100, "request", { turn: 1, messages: [{ role: "user", content: "go" }] }) +
    line(1200, "response", { turn: 1, message: { role: "assistant", content: "ok" }, usage: { prompt_tokens: 10, completion_tokens: 4 } }) +
    line(1300, "snippet", { turn: 1, code: "await sdk.moveTo(1, 2, 3);" })
  );
}

/**
 * One run directory. `terminationReason` null and a recent mtime is what makes
 * a run read as live, so both are the knobs every test here turns.
 */
function makeRun(
  runsDir: string,
  runId: string,
  opts: { terminationReason?: string | null; level?: number; mtime?: number } = {},
): string {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ runId, harnessVersion: "harness-test", startedAt: 1000, config: { model: "test/model" } }),
  );
  writeFileSync(join(dir, "trajectory.jsonl"), trajectory(runId));
  const db = new Database(join(dir, "run.sqlite"));
  db.run(
    `CREATE TABLE run (run_id TEXT, model TEXT, driver TEXT, shakeout TEXT, objective TEXT,
       harness_version TEXT, started_at INTEGER, ended_at INTEGER, termination_reason TEXT,
       termination_detail TEXT, pause_reason TEXT, config_json TEXT)`,
  );
  db.run(`INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    runId,
    "test/model",
    "openai",
    null,
    null,
    "harness-test",
    1000,
    null,
    opts.terminationReason ?? null,
    null,
    null,
    "{}",
  ]);
  db.run(`CREATE TABLE state (run_id TEXT, ts INTEGER, level INTEGER, xp INTEGER, map INTEGER, x REAL, y REAL, z REAL)`);
  db.run(`INSERT INTO state VALUES (?,?,?,?,?,?,?,?)`, [runId, 1200, opts.level ?? 5, 100, 0, 1, 2, 3]);
  db.close();
  touch(dir, opts.mtime ?? NOW);
  return dir;
}

/** Pin every artefact's mtime, so a test controls liveness and the signature. */
function touch(dir: string, mtimeMs: number): void {
  const at = mtimeMs / 1000;
  for (const name of ["meta.json", "run.sqlite", "trajectory.jsonl"]) {
    try {
      utimesSync(join(dir, name), at, at);
    } catch {
      /* a run without the file is a case the signature already handles */
    }
  }
}

/** Rewrite one run's level in place, then put the mtimes back where they were. */
function setLevel(dir: string, runId: string, level: number, mtimeMs: number): void {
  const db = new Database(join(dir, "run.sqlite"));
  db.run(`UPDATE state SET level = ? WHERE run_id = ?`, [level, runId]);
  db.close();
  touch(dir, mtimeMs);
}

function tempRuns(): string {
  const root = mkdtempSync(join(tmpdir(), "viewer-cache-"));
  const runs = join(root, "runs");
  mkdirSync(runs, { recursive: true });
  return runs;
}

describe("the run row memo", () => {
  test("a run that has gone quiet is read once", () => {
    const runs = tempRuns();
    // Long finished: the mtime is hours old, so nothing here is a live claim.
    makeRun(runs, "quiet", { terminationReason: "objective-complete", mtime: NOW - 3_600_000 });
    const cache = new Map<string, RunReadCacheEntry>();
    const first = listRunsCached(runs, cache, NOW);
    const second = listRunsCached(runs, cache, NOW);
    expect(first).toHaveLength(1);
    // Object identity is the assertion: a re-read would build a new row.
    expect(second[0]).toBe(first[0]!);
    rmSync(runs, { recursive: true, force: true });
  });

  test("a live run's row is never served stale", () => {
    const runs = tempRuns();
    /*
     * The trap this whole file exists for. The signature is put back exactly
     * where it was after the write — same size, same mtime — so the memo would
     * hit on the signature alone. A live run must be re-read anyway, because
     * its row is a claim about a process that is writing right now.
     */
    const dir = makeRun(runs, "live", { terminationReason: null, level: 5, mtime: NOW - 1000 });
    const cache = new Map<string, RunReadCacheEntry>();
    expect(readRunCached(runs, "live", cache, NOW).level).toBe(5);
    expect(readRunCached(runs, "live", cache, NOW).live).toBe(true);

    const before = statSync(join(dir, "run.sqlite"));
    setLevel(dir, "live", 9, NOW - 1000);
    expect(statSync(join(dir, "run.sqlite")).size).toBe(before.size);
    expect(statSync(join(dir, "run.sqlite")).mtimeMs).toBe(before.mtimeMs);

    expect(readRunCached(runs, "live", cache, NOW).level).toBe(9);
    rmSync(runs, { recursive: true, force: true });
  });

  test("a terminated run under the same conditions IS served from the memo", () => {
    const runs = tempRuns();
    /*
     * The other half of the pair: identical setup but with a termination
     * reason, so the row is not a claim about a running process. This is what
     * proves the test above is exercising the live rule and not merely the
     * signature — the signature is unchanged in both.
     */
    const dir = makeRun(runs, "done", { terminationReason: "objective-complete", level: 5, mtime: NOW - 1000 });
    const cache = new Map<string, RunReadCacheEntry>();
    expect(readRunCached(runs, "done", cache, NOW).level).toBe(5);
    setLevel(dir, "done", 9, NOW - 1000);
    expect(readRunCached(runs, "done", cache, NOW).level).toBe(5);
    rmSync(runs, { recursive: true, force: true });
  });

  test("a run whose files moved is re-read", () => {
    const runs = tempRuns();
    const dir = makeRun(runs, "grew", { terminationReason: "objective-complete", level: 5, mtime: NOW - 3_600_000 });
    const cache = new Map<string, RunReadCacheEntry>();
    expect(readRunCached(runs, "grew", cache, NOW).level).toBe(5);
    setLevel(dir, "grew", 9, NOW - 1_800_000);
    expect(readRunCached(runs, "grew", cache, NOW).level).toBe(9);
    rmSync(runs, { recursive: true, force: true });
  });

  test("liveness is decided against the caller's clock, never replayed", () => {
    const runs = tempRuns();
    makeRun(runs, "stale", { terminationReason: null, mtime: NOW - 3_600_000 });
    const cache = new Map<string, RunReadCacheEntry>();
    // An hour-old trajectory with no termination: quiet, so cacheable.
    expect(readRunCached(runs, "stale", cache, NOW).live).toBe(false);
    // The same row asked for against a clock inside the live window is not
    // answered from the memo at all — it is re-read and reads live.
    expect(readRunCached(runs, "stale", cache, NOW - 3_600_000 + 1000).live).toBe(true);
    rmSync(runs, { recursive: true, force: true });
  });

  test("a run that goes away is dropped from the memo", () => {
    const runs = tempRuns();
    makeRun(runs, "gone", { terminationReason: "objective-complete", mtime: NOW - 3_600_000 });
    const cache = new Map<string, RunReadCacheEntry>();
    listRunsCached(runs, cache, NOW);
    expect(cache.size).toBe(1);
    rmSync(join(runs, "gone"), { recursive: true, force: true });
    expect(listRunsCached(runs, cache, NOW)).toHaveLength(0);
    expect(cache.size).toBe(0);
    rmSync(runs, { recursive: true, force: true });
  });
});

describe("the state series memo", () => {
  test("a quiet run's samples are read once and a live run's never are", () => {
    const runs = tempRuns();
    const quiet = makeRun(runs, "quiet", { terminationReason: "objective-complete", level: 5, mtime: NOW - 3_600_000 });
    const live = makeRun(runs, "live", { terminationReason: null, level: 5, mtime: NOW - 1000 });
    const cache = new Map<string, RunReadCacheEntry>();
    // The rows have to be read first: the series rides on the entry the row
    // made, so the memo never attaches a series to a signature it did not see.
    listRunsCached(runs, cache, NOW);

    const first = readStatesCached(runs, "quiet", cache, NOW);
    expect(readStatesCached(runs, "quiet", cache, NOW)).toBe(first);
    setLevel(quiet, "quiet", 9, NOW - 3_600_000);
    expect(readStatesCached(runs, "quiet", cache, NOW)[0]?.level).toBe(5);

    expect(readStatesCached(runs, "live", cache, NOW)[0]?.level).toBe(5);
    setLevel(live, "live", 9, NOW - 1000);
    expect(readStatesCached(runs, "live", cache, NOW)[0]?.level).toBe(9);
    rmSync(runs, { recursive: true, force: true });
  });
});

describe("RunTotalsScanner", () => {
  test("resuming over an append is the same answer as reading the file whole", async () => {
    const runs = tempRuns();
    const path = join(runs, "trajectory.jsonl");
    writeFileSync(path, trajectory("r"));
    const scanner = new RunTotalsScanner(path);
    await scanner.scan();
    appendFileSync(path, line(1400, "tool_call", { turn: 2, tool: "look" }));
    appendFileSync(path, line(1500, "response", { turn: 2, message: { role: "assistant", content: "done" }, usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    const resumed = await scanner.scan();
    expect(resumed).toEqual(await scanRunTotals(path));
    rmSync(runs, { recursive: true, force: true });
  });

  test("a half-written last line is not counted until its newline arrives", async () => {
    const runs = tempRuns();
    const path = join(runs, "trajectory.jsonl");
    writeFileSync(path, trajectory("r"));
    const whole = await scanRunTotals(path);

    const scanner = new RunTotalsScanner(path);
    await scanner.scan();
    /*
     * The record is complete JSON but its newline has not landed. This is the
     * double-count trap: counting it now and again when the newline arrives
     * would give the run two tool calls where it made one, and it is a
     * *complete* record precisely so a "does it parse" guard cannot save us.
     */
    const record = line(1400, "tool_call", { turn: 2, tool: "look" });
    appendFileSync(path, record.slice(0, -1));
    const partial = await scanner.scan();
    expect(partial.entries).toBe(whole.entries);
    expect(partial.toolCalls).toBe(whole.toolCalls);

    appendFileSync(path, "\n");
    const complete = await scanner.scan();
    expect(complete).toEqual(await scanRunTotals(path));
    expect(complete.toolCalls).toBe(whole.toolCalls + 1);

    // And the byte after it still resumes from the right offset.
    appendFileSync(path, line(1500, "snippet", { turn: 2, code: "y" }));
    expect(await scanner.scan()).toEqual(await scanRunTotals(path));
    rmSync(runs, { recursive: true, force: true });
  });

  test("size reports only what was consumed, so a shrink is visible to the caller", async () => {
    const runs = tempRuns();
    const path = join(runs, "trajectory.jsonl");
    writeFileSync(path, trajectory("r"));
    const scanner = new RunTotalsScanner(path);
    await scanner.scan();
    expect(scanner.size).toBe(statSync(path).size);
    // Truncation or replacement: the caller (`runTotals` in `api.ts`) sees a
    // scanner that has read past the file and starts a fresh one, because
    // folding new bytes into old accumulators would double-count.
    writeFileSync(path, line(2000, "meta", { runId: "r" }));
    expect(scanner.size).toBeGreaterThan(statSync(path).size);
    rmSync(runs, { recursive: true, force: true });
  });

  test("a trajectory whose last record has no newline is still counted whole", async () => {
    const runs = tempRuns();
    const path = join(runs, "trajectory.jsonl");
    writeFileSync(path, trajectory("r") + JSON.stringify({ ts: 1400, t: "snippet", turn: 2, code: "x" }));
    // The one-shot form's long-standing behaviour, unchanged by resumability.
    expect((await scanRunTotals(path)).snippets).toBe(2);
    rmSync(runs, { recursive: true, force: true });
  });
});
