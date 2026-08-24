/**
 * What a run would have cost, in dollars.
 *
 * Two different questions hide behind one number, and this module answers both
 * rather than choosing:
 *
 * - **actual** — what the provider says it charged. OpenRouter reports it per
 *   response (`usage.cost`, in credits, which are dollars); the Claude Code
 *   driver reports it per session (`total_cost_usd` on a `claude_result`,
 *   `runner/src/adapter-claude.ts`). Used verbatim, never recomputed, and null
 *   whenever the provider reports nothing — which is most runs.
 * - **expected** — the price table applied to the run's `TokenTotals`. A
 *   derived figure, never an invoice, and computed even when an actual exists
 *   so the two can be read against each other.
 *
 * An unknown model gets no cost at all. A guessed price is worse than a blank:
 * the run page is read as evidence, and a number with no source behind it
 * cannot be checked. Prices are data, each row dated and sourced, so a stale
 * one is visible rather than buried in an expression.
 *
 * Figures come from the 2026-08-23 COSTS.md cross-check (§3 of `git show d752ef7:docs/COSTS.md`; the snapshot sections left the live doc on 2026-08-24), which checked the Sonnet row
 * against a real `costUsd` ($43.23 computed vs $43.90 reported, within 1.5%).
 */

import { isAllowlistedFree, isContributorSlug, isFreeSlug, isLocalBase } from "../src/model-cost";
import synced from "./prices.openrouter.json";
import type { CostBreakdown, CostFigure, CostView, RunRow, TokenTotals } from "./api-types";

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
 * and they are the ones that cross-check verified. Everything else the fleet
 * runs today is free-tier or local, handled by the two rules below; paid open
 * models are priced from the synced OpenRouter table (`SYNCED_PRICES`).
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
 * Open-model prices, synced from OpenRouter rather than typed in.
 *
 * `prices.openrouter.json` is written by `infra/sync-prices.ts` (`bun run
 * sync-prices`), which reads the provider's own catalogue and keeps the rows
 * the roster and the corpus actually need. A rate nobody typed is a rate nobody
 * can mistype, and the file's `asOf` dates every row in one place.
 *
 * These models are genuinely metered against the operator's OpenRouter
 * balance, so `asIfMetered` is false: the figure is a list-price estimate of a
 * real bill. OpenRouter has no cache-write tier for most models — the sync
 * falls back to the input rate, per its own quoting.
 *
 * A free slug never reaches here: `priceFor` answers it with `FREE_PRICE`
 * first, whatever the catalogue quotes.
 */
export type SyncedRow = Pick<PriceRow, "input" | "output" | "cacheRead" | "cacheWrite">;

export const SYNCED_PRICES: { asOf: string; models: Record<string, SyncedRow> } = synced;

/** The synced row for an OpenRouter id, or null when the sync does not carry it. */
export function syncedPrice(model: string): PriceRow | null {
  const row = SYNCED_PRICES.models[model];
  if (row === undefined) return null;
  return {
    id: model,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    asOf: SYNCED_PRICES.asOf,
    source: "list",
    asIfMetered: false,
    note: `OpenRouter list price, synced ${SYNCED_PRICES.asOf} (infra/sync-prices.ts); metered against the operator's OpenRouter balance`,
  };
}

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
  const open = syncedPrice(model);
  if (open !== null) return open;
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
function none(note: string): CostFigure {
  return { usd: null, basis: "none", asIfMetered: false, breakdown: null, priceId: null, asOf: null, note };
}

/**
 * Why a run has no price row, in the words the reader can act on.
 *
 * A Claude model we do not carry and an OpenRouter model the sync has not seen
 * are different problems: the second is fixed by running the script.
 */
function unpricedNote(run: PriceableRun): string {
  const claude = run.harness === "claude-code" || run.driver === "claude-code" || /claude/i.test(run.model ?? "");
  if (claude) return "no price on file for this model — tokens only, never a guess";
  return "no synced price — run `bun infra/sync-prices.ts`";
}

/**
 * The provider's own figure for a run, or a blank saying it reported none.
 *
 * Two providers, one meaning: OpenRouter bills per response (`usage.cost`, in
 * credits, which are dollars) and the Claude Agent SDK bills per session
 * (`total_cost_usd`). `tail.ts` sums whichever the run carries; this only has
 * to say what the number is.
 */
function actualCost(
  run: PriceableRun,
  reportedUsd: number | null,
  coverage: { costed: number; uncosted: number } | null,
): CostFigure {
  if (reportedUsd === null) return none("provider reports no cost for this run");
  const claudeCode = run.harness === "claude-code" || run.driver === "claude-code";
  /*
   * A run whose process was replaced mid-flight (the fleet resumes rather than
   * recreates) can hold responses from before the adapter recorded the
   * provider's charge and responses from after. The sum is then a bill for part
   * of the run wearing the shape of a bill for all of it, so it says which.
   * Only meaningful where the charge is per response: the claude-code figure is
   * one number for the whole session and never partial this way.
   */
  const partial =
    coverage !== null && coverage.costed > 0 && coverage.uncosted > 0
      ? ` — partial: ${coverage.uncosted} of ${coverage.costed + coverage.uncosted} responses reported no cost`
      : "";
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
      : `the provider's own charge, summed over the run's responses (OpenRouter usage.cost, in credits)${partial}`,
  };
}

/** The price table applied to the run's tokens: an estimate, never a bill. */
function expectedCost(args: {
  run: PriceableRun & { startedAt?: number | null };
  tokens: TokenTotals | null;
}): CostFigure {
  const { run, tokens } = args;
  const claudeCode = run.harness === "claude-code" || run.driver === "claude-code";
  const price = priceFor(run, run.startedAt ?? null);
  if (price === null) return none(unpricedNote(run));
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

/**
 * The two cost figures for one run.
 *
 * They are not ranked. `actual` is what the provider charged and `expected` is
 * what this repo's table says it should have — the point of carrying both is
 * that a gap between them is information (a stale price row, an opt-in that
 * never landed), and a single number with a precedence rule hides it.
 *
 * The top-level fields are `expected`, kept populated for one release so
 * consumers written against the old single-figure shape keep working.
 */
export function runCost(args: {
  run: PriceableRun & { startedAt?: number | null };
  tokens: TokenTotals | null;
  /** The provider's own total: OpenRouter `usage.cost` summed, or the Claude
   * SDK's `total_cost_usd`. Null when the run carries neither. */
  reportedUsd: number | null;
  /** How many of the run's responses carried a charge, from
   * `responseCostCoverage`. Absent where the caller does not count. */
  coverage?: { costed: number; uncosted: number } | null;
}): CostView {
  const actual = actualCost(args.run, args.reportedUsd, args.coverage ?? null);
  const expected = expectedCost(args);
  return { ...expected, actual, expected };
}
