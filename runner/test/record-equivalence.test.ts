/**
 * The scorer on the session record reads what it read off the state table
 * (operator, 2026-11-11: "the scorer reads the trace; the 60-second state table
 * is folded into it"; docs/METHODOLOGY.md, "The harness records a signal
 * vector").
 *
 * `v1p1-solo` (`fixtures/v1p1/`) is a run recorded while a v1 run still had
 * both: run.sqlite's 60-second `state` rows and the trajectory's milestones,
 * written by the loop, and the stack's trace and events, written by the
 * recorders, all off one state cache. Two layers:
 *
 * 1. **The record holds the same readings.** The trace folded up to each state
 *    row's instant equals that row, column for column, and the turn joined by
 *    timestamp equals the turn the row was stamped with.
 * 2. **The scored derivations agree up to the cadence.** Read off the samples
 *    the trace yields (`trace-samples.ts`) and off the state rows, the levels
 *    reached, the maps seen, the money and the turn-ins are equal; each level
 *    is first seen no later; XP at the top level and XP earned are no lower
 *    (the trace sees the last kill before a sample did); and the milestone
 *    facts from the `events` stream equal those from the trajectory's
 *    milestone records except where a stamp is earlier for the same reason.
 *
 * The frozen 0.5 runs are not in this test: their state rows and their trace
 * tables were written by hand independently (`fixtures/legacy05/README.md`),
 * so they disagree by construction, and a 0.5 run is still read off its state
 * table (`run-reader.ts`), which `legacy05-golden.test.ts` holds unchanged.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionReader, type TraceRow } from "@wrathbench/mcp/record";
import { latestReading, noteTurnLine, readStateSamples, TurnIndex } from "../src/run-reader";
import { TraceFold } from "../src/trace-samples";
import { statePointOf, type StatePointRow } from "../viewer/clickhouse";
import { levelMarks, mapsOf, questsAcrossRestarts, xpAtLevel, xpEarned } from "../viewer/results";
import { scanRunTotals } from "../viewer/tail";
import { materialiseV1p1, V1P1_RUN, V1P1_SRC, v1p1StateRows } from "./fixtures/v1p1";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const traceRows = (): TraceRow[] => new SessionReader(join(V1P1_SRC, "session")).rows("trace");

function turnIndex(): TurnIndex {
  const turns = new TurnIndex();
  for (const line of readFileSync(join(V1P1_SRC, "trajectory.jsonl"), "utf8").split("\n")) noteTurnLine(turns, line);
  return turns;
}

/** The trace folded up to and including `ts`, read in the state row's columns. */
function foldedAt(rows: readonly TraceRow[], ts: number): Record<string, unknown> {
  const fold = new TraceFold();
  for (const r of rows) {
    if (r.ts > ts) break;
    if (r.kind === "dict") fold.learn(r.dict);
    else fold.apply(r);
  }
  const s = fold.state;
  const items = fold.itemSamples();
  return {
    level: s.level,
    xp: s.xp,
    map: fold.map,
    x: fold.x,
    y: fold.y,
    z: fold.z,
    money: fold.sheet.money,
    zone: s.zone,
    area: s.area,
    health: s.hp,
    max_health: s.hpMax,
    power: s.pw,
    max_power: s.pwMax,
    power_type: s.pwType,
    next_level_xp: s.xpMax,
    items: items === null ? null : JSON.stringify(items),
  };
}

const COLUMNS = ["level", "xp", "map", "x", "y", "z", "money", "zone", "area", "health", "max_health", "power", "max_power", "power_type", "next_level_xp"] as const;

describe("v1p1-solo: the trace holds what the state rows held", () => {
  const rows = traceRows();
  const states = v1p1StateRows();

  test("the fixture is the overlap it claims to be", () => {
    expect(states).toHaveLength(20);
    expect(rows.length).toBeGreaterThan(300);
    expect(states.some((s) => s["level"] === 7)).toBe(true);
  });

  test("the trace folded to each row's instant equals the row, column for column", () => {
    for (const s of states) {
      const got = foldedAt(rows, s["ts"] as number);
      const want = Object.fromEntries(COLUMNS.map((c) => [c, s[c]]));
      expect({ ts: s["ts"], ...Object.fromEntries(COLUMNS.map((c) => [c, got[c]])) }).toEqual({ ts: s["ts"], ...want });
      // A row carried `items` only when they changed; where it did, the sheet says the same.
      if (s["items"] !== null) expect(got["items"]).toBe(s["items"] as string);
    }
  });

  test("the turn joined by timestamp is the turn each row was stamped with", () => {
    const turns = turnIndex();
    expect(states.map((s) => turns.at(s["ts"] as number))).toEqual(states.map((s) => (s["turn"] as number | null) ?? null));
    expect(turns.max).toBe(14);
  });
});

