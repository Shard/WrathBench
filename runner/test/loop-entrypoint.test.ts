/**
 * The fixed loop in its entrypoint phases (a probing spike), against the stub
 * adapter and a fake sandbox on a fake clock: a reply with no tool call ends
 * the wake, the harness deploys and the model sleeps; the fallback, a report
 * and the request cap wake or end it; a stop or a watchdog ends a sleep; and
 * the trajectory carries `wake`, `wake_end`, `deploy` and `program_error`
 * records with `wake` on every request and response. No live stack.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubAdapter, type ChatAdapter } from "../src/adapter";
import { loadRunConfig } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { TRIM_PENDING_NOTICE, TRIM_PENDING_NOTICE_ENTRYPOINT, runLoop, type StopRequest } from "../src/loop";
import type { DeployRecord, ProgramHostEvent, ProgramState, SandboxHost, SnippetResult } from "../src/sandbox/host";
import type { ProgramReport } from "../src/sandbox/ipc";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { FALLBACK_WAKE_MS, MIN_SLEEP_MS, WAKE_COALESCE_MS, WAKE_MAX_REQUESTS } from "../src/wake";
import { Watchdogs } from "../src/watchdogs";
import { Workspace } from "../src/workspace";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

function emptyReport(over: Partial<ProgramReport> = {}): ProgramReport {
  return { deploy: null, ticks: 0, longestTickMs: 0, overruns: 0, errors: [], requests: [], milestones: [], logs: [], logLines: 0, hints: [], ...over };
}

/** A sandbox that hosts a pretend program: deploys succeed, reports are whatever the test queues. */
function fakeProgramSandbox() {
  const listeners = new Set<(e: ProgramHostEvent) => void>();
  const queued: ProgramReport[] = [];
  const deploys: DeployRecord[] = [];
  let deployCount = 0;
  let unloaded = 0;
  const fake = {
    programState: { kind: "none" } as ProgramState,
    evalSnippet: (code: string): Promise<SnippetResult> => Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
    onProgramEvent: (l: (e: ProgramHostEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    programReport: () => Promise.resolve(queued.shift() ?? emptyReport()),
    deployAtYield: async (): Promise<DeployRecord | null> => {
      deployCount++;
      const rec: DeployRecord = { deploy: deployCount, version: deployCount, ok: true, exports: ["loop"], action: "load" };
      fake.programState = { kind: "running", deploy: deployCount, version: deployCount, at: T0 };
      deploys.push(rec);
      return rec;
    },
    unloadProgram: async () => {
      unloaded++;
    },
  };
  return {
    sandbox: fake as unknown as SandboxHost,
    emit: (e: ProgramHostEvent) => {
      for (const l of listeners) l(e);
    },
    queue: (r: ProgramReport) => queued.push(r),
    deploys,
    unloaded: () => unloaded,
  };
}

/**
 * The fake, able to deploy on a save as the real host does: main.ts and
 * anything under lib/ are the program's files, the next save's load fails
 * after `failNext()`, and the yield finds nothing left to load.
 */
function withSaveDeploys(fake: ReturnType<typeof fakeProgramSandbox>) {
  const sb = fake.sandbox as unknown as { programState: ProgramState } & Record<string, unknown>;
  const saves: string[] = [];
  let count = 0;
  let failNext = false;
  let failed: number | null = null;
  sb["deployOnSave"] = async (path: string): Promise<DeployRecord | null> => {
    saves.push(path);
    if (path !== "main.ts" && !path.startsWith("lib/")) return null;
    count++;
    if (failNext) {
      failNext = false;
      failed = count;
      return { deploy: count, version: count, ok: false, error: 'BuildMessage: Could not resolve "./lib/gen" at main.ts:1:21', action: "load" };
    }
    failed = null;
    sb.programState = { kind: "running", deploy: count, version: count, at: T0 };
    return { deploy: count, version: count, ok: true, exports: ["loop", "on.WB_MOVE_RESULT"], action: "load" };
  };
  sb["deployAtYield"] = async (): Promise<DeployRecord | null> => null;
  sb["programEdits"] = () => ({ editsSinceDeploy: failed !== null, failedDeploy: failed });
  return { saves, failNext: () => void (failNext = true) };
}

function setup(adapter: ChatAdapter, opts: { watchdogs?: Record<string, unknown>; onSleep?: (now: number) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-loopep-"));
  const config = {
    ...loadRunConfig({
      driver: "stub",
      episode: "probing",
      loop: "entrypoint",
      stepIntervalMs: 0,
      stateIntervalMs: 1,
      ...(opts.watchdogs !== undefined ? { watchdogs: opts.watchdogs } : {}),
    }),
    runId: "run-ep",
    token: "run-ep",
  };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-ep", harnessVersion: "t", startedAt: T0, config });
  let now = T0;
  const clock = () => now;
  const fake = fakeProgramSandbox();
  const abort = new AbortController();
  return {
    dir,
    fake,
    abort,
    clock,
    options: {
      config,
      adapter,
      sandbox: fake.sandbox,
      workspace: new Workspace(join(dir, "workspace"), { memory: true }),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs, clock),
      now: clock,
      signal: abort.signal,
      sleep: async (ms: number) => {
        now += ms;
        opts.onSleep?.(now);
      },
    },
  };
}

/** The user message (the fresh context) of the n-th request record. */
function userMessage(dir: string, n: number): string {
  const req = readTrajectory(dir).filter((r) => r.t === "request")[n]!;
  const messages = req["messages"] as { role: string; content: string }[];
  return messages.at(-1)!.content;
}

describe("the entrypoint loop's phases", () => {
  test("a reply with no tool call ends the wake, deploys, sleeps to the fallback, and the next request carries the new [wake] block", async () => {
    const adapter = new StubAdapter([
      { content: "writing", toolCalls: [{ name: "write_file", arguments: { path: "main.ts", content: "export function loop() {}\n" } }] },
      { content: "done for now", toolCalls: [] },
      { content: "still fine", toolCalls: [] },
    ]);
    const { dir, options, fake } = setup(adapter);
    const outcome = await runLoop(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "stub-complete" });
    const records = readTrajectory(dir);
    const kinds = records.filter((r) => ["wake", "wake_end", "deploy", "request"].includes(r.t)).map((r) => `${r.t}:${String(r["wake"])}`);
    expect(kinds).toEqual([
      "wake:1",
      "request:1",
      "request:1",
      "wake_end:1",
      "deploy:1",
      "wake:2",
      "request:2",
      "wake_end:2",
      "deploy:2",
      "wake:3",
      "request:3",
      "wake_end:3",
    ]);
    // The last ledger is flushed when the run stops, mid-wake here.
    expect(records.filter((r) => r.t === "wake_end").at(-1)).toMatchObject({ wake: 3, requests: 1, reason: "run_end" });
    const wakes = records.filter((r) => r.t === "wake");
    expect(wakes.map((w) => [w["turn"], w["reasons"], w["sleptMs"]])).toEqual([
      [1, ["start"], 0],
      [3, ["fallback"], FALLBACK_WAKE_MS],
      [4, ["fallback"], FALLBACK_WAKE_MS],
    ]);
    expect(records.find((r) => r.t === "wake_end")).toMatchObject({ wake: 1, requests: 2, reason: "yield" });
    expect(records.find((r) => r.t === "deploy")).toMatchObject({ wake: 1, trigger: "yield", deploy: 1, ok: true, action: "load" });
    // Every yield asks the host; whether anything loads is the host's call (this fake always loads).
    expect(fake.deploys).toHaveLength(2);
    // Every response carries its wake too.
    expect(records.filter((r) => r.t === "response").map((r) => r["wake"])).toEqual([1, 1, 2]);

    const first = userMessage(dir, 0);
    expect(first.split("\n")[0]).toBe(
      "[turn 1] Goal: survive and level as far as you can. Act via tools and your program; end your turn by replying without a tool call.",
    );
    expect(first).toContain("[wake 1 · request 1 of 20 in this wake · woke for: start]\nprogram: none · write main.ts; it loads when you save it");
    // Re-rendered on every request of the wake.
    expect(userMessage(dir, 1)).toContain("[wake 1 · request 2 of 20 in this wake · woke for: start]");
    const woken = userMessage(dir, 2);
    expect(woken).toContain("[wake 2 · request 1 of 20 in this wake · asleep 5m00s · woke for: fallback]");
    expect(woken).toContain("program: main.ts deploy 1 (12:00:00), running");
    // The block sits right after the goal line and before the state summary.
    expect(woken.indexOf("[wake 2")).toBeLessThan(woken.indexOf("[workspace") === -1 ? Infinity : woken.indexOf("<workspace>"));
    expect(fake.unloaded()).toBe(1);
  });

  test("a report with a new error wakes the model early, after the coalescing window, and the block shows it", async () => {
    const adapter = new StubAdapter([
      { content: "done", toolCalls: [] },
      { content: "seen it", toolCalls: [] },
    ]);
    let fired = false;
    const ctx = setup(adapter, {
      onSleep: (now) => {
        if (!fired && now >= T0 + 30_000) {
          fired = true;
          ctx.fake.emit({
            kind: "report",
            report: emptyReport({
              deploy: 1,
              ticks: 30,
              longestTickMs: 12,
              errors: [
                {
                  signature: "loop() TypeError at loop (main.ts:9:5)",
                  hook: "loop()",
                  kind: "thrown",
                  text: "TypeError: boom\n    at loop (main.ts:9:5)",
                  count: 4,
                  isNew: true,
                  deploy: 1,
                  firstTs: now,
                  lastTs: now,
                },
              ],
            }),
          });
        }
      },
    });
    const { dir, options } = ctx;
    await runLoop(options);
    const records = readTrajectory(dir);
    const second = records.filter((r) => r.t === "wake")[1]!;
    expect(second["reasons"]).toEqual(["error"]);
    expect(second["sleptMs"]).toBe(30_000 + WAKE_COALESCE_MS);
    const woken = userMessage(dir, 1);
    expect(woken).toContain("woke for: error]");
    expect(woken).toContain("- loop() TypeError: boom ×4");
    expect(woken).toContain("    at loop (main.ts:9:5)");
    expect(woken).toContain("30 ticks since you ended your turn");
    // Recorded once, as the wake it was seen in ended.
    expect(records.filter((r) => r.t === "program_error")).toEqual([
      expect.objectContaining({ wake: 2, signature: "loop() TypeError at loop (main.ts:9:5)", kind: "thrown", count: 4, deploy: 1 }),
    ]);
  });

  test("an ok:false answer the program got is shown and written as an outcome, and does not wake the model", async () => {
    const adapter = new StubAdapter([
      { content: "done", toolCalls: [] },
      { content: "seen it", toolCalls: [] },
    ]);
    let fired = false;
    const ctx = setup(adapter, {
      onSleep: (now) => {
        if (!fired && now >= T0 + 20_000) {
          fired = true;
          ctx.fake.emit({
            kind: "report",
            report: emptyReport({
              deploy: 1,
              errors: [
                {
                  signature: "loop() sdk.killTarget timeout",
                  hook: "loop()",
                  kind: "outcome",
                  text: 'sdk.killTarget() returned ok:false, status "timeout" — still up after 30s\n    at hunt (lib/brain.ts:88:21)',
                  count: 3,
                  isNew: false,
                  deploy: 1,
                  firstTs: now,
                  lastTs: now,
                },
              ],
            }),
          });
        }
      },
    });
    await runLoop(ctx.options);
    const records = readTrajectory(ctx.dir);
    // Slept on to the fallback: the answer is information, not a reason to wake.
    expect(records.filter((r) => r.t === "wake")[1]).toMatchObject({ reasons: ["fallback"], sleptMs: FALLBACK_WAKE_MS });
    expect(userMessage(ctx.dir, 1)).toContain(
      'outcomes:\n- loop() sdk.killTarget() returned ok:false, status "timeout" — still up after 30s ×3 (first 12:00:20, last 12:00:20)\n    at hunt (lib/brain.ts:88:21)',
    );
    expect(userMessage(ctx.dir, 1)).not.toContain("errors:");
    expect(records.filter((r) => r.t === "program_error")).toEqual([
      expect.objectContaining({ wake: 2, signature: "loop() sdk.killTarget timeout", hook: "loop()", kind: "outcome", count: 3, deploy: 1 }),
    ]);
  });

  test("memory.json is shown on a wake's first request and when it changed, and is one line while it has not", async () => {
    const stub = new StubAdapter([
      { content: "look", toolCalls: [{ name: "state_summary", arguments: {} }] },
      { content: "look again", toolCalls: [{ name: "state_summary", arguments: {} }] },
      { content: "done", toolCalls: [] },
      { content: "woken", toolCalls: [] },
    ]);
    let calls = 0;
    let ws: Workspace | undefined;
    const adapter = {
      label: "stub",
      complete: async (req: Parameters<StubAdapter["complete"]>[0]) => {
        calls++;
        // The program saves between the second and the third request.
        if (calls === 2) ws!.writeMemory('{"phase":"rest"}');
        return stub.complete(req);
      },
    };
    const ctx = setup(adapter);
    ws = ctx.options.workspace;
    ws.writeMemory('{"phase":"grind"}');
    await runLoop(ctx.options);
    const memoryPart = (n: number): string => {
      const m = userMessage(ctx.dir, n);
      return m.slice(m.indexOf("[memory.json")).split("\n").slice(0, 2).join("\n");
    };
    expect(memoryPart(0)).toBe('[memory.json, 17 chars]\n{"phase":"grind"}');
    expect(memoryPart(1).split("\n")[0]).toBe("[memory.json unchanged, 17 chars]");
    expect(memoryPart(2)).toBe('[memory.json, 16 chars]\n{"phase":"rest"}');
    // A new wake shows it again, changed or not.
    expect(memoryPart(3)).toBe('[memory.json, 16 chars]\n{"phase":"rest"}');
  });

  test(`a wake ends at ${WAKE_MAX_REQUESTS} requests, and the next one says so`, async () => {
    const turns = Array.from({ length: WAKE_MAX_REQUESTS + 1 }, () => ({ content: "busy", toolCalls: [{ name: "state_summary", arguments: {} }] }));
    const { dir, options } = setup(new StubAdapter(turns));
    await runLoop(options);
    const records = readTrajectory(dir);
    expect(records.find((r) => r.t === "wake_end")).toMatchObject({ wake: 1, requests: WAKE_MAX_REQUESTS, reason: "cap" });
    expect(userMessage(dir, WAKE_MAX_REQUESTS)).toContain(`(your last wake ended at the ${WAKE_MAX_REQUESTS}-request cap`);
    // Every request states the cap, so the last one is known before it is made.
    expect(userMessage(dir, 0)).toContain(`[wake 1 · request 1 of ${WAKE_MAX_REQUESTS} in this wake · woke for: start]`);
    expect(userMessage(dir, WAKE_MAX_REQUESTS - 1)).toContain(
      `[wake 1 · request ${WAKE_MAX_REQUESTS} of ${WAKE_MAX_REQUESTS} in this wake · woke for: start]`,
    );
  });

  test("the pre-trim ask names ending the turn as the other way through; the snippet loop's keeps its bytes", async () => {
    expect(TRIM_PENDING_NOTICE).toBe(
      "Older conversation will be trimmed after this turn. Record a short status entry — what you are doing and how it is going — with log_status.",
    );
    expect(TRIM_PENDING_NOTICE_ENTRYPOINT).toBe(
      "Older conversation will be trimmed after this reply, whether or not it ends your turn. Record a short status entry — what you are doing and how it is going — with log_status, or end your turn without one.",
    );
    // Growth varies per request, and the cap ends wakes along the way, as a real run's would.
    const turns = Array.from({ length: 50 }, (_, i) => ({
      content: "busy",
      toolCalls: Array.from({ length: [1, 3, 2, 1][i % 4]! }, () => ({ name: "state_summary", arguments: {} })),
    }));
    const { dir, options } = setup(new StubAdapter(turns));
    await runLoop(options);
    const requests = readTrajectory(dir).filter((r) => r.t === "request");
    const messages = requests.map((_, i) => userMessage(dir, i));
    const asked = messages.filter((m) => m.includes("- trim_pending: "));
    expect(asked.length).toBeGreaterThanOrEqual(2);
    for (const m of asked) expect(m).toContain(`- trim_pending: ${TRIM_PENDING_NOTICE_ENTRYPOINT}`);
    expect(messages.some((m) => m.includes(TRIM_PENDING_NOTICE))).toBe(false);
  });

  test("a stop while asleep ends the run at once with its own verdict", async () => {
    const adapter = new StubAdapter([{ content: "done", toolCalls: [] }]);
    const ctx = setup(adapter, {
      onSleep: (now) => {
        if (now >= T0 + 60_000 && !ctx.abort.signal.aborted) {
          ctx.abort.abort({ kind: "pause", reason: "operator-pause", detail: "SIGTERM: supervisor stop" } satisfies StopRequest);
        }
      },
    });
    const outcome = await runLoop(ctx.options);
    expect(outcome).toEqual({ kind: "paused", reason: "operator-pause", detail: "SIGTERM: supervisor stop" });
    expect(readTrajectory(ctx.dir).filter((r) => r.t === "wake")).toHaveLength(1);
  });

  test("the watchdogs are served while asleep, and idle never fires on a sleeping model", async () => {
    const adapter = new StubAdapter([{ content: "done", toolCalls: [] }, { content: "again", toolCalls: [] }]);
    // Idle shorter than the fallback: sleeping is not idling.
    const idle = setup(adapter, { watchdogs: { idleMs: 60_000 } });
    expect(await runLoop(idle.options)).toEqual({ kind: "terminated", reason: "stub-complete" });
    // The episode clock runs out mid-sleep: the sleep ends with it.
    const limited = setup(new StubAdapter([{ content: "done", toolCalls: [] }]), { watchdogs: { episodeMs: 90_000 } });
    const outcome = await runLoop(limited.options);
    expect(outcome.kind).toBe("terminated");
    expect(outcome.kind === "terminated" ? outcome.reason : null).toBe("episode-limit");
    expect(readTrajectory(limited.dir).some((r) => r.t === "watchdog" && r["reason"] === "episode-limit")).toBe(true);
  });

  test("a program that blocks on every deploy ends the run as snippet-runaway, however many ticks it completes first", async () => {
    const yields = () => new StubAdapter(Array.from({ length: 6 }, () => ({ content: "done", toolCalls: [] })));
    const halt = (fake: ReturnType<typeof fakeProgramSandbox>, now: number): void => {
      (fake.sandbox as unknown as { totalRestarts: number }).totalRestarts++;
      fake.emit({ kind: "halted", deploy: 1, at: now });
    };
    // Ticks, then a halt, on every deploy: the ticks never clear the count.
    const blocking = setup(yields(), {
      watchdogs: { maxSandboxRestarts: 2 },
      onSleep: (now) => {
        if (now === T0 + 8_000 || now === T0 + 38_000) blocking.fake.emit({ kind: "report", report: emptyReport({ deploy: 1, ticks: 5 }) });
        if (now === T0 + 10_000 || now === T0 + 40_000) halt(blocking.fake, now);
      },
    });
    expect(await runLoop(blocking.options)).toEqual({ kind: "terminated", reason: "snippet-runaway", detail: "2 consecutive sandbox restarts" });
    const wakes = readTrajectory(blocking.dir).filter((r) => r.t === "wake");
    expect(wakes[1]!["reasons"]).toEqual(["halted"]);
    const ends = readTrajectory(blocking.dir).filter((r) => r.t === "wake_end");
    expect(ends.reduce((n, r) => n + (r["halts"] as number), 0)).toBe(2);
    expect(ends.reduce((n, r) => n + (r["ticks"] as number), 0)).toBe(10);

    // A healthy program with the odd halt: a sleep that ends with it running
    // and no restart since the yield clears the count in between.
    const healthy = setup(yields(), {
      watchdogs: { maxSandboxRestarts: 2 },
      onSleep: (now) => {
        if (now === T0 + 10_000 || now === T0 + 400_000) halt(healthy.fake, now);
      },
    });
    expect(await runLoop(healthy.options)).toEqual({ kind: "terminated", reason: "stub-complete" });
  });

  test("a report that lands while the yielding reply is in flight reaches the next wake, and the ledger counts it once", async () => {
    const late = {
      signature: "loop() TypeError at loop (main.ts:9:5)",
      hook: "loop()",
      kind: "thrown" as const,
      text: "TypeError: late\n    at loop (main.ts:9:5)",
      isNew: true,
      deploy: 1,
      firstTs: T0,
      lastTs: T0,
    };
    let calls = 0;
    let emit: (e: ProgramHostEvent) => void = () => {};
    const stub = new StubAdapter([
      { content: "working", toolCalls: [{ name: "state_summary", arguments: {} }] },
      { content: "done", toolCalls: [] },
      { content: "seen", toolCalls: [] },
    ]);
    const adapter = {
      label: "stub",
      complete: async (req: Parameters<StubAdapter["complete"]>[0]) => {
        calls++;
        // The first request's block shows 2; one more lands during the second (yielding) request.
        if (calls === 1) emit({ kind: "report", report: emptyReport({ deploy: 1, errors: [{ ...late, count: 2 }] }) });
        if (calls === 2) emit({ kind: "report", report: emptyReport({ deploy: 1, errors: [{ ...late, count: 1, isNew: false }, { ...late, signature: "on.SMSG_X Error", hook: "on.SMSG_X", text: "Error: during the reply", count: 1 }] }) });
        return stub.complete(req);
      },
    };
    const ctx = setup(adapter);
    emit = ctx.fake.emit;
    await runLoop(ctx.options);
    const records = readTrajectory(ctx.dir);
    const second = records.filter((r) => r.t === "wake")[1]!;
    expect(second["reasons"]).toEqual(["error"]);
    const woken = userMessage(ctx.dir, 2);
    expect(woken).toContain("- on.SMSG_X Error: during the reply");
    expect(woken).toContain("- loop() TypeError: late (at");
    const counts = new Map<string, number>();
    for (const r of records.filter((x) => x.t === "program_error")) {
      counts.set(r["signature"] as string, (counts.get(r["signature"] as string) ?? 0) + (r["count"] as number));
    }
    expect(Object.fromEntries(counts)).toEqual({ "loop() TypeError at loop (main.ts:9:5)": 3, "on.SMSG_X Error": 1 });
  });

  test("the minimum sleep holds even for a reason that arrives at once", async () => {
    const adapter = new StubAdapter([{ content: "done", toolCalls: [] }, { content: "seen", toolCalls: [] }]);
    const ctx = setup(adapter);
    ctx.fake.queue(emptyReport());
    const origDeploy = (ctx.fake.sandbox as unknown as { deployAtYield: () => Promise<DeployRecord | null> }).deployAtYield;
    (ctx.fake.sandbox as unknown as { deployAtYield: () => Promise<DeployRecord | null> }).deployAtYield = async () => {
      const rec = await origDeploy();
      return rec === null ? null : { ...rec, ok: false, error: "BuildMessage: Unexpected ; at main.ts:1:1 — ;" };
    };
    await runLoop(ctx.options);
    const second = readTrajectory(ctx.dir).filter((r) => r.t === "wake")[1]!;
    expect(second["reasons"]).toEqual(["load"]);
    expect(second["sleptMs"]).toBe(MIN_SLEEP_MS);
    expect(userMessage(ctx.dir, 1)).toContain("deploy 1 failed to load (12:00:00)");
  });
});

describe("the entrypoint loop deploys on a save", () => {
  const write = (path: string, content: string) => ({ name: "write_file", arguments: { path, content } });

  test("a save that changes the program deploys at once: its result says so, the record names the save, and the yield loads nothing more", async () => {
    const adapter = new StubAdapter([
      {
        content: "writing",
        toolCalls: [
          write("./main.ts", 'export { loop, on } from "./lib/engine";\n'),
          write("main.ts", 'export { loop, on } from "./lib/engine";\n'),
          write("notes.md", "plan"),
          write("lib/engine.ts", "export function loop() {}\nexport const on = { WB_MOVE_RESULT() {} };\n"),
          { name: "edit_file", arguments: { path: "lib/engine.ts", old_string: "loop() {}", new_string: "loop() { return 1; }" } },
        ],
      },
      { content: "done", toolCalls: [] },
      { content: "woken", toolCalls: [] },
    ]);
    const ctx = setup(adapter);
    const saves = withSaveDeploys(ctx.fake);
    await runLoop(ctx.options);
    // The same text again is not a save; notes.md is, and the host finds it is not the program's.
    expect(saves.saves).toEqual(["main.ts", "notes.md", "lib/engine.ts", "lib/engine.ts"]);
    const records = readTrajectory(ctx.dir);
    const results = records.filter((r) => r.t === "tool_result").map((r) => r["text"] as string);
    expect(results[0]).toBe(
      "created main.ts\n[0% — 41/32000 chars]\ndeploy 1 loaded (12:00:00, version 1) and runs now; exports loop, on.WB_MOVE_RESULT",
    );
    expect(results[1]).toBe("wrote main.ts\n[0% — 41/32000 chars]");
    expect(results[2]).not.toContain("deploy");
    expect(results[4]).toContain("edited lib/engine.ts (1 replacement)");
    expect(results[4]).toContain("\ndeploy 3 loaded (12:00:00, version 3) and runs now");
    expect(records.filter((r) => r.t === "tool_result").every((r) => r["isError"] === false)).toBe(true);
    expect(records.filter((r) => r.t === "deploy")).toEqual([
      expect.objectContaining({ wake: 1, trigger: "save", tool: "write_file", path: "main.ts", deploy: 1, ok: true }),
      expect.objectContaining({ wake: 1, trigger: "save", tool: "write_file", path: "lib/engine.ts", deploy: 2, ok: true }),
      expect.objectContaining({ wake: 1, trigger: "save", tool: "edit_file", path: "lib/engine.ts", deploy: 3, ok: true }),
    ]);
    // The next wake's program line is the save's deploy, with nothing waiting on the yield.
    expect(userMessage(ctx.dir, 2)).toContain("program: main.ts deploy 3 (12:00:00), running");
    expect(userMessage(ctx.dir, 2)).toContain("· no edits since deploy");
  });

  test("a save that fails to load is reported in its result alone: no wake for it, a sleep to the fallback, and a program line that says which deploy failed", async () => {
    const adapter = new StubAdapter([
      { content: "start", toolCalls: [write("main.ts", "export function loop() {}\n")] },
      { content: "half a change", toolCalls: [write("main.ts", 'import { gen } from "./lib/gen";\nexport function loop() { return gen; }\n')] },
      { content: "done", toolCalls: [] },
      { content: "woken", toolCalls: [] },
    ]);
    const ctx = setup(adapter);
    const saves = withSaveDeploys(ctx.fake);
    let calls = 0;
    const complete = adapter.complete.bind(adapter);
    adapter.complete = async (req) => {
      if (++calls === 2) saves.failNext();
      return complete(req);
    };
    await runLoop(ctx.options);
    const records = readTrajectory(ctx.dir);
    const failed = records.filter((r) => r.t === "tool_result")[1]!;
    expect(failed["isError"]).toBe(false);
    expect(failed["text"]).toContain(
      'deploy 2 failed to load (12:00:00, version 2); deploy 1 keeps running:\n    BuildMessage: Could not resolve "./lib/gen" at main.ts:1:21',
    );
    expect(records.filter((r) => r.t === "deploy").at(-1)).toMatchObject({ trigger: "save", tool: "write_file", path: "main.ts", deploy: 2, ok: false });
    // Not a reason to wake: the model sleeps to the fallback, not the five-second floor.
    expect(records.filter((r) => r.t === "wake")[1]).toMatchObject({ reasons: ["fallback"], sleptMs: FALLBACK_WAKE_MS });
    expect(records.some((r) => r.t === "program_error")).toBe(false);
    const woken = userMessage(ctx.dir, 3);
    expect(woken).toContain("program: main.ts deploy 1 (12:00:00), running");
    expect(woken).toContain("edits since deploy: yes, they failed to load as deploy 2");
    expect(woken).not.toContain("failed to load (");
  });

  test("a reload after a restart is recorded with what triggered it", async () => {
    const adapter = new StubAdapter([{ content: "done", toolCalls: [] }, { content: "woken", toolCalls: [] }]);
    let fired = false;
    const ctx = setup(adapter, {
      onSleep: (now) => {
        if (fired) return;
        fired = true;
        ctx.fake.emit({ kind: "reload", deploy: 1, version: 1, at: now, answer: { ok: true, deploy: 1, exports: ["loop"] } });
      },
    });
    await runLoop(ctx.options);
    // This fake loads at every yield, so the second wake's yield adds a third.
    expect(readTrajectory(ctx.dir).filter((r) => r.t === "deploy").slice(0, 2)).toEqual([
      expect.objectContaining({ trigger: "yield", deploy: 1 }),
      expect.objectContaining({ trigger: "restart", reload: true, deploy: 1, ok: true }),
    ]);
  });
});

describe("the snippet loop is untouched", () => {
  test("no wake records, no wake field, and a reply without a tool call is just the next turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-loopsn-"));
    const config = { ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1 }), runId: "run-sn", token: "run-sn" };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-sn", harnessVersion: "t", startedAt: T0, config });
    const fake = fakeProgramSandbox();
    await runLoop({
      config,
      adapter: new StubAdapter([{ content: "hm", toolCalls: [] }, { content: "hm", toolCalls: [] }]),
      sandbox: fake.sandbox,
      workspace: new Workspace(join(dir, "workspace")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    });
    const records = readTrajectory(dir);
    expect(records.some((r) => ["wake", "wake_end", "deploy", "program_error"].includes(r.t))).toBe(false);
    expect(records.filter((r) => r.t === "request" || r.t === "response").some((r) => "wake" in r)).toBe(false);
    expect(fake.deploys).toHaveLength(0);
    expect(userMessage(dir, 0).split("\n")[0]).toBe("[turn 1] Goal: survive and level as far as you can. Act via tools.");
  });
});
