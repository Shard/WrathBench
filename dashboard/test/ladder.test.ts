/**
 * The ladder derivation.
 *
 * What matters here is what the release page is allowed to claim: unscorable
 * runs never enter a row, and a rung nothing records reads as "not
 * instrumented" instead of being approximated.
 */

import { describe, expect, test } from "bun:test";
import type { AreaFacts, ResultRun, LevelMark, RunCondition } from "../../viewer/api-types";
import { LEVEL_START_XP, TOKENS, XP, levelOfXp, runMetrics } from "../src/lib/axes";
import { filterBySeries } from "../src/lib/harness";
import { entryLines, runLines } from "../src/lib/runlines";
import { chartGroups, defaultLadderRuns, modelEntries, pickChartGroup } from "../src/lib/ladderfilter";
import { conditionOf } from "../../viewer/condition";
import { OPENCODE_GO_ROUTING } from "../../runner/src/routing";
import { runBilling, type BillableRun } from "../../runner/src/billing";
import { effortLabel, windowNote } from "../src/lib/format";
import {
  EXPANSION_MAPS,
  RUNGS,
  characterMilestones,
  type MilestoneAttempt,
  filterRuns,
  ladderPoints,
  ladderRows,
  levelRangeOf,
  runCostReading,
  scored,
  stitchCharacter,
  characterRows,
  characterSeries,
  characterSeriesLabel,
  entryKeyOf,
  modelOfRun,
  pointKey,
  xpEarnedOf,
} from "../src/lib/ladder";
import { DUNGEON_CHOICES, EPISODE_CHOICES, dungeonLabel, dungeonParam, dungeonRedirect, episodeParam } from "../src/lib/episodes";

/** An entry key (`entryKeyOf`) spelt for a test to tell entries apart: the model, with its effort and window. */
function spelt(key: string): string {
  const [model, id] = key.split("\n");
  const c = JSON.parse(id!) as { effort: string | null; compactWindow: string | null };
  const tag = effortLabel(c.effort, c.compactWindow);
  return tag === null ? model! : `${model!} (${tag})`;
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
  test("tainted rows cannot enter the public ladder ranking", () => {
    const rows = [
      run({ runId: "good", model: "good", maxLevel: 5 }),
      run({ runId: "live", model: "tainted", maxLevel: 80, unscored: "unscored (live)" }),
      run({ runId: "environment", model: "tainted", maxLevel: 80, unscored: "unscored (environment-defect)" }),
    ];
    expect(scored(rows).map((r) => r.runId)).toEqual(["good"]);
    expect(ladderRows(rows).map((r) => r.model)).toEqual(["good"]);
  });

  test("the scripted reference is no row and moves no row, however far it got", () => {
    const rows = [
      run({ runId: "low", model: "low", maxLevel: 3 }),
      run({ runId: "high", model: "high", maxLevel: 6 }),
      run({ runId: "ref", model: "reference/elwynn-human-paladin@1", maxLevel: 10, driver: "reference", unscored: "unscored (scripted reference)" }),
    ];
    expect(scored(rows).map((r) => r.runId)).toEqual(["low", "high"]);
    expect(ladderRows(rows).map((r) => r.model)).toEqual(ladderRows(rows.slice(0, 2)).map((r) => r.model));
    expect(ladderRows(rows).map((r) => r.model)).not.toContain("reference/elwynn-human-paladin@1");
  });
});

