/** The top bar's order is the brief's: about last, no home item, and no fleet — it moved into the status popout. */
import { describe, expect, test } from "bun:test";
import { CONFIG_NAV, NAV, navItems } from "../src/lib/nav";

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

/**
 * The operator's config page is not in `NAV` at all: the routes behind it are
 * not mounted in public mode, and a reader who cannot use it should not be
 * told it exists (item 134).
 */
describe("navItems", () => {
  test("a public build or a public viewer gets the reader's bar, unchanged", () => {
    expect(navItems(false)).toEqual(NAV);
    expect(NAV.some((n) => n.href === "/config")).toBe(false);
  });

  test("an operator gets config, and about is still last", () => {
    const items = navItems(true);
    expect(items).toContain(CONFIG_NAV);
    expect(items.at(-1)?.href).toBe("/about");
    expect(items.length).toBe(NAV.length + 1);
  });

  test("the reader's items keep their order either way", () => {
    expect(navItems(true).filter((n) => n.href !== "/config")).toEqual([...NAV]);
  });
});
