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
  MARK_RING_R,
  RUNGS,
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
  OPAQUE_PAUSE_REASON,
  ladderPoints,
  ladderRows,
  raceOptions,
  resolveChoice,
  runCostReading,
  scored,
  streamChartLayout,
  streamRows,
  streamSeries,
  timeTicks,
  xpEarnedOf,
} from "../src/lib/ladder";
import { familyOf, monogramOf } from "../src/lib/lineup";
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
 * does not have: every freeplay run is unscored, and a stream is one character
 * across attempts.
 */
describe("freeplay streams", () => {
  const fp = (over: Partial<ResultRun> = {}): ResultRun =>
    run({ unscored: "unscored (episode freeplay)", episode: "freeplay", ...over });

  test("an unscored run is a row here — which is exactly what the rung ladder drops", () => {
    const runs = [fp({ runId: "a1", model: "m", maxLevel: 7, xp: 100 })];
    // The bug this page had: `ladderRows` filters to `scored`, and no freeplay
    // run is ever scored, so the table was structurally empty.
    expect(scored(runs)).toEqual([]);
    expect(ladderRows(runs)).toEqual([]);
    expect(streamRows(runs).map((r) => r.streamId)).toEqual(["a1"]);
  });

  test("a chain of three collapses to one row: the latest attempt, the whole lineage", () => {
    const rows = streamRows([
      fp({ runId: "a1", maxLevel: 3, xp: 10 }),
      fp({ runId: "a3", continuedFrom: "a2", maxLevel: 9, xp: 40, startedAt: 300 }),
      fp({ runId: "a2", continuedFrom: "a1", maxLevel: 6, xp: 20, startedAt: 200 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.streamId).toBe("a1");
    expect(rows[0]!.attempts).toBe(3);
    expect(rows[0]!.chain).toEqual(["a1", "a2", "a3"]);
    // The latest attempt carries the character's current state.
    expect(rows[0]!.latest.runId).toBe("a3");
    expect(rows[0]!.level).toBe(9);
  });

  test("a lineage pointing outside the set is a root, not a dropped row", () => {
    // `dropContinuation` clears the link when the character is gone, and an
    // archived predecessor is never listed: both must leave the survivor here.
    const rows = streamRows([fp({ runId: "b7", continuedFrom: "b6-archived", maxLevel: 4 })]);
    expect(rows.map((r) => ({ id: r.streamId, n: r.attempts }))).toEqual([{ id: "b7", n: 1 }]);
  });

  test("two runs claiming one predecessor: the longer chain wins the row, then the later start", () => {
    const rows = streamRows([
      fp({ runId: "c1", maxLevel: 2 }),
      fp({ runId: "c2", continuedFrom: "c1", startedAt: 200, maxLevel: 5 }),
      fp({ runId: "c2b", continuedFrom: "c1", startedAt: 400, maxLevel: 6 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latest.runId).toBe("c2b");
    expect(rows[0]!.attempts).toBe(2);
  });

  test("a malformed cycle ends the walk instead of hanging the page", () => {
    const rows = streamRows([
      fp({ runId: "d1", continuedFrom: "d2" }),
      fp({ runId: "d2", continuedFrom: "d1" }),
    ]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.attempts).toBeLessThanOrEqual(2);
  });

  test("a stillborn launch is dropped; live, paused and ended streams all stay, with their status", () => {
    const rows = streamRows([
      fp({ runId: "live", live: true, maxLevel: 12 }),
      fp({ runId: "paused", pauseReason: "operator-pause", maxLevel: 11 }),
      fp({ runId: "ended", terminationReason: "manual", maxLevel: 10 }),
      fp({ runId: "nothing", stillborn: true, maxLevel: 20 }),
    ]);
    expect(rows.map((r) => [r.streamId, r.status, r.statusDetail])).toEqual([
      ["live", "live", null],
      ["paused", "paused", "operator-pause"],
      ["ended", "ended", "manual"],
    ]);
  });

  test("ordered by level then xp, and a missing reading sorts last rather than as zero", () => {
    const rows = streamRows([
      fp({ runId: "none", maxLevel: null, xp: null }),
      fp({ runId: "lo", maxLevel: 5, xp: 900 }),
      fp({ runId: "hi", maxLevel: 5, xp: 4000 }),
      fp({ runId: "zero", maxLevel: 5, xp: 0 }),
    ]);
    expect(rows.map((r) => r.streamId)).toEqual(["hi", "lo", "zero", "none"]);
  });

  /*
   * "exclude free" applies here exactly as it does on the scored tiers
   * (operator, 2026-08-29, reversing the same day's exemption). The page hands
   * `StreamTable` and `StreamChart` the same filtered set, so the two cannot
   * disagree; the filter itself is `filterRuns`, ahead of `streamRows`.
   */
  test("exclude free filters the field too, keeping the streams a viewer cannot answer for", () => {
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
    expect(streamRows(runs).map((r) => r.streamId)).toEqual(["gratis", "paid", "unknown"]);
    const kept = filterRuns(runs, { race: null, klass: null, harness: null, excludeFree: true });
    expect(streamRows(kept).map((r) => r.streamId)).toEqual(["paid", "unknown"]);
    // The chart reads the same filtered set, so it cannot show a dropped stream.
    const chart = streamSeries(streamRows(kept), kept);
    expect(chart.series.map((s) => s.streamId)).toEqual(["paid", "unknown"]);
    expect(chart.omitted).toEqual([]);
  });

  test("a mixed-billing chain re-roots on its survivor — accepted, because billing follows the endpoint", () => {
    // A stream is one character under one config, so this is not a shape the
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
    expect(streamRows(chain)[0]!.attempts).toBe(2);
    const kept = filterRuns(chain, { race: null, klass: null, harness: null, excludeFree: true });
    expect(streamRows(kept).map((r) => ({ id: r.streamId, n: r.attempts }))).toEqual([
      { id: "m2", n: 1 },
    ]);
    // The chart says the same thing the table does: the survivor is drawn and
    // marked truncated, which is already the wording for "history before the
    // oldest attempt served is not drawn" — true whether the ancestor was
    // archived or filtered.
    const drawn = streamSeries(streamRows(kept), kept).series;
    expect(drawn.map((d) => [d.streamId, d.truncated])).toEqual([["m2", true]]);
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
    expect(free.label).toBe("hy3-free");
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
      { key: "nocost", why: "no cost reading" },
      { key: "noxp", why: "no xp reading" },
      { key: "split", why: "no run with both cost and xp" },
    ]);
  });
});

describe("ladderChartLayout", () => {
  const box = { x0: 60, x1: 960, y0: 340, y1: 20 };
  const pt = (key: string, x: number, y: number) => ({
    key, label: `${key} · n=1`, single: true, model: key, effort: null, x, y, runs: 1, n: 1, basis: "reported" as const, asIfMetered: false, harnesses: ["wrathbench"],
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

  test("every label clears the mark it belongs to, both ways", () => {
    const l = ladderChartLayout([pt("one", 1, 100), pt("two", 4, 1200), pt("three", 6, 2000)], box);
    for (const d of l.placed) {
      // Against the mark's outer edge, not the puck: a thicker separation ring
      // has to move the labels too, and this is the test that says so.
      expect(Math.abs(d.labelX - d.cx)).toBeGreaterThan(MARK_RING_R);
      expect(Math.abs(d.labelY - d.cy)).toBeGreaterThan(MARK_RING_R);
    }
  });

  test("a label at the plot's right edge is anchored to its left", () => {
    const l = ladderChartLayout([pt("a-fairly-long-model-name", 8, 2500), pt("other", 0, 0)], box);
    expect(l.placed.find((d) => d.point.key.startsWith("a-fairly"))!.anchor).toBe("end");
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
 * The freeplay chart's series: one stepped line per stream, stitched across its
 * attempts on a cumulative active-playtime axis.
 *
 * The rules worth pinning are the seams. A stream is the point of the page, and
 * a stream is many runs; every way of getting the stitch wrong shows up as a
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

describe("streamSeries", () => {
  const fp = (over: Partial<ResultRun> = {}): ResultRun =>
    run({ unscored: "unscored (episode freeplay)", episode: "freeplay", ...over });
  const seriesOf = (runs: readonly ResultRun[]): ReturnType<typeof streamSeries> =>
    streamSeries(streamRows(runs), runs);

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
    // The line runs on to the stream's total active time, not to its last ding.
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

  test("a prior attempt with no active time omits the stream rather than compressing the axis", () => {
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

  test("a live stream's line ends at the run's own total, which the viewer computes against now", () => {
    const runs = [
      fp({ runId: "g1", live: true, levels: [mark(2, null, 10_000)], playtimeMs: 900_000 }),
    ];
    const s = seriesOf(runs).series[0]!;
    expect(s.status).toBe("live");
    expect(s.endX).toBe(900_000);
  });

  test("a stream with no placeable mark is omitted with its reason, never drawn flat at zero", () => {
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

  test("a viewer that predates continuedFrom does not report every stream as truncated", () => {
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
    const layout = streamChartLayout(series, box);
    expect(layout.xMax).toBe(200_000);
    expect(layout.yMax).toBeGreaterThanOrEqual(8);
    // Two streams sitting at the same level still get two readable labels.
    const [low, same] = [layout.placed[1]!, layout.placed[2]!];
    expect(low.endCy).toBe(same.endCy);
    expect(Math.abs(low.labelY - same.labelY)).toBeGreaterThanOrEqual(12);
    // A step, not a slope: the path only ever moves horizontally then vertically.
    expect(layout.placed[0]!.d).toMatch(/^M[\d.]+,[\d.]+ (H[\d.]+ V[\d.]+ )*H[\d.]+$/);
    // The y axis is anchored at zero, so a two-level gain is not the whole chart.
    expect(layout.py(0)).toBe(box.y0);
  });

  /*
   * The badge at each line's end (operator, 2026-08-29). `StreamChart` draws it
   * from `series.model` through the same `familyOf` lookup `ModelIcon` and the
   * scored scatter use, so what is testable without a DOM is the pair the
   * component reads: one series per stream, each carrying the model whose
   * family the badge is, and an id no family claims falling through to the
   * monogram rather than to a hole. The glob behind `logoHrefOf` is a Vite
   * feature, which is why the lookup and not the element is what is pinned —
   * `dashboard/README.md` says why the components have no DOM harness.
   */
  test("every series carries the model its badge is drawn from, one per stream", () => {
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
    // One badge per stream, not one per attempt: a chain is still a single series.
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
    const opaque = streamRows([fp({ runId: "a", pauseReason: OPAQUE_PAUSE_REASON })])[0]!;
    expect(opaque.status).toBe("paused");
    expect(opaque.statusDetail).toBeNull();

    const real = streamRows([fp({ runId: "b", pauseReason: "operator-pause" })])[0]!;
    expect(real.status).toBe("paused");
    expect(real.statusDetail).toBe("operator-pause");
  });
});
