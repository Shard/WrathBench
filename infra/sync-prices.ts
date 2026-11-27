#!/usr/bin/env bun
/**
 * Sync list prices into the model catalogue (`infra/model-catalogue.json`):
 * OpenRouter's into each model's `prices.openrouter`, and the per-model prices
 * an endpoint provider publishes itself (OpenCode Go's `/models`, a provider's
 * `listing`) into its `prices.endpoints` rows.
 *
 * Prices are data, not code: hand-typing a rate makes a number nobody can
 * check go stale silently. This pulls the provider's own catalogue and writes
 * the rows the fleet actually needs, dated, onto the entries they belong to.
 *
 *   bun wb data prices        # or: bun infra/sync-prices.ts
 *   bun wb data prices --fleet <config export> --runs <runs listing>
 *
 * Which models the fleet needs comes from the config store's roster and the
 * runs under `data/runs` on the machine it runs on. A checkout with neither
 * (a worktree, a laptop) is given them as files, read-only: `--fleet` takes a
 * config document (`bun wb config export`, which carries no secret) and
 * `--runs` the viewer's `/api/runs` body, or any JSON list of
 * `{ model, driver?, apiBase? }`. Neither file belongs in the repository.
 *
 * Scope is deliberately narrow — the catalogue is ~420 models and all but a
 * few dozen are noise here. An OpenRouter id is asked for when it is one of:
 *   - an id the model catalogue already prices (the standing asks: a model
 *     dropped from the roster still has runs whose cost must keep resolving,
 *     and a model about to be added is cheaper to price before the first run),
 *   - a model in the config store's roster (`runner/src/config-store.ts`),
 *     each provider leg by the model it names,
 *   - a model any run under `data/runs` was launched on, or
 *   - the vendor-prefixed key of the catalogue entry either of those resolves
 *     to: the row an OpenCode run falls back to (`openRouterAsks`).
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
 * `viewer/pricing.ts` reads it back the same way.
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
 * `viewer/pricing.ts` picks the window in force at a run's start). A
 * second sync on the same day replaces that day's window rather than stacking
 * a duplicate. The first window has no `from`: it means "everything before the
 * next window begins", which is what makes every run already on disk price
 * exactly as it did before windows existed.
 *
 * **History only grows.** An id the catalogue no longer lists keeps every
 * window it had, untouched: its runs billed at those rates, and a blank would
 * say they cost nothing knowable. The sync names such ids on its output and
 * never clears them. This replaces the earlier rule (2026-08-29) under which a
 * dropped id's windows were emptied; the ids emptied under it stay empty, an
 * entry's `delisted` saying why where one does, because there is no rate left
 * to restore. A kept id stays on its entry, so it is asked for again on every
 * sync and a relisting at a new rate appends a window like any other change.
 * Nothing else in the file is touched: the sync writes only `prices.openrouter`
 * blocks, a listing provider's endpoint rows and each provider's `asOf`, in
 * the file's one spelling (`formatCatalogue`).
 *
 * **A provider's own listing** (operator, 2026-11-18: an OpenCode run is priced
 * at OpenCode's own published per-model price where it publishes one, and at
 * the OpenRouter listing through the catalogue alias where it does not). A
 * provider in the catalogue with a `listing` URL is read the same way, under
 * the same rules: windows only appended, an id the listing drops keeps every
 * window, a suffixless 0/0 never written. Its asks are narrower still: the ids
 * its rows already price, and the roster legs and runs whose `apiBase` is the
 * provider's. A row is written only where the listing serves the model as
 * chat completions on that same base (a model OpenCode serves on its messages
 * or responses API is another endpoint, whatever its id), and only where one
 * flat rate is the price: a rate tiered by context size, or one that moves on
 * a date, is reported and left to the OpenRouter fallback, the way Haiku 5.5's
 * tiers are a decided blank (`viewer/pricing.ts`). A rate the listing
 * multiplies at peak hours (OpenCode's DeepSeek) is written at the off-peak
 * rate and the row's note says so, as DeepSeek's own platform row does. A row
 * that states its own `source` is hand-held and never touched.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { catalogueKeyOf, formatCatalogue, normalizeModelId, parseCatalogue } from "./model-catalogue";
import { readFleetConfig } from "../runner/src/config-read";
import { driverEntry } from "../runner/src/drivers";
import { isContributorSlug, isFreeSlug } from "../runner/src/model-cost";
import { sameBase } from "../runner/src/platform";

/** OpenRouter's model catalogue. Public: read with no key, here and by `viewer/drafts.ts`. */
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
 * order: an id the catalogue no longer prices keeps the windows it had (see
 * the header); a suffixless id quoted at 0/0 keeps the windows it had and gains
 * none (`isZeroQuote`); an unchanged rate leaves the id's windows
 * byte-identical; a changed rate appends `{ ...fresh, from: today }`; and a
 * change on a day that already has a window replaces it, so a second sync in
 * one day corrects rather than stacks. A window dated before today is never
 * removed or rewritten.
 */
