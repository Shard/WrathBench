/**
 * The shared formatters, where a wrong answer changes what a reader takes a
 * figure to mean: a reading that was never recorded is a dash and a recorded
 * zero is a value; a cost says whose figure it is, and an estimate is marked as
 * one; a free endpoint reads as free.
 */

import { describe, expect, test } from "bun:test";
import { costMark, fmtCost, fmtItems, fmtUsd, listCost, modelDisplay, moneyCoins, num } from "../src/lib/format";

describe("not recorded is a dash; a recorded zero is a reading", () => {
  test("across every figure that can be either", () => {
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(Number.NaN)).toBe("—");
    expect(fmtUsd(0)).toBe("$0.00");
    expect(num(undefined)).toBe("—");
    expect(num(0)).toBe("0");
    expect(fmtItems(null, false)).toBe("—");
    expect(fmtItems([], true)).toBe("none");
    // An empty purse is an observation, so zero copper is the one zero kept.
    expect(moneyCoins(null)).toBeNull();
    expect(moneyCoins(0)).toEqual([{ kind: "copper", value: 0 }]);
  });
});

describe("fmtCost", () => {
  test("no cost, basis none or a null usd is the caller's blank, even with other fields set", () => {
    expect(fmtCost(null)).toBe("— (unpriced model)");
    expect(fmtCost(null, "n/a")).toBe("n/a");
    expect(fmtCost({ usd: 1, basis: "none", asIfMetered: false, asOf: null })).toBe("— (unpriced model)");
    expect(fmtCost({ usd: null, basis: "reported", asIfMetered: false, asOf: null })).toBe("— (unpriced model)");
  });

  test("the basis names itself; a backfilled claude-code actual wears a *", () => {
    expect(fmtCost({ usd: 2.5, basis: "reported", asIfMetered: false, asOf: null })).toBe("$2.50 reported");
    expect(fmtCost({ usd: 2.5, basis: "reported", asIfMetered: true, asOf: null })).toBe("$2.50 as-if-metered (reported)");
    expect(fmtCost({ usd: 0.5, basis: "list", asIfMetered: false, asOf: "2026-08-24" })).toBe("$0.500 (list price, 2026-08)");
    const backfill = { reportedUsd: 839.38, usd: 748.7, turns: 2 };
    expect(fmtCost({ usd: 1588.08, basis: "reported", asIfMetered: true, asOf: null, backfill })).toBe("$1588.08* as-if-metered (reported)");
    // Marked even where nothing could be added: the figure still reads low.
    expect(costMark({ backfill: { ...backfill, usd: null } })).toBe("*");
  });
});

describe("listCost: one run's cost cell on a listing (operator, 2026-11-18)", () => {
  const reported = { usd: 1.25, basis: "reported", asIfMetered: false, asOf: null, note: "the provider's own charge" };
  const none = { usd: null, basis: "none", asIfMetered: false, asOf: null, note: "a subscription endpoint, so no actual" };
  const listed = { usd: 0.42, basis: "list-price", asIfMetered: true, asOf: "2026-11-01", note: "row note" };
  const unpriced = { usd: null, basis: "none", asIfMetered: false, asOf: null, note: "no price on file" };

  test("an actual shows as it always has, whatever the estimate says", () => {
    expect(listCost(reported, listed, "blank")).toEqual({ usd: 1.25, figure: reported, estimate: false, text: "$1.25", title: "the provider's own charge" });
  });

  test("a claude-code run's own as-if-metered figure is nobody's charge: the tilde, and a hover naming the CLI's figure", () => {
    const cli = { usd: 0.031, basis: "reported", asIfMetered: true, asOf: null, note: "the Claude Agent SDK's own total_cost_usd for this session" };
    expect(listCost(cli, listed, "blank")).toEqual({
      usd: 0.031,
      figure: cli,
      estimate: true,
      text: "~$0.031",
      title: "as-if-metered, the CLI's own total_cost_usd · no charge\nthe Claude Agent SDK's own total_cost_usd for this session",
    });
  });

  test("no actual: the estimate, marked, then why there is no actual; no price either is a dash", () => {
    expect(listCost(none, listed, "blank")).toEqual({
      usd: 0.42,
      figure: listed,
      estimate: true,
      text: "~$0.420",
      title: "expected, as-if-metered, 2026-11 prices · no actual\na subscription endpoint, so no actual",
    });
    // A $0 list price (a free tier) is still a figure, and still marked.
    expect(listCost(none, { ...listed, usd: 0 }, "blank").text).toBe("~$0.00");
    expect(listCost(none, unpriced, "blank")).toEqual({ usd: null, figure: null, estimate: false, text: "—", title: "a subscription endpoint, so no actual" });
  });
});

describe("modelDisplay", () => {
  test("drops the provider prefix; a free endpoint reads as a billing fact; anything else stays verbatim", () => {
    expect(modelDisplay("stealth/ox-alpha")).toBe("ox-alpha");
    expect(modelDisplay("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("nemotron-3-ultra-550b-a55b (free)");
    expect(modelDisplay("poolside/laguna-s-2.1-free")).toBe("laguna-s-2.1 (free)");
    expect(modelDisplay("some/model:beta")).toBe("model:beta");
    // Never empty: a string that is all prefix comes back as it came.
    expect(modelDisplay(":free")).toBe(":free");
    expect(modelDisplay("openai/")).toBe("openai/");
  });
});
