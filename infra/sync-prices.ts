#!/usr/bin/env bun
/**
 * Sync OpenRouter list prices into the model catalogue
 * (`infra/model-catalogue.json`, each model's `prices.openrouter`).
 *
 * Prices are data, not code: hand-typing a rate makes a number nobody can
 * check go stale silently. This pulls the provider's own catalogue and writes
 * the rows the fleet actually needs, dated, onto the entries they belong to.
 *
 *   bun wb data prices        # or: bun infra/sync-prices.ts
 *
 * Scope is deliberately narrow — the catalogue is ~420 models and all but a
 * few dozen are noise here. An OpenRouter id is asked for when it is one of:
 *   - an id the model catalogue already prices (the standing asks: a model
 *     dropped from the roster still has runs whose cost must keep resolving,
 *     and a model about to be added is cheaper to price before the first run),
 *   - a model in the config store's roster (`runner/src/config-store.ts`), or
 *   - a model any run under `data/runs` was launched on.
 * An id we ask for that the catalogue does not carry is reported, never
 * invented — an unpriced model stays unpriced (`pricing.ts` says so on the run
 * page). Nor is a suffixless id the catalogue quotes at 0/0 written: it is
 * reported, and a stealth preview that really is free is declared on its
 * roster entry (`isZeroQuote`). And a rate is written only onto a model the
 * model catalogue lists: an id it does not is reported as such, because a
 * price on no entry would be a model with a cost and no company, family or
 * weights — add the entry, then sync again.
 *
 * One id is not asked for as written: a `codex` entry or run names the model
 * the way the Codex CLI does (`gpt-6-astra`), and the catalogue carries it
 * under the vendor prefix (`openai/gpt-6-astra`). `catalogueIds` asks for the
 * prefixed id and *not* the bare one — the catalogue has no bare row, so
 * wanting it would report a miss every sync — and `codexPrice` in
 * `runner/viewer/pricing.ts` reads it back the same way.
 *
 * Units: the catalogue quotes dollars per token as strings; the file holds
 * dollars per million, rounded to six significant figures so a re-sync that
 * changed nothing produces no diff. OpenRouter has no cache-*write* tier for
 * most models — a write is billed as ordinary input — so `cacheWrite` falls
 * back to `input` rather than to zero.
 *
 * **A changed rate appends a window; it never overwrites one.** Each id maps to
 * a list of `{ input, output, cacheRead, cacheWrite, from? }` in date order.
 * The sync compares the catalogue against the *latest* window and, when the
 * four rates differ, appends a new one stamped `from: <today>` — so the runs
 * that billed at the old rate keep reading it (`windowAt` in
 * `runner/viewer/pricing.ts` picks the window in force at a run's start). A
 * second sync on the same day replaces that day's window rather than stacking
 * a duplicate. The first window has no `from`: it means "everything before the
 * next window begins", which is what makes every run already on disk price
 * exactly as it did before windows existed.
 *
 * One hole this does not close: an id the catalogue *drops* has its windows
 * emptied, so a delisted model's runs go unpriced rather than keeping the
 * rates they really billed at (an entry's `delisted` says why an id has
 * none). That is the 2026-08-29 delisting decision standing as it was; whether
 * a delisted id should keep its history is a question about what a blank
 * means, and the operator's. The emptied id stays on its entry, so it is asked
 * for again on every sync and a relisting is picked up rather than needing to
 * be noticed. Nothing else in the file is touched: the sync rewrites only
 * `prices.openrouter` blocks and the provider's `asOf`, in the file's one
 * spelling (`formatCatalogue`).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatCatalogue, normalizeModelId, parseCatalogue } from "./model-catalogue";
import { readFleetConfig } from "../runner/src/config-store";
import { driverEntry } from "../runner/src/drivers";
import { isFreeSlug } from "../runner/src/model-cost";

/** OpenRouter's model catalogue. Public: read with no key, here and by `runner/viewer/drafts.ts`. */
export const CATALOGUE = "https://openrouter.ai/api/v1/models";
const OUT = "infra/model-catalogue.json";
const RUNS = "data/runs";

