/**
 * OpenCode Go's allowance as a credential's usage windows (operator, 2026-10-16): the
 * usage endpoint's reader, the once-a-minute poller, and the fixed loop's use
 * of it — the freeplay gate at the turn boundary and a spent allowance's
 * reset. A fake fetch and synthetic figures only; no network.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenAiChatAdapter, StubAdapter, type AdapterOutcome, type ChatAdapter } from "../src/adapter";
import { loadRunConfig } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { runLoop } from "../src/loop";
import { GO_USAGE_PATH, GoUsageGauge, GoUsagePoller, goOverageOf, goUsageUrl, goUsageWindows, readGoUsage, type GoFetch } from "../src/opencode-go";
import { Scratchpad } from "@wrathbench/mcp";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const H = 3_600_000;
const KEY = "fake-go-key-never-logged";
const CRED = "go-paid";

/** A Go usage body in the endpoint's shape: synthetic percents, resets `inMs` from now as ISO dates. */
function body(rolling: number, weekly: number, inMs = 2 * H, status = "ok"): Record<string, unknown> {
  const resetsAt = new Date(Date.now() + inMs).toISOString();
  return {
    rolling: { status, percent: rolling, resetsAt },
    weekly: { status: "ok", percent: weekly, resetsAt: new Date(Date.now() + 50 * H).toISOString() },
    monthly: { status: "ok", percent: 3, resetsAt: new Date(Date.now() + 400 * H).toISOString() },
  };
}

/** A refusal: the status, and the body it carries. */
class Refusal {
  constructor(
    readonly status: number,
    readonly body: unknown = {},
  ) {}
}

/** A fetch that answers `answers` in turn (the last one repeats), counting its calls. A number is a refusal with an empty body. */
function fakeFetch(answers: (unknown | Error | number | Refusal)[]): GoFetch & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    if (typeof a === "number") return { ok: false, status: a, json: () => Promise.resolve({}) };
    if (a instanceof Refusal) return { ok: false, status: a.status, json: () => Promise.resolve(a.body) };
    return { ok: true, status: 200, json: () => Promise.resolve(a) };
  }) as unknown as GoFetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

