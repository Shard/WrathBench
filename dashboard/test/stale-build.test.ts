/**
 * The stale-build notice (item 64).
 *
 * Vite empties `dist/` on every build, so an open tab keeps executing whatever
 * JavaScript it loaded while the files behind it have been replaced. The cost
 * is not a crash — it is a bug report describing code that no longer exists.
 * The comparison is deliberately "what this tab loaded" against "what is served
 * now", never "newest against previous": the second would go quiet the moment
 * the tab polled twice.
 */

import { describe, expect, test } from "bun:test";
import { isStaleBuild } from "../src/lib/feeds";

describe("isStaleBuild", () => {
  test("a differing served build is stale", () => {
    expect(isStaleBuild("index-AAA.js", "index-BBB.js")).toBe(true);
  });

  test("the same build is not", () => {
    expect(isStaleBuild("index-AAA.js", "index-AAA.js")).toBe(false);
  });

  test("an unidentifiable build never nags, on either side", () => {
    // A dashboard served without an entry script, or a viewer too old to carry
    // the field, is "cannot tell". Warning there would train the operator to
    // ignore the banner, which costs more than the staleness it reports.
    expect(isStaleBuild(null, "index-BBB.js")).toBe(false);
    expect(isStaleBuild("index-AAA.js", null)).toBe(false);
    expect(isStaleBuild(undefined, "index-BBB.js")).toBe(false);
    expect(isStaleBuild("index-AAA.js", undefined)).toBe(false);
    expect(isStaleBuild(null, null)).toBe(false);
  });
});
