/**
 * The one model adapter: OpenAI-compatible chat completions with tool calling.
 * Provider, base URL, model id and key env var are run config; there is no
 * per-model behaviour anywhere in here.
 *
 * ### Retry policy (fixed, documented here and only here)
 *
 * - Retryable: network errors, HTTP 408/429/5xx. Exponential backoff
 *   1s * 2^attempt with ±25% jitter, capped at 30s, max 10 attempts, all of
 *   it under a 5-minute wall-clock budget for the whole complete() — 2026-08-24:
 *   five attempts (~15s of backoff) was too impatient for provider weather
 *   that a sixth try at 30s would have ridden out, but attempts alone are the
 *   wrong unit, because ten 120s request timeouts would spend 20+ minutes
 *   inside one complete(), where no watchdog can see it, and the idle watchdog
 *   would then kill the run AS THE MODEL'S FAULT mid-retry. Fast failures get
 *   every attempt; slow timeouts get as many as fit the budget; either way the
 *   outcome past the budget is the pause/throw decision below, reached sooner.
 *   A `Retry-After` on the response overrides the backoff for the next
 *   attempt, clamped to the same 30s cap and jittered upward only.
 * - Any 429 or 402 seen during the attempts makes the outcome a PAUSE, not a
 *   failure: a spent budget says nothing about the model, so the run is
 *   suspended and resumable. The body wording only picks which pause it is —
 *   `quota-exhausted` when it suggests credit/quota/billing (402 always),
 *   `rate-limited` otherwise. It is sticky across attempts: a 429 followed by
 *   a network timeout is still a pause.
 * - Any other 4xx is fatal immediately (`adapter-error`): the request is
 *   malformed and retrying would burn budget on a harness bug.
 *
 * The stub adapter plays a scripted response list. It exists to exercise the
 * whole runner without a model and is never used for results.
 */

import { z } from "zod";
import type { ChatMessage } from "./context";
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

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
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
  raw?: unknown;
}

export type AdapterOutcome =
  | { kind: "ok"; turn: AssistantTurn }
  | { kind: "pause"; reason: "quota-exhausted" | "rate-limited"; detail: string }
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

export interface OpenAiAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Reasoning effort, sent as `reasoning_effort`. Omitted when absent.
   *
   * Every level goes through unchanged, `none` (thinking off) included: some
   * OpenRouter models accept it, others reject it, which is true of `xhigh` and
   * `max` too and is the operator's problem, not the adapter's.
   */
  effort?: string;
  maxAttempts?: number;
  requestTimeoutMs?: number;
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
 * Deliberately a constant and not `harnessVersion()`: that shells out to `git
 * describe` (version.ts), and a subprocess per model call to decorate a header
 * is not a trade worth making. The trajectory carries the exact version.
 */
export const USER_AGENT = "wrathbench/0.2";

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

const EXHAUSTION_HINTS = /quota|credit|billing|insufficient|exceeded.*limit|payment/i;
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

export class OpenAiChatAdapter implements ChatAdapter {
  readonly label: string;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly retryBudgetMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Built once: nothing in here varies per request. */
  private readonly headers: Record<string, string>;

  constructor(private readonly opts: OpenAiAdapterOptions) {
    this.label = `openai-compatible:${opts.model}`;
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.retryBudgetMs = opts.retryBudgetMs ?? 300_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    const env = opts.env ?? process.env;
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
      ...(this.opts.baseUrl.includes("openrouter.ai") ? { usage: { include: true } } : {}),
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
    const retriesStartedAt = this.now();
    let made = 0;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (req.signal?.aborted === true) throw new AdapterError("request abandoned: the runner is stopping");
      // The wall-clock budget (see the retry policy above): attempts are the
      // wrong unit when each one can spend requestTimeoutMs on the wire.
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
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers,
          body,
          signal:
            req.signal !== undefined
              ? AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs), req.signal])
              : AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        if (req.signal !== undefined && req.signal.aborted) throw new AdapterError("request abandoned: the runner is stopping");
        lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
        lastStatus = undefined;
        continue;
      }
      const requestId = requestIdOf(res);
      if (requestId !== undefined) lastRequestId = requestId;
      let text: string;
      try {
        // The body read shares the request's AbortSignal: a provider that
        // returns headers and then stalls the body times out HERE, and that
        // is as retryable as the fetch itself failing.
        text = await res.text();
      } catch (err) {
        lastError = `body read failed: ${err instanceof Error ? err.message : String(err)}`;
        lastStatus = undefined;
        continue;
      }
      if (res.ok) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new AdapterError(
            `model API returned 2xx with a non-JSON body${requestId !== undefined ? ` [req ${requestId}]` : ""}`,
          );
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
            } else if (PROVIDER_BLIP_HINTS.test(lastError) && budget === null) {
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
        // Header first, body `id` as the fallback: OpenRouter puts the same
        // generation id in both, plain OpenAI only in the header.
        const bodyId = (json as { id?: unknown }).id;
        const turnRequestId =
          requestId ?? (typeof bodyId === "string" && bodyId.length > 0 ? bodyId : undefined);
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
      }
      const providerBlip =
        res.status >= 400 && res.status < 500 && PROVIDER_BLIP_HINTS.test(lastError);
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
    if (budget !== null) return { kind: "pause", ...budget };
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
    if (lastStatus === undefined && lastError.startsWith("network error:")) {
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
