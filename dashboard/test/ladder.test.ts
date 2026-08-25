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
  billingKnown,
  classOptions,
  filterRuns,
  harnessOptions,
  ladderChartLayout,
  ladderPoints,
  ladderRows,
  raceOptions,
  resolveChoice,
  runCostReading,
  scored,
  xpEarnedOf,
} from "../src/lib/ladder";
import { resolvedSummary } from "../src/lib/models";
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

  test("rung 4 needs both halves: a capital zone AND a recorded flight (ADR-0048)", () => {
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

  test("achievement points are a displayed signal and change no ordering (ADR-0018/0043)", () => {
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
