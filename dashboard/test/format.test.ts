/**
 * The inventory lists the run page and map popout print (FOLLOW-UPS 50):
 * a dash for a run that never recorded items, "none" for a recorded empty
 * side, and counts only past one.
 */

import { describe, expect, test } from "bun:test";
import { fmtItems, fmtLatency } from "../src/lib/format";

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
