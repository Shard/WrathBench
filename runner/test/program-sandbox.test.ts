/**
 * The program loop against the real confined child: the runner's sandbox
 * host with a program in the run directory, the run's wake taking its facts,
 * and the fixed loop driven by the stub adapter through a save, a routine, a
 * sleep that a routine's end wakes, and a `yield`. Then a second host over the
 * same run directory, as a resumed run builds it, which brings the routine
 * that was running back. No module: the routines touch nothing of the game.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Scratchpad } from "@wrathbench/mcp";
import { Workspace } from "@wrathbench/mcp/workspace";
import { leaseSessionSecret } from "@wrathbench/mcp/module-auth";
import { StubAdapter, type ChatRequest } from "../src/adapter";
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
