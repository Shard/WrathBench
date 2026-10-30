/**
 * The OpenAI-compatible adapter's streaming path against a fake fetch: event
 * assembly, the plain-JSON fallback, and the request clock (silence and
 * ceiling). No network, no model; the clock tests use real timers at
 * millisecond scale.
 */
import { describe, expect, test } from "bun:test";
import { OpenAiChatAdapter, REQUEST_CEILING_MS, SILENCE_TIMEOUT_MS, assembleStream, type AdapterOutcome } from "../src/adapter";

const req = { messages: [], tools: [] };
const enc = new TextEncoder();
const SSE = { "content-type": "text/event-stream; charset=utf-8" };

/** One `data:` event per chunk object, as a server sends them. */
const data = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;

/** A stream response that sends `parts` with `gapMs` between them, then closes (unless `hang`). */
function streamed(
  parts: string[],
  o: { gapMs?: number; hang?: boolean; headers?: Record<string, string>; onCancel?: () => void } = {},
): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (i >= parts.length) {
        if (o.hang === true) return new Promise<void>(() => {});
        ctl.close();
        return;
      }
      if (i > 0 && o.gapMs !== undefined) await new Promise((r) => setTimeout(r, o.gapMs));
      ctl.enqueue(enc.encode(parts[i++]!));
    },
    cancel() {
      o.onCancel?.();
    },
  });
  return new Response(body, { status: 200, headers: o.headers ?? SSE });
}

