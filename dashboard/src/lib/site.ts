/**
 * The deployment's own name, colours, homepage and about page: `/api/info`'s
 * `site` (the config store's `site` block, `runner/src/site-settings.ts`).
 * Absent, every function here answers what the dashboard was before it.
 *
 * The theme is a `<style id="site-theme">` element rather than properties set
 * on the root element: a token set per scheme has to follow the reader's
 * light/dark switch the way the stylesheet's own do, and an inline style would
 * pin one. `html:root` outranks the stylesheet's `:root`, whatever order the
 * two land in the head. A copy of the CSS and the name is kept in this
 * browser so `index.html`'s first script can paint them before the bundle
 * arrives; the live values replace it when `/api/info` settles.
 */

import type { ApiInfoResponse, ApiSiteInfo, SiteTheme, ThemeToken } from "@viewer/api-types";
import type { PageSite } from "@viewer/groups";

export const DEFAULT_NAME = "WrathBench";
/** Where `index.html`'s first script finds the last site it saw; the script names it too. */
export const SITE_CACHE_KEY = "wb.site";
const STYLE_ID = "site-theme";
const HEX = /^#[0-9a-f]{6}$/;

/** The stylesheet's own ground and ink per scheme, which a theme setting one of the two mixes against. */
const BASE: Record<"dark" | "light", { bg: string; fg: string }> = {
  dark: { bg: "#14161a", fg: "#d8dee6" },
  light: { bg: "#fbfbfc", fg: "#1e2229" },
};

/** The tokens drawn from ground and ink, as the share of ink in each (close to the stylesheet's own). */
const DERIVED: readonly [string, number][] = [
  ["--dim", 0.62],
  ["--line", 0.13],
  ["--grid", 0.03],
  ["--gridline", 0.08],
];

interface SiteCache {
  css?: string;
  name?: string;
}

function readCache(): SiteCache | null {
  try {
    const raw = globalThis.localStorage?.getItem(SITE_CACHE_KEY);
    if (raw === null || raw === undefined) return null;
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null ? (v as SiteCache) : null;
  } catch {
    return null;
  }
}

/** Read once: the name the wordmark shows until `/api/info` has answered. */
const cached = readCache();

/** The wordmark's and the tab's name: the site's, the cached one while `/api/info` is in flight, else WrathBench. */
export function siteName(info: Pick<ApiInfoResponse, "site"> | undefined, fallback: SiteCache | null = cached): string {
  if (info === undefined) return typeof fallback?.name === "string" ? fallback.name : DEFAULT_NAME;
  return info.site?.name ?? DEFAULT_NAME;
}

/**
 * Where `/` sends a reader, or null when `/` is the intro. `"off"` is the runs
 * list. The reader's own query (a series pin) comes along unless the target
 * names one.
 */
export function homeTarget(info: Pick<ApiInfoResponse, "site"> | undefined, search = ""): string | null {
  const home = info?.site?.home;
  if (home === undefined) return null;
  const path = home === "off" ? "/runs" : home;
  // As the store checked it, held again here: a path in the site and never `/` itself.
  if (!path.startsWith("/") || path.startsWith("//") || path === "/" || path.startsWith("/?")) return null;
  return path.includes("?") ? path : `${path}${search}`;
}

/** What the site block changes about which pages are mounted (`pageMounted`). */
export function pageSiteOf(info: Pick<ApiInfoResponse, "site"> | undefined): PageSite {
  return info?.site?.aboutHtml !== undefined ? { about: true } : {};
}

function mix(fg: string, bg: string, share: number): string {
  const ch = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  let out = "#";
  for (let i = 0; i < 3; i++) out += Math.round(ch(bg, i) + (ch(fg, i) - ch(bg, i)) * share).toString(16).padStart(2, "0");
  return out;
}

function schemeDecls(set: Partial<Record<ThemeToken, string>> | undefined, scheme: "dark" | "light"): string {
  if (set === undefined) return "";
  const decls: string[] = [];
  for (const token of ["bg", "fg", "panel", "accent"] as const) {
    const c = set[token];
    if (c !== undefined && HEX.test(c)) decls.push(`--${token}: ${c};`);
  }
  // Ground or ink moved: the tokens drawn between them follow, as hex the map's canvas can read.
  const bg = set.bg !== undefined && HEX.test(set.bg) ? set.bg : null;
  const fg = set.fg !== undefined && HEX.test(set.fg) ? set.fg : null;
  if (bg !== null || fg !== null) {
    for (const [name, share] of DERIVED) decls.push(`${name}: ${mix(fg ?? BASE[scheme].fg, bg ?? BASE[scheme].bg, share)};`);
  }
  return decls.join(" ");
}

/** The theme's CSS, or "" for none. Pure; only `#rrggbb` values reach it. */
export function themeCss(theme: SiteTheme | undefined): string {
  if (theme === undefined) return "";
  const dark = schemeDecls(theme.dark, "dark");
  const light = schemeDecls(theme.light, "light");
  const parts: string[] = [];
  // Each rule under its own scheme: `html:root` outranks the stylesheet's light block, so a dark rule outside one would paint light readers too.
  if (dark !== "") parts.push(`@media not all and (prefers-color-scheme: light) { html:root { ${dark} } }`);
  if (light !== "") parts.push(`@media (prefers-color-scheme: light) { html:root { ${light} } }`);
  return parts.join("\n");
}

/**
 * Put the live site on the page: the theme's style element, the tab title, the
 * browser chrome's colour, and the cache `index.html` paints from next time.
 * With no site, nothing is left of a previous one and nothing is written.
 */
export function applySite(site: ApiSiteInfo | undefined): void {
  if (typeof document === "undefined") return;
  const css = themeCss(site?.theme);
  let style = document.getElementById(STYLE_ID);
  if (css === "") style?.remove();
  else {
    if (style === null) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.append(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }
  const title = site?.name ?? DEFAULT_NAME;
  if (document.title !== title) document.title = title;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset["base"] ??= meta.content;
    const scheme = (meta.getAttribute("media") ?? "").includes("light") ? "light" : "dark";
    const want = site?.theme?.[scheme]?.bg ?? meta.dataset["base"] ?? meta.content;
    if (meta.content !== want) meta.content = want;
  }
  try {
    const keep: SiteCache = { ...(css !== "" ? { css } : {}), ...(site?.name !== undefined ? { name: site.name } : {}) };
    if (Object.keys(keep).length === 0) globalThis.localStorage?.removeItem(SITE_CACHE_KEY);
    else globalThis.localStorage?.setItem(SITE_CACHE_KEY, JSON.stringify(keep));
  } catch {
    /* storage refused (a private window, a blocked origin): the next load paints from the live value */
  }
}
