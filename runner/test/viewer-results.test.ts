/**
 * The results derivations behind the charts and the ladder.
 *
 * What is worth pinning is the honesty of the two numbers: a level mark carries
 * the turn and the *active* time of the first sample that showed the level, and
 * a run that cannot be scored says so through one predicate rather than each
 * page guessing.
 */

import { describe, expect, test } from "bun:test";
import type { RunRow, StatePoint } from "../viewer/api-types";
import {
  activeMsUntil,
  resultRunOf,
  levelMarks,
  mapsOf,
  trackFrom,
  turnsUsable,
  unscoredReason,
  xpEarned,
} from "../viewer/results";

function state(p: Partial<StatePoint> & { ts: number }): StatePoint {
  return {
    level: null,
    xp: null,
    map: null,
    x: null,
    y: null,
    z: null,
    eventCount: null,
    lastSeq: null,
    turn: null,
    ...p,
  };
}

function run(p: Partial<RunRow> = {}): RunRow {
  return {
    runId: "r",
    model: "m",
    driver: "openai",
    harness: "wrathbench",
    shakeout: null,
    objective: null,
    campaign: null,
    cell: null,
    extra: false,
    character: "Benchy",
    race: 1,
    raceName: "Human",
    class: 2,
    className: "Paladin",
    characterLabel: "Human Paladin",
    platform: "openrouter",
    apiBase: null,
    harnessVersion: "harness-0.2",
    comparability: null,
    startedAt: 1000,
    endedAt: null,
    terminationReason: null,
    terminationDetail: null,
    pauseReason: null,
    level: 4,
    xp: 10,
    money: null,
    questsCompleted: 3,
    items: null,
    mtime: null,
    bytes: null,
    live: false,
    ...p,
  };
}

describe("activeMsUntil", () => {
  const segments = [
    { start: 1000, end: 3000 },
    { start: 9000, end: 10_000 },
  ];

  test("charges only the segments that had started", () => {
    expect(activeMsUntil(segments, 2000)).toBe(1000);
    expect(activeMsUntil(segments, 5000)).toBe(2000); // the pause is not charged
    expect(activeMsUntil(segments, 9500)).toBe(2500);
    expect(activeMsUntil(segments, 99_999)).toBe(3000);
  });

  test("an open segment is charged only up to the cursor", () => {
    expect(activeMsUntil([{ start: 1000, end: null }], 4000)).toBe(3000);
  });

  test("no segments is not zero — it is unknown", () => {
    expect(activeMsUntil([], 5000)).toBeNull();
  });
});

describe("levelMarks", () => {
  test("takes each level at its first sighting, with turn and active time", () => {
    const marks = levelMarks(
      [
        state({ ts: 1000, level: 1, turn: 1 }),
        state({ ts: 1500, level: null, turn: 2 }),
        state({ ts: 2000, level: 2, turn: 4 }),
        state({ ts: 2500, level: 2, turn: 6 }),
        state({ ts: 9500, level: 3, turn: 40 }),
      ],
      [
        { start: 1000, end: 3000 },
        { start: 9000, end: 10_000 },
      ],
    );
    expect(marks.map((m) => m.level)).toEqual([1, 2, 3]);
    expect(marks.map((m) => m.turn)).toEqual([1, 4, 40]);
    // Level 3 is 500ms into the second segment, not 8.5s of wall clock.
    expect(marks[2]!.playtimeMs).toBe(2500);
  });

  test("a stale sample from a rebuilt cache never walks the series backwards", () => {
    const marks = levelMarks([
      state({ ts: 1, level: 5 }),
      state({ ts: 2, level: 3 }),
      state({ ts: 3, level: 6 }),
    ]);
    expect(marks.map((m) => m.level)).toEqual([5, 6]);
  });

  test("levels are null-safe and zero is not a level", () => {
    expect(levelMarks([state({ ts: 1 }), state({ ts: 2, level: 0 })])).toEqual([]);
  });

  test("an old run with no turn column still marks levels, with a null turn", () => {
    const marks = levelMarks([state({ ts: 5, level: 2 })]);
    expect(marks[0]!.turn).toBeNull();
    expect(marks[0]!.playtimeMs).toBeNull();
  });
});

