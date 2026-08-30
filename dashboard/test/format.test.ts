/**
 * The inventory lists the run page and map popout print (FOLLOW-UPS 50):
 * a dash for a run that never recorded items, "none" for a recorded empty
 * side, and counts only past one.
 */

import { describe, expect, test } from "bun:test";
import { fmtCost, fmtDuration, fmtElapsed, fmtItems, fmtLatency, fmtToolCallBudget, fmtTokens, fmtTps, fmtUsd, fmtWhen, modelDisplay, num, resolvedLabel, shortHarness, COST_BASIS_NOTE } from "../src/lib/format";

describe("fmtItems", () => {
  const items = [
    { name: "Worn Mace", count: 1, equipped: true },
    { name: "Hearthstone", count: 1, equipped: false },
    { name: "Tough Jerky", count: 5, equipped: false },
  ];

  test("splits worn from carried and shows counts past one", () => {
    expect(fmtItems(items, false)).toBe("Hearthstone, Tough Jerky ×5");
    expect(fmtItems(items, true)).toBe("Worn Mace");
  });

  test("null is unrecorded, an empty side is none", () => {
    expect(fmtItems(null, false)).toBe("—");
    expect(fmtItems([], true)).toBe("none");
  });
});

/**
 * The feed's latency figure: sub-second in ms, sub-minute with one decimal,
 * m:ss past that — and empty (not a dash) when there is nothing to say, since
 * it renders inline in an already crowded header.
 */
describe("fmtLatency", () => {
  test("scales through its three forms", () => {
    expect(fmtLatency(840)).toBe("840ms");
    expect(fmtLatency(12_340)).toBe("12.3s");
    expect(fmtLatency(124_000)).toBe("2m04s");
  });

  test("the seconds form never rounds up to a fake 60.0s", () => {
    expect(fmtLatency(59_960)).toBe("1m00s");
    expect(fmtLatency(59_900)).toBe("59.9s");
  });

  test("unknown and negative are empty, zero is a reading", () => {
    expect(fmtLatency(null)).toBe("");
    expect(fmtLatency(-5)).toBe("");
    expect(fmtLatency(0)).toBe("0ms");
  });
});

