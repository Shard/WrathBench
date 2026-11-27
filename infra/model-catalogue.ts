/**
 * The model catalogue: every model id the fleet has used, and every static
 * fact the repository keeps about it — who made it, its family and logo, its
 * display name, whether its weights are published, the other spellings it goes
 * by, and what each provider charges for it. The data is
 * `infra/model-catalogue.json`; this module is the whole of the code that reads
 * it, so the runner (bundled into its image whole), the dashboard build and the
 * infra scripts all read one file through one set of functions, and nothing
 * else in the tree keeps a per-model table.
 *
 * What it is not: the config store's roster. A roster entry
 * (`roster/<name>`: tier, idle, apiBase, effort, …) is operator config and
 * names a catalogue model by its id. Scheduling reads one thing here, a
 * model's identity across providers (`canonicalModelId`), so two entries of
 * one model fill one target; nothing else it decides comes from this file.
 *
 * **Lookup.** An id is compared trimmed, lowercased and without a trailing
 * `:free` (OpenRouter's variant suffix: the same model, another endpoint). It
 * resolves to the entry whose key or one of whose `aliases` it is. An id no
 * entry lists falls back to the first family whose `match` glob claims it, file
 * order being the precedence, so a run of a model nobody has catalogued yet
 * still gets its vendor's mark — but it gets no name, no prices, and its
 * weights read `unknown` unless the family states one for every model it
 * holds. The tests refuse any id in the repository's fixtures, roster examples
 * or price rows that only reaches the fallback, and `--status` names roster
 * entries that do, so a new model cannot quietly live there.
 *
 * **Prices** are matched on the id the *provider* bills under, exactly — never
 * through an alias, since the same model is different money on different
 * hosts (`viewer/pricing.ts` says in what order). The one exception is
 * a subscription endpoint's paid run with no endpoint row (an OpenCode Go
 * model OpenCode's listing does not price): a flat plan has no per-host bill,
 * so it reads its entry's OpenRouter row through the alias, as-if-metered
 * (`subscriptionListPrice`). An OpenRouter row is keyed by its OpenRouter id
 * and written by `infra/sync-prices.ts`; so is an endpoint row of a provider
 * that publishes a `listing` (OpenCode Go), unless the row states its own
 * `source`, which marks it hand-held. An Anthropic row and an endpoint row
 * list their ids (`ids`, defaulting to the entry's key). Rates are windowed: a list in date order, the first with no
 * `from`, so a run is priced at the rate in force when it started.
 *
 * Everything that resolves an id is total: null, undefined and nonsense all
 * answer, none throw.
 */

import raw from "./model-catalogue.json";

// ------------------------------------------------------------------- shape

/**
 * Whether a model's weights can be downloaded. `open` means a checkpoint of
 * that exact model is published; `closed` that it is served only; `unknown`
 * that nobody checked, or there was nothing to check against (a stealth id,
 * weights announced but not out).
 */
export type Weights = "open" | "closed" | "unknown";

export const WEIGHTS: readonly Weights[] = ["open", "closed", "unknown"];

/** `list` is the vendor's own published price; `catalogue` a third-party listing of it (models.dev), and said so. */
export type PriceSource = "list" | "catalogue";

/** Dollars per million tokens, and the day the rate took over (absent on a model's first window). */
export interface RateWindow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  from?: string;
}

/** A family: the logo, the brand name and the company, and the globs that claim an id no entry lists. */
export interface CatalogueFamily {
  /** Stable id; also the logo asset's file name. */
  id: string;
  /** How the family is written in prose ("Claude", "GPT"). */
  name: string;
  /** Who makes it. The ladder's company filter is this, lowercased. */
  company: string;
  /** The icon slug in the pinned icon package; absent means the family has no logo and gets a monogram. */
  icon?: string;
  /** Id globs, `*` matching any run of characters, for ids no entry lists. */
  match: readonly string[];
  /** A weights verdict for every model of the family, listed or not — only where the company publishes none at all. */
  weights?: Weights;
  /** Where that family-wide verdict comes from. */
  source?: string;
}

