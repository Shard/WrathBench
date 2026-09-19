/**
 * The OpenAI-compatible adapter against a fake fetch. No network, no model.
 */
import { describe, expect, test } from "bun:test";
import { APP_TITLE, APP_URL, OpenAiChatAdapter, USER_AGENT, parseRetryAfter } from "../src/adapter";

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

/** Captures the request an adapter sends, with the given extra options. */
async function sentRequest(
  extra: Record<string, unknown>,
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  let seen = "";
  let headers = new Headers();
  const adapter = new OpenAiChatAdapter({
    baseUrl: "http://model.invalid/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: Object.assign(
      (_url: string, init: RequestInit): Promise<Response> => {
        seen = String(init.body);
        // The adapter passes a plain object; normalise so the assertions are
        // about header semantics rather than object shape or key casing.
        headers = new Headers(init.headers as Record<string, string>);
        return Promise.resolve(new Response(JSON.stringify({ choices }), { status: 200 }));
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    ...extra,
  });
  await adapter.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });
  return { body: JSON.parse(seen) as Record<string, unknown>, headers };
}

async function sentBody(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await sentRequest(extra)).body;
}

describe("OpenAiChatAdapter attribution headers", () => {
  test("every request carries the OpenRouter attribution pair and a user agent", async () => {
    const { headers } = await sentRequest({ env: {} });
    expect(headers.get("x-title")).toBe(APP_TITLE);
    expect(headers.get("http-referer")).toBe(APP_URL);
    expect(headers.get("user-agent")).toBe(USER_AGENT);
    // The identity we send carries NO version. A hand-maintained one drifted
    // for three series ("wrathbench/0.2" against a 0.5 harness) and nothing
    // noticed, so the rule is stated as a test rather than a comment: any
    // digit in the outbound user-agent is a version literal coming back.
    expect(headers.get("user-agent")).toBe("WrathBench");
    expect(headers.get("user-agent")).not.toMatch(/\d/);
    // and the key still goes where it always did
    expect(headers.get("authorization")).toBe("Bearer k");
  });

  test("WRATHBENCH_APP_URL overrides the placeholder referer", async () => {
    const { headers } = await sentRequest({ env: { WRATHBENCH_APP_URL: "https://example.test/wb " } });
    expect(headers.get("http-referer")).toBe("https://example.test/wb");
  });

  test("a blank WRATHBENCH_APP_URL falls back to the default", async () => {
    const { headers } = await sentRequest({ env: { WRATHBENCH_APP_URL: "   " } });
    expect(headers.get("http-referer")).toBe(APP_URL);
  });

  test("an unusable WRATHBENCH_APP_URL falls back instead of breaking every request", async () => {
    // A control character would make fetch throw building the headers, which
    // the adapter would read as a network error and retry five times.
    const { headers } = await sentRequest({ env: { WRATHBENCH_APP_URL: "https://x.test/\nInjected: 1" } });
    expect(headers.get("http-referer")).toBe(APP_URL);
  });

  test("attribution is not host-gated: a non-OpenRouter endpoint gets it too", async () => {
    const { headers, body } = await sentRequest({ env: {} });
    expect(body).not.toHaveProperty("usage"); // not OpenRouter
    expect(headers.get("x-title")).toBe(APP_TITLE);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-08-22T00:00:00Z");

  test("integer seconds", () => {
    expect(parseRetryAfter("3", now)).toBe(3_000);
  });

  test("an HTTP-date becomes the delta from now, never negative", () => {
    expect(parseRetryAfter("Sat, 22 Aug 2026 00:00:07 GMT", now)).toBe(7_000);
    expect(parseRetryAfter("Fri, 21 Aug 2026 00:00:00 GMT", now)).toBe(0);
  });

  test("absent or unparseable yields null, never NaN", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
  });
});

describe("OpenAiChatAdapter Retry-After", () => {
  /** Plays a script and records how long the adapter slept between attempts. */
  function adapterTiming(script: Response[]): { adapter: OpenAiChatAdapter; slept: number[] } {
    const slept: number[] = [];
    let i = 0;
    const adapter = new OpenAiChatAdapter({
      baseUrl: "http://model.invalid/v1",
      apiKey: "k",
      model: "m",
      maxAttempts: script.length,
      fetchImpl: Object.assign(() => Promise.resolve(script[i++]!), { preconnect: () => {} }) as unknown as typeof fetch,
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    return { adapter, slept };
  }

  const limited = (retryAfter: string): Response =>
    new Response("slow down", { status: 429, headers: { "retry-after": retryAfter } });

  test("a Retry-After replaces the computed backoff and is never undercut", async () => {
    const { adapter, slept } = adapterTiming([limited("5"), new Response(JSON.stringify({ choices }))]);
    const out = await adapter.complete({ messages: [], tools: [] });
    expect(out.kind).toBe("ok");
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThanOrEqual(5_000);
    expect(slept[0]).toBeLessThan(5_500);
  });

  test("an absurd Retry-After is clamped to the 30s backoff cap", async () => {
    const { adapter, slept } = adapterTiming([limited("3600"), limited("3600")]);
    const out = await adapter.complete({ messages: [], tools: [] });
    expect(out.kind).toBe("pause"); // semantics unchanged: a 429 still pauses
    expect(slept[0]).toBeLessThanOrEqual(30_250);
    expect(slept[0]).toBeGreaterThanOrEqual(30_000);
  });

  test("without a Retry-After the exponential backoff is unchanged", async () => {
    const { adapter, slept } = adapterTiming([status(500, "boom"), status(500, "boom")]);
    await adapter.complete({ messages: [], tools: [] });
    expect(slept[0]).toBeGreaterThanOrEqual(750);
    expect(slept[0]).toBeLessThanOrEqual(1_250);
  });
});

describe("OpenAiChatAdapter request ids", () => {
  test("a response header id rides onto the turn", async () => {
    const adapter = adapterPlaying([
      new Response(JSON.stringify({ choices }), { status: 200, headers: { "x-request-id": "req_abc" } }),
    ]);
    const out = await adapter.complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.providerRequestId).toBe("req_abc");
  });

  test("the body's generation id is the fallback when no header carries one", async () => {
    const out = await adapterReturning({ id: "gen-123", choices }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.providerRequestId).toBe("gen-123");
  });

  test("a Cloudflare ray never shadows the body's generation id", async () => {
    // OpenRouter is CDN-fronted, so cf-ray is on nearly every response; the
    // gen-… id is the only one its generation lookup accepts.
    const adapter = adapterPlaying([
      new Response(JSON.stringify({ id: "gen-real", choices }), {
        status: 200,
        headers: { "cf-ray": "8ab-LHR" },
      }),
    ]);
    const out = await adapter.complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.providerRequestId).toBe("gen-real");
  });

  test("no id anywhere leaves the field absent", async () => {
    const out = await adapterReturning({ choices }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.providerRequestId).toBeUndefined();
  });

  test("a fatal 4xx names the request id so the provider can be asked about it", async () => {
    const res = new Response("bad request", { status: 400, headers: { "x-request-id": "req_bad" } });
    await expect(adapterPlaying([res]).complete({ messages: [], tools: [] })).rejects.toThrow(/req_bad/);
  });

  test("a pause detail names the request id too", async () => {
    const res = (): Response =>
      new Response("slow down", { status: 429, headers: { "x-openrouter-id": "gen-xyz" } });
    const out = await adapterPlaying([res(), res()]).complete({ messages: [], tools: [] });
    expect(out.kind === "pause" && out.detail).toContain("gen-xyz");
  });
});

describe("OpenAiChatAdapter reasoning effort", () => {
  test("no effort configured sends no reasoning_effort at all", async () => {
    expect(await sentBody({})).not.toHaveProperty("reasoning_effort");
  });

  test("a configured effort is sent verbatim", async () => {
    expect(await sentBody({ effort: "low" })).toMatchObject({ reasoning_effort: "low" });
  });

  test("`none` — thinking off — goes through like any other level", async () => {
    // Some OpenRouter models accept it and some reject it, which is true of
    // `xhigh` and `max` too: the adapter does not curate the vocabulary.
    expect(await sentBody({ effort: "none" })).toMatchObject({ reasoning_effort: "none" });
  });

  test("effort is not host-gated the way the usage opt-in is", async () => {
    const body = await sentBody({ effort: "high" });
    expect(body["reasoning_effort"]).toBe("high");
    // the usage opt-in IS host-gated, and this base url is not OpenRouter
    expect(body).not.toHaveProperty("usage");
  });
});

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

  test("cache_write_tokens is flattened from prompt_tokens_details — the shape OpenRouter sends", async () => {
    // Follow-up 59: OpenRouter nests writes and never sends the flat key, so
    // reading only the top level found nothing and every write priced at zero.
    const out = await adapterReturning({
      choices,
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 25 },
      },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({
      prompt_tokens: 100,
      cached_tokens: 60,
      cache_write_tokens: 25,
    });
  });

  test("a top-level cache_write_tokens wins and details are the fallback", async () => {
    const out = await adapterReturning({
      choices,
      usage: { cache_write_tokens: 7, prompt_tokens_details: { cache_write_tokens: 999 } },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({ cache_write_tokens: 7 });
  });

  test("a provider that reports no cache writes stays absent, never zero", async () => {
    const out = await adapterReturning({
      choices,
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 10 } },
    }).complete({ messages: [], tools: [] });
    const u = out.kind === "ok" ? out.turn.usage : undefined;
    expect(u).toEqual({ prompt_tokens: 100, cached_tokens: 10 });
    expect(u && "cache_write_tokens" in u).toBe(false);
  });

  test("the provider's own cost survives into the turn — it is the actual bill", async () => {
    const out = await adapterReturning({
      choices,
      usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.000138 },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({
      prompt_tokens: 900,
      completion_tokens: 12,
      cost: 0.000138,
    });
  });

  test("reasoning tokens are flattened from completion_tokens_details", async () => {
    const out = await adapterReturning({
      choices,
      usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 31 } },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({ completion_tokens: 40, reasoning_tokens: 31 });
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

  test("an OpenRouter 404 provider blip pauses as rate-limited, not adapter-error", async () => {
    // A healthy 60-turn nemotron episode died to one of these. Transient pool
    // weather, resumable — not a harness bug.
    const body = JSON.stringify({
      error: { message: "Provider returned error", code: 404, metadata: { raw: "", provider_name: "Nvidia" } },
    });
    const out = await adapterPlaying([status(404, body), status(404, body)]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
  });

  test("an OpenCode 400 upstream-unavailable pauses as rate-limited", async () => {
    const body = JSON.stringify({
      error: { type: "server_error", message: "Error from provider (Console): Upstream request failed: Model is unavailable." },
    });
    const out = await adapterPlaying([status(400, body), status(400, body)]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
  });

  test("a 404 for a bad model slug still fails fast as an AdapterError", async () => {
    const body = JSON.stringify({ error: { message: "No endpoints found for zz/not-a-model", code: 404 } });
    await expect(adapterPlaying([status(404, body)]).complete(req)).rejects.toThrow(/No endpoints found/);
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

  test("a 2xx error body with a string rate-limit code pauses as rate-limited", async () => {
    // Providers that send code as a string ("rate_limit_exceeded") with
    // rate-limit wording used to terminate the run instead of pausing.
    const errBody = JSON.stringify({
      error: { message: "Too many requests for this model", code: "rate_limit_exceeded" },
    });
    const out = await adapterPlaying([status(200, errBody), status(200, errBody)]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
  });

  test("a 2xx error body with a numeric-string 429 code pauses as rate-limited", async () => {
    const errBody = JSON.stringify({ error: { message: "Provider returned error", code: "429" } });
    const out = await adapterPlaying([status(200, errBody), status(200, errBody)]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
  });

  test("a 2xx error body that is only ever 5xx-shaped pauses instead of hard-erroring", async () => {
    // Provider-down weather: the run is resumable, the roster defers it.
    const errBody = JSON.stringify({ error: { message: "upstream exploded", code: 500 } });
    const out = await adapterPlaying([status(200, errBody), status(200, errBody)]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.detail).toContain("persistent 5xx");
  });

  test("attempts exhausted on pure network errors pause instead of terminating", async () => {
    // The other half of the 2026-08-22 fix: a timeout/reset/DNS failure never
    // has an HTTP status, so it fell past the persistent-5xx branch and three
    // episodes died as adapter-error on 2026-08-24 ("network error: The
    // operation timed out.", two different platforms). Provider-down weather
    // either way — the run is resumable, the roster defers it.
    const out = await adapterPlaying([new Error("The operation timed out."), new Error("The operation timed out.")]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
    expect(out.kind === "pause" && out.detail).toContain("persistent network failure");
  });

  test("a 2xx error body without any status shape still hard-errors", async () => {
    const errBody = JSON.stringify({ error: { message: "something odd, no code" } });
    await expect(
      adapterPlaying([status(200, errBody), status(200, errBody)]).complete(req),
    ).rejects.toThrow(/after 2 attempt\(s\)/);
  });

  test("persistent HTTP 500s pause as rate-limited instead of terminating", async () => {
    // Five consecutive 500s ended a level-3 run.
    const out = await adapterPlaying([
      status(500, "Internal server error"),
      status(500, "Internal server error"),
    ]).complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
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

  test("the retry budget stops the loop long before the idle watchdog could blame the model", async () => {
    // Ten attempts is the right patience for FAST failures; with each attempt
    // eating a 60s request timeout it would spend 10+ minutes inside one
    // complete(), where no watchdog can see it, and the idle watchdog would
    // then kill the run as the model's fault. The wall-clock budget cuts it
    // off: two 60s timeouts and ~1s of backoff blow a 100s budget, so the
    // third attempt never starts and the outcome is the same resumable pause.
    let t = 0;
    const adapter = new OpenAiChatAdapter({
      baseUrl: "http://model.invalid/v1",
      apiKey: "k",
      model: "m",
      maxAttempts: 10,
      retryBudgetMs: 100_000,
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
      fetchImpl: Object.assign(
        (): Promise<Response> => {
          t += 60_000; // the request timeout, spent on the wire
          return Promise.reject(new Error("The operation timed out."));
        },
        { preconnect: () => {} },
      ) as unknown as typeof fetch,
    });
    const out = await adapter.complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.detail).toContain("persistent network failure after 2 attempt(s)");
  });

  // "network failures with no 4xx anywhere are still a hard error" was pinned
  // here (af7e4aa) without a defence, and 2026-08-24 overturned it the same
  // way 2026-08-22 overturned it for 5xx: three live episodes died to pure
  // timeouts. The boundary now pauses — see "attempts exhausted on pure
  // network errors pause instead of terminating" above. What still hard-errors
  // on exhausted attempts is a failure that is neither an HTTP status nor a
  // socket error, which no longer has a test to itself because no such shape
  // has been observed.

  test("a non-retryable 4xx is fatal immediately", async () => {
    await expect(adapterPlaying([status(400, "bad request")]).complete(req)).rejects.toThrow(
      /HTTP 400/,
    );
  });
});
