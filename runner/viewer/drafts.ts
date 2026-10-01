/**
 * New models as drafts, fetched on demand (GitHub issue #66, the operator's
 * shape of 2026-09-18).
 *
 * A manual fetch reads the OpenRouter catalogue once and proposes every
 * tool-calling model the roster does not run and the operator has not ignored.
 * A draft is not a roster entry: it is not scheduled, not on the Models page,
 * and never in the public build. The operator ignores it (remembered, never
 * proposed again unless un-ignored) or promotes it into the roster at a tier
 * they choose, where it becomes an ordinary entry under the routing rule.
 *
 * Where each piece lives, and why:
 *
 * - Storage is the config store's `proposed/` key space
 *   (`runner/src/config-store.ts`, "The draft key space"): the same file,
 *   rows no config reader sees, no audit line, no version move.
 * - The fetch is one bounded, time-limited GET of a public catalogue, parsed
 *   with Zod because it is an external boundary. It needs no key — the
 *   catalogue is public, as `infra/sync-prices.ts` already reads it — and it
 *   calls no model: whether a slug really answers a tool call is what a `t0`
 *   trial finds out.
 * - The estimate is the catalogue's list price applied to the median counted
 *   `e90`, from the runs the viewer already serves. List price under-reads
 *   reasoning-heavy models two to three times (docs/COSTS.md), so it is
 *   labelled an estimate wherever it is shown; with no counted run to take a
 *   profile from there is no estimate at all rather than an invented one.
 * - Promotion builds `{ model, tier, race?, class? }` and nothing else. No
 *   `routing` (absent IS the rule: the author's own provider, fallbacks off,
 *   or the fleet's `policy.routing` where the operator set one), no `billing`
 *   (derived from the slug, as for any entry), no `idle` (absent is none). The
 *   tier is the operator's, always: the request must name it.
 */

import { z } from "zod";
import { CATALOGUE, priceOf } from "../../infra/sync-prices";
import { PROPOSED_PREFIX, type ConfigRow } from "../src/config-store";
import { billingOf } from "../src/model-cost";
import { inSeries, isCounted, type RunFact, type SchedulingPolicy } from "../src/models";
import { resolveRouting, routingLabel, type RoutingSpec } from "../src/routing";
import type {
  DraftFetchResponse,
  DraftPriceView,
  DraftsResponse,
  DraftView,
  E90TokenProfileView,
  TokenTotals,
} from "./api-types";
import { breakdownTotal, costOf } from "./pricing";

/** The catalogue a fetch reads. */
export const CATALOGUE_URL = CATALOGUE;

/** How long a fetch waits for the whole catalogue, headers and body together. */
export const CATALOGUE_TIMEOUT_MS = 20_000;

/**
 * The most a fetch will read. The catalogue was ~1 MB for ~420 models when
 * this was written; sixteen times that is room to grow, and a bound on what a
 * misbehaving answer can make the viewer hold.
 */
export const CATALOGUE_MAX_BYTES = 16 * 1024 * 1024;

/** A fetch that could not produce a catalogue. The message is the sentence the page shows. */
export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueError";
  }
}

// ------------------------------------------------------------- the catalogue

/** The envelope. Anything else about the answer is the rows' business. */
const catalogueSchema = z.object({ data: z.array(z.unknown()) });

/**
 * One catalogue row, as much of it as a draft reads. Unknown fields are
 * dropped; a row that does not fit is skipped and counted, never a reason to
 * refuse the rest.
 */
const catalogueModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  /** Unix seconds. */
  created: z.number().optional(),
  supported_parameters: z.array(z.string()).optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
});

export interface CatalogueModel {
  id: string;
  name: string | null;
  /** Epoch ms. */
  created: number | null;
  /** `supported_parameters` names `tools`. */
  tools: boolean;
  price: DraftPriceView | null;
}

export interface CatalogueRead {
  models: CatalogueModel[];
  /** Rows that did not parse. */
  skipped: number;
}