/** Who a price row is from: OpenRouter (synced), Anthropic (by hand), or another endpoint matched on its base. */
export interface CatalogueProvider {
  name: string;
  /** The day `infra/sync-prices.ts` last read this provider's prices: OpenRouter's catalogue, or a provider's `listing`. */
  asOf?: string;
  /** An endpoint provider: the `apiBase` a run must have recorded, compared as origin plus path. */
  apiBase?: string;
  /** An endpoint provider: the prefix of the row's on-screen id (`cerebras/qwen-3.8-27b`). */
  label?: string;
  source?: PriceSource;
  /**
   * An endpoint provider's default note for its rows. In it, or in a row's own,
   * `{asOf}` is the row's date and `{read}` the provider's `asOf` (the day its
   * listing was last read).
   */
  note?: string;
  /**
   * An endpoint provider billed as a flat plan (OpenCode Go): its rows are
   * as-if-metered, and the per-response `usage.cost` it reports is the overage
   * past the allowance, not the run's cost (`viewer/pricing.ts`).
   */
  subscription?: boolean;
  /**
   * An endpoint provider that publishes its own per-model prices, machine
   * readable (OpenCode's `/models`): the listing's URL. `infra/sync-prices.ts`
   * reads it and keeps this provider's rows the way it keeps OpenRouter's —
   * dated, appended, never cleared — except a row that states its own
   * `source`, which is a hand-held row the sync leaves alone. The provider's
   * `asOf` is then the day the listing was last read.
   */
  listing?: string;
}

/** One OpenRouter id's synced windows. A sync only appends; an empty list is an id emptied before it kept history. */
export interface OpenRouterPrice {
  windows: readonly RateWindow[];
  /** Why the id is unpriced for good: OpenRouter delisted it, so no sync can bring a rate back. */
  delisted?: string;
}

/** Anthropic's list price, matched on the model the Claude Code CLI served — or a decided blank. */
export interface AnthropicPrice {
  /** The served ids this row prices, exact; the entry's key when absent. */
  ids?: readonly string[];
  /** The day these list prices were read. */
  asOf?: string;
  windows?: readonly RateWindow[];
  /** Why there is no row on purpose, said on every run of it. */
  unpriced?: string;
}

/** A non-OpenRouter endpoint's price for this model, matched on the run's base and id. */
export interface EndpointPrice {
  /** The ids the endpoint serves this model under, exact; the entry's key when absent. */
  ids?: readonly string[];
  /** When the figures were taken (the first window's date; later ones carry their own `from`). */
  asOf: string;
  windows: readonly RateWindow[];
  /** Overrides the provider's note. */
  note?: string;
  /** Overrides the provider's source. */
  source?: PriceSource;
}

export interface ModelPrices {
  /** OpenRouter id -> its synced windows. */
  openrouter?: Readonly<Record<string, OpenRouterPrice>>;
  anthropic?: AnthropicPrice;
  /** Endpoint provider id (a key of `providers`) -> its row. */
  endpoints?: Readonly<Record<string, EndpointPrice>>;
}

/** One model, under the id the fleet ran it as. */
export interface CatalogueModel {
  /** A family id; null where the developer is not known (an unrevealed stealth id). */
  family: string | null;
  /** The model's own name, for prose. */
  name: string;
  /** Required unless the family states a verdict for all its models. */
  weights?: Weights;
  /** Where the weights verdict, or the attribution, was checked. */
  source?: string;
  /** Other spellings of this model: a codex slug, a dated snapshot, a Zen `-free` id, the id a provider reported serving. */
  aliases?: readonly string[];
  /** Anything else a reader should know about the id. */
  note?: string;
  prices?: ModelPrices;
}

export interface ModelCatalogue {
  version: number;
  /** The pinned logo source: @lobehub/icons-static-svg (MIT), fetched by `infra/fetch-model-logos.ts`. */
  icons: { package: string; version: string };
  providers: Readonly<Record<string, CatalogueProvider>>;
  /** File order is the glob precedence. */
  families: readonly CatalogueFamily[];
  models: Readonly<Record<string, CatalogueModel>>;
}

/** The catalogue as the file holds it. Validated by `parseCatalogue` in the tests, not at import, so a page never throws on load. */
export const CATALOGUE: ModelCatalogue = raw as unknown as ModelCatalogue;

/** The families, in file order — which is the matching precedence. */
export const FAMILIES: readonly CatalogueFamily[] = CATALOGUE.families;

// ------------------------------------------------------------------ lookup

/** The id as the catalogue compares it: trimmed, lowercased, without a `:free` suffix. */
export function normalizeModelId(model: string): string {
  const id = model.trim().toLowerCase();
  return id.endsWith(":free") ? id.slice(0, -":free".length) : id;
}

/**
 * A glob match anchored at both ends, `*` matching any run of characters.
 *
 * Written out rather than compiled to a RegExp: the patterns are catalogue
 * data, and a pattern built into a regex by concatenation is one `+` in a
 * model id away from meaning something else.
 */
