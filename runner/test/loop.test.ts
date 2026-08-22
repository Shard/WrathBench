/**
 * Agent loop against the stub adapter and a fake sandbox: termination reasons,
 * trajectory records, message-window mechanics. No live stack, no real model.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubAdapter, type ChatAdapter, type ChatRequest, type AdapterOutcome } from "../src/adapter";
import { parseEventFrame, StateCache } from "@wrathbench/sdk";
import { loadRunConfig } from "../src/config";
import { toJsonSafe } from "../src/jsonsafe";
import { runLoop } from "../src/loop";
import { Scratchpad } from "../src/scratchpad";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";

function fakeSandbox(snapshot: Record<string, unknown> = {}): SandboxHost {
  const fake = {
    evalSnippet: (code: string): Promise<SnippetResult> =>
      Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () =>
      Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0, ...snapshot }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  };
  return fake as unknown as SandboxHost;
}

function setup(
  adapter: ChatAdapter,
  extraConfig: Record<string, unknown> = {},
  snapshot: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-loop-"));
  const config = {
    ...loadRunConfig({ adapter: "stub", stepIntervalMs: 0, stateIntervalMs: 1, ...extraConfig }),
    runId: "run-test",
    token: "run-test",
  };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  return {
    dir,
    options: {
      config,
      adapter,
      sandbox: fakeSandbox(snapshot),
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    },
  };
}

describe("runLoop", () => {
  test("stub script runs tool calls, then terminates stub-complete", async () => {
    const adapter = new StubAdapter([
      { content: "acting", toolCalls: [{ name: "run_snippet", arguments: { code: "1+1" } }] },
      { content: null, toolCalls: [{ name: "write_scratchpad", arguments: { content: "# hi" } }] },
    ]);
    const { dir, options } = setup(adapter);
    const outcome = await runLoop(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "stub-complete" });
    const records = readTrajectory(dir);
    const types = records.map((r) => r.t);
    expect(types.filter((t) => t === "request")).toHaveLength(3);
    expect(types).toContain("snippet");
    expect(types).toContain("snippet_result");
    expect(types).toContain("tool_call");
    expect(types).toContain("termination");
    const snippetResult = records.find((r) => r.t === "snippet_result");
    expect(snippetResult?.["text"]).toContain("ran:1+1");
    expect(options.scratchpad.read()).toBe("# hi");
    const row = options.trajectory.runRow("run-test");
    expect(row?.["termination_reason"]).toBe("stub-complete");
    options.trajectory.close();
  });

  test("snippet trajectory entry logs the normalized code when an alias key was used", async () => {
    const adapter = new StubAdapter([
      { content: "acting", toolCalls: [{ name: "run_snippet", arguments: { snippet: "await connect()" } }] },
    ]);
    const { dir, options } = setup(adapter);
    await runLoop(options);
    const snippet = readTrajectory(dir).find((r) => r.t === "snippet");
    // The alias (snippet->code) is normalized before dispatch; the record must
    // carry the real source, not "".
    expect(snippet?.["code"]).toBe("await connect()");
    const result = readTrajectory(dir).find((r) => r.t === "snippet_result");
    expect(result?.["text"]).toContain("ran:await connect()");
    options.trajectory.close();
  });

  test("money and quest turn-ins reach the state row and the trajectory", async () => {
    const adapter = new StubAdapter([{ content: "acting", toolCalls: [] }]);
    const { dir, options } = setup(
      adapter,
      {},
      {
        money: { value: 12345, seq: 34, ts: 1 },
        questCompletions: [
          { questId: 7, xp: 400, money: 250, seq: 49, ts: 2 },
          { questId: 9, xp: 10, money: 0, seq: 50, ts: 3 },
        ],
      },
    );
    await runLoop(options);
    const rows = options.trajectory.stateRows("run-test");
    expect(rows[0]!["money"]).toBe(12345);
    expect(rows[0]!["quests_completed"]).toBe(2);
    // One compact record per completion, logged once even across several samples.
    const done = readTrajectory(dir).filter((r) => r.t === "quest_complete");
    expect(done.map((r) => r["questId"])).toEqual([7, 9]);
    options.trajectory.close();
  });

  test("quest-completion high-water mark resets after a sandbox restart (shorter list)", async () => {
    // Three samples: the completion list grows [7,9], stays, then SHRINKS to
    // [11] — the sandbox-restart/cache-rebuild case. Without the reset at
    // loop.ts:108 the rebuilt completion would never be re-logged.
    const snapshots: Record<string, unknown>[] = [
      { self: {}, questCompletions: [{ questId: 7 }, { questId: 9 }] },
      { self: {}, questCompletions: [{ questId: 7 }, { questId: 9 }] },
      { self: {}, questCompletions: [{ questId: 11 }] },
    ];
    let i = 0;
    const sandbox = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () =>
        Promise.resolve({ lastSeq: -1, eventCount: 0, ...(snapshots[Math.min(i++, snapshots.length - 1)]!) }),
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;

    const adapter = new StubAdapter([
      { content: "t1", toolCalls: [] },
      { content: "t2", toolCalls: [] },
      { content: "t3", toolCalls: [] },
    ]);
    const { dir, options } = setup(adapter, { stateIntervalMs: 1 });
    options.sandbox = sandbox;
    // Advancing clock so each turn's sample clears the stateIntervalMs gate.
    let clock = 0;
    (options as { now?: () => number }).now = () => (clock += 1000);
    await runLoop(options);
    // Guard: all three samples recorded (each turn cleared the interval gate).
    expect(options.trajectory.stateRows("run-test").length).toBeGreaterThanOrEqual(3);
    // 7 and 9 logged once each on growth; 11 logged after the shrink-triggered
    // reset — not swallowed by the high-water mark.
    const done = readTrajectory(dir).filter((r) => r.t === "quest_complete");
    expect(done.map((r) => r["questId"])).toEqual([7, 9, 11]);
    options.trajectory.close();
  });

  test("the new signals survive the real snapshot serializer, not just the stub", async () => {
    // The sandbox answers the state rpc with toJsonSafe(state.snapshot(), 6).
    // Stubbing the payload proves loop.ts reads it; this proves the SDK's own
    // snapshot still carries both signals once it has been through that.
    const cache = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
    for (const frame of [
      {
        seq: 1,
        opcode: "SMSG_UPDATE_OBJECT",
        opcodeId: 0x0a9,
        ts: 1,
        data: {
          blocks: 1,
          objects: [{ update: "values", guid: "7", fields: { money: 12345 } }],
        },
      },
      {
        seq: 2,
        opcode: "SMSG_QUESTGIVER_QUEST_COMPLETE",
        opcodeId: 0x191,
        ts: 2,
        data: { questId: 7, xp: 400, money: 250 },
      },
    ]) {
      const parsed = parseEventFrame(JSON.stringify(frame));
      if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
      cache.apply(parsed.event);
    }
    const wire = toJsonSafe(cache.snapshot(), 6) as Record<string, unknown>;

    const { options } = setup(new StubAdapter([{ content: "acting", toolCalls: [] }]), {}, wire);
    await runLoop(options);
    const row = options.trajectory.stateRows("run-test")[0]!;
    expect(row["money"]).toBe(12345);
    expect(row["quests_completed"]).toBe(1);
    options.trajectory.close();
  });

  test("maxTurns terminates as turn-limit", async () => {
    const adapter = new StubAdapter(
      Array.from({ length: 10 }, () => ({ content: "thinking", toolCalls: [] })),
    );
    const { options } = setup(adapter, { maxTurns: 2 });
    const outcome = await runLoop(options);
    expect(outcome.kind).toBe("terminated");
    expect(outcome.kind === "terminated" && outcome.reason).toBe("turn-limit");
    options.trajectory.close();
  });

  test("a pause outcome suspends the run resumably", async () => {
    const pausing: ChatAdapter = {
      label: "pausing",
      complete: (_req: ChatRequest): Promise<AdapterOutcome> =>
        Promise.resolve({ kind: "pause", reason: "quota-exhausted", detail: "429 quota" }),
    };
    const { options } = setup(pausing);
    const outcome = await runLoop(options);
    expect(outcome).toEqual({ kind: "paused", reason: "quota-exhausted", detail: "429 quota" });
    expect(options.trajectory.runRow("run-test")?.["pause_reason"]).toBe("quota-exhausted");
    expect(options.trajectory.runRow("run-test")?.["termination_reason"]).toBeNull();
    options.trajectory.close();
  });

  test("an adapter throwing mid-run terminates as adapter-error", async () => {
    const { AdapterError } = await import("../src/adapter");
    const broken: ChatAdapter = {
      label: "broken",
      complete: () => Promise.reject(new AdapterError("HTTP 400: bad request", 400)),
    };
    const { options } = setup(broken);
    const outcome = await runLoop(options);
    expect(outcome.kind === "terminated" && outcome.reason).toBe("adapter-error");
    options.trajectory.close();
  });

  test("provider-reported usage lands on the response record; absence stays absent", async () => {
    let call = 0;
    const withUsage: ChatAdapter = {
      label: "usage",
      complete: (): Promise<AdapterOutcome> => {
        call++;
        if (call > 2) return Promise.resolve({ kind: "stub-complete" });
        return Promise.resolve({
          kind: "ok",
          turn: {
            content: "ok",
            toolCalls: [],
            // second turn: a provider that reports nothing
            ...(call === 1
              ? { usage: { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 } }
              : {}),
          },
        });
      },
    };
    const { dir, options } = setup(withUsage);
    await runLoop(options);
    const responses = readTrajectory(dir).filter((r) => r.t === "response");
    expect(responses).toHaveLength(2);
    expect(responses[0]!["usage"]).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 34,
      total_tokens: 1234,
    });
    expect("usage" in responses[1]!).toBe(false);
    options.trajectory.close();
  });

  test("a length finish is recorded and raises a provider_truncated notice next turn", async () => {
    let call = 0;
    const truncating: ChatAdapter = {
      label: "trunc",
      complete: (): Promise<AdapterOutcome> => {
        call++;
        if (call > 2) return Promise.resolve({ kind: "stub-complete" });
        return Promise.resolve({
          kind: "ok",
          // first turn truncates; second is clean, and must carry the notice
          // the first turn's truncation raised.
          turn: { content: "ok", toolCalls: [], ...(call === 1 ? { finishReason: "length" } : {}) },
        });
      },
    };
    const { dir, options } = setup(truncating);
    await runLoop(options);
    const records = readTrajectory(dir);
    const responses = records.filter((r) => r.t === "response");
    expect(responses[0]!["finishReason"]).toBe("length");
    expect("finishReason" in responses[1]!).toBe(false);
    // the notice reaches the next turn's context, not scored as a model error
    const req2 = records.filter((r) => r.t === "request")[1];
    expect(JSON.stringify(req2)).toContain("finish_reason: length");
    options.trajectory.close();
  });

  test("every request contains the system prompt plus a fresh context message", async () => {
    const seen: ChatRequest[] = [];
    const recording: ChatAdapter = {
      label: "recording",
      complete: (req): Promise<AdapterOutcome> => {
        seen.push(structuredClone(req));
        return Promise.resolve(
          seen.length >= 3 ? { kind: "stub-complete" } : { kind: "ok", turn: { content: "ok", toolCalls: [] } },
        );
      },
    };
    const { options } = setup(recording);
    await runLoop(options);
    expect(seen).toHaveLength(3);
    for (const [i, req] of seen.entries()) {
      expect(req.messages[0]!.role).toBe("system");
      const users = req.messages.filter((m) => m.role === "user");
      expect(users).toHaveLength(1); // old context messages are dropped, never accumulated
      expect(users[0]!.content).toContain(`[turn ${i + 1}]`);
      expect(req.tools.map((t) => t.name)).toContain("run_snippet");
    }
    options.trajectory.close();
  });
});