describe("v1p1-solo: the scored derivations, off the trace and off the state rows", () => {
  const runs = tempDir("record-equivalence-");
  const dir = materialiseV1p1(runs);
  const fromTrace = readStateSamples(dir, V1P1_RUN).map((r) => statePointOf(r as unknown as StatePointRow));
  const fromState = v1p1StateRows().map((r) => statePointOf(r as unknown as StatePointRow));

  test("the levels reached are the same, each first seen no later and in no later turn", () => {
    const t = levelMarks(fromTrace);
    const s = levelMarks(fromState);
    expect(t.map((m) => m.level)).toEqual([5, 6, 7]);
    expect(t.map((m) => m.level)).toEqual(s.map((m) => m.level));
    for (const [i, m] of t.entries()) {
      expect(m.ts).toBeLessThanOrEqual(s[i]!.ts);
      if (m.turn !== null && s[i]!.turn !== null) expect(m.turn).toBeLessThanOrEqual(s[i]!.turn);
    }
    // The ding at 330 s was sampled at 360 s; the trace has it at the packet.
    expect(s[1]!.ts - t[1]!.ts).toBe(30_000);
  });

  test("XP at the top level and XP earned are lower bounds that the trace raises, never lowers", () => {
    const top = 7;
    expect(xpAtLevel(fromTrace, top)!).toBeGreaterThanOrEqual(xpAtLevel(fromState, top)!);
    expect(xpEarned(fromTrace)!).toBeGreaterThanOrEqual(xpEarned(fromState)!);
    // Three kills landed after the last state row, which the trace has and no sample did.
    expect(xpAtLevel(fromTrace, top)! - xpAtLevel(fromState, top)!).toBe(3 * 45);
    expect(xpEarned(fromTrace)! - xpEarned(fromState)!).toBeGreaterThanOrEqual(3 * 45);
  });

  test("turn-ins: the run's count, which the per-process counter summed to", () => {
    expect(questsAcrossRestarts(fromTrace)).toBe(3);
    expect(questsAcrossRestarts(fromState)).toBe(3);
    // The newest state row says 1: the cache's count since the restart.
    expect(fromState.at(-1)!.questsCompleted).toBe(1);
    expect(fromTrace.at(-1)!.questsCompleted).toBe(3);
  });

  test("maps, money and the newest reading", () => {
    expect(mapsOf(fromTrace)).toEqual(mapsOf(fromState));
    // The newest reading is the trace's last, a minute past the last state row.
    const latest = latestReading(dir, V1P1_RUN)!;
    const end = foldedAt(traceRows(), Infinity);
    expect({ level: latest.level, xp: latest.xp, money: latest.money, map: latest.map, zone: latest.zone, area: latest.area }).toEqual({
      level: end["level"] as number,
      xp: end["xp"] as number,
      money: end["money"] as number,
      map: end["map"] as number,
      zone: end["zone"] as number,
      area: end["area"] as number,
    });
    const last = v1p1StateRows().at(-1)!;
    expect(latest.money! - (last["money"] as number)).toBe(37);
    expect(latest.level).toBe(last["level"] as number);
  });

  test("the stream cursor is not on the trace", () => {
    expect(fromTrace.every((s) => s.eventCount === null && s.lastSeq === null)).toBe(true);
  });
});

describe("v1p1-solo: milestone facts, off the events stream and off the trajectory", () => {
  const runs = tempDir("record-equivalence-");
  // The same run twice: with its session record (v1, milestones from `events`)
  // and without it (read as the trajectory's milestone records were).
  materialiseV1p1(runs);
  const bare = join(runs, "bare");
  materialiseV1p1(runs, { as: "bare" });
  const fromEvents = () => scanRunTotals(join(runs, V1P1_RUN, "trajectory.jsonl"));
  const fromRecords = async () => {
    const { rmSync } = await import("node:fs");
    rmSync(join(bare, "session"), { recursive: true, force: true });
    return await scanRunTotals(join(bare, "trajectory.jsonl"));
  };

  test("the same facts, with the events' own stamps", async () => {
    const e = await fromEvents();
    const r = await fromRecords();
    expect(e.leveling!.levelUps).toBe(r.leveling!.levelUps);
    expect(e.leveling!.startLevel).toBe(r.leveling!.startLevel);
    expect(e.leveling!.maxLevel).toBe(r.leveling!.maxLevel);
    // The ding at 330 s: the event's stamp, where the loop's sample saw it at 360 s.
    expect(r.leveling!.marks.find((m) => m.to === 6 && m.from === 5)!.ts - e.leveling!.marks.find((m) => m.to === 6 && m.from === 5)!.ts).toBe(30_000);
    expect(e.areas).toEqual({ ...r.areas!, zoneMarks: e.areas!.zoneMarks, areaMarks: e.areas!.areaMarks });
    expect(e.achievements!.earned).toEqual(r.achievements!.earned);
    expect(e.achievements!.points).toBe(r.achievements!.points);
    expect(e.spells!.learned).toBe(r.spells!.learned);
    expect(e.talents).toEqual(r.talents);
    expect(e.trades).toEqual(r.trades);
    expect(e.taxi).toEqual(r.taxi);
    expect(e.deaths!.deaths).toBe(r.deaths!.deaths);
  });

  test("a restarted child states its baselines again, and none of them counts as a gain", async () => {
    const e = await fromEvents();
    // The loop wrote one baseline per runner process; the recorder writes one
    // per child, so the restart adds a zone, an area and a level baseline.
    const r = await fromRecords();
    expect(e.areas!.zoneMarks - r.areas!.zoneMarks).toBe(1);
    expect(e.areas!.areaMarks - r.areas!.areaMarks).toBe(1);
    expect(e.leveling!.marks.length - r.leveling!.marks.length).toBe(1);
  });
});
