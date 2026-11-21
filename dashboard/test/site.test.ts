/**
 * The deployment's name, theme, home and about as the dashboard takes them off
 * `/api/info` (`lib/site.ts`), and the pages a custom about mounts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ApiInfoResponse } from "@viewer/api-types";
import { DEFAULT_NAME, SITE_CACHE_KEY, applySite, homeTarget, pageSiteOf, siteName, themeCss } from "../src/lib/site";
import { linkable, navItems } from "../src/lib/nav";

const info = (site?: ApiInfoResponse["site"]): Pick<ApiInfoResponse, "site" | "groups"> => (site === undefined ? {} : { site });

describe("home", () => {
  test("the intro unless the site says otherwise", () => {
    expect(homeTarget(undefined)).toBeNull();
    expect(homeTarget(info())).toBeNull();
  });
  test('"off" is the runs list, a path is itself, and the reader\'s query comes along unless the path names one', () => {
    expect(homeTarget(info({ home: "off" }))).toBe("/runs");
    expect(homeTarget(info({ home: "/map" }), "?series=1.0")).toBe("/map?series=1.0");
    expect(homeTarget(info({ home: "/ladder?episode=e90" }), "?series=1.0")).toBe("/ladder?episode=e90");
  });
  test("anything that is not a path in the site, or is `/` itself, is the intro", () => {
    for (const home of ["/", "//evil.example", "https://evil.example", "/?x"]) expect(homeTarget(info({ home }))).toBeNull();
  });
});

describe("name", () => {
  test("WrathBench unless set; while /api/info is in flight, what this browser last saw", () => {
    expect(siteName(info(), null)).toBe(DEFAULT_NAME);
    expect(siteName(info({ name: "Lab" }), null)).toBe("Lab");
    expect(siteName(undefined, null)).toBe(DEFAULT_NAME);
    expect(siteName(undefined, { name: "Cached" })).toBe("Cached");
    // Once answered, the live value wins over the cache, unset included.
    expect(siteName(info(), { name: "Cached" })).toBe(DEFAULT_NAME);
  });
});

describe("about", () => {
  const viewerOnly = { runner: false, evals: false, viewer: true };
  test("a custom about is mounted, and in the bar, with evals off; without one it is evals'", () => {
    expect(pageSiteOf(info())).toEqual({});
    expect(pageSiteOf(info({ aboutHtml: "<p>x</p>" }))).toEqual({ about: true });
    expect(navItems({ admin: false, groups: viewerOnly }).map((n) => n.href)).toEqual(["/map", "/runs"]);
    expect(navItems({ admin: false, groups: viewerOnly, site: { about: true } }).map((n) => n.href)).toEqual(["/map", "/runs", "/about"]);
    expect(linkable({ groups: viewerOnly }, "/about")).toBe(false);
    expect(linkable({ groups: viewerOnly, site: { aboutHtml: "<p>x</p>" } }, "/about")).toBe(true);
  });
});

describe("theme", () => {
  test("no theme is no CSS", () => {
    expect(themeCss(undefined)).toBe("");
    expect(themeCss({})).toBe("");
  });
  test("each scheme its own rule; the light one under the stylesheet's own media query", () => {
    const css = themeCss({ dark: { accent: "#ff8800" }, light: { accent: "#aa5500" } });
    expect(css).toBe(
      "@media not all and (prefers-color-scheme: light) { html:root { --accent: #ff8800; } }\n@media (prefers-color-scheme: light) { html:root { --accent: #aa5500; } }",
    );
  });
  test("a token set for one scheme reaches no reader of the other", () => {
    const css = themeCss({ dark: { bg: "#101010" } });
    // Every rule sits in a scheme's media block, and none is the light one.
    expect(css).not.toMatch(/^html:root/m);
    expect(css).not.toContain("@media (prefers-color-scheme: light)");
    expect(themeCss({ light: { bg: "#fafafa" } })).not.toContain("not all and");
  });
  test("moving ground or ink derives dim, line and the grid as hex between them", () => {
    const css = themeCss({ dark: { bg: "#000000", fg: "#ffffff" } });
    expect(css).toContain("--bg: #000000;");
    expect(css).toContain("--dim: #9e9e9e;");
    expect(css).toContain("--line: #212121;");
    expect(css).not.toContain("color-mix");
    expect(css).not.toContain("var(");
    // Only accent: nothing derived.
    expect(themeCss({ dark: { accent: "#ff8800" } })).not.toContain("--dim");
  });
  test("a value that is not #rrggbb never reaches the CSS", () => {
    expect(themeCss({ dark: { accent: "red;} body{display:none" } })).toBe("");
  });
});

describe("applySite", () => {
  const saved = { document: globalThis.document, localStorage: globalThis.localStorage };
  afterEach(() => {
    Object.assign(globalThis, saved);
  });
  function install(): Window {
    const w = new Window();
    w.document.head.innerHTML =
      '<title>WrathBench</title><meta name="theme-color" content="#fbfbfc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#14161a" media="(prefers-color-scheme: dark)">';
    Object.assign(globalThis, { document: w.document, localStorage: w.localStorage });
    return w;
  }

  test("paints the theme, title and chrome colour, caches them, and takes all of it back when the site is cleared", () => {
    const w = install();
    applySite({ name: "Lab", theme: { dark: { bg: "#000000" }, light: { accent: "#aa5500" } } });
    expect(w.document.title).toBe("Lab");
    expect(w.document.getElementById("site-theme")?.textContent).toContain("--bg: #000000;");
    const metas = [...w.document.querySelectorAll("meta[name=theme-color]")].map((m) => m.getAttribute("content"));
    expect(metas).toEqual(["#fbfbfc", "#000000"]);
    const cached = JSON.parse(w.localStorage.getItem(SITE_CACHE_KEY) ?? "null") as { css: string; name: string };
    expect(cached.name).toBe("Lab");
    // The cached CSS passes index.html's own check before it is painted.
    expect(/^[\w\s:;#{}().,@%-]*$/.test(cached.css)).toBe(true);

    applySite(undefined);
    expect(w.document.title).toBe("WrathBench");
    expect(w.document.getElementById("site-theme")).toBeNull();
    expect([...w.document.querySelectorAll("meta[name=theme-color]")].map((m) => m.getAttribute("content"))).toEqual(["#fbfbfc", "#14161a"]);
    expect(w.localStorage.getItem(SITE_CACHE_KEY)).toBeNull();
  });

  test("with no site, the page is left as it was", () => {
    const w = install();
    const before = w.document.head.innerHTML.replace(/ data-base="[^"]*"/g, "");
    applySite(undefined);
    expect(w.document.head.innerHTML.replace(/ data-base="[^"]*"/g, "")).toBe(before);
  });
});
