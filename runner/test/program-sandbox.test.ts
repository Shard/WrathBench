/**
 * The program loop against the real confined child: the runner's sandbox
 * host with a program in the run directory, the run's wake taking its facts,
 * and the fixed loop driven by the stub adapter through a save, a routine, a
 * sleep that a routine's end wakes, and a `yield`. Then a second host over the
 * same run directory, as a resumed run builds it, which brings the routine
 * that was running back. No module: the routines touch nothing of the game.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scratchpad } from "@wrathbench/mcp";
import { Workspace } from "@wrathbench/mcp/workspace";
import { leaseSessionSecret } from "@wrathbench/mcp/module-auth";
import { StubAdapter, type ChatRequest } from "../src/adapter";
import { runCodexEpisode } from "../src/adapter-codex";
import { loadRunConfig } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { runLoop } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { PROGRAM_DIR, ProgramWake } from "../src/wake";
import { Watchdogs } from "../src/watchdogs";
import { PORT_SECRET, startStub, type Stub } from "./fixtures/fanout-module";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const hosts: SandboxHost[] = [];
const stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  await Promise.all(stubs.splice(0).map((s) => s.stop()));
});

const TOKEN = "program-test-token-0001";

function host(runDir: string, wake: ProgramWake, stub: Stub, secret: string): SandboxHost {
  const h = new SandboxHost({
    moduleUrl: stub.url,
    token: TOKEN,
    secret,
    account: "RUNNER",
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    logSink: () => {},
    program: { workspace: new Workspace(join(runDir, PROGRAM_DIR)), onFact: wake.onFact, beatMs: 200 },
  });
  hosts.push(h);
  return h;
}

const LOGIN = 'await connect(); return (await sdk.createSession({ character: "Thalvorn", race: 1, class: 2 })).character;';

const MAIN = `export async function trip(args) {
  await sleep(300, { wake: false });
  console.log("arrived at " + args.to);
  return "done";
}
export async function idle() {
  while (!signal.aborted) await sleep(50, { wake: false });
}
`;

describe("the program loop over a real sandbox", () => {
  test("save, start, sleep until the routine ends, yield; the records say so", async () => {
    const runDir = tempDir("wrathbench-program-run-");
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 50, stateIntervalMs: 1, loop: "program", yield: true }),
      runId: "run-program",
      token: "run-program",
    };
    const trajectory = new Trajectory(runDir);
    trajectory.writeMeta({ runId: "run-program", harnessVersion: "t", startedAt: Date.now(), config });
    const wake = new ProgramWake({ trajectory, tickMs: 20, coalesceMs: 100 });
    const module = startStub();
    stubs.push(module);
    const lease = await leaseSessionSecret({ moduleUrl: module.url, token: TOKEN, account: "RUNNER", env: { WRATHBENCH_MODULE_SECRET: PORT_SECRET } });
    const secret = lease.secret!;
    const sandbox = host(runDir, wake, module, secret);
    expect((await sandbox.evalSnippet(LOGIN)).value).toContain("Thalvorn");
    const requests: ChatRequest[] = [];
    const stub = new StubAdapter([
      { content: null, toolCalls: [{ name: "write_file", arguments: { path: "main.ts", content: MAIN } }, { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } }] },
      { content: "waiting", toolCalls: [] },
      { content: null, toolCalls: [{ name: "start_routine", arguments: { name: "idle" } }, { name: "yield", arguments: { seconds: 1 } }] },
    ]);
    const outcome = await runLoop({
      config,
      adapter: { label: "stub", complete: (req) => (requests.push(req), stub.complete(req)) },
      sandbox,
      scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      programWake: wake,
    });
    expect(outcome).toEqual({ kind: "terminated", reason: "stub-complete" });
    trajectory.close();
    const records = readTrajectory(runDir);
    const results = records.filter((r) => r.t === "tool_result").map((r) => String(r["text"]));
    expect(results[0]).toContain("loaded: deploy 1 · routines: idle, trip");
    expect(results[1]).toContain("started trip on deploy 1");
    // The sleep was woken by trip's end, and the block says what it printed and returned.
    const third = String(requests[2]!.messages.at(-1)!.content);
    expect(third).toMatch(/^\[turn 3\]\n\n\[wake 1 · slept \d+s · woke for: routine ended \(trip, returned\)\]/);
    expect(third).toContain('trip returned');
    expect(third).toContain("no routine is running");
    // Its console rides the beat: this wake's, or, when a timer beat was in
    // flight as the wake asked for one, the next wake's.
    expect(`${third}\n${results[3]}`).toContain("  [trip] arrived at Goldshire");
    // The yield found nothing in its one second, with idle running.
    expect(results[3]).toContain("[wake 2 · slept 1s · woke for: 1s passed]");
    expect(results[3]).toContain("idle running");
    expect(String(requests[3]!.messages.at(-1)!.content)).not.toContain("[wake");
    expect(records.filter((r) => r.t === "wake").map((r) => [r["via"], r["fired"]])).toEqual([
      ["turn-end", "routine_ended"],
      ["yield", "cap"],
    ]);
    expect(records.find((r) => r.t === "deploy")).toMatchObject({ ok: true, by: "save", deploy: 1 });
    expect(records.find((r) => r.t === "routine" && r["event"] === "ended")).toMatchObject({ name: "trip", state: "returned" });

    // The resume: a new process over the same run directory brings idle back.
    await sandbox.stop();
    const resumedWake = new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t } });
    const again = host(runDir, resumedWake, module, secret);
    await again.start();
    expect(again.program!.routines().find((r) => r.name === "idle")).toMatchObject({ state: "running", deploy: 1 });
    expect(resumedWake.waker.peek().map((r) => r.key)).toContain("sandbox_restart");
  }, 60_000);
});

// ------------------------------------------------------------ the codex driver

/** A directory holding a `codex` that runs the scripted fake (`fixtures/fake-codex.ts`). */
function fakeCodexBin(): string {
  const dir = tempDir("wrathbench-program-codex-bin-");
  const path = join(dir, "codex");
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures", "fake-codex.ts")} "$@"\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A codex home that looks logged in. */
function fakeCodexHome(): string {
  const dir = tempDir("wrathbench-program-codex-home-");
  writeFileSync(join(dir, "auth.json"), '{"auth_mode":"chatgpt","tokens":{"access_token":"fake"}}\n', "utf8");
  return dir;
}

/** A program-loop codex run over a real sandbox, its CLI the fake playing `calls` (one list per turn). */
async function codexProgramRun(calls: unknown[][], o: { maxTurns?: number; idleMs?: number; signal?: AbortSignal } = {}) {
  const runDir = tempDir("wrathbench-program-codex-");
  const config = {
    ...loadRunConfig({
      driver: "codex",
      model: "gpt-6.1-sol",
      credential: "chatgpt-1",
      usageMaxPct: { scored: 80, freeplay: 80 },
      episode: "probing",
      stepIntervalMs: 50,
      stateIntervalMs: 1,
      loop: "program",
      yield: true,
      ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
    }),
    runId: "run-program-codex",
    token: "run-program-codex",
  };
  const trajectory = new Trajectory(runDir);
  trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
  const wake = new ProgramWake({ trajectory, tickMs: 20, coalesceMs: 100 });
  const module = startStub();
  stubs.push(module);
  const lease = await leaseSessionSecret({ moduleUrl: module.url, token: TOKEN, account: "RUNNER", env: { WRATHBENCH_MODULE_SECRET: PORT_SECRET } });
  const sandbox = host(runDir, wake, module, lease.secret!);
  expect((await sandbox.evalSnippet(LOGIN)).value).toContain("Thalvorn");
  const record = join(runDir, "fake-record.json");
  const started = Date.now();
  const outcome = await runCodexEpisode({
    config: config as typeof config & { runId: string; token: string },
    runDir,
    sandbox,
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
    trajectory,
    watchdogs: new Watchdogs({ ...config.watchdogs, ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}) }),
    codexBin: fakeCodexBin(),
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", CODEX_HOME: fakeCodexHome() },
    extraEnv: { WB_FAKE_MODE: "tools", WB_FAKE_RECORD: record, WB_FAKE_CALLS: JSON.stringify(calls) },
    killGraceMs: 500,
    programWake: wake,
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
  });
  trajectory.close();
  return { outcome, ms: Date.now() - started, rec: JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>, records: readTrajectory(runDir) };
}

