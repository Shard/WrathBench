/**
 * The one model adapter: OpenAI-compatible chat completions with tool calling.
 * Provider, base URL, model id and key env var are run config; there is no
 * per-model behaviour anywhere in here.
 *
 * ### Streaming and the request clock (decided by the operator, 2026-10-30)
 *
 * Every request is sent with `stream: true` (and `stream_options:
 * { include_usage: true }`, the OpenAI-compatible way to have the usage block
 * arrive in the final chunk), and the server-sent events are assembled back
 * into the body a non-streaming call returns (`StreamAssembler`), so that
 * everything past the read — the schema, the 2xx-error path, usage, the
 * request id, `raw` — sees the shapes it always saw. A provider that ignores
 * `stream` and answers with a plain JSON body is read the old way, chosen by
 * the response's content type.
 *
 * Streaming exists for the clock. A fixed 120 s timeout on the whole request
 * measured reply length, not provider health: a self-hosted reasoning model at
 * ~70 tokens/s writing 7–8k-token turns was cut on every attempt while
 * producing steadily. Two timers now bound an attempt, the same for every
 * model:
 *
 * - Silence, `SILENCE_TIMEOUT_MS` (120 s): from sending the request to the
 *   response headers, and between any two stream lines that carry data. It
 *   keeps the old number, because it is the old question — is the provider
 *   still answering — asked of each gap instead of the sum. SSE comment lines
 *   (OpenRouter's `: OPENROUTER PROCESSING`) do NOT reset it: a comment proves
 *   the proxy is alive, not that the model is producing, and an upstream that
 *   has hung behind a live aggregator would otherwise hold the request until
 *   the ceiling. The case that costs is a model whose reasoning is hidden and
 *   streams nothing but comments while it thinks: a think past 120 s dies, as
 *   it did under the whole-request timeout, so this is no worse than before.
 *   Reasoning that streams as deltas (`reasoning`, `reasoning_content`) is
 *   data and keeps the request alive. So is any other `data:` event, an empty
 *   delta included: the adapter cannot tell a heartbeat from a token by
 *   shape, and a server that sends its heartbeats as data (the self-hosted
 *   omlx server sends an empty delta every ~10 s while it queues or prefills)
 *   is bounded by the ceiling, not by the silence.
 * - Ceiling, `REQUEST_CEILING_MS` (5 minutes): one attempt, however steady,
 *   ends there, so a stream that trickles forever cannot live inside
 *   complete(). It is about twice the slowest turn the harness has had to
 *   carry (an 8k-token turn at 70 tokens/s is ~2 minutes plus prefill).
 *
 * The retry budget below gates only the START of an attempt, never one in
 * flight, so a streaming request that is making progress is not cut by it.
 * The longest one complete() can take is therefore the budget, one backoff and
 * one ceiling: 5 + 0.5 + 5 = 10.5 minutes, about half the 20-minute idle
 * watchdog of every episode tier (`episodes.ts`); the 10-minute default a
 * run gets with no tier and no override sits just under it. Nothing inside complete() is read by a
 * watchdog — the fixed loop reads them at the turn boundary, and a success
 * resets `idle` before the next read — so this bound is what keeps that
 * boundary, the place a stop or a watchdog can act, from receding.
 *
 * A timer firing, a stream that breaks mid-read, a malformed chunk, or a
 * stream that ends with neither `[DONE]` nor a `finish_reason` (a cut
 * connection that would otherwise pass for a short turn) is a failed attempt,
 * retried whole like a network error: nothing of a partial stream is kept.
 *
 * ### Retry policy (fixed, documented here and only here)
 *
 * - Retryable: network errors (a timer above included), a failed or cut
 *   stream, HTTP 408/429/5xx. Exponential backoff
 *   1s * 2^attempt with ±25% jitter, capped at 30s, max 10 attempts, all of
 *   it under a 5-minute wall-clock budget for the whole complete() — 2026-08-24:
 *   five attempts (~15s of backoff) was too impatient for provider weather
 *   that a sixth try at 30s would have ridden out, but attempts alone are the
 *   wrong unit, because ten slow attempts would spend 20+ minutes inside one
 *   complete(), where no watchdog can see it. Fast failures get every attempt;
 *   slow ones get as many as START inside the budget; either way the outcome
 *   past the budget is the pause/throw decision below, reached sooner.
 *   A `Retry-After` on the response overrides the backoff for the next
 *   attempt, clamped to the same 30s cap and jittered upward only.
 * - Attempts exhausted on failures that never produced a usable response —
 *   network errors, timers, cut streams — PAUSE (`rate-limited`), as do
 *   attempts exhausted on 5xx: the provider or the path to it is down, not the
 *   harness. With every server sending headers before the first token, a stall
 *   now lands after the headers rather than before them, so a failed read is
 *   counted with the network errors; reading it as fatal would have turned
 *   streaming into a quiet change from pause to `adapter-error`.
 * - Any 429 or 402 seen during the attempts makes the outcome a PAUSE, not a
 *   failure: a spent budget says nothing about the model, so the run is
 *   suspended and resumable. The body wording only picks which pause it is —
 *   `quota-exhausted` when it suggests credit/quota/billing (402 always),
 *   `rate-limited` otherwise. It is sticky across attempts: a 429 followed by
 *   a network timeout is still a pause.
 * - A 429 or 402 that states when its allowance comes back (`X-RateLimit-Reset`,
 *   as a response header or echoed into the error body's `metadata.headers`,
 *   which is where OpenRouter's free-tier daily limit puts it) carries that
 *   instant on the pause as `notBefore`, and the supervisor waits for it once
 *   instead of spending defer-ladder rungs on refusals it was already told
 *   about. Only a reset 10 minutes to 48 hours out is carried
 *   (`PROVIDER_RESET_FLOOR_MS`): a nearer one is a per-minute window that the
 *   retries above and the ladder's first rungs already ride out, and exempting
 *   it from the ladder would let a saturated key resume every few minutes
 *   forever; a farther one is not believed. Either way the pause falls back to
 *   the ladder.
 * - Any other 4xx is fatal immediately (`adapter-error`): the request is
 *   malformed and retrying would burn budget on a harness bug.
 *
 * The stub adapter plays a scripted response list. It exists to exercise the
 * whole runner without a model and is never used for results.
 */

import { z } from "zod";
import type { ChatMessage } from "./context";
import { hostOfBase } from "./platform";
import { isOpenRouterBase, providerBodyOf, type RoutingSpec } from "./routing";
import { apiKeyRefusal } from "./providers";
import type { ToolDef } from "./tools";

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolDef[];
  /**
   * The runner is stopping: abandon the request in flight. A request can run
   * for minutes under a slow provider, and a supervisor's stop has a grace
   * period; the loop reads `signal.aborted` before it interprets the error.
   */
  signal?: AbortSignal | undefined;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as the model produced it. */
  arguments: string;
}

