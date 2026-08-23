/**
 * The inventory lists the run page and map popout print (FOLLOW-UPS 50):
 * a dash for a run that never recorded items, "none" for a recorded empty
 * side, and counts only past one.
 */

import { describe, expect, test } from "bun:test";
import { fmtItems } from "../src/lib/format";

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
