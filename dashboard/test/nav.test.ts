/** The top bar's order is the brief's: about last, no home item, and no fleet — it moved into the status popout. */
import { describe, expect, test } from "bun:test";
import { NAV } from "../src/lib/nav";

describe("NAV", () => {
  test("about is last", () => {
    expect(NAV.map((n) => n.href).at(-1)).toBe("/about");
  });
  test("fleet is not a nav item; the status popout is the way to it", () => {
    expect(NAV.some((n) => n.href === "/fleet")).toBe(false);
  });
  test("the homepage has no nav item of its own; the brand is the home link", () => {
    expect(NAV.some((n) => n.href === "/")).toBe(false);
    expect(NAV.some((n) => n.href === "/episodes")).toBe(false);
  });
  test("hrefs are unique", () => {
    expect(new Set(NAV.map((n) => n.href)).size).toBe(NAV.length);
  });
});