export interface SyncedPrice {
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One rate window: the rates, plus the day they took over (absent on the first). */
export type SyncedWindow = SyncedPrice & { from?: string };

/**
 * A suffixless id the catalogue quotes at 0/0: a stealth preview, typically,
 * free until the day it is revealed and starts billing. The table never holds
 * one (a paid model reading as free is the failure it must not have), so the
 * sync writes no such row; a preview that really is free is declared with its
 * roster entry's `billing: "free"`, which the run records and the price table
 * reads (`priceFor`).
 */
export function isZeroQuote(id: string, price: SyncedPrice): boolean {
  return !isFreeSlug(id) && price.input === 0 && price.output === 0;
}

/** Whether two windows quote the same four rates. Both sides are already rounded. */
export function sameRates(a: SyncedPrice, b: SyncedPrice): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/**
 * The file the sync should write: the existing windows, plus a new one wherever
 * the catalogue now quotes something else.
 *
 * Pure, so the interesting behaviour is testable without a catalogue. Rules, in
 * order: an id the catalogue no longer prices is dropped (see the header); a
 * suffixless id quoted at 0/0 keeps the windows it had and gains none
 * (`isZeroQuote`); an unchanged rate leaves the id's windows byte-identical; a
 * changed rate appends `{ ...fresh, from: today }`; and a change on a day that
 * already has a window replaces it, so a second sync in one day corrects
 * rather than stacks.
 */
export function mergeWindows(
  existing: Readonly<Record<string, readonly SyncedWindow[]>> | undefined,
  fresh: Record<string, SyncedPrice>,
  today: string,
): Record<string, SyncedWindow[]> {
  const out: Record<string, SyncedWindow[]> = {};
  for (const id of Object.keys(fresh).sort()) {
    const price = fresh[id]!;
    const prior = existing?.[id] ?? [];
    if (isZeroQuote(id, price)) {
      if (prior.length > 0) out[id] = prior.map((w) => ({ ...w }));
      continue;
    }
    const latest = prior[prior.length - 1];
    if (latest === undefined) {
      // First sighting: no `from`, so it also prices every run older than it.
      out[id] = [{ ...price }];
      continue;
    }
    if (sameRates(latest, price)) {
      out[id] = prior.map((w) => ({ ...w }));
      continue;
    }
    const kept = (latest.from === today ? prior.slice(0, -1) : prior).map((w) => ({ ...w }));
    out[id] = [...kept, { ...price, from: today }];
  }
  return out;
}

/** Six significant figures: enough for a $0.0000005/token rate, stable across syncs. */
export function perMillion(perToken: string | number | null | undefined): number | null {
  const n = typeof perToken === "string" ? Number(perToken) : perToken;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Number((n * 1e6).toPrecision(6));
}

interface CatalogueRow {
  id?: unknown;
  pricing?: Record<string, unknown>;
}

/** The row for one catalogue entry, or null when it quotes no usable price. */
export function priceOf(entry: CatalogueRow): SyncedPrice | null {
  const p = entry.pricing ?? {};
  const input = perMillion(p["prompt"] as string);
  const output = perMillion(p["completion"] as string);
  if (input === null || output === null) return null;
  const cacheRead = perMillion(p["input_cache_read"] as string);
  const cacheWrite = perMillion(p["input_cache_write"] as string);
  return {
    input,
    output,
    // No read tier quoted means reads are billed as input, same as writes.
    cacheRead: cacheRead ?? input,
    cacheWrite: cacheWrite ?? input,
  };
}

/**
 * The catalogue ids to ask for, given how a roster entry or a run names its
 * model and which driver ran it.
 *
 * One in, one out, except that a `codex` model is asked for under the vendor
 * prefix its own slug omits. Only the prefixed id goes into the wanted set: the
 * catalogue has no bare `gpt-6-astra` row, so asking for both would report a
 * miss on every sync for a model that is in fact priced.
 */
export function catalogueIds(model: string, driver: unknown): string[] {
  const vendor = driverEntry(driver)?.cost.vendor;
  if (vendor === undefined || model.includes("/")) return [model];
  return [`${vendor}/${model}`];
}

/** Model ids named by the fleet roster, as the catalogue spells them. */
export function rosterModels(fleetJson: string): string[] {
  const parsed = JSON.parse(fleetJson) as { roster?: Record<string, { model?: unknown; driver?: unknown }> };
  const out: string[] = [];
  for (const entry of Object.values(parsed.roster ?? {})) {
    if (typeof entry.model === "string" && entry.model.length > 0) out.push(...catalogueIds(entry.model, entry.driver));
  }
  return out;
}

/** Model ids any run in the corpus was launched on, as the catalogue spells them. */
async function corpusModels(runsDir: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return out; // no corpus on this checkout is not an error
  }
  for (const name of names) {
    const meta = join(runsDir, name, "meta.json");
    try {
      if (!statSync(meta).isFile()) continue;
      const m = (await Bun.file(meta).json()) as { config?: { model?: unknown; driver?: unknown } };
      const model = m.config?.model;
      if (typeof model === "string" && model.length > 0) out.push(...catalogueIds(model, m.config?.driver));
    } catch {
      /* a run without a readable meta.json prices nothing; it is not a failure */
    }
  }
  return out;
}

