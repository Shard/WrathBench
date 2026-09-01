/**
 * Which platform served a model, from the api base the run actually used.
 *
 * One spelling, because three readers ask the question: the run writer stamps
 * it into `run.platform` at writeMeta (item 36), the viewer's listing
 * reads that column, and the scheduler's projection labels a roster entry with
 * it. The api base is the honest source — the driver only says how we talked
 * to a model, not who served the weights — so the driver is a fallback each
 * caller keeps for itself: the listing has no platform for a run with neither,
 * while the projection assumes the roster's default.
 *
 * "Local" is the operator's own hardware, and it is exactly `isLocalBase` in
 * `model-cost.ts` — loopback, `.local`, and the RFC-1918 ranges — so the
 * platform label and the free/paid verdict cannot disagree about what a LAN
 * box is. A public IPv4 is a platform like any other host and reads as itself.
 */

import { isLocalBase } from "./model-cost";

/**
 * The platform an api base names, or null when there is no api base.
 *
 * A base that does not parse as a URL still tells us something, so the raw
 * string is matched rather than discarded.
 */
export function platformOfBase(apiBase: string | null | undefined): string | null {
  if (apiBase === null || apiBase === undefined || apiBase === "") return null;
  if (isLocalBase(apiBase)) return "local";
  let host = apiBase;
  try {
    host = new URL(apiBase).hostname;
  } catch {
    /* a malformed base still tells us something; fall through with the raw string */
  }
  if (host.includes("openrouter.ai")) return "openrouter";
  if (host.includes("api.anthropic.com")) return "anthropic";
  if (host.includes("api.openai.com")) return "openai";
  return host.replace(/^api\./, "");
}

/** The api base's answer, or the driver's name when a run carried no base. */
export function platformOf(
  apiBase: string | null | undefined,
  driver: string | null | undefined,
): string | null {
  return platformOfBase(apiBase) ?? (driver ?? null);
}
