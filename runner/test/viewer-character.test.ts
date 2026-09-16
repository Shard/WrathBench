/**
 * Aggregating a freeplay character at read time (`runner/viewer/character.ts`).
 *
 * The rules under test are the ones that decide what a number on the run page
 * MEANS: a tally sums, a state comes from the furthest attempt, and a kind no
 * attempt recorded reads null rather than zero — so a character whose oldest
 * attempts predate a column is not reported as having done less than it did.
 * The chain walk itself is `viewer-lineage.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { CostFigure, ResultRun, TokenTotals } from "../viewer/api-types";
import { characterViewOf } from "../viewer/character";
import { projectRunDetail } from "../viewer/public-projection";

function run(p: Partial<ResultRun> = {}): ResultRun {
  return {
    runId: "r",
    model: "m",
    platform: "openrouter",
    harnessVersion: "harness-0.5",
    harnessSeries: "0.5",
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
    episode: "freeplay",
    episodeSource: "stamped",
    episodeOverride: false,
    unscored: "unscored (episode freeplay)",
    startedAt: 0,
    endedAt: null,
    live: false,
    terminationReason: "idle",
    levels: [],
    maxLevel: null,
    xp: null,
    money: null,
    questsCompleted: null,
    maps: [0],
    character: "Bromdir",
    playtimeMs: null,
    tokens: null,
    actualCost: null,
    pauseReason: null,
    continuedFrom: null,
    stillborn: null,
    ...p,
  };
}

/** A chain a1 → a2 → a3, each attempt given the fields a case cares about. */
function chain(...parts: Partial<ResultRun>[]): ResultRun[] {
  return parts.map((p, i) =>
    run({
      runId: `a${i + 1}`,
      startedAt: (i + 1) * 1000,
      continuedFrom: i === 0 ? null : `a${i}`,
      ...p,
    }),
  );
}

function tokens(p: Partial<TokenTotals> = {}): TokenTotals {
  return {
    source: "reported",
    contextTokens: 100,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    turns: 1,
    ...p,
  };
}

function cost(usd: number | null, p: Partial<CostFigure> = {}): CostFigure {
  return {
    usd,
    basis: usd === null ? "none" : "reported",
    asIfMetered: false,
    breakdown: null,
    priceId: null,
    asOf: null,
    note: "",
    ...p,
  };
}

