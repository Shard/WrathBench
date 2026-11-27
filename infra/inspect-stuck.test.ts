/**
 * `bun wb inspect stuck` and the `fleet status` flag over runs written by the
 * runner's own Trajectory: a run whose character goes nowhere while its model
 * keeps issuing the same failing snippet trips, and runs that progress, or
 * wait in a way that is progress (a crafting session), do not. Every view runs
 * over the files and over the collector's rows.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig } from "../runner/src/config";
import { type ItemSample, Trajectory } from "../runner/src/trajectory";
import { type InspectStore, main, type ProgressSample, progressVerdict, STUCK_DEFAULTS } from "./inspect-run";
import { memoryStore } from "./inspect-memory-store";
import { liveRunStuck, runProgress } from "./run-fleet-state";
import { tempDirs } from "./temp-dirs";
import { emptyTraceSheet, emptyTraceState, type EventRow, SessionWriter, type TraceRow } from "@wrathbench/mcp/record";
import { writeLegacy05Run, type Legacy05State } from "../runner/test/fixtures/legacy05-writer";
import { readRunRow } from "../runner/src/run-reader";

const tmp = tempDirs();
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const TOKEN = "ef56".repeat(16);
const MIN = 60_000;

type Shape = "stuck" | "progressing" | "crafting";

const bags = (ore: number): ItemSample[] => [
  { name: "Worn Shortsword", count: 1, equipped: true, itemId: 25 },
  { name: "Copper Ore", count: ore, equipped: false, itemId: 2770 },
  { name: "Copper Bar", count: 20 - ore, equipped: false, itemId: 2840 },
];

/** A sample as a v1 trace's key row: the whole state and sheet, what is carried in the backpack. */
function keyOf(s: Omit<Legacy05State, "items"> & { items?: ItemSample[] }): TraceRow {
  const carried = (s.items ?? []).filter((i) => !i.equipped);
  const worn = (s.items ?? []).filter((i) => i.equipped);
  return {
    ts: s.ts,
    kind: "key",
    map: s.map ?? null,
    x: s.x ?? null,
    y: s.y ?? null,
    z: s.z ?? null,
    o: 0,
    data: {
      ...emptyTraceState(),
      ...emptyTraceSheet(),
      level: s.level ?? null,
      xp: s.xp ?? null,
      zone: s.zone ?? null,
      money: s.money ?? null,
      equip: worn.map((i, n) => [n, i.itemId ?? 0]),
      inv: carried.map((i, n) => [255, 23 + n, i.itemId ?? 0, i.count]),
    },
  };
}

/**
 * One live run over the three hours before NOW, a state sample a minute,
 * written the way the runner writes it. `stuck`: a ghost at a navmesh gap, the
 * same failing move twice a minute, the harness's hint block on every result,
 * and the model asking for a reset. `progressing` gains xp and walks;
 * `crafting` stands still while its bags change.
 */
