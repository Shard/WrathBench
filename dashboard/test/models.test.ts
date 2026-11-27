/**
 * The models table's pure layer. The projection is tested server-side
 * (`runner/test/models.test.ts`, `viewer/test/viewer-models.test.ts`); what is
 * pinned here is how the page phrases it, and the one lookup other pages depend
 * on — `(model, effort) → roster name`, which is the same key the projection
 * matches runs on and the only way a run page can link back to a row.
 */

import { describe, expect, test } from "bun:test";
import type { ModelRowView } from "../../viewer/api-types";
import { MODEL_COLUMNS, columnClass, modelRunCost, compareModelRows, highestTierOf, tierOf, tierTitle, countedOf, extrasOf, isPromoted, modelsHref, freeplayOf, modelTableRows, noteOf, schedulableOf, statusClass, windowParam } from "../src/lib/models";

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

describe("cells", () => {
  test("counted is shown against its target", () => {
    expect(countedOf(row().perEpisode.e90)).toBe("2/3");
    expect(countedOf(undefined)).toBe("—");
  });

  test("a status maps to a badge the stylesheet actually has", () => {
    expect(statusClass("promoted")).toBe("running");
    expect(statusClass("cooling")).toBe("draining");
    expect(statusClass("retired")).toBe("exited");
    expect(statusClass("new")).toBe("");
    expect(statusClass("active")).toBe("");
  });
});

describe("the --status columns", () => {
  test("billing, extras and the scheduler's verdict are the CLI's, phrased once", () => {
    // The header is rendered from this array, so its length is the body's
    // column count — the page's colSpan reads it rather than counting by hand.
    expect([...MODEL_COLUMNS]).toEqual(["status", "model", "tier", "platform", "harness", "e90", "e360", "freeplay", "extras", "note", "newest run"]);
    expect(MODEL_COLUMNS).not.toContain("billing");
    expect(MODEL_COLUMNS.indexOf("tier")).toBe(MODEL_COLUMNS.indexOf("model") + 1);
    expect(schedulableOf(row())).toBe("yes: schedulable on e90");
    expect(schedulableOf(row({ schedulable: { ok: false, why: "running (one character per model)", extras: false } }))).toBe("no: running (one character per model)");
    expect(extrasOf(row())).toBe(0);
    const e90 = row().perEpisode.e90!;
    expect(extrasOf(row({ perEpisode: { e90: { ...e90, extras: 2 }, e360: { ...e90, extras: 1 } } }))).toBe(3);
    // A local model's extras are freeplay runs and count here too.
    expect(extrasOf(row({ perEpisode: { e90: { ...e90, extras: 0 }, freeplay: { ...e90, extras: 2 } } }))).toBe(2);
  });

  test("the numeric columns are right-aligned in the header too", () => {
    expect(columnClass("e90")).toBe("right");
    expect(columnClass("e360")).toBe("right");
    expect(columnClass("extras")).toBe("right");
    expect(columnClass("model")).toBe("");
    expect(columnClass("newest run")).toBe("");
  });
});

describe("the tier order", () => {
  test("the highest tier is a max, not an alias for the scheduled one", () => {
    expect(highestTierOf({ declaredTier: "t1", tier: "t2" })).toBe("t2");
    // A config edit that lowers the declared tier must not read as un-climbing.
    expect(highestTierOf({ declaredTier: "t2", tier: "t1" })).toBe("t2");
    expect(highestTierOf({ declaredTier: "t0", tier: "t0" })).toBe("t0");
    expect(highestTierOf({ declaredTier: "t1", tier: "t3" })).toBe("t3");
  });

  test("the cell shows one tier, and a held witness still wears its star", () => {
    expect(tierOf(row({ declaredTier: "t1", tier: "t2", earnedPromotion: true }))).toBe("t2");
    expect(tierOf(row({ declaredTier: "t0", tier: "t0", earnedPromotion: true }))).toBe("t0*");
    expect(tierOf(row())).toBe("t1");
  });

  test("the star is the witness a pin keeps from climbing: t0's e90, a declared t2's e360, never t1 or t3 (operator, 2026-11-20)", () => {
    const t2 = { declaredTier: "t2", tier: "t2", earnedPromotion: true } as const;
    expect(tierOf(row({ ...t2, earnedDeadmines: true }))).toBe("t2*");
    expect(tierTitle(row({ ...t2, earnedDeadmines: true }))).toBe("tier t2 — has earned the Deadmines (a counted e360 reached the Deadmines level); move it to t3 to run them");
    // Only the e90 witness: a pinned t2 has already spent that, so no star.
    expect(tierOf(row(t2))).toBe("t2");
    expect(tierTitle(row(t2))).not.toContain("holds the ladder");
    expect(tierOf(row({ declaredTier: "t3", tier: "t3", earnedPromotion: true, earnedDeadmines: true }))).toBe("t3");
    expect(tierOf(row({ declaredTier: "t1", tier: "t1", earnedDeadmines: true }))).toBe("t1");
  });

  test("highest tier first, then the name — so a poll cannot reshuffle the table", () => {
    const rows = [
      row({ name: "beta", declaredTier: "t0", tier: "t0" }),
      row({ name: "alpha", declaredTier: "t1", tier: "t2" }),
      row({ name: "gamma", declaredTier: "t0", tier: "t1" }),
      row({ name: "alpha-low", declaredTier: "t0", tier: "t0" }),
    ];
    expect([...rows].sort(compareModelRows).map((r) => r.name)).toEqual([
      "alpha",
      "gamma",
      "alpha-low",
      "beta",
    ]);
  });
});

