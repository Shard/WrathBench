/**
 * `bun wb inspect stuck` and the `fleet status` flag over runs written by the
 * runner's own Trajectory: a run whose character goes nowhere while its model
 * keeps issuing the same failing snippet trips, and runs that progress, or
 * wait in ways that are progress (a crafting session, an xp-making sleep loop),
 * do not. Every view runs over the files and over the collector's rows.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig } from "../runner/src/config";
import { type ItemSample, Trajectory } from "../runner/src/trajectory";
import { HINT_LINE, type InspectStore, main, type ProgressSample, progressVerdict, STUCK_DEFAULTS } from "./inspect-run";
import { memoryStore } from "./inspect-memory-store";
import { formatAccounts, formatHolder, STUCK_MARK } from "./run-fleet-status";
import { liveRunStuck, runProgress } from "./run-fleet-state";
import { tempDirs } from "./temp-dirs";
import { emptyTraceSheet, emptyTraceState, SessionWriter, type TraceRow } from "@wrathbench/mcp/record";
import { writeLegacy05Run, type Legacy05State } from "../runner/test/fixtures/legacy05-writer";
import { readRunRow } from "../runner/src/run-reader";

const tmp = tempDirs();
const NOW = Date.UTC(2030, 0, 2, 12, 0, 0);
const TOKEN = "ef56".repeat(16);
const MIN = 60_000;

type Shape = "stuck" | "stranded" | "progressing" | "crafting" | "sleeping" | "young" | "cold";

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
 * One run over the three hours before NOW, a state sample a minute, written
 * the way the runner writes it. `stuck`: a ghost at a navmesh gap, the same
 * failing move twice a minute, the harness's hint block on every result, and
 * the model asking for a reset. `stranded`: the shape of a real one, a ghost
 * with no way back whose snippets succeed, waiting on a resurrection that
 * never comes, its model saying so. The others vary only what the detector reads.
 */
async function makeRun(runsDir: string, runId: string, shape: Shape, v1 = false): Promise<void> {
  const dir = join(runsDir, runId);
  const minutes = shape === "young" ? 30 : 180;
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
    const xp = shape === "progressing" ? 1000 + i * 10 : shape === "sleeping" && i % 20 === 0 ? 1000 + i : shape === "sleeping" ? 1000 + i - (i % 20) : 1350;
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
    if (shape === "sleeping" && i % 20 !== 0) continue;
    for (const half of [0, 30_000]) {
      clock = t0 + i * MIN + half + 1_000;
      call++;
      const code =
        shape === "stuck" ? "const r = await sdk.moveTo(corpse); return r.status;" : shape === "stranded" ? "return await waitForOpcode('SMSG_RESURRECT_REQUEST', 25000);" : "return await sdk.sleep(25000);";
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
      const said =
        shape === "stuck" && call % 90 === 0
          ? `Still blocked at the gap. Could the operator please reset my character to the graveyard? session ${TOKEN}`
          : shape === "stranded" && call % 30 === 0
            ? "No Spirit Healer or resurrection offer. External recovery assistance is needed."
            : "Continuing.";
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
      // A tool's served batch with a schema error: a v1 run's is a `calls` row.
      if (shape === "stuck" && row.ts === t0 + (minutes - 9) * MIN) writer.eventsServed(undefined, [{ seq: 10, ts: row.ts, opcode: "SMSG_Y", schemaError: "bad field" } as never]);
    }
    await writer.close();
  } else writeLegacy05Run(dir, readRunRow(dir, runId)!, samples);
  const hb = join(dir, "heartbeat");
  writeFileSync(hb, "a-host 1\n");
  const at = (shape === "cold" ? NOW - 10 * MIN : NOW - 5_000) / 1000;
  utimesSync(hb, at, at);
}

const RUNS = tmp("inspect-stuck-");
const SHAPES: Shape[] = ["stuck", "stranded", "progressing", "crafting", "sleeping", "young", "cold"];
for (const s of SHAPES) await makeRun(RUNS, `run-${s}`, s);
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