describe("the program loop on the codex driver, through the fake CLI", () => {
  test("the turn-end pause sleeps until a wake, whose block opens the next turn; yield is served and answers its wake", async () => {
    const r = await codexProgramRun(
      [
        [
          { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } },
        ],
        [
          { name: "start_routine", arguments: { name: "idle" } },
          { name: "yield", arguments: { seconds: 1 } },
        ],
      ],
      { maxTurns: 2 },
    );
    expect(r.outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });
    // The program's prompt, tools and the raised tool timeout are what the CLI was handed.
    expect(String(r.rec["instructions"])).toContain("## Your program");
    const served = (r.rec["mcpToolsLists"] as { tools: { name: string }[] }[])[0]!.tools.map((t) => t.name);
    expect(served).toEqual(expect.arrayContaining(["write_file", "start_routine", "stop_routine", "yield"]));
    expect((r.rec["argvs"] as string[][])[0]).toContain("mcp_servers.wrathbench.tool_timeout_sec=600");
    // The second turn opens with the wake trip's end caused, and only that turn.
    const messages = r.rec["userMessages"] as string[];
    expect(messages[0]).not.toContain("[wake");
    expect(messages[1]).toMatch(/^\[turn 2\]\n\n\[wake 1 · slept \d+s · woke for: routine ended \(trip, returned\)\]/);
    const results = r.records.filter((x) => x.t === "tool_result").map((x) => [x["name"], String(x["text"])]);
    expect(results.find(([n]) => n === "write_file")?.[1]).toContain("loaded: deploy 1 · routines: idle, trip");
    expect(results.find(([n]) => n === "yield")?.[1]).toContain("[wake 2 · slept 1s · woke for: 1s passed]");
    expect(r.records.filter((x) => x.t === "wake").map((x) => [x["via"], x["fired"]])).toEqual([
      ["turn-end", "routine_ended"],
      ["yield", "cap"],
    ]);
  }, 60_000);

  test("a stop request ends the sleep at once, and time asleep is not idle", async () => {
    const ac = new AbortController();
    // Nothing runs, so the turn-end sleep would last five minutes; idle is far shorter than the sleep.
    setTimeout(() => ac.abort(), 6_000);
    const r = await codexProgramRun([[{ name: "write_file", arguments: { path: "main.ts", content: MAIN } }]], { idleMs: 3_000, signal: ac.signal });
    expect(r.outcome).toEqual({ kind: "terminated", reason: "manual", detail: "aborted" });
    expect(r.ms).toBeLessThan(15_000);
    expect(r.records.filter((x) => x.t === "wake").map((x) => [x["via"], x["fired"]])).toEqual([["turn-end", "stopped"]]);
    expect(r.records.some((x) => x.t === "watchdog")).toBe(false);
  }, 60_000);
});
