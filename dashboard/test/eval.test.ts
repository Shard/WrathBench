/**
 * The eval grouping and the ladder derivation.
 *
 * What matters here is what the release page is allowed to claim: unscorable
 * runs never enter a group, effort splits a model into two rows rather than
 * being averaged away, a group with zero successes still appears, and a rung
 * nothing records reads as "not instrumented" instead of being approximated.
 */

import { describe, expect, test } from "bun:test";
import type { EvalRun, LevelMark } from "../../runner/viewer/api-types";
import {
  EXPANSION_MAPS,
  RUNGS,
  groupsForLevel,
  ladderRows,
  markAtLeast,
  scored,
} from "../src/lib/eval";

function mark(level: number, turn: number | null, ms: number | null): LevelMark {
  return { level, ts: level * 1000, turn, playtimeMs: ms };
}

function run(p: Partial<EvalRun> = {}): EvalRun {
  const levels = p.levels ?? [];
  return {
    runId: "r",
    model: "m",
    platform: "openrouter",
    harnessVersion: "harness-0.2",
    effort: null,
    contextEngine: "harness-fixed-window",
    promptHash: "sha256:aaaa",
    unscored: null,
    startedAt: 0,
    terminationReason: null,
    levels,
    maxLevel: levels.length > 0 ? levels[levels.length - 1]!.level : null,
    questsCompleted: 0,
    maps: [0],
    ...p,
  };
}

describe("scored / markAtLeast", () => {
  test("anything with a reason is out", () => {
    const rows = [run({ runId: "a" }), run({ runId: "b", unscored: "shakeout driver (stub)" })];
    expect(scored(rows).map((r) => r.runId)).toEqual(["a"]);
  });

  test("a level is credited by the first mark at or above it", () => {
    const r = run({ levels: [mark(2, 1, 10), mark(7, 9, 90)] });
    expect(markAtLeast(r, 5)?.level).toBe(7);
    expect(markAtLeast(r, 8)).toBeNull();
  });
});

describe("groupsForLevel", () => {
  test("groups by model, harness and effort, and reports best and median", () => {
    const rows = [
      run({ runId: "a", levels: [mark(5, 10, 1000)] }),
      run({ runId: "b", levels: [mark(5, 20, 3000)] }),
      run({ runId: "c", levels: [mark(5, 30, 5000)] }),
      run({ runId: "d", model: "other", levels: [mark(5, 4, 400)] }),
    ];
    const groups = groupsForLevel(rows, 5);
    expect(groups.map((g) => g.model)).toEqual(["other", "m"]); // fastest leads
    const m = groups.find((g) => g.model === "m")!;
    expect(m.attempts).toBe(3);
    expect(m.bestTurn).toBe(10);
    expect(m.medianTurn).toBe(20);
    expect(m.bestMs).toBe(1000);
    expect(m.reached[0]!.runId).toBe("a");
  });

  test("effort is a dimension, not an average (ADR-0024)", () => {
    const groups = groupsForLevel(
      [
        run({ runId: "lo", effort: "low", levels: [mark(5, 50, 5)] }),
        run({ runId: "hi", effort: "high", levels: [mark(5, 5, 1)] }),
      ],
      5,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.effort)).toEqual(["high", "low"]);
  });

  test("a group that never reached the level is still reported", () => {
    const groups = groupsForLevel([run({ levels: [mark(3, 4, 40)] })], 10);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.attempts).toBe(1);
    expect(groups[0]!.reached).toEqual([]);
    expect(groups[0]!.bestTurn).toBeNull();
  });

  test("unscorable runs never enter a group", () => {
    const groups = groupsForLevel(
      [run({ unscored: "shakeout driver (claude-subscription)", levels: [mark(5, 1, 1)] })],
      5,
    );
    expect(groups).toEqual([]);
  });

  test("a run with no turn index still contributes its time", () => {
    const g = groupsForLevel([run({ levels: [mark(5, null, 900)] })], 5)[0]!;
    expect(g.bestTurn).toBeNull();
    expect(g.bestMs).toBe(900);
  });
});

describe("ladderRows", () => {
  test("rungs 2, 4 and 6 are never claimed", () => {
    const row = ladderRows([run({ levels: [mark(80, 1, 1)], maxLevel: 80 })])[0]!;
    for (const n of [2, 4, 6]) {
      expect(row.cells.find((c) => c.n === n)!.status).toBe("not-instrumented");
    }
    expect(row.highest).toBe(8);
  });

  test("the highest derivable rung is reported per model, best run counting", () => {
    const rows = ladderRows([
      run({ model: "m", runId: "low", maxLevel: 4 }),
      run({ model: "m", runId: "high", maxLevel: 12 }),
      run({ model: "other", maxLevel: 2 }),
    ]);
    const m = rows.find((r) => r.model === "m")!;
    expect(m.highest).toBe(3);
    expect(m.runs).toBe(2);
    expect(m.cells.find((c) => c.n === 3)!.runId).toBe("high");
    expect(rows[0]!.model).toBe("m"); // sorted by how far each model got
    expect(rows.find((r) => r.model === "other")!.highest).toBe(0);
  });

  test("an expansion continent reaches rung 7 without the level threshold", () => {
    const row = ladderRows([run({ maxLevel: 12, maps: [EXPANSION_MAPS[0]!] })])[0]!;
    expect(row.cells.find((c) => c.n === 7)!.status).toBe("reached");
  });

  test("every rung either has a rule to apply or says it has none", () => {
    expect(RUNGS).toHaveLength(8);
    for (const r of RUNGS) expect(r.rule.length).toBeGreaterThan(10);
  });
});
