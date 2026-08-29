/**
 * The death producer: transitions latched in the sandbox child off the events
 * that carry them, drained by the loop's state sample and written as
 * `death` / `release` / `resurrect` milestones.
 *
 * Two halves, both fixture-based. The child half runs the real sandbox process
 * against a fake event stream — no game stack, frames hand-written from
 * module/PROTOCOL.md's own tables (positions are invented; nothing here is
 * captured from a running game, CLAUDE.md). The loop half feeds the drained
 * signals to `ContextBuilder` through a fake sandbox and reads the trajectory.
 *
 * The shape of the sequence is the one run
 * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2` produced three times and
 * the sampled window read caught none of: own health to zero, `repop()`, the
 * graveyard, the Spirit Healer, health back — the whole window inside 30s,
 * against a 60s sample.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import { SandboxHost } from "../src/sandbox/host";
import type { DeathSignal } from "../src/sandbox/ipc";
import { Scratchpad } from "../src/scratchpad";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";

const hosts: SandboxHost[] = [];

function makeHost(): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-death-"));
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

describe("sandbox child: the death window latched from the events", () => {
  test("one death, release and resurrect, in order and with the packets' own facts", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    // Nothing has happened: the drain is empty, not undefined.
    expect(await host.deathSignals()).toEqual([]);

    await host.evalSnippet(`
      // The death: own health to zero. The cache latches the corpse at the
      // spot the character stood on (source "death_spot").
      selfFields({ health: 0 });
      reclaimDelay(30000);
      // repop(): the server answers with the graveyard.
      releaseLoc(0, -6164, 336, 399);
      selfFields({ playerFlags: 0x10, health: 1 });
      // The Spirit Healer: the clear marker, then health back.
      releaseLoc(-1, 0, 0, 0);
      selfFields({ playerFlags: 0, health: 132 });
      "fed";
    `);

    const signals = await host.deathSignals();
    expect(signals.map((s) => s.kind)).toEqual(["death", "release", "resurrect"]);
    const death = signals[0]!;
    expect(death.position).toEqual({ map: 0, x: -6572, y: 405, z: 387, source: "death_spot" });
    // The ghost flag at the instant of death: not yet released. The `release`
    // record a moment later is what says the spirit went to the graveyard.
    expect(death.released).toBe(false);
    // ... and when `playerFlags` has never arrived the field is simply absent,
    // which is the ordinary case: an update block need not carry it.
    expect([death.zone, death.area]).toEqual([1, 132]);
    expect(signals[1]!.graveyard).toEqual({ map: 0, x: -6164, y: 336, z: 399 });
    // Each signal carries the timestamp of the event that made it, and they
    // climb: this is the fact the sampled read could not produce.
    expect(death.ts).toBeLessThan(signals[1]!.ts);
    expect(signals[1]!.ts).toBeLessThan(signals[2]!.ts);
    // Draining is destructive: the same window is never written twice.
    expect(await host.deathSignals()).toEqual([]);
  });

  test("two complete windows between two drains are two deaths", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet(`
      for (const n of [1, 2]) {
        selfFields({ health: 0 });
        releaseLoc(0, -6164, 336, 399);
        releaseLoc(-1, 0, 0, 0);
        selfFields({ health: 100 });
      }
      "fed";
    `);
    const kinds = (await host.deathSignals()).map((s) => s.kind);
    expect(kinds).toEqual(["death", "release", "resurrect", "death", "release", "resurrect"]);
  });

  test("a death with the ghost flag never observed carries no `released` at all", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE.replace(", playerFlags: 0", ""));
    await host.evalSnippet('selfFields({ health: 0 }); "fed";');
    const death = (await host.deathSignals())[0]!;
    expect(death.kind).toBe("death");
    expect(death.released).toBeUndefined();
  });

  test("a stale playerFlags 0 through the whole window is not a resurrect", async () => {
    // The ordinary case, and the one that would have made this producer worse
    // than the sampled read: `playerFlags` need not ride the blocks a death
    // brings, so a ghost can read `ghost === false` for the whole window. Only
    // a bit that was seen *on* means anything when it goes off.
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet(`
      selfFields({ health: 0 });
      releaseLoc(0, -6164, 336, 399);
      reclaimDelay(30000);
      selfFields({ health: 1 });
      "fed";
    `);
    expect((await host.deathSignals()).map((s) => s.kind)).toEqual(["death", "release"]);
  });

  test("a release and resurrect seen only through the ghost flag are read too", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet(`
      selfFields({ health: 0 });
      selfFields({ playerFlags: 0x10, health: 1 });
      selfFields({ playerFlags: 0, health: 1 });
      "fed";
    `);
    expect((await host.deathSignals()).map((s) => s.kind)).toEqual(["death", "release", "resurrect"]);
  });

  test("a corpse that is never released still records the death", async () => {
    // No repop: the character lies dead and the run ends there. The death is
    // still the death.
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet('selfFields({ health: 0 }); reclaimDelay(30000); "fed";');
    expect((await host.deathSignals()).map((s) => s.kind)).toEqual(["death"]);
  });

  test("staying dead across many events is one death, not one per event", async () => {
    const host = makeHost();
    await host.evalSnippet(PRELUDE);
    await host.evalSnippet(`
      selfFields({ health: 0 });
      for (let i = 0; i < 20; i++) selfFields({ health: 0 });
      "fed";
    `);
    expect((await host.deathSignals()).map((s) => s.kind)).toEqual(["death"]);
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
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-death-loop-"));
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
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-death-nodrain-"));
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
