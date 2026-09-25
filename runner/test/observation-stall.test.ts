/**
 * The stall detector: what the sampler writes when the child's observation of
 * the world has stopped arriving.
 *
 * The state sample is a read over the sandbox child's state cache, and that
 * read is local: it cannot fail, and a cache nothing folds into any more reads
 * exactly like a world in which nothing happens. A freeplay run whose snippet
 * closed the child's own event stream kept writing the same level, position
 * and cursor for fifteen hours while the character played on. Both halves are
 * fixture-based: the loop half runs the real `ContextBuilder` over a fake
 * sandbox, the child half asks the real sandbox process what it says about its
 * own stream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubAdapter } from "../src/adapter";
import { loadRunConfig } from "../src/config";
import { EpisodicLog } from "../src/episodic";
import { STALL_PAUSE } from "../src/lapse";
import { ContextBuilder, runLoop, type StopRequest } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import { Workspace } from "../src/workspace";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";

/** The snapshot the loop reads, with the cursor and the stream slot a test rewrites. */
function harness(slot: { eventCount: number; lastSeq: number; connected?: boolean }, onObservationStalled?: (detail: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-stall-"));
  let clock = 1_000_000;
  const config = {
    ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }),
    runId: "run-stall",
    token: "run-stall",
  };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-stall", harnessVersion: "t", startedAt: 1, config });
  const sandbox = {
    evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () =>
      Promise.resolve({
        self: { guid: "7", level: { value: 9, seq: 1, ts: 1 } },
        lastSeq: slot.lastSeq,
        eventCount: slot.eventCount,
        ...(slot.connected === undefined ? {} : { observation: { connected: slot.connected } }),
      }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  } as unknown as SandboxHost;
  const ctx = new ContextBuilder({
    config,
    sandbox,
    workspace: new Workspace(join(dir, "workspace")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
    now: () => clock,
    onObservationStalled,
  });
  return {
    dir,
    trajectory,
    /** One written sample: the clock clears the 60s row cadence every time. */
    sample: async (): Promise<void> => {
      clock += 60_000;
      await ctx.sampleState();
    },
    records: (kind: string) => readTrajectory(dir).filter((r) => r.t === "harness" && r["kind"] === kind),
  };
}

describe("the sampler names an observation that stopped arriving", () => {
  test("a closed stream behind a standing cursor is named, reasserted, and the rows keep coming", async () => {
    const slot = { eventCount: 220_302, lastSeq: 219_471, connected: false };
    const h = harness(slot);
    for (let i = 0; i < 7; i++) await h.sample();
    const stalled = h.records("observation_stalled");
    // The first sample arms the detector by seeing the cursor at all; the six
    // that follow find it standing still, and the stall is reasserted every
    // third of them so a run paused inside one ends beside the verdict.
    expect(stalled.map((r) => r["samples"])).toEqual([3, 6]);
    expect(stalled[0]!["eventCount"]).toBe(220_302);
    expect(stalled[0]!["lastSeq"]).toBe(219_471);
    // The state rows are still written: the last known reading is what a
    // resumed run counts its turns from.
    expect(h.trajectory.stateRows("run-stall").length).toBe(7);
    h.trajectory.close();
  });

  test("a cursor that keeps moving is never a stall, however the stream reads", async () => {
    const slot = { eventCount: 1, lastSeq: 1, connected: false };
    const h = harness(slot);
    for (let i = 0; i < 6; i++) {
      slot.eventCount++;
      slot.lastSeq++;
      await h.sample();
    }
    expect(h.records("observation_stalled")).toHaveLength(0);
    h.trajectory.close();
  });

  test("a run whose first snippet has not connected yet is not a stall", async () => {
    // Nothing has been observed at all: cursor at zero, stream not open. That
    // is every run's opening minutes, and it must stay silent.
    const h = harness({ eventCount: 0, lastSeq: -1, connected: false });
    for (let i = 0; i < 6; i++) await h.sample();
    expect(h.records("observation_stalled")).toHaveLength(0);
    h.trajectory.close();
  });

  test("a drop the reconnect ladder repairs passes without a record", async () => {
    const slot = { eventCount: 10, lastSeq: 10, connected: true };
    const h = harness(slot);
    await h.sample();
    slot.connected = false;
    await h.sample();
    slot.connected = true;
    slot.eventCount += 40;
    slot.lastSeq += 40;
    await h.sample();
    expect(h.records("observation_stalled")).toHaveLength(0);
    expect(h.records("observation_resumed")).toHaveLength(0);
    h.trajectory.close();
  });

  test("a sandbox restart does not disarm a run that had been observing", async () => {
    // The fresh child counts from zero again, and its stream never opens: the
    // arming latch is the run's history, not this sample's cursor.
    const slot = { eventCount: 4_000, lastSeq: 4_000, connected: true };
    const h = harness(slot);
    await h.sample();
    slot.eventCount = 0;
    slot.lastSeq = -1;
    slot.connected = false;
    for (let i = 0; i < 5; i++) await h.sample();
    expect(h.records("observation_stalled")).toHaveLength(1);
    h.trajectory.close();
  });

  test("a stall that ends is closed on the record", async () => {
    const slot = { eventCount: 100, lastSeq: 100, connected: false };
    const h = harness(slot);
    for (let i = 0; i < 5; i++) await h.sample();
    expect(h.records("observation_stalled")).toHaveLength(1);
    slot.connected = true;
    slot.eventCount += 12;
    slot.lastSeq += 12;
    await h.sample();
    const resumed = h.records("observation_resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!["eventCount"]).toBe(112);
    // ... and a stall afterwards is a second one, not a repeat of the first.
    slot.connected = false;
    for (let i = 0; i < 4; i++) await h.sample();
    expect(h.records("observation_stalled")).toHaveLength(2);
    h.trajectory.close();
  });

  test("a sandbox that says nothing about its stream is never called stalled", async () => {
    const h = harness({ eventCount: 500, lastSeq: 500 });
    for (let i = 0; i < 6; i++) await h.sample();
    expect(h.records("observation_stalled")).toHaveLength(0);
    h.trajectory.close();
  });
});

describe("a stalled observation asks for the pause", () => {
  test("once, on the first stall record, and not before", async () => {
    const asked: string[] = [];
    const slot = { eventCount: 900, lastSeq: 900, connected: false };
    const h = harness(slot, (detail) => asked.push(detail));
    // The arming sample and two standing ones: inside the reconnect window.
    for (let i = 0; i < 3; i++) await h.sample();
    expect(asked).toHaveLength(0);
    await h.sample();
    expect(asked).toHaveLength(1);
    // The request carries the record's own sentence.
    expect(asked[0]).toBe(h.records("observation_stalled")[0]!["detail"] as string);
    // A builder that keeps sampling (nobody honoured the request) reasserts
    // the record but never asks twice.
    for (let i = 0; i < 6; i++) await h.sample();
    expect(h.records("observation_stalled")).toHaveLength(3);
    expect(asked).toHaveLength(1);
    h.trajectory.close();
  });

  test("a drop the reconnect ladder repairs never asks", async () => {
    const asked: string[] = [];
    const slot = { eventCount: 10, lastSeq: 10, connected: true };
    const h = harness(slot, (detail) => asked.push(detail));
    await h.sample();
    slot.connected = false;
    await h.sample();
    await h.sample();
    slot.connected = true;
    slot.eventCount += 5;
    slot.lastSeq += 5;
    for (let i = 0; i < 4; i++) {
      slot.eventCount++;
      slot.lastSeq++;
      await h.sample();
    }
    expect(asked).toHaveLength(0);
    h.trajectory.close();
  });

  test("a sandbox restart whose fresh child never reconnects asks too", async () => {
    // The likeliest real trigger: the child is rebuilt (a runaway snippet, a
    // long provider request) and nothing calls connect() in it again.
    const asked: string[] = [];
    const slot = { eventCount: 4_000, lastSeq: 4_000, connected: true };
    const h = harness(slot, (detail) => asked.push(detail));
    await h.sample();
    slot.eventCount = 0;
    slot.lastSeq = -1;
    slot.connected = false;
    for (let i = 0; i < 4; i++) await h.sample();
    expect(asked).toHaveLength(1);
    h.trajectory.close();
  });

  test("the fixed loop pauses as observation-stalled before it writes another request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-stall-loop-"));
    const config = {
      ...loadRunConfig({ driver: "stub", stepIntervalMs: 0, stateIntervalMs: 1_000 }),
      runId: "run-stall-loop",
      token: "run-stall-loop",
    };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-stall-loop", harnessVersion: "t", startedAt: 1, config });
    // Observed once, then a closed stream behind a standing cursor for good.
    let samples = 0;
    const sandbox = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () => {
        samples++;
        return Promise.resolve({
          self: { guid: "7", level: { value: 9, seq: 1, ts: 1 } },
          lastSeq: 300,
          eventCount: 300,
          observation: { connected: samples === 1 },
        });
      },
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;
    // What run.ts does with the request: a pause, through the same abort a
    // supervisor stop uses, so every driver honours it on its existing path.
    const abort = new AbortController();
    let clock = 0;
    const outcome = await runLoop({
      config,
      adapter: new StubAdapter(Array.from({ length: 10 }, (_, i) => ({ content: `turn ${i + 1}`, toolCalls: [] }))),
      sandbox,
      workspace: new Workspace(join(dir, "workspace")),
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      sleep: () => Promise.resolve(),
      now: () => (clock += 60_000),
      signal: abort.signal,
      onObservationStalled: (detail) => abort.abort({ kind: "pause", reason: STALL_PAUSE, detail } satisfies StopRequest),
    });
    expect(outcome.kind).toBe("paused");
    expect(outcome.kind === "paused" ? outcome.reason : null).toBe("observation-stalled");
    expect(trajectory.runRow("run-stall-loop")?.["pause_reason"]).toBe("observation-stalled");
    expect(trajectory.runRow("run-stall-loop")?.["termination_reason"]).toBeNull();
    const records = readTrajectory(dir);
    // Three turns went out; the fourth turn's sample found the stall and the
    // pause won before its request was written.
    expect(records.filter((r) => r.t === "request")).toHaveLength(3);
    expect(records.filter((r) => r.t === "pause").map((r) => r["reason"])).toEqual(["observation-stalled"]);
    const stall = records.findIndex((r) => r.t === "harness" && r["kind"] === "observation_stalled");
    const pause = records.findIndex((r) => r.t === "pause");
    expect(stall).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(stall);
    trajectory.close();
  });
});

const hosts: SandboxHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

describe("sandbox child: the stream report rides the state snapshot", () => {
  test("the child says whether its own event stream is open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-stall-child-"));
    const host = new SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      workspace: new Workspace(join(dir, "workspace")),
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
    });
    hosts.push(host);
    // Nothing has opened a socket in this child, so the report is a plain
    // `false` — the fact the HUD has no field for and the detector needs.
    const snap = await host.stateSnapshot();
    expect(snap["observation"]).toEqual({ connected: false });
  });
});
