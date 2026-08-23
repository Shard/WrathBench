/**
 * The results grouping and the ladder derivation.
 *
 * What matters here is what the release page is allowed to claim: unscorable
 * runs never enter a group, effort splits a model into two rows rather than
 * being averaged away, a group with zero successes still appears, and a rung
 * nothing records reads as "not instrumented" instead of being approximated.
 */

import { describe, expect, test } from "bun:test";
import type { ResultRun, LevelMark } from "../../runner/viewer/api-types";
import {
  EXPANSION_MAPS,
  RUNGS,
  byCharacter,
  characterOptions,
  groupsForLevel,
  ladderRows,
  markAtLeast,
  scored,
} from "../src/lib/results";

function mark(level: number, turn: number | null, ms: number | null): LevelMark {
  return { level, ts: level * 1000, turn, playtimeMs: ms };
}

function run(p: Partial<ResultRun> = {}): ResultRun {
  const levels = p.levels ?? [];
  return {
    runId: "r",
    model: "m",
    platform: "openrouter",
    harnessVersion: "harness-0.2",
    harnessSeries: "0.2",
    extra: false,
    effort: null,
    race: 1,
    raceName: "Human",
    class: 2,
    className: "Paladin",
    characterLabel: "Human Paladin",
    modelResponses: 1,
    harness: "wrathbench",
    promptHash: "sha256:aaaa",
    serverBuild: null,
    wikiCoords: false,
    toolCalls: null,
    snippets: null,
    episode: "e90",
    episodeSource: "stamped",
    episodeOverride: false,
    unscored: null,
    startedAt: 0,
    terminationReason: null,
    levels,
    maxLevel: levels.length > 0 ? levels[levels.length - 1]!.level : null,
    xp: null,
    money: null,
    questsCompleted: 0,
    maps: [0],
    character: "Toon",
    playtimeMs: null,
    tokens: null,
    actualCost: null,
    pauseReason: null,
    ...p,
  };
}

