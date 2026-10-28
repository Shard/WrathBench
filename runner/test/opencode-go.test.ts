/**
 * OpenCode Go's allowance as a subscription lane (operator, 2026-10-16): the
 * usage endpoint's reader, the once-a-minute poller, and the fixed loop's use
 * of it — the freeplay gate at the turn boundary and a spent allowance's
 * reset. A fake fetch and synthetic figures only; no network.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { StubAdapter, type AdapterOutcome, type ChatAdapter } from "../src/adapter";
import { loadRunConfig } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { runLoop } from "../src/loop";
import { GO_USAGE_PATH, GoUsageGauge, GoUsagePoller, goUsageUrl, goUsageWindows, readGoUsage, type GoFetch } from "../src/opencode-go";
import { Scratchpad } from "@wrathbench/mcp";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const H = 3_600_000;
const KEY = "fake-go-key-never-logged";
const LANE = "opencode-go:OPENCODE_KEY";

/** A Go usage body in the endpoint's shape: synthetic percents, resets `inMs` from now as ISO dates. */
function body(rolling: number, weekly: number, inMs = 2 * H, status = "ok"): Record<string, unknown> {
  const resetsAt = new Date(Date.now() + inMs).toISOString();
  return {
    rolling: { status, percent: rolling, resetsAt },
    weekly: { status: "ok", percent: weekly, resetsAt: new Date(Date.now() + 50 * H).toISOString() },
    monthly: { status: "ok", percent: 3, resetsAt: new Date(Date.now() + 400 * H).toISOString() },
  };
}

/** A fetch that answers `answers` in turn (the last one repeats), counting its calls. */
function fakeFetch(answers: (unknown | Error | number)[]): GoFetch & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    if (typeof a === "number") return { ok: false, status: a, json: () => Promise.resolve({}) };
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

  test("windows are read tolerantly: percent, length where named, reset in any spelling; a spent status reads 100", () => {
    const at = Date.UTC(2030, 0, 1);
    expect(
      goUsageWindows({
        rolling: { status: "ok", percent: 12, resetsAt: new Date(at).toISOString() },
        weekly: { status: "ok", percent: 40, resetsAt: at / 1000 },
        monthly: { status: "exceeded", percent: 97, resetsAt: at },
      }),
    ).toEqual([
      { usedPercent: 12, windowMinutes: null, resetsAt: at },
      { usedPercent: 40, windowMinutes: 10_080, resetsAt: at },
      { usedPercent: 100, windowMinutes: null, resetsAt: at },
    ]);
    // Nested under a key, too.
    expect(goUsageWindows({ usage: { weekly: { percent: 5, resetsAt: at } } })).toEqual([{ usedPercent: 5, windowMinutes: 10_080, resetsAt: at }]);
    // A shape this does not know is no observation.
    expect(goUsageWindows({ balance: 3 })).toBeUndefined();
    expect(goUsageWindows("nope")).toBeUndefined();
    expect(goUsageWindows({ weekly: { percent: "lots" } })).toBeUndefined();
  });

  test("one read sends the key as a bearer token and never returns it; failures are words, never throws", async () => {
    const ok = fakeFetch([body(10, 20)]);
    const r = await readGoUsage("https://opencode.ai/inference/go/v1/usage", KEY, ok);
    expect("windows" in r && r.windows.length).toBe(3);
    expect(ok.calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(await readGoUsage("u", KEY, fakeFetch([500]))).toEqual({ why: "HTTP 500" });
    expect(await readGoUsage("u", KEY, fakeFetch([{ odd: true }]))).toEqual({ why: "a response shape this reader does not know" });
    const thrown = await readGoUsage("u", KEY, fakeFetch([new TypeError(`failed for ${KEY}`)]));
    expect(thrown).toEqual({ why: "TypeError" });
    expect(JSON.stringify(thrown)).not.toContain(KEY);
  });
});