async function makeRun(runsDir: string, runId: string, shape: Shape, v1 = false): Promise<void> {
  const dir = join(runsDir, runId);
  const minutes = 180;
  const t0 = NOW - minutes * MIN;
  let clock = t0;
  const traj = new Trajectory(dir, { now: () => clock });
  const config = { ...loadRunConfig({ driver: "stub" }), runId, token: TOKEN, runsDir, character: "Testwick", model: "test/model", account: "TESTACCT" };
  traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: t0, config });
  traj.setCharacter(runId, "Testwick");
  let call = 0;
  const samples: Legacy05State[] = [];
  const trace: TraceRow[] = [];
  for (let i = 0; i <= minutes; i++) {
    clock = t0 + i * MIN;
    const xp = shape === "progressing" ? 1000 + i * 10 : 1350;
    const x = shape === "progressing" ? -9000 + i * 3 : -9000 + (i % 2) * 0.4;
    const sample = { ts: clock, level: 12, xp, money: 4_210, questsCompleted: 4, map: 0, x, y: 400, z: 52, zone: 12, items: bags(shape === "crafting" ? 20 - Math.min(20, Math.floor(i / 6)) : 20) };
    // A 0.5 run: the sample went to the trajectory and to run.sqlite (below).
    traj.append({ t: "state", ...sample });
    samples.push(sample);
    if (v1) trace.push(keyOf(sample));
    if (shape === "stuck" && i === minutes - 10) {
      traj.append({ t: "harness", kind: "sandbox_restarted", text: "sandbox restarted (a snippet blocked the event loop past the timeout)." });
      traj.append({ t: "events_served", via: "context", count: 1, events: [{ seq: 9, opcode: "SMSG_X", schemaError: "bad field" }] });
    }
    for (const half of [0, 30_000]) {
      clock = t0 + i * MIN + half + 1_000;
      call++;
      const code = shape === "stuck" ? "const r = await sdk.moveTo(corpse); return r.status;" : "return await sdk.sleep(25000);";
      traj.append({ t: "tool_call", turn: call, call, name: "run_snippet", args: { code } });
      traj.append({ t: "snippet", turn: call, call, code });
      if (shape === "stuck") {
        traj.append({
          t: "snippet_result",
          turn: call,
          call,
          name: "run_snippet",
          isError: true,
          text: `error (${400 + (call % 7)}ms)\nError: moveTo target_off_mesh at (${-9000 + (call % 3)}, 400)\n--- harness ---\nmoveTo target_off_mesh ×45: the target is not on the navigation mesh; pick a point on the ground nearby`,
        });
      } else traj.append({ t: "snippet_result", turn: call, call, name: "run_snippet", isError: false, text: "ok (25000ms)\n=> null" });
      const said = shape === "stuck" && call % 90 === 0 ? `Still blocked at the gap. Could the operator please reset my character to the graveyard? session ${TOKEN}` : "Continuing.";
      traj.append({ t: "response", turn: call, message: { role: "assistant", content: said } });
    }
  }
  traj.close();
  if (v1) {
    // A v1 run: the trajectory is the model side, the readings are the trace's.
    const lines = readFileSync(join(dir, "trajectory.jsonl"), "utf8").split("\n").filter((l) => l.length > 0 && !l.includes('"t":"state"'));
    writeFileSync(join(dir, "trajectory.jsonl"), `${lines.join("\n")}\n`);
    let wclock = t0;
    const writer = new SessionWriter({ dir: join(dir, "session"), id: "5e5510aa0c0ffee2", stack: { version: "test" }, now: () => wclock, log: () => {} });
    writer.open();
    for (const row of trace) {
      wclock = row.ts;
      writer.ingest({ trace: { rows: [row], dropped: 0 }, events: { rows: [], dropped: 0 }, nearby: { rows: [], dropped: 0, through: 0 }, moves: [], character: { guid: "7", name: "Testwick", race: 1, class: 1 }, stream: { connected: true, events: 1, seq: 1 } });
    }
    await writer.close();
  } else writeLegacy05Run(dir, readRunRow(dir, runId)!, samples);
  const hb = join(dir, "heartbeat");
  writeFileSync(hb, "a-host 1\n");
  utimesSync(hb, (NOW - 5_000) / 1000, (NOW - 5_000) / 1000);
}

const RUNS = tmp("inspect-stuck-");
for (const s of ["stuck", "progressing"] as const) await makeRun(RUNS, `run-${s}`, s);
const STORE = await memoryStore(RUNS);

async function inspect(argv: string[], store?: InspectStore): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {}, (l) => out.push(l), (l) => err.push(l), NOW, store === undefined ? {} : { store });
  return { code, out, err };
}

const line = (out: string[], label: string): string => out.find((l) => l.startsWith(label)) ?? "";

/** The same shapes recorded by a v1 run: its readings are its trace's, and its trajectory has no `state` record. */
const RUNS_V1 = tmp("inspect-stuck-v1-");
for (const s of ["stuck", "progressing", "crafting"] as const) await makeRun(RUNS_V1, `run-${s}`, s, true);
const STORE_V1 = await memoryStore(RUNS_V1);

/**
 * A v1 run the way the stack really records a character standing still: one
 * key row when its trace opens, and nothing on the trace after it, while its
 * model calls a tool every 30 seconds (each a `calls` row) and the writer
 * beats `live.json` every tick. `deathloop` dies every twelve minutes at the
 * same camp and runs back from the graveyard 200 yards each time, paying a
 * repair and looting between, with no xp: the freeplay run whose corpse runs
 * read as progress.
 */