describe("fmtUsd", () => {
  test("missing is a dash, a recorded zero is a priced $0.00", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(undefined)).toBe("—");
    expect(fmtUsd(0)).toBe("$0.00");
  });

  test("three decimals under a dollar, two at or above", () => {
    expect(fmtUsd(0.0041)).toBe("$0.004");
    expect(fmtUsd(0.999)).toBe("$0.999");
    expect(fmtUsd(1)).toBe("$1.00");
    expect(fmtUsd(12.345)).toBe("$12.35");
  });

  test("non-finite is unrecorded", () => {
    expect(fmtUsd(Number.NaN)).toBe("—");
    expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("fmtCost", () => {
  test("no cost at all falls back to the caller's blank", () => {
    expect(fmtCost(null)).toBe("— (unpriced model)");
    expect(fmtCost(undefined)).toBe("— (unpriced model)");
    expect(fmtCost(null, "n/a")).toBe("n/a");
  });

  test("basis none or a null usd is also blank, even with other fields set", () => {
    expect(fmtCost({ usd: 1, basis: "none", asIfMetered: false, asOf: null })).toBe("— (unpriced model)");
    expect(fmtCost({ usd: null, basis: "reported", asIfMetered: false, asOf: null })).toBe("— (unpriced model)");
  });

  test("reported basis names itself, as-if-metered or not", () => {
    expect(fmtCost({ usd: 2.5, basis: "reported", asIfMetered: false, asOf: null })).toBe("$2.50 reported");
    expect(fmtCost({ usd: 2.5, basis: "reported", asIfMetered: true, asOf: null })).toBe("$2.50 as-if-metered (reported)");
  });

  test("list-price basis carries the server's date, or says undated", () => {
    expect(fmtCost({ usd: 0.5, basis: "list", asIfMetered: false, asOf: "2026-08-24" })).toBe(
      "$0.500 (list price, 2026-08)",
    );
    expect(fmtCost({ usd: 0.5, basis: "list", asIfMetered: true, asOf: null })).toBe(
      "$0.500 as-if-metered (list price, undated)",
    );
  });
});

describe("fmtTokens", () => {
  test("missing is a dash, small counts print exactly", () => {
    expect(fmtTokens(null)).toBe("—");
    expect(fmtTokens(undefined)).toBe("—");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  test("thousands and millions round at the thresholds", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(9999)).toBe("10.0k");
    expect(fmtTokens(10_000)).toBe("10k");
    expect(fmtTokens(999_999)).toBe("1000k");
    expect(fmtTokens(1_000_000)).toBe("1.00M");
    expect(fmtTokens(2_500_000)).toBe("2.50M");
  });
});

describe("fmtWhen", () => {
  const now = 1_000_000_000;

  test("missing is a dash, and the future reads as just now", () => {
    expect(fmtWhen(null, now)).toBe("—");
    expect(fmtWhen(now + 5000, now)).toBe("just now");
  });

  test("steps from just now through days", () => {
    expect(fmtWhen(now - 30_000, now)).toBe("just now");
    expect(fmtWhen(now - 5 * 60_000, now)).toBe("5m ago");
    expect(fmtWhen(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(fmtWhen(now - 24 * 3_600_000, now)).toBe("yesterday");
    expect(fmtWhen(now - 3 * 24 * 3_600_000, now)).toBe("3d ago");
  });
});

describe("num", () => {
  test("missing is a dash, a recorded zero prints as 0", () => {
    expect(num(null)).toBe("—");
    expect(num(undefined)).toBe("—");
    expect(num(0)).toBe("0");
    expect(num(42)).toBe("42");
  });
});

describe("shortHarness", () => {
  test("missing or empty is a dash", () => {
    expect(shortHarness(null)).toBe("—");
    expect(shortHarness(undefined)).toBe("—");
    expect(shortHarness("")).toBe("—");
  });

  test("strips the harness- prefix and leaves the rest alone", () => {
    expect(shortHarness("harness-0.5-1-gabc")).toBe("0.5-1-gabc");
    expect(shortHarness("0.5-1-gabc")).toBe("0.5-1-gabc");
  });
});

describe("fmtDuration", () => {
  test("null, non-finite and negative are all unrecorded", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(Number.NaN)).toBe("—");
    expect(fmtDuration(-1)).toBe("—");
  });

  test("minutes and seconds under an hour, hours and minutes at and past it", () => {
    expect(fmtDuration(0)).toBe("0m00s");
    expect(fmtDuration(65_000)).toBe("1m05s");
    expect(fmtDuration(3_600_000)).toBe("1h00m");
    expect(fmtDuration(3_600_000 + 90_000)).toBe("1h01m");
  });
});

describe("fmtTps", () => {
  test("no rate is a dash, never a zero", () => {
    expect(fmtTps(null)).toBe("—");
    expect(fmtTps(undefined)).toBe("—");
    expect(fmtTps(Number.NaN)).toBe("—");
  });

  test("a decimal where it reads, none where it does not", () => {
    expect(fmtTps(0)).toBe("0.0");
    expect(fmtTps(12.44)).toBe("12.4");
    expect(fmtTps(99.94)).toBe("99.9");
    expect(fmtTps(340.2)).toBe("340");
  });
});

describe("fmtToolCallBudget", () => {
  test("null reads as unlimited, a number keeps the label it always had", () => {
    // The run page's episode-budget line already spells a null `maxTurns`
    // "unlimited turns"; the ceiling now has the same two states and reads the
    // same way, so the policy freeplay lane is legible on its own page.
    expect(fmtToolCallBudget(null)).toBe("unlimited tool calls");
    expect(fmtToolCallBudget(500)).toBe("500 tool calls");
    expect(fmtToolCallBudget(3000)).toBe("3000 tool calls");
  });
});

describe("resolvedLabel", () => {
  test("says the served id only when it differs from what was asked for", () => {
    // The case it exists for: an alias the CLI resolved at launch.
    expect(resolvedLabel("sonnet", "claude-sonnet-5")).toBe("claude-sonnet-5");
    // A slug served as itself is already printed; saying it twice is noise.
    expect(resolvedLabel("z-ai/glm-5.2", "z-ai/glm-5.2")).toBeNull();
    // Not recorded stays silent rather than echoing the config string.
    expect(resolvedLabel("sonnet", null)).toBeNull();
    expect(resolvedLabel("sonnet", undefined)).toBeNull();
    expect(resolvedLabel(null, "claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

describe("fmtElapsed", () => {
  test("m:ss before an hour, h:mm:ss after it", () => {
    expect(fmtElapsed(0)).toBe("0:00");
    expect(fmtElapsed(9_000)).toBe("0:09");
    expect(fmtElapsed(754_000)).toBe("12:34");
    expect(fmtElapsed(3_599_000)).toBe("59:59");
    expect(fmtElapsed(3_600_000)).toBe("1:00:00");
    expect(fmtElapsed(3_922_000)).toBe("1:05:22");
    expect(fmtElapsed(36_000_000)).toBe("10:00:00");
  });

  test("truncated, never rounded: an entry 59.9s in belongs to 0:59", () => {
    expect(fmtElapsed(59_900)).toBe("0:59");
    expect(fmtElapsed(999)).toBe("0:00");
  });

  test("a span before the run's own start clamps to zero rather than printing a minus", () => {
    expect(fmtElapsed(-1)).toBe("0:00");
    expect(fmtElapsed(-90_000)).toBe("0:00");
  });

  test("nothing to measure is the dash, as everywhere else in this file", () => {
    expect(fmtElapsed(null)).toBe("—");
    expect(fmtElapsed(Number.NaN)).toBe("—");
    expect(fmtElapsed(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("COST_BASIS_NOTE", () => {
  test("says a claude-code cost is reported and as-if-metered, and never calls it list price", () => {
    expect(COST_BASIS_NOTE).toContain("as-if-metered");
    expect(COST_BASIS_NOTE).toContain("Claude SDK reports");
    expect(COST_BASIS_NOTE).not.toContain("list price");
  });
});

describe("modelDisplay", () => {
  test("drops the provider prefix and keeps the model's own version", () => {
    expect(modelDisplay("stealth/ox-alpha")).toBe("ox-alpha");
    expect(modelDisplay("z-ai/glm-4.7-flash")).toBe("glm-4.7-flash");
    expect(modelDisplay("deepseek/deepseek-v4-pro-0813")).toBe("deepseek-v4-pro-0813");
  });

  test("a :free tag reads as a billing fact, not part of the name", () => {
    expect(modelDisplay("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("nemotron-3-ultra-550b-a55b (free)");
    expect(modelDisplay("poolside/laguna-s-2.1:free")).toBe("laguna-s-2.1 (free)");
  });

  test("any other tag stays verbatim — we do not know what it means", () => {
    expect(modelDisplay("some/model:beta")).toBe("model:beta");
  });

  test("a name with no prefix is already short, version stamps and all", () => {
    expect(modelDisplay("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(modelDisplay("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(modelDisplay("sonnet")).toBe("sonnet");
    expect(modelDisplay("hy3-free")).toBe("hy3-free");
  });

  test("never returns empty: a string that is all prefix comes back as it came", () => {
    expect(modelDisplay("openai/")).toBe("openai/");
    expect(modelDisplay(":free")).toBe(":free");
    expect(modelDisplay("foo/:free")).toBe("foo/:free");
    expect(modelDisplay("")).toBe("");
  });

  test("only the last slash counts", () => {
    expect(modelDisplay("a/b/c-1")).toBe("c-1");
  });
});

test("modelDisplay: a baked-in -free suffix reads the same as :free", () => {
  expect(modelDisplay("hy3-free")).toBe("hy3 (free)");
  expect(modelDisplay("poolside/laguna-s-2.1-free")).toBe("laguna-s-2.1 (free)");
  expect(modelDisplay("-free")).toBe("-free");
});