describe("GoUsagePoller", () => {
  test("calls at most once a minute, keeps the newest reading, and says an unreadable lane once", async () => {
    let now = 1_000_000;
    const f = fakeFetch([{ odd: true }, { odd: true }, body(30, 10)]);
    const notes: string[] = [];
    const p = new GoUsagePoller(LANE, "https://opencode.ai/inference/go/v1/usage", KEY, { fetch: f, now: () => now, onNote: (t) => notes.push(t) });
    await p.refresh();
    await p.refresh(); // within the minute: no call
    expect(f.calls).toHaveLength(1);
    expect(p.current).toBeUndefined();
    now += 60_000;
    await p.refresh();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("its launches are not held");
    for (const n of notes) expect(n).not.toContain(KEY);
    now += 60_000;
    await p.refresh();
    expect(p.current).toMatchObject({ lane: LANE, observedAt: now });
    expect(p.current!.windows[0]!.usedPercent).toBe(30);
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
  const config = { ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1, episode }), runId: "run-test", token: "run-test" };
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
    const gauge = new GoUsageGauge(LANE, "https://opencode.ai/inference/go/v1/usage", KEY, (u) => trajectory.recordSubscriptionUsage(u), { fetch: fakeFetch([body(83, 20)]) });
    const outcome = await runLoop({ ...options, usage: gauge });
    expect(outcome).toMatchObject({ kind: "paused", reason: "subscription-budget" });
    expect(Math.abs((outcome.kind === "paused" ? outcome.notBefore! : 0) - (Date.now() + 2 * H))).toBeLessThan(5_000);
    expect(trajectory.runRow("run-test")?.["pause_reason"]).toBe("subscription-budget");
    expect(readMeta(dir)!.subscriptionUsage).toMatchObject({ lane: LANE });
    // The key is nowhere on the record.
    expect(JSON.stringify(readTrajectory(dir))).not.toContain(KEY);
    trajectory.close();
  });

  test("a scored run on the same reading plays on", async () => {
    const { trajectory, options } = setup(new StubAdapter(turns(2)), "e90");
    const gauge = new GoUsageGauge(LANE, "u", KEY, () => {}, { fetch: fakeFetch([body(95, 20)]) });
    expect(await runLoop({ ...options, usage: gauge })).toEqual({ kind: "terminated", reason: "stub-complete" });
    trajectory.close();
  });

  test("a spent allowance (quota-exhausted, no stated reset) waits for the spent window's reset", async () => {
    const spent: ChatAdapter = {
      label: "go-spent",
      complete: (): Promise<AdapterOutcome> => Promise.resolve({ kind: "pause", reason: "quota-exhausted", detail: "429 GoUsageLimitError" }),
    };
    const { dir, trajectory, options } = setup(spent, "e90");
    const gauge = new GoUsageGauge(LANE, "u", KEY, (u) => trajectory.recordSubscriptionUsage(u), { fetch: fakeFetch([body(99, 20, 3 * H)]) });
    const outcome = await runLoop({ ...options, usage: gauge });
    expect(outcome).toMatchObject({ kind: "paused", reason: "quota-exhausted" });
    const notBefore = outcome.kind === "paused" ? outcome.notBefore! : 0;
    expect(Math.abs(notBefore - (Date.now() + 3 * H))).toBeLessThan(5_000);
    expect(readTrajectory(dir).find((r) => r.t === "pause")?.["notBefore"]).toBe(notBefore);
    // Recorded as spent, so the lane gate holds the next attempt until then.
    expect(readMeta(dir)!.subscriptionUsage!.windows[0]!.usedPercent).toBe(100);
    trajectory.close();
  });

  test("an unreadable endpoint holds nothing: the run plays as before", async () => {
    const { trajectory, options } = setup(new StubAdapter(turns(2)), "freeplay");
    const gauge = new GoUsageGauge(LANE, "u", KEY, () => {}, { fetch: fakeFetch([{ odd: true }]) });
    expect(await runLoop({ ...options, usage: gauge })).toEqual({ kind: "terminated", reason: "stub-complete" });
    trajectory.close();
  });
});
