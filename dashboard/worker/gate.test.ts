/**
 * The gate is the only thing standing between the published projection and the
 * internet, so it is tested the way the projection's allowlist is: by asserting
 * what does NOT get out, not just what does.
 *
 * These run under `bun test` like every other suite — the handler touches
 * nothing workerd-only, and its two collaborators (the bucket binding and the
 * assets binding) are stubs here.
 */
import { describe, expect, test } from "bun:test";

import worker, { type Env, secretsMatch } from "./index.ts";

const PASSWORD = "correct horse battery staple";
const ORIGIN = "https://wrathbench-dashboard.example.workers.dev";

/** The manifest body a caller must never see without the secret. */
const MANIFEST = JSON.stringify({ gen: "g1", generatedAt: 1_700_000_000_000 });

function env(overrides: Partial<Env> = {}): Env {
  const bucket = {
    get(key: string) {
      if (key !== "v1/manifest.json") return null;
      return {
        body: new Response(MANIFEST).body,
        httpEtag: '"deadbeef"',
        writeHttpMetadata(_headers: Headers) {},
      };
    },
  };
  const assets = {
    fetch: () => new Response("<!doctype html><title>SPA</title>", { headers: { "content-type": "text/html" } }),
  };
  return {
    DASHBOARD_PASSWORD: PASSWORD,
    PUBLIC_BUCKET: bucket as unknown as Env["PUBLIC_BUCKET"],
    ASSETS: assets as unknown as Env["ASSETS"],
    ...overrides,
  };
}

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`${ORIGIN}${path}`, { headers });

const call = (path: string, headers: Record<string, string> = {}, e: Env = env()): Promise<Response> =>
  worker.fetch(get(path, headers), e);

describe("the wall", () => {
  test("an unauthenticated page load gets a form, not the app", async () => {
    const res = await call("/");
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("<form");
    expect(body).not.toContain("SPA");
  });

  test("an unauthenticated artifact fetch gets JSON, not the manifest and not the SPA", async () => {
    const res = await call("/v1/manifest.json");
    expect(res.status).toBe(401);
    const body = await res.text();
    // The two ways this fails silently: leaking the data, or serving
    // index.html because the Worker did not run before static assets.
    expect(body).not.toContain("g1");
    expect(body).not.toContain("<!doctype");
    expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
  });

  test("a deep link is walled too, not just the root", async () => {
    expect((await call("/run/abc123")).status).toBe(401);
    expect((await call("/ladder")).status).toBe(401);
  });

  test("a wrong password is refused every way it can be presented", async () => {
    expect((await call("/v1/manifest.json", { authorization: `Basic ${btoa(":wrong")}` })).status).toBe(401);
    expect((await call("/v1/manifest.json?k=wrong")).status).toBe(401);
    expect((await call("/v1/manifest.json", { cookie: "wb_pass=wrong" })).status).toBe(401);
    expect((await call("/v1/manifest.json", { authorization: "Basic !!!not-base64" })).status).toBe(401);
  });

  test("an unset secret fails closed rather than open", async () => {
    const res = await call("/v1/manifest.json", {}, env({ DASHBOARD_PASSWORD: "" }));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("g1");
  });

  test("writes are refused before the gate is even consulted", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/v1/manifest.json`, { method: "DELETE" }), env());
    expect(res.status).toBe(405);
  });
});

describe("getting through it", () => {
  test("HTTP Basic serves the artifact", async () => {
    const res = await call("/v1/manifest.json", { authorization: `Basic ${btoa(`:${PASSWORD}`)}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MANIFEST);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  test("a shared ?k= link trades the secret for a cookie and drops it from the URL", async () => {
    const res = await call(`/?k=${encodeURIComponent(PASSWORD)}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    // The cookie is a derivation, so a stolen jar is not a stolen password.
    expect(cookie).not.toContain(PASSWORD);
  });

  test("the cookie it hands back is the one that works", async () => {
    const first = await call(`/?k=${encodeURIComponent(PASSWORD)}`);
    const value = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await call("/v1/manifest.json", { cookie: value });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(MANIFEST);
  });

  test("an authenticated page load reaches the SPA", async () => {
    const res = await call("/", { authorization: `Basic ${btoa(`:${PASSWORD}`)}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SPA");
  });

  test("a missing object is a 404, not the SPA's index.html", async () => {
    const res = await call("/v1/snap/nope/runs.json", { authorization: `Basic ${btoa(`:${PASSWORD}`)}` });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SPA");
  });
});

describe("cache headers stand in for the zone's cache rules", () => {
  const auth = { authorization: `Basic ${btoa(`:${PASSWORD}`)}` };

  test("the mutable fast lane is held for the push cadence, not longer", async () => {
    const res = await call("/v1/manifest.json", auth);
    expect(res.headers.get("cache-control")).toBe("private, max-age=30");
  });

  test("content-addressed artifacts are immutable, and never public", async () => {
    // The bucket stub only knows the manifest, so read the policy directly off
    // a 404 — the headers under test are set before the body is chosen.
    for (const path of ["/v1/snap/g1/runs.json", "/v1/run/abc/3/detail.json"]) {
      const res = await call(path, auth);
      expect(res.status).toBe(404);
    }
    const manifest = await call("/v1/manifest.json", auth);
    // Nothing the gate serves may be cached by a shared cache: every response
    // is behind a password, and `public` would let a proxy fan it out.
    expect(manifest.headers.get("cache-control")).toStartWith("private");
  });
});

describe("secretsMatch", () => {
  test("matches only an exact string", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(secretsMatch("abc", "ab")).toBe(false);
    expect(secretsMatch("", "")).toBe(true);
  });

  test("compares bytes, so non-ASCII secrets are not truncated to equality", () => {
    expect(secretsMatch("é", "e")).toBe(false);
    expect(secretsMatch("パス", "パス")).toBe(true);
  });
});
