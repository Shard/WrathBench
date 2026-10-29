/**
 * `bun wb inspect live|run|trajectory` over runs written by the runner's own
 * Trajectory: the live rule (a pause is unterminated too, a cold heartbeat is
 * no owner), bounded output, and the session token struck everywhere it is
 * printed from, including the trajectory lines older runs carry it in.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig, MIN_TOKEN_LENGTH as RUNNER_MIN_TOKEN_LENGTH } from "../runner/src/config";
import { REDACTED as RUNNER_REDACTED } from "@wrathbench/mcp/redact";
import { RUN_DB_BUSY_TIMEOUT_MS as RUNNER_RUN_DB_BUSY_TIMEOUT_MS } from "../runner/src/rundb";
import { HEARTBEAT_DEAD_MS as RUNNER_HEARTBEAT_DEAD_MS, Trajectory } from "../runner/src/trajectory";
import { ARCHIVE_DIR as VIEWER_ARCHIVE_DIR } from "../runner/viewer/archive-dir";
import { clickhouseConfigFromEnv } from "../runner/viewer/clickhouse";
import { TURN_KINDS as COLLECTOR_TURN_KINDS, unparseableRow } from "../collector/src/lines";
import { questsAcrossRestarts } from "../runner/viewer/results";
import {
  ARCHIVE_DIR,
  DEFAULT_WIDTH,
  CLICKHOUSE_SETTINGS,
  clickhouseConfigOf,
  clickhouseStore,
  errorClass,
  extentSql,
  FIRST_PAGE_LINES,
  freshness,
  type InspectStore,
  rowsSql,
  STORE_BEHIND_MS,
  StoreError,
  TURN_KINDS,
  UNPARSEABLE,
  HEARTBEAT_DEAD_MS,
  main,
  MIN_TOKEN_LENGTH,
  offsetAfter,
  parseSince,
  questStretches,
  seekTime,
  REDACTED,
  RUN_DB_BUSY_TIMEOUT_MS,
  scanByRowid,
  verdictOf,
} from "./inspect-run";
import { memoryStore } from "./inspect-memory-store";
import { tempDirs } from "./temp-dirs";

const tmp = tempDirs();
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const TOKEN = "ab12".repeat(16);

type Shape = "live" | "ownerless" | "paused" | "terminated";

/** One run, written the way the runner writes it, plus the lines an older trajectory carried the token in. */
function makeRun(runsDir: string, runId: string, shape: Shape, opts: { token?: string } = {}): string {
  const dir = join(runsDir, runId);
  const t0 = NOW - 3_600_000;
  let clock = t0;
  const traj = new Trajectory(dir, { now: () => clock });
  const config = { ...loadRunConfig({ driver: "stub" }), runId, token: opts.token ?? TOKEN, runsDir, character: "Testwick", model: "test/model", account: "TESTACCT" };
  traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: t0, config });
  traj.setCharacter(runId, "Testwick");
  // What a pre-hardening writer left in the record: the token in a meta record.
  appendFileSync(join(dir, "trajectory.jsonl"), `${JSON.stringify({ ts: t0, t: "meta", runId, config: { token: opts.token ?? TOKEN } })}\n`);
  for (let i = 1; i <= 3; i++) {
    clock = t0 + i * 60_000;
    traj.recordState(runId, { level: i + 1, xp: i * 100, money: 12_345, questsCompleted: i, turn: i, zone: 12 });
    traj.append({ t: "tool_call", turn: i, call: i, name: "run_snippet", args: { code: `return ${i};` } });
    traj.append({ t: "snippet", turn: i, call: i, code: `return ${i};` });
    traj.append({ t: "snippet_result", turn: i, call: i, name: "run_snippet", isError: false, text: `ok (5ms)\n=> ${i}` });
  }
  clock = t0 + 5 * 60_000;
  traj.append({ t: "snippet", turn: 4, call: 4, code: "state.units({ guid: 1 })" });
  // An error whose text echoes a module reply that carried the token, as old runs did.
  appendFileSync(
    join(dir, "trajectory.jsonl"),
    `${JSON.stringify({ ts: clock, t: "snippet_result", turn: 4, call: 4, name: "run_snippet", isError: true, text: `error (12ms)\nTypeError: bad key for session ${opts.token ?? TOKEN}` })}\n`,
  );
  clock = t0 + 6 * 60_000;
  traj.append({ t: "snippet", turn: 5, call: 5, code: "await sleep(40000)" });
  traj.append({ t: "snippet_result", turn: 5, call: 5, name: "run_snippet", isError: true, text: "error (30000ms)\nsnippet evaluation exceeded 30000ms and was abandoned" });
  clock = t0 + 7 * 60_000;
  traj.append({ t: "tool_call", turn: 5, call: 6, name: "reflect", args: {} });
  traj.append({ t: "tool_result", turn: 5, call: 6, name: "reflect", isError: true, text: "Reflection needs rest or a flight" });
  traj.append({ t: "harness", kind: "sandbox_restarted", detail: "x".repeat(5_000) });
  // A huge record: never printed whole.
  clock = t0 + 8 * 60_000;
  traj.append({ t: "snippet", turn: 6, call: 7, code: `const big = "${"y".repeat(300_000)}";` });
  traj.append({ t: "snippet_result", turn: 6, call: 7, name: "run_snippet", isError: false, text: `ok (1ms)\n${"z".repeat(300_000)}` });
  traj.append({ t: "request", turn: 7, adapter: "stub", messages: "m".repeat(500_000) });
  if (shape === "paused") traj.setPause(runId, "operator-pause", "SIGTERM");
  if (shape === "terminated") traj.setTermination(runId, "episode-limit", "episode limit reached");
  traj.close();
  if (shape === "live" || shape === "ownerless") {
    const hb = join(dir, "heartbeat");
    writeFileSync(hb, "a-host 1\n");
    const at = (shape === "live" ? NOW - 5_000 : NOW - 10 * 60_000) / 1000;
    utimesSync(hb, at, at);
  }
  return dir;
}