/** An adapter whose fetch serves `next()` per attempt and records each request body. */
function adapterServing(
  next: (attempt: number, init: RequestInit) => Promise<Response>,
  extra: Record<string, unknown> = {},
): { adapter: OpenAiChatAdapter; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let attempt = 0;
  const adapter = new OpenAiChatAdapter({
    baseUrl: "http://model.invalid/v1",
    apiKey: "k",
    model: "m",
    fetchImpl: Object.assign(
      (_url: string, init: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return next(attempt++, init);
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    ...extra,
  });
  return { adapter, bodies };
}

const ok = (o: AdapterOutcome) => {
  if (o.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.turn;
};

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: "gen-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "vendor/model-1",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

describe("assembleStream", () => {
  test("content pieces join into the message a non-streaming call returns", () => {
    const { body, finished } = assembleStream(
      data(chunk({ role: "assistant", content: "" })) +
        data(chunk({ content: "Hel" })) +
        data(chunk({ content: "lo" })) +
        data(chunk({}, "stop")) +
        "data: [DONE]\n\n",
    );
    expect(finished).toBe(true);
    expect(body).toEqual({
      id: "gen-1",
      created: 1,
      model: "vendor/model-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    });
  });

  test("interleaved deltas of two tool calls are assembled by index", () => {
    const { body } = assembleStream(
      [
        chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "run_", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "wiki", arguments: "{\"q\"" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: "snippet", arguments: "{\"code\":" } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: ":\"x\"}" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "\"1\"}" } }] }),
        chunk({}, "tool_calls"),
      ]
        .map(data)
        .join("") + "data: [DONE]\n\n",
    );
    const msg = (body as { choices: { message: Record<string, unknown> }[] }).choices[0]!.message;
    expect(msg["content"]).toBeNull();
    expect(msg["tool_calls"]).toEqual([
      { id: "call_a", type: "function", function: { name: "run_snippet", arguments: "{\"code\":\"1\"}" } },
      { id: "call_b", type: "function", function: { name: "wiki", arguments: "{\"q\":\"x\"}" } },
    ]);
  });

  test("a name and id repeated whole on every delta are not doubled", () => {
    const { body } = assembleStream(
      data(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "run_snippet", arguments: "{\"a\"" } }] })) +
        data(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "run_snippet", arguments: ":1}" } }] }, "tool_calls")),
    );
    const msg = (body as { choices: { message: { tool_calls: unknown[] } }[] }).choices[0]!.message;
    expect(msg.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "run_snippet", arguments: "{\"a\":1}" } }]);
  });

  test("calls sent whole without an index stay separate, told apart by id", () => {
    const { body } = assembleStream(
      data(chunk({ tool_calls: [{ id: "c1", function: { name: "a", arguments: "{}" } }] })) +
        data(chunk({ tool_calls: [{ id: "c2", function: { name: "b", arguments: "{}" } }] }, "tool_calls")),
    );
    const msg = (body as { choices: { message: { tool_calls: { id: string }[] } }[] }).choices[0]!.message;
    expect(msg.tool_calls.map((t) => t.id)).toEqual(["c1", "c2"]);
  });

  test("streamed reasoning is kept under the field it arrived in", () => {
    const { body } = assembleStream(
      data(chunk({ reasoning: "think " })) +
        data(chunk({ reasoning: "more", reasoning_content: "rc" })) +
        data(chunk({ content: "done" }, "stop")),
    );
    const msg = (body as { choices: { message: Record<string, unknown> }[] }).choices[0]!.message;
    expect(msg["reasoning"]).toBe("think more");
    expect(msg["reasoning_content"]).toBe("rc");
    expect(msg["content"]).toBe("done");
  });

  test("comment lines, CRLF, and data without a space are all read", () => {
    const { body, finished } = assembleStream(
      ": OPENROUTER PROCESSING\r\n\r\n" +
        `data:${JSON.stringify(chunk({ content: "a" }))}\r\n\r\n` +
        ": OPENROUTER PROCESSING\r\n\r\n" +
        `data: ${JSON.stringify(chunk({ content: "b" }, "stop"))}\r\n\r\n` +
        "data: [DONE]\r\n\r\n",
    );
    expect(finished).toBe(true);
    expect((body as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("ab");
  });

  test("an event split over several data lines is joined before parsing", () => {
    const json = JSON.stringify(chunk({ content: "x" }, "stop"), null, 1).split("\n");
    const { body } = assembleStream(json.map((l) => `data: ${l}`).join("\n") + "\n\n");
    expect((body as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe("x");
  });

  test("an error chunk after the 200 becomes the body's error object", () => {
    const { body, finished } = assembleStream(
      data(chunk({ content: "partial" })) +
        data({ id: "gen-1", object: "chat.completion.chunk", error: { code: 502, message: "Provider disconnected" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }),
    );
    expect(finished).toBe(true);
    expect(body).toEqual({ id: "gen-1", created: 1, model: "vendor/model-1", error: { code: 502, message: "Provider disconnected" } });
  });

  test("no [DONE] is finished when a finish_reason arrived, and unfinished when nothing did", () => {
    expect(assembleStream(data(chunk({ content: "a" }, "stop"))).finished).toBe(true);
    expect(assembleStream(data(chunk({ content: "a" }))).finished).toBe(false);
  });

  test("a malformed chunk leaves the stream unfinished", () => {
    expect(assembleStream(data(chunk({ content: "a" }, "stop")) + "data: {not json\n\n").finished).toBe(false);
  });
});

describe("OpenAiChatAdapter streaming", () => {
  test("every request asks for a stream with usage", async () => {
    const { adapter, bodies } = adapterServing(() => Promise.resolve(streamed([data(chunk({ content: "x" }, "stop"))])));
    await adapter.complete(req);
    expect(bodies[0]!["stream"]).toBe(true);
    expect(bodies[0]!["stream_options"]).toEqual({ include_usage: true });
  });

  test("a streamed turn carries exactly what the same turn returned whole carries", async () => {
    const usage = {
      prompt_tokens: 5_400,
      completion_tokens: 120,
      total_tokens: 5_520,
      cost: 0.00213,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 4_800, cache_write_tokens: 300 },
      completion_tokens_details: { reasoning_tokens: 64 },
      cost_details: { upstream_inference_prompt_cost: 0.0019 },
    };
    const whole = {
      id: "gen-1",
      provider: "SomeHost",
      model: "vendor/model-1",
      choices: [
        {
          message: {
            content: "on it",
            tool_calls: [{ id: "call_a", type: "function", function: { name: "run_snippet", arguments: "{\"code\":\"1\"}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    };
    const parts = [
      ": OPENROUTER PROCESSING\n\n",
      data(chunk({ role: "assistant", content: "on " }, null, { provider: "SomeHost" })),
      data(chunk({ content: "it", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "run_snippet", arguments: "" } }] }, null, { provider: "SomeHost" })),
      data(chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"code\":\"1\"}" } }] }, null, { provider: "SomeHost" })),
      data(chunk({}, "tool_calls", { provider: "SomeHost" })),
      // The usage chunk `include_usage` adds: no choices.
      data({ id: "gen-1", object: "chat.completion.chunk", model: "vendor/model-1", provider: "SomeHost", choices: [], usage }),
      "data: [DONE]\n\n",
    ];
    const s = ok(await adapterServing(() => Promise.resolve(streamed(parts))).adapter.complete(req));
    const w = ok(
      await adapterServing(() =>
        Promise.resolve(new Response(JSON.stringify(whole), { status: 200, headers: { "content-type": "application/json" } })),
      ).adapter.complete(req),
    );
    const { raw: sRaw, ...sTurn } = s;
    const { raw: _wRaw, ...wTurn } = w;
    expect(sTurn).toEqual(wTurn);
    expect(sTurn.usage?.cost).toBe(0.00213);
    expect(sTurn.usage?.cached_tokens).toBe(4_800);
    expect(sTurn.usage?.reasoning_tokens).toBe(64);
    expect(sTurn.providerRequestId).toBe("gen-1");
    // What the loop reads off `raw`: the serving backend and model.
    expect((sRaw as { provider: string; model: string }).provider).toBe("SomeHost");
    expect((sRaw as { provider: string; model: string }).model).toBe("vendor/model-1");
  });

  test("a provider that ignores `stream` and answers with plain JSON is read as before", async () => {
    const whole = { id: "x-1", choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 3 } };
    const turn = ok(
      await adapterServing(() =>
        Promise.resolve(new Response(JSON.stringify(whole), { status: 200, headers: { "content-type": "application/json" } })),
      ).adapter.complete(req),
    );
    expect(turn.content).toBe("plain");
    expect(turn.usage).toEqual({ prompt_tokens: 3 });
    expect(turn.raw).toEqual(whole);
  });

  test("an event stream served under another content type is still assembled", async () => {
    const turn = ok(
      await adapterServing(() =>
        Promise.resolve(streamed([data(chunk({ content: "x" }, "stop")), "data: [DONE]\n\n"], { headers: { "content-type": "text/plain" } })),
      ).adapter.complete(req),
    );
    expect(turn.content).toBe("x");
  });

  test("a mid-stream error is read like a 2xx error body: retried, and a rate limit pauses", async () => {
    const errChunk = data({ id: "gen-9", error: { code: 429, message: "Rate limit exceeded upstream" } });
    const { adapter } = adapterServing(() => Promise.resolve(streamed([data(chunk({ content: "par" })), errChunk])), { maxAttempts: 2 });
    const out = await adapter.complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
    expect(out.kind === "pause" && out.detail).toContain("Rate limit exceeded upstream");
  });

  test("a mid-stream error followed by a clean stream succeeds", async () => {
    const { adapter } = adapterServing((n) =>
      Promise.resolve(
        n === 0
          ? streamed([data({ error: { code: 502, message: "Provider disconnected" } })])
          : streamed([data(chunk({ content: "second" }, "stop")), "data: [DONE]\n\n"]),
      ),
    );
    expect(ok(await adapter.complete(req)).content).toBe("second");
  });

  test("a stream cut before any finish is retried whole, and pauses when it never finishes", async () => {
    const cut = () => Promise.resolve(streamed([data(chunk({ content: "half" }))]));
    const { adapter: retried } = adapterServing((n) =>
      n === 0 ? cut() : Promise.resolve(streamed([data(chunk({ content: "whole" }, "stop"))])),
    );
    expect(ok(await retried.complete(req)).content).toBe("whole");

    const { adapter: never } = adapterServing(cut, { maxAttempts: 2 });
    const out = await never.complete(req);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.detail).toContain("persistent network failure after 2 attempt(s)");
    expect(out.kind === "pause" && out.detail).toContain("stream ended before the model finished");
  });

  test("an empty stream with no choice fails as a schema mismatch, as an empty body would", async () => {
    const { adapter } = adapterServing(() => Promise.resolve(streamed(["data: [DONE]\n\n"])), { maxAttempts: 1 });
    await expect(adapter.complete(req)).rejects.toThrow(/did not match schema/);
  });

  test("an error status is read as text with its pause semantics unchanged", async () => {
    const { adapter } = adapterServing(
      () => Promise.resolve(new Response("{\"error\":{\"message\":\"slow down\"}}", { status: 429, headers: { "content-type": "application/json" } })),
      { maxAttempts: 1 },
    );
    const out = await adapter.complete(req);
    expect(out.kind === "pause" && out.reason).toBe("rate-limited");
  });
});