describe("turnsUsable", () => {
  test("a series that only climbs is usable, gaps and nulls included", () => {
    expect(turnsUsable([state({ ts: 1, turn: 1 }), state({ ts: 2 }), state({ ts: 3, turn: 9 })])).toBe(
      true,
    );
    expect(turnsUsable([])).toBe(true);
  });

  test("a counter that restarted mid-run makes the whole index unusable", () => {
    // What a resume by a build without the cumulative offset leaves behind.
    const states = [
      state({ ts: 1, level: 2, turn: 40 }),
      state({ ts: 2, level: 3, turn: 3 }),
    ];
    expect(turnsUsable(states)).toBe(false);
    // And the marks say "no turn index" rather than crediting L3 to turn 3.
    expect(levelMarks(states).map((m) => m.turn)).toEqual([null, null]);
  });
});

describe("mapsOf / trackFrom", () => {
  test("maps are deduplicated and sorted", () => {
    expect(mapsOf([state({ ts: 1, map: 530 }), state({ ts: 2, map: 0 }), state({ ts: 3, map: 530 })])).toEqual([
      0, 530,
    ]);
  });

  test("the track keeps only samples that carried a position", () => {
    const points = trackFrom([
      state({ ts: 1, map: 0, x: 1, y: 2, level: 3, turn: 7 }),
      state({ ts: 2, level: 4 }),
      state({ ts: 3, map: 0, x: 5, y: 6 }),
    ]);
    expect(points.map((p) => p.ts)).toEqual([1, 3]);
    expect(points[0]).toMatchObject({ x: 1, y: 2, level: 3, turn: 7 });
  });
});

describe("unscoredReason", () => {
  test("a plain openai run is scorable", () => {
    expect(unscoredReason(run())).toBeNull();
  });

  test("a stub stamp, a stub driver and an objective each disqualify; the claude-code harness does not", () => {
    expect(unscoredReason(run({ shakeout: "unscored (scripted stub)" }))).toContain("stub");
    // Even with no stamp: the stub is scripted.
    expect(unscoredReason(run({ driver: "stub", shakeout: null }))).toContain("stub");
    expect(unscoredReason(run({ objective: "walk to Ironforge" }))).toContain("objective");
    // ADR-0035: a claude-code run is a tagged row, not an excluded one.
    expect(unscoredReason(run({ driver: "claude-code", harness: "claude-code", shakeout: null }))).toBeNull();
  });

  test("a lapsed run is an attempt, never a recorded episode (ADR-0049)", () => {
    // It is on the runs page with its reason, and out of every chart over
    // episodes — the ladder reads exactly this predicate.
    expect(unscoredReason(run({ terminationReason: "attempt-failed" }))).toBe("unscored (attempt-failed)");
    expect(unscoredReason(run({ terminationReason: "stale" }))).toBe("unscored (stale)");
    // The same predicate the scheduler writes runs off with, so an operator cut
    // and a harness defect are partial episodes here too — they used to reach
    // the ladder with whatever level they had at the moment they were stopped.
    expect(unscoredReason(run({ terminationReason: "manual" }))).toBe("unscored (manual)");
    expect(unscoredReason(run({ terminationReason: "harness-error" }))).toBe("unscored (harness-error)");
    expect(unscoredReason(run({ terminationReason: "stale-character" }))).toBe("unscored (stale-character)");
    // A run that ended on its own clock is untouched.
    expect(unscoredReason(run({ terminationReason: "episode-limit" }))).toBeNull();
  });
});

