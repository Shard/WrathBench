/**
 * Provider routing (issue #25; operator decision 2026-09-16).
 *
 * What is worth pinning is the three places a wrong answer is expensive: the
 * default (fallbacks off, the lab first), the gate (the object reaches an
 * OpenRouter base and nothing else), and the tuple (an OpenRouter run stamps
 * it, every other run stamps exactly what it stamped before the field existed).
 */

import { describe, expect, test } from "bun:test";
import {
  LAB_PROVIDERS,
  authorOf,
  isOpenRouterBase,
  labProvidersOf,
  parseRouting,
  providerBodyOf,
  resolveRouting,
  routingForRun,
  routingLabel,
} from "../src/routing";
import { OpenAiChatAdapter } from "../src/adapter";
import { comparabilityOf, sameComparability } from "../src/comparability";
import { loadRunConfig } from "../src/config";

describe("the default routing", () => {
  test("pins the model author's own provider with fallbacks off", () => {
    expect(resolveRouting(undefined, undefined, "z-ai/glm-5.3")).toEqual({
      order: ["Z.AI"],
      allowFallbacks: false,
    });
  });

  test("names both of a lab's own endpoints when it has two", () => {
    expect(resolveRouting(undefined, undefined, "google/gemini-3.8-flash").order).toEqual([
      "Google",
      "Google AI Studio",
    ]);
  });

  test("pins nothing — but still never falls back — for an author we have no evidence for", () => {
    // `minimax` and `deepseek` have only ever been served here by third
    // parties, so a first-party name would be a guess, and a guess with
    // fallbacks off kills every run of the model.
    expect(resolveRouting(undefined, undefined, "minimax/minimax-m3")).toEqual({ allowFallbacks: false });
    expect(resolveRouting(undefined, undefined, "omen-alpha")).toEqual({ allowFallbacks: false });
  });

  test("every lab name is one this harness has seen OpenRouter report", () => {
    // The table is evidence, not inference: the guard is that it stays small
    // and spelled the way the response bodies spell it.
    for (const [author, names] of Object.entries(LAB_PROVIDERS)) {
      expect(author).toBe(author.toLowerCase());
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n.trim()).toBe(n);
    }
  });

  test("requires the parameter exactly when the run declares an effort", () => {
    expect(resolveRouting(undefined, undefined, "openai/gpt-5.6-sol", { effort: "high" })).toEqual({
      order: ["OpenAI"],
      allowFallbacks: false,
      requireParameters: true,
    });
    expect(resolveRouting(undefined, undefined, "openai/gpt-5.6-sol").requireParameters).toBeUndefined();
  });

  test("an entry's routing wins over the policy's, whole and unmerged", () => {
    const entry = { order: ["Together"], allowFallbacks: true };
    const policy = { order: ["DeepInfra"], allowFallbacks: false, requireParameters: true };
    expect(resolveRouting(entry, policy, "z-ai/glm-5.3")).toEqual(entry);
  });

  test("the policy's routing replaces the lab default when the entry says nothing", () => {
    expect(resolveRouting(undefined, { sort: "throughput", allowFallbacks: true }, "z-ai/glm-5.3")).toEqual({
      sort: "throughput",
      allowFallbacks: true,
    });
  });

  test("authorOf reads the slug prefix and nothing else", () => {
    expect(authorOf("z-ai/glm-5.3")).toBe("z-ai");
    expect(authorOf("Z-AI/glm-5.3")).toBe("z-ai");
    expect(authorOf("omen-alpha")).toBeNull();
    expect(labProvidersOf("nvidia/nemotron-3-ultra-550b-a55b:free")).toEqual(["Nvidia"]);
  });
});

describe("parseRouting", () => {
  test("accepts a name, a list, and the full object", () => {
    expect(parseRouting("Z.AI", "x")).toEqual({ order: ["Z.AI"], allowFallbacks: false });
    expect(parseRouting(["Z.AI", "Together"], "x")).toEqual({ order: ["Z.AI", "Together"], allowFallbacks: false });
    expect(parseRouting({ order: ["Z.AI"], allowFallbacks: true }, "x")).toEqual({
      order: ["Z.AI"],
      allowFallbacks: true,
    });
  });

  test("defaults allowFallbacks to false — routing is pinned unless it says otherwise", () => {
    expect(parseRouting({ sort: "price" }, "x").allowFallbacks).toBe(false);
  });

  test("refuses an unknown key by name", () => {
    expect(() => parseRouting({ only: ["Z.AI"] }, "roster glm")).toThrow(/roster glm: routing has unknown key `only`/);
  });

  test("refuses sort alongside order", () => {
    expect(() => parseRouting({ order: ["Z.AI"], sort: "price" }, "x")).toThrow(/alternatives/);
  });

  test("refuses an empty order, a duplicate provider and a non-sort", () => {
    expect(() => parseRouting({ order: [] }, "x")).toThrow(/non-empty/);
    expect(() => parseRouting({ order: ["Z.AI", "Z.AI"] }, "x")).toThrow(/twice/);
    expect(() => parseRouting({ sort: "vibes" }, "x")).toThrow(/price, throughput, latency/);
  });
});