type IdleShape = "idle" | "deathloop";
async function makeIdleV1Run(runsDir: string, runId: string, shape: IdleShape): Promise<void> {
  const dir = join(runsDir, runId);
  const minutes = 180;
  const t0 = NOW - minutes * MIN;
  let clock = t0;
  const traj = new Trajectory(dir, { now: () => clock });
  const config = { ...loadRunConfig({ driver: "stub" }), runId, token: TOKEN, runsDir, character: "Testwick", model: "test/model", account: "TESTACCT" };
  traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: t0, config });
  traj.setCharacter(runId, "Testwick");
  const writer = new SessionWriter({ dir: join(dir, "session"), id: "5e5510aa0c0ffee2", stack: { version: "test" }, now: () => clock, log: () => {} });
  writer.open();
  const character = { guid: "7", name: "Testwick", race: 1, class: 1 };
  const drain = (rows: TraceRow[], events: EventRow[] = []) => ({ trace: { rows, dropped: 0 }, events: { rows: events, dropped: 0 }, nearby: { rows: [], dropped: 0, through: 0 }, moves: [], character, stream: { connected: true, events: 1, seq: 1 } });
  writer.ingest(drain([keyOf({ ts: t0, level: 12, xp: 1350, money: 4_210, map: 0, x: -9000, y: 400, z: 52, zone: 12, items: bags(20) })]));
  let call = 0;
  let deaths = 0;
  for (let at = t0 + 30_000; at <= NOW - 5_000; at += 30_000) {
    clock = at;
    if (shape === "deathloop" && (at - t0) % (12 * MIN) === 6 * MIN) {
      // Dead at the camp; then, in the reading after, back from the graveyard poorer, with other loot.
      deaths++;
      writer.ingest(drain([keyOf({ ts: at, level: 12, xp: 1350, money: 4_210 - deaths * 15, map: 0, x: -9000 - (deaths % 2) * 200, y: 400, z: 52, zone: 12, items: bags(20 - deaths) })], [{ ts: at, kind: "death", zone: 12 }]));
    } else writer.ingest(drain([]));
    call++;
    traj.append({ t: "tool_call", turn: call, call, name: "state_summary", args: {} });
    const id = writer.call("state_summary", {}, at);
    clock = at + 200;
    writer.result(id, { text: "Testwick, level 12, standing at the gate." });
    traj.append({ t: "tool_result", turn: call, call, name: "state_summary", isError: false, text: "ok" });
    traj.append({ t: "response", turn: call, message: { role: "assistant", content: "Waiting." } });
  }
  // Live: the writer holds the session open, its heartbeat a tick ago.
  clock = NOW - 2_000;
  writer.ingest(null);
  traj.close();
  const hb = join(dir, "heartbeat");
  writeFileSync(hb, "a-host 1\n");
  utimesSync(hb, (NOW - 5_000) / 1000, (NOW - 5_000) / 1000);
}

const RUNS_IDLE = tmp("inspect-stuck-idle-");
for (const s of ["idle", "deathloop"] as const) await makeIdleV1Run(RUNS_IDLE, `run-${s}`, s);
const STORE_IDLE = await memoryStore(RUNS_IDLE);

/**
 * A fan-out run with two characters, each recorded as `makeIdleV1Run`
 * records one: `idle` stands still while the agent talks, `levelled` levels
 * once early in the window. One agent drives both, so the trajectory is one.
 */
