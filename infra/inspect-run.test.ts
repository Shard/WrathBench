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
import { loadRunConfig } from "../runner/src/config";
import { MIN_TOKEN_LENGTH as RUNNER_MIN_TOKEN_LENGTH } from "../runner/src/session-token";
import { REDACTED as RUNNER_REDACTED } from "@wrathbench/mcp/redact";
import { SessionWriter } from "@wrathbench/mcp/record";
import { RUN_DB_BUSY_TIMEOUT_MS as RUNNER_RUN_DB_BUSY_TIMEOUT_MS } from "../runner/src/rundb";
import { Trajectory } from "../runner/src/trajectory";
import { HEARTBEAT_DEAD_MS as RUNNER_HEARTBEAT_DEAD_MS } from "../runner/src/heartbeat";
import { ARCHIVE_DIR as VIEWER_ARCHIVE_DIR } from "../runner/src/archive-dir";
import { clickhouseConfigFromEnv } from "../viewer/clickhouse";
import { TURN_KINDS as COLLECTOR_TURN_KINDS, unparseableRow } from "../collector/src/lines";
import { questsAcrossRestarts } from "../viewer/results";
import {
  ARCHIVE_DIR,
  DEFAULT_WIDTH,
  CLICKHOUSE_SETTINGS,
  clickhouseConfigOf,
  clickhouseStore,
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
  questStretches,
  seekTime,
  REDACTED,
  RUN_DB_BUSY_TIMEOUT_MS,
  scanByRowid,
  verdictOf,
} from "./inspect-run";
import { memoryStore } from "./inspect-memory-store";
import { tempDirs } from "./temp-dirs";
import { writeLegacy05Run, type Legacy05State } from "../runner/test/fixtures/legacy05-writer";
import { readRunRow } from "../runner/src/run-reader";
import { FANOUT_ROSTER_TOKEN, FANOUT_RUN, writeFanoutRun } from "../runner/test/fixtures/fanout";

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
  // A 0.5 run's state rows, laid down after its row (below).
  const states: Legacy05State[] = [];
  for (let i = 1; i <= 3; i++) {
    clock = t0 + i * 60_000;
    states.push({ ts: clock, level: i + 1, xp: i * 100, money: 12_345, questsCompleted: i, turn: i, zone: 12 });
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
  // The OpenAI-compatible adapter's retries, as `driver-adapters.ts` records them.
  traj.append({ t: "harness", kind: "adapter_retry", attempt: 2, of: 10, waitMs: 5_100, cause: "http", status: 429, detail: "HTTP 429: slow down" });
  traj.append({ t: "harness", kind: "adapter_retry", attempt: 3, of: 10, waitMs: 1_900, cause: "stream_cut", detail: "body read failed: the stream ended before the model finished" });
  // A huge record: never printed whole.
  clock = t0 + 8 * 60_000;
  traj.append({ t: "snippet", turn: 6, call: 7, code: `const big = "${"y".repeat(300_000)}";` });
  traj.append({ t: "snippet_result", turn: 6, call: 7, name: "run_snippet", isError: false, text: `ok (1ms)\n${"z".repeat(300_000)}` });
  traj.append({ t: "request", turn: 7, adapter: "stub", messages: "m".repeat(500_000) });
  if (shape === "paused") traj.setPause(runId, "operator-pause", "SIGTERM");
  if (shape === "terminated") traj.setTermination(runId, "episode-limit", "episode limit reached");
  traj.close();
  // These are 0.5 runs: the row and the samples are run.sqlite's (a v1 run's are below).
  writeLegacy05Run(dir, readRunRow(dir, runId)!, states);
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
  test("live is no termination, no pause and a fresh heartbeat; a pause is not live, whatever the heartbeat says", async () => {
    const row = { termination_reason: null, termination_detail: null, pause_reason: null };
    expect(verdictOf(row, NOW - 5_000, NOW).state).toBe("live");
    expect(verdictOf(row, NOW - HEARTBEAT_DEAD_MS - 1, NOW).state).toBe("ownerless");
    expect(verdictOf(row, null, NOW).state).toBe("ownerless");
    expect(verdictOf({ ...row, pause_reason: "operator-pause" }, NOW - 1_000, NOW)).toMatchObject({ state: "paused", reason: "operator-pause" });
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
      expect(at("trace")).toContain("none (no session record");
    }
    expect((await inspect(["run", "run-live", "--runs-dir", RUNS])).out.find((l) => l.startsWith("source"))).toBe("source     the files: ClickHouse not configured (no CLICKHOUSE_URL)");
    expect((await inspect(["run", "run-live", "--runs-dir", RUNS, "--files"], NOW, STORE)).out.find((l) => l.startsWith("source"))).toBe("source     the files: --files");
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

  test("a v1 run's session record is one line: who it is, whether it closed, and its streams; the ring is read from it", async () => {
    const runsDir = tmp("inspect-v1-");
    const dir = makeRun(runsDir, "run-v1", "terminated");
    let clock = NOW - 600_000;
    const writer = new SessionWriter({ dir: join(dir, "session"), id: "0123456789abcdef", stack: { version: "test" }, now: () => clock, log: () => {} });
    writer.open();
    const state = { hp: 1, hpMax: 1, pw: null, pwMax: null, pwType: null, level: 4, xp: 1, xpMax: 2, auras: [], combat: false, mounted: false, taxi: false, dead: false, ghost: false, resting: false, zone: null, area: null, target: null, cast: null };
    const sheet = { money: null, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null };
    writer.ingest({
      trace: { rows: [{ ts: clock, kind: "key", map: 0, x: 1, y: 2, z: 3, o: 0, data: { ...state, ...sheet } }], dropped: 0 },
      events: { rows: [], dropped: 0 },
      nearby: { rows: [{ ts: clock, kind: "key", self: { guid: "5", map: 0, target: null, down: false }, units: [] }], dropped: 0, through: clock },
      moves: [],
      character: { guid: "5", name: "Testwick", race: 1, class: 1 },
      stream: { connected: true, events: 1, seq: 1 },
    });
    const live = await inspect(["run", "run-v1", "--runs-dir", runsDir], NOW);
    const at = (r: { out: string[] }, label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at(live, "session")).toContain("wrath-session/1 (Testwick), open");
    // Never the session id: it is the token's fingerprint and the audit file's name.
    expect(live.out.some((l) => l.includes("0123456789abcdef"))).toBe(false);
    expect(at(live, "session")).toContain("trace 1 segment(s)");
    expect(at(live, "session")).toContain("events none");
    expect(at(live, "nearby")).toContain("1 window file(s)");
    expect(live.out.some((l) => l.startsWith("trace"))).toBe(false);
    clock = NOW - 60_000;
    await writer.close();
    const closed = await inspect(["run", "run-v1", "--runs-dir", runsDir], NOW);
    expect(at(closed, "session")).toContain("closed 60s ago");
    expect(at(closed, "nearby")).toContain("none");
    expect(closed.out.some((l) => l.includes("0123456789abcdef"))).toBe(false);
  });

  test("a v1 run with no run.sqlite reads its row off meta.json and its level and quests off its record, live owner or not", async () => {
    const runsDir = tmp("inspect-v1-files-");
    const dir = join(runsDir, "run-v1f");
    const t0 = NOW - 600_000;
    const traj = new Trajectory(dir, { now: () => t0 });
    traj.writeMeta({ runId: "run-v1f", harnessVersion: "harness-test", startedAt: t0, config: { ...loadRunConfig({ driver: "stub" }), runId: "run-v1f", token: TOKEN, character: "Testwick", model: "test/model" } });
    traj.close();
    const writer = new SessionWriter({ dir: join(dir, "session"), id: "0123456789abcdef", stack: { version: "test" }, now: () => t0 + 1_000, log: () => {} });
    writer.open();
    const state = { hp: 1, hpMax: 1, pw: null, pwMax: null, pwType: null, level: 6, xp: 450, xpMax: 900, auras: [], combat: false, mounted: false, taxi: false, dead: false, ghost: false, resting: false, zone: 12, area: null, target: null, cast: null };
    const sheet = { money: 1234, equip: null, bags: null, inv: null, dur: null, quests: null, rep: null, skills: null };
    writer.ingest({
      trace: { rows: [{ ts: t0 + 1_000, kind: "key", map: 0, x: 1, y: 2, z: 3, o: 0, data: { ...state, ...sheet } }, { ts: t0 + 2_000, kind: "state", data: { xp: 480 } }], dropped: 0 },
      events: { rows: [{ ts: t0 + 1_500, kind: "quest", id: 7 }, { ts: t0 + 1_600, kind: "quest", id: 8 }], dropped: 0 },
      nearby: { rows: [], dropped: 0, through: 0 },
      moves: [],
      character: { guid: "5", name: "Testwick", race: 1, class: 1 },
      stream: { connected: true, events: 1, seq: 1 },
    });
    // A live owner: a 0.5 run's run.sqlite would not be opened; a v1 run has none to hold.
    writeFileSync(join(dir, "heartbeat"), "a-host 1\n");
    utimesSync(join(dir, "heartbeat"), (NOW - 5_000) / 1000, (NOW - 5_000) / 1000);
    const r = await inspect(["run", "run-v1f", "--runs-dir", runsDir], NOW);
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("verdict")).toContain("live");
    expect(at("level")).toContain("L6 480xp of 900");
    expect(at("level")).toContain("money 12s 34c");
    expect(at("quests")).toBe("quests     2 over the run");
    expect(at("session")).toContain("wrath-session/1 (Testwick), open");
    const live = await inspect(["live", "--runs-dir", runsDir], NOW);
    expect(live.out.find((l) => l.includes("run-v1f"))).toContain("L6 480xp");
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
    expect(at("harness")).toContain("adapter_retry 2");
    expect(at("files")).toContain("trajectory.jsonl");
    expect(at("trace")).toContain("none (no session record");
    expect(at("nearby")).toContain("none");
    // A run with no live owner reads the same off its own files.
    const ended = await inspect(["run", "run-ended", "--runs-dir", RUNS]);
    expect(ended.out.find((l) => l.startsWith("level"))).toContain("L4 300xp");
    expect(ended.out.find((l) => l.startsWith("quests"))).toBe("quests     3 over the run");
    expect(ended.out.find((l) => l.startsWith("harness"))).toContain("adapter_retry 2");
  });

  test("the quest count is the run's across a resume, each process's stretch beside it", async () => {
    const runsDir = tmp("inspect-run-quests-");
    // Counted 1, 2, 3 from 11:01; resumed at 11:31 by a process whose count starts again at zero.
    const dir = makeRun(runsDir, "run-resumed", "live");
    writeLegacy05Run(dir, readRunRow(dir, "run-resumed")!, [
      { ts: NOW - 29 * 60_000, level: 4, xp: 400, questsCompleted: 0 },
      { ts: NOW - 28 * 60_000, level: 4, xp: 400, questsCompleted: 4 },
    ]);
    const r = await inspect(["run", "run-resumed", "--runs-dir", runsDir], NOW, await memoryStore(runsDir));
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("quests")).toBe("quests     7 over the run, summed across 1 restart(s); the newest sample reads 4 · from 01-02 11:01 3 · from 01-02 11:31 4");
    // The newest sample's own count is not the level line's to state.
    expect(at("level")).not.toContain("quests");
  });

  test("prints a bounded block, never the config or the token", async () => {
    const r = await inspect(["run", "run-live", "--runs-dir", RUNS]);
    expect(r.out.length).toBeLessThanOrEqual(16);
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
    const all = r.out.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('"token"');
  });

  test("refuses an id that would leave the runs directory", async () => {
    expect((await inspect(["run", "../etc", "--runs-dir", RUNS])).code).toBe(2);
    expect((await inspect(["run", "nope", "--runs-dir", RUNS])).code).toBe(1);
  });
});

