/**
 * The config store's `site` block: settings for what the dashboard shows,
 * and nothing the fleet does.
 *
 * Today one key, `previewSeries`: a harness series the site offers as
 * "preview (<series>)" rather than as "latest", so the established series
 * stays the default view while the next one fills up (operator, 2026-11-15).
 * Clearing it (`bun wb config delete site`) is the flip: "latest" then follows
 * the newest series again. docs/RUNBOOK.md, "Config reference", and
 * docs/PUBLIC-DASHBOARD.md, "The series selector".
 *
 * Read by the viewer for `/api/info` (and so by the publisher's `info.json`),
 * validated by the store on every write (`validateFleet`), and deliberately
 * never by `parseFleet`: the supervisor has no use for it, and a display
 * setting must not be able to reject the fleet's config.
 */

/** The keys the block may carry; anything else is refused by name. */
export const SITE_KEYS = ["previewSeries"] as const;

export interface SiteSettings {
  /** A `major.minor` series offered as a preview instead of as latest; absent when none is. */
  previewSeries?: string;
}

const SERIES = /^\d+\.\d+$/;

/**
 * The block as written, checked. Absent is no settings. `previewSeries: null`
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
  const { previewSeries } = raw as { previewSeries?: unknown };
  if (previewSeries === undefined || previewSeries === null) return {};
  if (typeof previewSeries !== "string" || !SERIES.test(previewSeries)) {
    throw new Error(`site.previewSeries must be a harness series like "1.0" (major.minor), not ${JSON.stringify(previewSeries)}`);
  }
  return { previewSeries };
}

/** The block as a reader takes it: one that does not read is no settings, never an error. */
export function siteSettingsOf(raw: unknown): SiteSettings {
  try {
    return parseSiteBlock(raw);
  } catch {
    return {};
  }
}
