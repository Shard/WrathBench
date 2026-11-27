/**
 * The supervisor's half of rollout deletion: which Codex homes it sweeps and
 * which threads it keeps, since deleting a live run's rollout loses that run;
 * and the `--status` line that carries the CLI's words with no credential in
 * them. Fixture homes in temp directories; no live stack.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHomesOf, liveCodexThreads, pruneCodexHomes } from "./run-fleet";
import { pauseDetailLine } from "./run-fleet-status";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 3_600_000;
const LIVE = "01a1447e-cf11-7d23-9d03-31d816687f46";
const PAUSING = "01a14447-ab85-7691-8c6a-e1c22ad6d98c";
const DEAD = "01a13865-5045-7781-8109-0b9505ae9af2";

/** A Codex home with old rollouts of the given threads, plus the CLI's other files. */
function home(threads: string[], ageMs = 30 * HOUR): string {
  const h = tmp("wrathbench-fleet-codex-home-");
  writeFileSync(join(h, "auth.json"), "{}\n");
  writeFileSync(join(h, "thread_history_1.sqlite"), "x");
  const day = join(h, "sessions", "2026", "10", "14");
  mkdirSync(day, { recursive: true });
  for (const t of threads) {
    const f = join(day, `rollout-2026-10-14T03-12-06-${t}.jsonl`);
    writeFileSync(f, "y".repeat(1024));
    utimesSync(f, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }
  return h;
}

/** A stand-in `codex` for the sweep's thread deletes: logs `CODEX_HOME` and its argv, then exits `code`. */
function fakeCodex(code = 0): { bin: string; calls: () => string[] } {
  const dir = tmp("wrathbench-fleet-codex-bin-");
  const bin = join(dir, "codex");
  const log = join(dir, "calls.log");
  writeFileSync(bin, `#!/bin/sh\necho "$CODEX_HOME $*" >> ${log}\n${code === 0 ? "" : 'echo "Error: failed to delete session" >&2\n'}exit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

const fact = (runId: string, o: { driver?: string; live?: boolean; heartbeatAt?: number | null; archived?: boolean } = {}) => ({
  runId,
  driver: o.driver ?? "codex",
  live: o.live ?? false,
  heartbeatAt: o.heartbeatAt ?? null,
  ...(o.archived !== undefined ? { archived: o.archived } : {}),
});

describe("the Codex homes a supervisor sweeps", () => {
  test("CODEX_HOME and each home a ChatGPT credential names, set to a directory here, once per real path", () => {
    const a = home([]);
    const b = home([]);
    const link = join(tmp("wrathbench-fleet-codex-link-"), "same");
    symlinkSync(a, link);
    const env = { CODEX_HOME: a, CODEX_HOME_2: b, CODEX_HOME_3: link, CODEX_HOME_4: join(a, "missing"), CLAUDE_CODE_OAUTH_TOKEN_2: b };
    const homes = codexHomesOf(["CODEX_HOME_2", "CODEX_HOME_3", "CODEX_HOME_4"], env);
    expect(homes.map((h) => h.env)).toEqual(["CODEX_HOME", "CODEX_HOME_2"]);
    // A home no credential names is not this supervisor's to sweep; an unset one is not here.
    expect(codexHomesOf([], { CODEX_HOME_2: b }).map((h) => h.env)).toEqual([]);
  });
});

describe("the threads a sweep keeps", () => {
  test("the recorded thread of every codex run with a live owner: live, or still beating", () => {
    const threads: Record<string, string> = { live: LIVE, pausing: PAUSING, ended: DEAD.replace("01a1", "01b1"), dead: DEAD, other: "x" };
    const { keep, unrecorded } = liveCodexThreads(
      [
        fact("live", { live: true }),
        // Paused a moment ago and still unwinding: not `live`, but its heartbeat is fresh.
        fact("pausing", { heartbeatAt: NOW - 30_000 }),
        // Ended and gone: its heartbeat file removed, or cold.
        fact("ended"),
        fact("dead", { heartbeatAt: NOW - 10 * 60_000 }),
        fact("other", { driver: "claude-code", live: true }),
        fact("archived", { live: true, archived: true }),
      ],
      { now: NOW, threadOf: (id) => threads[id] },
    );
    expect([...keep].sort()).toEqual([LIVE, PAUSING].sort());
    expect(unrecorded).toEqual([]);
  });
});

describe("the hourly sweep", () => {
  test("deletes every old rollout no live run claims, in every home, then those threads from the CLI's stores", () => {
    const a = home([LIVE, DEAD]);
    const b = home([PAUSING]);
    const cli = fakeCodex();
    const lines: string[] = [];
    const r = pruneCodexHomes({
      homes: [{ env: "CODEX_HOME", path: a }, { env: "CODEX_HOME_2", path: b }],
      runs: [fact("live", { live: true })],
      now: NOW,
      threadOf: () => LIVE,
      codexBin: cli.bin,
      say: (s) => lines.push(s),
    });
    expect(r).toMatchObject({ files: 2, bytes: 2048, kept: 1, errors: 0, threads: [DEAD, PAUSING] });
    expect(readdirSync(join(a, "sessions", "2026", "10", "14"))).toEqual([`rollout-2026-10-14T03-12-06-${LIVE}.jsonl`]);
    expect(readdirSync(join(b, "sessions", "2026", "10", "14"))).toEqual([]);
    for (const h of [a, b]) for (const f of ["auth.json", "thread_history_1.sqlite"]) expect(existsSync(join(h, f))).toBe(true);
    // Each dead thread in its own home; the live one is never offered.
    expect(cli.calls()).toEqual([`${a} delete --force ${DEAD}`, `${b} delete --force ${PAUSING}`]);
  });

  test("a rollout written in the last two hours stays, whoever owns it, and so does its thread", () => {
    const a = home([DEAD], 90 * 60_000);
    const cli = fakeCodex();
    const r = pruneCodexHomes({ homes: [{ env: "CODEX_HOME", path: a }], runs: [], now: NOW, codexBin: cli.bin, say: () => {} });
    expect(r).toMatchObject({ files: 0, kept: 1, threads: [] });
    expect(cli.calls()).toEqual([]);
  });

  test("nothing is deleted while a live codex run has no thread on record", () => {
    const a = home([DEAD]);
    const cli = fakeCodex();
    const lines: string[] = [];
    const r = pruneCodexHomes({ homes: [{ env: "CODEX_HOME", path: a }], runs: [fact("fresh", { live: true })], now: NOW, threadOf: () => undefined, codexBin: cli.bin, say: (s) => lines.push(s) });
    expect(r).toBeUndefined();
    expect(readdirSync(join(a, "sessions", "2026", "10", "14"))).toHaveLength(1);
    expect(cli.calls()).toEqual([]);
    expect(lines).toEqual(["codex rollouts: not swept — live codex run(s) with no thread on record: fresh"]);
  });
});

describe("--status", () => {
  test("an infrastructure-failed pause's CLI words reach the terminal as one line with no credential in it", () => {
    const WRITER_FAILED =
      "2026-10-16T10:04:31.504143Z ERROR codex_rollout::recorder: rollout writer failed for /home/bun/.codex/sessions/2026/10/16/rollout-2026-10-16T10-04-31-01a1442b-9a43-78a0-813e-e59e01be915d.jsonl; buffered rollout items will be retried: No space left on device (os error 28); error_kind=StorageFull; raw_os_error=Some(28)";
    const line = pauseDetailLine(WRITER_FAILED)!;
    expect(line.startsWith("rollout writer failed for …; buffered rollout items will be retried: No space left on device (os error 28)")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(pauseDetailLine("401 for Bearer abcdefghijklmnopqrstuvwxyz0123 and sk-proj-abcdefghijklmnop1234")).toBe("401 for [masked] and [masked]");
  });
});