describe("the request body", () => {
  const CHAT = { id: "gen-1", provider: "Z.AI", model: "z-ai/glm-5.3", choices: [{ message: { content: "ok" } }] };

  function capture(baseUrl: string, routing?: { order?: string[]; allowFallbacks: boolean }) {
    const seen: { body?: Record<string, unknown> } = {};
    const adapter = new OpenAiChatAdapter({
      baseUrl,
      apiKey: "k",
      model: "z-ai/glm-5.3",
      ...(routing !== undefined ? { routing } : {}),
      fetchImpl: (async (_u: string, init: RequestInit) => {
        seen.body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(CHAT), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    return { adapter, seen };
  }

  test("an OpenRouter request carries the provider object in OpenRouter's spelling", async () => {
    const { adapter, seen } = capture("https://openrouter.ai/api/v1", { order: ["Z.AI"], allowFallbacks: false });
    await adapter.complete({ messages: [], tools: [] });
    expect(seen.body?.["provider"]).toEqual({ order: ["Z.AI"], allow_fallbacks: false });
  });

  test("no other host is sent one, whatever the run config says", async () => {
    // A strict OpenAI-compatible server may 400 on a key it does not know, and
    // a direct endpoint has nothing to route between anyway.
    for (const base of ["https://api.cerebras.ai/v1", "https://opencode.ai/zen/v1", "http://192.168.1.20:1234/v1"]) {
      const { adapter, seen } = capture(base, { order: ["Z.AI"], allowFallbacks: false });
      await adapter.complete({ messages: [], tools: [] });
      expect(seen.body).not.toHaveProperty("provider");
    }
  });

  test("an unrouted OpenRouter request carries nothing either", async () => {
    const { adapter, seen } = capture("https://openrouter.ai/api/v1");
    await adapter.complete({ messages: [], tools: [] });
    expect(seen.body).not.toHaveProperty("provider");
  });

  test("providerBodyOf omits what was not asked for", () => {
    expect(providerBodyOf({ allowFallbacks: false })).toEqual({ allow_fallbacks: false });
    expect(providerBodyOf({ sort: "latency", allowFallbacks: true, requireParameters: true })).toEqual({
      sort: "latency",
      allow_fallbacks: true,
      require_parameters: true,
    });
  });

  test("isOpenRouterBase reads the host, not the string", () => {
    expect(isOpenRouterBase("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterBase("https://api.cerebras.ai/v1")).toBe(false);
    expect(isOpenRouterBase(undefined)).toBe(false);
  });

  test("routingLabel says who and whether it may move", () => {
    expect(routingLabel({ order: ["Z.AI", "Together"], allowFallbacks: true })).toBe("Z.AI > Together (fallbacks on)");
    expect(routingLabel({ allowFallbacks: false })).toBe("provider default");
  });
});

describe("the comparability tuple", () => {
  function config(over: Record<string, unknown> = {}) {
    return loadRunConfig({ runId: "r", token: "t".repeat(32), model: "z-ai/glm-5.3", ...over });
  }

  test("an OpenRouter run stamps the routing it was sent with", () => {
    const t = comparabilityOf(config({ apiBase: "https://openrouter.ai/api/v1" }), "harness-0.5-1");
    expect(t.routing).toEqual({ order: ["Z.AI"], allowFallbacks: false });
  });

  test("two runs of one slug on two providers are not comparable", () => {
    const a = comparabilityOf(config({ apiBase: "https://openrouter.ai/api/v1" }), "harness-0.5-1");
    const b = comparabilityOf(
      config({ apiBase: "https://openrouter.ai/api/v1", routing: { order: ["Together"], allowFallbacks: false } }),
      "harness-0.5-1",
    );
    expect(sameComparability(a, b)).toBe(false);
  });

  test("a run whose endpoint has one backend omits the field entirely", () => {
    // Not `null`: an absent key is what every tuple stamped before this
    // existed, so nothing in flight on Cerebras, LM Studio, OpenCode Zen or a
    // CLI restamps on resume for a fact that did not change.
    for (const apiBase of ["https://api.cerebras.ai/v1", "https://opencode.ai/zen/v1", undefined]) {
      const t = comparabilityOf(config(apiBase === undefined ? {} : { apiBase }), "harness-0.5-1");
      expect(t).not.toHaveProperty("routing");
    }
  });

  test("routingForRun refuses to invent routing for a non-aggregator", () => {
    expect(routingForRun({ apiBase: "https://api.cerebras.ai/v1", model: "qwen-3.8-27b" })).toBeNull();
    expect(routingForRun({ apiBase: "https://openrouter.ai/api/v1" })).toBeNull();
  });
});