describe("ladderRows", () => {
  test("a scored row carries no rung: the milestones are freeplay's (operator, 2026-11-15)", () => {
    const row = ladderRows([run({ levels: [mark(80, 1, 1)], maxLevel: 80, areas: areas({ leftStartArea: true, capitalZone: 1519 }), taxi: { flights: 3 } })])[0]!;
    expect("cells" in row).toBe(false);
    expect("highest" in row).toBe(false);
    expect(row.bestLevel).toBe(80);
  });

  test("achievement points are a displayed signal and change no ordering", () => {
    const rows = ladderRows([
      run({ model: "decorated", maxLevel: 4, achievements: { earned: 40, points: 400, ids: [1] } }),
      run({ model: "plain", maxLevel: 12, achievements: null }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["plain", "decorated"]);
  });

  test("one row per model and condition, best run counting", () => {
    const rows = ladderRows([
      run({ model: "m", runId: "low", maxLevel: 4 }),
      run({ model: "m", runId: "high", maxLevel: 12 }),
      run({ model: "other", maxLevel: 2 }),
    ]);
    const m = rows.find((r) => r.model === "m")!;
    expect(m.runs).toBe(2);
    expect(m.bestRunId).toBe("high");
    expect(rows[0]!.model).toBe("m");
  });
});

describe("the ladder's dispersion (operator 2026-09-16)", () => {
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
      billing: "paid",
    }),
    run({ runId: "gratis", model: "qwen/qwen3:free", billing: "free" }),
    run({ runId: "old", race: null, raceName: null, class: null, className: null, characterLabel: null }),
  ];
  const all = { excludeFree: false };

  test("exclude free drops the free runs and keeps the ones a viewer could not answer for", () => {
    // `old` carries no `billing` at all: an older viewer does not report that a
    // run was free, and dropping what it cannot answer would shrink the ladder.
    expect(filterRuns(rows, { ...all, excludeFree: true }).map((r) => r.runId)).toEqual([
      "base",
      "extra",
      "old",
    ]);
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
});

describe("exclude free hides only what nobody paid for (operator, 2026-11-16)", () => {
  // One run per lane, billed by the runner's own reader verdict, as `results.ts` stamps it.
  const GO = "https://opencode.ai/inference/go/openai/v1";
  const lanes: [string, BillableRun][] = [
    ["claude-code", { model: "claude-opus-5-5", harness: "claude-code", driver: "claude-code" }],
    ["codex", { model: "gpt-6.1-sol", harness: "codex", driver: "codex" }],
    ["go", { model: "deepseek-v4.1-flash", apiBase: GO, platform: "opencode.ai", harness: "wrathbench", driver: "openai" }],
    ["openrouter-paid", { model: "deepseek/deepseek-v4.1-flash", platform: "openrouter", harness: "wrathbench", driver: "openai" }],
    ["openrouter-free", { model: "nvidia/nemotron-3-super-120b-a12b:free", platform: "openrouter", harness: "wrathbench", driver: "openai" }],
    ["zen-free", { model: "laguna-s-2.1-free", apiBase: "https://opencode.ai/zen/v1", harness: "wrathbench", driver: "openai" }],
    ["go-free", { model: "hy3-free", apiBase: GO, harness: "wrathbench", driver: "openai" }],
    ["contributor-free", { model: "muse-spark-1.2-contributor-free", harness: "wrathbench", driver: "openai" }],
    ["local", { model: "qwen3.8-27b", apiBase: "http://192.168.1.21:8000/v1", platform: "local", harness: "wrathbench", driver: "openai" }],
    ["declared-free", { model: "stealth/space-bunny-alpha", platform: "openrouter", harness: "wrathbench", driver: "openai", declaredBilling: "free" }],
  ];
  const runs = lanes.map(([runId, b]) => run({ runId, model: b.model, billing: runBilling(b) }));

  test("subscription lanes and metered APIs stay; literally free endpoints and local hardware go", () => {
    expect(filterRuns(runs, { excludeFree: true }).map((r) => r.runId)).toEqual(["claude-code", "codex", "go", "openrouter-paid"]);
    expect(filterRuns(runs, { excludeFree: false })).toHaveLength(lanes.length);
  });
});

describe("ladder row order", () => {
  test("level first, then xp within it, then gold; no rung orders a scored row (operator, 2026-11-15)", () => {
    const rows = ladderRows([
      // `higher` leads `poorer` and `richer` on level alone, even though it
      // holds the least xp within it — the pair is lexicographic.
      run({ runId: "a", model: "poorer", levels: [mark(21, 1, 1)], maxLevel: 21, xp: 10, money: 9_999 }),
      run({ runId: "b", model: "higher", levels: [mark(22, 1, 1)], maxLevel: 22, xp: 5, money: 1 }),
      // What would have been rung 7 (an expansion continent) and rung 4 at a
      // lower level: it used to lead; now it sits where its level puts it.
      run({ runId: "c", model: "traveller", levels: [mark(12, 1, 1)], maxLevel: 12, xp: 0, money: 0, maps: [0, EXPANSION_MAPS[0]!], areas: areas({ leftStartArea: true, capitalZone: 1519 }), taxi: { flights: 2 } }),
      // Tied with "poorer" on the pair (21, 10); only gold separates the two.
      run({ runId: "d", model: "richer", levels: [mark(21, 1, 1)], maxLevel: 21, xp: 10, money: 10_000 }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["higher", "richer", "poorer", "traveller"]);
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
  test("probing has no ladder (operator, 2026-08-29); a link that names it falls back", () => {
    expect(EPISODE_CHOICES).not.toContain("probing");
    expect(EPISODE_CHOICES).toEqual(["e90", "e360", "freeplay"]);
    expect(episodeParam("probing")).toBe("e90");
  });

  test("the Deadmines eval is a tab, never a ladder choice; the five-agent id has none (operator, 2026-11-15)", () => {
    // `/api/ladder` refuses them, so the ladder's own request never names one.
    for (const id of DUNGEON_CHOICES) {
      expect(EPISODE_CHOICES).not.toContain(id);
      expect(episodeParam(id)).toBe("e90");
      expect(dungeonParam(id)).toBe(id);
    }
    expect(dungeonParam("e90")).toBeNull();
    expect(dungeonParam(undefined)).toBeNull();
    expect(DUNGEON_CHOICES).toEqual(["deadmines-solo"]);
    expect(dungeonLabel("deadmines-solo")).toBe("deadmines");
    // The five-agent id's old tab link lands on the one tab.
    expect(dungeonParam("deadmines")).toBeNull();
    expect(dungeonRedirect("deadmines")).toBe("deadmines-solo");
    expect(dungeonRedirect("deadmines-solo")).toBeNull();
    expect(dungeonRedirect("e90")).toBeNull();
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
    const kept = filterRuns(runs, { excludeFree: true });
    expect(characterRows(kept).map((r) => r.characterId)).toEqual(["paid", "unknown"]);
    // The chart reads the same filtered set, so it cannot show a dropped character.
    const chart = characterSeries(characterRows(kept), kept);
    expect(chart.series.map((s) => s.characterId)).toEqual(["paid", "unknown"]);
    expect(chart.omitted).toEqual([]);
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
    expect(points.map((p) => spelt(p.key))).toEqual(["hy3-free", "sonnet (low)", "sonnet"]);
    const low = points.find((p) => spelt(p.key) === "sonnet (low)")!;
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
    const solo = points.find((p) => spelt(p.key) === "sonnet")!;
    expect(solo.label).toBe("sonnet");
    expect(solo.single).toBe(true);
    const free = points.find((p) => spelt(p.key) === "hy3-free")!;
    expect(free.x).toBe(0);
    expect(free.y).toBe(20);
    expect(free.basis).toBe("list-price");
    expect(free.asIfMetered).toBe(true);
    expect(free.label).toBe("hy3 (free)");
    expect(free.single).toBe(false);
  });

  test("a claude-code compaction window is a point of its own, named like the model and said in its hover (operator, 2026-11-16)", () => {
    const { points } = ladderPoints([
      priced({ runId: "a", model: "claude-haiku-5-5", effort: "max", actualCost: fig(40, "reported"), xpEarned: 900 }),
      priced({ runId: "b", model: "claude-haiku-5-5", effort: "max", compactWindow: "100k", actualCost: fig(8, "reported"), xpEarned: 700 }),
    ]);
    // Two entries, never pooled.
    expect(points.map((p) => spelt(p.key)).sort()).toEqual(["claude-haiku-5-5 (max · 100k)", "claude-haiku-5-5 (max)"]);
    const small = points.find((p) => p.compactWindow === "100k")!;
    const big = points.find((p) => p.compactWindow === undefined)!;
    expect(small.x).toBe(8);
    // The window is a setting, not a title: both points carry the one name.
    expect(small.label).toBe("claude-haiku-5-5 (max)");
    expect(big.label).toBe("claude-haiku-5-5 (max)");
    // The point keeps the window for its hover and card (`windowNote`); `auto` carries no field.
    expect(windowNote(small.compactWindow)).toBe("compaction window 100k");
    expect("compactWindow" in big).toBe(false);
    expect(characterSeriesLabel("claude-haiku-5-5", "max")).toBe("claude-haiku-5-5 (max)");
    expect(pointKey("claude-sonnet-5-5", null)).toBe("claude-sonnet-5-5");
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
    expect(points.map((p) => spelt(p.key))).toEqual(["m"]);
    expect(points[0]!.basis).toBe("mixed");
    expect(omitted.map((o) => ({ ...o, key: spelt(o.key) }))).toEqual([
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
    expect(byTokens.points.map((p) => spelt(p.key))).toEqual(["counted"]);
    const counted = byTokens.points[0]!;
    expect(counted.x).toBe(2000);
    expect(counted.y).toBe(300);
    expect(counted.n).toBe(2);
    // The bag: means over the same two runs, cost included (both list-priced $0).
    expect(counted.metrics.tokens).toBe(2000);
    expect(counted.metrics.cost).toBe(0);
    expect(counted.metrics.turns).toBe(1);
    expect(counted.basis).toBe("list-price");
    expect(byTokens.omitted.map((o) => ({ ...o, key: spelt(o.key) }))).toEqual([
      { key: "guessed", label: "guessed", why: "no tokens reading" },
      { key: "noxp", label: "noxp", why: "no xp reading" },
      { key: "split", label: "split", why: "no run with both tokens and xp" },
    ]);
    // The default view still plots the estimated-token entry, priced as reported.
    const byCost = ladderPoints(runs);
    expect(byCost.points.map((p) => spelt(p.key))).toEqual(["counted", "guessed", "split"]);
    expect(byCost.points.find((p) => spelt(p.key) === "guessed")!.basis).toBe("reported");
    expect(byCost.omitted.map((o) => o.why)).toEqual(["no xp reading"]);
  });

  test("a snapshot-read token total is not a reading either, nor is a list price over it; turns and level are", () => {
    const floor = priced({ tokens: tokens(9000, "snapshot"), expectedCost: fig(140, "list-price", true), modelResponses: 42, levels: [mark(3, 1, 1000)] });
    const m = runMetrics(floor);
    expect(m.tokens).toBeNull();
    expect(m.tokensOut).toBeNull();
    expect(m.turns).toBe(42);
    expect(m.level).toBe(3);
    // The run page shows the floor; no axis plots a cost with most of its output missing.
    expect(m.cost).toBeNull();
    expect(m.xp).toBe(100);
    // What the CLI did report still reads, whatever the token source.
    expect(runMetrics({ ...floor, actualCost: fig(2, "reported") }).cost).toBe(2);
  });

  test("a claude-code run's turns are its CLI's model turns, every other harness's its response records", () => {
    // 148 response records, 124 model turns by the CLI: a record is one envelope of a message there.
    const cli: ResultRun["tokens"] = { ...tokens(9000)!, turns: 124 };
    expect(runMetrics(priced({ harness: "claude-code", tokens: cli, modelResponses: 148 })).turns).toBe(124);
    expect(runMetrics(priced({ harness: "claude-code", tokens: null, modelResponses: 148 })).turns).toBe(148);
    expect(runMetrics(priced({ harness: "codex", tokens: cli, modelResponses: 148 })).turns).toBe(148);
    expect(runMetrics(priced({ harness: "wrathbench", tokens: cli, modelResponses: 148 })).turns).toBe(148);
  });
});

/**
 * The freeplay chart's series: one stepped line per character, stitched across its
 * attempts on a cumulative active-playtime axis.
 *
 * The rules worth pinning are the seams. A character is the point of the page, and
 * a character is many runs; every way of getting the stitch wrong shows up as a
 * plausible-looking line, so the seam rules are pinned here.
 */
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
});

describe("entryKeyOf — the key a row, a pin and a line agree on", () => {
  test("one model under one condition: two efforts are two entries, never one row", () => {
    const runs = [
      run({ runId: "a", model: "sonnet", effort: "low", xpEarned: 100 }),
      run({ runId: "b", model: "sonnet", effort: "high", xpEarned: 200 }),
      run({ runId: "c", model: null, xpEarned: 50 }),
    ];
    const rows = ladderRows(runs);
    expect(rows.map((r) => r.model).sort()).toEqual(["(unnamed)", "sonnet", "sonnet"]);
    const rowKeys = new Set(rows.map((r) => r.key));
    for (const p of ladderPoints(runs).points) expect(rowKeys.has(p.key)).toBe(true);
    for (const r of runs) expect(rowKeys.has(entryKeyOf(r))).toBe(true);
  });

  test("the loop and the wiki each split a row; the prompt hash does not", () => {
    const base = { model: "m", maxLevel: 3, harnessSeries: "0.5", episode: "e90" as const };
    const cond = (id: string, over: Partial<RunCondition> = {}): RunCondition => ({ id, loop: "snippet", yield: false, pinned: true, wiki: true, subject: "hosted", ...over });
    const runs = [
      run({ ...base, runId: "a", promptHash: "sha256:a", condition: cond("x") }),
      run({ ...base, runId: "b", promptHash: "sha256:b", condition: cond("x") }),
      run({ ...base, runId: "c", condition: cond("y", { loop: "program", yield: true }) }),
    ];
    expect(ladderRows(runs).map((r) => [r.runs, r.condition.loop])).toEqual([[2, "snippet"], [1, "program"]]);
  });

  test("a Go-routed and a pinned run of one model are one entry on one chart (operator, 2026-11-16)", () => {
    // Each run's condition as the viewer derives it off the stamped tuple (`results.ts`).
    const onRoute = (runId: string, routing: Record<string, unknown> & { allowFallbacks: boolean }, maxLevel: number, startedAt: number) =>
      run({
        runId,
        model: "glm",
        maxLevel,
        startedAt,
        harnessSeries: "0.5",
        episode: "e90",
        condition: conditionOf({ series: "0.5", episode: "e90", harness: "wrathbench", tuple: { effort: null, routing } }),
      });
    const go = onRoute("go", { ...OPENCODE_GO_ROUTING }, 5, 200);
    const pinned = onRoute("pinned", { order: ["z-ai"], allowFallbacks: false }, 7, 100);
    const runs = [go, pinned];
    // Still says how each was routed.
    expect([go.condition!.pinned, pinned.condition!.pinned]).toEqual([false, true]);
    expect(entryKeyOf(go)).toBe(entryKeyOf(pinned));
    expect(chartGroups(runs).map((g) => [g.id, g.label, g.entries])).toEqual([["snippet", "snippet loop", 1]]);
    expect(defaultLadderRuns(runs).map((r) => r.runId)).toEqual(["go", "pinned"]);
    expect(ladderRows(runs).map((r) => [r.model, r.runs, r.bestLevel, r.bestRunId])).toEqual([["glm", 2, 7, "pinned"]]);
    expect(modelEntries(runs)).toHaveLength(1);
    // An old link to the unpinned chart opens the loop's, never an empty page.
    expect(pickChartGroup(chartGroups(runs), "snippet-unpinned")).toBe("snippet");
  });

  test("a Go run and an OpenRouter run of DeepSeek, recorded under two ids, are one entry and one model (operator, 2026-11-16)", () => {
    const base = { harnessSeries: "0.5", episode: "e90" as const, harness: "wrathbench" as const };
    const at = (runId: string, model: string, routing: Record<string, unknown> & { allowFallbacks: boolean }, maxLevel: number, startedAt: number): ResultRun =>
      run({ ...base, runId, model, maxLevel, startedAt, xpEarned: maxLevel * 100, condition: conditionOf({ series: "0.5", episode: "e90", harness: "wrathbench", tuple: { effort: null, routing } }) });
    const go = at("go", "deepseek-v4.1-flash", { ...OPENCODE_GO_ROUTING }, 5, 200);
    const or = at("or", "deepseek/deepseek-v4.1-flash", { order: ["GMICloud"], allowFallbacks: false }, 7, 100);
    const runs = [go, or];
    // Each run keeps the id its provider reported.
    expect(runs.map((r) => r.model)).toEqual(["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash"]);
    expect(modelOfRun(go)).toBe("deepseek/deepseek-v4.1-flash");
    expect(entryKeyOf(go)).toBe(entryKeyOf(or));
    expect(ladderRows(runs).map((r) => [r.model, r.runs, r.bestLevel, r.bestRunId])).toEqual([["deepseek/deepseek-v4.1-flash", 2, 7, "or"]]);
    // No cost reading here, so the chart names the one entry rather than placing it.
    expect(ladderPoints(runs).omitted.map((o) => [o.key, o.label])).toEqual([[entryKeyOf(go), "deepseek-v4.1-flash"]]);
    expect(modelEntries(runs)).toHaveLength(1);
    // A literally free endpoint of it is its own entry, always labelled free.
    const free = at("free", "deepseek/deepseek-v4.1-flash:free", { order: ["Chutes"], allowFallbacks: false }, 3, 50);
    expect(entryKeyOf(free)).not.toBe(entryKeyOf(go));
    expect(ladderPoints([...runs, free]).omitted.map((o) => o.label).sort()).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash (free)"]);
  });
});

describe("characterSeries", () => {
  const fp = (over: Partial<ResultRun> = {}): ResultRun =>
    run({ unscored: "unscored (episode freeplay)", episode: "freeplay", ...over });
  const seriesOf = (runs: readonly ResultRun[]): ReturnType<typeof characterSeries> =>
    characterSeries(characterRows(runs), runs);

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

  test("a character with no placeable mark is omitted with its reason, never drawn flat at zero", () => {
    // Two different nothings, and the caption says which.
    expect(seriesOf([fp({ runId: "h1", levels: [], playtimeMs: 60_000 })]).omitted[0]!.why).toBe(
      "no level recorded yet",
    );
    const unplaceable = seriesOf([fp({ runId: "h2", levels: [mark(3, null, null)], playtimeMs: 60_000 })]);
    expect(unplaceable.series).toEqual([]);
    expect(unplaceable.omitted[0]!.why).toBe("no level mark carries an active-time reading");
  });
});

describe("the xp levels the run lines are drawn against", () => {
  test("the cumulative table: where each level begins for a fresh L1 character", () => {
    // By hand from AzerothCore's player_xp_for_level: 400, 900, 1400, 2100, …
    expect(LEVEL_START_XP[1]).toBe(0);
    expect(LEVEL_START_XP[2]).toBe(400);
    expect(LEVEL_START_XP[3]).toBe(1300);
    expect(LEVEL_START_XP[5]).toBe(4800);
    expect(LEVEL_START_XP[10]).toBe(27_600);
    expect(LEVEL_START_XP).toHaveLength(81);
    expect(levelOfXp(0)).toBe(1);
    expect(levelOfXp(399)).toBe(1);
    expect(levelOfXp(400)).toBe(2);
    expect(levelOfXp(27_599)).toBe(9);
    expect(levelOfXp(27_600)).toBe(10);
    expect(levelOfXp(1e12)).toBe(80);
  });
});

describe("runLines — a tier's runs as xp against active playtime", () => {
  const MIN = 60_000;

  test("origin, the start of each level reached at its mark's playtime, then the run's own end", () => {
    const { lines, omitted } = runLines([
      run({
        runId: "a",
        model: "fixture/m",
        effort: "high",
        xpEarned: 3000,
        playtimeMs: 90 * MIN,
        levels: [mark(1, 0, 0), mark(2, 3, 10 * MIN), mark(3, 9, 30 * MIN), mark(4, 20, 70 * MIN)],
      }),
    ]);
    expect(omitted).toEqual([]);
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    // L2 begins at 400, L3 at 1,300, L4 at 2,700 (AzerothCore's table, summed by hand).
    expect(l.points).toEqual([
      { x: 0, y: 0 },
      { x: 10 * MIN, y: 400 },
      { x: 30 * MIN, y: 1300 },
      { x: 70 * MIN, y: 2700 },
      { x: 90 * MIN, y: 3000 },
    ]);
    expect(l.endLevel).toBe(4);
    expect(spelt(l.entry)).toBe("m (high)");
    expect(l.hoverKey).toBe(l.entry);
    expect(l.harness).toBe("wrathbench");
  });

  test("never runs backwards: a mark with no playtime is skipped, one past the end is held at it, a short xp reading is raised", () => {
    const l = runLines([
      run({
        runId: "b",
        xpEarned: 100, // a lower bound below the L3 mark's own floor
        playtimeMs: 20 * MIN,
        levels: [mark(1, 0, 0), mark(2, 2, null), mark(3, 5, 25 * MIN)],
      }),
    ]).lines[0]!;
    expect(l.points).toEqual([
      { x: 0, y: 0 },
      { x: 20 * MIN, y: 1300 },
      { x: 20 * MIN, y: 1300 },
    ]);
    expect(l.endY).toBe(1300);
    expect(l.endLevel).toBe(3);
  });

  test("a run without both readings, or unscored, is not drawn; the order is a function of the set", () => {
    const runs = [
      run({ runId: "z", model: "b", xpEarned: 10, playtimeMs: MIN }),
      run({ runId: "y", model: "a", xpEarned: 10, playtimeMs: MIN }),
      run({ runId: "x", model: "a", xpEarned: 10, playtimeMs: MIN }),
      run({ runId: "noxp", model: "a", xpEarned: null, playtimeMs: MIN }),
      run({ runId: "notime", model: "a", xpEarned: 10, playtimeMs: null }),
      run({ runId: "ref", model: "a", xpEarned: 10, playtimeMs: MIN, unscored: "unscored (scripted reference)" }),
    ];
    const m = runLines(runs);
    expect(m.lines.map((l) => l.runId)).toEqual(["x", "y", "z"]);
    expect(m.omitted).toEqual([
      { runId: "noxp", why: "no xp reading" },
      { runId: "notime", why: "no playtime reading" },
    ]);
    expect(runLines([...runs].reverse()).lines.map((l) => l.runId)).toEqual(["x", "y", "z"]);
  });

  test("an entry's line is the mean of its runs, each read at the same fraction of its own playtime", () => {
    const { lines } = runLines([
      // Straight from the origin to 3,000 xp at 90 minutes.
      run({ runId: "a", model: "m", effort: "high", xpEarned: 3000, playtimeMs: 90 * MIN, levels: [mark(1, 0, 0)] }),
      // L2 (400 xp) at 30 of its 60 minutes, then 1,000 xp at the end.
      run({ runId: "b", model: "m", effort: "high", xpEarned: 1000, playtimeMs: 60 * MIN, levels: [mark(1, 0, 0), mark(2, 3, 30 * MIN)] }),
      run({ runId: "c", model: "m", effort: "low", xpEarned: 200, playtimeMs: 90 * MIN, harness: "pi", levels: [mark(1, 0, 0)] }),
    ]);
    const entries = entryLines(lines);
    expect(entries.map((e) => [spelt(e.entry), e.n])).toEqual([
      ["m (high)", 2],
      ["m (low)", 1],
    ]);
    const m = entries[0]!;
    // Halfway through each run's own clock: a at 1,500, b at its L2 mark's 400.
    expect(m.points).toEqual([
      { x: 0, y: 0 },
      { x: 37.5 * MIN, y: 950 },
      { x: 75 * MIN, y: 2000 },
    ]);
    expect([m.endX, m.endY, m.endLevel]).toEqual([75 * MIN, 2000, 3]);
    expect(m.hoverKey).toBe(m.entry);
    expect(m.harnesses).toEqual(["wrathbench"]);
    // One run's mean is that run's line.
    const single = entries[1]!;
    expect(single.points).toEqual(lines.find((l) => l.runId === "c")!.points);
    expect(single.harnesses).toEqual(["pi"]);
    expect(entryLines([...lines].reverse())).toEqual(entries);
  });
});

/*
 * The milestone rungs as freeplay achievements (operator, 2026-11-15): which a
 * character reached across its attempts, and the cumulative active playtime it
 * reached each at.
 */
describe("freeplay milestones", () => {
  const H = 3_600_000;
  const at = (ts: number, playtimeMs: number | null) => ({ ts, playtimeMs });
  const times = (p: Partial<NonNullable<MilestoneAttempt["milestoneAt"]>> = {}): NonNullable<MilestoneAttempt["milestoneAt"]> => ({
    areas: true,
    flights: true,
    leftStartArea: null,
    capitalZone: null,
    flight: null,
    expansion: null,
    ...p,
  });
  const attempt = (runId: string, playtimeMs: number | null, levels: LevelMark[], milestoneAt?: MilestoneAttempt["milestoneAt"]): MilestoneAttempt => ({
    runId,
    playtimeMs,
    levels,
    ...(milestoneAt !== undefined ? { milestoneAt } : {}),
  });
  const lv = (level: number, ms: number | null): LevelMark => ({ level, ts: level * 1000, turn: null, playtimeMs: ms });
  const byN = (rs: ReturnType<typeof characterMilestones>, n: number) => rs.find((r) => r.n === n)!;

  test("a level rung is placed on the character's cumulative playtime, across attempts", () => {
    const rs = characterMilestones([
      attempt("a1", 2 * H, [lv(1, 0), lv(5, H)], times()),
      // Attempt 2 opens holding L5: its first mark is no new level, and L10 lands 30 minutes in.
      attempt("a2", H, [lv(5, 0), lv(10, H / 2)], times()),
    ]);
    expect(byN(rs, 1)).toEqual({ n: 1, status: "reached", playtimeMs: H, runId: "a1" });
    expect(byN(rs, 3)).toEqual({ n: 3, status: "reached", playtimeMs: 2 * H + H / 2, runId: "a2" });
    expect(byN(rs, 5).status).toBe("not-reached");
    expect(byN(rs, 8).status).toBe("not-reached");
  });

  test("an attempt with no active time leaves later rungs reached, with no playtime rather than a short one", () => {
    const rs = characterMilestones([attempt("a1", null, [lv(1, null)]), attempt("a2", H, [lv(10, H / 4)])]);
    expect(byN(rs, 3)).toEqual({ n: 3, status: "reached", playtimeMs: null, runId: "a2" });
  });

  test("rung 2 is the sustained exit's mark, read from the character's start only", () => {
    const left = characterMilestones([attempt("a1", H, [lv(1, 0)], times({ leftStartArea: at(5_000, 20 * 60_000) }))]);
    expect(byN(left, 2)).toEqual({ n: 2, status: "reached", playtimeMs: 20 * 60_000, runId: "a1" });
    const stayed = characterMilestones([attempt("a1", H, [lv(1, 0)], times())]);
    expect(byN(stayed, 2).status).toBe("not-reached");
    // The first attempt recorded no area: a later attempt's "exit" is from wherever it resumed, so it is not read.
    const blind = characterMilestones([
      attempt("a1", H, [lv(1, 0)], times({ areas: false })),
      attempt("a2", H, [lv(4, 0)], times({ leftStartArea: at(9_000, 60_000) })),
    ]);
    expect(byN(blind, 2).status).toBe("not-recorded");
    // Nor when the chain begins mid-history.
    const midway = characterMilestones([attempt("a2", H, [lv(4, 0)], times({ leftStartArea: at(9_000, 60_000) }))], true);
    expect(byN(midway, 2).status).toBe("not-recorded");
  });

  test("rung 4 needs a capital and a flight, on any attempts, and is reached at the later", () => {
    const rs = characterMilestones([
      attempt("a1", 2 * H, [lv(1, 0)], times({ capitalZone: at(1_000, H) })),
      attempt("a2", H, [lv(9, 0)], times({ flight: at(2_000, H / 2) })),
    ]);
    expect(byN(rs, 4)).toEqual({ n: 4, status: "reached", playtimeMs: 2 * H + H / 2, runId: "a2" });
    // Walked to the capital, never flew: no.
    expect(byN(characterMilestones([attempt("a1", H, [lv(1, 0)], times({ capitalZone: at(1_000, H) }))]), 4).status).toBe("not-reached");
    // Flew, but no record could say whether it ever saw a capital: not recorded, never "no".
    const noAreas = characterMilestones([attempt("a1", H, [lv(1, 0)], times({ areas: false, flight: at(1_000, H) }))]);
    expect(byN(noAreas, 4).status).toBe("not-recorded");
    // An attempt from before the producers: nothing to ask.
    expect(byN(characterMilestones([attempt("a1", H, [lv(1, 0)])]), 4).status).toBe("not-recorded");
  });

  test("rung 7 is level 40 or an expansion continent, whichever came first", () => {
    const rs = characterMilestones([attempt("a1", 9 * H, [lv(30, H), lv(40, 8 * H)], times({ expansion: at(100, 3 * H) }))]);
    expect(byN(rs, 7)).toEqual({ n: 7, status: "reached", playtimeMs: 3 * H, runId: "a1" });
  });

  test("rung 6 is a group of agents in a 5-man dungeon in freeplay, and reads not instrumented", () => {
    const six = RUNGS.find((r) => r.n === 6)!;
    expect(six.title).toBe("A 5-man dungeon done with a group of agents");
    expect(six.parts).toBeNull();
    expect(byN(characterMilestones([attempt("a1", 99 * H, [lv(80, H)], times({ capitalZone: at(1, 1), flight: at(2, 2) }))]), 6)).toEqual({
      n: 6,
      status: "not-instrumented",
      playtimeMs: null,
      runId: null,
    });
  });

  test("every rung says what it applies", () => {
    expect(RUNGS.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const r of RUNGS) expect(r.rule.length).toBeGreaterThan(10);
  });

  /*
   * The freeplay tab applies the shell's series like every tab (operator,
   * 2026-11-15), and cuts the runs before the walk, as every other filter here
   * does. A character no longer carries across a series; one begun before that
   * rule may span two, and under each it is that series' attempts only.
   */
  test("the series cuts the runs before the walk: a two-series chain re-roots, and rungs counted from the start are not credited", () => {
    const fp = (over: Partial<ResultRun>): ResultRun => run({ unscored: "unscored (episode freeplay)", episode: "freeplay", ...over });
    const runs = [
      fp({ runId: "old1", harnessSeries: "0.4", playtimeMs: H, maxLevel: 5, levels: [lv(1, 0), lv(5, H / 2)], milestoneAt: times({ leftStartArea: at(1, H / 4) }) }),
      fp({ runId: "old2", continuedFrom: "old1", harnessSeries: "0.5", startedAt: 200, playtimeMs: H, maxLevel: 7, levels: [lv(5, 0), lv(7, H / 2)], milestoneAt: times() }),
      fp({ runId: "old3", continuedFrom: "old2", harnessSeries: "0.5", startedAt: 300, playtimeMs: H, maxLevel: 9, levels: [lv(7, 0), lv(9, H / 2)], milestoneAt: times() }),
      fp({ runId: "new1", harnessSeries: "1.0", startedAt: 400, playtimeMs: H, maxLevel: 4, levels: [lv(1, 0), lv(4, H / 2)], milestoneAt: times() }),
      fp({ runId: "unstamped", harnessSeries: null, harnessVersion: null, startedAt: 500, maxLevel: 2 }),
    ];
    const tab = (series: string | null) => characterRows(filterBySeries(runs, series)).map((r) => ({ id: r.characterId, n: r.attempts, latest: r.latest.runId }));
    expect(tab("1.0")).toEqual([{ id: "new1", n: 1, latest: "new1" }]);
    expect(tab("0.5")).toEqual([{ id: "old2", n: 2, latest: "old3" }]);
    expect(tab("0.4")).toEqual([{ id: "old1", n: 1, latest: "old1" }]);
    // "all" is the whole field, the unstamped run included and the chain whole.
    expect(tab(null)).toEqual([
      { id: "old1", n: 3, latest: "old3" },
      { id: "new1", n: 1, latest: "new1" },
      { id: "unstamped", n: 1, latest: "unstamped" },
    ]);
    // Under 0.5 the character's start is not among its attempts, so leaving the
    // start area — reached on 0.4 — is neither credited nor claimed missed.
    const cut = characterRows(filterBySeries(runs, "0.5"))[0]!;
    expect(cut.milestones[1]!.status).toBe("not-recorded");
    expect(characterRows(runs)[0]!.milestones[1]!.status).toBe("reached");
  });
});
