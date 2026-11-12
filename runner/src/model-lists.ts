/**
 * Retiring a roster entry its provider no longer lists, and bringing it back
 * when the provider lists it again.
 *
 * A model a provider has withdrawn answers every launch with an error, and the
 * defer ladder would spend about ten launches over eleven hours learning that
 * (docs/RUNBOOK.md, "The scheduling policy"). The provider's own model list
 * says it directly. The supervisor reads each non-local provider's list (at
 * most once per `MODEL_LIST_READ_EVERY_MS`, `infra/run-fleet-model-lists.ts`)
 * and records what it found in `fleet-model-lists.json` beside the runs; the
 * projection (`modelStates`) reads that file, and a roster entry whose model
 * every successful read since a moment at least `GONE_CONFIRM_MS` ago has left
 * out is `retired` with the reason "gone from <provider>'s model list since
 * <date>". The first read that lists it again takes the retirement away; no
 * operator clear is involved, and `bun wb fleet clear-model` does not lift it.
 *
 * What it is not:
 * - A failed read (an error, a timeout, a non-200, an empty or unparseable
 *   list, no key to read with) changes nothing: it neither confirms an absence
 *   nor resets one.
 * - It is a scheduling verdict like the ladder's: it takes the model out of
 *   the policy's picks and touches nothing else. A run in flight runs on, no
 *   row is deleted, and no run is counted or uncounted by it.
 * - Lists not read: a CLI subscription's (`claude`, `chatgpt`), whose
 *   credential reads no model list, and the self-hosted server's (`local`),
 *   whose list is whatever the operator has loaded right now.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { providerById, providerOfModel } from "./credential-slots";
import { apiKeyRefusal, DEFAULT_API_BASE } from "./providers";

/** The file beside the runs that holds the reads. */
export const MODEL_LISTS_SIDECAR = "fleet-model-lists.json";

/** How often each list is read. */
export const MODEL_LIST_READ_EVERY_MS = 6 * 3_600_000;

/**
 * How long a model must have been missing, across successful reads, before
 * it is retired: a day, so a list that drops a model for an afternoon does not
 * retire it.
 */
export const GONE_CONFIRM_MS = 24 * 3_600_000;

/** The fewest successful reads that must agree a model is missing. */
export const GONE_CONFIRM_READS = 2;

/** How long one read waits, and the most it will hold. */
export const MODEL_LIST_TIMEOUT_MS = 20_000;
export const MODEL_LIST_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The providers whose list is read, and whether the read needs the provider's
 * key. OpenRouter's and OpenCode's lists are public; Cerebras and DeepSeek
 * answer only with a key. A provider not here is never read.
 */
export const MODEL_LIST_AUTH: Readonly<Record<string, "none" | "key">> = {
  openrouter: "none",
  opencode: "none",
  "opencode-go": "none",
  cerebras: "key",
  deepseek: "key",
};

/** One list to read: the provider it belongs to and where it is. */
export interface ModelListSource {
  provider: string;
  /** The provider's name for the operator's lines (`CredentialProvider.label`). */
  label: string;
  /** The entry's base, which a key is checked against before it is sent. */
  apiBase: string;
  url: string;
  auth: "none" | "key";
}

/**
 * The list a roster entry's model is on, or null when its provider's list is
 * not read. The list is the OpenAI-compatible `<apiBase>/models`, so two
 * spellings of one gateway's base are two lists, each read on its own.
 * OpenRouter's is asked for every output modality: its default leaves out a
 * model that also outputs something other than text.
 */