async function makeIdleFanoutRun(runsDir: string, runId: string, shapes: Record<string, "idle" | "levelled">): Promise<void> {
  const dir = join(runsDir, runId);
  const t0 = NOW - 180 * MIN;
  let clock = t0;
  const traj = new Trajectory(dir, { now: () => clock });
  const names = Object.keys(shapes);
  const config = { ...loadRunConfig({ driver: "stub" }), runId, token: TOKEN, runsDir, character: names[0], model: "test/model", account: "FANA", fanout: { characters: names.length, accounts: ["FANA", "FANB"] } };
  traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: t0, config });
  const writers = names.map((name, i) => {
    const w = new SessionWriter({ dir: join(dir, "sessions", name), id: `fa0f0f0f0f0f0f0${i}`, stack: { version: "test" }, now: () => clock, log: () => {} });
    w.open();
    return { name, w, character: { guid: String(900 + i), name, race: 1, class: 1 } };
  });
  const drain = (character: { guid: string; name: string; race: number; class: number }, rows: TraceRow[]) => ({
    trace: { rows, dropped: 0 },
    events: { rows: [], dropped: 0 },
    nearby: { rows: [], dropped: 0, through: 0 },
    moves: [],
    character,
    stream: { connected: true, events: 1, seq: 1 },
  });
  for (const [i, x] of writers.entries()) x.w.ingest(drain(x.character, [keyOf({ ts: t0, level: 12, xp: 1350, money: 4_210, map: 0, x: -9000 + i * 10, y: 400, z: 52, zone: 12, items: bags(20) })]));
  const levelAt = NOW - 110 * MIN;
  let call = 0;
  for (let at = t0 + 30_000; at <= NOW - 5_000; at += 30_000) {
    clock = at;
    call++;
    traj.append({ t: "tool_call", turn: call, call, name: "state_summary", args: {} });
    for (const x of writers) {
      x.w.ingest(drain(x.character, shapes[x.name] === "levelled" && at === levelAt ? [{ ts: at, kind: "state", data: { level: 13, xp: 20 } }] : []));
      // A call that names no character is written to every character's record.
      const id = x.w.call("state_summary", {}, at);
      x.w.result(id, { text: "both standing at the gate." });
    }
    traj.append({ t: "tool_result", turn: call, call, name: "state_summary", isError: false, text: "ok" });
    traj.append({ t: "response", turn: call, message: { role: "assistant", content: "Waiting." } });
  }
  clock = NOW - 2_000;
  for (const x of writers) x.w.ingest(null);
  traj.close();
  const hb = join(dir, "heartbeat");
  writeFileSync(hb, "a-host 1\n");
  utimesSync(hb, (NOW - 5_000) / 1000, (NOW - 5_000) / 1000);
}

const RUNS_FANOUT = tmp("inspect-stuck-fanout-");
await makeIdleFanoutRun(RUNS_FANOUT, "fan-idle", { Alfa: "idle", Bravo: "idle" });
await makeIdleFanoutRun(RUNS_FANOUT, "fan-one", { Alfa: "idle", Bravo: "levelled" });
const STORE_FANOUT = await memoryStore(RUNS_FANOUT);

for (const [where, store] of [["the files", undefined], ["ClickHouse", STORE]] as const) {
  describe(`inspect stuck on a 0.5 run, over ${where}`, () => {
    test("a run that goes nowhere while its model keeps trying trips, with the evidence, its token struck", async () => {
      const r = await inspect(["stuck", "run-stuck", "--runs-dir", RUNS], store);
      expect(r.code).toBe(0);
      expect(line(r.out, "verdict")).toContain("STUCK");
      expect(line(r.out, "source")).toContain(store === undefined ? "the files" : "ClickHouse");
      const progress = line(r.out, "progress");
      expect(progress).toContain("TRIPPED");
      expect(progress).toContain("L12 1350xp throughout");
      expect(progress).toContain("121 samples over 2h00m");
      // The same error at three places and seven timings is one signature.
      expect(line(r.out, "errors")).toMatch(/TRIPPED\s+24\d× "run_snippet: Error: moveTo target_off_mesh at \(-#, #\)"/);
      // The excerpt is struck like every line.
      expect(r.out.join("\n")).toContain("Could the operator please reset");
      expect(r.out.join("\n")).not.toContain(TOKEN);
    });

    test("a progressing run does not trip", async () => {
      const r = await inspect(["stuck", "run-progressing", "--runs-dir", RUNS], store);
      expect(line(r.out, "verdict")).toContain("not stuck");
      for (const s of ["errors", "hints", "asks"]) expect(line(r.out, s)).not.toContain("TRIPPED");
    });
  });
}

for (const [where, store] of [["the files", undefined], ["ClickHouse", STORE_V1]] as const) {
  describe(`inspect stuck on a v1 run, over ${where}`, () => {
    test("the samples are the trace's: a character that goes nowhere trips, as on a 0.5 run", async () => {
      const r = await inspect(["stuck", "run-stuck", "--runs-dir", RUNS_V1], store);
      expect(line(r.out, "verdict")).toContain("STUCK");
      expect(line(r.out, "progress")).toContain("L12 1350xp throughout");
      expect(line(r.out, "errors")).toContain("TRIPPED");
    });

    test("progress and a crafting session are progress", async () => {
      expect(line((await inspect(["stuck", "run-progressing", "--runs-dir", RUNS_V1], store)).out, "verdict")).toContain("not stuck");
      expect(line((await inspect(["stuck", "run-crafting", "--runs-dir", RUNS_V1], store)).out, "verdict")).toContain("not stuck");
    });
  });
}