describe("characterViewOf", () => {
  /*
   * Item 128: every run belongs to a character, and a run with no chain is a
   * character of one attempt rather than no character at all. Whether that
   * view is worth PRINTING is `hasLineage`'s question, and the run detail
   * route still asks it — this is only the aggregation.
   */
  test("a lone run is a character of one attempt", () => {
    const view = characterViewOf("a1", [run({ runId: "a1" })]);
    expect(view?.characterId).toBe("a1");
    expect(view?.attempt).toBe(1);
    expect(view?.attempts).toBe(1);
    expect(view?.previous).toBeNull();
    expect(view?.next).toBeNull();
    expect(view?.runs.map((r) => r.runId)).toEqual(["a1"]);
    expect(view?.totals.attempts).toBe(1);
  });

  test("a run the set does not hold, and a stillborn launch, have no character", () => {
    expect(characterViewOf("nobody", [run({ runId: "a1" })])).toBeNull();
    expect(characterViewOf("a1", [run({ runId: "a1", stillborn: true })])).toBeNull();
  });

  /*
   * A character page has to be able to name what it is about, and an attempt
   * row carries figures only. The identity comes off the NEWEST attempt that
   * recorded each field — a character can outlive a harness patch, and a thin
   * session must not blank a name the eleven before it proved.
   */
  test("the identity is the newest attempt's, field by field", () => {
    const runs = chain(
      { model: "old/model", harnessVersion: "harness-0.4", character: "Bromdir", effort: "low" },
      { model: "new/model", harnessVersion: "harness-0.5", character: null, effort: null },
    );
    const view = characterViewOf("a1", runs);
    expect(view?.model).toBe("new/model");
    expect(view?.harnessVersion).toBe("harness-0.5");
    // The second attempt recorded neither, so the first still speaks.
    expect(view?.name).toBe("Bromdir");
    expect(view?.effort).toBe("low");
  });

  test("an attempt sees the whole chain, forward as well as back", () => {
    const runs = chain({}, {}, {});
    const view = characterViewOf("a1", runs);
    expect(view?.runs.map((r) => r.runId)).toEqual(["a1", "a2", "a3"]);
    expect(view?.attempt).toBe(1);
    expect(view?.attempts).toBe(3);
    expect(view?.previous).toBeNull();
    expect(view?.next).toBe("a2");
    // The middle of the chain reads the same set, from its own place in it.
    expect(characterViewOf("a2", runs)?.attempt).toBe(2);
    expect(characterViewOf("a2", runs)?.previous).toBe("a1");
    expect(characterViewOf("a3", runs)?.runs.map((r) => r.runId)).toEqual(["a1", "a2", "a3"]);
  });

  test("quests, xp and playtime sum across the attempts", () => {
    const view = characterViewOf(
      "a3",
      chain(
        { questsCompleted: 4, xpEarned: 1000, playtimeMs: 60_000 },
        { questsCompleted: 7, xpEarned: 2500, playtimeMs: 120_000 },
        { questsCompleted: 2, xpEarned: 300, playtimeMs: 30_000 },
      ),
    );
    expect(view?.totals.questsCompleted).toBe(13);
    expect(view?.totals.xpEarned).toBe(3800);
    expect(view?.totals.playtimeMs).toBe(210_000);
    // The attempts keep their own figures: the strip shows the session as it
    // was recorded, and the total is the character's.
    expect(view?.runs.map((r) => r.questsCompleted)).toEqual([4, 7, 2]);
  });

  test("a kind no attempt recorded is null, not zero", () => {
    const view = characterViewOf("a2", chain({}, {}));
    expect(view?.totals.questsCompleted).toBeNull();
    expect(view?.totals.xpEarned).toBeNull();
    expect(view?.totals.playtimeMs).toBeNull();
    expect(view?.totals.tokens).toBeNull();
    expect(view?.totals.taxi).toBeNull();
    expect(view?.totals.spells).toBeNull();
    expect(view?.totals.deaths).toBeNull();
  });

  test("an attempt that predates a column contributes nothing and does not zero the total", () => {
    // a1 is old enough that its run.sqlite has no quests column at all.
    const view = characterViewOf("a2", chain({ questsCompleted: null }, { questsCompleted: 9 }));
    expect(view?.totals.questsCompleted).toBe(9);
    expect(view?.runs[0]?.questsCompleted).toBeNull();
  });

  test("level is the highest any attempt saw; money is the furthest reading", () => {
    const view = characterViewOf(
      "a3",
      chain({ maxLevel: 6, money: 1200 }, { maxLevel: 9, money: 4500 }, { maxLevel: 9, money: null }),
    );
    expect(view?.totals.level).toBe(9);
    // The newest attempt recorded no money, so the character reports the last one
    // that did rather than losing the character's purse to a missing sample.
    expect(view?.totals.money).toBe(4500);
  });

  test("achievements are the latest attempt's, never a sum", () => {
    const view = characterViewOf(
      "a3",
      chain(
        { achievements: { earned: 3, points: 30, ids: [1, 2, 3] } },
        { achievements: { earned: 5, points: 60, ids: [1, 2, 3, 4, 5] } },
        // The newest attempt wrote no milestone of that kind; the backlog is
        // still what the character holds, so the last reading stands.
        { achievements: null },
      ),
    );
    expect(view?.totals.achievements).toEqual({ earned: 5, points: 60, ids: [1, 2, 3, 4, 5] });
  });

  test("flights, deaths and trades are tallies", () => {
    const view = characterViewOf(
      "a2",
      chain(
        {
          taxi: { flights: 2 },
          deaths: { deaths: 3, releases: 3, resurrects: 2, first: null, last: null, sites: [] },
          trades: { trades: 1, first: null, last: null, marks: [{ ts: 5, turn: 1 }] },
        },
        {
          taxi: { flights: 1 },
          deaths: { deaths: 1, releases: 1, resurrects: 1, first: null, last: null, sites: [] },
          trades: { trades: 2, first: null, last: null, marks: [{ ts: 9, turn: 2 }] },
        },
      ),
    );
    expect(view?.totals.taxi?.flights).toBe(3);
    expect(view?.totals.deaths?.deaths).toBe(4);
    expect(view?.totals.trades?.trades).toBe(3);
    expect(view?.totals.trades?.marks).toHaveLength(2);
    expect(view?.runs.map((r) => r.flights)).toEqual([2, 1]);
  });

  test("spells sum their learns but keep one baseline, and talents count distinct", () => {
    const view = characterViewOf(
      "a2",
      chain(
        { spells: { learned: 2, atLogin: 10, ids: [7, 8], marks: [] } },
        // Attempt 2 logged in already holding attempt 1's book: summing the
        // baselines would count it twice.
        {
          spells: { learned: 1, atLogin: 12, ids: [9], marks: [] },
          talents: { spends: 2, talents: 1, marks: [{ id: 4, points: 2, ts: 1, turn: 1 }] },
        },
      ),
    );
    expect(view?.totals.spells).toEqual({ learned: 3, atLogin: 10, ids: [7, 8, 9], marks: [] });
    expect(view?.totals.talents?.spends).toBe(2);
    expect(view?.totals.talents?.talents).toBe(1);
  });

  test("tokens sum, the context is the last reading, and the weakest source wins", () => {
    const view = characterViewOf(
      "a3",
      chain(
        { tokens: tokens({ promptTokens: 100, completionTokens: 10, totalTokens: 110, turns: 4 }) },
        { tokens: null },
        {
          tokens: tokens({
            source: "snapshot",
            contextTokens: 900,
            promptTokens: 50,
            completionTokens: 5,
            totalTokens: 55,
            turns: 2,
            cacheReadTokens: 20,
          }),
        },
      ),
    );
    expect(view?.totals.tokens?.promptTokens).toBe(150);
    expect(view?.totals.tokens?.totalTokens).toBe(165);
    expect(view?.totals.tokens?.turns).toBe(6);
    expect(view?.totals.tokens?.contextTokens).toBe(900);
    // One under-read attempt makes the character's total under-read.
    expect(view?.totals.tokens?.source).toBe("snapshot");
    // The attempt that reported no cache figure says nothing about caching, so
    // the sum is the one that did — never 20 + 0 dressed as a full reading.
    expect(view?.totals.tokens?.cacheReadTokens).toBe(20);
    expect(view?.totals.tokens?.cacheWriteTokens).toBeNull();
  });

  test("cost keeps actual and expected apart, with the coverage beside them", () => {
    const view = characterViewOf(
      "a3",
      chain(
        { actualCost: cost(0.25), expectedCost: cost(0.3, { basis: "list-price" }) },
        // No provider figure at all: it contributes to neither sum and the
        // coverage is what says so.
        { actualCost: cost(null), expectedCost: cost(0.1, { basis: "list-price" }) },
        { actualCost: cost(0.75, { asIfMetered: true }), expectedCost: cost(null) },
      ),
    );
    expect(view?.totals.cost.actualUsd).toBeCloseTo(1.0);
    expect(view?.totals.cost.actualAttempts).toBe(2);
    expect(view?.totals.cost.expectedUsd).toBeCloseTo(0.4);
    expect(view?.totals.cost.expectedAttempts).toBe(2);
    expect(view?.totals.cost.attempts).toBe(3);
    // A subscription's own total is not a bill, and the flag is what lets the
    // page say so instead of printing a charge nobody paid.
    expect(view?.totals.cost.asIfMetered).toBe(true);
  });

  test("no attempt reporting a charge leaves the sum null", () => {
    const view = characterViewOf("a2", chain({ actualCost: cost(null) }, { actualCost: cost(null) }));
    expect(view?.totals.cost.actualUsd).toBeNull();
    expect(view?.totals.cost.actualAttempts).toBe(0);
  });

  test("a live last attempt leaves the character unended", () => {
    const view = characterViewOf(
      "a2",
      chain(
        { endedAt: 5000, terminationReason: "idle" },
        { endedAt: null, live: true, terminationReason: null, playtimeMs: 90_000 },
      ),
    );
    expect(view?.totals.endedAt).toBeNull();
    expect(view?.totals.startedAt).toBe(1000);
    expect(view?.runs[1]?.live).toBe(true);
  });

  test("an ended last attempt ends the character", () => {
    const view = characterViewOf("a2", chain({ endedAt: 5000 }, { endedAt: 9000 }));
    expect(view?.totals.endedAt).toBe(9000);
  });

  test("a stillborn launch is not an attempt and is not counted", () => {
    const runs = [
      ...chain({ questsCompleted: 4 }, { questsCompleted: 1 }),
      run({ runId: "a3", startedAt: 3000, continuedFrom: "a2", stillborn: true, questsCompleted: null }),
    ];
    const view = characterViewOf("a2", runs);
    expect(view?.runs.map((r) => r.runId)).toEqual(["a1", "a2"]);
    expect(view?.attempts).toBe(2);
    expect(view?.next).toBeNull();
    expect(view?.totals.questsCompleted).toBe(5);
  });

  test("a root naming a predecessor this viewer does not serve is truncated", () => {
    const runs = chain({ continuedFrom: "a0" }, {});
    const view = characterViewOf("a2", runs);
    expect(view?.truncated).toBe(true);
    expect(view?.characterId).toBe("a1");
    // Everything on screen is still summed — it is a lower bound, and the flag
    // is what says so.
    expect(view?.attempts).toBe(2);
    expect(characterViewOf("a2", chain({}, {}))?.truncated).toBe(false);
  });

  test("a fork serves the deeper branch, and the run on the other one keeps its own walk", () => {
    const runs = [
      ...chain({}, {}),
      run({ runId: "b3", startedAt: 3000, continuedFrom: "a2" }),
      run({ runId: "b4", startedAt: 4000, continuedFrom: "b3" }),
      // A re-launch that lost the race: it continues a2 as well, but nothing
      // continues it.
      run({ runId: "c3", startedAt: 3500, continuedFrom: "a2" }),
    ];
    expect(characterViewOf("a1", runs)?.runs.map((r) => r.runId)).toEqual(["a1", "a2", "b3", "b4"]);
    const off = characterViewOf("c3", runs);
    expect(off?.runs.map((r) => r.runId)).toEqual(["a1", "a2", "c3"]);
    expect(off?.attempt).toBe(3);
    expect(off?.next).toBeNull();
  });

  test("previous and next name the served chain, never a branch it does not list", () => {
    const runs = [
      ...chain({}, {}),
      run({ runId: "b3", startedAt: 3000, continuedFrom: "a2" }),
      run({ runId: "b4", startedAt: 4000, continuedFrom: "b3" }),
      // Later-started than b3, so the bare lineage walk would call it a2's
      // successor — while the chain served is the deeper branch through b3.
      run({ runId: "c3", startedAt: 3500, continuedFrom: "a2" }),
    ];
    const view = characterViewOf("a2", runs);
    expect(view?.runs.map((r) => r.runId)).toEqual(["a1", "a2", "b3", "b4"]);
    // The seam the feed links must be the attempt the strip lists next to it.
    expect(view?.next).toBe(view?.runs[view.attempt]?.runId);
    expect(view?.next).toBe("b3");
    expect(view?.previous).toBe("a1");
  });

  test("call counts sum over the attempts that recorded them", () => {
    const view = characterViewOf(
      "a2",
      chain({ toolCalls: 40, snippets: 3, modelResponses: 20 }, { toolCalls: null, snippets: 5, modelResponses: 11 }),
    );
    expect(view?.totals.toolCalls).toBe(40);
    expect(view?.totals.snippets).toBe(8);
    expect(view?.totals.modelResponses).toBe(31);
  });
});