describe("scored / markAtLeast", () => {
  test("anything with a reason is out", () => {
    const rows = [run({ runId: "a" }), run({ runId: "b", unscored: "unscored (scripted stub)" })];
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

  test("the wiki-coordinates tier is a dimension (ADR-0028)", () => {
    const groups = groupsForLevel(
      [
        run({ runId: "names", wikiCoords: false, levels: [mark(5, 50, 5)] }),
        run({ runId: "coords", wikiCoords: true, levels: [mark(5, 5, 1)] }),
        run({ runId: "old", wikiCoords: null, levels: [mark(5, 7, 2)] }),
      ],
      5,
    );
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.wikiCoords)).toEqual([true, null, false]);
  });

  test("the harness is a tag on the group, not part of its key (ADR-0035)", () => {
    const groups = groupsForLevel(
      [
        run({ runId: "w", harness: "wrathbench", levels: [mark(5, 10, 5)] }),
        run({ runId: "c", harness: "claude-code", levels: [mark(5, 2, 1)] }),
        run({ runId: "u", harness: null, levels: [mark(5, 7, 2)] }),
      ],
      5,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.attempts).toBe(3);
    expect(groups[0]!.harnesses).toEqual(["claude-code", "harness?", "wrathbench"]);
    const rows = ladderRows([
      run({ runId: "w", harness: "wrathbench", levels: [mark(5, 10, 5)] }),
      run({ runId: "c", harness: "claude-code", levels: [mark(5, 2, 1)] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.harnesses).toEqual(["claude-code", "wrathbench"]);
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
      [run({ unscored: "unscored (operator objective)", levels: [mark(5, 1, 1)] })],
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

describe("series grouping (ADR-0034)", () => {
  test("two builds in one series share a row and the row lists both; a minor bump is its own row", () => {
    const rows = [
      run({ runId: "a", harnessVersion: "harness-0.3-10-gaaa", harnessSeries: "0.3", levels: [mark(5, 10, 1000)] }),
      run({ runId: "b", harnessVersion: "harness-0.3-12-gbbb-dirty", harnessSeries: "0.3", levels: [mark(5, 8, 900)] }),
      run({ runId: "c", harnessVersion: "harness-0.2-33-gccc", harnessSeries: "0.2", levels: [mark(5, 4, 400)] }),
      run({ runId: "d", harnessVersion: "gdead", harnessSeries: null }),
    ];
    const groups = groupsForLevel(rows, 5).sort((x, y) => x.harnessVersion.localeCompare(y.harnessVersion));
    expect(groups.map((g) => [g.harnessVersion, g.attempts, g.harnessVersions])).toEqual([
      ["0.2", 1, ["harness-0.2-33-gccc"]],
      ["0.3", 2, ["harness-0.3-10-gaaa", "harness-0.3-12-gbbb-dirty"]],
      ["gdead", 1, ["gdead"]],
    ]);
    expect(groups[1]!.bestTurn).toBe(8);
  });
});

describe("the character filter (ADR-0034's extras cycle)", () => {
  const rows = [
    run({ runId: "base", levels: [mark(5, 10, 1000)] }),
    run({ runId: "extra", extra: true, race: 3, raceName: "Dwarf", class: 3, className: "Hunter", characterLabel: "Dwarf Hunter", levels: [mark(5, 4, 400)] }),
    run({ runId: "old", race: null, raceName: null, class: null, className: null, characterLabel: null }),
  ];

  test("the options are the labels actually present, sorted, with unrecorded runs offering none", () => {
    expect(characterOptions(rows)).toEqual(["Dwarf Hunter", "Human Paladin"]);
  });

  test("all is the default and keeps every run, including the ones with no character recorded", () => {
    expect(byCharacter(rows, null).map((r) => r.runId)).toEqual(["base", "extra", "old"]);
  });

  test("a chip narrows to that character and drops the unrecorded ones rather than guessing", () => {
    expect(byCharacter(rows, "Dwarf Hunter").map((r) => r.runId)).toEqual(["extra"]);
    expect(byCharacter(rows, "Human Paladin").map((r) => r.runId)).toEqual(["base"]);
  });

  test("character is a label, never a group key: one row holds both, and says which", () => {
    const groups = groupsForLevel(rows, 5);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.attempts).toBe(3);
    expect(groups[0]!.characters).toEqual(["Dwarf Hunter", "Human Paladin"]);
    // Filtered, the same call yields the one character's row alone.
    const dwarf = groupsForLevel(byCharacter(rows, "Dwarf Hunter"), 5);
    expect(dwarf[0]!.characters).toEqual(["Dwarf Hunter"]);
    expect(dwarf[0]!.bestTurn).toBe(4);
  });

  test("a ladder row labels the characters its model was played on", () => {
    expect(ladderRows(rows)[0]!.characters).toEqual(["Dwarf Hunter", "Human Paladin"]);
  });
});

describe("ladder row order", () => {
  test("the rung decides first, then total XP as a (level, xp) pair, then gold", () => {
    const rows = ladderRows([
      // All three below are on rung 5 (L20). `higher` leads them on level alone,
      // even though it holds the least xp within it — the pair is lexicographic.
      run({ runId: "a", model: "poorer", levels: [mark(21, 1, 1)], maxLevel: 21, xp: 10, money: 9_999 }),
      run({ runId: "b", model: "higher", levels: [mark(22, 1, 1)], maxLevel: 22, xp: 5, money: 1 }),
      // Rung 7 beats all of them regardless of what it holds.
      run({ runId: "c", model: "rung", levels: [mark(40, 1, 1)], maxLevel: 40, xp: 0, money: 0 }),
      // Tied with "poorer" on the pair (21, 10); only gold separates the two.
      run({ runId: "d", model: "richer", levels: [mark(21, 1, 1)], maxLevel: 21, xp: 10, money: 10_000 }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["rung", "higher", "richer", "poorer"]);
  });

  test("the two tie-breaks are maxima that may come from different runs", () => {
    const row = ladderRows([
      run({ runId: "far", levels: [mark(12, 1, 1)], maxLevel: 12, xp: 400, money: 5 }),
      run({ runId: "rich", levels: [mark(6, 1, 1)], maxLevel: 6, xp: 9_000, money: 50_000 }),
    ])[0]!;
    expect(row.bestLevel).toBe(12);
    // The xp is the one read at the best *level*, never the largest xp seen.
    expect(row.bestXp).toBe(400);
    expect(row.bestRunId).toBe("far");
    expect(row.bestMoney).toBe(50_000);
    expect(row.bestMoneyRunId).toBe("rich");
  });

  test("a missing reading sorts last, and zero does not", () => {
    const rows = ladderRows([
      run({ runId: "z", model: "zero", levels: [mark(10, 1, 1)], maxLevel: 10, xp: 0, money: 0 }),
      run({ runId: "n", model: "none", levels: [mark(10, 1, 1)], maxLevel: 10, xp: null, money: null }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["zero", "none"]);
    expect(rows[1]!.bestXp).toBeNull();
    expect(rows[1]!.bestMoney).toBeNull();
  });
});
