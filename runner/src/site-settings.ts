/**
 * The config store's `site` block: settings for what the dashboard shows,
 * and nothing the fleet does.
 *
 * - `previewSeries`: a harness series the site offers as "preview (<series>)"
 *   rather than as "latest", so the established series stays the default view
 *   while the next one fills up (operator, 2026-11-15). Clearing it
 *   (`bun wb config delete site`) is the flip: "latest" then follows the
 *   newest series again. docs/PUBLIC-DASHBOARD.md, "The series selector".
 * - `name`, `theme`, `home`, `about`: what makes a viewer deployed beside
 *   someone else's wrath-mcp theirs without a code change — the site's name,
 *   four colour tokens, what `/` is, and the about page's text as markdown.
 *   Public by design: `/api/info` carries them and so does the snapshot.
 *
 * docs/RUNBOOK.md, "Config reference", says how to set each.
 *
 * Read by the viewer for `/api/info` (and so by the publisher's `info.json`),
 * validated by the store on every write (`validateFleet`), and deliberately
 * never by `parseFleet`: the supervisor has no use for it, and a display
 * setting must not be able to reject the fleet's config.
 */

/** The keys the block may carry; anything else is refused by name. */
export const SITE_KEYS = ["previewSeries", "name", "theme", "home", "about"] as const;

/** The colour tokens a theme may set, by their stylesheet names (`--accent`, …). */
export const THEME_TOKENS = ["accent", "bg", "fg", "panel"] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/** A theme as each scheme takes it: a token absent from a scheme keeps the stylesheet's. */
export interface SiteTheme {
  dark?: Partial<Record<ThemeToken, string>>;
  light?: Partial<Record<ThemeToken, string>>;
}

export interface SiteSettings {
  /** A `major.minor` series offered as a preview instead of as latest; absent when none is. */
  previewSeries?: string;
  /** The site's name, in place of "WrathBench" in the wordmark, the tab title and the card. */
  name?: string;
  /** Colour overrides; absent when no token is set. */
  theme?: SiteTheme;
  /** What `/` is when it is not the intro: `"off"` (the runs list) or an in-site path. Absent is the intro. */
  home?: string;
  /** The about page as markdown, in place of the built-in one. */
  about?: string;
}

const SERIES = /^\d+\.\d+$/;
const NAME_MAX = 40;
const ABOUT_MAX = 20_000;
export const HOME_MAX = 200;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** A path in the site: segments of unreserved characters, then an optional plain query. */
const HOME_PATH = /^\/[A-Za-z0-9._~\-/]*(\?[A-Za-z0-9._~\-=&%]*)?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const unset = (v: unknown): boolean => v === undefined || v === null;

function parseName(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > NAME_MAX || v.trim() !== v || CONTROL.test(v)) {
    throw new Error(`site.name must be 1 to ${NAME_MAX} characters, with no control characters or surrounding spaces, not ${JSON.stringify(v)}`);
  }
  return v;
}

function parseTheme(v: unknown): SiteTheme | undefined {
  const shape = 'site.theme must be an object like { "accent": "#7aa2f7", "bg": { "dark": "#14161a", "light": "#fbfbfc" } }';
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(shape);
  const extra = Object.keys(v).filter((k) => !(THEME_TOKENS as readonly string[]).includes(k));
  if (extra.length > 0) throw new Error(`site.theme: ${extra.join(", ")} ${extra.length === 1 ? "is not a token" : "are not tokens"} — a theme sets only ${THEME_TOKENS.join(", ")}`);
  const dark: Partial<Record<ThemeToken, string>> = {};
  const light: Partial<Record<ThemeToken, string>> = {};
  const colour = (token: string, scheme: string | null, c: unknown): string => {
    if (typeof c !== "string" || !HEX.test(c)) {
      throw new Error(`site.theme.${token}${scheme === null ? "" : `.${scheme}`} must be a colour like "#7aa2f7", not ${JSON.stringify(c)}`);
    }
    return c.toLowerCase();
  };
  for (const token of THEME_TOKENS) {
    const c = (v as Record<string, unknown>)[token];
    if (unset(c)) continue;
    if (typeof c === "string") {
      dark[token] = light[token] = colour(token, null, c);
      continue;
    }
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw new Error(`site.theme.${token} must be a colour like "#7aa2f7" or { "dark": …, "light": … }, not ${JSON.stringify(c)}`);
    }
    const keys = Object.keys(c);
    const odd = keys.filter((k) => k !== "dark" && k !== "light");
    if (odd.length > 0 || keys.length === 0) {
      throw new Error(`site.theme.${token} takes "dark" and "light" and nothing else, not ${JSON.stringify(c)}`);
    }
    const pair = c as { dark?: unknown; light?: unknown };
    if (!unset(pair.dark)) dark[token] = colour(token, "dark", pair.dark);
    if (!unset(pair.light)) light[token] = colour(token, "light", pair.light);
  }
  const out: SiteTheme = {
    ...(Object.keys(dark).length > 0 ? { dark } : {}),
    ...(Object.keys(light).length > 0 ? { light } : {}),
  };
  return out.dark === undefined && out.light === undefined ? undefined : out;
}

function parseHome(v: unknown): string | undefined {
  if (v === "intro") return undefined;
  if (v === "off") return "off";
  if (
    typeof v !== "string" ||
    v.length > HOME_MAX ||
    !HOME_PATH.test(v) ||
    v === "/" ||
    v.startsWith("//") ||
    v.startsWith("/?") ||
    v === "/api" ||
    v.startsWith("/api/") ||
    v.startsWith("/api?")
  ) {
    throw new Error(`site.home must be "intro", "off" or a path in the site like "/runs", not ${JSON.stringify(v)}`);
  }
  return v;
}

function parseAbout(v: unknown): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > ABOUT_MAX || CONTROL_BUT_LINES.test(v)) {
    throw new Error(`site.about must be markdown text of 1 to ${ABOUT_MAX} characters`);
  }
  return v;
}

/**
 * The block as written, checked. Absent is no settings. A key set to `null`
 * reads as unset, because `patch` is a shallow merge and that is what clearing
 * one key through it leaves behind. Throws the sentence a write is refused with.
 */
export function parseSiteBlock(raw: unknown): SiteSettings {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('site must be an object like { "previewSeries": "1.0" }');
  }
  const extra = Object.keys(raw).filter((k) => !(SITE_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) {
    throw new Error(`site: ${extra.join(", ")} ${extra.length === 1 ? "is not a key" : "are not keys"} — the block carries only ${SITE_KEYS.join(", ")}`);
  }
  const { previewSeries, name, theme, home, about } = raw as Record<string, unknown>;
  const out: SiteSettings = {};
  if (!unset(previewSeries)) {
    if (typeof previewSeries !== "string" || !SERIES.test(previewSeries)) {
      throw new Error(`site.previewSeries must be a harness series like "1.0" (major.minor), not ${JSON.stringify(previewSeries)}`);
    }
    out.previewSeries = previewSeries;
  }
  if (!unset(name)) out.name = parseName(name);
  if (!unset(theme)) {
    const t = parseTheme(theme);
    if (t !== undefined) out.theme = t;
  }
  if (!unset(home)) {
    const h = parseHome(home);
    if (h !== undefined) out.home = h;
  }
  if (!unset(about)) out.about = parseAbout(about);
  return out;
}

/** The block as a reader takes it: one that does not read is no settings, never an error. */
export function siteSettingsOf(raw: unknown): SiteSettings {
  try {
    return parseSiteBlock(raw);
  } catch {
    return {};
  }
}