/**
 * Provider-reported token usage, when the provider reports it. Optional
 * end to end: an upstream that omits `usage` changes nothing downstream.
 * Worth logging because it is the only honest measure of prompt-cache
 * effectiveness — estimates cannot see a cache hit.
 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Prompt tokens served from the provider's prompt cache, flattened from
   * `prompt_tokens_details.cached_tokens` (OpenAI-compat) or a top-level
   * `cached_tokens`. Absent when the provider reports nothing. */
  cached_tokens?: number;
  /** Prompt tokens written INTO the provider's cache, flattened from
   * `prompt_tokens_details.cache_write_tokens` (what OpenRouter sends) or a
   * top-level `cache_write_tokens`. A subset of the prompt, like the reads, and
   * priced at its own tier by `costOf`. Absent when the provider says nothing. */
  cache_write_tokens?: number;
  /** Reasoning tokens, flattened from `completion_tokens_details`. The only
   * counter that shows whether an effort level actually moved anything. */
  reasoning_tokens?: number;
  /** Provider-reported cost in credits (OpenRouter sends this when the usage
   * opt-in is on). The provider's own number, never our estimate. */
  cost?: number;
}

/**
 * The provider's own `usage` object, kept beside the normalised `TokenUsage`
 * and bounded to numbers (`toUsageRaw`). It exists for the fields the
 * normalisation has no name for — DeepSeek's `prompt_cache_hit_tokens` /
 * `prompt_cache_miss_tokens`, OpenRouter's `cost_details` — without which a
 * bill that does not match the token price cannot be reconciled after the
 * fact. Nothing reads it but a person doing that; every reader of usage keeps
 * reading the normalised block.
 */
export type RawUsage = Record<string, number | Record<string, number>>;

/** Most numeric leaves a raw usage keeps, top level and nested together. */
export const RAW_USAGE_MAX_LEAVES = 64;
/** Longest key a raw usage keeps; a longer one is dropped with its value. */
export const RAW_USAGE_MAX_KEY_LENGTH = 64;

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  /** The provider's `usage` as sent, bounded (`RawUsage`). Absent when it sent none. */
  usageRaw?: RawUsage;
  /**
   * The provider's own id for the request that produced this turn, off the
   * response headers (`x-request-id` / OpenRouter's `x-openrouter-id`) or the
   * body's top-level `id`. The only handle a provider-side support thread can
   * use. Absent when the provider identifies nothing.
   */
  providerRequestId?: string;
  /**
   * The provider's `finish_reason` for the chosen choice. "length" means the
   * provider truncated the turn — possibly mid tool-call JSON — and the turn
   * must not be scored as a model failure. Absent when not reported.
   */
  finishReason?: string;
  /**
   * Which backend served this call, and the model id it served, when the
   * endpoint names them outside the body: OpenCode does so in response
   * headers (`openCodeServedOf`). OpenRouter names them in the body instead
   * (`provider`, `model`), which the loop reads off `raw`. Record-only, like
   * those: nothing the model sees changes. Absent when the endpoint names
   * neither.
   */
  served?: { provider?: string; model?: string };
  raw?: unknown;
}

export type AdapterOutcome =
  | { kind: "ok"; turn: AssistantTurn }
  | {
      kind: "pause";
      reason: "quota-exhausted" | "rate-limited";
      detail: string;
      /** The provider's own stated reset (`statedResetOf`), already inside the carried window. */
      notBefore?: number;
    }
  | { kind: "stub-complete" };

export class AdapterError extends Error {
  override readonly name = "AdapterError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ChatAdapter {
  readonly label: string;
  complete(req: ChatRequest): Promise<AdapterOutcome>;
}

// ------------------------------------------------------------------ openai

const completionSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.looseObject({
                id: z.string(),
                function: z.looseObject({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
        // "length" means the provider truncated the turn — possibly mid
        // tool-call JSON. Without it a truncation is indistinguishable from a
        // clean stop and gets scored as a model failure (2026-08-22 review).
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  // Loose + all-optional: providers vary in which counters they send, and one
  // that sends none must still parse.
  usage: z
    .looseObject({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
      cached_tokens: z.number().nullish(),
      cache_write_tokens: z.number().nullish(),
      cost: z.number().nullish(),
      prompt_tokens_details: z
        .looseObject({ cached_tokens: z.number().nullish(), cache_write_tokens: z.number().nullish() })
        .nullish(),
      completion_tokens_details: z.looseObject({ reasoning_tokens: z.number().nullish() }).nullish(),
    })
    .nullish(),
});

/** Drop null/absent counters so an omitted field never logs as `null`. */
function toUsage(u: z.infer<typeof completionSchema>["usage"]): TokenUsage | undefined {
  if (u === undefined || u === null) return undefined;
  const usage: TokenUsage = {};
  if (typeof u.prompt_tokens === "number") usage.prompt_tokens = u.prompt_tokens;
  if (typeof u.completion_tokens === "number") usage.completion_tokens = u.completion_tokens;
  if (typeof u.total_tokens === "number") usage.total_tokens = u.total_tokens;
  const cached = typeof u.cached_tokens === "number" ? u.cached_tokens : u.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.cached_tokens = cached;
  // Cache WRITES. OpenRouter sends these nested under `prompt_tokens_details`,
  // never at the top level, so reading only the flat key found nothing and the
  // viewer's `expected` priced every write at zero (follow-up 59). Models that
  // quote a write tier — gpt-5.6-luna at 1.25x input, gemini-3.7-flash at a
  // storage-only rate — were the ones it got wrong.
  const written =
    typeof u.cache_write_tokens === "number" ? u.cache_write_tokens : u.prompt_tokens_details?.cache_write_tokens;
  if (typeof written === "number") usage.cache_write_tokens = written;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number") usage.reasoning_tokens = reasoning;
  // The provider's own charge for this call, in credits (OpenRouter credits are
  // dollars). It is the only figure in the run that is a bill rather than a
  // reconstruction, so it must survive the trip into the trajectory: the viewer
  // reads it as the run's *actual* cost, against which the price table is only
  // an estimate. Both this and `reasoning_tokens` were parsed and then dropped
  // here until 2026-08-23, which is why no run before then carries either.
  if (typeof u.cost === "number") usage.cost = u.cost;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/**
 * The provider's `usage` as sent, bounded so that a malformed or hostile body
 * cannot bloat a record: finite numbers only (no strings, booleans, nulls or
 * arrays), one level of nested objects (`prompt_tokens_details`,
 * `completion_tokens_details`, `cost_details`, …) and nothing below it, no key
 * longer than `RAW_USAGE_MAX_KEY_LENGTH`, and at most `RAW_USAGE_MAX_LEAVES`
 * numbers in document order. A nested object left empty is dropped, and so is
 * the whole thing: absent, never `{}`. The same rule for every provider.
 */
function toUsageRaw(u: z.infer<typeof completionSchema>["usage"]): RawUsage | undefined {
  if (u === undefined || u === null) return undefined;
  let left = RAW_USAGE_MAX_LEAVES;
  const keep = (k: string): boolean => k.length > 0 && k.length <= RAW_USAGE_MAX_KEY_LENGTH;
  const leaf = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const top: [string, number | Record<string, number>][] = [];
  for (const [k, v] of Object.entries(u)) {
    if (left === 0) break;
    if (!keep(k)) continue;
    if (leaf(v)) {
      top.push([k, v]);
      left--;
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const nested: [string, number][] = [];
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        if (left === 0) break;
        if (!keep(nk) || !leaf(nv)) continue;
        nested.push([nk, nv]);
        left--;
      }
      if (nested.length > 0) top.push([k, Object.fromEntries(nested)]);
    }
  }
  return top.length === 0 ? undefined : Object.fromEntries(top);
}

export interface OpenAiAdapterOptions {
  baseUrl: string;
  apiKey: string;
  /**
   * The env var `apiKey` was read from. When given, the adapter refuses to be
   * built unless the provider table allows that key towards `baseUrl`
   * (runner/src/providers.ts) — the last check before the key is attached to
   * a request. `run.ts` always passes it; a test that builds the adapter
   * around a fake key and a fake host leaves it out.
   */
  apiKeyEnv?: string;
  model: string;
  /**
   * Reasoning effort, sent as `reasoning_effort`. Omitted when absent.
   *
   * Every level goes through unchanged, `none` (thinking off) included: some
   * OpenRouter models accept it, others reject it, which is true of `xhigh` and
   * `max` too and is the operator's problem, not the adapter's.
   */
  effort?: string;
  /**
   * Which backend may serve this run (`routing.ts`), already resolved — the
   * adapter states it, it does not decide it. Sent as OpenRouter's
   * request-level `provider` object and only to an OpenRouter base, the same
   * gate and the same reason as the `usage` opt-in below: a strict
   * OpenAI-compatible server may 400 on a key it does not know.
   *
   * Absent is not "unrouted by choice" — it is a run whose base does not speak
   * this, and the comparability tuple omits the field for exactly those.
   */
  routing?: RoutingSpec;
  /**
   * The conversation this adapter serves, stable for its whole life: the run
   * id. Sent only to OpenCode (`OPENCODE_SESSION_HEADER`); every other host
   * gets nothing from it.
   */
  sessionId?: string;
  maxAttempts?: number;
  /** Longest an attempt may go without data (`SILENCE_TIMEOUT_MS`). */
  silenceTimeoutMs?: number;
  /** Longest one attempt may take however steady (`REQUEST_CEILING_MS`). */
  requestCeilingMs?: number;
  /** Wall-clock ceiling for one complete()'s retries (see the retry policy). */
  retryBudgetMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for the retry budget, the way Trajectory does it. */
  now?: () => number;
  /** Attribution referer override. Falls back to env, then to APP_URL. */
  appUrl?: string;
  /** Injectable for tests, the way version.ts does it. */
  env?: Record<string, string | undefined>;
}

/**
 * Attribution only — never fetched, never used for auth or routing. OpenRouter
 * groups requests into an "app" by the `HTTP-Referer` header and labels it with
 * `X-Title`; without them the harness shows up on openrouter.ai as "unknown".
 * The repository is the identity this project owns long-term — private for now,
 * which is fine: nothing dereferences it. Override per-run with
 * `WRATHBENCH_APP_URL`.
 */
export const APP_URL = "https://github.com/Shard/WrathBench";
export const APP_TITLE = "WrathBench";
/**
 * The outbound identity, and deliberately no version with it. A hand-written
 * `wrathbench/0.2` sat here while the harness moved to the 0.5 series, so what
 * we told every provider was simply false and nothing caught it; the fix that
 * cannot go stale is to say only who we are. A bare product token is a
 * well-formed User-Agent (RFC 9110 makes the `/version` half optional), and it
 * is the same name `X-Title` already carries, so it reuses that constant
 * rather than repeating the string. The exact harness version belongs in the
 * trajectory (`harnessVersion()`), which is where it is recorded — a provider
 * has no use for it, and a per-request `git describe` was never a trade worth
 * making anyway.
 */
export const USER_AGENT = APP_TITLE;

/**
 * OpenCode's session header. Go's docs admit coding agents other than its own
 * client on three conditions: typical coding-agent traffic, a user agent of
 * the agent's own (`USER_AGENT` already is one), and "a stable session ID in
 * x-opencode-session for each conversation so we can optimize routing and
 * prompt caching". This is the third, and it is all we send: the headers that
 * identify OpenCode's own client (`x-opencode-client` and its siblings) are
 * never sent, because claiming to be a client we are not is the spoofing this
 * harness does not do.
 *
 * Host-gated on `opencode.ai` exactly (`hostOfBase`), both of its gateways,
 * since a strict endpoint elsewhere has no use for it.
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * The session header for this base, or nothing. A value that is not plain
 * printable ASCII is dropped rather than sent: `fetch` throws building such a
 * header, and this adapter would read the throw as a network error and retry
 * it as an outage.
 */
export function openCodeSessionHeaders(baseUrl: string, sessionId: string | undefined): Record<string, string> {
  if (hostOfBase(baseUrl) !== "opencode.ai") return {};
  if (sessionId === undefined || !/^[\x21-\x7e]+$/.test(sessionId)) return {};
  return { [OPENCODE_SESSION_HEADER]: sessionId };
}

/**
 * The response headers in which OpenCode names the upstream that served a
 * call: the endpoint it routed to (`openrouter-xiaomi`,
 * `orcarouter-dsv4.1flash`, …) and that upstream's own model id
 * (`xiaomi/mimo-v2.5`). Go picks the backend itself, so these are the only
 * record of which machine answered.
 */
export const OPENCODE_SERVED_HEADERS = {
  provider: "x-opencode-endpoint-id",
  model: "x-opencode-upstream-model-id",
} as const;

/** Longest header value kept as a served provider or model; a longer one is dropped. */
const SERVED_HEADER_MAX = 200;

/**
 * What an OpenCode response's headers say served it, or undefined for any
 * other host or a response that names neither. Host-gated like the session
 * header, and each value is kept only when it is plain printable text of a
 * sane length, so a malformed header records nothing rather than garbage.
 */
export function openCodeServedOf(baseUrl: string, headers: Headers): { provider?: string; model?: string } | undefined {
  if (hostOfBase(baseUrl) !== "opencode.ai") return undefined;
  const read = (name: string): string | undefined => {
    const v = headers.get(name)?.trim();
    return v !== undefined && v.length > 0 && v.length <= SERVED_HEADER_MAX && /^[\x20-\x7e]+$/.test(v) ? v : undefined;
  };
  const provider = read(OPENCODE_SERVED_HEADERS.provider);
  const model = read(OPENCODE_SERVED_HEADERS.model);
  if (provider === undefined && model === undefined) return undefined;
  return { ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}) };
}