export interface ReadCatalogueOptions {
  url?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * The list price a row quotes, per million tokens, through the price sync's
 * own reading (`priceOf`). Null for no price and for a negative one — the
 * catalogue's routers quote `-1`, meaning "depends", which is not a price.
 */
function catalogueRowPrice(pricing: Record<string, unknown> | undefined): DraftPriceView | null {
  const p = priceOf(pricing === undefined ? {} : { pricing });
  if (p === null) return null;
  if (p.input < 0 || p.output < 0 || p.cacheRead < 0 || p.cacheWrite < 0) return null;
  return { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite };
}

/** Parse a catalogue body. Exported so a fixture can be read without a fetch. */
export function parseCatalogue(text: string): CatalogueRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CatalogueError("the catalogue answered with something that is not JSON");
  }
  const envelope = catalogueSchema.safeParse(raw);
  if (!envelope.success) throw new CatalogueError("the catalogue answered without a `data` array — its shape has changed");
  const models: CatalogueModel[] = [];
  let skipped = 0;
  for (const row of envelope.data.data) {
    const parsed = catalogueModelSchema.safeParse(row);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const m = parsed.data;
    models.push({
      id: m.id,
      name: m.name ?? null,
      created: m.created === undefined ? null : m.created * 1000,
      tools: m.supported_parameters?.includes("tools") === true,
      price: catalogueRowPrice(m.pricing),
    });
  }
  return { models, skipped };
}

/** Read a body to at most `maxBytes`, refusing past it rather than truncating. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CatalogueError(`the catalogue is ${declared} bytes, over the ${maxBytes}-byte bound`);
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new CatalogueError(`the catalogue ran past the ${maxBytes}-byte bound`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One GET of the catalogue: bounded in bytes, bounded in time, and the only
 * outbound call a fetch makes. `fetcher` is injected so a test reads a fixture
 * and nothing in the suite reaches the network.
 *
 * The time bound races the whole exchange rather than trusting the abort
 * signal alone, so a fetcher that ignores the signal still gives up on time.
 */
