/**
 * The typed client. What is worth pinning is the contract, not the fetch:
 * that every method is a GET, that paths are root-relative so the same code
 * works behind the dev proxy and same-origin off the viewer, that a run id is
 * encoded rather than interpolated, and that a non-2xx becomes an `ApiError`
 * carrying the status a page needs to tell 404 from 500.
 *
 * The typing is checked by construction: the responses below are declared as
 * the shared wire types from `runner/viewer/api-types.ts`, so a drift between
 * the viewer's shapes and the client's is a compile error, not a runtime one.
 */

import { describe, expect, test } from "bun:test";
import type { FleetResponse, RunsResponse } from "../../runner/viewer/api-types";
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
      "/api/run/r1/entries?limit=200",
    ]);
  });

  test("the episode filter travels in the query, and is omitted when unset", async () => {
    const s = stub({ runs: [] });
    const c = createClient({ fetch: s.fetch });
    await c.episodes();
    await c.eval();
    await c.eval("e360");
    await c.eval("all");
    await c.ladder("e90", true);
    expect(s.calls.map((x) => x.url)).toEqual([
      "/api/episodes",
      // No param at all: the server's own default (e90) is the one default.
      "/api/eval",
      "/api/eval?episode=e360",
      "/api/eval?episode=all",
      "/api/ladder?episode=e90&includeOverrides=1",
    ]);
    expect(s.calls.every((x) => x.method === "GET")).toBe(true);
  });

  test("a run id is encoded, never interpolated raw", async () => {
    const s = stub({});
    const c = createClient({ fetch: s.fetch });
    await c.run("../../etc/passwd");
    expect(s.calls[0]!.url).toBe("/api/run/..%2F..%2Fetc%2Fpasswd");
    expect(s.calls[0]!.url).not.toContain("/etc/");
  });

  test("windowing passes from and limit through", async () => {
    const s = stub({ from: 0, total: 0, entries: [] });
    const c = createClient({ fetch: s.fetch });
    await c.entries("r1", 40, 60);
    expect(s.calls[0]!.url).toBe("/api/run/r1/entries?limit=60&from=40");
  });

  test("a base prefix is honoured, for a viewer reached elsewhere", async () => {
    const s = stub({});
    await createClient({ fetch: s.fetch, base: "http://127.0.0.1:8091" }).runs();
    expect(s.calls[0]!.url).toBe("http://127.0.0.1:8091/api/runs");
  });

  test("the stream URL is derived, not fetched", () => {
    expect(createClient().streamUrl("a b")).toBe("/api/run/a%20b/stream");
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

  test("a non-JSON error body still produces a status, not a parse crash", async () => {
    const c = createClient({ fetch: stub("<html>gateway</html>", 502).fetch });
    const err = (await c.runs().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
  });
});

describe("shapes", () => {
  test("a run listing round-trips as the shared wire type", async () => {
    const payload: RunsResponse = {
      runs: [
        {
          runId: "r1", model: "m", driver: "openai", adapter: "openai", harness: "wrathbench", shakeout: null, objective: null,
          comparability: null,
          character: "Chr", platform: "openrouter", apiBase: null, harnessVersion: "harness-0.2",
          startedAt: 1, endedAt: null, terminationReason: null, terminationDetail: null,
          pauseReason: null, level: 4, xp: 10, money: 0, questsCompleted: 2, mtime: 5,
          bytes: 9, live: true, tokens: null, cost: null, firstTs: 1, lastTs: 2, playtimeMs: 1,
          modelResponses: 3, stillborn: false,
        },
      ],
      includeStillborn: false,
      stillbornExcluded: 2,
    };
    const got = await createClient({ fetch: stub(payload).fetch }).runs();
    expect(got.runs[0]!.level).toBe(4);
    // A recorded zero is a value, not a gap: it must survive the round trip.
    expect(got.runs[0]!.money).toBe(0);
  });

  test("an absent fleet reads as present:false with no lanes", async () => {
    const payload: FleetResponse = { present: false, lanes: [], now: 1 };
    const got = await createClient({ fetch: stub(payload).fetch }).fleet();
    expect(got.present).toBe(false);
    expect(got.lanes).toHaveLength(0);
  });
});
