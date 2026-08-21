/**
 * The OpenAI-compatible adapter against a fake fetch. No network, no model.
 */
import { describe, expect, test } from "bun:test";
import { OpenAiChatAdapter } from "../src/adapter";

function adapterReturning(body: unknown): OpenAiChatAdapter {
  return new OpenAiChatAdapter({
    baseUrl: "http://model.invalid/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: Object.assign(
      (): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      { preconnect: () => {} },
    ) as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
  });
}

const choices = [{ message: { content: "hi", tool_calls: [] } }];

/** An adapter whose fetch plays a scripted list of responses / throws. */
function adapterPlaying(script: (Response | Error)[]): OpenAiChatAdapter {
  let i = 0;
  return new OpenAiChatAdapter({
    baseUrl: "http://model.invalid/v1",
    apiKey: "k",
    model: "m",
    maxAttempts: script.length,
    fetchImpl: Object.assign(
      (): Promise<Response> => {
        const next = script[i++]!;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
  });
}

const status = (code: number, body: string): Response => new Response(body, { status: code });

describe("OpenAiChatAdapter usage", () => {
  test("carries provider-reported usage onto the turn", async () => {
    const out = await adapterReturning({
      choices,
      usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 },
    }).complete({ messages: [], tools: [] });
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && out.turn.usage).toEqual({
      prompt_tokens: 900,
      completion_tokens: 12,
      total_tokens: 912,
    });
  });

  test("a provider that omits usage parses and reports none", async () => {
    const out = await adapterReturning({ choices }).complete({ messages: [], tools: [] });
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && out.turn.usage).toBeUndefined();
  });

  test("cached_tokens is flattened from prompt_tokens_details", async () => {
    const out = await adapterReturning({
      choices,
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({ prompt_tokens: 100, cached_tokens: 80 });
  });

  test("a top-level cached_tokens wins and details are the fallback", async () => {
    const out = await adapterReturning({
      choices,
      usage: { cached_tokens: 40, prompt_tokens_details: { cached_tokens: 9 } },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({ cached_tokens: 40 });
  });

  test("partial usage keeps the counters it has and drops the rest", async () => {
    const out = await adapterReturning({
      choices,
      usage: { prompt_tokens: 5, completion_tokens: null },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({ prompt_tokens: 5 });
  });
});

describe("OpenAiChatAdapter budget pauses", () => {
  const req = { messages: [], tools: [] };

  test("a 429 with no quota wording pauses as rate-limited", async () => {
    const out = await adapterPlaying([
      status(429, "slow down"),
      status(429, "slow down"),
    ]).complete(req);
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
  });

  test("a 429 whose body says quota pauses as quota-exhausted", async () => {
    const out = await adapterPlaying([status(429, "insufficient credit")]).complete(req);
    expect(out.kind === "pause" && out.reason).toBe("quota-exhausted");
  });

  test("a 429 followed by network failures still pauses, not adapter-errors", async () => {
    // The run-real-smoke-1 shape: the 429's status used to be overwritten by
    // the next attempt's network error and the run died as adapter-error.
    const out = await adapterPlaying([
      status(429, "too many requests"),
      new Error("fetch timed out"),
      new Error("fetch timed out"),
    ]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
    // and the detail describes the 429, not the socket that died after it
    expect(out.kind === "pause" && out.detail).toContain("429");
  });

  test("a 2xx body carrying an error object with code 429 pauses instead of adapter-erroring", async () => {
    // The night-nemotron-1 shape: free-tier upstream returns HTTP 200 with
    // {"error": ...} and no choices; this used to terminate as a schema error.
    const errBody = JSON.stringify({ error: { message: "Provider returned error", code: 429 } });
    const out = await adapterPlaying([
      status(200, errBody),
      status(200, errBody),
    ]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
    expect(out.kind === "pause" && out.detail).toContain("2xx body");
  });

  test("a 2xx error body without budget shape retries and then hard-errors", async () => {
    const errBody = JSON.stringify({ error: { message: "upstream exploded", code: 500 } });
    await expect(
      adapterPlaying([status(200, errBody), status(200, errBody)]).complete(req),
    ).rejects.toThrow(/after 2 attempts/);
  });

  test("a 2xx error body followed by a good response succeeds", async () => {
    const errBody = JSON.stringify({ error: { message: "upstream exploded", code: 500 } });
    const out = await adapterPlaying([
      status(200, errBody),
      status(200, JSON.stringify({ choices })),
    ]).complete(req);
    expect(out.kind).toBe("ok");
  });

  test("quota wins over a later plain rate limit", async () => {
    const out = await adapterPlaying([
      status(429, "quota exceeded for this key"),
      status(429, "slow down"),
    ]).complete(req);
    expect(out.kind === "pause" && out.reason).toBe("quota-exhausted");
  });

  test("network failures with no 4xx anywhere are still a hard error", async () => {
    await expect(
      adapterPlaying([new Error("boom"), new Error("boom")]).complete(req),
    ).rejects.toThrow(/failed after 2 attempts/);
  });

  test("a non-retryable 4xx is fatal immediately", async () => {
    await expect(adapterPlaying([status(400, "bad request")]).complete(req)).rejects.toThrow(
      /HTTP 400/,
    );
  });
});
