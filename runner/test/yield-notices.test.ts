/**
 * The harness notices a `yield` carries: the ones queued for the next turn
 * message, the driver's and the sandbox's, go in the yield's result after the
 * wake block, in the turn message's `[harness notices]` form, and that
 * message does not repeat them. Pure on `ProgramWake.yieldAnswer`, then
 * through the fixed loop and the claude-code driver's fake CLI over a real
 * sandbox, whose notice is queued while the model sleeps in a `yield`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scratchpad } from "@wrathbench/mcp";
import { Workspace } from "@wrathbench/mcp/workspace";
import { leaseSessionSecret } from "@wrathbench/mcp/module-auth";
import { StubAdapter, type ChatRequest } from "../src/adapter";
import { runClaudeEpisode } from "../src/adapter-claude";
import { loadRunConfig } from "../src/config";
import { assembleContext, renderNotices } from "../src/context";
import { EpisodicLog } from "../src/episodic";
import { runLoop } from "../src/loop";
import { SandboxHost, type HarnessNotice } from "../src/sandbox/host";
import { readTrajectory, Trajectory } from "../src/trajectory";
import { PROGRAM_DIR, ProgramWake } from "../src/wake";
import { Watchdogs } from "../src/watchdogs";
import { PORT_SECRET, startStub, type Stub } from "./fixtures/fanout-module";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

describe("ProgramWake.yieldAnswer", () => {
  const wake = (): ProgramWake => new ProgramWake({ trajectory: { append: () => {}, scrub: (t) => t.replaceAll("s3cret", "[redacted]") }, now: () => 10_000 });

  test("no notice queued: the block alone, its bytes unchanged", () => {
    const queued: HarnessNotice[] = [];
    expect(wake().yieldAnswer("[wake 1 · slept 5s · woke for: 5s passed]", queued, () => [])).toBe("[wake 1 · slept 5s · woke for: 5s passed]");
  });

  test("the driver's queue, then the sandbox's, after the block in the turn message's form; both are emptied; the run's secrets are scrubbed", () => {
    const w = wake();
    const queued = [{ ts: 1, kind: "compaction_ask", text: "log a status entry now" }] as unknown as HarnessNotice[];
    const sandbox: HarnessNotice[] = [{ ts: 2, kind: "session_note", text: "sandbox reported fatal error: s3cret" }];
    const out = w.yieldAnswer("[wake 2 · slept 1s · woke for: a harness notice]", queued, () => sandbox.splice(0, sandbox.length));
    expect(out).toBe(
      "[wake 2 · slept 1s · woke for: a harness notice]\n\n[harness notices]\n- compaction_ask: log a status entry now\n- session_note: sandbox reported fatal error: [redacted]",
    );
    expect(queued).toEqual([]);
    expect(sandbox).toEqual([]);
    // The same section a turn message renders.
    expect(assembleContext({ turn: 1, stateSummary: "s", events: [], scratchpad: "", notices: [queued[0] ?? { ts: 1, kind: "session_note", text: "x" }] })).toContain(
      renderNotices([{ kind: "session_note", text: "x" }]),
    );
  });

  test("a notice it carried no longer wakes; a death, which it does not carry, still does", () => {
    const w = wake();
    w.onNotice({ kind: "session_note", ts: 5_000 });
    w.onDeath(5_000);
    w.yieldAnswer("[wake 3]", [{ ts: 5_000, kind: "session_note", text: "x" }], () => []);
    expect(w.waker.peek().map((r) => r.key)).toEqual(["died"]);
  });

  test("with nothing to carry, nothing is forgotten", () => {
    const w = wake();
    w.onNotice({ kind: "session_note", ts: 5_000 });
    w.yieldAnswer("[wake 4]", [], () => []);
    expect(w.waker.peek().map((r) => r.key)).toEqual(["notice"]);
  });
});

// ------------------------------------------------------------ over a real sandbox

const hosts: SandboxHost[] = [];
const stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  await Promise.all(stubs.splice(0).map((s) => s.stop()));
});

const TOKEN = "yield-notices-token-0001";
const LOGIN = 'await connect(); return (await sdk.createSession({ character: "Thalvorn", race: 1, class: 2 })).character;';
const MAIN = `export async function idle() {
  while (!signal.aborted) await sleep(50, { wake: false });
}
export async function nap() {
  await sleep(2000, { wake: false });
  return "done";
}
`;
const NOTE = "sandbox reported fatal error: the test's own note";

/**
 * A logged-in sandbox hosting a program, whose notice queue gets one
 * `session_note` while the model sleeps in its first `yield`, raised the way
 * the host raises one (`onNotice` beside the queue).
 */
