/**
 * The ladder derivation.
 *
 * What matters here is what the release page is allowed to claim: unscorable
 * runs never enter a row, and a rung nothing records reads as "not
 * instrumented" instead of being approximated.
 */

import { describe, expect, test } from "bun:test";
import type { AreaFacts, ResultRun, LevelMark } from "../../runner/viewer/api-types";
import { DEFAULT_VIEW, LADDER_VIEWS, LEVEL, type Metrics, TOKENS, TURNS, XP, betterCorner, runMetrics, viewParam } from "../src/lib/axes";
import { paretoSteps } from "../src/lib/pareto";
import {
  CUE_PAD,
  EXPANSION_MAPS,
  LABEL_DESC,
  LABEL_H,
  type LadderPoint,
  LABEL_ROW,
  MARK_RING_R,
  RUNGS,
  chartCue,
  puckRect,
  rectsOverlap,
  segmentsCross,
  characterIconCx,
  characterLabelX,
  billingKnown,
  classOptions,
  filterRuns,
  harnessOptions,
  COST_CEILING_MIN,
  COST_FLOOR,
  FREE_GUTTER_W,
  costScale,
  fmtCostTick,
  ladderChartLayout,
  ladderPoints,
  ladderRows,
  levelRangeOf,
  raceOptions,
  resolveChoice,
  runCostReading,
  scored,
  stitchCharacter,
  characterChartLayout,
  characterRows,
  characterSeries,
  timeTicks,
  xpEarnedOf,
} from "../src/lib/ladder";
import { OPAQUE_PAUSE_REASON } from "../src/lib/runs";
import { familyOf, monogramOf } from "../src/lib/lineup";
import { resolvedSummary } from "../src/lib/models";
import { EPISODE_CHOICES, episodeParam } from "../src/lib/episodes";

/** A metric bag with the named readings and null everywhere else. */
function bag(p: Partial<Record<keyof Metrics, number | null>>): Metrics {
  return { cost: null, xp: null, tokens: null, tokensOut: null, turns: null, toolCalls: null, playtimeMs: null, level: null, quests: null, ...p };
}

function mark(level: number, turn: number | null, ms: number | null): LevelMark {
  return { level, ts: level * 1000, turn, playtimeMs: ms };
}

function areas(p: Partial<AreaFacts> = {}): AreaFacts {
  return { startArea: 9, distinctAreas: 1, leftStartArea: false, capitalZone: null, zoneMarks: 1, areaMarks: 1, ...p };
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
    campaign: null,
    cell: null,
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
    continuedFrom: null,
    stillborn: null,
    ...p,
  };
}

describe("scored", () => {
  test("anything with a reason is out", () => {
    const rows = [run({ runId: "a" }), run({ runId: "b", unscored: "unscored (scripted stub)" })];
    expect(scored(rows).map((r) => r.runId)).toEqual(["a"]);
  });

  test("tainted rows cannot enter the public ladder ranking", () => {
    const rows = [
      run({ runId: "good", model: "good", maxLevel: 5 }),
      run({ runId: "live", model: "tainted", maxLevel: 80, unscored: "unscored (live)" }),
      run({ runId: "environment", model: "tainted", maxLevel: 80, unscored: "unscored (environment-defect)" }),
    ];
    expect(scored(rows).map((r) => r.runId)).toEqual(["good"]);
    expect(ladderRows(rows).map((r) => r.model)).toEqual(["good"]);
  });
});

describe("the resolved model id on a ladder row", () => {
  test("collects the ids a row's runs were really on, and shows an alias resolving two ways", () => {
    const rows = ladderRows([
      run({ runId: "a", model: "sonnet", resolvedModel: "claude-sonnet-5", maxLevel: 4 }),
      run({ runId: "b", model: "sonnet", resolvedModel: "claude-sonnet-4-5", maxLevel: 3 }),
      run({ runId: "c", model: "z-ai/glm-5.2", resolvedModel: "z-ai/glm-5.2", maxLevel: 2 }),
      run({ runId: "d", model: "opus", maxLevel: 2 }),
    ]);
    const by = new Map(rows.map((r) => [r.model, r]));
    // One row, two Claudes: the drift the alias hid.
    expect(by.get("sonnet")!.resolvedModels).toEqual(["claude-sonnet-4-5", "claude-sonnet-5"]);
    expect(resolvedSummary("sonnet", by.get("sonnet")!.resolvedModels)).toEqual({
      ids: ["claude-sonnet-4-5", "claude-sonnet-5"],
      mixed: true,
    });
    // A slug served as itself says nothing a row does not already print.
    expect(resolvedSummary("z-ai/glm-5.2", by.get("z-ai/glm-5.2")!.resolvedModels)).toBeNull();
    // A run that recorded none reads as "not recorded", never as its config string.
    expect(by.get("opus")!.resolvedModels).toEqual([]);
    expect(resolvedSummary("opus", by.get("opus")!.resolvedModels)).toBeNull();
  });
});

