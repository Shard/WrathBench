/** The top bar's order is the brief's: about last, no home item, and no fleet — it moved into the status popout. */
import { describe, expect, test } from "bun:test";
import { CONFIG_NAV, NAV, groupsOf, navItems, surface } from "../src/lib/nav";

describe("NAV", () => {
  test("about is last", () => {
    expect(NAV.map((n) => n.href).at(-1)).toBe("/about");
  });
  test("ladder comes immediately before runs", () => {
    const hrefs = NAV.map((n) => n.href);
    expect(hrefs.indexOf("/ladder")).toBe(hrefs.indexOf("/runs") - 1);
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
 * mounted only with the admin switch on, and a reader who cannot use it should
 * not be told it exists.
 */
describe("navItems", () => {
  test("a public build, a public viewer or a private one without admin gets the reader's bar, unchanged", () => {
    expect(navItems({ admin: false })).toEqual(NAV);
    expect(NAV.some((n) => n.href === "/config")).toBe(false);
  });

  test("an operator gets config, and about is still last", () => {
    const items = navItems({ admin: true });
    expect(items).toContain(CONFIG_NAV);
    expect(items.at(-1)?.href).toBe("/about");
    expect(items.length).toBe(NAV.length + 1);
  });

  test("the reader's items keep their order either way", () => {
    expect(navItems({ admin: true }).filter((n) => n.href !== "/config")).toEqual([...NAV]);
  });

  test("an off group's pages are not in the bar", () => {
    const viewerOnly = { runner: false, evals: false, viewer: true };
    expect(navItems({ admin: false, groups: viewerOnly }).map((n) => n.href)).toEqual(["/map", "/runs"]);
    expect(navItems({ admin: true, groups: viewerOnly }).map((n) => n.href)).toEqual(["/map", "/runs", "/config"]);
    expect(navItems({ admin: false, groups: { runner: true, evals: false, viewer: true } }).map((n) => n.href)).toEqual(["/map", "/runs", "/models"]);
  });
});

/**
 * The header badge and the config nav item are one derivation, so they cannot
 * disagree about which site a reader is on.
 */
describe("surface", () => {
  test("the public bundle is PREVIEW whatever a viewer would have said", () => {
    expect(surface(true, undefined)).toBe("PREVIEW");
    expect(surface(true, { publicMode: false, admin: true })).toBe("PREVIEW");
  });

  test("a private build follows the viewer: ADMIN only with the admin switch on", () => {
    expect(surface(false, { publicMode: false, admin: true })).toBe("ADMIN");
    expect(surface(false, { publicMode: false })).toBeNull();
    expect(surface(false, { publicMode: true })).toBe("PREVIEW");
  });

  test("nothing is claimed before /api/info settles", () => {
    expect(surface(false, undefined)).toBeNull();
  });

  test("the config item exists exactly where the badge says ADMIN", () => {
    for (const info of [{ publicMode: true }, { publicMode: false }, { publicMode: false, admin: true as const }, undefined]) {
      const admin = surface(false, info) === "ADMIN";
      expect(navItems({ admin }).includes(CONFIG_NAV)).toBe(admin);
    }
  });
});

describe("groupsOf", () => {
  test("absent is every group", () => {
    expect(groupsOf(undefined)).toEqual({ runner: true, evals: true, viewer: true });
    expect(groupsOf({})).toEqual({ runner: true, evals: true, viewer: true });
    expect(groupsOf({ groups: { runner: false, evals: true, viewer: true } }).runner).toBe(false);
  });
});