describe("OpenAiChatAdapter request clock", () => {
  test("the defaults are a 120 s silence and a 5-minute ceiling", () => {
    expect(SILENCE_TIMEOUT_MS).toBe(120_000);
    expect(REQUEST_CEILING_MS).toBe(300_000);
  });

  test("a stalled stream times out on silence, is cancelled, and pauses when it keeps stalling", async () => {
    let cancelled = 0;
    const { adapter } = adapterServing(
      () => Promise.resolve(streamed([data(chunk({ content: "a" }))], { hang: true, onCancel: () => cancelled++ })),
      { maxAttempts: 2, silenceTimeoutMs: 40, requestCeilingMs: 5_000 },
    );
    const started = Date.now();
    const out = await adapter.complete(req);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.kind).toBe("pause");
    expect(out.kind === "pause" && out.detail).toContain("body read failed: no data from the model API for 0.04 s");
    expect(cancelled).toBe(2);
  });

  test("a slow but steady stream outlives many silence windows", async () => {
    const parts = Array.from({ length: 12 }, (_, i) => data(chunk({ content: String(i % 10) })));
    parts.push(data(chunk({}, "stop")), "data: [DONE]\n\n");
    const { adapter } = adapterServing(() => Promise.resolve(streamed(parts, { gapMs: 25 })), {
      maxAttempts: 1,
      silenceTimeoutMs: 80,
      requestCeilingMs: 5_000,
    });
    // ~350 ms in all, over four times the silence window.
    expect(ok(await adapter.complete(req)).content).toBe("012345678901");
  });

  test("keep-alive comments alone do not keep a request alive", async () => {
    const parts = [...Array.from({ length: 20 }, () => ": OPENROUTER PROCESSING\n\n"), data(chunk({ content: "late" }, "stop"))];
    const { adapter } = adapterServing(() => Promise.resolve(streamed(parts, { gapMs: 20 })), {
      maxAttempts: 1,
      silenceTimeoutMs: 100,
      requestCeilingMs: 5_000,
    });
    const out = await adapter.complete(req);
    expect(out.kind === "pause" && out.detail).toContain("no data from the model API");
  });

  test("the wait for headers is covered by the silence timer", async () => {
    const { adapter } = adapterServing(
      (_n, init) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason as Error), { once: true });
        }),
      { maxAttempts: 1, silenceTimeoutMs: 40, requestCeilingMs: 5_000 },
    );
    const out = await adapter.complete(req);
    expect(out.kind === "pause" && out.detail).toContain("network error: no data from the model API for 0.04 s");
  });

  test("a stream that trickles forever ends at the ceiling", async () => {
    const parts = Array.from({ length: 1_000 }, () => data(chunk({ content: "." })));
    let cancelled = false;
    const { adapter } = adapterServing(() => Promise.resolve(streamed(parts, { gapMs: 10, onCancel: () => (cancelled = true) })), {
      maxAttempts: 1,
      silenceTimeoutMs: 100,
      requestCeilingMs: 150,
    });
    const started = Date.now();
    const out = await adapter.complete(req);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.kind === "pause" && out.detail).toContain("the request passed its 0.15 s ceiling");
    expect(cancelled).toBe(true);
  });

  test("the retry budget never cuts an attempt in flight: a long steady stream that started inside it completes", async () => {
    let t = 0;
    const parts = Array.from({ length: 5 }, () => data(chunk({ content: "x" })));
    parts.push(data(chunk({}, "stop")));
    const { adapter } = adapterServing(
      (n) => {
        if (n === 0) {
          t += 290_000; // a first attempt that failed late in the budget
          return Promise.reject(new Error("socket hang up"));
        }
        t += 60_000; // the second, long and steady, runs past the budget
        return Promise.resolve(streamed(parts, { gapMs: 10 }));
      },
      { now: () => t, silenceTimeoutMs: 100, requestCeilingMs: 5_000 },
    );
    expect(ok(await adapter.complete(req)).content).toBe("xxxxx");
  });

  test("a runner stop mid-stream abandons the request rather than reading as a timeout", async () => {
    const stop = new AbortController();
    const { adapter } = adapterServing(
      () => {
        setTimeout(() => stop.abort(), 30);
        return Promise.resolve(streamed([data(chunk({ content: "a" }))], { hang: true }));
      },
      { silenceTimeoutMs: 5_000, requestCeilingMs: 5_000 },
    );
    await expect(adapter.complete({ ...req, signal: stop.signal })).rejects.toThrow(/request abandoned/);
  });
});