describe("the public projection of a character", () => {
  const view = characterViewOf(
    "a2",
    chain(
      { questsCompleted: 3, pauseReason: "quota exhausted on account seven" },
      {
        questsCompleted: 2,
        deaths: { deaths: 2, releases: 2, resurrects: 1, first: null, last: null, sites: [] },
        actualCost: cost(0.5),
      },
    ),
  );

  const projected = projectRunDetail({
    run: {
      runId: "a2",
      model: null,
      driver: null,
      harness: null,
      shakeout: null,
      objective: null,
      campaign: null,
      cell: null,
      extra: false,
      comparability: null,
      character: null,
      race: null,
      raceName: null,
      class: null,
      className: null,
      characterLabel: null,
      platform: null,
      resolvedModel: null,
      cliVersion: null,
      apiBase: null,
      harnessVersion: null,
      startedAt: null,
      endedAt: null,
      terminationReason: null,
      terminationDetail: null,
      pauseReason: null,
      continuedFrom: "a1",
      level: null,
      xp: null,
      money: null,
      questsCompleted: null,
      items: null,
      mtime: null,
      bytes: null,
      live: false,
    },
    states: [],
    total: 0,
    tokens: tokens(),
    cost: { ...cost(null), actual: cost(null), expected: cost(null) },
    playtimeMs: null,
    character: view ?? undefined,
  }).character;

  test("the figures survive: they are already public per attempt", () => {
    expect(projected?.runs.map((r) => r.runId)).toEqual(["a1", "a2"]);
    expect(projected?.totals.questsCompleted).toBe(5);
    expect(projected?.totals.cost.actualUsd).toBeCloseTo(0.5);
  });

  /*
   * The projector is an allowlist, so what it emits is pinned rather than
   * reasoned about (the rule `viewer-public-mode.test.ts` states). The six
   * identity fields item 128 added are here because a character page has to be
   * able to name what it is about, and every one of them already rides on a
   * public runs row — but that is an argument, and this is the check.
   */
  test("the projected view emits exactly these fields, identity included", () => {
    expect(Object.keys(projected ?? {}).sort()).toEqual(
      [
        "attempt",
        "attempts",
        "characterId",
        "characterLabel",
        "driver",
        "effort",
        "harnessVersion",
        "model",
        "name",
        "next",
        "previous",
        "runs",
        "totals",
        "truncated",
      ].sort(),
    );
  });

  test("a pause reason becomes the token, and the death figures are withheld whole", () => {
    expect(projected?.runs[0]?.pauseReason).toBe("paused");
    expect(projected?.totals.deaths).toBeUndefined();
    expect(projected?.runs.every((r) => r.deaths === undefined)).toBe(true);
  });
});
