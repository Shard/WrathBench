/**
 * The ladder derivation.
 *
 * What matters here is what the release page is allowed to claim: unscorable
 * runs never enter a row, and a rung nothing records reads as "not
 * instrumented" instead of being approximated.
 */

import { describe, expect, test } from "bun:test";
import type { AreaFacts, ResultRun, LevelMark } from "../../runner/viewer/api-types";
import {
  EXPANSION_MAPS,
  RUNGS,
  byCharacter,
  characterOptions,
  ladderChartLayout,
  ladderPoints,
  ladderRows,
  runCostReading,
  scored,
  xpEarnedOf,
} from "../src/lib/ladder";
import { EPISODE_CHOICES, episodeParam } from "../src/lib/episodes";

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
    ...p,
  };
}

describe("scored", () => {
  test("anything with a reason is out", () => {
    const rows = [run({ runId: "a" }), run({ runId: "b", unscored: "unscored (scripted stub)" })];
    expect(scored(rows).map((r) => r.runId)).toEqual(["a"]);
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

  test("a capital zone reaches rung 4; a zone that is not one does not", () => {
    const cap = ladderRows([run({ model: "cap", areas: areas({ capitalZone: 1519 }) })])[0]!;
    expect(cap.cells.find((c) => c.n === 4)!.status).toBe("reached");
    const not = ladderRows([run({ model: "field", areas: areas({ capitalZone: null }) })])[0]!;
    expect(not.cells.find((c) => c.n === 4)!.status).toBe("not-reached");
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

  test("one point per (model, effort), both coordinates means over the runs that carry them", () => {
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
    expect(low.x).toBe(2);
    expect(low.y).toBe(200);
    expect(low.runs).toBe(2);
    expect(low.costRuns).toBe(2);
    expect(low.xpRuns).toBe(1);
    expect(low.basis).toBe("reported");
    const free = points.find((p) => p.key === "hy3-free")!;
    expect(free.x).toBe(0);
    expect(free.y).toBe(20);
    expect(free.basis).toBe("list-price");
    expect(free.asIfMetered).toBe(true);
  });

  test("a mixed basis is named, an unpriced or unmeasured entry is omitted and said, unscored runs never enter", () => {
    const { points, omitted } = ladderPoints([
      priced({ runId: "a", model: "m", actualCost: fig(1, "reported") }),
      priced({ runId: "b", model: "m" }),
      priced({ runId: "c", model: "nocost", actualCost: null, expectedCost: null }),
      priced({ runId: "d", model: "noxp", xpEarned: null }),
      priced({ runId: "e", model: "stub", unscored: "unscored (scripted stub)" }),
    ]);
    expect(points.map((p) => p.key)).toEqual(["m"]);
    expect(points[0]!.basis).toBe("mixed");
    expect(omitted).toEqual([
      { key: "nocost", why: "no cost reading" },
      { key: "noxp", why: "no xp reading" },
    ]);
  });
});

describe("ladderChartLayout", () => {
  const box = { x0: 60, x1: 960, y0: 340, y1: 20 };
  const pt = (key: string, x: number, y: number) => ({
    key, model: key, effort: null, x, y, runs: 1, costRuns: 1, xpRuns: 1, basis: "reported" as const, asIfMetered: false, harnesses: ["wrathbench"],
  });

  test("zero cost sits on the y axis, the top-right point sits at the plot's top-right tick", () => {
    const l = ladderChartLayout([pt("free", 0, 0), pt("paid", 8, 2500)], box);
    const free = l.placed.find((d) => d.point.key === "free")!;
    expect(free.cx).toBe(box.x0);
    expect(free.cy).toBe(box.y0);
    expect(l.xMax).toBe(8);
    expect(l.yMax).toBe(2500);
    const paid = l.placed.find((d) => d.point.key === "paid")!;
    expect(paid.cx).toBe(box.x1);
    expect(paid.cy).toBe(box.y1);
  });

  test("labels of coincident points do not share a slot", () => {
    const l = ladderChartLayout([pt("one", 1, 100), pt("two", 1, 100), pt("three", 1, 100), pt("far", 2, 200)], box);
    const slots = new Set(l.placed.map((d) => `${d.anchor}:${d.labelY.toFixed(1)}`));
    expect(slots.size).toBe(4);
  });

  test("a label at the plot's right edge is anchored to its left", () => {
    const l = ladderChartLayout([pt("a-fairly-long-model-name", 8, 2500), pt("other", 0, 0)], box);
    expect(l.placed.find((d) => d.point.key.startsWith("a-fairly"))!.anchor).toBe("end");
  });
});
