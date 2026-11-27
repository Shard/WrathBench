/**
 * The models table's pure layer. The projection is tested server-side
 * (`runner/test/models.test.ts`, `viewer/test/viewer-models.test.ts`); what is
 * pinned here is what the page claims about a model: its tier and promotion,
 * one row per model, and which cost figure a run is shown with.
 */

import { describe, expect, test } from "bun:test";
import type { ModelRowView } from "../../viewer/api-types-runner";
import { modelRunCost, highestTierOf, tierOf, tierTitle, isPromoted, freeplayOf, modelTableRows } from "../src/lib/models";

function row(over: Partial<ModelRowView> = {}): ModelRowView {
  return {
    name: "alpha",
    model: "vendor/alpha",
    effort: null,
    platform: "openrouter",
    harness: "wrathbench",
    billing: "free",
    declaredTier: "t1",
    tier: "t1",
    earnedPromotion: false,
    idle: "none",
    status: "active",
    eligible: ["e90"],
    perEpisode: {
      e90: {
        counted: 2,
        attempts: 3,
        extras: 0,
        otherSeries: 0,
        target: 3,
        bestLevel: 4,
        countedLevel: null,
        lastEnded: 1000,
        lastReason: "idle",
        runIds: ["a-2", "a-1"],
      },
    },
    ladder: 0,
    schedulable: { ok: true, why: "schedulable on e90", extras: false },
    runs: [],
    newestRunId: "a-3",
    lastError: null,
    ...over,
  };
}

describe("the tier a row claims", () => {
  test("the highest tier is a max, and a declared tier lowered below the scheduled one is not a climb", () => {
    expect(highestTierOf({ declaredTier: "t1", tier: "t2" })).toBe("t2");
    expect(highestTierOf({ declaredTier: "t2", tier: "t1" })).toBe("t2");
    expect(isPromoted(row({ declaredTier: "t2", tier: "t1" }))).toBe(false);
    // The hover says the same thing the cell does: never "tier t1" beside a `t2`.
    expect(tierTitle(row({ declaredTier: "t2", tier: "t1", earnedPromotion: true }))).toContain("scheduled on t1");
  });

  test("the star is the witness a pin keeps from climbing: t0's e90, a declared t2's e360, never t1 or t3", () => {
    expect(tierOf(row({ declaredTier: "t0", tier: "t0", earnedPromotion: true }))).toBe("t0*");
    expect(tierOf(row({ declaredTier: "t1", tier: "t2", earnedPromotion: true }))).toBe("t2");
    expect(tierOf(row({ declaredTier: "t2", tier: "t2", earnedPromotion: true, earnedDeadmines: true }))).toBe("t2*");
    expect(tierOf(row({ declaredTier: "t2", tier: "t2", earnedPromotion: true }))).toBe("t2");
    expect(tierOf(row({ declaredTier: "t3", tier: "t3", earnedPromotion: true, earnedDeadmines: true }))).toBe("t3");
    expect(tierOf(row({ declaredTier: "t1", tier: "t1", earnedDeadmines: true }))).toBe("t1");
  });

  test("promotion is a climb, not eligibility: a hand-placed tier never wears the badge", () => {
    expect(isPromoted(row({ declaredTier: "t1", tier: "t2", earnedPromotion: true, eligible: ["e90", "e360"] }))).toBe(true);
    expect(isPromoted(row({ declaredTier: "t2", tier: "t2", eligible: ["e90", "e360"] }))).toBe(false);
    expect(isPromoted(row({ declaredTier: "t0", tier: "t0", earnedPromotion: true }))).toBe(false);
  });
});

describe("rows", () => {
  test("an entry's siblings fold into the first of them in table order, with every entry's runs, newest first", () => {
    const runOf = (runId: string, startedAt: number) => ({ runId, startedAt }) as ModelRowView["runs"][number];
    const go = row({ name: "ds-go", model: "deepseek-v4.1-flash", tier: "t1", declaredTier: "t1", siblings: ["ds-or"], runs: [runOf("go-2", 300), runOf("go-1", 100)], newestRunId: "go-2" });
    const or = row({ name: "ds-or", model: "deepseek/deepseek-v4.1-flash", tier: "t0", declaredTier: "t0", siblings: ["ds-go"], runs: [runOf("or-1", 200)], newestRunId: "or-1" });
    const alone = row({ name: "solo", model: "m", tier: "t0", declaredTier: "t0" });
    const table = modelTableRows([or, alone, go]);
    expect(table.map((t) => [t.row.name, t.also.map((a) => a.name)])).toEqual([
      ["ds-go", ["ds-or"]],
      ["solo", []],
    ]);
    expect(table[0]!.row.runs.map((r) => r.runId)).toEqual(["go-2", "or-1", "go-1"]);
  });

  test("the freeplay column matches the model's character on model, effort and window", () => {
    const character = (over: Record<string, unknown> = {}) =>
      ({ characterId: "s", model: "sonnet", effort: "low", status: "paused", statusDetail: "operator-pause", level: 15, attempts: 3, latest: { runId: "s-a3" }, ...over }) as never;
    expect(freeplayOf({ model: "sonnet", effort: "low" }, [character()])).not.toBeNull();
    expect(freeplayOf({ model: "sonnet", effort: null }, [character()])).toBeNull();
    expect(freeplayOf({ model: "opus", effort: "low" }, [character()])).toBeNull();
    const owns = { model: "sonnet", effort: "low", windows: ["auto", "300k"] };
    expect(freeplayOf(owns, [character({ compactWindow: "300k" })])).not.toBeNull();
    expect(freeplayOf(owns, [character({ compactWindow: "100k" })])).toBeNull();
  });
});

describe("modelRunCost: a run's cost in a model's panel", () => {
  const none = { usd: null, basis: "none" as const, asIfMetered: false, breakdown: null, priceId: null, asOf: null, note: "a subscription endpoint, so no actual" };
  const actual = { ...none, usd: 1.25, basis: "reported" as const, note: "the provider's own charge" };
  const expected = { usd: 0.42, basis: "list-price" as const, asIfMetered: true, asOf: "2026-11-01" };

  test("an actual says it was reported; without one the list price is tilded and says it is one", () => {
    expect(modelRunCost({ cost: { actual, expected } })).toEqual({ text: "$1.25 reported", title: "the provider's own charge" });
    expect(modelRunCost({ cost: { actual: none, expected } })).toEqual({
      text: "~$0.420 as-if-metered (list price, 2026-11)",
      title: "expected, as-if-metered, 2026-11 prices · no actual\na subscription endpoint, so no actual",
    });
    // A claude-code run's own as-if-metered figure is not a charge either.
    const cli = { ...actual, usd: 0.031, asIfMetered: true, note: "the SDK's own total_cost_usd" };
    expect(modelRunCost({ cost: { actual: cli, expected } }).text).toBe("~$0.031 as-if-metered (reported)");
  });

  test("no price, no cost, or a snapshot from before the estimate: a dash", () => {
    expect(modelRunCost({ cost: { actual: none, expected: { ...expected, basis: "none", usd: null } } }).text).toBe("—");
    expect(modelRunCost({ cost: { actual: none } }).text).toBe("—");
    expect(modelRunCost({ cost: null }).text).toBe("—");
  });
});