describe("promoted and highest tier agree", () => {
  test("a declared tier lowered below the scheduled one is not a climb", () => {
    // Config edit: declared t2, scheduled back to t1. highestTierOf still
    // reports t2 (the max), and isPromoted must use the same rank comparison
    // or the row would render `↑t1` beside a `t2` cell.
    const lowered = row({ declaredTier: "t2", tier: "t1" });
    expect(highestTierOf(lowered)).toBe("t2");
    expect(isPromoted(lowered)).toBe(false);
  });

  test("a witness earned while lowered still wears its star", () => {
    // The star answers "has this model earned the rung its declared tier keeps
    // it from", which is still true here, even though the row is not shown as promoted.
    expect(tierOf(row({ declaredTier: "t2", tier: "t1", earnedPromotion: true, earnedDeadmines: true }))).toBe("t2*");
    expect(tierOf(row({ declaredTier: "t2", tier: "t1", earnedPromotion: true }))).toBe("t2");
    // The hover has to say the same thing the cell does: highest tier t2,
    // scheduled lower — never "tier t1", which would contradict the `t2*`.
    expect(tierTitle(row({ declaredTier: "t2", tier: "t1", earnedPromotion: true }))).toContain("scheduled on t1");
  });
});

describe("noteOf", () => {
  test("retirement outranks cooling, cooling outranks promotion", () => {
    const retired = row({
      status: "retired",
      retired: { at: 1, reason: "10 consecutive no-progress attempts" },
      cooling: { until: 2, rung: 9, reason: "a-3: stillborn" },
      eligible: ["e90", "e360"],
    });
    expect(noteOf(retired)).toContain("retired");
    const cooling = row({
      status: "cooling",
      cooling: { until: Date.now() + 60_000, rung: 2, reason: "a-3: stillborn" },
      eligible: ["e90", "e360"],
    });
    expect(noteOf(cooling)).toContain("cooling rung 2");
    expect(noteOf(row({ eligible: ["e90", "e360"] }))).toBe("promoted to e360");
    expect(noteOf(row())).toBeNull();
  });

  test("promotion is a climb, not eligibility: a hand-placed tier never wears the badge", () => {
    expect(isPromoted(row({ declaredTier: "t1", tier: "t2", earnedPromotion: true, eligible: ["e90", "e360"] }))).toBe(true);
    // Placed on t2 by an operator: eligible for e360, but it earned nothing.
    expect(isPromoted(row({ declaredTier: "t2", tier: "t2", eligible: ["e90", "e360"] }))).toBe(false);
    // A t0 model holding a witness it may not spend is not promoted either.
    expect(isPromoted(row({ declaredTier: "t0", tier: "t0", earnedPromotion: true }))).toBe(false);
    expect(isPromoted(row())).toBe(false);
  });
});

describe("modelsHref", () => {
  test("the href is the anchor, and an unnamed model still lands on the page", () => {
    expect(modelsHref("alpha-low")).toBe("/models#alpha-low");
    expect(modelsHref("a b")).toBe("/models#a%20b");
    expect(modelsHref(null)).toBe("/models");
  });
});

