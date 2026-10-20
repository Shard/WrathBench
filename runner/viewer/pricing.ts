/**
 * What a run would have cost, in dollars.
 *
 * Two different questions hide behind one number, and this module answers both
 * rather than choosing:
 *
 * - **actual** — what the provider says it charged. OpenRouter reports it per
 *   response (`usage.cost`, in credits, which are dollars); the Claude Code
 *   driver reports it per session (`total_cost_usd` on a `claude_result`,
 *   `runner/src/adapter-claude.ts`). Used verbatim, and null whenever the
 *   provider reports nothing — which is most runs. The one addition: a
 *   claude-code run's turns that ended before the CLI reported their cost are
 *   priced at list and added, and the figure carries both parts and a `*`
 *   wherever it is shown (`backfilled`; operator's decision, 2026-10-08).
 * - **expected** — the price table applied to the run's `TokenTotals`. A
 *   derived figure, never an invoice, and computed even when an actual exists
 *   so the two can be read against each other.
 *
 * An unknown model gets no cost at all. A guessed price is worse than a blank:
 * the run page is read as evidence, and a number with no source behind it
 * cannot be checked. Prices are data, each row dated and sourced, so a stale
 * one is visible rather than buried in an expression.
 *
 * The prices live in the model catalogue (`infra/model-catalogue.json`, read
 * through `infra/model-catalogue.ts`), on each model's own entry; this module
 * holds no rate and no model id, only the rules for which row a run reads.
 *
 * Rates are asked for *as of the run*, never as of today. Every row answers
 * that question the same way, with rate windows: a list of
 * `{ input, output, cacheRead, cacheWrite, from? }` in date order whose first
 * window carries no `from` (`windowAt`; `infra/sync-prices.ts` appends to the
 * synced ones). Re-pricing yesterday's runs at today's catalogue is the
 * failure all three kinds of row avoid.
 *
 * Three kinds of row, by where the figure can come from:
 * - **Anthropic** (`ANTHROPIC_PRICES`) — list prices, by hand, matched on the
 *   model the Claude Code CLI actually served (`resolvedModel`), not the
 *   roster's alias.
 * - **OpenRouter** (`OPENROUTER_PRICES`) — its catalogue, by script, matched
 *   on the id; a codex run matches under `openai/<slug>`, since the Codex CLI's
 *   own slug carries no vendor prefix (`codexPrice`).
 * - **Endpoints** (`ENDPOINT_PRICES`) — paid providers that are not
 *   OpenRouter, by hand, matched on the run's `apiBase` *and* id (operator's
 *   decision, 2026-09-04, on its trigger: a second such provider).
 */

