/**
 * The supervisor's half of rollout deletion: which Codex homes it sweeps,
 * which threads it keeps, the one line a sweep logs, and the operator's
 * `--status` lines that say what an `infrastructure-failed` pause was and how
 * full a lane's volume is. Fixture homes in temp directories; no live stack.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHomesOf, liveCodexThreads, pruneCodexHomes, volumeUsage, type PausedListing } from "./run-fleet";
import { codexLaneVolume, formatPaused, pauseDetailLine, pauseDetailOf } from "./run-fleet-status";
import { formatSubscriptionGate, subscriptionGate } from "./run-fleet-gate";
import { writeCodexThread } from "../runner/src/codex-rollout";
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

const fact = (runId: string, o: { driver?: string; live?: boolean; heartbeatAt?: number | null; archived?: boolean } = {}) => ({
  runId,
  driver: o.driver ?? "codex",
  live: o.live ?? false,
  heartbeatAt: o.heartbeatAt ?? null,
  ...(o.archived !== undefined ? { archived: o.archived } : {}),
});

describe("the Codex homes a supervisor sweeps", () => {
  test("CODEX_HOME and each CODEX_HOME_N policy.subscriptions names, set to a directory here, once per real path", () => {
    const a = home([]);
    const b = home([]);
    const link = join(tmp("wrathbench-fleet-codex-link-"), "same");
    symlinkSync(a, link);
    const env = { CODEX_HOME: a, CODEX_HOME_2: b, CODEX_HOME_3: link, CODEX_HOME_4: join(a, "missing"), CLAUDE_CODE_OAUTH_TOKEN_2: b };
    const homes = codexHomesOf(["CLAUDE_CODE_OAUTH_TOKEN_2", "CODEX_HOME_2", "CODEX_HOME_3", "CODEX_HOME_4"], env);
    expect(homes.map((h) => h.env)).toEqual(["CODEX_HOME", "CODEX_HOME_2"]);
    // A home the policy does not name is not this supervisor's to sweep; an unset one is not here.
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

  test("a live codex run with no thread on record is named, and reads its sidecar by default", () => {
    const runsDir = tmp("wrathbench-fleet-runs-");
    mkdirSync(join(runsDir, "a"));
    mkdirSync(join(runsDir, "b"));
    writeCodexThread(join(runsDir, "a"), LIVE);
    const r = liveCodexThreads([fact("a", { live: true }), fact("b", { live: true })], { now: NOW, runsDir });
    expect([...r.keep]).toEqual([LIVE]);
    expect(r.unrecorded).toEqual(["b"]);
  });
});

describe("the hourly sweep", () => {
  test("deletes every old rollout no live run claims, in every home, and says so in one line", () => {
    const a = home([LIVE, DEAD]);
    const b = home([PAUSING]);
    const lines: string[] = [];
    const r = pruneCodexHomes({
      homes: [{ env: "CODEX_HOME", path: a }, { env: "CODEX_HOME_2", path: b }],
      runs: [fact("live", { live: true })],
      now: NOW,
      threadOf: () => LIVE,
      say: (s) => lines.push(s),
    });
    expect(r).toMatchObject({ files: 2, bytes: 2048, kept: 1, errors: 0 });
    expect(readdirSync(join(a, "sessions", "2026", "10", "14"))).toEqual([`rollout-2026-10-14T03-12-06-${LIVE}.jsonl`]);
    expect(readdirSync(join(b, "sessions", "2026", "10", "14"))).toEqual([]);
    for (const h of [a, b]) for (const f of ["auth.json", "thread_history_1.sqlite"]) expect(existsSync(join(h, f))).toBe(true);
    expect(lines).toEqual(["codex rollouts: removed 2 (0.0 MiB) under CODEX_HOME, CODEX_HOME_2; kept 1 (1 live thread)"]);
  });

  test("a rollout written in the last two hours stays, whoever owns it", () => {
    const a = home([DEAD], 90 * 60_000);
    const r = pruneCodexHomes({ homes: [{ env: "CODEX_HOME", path: a }], runs: [], now: NOW, say: () => {} });
    expect(r).toMatchObject({ files: 0, kept: 1 });
  });

  test("nothing is deleted while a live codex run has no thread on record", () => {
    const a = home([DEAD]);
    const lines: string[] = [];
    const r = pruneCodexHomes({ homes: [{ env: "CODEX_HOME", path: a }], runs: [fact("fresh", { live: true })], now: NOW, threadOf: () => undefined, say: (s) => lines.push(s) });
    expect(r).toBeUndefined();
    expect(readdirSync(join(a, "sessions", "2026", "10", "14"))).toHaveLength(1);
    expect(lines).toEqual(["codex rollouts: not swept — live codex run(s) with no thread on record: fresh"]);
  });

  test("no home is no sweep and no line; a failure is one line, never a throw", () => {
    const lines: string[] = [];
    expect(pruneCodexHomes({ homes: [], runs: [], now: NOW, say: (s) => lines.push(s) })).toBeUndefined();
    expect(lines).toEqual([]);
    const r = pruneCodexHomes({
      homes: [{ env: "CODEX_HOME", path: home([]) }],
      runs: [fact("x", { live: true })],
      now: NOW,
      threadOf: () => {
        throw new Error("boom");
      },
      say: (s) => lines.push(s),
    });
    expect(r).toBeUndefined();
    expect(lines).toEqual(["codex rollouts: sweep failed — boom"]);
  });
});

describe("--status", () => {
  const listing = (reason: string): PausedListing => ({
    runId: "fleet-codex-sol-61-freeplay-gpt-6-1-sol-20261011-a2",
    model: "gpt-6.1-sol",
    account: "RUNNER3",
    reason,
    since: NOW - HOUR,
    pauseCount: 7,
    resumeAfter: NOW + HOUR,
    elapsedMs: 94 * HOUR,
    budgetMs: null,
    why: `${reason}, pause 7: resuming after 13:00:00`,
  });
  const WRITER_FAILED =
    "2026-10-16T10:04:31.504143Z ERROR codex_rollout::recorder: rollout writer failed for /home/bun/.codex/sessions/2026/10/16/rollout-2026-10-16T10-04-31-01a1442b-9a43-78a0-813e-e59e01be915d.jsonl; buffered rollout items will be retried: No space left on device (os error 28); error_kind=StorageFull; raw_os_error=Some(28)";

  test("an infrastructure-failed pause carries the CLI's own words: one line, no log prefix or paths, at most 120 characters", () => {
    const line = pauseDetailLine(WRITER_FAILED)!;
    expect(line.startsWith("rollout writer failed for …; buffered rollout items will be retried: No space left on device (os error 28)")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith("…")).toBe(true);
    expect(pauseDetailLine("failed\n  to   initialize thread persistence")).toBe("failed to initialize thread persistence");
    // Credential shapes never reach the terminal, and nothing is no line.
    expect(pauseDetailLine("401 for Bearer abcdefghijklmnopqrstuvwxyz0123 and sk-proj-abcdefghijklmnop1234")).toBe("401 for [masked] and [masked]");
    expect(pauseDetailLine("  ")).toBeUndefined();
    expect(pauseDetailLine(undefined)).toBeUndefined();
  });

  test("the paused line appends it for an infrastructure-failed pause only, read off the run's meta.json", () => {
    const runsDir = tmp("wrathbench-fleet-status-runs-");
    const runDir = join(runsDir, listing("x").runId);
    mkdirSync(runDir);
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({ runId: "r", pause: { reason: "infrastructure-failed", detail: WRITER_FAILED, at: NOW, episodeElapsedMs: 1 } }));
    const [head, infra, quota] = formatPaused([listing("infrastructure-failed"), listing("quota-exhausted")], pauseDetailOf(runsDir));
    expect(head).toBe("paused runs not resumed (2):");
    expect(infra).toBe(
      "  fleet-codex-sol-61-freeplay-gpt-6-1-sol-20261011-a2 — gpt-6.1-sol on RUNNER3: infrastructure-failed, 94h00m elapsed — infrastructure-failed, pause 7: resuming after 13:00:00 — CLI: " +
        pauseDetailLine(WRITER_FAILED),
    );
    expect(quota).not.toContain("CLI:");
    // Without the lookup, the line is what it always was.
    expect(formatPaused([listing("infrastructure-failed")])[1]).not.toContain("CLI:");
  });

  test("a codex lane's line says how full its volume is; any other lane's says nothing more", () => {
    const h = home([]);
    expect(volumeUsage(h)).toMatch(/^\d+% of \d+\.\dG used$/);
    expect(volumeUsage(join(h, "missing"))).toBeUndefined();
    expect(codexLaneVolume("codex:CODEX_HOME", { CODEX_HOME: h })).toBe(volumeUsage(h));
    expect(codexLaneVolume("codex:CODEX_HOME_2", { CODEX_HOME: h })).toBeUndefined();
    expect(codexLaneVolume("claude-code:CLAUDE_CODE_OAUTH_TOKEN", { CODEX_HOME: h })).toBeUndefined();
    const gate = subscriptionGate([], { scored: 80, freeplay: 80 }, NOW);
    const lines = formatSubscriptionGate(gate, ["claude-code:CLAUDE_CODE_OAUTH_TOKEN", "codex:CODEX_HOME"], { volumeOf: (l) => codexLaneVolume(l, { CODEX_HOME: h }) });
    expect(lines.find((l) => l.includes("codex:CODEX_HOME"))).toBe(`  codex:CODEX_HOME: no observation — open; volume ${volumeUsage(h)}`);
    expect(lines.find((l) => l.includes("claude-code:"))).toBe("  claude-code:CLAUDE_CODE_OAUTH_TOKEN: no observation — open");
  });
});
