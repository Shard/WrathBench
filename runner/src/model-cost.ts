/**
 * Whether a model costs the operator money per run: `free` or `paid`.
 *
 * Billing is a property of the *model as the roster names it*, not of a run,
 * and it is decided once here so the scheduler (paid models get a
 * hard target and a concurrency cap, free ones get extras) and the viewer's
 * price table (`runner/viewer/pricing.ts`) cannot disagree about which side the
 * rules put a model on. The rules are deliberately few and mechanical:
 *
 * - a `:free` / `-free` slug (OpenRouter, OpenCode Zen) is free — the suffix
 *   is the pool's own convention; a `-contributor-free` slug is free because
 *   the provider keeps the prompts;
 * - a LAN/loopback `apiBase` is free — the operator's own hardware;
 * - the `claude-code` driver is free — it bills a flat subscription, not tokens;
 * - everything else is paid, the side that never quietly overspends.
 *
 * A roster entry may override the verdict with `billing` for the case the
 * rules cannot see: a stealth id priced at zero with no free suffix, or a key
 * on a paid plan for a free-looking id. On the openai driver the override is
 * also recorded on each run it launches (`RunConfig.billing`), so the reader's
 * verdict reads that run the same way and the price table prices a recorded
 * `free` as free rather than looking the id up.
 *
 * This is the SCHEDULER's verdict — "does this consume the paid concurrency
 * budget". The reader's verdict, "did we pay for this run", is `runBilling` in
 * `runner/src/billing.ts`, and it puts `claude-code` on the paid side because a
 * subscription is a bill. The two share the predicates below and disagree on
 * that one clause on purpose; changing either does not change the other.
 */


export type Billing = "free" | "paid";

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
  if (isContributorSlug(m.model) || isFreeSlug(m.model)) return "free";
  return "paid";
}