import {
  ANTHROPIC_PRICES,
  ANTHROPIC_UNPRICED,
  ENDPOINT_PRICES,
  OPENROUTER_DELISTED,
  OPENROUTER_PRICES,
  type RateWindow,
} from "../../infra/model-catalogue";
import { declaredBillingOf } from "../src/billing";
import { DEFAULT_DRIVER, driverEntry, eitherHas, entryOf, harnessDriver } from "../src/drivers";
import { isContributorSlug, isFreeSlug, isLocalBase } from "../src/model-cost";
import type { CostBreakdown, CostCoverage, CostFigure, CostView, RunRow, TokenTotals, UnreportedUsage } from "./api-types";

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
  /**
   * Where they came from. `"list"` is the vendor's own published list price;
   * `"catalogue"` is a third-party catalogue's listing of it (models.dev), one
   * step removed from the vendor and said so.
   */
  source: "list" | "catalogue";
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
 * The Anthropic row for a served model id at a date, or null when the
 * catalogue has none.
 *
 * Matched exactly, never by family: `opus` meant Opus 5 until the CLI pin moved
 * to 2.1.280 (2026-09-23) and Opus 5.5 after, and `sonnet` became Sonnet 5.5 on
 * 2.1.284 (2026-09-29), so a family pattern priced Opus 5.5 at Opus 5's rates
 * and matched no Fable at all. The CLI names the model it served on its first
 * line (`claude_system.model`, promoted to `RunRow.resolvedModel`), and that is
 * the id read here; a row lists the spellings it prices (a dated snapshot and
 * its undated name).
 *
 * The rows are Anthropic list prices, by hand. Source:
 * platform.claude.com/docs/en/about-claude/pricing and the release notes, read
 * 2026-10-08 (claude.com/pricing as a cross-check). Checked the same day
 * against the CLI's own `total_cost_usd` on one run per model: Sonnet 5.5, Opus
 * 5.5 and Fable 5.1 reproduce to the cent, and seven Fable 5 runs to within
 * $0.003. Re-read 2026-10-16 against the same page and the Claude API
 * reference's model table: no row's rate had moved. That table (cached
 * 2026-10-06) still lists Sonnet 5.5's cache read at $0.20; the page lists
 * $0.10, which is Sonnet 5.5's second window, from 2026-10-07 (a run started
 * before keeps $0.20).
 *
 * **Cache writes are the 1-hour rate, 2× input.** Every claude-code run so far
 * writes 1-hour cache — `usageRaw.cache_creation.ephemeral_1h_input_tokens`
 * carries the writes and `ephemeral_5m_input_tokens` is 0 — so the 5-minute
 * rate (1.25×) read every run's writes low, by up to 16% of the whole bill on
 * a Haiku 4.5 e360. A run that ever writes 5-minute cache would need the split
 * carried through `normalizeClaudeUsage`; none does today.
 *
 * Sonnet 5 is $2/$10 flat. Its introductory price was announced to rise to
 * $3/$15 on 2026-09-01, and this table used to switch on that date; the rise
 * never happened — the 2026-08-10 release notes made $2/$10 the standard
 * price — so there is no second window.
 *
 * Haiku 5.5 is a decided blank (`ANTHROPIC_UNPRICED`, its entry's
 * `unpriced`): it is priced per request on the prompt's size — $0.10/$0.50
 * (cache read $0.01) for a prompt up to 100K tokens, $0.50/$2.50 ($0.05) above
 * it — and the CLI tiers each API call on its own. A run's token totals cannot
 * say which calls were which, and either flat rate is wrong: the ≤100K rate
 * read the first Haiku 5.5 e90 4.3× low, the >100K rate about 15% high (267 of
 * its 375 calls were over 100K). So it stays a blank, by the rule at the top of
 * this file, and its runs read the CLI's own figure, which prices each call at
 * its own tier. A row could only come back with the tier applied per response
 * when the totals are read.
 */
