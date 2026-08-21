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

  test("partial usage keeps the counters it has and drops the rest", async () => {
    const out = await adapterReturning({
      choices,
      usage: { prompt_tokens: 5, completion_tokens: null },
    }).complete({ messages: [], tools: [] });
    expect(out.kind === "ok" && out.turn.usage).toEqual({ prompt_tokens: 5 });
  });
});