for (const [where, store] of [["the files", undefined], ["ClickHouse", STORE_V1]] as const) {
  describe(`inspect stuck on a v1 run, over ${where}`, () => {
    test("the samples are the trace's: a character that goes nowhere trips, as on a 0.5 run", async () => {
      const r = await inspect(["stuck", "run-stuck", "--runs-dir", RUNS_V1], store);
      expect(line(r.out, "verdict")).toContain("STUCK");
      expect(line(r.out, "progress")).toContain("L12 1350xp throughout");
      expect(line(r.out, "errors")).toContain("TRIPPED");
      // The context window's record (trajectory) and the tool's batch (record).
      expect(line(r.out, "schema")).toMatch(/ok\s+2 events_served/);
    });

    test("the fleet's flag and progress read the same samples", () => {
      expect(liveRunStuck("run-stuck", NOW, RUNS_V1)).toContain("no progress");
      expect(liveRunStuck("run-progressing", NOW, RUNS_V1)).toBeUndefined();
      expect(runProgress("run-stuck", RUNS_V1)).toEqual({ level: 12, xp: 1350, startedAt: NOW - 180 * MIN });
    });

    test("progress and a crafting session are progress", async () => {
      expect(line((await inspect(["stuck", "run-progressing", "--runs-dir", RUNS_V1], store)).out, "verdict")).toContain("not stuck");
      expect(line((await inspect(["stuck", "run-crafting", "--runs-dir", RUNS_V1], store)).out, "verdict")).toContain("not stuck");
    });
  });
}

for (const [where, store] of [["the files", undefined], ["ClickHouse", STORE]] as const) {
  describe(`inspect stuck, over ${where}`, () => {
    test("a run that goes nowhere while its model keeps trying trips, with the evidence", async () => {
      const r = await inspect(["stuck", "run-stuck", "--runs-dir", RUNS], store);
      expect(r.code).toBe(0);
      expect(r.out[0]).toContain("the stuck detector over 2h00m");
      expect(line(r.out, "verdict")).toContain("STUCK");
      expect(line(r.out, "source")).toContain(store === undefined ? "the files" : "ClickHouse");
      const progress = line(r.out, "progress");
      expect(progress).toContain("TRIPPED");
      expect(progress).toContain("L12 1350xp throughout");
      expect(progress).toMatch(/within 0\.4 yd/);
      expect(progress).toContain("121 samples over 2h00m");
      expect(line(r.out, "activity")).toMatch(/^activity\s+24\d snippet/);
      // The same error at three places and seven timings is one signature.
      expect(line(r.out, "errors")).toMatch(/TRIPPED\s+24\d× "run_snippet: Error: moveTo target_off_mesh at \(-#, #\)"/);
      expect(line(r.out, "hints")).toMatch(/TRIPPED\s+moveTo target_off_mesh 1\d{4}/);
      expect(line(r.out, "schema")).toMatch(/ok\s+1 events_served/);
      expect(line(r.out, "restarts")).toMatch(/ok\s+1 sandbox restart/);
      expect(line(r.out, "asks")).toMatch(/TRIPPED\s+heuristic: [2-3] of 24\d response/);
      // The excerpt is struck like every line.
      expect(r.out.join("\n")).toContain("Could the operator please reset");
      expect(r.out.join("\n")).not.toContain(TOKEN);
      expect(line(r.out, "limits")).toContain("--window 2h00m --move 50");
    });

    test("a stranded ghost whose snippets all succeed trips on progress alone, and its words read as asking", async () => {
      const r = await inspect(["stuck", "run-stranded", "--runs-dir", RUNS], store);
      expect(line(r.out, "verdict")).toContain("STUCK");
      expect(line(r.out, "errors")).toMatch(/ok\s+none failed/);
      expect(line(r.out, "hints")).toMatch(/ok\s+no harness-delivered hint/);
      expect(line(r.out, "asks")).toMatch(/TRIPPED\s+heuristic: 8 of 24\d/);
      expect(r.out.join("\n")).toContain("External recovery assistance is needed.");
    });

    test("thresholds are flags: a lower restart count trips that signal, a short window holds", async () => {
      const r = await inspect(["stuck", "run-stuck", "--runs-dir", RUNS, "--restarts", "1", "--window", "20m"], store);
      expect(line(r.out, "restarts")).toContain("TRIPPED");
      expect(line(r.out, "progress")).toContain("21 samples over 20m");
      expect(line(r.out, "limits")).toContain("--window 20m");
    });

    test("--until judges an earlier stretch", async () => {
      const r = await inspect(["stuck", "run-progressing", "--runs-dir", RUNS, "--until", "1h"], store);
      expect(r.out[0]).toContain("2030-01-02T11:00:00Z (--until)");
      expect(line(r.out, "progress")).toContain("ok");
    });

    test("a progressing run does not trip, and says what moved", async () => {
      const r = await inspect(["stuck", "run-progressing", "--runs-dir", RUNS], store);
      expect(line(r.out, "verdict")).toContain("not stuck");
      expect(line(r.out, "progress")).toMatch(/^progress\s+ok\s+L12 \d+xp → L12 \d+xp · moved \d+ yd/);
      for (const s of ["errors", "hints", "asks"]) expect(line(r.out, s)).not.toContain("TRIPPED");
    });

    test("a stationary crafting session is progress: its bags change", async () => {
      const r = await inspect(["stuck", "run-crafting", "--runs-dir", RUNS], store);
      expect(line(r.out, "verdict")).toContain("not stuck");
      expect(line(r.out, "progress")).toContain("items changed");
    });

    test("a sleep loop that makes xp is progress, however few its snippets", async () => {
      const r = await inspect(["stuck", "run-sleeping", "--runs-dir", RUNS], store);
      expect(line(r.out, "verdict")).toContain("not stuck");
      expect(line(r.out, "activity")).toMatch(/^activity\s+1\d snippet/);
    });

    test("a run younger than the window is unjudged, not stuck", async () => {
      const r = await inspect(["stuck", "run-young", "--runs-dir", RUNS], store);
      expect(line(r.out, "verdict")).toContain("unjudged");
      expect(line(r.out, "progress")).toMatch(/gap from 2030-01-02T10:00:00Z/);
    });

    test("with no run id: one line per run with a live owner", async () => {
      const r = await inspect(["stuck", "--runs-dir", RUNS], store);
      expect(r.out[0]).toContain("6 run(s) with a live owner");
      expect(r.out.find((l) => l.includes("run-stuck"))).toMatch(/run-stuck  STUCK \(also tripped: errors, hints, asks\)  no progress in 2h00m: L12 1350xp throughout/);
      for (const s of ["progressing", "crafting", "sleeping"]) expect(r.out.find((l) => l.includes(`run-${s}`))).toMatch(/ progressing$/);
      expect(r.out.find((l) => l.includes("run-young"))).toContain("unjudged");
      expect(r.out.some((l) => l.includes("run-cold"))).toBe(false);
      expect(r.out.join("\n")).not.toContain(TOKEN);
    });
  });
}

