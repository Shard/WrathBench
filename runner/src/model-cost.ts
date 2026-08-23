/**
 * Whether a model costs the operator money per run: `free` or `paid`.
 *
 * Billing is a property of the *model as the roster names it*, not of a run,
 * and it is decided once here so the scheduler (ADR-0034: paid models get a
 * hard target and a concurrency cap, free ones get extras) and the viewer's
 * price table (`runner/viewer/pricing.ts`) cannot disagree about which side a
 * model is on. The rules are deliberately few and mechanical:
 *
 * - a `:free` / `-free` slug (OpenRouter, OpenCode Zen) is free — the suffix
 *   is the pool's own convention; a `-contributor-free` slug is free because
 *   the provider keeps the prompts;
 * - a LAN/loopback `apiBase` is free — the operator's own hardware;
 * - the `claude-code` driver is free — it bills a flat subscription, not tokens;
 * - a suffixless id the operator has verified free (`FREE_SUFFIXLESS_ALLOWLIST`)
 *   is free; everything else is paid.
 *
 * A roster entry may override the verdict with `billing` for the case the
 * rules cannot see (a key on a paid plan for a free-looking id, say).
 */


export type Billing = "free" | "paid";

/**
 * Shared-free-pool model ids that are genuinely free but carry no `-free`
 * suffix. Stealth/preview models are the case: OpenRouter lists
 * `stealth/ox-alpha` at 0/0 (verified 2026-08-22). Membership is an explicit
 * operator assertion; re-verify before adding one and drop it the day the
 * id starts billing. The fleet's lane policy (`infra/run-fleet.ts`) reads the
 * same set.
 */
export const FREE_SUFFIXLESS_ALLOWLIST: ReadonlySet<string> = new Set(["stealth/ox-alpha"]);

export function isAllowlistedFree(model: string): boolean {
  return FREE_SUFFIXLESS_ALLOWLIST.has(model.toLowerCase());
}

/** A `:free` (OpenRouter) or `-free` (OpenCode Zen) slug. */
export function isFreeSlug(model: string): boolean {
  return /(?::free$|-free$)/.test(model);
}

/** A `-contributor-free` slug: free because the provider keeps prompts and completions. */
export function isContributorSlug(model: string): boolean {
  return /contributor-free/i.test(model);
}

/** An api base that is not on the public internet: LM Studio and friends. */
export function isLocalBase(apiBase: string | null | undefined): boolean {
  if (apiBase === null || apiBase === undefined || apiBase === "") return false;
  let host: string;
  try {
    host = new URL(apiBase).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export interface BillableModel {
  model: string;
  apiBase?: string | null;
  driver?: string | null;
  /** The harness tag (ADR-0035), for a stored run that recorded one. */
  harness?: string | null;
  /** Operator override; wins over every rule. */
  billing?: Billing;
}

/** The one verdict. */
export function billingOf(m: BillableModel): Billing {
  if (m.billing !== undefined) return m.billing;
  if (isLocalBase(m.apiBase)) return "free";
  if (m.driver === "claude-code" || m.harness === "claude-code") return "free";
  if (isContributorSlug(m.model) || isFreeSlug(m.model) || isAllowlistedFree(m.model)) return "free";
  return "paid";
}
