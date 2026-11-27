/**
 * The operator's admin page is not in `NAV` at all: the routes behind it are
 * mounted only with the admin switch on, and a reader who cannot use it should
 * not be told it exists. The header badge and the admin item are one
 * derivation, so they cannot disagree about which site a reader is on.
 */
import { describe, expect, test } from "bun:test";
import { ADMIN_NAV, NAV, linkable, navItems, surface } from "../src/lib/nav";

describe("the admin surface", () => {
  test("a reader's bar has no admin; an operator's adds it and keeps the rest in order", () => {
    expect(navItems({ admin: false })).toEqual(NAV);
    expect(NAV.some((n) => n.href === "/admin")).toBe(false);
    expect(navItems({ admin: true }).filter((n) => n.href !== "/admin")).toEqual([...NAV]);
    expect(navItems({ admin: true })).toContain(ADMIN_NAV);
  });

  test("the public bundle is PREVIEW whatever a viewer says; a private build is ADMIN only with the switch on", () => {
    expect(surface(true, undefined)).toBe("PREVIEW");
    expect(surface(true, { publicMode: false, admin: true })).toBe("PREVIEW");
    expect(surface(false, { publicMode: false, admin: true })).toBe("ADMIN");
    expect(surface(false, { publicMode: false })).toBeNull();
    expect(surface(false, { publicMode: true })).toBe("PREVIEW");
    expect(surface(false, undefined)).toBeNull();
  });

  test("the admin item exists exactly where the badge says ADMIN, and nothing links to admin", () => {
    for (const info of [{ publicMode: true }, { publicMode: false }, { publicMode: false, admin: true as const }, undefined]) {
      const admin = surface(false, info) === "ADMIN";
      expect(navItems({ admin }).includes(ADMIN_NAV)).toBe(admin);
    }
    expect(linkable({}, "/admin")).toBe(false);
  });
});

describe("groups", () => {
  const off = (g: "runner" | "evals") => ({ groups: { runner: g !== "runner", evals: g !== "evals", viewer: true } });

  test("an off group's pages are neither in the bar nor linked; the viewer's own pages always are", () => {
    expect(navItems({ admin: false, groups: { runner: false, evals: false, viewer: true } }).map((n) => n.href)).toEqual(["/map", "/runs"]);
    expect(linkable(undefined, "/ladder")).toBe(false);
    expect(linkable(off("evals"), "/ladder?episode=e90")).toBe(false);
    expect(linkable(off("runner"), "/models#claude-a")).toBe(false);
    expect(linkable(off("runner"), "/ladder?episode=e90")).toBe(true);
    expect(linkable(off("evals"), "/runs")).toBe(true);
  });
});
