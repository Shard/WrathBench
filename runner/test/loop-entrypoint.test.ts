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
import { runLoop, type StopRequest } from "../src/loop";
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
    expect(records.find((r) => r.t === "deploy")).toMatchObject({ wake: 1, deploy: 1, ok: true, action: "load" });
    // Every yield asks the host; whether anything loads is the host's call (this fake always loads).
    expect(fake.deploys).toHaveLength(2);
    // Every response carries its wake too.
    expect(records.filter((r) => r.t === "response").map((r) => r["wake"])).toEqual([1, 1, 2]);

    const first = userMessage(dir, 0);
    expect(first.split("\n")[0]).toBe(
      "[turn 1] Goal: survive and level as far as you can. Act via tools and your program; end your turn by replying without a tool call.",
    );
    expect(first).toContain("[wake 1 · request 1 of this wake · woke for: start]\nprogram: none · write main.ts; it loads when you end your turn");
    // Re-rendered on every request of the wake.
    expect(userMessage(dir, 1)).toContain("[wake 1 · request 2 of this wake · woke for: start]");
    const woken = userMessage(dir, 2);
    expect(woken).toContain("[wake 2 · request 1 of this wake · asleep 5m00s · woke for: fallback]");
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
      expect.objectContaining({ wake: 2, signature: "loop() TypeError at loop (main.ts:9:5)", count: 4, deploy: 1 }),
    ]);
  });

  test(`a wake ends at ${WAKE_MAX_REQUESTS} requests, and the next one says so`, async () => {
    const turns = Array.from({ length: WAKE_MAX_REQUESTS + 1 }, () => ({ content: "busy", toolCalls: [{ name: "state_summary", arguments: {} }] }));
    const { dir, options } = setup(new StubAdapter(turns));
    await runLoop(options);
    const records = readTrajectory(dir);
    expect(records.find((r) => r.t === "wake_end")).toMatchObject({ wake: 1, requests: WAKE_MAX_REQUESTS, reason: "cap" });
    expect(userMessage(dir, WAKE_MAX_REQUESTS)).toContain(`(your last wake ended at the ${WAKE_MAX_REQUESTS}-request cap`);
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
