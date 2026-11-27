/**
 * The typed client. What is worth pinning is the contract, not the fetch:
 * that every method is a GET, that paths are root-relative so the same code
 * works behind the dev proxy and same-origin off the viewer, that a run id is
 * encoded rather than interpolated, that a non-2xx becomes an `ApiError`
 * carrying the status a page needs to tell 404 from 500, and that the memo
 * never holds a failure.
 */

import { describe, expect, test } from "bun:test";
import type { RunsResponse } from "../../viewer/api-types";
import { ApiError, createClient } from "../src/api/client";

interface Call {
  url: string;
  method: string;
}

function stub(body: unknown, status = 200): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: f, calls };
}

describe("paths", () => {
  test("every read is a GET against a root-relative path", async () => {
    const s = stub({ runs: [] });
    const c = createClient({ fetch: s.fetch });
    await c.info();
    await c.runs();
    await c.positions();
    await c.fleet();
    await c.run("r1");
    await c.entries("r1");
    expect(s.calls.map((x) => x.method)).toEqual(["GET", "GET", "GET", "GET", "GET", "GET"]);
    expect(s.calls.map((x) => x.url)).toEqual([
      "/api/info",
      "/api/runs",
      "/api/positions",
      "/api/fleet",
      "/api/run/r1",
      "/api/run/r1/entries?limit=1000",
    ]);
  });

  test("a run id is encoded, never interpolated raw", async () => {
    const s = stub({});
    const c = createClient({ fetch: s.fetch });
    await c.run("../../etc/passwd");
    expect(s.calls[0]!.url).toBe("/api/run/..%2F..%2Fetc%2Fpasswd");
    expect(s.calls[0]!.url).not.toContain("/etc/");
  });
});

describe("errors", () => {
  test("a non-2xx becomes an ApiError carrying the status and the server's message", async () => {
    const c = createClient({ fetch: stub({ error: "no such run: nope" }, 404).fetch });
    await expect(c.run("nope")).rejects.toThrow(ApiError);
    const err = (await c.run("nope").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(404);
    expect(err.message).toContain("no such run");
  });
});

/**
 * The memo. Same shape as the snapshot client's (`snapshot-client.test.ts`
 * pins that one), because it is the same memo — page flips on the live path
 * were refetching a megabyte of listing on every mount, and the several feeds
 * a page mounts all fire their first request in the same tick.
 */
describe("the memo", () => {
  test("a repeated read inside the window is served from memory", async () => {
    const s = stub({ runs: [] } satisfies RunsResponse);
    let clock = 0;
    const c = createClient({ fetch: s.fetch, now: () => clock, ttlMs: 4_000 });
    await c.runs();
    clock = 3_999;
    await c.runs();
    expect(s.calls).toHaveLength(1);
    // On the window's edge the entry has expired, so the poll gets a fresh body.
    clock = 4_000;
    await c.runs();
    expect(s.calls).toHaveLength(2);
  });

  test("concurrent callers share one request rather than racing", async () => {
    const s = stub({ runs: [] });
    const c = createClient({ fetch: s.fetch, now: () => 0 });
    await Promise.all([c.runs(), c.runs(), c.results("all")]);
    expect(s.calls).toHaveLength(2);
  });

  test("a failed fetch is not remembered: the next poll is the retry", async () => {
    const s = stub({ error: "boom" }, 500);
    const c = createClient({ fetch: s.fetch, now: () => 0 });
    await expect(c.runs()).rejects.toThrow(ApiError);
    await expect(c.runs()).rejects.toThrow(ApiError);
    // Two attempts, not one attempt and a remembered failure holding the
    // window: a blip must not outlive the request that hit it.
    expect(s.calls).toHaveLength(2);
  });
});
