/**
 * The one model adapter: OpenAI-compatible chat completions with tool calling.
 * Provider, base URL, model id and key env var are run config; there is no
 * per-model behaviour anywhere in here (ADR-0004).
 *
 * ### Retry policy (fixed, documented here and only here)
 *
 * - Retryable: network errors, HTTP 408/429/5xx. Exponential backoff
 *   1s * 2^attempt with ±25% jitter, capped at 30s, max 5 attempts.
 * - After retries are exhausted on a 429/402 whose body suggests quota or
 *   subscription exhaustion (insufficient credit, quota, billing), the outcome
 *   is a PAUSE (`window-exhausted`), not a failure: the run is suspended and
 *   resumable, because a spent budget says nothing about the model.
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

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export type AdapterOutcome =
  | { kind: "ok"; turn: AssistantTurn }
  | { kind: "pause"; reason: "window-exhausted"; detail: string }
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
});

export interface OpenAiAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const EXHAUSTION_HINTS = /quota|credit|billing|insufficient|exceeded.*limit|payment/i;

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
    });

    let lastError = "";
    let lastStatus: number | undefined;
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
      const text = await res.text();
      if (res.ok) {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new AdapterError("model API returned 2xx with a non-JSON body");
        }
        const parsed = completionSchema.safeParse(json);
        if (!parsed.success) {
          throw new AdapterError(`model API response did not match schema: ${parsed.error.message}`);
        }
        const msg = parsed.data.choices[0]!.message;
        return {
          kind: "ok",
          turn: {
            content: msg.content ?? null,
            toolCalls: (msg.tool_calls ?? []).map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            })),
            raw: json,
          },
        };
      }
      lastStatus = res.status;
      lastError = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable && res.status !== 402) {
        throw new AdapterError(lastError, res.status);
      }
      if (res.status === 402) break; // no point retrying an empty wallet
    }

    if ((lastStatus === 429 || lastStatus === 402) && EXHAUSTION_HINTS.test(lastError)) {
      return { kind: "pause", reason: "window-exhausted", detail: lastError };
    }
    if (lastStatus === 402) {
      return { kind: "pause", reason: "window-exhausted", detail: lastError };
    }
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
