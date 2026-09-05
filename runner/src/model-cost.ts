/**
 * Whether a model costs the operator money per run: `free` or `paid`.
 *
 * Billing is a property of the *model as the roster names it*, not of a run,
 * and it is decided once here so the scheduler (paid models get a
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
 *
 * This is the SCHEDULER's verdict — "does this consume the paid concurrency
 * budget". The reader's verdict, "did we pay for this run", is `runBilling` in
 * `runner/src/billing.ts`, and it puts `claude-code` on the paid side because a
 * subscription is a bill. The two share the predicates below and disagree on
 * that one clause on purpose; changing either does not change the other.
 */


export type Billing = "free" | "paid";

/**
 * Shared-free-pool model ids that are genuinely free but carry no `-free`
 * suffix. Empty today, and that is the resting state: the only case the repo
 * has ever had was a stealth model priced at 0/0 for its preview window
 * (`stealth/ox-alpha`, verified 2026-08-22, removed 2026-08-28 when the window
 * closed and OpenRouter revealed it as ZAI GLM-5.3-Flash at paid rates).
 *
 * Membership is an explicit operator assertion that an id billing nothing today
 * may be scheduled on the free account pool and spend none of the paid
 * concurrency budget — so it is worth an entry only while a real id is both
 * genuinely 0/0 and wanted on that pool, and it must come out the day the id
 * starts billing. Everything not in here is paid, which is the side that never
 * quietly overspends. The fleet's roster policy (`infra/run-fleet.ts`) reads the
 * same set, so an entry also decides whether a suffixless id may sit in the
 * roster without declaring `billing: "paid"`.
 */
export const FREE_SUFFIXLESS_ALLOWLIST: ReadonlySet<string> = new Set<string>();

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
  /** The harness tag, for a stored run that recorded one. */
  harness?: string | null;
  /** Operator override; wins over every rule. */
  billing?: Billing;
}

/** The one verdict. */
export function billingOf(m: BillableModel): Billing {
  if (m.billing !== undefined) return m.billing;
  if (isLocalBase(m.apiBase)) return "free";
  // The subscription scaffolds (claude-code, codex): a flat bill, no per-token charge.
  if (m.driver === "claude-code" || m.harness === "claude-code" || m.driver === "codex" || m.harness === "codex") return "free";
  if (isContributorSlug(m.model) || isFreeSlug(m.model) || isAllowlistedFree(m.model)) return "free";
  return "paid";
}