export function modelListSourceOf(
  entry: { driver?: string | null | undefined; apiBase?: string | null | undefined },
  env: Record<string, string | undefined> = process.env,
): ModelListSource | null {
  const provider = providerOfModel(entry, env);
  if (provider === null) return null;
  const auth = MODEL_LIST_AUTH[provider];
  if (auth === undefined) return null;
  const apiBase = (entry.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const url = `${apiBase}/models${provider === "openrouter" ? "?output_modalities=all" : ""}`;
  return { provider, label: providerById(provider)?.label ?? provider, apiBase, url, auth };
}

// ------------------------------------------------------------------ the file

/** The newest attempt at one list. */
export interface ModelListRead {
  provider: string;
  /** When it was attempted. */
  at: number;
  ok: boolean;
  /** Ids on the list, when it was read. */
  count?: number;
  /** Why it was not, when it was not. */
  why?: string;
  /** The newest successful read of this list, kept across failures. */
  lastOkAt?: number;
}

/** A roster model a successful read left out. */
export interface ModelMissing {
  /** The first successful read that left it out. */
  since: number;
  /** The newest one. */
  last: number;
  /** How many successful reads in a row have. */
  reads: number;
}

export interface ModelListsSidecar {
  version: 1;
  /** List url -> its newest attempt. */
  reads: Record<string, ModelListRead>;
  /** List url -> model id -> how long it has been missing from that list. */
  missing: Record<string, Record<string, ModelMissing>>;
}

export function emptyModelLists(): ModelListsSidecar {
  return { version: 1, reads: {}, missing: {} };
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Read the file back. Ours, not an external boundary, so a plain reading: a
 * row that does not read is dropped, and an unreadable file is an empty one —
 * which retires nothing.
 */
export function parseModelLists(text: string): ModelListsSidecar {
  const out = emptyModelLists();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null) return out;
  const { reads, missing } = raw as { reads?: unknown; missing?: unknown };
  if (typeof reads === "object" && reads !== null) {
    for (const [url, r] of Object.entries(reads as Record<string, unknown>)) {
      if (typeof r !== "object" || r === null) continue;
      const v = r as Record<string, unknown>;
      const at = finite(v.at);
      if (typeof v.provider !== "string" || at === undefined || typeof v.ok !== "boolean") continue;
      const count = finite(v.count);
      const lastOkAt = finite(v.lastOkAt);
      out.reads[url] = {
        provider: v.provider,
        at,
        ok: v.ok,
        ...(count !== undefined ? { count } : {}),
        ...(typeof v.why === "string" ? { why: v.why } : {}),
        ...(lastOkAt !== undefined ? { lastOkAt } : {}),
      };
    }
  }
  if (typeof missing === "object" && missing !== null) {
    for (const [url, models] of Object.entries(missing as Record<string, unknown>)) {
      if (typeof models !== "object" || models === null) continue;
      const rows: Record<string, ModelMissing> = {};
      for (const [model, m] of Object.entries(models as Record<string, unknown>)) {
        if (typeof m !== "object" || m === null) continue;
        const v = m as Record<string, unknown>;
        const since = finite(v.since);
        const last = finite(v.last);
        const n = finite(v.reads);
        if (since === undefined || last === undefined || n === undefined) continue;
        rows[model] = { since, last, reads: n };
      }
      if (Object.keys(rows).length > 0) out.missing[url] = rows;
    }
  }
  return out;
}

export function serializeModelLists(s: ModelListsSidecar): string {
  return JSON.stringify({ version: 1, reads: s.reads, missing: s.missing }, null, 2) + "\n";
}

export function readModelListsSidecar(runsDir: string): ModelListsSidecar {
  const p = join(runsDir, MODEL_LISTS_SIDECAR);
  if (!existsSync(p)) return emptyModelLists();
  try {
    return parseModelLists(readFileSync(p, "utf8"));
  } catch {
    return emptyModelLists();
  }
}

/** Atomic, so a reader mid-read never sees a torn file. */
export function writeModelListsSidecar(runsDir: string, s: ModelListsSidecar): void {
  mkdirSync(runsDir, { recursive: true });
  const p = join(runsDir, MODEL_LISTS_SIDECAR);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, serializeModelLists(s));
  renameSync(tmp, p);
}

// ------------------------------------------------------------------ the rule

export type ModelListResult = { ok: true; ids: ReadonlySet<string> } | { ok: false; why: string };

/**
 * Fold one attempt at one list into the file. Pure. `models` is every roster
 * model on this list: a successful read clears each one it lists, starts or
 * extends the absence of each one it does not, and forgets an absence the
 * roster no longer has a model for. A failed read records only that it
 * failed.
 */