describe("inspect over a fan-out run", () => {
  test("run, trajectory and live read it without throwing, and never print its roster's token", async () => {
    const runsDir = tmp("inspect-fanout-");
    await writeFanoutRun(runsDir);
    for (const argv of [["run", FANOUT_RUN], ["trajectory", FANOUT_RUN], ["live"]]) {
      const r = await inspect([...argv, "--runs-dir", runsDir], NOW);
      expect({ argv, err: r.err.filter((l) => /TypeError|Error:/.test(l)) }).toEqual({ argv, err: [] });
      expect({ argv, leaked: [...r.out, ...r.err].some((l) => l.includes(FANOUT_ROSTER_TOKEN)) }).toEqual({ argv, leaked: false });
    }
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
});

describe("inspect trajectory: a window, and either end of it", () => {
  const at = (min: number): string => String(NOW - 3_600_000 + min * 60_000);
  const body = async (argv: string[]): Promise<string[]> => (await inspect(["trajectory", "run-live", "--runs-dir", RUNS, ...argv])).out.slice(1, -1);

  test("--since and --until together are a range", async () => {
    const r = await body(["--since", at(2.5), "--until", at(5.5)]);
    expect(r.map((l) => /return \d;|TypeError/.exec(l)?.[0])).toEqual(["return 3;", "TypeError"]);
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
  const views = [
    ["trajectory"],
    ["trajectory", "--errors"],
    ["trajectory", "--all", "--last", "200"],
    ["trajectory", "--all", "--grep", "session"],
    ["trajectory", "--since", at(2.5), "--until", at(5.5)],
    ["trajectory", "--since", at(1.5), "--next", "2"],
    ["tools"],
    ["pad"],
  ];
  const runViews = [["run"], ["run", "--since", at(5.5)]];
  // A live run's row is read only from ClickHouse, so `run` is compared where the files may answer it too.
  for (const id of ["run-live", "run-ended"]) {
    test(id, async () => {
      for (const argv of id === "run-live" ? views : [...views, ...runViews]) {
        const files = await view(id, argv);
        expect({ argv, empty: files.length === 0 }).toEqual({ argv, empty: false });
        expect({ argv, lines: await view(id, argv, STORE) }).toEqual({ argv, lines: files });
      }
    });
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