/** `Retry-After`: integer seconds or an HTTP-date. Anything else is ignored. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** The nearest stated reset a pause carries; see the retry policy above. */
export const PROVIDER_RESET_FLOOR_MS = 10 * 60_000;
/** The farthest stated reset a pause carries. */
export const PROVIDER_RESET_CEILING_MS = 48 * 60 * 60_000;

/**
 * An `X-RateLimit-Reset` value as an epoch instant in milliseconds. OpenRouter
 * sends milliseconds; a value below 1e12 is read as epoch seconds, so a
 * delta-seconds value ("60") lands in 1970 and is dropped by the window check
 * rather than misread.
 */
function resetInstant(value: unknown): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1_000 : n;
}

/**
 * The instant a refused allowance resets, as the provider stated it: the
 * `X-RateLimit-Reset` echoed into the error body's `metadata.headers` first —
 * it describes the limit that actually refused — then the response header.
 * Null when neither states one. Unvalidated: the caller decides whether the
 * instant is inside the window a pause carries.
 */
export function statedResetOf(headers: Headers, body: unknown): number | null {
  const echoed = (body as { error?: { metadata?: { headers?: unknown } } } | null)?.error?.metadata?.headers;
  if (echoed !== null && typeof echoed === "object") {
    for (const [k, v] of Object.entries(echoed)) {
      if (k.toLowerCase() !== "x-ratelimit-reset") continue;
      const at = resetInstant(v);
      if (at !== null) return at;
    }
  }
  return resetInstant(headers.get("x-ratelimit-reset"));
}

/** A body as JSON, or null: a refusal's body is often plain text ("slow down"). */
function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The provider's request id, for a provider-side support thread. Deliberately
 * NOT `cf-ray`: OpenRouter is Cloudflare-fronted, so a ray is present on
 * essentially every response and would shadow the body's `gen-…` id — which is
 * the only one OpenRouter's own generation lookup accepts. A CDN ray identifies
 * a proxy hop, not a generation, and cannot be asked about.
 */
