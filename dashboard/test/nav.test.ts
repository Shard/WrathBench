/** The top bar's order is the brief's: fleet second-last, about last, no home item. */
import { describe, expect, test } from "bun:test";
import { NAV } from "../src/lib/nav";

describe("NAV", () => {
  test("fleet is second-last and about is last", () => {
    const hrefs = NAV.map((n) => n.href);
    expect(hrefs.at(-2)).toBe("/fleet");
    expect(hrefs.at(-1)).toBe("/about");
  });
  test("the homepage has no nav item of its own; the brand is the home link", () => {
    expect(NAV.some((n) => n.href === "/")).toBe(false);
    expect(NAV.some((n) => n.href === "/episodes")).toBe(false);
  });
  test("hrefs are unique", () => {
    expect(new Set(NAV.map((n) => n.href)).size).toBe(NAV.length);
  });
});