export function globMatch(pattern: string, s: string): boolean {
  const parts = pattern.split("*");
  const first = parts[0]!;
  if (parts.length === 1) return s === first;
  const last = parts[parts.length - 1]!;
  if (!s.startsWith(first) || !s.endsWith(last)) return false;
  let at = first.length;
  const end = s.length - last.length;
  if (end < at) return false;
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (seg === "") continue;
    const found = s.indexOf(seg, at);
    if (found === -1 || found + seg.length > end) return false;
    at = found + seg.length;
  }
  return true;
}

/** Normalised key or alias -> entry key, for one catalogue. */
function indexOf(cat: ModelCatalogue): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(cat.models)) {
    out.set(normalizeModelId(key), key);
    for (const alias of entry.aliases ?? []) out.set(normalizeModelId(alias), key);
  }
  return out;
}

const INDEX = indexOf(CATALOGUE);
const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

/** The entry key an id resolves to, through its aliases, or null for an id no entry lists. */
export function catalogueKeyOf(model: string | null | undefined): string | null {
  if (model === null || model === undefined) return null;
  const id = normalizeModelId(model);
  if (id === "") return null;
  return INDEX.get(id) ?? null;
}

/** An id without its provider prefix: the part after the last slash, or the id itself when that would be empty. */
function bareOf(id: string): string {
  const slash = id.lastIndexOf("/");
  const bare = slash === -1 ? id : id.slice(slash + 1);
  return bare === "" ? id : bare;
}

/**
 * The bare form of every key and alias -> its entry key, for the general rule
 * of `canonicalModelId`. A bare form two entries would share is left out, so
 * the rule never picks between them (`parseCatalogue` refuses such a file).
 */
function bareIndexOf(cat: ModelCatalogue): Map<string, string> {
  const out = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, entry] of Object.entries(cat.models)) {
    for (const id of [key, ...(entry.aliases ?? [])]) {
      const bare = bareOf(normalizeModelId(id));
      const prior = out.get(bare);
      if (prior !== undefined && prior !== key) ambiguous.add(bare);
      else out.set(bare, key);
    }
  }
  for (const bare of ambiguous) out.delete(bare);
  return out;
}

const BARE_INDEX = bareIndexOf(CATALOGUE);

/**
 * A literally free endpoint's id, spelled as the billing rule spells it
 * (`isFreeSlug`, runner/src/model-cost.ts): an OpenRouter `:free` id, a Zen
 * `-free` id, a contributor-free one. The id without its marker, or null for
 * an id that is not one.
 */
function freeBaseOf(id: string): string | null {
  const m = /^(.*?)(?::free|-free)$/.exec(id);
  return m === null || bareOf(m[1]!) === "" || m[1]!.endsWith("/") ? null : m[1]!;
}

/** The entry an id names through its key, an alias or its bare form (rules 1–3 below), or the bare form itself. */
function resolveId(id: string): string {
  return INDEX.get(id) ?? BARE_INDEX.get(bareOf(id)) ?? bareOf(id);
}

/**
 * A model's one identity, whichever provider served it (operator,
 * 2026-11-16): OpenCode Go records DeepSeek V4.1 Flash as
 * `deepseek-v4.1-flash` and OpenRouter as `deepseek/deepseek-v4.1-flash`, and
 * both answer `deepseek/deepseek-v4.1-flash`. What a reader groups by (a
 * ladder entry, a models row, a filter, an export cell) and what a target
 * counts in are this, never the id a run recorded, which stays the record.
 *
 * Keyed on the provider's id, compared trimmed and lowercased:
 *
 * 1. An id the catalogue lists, as a key or an alias, is that entry's key.
 *    The aliases are the explicit entries, for spellings no rule can decide (a
 *    codex slug, a dated snapshot, `qwen-3.8-27b` beside `qwen/qwen3.8-27b`).
 * 2. Otherwise the general rule: a vendor-prefixed id and the bare id after
 *    its slash are one model, so either form finds the entry whose key or
 *    alias has that bare form (`north-mini-code` is `cohere/north-mini-code`).
 * 3. An id nothing lists is its bare form, so a bare and a prefixed run of an
 *    uncatalogued model still meet.
 *
 * A literally free endpoint is never the paid model (operator, 2026-11-16):
 * an OpenRouter `:free` id, a Zen `-free` id and a contributor-free one are
 * the model they serve marked `:free` (`deepseek/deepseek-v4.1-flash:free`,
 * `poolside/laguna-s-2.1:free` for Zen's `laguna-s-2.1-free`), one model
 * across the free endpoints and always shown as free. An entry spelled free
 * (`cat-jam-free`, whose alias `catjam` is too) is its own key.
 *
 * Pure and total; an empty id is handed back as it came.
 */
