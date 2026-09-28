/**
 * Whether a *run* cost the operator money — the reader's question, not the
 * scheduler's.
 *
 * There are two billing verdicts in this repo and they disagree on purpose.
 * `billingOf` in `model-cost.ts` answers **"does this model consume the paid
 * concurrency budget?"** — a `claude-code` job bills a flat subscription, so it
 * spends none of the metered budget and lands on `free` there, which is what
 * `policy.paid`'s cap and the account classes are built on. This one answers
 * **"did we pay for this run?"** — a subscription is money, so `claude-code` is
 * `paid` here. Sharing the two would silently re-scope the fleet's cap, so they
 * stay two functions with one shared set of predicates and this comment.
 *
 * The rules, in order:
 *
 * - the `claude-code` harness (or driver) is **paid** — a subscription is a bill;
 * - a `billing` the run recorded at launch wins over everything below — the
 *   roster entry's own word, for the id the rules would put on the wrong side
 *   (a stealth id quoted at zero with no free suffix). Honoured on the openai
 *   driver only: a subscription driver's bill is the subscription;
 * - a local/LAN api base, or a run stamped `platform: "local"`, is free — the
 *   operator's own hardware;
 * - a `:free` / `-free` / `-contributor-free` slug is free;
 * - everything else is paid.
 *
 * A run that recorded no model at all still gets a verdict, because every other
 * clause can still answer; with nothing to go on it reads `paid`, which is the
 * side that does not quietly shrink a spend.
 */

import {
  isContributorSlug,
  isFreeSlug,
  isLocalBase,
  type Billing,
} from "./model-cost";

export type { Billing };

/** What a stored run records about who served it. */
export interface BillableRun {
  model: string | null;
  apiBase?: string | null;
  /** `runner/src/platform.ts`'s label; `"local"` is the operator's own box. */
  platform?: string | null;
  /** The harness tag. */
  harness?: string | null;
  driver?: string | null;
  /** The roster entry's `billing` as the run recorded it at launch; absent on most runs. */
  declaredBilling?: Billing | null;
}

/** The harnesses (and the drivers of the same name) that bill a flat subscription: Claude Code, Codex. */
export function isSubscriptionHarness(name: string | null | undefined): boolean {
  return name === "claude-code" || name === "codex";
}

/**
 * The billing a run recorded at launch, where the reader honours one: the
 * openai driver only. `priceFor` asks the same function before pricing a
 * recorded free, so the verdict and the price cannot drift apart.
 */
export function declaredBillingOf(run: Pick<BillableRun, "driver" | "declaredBilling">): Billing | undefined {
  if (run.driver !== "openai") return undefined;
  return run.declaredBilling ?? undefined;
}

/** Did this run cost money? See the module comment for why it is not `billingOf`. */
export function runBilling(run: BillableRun): Billing {
  if (isSubscriptionHarness(run.harness) || isSubscriptionHarness(run.driver)) return "paid";
  const declared = declaredBillingOf(run);
  if (declared !== undefined) return declared;
  if (run.platform === "local" || isLocalBase(run.apiBase)) return "free";
  const model = run.model;
  if (model !== null && (isContributorSlug(model) || isFreeSlug(model))) {
    return "free";
  }
  return "paid";
}
