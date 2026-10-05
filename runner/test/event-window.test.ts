/**
 * The per-turn event window: ambient movement excluded FIRST, then the last
 * `CONTEXT_POLICY.EVENT_WINDOW` of what remains (context.ts,
 * `EVENT_WINDOW_EXCLUDE`; operator decision, 2026-10-05).
 *
 * Three layers, all fixture-based. The sandbox child's own ring of non-ambient
 * events, run for real against a hand-fed event stream (no game stack; frames
 * hand-written from module/PROTOCOL.md's tables, positions invented). The
 * context builder, over a fake sandbox, for what it renders and what it logs.
 * And the pure `eventWindow` / `assembleContext` pair.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { CONTEXT_POLICY, assembleContext, eventWindow } from "../src/context";
import { ContextBuilder } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import type { ContextEvents, EventSummary } from "../src/sandbox/ipc";
import { Scratchpad } from "../src/scratchpad";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const hosts: SandboxHost[] = [];

function makeHost(): SandboxHost {
  const dir = tempDir("wrathbench-window-");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * `swings(n)` feeds n bodiless swing errors (a non-ambient opcode), `ambient(n)`
 * n transport progress frames — the once-a-second-per-car report that made up
 * most of the stream on a continent with trams and boats.
 */
const PRELUDE = `
globalThis.seq = 0;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1_700_000_000_000 + seq, data }));
};
globalThis.swings = (n) => { for (let i = 0; i < n; i++) feed("SMSG_ATTACKSWING_NOTINRANGE", 0x145, {}); };
globalThis.ambient = (n) => {
  for (let i = 0; i < n; i++) {
    feed("WB_TRANSPORT_PROGRESS", 0xff06, { guid: "1f0001", entry: 176080, pos: { x: 1, y: 2, z: 3, o: 0 }, progressMs: i, periodMs: 120000 });
  }
};
"ready";
`;

describe("the sandbox child's window: non-ambient events, ringed apart from the SDK buffer", () => {
  test("reaches past any number of ambient events, and counts the ones in the span it covers", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    // Ten signal events, then more ambient ones than the SDK buffer holds.
    await host.evalSnippet('swings(10); ambient(600); swings(3); ambient(50); "fed";');

    // The SDK's whole buffer (500 events) has lost the first ten to the
    // ambient flood: filtering it could never have shown them...
    const raw = await host.recentEvents(500);
    expect(raw.filter((e) => !CONTEXT_POLICY.EVENT_WINDOW_EXCLUDE.test(e.opcode))).toHaveLength(3);

    // ...while the window holds every signal event so far, and since that is
    // every one this child has seen, the span is its whole life.
    const all = await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW);
    expect(all.events).toHaveLength(13);
    expect(all.events.every((e) => e.opcode === "SMSG_ATTACKSWING_NOTINRANGE")).toBe(true);
    expect(all.folded).toBe(650);

    // Past the cap: the last 64 signal events, and only the ambient ones that
    // arrived after the oldest of them.
    await host.evalSnippet('swings(60); ambient(7); swings(4); ambient(5); "fed";');
    const capped = await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW);
    expect(capped.events).toHaveLength(CONTEXT_POLICY.EVENT_WINDOW);
    // 77 signal events in all: the oldest shown is the 14th, the first of the
    // 60, so the span holds the 7 and the 5 fed after it, not the 650 before.
    expect(capped.folded).toBe(12);
    const seqs = capped.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // A smaller ask is the newest of the same.
    const four = await host.contextEvents(4);
    expect(four.events.map((e) => e.seq)).toEqual(seqs.slice(-4));
    expect(four.folded).toBe(5);
  });

  test("an all-ambient stream says how much it folded, and an untouched one is empty", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    expect(await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW)).toEqual({ events: [], folded: 0 });
    await host.evalSnippet('ambient(20); "fed";');
    expect(await host.contextEvents(CONTEXT_POLICY.EVENT_WINDOW)).toEqual({ events: [], folded: 20 });
  });
});

