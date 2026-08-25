/**
 * The inventory lists the run page and map popout print (FOLLOW-UPS 50):
 * a dash for a run that never recorded items, "none" for a recorded empty
 * side, and counts only past one.
 */

import { describe, expect, test } from "bun:test";
import { fmtCost, fmtDuration, fmtItems, fmtTokens, fmtTps, fmtUsd, fmtWhen, num, shortHarness } from "../src/lib/format";

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