async function sandboxWithNotice(runDir: string, wake: ProgramWake): Promise<SandboxHost> {
  const module = startStub();
  stubs.push(module);
  const lease = await leaseSessionSecret({ moduleUrl: module.url, token: TOKEN, account: "RUNNER", env: { WRATHBENCH_MODULE_SECRET: PORT_SECRET } });
  const sandbox = new SandboxHost({
    moduleUrl: module.url,
    token: TOKEN,
    secret: lease.secret!,
    account: "RUNNER",
    scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    logSink: () => {},
    program: { workspace: new Workspace(join(runDir, PROGRAM_DIR)), onFact: wake.onFact, beatMs: 200 },
  });
  hosts.push(sandbox);
  expect((await sandbox.evalSnippet(LOGIN)).value).toContain("Thalvorn");
  const drain = sandbox.drainNotices.bind(sandbox);
  const queued: ReturnType<typeof drain> = [];
  sandbox.drainNotices = () => [...queued.splice(0, queued.length), ...drain()];
  const sleep = wake.sleep.bind(wake);
  let raised = false;
  wake.sleep = (program, o) => {
    if (o.via === "yield" && !raised) {
      raised = true;
      setTimeout(() => {
        const n = { ts: Date.now(), kind: "session_note" as const, text: NOTE };
        queued.push(n);
        wake.onNotice(n);
      }, 300);
    }
    return sleep(program, o);
  };
  return sandbox;
}

describe("a yield carries the notice raised while the model slept in it", () => {
  test("the fixed loop: in the yield's result, after the block, and not in the next request", async () => {
    const runDir = tempDir("wrathbench-yield-notices-loop-");
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 50, stateIntervalMs: 1, loop: "program", yield: true }),
      runId: "run-yield-notices",
      token: "run-yield-notices",
    };
    const trajectory = new Trajectory(runDir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
    const wake = new ProgramWake({ trajectory, tickMs: 20, coalesceMs: 100 });
    const sandbox = await sandboxWithNotice(runDir, wake);
    const requests: ChatRequest[] = [];
    const stub = new StubAdapter([
      { content: null, toolCalls: [{ name: "write_file", arguments: { path: "main.ts", content: MAIN } }, { name: "start_routine", arguments: { name: "idle" } }, { name: "yield", arguments: { seconds: 30 } }] },
      { content: null, toolCalls: [{ name: "stop_routine", arguments: { name: "idle" } }] },
    ]);
    await runLoop({
      config,
      adapter: { label: "stub", complete: (req) => (requests.push(req), stub.complete(req)) },
      sandbox,
      scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      programWake: wake,
    });
    trajectory.close();
    const yielded = readTrajectory(runDir).find((r) => r.t === "tool_result" && r["name"] === "yield");
    const text = String(yielded?.["text"]);
    expect(text).toMatch(/^\[wake 1 · slept \d+s · woke for: a harness notice\]/);
    expect(text).toEndWith(`\n\n[harness notices]\n- session_note: ${NOTE}`);
    expect(String(requests[1]!.messages.at(-1)!.content)).not.toContain(NOTE);
  }, 60_000);

  test("claude-code: in the yield's result, inside the turn, and not in the next turn's message", async () => {
    const runDir = tempDir("wrathbench-yield-notices-claude-");
    const config = {
      ...loadRunConfig({
        driver: "claude-code",
        model: "opus",
        runsDir: tempDir("wrathbench-yield-notices-runs-"),
        credential: "claude-1",
        usageMaxPct: { scored: 80, freeplay: 80 },
        episode: "probing",
        stepIntervalMs: 50,
        stateIntervalMs: 1,
        loop: "program",
        yield: true,
        maxTurns: 2,
      }),
      runId: "run-yield-notices-claude",
      token: "run-yield-notices-claude",
    };
    const trajectory = new Trajectory(runDir);
    trajectory.writeMeta({ runId: config.runId, harnessVersion: "t", startedAt: Date.now(), config });
    const wake = new ProgramWake({ trajectory, tickMs: 20, coalesceMs: 100 });
    const sandbox = await sandboxWithNotice(runDir, wake);
    const bin = join(tempDir("wrathbench-yield-notices-bin-"), "claude");
    writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures", "fake-claude.ts")} "$@"\n`, "utf8");
    chmodSync(bin, 0o755);
    const record = join(runDir, "fake-record.json");
    const calls = [
      [
        { name: "write_file", arguments: { path: "main.ts", content: MAIN } },
        // Ends after the notice woke the yield, so the turn-end sleep after this turn ends on it.
        { name: "start_routine", arguments: { name: "nap" } },
        { name: "yield", arguments: { seconds: 30 } },
      ],
      [],
    ];
    const outcome = await runClaudeEpisode({
      config: config as typeof config & { runId: string; token: string },
      runDir,
      sandbox,
      scratchpad: new Scratchpad(join(runDir, "scratchpad.md")),
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      claudeBin: bin,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-for-tests" },
      extraEnv: { WB_FAKE_MODE: "tools", WB_FAKE_RECORD: record, WB_FAKE_CALLS: JSON.stringify(calls) },
      killGraceMs: 500,
      programWake: wake,
    });
    trajectory.close();
    expect(outcome).toEqual({ kind: "terminated", reason: "turn-limit", detail: "2 turns" });
    const records = readTrajectory(runDir);
    const text = String(records.find((r) => r.t === "tool_result" && r["name"] === "yield")?.["text"]);
    expect(text).toMatch(/^\[wake 1 · slept \d+s · woke for: a harness notice\]/);
    expect(text).toEndWith(`\n\n[harness notices]\n- session_note: ${NOTE}`);
    const messages = (JSON.parse(readFileSync(record, "utf8")) as { userMessages: string[] }).userMessages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).not.toContain(NOTE);
  }, 60_000);
});
