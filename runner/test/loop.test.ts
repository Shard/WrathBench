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
import { ContextBuilder, itemSample, runLoop } from "../src/loop";
import { EpisodicLog } from "../src/episodic";
import { Scratchpad } from "../src/scratchpad";
import type { SandboxHost, SnippetResult } from "../src/sandbox/host";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";
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
      episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
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

  test("achievements: the login backlog is one record and own earns are firsts", async () => {
    const adapter = new StubAdapter([
      { content: "t1", toolCalls: [] },
      { content: "t2", toolCalls: [] },
    ]);
    const { dir, options } = setup(
      adapter,
      {},
      {
        self: {
          achievements: {
            loginSeen: true,
            points: 35,
            entries: [
              { achievementId: 6, name: "Level 10", points: 10, categoryId: 92, source: "login" },
              { achievementId: 7, points: 15, source: "login" },
              { achievementId: 12, name: "Explore Elwynn Forest", points: 10, source: "earned" },
            ],
          },
        },
      },
    );
    await runLoop(options);
    const ms = readTrajectory(dir).filter((r) => r.t === "milestone");
    const backlog = ms.filter((r) => r["kind"] === "achievements_at_login");
    // Once, however many samples the run took: a resumed run's history is
    // visible without its past being re-emitted as fresh firsts.
    expect(backlog).toHaveLength(1);
    expect(backlog[0]!["ids"]).toEqual([6, 7]);
    expect(backlog[0]!["points"]).toBe(25);
    const earns = ms.filter((r) => r["kind"] === "achievement");
    expect(earns).toHaveLength(1);
    expect(earns[0]!["id"]).toBe(12);
    expect(earns[0]!["name"]).toBe("Explore Elwynn Forest");
    expect(earns[0]!["points"]).toBe(10);
    options.trajectory.close();
  });

  test("an empty login backlog is still recorded: it is what says the taps were live", async () => {
    const adapter = new StubAdapter([{ content: "t1", toolCalls: [] }]);
    const { dir, options } = setup(
      adapter,
      {},
      { self: { achievements: { loginSeen: true, points: 0, entries: [] } } },
    );
    await runLoop(options);
    const ms = readTrajectory(dir).filter((r) => r.t === "milestone" && r["kind"] === "achievements_at_login");
    expect(ms).toHaveLength(1);
    expect(ms[0]!["ids"]).toEqual([]);
    expect(ms[0]!["points"]).toBe(0);
    options.trajectory.close();
  });

  test("a flight is the flag flipping on after an accepted reply; a first sight of it is not a takeoff", async () => {
    const ok = { value: { reply: 0, ok: true }, seq: 5, ts: 5 };
    const snapshots: Record<string, unknown>[] = [
      // Already flying when the process opened (a resume mid-flight): seeded,
      // never a takeoff — nothing said this flight began here.
      { self: { taxiFlight: { value: true, seq: 1, ts: 1 }, taxiReply: ok } },
      // The landing IS an observation, even though the takeoff was not seen.
      { self: { taxiFlight: { value: false, seq: 2, ts: 2 }, area: { value: { id: 24 } }, taxiReply: ok } },
      // On without an accepted reply: no packet said a flight was accepted.
      { self: { taxiFlight: { value: true, seq: 3, ts: 3 } } },
      { self: { taxiFlight: { value: false, seq: 4, ts: 4 } } },
      // Accepted, then the flag on: the flight a client would see start.
      { self: { taxiFlight: { value: true, seq: 5, ts: 5 }, area: { value: { id: 9 } }, taxiReply: ok } },
    ];
    let i = 0;
    const sandbox = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () =>
        Promise.resolve({ lastSeq: -1, eventCount: 0, ...snapshots[Math.min(i++, snapshots.length - 1)]! }),
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;
    const adapter = new StubAdapter(
      Array.from({ length: snapshots.length }, (_, n) => ({ content: `t${n}`, toolCalls: [] })),
    );
    const { dir, options } = setup(adapter, { stateIntervalMs: 1 });
    options.sandbox = sandbox;
    let clock = 0;
    (options as { now?: () => number }).now = () => (clock += 1000);
    await runLoop(options);
    const ms = readTrajectory(dir).filter(
      (r) => r.t === "milestone" && (r["kind"] === "taxi" || r["kind"] === "taxi_landed"),
    );
    expect(ms.map((r) => [r["kind"], r["from"], r["to"]])).toEqual([
      ["taxi_landed", undefined, { areaId: 24 }],
      ["taxi_landed", undefined, undefined],
      ["taxi", { areaId: 9 }, undefined],
    ]);
    options.trajectory.close();
  });

  /** A loop whose samples walk a fixed list of snapshots, one per turn. */
  function walk(snapshots: Record<string, unknown>[]) {
    let i = 0;
    const sandbox = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: () =>
        Promise.resolve({ lastSeq: -1, eventCount: 0, ...snapshots[Math.min(i++, snapshots.length - 1)]! }),
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;
    const adapter = new StubAdapter(
      Array.from({ length: snapshots.length }, (_, n) => ({ content: `t${n}`, toolCalls: [] })),
    );
    const { dir, options } = setup(adapter, { stateIntervalMs: 1 });
    options.sandbox = sandbox;
    let clock = 0;
    (options as { now?: () => number }).now = () => (clock += 1000);
    return { dir, options };
  }

  test("level marks: the first observation is a baseline, a change is a gain, with the XP of the moment", async () => {
    const { dir, options } = walk([
      { self: { level: { value: 1, seq: 1, ts: 1 } }, xp: { value: 0, seq: 1, ts: 1 } },
      { self: { level: { value: 1, seq: 2, ts: 2 } }, xp: { value: 50, seq: 2, ts: 2 } },
      { self: { level: { value: 2, seq: 3, ts: 3 } }, xp: { value: 10, seq: 3, ts: 3 } },
    ]);
    await runLoop(options);
    const ms = readTrajectory(dir).filter((r) => r.t === "milestone" && r["kind"] === "level");
    // The baseline carries no `from` — it is the level the process opened on,
    // never a level-up — and a sample that changes nothing writes nothing.
    expect(ms.map((r) => [r["from"], r["to"], r["xp"]])).toEqual([
      [undefined, 1, 0],
      [1, 2, 10],
    ]);
    options.trajectory.close();
  });

  test("a death seen mid-window is one record, stamped with the cache's own time", async () => {
    const dead = {
      self: {
        fields: { health: { value: 50, seq: 9, ts: 4500 }, playerFlags: { value: 0x10, seq: 9, ts: 4500 } },
        corpse: { value: { map: 0, x: 1, y: 2, z: 3, source: "death_spot" }, seq: 9, ts: 4444 },
        graveyard: { value: { map: 0, x: 10, y: 20, z: 30 }, seq: 9, ts: 4460 },
        zone: { value: { id: 12 } },
        area: { value: { id: 9 } },
      },
    };
    const { dir, options } = walk([
      { self: { fields: { health: { value: 100, seq: 1, ts: 1 }, playerFlags: { value: 0, seq: 1, ts: 1 } } } },
      // The sample lands *inside* the dead window, not on the transition: the
      // cache is still holding the corpse, which is what makes the death
      // recoverable at all at a 60s sampling interval.
      dead,
      // Still the same window: a second sample must not invent a second death.
      dead,
      { self: { fields: { health: { value: 100, seq: 20, ts: 5000 }, playerFlags: { value: 0, seq: 20, ts: 5000 } } } },
    ]);
    await runLoop(options);
    const ms = readTrajectory(dir).filter(
      (r) => r.t === "milestone" && (r["kind"] === "death" || r["kind"] === "release" || r["kind"] === "resurrect"),
    );
    expect(ms.map((r) => r["kind"])).toEqual(["death", "release", "resurrect"]);
    const death = ms[0]!;
    // The death's own timestamp, not the sample's — the record's own `ts` is
    // when the sample landed and is deliberately a different fact.
    expect(death["observedTs"]).toBe(4444);
    expect(death["position"]).toEqual({ map: 0, x: 1, y: 2, z: 3, source: "death_spot" });
    // Released already, so the zone/area reading is the graveyard's; the flag
    // is what tells a reader which one it is holding.
    expect(death["released"]).toBe(true);
    expect(death["zone"]).toEqual({ id: 12 });
    expect(ms[1]!["graveyard"]).toEqual({ map: 0, x: 10, y: 20, z: 30 });
    options.trajectory.close();
  });

  test("a process that opens on a dead character seeds it and records no death", async () => {
    const dead = {
      self: {
        fields: { health: { value: 0, seq: 1, ts: 1 } },
        corpse: { value: { map: 0, x: 1, y: 2, z: 3, source: "corpse_query" }, seq: 1, ts: 1 },
      },
    };
    const { dir, options } = walk([dead, dead]);
    await runLoop(options);
    // Joining a dead window in progress says nothing about when it opened, so
    // it says nothing — the rule `lastTaxiFlight` already follows.
    expect(readTrajectory(dir).filter((r) => r.t === "milestone" && r["kind"] === "death")).toHaveLength(0);
    options.trajectory.close();
  });

  test("the spellbook: the first book seen is the baseline, later ids are learns (item 35)", async () => {
    const { dir, options } = walk([
      // An empty book is the cache before `SMSG_INITIAL_SPELLS`, not a baseline:
      // taking it as one would make the whole book arrive as fresh learns.
      { self: {}, spells: [] },
      { self: {}, spells: [{ spellId: 78 }, { spellId: 6603 }] },
      { self: {}, spells: [{ spellId: 78 }, { spellId: 6603 }] },
      { self: {}, spells: [{ spellId: 78 }, { spellId: 6603 }, { spellId: 772 }] },
    ]);
    await runLoop(options);
    const ms = readTrajectory(dir).filter(
      (r) => r.t === "milestone" && (r["kind"] === "spells_at_login" || r["kind"] === "spell"),
    );
    expect(ms.map((r) => [r["kind"], r["ids"] ?? r["id"]])).toEqual([
      ["spells_at_login", [78, 6603]],
      ["spell", 772],
    ]);
    options.trajectory.close();
  });

  test("talents: the first frame seeds silently, a climbing rank is a spend, a respec is not", async () => {
    const frame = (rows: { talentId: number; rank: number }[]) => ({
      self: {},
      talents: { unspentPoints: 0, activeSpec: 0, talents: rows },
    });
    const { dir, options } = walk([
      // Already holding a point: a resumed character's spend, not this run's.
      frame([{ talentId: 1683, rank: 0 }]),
      frame([{ talentId: 1683, rank: 1 }]),
      // The respec takes it back — silently, so the relearn below reads as a
      // spend again rather than being swallowed by a remembered rank.
      frame([]),
      frame([{ talentId: 1683, rank: 0 }]),
    ]);
    await runLoop(options);
    const ms = readTrajectory(dir).filter((r) => r.t === "milestone" && r["kind"] === "talent");
    expect(ms.map((r) => [r["id"], r["rank"], r["points"]])).toEqual([
      [1683, 1, 2],
      [1683, 0, 1],
    ]);
    options.trajectory.close();
  });

  test("trades: one record per completion, deduped on the cache's own stamp", async () => {
    const { dir, options } = walk([
      { self: {}, trade: { status: 2, ts: 100 } },
      { self: {}, trade: { status: 8, ts: 500 } },
      // The completion latches: the same stamp seen again is the same trade.
      { self: {}, trade: { status: 8, ts: 500 } },
      { self: {}, trade: { status: 8, ts: 900 } },
    ]);
    await runLoop(options);
    const ms = readTrajectory(dir).filter((r) => r.t === "milestone" && r["kind"] === "trade");
    expect(ms.map((r) => r["observedTs"])).toEqual([500, 900]);
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

  test("the ticker records state while a model request is in flight (item 77)", async () => {
    // The openai-compatible path used to sample only in the turn preamble, so
    // one 485s request was an 8-minute observability blackout: no state row,
    // no XP signal. The ticker samples on the wall clock while complete()
    // holds the turn.
    const slow: ChatAdapter = {
      label: "slow",
      complete: async (): Promise<AdapterOutcome> => {
        await new Promise((r) => setTimeout(r, 120));
        return { kind: "stub-complete" };
      },
    };
    const { options } = setup(slow);
    await runLoop({ ...options, stateTickMs: 10 });
    const rows = options.trajectory.stateRows("run-test");
    // One row from the turn preamble, the rest from inside the request.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Mid-request samples carry the turn in flight, not "before the first".
    expect(rows.every((r) => r["turn"] === 1)).toBe(true);
    options.trajectory.close();
  });

  test("the ticker stops with the loop: nothing samples after runLoop returns", async () => {
    const { options } = setup(new StubAdapter([]));
    await runLoop({ ...options, stateTickMs: 5 });
    const recorded = options.trajectory.stateRows("run-test").length;
    await new Promise((r) => setTimeout(r, 40));
    expect(options.trajectory.stateRows("run-test")).toHaveLength(recorded);
    options.trajectory.close();
  });

  test("concurrent sampleState calls coalesce: completions and milestones log once", async () => {
    // The ticker and the turn preamble can sample at the same moment; two
    // interleaved samples would each read the quest/zone/area high-water marks
    // before either advanced them and double-log everything in the window.
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-loop-"));
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
    expect(readTrajectory(dir).filter((r) => r.t === "quest_complete")).toHaveLength(1);
    expect(readTrajectory(dir).filter((r) => r.t === "milestone" && r["kind"] === "zone")).toHaveLength(1);
    expect(trajectory.stateRows("run-test")).toHaveLength(1);
    // The coalescing window closes with the sample: a later call runs its own.
    await builder.sampleState();
    expect(snapshots).toBe(2);
    trajectory.close();
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

  test("a turn longer than the tick still lands state samples, one at a time (item 77)", async () => {
    // The openai-compatible failure this fixes: one 485s provider call left the
    // run with no state row and no XP signal for eight minutes, because the only
    // sample was the turn preamble's. The ticker samples through the request.
    let inFlight = 0;
    let maxInFlight = 0;
    const sandbox = {
      evalSnippet: () => Promise.resolve({ ok: true, value: "", logs: [], durationMs: 1 }),
      recentEvents: () => Promise.resolve([]),
      stateSnapshot: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { self: { guid: "1", level: { value: 1 } }, lastSeq: -1, eventCount: 0 };
      },
      totalRestarts: 0,
      consecutiveRestarts: 0,
      drainNotices: () => [],
      stop: () => Promise.resolve(),
    } as unknown as SandboxHost;

    let calls = 0;
    const slow: ChatAdapter = {
      label: "slow",
      complete: async (): Promise<AdapterOutcome> => {
        calls += 1;
        if (calls > 1) return { kind: "stub-complete" };
        await new Promise((r) => setTimeout(r, 300));
        return { kind: "ok", turn: { content: "took a while", toolCalls: [] } };
      },
    };

    const { dir, options } = setup(slow, { stateIntervalMs: 1 });
    options.sandbox = sandbox;
    (options as { stateTickMs?: number }).stateTickMs = 25;
    await runLoop(options);

    const records = readTrajectory(dir);
    const requestAt = records.findIndex((r) => r.t === "request");
    const responseAt = records.findIndex((r) => r.t === "response");
    expect(requestAt).toBeGreaterThanOrEqual(0);
    expect(responseAt).toBeGreaterThan(requestAt);
    // Samples taken while the provider call was in flight: same shape as any
    // other `state` record, stamped with the turn that was in flight.
    const midTurn = records.slice(requestAt + 1, responseAt).filter((r) => r.t === "state");
    expect(midTurn.length).toBeGreaterThanOrEqual(1);
    for (const r of midTurn) expect(r["turn"]).toBe(1);
    // Never two snapshots at once: the ticker joins the preamble's sample.
    expect(maxInFlight).toBe(1);
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
 * Prompt-cache prefix discipline (item 78). Measured on a real paid run
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
