/**
 * The one model adapter: OpenAI-compatible chat completions with tool calling.
 * Provider, base URL, model id and key env var are run config; there is no
 * per-model behaviour anywhere in here (ADR-0004).
 *
 * ### Retry policy (fixed, documented here and only here)
 *
 * - Retryable: network errors, HTTP 408/429/5xx. Exponential backoff
 *   1s * 2^attempt with ±25% jitter, capped at 30s, max 5 attempts.
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
 * effectiveness (ADR-0012 addendum) — estimates cannot see a cache hit.
 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Prompt tokens served from the provider's prompt cache, flattened from
   * `prompt_tokens_details.cached_tokens` (OpenAI-compat) or a top-level
   * `cached_tokens`. Absent when the provider reports nothing. */
  cached_tokens?: number;
}

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
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
      prompt_tokens_details: z.looseObject({ cached_tokens: z.number().nullish() }).nullish(),
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
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export interface OpenAiAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Reasoning effort, sent as `reasoning_effort`. Omitted when absent. */
  effort?: string;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenAiAdapterOptions) {
    this.label = `openai-compatible:${opts.model}`;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
    // Sticky across attempts, deliberately: a 429 followed by a retry that dies
    // of a network timeout used to clear `lastStatus` and turn a budget pause
    // into a terminal adapter-error (observed on run-real-smoke-1). What the
    // provider said once about the budget outlives one flaky socket.
    let budget: { reason: "quota-exhausted" | "rate-limited"; detail: string } | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
        await this.sleep(base + Math.floor(base * (Math.random() * 0.5 - 0.25)));
      }
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
        lastStatus = undefined;
        continue;
      }
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
          throw new AdapterError("model API returned 2xx with a non-JSON body");
        }
        const parsed = completionSchema.safeParse(json);
        if (!parsed.success) {
          // Free-tier providers return 200 with an error object and no
          // `choices` (observed: OpenRouter upstream, night-nemotron-1, which
          // this used to terminate as adapter-error). Read it like the
          // HTTP-status path: budget-shaped errors pause, the rest retry.
          const errObj = (json as { error?: unknown }).error;
          if (errObj !== undefined && errObj !== null) {
            lastError = `provider error in 2xx body: ${JSON.stringify(errObj).slice(0, 500)}`;
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
        const msg = parsed.data.choices[0]!.message;
        const usage = toUsage(parsed.data.usage);
        return {
          kind: "ok",
          turn: {
            content: msg.content ?? null,
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
      lastError = `HTTP ${res.status}: ${text.slice(0, 500)}`;
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
    throw new AdapterError(`model API failed after ${this.maxAttempts} attempts: ${lastError}`, lastStatus);
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
