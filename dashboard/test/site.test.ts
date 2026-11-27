/**
 * The deployment's site settings as the dashboard takes them off `/api/info`
 * (`lib/site.ts`), where they reach a reader's page: the home redirect stays
 * inside the site, and a theme value can only ever be a colour.
 */
import { describe, expect, test } from "bun:test";
import type { ApiInfoResponse } from "@viewer/api-types";
import { homeTarget, themeCss } from "../src/lib/site";

const info = (site?: ApiInfoResponse["site"]): Pick<ApiInfoResponse, "site" | "groups"> => (site === undefined ? {} : { site });

describe("home", () => {
  test('the intro unless the site says otherwise; "off" is the runs list, a path is itself', () => {
    expect(homeTarget(undefined)).toBeNull();
    expect(homeTarget(info())).toBeNull();
    expect(homeTarget(info({ home: "off" }))).toBe("/runs");
    expect(homeTarget(info({ home: "/map" }), "?series=1.0")).toBe("/map?series=1.0");
    expect(homeTarget(info({ home: "/ladder?episode=e90" }), "?series=1.0")).toBe("/ladder?episode=e90");
  });

  test("anything that is not a path in the site, or is `/` itself, is the intro", () => {
    for (const home of ["/", "//evil.example", "https://evil.example", "/?x"]) expect(homeTarget(info({ home }))).toBeNull();
  });
});

describe("theme", () => {
  test("each scheme its own rule, the light one under the stylesheet's own media query", () => {
    expect(themeCss(undefined)).toBe("");
    expect(themeCss({ dark: { accent: "#ff8800" }, light: { accent: "#aa5500" } })).toBe(
      "@media not all and (prefers-color-scheme: light) { html:root { --accent: #ff8800; } }\n@media (prefers-color-scheme: light) { html:root { --accent: #aa5500; } }",
    );
  });

  test("a value that is not #rrggbb never reaches the CSS", () => {
    expect(themeCss({ dark: { accent: "red;} body{display:none" } })).toBe("");
  });
});
