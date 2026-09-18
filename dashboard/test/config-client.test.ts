/**
 * The config write client (item 134).
 *
 * The contract worth pinning: the refusal sentence arrives VERBATIM — the
 * whole point of the API is that a rejected edit carries the sentence
 * `parseFleet` would refuse the file with, and `client.ts`'s `getJson` glues
 * the URL onto it — the status comes with it so the page can tell a refusal
 * from a missing store, the attribution rides as headers, and the export body
 * never names a path (a path makes the server write a file).
 */

import { describe, expect, test } from "bun:test";
import { ACTOR_HEADER, ConfigError, NOTE_HEADER, createConfigClient } from "../src/api/config-client";

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

const ATT = { actor: "mark", note: "promote" };

describe("paths and methods", () => {
  test("a row key's two halves are path segments, each encoded on its own", async () => {
    const s = stub({ key: "roster/a", value: {}, version: 2 });
    const c = createConfigClient({ fetch: s.fetch });
    await c.patch("roster/qwen3.8:27b", { tier: "t1" }, ATT);
    expect(s.calls[0]?.url).toBe("/api/config/roster/qwen3.8%3A27b");
    expect(s.calls[0]?.method).toBe("PATCH");
  });

  test("each verb goes where it says", async () => {
    const s = stub({ config: {}, keys: [], version: 0, path: "x", seeded: false });
    const c = createConfigClient({ fetch: s.fetch });
    await c.config();
    await c.audit(50);
    await c.put("policy", {}, ATT);
    await c.remove("roster/a", ATT);
    await c.export();
    expect(s.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET /api/config",
      "GET /api/config/audit?limit=50",
      "PUT /api/config/policy",
      "DELETE /api/config/roster/a",
      "POST /api/config/export",
    ]);
  });

  test("the export body never names a path — a path makes the SERVER write a file", async () => {
    const s = stub({ path: null, bytes: 3, text: "{}\n" });
    const c = createConfigClient({ fetch: s.fetch });
    await c.export();
    expect(s.calls[0]?.body).toBe("{}");
  });
});

describe("attribution", () => {
  test("actor and note ride as the headers the API reads them from", async () => {
    const s = stub({ key: "policy", value: {}, version: 1 });
    const c = createConfigClient({ fetch: s.fetch });
    await c.put("policy", { a: 1 }, ATT);
    expect(s.calls[0]?.headers[ACTOR_HEADER]).toBe("mark");
    expect(s.calls[0]?.headers[NOTE_HEADER]).toBe("promote");
    expect(s.calls[0]?.headers["content-type"]).toBe("application/json");
  });

  test("a read carries no attribution and no body", async () => {
    const s = stub({ config: {}, keys: [], version: 0, path: "x", seeded: true });
    const c = createConfigClient({ fetch: s.fetch });
    await c.config();
    expect(s.calls[0]?.headers[ACTOR_HEADER]).toBeUndefined();
    expect(s.calls[0]?.body).toBeUndefined();
  });
});

describe("refusals", () => {
  test("the server's sentence comes back verbatim, with nothing prepended", async () => {
    const sentence = "roster.x: tier must be one of t0, t1, t2";
    const s = stub({ error: sentence, key: "roster/x" }, 400);
    const c = createConfigClient({ fetch: s.fetch });
    const err = await c.patch("roster/x", { tier: "t9" }, ATT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe(sentence);
    expect((err as ConfigError).status).toBe(400);
  });

  test("the status tells a refusal from an unseeded store from a route that is not mounted", async () => {
    for (const [status, body] of [
      [409, { error: "no config store at /x — seed it first" }],
      [404, { error: "not found" }],
    ] as [number, unknown][]) {
      const c = createConfigClient({ fetch: stub(body, status).fetch });
      const err = (await c.config().catch((e: unknown) => e)) as ConfigError;
      expect(err.status).toBe(status);
    }
  });

  test("a non-JSON error body still errors, with the status as the sentence", async () => {
    const f = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof globalThis.fetch;
    const c = createConfigClient({ fetch: f });
    const err = (await c.config().catch((e: unknown) => e)) as ConfigError;
    expect(err.status).toBe(502);
    expect(err.message).toBe("502");
  });
});
