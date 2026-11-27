/**
 * The config write client.
 *
 * The contract worth pinning: the refusal sentence arrives VERBATIM — the
 * whole point of the API is that a rejected edit carries the sentence
 * `parseFleet` would refuse the file with, and `client.ts`'s `getJson` glues
 * the URL onto it — with its status, a row key's halves are encoded each on
 * its own, and every write says JSON (the viewer's cross-site write guard).
 */

import { describe, expect, test } from "bun:test";
import { ConfigError, createConfigClient } from "../src/api/config-client";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(body: unknown, status = 200): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: f, calls };
}

describe("paths and methods", () => {
  test("a row key's two halves are path segments, each encoded on its own", async () => {
    const s = stub({ key: "roster/a", value: {}, version: 2 });
    const c = createConfigClient({ fetch: s.fetch });
    await c.patch("roster/qwen3.8:27b", { tier: "t1" });
    expect(s.calls[0]?.url).toBe("/api/config/roster/qwen3.8%3A27b");
    expect(s.calls[0]?.method).toBe("PATCH");
  });

  test("every write says JSON, with a body or without — the viewer refuses an unsafe method that does not", async () => {
    const s = stub({ key: "roster/a", value: null, version: 1 });
    const c = createConfigClient({ fetch: s.fetch });
    await c.patch("roster/a", { tier: "t1" });
    await c.put("policy", {});
    await c.remove("roster/a");
    await c.export();
    await c.fetchDrafts();
    await c.ignoreDraft("vendor/x");
    await c.unignoreDraft("vendor/x");
    await c.promoteDraft({ model: "vendor/x", name: "x", tier: "t0" });
    expect(s.calls.map((x) => [x.method, x.headers["content-type"]])).toEqual([
      ["PATCH", "application/json"],
      ["PUT", "application/json"],
      ["DELETE", "application/json"],
      ["POST", "application/json"],
      ["POST", "application/json"],
      ["POST", "application/json"],
      ["POST", "application/json"],
      ["POST", "application/json"],
    ]);
    // A read stays a plain GET: nothing to guard, and no reason to preflight.
    await c.config();
    expect(s.calls.at(-1)?.headers["content-type"]).toBeUndefined();
  });
});

describe("refusals", () => {
  test("the server's sentence comes back verbatim, with nothing prepended", async () => {
    const sentence = "roster.x: tier must be one of t0, t1, t2";
    const s = stub({ error: sentence, key: "roster/x" }, 400);
    const c = createConfigClient({ fetch: s.fetch });
    const err = await c.patch("roster/x", { tier: "t9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe(sentence);
    expect((err as ConfigError).status).toBe(400);
  });
});
