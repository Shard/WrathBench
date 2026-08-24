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
 *   - a model in `infra/fleet.json`'s roster,
 *   - a model any run under `data/runs` was launched on, or
 *   - a `PIN` below: ids we want priced whatever the roster says today.
 * An id we ask for that the catalogue does not carry is reported, never
 * invented — an unpriced model stays unpriced (`pricing.ts` says so on the run
 * page).
 *
 * Units: the catalogue quotes dollars per token as strings; the file holds
 * dollars per million, rounded to six significant figures so a re-sync that
 * changed nothing produces no diff. OpenRouter has no cache-*write* tier for
 * most models — a write is billed as ordinary input — so `cacheWrite` falls
 * back to `input` rather than to zero.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CATALOGUE = "https://openrouter.ai/api/v1/models";
const OUT = "runner/viewer/prices.openrouter.json";
const FLEET = "infra/fleet.json";
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
  "stealth/ox-alpha",
  "openai/gpt-5.6-luna",
  "google/gemini-3.7-flash",
];

export interface SyncedPrice {
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SyncedPrices {
  /** The day the catalogue was read. Every row in the file shares it. */
  asOf: string;
  models: Record<string, SyncedPrice>;
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

/** Model ids named by the fleet roster. */
export function rosterModels(fleetJson: string): string[] {
  const parsed = JSON.parse(fleetJson) as { roster?: Record<string, { model?: unknown }> };
  const out: string[] = [];
  for (const entry of Object.values(parsed.roster ?? {})) {
    if (typeof entry.model === "string" && entry.model.length > 0) out.push(entry.model);
  }
  return out;
}

/** Model ids any run in the corpus was launched on. */
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
      const m = (await Bun.file(meta).json()) as { config?: { model?: unknown } };
      const model = m.config?.model;
      if (typeof model === "string" && model.length > 0) out.push(model);
    } catch {
      /* a run without a readable meta.json prices nothing; it is not a failure */
    }
  }
  return out;
}

export async function main(): Promise<void> {
  const wanted = new Set<string>(PIN);
  for (const m of rosterModels(await Bun.file(FLEET).text())) wanted.add(m);
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

  const out: SyncedPrices = { asOf: new Date().toISOString().slice(0, 10), models };
  await Bun.write(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${OUT}: ${Object.keys(models).length} priced of ${wanted.size} wanted, from ${rows.length} catalogue rows`);
  if (missing.length > 0) {
    // Most of these are OpenCode Zen / local ids, which OpenRouter never
    // carries — they are free or local and priced by rule, not by table.
    console.log(`not in the OpenRouter catalogue (left unpriced): ${missing.join(", ")}`);
  }
}

if (import.meta.main) await main();