describe("ladderRows", () => {
  test("rung 6 is never claimed, and rungs 2 and 4 are no longer blanks", () => {
    const row = ladderRows([run({ levels: [mark(80, 1, 1)], maxLevel: 80 })])[0]!;
    expect(row.cells.find((c) => c.n === 6)!.status).toBe("not-instrumented");
    // No milestone records on this run: answered, and answered "no".
    for (const n of [2, 4]) expect(row.cells.find((c) => c.n === n)!.status).toBe("not-reached");
    expect(row.highest).toBe(8);
  });

  test("a run that predates the milestone producer never claims rung 2 or 4", () => {
    const row = ladderRows([run({ areas: null }), run({ runId: "older" })])[0]!;
    for (const n of [2, 4]) expect(row.cells.find((c) => c.n === n)!.status).toBe("not-reached");
  });

  test("leaving the first-observed area reaches rung 2, staying in it does not", () => {
    const stayed = ladderRows([
      run({ model: "stayer", areas: areas({ leftStartArea: false }) }),
    ])[0]!;
    expect(stayed.cells.find((c) => c.n === 2)!.status).toBe("not-reached");
    const left = ladderRows([run({ model: "walker", areas: areas({ leftStartArea: true, distinctAreas: 3 }) })])[0]!;
    expect(left.cells.find((c) => c.n === 2)!.status).toBe("reached");
    expect(left.highest).toBe(2);
  });

  test("rung 4 needs both halves: a capital zone AND a recorded flight", () => {
    const both = ladderRows([
      run({ model: "cap", areas: areas({ capitalZone: 1519 }), taxi: { flights: 1 } }),
    ])[0]!;
    expect(both.cells.find((c) => c.n === 4)!.status).toBe("reached");
    // Walked to Stormwind, never flew: the rung says "and", so it says no.
    const walked = ladderRows([
      run({ model: "walker", areas: areas({ capitalZone: 1519 }), taxi: { flights: 0 } }),
    ])[0]!;
    expect(walked.cells.find((c) => c.n === 4)!.status).toBe("not-reached");
    const flewNoCapital = ladderRows([
      run({ model: "flier", areas: areas({ capitalZone: null }), taxi: { flights: 2 } }),
    ])[0]!;
    expect(flewNoCapital.cells.find((c) => c.n === 4)!.status).toBe("not-reached");
  });

  test("a run from before the flight taps cannot pass rung 4, and says nothing about one that can", () => {
    // `taxi: null` is "not recorded", not "flew nowhere" — the pre-deploy run
    // simply fails to answer, and a cell is reached as soon as ANY run does.
    const pre = run({ runId: "pre", areas: areas({ capitalZone: 1519 }), taxi: null });
    expect(ladderRows([pre])[0]!.cells.find((c) => c.n === 4)!.status).toBe("not-reached");
    const row = ladderRows([
      pre,
      run({ runId: "post", areas: areas({ capitalZone: 1519 }), taxi: { flights: 1 } }),
    ])[0]!;
    const cell = row.cells.find((c) => c.n === 4)!;
    expect(cell.status).toBe("reached");
    expect(cell.runId).toBe("post");
  });

  test("achievement points are a displayed signal and change no ordering", () => {
    const rows = ladderRows([
      run({ model: "decorated", maxLevel: 4, achievements: { earned: 40, points: 400, ids: [1] } }),
      run({ model: "plain", maxLevel: 12, achievements: null }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["plain", "decorated"]);
  });

  test("a hole at rung 2 does not lower the highest rung reached", () => {
    // The model got to L10 without a milestone record ever showing it moved.
    const row = ladderRows([run({ levels: [mark(10, 1, 1)], maxLevel: 10, areas: areas({ leftStartArea: false }) })])[0]!;
    expect(row.cells.find((c) => c.n === 2)!.status).toBe("not-reached");
    expect(row.highest).toBe(3);
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

describe("the ladder's dispersion (item 125, operator 2026-09-16)", () => {
  test("a rung cell counts how many runs reached it, not just that one did", () => {
    const rows = ladderRows([
      run({ model: "m", runId: "a", maxLevel: 12 }),
      run({ model: "m", runId: "b", maxLevel: 10 }),
      run({ model: "m", runId: "c", maxLevel: 4 }),
    ]);
    const cell = rows[0]!.cells.find((c) => c.n === 3)!;
    expect(cell.status).toBe("reached");
    expect(cell.reached).toBe(2);
    expect(cell.askable).toBe(3);
    // The link is unchanged: the first run that passes, not the furthest.
    expect(cell.runId).toBe("a");
  });

  test("a run that could not be asked is not counted as a failure", () => {
    // Two runs predate the area record entirely; only one can answer rung 2.
    const rows = ladderRows([
      run({ model: "m", runId: "new", maxLevel: 6, areas: areas({ leftStartArea: true }) }),
      run({ model: "m", runId: "old1", maxLevel: 6 }),
      run({ model: "m", runId: "old2", maxLevel: 6 }),
    ]);
    const cell = rows[0]!.cells.find((c) => c.n === 2)!;
    expect(cell.reached).toBe(1);
    expect(cell.askable).toBe(1); // 1/1, never 1/3
    expect(rows[0]!.runs).toBe(3);
  });

  test("rung 4 needs both records, so a run with areas but no taxi cannot be asked", () => {
    const rows = ladderRows([
      run({ model: "m", maxLevel: 6, areas: areas({ capitalZone: 1537 }) }),
      run({ model: "m", maxLevel: 6, areas: areas({ capitalZone: 1537 }), taxi: { flights: 1 } }),
    ]);
    const cell = rows[0]!.cells.find((c) => c.n === 4)!;
    expect(cell.askable).toBe(1);
    expect(cell.reached).toBe(1);
  });

  test("an uninstrumented rung counts nothing rather than reporting 0 of n", () => {
    const cell = ladderRows([run({ maxLevel: 6 })])[0]!.cells.find((c) => c.n === 6)!;
    expect(cell.status).toBe("not-instrumented");
    expect(cell.askable).toBe(0);
    expect(cell.reached).toBe(0);
  });

  test("the level range is min, median and max over the runs that recorded a level", () => {
    expect(levelRangeOf([run({ maxLevel: 5 }), run({ maxLevel: 7 }), run({ maxLevel: 6 })])).toEqual({
      min: 5,
      median: 6,
      max: 7,
      n: 3,
    });
  });

  test("an even count takes the lower middle: an observed level, never a half-level", () => {
    const lr = levelRangeOf([run({ maxLevel: 6 }), run({ maxLevel: 7 })])!;
    expect(lr.median).toBe(6);
    expect(Number.isInteger(lr.median)).toBe(true);
  });

  test("a run with no level reading is left out, not counted as zero; none at all is null", () => {
    const lr = levelRangeOf([run({ maxLevel: 4 }), run({ maxLevel: null }), run({ maxLevel: 8 })])!;
    expect(lr).toEqual({ min: 4, median: 4, max: 8, n: 2 });
    expect(levelRangeOf([run({ maxLevel: null })])).toBeNull();
  });

  test("the row carries the spread beside the maximum, and the maximum is unchanged", () => {
    const row = ladderRows([
      run({ model: "m", runId: "a", maxLevel: 7 }),
      run({ model: "m", runId: "b", maxLevel: 5 }),
      run({ model: "m", runId: "c", maxLevel: 6 }),
    ])[0]!;
    expect(row.bestLevel).toBe(7);
    expect(row.levelRange).toEqual({ min: 5, median: 6, max: 7, n: 3 });
  });
});

describe("the ladder's filters", () => {
  const rows = [
    run({ runId: "base", levels: [mark(5, 10, 1000)], billing: "paid" }),
    run({
      runId: "extra",
      extra: true,
      race: 3,
      raceName: "Dwarf",
      class: 3,
      className: "Hunter",
      characterLabel: "Dwarf Hunter",
      levels: [mark(5, 4, 400)],
      harness: "claude-code",
      billing: "paid",
    }),
    run({ runId: "gratis", model: "qwen/qwen3:free", billing: "free" }),
    run({ runId: "old", race: null, raceName: null, class: null, className: null, characterLabel: null }),
  ];
  const all = { race: null, klass: null, harness: null, excludeFree: false };

  test("the options are the values actually present, sorted, with unrecorded runs offering none", () => {
    expect(raceOptions(rows)).toEqual(["Dwarf", "Human"]);
    expect(classOptions(rows)).toEqual(["Hunter", "Paladin"]);
    expect(harnessOptions(rows)).toEqual(["claude-code", "wrathbench"]);
  });

  test("all is the default and keeps every run, including the ones recording nothing", () => {
    expect(filterRuns(rows, all).map((r) => r.runId)).toEqual(["base", "extra", "gratis", "old"]);
  });

  test("a pick narrows to that value and drops the unrecorded ones rather than guessing", () => {
    expect(filterRuns(rows, { ...all, race: "Dwarf" }).map((r) => r.runId)).toEqual(["extra"]);
    expect(filterRuns(rows, { ...all, klass: "Paladin" }).map((r) => r.runId)).toEqual(["base", "gratis"]);
    expect(filterRuns(rows, { ...all, harness: "claude-code" }).map((r) => r.runId)).toEqual(["extra"]);
  });

  test("race and class are independent, so a pair nothing ran is empty rather than impossible", () => {
    expect(filterRuns(rows, { ...all, race: "Dwarf", klass: "Paladin" })).toEqual([]);
    expect(filterRuns(rows, { ...all, race: "Human", klass: "Paladin" }).map((r) => r.runId)).toEqual([
      "base",
      "gratis",
    ]);
  });

  test("exclude free drops the free runs and keeps the ones a viewer could not answer for", () => {
    // `old` carries no `billing` at all: an older viewer does not report that a
    // run was free, and dropping what it cannot answer would shrink the ladder.
    expect(filterRuns(rows, { ...all, excludeFree: true }).map((r) => r.runId)).toEqual([
      "base",
      "extra",
      "old",
    ]);
  });

  test("a feed that answers billing on no run at all is reported, not filtered", () => {
    expect(billingKnown(rows)).toBe(true);
    expect(billingKnown([run({ runId: "old" })])).toBe(false);
    expect(filterRuns([run({ runId: "old" })], { ...all, excludeFree: true }).map((r) => r.runId)).toEqual(["old"]);
  });

  test("a remembered choice this episode cannot honour resolves back to all", () => {
    expect(resolveChoice(raceOptions(rows), "Dwarf")).toBe("Dwarf");
    expect(resolveChoice(raceOptions(rows), "Gnome")).toBeNull();
    expect(resolveChoice(raceOptions(rows), null)).toBeNull();
  });

  test("filtering happens before the rows, so the ranking is over what is on screen", () => {
    const set = [
      run({ runId: "p", model: "paid-model", levels: [mark(5, 1, 1)], maxLevel: 5, billing: "paid" }),
      run({ runId: "f", model: "free-model", levels: [mark(20, 1, 1)], maxLevel: 20, billing: "free" }),
    ];
    expect(ladderRows(filterRuns(set, all)).map((r) => r.model)).toEqual(["free-model", "paid-model"]);
    expect(ladderRows(filterRuns(set, { ...all, excludeFree: true })).map((r) => r.model)).toEqual([
      "paid-model",
    ]);
  });

  test("a ladder row still labels the characters its model was played on", () => {
    expect(ladderRows(rows.filter((r) => r.model === "m"))[0]!.characters).toEqual([
      "Dwarf Hunter",
      "Human Paladin",
    ]);
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

describe("the shared episode param", () => {
  test("one tier at a time: e90 by default, a typo or the old `all` falls back visibly", () => {
    expect(episodeParam(undefined)).toBe("e90");
    expect(episodeParam("e360")).toBe("e360");
    // A typo in a shared link falls back rather than being sent to the API,
    // which would answer 400 and blank the page.
    expect(episodeParam("e42")).toBe("e90");
    // `all` was a choice once; a link that still carries it lands on the default.
    expect(episodeParam("all")).toBe("e90");
    expect(EPISODE_CHOICES).not.toContain("all");
  });

  test("probing has no ladder (operator, 2026-08-29); a link that names it falls back", () => {
    expect(EPISODE_CHOICES).not.toContain("probing");
    expect(EPISODE_CHOICES).toEqual(["e90", "e360", "freeplay"]);
    expect(episodeParam("probing")).toBe("e90");
  });
});

/**
 * The freeplay field. Everything here turns on two facts the scored ladder
 * does not have: every freeplay run is unscored, and a character is one character
 * across attempts.
 */
describe("freeplay characters", () => {
  const fp = (over: Partial<ResultRun> = {}): ResultRun =>
    run({ unscored: "unscored (episode freeplay)", episode: "freeplay", ...over });

  test("an unscored run is a row here — which is exactly what the rung ladder drops", () => {
    const runs = [fp({ runId: "a1", model: "m", maxLevel: 7, xp: 100 })];
    // The bug this page had: `ladderRows` filters to `scored`, and no freeplay
    // run is ever scored, so the table was structurally empty.
    expect(scored(runs)).toEqual([]);
    expect(ladderRows(runs)).toEqual([]);
    expect(characterRows(runs).map((r) => r.characterId)).toEqual(["a1"]);
  });

  test("a character carries its effort, so two characters of one model are told apart", () => {
    const rows = characterRows([
      fp({ runId: "s1", model: "z-ai/glm-4.7-flash", effort: "low", maxLevel: 3 }),
      fp({ runId: "s2", model: "z-ai/glm-4.7-flash", effort: null, maxLevel: 4 }),
    ]);
    expect(rows.map((r) => [r.model, r.effort])).toEqual(
      expect.arrayContaining([
        ["z-ai/glm-4.7-flash", "low"],
        ["z-ai/glm-4.7-flash", null],
      ]),
    );
  });

  test("a chain of three collapses to one row: the latest attempt, the whole lineage", () => {
    const rows = characterRows([
      fp({ runId: "a1", maxLevel: 3, xp: 10 }),
      fp({ runId: "a3", continuedFrom: "a2", maxLevel: 9, xp: 40, startedAt: 300 }),
      fp({ runId: "a2", continuedFrom: "a1", maxLevel: 6, xp: 20, startedAt: 200 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.characterId).toBe("a1");
    expect(rows[0]!.attempts).toBe(3);
    expect(rows[0]!.chain).toEqual(["a1", "a2", "a3"]);
    // The latest attempt carries the character's current state.
    expect(rows[0]!.latest.runId).toBe("a3");
    expect(rows[0]!.level).toBe(9);
  });

  test("quests are the character's, summed over the chain — not the last session's", () => {
    // The runner's counter restarts at every continuation, so the latest
    // attempt's 2 is the tally of one session and the character has done 13.
    const rows = characterRows([
      fp({ runId: "q1", questsCompleted: 4, maxLevel: 3 }),
      fp({ runId: "q2", continuedFrom: "q1", startedAt: 200, questsCompleted: 7, maxLevel: 6 }),
      fp({ runId: "q3", continuedFrom: "q2", startedAt: 300, questsCompleted: 2, maxLevel: 9 }),
    ]);
    expect(rows[0]!.questsCompleted).toBe(13);
    // Level, xp and money are what the character HOLDS: still the furthest attempt's.
    expect(rows[0]!.level).toBe(9);
  });

  test("an attempt that recorded no quest count contributes nothing, and none at all is null", () => {
    const some = characterRows([
      fp({ runId: "n1", questsCompleted: null }),
      fp({ runId: "n2", continuedFrom: "n1", startedAt: 200, questsCompleted: 5 }),
    ]);
    expect(some[0]!.questsCompleted).toBe(5);
    const none = characterRows([
      fp({ runId: "p1", questsCompleted: null }),
      fp({ runId: "p2", continuedFrom: "p1", startedAt: 200, questsCompleted: null }),
    ]);
    // Never 0: a character whose attempts all predate the column has not been
    // observed completing nothing.
    expect(none[0]!.questsCompleted).toBeNull();
  });

  test("a lineage pointing outside the set is a root, not a dropped row", () => {
    // `dropContinuation` clears the link when the character is gone, and an
    // archived predecessor is never listed: both must leave the survivor here.
    const rows = characterRows([fp({ runId: "b7", continuedFrom: "b6-archived", maxLevel: 4 })]);
    expect(rows.map((r) => ({ id: r.characterId, n: r.attempts }))).toEqual([{ id: "b7", n: 1 }]);
  });

  test("two runs claiming one predecessor: the longer chain wins the row, then the later start", () => {
    const rows = characterRows([
      fp({ runId: "c1", maxLevel: 2 }),
      fp({ runId: "c2", continuedFrom: "c1", startedAt: 200, maxLevel: 5 }),
      fp({ runId: "c2b", continuedFrom: "c1", startedAt: 400, maxLevel: 6 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latest.runId).toBe("c2b");
    expect(rows[0]!.attempts).toBe(2);
  });

  test("a malformed cycle ends the walk instead of hanging the page", () => {
    const rows = characterRows([
      fp({ runId: "d1", continuedFrom: "d2" }),
      fp({ runId: "d2", continuedFrom: "d1" }),
    ]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.attempts).toBeLessThanOrEqual(2);
  });

  test("a stillborn launch is dropped; live, paused and ended characters all stay, with their status", () => {
    const rows = characterRows([
      fp({ runId: "live", live: true, maxLevel: 12 }),
      fp({ runId: "paused", pauseReason: "operator-pause", maxLevel: 11 }),
      fp({ runId: "ended", terminationReason: "manual", maxLevel: 10 }),
      fp({ runId: "nothing", stillborn: true, maxLevel: 20 }),
    ]);
    expect(rows.map((r) => [r.characterId, r.status, r.statusDetail])).toEqual([
      ["live", "live", null],
      ["paused", "paused", "operator-pause"],
      ["ended", "ended", "manual"],
    ]);
  });

  test("ordered by level then xp, and a missing reading sorts last rather than as zero", () => {
    const rows = characterRows([
      fp({ runId: "none", maxLevel: null, xp: null }),
      fp({ runId: "lo", maxLevel: 5, xp: 900 }),
      fp({ runId: "hi", maxLevel: 5, xp: 4000 }),
      fp({ runId: "zero", maxLevel: 5, xp: 0 }),
    ]);
    expect(rows.map((r) => r.characterId)).toEqual(["hi", "lo", "zero", "none"]);
  });

  /*
   * "exclude free" applies here exactly as it does on the scored tiers
   * (operator, 2026-08-29, reversing the same day's exemption). The page hands
   * `CharacterTable` and `CharacterChart` the same filtered set, so the two cannot
   * disagree; the filter itself is `filterRuns`, ahead of `characterRows`.
   */
  test("exclude free filters the field too, keeping the characters a viewer cannot answer for", () => {
    const runs = [
      fp({ runId: "paid", model: "sonnet", billing: "paid", maxLevel: 9, levels: [mark(9, 1, 1000)], playtimeMs: 1000 }),
      fp({
        runId: "gratis",
        model: "qwen/qwen3:free",
        billing: "free",
        maxLevel: 12,
        levels: [mark(12, 1, 1000)],
        playtimeMs: 1000,
      }),
      fp({ runId: "unknown", model: "old", maxLevel: 7, levels: [mark(7, 1, 1000)], playtimeMs: 1000 }),
    ];
    expect(characterRows(runs).map((r) => r.characterId)).toEqual(["gratis", "paid", "unknown"]);
    const kept = filterRuns(runs, { race: null, klass: null, harness: null, excludeFree: true });
    expect(characterRows(kept).map((r) => r.characterId)).toEqual(["paid", "unknown"]);
    // The chart reads the same filtered set, so it cannot show a dropped character.
    const chart = characterSeries(characterRows(kept), kept);
    expect(chart.series.map((s) => s.characterId)).toEqual(["paid", "unknown"]);
    expect(chart.omitted).toEqual([]);
  });

  test("a mixed-billing chain re-roots on its survivor — accepted, because billing follows the endpoint", () => {
    // A character is one character under one config, so this is not a shape the
    // fleet produces; pinned so the consequence is stated rather than accidental.
    const chain = [
      fp({ runId: "m1", billing: "free", maxLevel: 3, levels: [mark(3, 1, 1000)], playtimeMs: 1000 }),
      fp({
        runId: "m2",
        continuedFrom: "m1",
        billing: "paid",
        maxLevel: 6,
        startedAt: 200,
        levels: [mark(6, 1, 2000)],
        playtimeMs: 2000,
      }),
    ];
    expect(characterRows(chain)[0]!.attempts).toBe(2);
    const kept = filterRuns(chain, { race: null, klass: null, harness: null, excludeFree: true });
    expect(characterRows(kept).map((r) => ({ id: r.characterId, n: r.attempts }))).toEqual([
      { id: "m2", n: 1 },
    ]);
    // The chart says the same thing the table does: the survivor is drawn and
    // marked truncated, which is already the wording for "history before the
    // oldest attempt served is not drawn" — true whether the ancestor was
    // archived or filtered.
    const drawn = characterSeries(characterRows(kept), kept).series;
    expect(drawn.map((d) => [d.characterId, d.truncated])).toEqual([["m2", true]]);
  });
});

/* ---------------------------------------------------------------- scatter */

const fig = (usd: number | null, basis: "reported" | "list-price" | "none", asIfMetered = false) => ({
  usd,
  basis,
  asIfMetered,
  breakdown: null,
  priceId: null,
  asOf: null,
  note: "",
});

describe("runCostReading", () => {
  test("the provider's figure first, the list price only where there is none", () => {
    expect(runCostReading({ actualCost: fig(0.5, "reported"), expectedCost: fig(0.4, "list-price") })).toEqual({ usd: 0.5, basis: "reported", asIfMetered: false });
    expect(runCostReading({ actualCost: fig(null, "none"), expectedCost: fig(0, "list-price", true) })).toEqual({ usd: 0, basis: "list-price", asIfMetered: true });
    // A reported $0 (a free tier that reports) is a reading, not a blank.
    expect(runCostReading({ actualCost: fig(0, "reported"), expectedCost: fig(1, "list-price") })?.usd).toBe(0);
    expect(runCostReading({ actualCost: null, expectedCost: null })).toBeNull();
    // A viewer that predates `expectedCost`.
    expect(runCostReading({ actualCost: fig(null, "none") })).toBeNull();
  });
});

describe("xpEarnedOf", () => {
  test("the viewer's lower bound; without it, only a run still on L1 has a known total", () => {
    expect(xpEarnedOf({ xpEarned: 1234, maxLevel: 3, xp: 4 })).toBe(1234);
    expect(xpEarnedOf({ xpEarned: null, maxLevel: 1, xp: 40 })).toBeNull();
    expect(xpEarnedOf({ maxLevel: 1, xp: 40 })).toBe(40);
    expect(xpEarnedOf({ maxLevel: 3, xp: 40 })).toBeNull();
  });
});

describe("ladderPoints", () => {
  const priced = (p: Partial<ResultRun>): ResultRun =>
    run({ actualCost: fig(null, "none"), expectedCost: fig(0, "list-price", true), xpEarned: 100, ...p });

  test("one point per (model, effort), both coordinates means over the runs that carry both readings", () => {
    const { points, omitted } = ladderPoints([
      priced({ runId: "a", model: "sonnet", effort: "low", actualCost: fig(1, "reported"), xpEarned: 200 }),
      priced({ runId: "b", model: "sonnet", effort: "low", actualCost: fig(3, "reported"), xpEarned: null }),
      priced({ runId: "c", model: "sonnet", effort: null, actualCost: fig(5, "reported"), xpEarned: 50 }),
      priced({ runId: "d", model: "hy3-free", xpEarned: 30 }),
      priced({ runId: "e", model: "hy3-free", xpEarned: 10 }),
    ]);
    expect(omitted).toEqual([]);
    expect(points.map((p) => p.key)).toEqual(["hy3-free", "sonnet", "sonnet (low)"]);
    const low = points.find((p) => p.key === "sonnet (low)")!;
    // Run b has a price and no xp: it feeds neither mean. Pairing its $3 with
    // run a's xp would put the point nowhere a run was.
    expect(low.x).toBe(1);
    expect(low.y).toBe(200);
    expect(low.runs).toBe(2);
    expect(low.n).toBe(1);
    expect(low.basis).toBe("reported");
    // The label carries the sample size both means rest on — the runs with
    // both readings, not the larger of the two counts — and `single` flags it.
    expect(low.label).toBe("sonnet (low)");
    expect(low.single).toBe(true);
    const solo = points.find((p) => p.key === "sonnet")!;
    expect(solo.label).toBe("sonnet");
    expect(solo.single).toBe(true);
    const free = points.find((p) => p.key === "hy3-free")!;
    expect(free.x).toBe(0);
    expect(free.y).toBe(20);
    expect(free.basis).toBe("list-price");
    expect(free.asIfMetered).toBe(true);
    expect(free.label).toBe("hy3 (free)");
    expect(free.single).toBe(false);
  });

  test("a mixed basis is named, an unpriced or unmeasured entry is omitted and said, unscored runs never enter", () => {
    const { points, omitted } = ladderPoints([
      priced({ runId: "a", model: "m", actualCost: fig(1, "reported") }),
      priced({ runId: "b", model: "m" }),
      priced({ runId: "c", model: "nocost", actualCost: null, expectedCost: null }),
      priced({ runId: "d", model: "noxp", xpEarned: null }),
      priced({ runId: "e", model: "stub", unscored: "unscored (scripted stub)" }),
      // The live sonnet (low) shape: one run priced without xp, two with xp and no price.
      priced({ runId: "f", model: "split", actualCost: fig(1, "reported"), expectedCost: null, xpEarned: null }),
      priced({ runId: "g", model: "split", actualCost: null, expectedCost: null, xpEarned: 500 }),
      priced({ runId: "h", model: "split", actualCost: null, expectedCost: null, xpEarned: 700 }),
    ]);
    expect(points.map((p) => p.key)).toEqual(["m"]);
    expect(points[0]!.basis).toBe("mixed");
    expect(omitted).toEqual([
      { key: "nocost", label: "nocost", why: "no cost reading" },
      { key: "noxp", label: "noxp", why: "no xp reading" },
      { key: "split", label: "split", why: "no run with both cost and xp" },
    ]);
  });
});

describe("ladderPoints over another pair of axes", () => {
  const priced = (p: Partial<ResultRun>): ResultRun =>
    run({ actualCost: fig(null, "none"), expectedCost: fig(0, "list-price", true), xpEarned: 100, ...p });
  const tokens = (total: number, source: "reported" | "estimated" | "snapshot" = "reported"): ResultRun["tokens"] => ({
    source,
    contextTokens: 0,
    promptTokens: total - 10,
    completionTokens: 10,
    totalTokens: total,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    turns: 1,
  });

  test("the same pairing rule, the omission reasons worded from the axes, and an entry present on one view and omitted on another", () => {
    const runs = [
      // Counted tokens and xp: on both views.
      priced({ runId: "a", model: "counted", tokens: tokens(1000), xpEarned: 200 }),
      priced({ runId: "b", model: "counted", tokens: tokens(3000), xpEarned: 400 }),
      // Priced, with xp, but its tokens are a chars÷4 estimate: plotted on
      // cost × xp, omitted on tokens × xp — an estimate is not a reading.
      priced({ runId: "c", model: "guessed", tokens: tokens(5000, "estimated"), actualCost: fig(2, "reported") }),
      // Counted tokens on one run and xp on another: the pairing rule is the
      // same one cost × xp applies, and the reason names the axes in view.
      priced({ runId: "d", model: "split", tokens: tokens(700), xpEarned: null }),
      priced({ runId: "e", model: "split", tokens: null, xpEarned: 300 }),
      // Tokens, no xp at all.
      priced({ runId: "f", model: "noxp", tokens: tokens(700), xpEarned: null }),
    ];
    const byTokens = ladderPoints(runs, TOKENS, XP);
    expect(byTokens.points.map((p) => p.key)).toEqual(["counted"]);
    const counted = byTokens.points[0]!;
    expect(counted.x).toBe(2000);
    expect(counted.y).toBe(300);
    expect(counted.n).toBe(2);
    // The bag: means over the same two runs, cost included (both list-priced $0).
    expect(counted.metrics.tokens).toBe(2000);
    expect(counted.metrics.cost).toBe(0);
    expect(counted.metrics.turns).toBe(1);
    expect(counted.basis).toBe("list-price");
    expect(byTokens.omitted).toEqual([
      { key: "guessed", label: "guessed", why: "no tokens reading" },
      { key: "noxp", label: "noxp", why: "no xp reading" },
      { key: "split", label: "split", why: "no run with both tokens and xp" },
    ]);
    // The default view still plots the estimated-token entry, priced as reported.
    const byCost = ladderPoints(runs);
    expect(byCost.points.map((p) => p.key)).toEqual(["counted", "guessed", "split"]);
    expect(byCost.points.find((p) => p.key === "guessed")!.basis).toBe("reported");
    expect(byCost.omitted.map((o) => o.why)).toEqual(["no xp reading"]);
  });

  test("a snapshot-read token total is not a reading either; turns and level are", () => {
    const m = runMetrics(priced({ tokens: tokens(9000, "snapshot"), modelResponses: 42, levels: [mark(3, 1, 1000)] }));
    expect(m.tokens).toBeNull();
    expect(m.tokensOut).toBeNull();
    expect(m.turns).toBe(42);
    expect(m.level).toBe(3);
    expect(m.cost).toBe(0);
    expect(m.xp).toBe(100);
  });

  test("basis is null only when no counted run carries a price, which a cost axis never plots", () => {
    const runs = [priced({ runId: "a", model: "m", actualCost: null, expectedCost: null, modelResponses: 10, xpEarned: 50 })];
    expect(ladderPoints(runs, TURNS, XP).points[0]!.basis).toBeNull();
    expect(ladderPoints(runs).omitted[0]!.why).toBe("no cost reading");
  });

  test("the layout takes the x spec's scale: linear ticks from zero, no gutter, no minor lines", () => {
    const box = { x0: 60, x1: 960, y0: 340, y1: 20 };
    const point = (key: string, turns: number, level: number): LadderPoint => ({
      key, label: key, single: false, model: key, effort: null, x: turns, y: level, metrics: bag({ turns, level }), runs: 2, n: 2, basis: null, asIfMetered: false, harnesses: ["wrathbench"],
    });
    const l = ladderChartLayout([point("a", 120, 4), point("b", 430, 6)], box, TURNS, LEVEL);
    expect(l.xScale).toBe("linear");
    expect(l.xTicks).toEqual([0, 100, 200, 300, 400, 500]);
    expect(l.xMinorTicks).toEqual([]);
    expect(l.hasFree).toBe(false);
    expect(l.axisX0).toBe(box.x0);
    expect(l.px(0)).toBe(box.x0);
    expect(l.px(500)).toBe(box.x1);
    expect(l.yTicks).toEqual([0, 2, 4, 6]);
    // The default is the log cost axis, exactly as before.
    expect(ladderChartLayout([point("a", 1, 4)], box).xScale).toBe("log-cost");
  });

  test("the pareto front follows the axes, and the default still reads lower cost, higher xp", () => {
    const runs = [
      priced({ runId: "a", model: "cheap-slow", actualCost: fig(1, "reported"), modelResponses: 400, xpEarned: 300 }),
      priced({ runId: "b", model: "dear-quick", actualCost: fig(5, "reported"), modelResponses: 50, xpEarned: 300 }),
      priced({ runId: "c", model: "worst", actualCost: fig(6, "reported"), modelResponses: 500, xpEarned: 100 }),
    ];
    const frontOn = (x = DEFAULT_VIEW.x, y = DEFAULT_VIEW.y) =>
      paretoSteps(ladderPoints(runs, x, y).points, { x: x.better, y: y.better }).front.map((p) => p.model);
    expect(frontOn()).toEqual(["cheap-slow"]);
    expect(frontOn(TURNS, XP)).toEqual(["dear-quick"]);
  });

  test("the views: default first, each x a resource and each y a distance, and `?view=` resolves or falls back", () => {
    expect(DEFAULT_VIEW.id).toBe("cost-xp");
    expect(LADDER_VIEWS.map((v) => v.id)).toEqual(["cost-xp", "tokens-xp", "turns-xp", "calls-xp"]);
    for (const v of LADDER_VIEWS) {
      expect(v.x.better).toBe("lower");
      expect(v.y.better).toBe("higher");
      expect(v.title).toBe(`${v.x.label} × ${v.y.label}`);
    }
    expect(viewParam("turns-xp").id).toBe("turns-xp");
    expect(viewParam(["calls-xp", "turns-xp"]).id).toBe("calls-xp");
    expect(viewParam("playtime-level")).toBe(DEFAULT_VIEW);
    // The withdrawn cost × level view: an old link lands on the default, not a blank chart.
    expect(viewParam("cost-level")).toBe(DEFAULT_VIEW);
    expect(viewParam(undefined)).toBe(DEFAULT_VIEW);
    // Cost is the one log axis; the format that used to be `fmtCostTick` is its own.
    expect(LADDER_VIEWS.filter((v) => v.x.scale === "log-cost").map((v) => v.id)).toEqual(["cost-xp"]);
    // Level is no view's axis but is still a spec: the hover's "also" line reads it.
    expect(LEVEL.format(0)).toBe("0");
    expect(LEVEL.format(5)).toBe("L5");
    expect(XP.format(2000)).toBe("2k");
    expect(TOKENS.format(1_500_000)).toBe("1.5M");
    expect(TOKENS.format(20_000_000)).toBe("20M");
    expect(TOKENS.format(800_000)).toBe("800k");
  });
});

describe("ladderChartLayout", () => {
  const box = { x0: 60, x1: 960, y0: 340, y1: 20 };
  // The drawn label is the key alone (`pointLabel`), so the fixture's is too.
  const pt = (key: string, x: number, y: number): LadderPoint => ({
    key, label: key, single: true, model: key, effort: null, x, y, metrics: bag({ cost: x, xp: y }), runs: 1, n: 1, basis: "reported", asIfMetered: false, harnesses: ["wrathbench"],
  });

  test("a free entry sits in the gutter, the dearest point at the ceiling on the right edge", () => {
    const l = ladderChartLayout([pt("free", 0, 0), pt("paid", 10, 2500)], box);
    const free = l.placed.find((d) => d.point.key === "free")!;
    expect(l.hasFree).toBe(true);
    expect(free.cx).toBe(l.freeX);
    expect(free.cy).toBe(box.y0);
    expect(l.xMax).toBe(10);
    expect(l.yMax).toBe(2500);
    const paid = l.placed.find((d) => d.point.key === "paid")!;
    expect(paid.cx).toBeCloseTo(box.x1, 9);
    expect(paid.cy).toBe(box.y1);
  });

  test("the layout carries the cost axis the ticks are drawn against", () => {
    const l = ladderChartLayout([pt("cheap", 0.4, 100), pt("dear", 60, 2000)], box);
    expect(l.hasFree).toBe(false);
    expect(l.axisX0).toBe(box.x0);
    expect(l.xTicks).toEqual([0.01, 0.1, 1, 10, 100]);
    expect(l.xMinorTicks.every((t) => t < l.xMax)).toBe(true);
  });

  test("labels of coincident points do not share a slot", () => {
    const l = ladderChartLayout([pt("one", 1, 100), pt("two", 1, 100), pt("three", 1, 100), pt("far", 2, 200)], box);
    const slots = new Set(l.placed.map((d) => `${d.anchor}:${d.labelY.toFixed(1)}`));
    expect(slots.size).toBe(4);
  });

  test("every label clears every mark, its own included, and its box covers its descenders", () => {
    const l = ladderChartLayout([pt("one", 1, 100), pt("two", 4, 1200), pt("three", 6, 2000)], box);
    for (const d of l.placed) {
      // Against the mark's outer ring, bounding-boxed, not the puck: a thicker
      // separation ring has to move the labels too, and this is the test that says so.
      for (const other of l.placed) expect(rectsOverlap(d.rect, puckRect(other.cx, other.cy))).toBe(false);
      // The baseline sits a descender above the box's bottom edge.
      expect(d.rect.b - d.labelY).toBeCloseTo(LABEL_DESC, 9);
      expect(d.rect.t).toBeLessThan(d.labelY);
    }
  });

  /*
   * The placement's contract, on the fixture that used to break it: a dozen
   * entries inside a small cost/xp box — the crowded cheap-and-low corner every
   * roster has — plus outliers. Before the rings and the leaders the losers of
   * such a cluster all fell back to the same slot and printed over each other.
   */
  const cluster = (): ReturnType<typeof pt>[] => {
    const dense: ReturnType<typeof pt>[] = [];
    // Twelve names of realistic length on a 4×3 grid over a sixth of a decade
    // of cost and an eighth of the xp axis — about 40 by 40 viewBox units for
    // labels 40–80 wide. Dense enough that half of them need a ring past the
    // first and some reach the fifth; sparse enough that the greedy pass finds
    // a clean answer, which is what makes the strict assertions below fair.
    // A tighter grid is solvable only with crossing leaders or `crowded`
    // labels, both of which are tolerated on purpose and pinned separately.
    for (let i = 0; i < 12; i++) {
      dense.push(pt(`model-${String.fromCharCode(97 + i)}${i % 3 === 0 ? " (low)" : ""}`, 1 + (i % 4) * 0.15, 100 + Math.floor(i / 4) * 120 + (i % 4) * 12));
    }
    return [...dense, pt("dear-and-far", 40, 2400), pt("mid-outlier", 6, 1300), pt("cheap-outlier", 0.05, 700), pt("free-corner", 0, 0)];
  };

  test("a dense cluster: no label over a label or a mark, leaders only past ring 1, none crossing, all inside", () => {
    const l = ladderChartLayout(cluster(), box);
    const clear = l.placed.filter((d) => !d.crowded);
    // Every entry got a label, and the fixture is solvable without a crowded one.
    expect(l.placed).toHaveLength(16);
    expect(clear).toHaveLength(16);
    for (const d of clear) {
      for (const o of l.placed) {
        expect(rectsOverlap(d.rect, puckRect(o.cx, o.cy))).toBe(false);
        if (o !== d) expect(rectsOverlap(d.rect, o.rect)).toBe(false);
      }
      // Inside the plot: the top margin may hold a label, the axis line may not.
      expect(d.rect.l).toBeGreaterThanOrEqual(box.x0 - 2);
      expect(d.rect.r).toBeLessThanOrEqual(box.x1 + 2);
      expect(d.rect.b).toBeLessThanOrEqual(box.y0);
      expect(d.rect.t).toBeGreaterThanOrEqual(box.y1 - LABEL_ROW);
      // A leader exactly when the label is not adjacent.
      expect(d.leader !== null).toBe(d.ring > 1);
      if (d.leader !== null) {
        // From the ring's edge…
        expect(Math.hypot(d.leader.x1 - d.cx, d.leader.y1 - d.cy)).toBeCloseTo(MARK_RING_R, 6);
        // …to just outside the label's box.
        expect(rectsOverlap({ l: d.leader.x2, t: d.leader.y2, r: d.leader.x2, b: d.leader.y2 }, d.rect)).toBe(false);
        expect(Math.hypot(d.leader.x2 - d.cx, d.leader.y2 - d.cy)).toBeGreaterThan(MARK_RING_R);
      }
    }
    // The cluster actually exercised the rings, the outermost included.
    expect(l.placed.filter((d) => d.ring > 1).length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...l.placed.map((d) => d.ring))).toBe(5);
    const leaders = clear.flatMap((d) => (d.leader === null ? [] : [d.leader]));
    for (let i = 0; i < leaders.length; i++) {
      for (let j = i + 1; j < leaders.length; j++) expect(segmentsCross(leaders[i]!, leaders[j]!)).toBe(false);
    }
  });

  test("the placement is a function of the set, not of the order the entries arrived in", () => {
    const base = cluster();
    const strip = (l: ReturnType<typeof ladderChartLayout>) =>
      l.placed.map((d) => ({ key: d.point.key, x: d.labelX, y: d.labelY, a: d.anchor, ring: d.ring, leader: d.leader, crowded: d.crowded }));
    const reference = strip(ladderChartLayout(base, box));
    const permutations = [
      [...base].reverse(),
      [...base].sort((a, b) => a.key.localeCompare(b.key)),
      [...base.slice(7), ...base.slice(0, 7)],
    ];
    for (const perm of permutations) expect(strip(ladderChartLayout(perm, box))).toEqual(reference);
    // Two entries with identical coordinates and labels of equal length are
    // still ordered — by label, then key — so even they cannot swap slots.
    const twins = [pt("twin-b", 2, 500), pt("twin-a", 2, 500)];
    expect(strip(ladderChartLayout(twins, box))).toEqual(strip(ladderChartLayout([...twins].reverse(), box)));
    expect(strip(ladderChartLayout(twins, box))[0]!.key).toBe("twin-a");
  });

  test("golden: an outlier's label sits centred above its mark, adjacent, with no leader", () => {
    const l = ladderChartLayout(cluster(), box);
    for (const key of ["mid-outlier", "cheap-outlier"]) {
      const d = l.placed.find((p) => p.point.key === key)!;
      expect(d.anchor).toBe("middle");
      expect(d.labelX).toBe(d.cx);
      expect(d.labelY).toBeLessThan(d.cy - MARK_RING_R);
      expect(d.ring).toBe(1);
      expect(d.leader).toBeNull();
      expect(d.crowded).toBe(false);
    }
    // The dearest, highest point is near the plot's top-right corner: a label
    // may rise into the top margin by its own height, so above still fits.
    const corner = l.placed.find((p) => p.point.key === "dear-and-far")!;
    expect(corner.ring).toBe(1);
    expect(corner.anchor).toBe("middle");
    expect(corner.rect.t).toBeLessThan(box.y1);
    expect(corner.leader).toBeNull();
  });

  test("when every slot collides the least-overlapping one is taken and flagged, never dropped", () => {
    // Forty entries on one spot: no arrangement of twenty-four slots holds them.
    const pile = Array.from({ length: 40 }, (_, i) => pt(`pile-${String(i).padStart(2, "0")}`, 1, 100));
    const l = ladderChartLayout(pile, box);
    expect(l.placed).toHaveLength(40);
    const crowded = l.placed.filter((d) => d.crowded);
    expect(crowded.length).toBeGreaterThan(0);
    for (const d of crowded) {
      // Honest flag: a crowded label really does overlap something…
      const hits = l.placed.filter((o) => o !== d && (rectsOverlap(d.rect, o.rect) || rectsOverlap(d.rect, puckRect(o.cx, o.cy))));
      expect(hits.length).toBeGreaterThan(0);
      // …carries a leader whatever its ring, and stayed in the box.
      expect(d.leader).not.toBeNull();
      expect(d.rect.b).toBeLessThanOrEqual(box.y0);
    }
    // …and a label that was not flagged overlaps no mark and no other clean
    // label — a crowded one placed after it may land on it, which is what the
    // flag on that one records.
    const clean = l.placed.filter((p) => !p.crowded);
    for (const d of clean) {
      for (const o of l.placed) expect(rectsOverlap(d.rect, puckRect(o.cx, o.cy))).toBe(false);
      for (const o of clean) if (o !== d) expect(rectsOverlap(d.rect, o.rect)).toBe(false);
    }
  });

  test("a label at the plot's right edge is anchored to its left", () => {
    const l = ladderChartLayout([pt("a-fairly-long-model-name", 8, 2500), pt("other", 0, 0)], box);
    expect(l.placed.find((d) => d.point.key.startsWith("a-fairly"))!.anchor).toBe("end");
  });

  test("the corner cue: top-left on every offered view, read off the specs, and it would move with them", () => {
    for (const v of LADDER_VIEWS) {
      expect(betterCorner({ x: v.x.better, y: v.y.better })).toEqual({ h: "left", v: "top", arrow: "↖" });
      const l = ladderChartLayout([pt("a", 1, 100)], box, v.x, v.y);
      expect(l.cue.text).toBe("↖ better");
      expect(l.cue.anchor).toBe("start");
      expect(l.cue.rect.l).toBe(box.x0 + CUE_PAD);
      expect(l.cue.rect.t).toBe(box.y1 + CUE_PAD);
    }
    expect(betterCorner({ x: "higher", y: "lower" })).toEqual({ h: "right", v: "bottom", arrow: "↘" });
    expect(betterCorner({ x: "higher", y: "higher" }).arrow).toBe("↗");
    expect(betterCorner({ x: "lower", y: "lower" }).arrow).toBe("↙");
    const flipped = chartCue(box, { x: "higher", y: "lower" }, []);
    expect(flipped.text).toBe("↘ better");
    expect(flipped.anchor).toBe("end");
    expect(flipped.rect.r).toBe(box.x1 - CUE_PAD);
    expect(flipped.rect.b).toBe(box.y0 - CUE_PAD);
  });

  test("the cue is an obstacle to labels and gives way to marks", () => {
    // The cheapest, furthest entry sits exactly in the better corner, with a
    // neighbour whose above-centre label would land on the cue's row.
    const l = ladderChartLayout([pt("corner", 0.01, 2500), pt("near", 0.02, 2300), pt("far", 5, 100)], box);
    const corner = l.placed.find((d) => d.point.key === "corner")!;
    expect(corner.cx).toBe(box.x0);
    expect(corner.cy).toBe(box.y1);
    // The cue slid right past the mark rather than sitting under it…
    expect(rectsOverlap(l.cue.rect, puckRect(corner.cx, corner.cy))).toBe(false);
    expect(l.cue.rect.l).toBeGreaterThan(box.x0 + CUE_PAD);
    for (const d of l.placed) {
      // …and no label prints over the cue.
      expect(rectsOverlap(d.rect, l.cue.rect)).toBe(false);
    }
  });
});

describe("costScale", () => {
  const [x0, x1] = [60, 960];

  test("the ceiling is the smallest decade at or above the dearest entry, never under $10", () => {
    expect(costScale([0.004], x0, x1).ceiling).toBe(COST_CEILING_MIN);
    expect(costScale([], x0, x1).ceiling).toBe(COST_CEILING_MIN);
    expect(costScale([0], x0, x1).ceiling).toBe(COST_CEILING_MIN);
    expect(costScale([8], x0, x1).ceiling).toBe(10);
    // The exact decades: a point at $10 or $100 lands on the right edge rather
    // than opening a whole empty decade above itself.
    expect(costScale([1], x0, x1).ceiling).toBe(10);
    expect(costScale([10], x0, x1).ceiling).toBe(10);
    expect(costScale([60], x0, x1).ceiling).toBe(100);
    expect(costScale([100], x0, x1).ceiling).toBe(100);
    expect(costScale([101], x0, x1).ceiling).toBe(1000);
  });

  test("anything positive under a cent is clamped onto the floor, not dropped", () => {
    const s = costScale([0.0004, 60], x0, x1);
    expect(s.floor).toBe(COST_FLOOR);
    expect(s.px(0.0004)).toBe(s.px(COST_FLOOR));
    expect(s.px(COST_FLOOR)).toBe(s.axisX0);
    // And the ceiling clamps the other way.
    expect(s.px(1e6)).toBeCloseTo(x1, 9);
  });

  test("decades are evenly spaced and the map rises with cost", () => {
    const s = costScale([60], x0, x1);
    expect(s.ticks).toEqual([0.01, 0.1, 1, 10, 100]);
    const step = s.px(0.1) - s.px(0.01);
    expect(s.px(1) - s.px(0.1)).toBeCloseTo(step, 9);
    expect(s.px(100) - s.px(10)).toBeCloseTo(step, 9);
    for (const [a, b] of [[0.02, 0.05], [0.5, 2], [9, 11]] as const) expect(s.px(a)).toBeLessThan(s.px(b));
  });

  test("minor lines are the 2x and 5x inside the axis, and stop below the ceiling", () => {
    const s = costScale([8], x0, x1);
    expect(s.ticks).toEqual([0.01, 0.1, 1, 10]);
    expect(s.minorTicks).toEqual([0.02, 0.05, 0.2, 0.5, 2, 5]);
  });

  test("the free gutter exists only when something cost nothing, and holds the zeroes", () => {
    const none = costScale([0.5, 60], x0, x1);
    expect(none.hasFree).toBe(false);
    expect(none.axisX0).toBe(x0);
    expect(none.px(0)).toBe(x0);

    const some = costScale([0, 60], x0, x1);
    expect(some.hasFree).toBe(true);
    expect(some.axisX0).toBe(x0 + FREE_GUTTER_W);
    expect(some.px(0)).toBe(some.freeX);
    // The gutter is left of the axis, with the divider between the two.
    expect(some.freeX).toBeLessThan(some.dividerX);
    expect(some.dividerX).toBeLessThan(some.axisX0);
    // A free entry is never interpolated against the decades.
    expect(some.px(0)).toBeLessThan(some.px(COST_FLOOR));
  });
});

describe("fmtCostTick", () => {
  test("cents below a dollar, dollars at and above one", () => {
    expect([0.01, 0.1, 1, 10, 100].map(fmtCostTick)).toEqual(["1\u00a2", "10\u00a2", "$1", "$10", "$100"]);
  });
});

/**
 * The freeplay chart's series: one stepped line per character, stitched across its
 * attempts on a cumulative active-playtime axis.
 *
 * The rules worth pinning are the seams. A character is the point of the page, and
 * a character is many runs; every way of getting the stitch wrong shows up as a
 * plausible-looking line, so each of them gets a case.
 */
describe("timeTicks", () => {
  test("a duration axis steps in minutes and hours, never in decimal milliseconds", () => {
    // What `niceTicks` would do to 7h is a gridline every 1.39h: its 1/2/5×10^k
    // step is decimal, and time is not.
    const hour = 3_600_000;
    expect(timeTicks(7 * hour)).toEqual([0, 2 * hour, 4 * hour, 6 * hour, 8 * hour]);
    expect(timeTicks(50 * 60_000)).toEqual([0, 10, 20, 30, 40, 50].map((m) => m * 60_000));
    expect(timeTicks(0)).toEqual([0]);
    // Past the last named step, whole days.
    const day = 24 * hour;
    expect(timeTicks(5 * day)).toEqual([0, day, 2 * day, 3 * day, 4 * day, 5 * day]);
  });
});

describe("stitchCharacter", () => {
  const at = (runId: string, playtimeMs: number | null, marks: LevelMark[]) => ({ runId, playtimeMs, levels: marks });

  test("attempts lie end to end on one cumulative active-time axis", () => {
    const st = stitchCharacter([
      at("a1", 1000, [mark(2, null, 400)]),
      at("a2", 500, [mark(3, null, 100)]),
    ]);
    expect(st.broke).toBeNull();
    expect(st.points.map((p) => [p.level, p.x])).toEqual([
      [2, 400],
      [3, 1100],
    ]);
    expect(st.endX).toBe(1500);
  });

  test("a seam is not a ding: the level the character already held draws nothing", () => {
    const st = stitchCharacter([at("a1", 1000, [mark(5, null, 300)]), at("a2", 400, [mark(5, null, 10), mark(6, null, 200)])]);
    expect(st.points.map((p) => p.level)).toEqual([5, 6]);
  });

  test("a prior attempt with no active time breaks the stitch rather than compressing the axis", () => {
    const st = stitchCharacter([at("a1", null, []), at("a2", 400, [mark(3, null, 100)])]);
    expect(st.broke).toBe("attempt 1 of 2 recorded no active time");
  });

  test("the LAST attempt with no span just ends the line at what its marks prove", () => {
    const st = stitchCharacter([at("a1", 1000, []), at("a2", null, [mark(4, null, 250)])]);
    expect(st.broke).toBeNull();
    expect(st.endX).toBe(1250);
  });
});

describe("characterSeries", () => {
  const fp = (over: Partial<ResultRun> = {}): ResultRun =>
    run({ unscored: "unscored (episode freeplay)", episode: "freeplay", ...over });
  const seriesOf = (runs: readonly ResultRun[]): ReturnType<typeof characterSeries> =>
    characterSeries(characterRows(runs), runs);

  test("a nameless character is labelled by the short model and its effort, never the raw slug", () => {
    const { series } = seriesOf([
      fp({
        runId: "n1",
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        effort: "low",
        character: null,
        levels: [mark(1, null, 0), mark(2, null, 600_000)],
        playtimeMs: 1_000_000,
      }),
    ]);
    expect(series[0]!.label).toBe("nemotron-3-ultra-550b-a55b (free) (low)");
    // The full slug stays on the series, which is what the logo keys on.
    expect(series[0]!.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  test("a three-attempt chain draws one line, each attempt offset by the last one's playtime", () => {
    const runs = [
      fp({ runId: "a1", levels: [mark(1, null, 0), mark(2, null, 600_000)], playtimeMs: 1_000_000 }),
      fp({
        runId: "a2",
        continuedFrom: "a1",
        startedAt: 200,
        levels: [mark(2, null, 0), mark(3, null, 300_000)],
        playtimeMs: 500_000,
      }),
      fp({
        runId: "a3",
        continuedFrom: "a2",
        startedAt: 300,
        levels: [mark(3, null, 0), mark(4, null, 100_000)],
        playtimeMs: 400_000,
      }),
    ];
    const { series, omitted } = seriesOf(runs);
    expect(omitted).toEqual([]);
    expect(series).toHaveLength(1);
    const s = series[0]!;
    expect(s.attempts).toBe(3);
    expect(s.latestRunId).toBe("a3");
    // L1 and L2 on a1, L3 300s into a2 (offset 1_000_000), L4 100s into a3
    // (offset 1_500_000). Nothing is placed at a seam-relative zero.
    expect(s.points.map((p) => [p.level, p.x])).toEqual([
      [1, 0],
      [2, 600_000],
      [3, 1_300_000],
      [4, 1_600_000],
    ]);
    // The line runs on to the character's total active time, not to its last ding.
    expect(s.endX).toBe(1_900_000);
    expect(s.endLevel).toBe(4);
  });

  test("a seam at an unchanged level draws no step — the first mark of an attempt is not a gain", () => {
    const runs = [
      fp({ runId: "b1", levels: [mark(5, null, 0)], playtimeMs: 100_000 }),
      fp({ runId: "b2", continuedFrom: "b1", startedAt: 200, levels: [mark(5, null, 0)], playtimeMs: 100_000 }),
      fp({ runId: "b3", continuedFrom: "b2", startedAt: 300, levels: [mark(5, null, 0)], playtimeMs: 100_000 }),
    ];
    const s = seriesOf(runs).series[0]!;
    expect(s.attempts).toBe(3);
    // One point, not three: two phantom rises would otherwise be drawn at L5.
    expect(s.points.map((p) => p.level)).toEqual([5]);
    expect(s.endX).toBe(300_000);
  });

  test("a level gained in the unobserved gap steps at the seam", () => {
    const runs = [
      fp({ runId: "c1", levels: [mark(4, null, 0)], playtimeMs: 100_000 }),
      // The character came back at 6: the ding happened between the attempts,
      // and the seam is the lower bound on when.
      fp({ runId: "c2", continuedFrom: "c1", startedAt: 200, levels: [mark(6, null, 0)], playtimeMs: 50_000 }),
    ];
    const s = seriesOf(runs).series[0]!;
    expect(s.points.map((p) => [p.level, p.x])).toEqual([
      [4, 0],
      [6, 100_000],
    ]);
  });

  test("a prior attempt with no active time omits the character rather than compressing the axis", () => {
    const runs = [
      fp({ runId: "d1", levels: [mark(3, null, null)], playtimeMs: null }),
      fp({ runId: "d2", continuedFrom: "d1", startedAt: 200, levels: [mark(4, null, 60_000)], playtimeMs: 90_000 }),
    ];
    const { series, omitted } = seriesOf(runs);
    expect(series).toEqual([]);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.why).toBe("attempt 1 of 2 recorded no active time");
  });

  test("a last attempt with no active time never pulls the line back behind the attempts before it", () => {
    const runs = [
      fp({ runId: "p1", levels: [mark(3, null, 60_000)], playtimeMs: 100_000 }),
      // No playtime and no placeable mark: the line must still run to the
      // 100_000 the first attempt proves, not back to the 60_000 mark.
      fp({ runId: "p2", continuedFrom: "p1", startedAt: 200, levels: [], playtimeMs: null }),
    ];
    expect(seriesOf(runs).series[0]!.endX).toBe(100_000);
  });

  test("an attempt with no total falls back to what its marks prove it played", () => {
    const runs = [
      // `playtimeMs` never landed, but a mark at 90s did: the successor's
      // offset is that lower bound, not zero and not an omission.
      fp({ runId: "q1", levels: [mark(2, null, 90_000)], playtimeMs: null }),
      fp({ runId: "q2", continuedFrom: "q1", startedAt: 200, levels: [mark(3, null, 10_000)], playtimeMs: 20_000 }),
    ];
    const s = seriesOf(runs).series[0]!;
    expect(s.points.map((p) => [p.level, p.x])).toEqual([
      [2, 90_000],
      [3, 100_000],
    ]);
    expect(s.endX).toBe(110_000);
  });

  test("the LAST attempt with no active time simply ends at its last mark", () => {
    const runs = [
      fp({ runId: "e1", levels: [mark(3, null, 0), mark(4, null, 120_000)], playtimeMs: null }),
    ];
    const s = seriesOf(runs).series[0]!;
    // No `playtimeMs` on the run, so the marks are the only evidence of time:
    // the line stops where the last one proves it got to.
    expect(s.endX).toBe(120_000);
    expect(s.endLevel).toBe(4);
  });

  test("a continuedFrom outside the set is a root, and says its history is truncated", () => {
    const runs = [fp({ runId: "f2", continuedFrom: "f1", levels: [mark(9, null, 0)], playtimeMs: 60_000 })];
    const s = seriesOf(runs).series[0]!;
    expect(s.attempts).toBe(1);
    expect(s.truncated).toBe(true);
    expect(s.points.map((p) => p.level)).toEqual([9]);
  });

  test("a live character's line ends at the run's own total, which the viewer computes against now", () => {
    const runs = [
      fp({ runId: "g1", live: true, levels: [mark(2, null, 10_000)], playtimeMs: 900_000 }),
    ];
    const s = seriesOf(runs).series[0]!;
    expect(s.status).toBe("live");
    expect(s.endX).toBe(900_000);
  });

  test("a character with no placeable mark is omitted with its reason, never drawn flat at zero", () => {
    // Two different nothings, and the caption says which.
    expect(seriesOf([fp({ runId: "h1", levels: [], playtimeMs: 60_000 })]).omitted[0]!.why).toBe(
      "no level recorded yet",
    );
    const unplaceable = seriesOf([fp({ runId: "h2", levels: [mark(3, null, null)], playtimeMs: 60_000 })]);
    expect(unplaceable.series).toEqual([]);
    expect(unplaceable.omitted[0]!.why).toBe("no level mark carries an active-time reading");
  });

  test("a repeated character name is disambiguated by its start date; a unique one is left alone", () => {
    const runs = [
      fp({ runId: "n1", character: "Qwenlocal", startedAt: Date.UTC(2026, 7, 23), levels: [mark(3, null, 0)], playtimeMs: 60_000 }),
      fp({ runId: "n2", character: "Qwenlocal", startedAt: Date.UTC(2026, 7, 24), levels: [mark(2, null, 0)], playtimeMs: 60_000 }),
      fp({ runId: "n3", character: "Alone", startedAt: Date.UTC(2026, 7, 25), levels: [mark(1, null, 0)], playtimeMs: 60_000 }),
    ];
    expect(seriesOf(runs).series.map((s) => s.label)).toEqual([
      "Qwenlocal 2026-08-23",
      "Qwenlocal 2026-08-24",
      "Alone",
    ]);
  });

  test("a viewer that predates continuedFrom does not report every character as truncated", () => {
    // The field is absent, not null, off an older viewer — and `undefined !==
    // null` would have marked the whole fleet as missing history.
    const older = fp({ runId: "m1", levels: [mark(3, null, 0)], playtimeMs: 60_000 });
    delete (older as { continuedFrom?: string | null }).continuedFrom;
    expect(seriesOf([older]).series[0]!.truncated).toBe(false);
  });

  test("series are ordered furthest first, and the layout keeps their end labels apart", () => {
    const runs = [
      fp({ runId: "i1", character: "Low", levels: [mark(2, null, 0)], playtimeMs: 100_000 }),
      fp({ runId: "j1", character: "High", levels: [mark(2, null, 0), mark(8, null, 50_000)], playtimeMs: 200_000 }),
      fp({ runId: "k1", character: "Same", levels: [mark(2, null, 0)], playtimeMs: 100_000 }),
    ];
    const { series } = seriesOf(runs);
    expect(series.map((s) => s.label)).toEqual(["High", "Low", "Same"]);
    const box = { x0: 50, x1: 900, y0: 340, y1: 16 };
    const layout = characterChartLayout(series, box);
    expect(layout.xMax).toBe(200_000);
    expect(layout.yMax).toBeGreaterThanOrEqual(8);
    // Two characters sitting at the same level still get two readable labels.
    const [low, same] = [layout.placed[1]!, layout.placed[2]!];
    expect(low.endCy).toBe(same.endCy);
    expect(Math.abs(low.labelY - same.labelY)).toBeGreaterThanOrEqual(12);
    // A step, not a slope: the path only ever moves horizontally then vertically.
    expect(layout.placed[0]!.d).toMatch(/^M[\d.]+,[\d.]+ (H[\d.]+ V[\d.]+ )*H[\d.]+$/);
    // The y axis is anchored at zero, so a two-level gain is not the whole chart.
    expect(layout.py(0)).toBe(box.y0);
  });

  test("a character label pushed more than one row off its line gets a leader from the badge; one row does not", () => {
    // Five characters holding the same level at the same time: the stack is five rows deep.
    const runs = ["Ann", "Bob", "Cyd", "Dee", "Eve"].map((c, i) =>
      fp({ runId: `${c}1`, character: c, levels: [mark(4, null, 0)], playtimeMs: 100_000 + i }),
    );
    const box = { x0: 50, x1: 900, y0: 340, y1: 16 };
    const { series } = seriesOf(runs);
    const layout = characterChartLayout(series, box);
    const rows = layout.placed.map((p) => Math.round((p.labelY - layout.placed[0]!.labelY) / LABEL_ROW));
    expect(rows).toEqual([0, 1, 2, 3, 4]);
    expect(layout.placed.map((p) => p.leader === null)).toEqual([true, true, false, false, false]);
    for (const p of layout.placed) {
      expect(p.labelX).toBe(characterLabelX(p.endCx));
      expect(p.labelY + LABEL_DESC).toBeLessThanOrEqual(box.y0);
      if (p.leader !== null) {
        expect(p.leader.y1).toBe(p.endCy);
        expect(p.leader.x2).toBeLessThan(p.labelX);
        expect(p.leader.y2).toBeGreaterThan(p.endCy);
      }
    }
    // The stack is a function of the set: a reversed input places identically.
    const again = characterChartLayout([...series].reverse(), box);
    expect(again.placed.map((p) => [p.series.characterId, p.labelY])).toEqual(layout.placed.map((p) => [p.series.characterId, p.labelY]));
  });

  test("the field's cue is top-left, gives way to a badge, and a label that would reach it is pushed a row down", () => {
    // A character at the top tick with next to no playtime: its badge sits in
    // the corner and its label starts a badge past the axis.
    const box = { x0: 50, x1: 900, y0: 340, y1: 16 };
    const early = seriesOf([
      fp({ runId: "e1", character: "Early", levels: [mark(8, null, 0)], playtimeMs: 1 }),
      fp({ runId: "l1", character: "Late", levels: [mark(4, null, 0)], playtimeMs: 200_000 }),
    ]).series;
    const l = characterChartLayout(early, box);
    expect(l.cue.text).toBe("↖ better");
    expect(l.cue.anchor).toBe("start");
    expect(l.cue.rect.t).toBe(box.y1 + CUE_PAD);
    const top = l.placed.find((p) => p.series.label === "Early")!;
    expect(top.endCy).toBe(box.y1);
    // The cue stepped right past the badge on the line's end rather than sitting under it.
    expect(l.cue.rect.l).toBeGreaterThan(box.x0 + CUE_PAD);
    expect(rectsOverlap(l.cue.rect, puckRect(characterIconCx(top.endCx), top.endCy))).toBe(false);
    // The top character's label sits on its line — its box ends where the cue's begins, and touching is not overlapping.
    expect(top.labelY).toBeCloseTo(top.endCy + 3.5, 9);
    for (const p of l.placed) expect(rectsOverlap({ l: p.labelX, t: p.labelY - 10, r: p.labelX + 60, b: p.labelY + LABEL_DESC }, l.cue.rect)).toBe(false);
    // A line just under the top tick, on a short plot, puts its label's row
    // across the cue: the label is pushed down a row, as it would be for a
    // label already there. Level 9 alone ticks to 10, so it is a tenth down.
    // (The long character is what puts the short one in the corner: alone, its
    // own end would be the axis's ceiling. Its label sits rows away.)
    const short = { x0: 50, x1: 900, y0: 116, y1: 16 };
    const late = fp({ runId: "l1", character: "Late", levels: [mark(4, null, 0)], playtimeMs: 200_000 });
    const under = characterChartLayout(seriesOf([fp({ runId: "e1", character: "Early", levels: [mark(9, null, 0)], playtimeMs: 1 }), late]).series, short);
    const u = under.placed.find((p) => p.series.label === "Early")!;
    expect(u.endCy).toBe(26);
    // Two rows here, not one: a row down its box still reached into the cue's.
    expect(u.labelY).toBeCloseTo(u.endCy + 3.5 + 2 * LABEL_ROW, 9);
    expect(u.labelY - LABEL_H).toBeGreaterThanOrEqual(under.cue.rect.b);
    expect(rectsOverlap({ l: u.labelX, t: u.labelY - LABEL_H, r: u.labelX + 60, b: u.labelY + LABEL_DESC }, under.cue.rect)).toBe(false);
    // The same character further along the axis is nowhere near the cue and keeps its natural row.
    const far = characterChartLayout(seriesOf([fp({ runId: "e1", character: "Early", levels: [mark(9, null, 0)], playtimeMs: 150_000 }), late]).series, short);
    const f = far.placed.find((p) => p.series.label === "Early")!;
    expect(f.labelY).toBeCloseTo(f.endCy + 3.5, 9);
  });

  /*
   * The badge at each line's end (operator, 2026-08-29). `CharacterChart` draws it
   * from `series.model` through the same `familyOf` lookup `ModelIcon` and the
   * scored scatter use, so what is testable without a DOM is the pair the
   * component reads: one series per character, each carrying the model whose
   * family the badge is, and an id no family claims falling through to the
   * monogram rather than to a hole. The glob behind `logoHrefOf` is a Vite
   * feature, which is why the lookup and not the element is what is pinned —
   * `dashboard/README.md` says why the components have no DOM harness.
   */
  test("every series carries the model its badge is drawn from, one per character", () => {
    const runs = [
      fp({ runId: "s1", model: "anthropic/claude-sonnet-4-5", character: "Anvi", levels: [mark(9, null, 0)], playtimeMs: 100_000 }),
      fp({ runId: "s2", model: "z-ai/glm-5.2:free", character: "Bree", levels: [mark(7, null, 0)], playtimeMs: 100_000 }),
      fp({ runId: "s3", model: "stealth/ox-alpha", character: "Cass", levels: [mark(5, null, 0)], playtimeMs: 100_000 }),
    ];
    const { series } = seriesOf(runs);
    expect(series.map((x) => [x.label, x.model])).toEqual([
      ["Anvi", "anthropic/claude-sonnet-4-5"],
      ["Bree", "z-ai/glm-5.2:free"],
      ["Cass", "stealth/ox-alpha"],
    ]);
    // The logo each one resolves to — the `:free` suffix is stripped, not matched on.
    expect(series.map((x) => familyOf(x.model)?.id ?? null)).toEqual(["claude", "glm", null]);
    // …and the id nothing claims gets a letter instead, never an empty badge.
    expect(monogramOf(series[2]!.model)).not.toBe("");
    // One badge per character, not one per attempt: a chain is still a single series.
    const chained = seriesOf([
      fp({ runId: "c1", model: "openai/gpt-5.6-luna", character: "Dex", levels: [mark(3, null, 0)], playtimeMs: 100_000 }),
      fp({
        runId: "c2",
        continuedFrom: "c1",
        startedAt: 200,
        model: "openai/gpt-5.6-luna",
        character: "Dex",
        levels: [mark(4, null, 0)],
        playtimeMs: 100_000,
      }),
    ]).series;
    expect(chained.map((x) => familyOf(x.model)?.id)).toEqual(["openai"]);
  });
});

describe("a withheld pause reason is not printed back as a detail", () => {
  /*
   * The public projection replaces the free text with the fixed `paused`
   * token, and the row would otherwise read `paused (paused)`.
   */
  const fp = (p: Partial<ResultRun>): ResultRun =>
    run({ unscored: "unscored (episode freeplay)", episode: "freeplay", ...p });

  test("the opaque token leaves no detail; a real reason still shows", () => {
    const opaque = characterRows([fp({ runId: "a", pauseReason: OPAQUE_PAUSE_REASON })])[0]!;
    expect(opaque.status).toBe("paused");
    expect(opaque.statusDetail).toBeNull();

    const real = characterRows([fp({ runId: "b", pauseReason: "operator-pause" })])[0]!;
    expect(real.status).toBe("paused");
    expect(real.statusDetail).toBe("operator-pause");
  });
});