function requestIdOf(res: Response): string | undefined {
  for (const h of ["x-request-id", "x-openrouter-id", "openai-request-id"]) {
    const v = res.headers.get(h);
    if (v !== null && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

// `GoUsageLimitError` is OpenCode Go's spent allowance (a 429): an exhausted
// subscription window, not a passing rate limit, so it is `quota-exhausted`
// and waits for the window's reset (`opencode-go.ts`; operator, 2026-10-16).
// The pi driver reads a 429's words with the same test (`detectPiFailure`).
export const EXHAUSTION_HINTS = /quota|credit|billing|insufficient|exceeded.*limit|payment|GoUsageLimitError/i;
// Rate-limit wording that a provider may send with a 2xx body and a string code
// ("rate_limit_exceeded", "Rate limit exceeded") instead of a numeric 429. Kept
// separate from EXHAUSTION_HINTS so it reads as rate-limited, not quota-spent,
// and so the HTTP-429 path's quota-vs-rate decision is unaffected.
const RATE_LIMIT_HINTS = /rate.?limit|too many requests/i;
// Transient upstream-provider failures that aggregators wrap in 4xx bodies:
// OpenRouter's 404 "Provider returned error" (with provider_name metadata)
// mid-episode, OpenCode Zen's 400 type:"server_error" "Upstream request
// failed: Model is unavailable". Pool weather, not a harness bug — these
// retry, and if they persist, pause as rate-limited so the roster defers and
// comes back later instead of terminating a healthy episode (fleet-free-or-a
// lost a 60-turn nemotron episode to a single such 404, 2026-08-22).
// Deliberately does NOT match "No endpoints found": a bad model slug must
// still fail fast as an AdapterError.
const PROVIDER_BLIP_HINTS =
  /provider returned error|upstream request failed|model is unavailable|provider_name|"server_error"|no instances available/i;
// A slug the provider has withdrawn is a bad model id too, whatever else its
// body says: OpenRouter answers a retired `:free` slug with 404 "This model is
// unavailable for free. The paid version is available now - use this slug
// instead: …", which `model is unavailable` would otherwise read as pool
// weather, so the run paused rate-limited and climbed the defer ladder until
// it ran out of rungs, blaming rate limiting all the way.
const WITHDRAWN_SLUG_HINTS = /unavailable for free|use this slug instead/i;
// A refusal that names one of our messages as the bad parameter is about the
// request we built, whatever wrapper it arrives in: OpenCode Go relays an
// upstream 400 as type "server_error", "Upstream request failed: [400] Param
// Incorrect", with `"param":"messages[32] assistant must provide content,
// reasoning_content or tool_calls"`. The blip hints read that as pool weather,
// so the run retried the same bytes, paused rate-limited and was spent as a
// failed attempt on a harness bug. It is the "any other 4xx" of the policy
// above: fatal at once, as an adapter-error.
const REQUEST_SHAPE_HINTS = /"param"\s*:\s*"messages\[/i;

/** A transient upstream failure wrapped in a 4xx body, and neither a withdrawn slug nor a refusal of our request's shape. */
function isProviderBlip(text: string): boolean {
  return PROVIDER_BLIP_HINTS.test(text) && !WITHDRAWN_SLUG_HINTS.test(text) && !REQUEST_SHAPE_HINTS.test(text);
}

/** See "Streaming and the request clock" above. */
export const SILENCE_TIMEOUT_MS = 120_000;
/** See "Streaming and the request clock" above. */
export const REQUEST_CEILING_MS = 300_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** One tool call as its deltas have built it so far. */
interface ToolCallParts {
  index: number | undefined;
  id: string | undefined;
  type: string | undefined;
  name: string;
  arguments: string;
}

/**
 * A chat-completions event stream folded back into the body the same request
 * would have returned without `stream`: `choices[0].message` with `content`,
 * `tool_calls` and any streamed reasoning text, `finish_reason`, `usage`, and
 * the top-level fields (`id`, `model`, OpenRouter's `provider`, …) the chunks
 * carry. Only choice 0 is kept, the one the adapter reads.
 *
 * Fed one line at a time, without its terminator (`line`), so the reader can
 * tell data from keep-alive comments as it goes; `finish` closes it. Pure: no
 * clock, no I/O.
 */
export class StreamAssembler {
  private data: string[] = [];
  private readonly top: Json = {};
  private sawChoice = false;
  private role: string | undefined;
  private readonly content: string[] = [];
  private readonly reasoning = new Map<string, string[]>();
  private readonly toolCalls: ToolCallParts[] = [];
  private finishReason: string | null = null;
  private usage: Json | undefined;
  private error: unknown;
  private malformed = false;
  /** `[DONE]` arrived, or an error chunk did: nothing after it is read. */
  done = false;

  /** Folds one stream line in; true when it carried data rather than a comment or an event boundary. */
  line(text: string): boolean {
    if (text === "") {
      this.dispatch();
      return false;
    }
    if (text.startsWith(":")) return false;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    return true;
  }

  /**
   * The assembled body, and whether the stream finished: `[DONE]`, a
   * `finish_reason` or an error chunk arrived, and no chunk was malformed. An
   * unfinished stream is a cut connection, not a short turn.
   */
  finish(): { body: unknown; finished: boolean } {
    this.dispatch();
    const finished = !this.malformed && (this.done || this.finishReason !== null || this.error !== undefined);
    if (this.error !== undefined) return { body: { ...this.top, error: this.error }, finished };
    if (!this.sawChoice) {
      // No choice at all: the non-streaming equivalent is an empty `choices`,
      // which the schema refuses, so it is refused the same way here.
      return { body: { ...this.top, choices: [], ...(this.usage !== undefined ? { usage: this.usage } : {}) }, finished };
    }
    // No text is `null`, as a non-streaming body spells it: OpenRouter opens
    // every stream with `content: ""`, and an empty string where the whole
    // body said null would change the replayed message and its record.
    const text = this.content.join("");
    const message: Json = { role: this.role ?? "assistant", content: text.length > 0 ? text : null };
    for (const [k, parts] of this.reasoning) message[k] = parts.join("");
    if (this.toolCalls.length > 0) {
      message["tool_calls"] = this.toolCalls.map((tc) => ({
        ...(tc.id !== undefined ? { id: tc.id } : {}),
        type: tc.type ?? "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return {
      body: {
        ...this.top,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: this.finishReason }],
        ...(this.usage !== undefined ? { usage: this.usage } : {}),
      },
      finished,
    };
  }

  private dispatch(): void {
    if (this.data.length === 0) return;
    const payload = this.data.join("\n");
    this.data = [];
    if (this.done) return;
    if (payload.trim() === "[DONE]") {
      this.done = true;
      return;
    }
    const chunk = jsonOrNull(payload);
    if (!isObject(chunk)) {
      this.malformed = true;
      return;
    }
    for (const [k, v] of Object.entries(chunk)) {
      if (k === "choices" || k === "usage" || k === "error" || k === "object") continue;
      if (!(k in this.top) && v !== null && v !== undefined) this.top[k] = v;
    }
    // Mid-stream errors arrive as a chunk after the 200 (OpenRouter does
    // this): the body becomes the error object, read like a 2xx error body.
    if (chunk["error"] !== undefined && chunk["error"] !== null) {
      this.error = chunk["error"];
      this.done = true;
      return;
    }
    // `include_usage` sends it once, on a final chunk with no choices; a
    // provider that repeats it cumulatively ends on the total either way.
    if (isObject(chunk["usage"])) this.usage = chunk["usage"];
    const choices = chunk["choices"];
    if (!Array.isArray(choices)) return;
    for (const c of choices) {
      if (!isObject(c)) continue;
      if ((typeof c["index"] === "number" ? c["index"] : 0) !== 0) continue;
      this.sawChoice = true;
      if (typeof c["finish_reason"] === "string") this.finishReason = c["finish_reason"];
      const delta = c["delta"];
      if (!isObject(delta)) continue;
      if (typeof delta["role"] === "string") this.role = delta["role"];
      if (typeof delta["content"] === "string") this.content.push(delta["content"]);
      for (const k of ["reasoning", "reasoning_content"]) {
        const piece = delta[k];
        if (typeof piece !== "string") continue;
        const parts = this.reasoning.get(k) ?? [];
        parts.push(piece);
        this.reasoning.set(k, parts);
      }
      if (Array.isArray(delta["tool_calls"])) this.toolCallDeltas(delta["tool_calls"]);
    }
  }

  /**
   * Tool-call deltas, matched to their call by `index`. `id` and `type` are
   * taken once; `function.name` and `function.arguments` are appended — except
   * a name repeated whole on every delta, which some servers send. A delta
   * without an index (servers that send each call complete) is matched by its
   * id, or opens a new call when the id is new.
   */
  private toolCallDeltas(deltas: unknown[]): void {
    for (const d of deltas) {
      if (!isObject(d)) continue;
      const index = typeof d["index"] === "number" ? d["index"] : undefined;
      const id = typeof d["id"] === "string" && d["id"].length > 0 ? d["id"] : undefined;
      let tc =
        index !== undefined
          ? this.toolCalls.find((t) => t.index === index)
          : id !== undefined
            ? this.toolCalls.find((t) => t.id === id)
            : this.toolCalls.at(-1);
      if (tc === undefined) {
        tc = { index, id: undefined, type: undefined, name: "", arguments: "" };
        this.toolCalls.push(tc);
      }
      if (tc.id === undefined && id !== undefined) tc.id = id;
      if (tc.type === undefined && typeof d["type"] === "string") tc.type = d["type"];
      const fn = d["function"];
      if (!isObject(fn)) continue;
      const name = fn["name"];
      if (typeof name === "string" && name.length > 0 && name !== tc.name) tc.name += name;
      if (typeof fn["arguments"] === "string") tc.arguments += fn["arguments"];
    }
  }
}

/** An attempt ended by its own clock (silence or ceiling), not by the network or the runner. */
class AttemptTimeout extends Error {
  override readonly name = "AttemptTimeout";
}

/**
 * One attempt's two timers (see "Streaming and the request clock") over an
 * AbortController, joined with the runner's stop signal. `touch` is called on
 * every sign of data and restarts the silence timer.
 */
class AttemptClock {
  private readonly ctl = new AbortController();
  readonly signal: AbortSignal;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private readonly ceiling: ReturnType<typeof setTimeout>;

  constructor(
    private readonly silenceMs: number,
    ceilingMs: number,
    stop: AbortSignal | undefined,
  ) {
    this.signal = stop !== undefined ? AbortSignal.any([this.ctl.signal, stop]) : this.ctl.signal;
    this.ceiling = setTimeout(
      () => this.ctl.abort(new AttemptTimeout(`the request passed its ${ceilingMs / 1000} s ceiling`)),
      ceilingMs,
    );
    this.touch();
  }

  touch(): void {
    clearTimeout(this.silence);
    this.silence = setTimeout(
      () => this.ctl.abort(new AttemptTimeout(`no data from the model API for ${this.silenceMs / 1000} s`)),
      this.silenceMs,
    );
  }

  /** What ended the attempt: the timer that fired, or the error itself. */
  why(err: unknown): string {
    const reason: unknown = this.ctl.signal.aborted ? this.ctl.signal.reason : err;
    return reason instanceof Error ? reason.message : String(reason);
  }

  stop(): void {
    clearTimeout(this.silence);
    clearTimeout(this.ceiling);
  }
}

/** What a response's body read produced. */
type BodyRead = { kind: "text"; text: string } | { kind: "stream"; body: unknown; finished: boolean };

/**
 * Reads a response body under the attempt's clock. A 2xx `text/event-stream`
 * is assembled as it arrives, and only lines that carry data reset the
 * silence timer; any other body is read as text, every chunk counting. Each
 * read is raced against the clock and the reader cancelled when it fires,
 * rather than trusting the body to notice the aborted fetch signal.
 */
/** A whole event stream as text, assembled: the tests' entry, and the fallback for a stream served under another content type. */
export function assembleStream(text: string): { body: unknown; finished: boolean } {
  const a = new StreamAssembler();
  for (const l of text.split(/\r\n|\r|\n/)) {
    a.line(l);
    if (a.done) break;
  }
  return a.finish();
}

async function readBody(res: Response, clock: AttemptClock): Promise<BodyRead> {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const sse = res.ok && type.startsWith("text/event-stream");
  if (res.body === null) return sse ? { kind: "stream", ...new StreamAssembler().finish() } : { kind: "text", text: "" };
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    if (clock.signal.aborted) reject(clock.signal.reason as Error);
    clock.signal.addEventListener("abort", () => reject(clock.signal.reason as Error), { once: true });
  });
  aborted.catch(() => {});
  const decoder = new TextDecoder();
  const assembler = sse ? new StreamAssembler() : null;
  const text: string[] = [];
  let pending = "";
  const lines = (chunk: string, last: boolean): void => {
    pending += chunk;
    // A trailing CR may be the first half of a CRLF split across reads.
    const cut = last ? pending.length : pending.endsWith("\r") ? pending.length - 1 : pending.length;
    const parts = pending.slice(0, cut).split(/\r\n|\r|\n/);
    pending = (last ? "" : parts.pop() ?? "") + pending.slice(cut);
    for (const l of parts) {
      if (assembler!.line(l)) clock.touch();
      if (assembler!.done) return;
    }
  };
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), aborted]);
      if (r.done) break;
      if (r.value.byteLength === 0) continue;
      const chunk = decoder.decode(r.value, { stream: true });
      if (assembler === null) {
        clock.touch();
        text.push(chunk);
        continue;
      }
      lines(chunk, false);
      if (assembler.done) break;
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }
  const tail = decoder.decode();
  if (assembler === null) return { kind: "text", text: text.join("") + tail };
  if (assembler.done) void reader.cancel().catch(() => {});
  else lines(tail, true);
  return { kind: "stream", ...assembler.finish() };
}

