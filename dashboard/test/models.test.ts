/**
 * The models table's pure layer. The projection is tested server-side
 * (`runner/test/models.test.ts`, `runner/test/viewer-models.test.ts`); what is
 * pinned here is how the page phrases it, and the one lookup other pages depend
 * on — `(model, effort) → roster name`, which is the same key the projection
 * matches runs on and the only way a run page can link back to a row.
 */

import { describe, expect, test } from "bun:test";
import type { ModelRowView } from "../../runner/viewer/api-types";
import { MODEL_COLUMNS, columnClass, compareModelRows, highestTierOf, tierOf, countedOf, episodesHref, extrasOf, isPromoted, modelsHref, noteOf, resultsHref, rosterNameFor, schedulableOf, statusClass } from "../src/lib/models";

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
    earnedRung1: false,
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
        reachedL5: false,
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
    expect([...MODEL_COLUMNS]).toEqual(["status", "model", "tier", "platform", "harness", "e90", "e360", "extras", "schedulable", "note", "newest run"]);
    expect(MODEL_COLUMNS).not.toContain("billing");
    expect(MODEL_COLUMNS.indexOf("tier")).toBe(MODEL_COLUMNS.indexOf("model") + 1);
    expect(schedulableOf(row())).toBe("yes: schedulable on e90");
    expect(schedulableOf(row({ schedulable: { ok: false, why: "running (one stream per model)", extras: false } }))).toBe("no: running (one stream per model)");
    expect(extrasOf(row())).toBe(0);
    const e90 = row().perEpisode.e90!;
    expect(extrasOf(row({ perEpisode: { e90: { ...e90, extras: 2 }, e360: { ...e90, extras: 1 } } }))).toBe(3);
    // A local model's extras are freeplay runs (ADR-0034) and count here too.
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
  });

  test("the cell shows one tier, and a held witness still wears its star", () => {
    expect(tierOf(row({ declaredTier: "t1", tier: "t2", earnedRung1: true }))).toBe("t2");
    expect(tierOf(row({ declaredTier: "t0", tier: "t0", earnedRung1: true }))).toBe("t0*");
    expect(tierOf(row())).toBe("t1");
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
    expect(isPromoted(row({ declaredTier: "t1", tier: "t2", earnedRung1: true, eligible: ["e90", "e360"] }))).toBe(true);
    // Placed on t2 by an operator: eligible for e360, but it earned nothing.
    expect(isPromoted(row({ declaredTier: "t2", tier: "t2", eligible: ["e90", "e360"] }))).toBe(false);
    // A t0 model holding a witness it may not spend is not promoted either.
    expect(isPromoted(row({ declaredTier: "t0", tier: "t0", earnedRung1: true }))).toBe(false);
    expect(isPromoted(row())).toBe(false);
  });
});

describe("rosterNameFor", () => {
  const rows = [
    row({ name: "alpha", model: "vendor/alpha", effort: null }),
    row({ name: "alpha-low", model: "vendor/alpha", effort: "low" }),
  ];

  test("effort is part of the key, as it is in the projection", () => {
    expect(rosterNameFor(rows, "vendor/alpha", null)).toBe("alpha");
    expect(rosterNameFor(rows, "vendor/alpha", "low")).toBe("alpha-low");
  });

  test("an unknown effort still points at the model, an unknown model at nothing", () => {
    expect(rosterNameFor(rows, "vendor/alpha", "high")).toBe("alpha");
    expect(rosterNameFor(rows, "vendor/beta")).toBeNull();
    expect(rosterNameFor(rows, null)).toBeNull();
  });

  test("the href is the anchor, and an unnamed model still lands on the page", () => {
    expect(modelsHref("alpha-low")).toBe("/models#alpha-low");
    expect(modelsHref("a b")).toBe("/models#a%20b");
    expect(modelsHref(null)).toBe("/models");
  });
});

describe("the cross-page run filter", () => {
  test("effort travels with the model, so a link cannot over-match", () => {
    expect(episodesHref({ model: "vendor/alpha", effort: "low", episode: "e90" })).toBe(
      "/episodes?episode=e90&model=vendor%2Falpha&effort=low",
    );
    // No effort is its own value — the roster entry with none — and is simply
    // absent from the query rather than being spelled as a wildcard.
    expect(episodesHref({ model: "vendor/alpha", effort: null, episode: "e90" })).toBe(
      "/episodes?episode=e90&model=vendor%2Falpha",
    );
  });

  test("the server's defaults are omitted, so a link is the shortest URL that means it", () => {
    expect(resultsHref({ harness: "all" })).toBe("/results");
    expect(resultsHref({ harness: "claude-code", episode: "all" })).toBe(
      "/results?episode=all&harness=claude-code",
    );
    expect(episodesHref({})).toBe("/episodes");
  });
});
