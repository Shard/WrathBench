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
import { REDACTED as RUNNER_REDACTED } from "../runner/src/redact";
import { HEARTBEAT_DEAD_MS as RUNNER_HEARTBEAT_DEAD_MS, Trajectory } from "../runner/src/trajectory";
import { ARCHIVE_DIR as VIEWER_ARCHIVE_DIR } from "../runner/viewer/archive-dir";
import {
  ARCHIVE_DIR,
  DEFAULT_WIDTH,
  errorClass,
  HEARTBEAT_DEAD_MS,
  main,
  MIN_TOKEN_LENGTH,
  parseSince,
  REDACTED,
  verdictOf,
} from "./inspect-run";
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

function inspect(argv: string[], now = NOW): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {}, (l) => out.push(l), (l) => err.push(l), now);
  return { code, out, err };
}

const RUNS = runs();

describe("the constants it shares with the runner", () => {
  test("are the runner's own", () => {
    expect(HEARTBEAT_DEAD_MS).toBe(RUNNER_HEARTBEAT_DEAD_MS);
    expect(MIN_TOKEN_LENGTH).toBe(RUNNER_MIN_TOKEN_LENGTH);
    expect(REDACTED).toBe(RUNNER_REDACTED);
    expect(ARCHIVE_DIR).toBe(VIEWER_ARCHIVE_DIR);
  });

  test("the file imports bun:sqlite and node:* only, so it runs from stdin in any runner image", () => {
    const src = readFileSync(join(import.meta.dir, "inspect-run.ts"), "utf8");
    const specs = [...src.matchAll(/^import[^"]*"([^"]+)"/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s === "bun:sqlite" || s!.startsWith("node:")).toBe(true);
  });
});

describe("the live rule", () => {
  test("live is no termination, no pause and a fresh heartbeat", () => {
    const row = { termination_reason: null, termination_detail: null, pause_reason: null };
    expect(verdictOf(row, NOW - 5_000, NOW).state).toBe("live");
    expect(verdictOf(row, NOW - HEARTBEAT_DEAD_MS - 1, NOW).state).toBe("ownerless");
    expect(verdictOf(row, null, NOW).state).toBe("ownerless");
  });

  test("a pause is not live, whatever the heartbeat says", () => {
    const row = { termination_reason: null, termination_detail: null, pause_reason: "operator-pause" };
    expect(verdictOf(row, NOW - 1_000, NOW)).toMatchObject({ state: "paused", reason: "operator-pause" });
  });

  test("inspect run says which, and why", () => {
    const line = (id: string): string => inspect(["run", id, "--runs-dir", RUNS]).out.find((l) => l.startsWith("verdict"))!;
    expect(line("run-live")).toContain("live: no termination, no pause; heartbeat 5s ago");
    expect(line("run-ownerless")).toContain("ownerless");
    expect(line("run-paused")).toContain("paused: operator-pause");
    expect(line("run-ended")).toContain("terminated: episode-limit — episode limit reached");
  });

  test("an empty-string reason is no reason, as readVerdict reads it", () => {
    const runsDir = tmp("inspect-run-empty-");
    const dir = makeRun(runsDir, "run-empty", "live");
    const db = new Database(join(dir, "run.sqlite"));
    db.run("UPDATE run SET pause_reason = '', termination_reason = ''");
    db.close();
    expect(inspect(["run", "run-empty", "--runs-dir", runsDir]).out.find((l) => l.startsWith("verdict"))).toContain("live:");
  });

  test("inspect live lists the runs with a heartbeat, and only those", () => {
    const r = inspect(["live", "--runs-dir", RUNS]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("1 run(s) with a live owner, 1 with a cold heartbeat");
    expect(r.out.some((l) => l.includes("run-live") && l.includes(" live "))).toBe(true);
    expect(r.out.some((l) => l.includes("run-ownerless") && l.includes("ownerless"))).toBe(true);
    expect(r.out.some((l) => l.includes("run-paused") || l.includes("run-ended"))).toBe(false);
  });
});

describe("inspect run", () => {
  test("reads the level, the counts by kind and the errors by class", () => {
    const r = inspect(["run", "run-live", "--runs-dir", RUNS]);
    expect(r.code).toBe(0);
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("level")).toContain("L4 300xp");
    expect(at("level")).toContain("money 1g 23s 45c");
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
  });

  test("--since counts only what came after", () => {
    const r = inspect(["run", "run-live", "--runs-dir", RUNS, "--since", String(NOW - 3_600_000 + 5.5 * 60_000)]);
    const at = (label: string): string => r.out.find((l) => l.startsWith(label)) ?? "";
    expect(at("activity")).toContain("since ");
    expect(at("errors")).toContain("snippets 1/2: timeout 1");
  });

  test("prints a bounded block, never the config or the token", () => {
    const r = inspect(["run", "run-live", "--runs-dir", RUNS]);
    expect(r.out.length).toBeLessThanOrEqual(16);
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
    const all = r.out.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('"token"');
  });

  test("finds an archived run, and says so", () => {
    const runsDir = tmp("inspect-run-archive-");
    mkdirSync(join(runsDir, ARCHIVE_DIR), { recursive: true });
    makeRun(join(runsDir, ARCHIVE_DIR), "run-old", "terminated");
    expect(inspect(["run", "run-old", "--runs-dir", runsDir]).out[0]).toContain("run-old (archived)");
  });

  test("refuses an id that would leave the runs directory", () => {
    expect(inspect(["run", "../etc", "--runs-dir", RUNS]).code).toBe(2);
    expect(inspect(["run", "nope", "--runs-dir", RUNS]).code).toBe(1);
  });
});

describe("inspect trajectory", () => {
  test("one line per snippet with its result, the newest last, every line capped", () => {
    const r = inspect(["trajectory", "run-live", "--runs-dir", RUNS]);
    expect(r.code).toBe(0);
    const body = r.out.slice(1);
    expect(body.filter((l) => l.includes(" snippet ")).length).toBe(6);
    expect(body.some((l) => l.includes("reflect ✗"))).toBe(true);
    expect(body.some((l) => l.includes("harness"))).toBe(true);
    expect(body.at(-1)).toContain("snippet ✓");
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
    expect(r.out.join("\n").length).toBeLessThan(20 * DEFAULT_WIDTH);
  });

  test("--errors keeps the failures, --last the newest few", () => {
    const errors = inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--errors"]).out.slice(1);
    expect(errors.length).toBe(3);
    for (const l of errors) expect(l).toContain("✗");
    const last = inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--last", "2"]).out.slice(1);
    expect(last.length).toBe(2);
  });

  test("--all is every record kind, the big ones by size alone", () => {
    const r = inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--all", "--last", "200"]);
    expect(r.out.some((l) => /request {2}\(\d+\.\d KB\)/.test(l))).toBe(true);
    expect(r.out.some((l) => /snippet_result {2}\(\d+\.\d KB\)/.test(l))).toBe(true);
    for (const l of r.out) expect(l.length).toBeLessThanOrEqual(DEFAULT_WIDTH);
  });

  test("the token is struck from every view, a cut one included", () => {
    for (const extra of [[], ["--errors"], ["--all", "--last", "500"], ["--grep", "TypeError"], ["--grep", "session", "--all"]]) {
      const all = inspect(["trajectory", "run-live", "--runs-dir", RUNS, ...extra]).out.join("\n");
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(TOKEN.slice(0, MIN_TOKEN_LENGTH));
    }
    expect(inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--grep", "bad key"]).out.join("\n")).toContain(REDACTED);
  });

  test("a token that is the run id, or too short to be one, is not struck", () => {
    const runsDir = tmp("inspect-run-oldtoken-");
    makeRun(runsDir, "run-legacy", "terminated", { token: "run-legacy" });
    const all = inspect(["trajectory", "run-legacy", "--runs-dir", runsDir]).out.join("\n");
    expect(all).toContain("run-legacy");
    expect(all).not.toContain(REDACTED);
  });

  test("--since stops reading at the first older record", () => {
    const r = inspect(["trajectory", "run-live", "--runs-dir", RUNS, "--since", String(NOW - 3_600_000 + 5.5 * 60_000)]);
    const body = r.out.slice(1);
    expect(body.some((l) => l.includes("timeout") || l.includes("exceeded"))).toBe(true);
    expect(body.some((l) => l.includes("return 1;"))).toBe(false);
  });
});

describe("parsing", () => {
  test("an error's class is its name, timeout for the ceiling, else its first words", () => {
    expect(errorClass("error (10012ms)\nEventTimeoutError: timed out after 10000ms")).toBe("EventTimeoutError");
    expect(errorClass("error (1ms)\nTypeError: undefined is not an object")).toBe("TypeError");
    expect(errorClass("error (30000ms)\nsnippet evaluation exceeded 30000ms")).toBe("timeout");
    expect(errorClass("error (3ms)\nError: scratchpad.write refused")).toBe("Error");
    expect(errorClass("something odd happened here")).toBe("something odd happened");
  });

  test("--since takes a duration back from now, epoch ms or ISO", () => {
    expect(parseSince("30m", NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince("2h", NOW)).toBe(NOW - 7_200_000);
    expect(parseSince(String(NOW - 5), NOW)).toBe(NOW - 5);
    expect(parseSince("2030-01-02T11:00:00Z", NOW)).toBe(NOW - 3_600_000);
    expect(() => parseSince("yesterday", NOW)).toThrow();
  });

  test("a bad flag or a missing id is a usage error", () => {
    expect(inspect(["run"]).code).toBe(2);
    expect(inspect(["trajectory", "run-live", "--last", "0", "--runs-dir", RUNS]).code).toBe(2);
    expect(inspect(["trajectory", "run-live", "--nope"]).code).toBe(2);
    expect(inspect([]).code).toBe(2);
  });
});
