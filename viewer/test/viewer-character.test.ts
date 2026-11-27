/**
 * Aggregating a freeplay character at read time (`viewer/character.ts`).
 *
 * The rules under test are the ones that decide what a number on the run page
 * MEANS: a tally sums, a state comes from the furthest attempt, and a kind no
 * attempt recorded reads null rather than zero — so a character whose oldest
 * attempts predate a column is not reported as having done less than it did.
 * The chain walk itself is `viewer-lineage.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { CostFigure, DeathFacts, ResultRun, TokenTotals } from "../api-types";
import { characterViewOf } from "../character";
import { projectRunDetail } from "../public-projection";

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

  /*
   * The projector is an allowlist, so what it emits is pinned rather than
   * reasoned about (the rule `viewer-public-mode.test.ts` states). The six
   * the identity fields added are here because a character page has to be
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
        "episode",
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

  test("a pause reason becomes the token, and the deaths are the count the card prints", () => {
    expect(projected?.runs[0]?.pauseReason).toBe("paused");
    // Deaths are public (operator, 2026-10-18): the character's total ships,
    // and the per-attempt count, which no page reads, does not.
    expect(projected?.totals.deaths).toEqual({ deaths: 2 } as DeathFacts);
    expect(projected?.runs.every((r) => r.deaths === undefined)).toBe(true);
  });
});