export function canonicalModelId(model: string): string {
  const id = model.trim().toLowerCase();
  if (id === "") return model;
  const free = freeBaseOf(id);
  // Listed as it is first (a `-free` entry, a `-free` alias of a paid one), then by its rules.
  const key = INDEX.get(id) ?? resolveId(free ?? id);
  // An entry spelled free is its own free model; a free endpoint of a paid one is that model marked free.
  if (freeBaseOf(key) !== null) return key;
  return free !== null ? `${key}:free` : key;
}

/** The first family whose glob claims the id: the fallback for an id no entry lists. */
function familyByGlob(id: string): CatalogueFamily | null {
  for (const family of FAMILIES) {
    for (const pattern of family.match) {
      if (globMatch(pattern.toLowerCase(), id)) return family;
    }
  }
  return null;
}

/** What the catalogue says about one id, resolved. */
export interface ResolvedModel {
  /** The entry key, or null for an id no entry lists. */
  key: string | null;
  entry: CatalogueModel | null;
  family: CatalogueFamily | null;
  /** The model's own name; null for an unlisted id. */
  name: string | null;
  weights: Weights;
}

const NOTHING: ResolvedModel = { key: null, entry: null, family: null, name: null, weights: "unknown" };

/** Everything the catalogue knows about an id. Total. */
export function modelOf(model: string | null | undefined): ResolvedModel {
  if (model === null || model === undefined) return NOTHING;
  const id = normalizeModelId(model);
  if (id === "") return NOTHING;
  const key = INDEX.get(id);
  if (key !== undefined) {
    const entry = CATALOGUE.models[key]!;
    const family = entry.family === null ? null : (FAMILY_BY_ID.get(entry.family) ?? null);
    return { key, entry, family, name: entry.name, weights: entry.weights ?? family?.weights ?? "unknown" };
  }
  const family = familyByGlob(id);
  return { key: null, entry: null, family, name: null, weights: family?.weights ?? "unknown" };
}

/** The family an id belongs to, or null for one nothing claims (the UI's monogram). */
export function familyOf(model: string | null | undefined): CatalogueFamily | null {
  return modelOf(model).family;
}

/** Whether a model's weights are published. `unknown` for an id the catalogue cannot answer for. */
export function weightsOf(model: string | null | undefined): Weights {
  const w = modelOf(model).weights;
  return WEIGHTS.includes(w) ? w : "unknown";
}

// ------------------------------------------------------------------ prices

/** Every OpenRouter id's windows, flat, as `viewer/pricing.ts` reads them. */
export interface OpenRouterTable {
  /** The day the catalogue was last read, not the day a rate began. */
  asOf: string;
  models: Readonly<Record<string, readonly RateWindow[]>>;
}

/** One Anthropic row: the served ids it prices and their windows. */
export interface AnthropicRow {
  ids: readonly string[];
  windows: readonly RateWindow[];
  asOf: string;
}

/** One endpoint row, resolved against its provider. */
export interface EndpointRow {
  /** What the row is called on screen: `<provider label>/<id>`. */
  id: string;
  /** The exact `apiBase` a run must have recorded. */
  apiBase: string;
  /** The model id as the provider names it — exact, case-sensitive. */
  model: string;
  windows: readonly RateWindow[];
  /**
   * The date an undated first window reads as. A hand-held row's own `asOf`
   * (the day it was typed); a row the sync keeps from a provider's `listing`,
   * the day that listing was last read — the provider's `asOf`, as an
   * OpenRouter row reads the catalogue's (`syncedListingAsOf`).
   */
  asOf: string;
  source: PriceSource;
  note: string;
  /** The provider's `subscription`: the row is a comparison, not a bill. */
  subscription: boolean;
}

/**
 * The day a row the sync keeps from its provider's `listing` was last read, or
 * null for a hand-held row (one stating its own `source`, or on a provider with
 * no listing). An undated first window reads as this date, as an OpenRouter
 * row's reads as the day the catalogue was last synced: the rate is confirmed
 * as of the latest read, not only as of the day the row was first written,
 * which stays in the note ("row since").
 */
export function syncedListingAsOf(provider: CatalogueProvider, row: { source?: PriceSource }): string | null {
  if (provider.listing === undefined || row.source !== undefined) return null;
  return provider.asOf ?? null;
}

