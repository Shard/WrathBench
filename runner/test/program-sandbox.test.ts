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
import { Scratchpad, type EventSummary } from "@wrathbench/mcp";
import { Workspace } from "@wrathbench/mcp/workspace";
import { leaseSessionSecret } from "@wrathbench/mcp/module-auth";
import { StubAdapter, type ChatRequest } from "../src/adapter";
import { runCodexEpisode } from "../src/adapter-codex";
import { loadRunConfig } from "../src/config";
import { EVENTS_UNCHANGED_LINE, formatEventLine, scratchpadUnchangedLine } from "../src/context";
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

/** A sandbox whose context events are `of`'s, by the message's index (from 0), rather than the stub's stream. */
function overrideEvents(sandbox: SandboxHost, of: ((message: number) => EventSummary[]) | undefined): void {
  if (of === undefined) return;
  let n = 0;
  (sandbox as unknown as { contextEvents: () => Promise<unknown> }).contextEvents = () => Promise.resolve({ events: of(n++), folded: 0 });
}

const T0 = Date.UTC(2030, 0, 2, 12, 0, 0);
/** Chat events seq `from`..`to`. */
const evs = (from: number, to: number): EventSummary[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, ts: T0 + (from + i) * 1000, opcode: "SMSG_MESSAGECHAT", data: { text: `line ${from + i}` } }) as EventSummary);
const fullWindow = (from: number, to: number): string => `[events: last ${to - from + 1}, newest last]\n${evs(from, to).map(formatEventLine).join("\n")}`;

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
    overrideEvents(sandbox, () => evs(1, 5));
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
    // The fixed loop keeps no earlier turn message, so every request holds one
    // user message, this turn's, and carries the event window whole.
    expect(requests.every((q) => q.messages.filter((m) => m.role === "user").length === 1)).toBe(true);
    expect(requests.map((q) => String(q.messages.at(-1)!.content)).every((u) => u.includes(fullWindow(1, 5)) && !u.includes(EVENTS_UNCHANGED_LINE))).toBe(true);

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
async function codexProgramRun(
  calls: unknown[][],
  o: {
    maxTurns?: number;
    idleMs?: number;
    signal?: AbortSignal;
    /** The event window each turn's message is built from, by the message's index (from 0), in place of the stub's stream. */
    events?: (message: number) => EventSummary[];
    /** The fake's `WB_FAKE_MODE`; `tools` unless said. */
    mode?: string;
    /** `WB_FAKE_ROLLOUT`'s entries; a rollout of every turn unless said. */
    rollout?: unknown[];
  } = {},
) {
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
  overrideEvents(sandbox, o.events);
  const rollout = o.rollout ?? calls.map((_, i) => ({ total: 10_000 * (i + 1) }));
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
    // A thread whose rollout the CLI writes, as the real one does: the thread context trusts only a turn it could read.
    extraEnv: {
      WB_FAKE_MODE: o.mode ?? "tools",
      WB_FAKE_RECORD: record,
      WB_FAKE_CALLS: JSON.stringify(calls),
      WB_FAKE_THREAD_ID: "01a119da-ef89-7a63-ac51-314ac6a70a60",
      WB_FAKE_ROLLOUT: JSON.stringify(rollout),
    },
    killGraceMs: 500,
    programWake: wake,
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
  });
  trajectory.close();
  return { outcome, ms: Date.now() - started, rec: JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>, records: readTrajectory(runDir) };
}

describe("the program loop on the codex driver, through the fake CLI", () => {
  test("the turn-end pause sleeps until a wake, whose block opens the next turn; yield is served; the pad and the event window go whole only when the thread does not hold them", async () => {
    const r = await codexProgramRun(
      [
        [
          { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
          { name: "write_scratchpad", arguments: { content: "# plan\nGoldshire" } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } },
        ],
        [{ name: "start_routine", arguments: { name: "trip", args: { to: "Elwynn" } } }],
        [
          { name: "run_snippet", arguments: { code: 'await scratchpad.write("# plan\\nfrom a snippet"); return 1' } },
          { name: "start_routine", arguments: { name: "trip", args: { to: "Westfall" } } },
        ],
        [
          { name: "start_routine", arguments: { name: "idle" } },
          { name: "yield", arguments: { seconds: 1 } },
        ],
      ],
      { maxTurns: 4, events: (n) => (n < 3 ? evs(1, 5) : evs(1, 6)) },
    );
    expect(r.outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "4 turns" });
    // The program's prompt, tools and the raised tool timeout are what the CLI was handed.
    expect(String(r.rec["instructions"])).toContain("## Your program");
    const served = (r.rec["mcpToolsLists"] as { tools: { name: string }[] }[])[0]!.tools.map((t) => t.name);
    expect(served).toEqual(expect.arrayContaining(["write_file", "start_routine", "stop_routine", "yield"]));
    expect((r.rec["argvs"] as string[][])[0]).toContain("mcp_servers.wrathbench.tool_timeout_sec=600");
    const results = r.records.filter((x) => x.t === "tool_result").map((x) => [x["name"], String(x["text"])]);
    expect(results.find(([n]) => n === "write_file")?.[1]).toContain("loaded: deploy 1 · routines: idle, trip");
    expect(results.find(([n]) => n === "yield")?.[1]).toContain("[wake 4 · slept 1s · woke for: 1s passed]");
    expect(r.records.filter((x) => x.t === "wake").map((x) => [x["via"], x["fired"]])).toEqual([
      ["turn-end", "routine_ended"],
      ["turn-end", "routine_ended"],
      ["turn-end", "routine_ended"],
      ["yield", "cap"],
    ]);
    const messages = r.rec["userMessages"] as string[];
    expect(messages.length).toBe(4);
    // Each turn after a sleep opens with the wake its routine's end caused; the first with none.
    expect(messages[0]).not.toContain("[wake");
    expect(messages[1]).toMatch(/^\[turn 2\]\n\n\[wake 1 · slept \d+s · woke for: routine ended \(trip, returned\)\]/);
    // Turn 1: the pad as it then was (empty), and the window whole.
    expect(messages[0]).toContain("[scratchpad]\n(empty");
    expect(messages[0]).toContain(fullWindow(1, 5));
    // Turn 2: the model wrote the pad itself, so the thread holds it; the window is unchanged.
    expect(messages[1]).toEndWith("[scratchpad 0.0k/32k: unchanged since you last saw it in this conversation, so not repeated]");
    expect(messages[1]).not.toContain("# plan");
    expect(messages[1]).toContain(`\n\n${EVENTS_UNCHANGED_LINE}\n\n`);
    // Turn 3 is the same; turn 4 follows a snippet's write, which the thread never saw, and a new event.
    expect(messages[2]).toContain("so not repeated]");
    expect(messages[2]).toContain(EVENTS_UNCHANGED_LINE);
    expect(messages[3]).toEndWith("[scratchpad 0.0k/32k]\n# plan\nfrom a snippet");
    expect(messages[3]).toContain(fullWindow(1, 6));
  }, 60_000);

  test("a stop request ends the sleep at once, and time asleep is not idle", async () => {
    const ac = new AbortController();
    // Nothing runs, so the turn-end sleep would last five minutes; idle is far shorter than the sleep.
    setTimeout(() => ac.abort(), 3_500);
    const r = await codexProgramRun([[{ name: "write_file", arguments: { path: "main.ts", content: MAIN } }]], { idleMs: 1_500, signal: ac.signal });
    expect(r.outcome).toEqual({ kind: "terminated", reason: "manual", detail: "aborted" });
    expect(r.ms).toBeLessThan(15_000);
    expect(r.records.filter((x) => x.t === "wake").map((x) => [x["via"], x["fired"]])).toEqual([["turn-end", "stopped"]]);
    expect(r.records.some((x) => x.t === "watchdog")).toBe(false);
  }, 60_000);
});

