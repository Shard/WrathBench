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
 * Rates are asked for *as of the run*, never as of today. All three tables
 * answer that question the same way, with rate windows: each id maps to a list
 * of `{ input, output, cacheRead, cacheWrite, from? }` in date order and the
 * first window carries no `from` (see `SYNCED_PRICES` below for the format and
 * `infra/sync-prices.ts` for who appends to the synced one). Re-pricing
 * yesterday's runs at today's catalogue is the failure all three avoid.
 *
 * Three tables, by where the figure can come from:
 * - `CLAUDE_PRICES` — Anthropic list prices, by hand, matched on the model the
 *   Claude Code CLI actually served (`resolvedModel`), not the roster's alias.
 * - `SYNCED_PRICES` — OpenRouter's catalogue, by script, matched on the id; a
 *   codex run matches under `openai/<slug>`, since the Codex CLI's own slug
 *   carries no vendor prefix (`codexPrice`).
 * - `PROVIDER_PRICES` — paid providers that are not OpenRouter, by hand,
 *   matched on the run's `apiBase` *and* id (operator's decision, 2026-09-04,
 *   on its trigger: a second such provider).
 */

import { declaredBillingOf } from "../src/billing";
import { isContributorSlug, isFreeSlug, isLocalBase } from "../src/model-cost";
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
 * One Anthropic model, by the id the Claude Code CLI served it under.
 *
 * Matched exactly, never by family: `opus` meant Opus 5 until the CLI pin moved
 * to 2.1.280 (2026-09-23) and Opus 5.5 after, and `sonnet` became Sonnet 5.5 on
 * 2.1.284 (2026-09-29), so a family pattern priced Opus 5.5 at Opus 5's rates
 * and matched no Fable at all. The CLI names the model it served on its first
 * line (`claude_system.model`, promoted to `RunRow.resolvedModel`), and that is
 * the id read here.
 */
export interface ClaudePriceRow {
  /** The served ids this row prices, exact — a dated snapshot spelling included. */
  ids: readonly string[];
  /** Rate windows in date order; the first carries no `from`. Dollars per million tokens. */
  windows: readonly SyncedWindow[];
  /** The day these list prices were read. */
  asOf: string;
}

/**
 * Anthropic list prices, by hand.
 *
 * Source: platform.claude.com/docs/en/about-claude/pricing and the release
 * notes, read 2026-10-08 (claude.com/pricing as a cross-check). Checked the
 * same day against the CLI's own `total_cost_usd` on one run per model: Sonnet
 * 5.5, Opus 5.5 and Fable 5.1 reproduce to the cent, and seven Fable 5 runs to
 * within $0.003.
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
 * Haiku 5.5 is deliberately absent: see `CLAUDE_UNPRICED`.
 */
export const CLAUDE_PRICES: readonly ClaudePriceRow[] = [
  { ids: ["claude-fable-5-1"], windows: [{ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 }], asOf: "2026-10-08" },
  { ids: ["claude-fable-5"], windows: [{ input: 10, output: 50, cacheRead: 1.0, cacheWrite: 20 }], asOf: "2026-10-08" },
  { ids: ["claude-opus-5-5"], windows: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 }], asOf: "2026-10-08" },
  { ids: ["claude-opus-5"], windows: [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }], asOf: "2026-10-08" },
  { ids: ["claude-opus-4-8"], windows: [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }], asOf: "2026-10-08" },
  { ids: ["claude-opus-4-7"], windows: [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }], asOf: "2026-10-08" },
  { ids: ["claude-opus-4-6"], windows: [{ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 }], asOf: "2026-10-08" },
  {
    ids: ["claude-sonnet-5-5"],
    // Cache reads dropped to $0.10 on 2026-10-07; a run started before keeps $0.20.
    windows: [
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
      { from: "2026-10-07", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
    ],
    asOf: "2026-10-08",
  },
  { ids: ["claude-sonnet-5"], windows: [{ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 }], asOf: "2026-10-08" },
  {
    ids: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    windows: [{ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 }],
    asOf: "2026-10-08",
  },
];

