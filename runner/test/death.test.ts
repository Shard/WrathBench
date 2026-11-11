/**
 * The death records: the transitions the stack recorded off the events that
 * carry them (`@wrathbench/mcp/record`, the session record's `events` stream),
 * handed to the loop by the runner's host (`SandboxHost.deathSignals`, through
 * `RecordSignals`) and written as `death` / `release` / `resurrect` milestones.
 *
 * The watcher itself, frame by frame, is the stack's and is tested there
 * (`wrath-mcp/mcp/test/record-watchers.test.ts`). Here: that the runner's host
 * hands the loop what the stack recorded from a real child, that a host
 * keeping no record says so by throwing and the loop then reads the window
 * from its sample, and that the loop writes what it is handed. Frames are
 * hand-written from wrath-mcp/module/PROTOCOL.md's own tables; positions are
 * invented and nothing here is captured from a running game (CLAUDE.md).
 *
 * The shape of the sequence is the one run
 * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2` produced three times and
 * the sampled window read caught none of: own health to zero, `repop()`, the
 * graveyard, the Spirit Healer, health back — the whole window inside 30s,
 * against a 60s sample.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import type { DeathSignal } from "../src/sandbox/signals";
import { openSessionRecord } from "../src/session-record";
import { Scratchpad } from "@wrathbench/mcp";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const hosts: SandboxHost[] = [];

/** A real runner host; with `record`, the run's session record as run.ts opens it. */
function makeHost(o: { record?: boolean } = {}): SandboxHost {
  const runsDir = tempDir("wrathbench-death-");
  const runDir = join(runsDir, "run-death");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(runsDir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    ...(o.record === true ? { session: openSessionRecord({ runDir, runsDir, token: "test-token", scrub: (t) => t }) } : {}),
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * Enter the world as guid "7" and expose the frames a death is made of.
 * Opcode ids are PROTOCOL.md's: `WB_SESSION_STATE` 0xFF03 (which carries the
 * position and the zone/area pair a reattaching client is given),
 * `SMSG_UPDATE_OBJECT` 0x0A9, `SMSG_DEATH_RELEASE_LOC` 0x378,
 * `SMSG_CORPSE_RECLAIM_DELAY` 0x269. Zone and area names are left empty: the
 * ids are all this reads, and game text does not belong in the repo.
 */
const PRELUDE = `
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
};
globalThis.selfFields = (fields) =>
  feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] });
globalThis.releaseLoc = (map, x, y, z) => feed("SMSG_DEATH_RELEASE_LOC", 0x378, { map, x, y, z });
globalThis.reclaimDelay = (delayMs) => feed("SMSG_CORPSE_RECLAIM_DELAY", 0x269, { delayMs });
feed("WB_SESSION_STATE", 0xff03, {
  character: "Fenwick", guid: "7", inWorld: true,
  map: 0, x: -6572, y: 405, z: 387, o: 1.7, level: 7,
  zoneId: 1, zoneName: "", areaId: 132, areaName: "",
});
selfFields({ health: 186, maxHealth: 186, playerFlags: 0 });
`;

/** One whole window: death, repop to the graveyard, the Spirit Healer. */
const WINDOW = `
  selfFields({ health: 0 });
  reclaimDelay(30000);
  releaseLoc(0, -6164, 336, 399);
  selfFields({ playerFlags: 0x10, health: 1 });
  releaseLoc(-1, 0, 0, 0);
  selfFields({ playerFlags: 0, health: 132 });
  "fed";
`;

describe("the runner's host hands the loop what the stack recorded", () => {
  test("a death, release and resurrect the child saw come back from the session record, in order and drained once", async () => {
    const host = makeHost({ record: true });
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    // Nothing has happened: the drain is empty, not undefined.
    expect(await host.deathSignals()).toEqual([]);
    expect((await host.evalSnippet(WINDOW)).ok).toBe(true);
    // No record tick has run since: `deathSignals` forces one drain itself.
    const signals = await host.deathSignals();
    expect(signals.map((s) => s.kind)).toEqual(["death", "release", "resurrect"]);
    expect(signals[0]).toMatchObject({ position: { map: 0, x: -6572, y: 405, z: 387, source: "death_spot" }, zone: 1, area: 132, released: false });
    expect(signals[1]!.graveyard).toEqual({ map: 0, x: -6164, y: 336, z: 399 });
    // Each carries the timestamp and seq of the event that made it.
    expect(signals[0]!.ts).toBeLessThan(signals[1]!.ts);
    expect(signals[1]!.ts).toBeLessThan(signals[2]!.ts);
    expect(signals.every((s) => s.seq > 0)).toBe(true);
    // Draining is destructive: the same window is never written twice.
    expect(await host.deathSignals()).toEqual([]);
  });

  test("a host that keeps no record throws from every drain, and the loop reads the death from its sample instead", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    await expect(host.deathSignals()).rejects.toThrow("keeps no session record");
    await expect(host.flightSignals()).rejects.toThrow("keeps no session record");
    await expect(host.partySignals()).rejects.toThrow("keeps no session record");

    // The loop over that real host: the throw is "no drain", and the sampled
    // window read is the producer. The first sample seeds it alive; the
    // second lands inside the window, a corpse in the cache.
    const dir = tempDir("wrathbench-death-fallback-");
    let clock = 1_000_000;
    const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }), runId: "run-test", token: "run-test" };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
    const ctx = new ContextBuilder({
      config,
      sandbox: host,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      now: () => clock,
    });
    expect(await ctx.sampleState()).not.toBeNull();
    expect(deathRecords(dir)).toEqual([]);
    await host.evalSnippet('selfFields({ health: 0 }); reclaimDelay(30000); "fed";');
    clock += 60_000;
    await ctx.sampleState();
    expect(deathRecords(dir).map((r) => r["kind"])).toEqual(["death"]);
    expect(deathRecords(dir)[0]).toMatchObject({ zone: { id: 1 }, area: { id: 132 } });
    trajectory.close();
  });
});