for (const [where, store] of [["the files", undefined], ["ClickHouse", STORE_IDLE]] as const) {
  describe(`inspect stuck on a still v1 character, over ${where}`, () => {
    test("a trace silent for hours is judged by the record's other writes: standing still while the model talks is stuck", async () => {
      const r = await inspect(["stuck", "run-idle", "--runs-dir", RUNS_IDLE], store);
      expect(line(r.out, "verdict")).toContain("STUCK");
      // No trace row in the window: the reading is the one it started from.
      expect(line(r.out, "progress")).toMatch(/0 trace sample\(s\) and \d+ other record write\(s\)/);
    });

    test("a death loop off the record's events is stuck whatever the corpse runs moved and the repairs spent", async () => {
      const r = await inspect(["stuck", "run-deathloop", "--runs-dir", RUNS_IDLE], store);
      expect(line(r.out, "verdict")).toContain("STUCK: a death loop");
      expect(line(r.out, "progress")).toContain("death loop: 10 deaths in the window (threshold 5)");
    });
  });
}

for (const [where, store] of [["the files", undefined], ["ClickHouse", STORE_FANOUT]] as const) {
  describe(`inspect stuck on a fan-out run, over ${where}`, () => {
    test("each character is judged off its own record, and the run is stuck only when every one is", async () => {
      const idle = await inspect(["stuck", "fan-idle", "--runs-dir", RUNS_FANOUT], store);
      expect(line(idle.out, "verdict")).toContain("STUCK: no game progress in the window (all 2 characters");
      expect(idle.out.find((l) => l.startsWith("  Alfa"))).toMatch(/TRIPPED\s+L12 1350xp throughout/);
      expect(idle.out.find((l) => l.startsWith("  Bravo"))).toMatch(/TRIPPED\s+L12 1350xp throughout/);
      const one = await inspect(["stuck", "fan-one", "--runs-dir", RUNS_FANOUT], store);
      expect(line(one.out, "verdict")).toContain("not stuck: a character made progress");
      expect(one.out.find((l) => l.startsWith("  Alfa"))).toContain("TRIPPED");
      expect(one.out.find((l) => l.startsWith("  Bravo"))).toMatch(/ok\s+L12 1350xp → L13 20xp/);
    });
  });
}

describe("fleet status's flag", () => {
  test("reads what inspect stuck reads, on every record shape: a stuck live run is flagged, the rest are not", () => {
    expect(liveRunStuck("run-stuck", NOW, RUNS)).toMatch(/^no progress in 2h00m: L12 1350xp throughout/);
    expect(liveRunStuck("run-progressing", NOW, RUNS)).toBeUndefined();
    expect(liveRunStuck("run-missing", NOW, RUNS)).toBeUndefined();
    expect(liveRunStuck("run-stuck", NOW, RUNS_V1)).toContain("no progress");
    expect(liveRunStuck("run-progressing", NOW, RUNS_V1)).toBeUndefined();
    expect(runProgress("run-stuck", RUNS_V1)).toEqual({ level: 12, xp: 1350, startedAt: NOW - 180 * MIN });
    expect(liveRunStuck("run-idle", NOW, RUNS_IDLE)).toMatch(/^no progress in 2h00m: L12 1350xp throughout/);
    expect(liveRunStuck("run-deathloop", NOW, RUNS_IDLE)).toMatch(/^death loop: 10 deaths in the window/);
    // A fan-out run: every character held, or none flagged.
    expect(liveRunStuck("fan-idle", NOW, RUNS_FANOUT)).toMatch(/^no progress in 2h00m/);
    expect(liveRunStuck("fan-one", NOW, RUNS_FANOUT)).toBeUndefined();
  });
});