export function applyModelListRead(
  prev: ModelListsSidecar,
  source: Pick<ModelListSource, "provider" | "url">,
  models: readonly string[],
  result: ModelListResult,
  now: number,
): ModelListsSidecar {
  const before = prev.reads[source.url];
  const next: ModelListsSidecar = { version: 1, reads: { ...prev.reads }, missing: { ...prev.missing } };
  if (!result.ok) {
    next.reads[source.url] = {
      provider: source.provider,
      at: now,
      ok: false,
      why: result.why,
      ...(before?.lastOkAt !== undefined ? { lastOkAt: before.lastOkAt } : {}),
    };
    return next;
  }
  next.reads[source.url] = { provider: source.provider, at: now, ok: true, count: result.ids.size, lastOkAt: now };
  const was = prev.missing[source.url] ?? {};
  const rows: Record<string, ModelMissing> = {};
  for (const model of new Set(models)) {
    if (result.ids.has(model)) continue;
    const m = was[model];
    rows[model] = m === undefined ? { since: now, last: now, reads: 1 } : { since: m.since, last: now, reads: m.reads + 1 };
  }
  if (Object.keys(rows).length > 0) next.missing[source.url] = rows;
  else delete next.missing[source.url];
  return next;
}

/** A model its provider stopped listing, confirmed: which provider, and since when. */
export interface ModelGone {
  provider: string;
  /** The provider's name, for the reason. */
  label: string;
  since: number;
}

/** The retirement's reason, as `--status` and the pages show it. */
export function goneReason(g: ModelGone): string {
  return `gone from ${g.label}'s model list since ${new Date(g.since).toISOString().slice(0, 10)}`;
}

/**
 * Whether this roster entry's model is gone from its provider's list: at
 * least `GONE_CONFIRM_READS` successful reads in a row left it out, the first
 * of them at least `GONE_CONFIRM_MS` before the newest. Undefined for a model
 * still listed, not yet confirmed, or on a list that is not read.
 */
export function modelGoneOf(
  lists: ModelListsSidecar,
  entry: { model: string; driver?: string | null | undefined; apiBase?: string | null | undefined },
  env: Record<string, string | undefined> = process.env,
): ModelGone | undefined {
  const source = modelListSourceOf(entry, env);
  if (source === null) return undefined;
  const m = lists.missing[source.url]?.[entry.model];
  if (m === undefined || m.reads < GONE_CONFIRM_READS || m.last - m.since < GONE_CONFIRM_MS) return undefined;
  return { provider: source.provider, label: source.label, since: m.since };
}

// ------------------------------------------------------------------ the read

/** The envelope every OpenAI-compatible list answers with; the rows' other fields are not ours to read. */
const listSchema = z.object({ data: z.array(z.unknown()) });

/** Parse a list body into its ids. Exported so a fixture is read without a fetch. */
export function parseModelListBody(body: string): ModelListResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, why: "the list is not JSON" };
  }
  const env = listSchema.safeParse(json);
  if (!env.success) return { ok: false, why: "the list has no data array" };
  const ids = new Set<string>();
  for (const row of env.data.data) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  // A provider that answers with nothing has not withdrawn everything.
  if (ids.size === 0) return { ok: false, why: "the list is empty" };
  return { ok: true, ids };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`the list is over ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface ReadModelListOptions {
  fetcher?: typeof globalThis.fetch;
  /** The key for a list that needs one, and the NAME of the variable it came from (checked against the base). */
  key?: { env: string; value: string };
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * One GET of one list: bounded in time and bytes, and never throws. A key is
 * sent only to a list that needs one, and only where the provider table lets
 * that key go (`apiKeyRefusal`); the failure text names the variable, never
 * its value.
 */
export async function readModelList(source: ModelListSource, opts: ReadModelListOptions = {}): Promise<ModelListResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (source.auth === "key") {
    if (opts.key === undefined || opts.key.value.length === 0) return { ok: false, why: `no ${source.label} key to read the list with` };
    const refusal = apiKeyRefusal(opts.key.env, source.apiBase);
    if (refusal !== null) return { ok: false, why: refusal };
    headers.authorization = `Bearer ${opts.key.value}`;
  }
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? MODEL_LIST_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ModelListResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, why: `no answer within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
  });
  const exchange = (async (): Promise<ModelListResult> => {
    try {
      const res = await fetcher(source.url, { signal: controller.signal, headers });
      if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
      return parseModelListBody(await readCapped(res, opts.maxBytes ?? MODEL_LIST_MAX_BYTES));
    } catch (e) {
      return { ok: false, why: e instanceof Error ? e.message : String(e) };
    }
  })();
  try {
    return await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