/** A sandbox whose only job is to hand the loop a queue of drained signals. */
function fakeSandbox(queue: DeathSignal[][], snapshot: Record<string, unknown> = {}): SandboxHost {
  const fake = {
    evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () =>
      Promise.resolve({ self: { guid: "7" }, lastSeq: 1, eventCount: 1, ...snapshot }),
    deathSignals: () => Promise.resolve(queue.shift() ?? []),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  };
  return fake as unknown as SandboxHost;
}

/**
 * A builder over a fake sandbox and a clock the test moves itself: the sample
 * is gated on `stateIntervalMs`, and a run's samples are 60s apart, so the
 * tests step the clock exactly that far rather than racing the millisecond.
 */
function builder(queue: DeathSignal[][], snapshot: Record<string, unknown> = {}) {
  const dir = tempDir("wrathbench-death-loop-");
  let clock = 1_000_000;
  const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }), runId: "run-test", token: "run-test" };
  const trajectory = new Trajectory(dir);
  trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
  const ctx = new ContextBuilder({
    config,
    sandbox: fakeSandbox(queue, snapshot),
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    trajectory,
    watchdogs: new Watchdogs(config.watchdogs),
    now: () => clock,
  });
  return {
    dir,
    ctx,
    trajectory,
    /** One state sample, a fleet interval after the last. */
    sample: async (): Promise<void> => {
      clock += 60_000;
      await ctx.sampleState();
    },
  };
}

function deathRecords(dir: string): Record<string, unknown>[] {
  return readTrajectory(dir).filter(
    (r) => r.t === "milestone" && (r["kind"] === "death" || r["kind"] === "release" || r["kind"] === "resurrect"),
  );
}

