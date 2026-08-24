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
import { itemSample, runLoop } from "../src/loop";
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
    ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1, ...extraConfig }),
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

  test("zone/area ids reach the state row and a milestone record on change, ids only", async () => {
    const adapter = new StubAdapter([{ content: "acting", toolCalls: [] }]);
    const { dir, options } = setup(
      adapter,
      {},
      {
        self: {
          zone: { value: { id: 12, name: "Elwynn Forest" }, seq: 3, ts: 1 },
          area: { value: { id: 9, name: "Northshire Valley" }, seq: 3, ts: 1 },
        },
      },
    );
    await runLoop(options);
    const rows = options.trajectory.stateRows("run-test");
    expect(rows[0]!["zone"]).toBe(12);
    expect(rows[0]!["area"]).toBe(9);
    // First observation is a milestone from nowhere; later samples with the
    // same pair add nothing. Names never appear in the record.
    const ms = readTrajectory(dir).filter((r) => r.t === "milestone");
    expect(ms.map((r) => [r["kind"], r["from"], r["to"]])).toEqual([
      ["zone", undefined, { id: 12 }],
      ["area", undefined, { id: 9 }],
    ]);
    expect(JSON.stringify(ms)).not.toContain("Elwynn");
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

  test("a stop request carrying a pause suspends the run as operator-pause with the clock persisted (ADR-0036)", async () => {
    const abort = new AbortController();
    let calls = 0;
    const slow: ChatAdapter = {
      label: "slow",
      complete: (req: ChatRequest): Promise<AdapterOutcome> => {
        calls++;
        // The request in flight is abandoned when the runner stops: the
        // adapter contract is "throw once the signal fires".
        return new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("abandoned")), { once: true });
        });
      },
    };
    const { options } = setup(slow);
    const run = runLoop({ ...options, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 20));
    abort.abort({ kind: "pause", reason: "operator-pause", detail: "SIGTERM: supervisor stop" });
    const outcome = await run;
    expect(calls).toBe(1);
    expect(outcome).toEqual({ kind: "paused", reason: "operator-pause", detail: "SIGTERM: supervisor stop" });
    const row = options.trajectory.runRow("run-test");
    expect(row?.["pause_reason"]).toBe("operator-pause");
    expect(row?.["termination_reason"]).toBeNull();
    const pause = readTrajectory(options.trajectory.dir).find((r) => r.t === "pause");
    expect(pause?.["reason"]).toBe("operator-pause");
    expect(typeof pause?.["episodeElapsedMs"]).toBe("number");
    options.trajectory.close();
  });

  test("a stop request carrying a terminate (Ctrl-C) ends the run as manual", async () => {
    const abort = new AbortController();
    abort.abort({ kind: "terminate", detail: "SIGINT" });
    const adapter = new StubAdapter([{ content: "never reached", toolCalls: [] }]);
    const { options } = setup(adapter);
    const outcome = await runLoop({ ...options, signal: abort.signal });
    expect(outcome).toEqual({ kind: "terminated", reason: "manual", detail: "SIGINT" });
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

describe("itemSample", () => {
  test("worn from inventory slots 0-18, carried from bag(), names with counts", () => {
    const sample = itemSample({
      inventory: [
        { slot: 16, name: "Worn Mace", stackCount: 1 },
        { slot: 19, name: "Small Brown Pouch" }, // a worn bag: neither equipment nor carried
        { slot: 23, name: "Hearthstone" }, // backpack rows come from bag(), not here
        { slot: 4, itemId: 6125 }, // no name answered yet
      ],
      bag: {
        freeSlots: 20,
        totalSlots: 22,
        items: [
          { slot: 23, itemId: 6948, name: "Hearthstone", count: 1 },
          { slot: 0, itemId: 2589, name: "Linen Cloth", count: 3 },
        ],
      },
    });
    expect(sample).toEqual([
      { name: "Worn Mace", count: 1, equipped: true },
      { name: "item 6125", count: 1, equipped: true },
      { name: "Hearthstone", count: 1, equipped: false },
      { name: "Linen Cloth", count: 3, equipped: false },
    ]);
  });

  test("a snapshot with no inventory at all records nothing", () => {
    expect(itemSample({})).toBeUndefined();
  });
});

/**
 * Prompt-cache prefix discipline (FOLLOW-UPS 78). Measured on a real paid run
 * (fleet-deepseek-…-20260824-a4): all 150 consecutive request pairs were
 * byte-stable up to the append point; every mid-block cached_tokens=0 was the
 * aggregator routing to a different backend or backend-internal cache
 * weather. These tests pin the half the harness controls: the serialized
 * request prefix, and the provider attribution that makes the other half
 * diagnosable from the trajectory alone.
 */
describe("prompt-cache prefix discipline", () => {
  test("serialized request N+1 extends request N byte-for-byte up to the append point, across a trim", async () => {
    // One tool call per turn -> history grows 2 messages/turn, so 30 turns
    // cross the MESSAGE_WINDOW_MAX=48 ceiling and exercise one block trim.
    const adapter = new StubAdapter(
      Array.from({ length: 30 }, (_, i) => ({
        content: `turn ${i}`,
        toolCalls: [{ name: "run_snippet", arguments: { code: `ping(${i})` } }],
      })),
    );
    const { dir, options } = setup(adapter);
    await runLoop(options);
    const reqs = readTrajectory(dir).filter((r) => r.t === "request");
    expect(reqs.length).toBe(31); // 30 scripted turns + the stub-complete turn
    let trims = 0;
    for (let i = 1; i < reqs.length; i++) {
      // Drop the trailing per-turn user context message: it is regenerated
      // every turn by design and is never part of the cacheable prefix.
      const prev = (reqs[i - 1]!.messages as unknown[]).slice(0, -1).map((m) => JSON.stringify(m));
      const next = (reqs[i]!.messages as unknown[]).slice(0, -1).map((m) => JSON.stringify(m));
      if (next.length < prev.length) {
        trims++; // the one deliberate cache miss per block (ADR-0012)
        continue;
      }
      expect(next.slice(0, prev.length)).toEqual(prev);
    }
    expect(trims).toBe(1);
  });

  test("the serving provider named in the response body lands on the response record", async () => {
    const adapter: ChatAdapter = {
      label: "fake-aggregator",
      complete: (_req: ChatRequest): Promise<AdapterOutcome> =>
        Promise.resolve({
          kind: "ok",
          turn: { content: "done", toolCalls: [], raw: { provider: "SomeBackend" } },
        }),
    };
    const { dir, options } = setup(adapter, { maxTurns: 1 });
    await runLoop(options);
    const responses = readTrajectory(dir).filter((r) => r.t === "response");
    expect(responses.length).toBe(1);
    expect(responses[0]!.provider).toBe("SomeBackend");
  });

  test("no provider field appears when the body names none", async () => {
    const adapter = new StubAdapter([{ content: "done", toolCalls: [] }]);
    const { dir, options } = setup(adapter, { maxTurns: 1 });
    await runLoop(options);
    const responses = readTrajectory(dir).filter((r) => r.t === "response");
    expect(responses[0]!).not.toHaveProperty("provider");
  });
});

describe("runLoop fresh-character precondition", () => {
  test("a used character on first sight terminates stale-character before the model gets a turn", async () => {
    const adapter = new StubAdapter([{ content: "acting", toolCalls: [{ name: "run_snippet", arguments: { code: "1+1" } }] }]);
    const { dir, options } = setup(adapter, {}, { self: { guid: "294", level: { value: 6 } } });
    options.watchdogs.expectFreshCharacter(new Set(["294"]));
    const outcome = await runLoop(options);
    expect(outcome.kind).toBe("terminated");
    if (outcome.kind !== "terminated") throw new Error("unreachable");
    expect(outcome.reason).toBe("stale-character");
    const records = readTrajectory(dir);
    expect(records.filter((r) => r.t === "request")).toHaveLength(0);
    expect(records.find((r) => r.t === "termination")?.["reason"]).toBe("stale-character");
  });

  test("a fresh level-1 character with an unlisted guid plays on", async () => {
    const adapter = new StubAdapter([{ content: "acting", toolCalls: [{ name: "run_snippet", arguments: { code: "1+1" } }] }]);
    const { options } = setup(adapter, {}, { self: { guid: "301", level: { value: 1 } } });
    options.watchdogs.expectFreshCharacter(new Set(["294"]));
    const outcome = await runLoop(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "stub-complete" });
  });
});