/** The flat views of one catalogue's prices. Pure; the module's own are below. */
export function priceTables(cat: ModelCatalogue): {
  openrouter: OpenRouterTable;
  delisted: Readonly<Record<string, string>>;
  anthropic: readonly AnthropicRow[];
  anthropicUnpriced: Readonly<Record<string, string>>;
  endpoints: readonly EndpointRow[];
} {
  const synced: Record<string, readonly RateWindow[]> = {};
  const delisted: Record<string, string> = {};
  const anthropic: AnthropicRow[] = [];
  const anthropicUnpriced: Record<string, string> = {};
  const endpoints: EndpointRow[] = [];
  for (const [key, entry] of Object.entries(cat.models)) {
    const p = entry.prices;
    if (p === undefined) continue;
    for (const [id, row] of Object.entries(p.openrouter ?? {})) {
      // An empty list (an id emptied before the sync kept history) is asked
      // for again on every sync, and read as having no row at all.
      if (row.windows.length > 0) synced[id] = row.windows;
      if (row.delisted !== undefined) delisted[id] = row.delisted;
    }
    const a = p.anthropic;
    if (a !== undefined) {
      const ids = a.ids ?? [key];
      if (a.unpriced !== undefined) for (const id of ids) anthropicUnpriced[id] = a.unpriced;
      if (a.windows !== undefined && a.windows.length > 0) anthropic.push({ ids, windows: a.windows, asOf: a.asOf ?? "" });
    }
    for (const [providerId, row] of Object.entries(p.endpoints ?? {})) {
      const provider = cat.providers[providerId];
      if (provider?.apiBase === undefined) continue;
      for (const model of row.ids ?? [key]) {
        endpoints.push({
          id: `${provider.label ?? providerId}/${model}`,
          apiBase: provider.apiBase,
          model,
          windows: row.windows,
          asOf: syncedListingAsOf(provider, row) ?? row.asOf,
          source: row.source ?? provider.source ?? "list",
          note: (row.note ?? provider.note ?? "").replaceAll("{asOf}", row.asOf).replaceAll("{read}", provider.asOf ?? row.asOf),
          subscription: provider.subscription === true,
        });
      }
    }
  }
  const sorted = Object.fromEntries(Object.keys(synced).sort().map((id) => [id, synced[id]!]));
  return { openrouter: { asOf: cat.providers["openrouter"]?.asOf ?? "", models: sorted }, delisted, anthropic, anthropicUnpriced, endpoints };
}

/*
 * The module's own tables. Every step is a pure-annotated call rather than a
 * property read, because a bundler keeps a top-level `TABLES.x` as a possible
 * getter with side effects: this way a bundle that reads no price (the
 * dashboard's) drops the walk and the code behind it.
 */
type PriceTables = ReturnType<typeof priceTables>;
const TABLES: PriceTables = /* @__PURE__ */ priceTables(CATALOGUE);
const table = <K extends keyof PriceTables>(k: K): PriceTables[K] => TABLES[k];

/** OpenRouter's catalogue prices, by OpenRouter id (`infra/sync-prices.ts` writes them). */
export const OPENROUTER_PRICES: OpenRouterTable = /* @__PURE__ */ table("openrouter");
/** OpenRouter ids the catalogue has dropped for good, and why. */
export const OPENROUTER_DELISTED: Readonly<Record<string, string>> = /* @__PURE__ */ table("delisted");
/** Anthropic list prices, by the id the Claude Code CLI served. */
export const ANTHROPIC_PRICES: readonly AnthropicRow[] = /* @__PURE__ */ table("anthropic");
/** Claude models with no row on purpose, and why — a decided blank, not a missing one. */
export const ANTHROPIC_UNPRICED: Readonly<Record<string, string>> = /* @__PURE__ */ table("anthropicUnpriced");
/** Endpoints that are not OpenRouter (metered, or a subscription), matched on the run's base and id. */
export const ENDPOINT_PRICES: readonly EndpointRow[] = /* @__PURE__ */ table("endpoints");

// -------------------------------------------------------------- validation

