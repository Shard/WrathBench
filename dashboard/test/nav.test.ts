/** The top bar's order is the brief's: about last, no home item, and no fleet — it moved into the status popout. */
import { describe, expect, test } from "bun:test";
import { CONFIG_NAV, NAV, navItems, surface } from "../src/lib/nav";

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
 * told it exists.
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

/**
 * The header badge and the config nav item are one derivation, so they cannot
 * disagree about which site a reader is on.
 */
describe("surface", () => {
  test("the public bundle is PREVIEW whatever a viewer would have said", () => {
    expect(surface(true, undefined)).toBe("PREVIEW");
    expect(surface(true, false)).toBe("PREVIEW");
  });

  test("a private build follows the viewer", () => {
    expect(surface(false, false)).toBe("ADMIN");
    expect(surface(false, true)).toBe("PREVIEW");
  });

  test("nothing is claimed before /api/info settles", () => {
    expect(surface(false, undefined)).toBeNull();
  });

  test("the config item exists exactly where the badge says ADMIN", () => {
    for (const publicMode of [true, false, undefined]) {
      const admin = surface(false, publicMode) === "ADMIN";
      expect(navItems(admin).includes(CONFIG_NAV)).toBe(admin);
    }
  });
});
