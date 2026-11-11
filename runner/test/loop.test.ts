/**
 * Agent loop against the stub adapter and a fake sandbox: termination reasons,
 * trajectory records, message-window mechanics. No live stack, no real model.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StubAdapter, type ChatAdapter, type ChatRequest, type AdapterOutcome, type ToolCall } from "../src/adapter";
import type { ChatMessage } from "../src/context";
import { requestsOf } from "./fixtures/requests";
import { SEGMENT_TURNS, slimRun } from "./fixtures/slim-run";
import { loadRunConfig } from "../src/config";
import { ContextBuilder, replayedAssistant, runLoop } from "../src/loop";
import { EpisodicLog } from "../src/episodic";
import { Scratchpad } from "@wrathbench/mcp";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import type { ActionHintNote } from "@wrathbench/mcp";
import { renderActionHints } from "../src/tools";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { LEAKED_SECRET, LEAKY_PAD, LEAKY_RESULT_AS_READ, leakyCrashNotice, leakySnippetResult } from "./fixtures/leaky-snippet";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

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
  const dir = tempDir("wrathbench-loop-");
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
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    },
  };
}

/** Count the state snapshots a sandbox is asked for, from now on. */
function countSnapshots(sandbox: SandboxHost): () => number {
  let n = 0;
  const real = sandbox.stateSnapshot.bind(sandbox);
  (sandbox as { stateSnapshot: SandboxHost["stateSnapshot"] }).stateSnapshot = () => {
    n++;
    return real();
  };
  return () => n;
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
    // Every call carries its dispatch stamp, the same field the CLI drivers
    // write, so a reader times calls from it rather than from record shape.
    const calls = records.filter((r) => r.t === "tool_call");
    const results = records.filter((r) => r.t === "snippet_result" || r.t === "tool_result");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    calls.forEach((c, k) => {
      const dispatchTs = c["dispatchTs"];
      expect(typeof dispatchTs).toBe("number");
      expect(dispatchTs as number).toBeLessThanOrEqual(c.ts);
      expect(results[k]!.ts).toBeGreaterThanOrEqual(dispatchTs as number);
    });
    expect(options.scratchpad.read()).toBe("# hi");
    const row = options.trajectory.runRow("run-test");
    expect(row?.["termination_reason"]).toBe("stub-complete");
    options.trajectory.close();
  });

  test("pending action hints ride a non-snippet tool result, and the trajectory records what the model saw", async () => {
    // A background routine's hint no longer waits for the next snippet: it
    // rides whichever tool result comes next — here a scratchpad write, then a
    // call whose arguments were not even JSON — and the record is that text.
    const pending: ActionHintNote[] = [];
    const hint: ActionHintNote = { action: "moveTo", status: "drop", count: 3, hint: "steps off a ledge", ts: 1 };
    const block = renderActionHints([hint]) as string;
    let n = 0;
    const adapter: ChatAdapter = {
      label: "raw",
      complete: async (): Promise<AdapterOutcome> => {
        n++;
        if (n > 2) return { kind: "stub-complete" };
        pending.push({ ...hint });
        const args = n === 1 ? JSON.stringify({ content: "# hi" }) : "{broken";
        return { kind: "ok", turn: { content: null, toolCalls: [{ id: `c${n}`, name: "write_scratchpad", arguments: args }] } };
      },
    };
    const { dir, options } = setup(adapter);
    (options.sandbox as unknown as { drainActionHints: () => Promise<ActionHintNote[]> }).drainActionHints = async () =>
      pending.splice(0, pending.length);
    await runLoop(options);
    const results = readTrajectory(dir).filter((r) => r.t === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]?.["text"]).toBe(`written (4 chars)\n${block}`);
    expect(results[0]?.["isError"]).toBe(false);
    expect(String(results[1]?.["text"])).toStartWith("tool arguments were not valid JSON");
    expect(String(results[1]?.["text"]).endsWith(`\n${block}`)).toBe(true);
    expect(results[1]?.["isError"]).toBe(true);
    expect(pending).toEqual([]);
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

  test("the ticker samples while a model request is in flight", async () => {
    // The openai-compatible path used to sample only in the turn preamble, so
    // one 485s request was an 8-minute blackout for the watchdogs and the
    // stall detector. The ticker samples on the wall clock while complete()
    // holds the turn.
    const slow: ChatAdapter = {
      label: "slow",
      complete: async (): Promise<AdapterOutcome> => {
        await new Promise((r) => setTimeout(r, 120));
        return { kind: "stub-complete" };
      },
    };
    const { options } = setup(slow);
    const counted = countSnapshots(options.sandbox);
    await runLoop({ ...options, stateTickMs: 10 });
    // One from the turn preamble, the rest from inside the request.
    expect(counted()).toBeGreaterThanOrEqual(3);
    options.trajectory.close();
  });

  test("the ticker only samples: it drains no record of its own, and the run gets no run.sqlite", async () => {
    // The session record is the stack's: its host drains the child's recorder
    // on a tick of its own (`SandboxHost.recordDrain`). A ticker that still
    // drained a trace or a ring here would be a second reader racing the
    // stack's for one destructive buffer.
    const slow: ChatAdapter = {
      label: "slow",
      complete: async (): Promise<AdapterOutcome> => {
        await new Promise((r) => setTimeout(r, 120));
        return { kind: "stub-complete" };
      },
    };
    const { dir, options } = setup(slow);
    const asked: string[] = [];
    const spy = (name: string) => () => {
      asked.push(name);
      return Promise.resolve(null);
    };
    Object.assign(options.sandbox, { recordDrain: spy("recordDrain"), traceDrain: spy("traceDrain"), nearbyDrain: spy("nearbyDrain") });
    const counted = countSnapshots(options.sandbox);
    await runLoop({ ...options, stateTickMs: 10 });
    expect(counted()).toBeGreaterThanOrEqual(3);
    expect(asked).toEqual([]);
    options.trajectory.close();
    expect(existsSync(join(dir, "run.sqlite"))).toBe(false);
    // The trajectory is the model side: no state, milestone or turn-in record.
    expect(readTrajectory(dir).filter((r) => ["state", "milestone", "quest_complete", "move", "actions"].includes(r.t))).toEqual([]);
  });

  test("the ticker stops with the loop: nothing samples after runLoop returns", async () => {
    const { options } = setup(new StubAdapter([]));
    const counted = countSnapshots(options.sandbox);
    await runLoop({ ...options, stateTickMs: 5 });
    const sampled = counted();
    await new Promise((r) => setTimeout(r, 40));
    expect(counted()).toBe(sampled);
    options.trajectory.close();
  });

  test("concurrent sampleState calls coalesce: one snapshot serves both", async () => {
    // The ticker and the turn preamble can sample at the same moment; one
    // snapshot serves both rather than two racing the child.
    const dir = tempDir("wrathbench-loop-");
    const config = {
      ...loadRunConfig({ driver: "stub", stateIntervalMs: 1 }),
      runId: "run-test",
      token: "run-test",
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
    let snapshots = 0;
    const sandbox = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            snapshots++;
            resolve({
              self: { guid: "7", zone: { value: { id: 12 }, seq: 1, ts: 1 } },
              lastSeq: -1,
              eventCount: 0,
              questCompletions: [{ questId: 7 }],
            });
          }, 20),
        ),
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;
    const builder = new ContextBuilder({
      config,
      sandbox,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
    });
    const [a, b] = await Promise.all([builder.sampleState(), builder.sampleState()]);
    // One snapshot served both callers — not two interleaved samples.
    expect(snapshots).toBe(1);
    expect(a).toBe(b);
    // The coalescing window closes with the sample: a later call runs its own.
    await builder.sampleState();
    expect(snapshots).toBe(2);
    trajectory.close();
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

  test("a verdict whose row write gives up leaves the loop with the runner's own reason, never re-terminated as harness-error", async () => {
    const adapter = new StubAdapter(
      Array.from({ length: 10 }, () => ({ content: "thinking", toolCalls: [] })),
    );
    const { options } = setup(adapter, { maxTurns: 2 });
    const t = options.trajectory;
    const locked = Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY", errno: 5 });
    // What a termination whose row write spent its retries looks like: the
    // record appended, the write rejected.
    t.setTermination = (_runId, reason, detail) => {
      t.append({ t: "termination", reason, detail });
      return Promise.reject(locked);
    };
    await expect(runLoop(options)).rejects.toBe(locked);
    const ends = readTrajectory(t.dir).filter((r) => r.t === "termination");
    expect(ends.map((r) => r["reason"])).toEqual(["turn-limit"]);
    t.close();
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

  test("a provider's stated reset rides from the adapter onto the outcome and the pause record", async () => {
    const reset = Date.UTC(2026, 8, 22);
    const pausing: ChatAdapter = {
      label: "pausing",
      complete: (_req: ChatRequest): Promise<AdapterOutcome> =>
        Promise.resolve({ kind: "pause", reason: "quota-exhausted", detail: "429 daily", notBefore: reset }),
    };
    const { options, dir } = setup(pausing);
    const outcome = await runLoop(options);
    options.trajectory.close();
    expect(outcome).toEqual({ kind: "paused", reason: "quota-exhausted", detail: "429 daily", notBefore: reset });
    const pause = readTrajectory(dir).find((r) => r.t === "pause");
    expect(pause?.["notBefore"]).toBe(reset);
  });

  test("a stop request carrying a pause suspends the run as operator-pause with the clock persisted", async () => {
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

  test("the provider's raw usage lands beside the normalised block and never reaches the model", async () => {
    const usageRaw = {
      prompt_tokens: 1200,
      completion_tokens: 34,
      prompt_cache_hit_tokens: 1024,
      prompt_cache_miss_tokens: 176,
      completion_tokens_details: { reasoning_tokens: 12 },
    };
    // The same two turns with and without it: what the model is handed must
    // not differ by a byte.
    async function run(withRaw: boolean): Promise<{ dir: string; seen: ChatRequest[] }> {
      const seen: ChatRequest[] = [];
      const adapter: ChatAdapter = {
        label: "raw-usage",
        complete: (req): Promise<AdapterOutcome> => {
          seen.push(structuredClone({ messages: req.messages, tools: req.tools }));
          if (seen.length > 2) return Promise.resolve({ kind: "stub-complete" });
          return Promise.resolve({
            kind: "ok",
            turn: {
              content: "ok",
              toolCalls: [{ id: `c${seen.length}`, name: "write_scratchpad", arguments: '{"content":"# hi"}' }],
              usage: { prompt_tokens: 1200, completion_tokens: 34 },
              ...(withRaw && seen.length === 1 ? { usageRaw } : {}),
            },
          });
        },
      };
      const { dir, options } = setup(adapter);
      await runLoop(options);
      options.trajectory.close();
      return { dir, seen };
    }
    const withRaw = await run(true);
    const without = await run(false);

    const responses = readTrajectory(withRaw.dir).filter((r) => r.t === "response");
    expect(responses).toHaveLength(2);
    expect(responses[0]!["usageRaw"]).toEqual(usageRaw);
    expect(responses[0]!["usage"]).toEqual({ prompt_tokens: 1200, completion_tokens: 34 });
    expect("usageRaw" in responses[1]!).toBe(false);

    // Every request after the first carries the turn before it in history.
    expect(withRaw.seen).toHaveLength(3);
    expect(without.seen).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      // The trailing context message is rebuilt each turn from the clock and
      // the world; everything before it is the history the response fed.
      const a = withRaw.seen[i]!;
      const b = without.seen[i]!;
      expect(JSON.stringify(a.messages.slice(0, -1))).toBe(JSON.stringify(b.messages.slice(0, -1)));
      expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
      expect(JSON.stringify(a)).not.toContain("prompt_cache_hit_tokens");
    }
    for (const r of readTrajectory(withRaw.dir).filter((r) => r.t === "request")) {
      expect(JSON.stringify(r)).not.toContain("prompt_cache_hit_tokens");
    }
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

describe("replayedAssistant", () => {
  /** The construction the loop used before the empty-turn fix, verbatim. */
  function legacyAssistant(turn: { content: string | null; toolCalls: ToolCall[] }): ChatMessage {
    return {
      role: "assistant",
      content: turn.content,
      ...(turn.toolCalls.length > 0
        ? {
            tool_calls: turn.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    };
  }

  function turnOf(message: ChatMessage): { content: string | null; toolCalls: ToolCall[] } {
    return {
      content: message.content,
      toolCalls: (message.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
    };
  }

  test("every assistant turn of the slim-run fixture replays byte-identical to the old construction", async () => {
    // The fixture reaches text with calls, no text with calls, several calls
    // in a turn, a malformed argument string and an over-cap reply, across two
    // segments; its requests are proven to replay by `requestsOf`.
    const { dir } = await slimRun(tempDir("wrathbench-replayed-"));
    requestsOf(dir);
    const messages = readTrajectory(dir)
      .filter((r) => r.t === "response")
      .map((r) => r["message"] as ChatMessage);
    expect(messages.length).toBe(SEGMENT_TURNS[0] + SEGMENT_TURNS[1]);
    expect(messages.some((m) => m.content === null)).toBe(true);
    for (const m of messages) {
      const turn = turnOf(m);
      expect(JSON.stringify(replayedAssistant(turn))).toBe(JSON.stringify(legacyAssistant(turn)));
      expect(JSON.stringify(replayedAssistant(turn))).toBe(JSON.stringify(m));
    }
  });

  test("only a turn with neither text nor tool calls changes: it replays with empty content", () => {
    const call: ToolCall = { id: "c1", name: "run_snippet", arguments: '{"code":"1"}' };
    const same: { content: string | null; toolCalls: ToolCall[] }[] = [
      { content: "text", toolCalls: [] },
      { content: "", toolCalls: [] },
      { content: "text", toolCalls: [call] },
      { content: null, toolCalls: [call] },
      { content: "", toolCalls: [call] },
    ];
    for (const turn of same) expect(JSON.stringify(replayedAssistant(turn))).toBe(JSON.stringify(legacyAssistant(turn)));
    expect(replayedAssistant({ content: null, toolCalls: [] })).toEqual({ role: "assistant", content: "" });
    expect(JSON.stringify(replayedAssistant({ content: null, toolCalls: [] }))).toBe('{"role":"assistant","content":""}');
  });

  test("a reasoning-only turn replays as a valid message, and the trajectory replays to the bytes sent", async () => {
    const sent: ChatMessage[][] = [];
    const turns: AdapterOutcome[] = [
      // Reasoning-only: no text, no calls (the driver does not carry reasoning).
      { kind: "ok", turn: { content: null, toolCalls: [] } },
      { kind: "ok", turn: { content: null, toolCalls: [{ id: "c1", name: "run_snippet", arguments: '{"code":"1"}' }] } },
      { kind: "ok", turn: { content: "after", toolCalls: [] } },
    ];
    const adapter: ChatAdapter = {
      label: "stub",
      complete: (req: ChatRequest): Promise<AdapterOutcome> => {
        sent.push(JSON.parse(JSON.stringify(req.messages)) as ChatMessage[]);
        return Promise.resolve(turns.shift() ?? { kind: "stub-complete" });
      },
    };
    const { dir, options } = setup(adapter);
    await runLoop(options);
    options.trajectory.close();
    const last = sent[sent.length - 1]!;
    const assistants = last.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(JSON.stringify(assistants[0])).toBe('{"role":"assistant","content":""}');
    // Valid on every message: text, or tool calls.
    for (const m of assistants) expect(typeof m.content === "string" || (m.tool_calls?.length ?? 0) > 0).toBe(true);
    // The tool-call turn with no text keeps its null content, as before.
    expect(assistants[1]!.content).toBeNull();
    // The record carries what was sent, and every request rebuilds from it.
    const responses = readTrajectory(dir).filter((r) => r.t === "response");
    expect(responses[0]!["message"]).toEqual({ role: "assistant", content: "" });
    expect(requestsOf(dir).map((r) => r.messages)).toEqual(sent);
  });
});

describe("prompt-cache prefix discipline", () => {
  test("serialized request N+1 extends request N byte-for-byte up to the append point, across a trim", async () => {
    // One tool call per turn -> history grows 2 messages/turn, so 30 turns
    // cross the MESSAGE_WINDOW_MAX=48 ceiling and exercise one block trim.
    const stub = new StubAdapter(
      Array.from({ length: 30 }, (_, i) => ({
        content: `turn ${i}`,
        toolCalls: [{ name: "run_snippet", arguments: { code: `ping(${i})` } }],
      })),
    );
    // Captured where the bytes leave the loop: the message array handed to
    // the adapter, serialised on the way in.
    const sent: string[][] = [];
    const adapter: ChatAdapter = {
      label: stub.label,
      complete: (req) => {
        sent.push(req.messages.map((m) => JSON.stringify(m)));
        return stub.complete(req);
      },
    };
    const { options } = setup(adapter);
    await runLoop(options);
    expect(sent.length).toBe(31); // 30 scripted turns + the stub-complete turn
    let trims = 0;
    for (let i = 1; i < sent.length; i++) {
      // Drop the trailing per-turn user context message: it is regenerated
      // every turn by design and is never part of the cacheable prefix.
      const prev = sent[i - 1]!.slice(0, -1);
      const next = sent[i]!.slice(0, -1);
      if (next.length < prev.length) {
        trims++; // the one deliberate cache miss per block (hysteretic window)
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
    // And onto the run itself (2026-09-16): with routing pinned, the backend
    // that took the request is the answer to what the tuple asked for, so a
    // cross-run SELECT must be able to read it without replaying the JSONL.
    expect(readMeta(dir)?.resolved).toEqual({ model: null, cliVersion: null, provider: "SomeBackend" });
  });

  test("the served model in the response body lands on the record and is promoted onto the run", async () => {
    // OpenRouter answers a request for one slug with the id it actually routed
    // to, and that — not the config string — is what a chart has to name.
    let call = 0;
    const adapter: ChatAdapter = {
      label: "fake-aggregator",
      complete: (_req: ChatRequest): Promise<AdapterOutcome> =>
        Promise.resolve({
          kind: "ok",
          // A second turn served elsewhere must not revise the run's answer.
          turn: { content: "done", toolCalls: [], raw: { model: call++ === 0 ? "vendor/alpha-2026-08" : "vendor/other" } },
        }),
    };
    const { dir, options } = setup(adapter, { maxTurns: 2 });
    await runLoop(options);
    const responses = readTrajectory(dir).filter((r) => r.t === "response");
    expect(responses[0]!.model).toBe("vendor/alpha-2026-08");
    expect(readMeta(dir)?.resolved).toEqual({ model: "vendor/alpha-2026-08", cliVersion: null, provider: null });
    expect(readTrajectory(dir).filter((r) => r["kind"] === "resolved_model")).toHaveLength(1);
  });

  test("OpenCode's served headers land on every record and the first is promoted, ahead of the body", async () => {
    // Go picks the backend itself, so its headers are the only record of which
    // machine answered; its body's `model` just echoes the id asked for.
    let call = 0;
    const adapter: ChatAdapter = {
      label: "fake-go",
      complete: (_req: ChatRequest): Promise<AdapterOutcome> => {
        const first = call++ === 0;
        return Promise.resolve({
          kind: "ok",
          turn: {
            content: "done",
            toolCalls: [],
            served: first
              ? { provider: "orcarouter-dsv4.1flash", model: "deepseek/deepseek-v4.1-flash" }
              : { provider: "another-endpoint", model: "deepseek/deepseek-v4.1-flash" },
            raw: { model: "deepseek-v4.1-flash" },
          },
        });
      },
    };
    const { dir, options } = setup(adapter, { maxTurns: 2 });
    await runLoop(options);
    const responses = readTrajectory(dir).filter((r) => r.t === "response");
    expect(responses).toHaveLength(2);
    // Each record says what served it, as an OpenRouter body's `provider` does.
    expect(responses[0]!.provider).toBe("orcarouter-dsv4.1flash");
    expect(responses[0]!.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(responses[1]!.provider).toBe("another-endpoint");
    // The run keeps the first answer, never revised.
    expect(readMeta(dir)?.resolved).toEqual({ model: "deepseek/deepseek-v4.1-flash", cliVersion: null, provider: "orcarouter-dsv4.1flash" });
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

  test("the name the model chose is recorded over the harness's suggestion", async () => {
    const adapter = new StubAdapter([{ content: "acting", toolCalls: [{ name: "run_snippet", arguments: { code: "1+1" } }] }]);
    const { dir, options } = setup(adapter, { character: "Fleetsonnet" }, { self: { guid: "301", name: "Grimjaw", level: { value: 1 } } });
    await runLoop(options);
    // The runs page and the positions feed read the run row; a resumed runner
    // reads meta.json. Both must name the character that is in the world.
    expect(options.trajectory.runRow("run-test")?.["character"]).toBe("Grimjaw");
    expect(readMeta(dir)?.config.character).toBe("Grimjaw");
    expect(readTrajectory(dir).filter((r) => r.t === "character")).toHaveLength(1);
  });

  test("a character whose name matches the launch config is not re-recorded", async () => {
    const adapter = new StubAdapter([{ content: "acting", toolCalls: [{ name: "run_snippet", arguments: { code: "1+1" } }] }]);
    const { dir, options } = setup(adapter, { character: "Fleetsonnet" }, { self: { guid: "301", name: "Fleetsonnet", level: { value: 1 } } });
    await runLoop(options);
    expect(readTrajectory(dir).filter((r) => r.t === "character")).toHaveLength(0);
  });

  test("a fresh level-1 character with an unlisted guid plays on", async () => {
    const adapter = new StubAdapter([{ content: "acting", toolCalls: [{ name: "run_snippet", arguments: { code: "1+1" } }] }]);
    const { options } = setup(adapter, {}, { self: { guid: "301", level: { value: 1 } } });
    options.watchdogs.expectFreshCharacter(new Set(["294"]));
    const outcome = await runLoop(options);
    expect(outcome).toEqual({ kind: "terminated", reason: "stub-complete" });
  });
});

describe("registered secrets in what the model reads", () => {
  test("a secret a snippet returned, logged or threw, a notice's and the pad's reach the model as [redacted], and the record is the same text", async () => {
    const sent: ChatRequest["messages"][] = [];
    let n = 0;
    const adapter: ChatAdapter = {
      label: "raw",
      complete: async (req: ChatRequest): Promise<AdapterOutcome> => {
        sent.push(req.messages.map((m) => ({ ...m })));
        n++;
        if (n > 1) return { kind: "stub-complete" };
        return { kind: "ok", turn: { content: null, toolCalls: [{ id: "c1", name: "run_snippet", arguments: JSON.stringify({ code: "process.env" }) }] } };
      },
    };
    const { dir, options } = setup(adapter);
    options.trajectory.redact(LEAKED_SECRET);
    const notices = [leakyCrashNotice()];
    Object.assign(options.sandbox, {
      evalSnippet: () => Promise.resolve(leakySnippetResult()),
      drainNotices: () => notices.splice(0),
    });
    writeFileSync(join(dir, "scratchpad.md"), LEAKY_PAD, "utf8");
    await runLoop(options);
    options.trajectory.close();

    const context = sent[0]!.at(-1)!.content ?? "";
    expect(context).toContain("Last stderr: dumping [redacted]");
    expect(context).toContain("key: [redacted]");
    const toolMessage = sent[1]!.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe(LEAKY_RESULT_AS_READ);
    // Scrubbed once, before both: the record is the text the model read.
    expect(readTrajectory(dir).find((r) => r.t === "snippet_result")?.["text"]).toBe(LEAKY_RESULT_AS_READ);
    expect(JSON.stringify(sent)).not.toContain(LEAKED_SECRET);
    expect(readFileSync(join(dir, "trajectory.jsonl"), "utf8")).not.toContain(LEAKED_SECRET);
  });
});