const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES: readonly string[] = ["list", "catalogue"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where} must be a non-empty string`);
  return value;
}

function only(o: Obj, keys: readonly string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length > 0) throw new Error(`${where}: unknown key ${extra.map((k) => `\`${k}\``).join(", ")} (valid: ${keys.join(", ")})`);
}

function windows(value: unknown, where: string, allowEmpty: boolean): void {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array of rate windows`);
  if (value.length === 0 && !allowEmpty) throw new Error(`${where} must hold at least one window`);
  let last = "";
  value.forEach((w, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(w)) throw new Error(`${at} must be an object`);
    only(w, ["input", "output", "cacheRead", "cacheWrite", "from"], at);
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
      const n = w[k];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`${at}.${k} must be a non-negative number`);
    }
    if (i === 0 && w["from"] !== undefined) throw new Error(`${at}: the first window carries no \`from\` — it prices everything before the next`);
    if (i > 0) {
      const from = w["from"];
      if (typeof from !== "string" || !DAY.test(from)) throw new Error(`${at}.from must be a YYYY-MM-DD day`);
      if (from <= last) throw new Error(`${at}.from must come after the window before it`);
      last = from;
    }
  });
}

function idList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where} must be a non-empty array of ids`);
  return value.map((v, i) => str(v, `${where}[${i}]`));
}

/**
 * Parse and validate the catalogue file. Hand-rolled rather than zod, like
 * the rest of infra's config reading: the shape is small and the errors are
 * worth naming the offending entry. Run by the tests over the committed file,
 * by the logo fetch and by the price sync before either writes anything.
 */
export function parseCatalogue(json: string, where = "infra/model-catalogue.json"): ModelCatalogue {
  let top: unknown;
  try {
    top = JSON.parse(json);
  } catch (err) {
    throw new Error(`${where}: not valid JSON — ${(err as Error).message}`);
  }
  if (!isObj(top)) throw new Error(`${where}: expected an object`);
  only(top, ["_notes", "version", "icons", "providers", "families", "models"], where);
  if (typeof top["version"] !== "number") throw new Error(`${where}: version must be a number`);

  const icons = top["icons"];
  if (!isObj(icons)) throw new Error(`${where}: icons must be an object with package and version`);
  str(icons["package"], `${where}: icons.package`);
  str(icons["version"], `${where}: icons.version`);

  const providers = top["providers"];
  if (!isObj(providers)) throw new Error(`${where}: providers must be an object`);
  for (const id of ["openrouter", "anthropic"]) if (!isObj(providers[id])) throw new Error(`${where}: providers.${id} is required`);
  for (const [id, p] of Object.entries(providers)) {
    const at = `${where}: providers.${id}`;
    if (!isObj(p)) throw new Error(`${at} must be an object`);
    only(p, ["name", "asOf", "apiBase", "label", "source", "note", "subscription", "listing"], at);
    str(p["name"], `${at}.name`);
    if (id === "openrouter" && (typeof p["asOf"] !== "string" || !DAY.test(p["asOf"]))) throw new Error(`${at}.asOf must be a YYYY-MM-DD day`);
    if (p["apiBase"] !== undefined) {
      const base = str(p["apiBase"], `${at}.apiBase`);
      try {
        new URL(base);
      } catch {
        throw new Error(`${at}.apiBase is not a URL`);
      }
      if (!SAFE_SLUG.test(str(p["label"], `${at}.label`))) throw new Error(`${at}.label must match ${SAFE_SLUG}`);
    }
    if (p["source"] !== undefined && !SOURCES.includes(p["source"] as string)) throw new Error(`${at}.source must be list or catalogue`);
    if (p["subscription"] !== undefined && (p["subscription"] !== true || p["apiBase"] === undefined)) {
      throw new Error(`${at}.subscription must be true, on an endpoint provider`);
    }
    if (p["listing"] !== undefined) {
      if (p["apiBase"] === undefined) throw new Error(`${at}.listing is for an endpoint provider (one with an apiBase)`);
      try {
        new URL(str(p["listing"], `${at}.listing`));
      } catch {
        throw new Error(`${at}.listing is not a URL`);
      }
      if (p["asOf"] !== undefined && (typeof p["asOf"] !== "string" || !DAY.test(p["asOf"]))) throw new Error(`${at}.asOf must be a YYYY-MM-DD day`);
    }
  }

  const families = top["families"];
  if (!Array.isArray(families) || families.length === 0) throw new Error(`${where}: families must be a non-empty array`);
  const familyIds = new Set<string>();
  families.forEach((f, i) => {
    if (!isObj(f)) throw new Error(`${where}: families[${i}] must be an object`);
    const id = str(f["id"], `${where}: families[${i}].id`);
    // The id is written as `<id>.svg`; keep it to something that cannot escape
    // the assets directory or surprise a bundler.
    if (!SAFE_SLUG.test(id)) throw new Error(`${where}: families[${i}].id "${id}" must match ${SAFE_SLUG}`);
    if (familyIds.has(id)) throw new Error(`${where}: duplicate family id "${id}"`);
    familyIds.add(id);
    const at = `${where}: family ${id}`;
    only(f, ["id", "name", "company", "icon", "match", "weights", "source"], at);
    str(f["name"], `${at} name`);
    str(f["company"], `${at} company`);
    if (f["icon"] !== undefined && !SAFE_SLUG.test(str(f["icon"], `${at} icon`))) throw new Error(`${at} icon must match ${SAFE_SLUG}`);
    idList(f["match"], `${at} match`);
    if (f["weights"] !== undefined && !(WEIGHTS as readonly unknown[]).includes(f["weights"])) throw new Error(`${at} weights must be one of ${WEIGHTS.join(", ")}`);
    if (f["weights"] !== undefined) str(f["source"], `${at} source (a family-wide weights verdict says where it is from)`);
  });
  const familyWeights = new Map(families.map((f) => [(f as Obj)["id"] as string, (f as Obj)["weights"]]));

  const models = top["models"];
  if (!isObj(models) || Object.keys(models).length === 0) throw new Error(`${where}: models must be a non-empty object`);
  const seen = new Map<string, string>();
  const claim = (id: string, key: string, what: string): void => {
    const n = normalizeModelId(id);
    if (n !== id) throw new Error(`${where}: model ${key}: ${what} "${id}" must be written as the catalogue compares it ("${n}")`);
    const prior = seen.get(n);
    if (prior !== undefined) throw new Error(`${where}: "${id}" names two entries (${prior} and ${key})`);
    seen.set(n, key);
  };
  const bares = new Map<string, string>();
  const billed = new Map<string, string>();
  const bill =(ns: string, id: string, key: string): void => {
    const k = `${ns} ${id}`;
    if (billed.has(k)) throw new Error(`${where}: ${ns} prices "${id}" twice (${billed.get(k)} and ${key})`);
    billed.set(k, key);
  };
  for (const [key, e] of Object.entries(models)) {
    const at = `${where}: model ${key}`;
    if (!isObj(e)) throw new Error(`${at} must be an object`);
    only(e, ["family", "name", "weights", "source", "aliases", "note", "prices"], at);
    claim(key, key, "the key");
    for (const a of e["aliases"] === undefined ? [] : idList(e["aliases"], `${at} aliases`)) claim(a, key, "alias");
    // `canonicalModelId`'s general rule: a bare form names one entry, or a
    // Go-served and an OpenRouter-served run could land on two models.
    for (const id of [key, ...((e["aliases"] as string[] | undefined) ?? [])]) {
      const bare = bareOf(normalizeModelId(id));
      const prior = bares.get(bare);
      if (prior !== undefined && prior !== key) throw new Error(`${where}: the bare id "${bare}" names two entries (${prior} and ${key}): a bare id and its vendor-prefixed form are one model (canonicalModelId)`);
      bares.set(bare, key);
    }
    if (e["family"] !== null && !familyIds.has(e["family"] as string)) throw new Error(`${at}: family must be a family id or null`);
    str(e["name"], `${at} name`);
    if (e["weights"] === undefined) {
      if (e["family"] === null || familyWeights.get(e["family"] as string) === undefined) {
        throw new Error(`${at}: weights is required (open, closed or unknown) — its family states none for all its models`);
      }
    } else if (!(WEIGHTS as readonly unknown[]).includes(e["weights"])) throw new Error(`${at} weights must be one of ${WEIGHTS.join(", ")}`);
    if (e["source"] !== undefined) str(e["source"], `${at} source`);
    if (e["note"] !== undefined) str(e["note"], `${at} note`);
    const own = new Set([key, ...((e["aliases"] as string[] | undefined) ?? [])]);
    const mine = (id: string, what: string): void => {
      if (!own.has(normalizeModelId(id))) throw new Error(`${at}: ${what} "${id}" is not this entry's key or one of its aliases`);
    };
    const prices = e["prices"];
    if (prices === undefined) continue;
    if (!isObj(prices)) throw new Error(`${at} prices must be an object`);
    only(prices, ["openrouter", "anthropic", "endpoints"], `${at} prices`);
    if (prices["openrouter"] !== undefined) {
      if (!isObj(prices["openrouter"])) throw new Error(`${at} prices.openrouter must map OpenRouter ids to windows`);
      for (const [id, row] of Object.entries(prices["openrouter"])) {
        const rat = `${at} prices.openrouter["${id}"]`;
        mine(id, "OpenRouter id");
        bill("openrouter", id, key);
        if (!isObj(row)) throw new Error(`${rat} must be an object`);
        only(row, ["windows", "delisted"], rat);
        windows(row["windows"], `${rat}.windows`, true);
        if (row["delisted"] !== undefined) {
          str(row["delisted"], `${rat}.delisted`);
          if ((row["windows"] as unknown[]).length > 0) throw new Error(`${rat}: a delisted id has no windows`);
        }
        // A suffixless id quoted at 0/0 would be a paid model reading as free.
        if (!/(?::free$|-free$)/.test(id) && (row["windows"] as RateWindow[]).some((w) => w.input === 0 && w.output === 0)) {
          throw new Error(`${rat}: a suffixless id is never priced at zero — declare billing "free" on the roster entry instead`);
        }
      }
    }
    if (prices["anthropic"] !== undefined) {
      const a = prices["anthropic"];
      const rat = `${at} prices.anthropic`;
      if (!isObj(a)) throw new Error(`${rat} must be an object`);
      only(a, ["ids", "asOf", "windows", "unpriced"], rat);
      const ids = a["ids"] === undefined ? [key] : idList(a["ids"], `${rat}.ids`);
      for (const id of ids) {
        mine(id, "served id");
        bill("anthropic", id, key);
      }
      if ((a["windows"] === undefined) === (a["unpriced"] === undefined)) throw new Error(`${rat}: give windows (with asOf) or unpriced, not both and not neither`);
      if (a["windows"] !== undefined) {
        windows(a["windows"], `${rat}.windows`, false);
        if (typeof a["asOf"] !== "string" || !DAY.test(a["asOf"])) throw new Error(`${rat}.asOf must be a YYYY-MM-DD day`);
      } else str(a["unpriced"], `${rat}.unpriced`);
    }
    if (prices["endpoints"] !== undefined) {
      if (!isObj(prices["endpoints"])) throw new Error(`${at} prices.endpoints must map provider ids to rows`);
      for (const [pid, row] of Object.entries(prices["endpoints"])) {
        const rat = `${at} prices.endpoints.${pid}`;
        const provider = providers[pid];
        if (!isObj(provider) || provider["apiBase"] === undefined) throw new Error(`${rat}: ${pid} is not an endpoint provider (one with an apiBase)`);
        if (!isObj(row)) throw new Error(`${rat} must be an object`);
        only(row, ["ids", "asOf", "windows", "note", "source"], rat);
        const ids = row["ids"] === undefined ? [key] : idList(row["ids"], `${rat}.ids`);
        for (const id of ids) {
          // Case-sensitive on the wire, so the id is checked as written.
          mine(id, "served id");
          bill(`endpoint ${provider["apiBase"]}`, id, key);
        }
        if (typeof row["asOf"] !== "string" || !DAY.test(row["asOf"])) throw new Error(`${rat}.asOf must be a YYYY-MM-DD day`);
        windows(row["windows"], `${rat}.windows`, false);
        if (row["note"] === undefined && provider["note"] === undefined) throw new Error(`${rat}: a row needs a note when its provider has none`);
        if (row["note"] !== undefined) str(row["note"], `${rat}.note`);
        if (row["source"] !== undefined && !SOURCES.includes(row["source"] as string)) throw new Error(`${rat}.source must be list or catalogue`);
        if (row["source"] === undefined && provider["source"] === undefined) throw new Error(`${rat}: a row needs a source when its provider has none`);
      }
    }
  }
  return top as unknown as ModelCatalogue;
}

// -------------------------------------------------------------- formatting

/**
 * The file's one spelling: two-space JSON, with any object or array short
 * enough to sit on one line kept on one — a rate window, an alias list — so a
 * hand edit and a sync write the same bytes and a diff shows what moved.
 */
export function formatCatalogue(doc: unknown): string {
  const WIDTH = 140;
  const inline = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(inline).join(", ")}]`
      : isObj(v)
        ? `{ ${Object.entries(v)
            .map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`)
            .join(", ")} }`.replace(/^\{  \}$/, "{}")
        : JSON.stringify(v);
  const block = (v: unknown, indent: string, lead: number): string => {
    if (!Array.isArray(v) && !isObj(v)) return JSON.stringify(v);
    const one = inline(v);
    if (indent.length + lead + one.length <= WIDTH && !one.includes("\n")) return one;
    const next = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[\n${v.map((x) => `${next}${block(x, next, 0)}`).join(",\n")}\n${indent}]`;
    }
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${block(x, next, JSON.stringify(k).length + 2)}`).join(",\n")}\n${indent}}`;
  };
  return `${block(doc, "", 0)}\n`;
}