// ------------------------------------------------- the event window's rule

/** Each turn starts a trip whose end wakes the next; the last turn does nothing. */
const TRIPS = (turns: number): unknown[][] => [
  [
    { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
    { name: "start_routine", arguments: { name: "trip", args: { to: "Goldshire" } } },
  ],
  ...Array.from({ length: turns - 2 }, (_, i) => [{ name: "start_routine", arguments: { name: "trip", args: { to: `stop ${i}` } } }]),
  [],
];
const rollout = (turns: number, compactAt?: number): unknown[] =>
  Array.from({ length: turns }, (_, i) => ({ total: 10_000 * (i + 1), ...(i + 1 === compactAt ? { compact: { pre: 440_000, post: 50_000 } } : {}) }));

describe("the event window on codex's program loop", () => {
  test("a compaction the rollout shows sends the window whole in the next message", async () => {
    const r = await codexProgramRun(TRIPS(3), { maxTurns: 3, events: () => evs(1, 5), rollout: rollout(3, 2) });
    const messages = r.rec["userMessages"] as string[];
    expect(r.records.some((x) => x.t === "harness" && x["kind"] === "compaction")).toBe(true);
    expect(messages[1]).toContain(EVENTS_UNCHANGED_LINE);
    expect(messages[2]).toContain(fullWindow(1, 5));
  }, 60_000);

  test("a thread that lost turns sends the window and the pad whole after it", async () => {
    // `regress`: the third turn's total reads as though the second never happened.
    const calls = TRIPS(4);
    calls[0] = [...calls[0]!, { name: "write_scratchpad", arguments: { content: "# plan\nGoldshire" } }];
    const r = await codexProgramRun(calls, { maxTurns: 4, events: () => evs(1, 5), mode: "regress" });
    expect(r.records.some((x) => x.t === "harness" && x["kind"] === "usage_regressed")).toBe(true);
    const messages = r.rec["userMessages"] as string[];
    expect(messages.map((m) => m.includes(EVENTS_UNCHANGED_LINE))).toEqual([false, true, true, false]);
    expect(messages.map((m) => m.endsWith(scratchpadUnchangedLine("# plan\nGoldshire".length)))).toEqual([false, true, true, false]);
    expect(messages[3]).toEndWith("[scratchpad 0.0k/32k]\n# plan\nGoldshire");
  }, 60_000);

  test("a failed turn may not have kept its message: the window goes whole after it", async () => {
    // `flaky`: the first turn fails before its calls, and its queued notice
    // wakes the next, which resumes the thread. The fake writes no rollout
    // for the failed turn, so the unread rollout resets the thread as well.
    const r = await codexProgramRun([[], ...TRIPS(3)], { maxTurns: 4, events: () => evs(1, 5), mode: "flaky" });
    expect(r.records.some((x) => x.t === "codex_result" && x["status"] === "failed")).toBe(true);
    expect((r.rec["userMessages"] as string[]).map((m) => m.includes(EVENTS_UNCHANGED_LINE))).toEqual([false, false, true, true]);
  }, 60_000);

  test("a thread other than the one before holds nothing: the window goes whole once the CLI names it", async () => {
    // Every turn starts a thread of its own. The message that reaches a new
    // thread is the one built for the old (the CLI names its thread only once
    // the turn has started), so the second is the line; every later one is whole.
    const r = await codexProgramRun(TRIPS(4), { maxTurns: 4, events: () => evs(1, 5), mode: "new-thread" });
    expect((r.rec["userMessages"] as string[]).map((m) => m.includes(EVENTS_UNCHANGED_LINE))).toEqual([false, true, false, false]);
  }, 60_000);
});
