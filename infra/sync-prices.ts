#!/usr/bin/env bun
/**
 * Sync OpenRouter list prices into `runner/viewer/prices.openrouter.json`.
 *
 * Prices are data, not code: hand-typing a rate into `pricing.ts` makes a
 * number nobody can check go stale silently. This pulls the provider's own
 * catalogue and writes the rows the fleet actually needs, dated.
 *
 *   bun run sync-prices        # or: bun infra/sync-prices.ts
 *
 * Scope is deliberately narrow — the catalogue is ~420 models and all but a
 * dozen are noise here. A row is written when its id is one of:
 *   - a model in the config store's roster (`runner/src/config-store.ts`),
 *   - a model any run under `data/runs` was launched on, or
 *   - a `PIN` below: ids we want priced whatever the roster says today.
 * An id we ask for that the catalogue does not carry is reported, never
 * invented — an unpriced model stays unpriced (`pricing.ts` says so on the run
 * page).
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
 * One hole this does not close: an id the catalogue *drops* is still removed
 * outright, windows and all, so a delisted model's runs go unpriced rather than
 * keeping the rates they really billed at (`DELISTED_MODELS` in `pricing.ts`
 * names why a row is missing). That is the 2026-08-29 delisting decision
 * standing as it was; whether a delisted id should keep its history is a
 * question about what a blank means, and the operator's.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFleetConfig } from "../runner/src/config-store";

const CATALOGUE = "https://openrouter.ai/api/v1/models";
const OUT = "runner/viewer/prices.openrouter.json";
const RUNS = "data/runs";

/**
 * Ids priced regardless of whether anything in the fleet or the corpus is on
 * them today. Kept by hand: a model dropped from the roster still has runs in
 * the corpus whose cost must keep resolving, and a model we are about to add
 * is cheaper to price before the first run than after.
 */
const PIN: readonly string[] = [
  "deepseek/deepseek-v4-flash-0731",
  "deepseek/deepseek-v4-flash",
  // Delisted 2026-08-28: the catalogue no longer carries the stealth id at
  // all, so this pin will never resolve — it is kept as the standing ask, so a
  // relisting is picked up rather than needing to be noticed. The 0/0/0/0 row
  // it used to hold by hand was deliberately dropped on 2026-08-29: a paid
  // model reading as free is worse than a blank, and the corpus's 22 runs now
  // read unpriced with the delisting named (`DELISTED_MODELS` in
  // `runner/viewer/pricing.ts`) rather than $0.00 wearing a synced-price label.
  "stealth/ox-alpha",
  "openai/gpt-5.6-luna",
  "google/gemini-3.7-flash",
  // Launch discount: $0.075/$0.25 per Mtok runs to roughly 2026-09-09, after
  // which the catalogue quotes list ($0.15/$0.50). A sync past that date
  // appends a window dated that day; August's runs keep the discount.
  "z-ai/glm-5.3-flash",
];

export interface SyncedPrice {
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One rate window: the rates, plus the day they took over (absent on the first). */
export type SyncedWindow = SyncedPrice & { from?: string };

export interface SyncedPrices {
  /** The day the catalogue was last read. A *window*'s date is its own `from`. */
  asOf: string;
  /** Windows per id, oldest first. The first carries no `from`. */
  models: Record<string, SyncedWindow[]>;
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
 * order: an id the catalogue no longer prices is dropped (see the header); an
 * unchanged rate leaves the id's windows byte-identical; a changed rate appends
 * `{ ...fresh, from: today }`; and a change on a day that already has a window
 * replaces it, so a second sync in one day corrects rather than stacks.
 */
export function mergeWindows(
  existing: Record<string, SyncedWindow[]> | undefined,
  fresh: Record<string, SyncedPrice>,
  today: string,
): Record<string, SyncedWindow[]> {
  const out: Record<string, SyncedWindow[]> = {};
  for (const id of Object.keys(fresh).sort()) {
    const price = fresh[id]!;
    const prior = existing?.[id] ?? [];
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
  if (driver !== "codex" || model.includes("/")) return [model];
  return [`openai/${model}`];
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

export async function main(): Promise<void> {
  const wanted = new Set<string>(PIN);
  const fleet = readFleetConfig();
  if (fleet.status === "ok") for (const m of rosterModels(fleet.text)) wanted.add(m);
  else console.error(`sync-prices: config store ${fleet.status} — pricing the corpus and the pins only`);
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
  let prior: Record<string, SyncedWindow[]> | undefined;
  try {
    prior = ((await Bun.file(OUT).json()) as SyncedPrices).models;
  } catch {
    prior = undefined; // no file yet: every id starts on a first, undated window
  }
  const windows = mergeWindows(prior, models, today);
  const appended = Object.entries(windows)
    .filter(([, ws]) => ws[ws.length - 1]?.from === today)
    .map(([id]) => id);

  const out: SyncedPrices = { asOf: today, models: windows };
  await Bun.write(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${OUT}: ${Object.keys(windows).length} priced of ${wanted.size} wanted, from ${rows.length} catalogue rows`);
  if (appended.length > 0) {
    // A rate moved. Earlier runs keep the window they billed at; only runs from
    // today forward read the new one.
    console.log(`rate changed, new window from ${today} (earlier runs keep the old rate): ${appended.join(", ")}`);
  }
  if (missing.length > 0) {
    // Most of these are OpenCode Zen / local ids, which OpenRouter never
    // carries — they are free or local and priced by rule, not by table.
    console.log(`not in the OpenRouter catalogue (left unpriced): ${missing.join(", ")}`);
  }
}

if (import.meta.main) await main();
