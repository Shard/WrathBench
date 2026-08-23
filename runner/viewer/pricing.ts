/**
 * What a run would have cost, in dollars.
 *
 * Two different questions hide behind one number, and this module keeps them
 * apart:
 *
 * - **reported** — the Claude Code driver's own `total_cost_usd`, recorded on a
 *   `claude_result` record (`runner/src/adapter-claude.ts`). That is the SDK's
 *   accounting of its own session and is used verbatim; nothing here recomputes
 *   it. It exists only on a naturally completed session, so most claude-code
 *   runs do not have one.
 * - **list-price** — this table applied to the run's `TokenTotals`. A derived
 *   figure, never an invoice.
 *
 * An unknown model gets no cost at all. A guessed price is worse than a blank:
 * the run page is read as evidence, and a number with no source behind it
 * cannot be checked. Prices are data, each row dated and sourced, so a stale
 * one is visible rather than buried in an expression.
 *
 * Figures come from `docs/COSTS.md` §3, which cross-checked the Sonnet row
 * against a real `costUsd` ($43.23 computed vs $43.90 reported, within 1.5%).
 */

import { isAllowlistedFree, isContributorSlug, isFreeSlug, isLocalBase } from "../src/model-cost";
import type { CostBreakdown, CostView, RunRow, TokenTotals } from "./api-types";

/** One priced model: dollars per million tokens, with where the figure is from. */
export interface PriceRow {
  /** What the row is called on screen, not a model string to match on. */
  id: string;
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** When these figures were taken. A row is stale, never silently current. */
  asOf: string;
  /** Where they came from. `"list"` is the vendor's published list price. */
  source: "list";
  /**
   * True when the operator does not actually pay this per token — a flat
   * subscription, a free tier, or hardware they already own. The figure is then
   * "what this would have cost if metered", which is a comparison and not a
   * bill.
   */
  asIfMetered: boolean;
  note: string;
}

/**
 * The named models.
 *
 * Anthropic rows only: they are the ones with a non-zero price in this fleet,
 * and they are the ones `docs/COSTS.md` §3 verified. Everything else the fleet
 * runs today is free-tier or local, handled by the two rules below; paid open
 * models live in `OPEN_PRICES`.
 *
 * Sonnet 5 is under introductory pricing **through 2026-08-31** — that is what
 * COSTS.md's cross-check showed is really billing, so it is what the row holds.
 * `standardAfter` carries the rates that take over, and `priceFor` switches to
 * them once the run's own start date is past the lapse. A price table that
 * silently keeps charging an expired promotion is the failure this avoids.
 */
export const CLAUDE_PRICES: (PriceRow & {
  match: RegExp;
  standardAfter?: { from: string; input: number; output: number; cacheRead: number; cacheWrite: number };
})[] = [
  {
    id: "claude-opus-5",
    match: /opus/i,
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    asOf: "2026-08-22",
    source: "list",
    asIfMetered: true,
    note: "Anthropic API list price; the claude-code harness bills a subscription, so this is as-if-metered",
  },
  {
    id: "claude-sonnet-5",
    match: /sonnet/i,
    input: 2.0,
    output: 10.0,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    standardAfter: { from: "2026-09-01", input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    asOf: "2026-08-22",
    source: "list",
    asIfMetered: true,
    note: "introductory list price through 2026-08-31 ($3/$15 after); the claude-code harness bills a subscription, so this is as-if-metered",
  },
  {
    id: "claude-haiku-4.5",
    match: /haiku/i,
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    asOf: "2026-08-22",
    source: "list",
    asIfMetered: true,
    note: "Anthropic API list price; not in the current fleet, kept for reference",
  },
];

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export const FREE_PRICE: PriceRow = {
  id: "free-tier",
  ...ZERO,
  asOf: "2026-08-22",
  source: "list",
  asIfMetered: true,
  note: "free tier — request-capped, not token-billed (docs/COSTS.md §1)",
};

/** `-contributor-free` slugs (OpenCode Zen): free because the provider keeps prompts and completions. */
export const CONTRIBUTOR_PRICE: PriceRow = {
  ...FREE_PRICE,
  id: "contributor-free",
  note: "contributor tier — free; prompts and completions are shared with the provider",
};

export const LOCAL_PRICE: PriceRow = {
  id: "local",
  ...ZERO,
  asOf: "2026-08-22",
  source: "list",
  asIfMetered: true,
  note: "local — served from the operator's own hardware, no marginal token cost",
};

/**
 * The free/local/paid split is a model property decided once in
 * `runner/src/model-cost.ts` (the scheduler reads the same verdict, ADR-0034);
 * the predicates are re-exported so existing callers keep their names.
 */
export { isFreeSlug, isLocalBase } from "../src/model-cost";

/**
 * Paid open models, matched on the exact OpenRouter id. These are genuinely
 * metered (the operator's OpenRouter balance), so `asIfMetered` is false and the
 * figure is a list-price estimate of a real bill. OpenRouter quotes per token;
 * rows hold dollars per million. No cache-write tier on OpenRouter: a cache
 * write is billed as input, so `cacheWrite` equals `input`.
 */
export const OPEN_PRICES: (PriceRow & { match: string })[] = [
  {
    id: "deepseek-v4-flash-0731",
    match: "deepseek/deepseek-v4-flash-0731",
    input: 0.08,
    output: 0.18,
    cacheRead: 0.016,
    cacheWrite: 0.08,
    asOf: "2026-08-23",
    source: "list",
    asIfMetered: false,
    note: "OpenRouter list price (GET /api/v1/models, 2026-08-23); metered against the operator's OpenRouter balance",
  },
  {
    id: "deepseek-v4-flash-0423",
    match: "deepseek/deepseek-v4-flash",
    input: 0.052,
    output: 0.103,
    cacheRead: 0.0103,
    cacheWrite: 0.052,
    asOf: "2026-08-23",
    source: "list",
    asIfMetered: false,
    note: "the April snapshot, run once by mistake on 2026-08-23 and ended by hand; OpenRouter list price",
  },
];

/** What a run needs to carry to be priced. A subset of `RunRow`, so tests can be small. */
export type PriceableRun = Pick<RunRow, "model" | "apiBase" | "platform" | "driver" | "harness">;

/**
 * The price row for a run, or null when we cannot name one.
 *
 * Matched on the whole run rather than the model string, because the string
 * alone does not say enough: `qwen/qwen3.8-27b` is free only because its
 * `apiBase` is an address on the operator's LAN, and a bare `sonnet` is a
 * Claude model only because the harness that ran it was `claude-code`.
 */
export function priceFor(run: PriceableRun, at: number | null = null): PriceRow | null {
  const model = run.model ?? "";
  if (isLocalBase(run.apiBase)) return LOCAL_PRICE;
  if (isContributorSlug(model)) return CONTRIBUTOR_PRICE;
  if (isFreeSlug(model) || isAllowlistedFree(model)) return FREE_PRICE;
  for (const p of OPEN_PRICES) if (p.match === model) return { ...p };
  const claude = run.harness === "claude-code" || run.driver === "claude-code" || /claude/i.test(model);
  if (!claude) return null;
  for (const p of CLAUDE_PRICES) {
    if (!p.match.test(model)) continue;
    const std = p.standardAfter;
    if (std !== undefined && at !== null && at >= Date.parse(std.from)) {
      return {
        id: p.id,
        input: std.input,
        output: std.output,
        cacheRead: std.cacheRead,
        cacheWrite: std.cacheWrite,
        asOf: p.asOf,
        source: "list",
        asIfMetered: p.asIfMetered,
        note: `standard list price (the introductory rate lapsed ${std.from}); the claude-code harness bills a subscription, so this is as-if-metered`,
      };
    }
    return { ...p };
  }
  return null;
}

/**
 * Dollars for a run's tokens at one price row.
 *
 * Cache reads and cache writes are a *subset* of the prompt on both usage
 * shapes the viewer normalises (see `reportedUsage` in `tail.ts`), so the
 * full-price input is what is left of the prompt once both come out of it.
 */
export function costOf(tokens: TokenTotals, price: PriceRow): CostBreakdown {
  const read = tokens.cacheReadTokens ?? 0;
  const write = tokens.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, tokens.promptTokens - read - write);
  return {
    input: (fresh * price.input) / 1e6,
    output: (tokens.completionTokens * price.output) / 1e6,
    cacheRead: (read * price.cacheRead) / 1e6,
    cacheWrite: (write * price.cacheWrite) / 1e6,
  };
}