export class OpenAiChatAdapter implements ChatAdapter {
  readonly label: string;
  private readonly maxAttempts: number;
  private readonly silenceTimeoutMs: number;
  private readonly requestCeilingMs: number;
  private readonly retryBudgetMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Built once: nothing in here varies per request. */
  private readonly headers: Record<string, string>;

  constructor(private readonly opts: OpenAiAdapterOptions) {
    this.label = `openai-compatible:${opts.model}`;
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
    this.requestCeilingMs = opts.requestCeilingMs ?? REQUEST_CEILING_MS;
    this.retryBudgetMs = opts.retryBudgetMs ?? 300_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    const env = opts.env ?? process.env;
    if (opts.apiKeyEnv !== undefined) {
      const refusal = apiKeyRefusal(opts.apiKeyEnv, opts.baseUrl, env);
      if (refusal !== null) throw new Error(`refusing to send the key: ${refusal}`);
    }
    const fromEnv = env["WRATHBENCH_APP_URL"];
    const configured = opts.appUrl ?? fromEnv;
    // A stray newline or control character in the env var would make `fetch`
    // throw while building headers, which this adapter's catch would read as a
    // network error and retry five times — an operator typo presenting as a
    // phantom outage. Anything unusable falls back to the placeholder.
    const appUrl =
      configured !== undefined && /^[\x21-\x7e]+$/.test(configured.trim()) ? configured.trim() : APP_URL;
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      // Sent unconditionally: OpenRouter attributes the app by these two, and
      // every other OpenAI-compatible endpoint ignores them. `HTTP-Referer` is
      // OpenRouter's own (misspelt) header name — not the standard `Referer`,
      // and it must not be normalised to it.
      "HTTP-Referer": appUrl,
      "X-Title": APP_TITLE,
      "user-agent": USER_AGENT,
      ...openCodeSessionHeaders(opts.baseUrl, opts.sessionId),
    };
  }

  async complete(req: ChatRequest): Promise<AdapterOutcome> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = JSON.stringify({
      model: this.opts.model,
      messages: req.messages,
      tools: req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      // Streamed for the request clock (see the header), and assembled back
      // into the non-streaming body. `include_usage` is the OpenAI-compatible
      // way to keep `usage`: without it a stream carries none.
      stream: true,
      stream_options: { include_usage: true },
      // Only present when the run declares an effort level. Unlike the usage
      // opt-in below this is NOT host-gated: effort is a run dimension the
      // operator asked for by name, and silently dropping it on a non-OpenRouter
      // endpoint would put a run in the matrix under a level it never used.
      // Sent in the OpenAI-compatible spelling, which OpenRouter honours — the
      // same prompt at low/high moved reasoning_tokens 216/310 on a model whose
      // OpenRouter metadata lists `reasoning_effort`. A provider that rejects
      // the field fails loudly on the first request, which is the right way for
      // a mis-declared matrix cell to end.
      ...(this.opts.effort !== undefined ? { reasoning_effort: this.opts.effort } : {}),
      // OpenRouter-only accounting opt-in: returns cache and cost detail in
      // `usage`. Observability, not behavior — but gated to the one host that
      // documents it, since a strict OpenAI-compat server may 400 on unknowns.
      ...(isOpenRouterBase(this.opts.baseUrl) ? { usage: { include: true } } : {}),
      // Which backend may serve this (operator decision 2026-09-16, see
      // `routing.ts`). Host-gated like the usage opt-in: an aggregator is the
      // only thing with a choice to make, and a direct endpoint would 400 on
      // the key. With `allow_fallbacks: false` a request that cannot be served
      // by a named provider FAILS rather than moving to another machine, which
      // is the point — a silent move is a different measurement wearing the
      // same row.
      ...(this.opts.routing !== undefined && isOpenRouterBase(this.opts.baseUrl)
        ? { provider: providerBodyOf(this.opts.routing) }
        : {}),
    });

    let lastError = "";
    let lastStatus: number | undefined;
    /** Newest provider request id seen; threaded into every failure message. */
    let lastRequestId: string | undefined;
    // Sticky across attempts, deliberately: a 429 followed by a retry that dies
    // of a network timeout used to clear `lastStatus` and turn a budget pause
    // into a terminal adapter-error (observed on run-real-smoke-1). What the
    // provider said once about the budget outlives one flaky socket.
    let budget: { reason: "quota-exhausted" | "rate-limited"; detail: string } | null = null;
    // Set from a `Retry-After` on the response that is about to be retried, and
    // consumed by the next iteration's sleep — the sleep happens at the top of
    // the loop, so honouring the header means carrying it across one iteration.
    let retryAfterMs: number | null = null;
    // The newest reset instant a budget-shaped refusal stated; sticky like
    // `budget`, and checked against the carried window only at the pause.
    let statedReset: number | null = null;
    const retriesStartedAt = this.now();
    let made = 0;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (req.signal?.aborted === true) throw new AdapterError("request abandoned: the runner is stopping");
      // The wall-clock budget (see the retry policy above): attempts are the
      // wrong unit when each one can spend a ceiling on the wire. It gates the
      // start of an attempt only: one in flight runs to its own clock.
      if (attempt > 0 && this.now() - retriesStartedAt >= this.retryBudgetMs) break;
      made = attempt + 1;
      if (attempt > 0) {
        const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
        // Jitter is subtractive on the computed backoff but NOT on a
        // server-stated delay: retrying before the time the provider named is
        // the one thing Retry-After exists to prevent, so it only ever waits
        // longer. And it is clamped to the same 30s cap the backoff uses: a
        // `Retry-After: 3600` would park the whole harness inside one
        // complete(), where no watchdog can see it, and trade a resumable
        // `rate-limited` pause for an invisible hour-long hang.
        const wait =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, 30_000) + Math.floor(Math.random() * 250)
            : base + Math.floor(base * (Math.random() * 0.5 - 0.25));
        retryAfterMs = null;
        await this.sleep(wait);
      }
      // Both timers start before the request is sent: the silence one covers
      // the wait for the response headers too (see the request clock above).
      const clock = new AttemptClock(this.silenceTimeoutMs, this.requestCeilingMs, req.signal);
      let res: Response;
      let read: BodyRead;
      try {
        try {
          res = await this.fetchImpl(url, {
            method: "POST",
            headers: this.headers,
            body,
            // Never followed. A followed redirect re-sends the request — the
            // bearer included — to wherever the Location says, which is exactly
            // the host check (runner/src/providers.ts) the key was cleared by
            // being skipped. A provider that redirects is refused below.
            redirect: "manual",
            signal: clock.signal,
          });
        } catch (err) {
          if (req.signal !== undefined && req.signal.aborted) throw new AdapterError("request abandoned: the runner is stopping");
          lastError = `network error: ${clock.why(err)}`;
          lastStatus = undefined;
          continue;
        }
        if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
          // Terminal, not retried: the base is wrong (a scheme or path the
          // provider moves), and no number of attempts makes it right.
          throw new AdapterError(
            `model API answered with a redirect (HTTP ${res.status}) — not followed, so the key is never re-sent to another URL; fix the apiBase`,
          );
        }
        const headerId = requestIdOf(res);
        if (headerId !== undefined) lastRequestId = headerId;
        try {
          // Under the same clock: a provider that returns headers and then
          // stalls times out HERE, and that is as retryable as the fetch
          // itself failing.
          read = await readBody(res, clock);
        } catch (err) {
          if (req.signal !== undefined && req.signal.aborted) throw new AdapterError("request abandoned: the runner is stopping");
          lastError = `body read failed: ${clock.why(err)}${headerId !== undefined ? ` [req ${headerId}]` : ""}`;
          lastStatus = undefined;
          continue;
        }
      } finally {
        clock.stop();
      }
      const requestId = requestIdOf(res);
      // A body served as text that is an event stream all the same (a server
      // that streams under the wrong content type) is assembled like one.
      if (res.ok && read.kind === "text" && /^\s*data:/.test(read.text)) {
        read = { kind: "stream", ...assembleStream(read.text) };
      }
      if (res.ok && read.kind === "stream" && !read.finished) {
        // A cut connection: retried whole, like any failed read.
        lastError = `body read failed: the stream ended before the model finished${
          requestId !== undefined ? ` [req ${requestId}]` : ""
        }`;
        lastStatus = undefined;
        continue;
      }
      const text = read.kind === "text" ? read.text : "";
      if (res.ok) {
        let json: unknown;
        if (read.kind === "stream") json = read.body;
        else {
          try {
            json = JSON.parse(text);
          } catch {
            throw new AdapterError(
              `model API returned 2xx with a non-JSON body${requestId !== undefined ? ` [req ${requestId}]` : ""}`,
            );
          }
        }
        const parsed = completionSchema.safeParse(json);
        if (!parsed.success) {
          // Free-tier providers return 200 with an error object and no
          // `choices` (observed: OpenRouter upstream, night-nemotron-1, which
          // this used to terminate as adapter-error). Read it like the
          // HTTP-status path: budget-shaped errors pause, the rest retry.
          const errObj = (json as { error?: unknown }).error;
          if (errObj !== undefined && errObj !== null) {
            lastError = `provider error in 2xx body${
              requestId !== undefined ? ` [req ${requestId}]` : ""
            }: ${JSON.stringify(errObj).slice(0, 500)}`;
            const code = (errObj as { code?: unknown; status?: unknown }).code ??
              (errObj as { status?: unknown }).status;
            // Accept a numeric code or a numeric string ("429"): providers vary.
            const numCode =
              typeof code === "number"
                ? code
                : typeof code === "string" && /^\d+$/.test(code.trim())
                  ? Number(code)
                  : undefined;
            lastStatus = numCode;
            if (
              numCode === 429 ||
              numCode === 402 ||
              RATE_LIMIT_HINTS.test(lastError) ||
              EXHAUSTION_HINTS.test(lastError)
            ) {
              const quota = numCode === 402 || EXHAUSTION_HINTS.test(lastError);
              if (budget === null || (quota && budget.reason === "rate-limited")) {
                budget = { reason: quota ? "quota-exhausted" : "rate-limited", detail: lastError };
              }
              statedReset = statedResetOf(res.headers, json) ?? statedReset;
            } else if (isProviderBlip(lastError) && budget === null) {
              budget = { reason: "rate-limited", detail: lastError };
            }
            continue;
          }
          throw new AdapterError(`model API response did not match schema: ${parsed.error.message}`);
        }
        const choice = parsed.data.choices[0]!;
        const msg = choice.message;
        const finishReason = choice.finish_reason ?? undefined;
        const usage = toUsage(parsed.data.usage);
        const usageRaw = toUsageRaw(parsed.data.usage);
        // Header first, body `id` as the fallback: OpenRouter puts the same
        // generation id in both, plain OpenAI only in the header.
        const bodyId = (json as { id?: unknown }).id;
        const turnRequestId =
          requestId ?? (typeof bodyId === "string" && bodyId.length > 0 ? bodyId : undefined);
        const served = openCodeServedOf(this.opts.baseUrl, res.headers);
        return {
          kind: "ok",
          turn: {
            content: msg.content ?? null,
            ...(turnRequestId !== undefined ? { providerRequestId: turnRequestId } : {}),
            ...(finishReason !== undefined ? { finishReason } : {}),
            toolCalls: (msg.tool_calls ?? []).map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            })),
            ...(usage !== undefined ? { usage } : {}),
            ...(usageRaw !== undefined ? { usageRaw } : {}),
            ...(served !== undefined ? { served } : {}),
            raw: json,
          },
        };
      }
      lastStatus = res.status;
      lastError = `HTTP ${res.status}${requestId !== undefined ? ` [req ${requestId}]` : ""}: ${text.slice(0, 500)}`;
      retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
      // A 429 is a pause whatever the body says; the hints only decide whether
      // it reads as a spent budget or as ordinary rate limiting. Body wording
      // is a provider's whim and a run must not die on it.
      if (res.status === 429 || res.status === 402) {
        const quota = res.status === 402 || EXHAUSTION_HINTS.test(lastError);
        // Quota wins once seen: an empty wallet does not become a passing
        // rate limit because a later attempt was worded differently.
        if (budget === null || (quota && budget.reason === "rate-limited")) {
          budget = { reason: quota ? "quota-exhausted" : "rate-limited", detail: lastError };
        }
        // From the whole body, never `lastError`: that is cut at 500
        // characters, and OpenRouter's metadata sits past the message.
        statedReset = statedResetOf(res.headers, jsonOrNull(text)) ?? statedReset;
      }
      const providerBlip =
        res.status >= 400 && res.status < 500 && isProviderBlip(lastError);
      if (providerBlip && budget === null) {
        budget = { reason: "rate-limited", detail: lastError };
      }
      const retryable =
        res.status === 408 || res.status === 429 || res.status >= 500 || providerBlip;
      if (!retryable && res.status !== 402) {
        throw new AdapterError(lastError, res.status);
      }
      if (res.status === 402) break; // no point retrying an empty wallet
    }

    // The run is suspendable and resumable, not broken.
    if (budget !== null) {
      // Validated here and only here: every reader downstream (the streak,
      // the resume cadence, the roster) takes a carried `notBefore` as given.
      const now = this.now();
      const notBefore =
        statedReset !== null && statedReset >= now + PROVIDER_RESET_FLOOR_MS && statedReset <= now + PROVIDER_RESET_CEILING_MS
          ? statedReset
          : null;
      return { kind: "pause", ...budget, ...(notBefore !== null ? { notBefore } : {}) };
    }
    // Attempts exhausted on nothing but 5xx: the provider is down, not the
    // harness. Terminating here threw away a level-3 hy3 episode on five
    // consecutive 500s (fleet-free-oc-a, 2026-08-22); pausing lets the
    // roster defer the model and come back when the pool recovers.
    if (lastStatus !== undefined && lastStatus >= 500) {
      return {
        kind: "pause",
        reason: "rate-limited",
        detail: `persistent 5xx after ${made} attempt(s): ${lastError}`,
      };
    }
    // The same reasoning for a request that never got a status at all: a
    // timeout, a reset, a DNS failure is the provider (or the path to it)
    // down, not the harness. The 5xx branch above was the 2026-08-22 fix;
    // pure network errors fell past it — `lastStatus` stays undefined — and
    // three episodes died on 2026-08-24 to the identical "network error: The
    // operation timed out." across two different platforms. Pause, defer,
    // come back.
    // A failed or cut read is the same failure one step later: streaming puts
    // the headers before the first token, so a stall now lands after them.
    if (lastStatus === undefined && (lastError.startsWith("network error:") || lastError.startsWith("body read failed:"))) {
      return {
        kind: "pause",
        reason: "rate-limited",
        detail: `persistent network failure after ${made} attempt(s): ${lastError}`,
      };
    }
    // The last request id even when the final attempt died on the socket and
    // carried none: it is what a provider-side support thread asks for first.
    const idSuffix =
      lastRequestId !== undefined && !lastError.includes(lastRequestId) ? ` (last req ${lastRequestId})` : "";
    throw new AdapterError(
      `model API failed after ${made} attempt(s)${idSuffix}: ${lastError}`,
      lastStatus,
    );
  }
}

// -------------------------------------------------------------------- stub

/** One scripted assistant turn for the stub adapter. */
export const stubTurnSchema = z.object({
  content: z.string().nullable().default(null),
  toolCalls: z
    .array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }))
    .default([]),
});
export type StubTurn = z.infer<typeof stubTurnSchema>;

export class StubAdapter implements ChatAdapter {
  readonly label = "stub";
  private cursor = 0;

  constructor(private readonly turns: StubTurn[]) {}

  static fromScriptFile(path: string): StubAdapter {
    const raw: unknown = JSON.parse(require("node:fs").readFileSync(path, "utf8") as string);
    return new StubAdapter(z.array(stubTurnSchema).parse(raw));
  }

  complete(_req: ChatRequest): Promise<AdapterOutcome> {
    const turn = this.turns[this.cursor];
    if (turn === undefined) return Promise.resolve({ kind: "stub-complete" });
    this.cursor++;
    return Promise.resolve({
      kind: "ok",
      turn: {
        content: turn.content,
        toolCalls: turn.toolCalls.map((tc, i) => ({
          id: `stub-${this.cursor}-${i}`,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        })),
      },
    });
  }
}