export async function readCatalogue(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  opts: ReadCatalogueOptions = {},
): Promise<CatalogueRead> {
  const url = opts.url ?? CATALOGUE_URL;
  const timeoutMs = opts.timeoutMs ?? CATALOGUE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? CATALOGUE_MAX_BYTES;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CatalogueError(`the catalogue did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });
  const exchange = (async (): Promise<string> => {
    const res = await fetcher(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new CatalogueError(`the catalogue answered HTTP ${res.status}`);
    return await readCapped(res, maxBytes);
  })();
  try {
    return parseCatalogue(await Promise.race([exchange, timeout]));
  } catch (e) {
    if (e instanceof CatalogueError) throw e;
    throw new CatalogueError(`could not read the catalogue: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the drafts

/** A draft as stored at `proposed/<model>`. */
export interface DraftRecord {
  model: string;
  status: "draft" | "ignored";
  name: string | null;
  created: number | null;
  price: DraftPriceView | null;
  firstSeen: number;
  ignoredAt?: number;
  ignoredBy?: string;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Narrow a stored document back to a record. The store is ours, not an
 * external boundary, so this is a plain reading rather than a schema: a field
 * that does not read is absent, and a row with no model id is not a draft.
 */
export function draftRecordOf(row: Pick<ConfigRow, "key" | "value">): DraftRecord | null {
  if (!row.key.startsWith(PROPOSED_PREFIX)) return null;
  const model = row.key.slice(PROPOSED_PREFIX.length);
  if (model.length === 0) return null;
  const o = typeof row.value === "object" && row.value !== null && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
  const p = typeof o["price"] === "object" && o["price"] !== null ? (o["price"] as Record<string, unknown>) : null;
  const price =
    p !== null && finite(p["input"]) !== null && finite(p["output"]) !== null
      ? {
          input: finite(p["input"])!,
          output: finite(p["output"])!,
          cacheRead: finite(p["cacheRead"]) ?? finite(p["input"])!,
          cacheWrite: finite(p["cacheWrite"]) ?? finite(p["input"])!,
        }
      : null;
  const ignoredAt = finite(o["ignoredAt"]);
  return {
    model,
    status: o["status"] === "ignored" ? "ignored" : "draft",
    name: typeof o["name"] === "string" ? o["name"] : null,
    created: finite(o["created"]),
    price,
    firstSeen: finite(o["firstSeen"]) ?? 0,
    ...(ignoredAt !== null ? { ignoredAt } : {}),
    ...(typeof o["ignoredBy"] === "string" ? { ignoredBy: o["ignoredBy"] } : {}),
  };
}

/** The document a record is stored as. The model is the key; it rides along so a row reads on its own. */
export function draftDocument(d: DraftRecord): Record<string, unknown> {
  return {
    model: d.model,
    status: d.status,
    name: d.name,
    created: d.created,
    price: d.price,
    firstSeen: d.firstSeen,
    ...(d.ignoredAt !== undefined ? { ignoredAt: d.ignoredAt } : {}),
    ...(d.ignoredBy !== undefined ? { ignoredBy: d.ignoredBy } : {}),
  };
}

/** What a fetch writes, and what it reports. */
export interface Reconciled {
  put: DraftRecord[];
  remove: string[];
  report: DraftFetchResponse;
}

/**
 * What one catalogue read does to the drafts. Pure, so idempotence is a
 * property of this function and is tested here rather than through a store:
 *
 * - a tool-calling model that is neither in the roster nor already a draft
 *   is proposed;
 * - a pending draft has its name, date and price refreshed, and is written
 *   only when one of them moved — a second fetch of an unchanged catalogue
 *   writes nothing;
 * - an ignored model is never touched, so no fetch brings it back;
 * - a pending draft for a model the roster now runs is dropped;
 * - a draft whose row is missing from this read is left alone: a row that
 *   failed to parse is not evidence the model is gone.
 */
export function reconcileDrafts(args: {
  catalogue: CatalogueRead;
  existing: readonly DraftRecord[];
  /** Every roster entry's `model`, as written. */
  roster: ReadonlySet<string>;
  now: number;
}): Reconciled {
  const byModel = new Map(args.existing.map((d) => [d.model, d]));
  const put = new Map<string, DraftRecord>();
  const added: string[] = [];
  let refreshed = 0;
  let toolModels = 0;
  const seen = new Set<string>();
  for (const m of args.catalogue.models) {
    if (!m.tools || seen.has(m.id)) continue;
    seen.add(m.id);
    toolModels++;
    if (args.roster.has(m.id)) continue;
    const prior = byModel.get(m.id);
    if (prior === undefined) {
      put.set(m.id, { model: m.id, status: "draft", name: m.name, created: m.created, price: m.price, firstSeen: args.now });
      added.push(m.id);
      continue;
    }
    if (prior.status === "ignored") continue;
    const next: DraftRecord = { ...prior, name: m.name, created: m.created, price: m.price };
    if (JSON.stringify(draftDocument(next)) !== JSON.stringify(draftDocument(prior))) {
      put.set(m.id, next);
      refreshed++;
    }
  }
  const remove = args.existing.filter((d) => d.status === "draft" && args.roster.has(d.model)).map((d) => d.model);
  return {
    put: [...put.values()],
    remove,
    report: { toolModels, added, refreshed, removed: remove, skipped: args.catalogue.skipped },
  };
}

// -------------------------------------------------------------- the estimate

/** One run, as the profile reads it: the scheduler's fact, its harness, its tokens. */
export interface ProfileRun {
  fact: RunFact;
  harness: string | null;
  tokens: TokenTotals | null;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

/**
 * The median counted `e90`'s tokens: prompt, completion and cache reads, each
 * its own median.
 *
 * "Counted" is the scheduler's own word (`isCounted`, in this series), so the
 * profile is the evidence the ladders read. Two narrowings, both because a
 * draft would run on the wrathbench harness over OpenRouter:
 *
 * - **the wrathbench harness only** — a claude-code or codex session owns its
 *   own context and is almost all cache reads, which would price every draft
 *   as if it cached like a CLI;
 * - **provider-reported tokens only** — an estimated or snapshot count is
 *   itself a guess, and an estimate of an estimate is not one.
 *
 * Null when nothing qualifies: no profile, no estimate.
 */
export function e90TokenProfile(runs: readonly ProfileRun[], policy: SchedulingPolicy): E90TokenProfileView | null {
  const picked = runs.filter(
    (r): r is ProfileRun & { tokens: TokenTotals } =>
      r.fact.episode === "e90" &&
      isCounted(r.fact) &&
      inSeries(r.fact, policy) &&
      r.harness === "wrathbench" &&
      r.tokens !== null &&
      r.tokens.source === "reported",
  );
  if (picked.length === 0) return null;
  return {
    runs: picked.length,
    series: policy.series,
    promptTokens: median(picked.map((r) => r.tokens.promptTokens)),
    completionTokens: median(picked.map((r) => r.tokens.completionTokens)),
    // The reading `costOf` gives a missing figure: nothing read from cache.
    cacheReadTokens: median(picked.map((r) => r.tokens.cacheReadTokens ?? 0)),
  };
}

/** List price applied to the profile, through the run pages' own `costOf`. */
export function estimateUsd(price: DraftPriceView | null, profile: E90TokenProfileView | null): number | null {
  if (price === null || profile === null) return null;
  const tokens: TokenTotals = {
    source: "reported",
    contextTokens: 0,
    promptTokens: profile.promptTokens,
    completionTokens: profile.completionTokens,
    totalTokens: profile.promptTokens + profile.completionTokens,
    cacheReadTokens: profile.cacheReadTokens,
    cacheWriteTokens: null,
    turns: 0,
  };
  return breakdownTotal(
    costOf(tokens, { id: "draft", ...price, asOf: "", source: "catalogue", asIfMetered: false, note: "draft estimate" }),
  );
}

// ------------------------------------------------------------- the responses

/**
 * A roster name to start the promote form from: the slug without its author,
 * in the characters a roster name may hold (`z-ai/glm-5.3-flash:free` ->
 * `glm-5.3-flash-free`). Only a suggestion — the operator edits it, and the
 * parser is what decides.
 */
export function suggestedRosterName(model: string): string {
  const slug = model.slice(model.indexOf("/") + 1);
  const name = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return name.length > 0 ? name : "model";
}

function viewOf(d: DraftRecord, profile: E90TokenProfileView | null, policyRouting: RoutingSpec | undefined): DraftView {
  return {
    model: d.model,
    name: d.name,
    created: d.created,
    firstSeen: d.firstSeen,
    status: d.status,
    ignoredAt: d.ignoredAt ?? null,
    ignoredBy: d.ignoredBy ?? null,
    billing: billingOf({ model: d.model }),
    price: d.price,
    estimateUsd: estimateUsd(d.price, profile),
    routing: routingLabel(resolveRouting(undefined, policyRouting, d.model)),
    suggestedName: suggestedRosterName(d.model),
  };
}

/** Newest first by the catalogue's date, then by when it was proposed, then by id. */
function newestFirst(a: DraftView, b: DraftView): number {
  return (b.created ?? 0) - (a.created ?? 0) || b.firstSeen - a.firstSeen || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
}

/**
 * `GET /api/config/proposed`. A draft for a model the roster has meanwhile
 * gained (added by hand) is not listed; the next fetch drops its row.
 */
export function draftsResponse(args: {
  rows: readonly Pick<ConfigRow, "key" | "value">[];
  roster: ReadonlySet<string>;
  profile: E90TokenProfileView | null;
  policyRouting?: RoutingSpec | undefined;
}): DraftsResponse {
  const views = args.rows
    .map((r) => draftRecordOf(r))
    .filter((d): d is DraftRecord => d !== null && !args.roster.has(d.model))
    .map((d) => viewOf(d, args.profile, args.policyRouting))
    .sort(newestFirst);
  return {
    drafts: views.filter((v) => v.status === "draft"),
    ignored: views.filter((v) => v.status === "ignored"),
    profile: args.profile,
  };
}

// ------------------------------------------------------------ request bodies

/** `POST /api/config/proposed/{ignore,unignore}`. */
export const draftRefSchema = z.strictObject({ model: z.string().min(1) });

/**
 * `POST /api/config/proposed/promote`. Strict, as a roster entry is: a key the
 * promotion does not read is refused rather than dropped. The tier is
 * required — promotion never picks one — and its VALUE is the parser's to
 * judge, like the name, so a refusal is the sentence a hand edit would get.
 */
export const promoteSchema = z.strictObject({
  model: z.string().min(1),
  name: z.string().min(1),
  tier: z.string().min(1),
  race: z.number().int().optional(),
  class: z.number().int().optional(),
});

export type PromoteBody = z.infer<typeof promoteSchema>;

/** The roster entry a promotion writes: what a hand-written one would say, and nothing it would not. */
export function promotedEntry(body: PromoteBody): Record<string, unknown> {
  return {
    model: body.model,
    tier: body.tier,
    ...(body.race !== undefined ? { race: body.race } : {}),
    ...(body.class !== undefined ? { class: body.class } : {}),
  };
}

/** A Zod refusal as one line. */
export function bodyError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "body"}: ${i.message}`).join("; ");
}