type Doc = { models: Record<string, { aliases?: string[]; prices?: { openrouter?: Record<string, { windows: SyncedWindow[]; delisted?: string }> } & Record<string, unknown> } & Record<string, unknown>>; providers: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/** Every OpenRouter id the catalogue already carries a block for: the standing asks. */
export function catalogueOpenRouterIds(doc: Doc): string[] {
  return Object.values(doc.models).flatMap((e) => Object.keys(e.prices?.openrouter ?? {}));
}

/** The windows the catalogue holds now, flat, emptied ids included. */
export function catalogueWindows(doc: Doc): Record<string, SyncedWindow[]> {
  const out: Record<string, SyncedWindow[]> = {};
  for (const e of Object.values(doc.models)) for (const [id, row] of Object.entries(e.prices?.openrouter ?? {})) out[id] = row.windows;
  return out;
}

/**
 * Write a sync's windows onto the catalogue's entries. Pure: the document in,
 * a new document and the ids it could not place out.
 *
 * `windows` is `mergeWindows`'s answer: every id the OpenRouter catalogue
 * priced. An id with windows goes onto the entry it resolves to (its key or an
 * alias, as every reader compares ids); an id with none that already has a
 * block is emptied, its `delisted` note kept; an id with none and no block
 * stays absent. An id with windows no entry lists is returned, never written.
 * Nothing but `prices.openrouter` blocks and the provider's `asOf` changes.
 */
export function applyOpenRouterWindows(doc: Doc, windows: Readonly<Record<string, SyncedWindow[]>>, asOf: string): { doc: Doc; unlisted: string[] } {
  const next = structuredClone(doc);
  const index = new Map<string, string>();
  for (const [key, e] of Object.entries(next.models)) {
    index.set(normalizeModelId(key), key);
    for (const a of e.aliases ?? []) index.set(normalizeModelId(a), key);
  }
  // Ids the OpenRouter catalogue no longer prices: empty them where they are.
  for (const e of Object.values(next.models)) {
    for (const [id, row] of Object.entries(e.prices?.openrouter ?? {})) if (windows[id] === undefined) row.windows = [];
  }
  const unlisted: string[] = [];
  for (const id of Object.keys(windows).sort()) {
    const key = index.get(normalizeModelId(id));
    if (key === undefined) {
      unlisted.push(id);
      continue;
    }
    const entry = next.models[key]!;
    const prices = (entry.prices ??= {});
    const openrouter = (prices.openrouter ??= {});
    const prior = openrouter[id];
    openrouter[id] = { ...(prior ?? {}), windows: windows[id]!.map((w) => ({ ...w })) };
    if (prior?.delisted !== undefined && windows[id]!.length > 0) {
      // Relisted: the note that said it never would be is no longer true.
      delete openrouter[id]!.delisted;
    }
  }
  next.providers["openrouter"] = { ...next.providers["openrouter"], asOf };
  return { doc: next, unlisted };
}

export async function main(): Promise<void> {
  const text = await Bun.file(OUT).text();
  parseCatalogue(text, OUT);
  const doc = JSON.parse(text) as Doc;
  const wanted = new Set<string>(catalogueOpenRouterIds(doc));
  const fleet = readFleetConfig();
  if (fleet.status === "ok") for (const m of rosterModels(fleet.text)) wanted.add(m);
  else console.error(`sync-prices: config store ${fleet.status} — pricing the corpus and the catalogue's own ids only`);
  for (const m of await corpusModels(RUNS)) wanted.add(m);

  const res = await fetch(CATALOGUE);
  if (!res.ok) throw new Error(`${CATALOGUE}: HTTP ${res.status}`);
  const catalogue = (await res.json()) as { data?: CatalogueRow[] };
  const rows = catalogue.data ?? [];
  const byId = new Map<string, CatalogueRow>();
  for (const r of rows) if (typeof r.id === "string") byId.set(r.id, r);

  const models: Record<string, SyncedPrice> = {};
  const missing: string[] = [];
  for (const id of [...wanted].sort()) {
    const entry = byId.get(id);
    const price = entry === undefined ? null : priceOf(entry);
    if (price === null) {
      missing.push(id);
      continue;
    }
    models[id] = price;
  }

  const today = new Date().toISOString().slice(0, 10);
  const windows = mergeWindows(catalogueWindows(doc), models, today);
  const zeroQuoted = Object.entries(models)
    .filter(([id, price]) => isZeroQuote(id, price))
    .map(([id]) => id);
  const appended = Object.entries(windows)
    .filter(([, ws]) => ws[ws.length - 1]?.from === today)
    .map(([id]) => id);

  const { doc: out, unlisted } = applyOpenRouterWindows(doc, windows, today);
  const written = formatCatalogue(out);
  parseCatalogue(written, OUT);
  await Bun.write(OUT, written);
  console.log(`${OUT}: ${Object.keys(windows).length - unlisted.length} OpenRouter ids priced of ${wanted.size} wanted, from ${rows.length} catalogue rows`);
  if (appended.length > 0) {
    // A rate moved. Earlier runs keep the window they billed at; only runs from
    // today forward read the new one.
    console.log(`rate changed, new window from ${today} (earlier runs keep the old rate): ${appended.join(", ")}`);
  }
  if (zeroQuoted.length > 0) {
    // Not a miss: the catalogue prices these at zero, and the table keeps no
    // zero row for a suffixless id. A run of one is free only by its entry's billing.
    console.log(`quoted at 0/0 without a free suffix (no row written; declare billing "free" on the roster entry): ${zeroQuoted.join(", ")}`);
  }
  if (unlisted.length > 0) {
    // Priced by OpenRouter, but nobody has said who made it: no row is written.
    console.log(`priced by OpenRouter but not in the model catalogue (no row written; add an entry to ${OUT}, then sync again): ${unlisted.join(", ")}`);
  }
  if (missing.length > 0) {
    // Most of these are OpenCode Zen / local ids, which OpenRouter never
    // carries — they are free or local and priced by rule, not by table.
    console.log(`not in the OpenRouter catalogue (left unpriced): ${missing.join(", ")}`);
  }
}

if (import.meta.main) await main();
