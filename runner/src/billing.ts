/**
 * Whether a run (or a roster entry's runs) cost the operator money: the
 * READER's verdict, and the only one any page, the public snapshot or the
 * Every Eval Ever export shows.
 *
 * **Free means literally free** (operator, 2026-11-16): an endpoint that
 * charges nothing, or hardware the operator already owns. Usage paid for with
 * a subscription is not free — a Claude Code or ChatGPT plan, or OpenCode Go's
 * allowance, whose responses report a `usage.cost` of zero until the allowance
 * is spent — so those runs read `paid` here and show under "exclude free".
 *
 * There are two billing verdicts in this repo and they disagree on purpose.
 * `billingOf` in `model-cost.ts` answers **"which side of a metered key may
 * carry this model?"** — a `claude-code` job bills a flat subscription, so it
 * spends none of the metered budget and lands on `free` there, which is what a
 * metered credential's `billing` is matched against (runner/src/credential-slots.ts).
 * It is the scheduler's alone and never reaches a reader. This one answers
 * **"did we pay for this run?"**. Sharing the two would silently re-scope
 * which credential carries a run, so they stay two functions with one shared
 * set of predicates and this comment.
 *
 * The rules, in order:
 *
 * - a driver that reaches no model (the scripted reference) is **free**;
 * - a subscription harness or driver (claude-code, codex) is **paid** — a
 *   subscription is a bill;
 * - a `billing` the run recorded at launch wins over everything below — the
 *   roster entry's own word, for the id the rules would put on the wrong side
 *   (a stealth id quoted at zero with no free suffix). Honoured on the openai
 *   driver only: a subscription driver's bill is the subscription;
 * - a local/LAN api base, or a run stamped `platform: "local"`, is free — the
 *   operator's own hardware;
 * - a `:free` (OpenRouter) / `-free` (OpenCode Zen and Go) /
 *   `-contributor-free` slug is free;
 * - everything else is paid, OpenCode Go's other slugs included.
 *
 * A run that recorded no model at all still gets a verdict, because every other
 * clause can still answer; with nothing to go on it reads `paid`, which is the
 * side that does not quietly shrink a spend.
 */

import { driverEntry, eitherHas } from "./drivers";
import {
  isContributorSlug,
  isFreeSlug,
  isLocalBase,
  type Billing,
} from "./model-cost";

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

/** The harnesses (and the drivers of the same name) that bill a flat subscription: Claude Code, Codex (`bill`, drivers.ts). */
export function isSubscriptionHarness(name: string | null | undefined): boolean {
  return eitherHas({ driver: name, harness: name }, (d) => d.bill === "subscription");
}

/**
 * The billing a run recorded at launch, where the reader honours one: the
 * openai driver only. `priceFor` asks the same function before pricing a
 * recorded free, so the verdict and the price cannot drift apart.
 */
export function declaredBillingOf(run: Pick<BillableRun, "driver" | "declaredBilling">): Billing | undefined {
  if (driverEntry(run.driver)?.endpoint !== true) return undefined;
  return run.declaredBilling ?? undefined;
}

/** Did this run cost money? See the module comment for why it is not `billingOf`. */
export function runBilling(run: BillableRun): Billing {
  // The scripted reference reaches no model and no provider: nothing bills.
  if (driverEntry(run.driver)?.bill === "none") return "free";
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

/** What a roster entry's projection (`ModelState`, runner/src/models.ts) knows about who serves it. */
export interface BillableEntry {
  model: string;
  apiBase?: string | null;
  platform?: string | null;
  harness?: string | null;
  driver?: string | null;
  /** The entry's own `billing`, as written in the roster; absent when derived. */
  declaredBilling?: Billing | null;
}

/**
 * A roster entry's reader verdict: what its runs read, by the same rules as
 * `runBilling`, so the models page and its runs cannot disagree. Never the
 * entry's `ModelState.billing`, which is the scheduler's.
 */
export function entryBilling(e: BillableEntry): Billing {
  return runBilling({
    model: e.model,
    apiBase: e.apiBase ?? null,
    platform: e.platform ?? null,
    harness: e.harness ?? null,
    driver: e.driver ?? null,
    declaredBilling: e.declaredBilling ?? null,
  });
}