export function claudePrice(model: string, at: number | null = null): PriceRow | null {
  const row = ANTHROPIC_PRICES.find((p) => p.ids.includes(model));
  if (row === undefined) return null;
  const w = windowAt(row.windows, at);
  if (w === null) return null;
  const when = w.from === undefined ? `read ${row.asOf}` : `in force from ${w.from}, read ${row.asOf}`;
  return {
    id: model,
    input: w.input,
    output: w.output,
    cacheRead: w.cacheRead,
    cacheWrite: w.cacheWrite,
    asOf: w.from ?? row.asOf,
    source: "list",
    asIfMetered: true,
    note: `Anthropic API list price (${when}), cache writes at the 1-hour rate; the claude-code harness bills a subscription, so this is as-if-metered`,
  };
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export const FREE_PRICE: PriceRow = {
  id: "free-tier",
  ...ZERO,
  asOf: "2026-08-22",
  source: "list",
  asIfMetered: true,
  note: "free tier — request-capped, not token-billed",
};

/** `-contributor-free` slugs (OpenCode Zen): free because the provider keeps prompts and completions. */
export const CONTRIBUTOR_PRICE: PriceRow = {
  ...FREE_PRICE,
  id: "contributor-free",
  note: "contributor tier — free; prompts and completions are shared with the provider",
};

/**
 * An openai run whose roster entry declared `billing: "free"` — a stealth
 * preview quoted at zero, say. It needs no price: the sync keeps no 0/0 row for
 * a suffixless id, so the operator's word is the only thing that says free.
 */
export const DECLARED_FREE_PRICE: PriceRow = {
  ...FREE_PRICE,
  id: "declared-free",
  note: "free by the roster entry's own billing — no list price is kept for it",
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
 * `runner/src/model-cost.ts` (the scheduler reads the same verdict);
 * the predicates are re-exported so existing callers keep their names.
 */
export { isFreeSlug, isLocalBase } from "../src/model-cost";

/*
 * Open-model prices, synced from OpenRouter rather than typed in.
 *
 * Each catalogue entry's `prices.openrouter` is written by
 * `infra/sync-prices.ts` (`bun wb data prices`), which reads the provider's own
 * catalogue for every OpenRouter id the model catalogue, the roster and the
 * corpus name. A rate nobody typed is a rate nobody can mistype.
 *
 * **Rate windows.** Each id maps to a *list* of windows in date order rather
 * than to one row, because a rate that moves must not re-price the runs that
 * billed at the old one — `z-ai/glm-5.3-flash`'s launch discount lapsing around
 * 2026-09-09 is the case this exists for. A window carries the four rates plus
 * an optional `from` (`YYYY-MM-DD`, the day it took over); the first window
 * omits `from`, meaning "everything before the next window begins", so every
 * run already on disk when windows arrived keeps the reading it had.
 * `syncedPrice` picks the last window whose `from` is at or before the run's
 * start, and the latest window when a caller asks for no particular date. The
 * Anthropic and endpoint rows carry the same windows, typed by hand.
 *
 * `OPENROUTER_PRICES.asOf` is the day the catalogue was last read, not the day
 * a rate began — a window's own `from` is that, and a window without one is
 * dated by the sync that first wrote it.
 *
 * These models are genuinely metered against the operator's OpenRouter
 * balance, so `asIfMetered` is false: the figure is a list-price estimate of a
 * real bill. The one exception is a codex run reading an `openai/` row: the
 * rates are the same, but that lane bills a ChatGPT subscription, so the same
 * figure is a comparison and `codexPrice` says so. OpenRouter has no cache-write tier for most models — the sync
 * falls back to the input rate, per its own quoting.
 *
 * A free slug never reaches here: `priceFor` answers it with `FREE_PRICE`
 * first, whatever the catalogue quotes. So a 0/0 row is only ever reached for a
 * `:free`/`-free` id — a *suffixless* id quoted at 0/0 would be a paid model
 * reading as free, which is the one shape no row may hold. `parseCatalogue`
 * refuses it, and the sync never writes one (`mergeWindows`): a stealth id that
 * really is free says so with its roster entry's `billing`, which the run
 * records and `priceFor` reads.
 */

/**
 * The window in force at `at`, or the latest when the caller names no date.
 *
 * Null means "the table's current price" — a run with no start date on it, and
 * every caller that just wants today's rate. A date older than every `from`
 * falls back to the earliest window, which is the best the table can say about
 * a run that predates what it knows.
 */
export function windowAt(windows: readonly RateWindow[], at: number | null): RateWindow | null {
  if (windows.length === 0) return null;
  if (at === null) return windows[windows.length - 1]!;
  let chosen: RateWindow | null = null;
  for (const w of windows) {
    if (w.from !== undefined && Date.parse(w.from) > at) break;
    chosen = w;
  }
  return chosen ?? windows[0]!;
}

/**
 * Whose bill a synced row describes.
 *
 * The rates are the same figure read twice. An OpenRouter run meters the
 * operator's balance, so the row is a list-price estimate of a real charge; the
 * *same* row read for a codex run is a comparison, because the Codex CLI bills
 * a flat ChatGPT subscription and reports no dollar figure at all. Only the
 * billing sentence and `asIfMetered` differ, so they are decided here and the
 * window provenance (undated first window against a dated one) is written once.
 */
type SyncedFlavor = "openrouter" | "vendor";

const SYNCED_BILLING: Record<SyncedFlavor, { asIfMetered: boolean; list: string; whose: string }> = {
  openrouter: {
    asIfMetered: false,
    list: "OpenRouter list price",
    whose: "metered against the operator's OpenRouter balance",
  },
  vendor: {
    asIfMetered: true,
    list: "OpenAI API list price via the OpenRouter catalogue",
    whose: "the codex harness bills a ChatGPT subscription, so this is as-if-metered",
  },
};

function syncedRow(model: string, at: number | null, flavor: SyncedFlavor): PriceRow | null {
  const windows = OPENROUTER_PRICES.models[model];
  if (windows === undefined) return null;
  const row = windowAt(windows, at);
  if (row === null) return null;
  const { asIfMetered, list, whose } = SYNCED_BILLING[flavor];
  const when =
    row.from === undefined
      ? `${list}, synced ${OPENROUTER_PRICES.asOf} (infra/sync-prices.ts)`
      : `${list} in force from ${row.from} (catalogue read ${OPENROUTER_PRICES.asOf}, infra/sync-prices.ts)`;
  return {
    id: model,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    asOf: row.from ?? OPENROUTER_PRICES.asOf,
    source: "list",
    asIfMetered,
    note: `${when}; ${whose}`,
  };
}

/** The synced row for an OpenRouter id at a date, or null when the sync does not carry it. */
export function syncedPrice(model: string, at: number | null = null): PriceRow | null {
  return syncedRow(model, at, "openrouter");
}

/**
 * The synced row for a codex model, looked up under the vendor prefix.
 *
 * A Codex catalogue slug never carries one — the CLI calls the model
 * `gpt-6-astra` where OpenRouter calls it `openai/gpt-6-astra` — and nothing in
 * the fleet maps the two, so a codex run read as unpriced and fell off the
 * ladder's cost axis entirely. The prefix is the mapping: the catalogue carries
 * OpenAI's own published list price under it, which is the only sourced figure
 * available for a lane whose CLI reports no cost. Operator's decision,
 * 2026-09-05, on the first codex run (`gpt-6-astra`, verified that day against
 * OpenAI's published API list price: $10/$50/$1 per million).
 *
 * The bare id is still tried first by `priceFor`, so a codex model that one day
 * *is* in the catalogue unprefixed keeps reading its own row and nothing that
 * prices today changes.
 */
export function codexPrice(model: string, at: number | null = null): PriceRow | null {
  return vendorPrice(model, "openai", at);
}

/** The synced row for a bare slug under a catalogue vendor's prefix (`DriverCost.vendor`). */
function vendorPrice(model: string, vendor: string, at: number | null): PriceRow | null {
  if (model.includes("/")) return null;
  return syncedRow(`${vendor}/${model}`, at, "vendor");
}

/**
 * The catalogue vendor a run's bare slug is priced under — a codex run, whose
 * CLI reports no cost — whichever field of the pair carries it.
 */
function vendorOf(run: Pick<PriceableRun, "driver" | "harness">): string | undefined {
  return driverEntry(run.driver)?.cost.vendor ?? harnessDriver(run.harness)?.cost.vendor;
}

/** A run whose CLI reports its own as-if-metered figure (claude-code), whichever field of the pair carries it. */
function isCliReported(run: Pick<PriceableRun, "driver" | "harness">): boolean {
  return eitherHas(run, (d) => d.cost.reported === "cli");
}

/*
 * Paid providers that are not OpenRouter, priced by hand: each model entry's
 * `prices.endpoints`, resolved against its provider (`ENDPOINT_PRICES`).
 *
 * The OpenRouter sync cannot help here: `infra/sync-prices.ts` writes only the
 * windows its catalogue quotes, so a Cerebras rate in an entry's
 * `prices.openrouter` would be emptied on the next run of the script — and
 * OpenRouter's `qwen/qwen3.8-27b` is neither the same id string nor the same
 * rate as Cerebras's `qwen-3.8-27b`. So these rows are typed in, dated and
 * sourced the way the Anthropic rows are, and a stale one is visible rather
 * than silent. Operator's decision, 2026-09-04 (on its stated trigger:
 * `omen-alpha` on OpenCode's pay-as-you-go endpoint was the second
 * non-OpenRouter paid provider to enter the fleet). This is the narrow case
 * "an unknown model gets no cost at all" was not written for — the price is
 * published and known, not guessed — and a row goes in only with a source a
 * reader can check.
 *
 * A row is matched on the run's `apiBase` **and** its model id, never the id
 * alone: the same id string means different money on different hosts, and a
 * bare `omen-alpha` says nothing about which endpoint served it. The base is
 * compared exactly (origin plus path, trailing slash ignored), so a row for
 * `opencode.ai/zen/go/v1` does not reach the free `/zen/v1` slugs and a row
 * for one provider can never fire for a run on another. OpenCode Go's chat
 * base as its docs give it is `/inference/go/openai/v1`; the older
 * `/zen/go/v1` still answers, and `omen-alpha`'s row stays on it (its own
 * provider, `opencode-go-zen`) because its runs recorded that base.
 *
 * Rates are windowed exactly as the synced ones are (first window undated,
 * `windowAt` picks the one in force at the run's start), so a provider that
 * moves its price gets a new window appended by hand with its `from` date and
 * the runs that billed at the old rate keep reading it. A promotional rate
 * whose end is *known* gets its successor window appended on day one; one
 * whose end is not known (`omen-alpha`) carries the fact in its note and gets
 * the window the day the bill changes.
 *
 * Cache tiers, where the listing is silent. Cerebras caches the prefix and
 * bills every input token at the input rate whether it was served from cache
 * or not ("What Cerebras costs"), so its cacheRead and cacheWrite are the
 * input rate rather than a tier below it. A models.dev listing with no
 * cache-write tier (omen-alpha, and the Go models but space-bunny, whose
 * listing states 0) bills a write as ordinary input, the same fallback the
 * OpenRouter sync uses. DeepSeek's platform prices by time of day, which a date
 * window cannot say: its row is the off-peak rate, and a cache miss bills at
 * the input rate. Go's usage limits are dollar amounts and its chat responses
 * carry no `usage.cost`, so the listing is the only figure those runs get; the
 * free Go slugs (`-free`) need no row.
 *
 * `asIfMetered` is false throughout: these endpoints meter the operator's own
 * balance, so the figure is a list-price estimate of a real bill, not a
 * comparison. A row here does not touch the scheduler's free/paid verdict —
 * that stays `runner/src/model-cost.ts`'s.
 */

/** Two api bases name the same endpoint: same origin, same path, trailing slash ignored. */
function sameBase(a: string | null | undefined, b: string): boolean {
  if (a === null || a === undefined || a === "") return false;
  const norm = (u: string): string | null => {
    try {
      const url = new URL(u);
      return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

/** The hand-held endpoint row for a run at a date, or null when no row names its base and id. */
export function providerPrice(run: Pick<PriceableRun, "model" | "apiBase">, at: number | null = null): PriceRow | null {
  const model = run.model ?? "";
  for (const p of ENDPOINT_PRICES) {
    if (p.model !== model || !sameBase(run.apiBase, p.apiBase)) continue;
    const w = windowAt(p.windows, at);
    if (w === null) return null;
    return {
      id: p.id,
      input: w.input,
      output: w.output,
      cacheRead: w.cacheRead,
      cacheWrite: w.cacheWrite,
      asOf: w.from ?? p.asOf,
      source: p.source,
      asIfMetered: false,
      note: w.from === undefined ? p.note : `in force from ${w.from} — ${p.note}`,
    };
  }
  return null;
}

/** Whether a run's base is one the hand-held endpoint rows know at all, whatever the model. */
function isProviderBase(apiBase: string | null | undefined): boolean {
  return ENDPOINT_PRICES.some((p) => sameBase(apiBase, p.apiBase));
}

/*
 * OpenRouter ids the provider's catalogue no longer carries, and why
 * (`OPENROUTER_DELISTED`, an entry's `prices.openrouter[id].delisted`).
 *
 * A delisted model is unpriced in a way running the sync cannot fix — the
 * catalogue has no row to copy, so a sync *empties* the id's windows rather
 * than updating them. That is a different problem from "the sync has not seen
 * this yet", and telling the reader to run a script that cannot help is worse
 * than telling them nothing, so `unpricedNote` answers these ids from the
 * entry instead.
 *
 * The note is also the record of why the id has no windows: the alternative
 * was to hold a rate by hand, and a hand-held rate where the whole point is
 * that nobody types rates in is a number with no source behind it.
 */

/**
 * What a run needs to carry to be priced. A subset of `RunRow`, so tests can be
 * small. `resolvedModel` is optional for the same reason; every caller in
 * `api.ts` passes a row through `withResolved`, so a run that recorded the
 * model it was served carries it here.
 */
export type PriceableRun = Pick<RunRow, "model" | "apiBase" | "platform" | "driver" | "harness" | "declaredBilling"> &
  Partial<Pick<RunRow, "resolvedModel">>;

/**
 * Whether a run is priced from the Claude table at all.
 *
 * Decided on what the run recorded — its harness, driver and launch model —
 * and never on the served id: the runs of the retired `claude-subscription`
 * driver also resolved to `claude-sonnet-5`, and their summed per-response
 * prompt tokens read about 4× the session's real input (docs/COSTS.md, "Rules,
 * each paid for"), so pricing them would put a bill four times too large
 * beside the CLI's own figure. They stay unpriced, as they always were.
 */
function isClaudeRun(run: Pick<PriceableRun, "model" | "driver" | "harness">): boolean {
  return eitherHas(run, (d) => d.cost.table === "claude") || /claude/i.test(run.model ?? "");
}

/** The Claude model a run was served: the CLI's own answer when it recorded one, else the launch string. */
function servedClaudeModel(run: Pick<PriceableRun, "model" | "resolvedModel">): string {
  return run.resolvedModel ?? run.model ?? "";
}

/**
 * The price row for a run, or null when we cannot name one.
 *
 * Matched on the whole run rather than the model string, because the string
 * alone does not say enough: `qwen/qwen3.8-27b` is free only because its
 * `apiBase` is an address on the operator's LAN, a bare `sonnet` is a Claude
 * model only because the harness that ran it was `claude-code` — and which
 * Claude only because the CLI said what it served — and `qwen-3.8-27b` costs
 * $0.99/Mtok only because its `apiBase` is Cerebras.
 *
 * The order is most-specific evidence first. Local base, then a recorded
 * `billing: "free"` (the operator's word; a recorded `paid` leaves the price to
 * the rules below, which price the id), then the free
 * spellings (a `-free` slug is free on any host, so it precedes the provider
 * table), then the provider table — keyed on base *and* id, so it can never
 * fire for an OpenRouter run and cannot shadow a synced answer, while the
 * reverse order would let an id that happens to collide with an OpenRouter id
 * read as OpenRouter-metered on a host that is not OpenRouter — then the synced
 * table by id, then the Claude rows by the model the CLI served.
 *
 * A Claude alias with no served model recorded gets no row. No family fallback
 * stands in: the alias meant different generations at different CLI pins, and
 * every claude-code run in the corpus names its served model, stamped or in its
 * trajectory, so a fallback would only ever be a guess.
 */
export function priceFor(run: PriceableRun, at: number | null = null): PriceRow | null {
  const model = run.model ?? "";
  if (isLocalBase(run.apiBase)) return LOCAL_PRICE;
  if (declaredBillingOf(run) === "free") return DECLARED_FREE_PRICE;
  if (isContributorSlug(model)) return CONTRIBUTOR_PRICE;
  if (isFreeSlug(model)) return FREE_PRICE;
  const provider = providerPrice(run, at);
  if (provider !== null) return provider;
  const open = syncedPrice(model, at);
  if (open !== null) return open;
  const vendor = vendorOf(run);
  if (vendor !== undefined) {
    const row = vendorPrice(model, vendor, at);
    if (row !== null) return row;
  }
  if (!isClaudeRun(run)) return null;
  return claudePrice(servedClaudeModel(run), at);
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
 * Several different problems wear the same blank: a Claude model we do not
 * carry, one we decided not to price (`ANTHROPIC_UNPRICED`), a Claude alias whose
 * run never said what it was served, an OpenRouter model the sync has not
 * seen (fixed by running the script), one the catalogue has dropped (which the
 * script cannot fix, and `OPENROUTER_DELISTED` says so in its own words), and a
 * model on a paid provider the hand-held table knows but has no row for (which
 * the script cannot price either — the row is typed into the entry's `prices.endpoints`,
 * with a source).
 */
export function unpricedNote(run: PriceableRun): string {
  const delisted = OPENROUTER_DELISTED[run.model ?? ""];
  if (delisted !== undefined) return delisted;
  // Before the Claude branch: a codex slug is a bare model id with no vendor in
  // it, so the harness is the only thing that says which table can answer, and
  // the answer is the sync's — under `openai/<slug>` rather than the bare id.
  if (vendorOf(run) !== undefined) {
    return "no synced price — run `bun wb data prices` (infra/sync-prices.ts; a codex model is priced from the catalogue's `openai/` id)";
  }
  if (isClaudeRun(run)) {
    const served = servedClaudeModel(run);
    const decided = ANTHROPIC_UNPRICED[served];
    if (decided !== undefined) return decided;
    if ((run.resolvedModel ?? null) === null && !served.startsWith("claude-")) {
      return `\`${served}\` is an alias the CLI resolves at launch, and this run recorded no served model, so which model it was — and its price — is not known; tokens only, never a guess`;
    }
    return `no price on file for ${served} — tokens only, never a guess; a new Claude model needs a dated, sourced prices.anthropic on its entry in infra/model-catalogue.json`;
  }
  if (isProviderBase(run.apiBase)) {
    return "no hand-held price for this model on this provider — add a dated, sourced prices.endpoints row to its entry in infra/model-catalogue.json; the OpenRouter sync cannot price it";
  }
  return "no synced price — run `bun wb data prices` (infra/sync-prices.ts)";
}

/**
 * The provider's own figure for a run, or a blank saying it reported none.
 *
 * Two shapes, one meaning: a per-response `usage.cost` (OpenRouter's, in
 * credits, which are dollars; OpenCode's pay-as-you-go endpoint reports the
 * same field) and the Claude Agent SDK's per-session `total_cost_usd`.
 * `tail.ts` sums whichever the run carries; this only has to say what the
 * number is, and whose.
 *
 * One exception to "verbatim": a claude-code run whose CLI never reported a
 * cost for some turns (`coverage.unreported`) gets those turns backfilled, by
 * `backfilled` below.
 */
function actualCost(
  run: PriceableRun & { startedAt?: number | null },
  reportedUsd: number | null,
  coverage: CostCoverage | null,
): CostFigure {
  if (reportedUsd === null) return none("provider reports no cost for this run");
  const claudeCode = isCliReported(run);
  const unreported = coverage?.unreported;
  if (claudeCode && unreported !== undefined && unreported.turns > 0) return backfilled(run, reportedUsd, unreported);
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
      : isProviderBase(run.apiBase)
        ? `the provider's own charge, summed over the run's responses (usage.cost, as the endpoint reports it)${partial}`
        : `the provider's own charge, summed over the run's responses (OpenRouter usage.cost, in credits)${partial}`,
  };
}

const usdText = (v: number): string => `$${v.toFixed(2)}`;

/**
 * A claude-code actual with its unreported turns put back.
 *
 * The CLI reports cost only on a `claude_result`, which lands only when a turn
 * ends cleanly, so a turn the watchdog killed or a pause cut off is in no
 * session's `total_cost_usd` — on the fable-none freeplay run of 2026-08-29 two
 * paused sessions left $839 standing for ~$1,588 of tokens. Operator's
 * decision, 2026-10-08: backfill, and mark it. Those turns' tokens are priced
 * at the run's own list row as of its start — the served-model row the
 * expected figure uses — and added to the CLI's figure; both parts ride on
 * `backfill` and every surface shows the sum with a `*` whose hover is the
 * note. Where the model has no row (Haiku 5.5, tiered per request) nothing is
 * added, and the figure is still marked, because it still reads low.
 *
 * The estimate is a floor: those turns' output is the API's opening snapshot,
 * under-read (`tokenTotals`), and only their input side is a finished count.
 */
function backfilled(run: PriceableRun & { startedAt?: number | null }, reportedUsd: number, gap: UnreportedUsage): CostFigure {
  const price = priceFor(run, run.startedAt ?? null);
  const turns = gap.turns === 1 ? "1 turn that ended before the CLI reported a cost" : `${gap.turns} turns that ended before the CLI reported a cost`;
  const estimate =
    price === null
      ? null
      : breakdownTotal(
          costOf(
            {
              source: "reported",
              contextTokens: 0,
              promptTokens: gap.promptTokens,
              completionTokens: gap.completionTokens,
              totalTokens: gap.promptTokens + gap.completionTokens,
              cacheReadTokens: gap.cacheReadTokens,
              cacheWriteTokens: gap.cacheWriteTokens,
              turns: gap.turns,
            },
            price,
          ),
        );
  const bill = "billed against a subscription, so not an invoice";
  return {
    usd: reportedUsd + (estimate ?? 0),
    basis: "reported",
    asIfMetered: true,
    breakdown: null,
    priceId: null,
    asOf: null,
    note:
      estimate === null || price === null
        ? `the CLI's own total_cost_usd, which leaves out ${turns}; the model has no list price to estimate ${gap.turns === 1 ? "it" : "them"} at, so this reads low — ${bill}`
        : `includes ${usdText(estimate)} estimated at ${price.id} list price for ${turns} (a floor: output there is under-read); the CLI's own figure is ${usdText(reportedUsd)} — ${bill}`,
    backfill: { reportedUsd, usd: estimate, turns: gap.turns },
  };
}

/** The price table applied to the run's tokens: an estimate, never a bill. */
function expectedCost(args: {
  run: PriceableRun & { startedAt?: number | null };
  tokens: TokenTotals | null;
}): CostFigure {
  const { run, tokens } = args;
  const claudeCode = isCliReported(run);
  // A codex run bills a ChatGPT subscription and reports no cost at all, so a
  // list-price figure over its tokens is as-if-metered whatever the row says.
  const codex = vendorOf(run) !== undefined;
  const price = priceFor(run, run.startedAt ?? null);
  if (price === null) return none(unpricedNote(run));
  if (tokens === null) return none("no token totals for this run");
  const free = price.input === 0 && price.output === 0;
  if (tokens.source !== "reported" && !free) {
    return none("tokens were estimated from characters, not reported by the provider — no price computed");
  }
  const breakdown = costOf(tokens, price);
  /*
   * A claude-code run's own figure is the CLI's `total_cost_usd`, and that is
   * the one to read; this is the table over the same tokens. They agree to the
   * cent where the row is right (checked 2026-10-08 on Sonnet 5.5, Opus 5.5 and
   * Fable 5.1), so a gap between them points at the row or at turns the CLI
   * never reported. The old "upper bound" warning here came from the retired
   * `claude-subscription` driver, whose per-response sums read ~4× high
   * (docs/COSTS.md, "Rules, each paid for"); those runs are not priced at all.
   */
  const caveat = claudeCode && !free ? " — where the CLI reported its own figure, that is the one to read" : "";
  return {
    usd: breakdownTotal(breakdown),
    basis: "list-price",
    asIfMetered: price.asIfMetered || codex,
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
  /** How many of the run's responses carried a charge, and a claude-code
   * run's unreported turns, from `responseCostCoverage`. Absent where the
   * caller does not count. */
  coverage?: CostCoverage | null;
}): CostView {
  const actual = actualCost(args.run, args.reportedUsd, args.coverage ?? null);
  const expected = expectedCost(args);
  return { ...expected, actual, expected };
}

/** A roster entry as far as pricing reads it (`RosterSpec` in `infra/run-roster.ts`). */
export interface PriceableEntry {
  model: string;
  /** Absent means the openai driver, as on the roster. */
  driver?: string | null;
  apiBase?: string | null;
  billing?: "free" | "paid";
}

/**
 * Why a roster entry's runs would read with no expected cost, or null when
 * they will carry one.
 *
 * The gap this closes: the gpt-6 codex models joined the roster on 2026-10-01 and
 * read unpriced for a week, because nothing tied the roster to the price
 * tables and the sync that would have priced them was never re-run. It is
 * asked of the entry as a run of it would be priced today — the same
 * `priceFor` — so it cannot disagree with the run page.
 *
 * Two kinds of entry are not gaps. A decided blank (`OPENROUTER_DELISTED`,
 * `ANTHROPIC_UNPRICED`) already says why on every run. A claude-code alias
 * (`sonnet`, `opus`) resolves only when the CLI starts, so nothing here can
 * say what it will be served; its runs are priced on the served model they
 * record, and an unpriced one reads so on the run page.
 *
 * A warning, never a refusal: a model with no price yet is still runnable.
 */
export function rosterPriceGap(entry: PriceableEntry): string | null {
  const driver = entry.driver ?? DEFAULT_DRIVER;
  const known = driverEntry(driver);
  const harness = (known ?? entryOf(DEFAULT_DRIVER)).harness;
  const run: PriceableRun = { model: entry.model, apiBase: entry.apiBase ?? null, platform: null, driver, harness };
  if (entry.billing !== undefined) run.declaredBilling = entry.billing;
  const prefix = known?.cost.modelPrefix;
  if (prefix !== undefined && !entry.model.startsWith(prefix)) return null;
  if (priceFor(run) !== null) return null;
  if (OPENROUTER_DELISTED[entry.model] !== undefined || ANTHROPIC_UNPRICED[entry.model] !== undefined) return null;
  return unpricedNote(run);
}