export function mergeWindows(
  existing: Readonly<Record<string, readonly SyncedWindow[]>> | undefined,
  fresh: Record<string, SyncedPrice>,
  today: string,
): Record<string, SyncedWindow[]> {
  const out: Record<string, SyncedWindow[]> = {};
  for (const [id, prior] of Object.entries(existing ?? {})) {
    // No longer listed: every window it had, as it was.
    if (fresh[id] === undefined && prior.length > 0) out[id] = prior.map((w) => ({ ...w }));
  }
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

/** One way a model is launched: by a roster leg, or by a run that was. */
export interface Launch {
  model: string;
  driver?: unknown;
  apiBase?: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Every way the fleet roster launches a model: one per provider leg (a leg may
 * name its own model and base: `deepseek-v41-flash` runs Go's
 * `deepseek-v4.1-flash` and OpenRouter's `deepseek/deepseek-v4.1-flash`), or
 * the entry itself where it lists no legs.
 */
export function rosterLaunches(fleetJson: string): Launch[] {
  type Leg = { model?: unknown; apiBase?: unknown };
  const parsed = JSON.parse(fleetJson) as { roster?: Record<string, { model?: unknown; driver?: unknown; apiBase?: unknown; providers?: Leg[] }> };
  const out: Launch[] = [];
  for (const entry of Object.values(parsed.roster ?? {})) {
    const model = str(entry.model);
    const legs = Array.isArray(entry.providers) && entry.providers.length > 0 ? entry.providers : [{}];
    for (const leg of legs) {
      const m = str(leg.model) ?? model;
      if (m !== null) out.push({ model: m, driver: entry.driver, apiBase: str(leg.apiBase) ?? str(entry.apiBase) });
    }
  }
  return out;
}

/** Model ids named by the fleet roster, as the catalogue spells them. */
export function rosterModels(fleetJson: string): string[] {
  return rosterLaunches(fleetJson).flatMap((l) => catalogueIds(l.model, l.driver));
}

/**
 * The runs a `--runs` file names: the viewer's `/api/runs` body (`{ runs }`) or
 * a bare list, each with a `model` and, where known, its `driver` and `apiBase`.
 */
export function runLaunches(text: string): Launch[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : ((parsed as { runs?: unknown }).runs ?? []);
  if (!Array.isArray(rows)) throw new Error("--runs: expected a list of runs, or an object with one under `runs`");
  const out: Launch[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const model = str(r?.["model"]);
    if (model !== null) out.push({ model, driver: r["driver"], apiBase: str(r["apiBase"]) });
  }
  return out;
}

/** Every run in the corpus, by the model, driver and base it was launched with. */
async function corpusLaunches(runsDir: string): Promise<Launch[]> {
  const out: Launch[] = [];
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
      const m = (await Bun.file(meta).json()) as { config?: { model?: unknown; driver?: unknown; apiBase?: unknown } };
      const model = str(m.config?.model);
      if (model !== null) out.push({ model, driver: m.config?.driver, apiBase: str(m.config?.apiBase) });
    } catch {
      /* a run without a readable meta.json prices nothing; it is not a failure */
    }
  }
  return out;
}

type EndpointRowDoc = { ids?: string[]; asOf: string; windows: SyncedWindow[]; note?: string; source?: string };
type Doc = {
  models: Record<
    string,
    {
      aliases?: string[];
      prices?: { openrouter?: Record<string, { windows: SyncedWindow[]; delisted?: string }>; endpoints?: Record<string, EndpointRowDoc> } & Record<string, unknown>;
    } & Record<string, unknown>
  >;
  providers: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;

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
 * `windows` is `mergeWindows`'s answer: every id the file should price. An id
 * with windows goes onto the entry it resolves to (its key or an alias, as
 * every reader compares ids); an id absent from `windows` keeps its block
 * exactly as it was, so nothing the sync is not told about is ever cleared. An
 * id with windows no entry lists is returned, never written. Nothing but
 * `prices.openrouter` blocks and the provider's `asOf` changes.
 */
export function applyOpenRouterWindows(doc: Doc, windows: Readonly<Record<string, SyncedWindow[]>>, asOf: string): { doc: Doc; unlisted: string[] } {
  const next = structuredClone(doc);
  const index = new Map<string, string>();
  for (const [key, e] of Object.entries(next.models)) {
    index.set(normalizeModelId(key), key);
    for (const a of e.aliases ?? []) index.set(normalizeModelId(a), key);
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

/**
 * Whether this sync wrote a rate today that the id did not already have:
 * a window appended, or today's replaced by a second sync. A window an
 * earlier sync wrote today, unchanged, is not news.
 */
export function movedToday(before: readonly SyncedWindow[], after: readonly SyncedWindow[], today: string): boolean {
  const last = after[after.length - 1];
  if (last?.from !== today) return false;
  const was = before[before.length - 1];
  return was === undefined || was.from !== today || !sameRates(was, last);
}

/**
 * The OpenRouter ids one launch asks for: the id as launched (vendor-prefixed
 * for a codex slug, `catalogueIds`), and the key of the catalogue entry it
 * resolves to when that key is itself vendor-prefixed. The key is the row an
 * OpenCode run falls back to when its provider's listing has no price for the
 * model (`subscriptionListPrice` in `viewer/pricing.ts` reads the entry's
 * key and nothing else), so Go's bare `glm-5.3` asks for `z-ai/glm-5.3`, and a
 * model only ever run on a `:free` variant OpenRouter has since dropped still
 * gets its paid listing. A bare key (`kimi-k3.1-pro`) is no OpenRouter id and
 * is not asked for.
 */
export function openRouterAsks(l: Launch): string[] {
  const ids = catalogueIds(l.model, l.driver);
  const out = new Set(ids);
  for (const id of ids) {
    const key = catalogueKeyOf(id);
    if (key !== null && key.includes("/")) out.add(key);
  }
  return [...out];
}

// ----------------------------------------------------- a provider's own listing

/** One model in an OpenCode-shaped `/models` listing, as far as the sync reads it. */
export interface ListingRow {
  id?: unknown;
  cost?: {
    text?: {
      input?: { price?: unknown; cache?: { read?: unknown; write?: unknown }; overrides?: unknown };
      output?: { price?: unknown; overrides?: unknown };
    };
    multipliers?: unknown;
  };
  api?: Record<string, { base_url?: unknown } | undefined>;
}

/** What a listing says one model costs on a base: a flat rate (with any peak-hours caveat), or why there is none. */
export type ListingQuote = { price: SyncedPrice; peak: string | null } | { skip: string };

const round6 = (n: number): number => Number(n.toPrecision(6));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const DAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

/** The hours of one `{ all: [{ utc_hours: { gte } }, { utc_hours: { lt } }] }` clause, or null. */
function hourRange(clause: unknown): string | null {
  const all = (clause as { all?: unknown })?.all;
  if (!Array.isArray(all)) return null;
  let from: string | null = null;
  let to: string | null = null;
  for (const c of all as { utc_hours?: { gte?: unknown; lt?: unknown } }[]) {
    from = str(c?.utc_hours?.gte) ?? from;
    to = str(c?.utc_hours?.lt) ?? to;
  }
  return from !== null && to !== null ? `${from}–${to}` : null;
}

/**
 * A peak-hours multiplier in words, or null when it is not one the sync can
 * read. OpenCode writes DeepSeek's as `{ when: { utc_days: { in: [mon..fri] },
 * any: [<hour range>, …] }, factor: 2 }`.
 */
function peakOf(m: unknown): string | null {
  const { when, factor } = (m ?? {}) as { when?: Record<string, unknown>; factor?: unknown };
  const f = num(factor);
  if (when === undefined || f === null || when["date"] !== undefined) return null;
  const days = (when["utc_days"] as { in?: unknown } | undefined)?.in;
  if (!Array.isArray(days) || days.some((d) => DAY_NAMES[d as string] === undefined)) return null;
  const any = when["any"];
  if (!Array.isArray(any) || any.length === 0) return null;
  const ranges = any.map(hourRange);
  if (ranges.some((r) => r === null)) return null;
  const dayText = days.join(",") === "mon,tue,wed,thu,fri" ? "Monday to Friday" : days.map((d) => DAY_NAMES[d as string]).join(", ");
  return `${f}× in peak hours, ${ranges.join(" and ")} UTC ${dayText}`;
}

/**
 * What a listing row says a model costs as chat completions on `apiBase`. Pure.
 *
 * Dollars per million, as OpenCode quotes them, rounded as the OpenRouter rows
 * are. A cache tier the listing leaves out bills as input, the fallback every
 * synced row uses. No row, with the reason, for: a model the listing serves on
 * another API or base; a price tiered by context size (`overrides`), or cache
 * writes priced by retention, which a run's totals cannot split; and a
 * multiplier that is not a peak-hours one (a rate moving on a date).
 */
export function listingQuote(row: ListingRow, apiBase: string): ListingQuote {
  const served = row.api?.["chat-completions"]?.base_url;
  if (typeof served !== "string" || !sameBase(served, apiBase)) {
    const apis = Object.keys(row.api ?? {}).join(", ") || "no API";
    return { skip: `served as ${typeof served === "string" ? `chat completions on ${served}` : apis}, not on this base` };
  }
  const text = row.cost?.text;
  const input = num(text?.input?.price);
  const output = num(text?.output?.price);
  if (input === null || output === null) return { skip: "no text price in the listing" };
  if (text?.input?.overrides !== undefined || text?.output?.overrides !== undefined) {
    return { skip: "priced in tiers by context size, which a run's totals cannot split" };
  }
  const read = text?.input?.cache?.read;
  const write = text?.input?.cache?.write;
  if (read !== undefined && num(read) === null) return { skip: "a cache-read price the sync cannot read" };
  if (write !== undefined && num(write) === null) return { skip: "cache writes priced by retention, which a run's totals cannot split" };
  const peaks: string[] = [];
  const multipliers = row.cost?.multipliers;
  if (multipliers !== undefined) {
    if (!Array.isArray(multipliers)) return { skip: "a multiplier the sync cannot read" };
    for (const m of multipliers) {
      const peak = peakOf(m);
      if (peak === null) return { skip: "a multiplier that is not a peak-hours one (a rate that moves on a date, say)" };
      peaks.push(peak);
    }
  }
  const price = {
    input: round6(input),
    output: round6(output),
    cacheRead: round6(num(read) ?? input),
    cacheWrite: round6(num(write) ?? input),
  };
  return { price, peak: peaks.length === 0 ? null : peaks.join("; ") };
}

/** The sentence a peak-hours row's note carries, after the provider's own. */
export function peakNote(peak: string): string {
  return `The listing bills ${peak}, which a date window cannot say, so this is the off-peak rate and a run that spans those hours cost up to that multiple`;
}

/** Normalised key or alias -> entry key. */
function entryIndex(doc: Doc): Map<string, string> {
  const index = new Map<string, string>();
  for (const [key, e] of Object.entries(doc.models)) {
    index.set(normalizeModelId(key), key);
    for (const a of e.aliases ?? []) index.set(normalizeModelId(a), key);
  }
  return index;
}

/**
 * A listing provider's rows, by served id: the windows of every row the sync
 * keeps, and the ids of the hand-held ones (a row that states its own `source`).
 */
export function listingRows(doc: Doc, providerId: string): { windows: Record<string, SyncedWindow[]>; held: string[] } {
  const windows: Record<string, SyncedWindow[]> = {};
  const held: string[] = [];
  for (const [key, e] of Object.entries(doc.models)) {
    const row = e.prices?.endpoints?.[providerId];
    if (row === undefined) continue;
    for (const id of row.ids ?? [key]) {
      if (row.source !== undefined) held.push(id);
      else windows[id] = row.windows;
    }
  }
  return { windows, held };
}

/**
 * The ids to ask a listing for: every id its kept rows price (a model dropped
 * from the roster still has runs), and every roster leg or run on the
 * provider's base. A free or contributor slug needs no row and is not asked
 * for; nor is a hand-held row's id.
 */
export function listingAsks(doc: Doc, providerId: string, launches: readonly Launch[]): string[] {
  const apiBase = doc.providers[providerId]?.["apiBase"];
  if (typeof apiBase !== "string") return [];
  const { windows, held } = listingRows(doc, providerId);
  const wanted = new Set(Object.keys(windows));
  for (const l of launches) if (sameBase(l.apiBase, apiBase)) wanted.add(l.model);
  for (const id of held) wanted.delete(id);
  return [...wanted].filter((id) => !isFreeSlug(id) && !isContributorSlug(id)).sort();
}

/**
 * Write a listing sync's windows onto the catalogue. Pure, like
 * `applyOpenRouterWindows`: `windows` is `mergeWindows`'s answer for the
 * provider, `peaks` the peak-hours caveat of each id the listing quoted today
 * (null for none). A kept row gets its windows and, for a quoted id, its note
 * (the provider's plus the caveat, or none); a new id gets a row dated today,
 * on the entry its key or an alias names. The note keeps the provider's
 * placeholders, so it reads the listing's latest date like every other row.
 * Returned rather than written: an id
 * no entry lists, and one whose entry already has a row on this provider for
 * another id (`clash`). Hand-held rows are never touched.
 */
export function applyListingWindows(
  doc: Doc,
  providerId: string,
  windows: Readonly<Record<string, SyncedWindow[]>>,
  peaks: Readonly<Record<string, string | null>>,
  asOf: string,
): { doc: Doc; unlisted: string[]; clash: string[] } {
  const next = structuredClone(doc);
  const index = entryIndex(next);
  const provider = next.providers[providerId] ?? {};
  const providerNote = typeof provider["note"] === "string" ? provider["note"] : "";
  const unlisted: string[] = [];
  const clash: string[] = [];
  for (const id of Object.keys(windows).sort()) {
    const key = index.get(normalizeModelId(id));
    if (key === undefined) {
      unlisted.push(id);
      continue;
    }
    const prices = (next.models[key]!.prices ??= {});
    const endpoints = (prices.endpoints ??= {});
    const prior = endpoints[providerId];
    if (prior !== undefined && !(prior.ids ?? [key]).includes(id)) {
      clash.push(id);
      continue;
    }
    if (prior?.source !== undefined) continue;
    const row: EndpointRowDoc = prior === undefined ? { ...(id === key ? {} : { ids: [id] }), asOf, windows: [] } : { ...prior };
    row.windows = windows[id]!.map((w) => ({ ...w }));
    if (id in peaks) {
      const peak = peaks[id];
      if (peak === null || peak === undefined) delete row.note;
      else row.note = `${providerNote}. ${peakNote(peak)}`;
    }
    endpoints[providerId] = row;
  }
  next.providers[providerId] = { ...provider, asOf };
  return { doc: next, unlisted, clash };
}

/** One listing provider's sync, reported. */
export interface ListingReport {
  providerId: string;
  wanted: number;
  priced: string[];
  appended: string[];
  kept: string[];
  skipped: string[];
  unlisted: string[];
  clash: string[];
}

/** Read a provider's listing and fold it into `doc`. */
async function syncListing(doc: Doc, providerId: string, launches: readonly Launch[], today: string): Promise<{ doc: Doc; report: ListingReport }> {
  const url = doc.providers[providerId]!["listing"] as string;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return foldListing(doc, providerId, ((await res.json()) as { data?: ListingRow[] }).data ?? [], launches, today);
}

/**
 * One provider's listing, folded into the catalogue: the asks, each quoted or
 * skipped with its reason, merged onto the rows the sync keeps (appending
 * only), and written. Pure; `syncListing` is the fetch around it.
 */
export function foldListing(doc: Doc, providerId: string, listing: readonly ListingRow[], launches: readonly Launch[], today: string): { doc: Doc; report: ListingReport } {
  const apiBase = doc.providers[providerId]!["apiBase"] as string;
  const byId = new Map<string, ListingRow>();
  for (const r of listing) if (typeof r.id === "string") byId.set(r.id, r);

  const asks = listingAsks(doc, providerId, launches);
  const fresh: Record<string, SyncedPrice> = {};
  const peaks: Record<string, string | null> = {};
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const id of asks) {
    const row = byId.get(id);
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    const quote = listingQuote(row, apiBase);
    if ("skip" in quote) {
      skipped.push(`${id} (${quote.skip})`);
      continue;
    }
    if (isZeroQuote(id, quote.price)) {
      skipped.push(`${id} (quoted at 0/0 without a free suffix)`);
      continue;
    }
    fresh[id] = quote.price;
    peaks[id] = quote.peak;
  }
  const { windows: prior } = listingRows(doc, providerId);
  const merged = mergeWindows(prior, fresh, today);
  // Only what this sync asked about: a kept row it was not told about stays exactly as it is.
  const touched = Object.fromEntries(Object.entries(merged).filter(([id]) => id in fresh));
  const { doc: out, unlisted, clash } = applyListingWindows(doc, providerId, touched, peaks, today);
  const appended = Object.keys(fresh).filter((id) => (prior[id]?.length ?? 0) > 0 && movedToday(prior[id]!, merged[id]!, today));
  return {
    doc: out,
    report: {
      providerId,
      wanted: asks.length,
      priced: Object.keys(fresh).filter((id) => !unlisted.includes(id) && !clash.includes(id)),
      appended,
      kept: missing.filter((id) => prior[id] !== undefined),
      skipped: [...skipped, ...missing.filter((id) => prior[id] === undefined).map((id) => `${id} (not in the listing)`)],
      unlisted,
      clash,
    },
  };
}

/** `--fleet <file>` and `--runs <file>`: the roster and runs as files, for a checkout that has neither. */
export function parseArgs(argv: readonly string[]): { fleet: string | null; runs: string | null } {
  const out = { fleet: null as string | null, runs: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const flag = a === "--fleet" ? "fleet" : a === "--runs" ? "runs" : null;
    if (flag === null) throw new Error(`sync-prices: unknown argument ${a} (expected --fleet <config export> and/or --runs <runs listing>)`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`sync-prices: ${a} needs a file`);
    out[flag] = v;
  }
  return out;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const text = await Bun.file(OUT).text();
  parseCatalogue(text, OUT);
  const doc = JSON.parse(text) as Doc;
  const launches: Launch[] = [];
  if (args.fleet !== null) launches.push(...rosterLaunches(await Bun.file(args.fleet).text()));
  else {
    const fleet = readFleetConfig();
    if (fleet.status === "ok") launches.push(...rosterLaunches(fleet.text));
    else console.error(`sync-prices: config store ${fleet.status} — pricing the corpus and the catalogue's own ids only (--fleet <file> takes a config export)`);
  }
  launches.push(...(args.runs !== null ? runLaunches(await Bun.file(args.runs).text()) : await corpusLaunches(RUNS)));
  const wanted = new Set<string>(catalogueOpenRouterIds(doc));
  for (const l of launches) for (const id of openRouterAsks(l)) wanted.add(id);
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
  const prior = catalogueWindows(doc);
  const appended = Object.entries(windows)
    .filter(([id, ws]) => models[id] !== undefined && (prior[id]?.length ?? 0) > 0 && movedToday(prior[id]!, ws, today))
    .map(([id]) => id);
  // Wanted, not quoted, and already holding windows: kept as they are.
  const kept = missing.filter((id) => windows[id] !== undefined);
  const unpriced = missing.filter((id) => windows[id] === undefined);

  const { doc: synced, unlisted } = applyOpenRouterWindows(doc, windows, today);
  let out = synced;
  const listings: ListingReport[] = [];
  for (const [providerId, p] of Object.entries(out.providers)) {
    if (typeof p["listing"] !== "string") continue;
    const r = await syncListing(out, providerId, launches, today);
    out = r.doc;
    listings.push(r.report);
  }
  const written = formatCatalogue(out);
  parseCatalogue(written, OUT);
  await Bun.write(OUT, written);
  for (const r of listings) {
    console.log(`${OUT}: ${r.priced.length} ${r.providerId} ids priced from its own listing, of ${r.wanted} wanted`);
    if (r.appended.length > 0) console.log(`  ${r.providerId} rate changed, new window from ${today} (earlier runs keep the old rate): ${r.appended.join(", ")}`);
    if (r.kept.length > 0) console.log(`  no longer in ${r.providerId}'s listing (every window kept): ${r.kept.join(", ")}`);
    // These fall back to the entry's OpenRouter row through the alias, where it has one.
    if (r.skipped.length > 0) console.log(`  no ${r.providerId} row written: ${r.skipped.join("; ")}`);
    if (r.unlisted.length > 0) console.log(`  priced by ${r.providerId} but not in the model catalogue (add an entry or alias to ${OUT}, then sync again): ${r.unlisted.join(", ")}`);
    if (r.clash.length > 0) console.log(`  the entry already has a ${r.providerId} row under another id (no row written): ${r.clash.join(", ")}`);
  }
  console.log(`${OUT}: ${Object.keys(windows).filter((id) => models[id] !== undefined && !unlisted.includes(id)).length} OpenRouter ids priced of ${wanted.size} wanted, from ${rows.length} catalogue rows`);
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
  if (kept.length > 0) {
    // Gone from OpenRouter, but their runs billed at the rates on file: every
    // window stays, and a relisting is picked up on a later sync.
    console.log(`no longer priced by OpenRouter (every window kept): ${kept.join(", ")}`);
  }
  if (unpriced.length > 0) {
    // Most of these are OpenCode Zen / local ids, which OpenRouter never
    // carries — they are free or local and priced by rule, not by table.
    console.log(`not in the OpenRouter catalogue (left unpriced): ${unpriced.join(", ")}`);
  }
}

if (import.meta.main) await main();