export function breakdownTotal(b: CostBreakdown): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite;
}

/** No cost, with a reason. The blank is a statement, so it always carries one. */
function none(note: string): CostView {
  return { usd: null, basis: "none", asIfMetered: false, breakdown: null, priceId: null, asOf: null, note };
}

/**
 * The cost figure for one run.
 *
 * Precedence is not a preference: a driver that reported its own cost has
 * settled the question, and this table is only ever a reconstruction of one.
 */
export function runCost(args: {
  run: PriceableRun & { startedAt?: number | null };
  tokens: TokenTotals | null;
  /** `total_cost_usd` summed off the run's `claude_result` records, or null. */
  reportedUsd: number | null;
}): CostView {
  const { run, tokens, reportedUsd } = args;
  const claudeCode = run.harness === "claude-code" || run.driver === "claude-code";
  if (reportedUsd !== null) {
    return {
      usd: reportedUsd,
      basis: "reported",
      // A claude-code run is billed against a flat subscription; the SDK's
      // figure is what the same session would have cost on the metered API.
      asIfMetered: claudeCode,
      breakdown: null,
      priceId: null,
      asOf: null,
      note: claudeCode
        ? "the Claude Agent SDK's own total_cost_usd for this session — billed against a subscription, so not an invoice"
        : "reported by the driver",
    };
  }
  const price = priceFor(run, run.startedAt ?? null);
  if (price === null) return none("no price on file for this model — tokens only, never a guess");
  if (tokens === null) return none("no token totals for this run");
  const free = price.input === 0 && price.output === 0;
  if (tokens.source !== "reported" && !free) {
    return none("tokens were estimated from characters, not reported by the provider — no price computed");
  }
  const breakdown = costOf(tokens, price);
  /*
   * COSTS.md §3 measured this exact reconstruction against a real `costUsd` on
   * the claude-code harness and found the summed per-response usage overstates
   * the session by roughly 4x (783.6M summed prompt tokens against 201.6M real)
   * while undercounting output. The figure is still shown — the alternative is
   * a blank where an order of magnitude is useful — but it does not get to be
   * shown bare.
   */
  const caveat =
    claudeCode && !free
      ? " — per-response usage sums overstate this harness's real bill (docs/COSTS.md §3), so read it as an upper bound"
      : "";
  return {
    usd: breakdownTotal(breakdown),
    basis: "list-price",
    asIfMetered: price.asIfMetered,
    breakdown,
    priceId: price.id,
    asOf: price.asOf,
    note: `${price.id} ${price.source} price as of ${price.asOf}: ${price.note}${caveat}`,
  };
}