function runs(): string {
  const runsDir = tmp("inspect-run-");
  makeRun(runsDir, "run-live", "live");
  makeRun(runsDir, "run-ownerless", "ownerless");
  makeRun(runsDir, "run-paused", "paused");
  makeRun(runsDir, "run-ended", "terminated");
  return runsDir;
}

/** The command over the files (no CLICKHOUSE_URL), or over `store` in its place. */
async function inspect(argv: string[], now = NOW, store?: InspectStore): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {}, (l) => out.push(l), (l) => err.push(l), now, store === undefined ? {} : { store });
  return { code, out, err };
}

const RUNS = runs();
/** What ClickHouse would hold of RUNS: the collector's own rows, in memory. */
const STORE = await memoryStore(RUNS);

describe("the constants it shares with the runner", () => {
  test("are the runner's own", async () => {
    expect(HEARTBEAT_DEAD_MS).toBe(RUNNER_HEARTBEAT_DEAD_MS);
    expect(MIN_TOKEN_LENGTH).toBe(RUNNER_MIN_TOKEN_LENGTH);
    expect(REDACTED).toBe(RUNNER_REDACTED);
    expect(ARCHIVE_DIR).toBe(VIEWER_ARCHIVE_DIR);
    expect(RUN_DB_BUSY_TIMEOUT_MS).toBe(RUNNER_RUN_DB_BUSY_TIMEOUT_MS);
  });

  test("the quest fold is the viewer's: the same total from the same counts", async () => {
    const cases: (number | null)[][] = [[0, 12, 60, 60, 0, 0, 1, 2], [0, 8, 0, 3, 8, 0, 2, 0], [3, null, 5], [0, 0], [null], []];
    for (const q of cases) {
      const total = questStretches(q.map((quests, ts) => ({ ts, quests })))?.total ?? null;
      expect(total).toBe(questsAcrossRestarts(q.map((questsCompleted) => ({ questsCompleted }))));
    }
  });

  test("the file imports bun:sqlite and node:* only, so it runs from stdin in any runner image", async () => {
    const src = readFileSync(join(import.meta.dir, "inspect-run.ts"), "utf8");
    const specs = [...src.matchAll(/^import[^"]*"([^"]+)"/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s === "bun:sqlite" || s!.startsWith("node:")).toBe(true);
  });
});

describe("the live rule", () => {
  test("live is no termination, no pause and a fresh heartbeat", async () => {
    const row = { termination_reason: null, termination_detail: null, pause_reason: null };
    expect(verdictOf(row, NOW - 5_000, NOW).state).toBe("live");
    expect(verdictOf(row, NOW - HEARTBEAT_DEAD_MS - 1, NOW).state).toBe("ownerless");
    expect(verdictOf(row, null, NOW).state).toBe("ownerless");
  });

  test("a pause is not live, whatever the heartbeat says", async () => {
    const row = { termination_reason: null, termination_detail: null, pause_reason: "operator-pause" };
    expect(verdictOf(row, NOW - 1_000, NOW)).toMatchObject({ state: "paused", reason: "operator-pause" });
  });

  test("inspect run says which, and why", async () => {
    const line = async (id: string, store?: InspectStore): Promise<string> => (await inspect(["run", id, "--runs-dir", RUNS], NOW, store)).out.find((l) => l.startsWith("verdict"))!;
    expect(await line("run-live", STORE)).toContain("live: no termination, no pause; heartbeat 5s ago");
    for (const store of [STORE, undefined]) {
      expect(await line("run-ownerless", store)).toContain("ownerless");
      expect(await line("run-paused", store)).toContain("paused: operator-pause");
      expect(await line("run-ended", store)).toContain("terminated: episode-limit — episode limit reached");
    }
  });

  test("without ClickHouse a live run's row and samples are not read, and it says so", async () => {
    for (const r of [await inspect(["run", "run-live", "--runs-dir", RUNS]), await inspect(["run", "run-live", "--runs-dir", RUNS, "--files"], NOW, STORE)]) {
      const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
      expect(r.code).toBe(0);
      expect(at("verdict")).toContain("unread: heartbeat 5s ago, so its process is up");
      expect(at("level")).toContain("not read: heartbeat 5s ago, so the run may be live");
      expect(at("quests")).toBe("");
      // The trajectory takes no lock, so it is still read; the character comes from meta.json.
      expect(at("activity")).toContain("6 snippets");
      expect(at("character")).toContain("Testwick on TESTACCT");
      expect(at("trace")).toContain("no rows");
    }
    expect((await inspect(["run", "run-live", "--runs-dir", RUNS])).out.find((l) => l.startsWith("source"))).toBe("source     the files: ClickHouse not configured (no CLICKHOUSE_URL)");
    expect((await inspect(["run", "run-live", "--runs-dir", RUNS, "--files"], NOW, STORE)).out.find((l) => l.startsWith("source"))).toBe("source     the files: --files");
  });

  test("an empty-string reason is no reason, as readVerdict reads it", async () => {
    const runsDir = tmp("inspect-run-empty-");
    const dir = makeRun(runsDir, "run-empty", "live");
    const db = new Database(join(dir, "run.sqlite"));
    db.run("UPDATE run SET pause_reason = '', termination_reason = ''");
    db.close();
    expect((await inspect(["run", "run-empty", "--runs-dir", runsDir], NOW, await memoryStore(runsDir))).out.find((l) => l.startsWith("verdict"))).toContain("live:");
  });

  test("inspect live lists the runs with a heartbeat, and only those", async () => {
    const r = await inspect(["live", "--runs-dir", RUNS], NOW, STORE);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("1 run(s) with a live owner, 1 with a cold heartbeat");
    expect(r.out.some((l) => l.includes("run-live") && l.includes(" live ") && l.includes("L4 300xp"))).toBe(true);
    expect(r.out.some((l) => l.includes("run-ownerless") && l.includes("ownerless"))).toBe(true);
    expect(r.out.some((l) => l.includes("run-paused") || l.includes("run-ended"))).toBe(false);
    expect(r.out.at(-1)).toBe("source    ClickHouse for the rows and the newest samples; the heartbeats from the files");
    // Without ClickHouse the cold one's row is read from its file; the live one's is not read at all.
    const files = await inspect(["live", "--runs-dir", RUNS]);
    expect(files.out.some((l) => l.includes("run-live") && l.includes(" unread ") && l.includes("L?"))).toBe(true);
    expect(files.out.some((l) => l.includes("run-ownerless") && l.includes("ownerless") && l.includes("L4 300xp"))).toBe(true);
  });
});

describe("inspect run", () => {
  test("waits out a live run's write lock instead of crashing on SQLITE_BUSY", async () => {
    const runsDir = tmp("inspect-run-busy-");
    const dir = makeRun(runsDir, "run-busy", "live");
    // Another process holds the write lock for a moment, the way the live runner does mid-write.
    const holder = Bun.spawn(
      ["bun", "-e", 'const { Database } = require("bun:sqlite"); const db = new Database(process.argv[1]); db.exec("BEGIN EXCLUSIVE"); console.log("locked"); Bun.sleepSync(800); db.exec("COMMIT"); db.close();', join(dir, "run.sqlite")],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    const r = await inspect(["run", "run-busy", "--runs-dir", runsDir]);
    expect(await holder.exited).toBe(0);
    expect(r.err.join("\n")).not.toContain("SQLITE_BUSY");
    expect(r.code).toBe(0);
    expect(r.out.find((l) => l.startsWith("trace"))).toContain("no rows");
  });

  test("reads the level, the counts by kind and the errors by class", async () => {
    const r = await inspect(["run", "run-live", "--runs-dir", RUNS], NOW, STORE);
    expect(r.code).toBe(0);
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("source")).toBe("source     ClickHouse through 2030-01-02T11:08:00Z, current with the file");
    expect(at("level")).toContain("L4 300xp");
    expect(at("level")).toContain("money 1g 23s 45c");
    expect(at("quests")).toBe("quests     3 over the run");
    expect(at("character")).toContain("Testwick on TESTACCT");
    expect(at("activity")).toContain("6 snippets");
    expect(at("errors")).toContain("snippets 2/6: ");
    expect(at("errors")).toContain("TypeError 1");
    expect(at("errors")).toContain("timeout 1");
    expect(at("errors")).toContain("tools 1/1: reflect 1");
    expect(at("harness")).toContain("sandbox_restarted 1");
    expect(at("files")).toContain("trajectory.jsonl");
    expect(at("trace")).toContain("no rows");
    expect(at("nearby")).toContain("none");
    // A run with no live owner reads the same off its own files.
    const ended = await inspect(["run", "run-ended", "--runs-dir", RUNS]);
    expect(ended.out.find((l) => l.startsWith("level"))).toContain("L4 300xp");
    expect(ended.out.find((l) => l.startsWith("quests"))).toBe("quests     3 over the run");
  });

  test("the quest count is the run's across a resume, each process's stretch beside it", async () => {
    const runsDir = tmp("inspect-run-quests-");
    // Counted 1, 2, 3 from 11:01; resumed at 11:31 by a process whose count starts again at zero.
    const dir = makeRun(runsDir, "run-resumed", "live");
    let clock = NOW - 30 * 60_000;
    const traj = new Trajectory(dir, { now: () => clock });
    for (const q of [0, 4]) {
      clock += 60_000;
      traj.recordState("run-resumed", { level: 4, xp: 400, questsCompleted: q });
    }
    traj.close();
    const r = await inspect(["run", "run-resumed", "--runs-dir", runsDir], NOW, await memoryStore(runsDir));
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("quests")).toBe("quests     7 over the run, summed across 1 restart(s); the newest sample reads 4 · from 01-02 11:01 3 · from 01-02 11:31 4");
    // The newest sample's own count is not the level line's to state.
    expect(at("level")).not.toContain("quests");
  });

  test("--since counts only what came after", async () => {
    const r = await inspect(["run", "run-live", "--runs-dir", RUNS, "--since", String(NOW - 3_600_000 + 5.5 * 60_000)]);
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("activity")).toContain("since ");
    expect(at("errors")).toContain("snippets 1/2: timeout 1");
  });

  test("prints a bounded block, never the config or the token", async () => {
    const r = await inspect(["run", "run-live", "--runs-dir", RUNS]);
    expect(r.out.length).toBeLessThanOrEqual(16);
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
    const all = r.out.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('"token"');
  });

  test("finds an archived run, and says so", async () => {
    const runsDir = tmp("inspect-run-archive-");
    mkdirSync(join(runsDir, ARCHIVE_DIR), { recursive: true });
    makeRun(join(runsDir, ARCHIVE_DIR), "run-old", "terminated");
    expect((await inspect(["run", "run-old", "--runs-dir", runsDir])).out[0]).toContain("run-old (archived)");
  });

  test("refuses an id that would leave the runs directory", async () => {
    expect((await inspect(["run", "../etc", "--runs-dir", RUNS])).code).toBe(2);
    expect((await inspect(["run", "nope", "--runs-dir", RUNS])).code).toBe(1);
  });
});

describe("inspect trajectory", () => {
  test("one line per snippet with its result, the newest last, every line capped", async () => {
    const r = await inspect(["trajectory", "run-live", "--runs-dir", RUNS]);
    expect(r.code).toBe(0);
    const body = r.out.slice(1, -1);
    expect(body.filter((l) => l.includes(" snippet ")).length).toBe(6);
    expect(body.some((l) => l.includes("reflect ✗"))).toBe(true);
    expect(body.some((l) => l.includes("harness"))).toBe(true);
    expect(body.at(-1)).toContain("snippet ✓");
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
    expect(r.out.join("\n").length).toBeLessThan(20 * DEFAULT_WIDTH);
  });

  test("--errors keeps the failures, --last the newest few", async () => {
    const errors = (await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--errors"])).out.slice(1, -1);
    expect(errors.length).toBe(3);
    for (const l of errors) expect(l).toContain("✗");
    const last = (await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--last", "2"])).out.slice(1, -1);
    expect(last.length).toBe(2);
  });

  test("--all is every record kind, the big ones by size alone", async () => {
    const r = await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--all", "--last", "200"]);
    expect(r.out.some((l) => /request {2}\(\d+\.\d KB\)/.test(l))).toBe(true);
    expect(r.out.some((l) => /snippet_result {2}\(\d+\.\d KB\)/.test(l))).toBe(true);
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
  });

  test("the token is struck from every view, a cut one included", async () => {
    for (const extra of [[], ["--errors"], ["--all", "--last", "500"], ["--grep", "TypeError"], ["--grep", "session", "--all"]]) {
      const all = (await inspect(["trajectory", "run-live", "--runs-dir", RUNS, ...extra])).out.join("\n");
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(TOKEN.slice(0, MIN_TOKEN_LENGTH));
    }
    expect((await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--grep", "bad key"])).out.join("\n")).toContain(REDACTED);
  });

  test("a token that is the run id, or too short to be one, is not struck", async () => {
    const runsDir = tmp("inspect-run-oldtoken-");
    makeRun(runsDir, "run-legacy", "terminated", { token: "run-legacy" });
    const all = (await inspect(["trajectory", "run-legacy", "--runs-dir", runsDir])).out.join("\n");
    expect(all).toContain("run-legacy");
    expect(all).not.toContain(REDACTED);
  });

  test("--grep with --all filters meta records too, so they never spend --last", async () => {
    const runsDir = tmp("inspect-run-meta-grep-");
    const dir = join(runsDir, "run-resumed");
    mkdirSync(dir, { recursive: true });
    const t0 = NOW - 3_600_000;
    const rec = (i: number, r: Record<string, unknown>): string => `${JSON.stringify({ ts: t0 + i * 60_000, ...r })}\n`;
    let body = "";
    for (let i = 1; i <= 3; i++) body += rec(i, { t: "snippet_result", turn: i, call: i, name: "run_snippet", isError: true, text: `error (5ms)\nNeedleError: miss ${i}` });
    // Every resume writes a meta record, newer than the matches.
    for (let i = 4; i <= 8; i++) body += rec(i, { t: "meta", runId: "run-resumed", harnessVersion: "harness-test" });
    writeFileSync(join(dir, "trajectory.jsonl"), body);
    const r = await inspect(["trajectory", "run-resumed", "--runs-dir", runsDir, "--all", "--grep", "NeedleError", "--last", "2"]);
    expect(r.code).toBe(0);
    const lines = r.out.slice(1, -1);
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes(" meta "))).toBe(false);
    expect(lines[0]).toContain("miss 2");
    expect(lines[1]).toContain("miss 3");
    // A grep a meta record matches still shows it.
    expect((await inspect(["trajectory", "run-resumed", "--runs-dir", runsDir, "--all", "--grep", "harness-test", "--last", "2"])).out.slice(1, -1).every((l) => l.includes(" meta "))).toBe(true);
  });

  test("--since stops reading at the first older record", async () => {
    const r = await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--since", String(NOW - 3_600_000 + 5.5 * 60_000)]);
    const body = r.out.slice(1, -1);
    expect(body.some((l) => l.includes("timeout") || l.includes("exceeded"))).toBe(true);
    expect(body.some((l) => l.includes("return 1;"))).toBe(false);
  });
});

describe("inspect trajectory: a window, and either end of it", () => {
  const at = (min: number): string => String(NOW - 3_600_000 + min * 60_000);
  const body = async (argv: string[]): Promise<string[]> => (await inspect(["trajectory", "run-live", "--runs-dir", RUNS, ...argv])).out.slice(1, -1);

  test("--until leaves out everything after it", async () => {
    const r = await body(["--until", at(5.5)]);
    expect(r.some((l) => l.includes("return 1;"))).toBe(true);
    expect(r.some((l) => l.includes("TypeError"))).toBe(true);
    expect(r.some((l) => l.includes("exceeded") || l.includes("reflect"))).toBe(false);
    expect((await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--until", at(5.5)])).out[0]).toContain("until 2030-01-02T11:05:30Z");
  });

  test("--since and --until together are a range", async () => {
    const r = await body(["--since", at(2.5), "--until", at(5.5)]);
    expect(r.map((l) => /return \d;|TypeError/.exec(l)?.[0])).toEqual(["return 3;", "TypeError"]);
  });

  test("--next is the first N from --since, or from the file's start", async () => {
    const r = await body(["--since", at(1.5), "--next", "2"]);
    expect(r.length).toBe(2);
    expect(r[0]).toContain("return 2;");
    expect(r[1]).toContain("return 3;");
    expect((await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--next", "2"])).out[0]).toContain("the first 2 item(s)");
    expect((await body(["--next", "1"]))[0]).toContain("return 1;");
    // Read forward, a tool call meets its result after it.
    expect((await body(["--since", at(6.9), "--until", at(7), "--next", "5"]))[0]).toContain("reflect ✗  {}  ⇒ Reflection needs rest");
  });

  test("inspect run takes the same window", async () => {
    const r = await inspect(["run", "run-live", "--runs-dir", RUNS, "--until", at(5.5)]);
    const line = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(line("activity")).toContain("until 2030-01-02T11:05:30Z: ");
    expect(line("errors")).toContain("snippets 1/4: TypeError 1");
  });

  test("a bad window is a usage error, said with the flag that was wrong", async () => {
    const bad = await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--until", "yesterday"]);
    expect(bad.code).toBe(2);
    expect(bad.err[0]).toContain("--until yesterday");
    expect((await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--since", at(5), "--until", at(4)])).code).toBe(2);
    expect((await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--last", "2", "--next", "2"])).code).toBe(2);
    expect((await inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--next", "0"])).code).toBe(2);
  });

  test("a big file is bisected to the window, and every view still reads the same lines", async () => {
    const runsDir = tmp("inspect-run-seek-");
    const dir = join(runsDir, "run-big");
    mkdirSync(dir, { recursive: true });
    const t0 = NOW - 86_400_000;
    const lines: string[] = [];
    for (let i = 0; i < 6_000; i++) {
      lines.push(JSON.stringify({ ts: t0 + i * 1_000, t: "snippet", turn: i, call: i, code: `return ${i}; // ${"p".repeat(i % 7 === 0 ? 2_000 : 150)}` }));
      lines.push(JSON.stringify({ ts: t0 + i * 1_000, t: "snippet_result", turn: i, call: i, name: "run_snippet", isError: false, text: `ok (1ms)\n=> ${i}` }));
    }
    const path = join(dir, "trajectory.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`);
    const starts: number[] = [];
    let off = 0;
    for (const l of lines) {
      starts.push(off);
      off += Buffer.byteLength(l) + 1;
    }
    expect(off).toBeGreaterThan(2 << 20);
    for (const i of [0, 1, 2_500, 4_242, 5_999]) {
      const t = t0 + i * 1_000;
      const first = starts[2 * i]!;
      const s = seekTime(path, t);
      expect(s).toBeLessThanOrEqual(first);
      expect(first - s).toBeLessThan(512 << 10);
      expect(starts.includes(s)).toBe(true);
      expect(offsetAfter(path, t)).toBe(starts[2 * i + 2] ?? off);
    }
    expect(offsetAfter(path, t0 + 10_000_000)).toBe(off);
    const view = async (argv: string[]): Promise<string[]> => (await inspect(["trajectory", "run-big", "--runs-dir", runsDir, ...argv])).out.slice(1, -1);
    expect((await view(["--until", String(t0 + 4_242_000), "--last", "2"])).map((l) => /return (\d+);/.exec(l)?.[1])).toEqual(["4241", "4242"]);
    expect((await view(["--since", String(t0 + 2_500_000), "--next", "2"])).map((l) => /return (\d+);/.exec(l)?.[1])).toEqual(["2500", "2501"]);
  });
});

describe("parsing", () => {
  test("an error's class is its name, timeout for the ceiling, else its first words", async () => {
    expect(errorClass("error (10012ms)\nEventTimeoutError: timed out after 10000ms")).toBe("EventTimeoutError");
    expect(errorClass("error (1ms)\nTypeError: undefined is not an object")).toBe("TypeError");
    expect(errorClass("error (30000ms)\nsnippet evaluation exceeded 30000ms")).toBe("timeout");
    expect(errorClass("error (3ms)\nError: scratchpad.write refused")).toBe("Error");
    expect(errorClass("something odd happened here")).toBe("something odd happened");
  });

  test("--since takes a duration back from now, epoch ms or ISO", async () => {
    expect(parseSince("30m", NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince("2h", NOW)).toBe(NOW - 7_200_000);
    expect(parseSince(String(NOW - 5), NOW)).toBe(NOW - 5);
    expect(parseSince("2030-01-02T11:00:00Z", NOW)).toBe(NOW - 3_600_000);
    expect(() => parseSince("yesterday", NOW)).toThrow();
  });

  test("a bad flag or a missing id is a usage error", async () => {
    expect((await inspect(["run"])).code).toBe(2);
    expect((await inspect(["trajectory", "run-live", "--last", "0", "--runs-dir", RUNS])).code).toBe(2);
    expect((await inspect(["trajectory", "run-live", "--nope"])).code).toBe(2);
    expect((await inspect([])).code).toBe(2);
  });
});

describe("a whole-table read of a run walks it in rowid windows, one statement each", () => {
  test("every row comes back, in rowid order, and no statement covers more than a window", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE trace (run_id TEXT, ts INTEGER, kind TEXT)");
    const ins = db.query("INSERT INTO trace (run_id, ts, kind) VALUES ('r', ?, ?)");
    for (let i = 1; i <= 25; i++) ins.run(i, i % 3 === 0 ? "state" : "pos");
    const spans: number[] = [];
    const q = db.query("SELECT ts FROM trace WHERE rowid > ? AND rowid <= ?");
    const rows = scanByRowid(db, "trace", (lo, hi) => {
      spans.push(hi - lo);
      return q.all(lo, hi) as { ts: number }[];
    }, 10);
    expect(rows.map((r) => r.ts)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(spans).toEqual([10, 10, 5]);
    db.exec("DELETE FROM trace");
    expect(scanByRowid(db, "trace", () => [1], 10)).toEqual([]);
    db.close();
  });
});

describe("ClickHouse and the files give the same views", () => {
  /** A view without its source line, the one line that says where it read. */
  const view = async (id: string, argv: string[], store?: InspectStore): Promise<string[]> =>
    (await inspect([argv[0]!, id, ...argv.slice(1), "--runs-dir", RUNS], NOW, store)).out.filter((l) => !l.startsWith("source"));
  const at = (min: number): string => String(NOW - 3_600_000 + min * 60_000);
  const trajectoryViews = [
    ["trajectory"],
    ["trajectory", "--errors"],
    ["trajectory", "--last", "3"],
    ["trajectory", "--all", "--last", "200"],
    ["trajectory", "--grep", "TypeError|return 2"],
    ["trajectory", "--all", "--grep", "session"],
    ["trajectory", "--since", at(2.5), "--until", at(5.5)],
    ["trajectory", "--since", at(1.5), "--next", "2"],
    ["trajectory", "--next", "1"],
    ["trajectory", "--errors", "--next", "5"],
    ["tools"],
    ["tools", "--since", at(5)],
    ["pad"],
  ];
  const runViews = [["run"], ["run", "--since", at(5.5)], ["run", "--until", at(5.5)]];
  for (const id of ["run-live", "run-ownerless", "run-paused", "run-ended"]) {
    // A live run's row is read only from ClickHouse, so `run` is compared where the files may answer it too.
    for (const argv of id === "run-live" ? trajectoryViews : [...trajectoryViews, ...runViews]) {
      test(`${id}: ${argv.join(" ")}`, async () => {
        const files = await view(id, argv);
        expect(files.length).toBeGreaterThan(0);
        expect(await view(id, argv, STORE)).toEqual(files);
      });
    }
  }
});

describe("reading ClickHouse", () => {
  test("--last reads one small page of a big run, not the run", async () => {
    const runsDir = tmp("inspect-run-pages-");
    const dir = join(runsDir, "run-pages");
    mkdirSync(dir, { recursive: true });
    const t0 = NOW - 86_400_000;
    const lines: string[] = [];
    for (let i = 0; i < 6_000; i++) {
      lines.push(JSON.stringify({ ts: t0 + i * 1_000, t: "snippet", turn: i, call: i, code: `return ${i};` }));
      lines.push(JSON.stringify({ ts: t0 + i * 1_000, t: "snippet_result", turn: i, call: i, name: "run_snippet", isError: i % 1000 === 7, text: `ok (1ms)\n=> ${i}` }));
    }
    writeFileSync(join(dir, "trajectory.jsonl"), `${lines.join("\n")}\n`);
    const store = await memoryStore(runsDir);
    const r = await inspect(["trajectory", "run-pages", "--runs-dir", runsDir, "--last", "2"], NOW, store);
    expect(r.out.slice(1, -1).map((l) => /return (\d+);/.exec(l)?.[1])).toEqual(["5998", "5999"]);
    expect(store.pages).toEqual([[12_000 - FIRST_PAGE_LINES, 12_000]]);
    // A sparse --errors pages back with growing pages until it has its items, and reads no further.
    store.pages.length = 0;
    const errors = await inspect(["trajectory", "run-pages", "--runs-dir", runsDir, "--errors", "--last", "2"], NOW, store);
    expect(errors.out.slice(1, -1).map((l) => /return (\d+);/.exec(l)?.[1])).toEqual(["4007", "5007"]);
    expect(store.pages.map(([a, b]) => b - a)).toEqual([1_000, 2_000, 4_000]);
  });

  test("the source line says how far behind the file ClickHouse is, and when that means the collector is not keeping up", async () => {
    const newest = NOW - 3_600_000 + 8 * 60_000;
    expect(freshness(newest, newest)).toBe("ClickHouse through 2030-01-02T11:08:00Z, current with the file");
    expect(freshness(newest - 8_000, newest)).toBe("ClickHouse through 2030-01-02T11:07:52Z, 8s behind the file");
    expect(freshness(newest - STORE_BEHIND_MS - 60_000, newest)).toContain("3m behind the file: the collector is behind or down");
    expect(freshness(null, newest)).toBe("ClickHouse, which holds no trajectory record of this run yet");
    const behind: InspectStore = { ...STORE, extent: async (id, w) => ({ ...(await STORE.extent(id, w)), newestTs: newest - 14 * 60_000 }) };
    const r = await inspect(["trajectory", "run-ended", "--runs-dir", RUNS], NOW, behind);
    expect(r.out.at(-1)).toBe(
      "source    ClickHouse through 2030-01-02T10:54:00Z, 14m behind the file: the collector is behind or down, and the newest records are missing here (--files reads the file)",
    );
  });

  test("a run ClickHouse does not hold yet is read from its files, and says so", async () => {
    const runsDir = tmp("inspect-run-new-");
    makeRun(runsDir, "run-new", "terminated");
    const r = await inspect(["run", "run-new", "--runs-dir", runsDir], NOW, STORE);
    expect(r.out.find((l) => l.startsWith("source"))).toBe("source     the files: the run is not in ClickHouse yet");
    expect(r.out.find((l) => l.startsWith("level"))).toContain("L4 300xp");
  });

  test("ClickHouse unreachable is a labelled fallback; one that fails mid-read is an error that names no URL", async () => {
    const down: InspectStore = {
      ...STORE,
      runs: async () => {
        throw new StoreError("ConnectionRefused");
      },
    };
    const r = await inspect(["trajectory", "run-ended", "--runs-dir", RUNS], NOW, down);
    expect(r.out.at(-1)).toBe("source    the files: ClickHouse unreachable (ConnectionRefused)");
    expect(r.out.slice(0, -1)).toEqual((await inspect(["trajectory", "run-ended", "--runs-dir", RUNS])).out.slice(0, -1));
    const midway: InspectStore = {
      ...STORE,
      rows: async () => {
        throw new StoreError("HTTP 500: Code: 241. DB::Exception: memory limit exceeded");
      },
    };
    const m = await inspect(["trajectory", "run-ended", "--runs-dir", RUNS], NOW, midway);
    expect(m.code).toBe(1);
    expect(m.err.join("\n")).toBe("ClickHouse failed mid-read (HTTP 500: Code: 241. DB::Exception: memory limit exceeded); --files reads the files");
    // A real refused connection, through a URL that carries a password: the reason is named, the URL never printed.
    const env = { CLICKHOUSE_URL: "http://inspect:hunter2-not-a-secret@127.0.0.1:1" };
    const out: string[] = [];
    const err: string[] = [];
    expect(await main(["trajectory", "run-ended", "--runs-dir", RUNS], env, (l) => out.push(l), (l) => err.push(l), NOW)).toBe(0);
    expect(out.at(-1)).toMatch(/^source {4}the files: ClickHouse unreachable \(\w+\)$/);
    expect([...out, ...err].join("\n")).not.toContain("hunter2");
  });

  test("every query is read-only, named in query_log, bounded in time, and sends the password in a header", async () => {
    const seen: { url: URL; init: RequestInit }[] = [];
    const store = clickhouseStore({ url: "http://ch:8123", user: "wb", password: "pw", database: "wrathbench" }, async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: [{ ts: 5, quests: 2 }] }));
    });
    expect(await store.quests("run-x")).toEqual([{ ts: 5, quests: 2 }]);
    const { url, init } = seen[0]!;
    expect(url.searchParams.get("readonly")).toBe("2");
    expect(url.searchParams.get("log_comment")).toBe("wb inspect");
    expect(url.searchParams.get("max_execution_time")).toBe(CLICKHOUSE_SETTINGS["max_execution_time"]!);
    expect(url.searchParams.get("database")).toBe("wrathbench");
    expect(url.search).not.toContain("pw");
    expect((init.headers as Record<string, string>)["x-clickhouse-key"]).toBe("pw");
    expect(String(init.body)).toContain("FROM states FINAL WHERE run_id = 'run-x'");
  });

  test("the SQL reads a run by its key and a range of lines, and the extent never touches a line's text", () => {
    const sql = rowsSql("run-x", { kinds: { snippet: { row: { contains: "scratchpad" }, raw: "all" } } }, { since: 1000.5, until: null }, 2_000, 3_000);
    expect(sql).toContain("run_id = 'run-x' AND line_no >= 2000 AND line_no < 3000 AND ts >= 1001");
    expect(sql).toContain("position(raw, 'scratchpad') > 0");
    // Only `turns` holds a snippet, so `events` is not read at all.
    expect(sql).not.toContain("FROM events");
    expect(rowsSql("run-x", { kinds: "all" }, { since: null, until: null }, 0, 10)).toContain("FROM events");
    const ext = extentSql("run-x", { since: null, until: 5 });
    expect(ext).not.toContain("raw");
    expect(ext).toContain("(any(ts) <= 5) AS w");
  });
});

describe("what it shares with the viewer and the collector", () => {
  test("the same ClickHouse coordinates from the same environment as the viewer", () => {
    const envs: Record<string, string>[] = [
      {},
      { CLICKHOUSE_URL: "" },
      { CLICKHOUSE_URL: "http://ch:8123/" },
      { CLICKHOUSE_URL: "http://ch:8123", CLICKHOUSE_USER: "u", CLICKHOUSE_PASSWORD: "p", CLICKHOUSE_DATABASE: "d" },
    ];
    for (const env of envs) expect(clickhouseConfigOf(env)).toEqual(clickhouseConfigFromEnv(env));
  });

  test("the collector's table split and its name for a line that is not a record", () => {
    expect([...TURN_KINDS].sort()).toEqual([...COLLECTOR_TURN_KINDS].sort());
    expect(unparseableRow({ runId: "r", lineNo: 0, ingestedAt: 0 }, "x")["kind"]).toBe(UNPARSEABLE);
  });
});