describe("the hint block's lines", () => {
  test("read the action, status and count past a label that is code, parentheses and all", () => {
    expect(HINT_LINE.exec("castSpell not_ready ×48 (from an earlier snippet: if(hpPct()<85){ await cast(27136,state.self.gui…): Divine Storm (53385): its cooldown")?.slice(1, 4)).toEqual(["castSpell", "not_ready", "48"]);
    const plain = HINT_LINE.exec("moveTo too_far: walk closer first");
    expect([plain?.[1], plain?.[2], plain?.[3]]).toEqual(["moveTo", "too_far", undefined]);
    // A hint's own text on a line of its own, and the block's overflow line, are not tallies.
    expect(HINT_LINE.exec("Divine Storm (53385): its cooldown, or the global cooldown")).toBeNull();
    expect(HINT_LINE.exec("(+2 other failure statuses since the last result)")).toBeNull();
  });
});

describe("inspect stuck's flags", () => {
  test("refuses a bad threshold and a flag it does not take", async () => {
    expect((await inspect(["stuck", "run-stuck", "--runs-dir", RUNS, "--window", "2"])).err[0]).toContain("--window is a duration");
    expect((await inspect(["stuck", "run-stuck", "--runs-dir", RUNS, "--repeat", "1.5"])).err[0]).toContain("--repeat is a whole number");
    expect((await inspect(["stuck", "run-stuck", "--runs-dir", RUNS, "--since", "1h"])).err[0]).toContain("--since does not apply to stuck");
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

  test("a quest count reset by a restart is not progress, and a field a sample lacks is not a change", () => {
    expect(progressVerdict(series((i) => ({ quests: i > 60 ? 0 : 3 })), w, STUCK_DEFAULTS).state).toBe("stuck");
    expect(progressVerdict(series((i) => (i % 2 === 0 ? { money: null, items: null, x: null } : {})), w, STUCK_DEFAULTS).state).toBe("stuck");
  });

  test("pacing inside the radius is not movement", () => {
    expect(progressVerdict(series((i) => ({ x: (i % 2) * 30, y: (i % 3) * 20 })), w, STUCK_DEFAULTS).state).toBe("stuck");
  });

  test("a gap in the samples leaves the window unjudged", () => {
    const gappy = series().filter((s) => s.ts < 40 * MIN || s.ts > 60 * MIN);
    expect(progressVerdict(gappy, w, STUCK_DEFAULTS)).toMatchObject({ state: "unjudged" });
    expect(progressVerdict([], w, STUCK_DEFAULTS).state).toBe("unjudged");
  });
});

describe("fleet status's flag", () => {
  test("a stuck live run is flagged from one bounded read of its run.sqlite; the rest are not", () => {
    const flag = liveRunStuck("run-stuck", NOW, RUNS);
    expect(flag).toMatch(/^no progress in 2h00m: L12 1350xp throughout/);
    expect(liveRunStuck("run-stranded", NOW, RUNS)).toMatch(/^no progress in 2h00m/);
    for (const s of ["progressing", "crafting", "sleeping", "young"]) expect([s, liveRunStuck(`run-${s}`, NOW, RUNS)]).toEqual([s, undefined]);
    // A cold heartbeat has no live owner, and is not looked at.
    expect(liveRunStuck("run-cold", NOW, RUNS)).toBeUndefined();
    expect(liveRunStuck("run-missing", NOW, RUNS)).toBeUndefined();
  });

  test("a run's level and xp are its newest state sample's, with its start", async () => {
    const dir = tmp("wb-progress-");
    let clock = NOW - 10 * MIN;
    const write = async (runId: string, samples: { level?: number; xp?: number }[]): Promise<void> => {
      const traj = new Trajectory(join(dir, runId), { now: () => clock });
      const config = { ...loadRunConfig({ driver: "stub" }), runId, runsDir: dir, model: "test/model", account: "TESTACCT" };
      traj.writeMeta({ runId, harnessVersion: "harness-test", startedAt: NOW - 10 * MIN, config });
      traj.close();
      // 0.5 runs: the fleet's reader of v1 records comes with its switch-over.
      writeLegacy05Run(join(dir, runId), readRunRow(join(dir, runId), runId)!, samples.map((sm) => ({ ...sm, ts: (clock += 1_000), map: 0, x: 0, y: 0, z: 0 })));
    };
    await write("p-levelled", [{ level: 3, xp: 900 }, { level: 4, xp: 10 }, { level: 4, xp: 250 }]);
    await write("p-no-xp", [{ level: 2, xp: 40 }, { level: 2 }]);
    await write("p-no-level", [{ level: 5, xp: 70 }, {}]);
    await write("p-empty", []);
    expect(runProgress("p-levelled", dir)).toEqual({ level: 4, xp: 250, startedAt: NOW - 10 * MIN });
    expect(runProgress("p-no-xp", dir)).toEqual({ level: 2, xp: 0, startedAt: NOW - 10 * MIN });
    // The newest sample decides: one without a level is no progress to report.
    expect(runProgress("p-no-level", dir)).toBeUndefined();
    expect(runProgress("p-empty", dir)).toBeUndefined();
    expect(runProgress("p-missing", dir)).toBeUndefined();
  });

  test("the account row and the holder note carry the marker and the command that says why", () => {
    const flag = liveRunStuck("run-stuck", NOW, RUNS)!;
    const rows = formatAccounts([{ account: "RUNNER1", kind: "pool", job: { name: "m-freeplay", models: ["m"], episode: "freeplay", runId: "run-stuck", level: 12, xp: 1350, elapsedMs: 3 * 3_600_000, stuck: flag } }]);
    expect(rows[1]).toContain(`${STUCK_MARK} no progress in 2h00m`);
    expect(rows[1]).toEndWith("(bun wb inspect stuck run-stuck)");
    expect(formatHolder({ runId: "run-stuck", stuck: flag })).toContain(`not fleet-managed ${STUCK_MARK} no progress`);
    const calm = formatAccounts([{ account: "RUNNER1", kind: "pool", job: { name: "m-freeplay", models: ["m"], episode: "freeplay", runId: "run-progressing", level: 12, xp: 2800 } }]);
    expect(calm[1]).not.toContain(STUCK_MARK);
  });
});