describe("progressVerdict", () => {
  const w = { since: 0, until: 120 * MIN };
  const sample = (i: number, over: Partial<ProgressSample> = {}): ProgressSample => ({ ts: i * MIN, level: 10, xp: 500, money: 100, quests: 3, map: 1, x: 0, y: 0, z: 0, items: "a:1", ...over });
  const series = (f: (i: number) => Partial<ProgressSample> = () => ({})): ProgressSample[] => Array.from({ length: 121 }, (_, i) => sample(i, f(i)));

  test("nothing changing over a covered window is stuck", () => {
    expect(progressVerdict(series(), w, STUCK_DEFAULTS).state).toBe("stuck");
  });

  test("each kind of progress clears it", () => {
    const cases: [string, (i: number) => Partial<ProgressSample>][] = [
      ["level", (i) => ({ level: i > 60 ? 11 : 10, xp: i > 60 ? 0 : 500 })],
      ["quests", (i) => ({ quests: i > 60 ? 4 : 3 })],
      ["money", (i) => ({ money: i > 60 ? 50 : 100 })],
      ["map", (i) => ({ map: i > 40 && i < 80 ? 0 : 1 })],
      ["a flight", (i) => ({ x: i * 40 })],
    ];
    for (const [what, f] of cases) expect([what, progressVerdict(series(f), w, STUCK_DEFAULTS).state]).toEqual([what, "progressing"]);
  });

  test("a gap in the samples leaves the window unjudged", () => {
    const gappy = series().filter((s) => s.ts < 40 * MIN || s.ts > 60 * MIN);
    expect(progressVerdict(gappy, w, STUCK_DEFAULTS)).toMatchObject({ state: "unjudged" });
    expect(progressVerdict([], w, STUCK_DEFAULTS).state).toBe("unjudged");
  });

  test("given the record's writes, a still trace is covered by them and starts from the reading before the window", () => {
    const writes = Array.from({ length: 240 }, (_, i) => i * 30_000 + 1_000);
    const before = sample(-30);
    // No sample in the window: the one before it, carried in, held throughout.
    expect(progressVerdict([before], w, STUCK_DEFAULTS, writes)).toMatchObject({ state: "stuck" });
    // The one sample in the window is a level over the one before it.
    expect(progressVerdict([before, sample(5, { level: 11, xp: 0 })], w, STUCK_DEFAULTS, writes).state).toBe("progressing");
    // Writes with a 20-minute hole, or none, do not cover it.
    expect(progressVerdict([before], w, STUCK_DEFAULTS, writes.filter((t) => t < 40 * MIN || t > 60 * MIN)).state).toBe("unjudged");
    expect(progressVerdict([before], w, STUCK_DEFAULTS, []).state).toBe("unjudged");
  });

  test("a death loop is stuck whatever moved or was gained; fewer deaths, or a window not covered, is judged as before", () => {
    // Corpse runs 200 yd out and back, a repair after each death.
    const walking = series((i) => ({ x: (i % 24 < 12 ? 0 : 200), money: 100 - Math.floor(i / 12) }));
    const deaths = (n: number): number[] => Array.from({ length: n }, (_, i) => (i * 12 + 6) * MIN);
    expect(progressVerdict(walking, w, STUCK_DEFAULTS, undefined, deaths(10)).state).toBe("stuck");
    expect(progressVerdict(walking, w, STUCK_DEFAULTS, undefined, deaths(4)).state).toBe("progressing");
    expect(progressVerdict(walking, w, { ...STUCK_DEFAULTS, deaths: 4 }, undefined, deaths(4)).state).toBe("stuck");
    // Xp between the deaths does not end the loop.
    expect(progressVerdict(series((i) => ({ xp: 500 + i })), w, STUCK_DEFAULTS, undefined, deaths(10))).toMatchObject({ state: "stuck", deathLoop: { deaths: 10 } });
    // Deaths outside the window are not counted.
    expect(progressVerdict(walking, w, STUCK_DEFAULTS, undefined, deaths(10).map((t) => t - 3 * 3_600_000)).state).toBe("progressing");
    // Nothing recorded is still not no progress, however many deaths.
    expect(progressVerdict(walking.filter((x) => x.ts < 40 * MIN || x.ts > 60 * MIN), w, STUCK_DEFAULTS, undefined, deaths(10)).state).toBe("unjudged");
  });
});