describe("the loop writes what the child latched", () => {
  test("a whole death that opened and closed between two samples is still recorded", async () => {
    const { dir, sample, trajectory } = builder([
      [],
      [
        {
          kind: "death",
          ts: 4444,
          seq: 9,
          position: { map: 0, x: -6572, y: 405, z: 387, source: "death_spot" },
          zone: 1,
          area: 132,
          released: false,
        },
        { kind: "release", ts: 4460, seq: 12, graveyard: { map: 0, x: -6164, y: 336, z: 399 } },
        { kind: "resurrect", ts: 4490, seq: 20 },
      ],
    ]);
    await sample();
    await sample();
    const ms = deathRecords(dir);
    expect(ms.map((r) => r["kind"])).toEqual(["death", "release", "resurrect"]);
    // The death event's own timestamp, not the sample's — the record's `ts` is
    // when the sample landed and stays a different fact.
    expect(ms[0]!["observedTs"]).toBe(4444);
    expect(ms[0]!["position"]).toEqual({ map: 0, x: -6572, y: 405, z: 387, source: "death_spot" });
    expect(ms[0]!["zone"]).toEqual({ id: 1 });
    expect(ms[0]!["area"]).toEqual({ id: 132 });
    expect(ms[0]!["released"]).toBe(false);
    expect(ms[1]!["graveyard"]).toEqual({ map: 0, x: -6164, y: 336, z: 399 });
    trajectory.close();
  });

  test("two cycles drained in one sample are two deaths, in order", async () => {
    const cycle = (t: number): DeathSignal[] => [
      { kind: "death", ts: t, seq: t },
      { kind: "release", ts: t + 5, seq: t + 5 },
      { kind: "resurrect", ts: t + 9, seq: t + 9 },
    ];
    const { dir, sample, trajectory } = builder([[...cycle(100), ...cycle(200)]]);
    await sample();
    const ms = deathRecords(dir);
    expect(ms.map((r) => r["kind"])).toEqual([
      "death",
      "release",
      "resurrect",
      "death",
      "release",
      "resurrect",
    ]);
    expect(ms.map((r) => r["observedTs"]).filter((v) => v !== undefined)).toEqual([100, 200]);
    trajectory.close();
  });

  test("the signal's own zone falls back to the sample's when the cache had none", async () => {
    const { dir, sample, trajectory } = builder([[{ kind: "death", ts: 7, seq: 7 }]]);
    await sample();
    const death = deathRecords(dir)[0]!;
    // The fake snapshot names no zone either, so nothing is invented.
    expect(death["zone"]).toBeUndefined();
    expect(death["position"]).toBeUndefined();
    expect(death["observedTs"]).toBe(7);
    trajectory.close();
  });

  test("the window read stays silent while the signals own the window", async () => {
    // The sample a mid-window drain actually lands on: health 0, a corpse the
    // cache is holding, and `playerFlags` a stale 0 — the ordinary reading,
    // since an update block need not carry the flag. The window read would call
    // that stale 0 a resurrect the moment the signals reported the release, and
    // would re-read the corpse as a second death; both belong to the signals.
    const midWindow = {
      self: {
        guid: "7",
        fields: { health: { value: 0, seq: 9, ts: 4444 }, playerFlags: { value: 0, seq: 9, ts: 4444 } },
        corpse: { value: { map: 0, x: -6572, y: 405, z: 387, source: "death_spot" }, seq: 9, ts: 4444 },
      },
    };
    const open = builder(
      [
        [],
        [
          { kind: "death", ts: 4444, seq: 9 },
          { kind: "release", ts: 4460, seq: 12, graveyard: { map: 0, x: -6164, y: 336, z: 399 } },
        ],
      ],
      midWindow,
    );
    // The first sample seeds the latches from a living reading, so the window
    // read is armed rather than seeding silently on the dead one.
    await open.sample();
    await open.sample();
    expect(deathRecords(open.dir).map((r) => r["kind"])).toEqual(["death", "release"]);
    open.trajectory.close();

    // And a whole cycle drained at one sample: the snapshot was taken before
    // the drain and still shows the corpse, which is not a second death.
    const closed = builder(
      [
        [],
        [
          { kind: "death", ts: 4444, seq: 9 },
          { kind: "release", ts: 4460, seq: 12 },
          { kind: "resurrect", ts: 4490, seq: 20 },
        ],
      ],
      midWindow,
    );
    await closed.sample();
    await closed.sample();
    expect(deathRecords(closed.dir).map((r) => r["kind"])).toEqual(["death", "release", "resurrect"]);
    closed.trajectory.close();
  });

  test("a sandbox with no drain at all leaves the window read as the producer", async () => {
    // The fallback path: an older child, or a restarted one. `loop.test.ts`
    // covers what the window read then produces; here it is enough that the
    // sample does not throw on the missing method.
    const fake = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () => Promise.resolve({ self: { guid: "7" } }),
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;
    const dir = tempDir("wrathbench-death-nodrain-");
    const config = { ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }), runId: "run-test", token: "run-test" };
    const trajectory = new Trajectory(dir);
    trajectory.writeMeta({ runId: "run-test", harnessVersion: "t", startedAt: Date.now(), config });
    const ctx = new ContextBuilder({
      config,
      sandbox: fake,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
    });
    expect(await ctx.sampleState()).not.toBeNull();
    expect(deathRecords(dir)).toHaveLength(0);
    trajectory.close();
  });
});
