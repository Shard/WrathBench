/**
 * The `site` block's deployment keys (runner/src/site-settings.ts) and the
 * about page's rendering (viewer/site-info.ts): what a write may set,
 * and that nothing scriptable survives the markdown.
 */
import { describe, expect, test } from "bun:test";
import { parseSiteBlock } from "../src/site-settings";
import { renderAboutHtml, siteInfoField } from "../../viewer/site-info";

describe("parseSiteBlock", () => {

  test("every key at once reads back normalised", () => {
    expect(
      parseSiteBlock({
        previewSeries: "1.0",
        name: "My Lab",
        theme: { accent: "#FF8800", bg: { dark: "#101010", light: "#fafafa" }, fg: { light: "#111111" } },
        home: "/runs",
        about: "# Hello",
      }),
    ).toEqual({
      previewSeries: "1.0",
      name: "My Lab",
      theme: { dark: { accent: "#ff8800", bg: "#101010" }, light: { accent: "#ff8800", bg: "#fafafa", fg: "#111111" } },
      home: "/runs",
      about: "# Hello",
    });
  });

  test("an unknown key is refused by name", () => {
    expect(() => parseSiteBlock({ banner: "hi" })).toThrow(/site: banner is not a key/);
    expect(() => parseSiteBlock("x")).toThrow(/site must be an object/);
  });

  test("theme: four tokens, #rrggbb, a string for both schemes or a dark/light pair", () => {
    expect(parseSiteBlock({ theme: { panel: { dark: "#000000" } } }).theme).toEqual({ dark: { panel: "#000000" } });
    expect(parseSiteBlock({ theme: {} }).theme).toBeUndefined();
    expect(() => parseSiteBlock({ theme: { err: "#000000" } })).toThrow(/err is not a token/);
    expect(() => parseSiteBlock({ theme: { accent: "red" } })).toThrow(/site.theme.accent must be a colour/);
    expect(() => parseSiteBlock({ theme: { accent: "#fff" } })).toThrow(/site.theme.accent must be a colour/);
    expect(() => parseSiteBlock({ theme: { accent: "#ffffff;}" } })).toThrow(/site.theme.accent must be a colour/);
    expect(() => parseSiteBlock({ theme: { bg: { dark: "url(x)" } } })).toThrow(/site.theme.bg.dark must be a colour/);
    expect(() => parseSiteBlock({ theme: { bg: { dim: "#000000" } } })).toThrow(/takes "dark" and "light"/);
    expect(() => parseSiteBlock({ theme: { bg: {} } })).toThrow(/takes "dark" and "light"/);
    expect(() => parseSiteBlock({ theme: "#000000" })).toThrow(/site.theme must be an object/);
  });

  test('home: "intro" is the default, "off" and in-site paths are kept, anything else is refused', () => {
    expect(parseSiteBlock({ home: "intro" }).home).toBeUndefined();
    expect(parseSiteBlock({ home: "off" }).home).toBe("off");
    expect(parseSiteBlock({ home: "/runs" }).home).toBe("/runs");
    expect(parseSiteBlock({ home: "/ladder?episode=e90" }).home).toBe("/ladder?episode=e90");
    for (const bad of ["/", "runs", "//evil.com", "/\\evil", "https://evil.com", "javascript:alert(1)", "/api/info", "/api", "/?x=1", "/runs#x", `/${"a".repeat(200)}`, "/a b", 1]) {
      expect(() => parseSiteBlock({ home: bad })).toThrow(/site.home must be/);
    }
  });

});

describe("the about page's markdown", () => {
  const html = (md: string): string => renderAboutHtml(md);

  test("raw HTML is text, never markup", () => {
    for (const md of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", 'x <a href="javascript:1">z</a>', "<iframe src=//evil>", "<style>body{}</style>", "x <b onclick=alert(1)>b</b>"]) {
      const out = html(md);
      expect(out).not.toMatch(/<(script|img|iframe|style|b)\b/i);
      expect(out).not.toMatch(/<a [^>]*href="javascript/i);
      expect(out).toContain("&lt;");
    }
  });

  test("a link keeps its href only for http(s), mailto, an in-site path or a fragment", () => {
    const kept = ["https://a.example/x?y=1", "http://a.example", "mailto:a@b.example", "/runs", "#top"];
    for (const href of kept) expect(html(`[x](${href})`)).toMatch(/<a href="[^"]+">x<\/a>/);
    const dropped = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "JaVa&#115;cript:1", "&#106;avascript:1", "vbscript:x", "data:text/html,x", "//evil.example", "file:///etc/passwd", "runs", "%6Aavascript:x"];
    for (const href of dropped) {
      const out = html(`[x](${href})`);
      expect(out).toBe("<p>x</p>\n");
    }
    // A leading space or tab is no way around it.
    expect(html("[x](< javascript:x>)")).not.toContain("href");
    expect(html("[x](<\tjavascript:x>)")).not.toContain("href");
  });

  test("an image is its alt text and makes no request", () => {
    const out = html('![a <b> picture](https://img.example/x.png "t")');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("img.example");
    expect(out).toContain("a &lt;b&gt; picture");
  });
});

describe("/api/info's site field", () => {
  test("absent when the block sets none of its keys; each field only when set", () => {
    expect(siteInfoField({})).toEqual({});
    expect(siteInfoField({ previewSeries: "1.0" })).toEqual({});
    expect(siteInfoField({ name: "Lab" })).toEqual({ site: { name: "Lab" } });
    expect(siteInfoField({ home: "off", about: "[x](javascript:1)" })).toEqual({ site: { home: "off", aboutHtml: "<p>x</p>\n" } });
  });
});