/**
 * Claude models that have no row on purpose, and why — the Claude twin of
 * `DELISTED_MODELS`: a decided blank, not a missing one.
 *
 * Haiku 5.5 is priced per request on the prompt's size: $0.10/$0.50 (cache
 * read $0.01) for a prompt up to 100K tokens, $0.50/$2.50 ($0.05) above it,
 * and the CLI tiers each API call on its own. A run's token totals cannot say
 * which calls were which, and either flat rate is wrong: the ≤100K rate read
 * the first Haiku 5.5 e90 4.3× low, the >100K rate about 15% high (267 of its
 * 375 calls were over 100K). Pricing it needs the tier applied per response
 * when the totals are read; that is GitHub issue #122.
 */
export const CLAUDE_UNPRICED: Readonly<Record<string, string>> = {
  "claude-haiku-5-5":
    "tiered per request — Anthropic prices each call by its prompt size (≤100K or >100K tokens) and a run's totals cannot say which calls were which, so no single rate prices it; the CLI's own figure is the one to read",
};

/** The Claude row for a served model id at a date, or null when the table has none. */
export function claudePrice(model: string, at: number | null = null): PriceRow | null {
  const row = CLAUDE_PRICES.find((p) => p.ids.includes(model));
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

/**
 * Open-model prices, synced from OpenRouter rather than typed in.
 *
 * `prices.openrouter.json` is written by `infra/sync-prices.ts` (`bun run
 * sync-prices`), which reads the provider's own catalogue and keeps the rows
 * the roster and the corpus actually need. A rate nobody typed is a rate nobody
 * can mistype.
 *
 * **Rate windows.** Each id maps to a *list* of windows in date order rather
 * than to one row, because a rate that moves must not re-price the runs that
 * billed at the old one — `z-ai/glm-5.3-flash`'s launch discount lapsing around
 * 2026-09-09 is the case this exists for. A window carries the same four rates
 * as before plus an optional `from` (`YYYY-MM-DD`, the day it took over); the
 * first window omits `from`, meaning "everything before the next window
 * begins", so every run already on disk when windows arrived keeps the reading
 * it had. `syncedPrice` picks the last window whose `from` is at or before the
 * run's start, and the latest window when a caller asks for no particular date.
 * The Claude and provider tables carry the same windows, typed by hand.
 *
 * The file-level `asOf` is the day the catalogue was last read, not the day a
 * rate began — a window's own `from` is that, and a window without one is dated
 * by the sync that first wrote the file.
 *
 * These models are genuinely metered against the operator's OpenRouter
 * balance, so `asIfMetered` is false: the figure is a list-price estimate of a
 * real bill. The one exception is a codex run reading an `openai/` row: the
 * rates are the same, but that lane bills a ChatGPT subscription, so the same
 * figure is a comparison and `codexPrice` says so. OpenRouter has no cache-write tier for most models — the sync
 * falls back to the input rate, per its own quoting.
 *
 * A free slug never reaches here: `priceFor` answers it with `FREE_PRICE`
 * first, whatever the catalogue quotes. So a 0/0 row in this file is only ever
 * reached for a `:free`/`-free` id — a *suffixless* id quoted at 0/0 would be
 * a paid model reading as free, which is the one shape the table must not
 * hold. `viewer-pricing.test.ts` asserts that invariant over every window in
 * the whole file, and the sync never writes one (`mergeWindows`): a stealth id
 * that really is free says so with its roster entry's `billing`, which the run
 * records and `priceFor` reads.
 */
export type SyncedRow = Pick<PriceRow, "input" | "output" | "cacheRead" | "cacheWrite">;

/** One rate window: the rates, and the day they took over (absent on the first). */
export type SyncedWindow = SyncedRow & { from?: string };

export const SYNCED_PRICES: { asOf: string; models: Record<string, SyncedWindow[]> } = synced;

/**
 * The window in force at `at`, or the latest when the caller names no date.
 *
 * Null means "the table's current price" — a run with no start date on it, and
 * every caller that just wants today's rate. A date older than every `from`
 * falls back to the earliest window, which is the best the table can say about
 * a run that predates what it knows.
 */
export function windowAt(windows: readonly SyncedWindow[], at: number | null): SyncedWindow | null {
  if (windows.length === 0) return null;
  if (at === null) return windows[windows.length - 1]!;
  let chosen: SyncedWindow | null = null;
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
type SyncedFlavor = "openrouter" | "codex";

const SYNCED_BILLING: Record<SyncedFlavor, { asIfMetered: boolean; list: string; whose: string }> = {
  openrouter: {
    asIfMetered: false,
    list: "OpenRouter list price",
    whose: "metered against the operator's OpenRouter balance",
  },
  codex: {
    asIfMetered: true,
    list: "OpenAI API list price via the OpenRouter catalogue",
    whose: "the codex harness bills a ChatGPT subscription, so this is as-if-metered",
  },
};

function syncedRow(model: string, at: number | null, flavor: SyncedFlavor): PriceRow | null {
  const windows = SYNCED_PRICES.models[model];
  if (windows === undefined) return null;
  const row = windowAt(windows, at);
  if (row === null) return null;
  const { asIfMetered, list, whose } = SYNCED_BILLING[flavor];
  const when =
    row.from === undefined
      ? `${list}, synced ${SYNCED_PRICES.asOf} (infra/sync-prices.ts)`
      : `${list} in force from ${row.from} (catalogue read ${SYNCED_PRICES.asOf}, infra/sync-prices.ts)`;
  return {
    id: model,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    asOf: row.from ?? SYNCED_PRICES.asOf,
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
  if (model.includes("/")) return null;
  return syncedRow(`openai/${model}`, at, "codex");
}

/** A run driven by the Codex CLI, whichever field of the pair carries it. */
function isCodex(run: Pick<PriceableRun, "driver" | "harness">): boolean {
  return run.harness === "codex" || run.driver === "codex";
}

/**
 * Paid providers that are not OpenRouter, priced by hand.
 *
 * The OpenRouter sync cannot help here: `infra/sync-prices.ts` writes only ids
 * its catalogue carries and deletes the rest, so a Cerebras row typed into
 * `prices.openrouter.json` would vanish on the next run of the script — and
 * OpenRouter's `qwen/qwen3.8-27b` is neither the same id string nor the same
 * rate as Cerebras's `qwen-3.8-27b`. So these rows live in source, dated and
 * sourced the way `CLAUDE_PRICES` is, and a stale one is visible rather than
 * silent. Operator's decision, 2026-09-04 (on its stated
 * trigger: `omen-alpha` on OpenCode's pay-as-you-go endpoint was the second
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
 * for one provider can never fire for a run on another.
 *
 * Rates are windowed exactly as the synced table's are (`SyncedWindow[]`,
 * first window undated, `windowAt` picks the one in force at the run's start),
 * so a provider that moves its price gets a new window appended by hand with
 * its `from` date and the runs that billed at the old rate keep reading it.
 * The Claude rows use the same shape for the same reason.
 * A promotional rate whose end is *known* gets its successor window appended
 * on day one; one whose end is not known (`omen-alpha`, below) carries the
 * fact in its note and gets the window the day the bill changes.
 *
 * `asIfMetered` is false throughout: these endpoints meter the operator's own
 * balance, so the figure is a list-price estimate of a real bill, not a
 * comparison. A row here does not touch the scheduler's free/paid verdict —
 * that stays `runner/src/model-cost.ts`'s.
 */
export interface ProviderPriceRow {
  /** What the row is called on screen. */
  id: string;
  /** The exact `apiBase` the roster entry names, compared by `sameBase`. */
  apiBase: string;
  /** The model id as the provider names it — exact, case-sensitive. */
  model: string;
  /** Rate windows in date order; the first carries no `from`. */
  windows: readonly SyncedWindow[];
  /** When the figures were taken (the first window's date; later ones carry their own `from`). */
  asOf: string;
  source: PriceRow["source"];
  note: string;
}

export const PROVIDER_PRICES: readonly ProviderPriceRow[] = [
  {
    id: "cerebras/qwen-3.8-27b",
    apiBase: "https://api.cerebras.ai/v1",
    model: "qwen-3.8-27b",
    // No cache discount: Cerebras caches the prefix and bills every input
    // token at the input rate whether it was served from cache or not
    // ("What Cerebras costs"), so cacheRead and
    // cacheWrite are the input rate rather than a tier below it.
    windows: [{ input: 0.99, output: 1.49, cacheRead: 0.99, cacheWrite: 0.99 }],
    asOf: "2026-09-04",
    source: "list",
    note: "Cerebras published price, verified 2026-09-04; no cache discount, so every prompt token bills at the input rate; metered against the operator's Cerebras balance",
  },
  {
    id: "opencode-go/omen-alpha",
    apiBase: "https://opencode.ai/zen/go/v1",
    model: "omen-alpha",
    // models.dev lists no cache-write tier; a write is billed as ordinary
    // input, the same fallback the OpenRouter sync uses.
    windows: [{ input: 0.2, output: 0.66, cacheRead: 0.04, cacheWrite: 0.2 }],
    asOf: "2026-09-04",
    source: "catalogue",
    note: "models.dev registry listing for the opencode-go provider, read 2026-09-04 (model released the same day). The endpoint reported usage.cost 0 on every live response that day, so the published rate and the observed charge disagree: the actual figure beside this one is the provider's own word, and this is what the listing says it would cost if billed — a free alpha preview is the likely reading, but neither a free nor a billed alpha is asserted here. Append a dated window the day the bill changes",
  },
];

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

/** The hand-held provider row for a run at a date, or null when no row names its base and id. */
export function providerPrice(run: Pick<PriceableRun, "model" | "apiBase">, at: number | null = null): PriceRow | null {
  const model = run.model ?? "";
  for (const p of PROVIDER_PRICES) {
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

/** Whether a run's base is one the hand-held provider table knows at all, whatever the model. */
function isProviderBase(apiBase: string | null | undefined): boolean {
  return PROVIDER_PRICES.some((p) => sameBase(apiBase, p.apiBase));
}

/**
 * Ids the provider's catalogue no longer carries, and why.
 *
 * A delisted model is unpriced in a way running the sync cannot fix — the
 * catalogue has no row to copy, so a sync *removes* the id rather than
 * updating it. That is a different problem from "the sync has not seen this
 * yet", and telling the reader to run a script that cannot help is worse than
 * telling them nothing, so `unpricedNote` answers these ids from here instead.
 *
 * This map is also the record of why a row is missing from
 * `prices.openrouter.json`: the alternative was to hold a rate by hand, and a
 * hand-held rate in a file whose whole point is that nobody types rates into
 * it is a number with no source behind it.
 */
export const DELISTED_MODELS: Readonly<Record<string, string>> = {
  "stealth/ox-alpha":
    "delisted — the stealth listing was revealed as ZAI GLM-5.3-Flash on 2026-08-28 and left the OpenRouter catalogue, so no list price is on file and a sync cannot restore one; these runs were free while the preview window was open, and the provider's own per-response charge is the figure to read",
};

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
  return run.harness === "claude-code" || run.driver === "claude-code" || /claude/i.test(run.model ?? "");
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
  if (isCodex(run)) {
    const codex = codexPrice(model, at);
    if (codex !== null) return codex;
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
 * carry, one we decided not to price (`CLAUDE_UNPRICED`), a Claude alias whose
 * run never said what it was served, an OpenRouter model the sync has not
 * seen (fixed by running the script), one the catalogue has dropped (which the
 * script cannot fix, and `DELISTED_MODELS` says so in its own words), and a
 * model on a paid provider the hand-held table knows but has no row for (which
 * the script cannot price either — the row is typed into `PROVIDER_PRICES`,
 * with a source).
 */
export function unpricedNote(run: PriceableRun): string {
  const delisted = DELISTED_MODELS[run.model ?? ""];
  if (delisted !== undefined) return delisted;
  // Before the Claude branch: a codex slug is a bare model id with no vendor in
  // it, so the harness is the only thing that says which table can answer, and
  // the answer is the sync's — under `openai/<slug>` rather than the bare id.
  if (isCodex(run)) {
    return "no synced price — run `bun infra/sync-prices.ts` (a codex model is priced from the catalogue's `openai/` id)";
  }
  if (isClaudeRun(run)) {
    const served = servedClaudeModel(run);
    const decided = CLAUDE_UNPRICED[served];
    if (decided !== undefined) return decided;
    if ((run.resolvedModel ?? null) === null && !served.startsWith("claude-")) {
      return `\`${served}\` is an alias the CLI resolves at launch, and this run recorded no served model, so which model it was — and its price — is not known; tokens only, never a guess`;
    }
    return `no price on file for ${served} — tokens only, never a guess; a new Claude model needs a dated, sourced row in CLAUDE_PRICES (runner/viewer/pricing.ts)`;
  }
  if (isProviderBase(run.apiBase)) {
    return "no hand-held price for this model on this provider — add a dated, sourced row to PROVIDER_PRICES (runner/viewer/pricing.ts); the OpenRouter sync cannot price it";
  }
  return "no synced price — run `bun infra/sync-prices.ts`";
}

/**
 * The provider's own figure for a run, or a blank saying it reported none.
 *
 * Two shapes, one meaning: a per-response `usage.cost` (OpenRouter's, in
 * credits, which are dollars; OpenCode's pay-as-you-go endpoint reports the
 * same field) and the Claude Agent SDK's per-session `total_cost_usd`.
 * `tail.ts` sums whichever the run carries; this only has to say what the
 * number is, and whose.
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
      : isProviderBase(run.apiBase)
        ? `the provider's own charge, summed over the run's responses (usage.cost, as the endpoint reports it)${partial}`
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
  // A codex run bills a ChatGPT subscription and reports no cost at all, so a
  // list-price figure over its tokens is as-if-metered whatever the row says.
  const codex = isCodex(run);
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
  /** How many of the run's responses carried a charge, from
   * `responseCostCoverage`. Absent where the caller does not count. */
  coverage?: { costed: number; uncosted: number } | null;
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
 * Two kinds of entry are not gaps. A decided blank (`DELISTED_MODELS`,
 * `CLAUDE_UNPRICED`) already says why on every run. A claude-code alias
 * (`sonnet`, `opus`) resolves only when the CLI starts, so nothing here can
 * say what it will be served; its runs are priced on the served model they
 * record, and an unpriced one reads so on the run page.
 *
 * A warning, never a refusal: a model with no price yet is still runnable.
 */
export function rosterPriceGap(entry: PriceableEntry): string | null {
  const driver = entry.driver ?? "openai";
  const harness = driver === "claude-code" ? "claude-code" : driver === "codex" ? "codex" : "wrathbench";
  const run: PriceableRun = { model: entry.model, apiBase: entry.apiBase ?? null, platform: null, driver, harness };
  if (entry.billing !== undefined) run.declaredBilling = entry.billing;
  if (driver === "claude-code" && !entry.model.startsWith("claude-")) return null;
  if (priceFor(run) !== null) return null;
  if (DELISTED_MODELS[entry.model] !== undefined || CLAUDE_UNPRICED[entry.model] !== undefined) return null;
  return unpricedNote(run);
}