function ev(seq: number, opcode: string): EventSummary {
  return { seq, ts: 1000 + seq, opcode, data: {} };
}

function builderOver(sandbox: Record<string, unknown>) {
  const dir = tempDir("wrathbench-window-loop-");
  const config = { ...loadRunConfig({ driver: "stub" }), runId: "run-test", token: "run-test" };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  const fake = {
    evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
    stateSnapshot: () => Promise.resolve({ self: { guid: "7" }, lastSeq: 1, eventCount: 1 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
    ...sandbox,
  };
  const ctx = new ContextBuilder({
    config,
    sandbox: fake as unknown as SandboxHost,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
  });
  return { dir, ctx, trajectory };
}

describe("the context builder renders the window and logs exactly that", () => {
  test("events_served carries what was rendered and the folded count, never the ambient packets", async () => {
    const window: ContextEvents = { events: [ev(5, "SMSG_ATTACKSTART"), ev(900, "SMSG_LOOT_RESPONSE")], folded: 4_321 };
    const { dir, ctx, trajectory } = builderOver({
      contextEvents: () => Promise.resolve(window),
      recentEvents: () => Promise.reject(new Error("the window must not read the raw tail")),
    });
    const text = await ctx.build(1, []);
    expect(text).toContain("[events: last 2, newest last; 4321 ambient movement events folded into state only]");
    const served = readTrajectory(dir).filter((r) => r.t === "events_served");
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ via: "context", count: 2, folded: 4_321 });
    expect((served[0]!["events"] as EventSummary[]).map((e) => e.seq)).toEqual([5, 900]);
    trajectory.close();
  });

  test("a sandbox without the ring is read over its raw tail, folded the same way", async () => {
    const raw = [ev(1, "SMSG_MONSTER_MOVE"), ev(2, "SMSG_ATTACKSTART"), ev(3, "WB_TRANSPORT_PROGRESS"), ev(4, "MSG_MOVE_HEARTBEAT")];
    const { dir, ctx, trajectory } = builderOver({ recentEvents: () => Promise.resolve(raw) });
    const text = await ctx.build(1, []);
    expect(text).toContain("[events: last 1, newest last; 3 ambient movement events folded into state only]");
    const served = readTrajectory(dir).filter((r) => r.t === "events_served")[0]!;
    expect(served).toMatchObject({ via: "context", count: 1, folded: 3 });
    expect((served["events"] as EventSummary[]).map((e) => e.opcode)).toEqual(["SMSG_ATTACKSTART"]);
    trajectory.close();
  });
});

describe("eventWindow and assembleContext", () => {
  const base = { stateSummary: "[state]", scratchpad: "", notices: [], turn: 3 };

  test("excludes ambient first, then keeps the last EVENT_WINDOW of the rest", () => {
    const events: EventSummary[] = [];
    for (let i = 0; i < 100; i++) events.push(ev(2 * i, "SMSG_ATTACKSTART"), ev(2 * i + 1, "WB_TRANSPORT_PROGRESS"));
    const { window, folded } = eventWindow(events, 7);
    expect(window).toHaveLength(CONTEXT_POLICY.EVENT_WINDOW);
    expect(window.every((e) => e.opcode === "SMSG_ATTACKSTART")).toBe(true);
    expect(window[window.length - 1]!.seq).toBe(198);
    expect(folded).toBe(107);
  });

  test("the folded count the sandbox reports reaches the line, and an all-ambient span still says so", () => {
    expect(assembleContext({ ...base, events: [ev(1, "SMSG_ATTACKSTART")], folded: 12 })).toContain(
      "[events: last 1, newest last; 12 ambient movement events folded into state only]",
    );
    expect(assembleContext({ ...base, events: [], folded: 9 })).toContain(
      "[events]\nno non-movement events; 9 ambient movement events folded into state only",
    );
    expect(assembleContext({ ...base, events: [] })).toContain("[events]\nnone yet");
  });
});