describe("resultRunOf", () => {
  test("projects identity, comparability fields and the level series", () => {
    const e = resultRunOf(
      run({
        comparability: {
          harnessVersion: "harness-0.2",
          promptHash: "sha256:abc",
          promptChars: 10,
          harness: "wrathbench",
          effort: "high",
          budget: {
            maxTurns: null,
            maxToolCalls: 500,
            idleMs: 1,
            noXpMs: null,
            episodeMs: 2,
            maxSandboxRestarts: 3,
          },
          objective: false,
          wikiCoords: true,
          serverBuild: { build: "harness-0.2-1-gabc", startedAtMs: 1 },
        },
      }),
      [state({ ts: 1000, level: 1, turn: 1, map: 0 }), state({ ts: 2000, level: 5, turn: 9, map: 0 })],
      [{ start: 1000, end: 3000 }],
    );
    expect(e.effort).toBe("high");
    expect(e.harness).toBe("wrathbench");
    expect(e.promptHash).toBe("sha256:abc");
    expect(e.serverBuild).toBe("harness-0.2-1-gabc");
    expect(e.wikiCoords).toBe(true);
    expect(e.unscored).toBeNull();
    expect(e.maxLevel).toBe(5);
    expect(e.maps).toEqual([0]);
    expect(e.levels).toHaveLength(2);
  });

  test("the listing facts ride on the row, and default to null when not supplied", () => {
    const bare = resultRunOf(run({ character: "Fixturely", pauseReason: "quota-exhausted" }), [], []);
    expect(bare.character).toBe("Fixturely");
    // The runs page's status column reads these; they are the listing's own, not recomputed.
    expect(bare.live).toBe(false);
    expect(bare.endedAt).toBe(run().endedAt);
    expect(bare.pauseReason).toBe("quota-exhausted");
    expect(bare.playtimeMs).toBeNull();
    expect(bare.tokens).toBeNull();
    expect(bare.actualCost).toBeNull();

    const listed = resultRunOf(run(), [], [], null, {
      playtimeMs: 60_000,
      tokens: null,
      actualCost: { usd: 0.5, basis: "reported", asIfMetered: false, breakdown: null, priceId: null, asOf: null, note: "provider-reported" },
    });
    expect(listed.playtimeMs).toBe(60_000);
    expect(listed.actualCost?.usd).toBe(0.5);
    // The expected figure is its own field, and null from a caller that predates it.
    expect(listed.expectedCost).toBeNull();
    const priced = resultRunOf(run(), [], [], null, {
      playtimeMs: null,
      tokens: null,
      actualCost: null,
      expectedCost: { usd: 0, basis: "list-price", asIfMetered: true, breakdown: null, priceId: "free", asOf: "2026-08-22", note: "free tier" },
    });
    expect(priced.expectedCost?.usd).toBe(0);
    expect(priced.expectedCost?.asIfMetered).toBe(true);
  });

  test("xpEarned rides on the row as the run page's lower bound", () => {
    const e = resultRunOf(run(), [
      state({ ts: 1000, level: 1, xp: 300 }),
      state({ ts: 2000, level: 2, xp: 50 }),
    ], []);
    expect(e.xpEarned).toBe(350);
    expect(resultRunOf(run(), [], []).xpEarned).toBeNull();
  });

  test("falls back to the run's own level when no sample carried one", () => {
    expect(resultRunOf(run({ level: 7 }), [], []).maxLevel).toBe(7);
  });

  test("xp is the furthest reading at the run's highest level, and money is the last one", () => {
    const e = resultRunOf(run({ money: 4_242 }), [
      state({ ts: 1000, level: 4, xp: 9_000 }),
      state({ ts: 2000, level: 5, xp: 100 }),
      state({ ts: 3000, level: 5, xp: 700 }),
    ], []);
    expect(e.maxLevel).toBe(5);
    // Not 9_000: xp resets at every ding, so only the reading at L5 pairs with it.
    expect(e.xp).toBe(700);
    expect(e.money).toBe(4_242);
  });

  test("an xp read at another level is never paired with the max level", () => {
    // The newest sample's level is the run's level, so run.xp only applies when
    // the two agree; here no sample carried the max level's xp at all.
    const e = resultRunOf(run({ level: 3, xp: 55 }), [state({ ts: 1000, level: 3 })], []);
    expect(e.maxLevel).toBe(3);
    expect(e.xp).toBe(55);
    expect(resultRunOf(run({ level: 2, xp: 55 }), [state({ ts: 1000, level: 3 })], []).xp).toBeNull();
  });
});

describe("xpEarned", () => {
  test("sums the last observed xp of every level below, plus the xp within the top one", () => {
    const states = [
      state({ ts: 1, level: 1, xp: 100 }),
      state({ ts: 2, level: 1, xp: 350 }),
      state({ ts: 3, level: 2, xp: 20 }),
      state({ ts: 4, level: 2, xp: 400 }),
      state({ ts: 5, level: 4, xp: 10 }), // a two-level jump between samples: one fold, never an invented level
    ];
    expect(xpEarned(states)).toBe(350 + 400 + 10);
  });

  test("reads level and xp off the same sample, sorts by time, and never dips", () => {
    expect(xpEarned([state({ ts: 2, level: 2, xp: 5 }), state({ ts: 1, level: 1, xp: 90 })])).toBe(95);
    expect(xpEarned([state({ ts: 1, level: 1, xp: 90 }), state({ ts: 2, level: 1, xp: 40 })])).toBe(90);
    expect(xpEarned([state({ ts: 1, level: 1 }), state({ ts: 2, xp: 40 })])).toBeNull();
    expect(xpEarned([])).toBeNull();
  });
});