describe("freeplay column", () => {
  const character = (over: Record<string, unknown> = {}) =>
    ({ characterId: "s", model: "sonnet", effort: "low", status: "paused", statusDetail: "operator-pause", level: 15, attempts: 3, latest: { runId: "s-a3" }, ...over }) as never;
  test("matches the model's character on model and effort", () => {
    expect(freeplayOf({ model: "sonnet", effort: "low" }, [character()])).not.toBeNull();
    expect(freeplayOf({ model: "sonnet", effort: null }, [character()])).toBeNull();
    expect(freeplayOf({ model: "opus", effort: "low" }, [character()])).toBeNull();
  });

  test("a row with no window keeps its character when a session moves to the driver's default window", () => {
    const row = { model: "sonnet", effort: "low", windows: ["auto", "300k"] };
    expect(freeplayOf(row, [character()])).not.toBeNull();
    expect(freeplayOf(row, [character({ compactWindow: "300k" })])).not.toBeNull();
    expect(freeplayOf(row, [character({ compactWindow: "100k" })])).toBeNull();
    // An opted-out row, and a snapshot from before the list, match their own window alone.
    expect(freeplayOf({ ...row, compactWindow: "auto", windows: ["auto"] }, [character({ compactWindow: "300k" })])).toBeNull();
    expect(freeplayOf({ model: "sonnet", effort: "low" }, [character({ compactWindow: "300k" })])).toBeNull();
    expect(freeplayOf({ model: "sonnet", effort: "low", compactWindow: "100k" }, [character({ compactWindow: "100k" })])).not.toBeNull();
  });

  test("a row's link to its runs carries the windows it owns, and nothing when that is auto alone", () => {
    expect(windowParam({ windows: ["auto", "300k"] })).toBe("auto,300k");
    expect(windowParam({ windows: ["auto"] })).toBeNull();
    expect(windowParam({ compactWindow: "auto", windows: ["auto"] })).toBeNull();
    expect(windowParam({ compactWindow: "100k", windows: ["100k"] })).toBe("100k");
    expect(windowParam({ compactWindow: "100k" })).toBe("100k");
    expect(windowParam({})).toBeNull();
  });
});

describe("modelTableRows — one row per model (operator, 2026-11-16)", () => {
  const runOf = (runId: string, startedAt: number) => ({ runId, startedAt }) as ModelRowView["runs"][number];
  test("an entry's siblings fold into the first of them in table order, with every entry's runs, newest first", () => {
    const go = row({ name: "ds-go", model: "deepseek-v4.1-flash", tier: "t1", declaredTier: "t1", siblings: ["ds-or"], runs: [runOf("go-2", 300), runOf("go-1", 100)], newestRunId: "go-2" });
    const or = row({ name: "ds-or", model: "deepseek/deepseek-v4.1-flash", tier: "t0", declaredTier: "t0", siblings: ["ds-go"], runs: [runOf("or-1", 200)], newestRunId: "or-1" });
    const alone = row({ name: "solo", model: "m", tier: "t0", declaredTier: "t0" });
    const table = modelTableRows([or, alone, go]);
    expect(table.map((t) => [t.row.name, t.also.map((a) => a.name)])).toEqual([
      ["ds-go", ["ds-or"]],
      ["solo", []],
    ]);
    expect(table[0]!.row.runs.map((r) => r.runId)).toEqual(["go-2", "or-1", "go-1"]);
    expect(table[0]!.row.newestRunId).toBe("go-2");
    // A row from a viewer that predates the field is a row of its own, as before.
    expect(modelTableRows([row({ name: "a" }), row({ name: "b" })]).map((t) => t.also.length)).toEqual([0, 0]);
  });
});

describe("modelRunCost: a run's cost in a model's panel (operator, 2026-11-18)", () => {
  const none = { usd: null, basis: "none" as const, asIfMetered: false, breakdown: null, priceId: null, asOf: null, note: "a subscription endpoint, so no actual" };
  const actual = { ...none, usd: 1.25, basis: "reported" as const, note: "the provider's own charge" };
  const expected = { usd: 0.42, basis: "list-price" as const, asIfMetered: true, asOf: "2026-11-01" };

  test("an actual says it was reported, as before", () => {
    expect(modelRunCost({ cost: { actual, expected } })).toEqual({ text: "$1.25 reported", title: "the provider's own charge" });
  });

  test("no actual: the list price, spelled as one and tilded, with the run page's line in the hover", () => {
    expect(modelRunCost({ cost: { actual: none, expected } })).toEqual({
      text: "~$0.420 as-if-metered (list price, 2026-11)",
      title: "expected, as-if-metered, 2026-11 prices · no actual\na subscription endpoint, so no actual",
    });
  });

  test("a claude-code run's own as-if-metered figure: tilded, the CLI's figure named in the hover", () => {
    const cli = { ...actual, usd: 0.031, asIfMetered: true, note: "the SDK's own total_cost_usd" };
    expect(modelRunCost({ cost: { actual: cli, expected } })).toEqual({
      text: "~$0.031 as-if-metered (reported)",
      title: "as-if-metered, the CLI's own total_cost_usd · no charge\nthe SDK's own total_cost_usd",
    });
  });

  test("no price, no cost, or a snapshot from before the estimate: a dash", () => {
    expect(modelRunCost({ cost: { actual: none, expected: { ...expected, basis: "none", usd: null } } }).text).toBe("—");
    expect(modelRunCost({ cost: { actual: none } }).text).toBe("—");
    expect(modelRunCost({ cost: null })).toEqual({ text: "—", title: "provider reports no cost for this run" });
  });
});
