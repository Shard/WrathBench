/**
 * Which platform served a model, from the api base the run actually used.
 *
 * One spelling, because three readers ask the question: the run writer stamps
 * it into `run.platform` at writeMeta, the viewer's listing
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
 * The lowercased hostname of an api base, or null when there is none or it
 * does not parse as a URL.
 *
 * Every "is this base provider X" question is asked of this and answered by
 * equality — never by searching the string, where `openrouter.ai.example.com`,
 * `evil-openrouter.ai` or a path segment would all pass for OpenRouter. The
 * provider table (`providers.ts`) decides where a key may go the same way.
 */
export function hostOfBase(apiBase: string | null | undefined): string | null {
  if (apiBase === null || apiBase === undefined || apiBase === "") return null;
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Whether an api base is OpenCode Go, billed apart from Zen's shared tier on
 * the same host. The path is what distinguishes it —
 * `https://opencode.ai/inference/go/openai/v1` (or the older
 * `https://opencode.ai/zen/go/v1`, which still answers) against the shared
 * tier's `https://opencode.ai/inference/openai/v1` and `/zen/v1` — so this
 * reads the base itself rather than `platformOfBase`, which answers with a
 * hostname. The host is matched exactly (`hostOfBase`), never by substring,
 * and a base that does not parse is not this surface. Read by the scheduler's
 * concurrency key (`models.ts`) and by the routing a run stamps (`routing.ts`).
 */
export function isOpenCodeGoBase(apiBase: string | null | undefined): boolean {
  if (hostOfBase(apiBase) !== "opencode.ai") return false;
  return /(^|\/)(zen|inference)\/go(\/|$)/.test(new URL(apiBase!).pathname);
}

/** The platforms a hostname is labelled with, matched exactly. Anything else is its own host. */
const NAMED_HOSTS: Readonly<Record<string, string>> = {
  "openrouter.ai": "openrouter",
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
};

/**
 * The platform an api base names, or null when there is no api base.
 *
 * Known hosts are matched exactly (`NAMED_HOSTS`); any other host labels
 * itself, without a leading `api.`. A base that does not parse as a URL still
 * labels itself the same way, but is never taken for a named platform.
 */
export function platformOfBase(apiBase: string | null | undefined): string | null {
  if (apiBase === null || apiBase === undefined || apiBase === "") return null;
  if (isLocalBase(apiBase)) return "local";
  const host = hostOfBase(apiBase);
  if (host === null) return apiBase.replace(/^api\./, "");
  return NAMED_HOSTS[host] ?? host.replace(/^api\./, "");
}

/** The api base's answer, or the driver's name when a run carried no base. */
export function platformOf(
  apiBase: string | null | undefined,
  driver: string | null | undefined,
): string | null {
  return platformOfBase(apiBase) ?? (driver ?? null);
}