describe("the usage endpoint", () => {
  test("lives on the Go base's origin", () => {
    expect(goUsageUrl("https://opencode.ai/zen/go/v1")).toBe(`https://opencode.ai${GO_USAGE_PATH}`);
    expect(goUsageUrl("https://opencode.ai/inference/go/v1")).toBe("https://opencode.ai/inference/go/v1/usage");
    expect(goUsageUrl("not a url")).toBeUndefined();
    expect(goUsageUrl(undefined)).toBeUndefined();
  });

  test("windows are read tolerantly: percent, length by name, reset in any spelling; any status but ok reads 100", () => {
    const at = Date.UTC(2030, 0, 1);
    expect(
      goUsageWindows({
        rolling: { status: "ok", percent: 12, resetsAt: new Date(at).toISOString() },
        weekly: { status: "ok", percent: 40, resetsAt: at / 1000 },
        monthly: { status: "exceeded", percent: 97, resetsAt: at },
      }),
    ).toEqual([
      { usedPercent: 12, windowMinutes: 300, resetsAt: at },
      { usedPercent: 40, windowMinutes: 10_080, resetsAt: at },
      { usedPercent: 100, windowMinutes: 43_200, resetsAt: at },
    ]);
    // Go's own spent literal, on a percent that rounds below 100.
    expect(goUsageWindows({ usage: { rolling: { status: "rate-limited", percent: 97, resetsAt: at } } })).toEqual([{ usedPercent: 100, windowMinutes: 300, resetsAt: at }]);
    // Nested under a key, too.
    expect(goUsageWindows({ usage: { weekly: { percent: 5, resetsAt: at } } })).toEqual([{ usedPercent: 5, windowMinutes: 10_080, resetsAt: at }]);
    // A shape this does not know is no observation.
    expect(goUsageWindows({ balance: 3 })).toBeUndefined();
    expect(goUsageWindows("nope")).toBeUndefined();
    expect(goUsageWindows({ weekly: { percent: "lots" } })).toBeUndefined();
  });

  test("one read sends the key as a bearer token and never returns it; a failure is classified, never thrown", async () => {
    const ok = fakeFetch([body(10, 20)]);
    const r = await readGoUsage("https://opencode.ai/inference/go/v1/usage", KEY, ok);
    expect(r.ok && r.windows.length).toBe(3);
    expect(ok.calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    // A refused key, with the provider's code and never its message.
    expect(await readGoUsage("u", KEY, fakeFetch([new Refusal(401, { error: { type: "authentication_error", code: "api_key_expired", message: `key ${KEY} expired` } })]))).toEqual({
      ok: false,
      classification: "auth-failed",
      http: 401,
      code: "api_key_expired",
    });
    expect(await readGoUsage("u", KEY, fakeFetch([new Refusal(403, { type: "forbidden" })]))).toEqual({ ok: false, classification: "no-access", http: 403, code: "forbidden" });
    expect(await readGoUsage("u", KEY, fakeFetch([500]))).toEqual({ ok: false, classification: "unread", http: 500 });
    expect(await readGoUsage("u", KEY, fakeFetch([{ odd: true }]))).toEqual({ ok: false, classification: "unread", http: 200, code: "unknown-shape" });
    const thrown = await readGoUsage("u", KEY, fakeFetch([new TypeError(`failed for ${KEY}`)]));
    expect(thrown).toEqual({ ok: false, classification: "unread", http: null, code: "TypeError" });
    // A code that is not one short token is dropped, whatever it quotes.
    expect(await readGoUsage("u", KEY, fakeFetch([new Refusal(401, { error: { code: `bad key ${KEY}` } })]))).toEqual({ ok: false, classification: "auth-failed", http: 401 });
    expect(JSON.stringify(thrown)).not.toContain(KEY);
  });

  test("a response billed to the balance is an overage; the allowance, free or anything else is not", () => {
    const usage = (billing_source: unknown) => ({ usage: { cost: 0.01, opencode: { billing_source, allowance: 0 } } });
    expect(goOverageOf(usage("balance"))).toBe(true);
    for (const other of ["go", "go-plus", "free", "byok", undefined]) expect(goOverageOf(usage(other))).toBe(false);
    expect(goOverageOf({ usage: { cost: 1 } })).toBe(false);
    expect(goOverageOf(null)).toBe(false);
  });

  test("the overage survives the stream: the final usage chunk's billing_source reaches the turn's raw body", async () => {
    const sse = [
      { id: "gw-1", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
      { id: "gw-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "gw-1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.002, opencode: { billing_source: "balance", list_cost: 0.002, allowance: 0 } } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const adapter = new OpenAiChatAdapter({
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: Object.assign(() => Promise.resolve(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })), {
        preconnect: () => {},
      }) as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    const out = await adapter.complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && goOverageOf(out.turn.raw)).toBe(true);
  });
});

describe("GoUsagePoller", () => {
  test("calls at most once a minute, keeps the newest reading, and says an unreadable credential once", async () => {
    let now = 1_000_000;
    const f = fakeFetch([{ odd: true }, { odd: true }, body(30, 10)]);
    const notes: string[] = [];
    const p = new GoUsagePoller(CRED, "https://opencode.ai/inference/go/v1/usage", KEY, { fetch: f, now: () => now, onNote: (t) => notes.push(t) });
    await p.refresh();
    await p.refresh(); // within the minute: no call
    expect(f.calls).toHaveLength(1);
    expect(p.current).toBeUndefined();
    now += 60_000;
    await p.refresh();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("its launches are not held");
    for (const n of notes) expect(n).not.toContain(KEY);
    expect(p.lastRead).toEqual({ at: now, http: 200, code: "unknown-shape", classification: "unread", since: now - 60_000 });
    now += 60_000;
    await p.refresh();
    expect(p.current).toMatchObject({ credential: CRED, observedAt: now });
    expect(p.current!.windows[0]!.usedPercent).toBe(30);
    expect(p.lastRead).toEqual({ at: now, http: 200, classification: "ok", since: now });
    expect(notes).toHaveLength(2);
  });

  test("every read is classified, with when its class began, and each change is said once", async () => {
    let now = 1_000_000;
    const f = fakeFetch([new Refusal(401, { error: { code: "api_key_expired" } }), new Refusal(401, { error: { code: "api_key_expired" } }), new Refusal(403), new TypeError("x"), body(100, 10, 2 * H, "rate-limited"), body(10, 10)]);
    const notes: string[] = [];
    const p = new GoUsagePoller(CRED, "u", KEY, { fetch: f, now: () => now, onNote: (t) => notes.push(t) });
    const step = async () => {
      await p.refresh();
      const r = p.lastRead!;
      now += 60_000;
      return r;
    };
    expect(await step()).toEqual({ at: 1_000_000, http: 401, code: "api_key_expired", classification: "auth-failed", since: 1_000_000 });
    // The same class again keeps its beginning, and is not said again.
    expect(await step()).toMatchObject({ classification: "auth-failed", since: 1_000_000 });
    expect(await step()).toMatchObject({ classification: "no-access", http: 403 });
    expect(await step()).toMatchObject({ classification: "unread", http: null, code: "TypeError" });
    expect(await step()).toMatchObject({ classification: "spent", http: 200, code: "rate-limited" });
    expect(p.current!.windows[0]!.usedPercent).toBe(100);
    expect(await step()).toMatchObject({ classification: "ok", http: 200 });
    expect(notes).toHaveLength(5);
    expect(notes[0]).toContain("refused");
    expect(notes[0]).toContain("held until a read succeeds");
    for (const n of notes) expect(n).not.toContain(KEY);
  });

  test("a balance charge is an overage until a read at least an interval after it shows room", async () => {
    let now = 1_000_000;
    const f = fakeFetch([body(40, 10), body(100, 10, 2 * H, "rate-limited"), body(40, 10)]);
    const p = new GoUsagePoller(CRED, "u", KEY, { fetch: f, now: () => now });
    await p.refresh();
    expect(p.lastRead!.classification).toBe("ok");
    // An overage older than the last room read is already over.
    p.noteOverage(now - 120_000);
    expect(p.lastRead!.classification).toBe("ok");
    p.noteOverage(now + 1_000);
    expect(p.lastRead).toMatchObject({ classification: "overage", code: "balance", since: now + 1_000 });
    now += 60_000;
    await p.refresh(); // spent, inside the window of the charge: still overage
    expect(p.lastRead).toMatchObject({ classification: "overage", since: 1_001_000 });
    now += 60_000;
    await p.refresh(); // room, past the interval: over
    expect(p.lastRead).toMatchObject({ classification: "ok" });
    // Noting the same charge again changes nothing.
    p.noteOverage(1_001_000);
    expect(p.lastRead!.classification).toBe("ok");
  });

  test("a refused key outranks an overage", async () => {
    const p = new GoUsagePoller(CRED, "u", KEY, { fetch: fakeFetch([401]), now: () => 5_000 });
    await p.refresh();
    p.noteOverage(5_000);
    expect(p.lastRead!.classification).toBe("auth-failed");
  });
});

// ------------------------------------------------------------- the loop

function fakeSandbox(): SandboxHost {
  return {
    evalSnippet: (code: string): Promise<SnippetResult> => Promise.resolve({ ok: true, value: `ran:${code}`, logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
}

function setup(adapter: ChatAdapter, episode: string) {
  const dir = tempDir("wrathbench-go-loop-");
  // The credential's usage budget rides the run's config, as the fleet hands it over.
  const config = { ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1, episode, credential: CRED, usageMaxPct: { scored: 80, freeplay: 80 } }), runId: "run-test", token: "run-test" };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  return {
    dir,
    trajectory,
    options: {
      config,
      adapter,
      sandbox: fakeSandbox(),
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
    },
  };
}

const turns = (n: number): ConstructorParameters<typeof StubAdapter>[0] =>
  Array.from({ length: n }, () => ({ content: "acting", toolCalls: [{ name: "run_snippet", arguments: { code: "1" } }] }));

describe("the fixed loop on an OpenCode Go allowance", () => {
  test("a freeplay run stops at the turn boundary at the freeplay threshold, recorded, resumable at the reset", async () => {
    const { dir, trajectory, options } = setup(new StubAdapter(turns(5)), "freeplay");
    const gauge = new GoUsageGauge(CRED, "https://opencode.ai/inference/go/v1/usage", KEY, (u) => trajectory.recordSubscriptionUsage(u), { fetch: fakeFetch([body(83, 20)]) });
    const outcome = await runLoop({ ...options, usage: gauge });
    expect(outcome).toMatchObject({ kind: "paused", reason: "subscription-budget" });
    expect(Math.abs((outcome.kind === "paused" ? outcome.notBefore! : 0) - (Date.now() + 2 * H))).toBeLessThan(5_000);
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBe("subscription-budget");
    expect(readMeta(dir)!.subscriptionUsage).toMatchObject({ credential: CRED });
    // The key is nowhere on the record.
    expect(JSON.stringify(readTrajectory(dir))).not.toContain(KEY);
    trajectory.close();
  });

  test("a scored run on the same reading plays on", async () => {
    const { trajectory, options } = setup(new StubAdapter(turns(2)), "e90");
    const gauge = new GoUsageGauge(CRED, "u", KEY, () => {}, { fetch: fakeFetch([body(95, 20)]) });
    expect(await runLoop({ ...options, usage: gauge })).toEqual({ kind: "terminated", reason: "stub-complete" });
    trajectory.close();
  });

  test("a spent allowance (quota-exhausted, no stated reset) waits for the spent window's reset", async () => {
    const spent: ChatAdapter = {
      label: "go-spent",
      complete: (): Promise<AdapterOutcome> => Promise.resolve({ kind: "pause", reason: "quota-exhausted", detail: "429 GoUsageLimitError" }),
    };
    const { dir, trajectory, options } = setup(spent, "e90");
    const gauge = new GoUsageGauge(CRED, "u", KEY, (u) => trajectory.recordSubscriptionUsage(u), { fetch: fakeFetch([body(99, 20, 3 * H)]) });
    const outcome = await runLoop({ ...options, usage: gauge });
    expect(outcome).toMatchObject({ kind: "paused", reason: "quota-exhausted" });
    const notBefore = outcome.kind === "paused" ? outcome.notBefore! : 0;
    expect(Math.abs(notBefore - (Date.now() + 3 * H))).toBeLessThan(5_000);
    expect(readTrajectory(dir).find((r) => r.t === "pause")?.["notBefore"]).toBe(notBefore);
    // Recorded as spent, so the credential's budget holds the next attempt until then.
    expect(readMeta(dir)!.subscriptionUsage!.windows[0]!.usedPercent).toBe(100);
    trajectory.close();
  });

  test("a response billed to the balance is recorded and marks the allowance spent: freeplay stops at the boundary", async () => {
    let turn = 0;
    const billed: ChatAdapter = {
      label: "go-billed",
      complete: (): Promise<AdapterOutcome> => {
        turn++;
        return Promise.resolve({
          kind: "ok",
          turn: {
            content: "acting",
            toolCalls: [{ id: `c${turn}`, name: "run_snippet", arguments: JSON.stringify({ code: "1" }) }],
            raw: { usage: { cost: 0.01, opencode: { billing_source: turn >= 2 ? "balance" : "go" } } },
          },
        });
      },
    };
    const { dir, trajectory, options } = setup(billed, "freeplay");
    const gauge = new GoUsageGauge(CRED, "u", KEY, (u) => trajectory.recordSubscriptionUsage(u), { fetch: fakeFetch([body(20, 10)]) });
    const outcome = await runLoop({ ...options, usage: gauge });
    expect(outcome).toMatchObject({ kind: "paused", reason: "subscription-budget" });
    expect(turn).toBe(2);
    const meta = readMeta(dir)!;
    expect(meta.credentialOverage).toMatchObject({ credential: CRED });
    expect(meta.subscriptionUsage!.windows.some((w) => w.usedPercent >= 100)).toBe(true);
    const recs = readTrajectory(dir).filter((r) => r.t === "harness" && r["kind"] === "usage_overage");
    expect(recs).toHaveLength(1);
    expect(JSON.stringify(readTrajectory(dir))).not.toContain(KEY);
    trajectory.close();
  });

  test("a scored run billed to the balance plays on, recording the charge once per stretch", async () => {
    let turn = 0;
    const billed: ChatAdapter = {
      label: "go-billed",
      complete: (): Promise<AdapterOutcome> => {
        turn++;
        if (turn > 3) return Promise.resolve({ kind: "stub-complete" });
        return Promise.resolve({ kind: "ok", turn: { content: "acting", toolCalls: [], raw: { usage: { opencode: { billing_source: "balance" } } } } });
      },
    };
    const { dir, trajectory, options } = setup(billed, "e90");
    // No gauge (a credential with no usage budget): recorded all the same.
    expect(await runLoop(options)).toEqual({ kind: "terminated", reason: "stub-complete" });
    expect(readTrajectory(dir).filter((r) => r.t === "harness" && r["kind"] === "usage_overage")).toHaveLength(1);
    expect(readMeta(dir)!.credentialOverage).toMatchObject({ credential: CRED });
    trajectory.close();
  });

  test("an unreadable endpoint holds nothing: the run plays as before", async () => {
    const { trajectory, options } = setup(new StubAdapter(turns(2)), "freeplay");
    const gauge = new GoUsageGauge(CRED, "u", KEY, () => {}, { fetch: fakeFetch([{ odd: true }]) });
    expect(await runLoop({ ...options, usage: gauge })).toEqual({ kind: "terminated", reason: "stub-complete" });
    trajectory.close();
  });
});
