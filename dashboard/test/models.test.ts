/**
 * The models table's pure layer. The projection is tested server-side
 * (`runner/test/models.test.ts`, `runner/test/viewer-models.test.ts`); what is
 * pinned here is how the page phrases it, and the one lookup other pages depend
 * on — `(model, effort) → roster name`, which is the same key the projection
 * matches runs on and the only way a run page can link back to a row.
 */

import { describe, expect, test } from "bun:test";
import type { ModelRowView } from "../../runner/viewer/api-types";
import { countedOf, isPromoted, modelsHref, noteOf, rosterNameFor, statusClass } from "../src/lib/models";

function row(over: Partial<ModelRowView> = {}): ModelRowView {
  return {
    name: "alpha",
    model: "vendor/alpha",
    effort: null,
    platform: "openrouter",
    harness: "wrathbench",
    billing: "free",
    status: "active",
    eligible: ["e90"],
    perEpisode: {
      e90: {
        counted: 2,
        stillborn: 1,
        attempts: 3,
        extras: 0,
        otherSeries: 0,
        target: 3,
        bestLevel: 4,
        reachedL5: false,
        lastEnded: 1000,
        lastReason: "idle",
        runIds: ["a-2", "a-1"],
        stillbornRunIds: ["a-3"],
      },
    },
    ladder: 0,
    runs: [],
    newestRunId: "a-3",
    lastError: null,
    ...over,
  };
}

describe("cells", () => {
  test("counted is shown against its target, never merged with stillborn", () => {
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

  test("promotion is eligibility, not status text", () => {
    expect(isPromoted(row({ eligible: ["e90", "e360"] }))).toBe(true);
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
