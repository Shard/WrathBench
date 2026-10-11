/**
 * The viewer's write guard (`runner/viewer/write-guard.ts`): an unsafe method
 * from anywhere but the viewer's own pages is refused before any route runs,
 * on every path, and the dashboard's own writes — same origin, JSON — pass.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { writeGuard } from "../viewer/write-guard";
import { ConfigStore } from "../src/config-store";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GLM = { tier: "t1", model: "z-ai/glm-5.2:free" };

function fixture(publicMode = false): { handle: ReturnType<typeof createApi>; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "write-guard-"));
  roots.push(root);
  const dbPath = join(root, "config.sqlite");
  const store = new ConfigStore(dbPath);
  store.seed({ accounts: { pool: ["RUNNER"] }, roster: { glm: GLM }, queue: [] });
  store.close();
  return { handle: createApi({ runsDir: join(root, "runs"), tilesDir: join(root, "tiles"), configDbPath: dbPath, ...(publicMode ? { publicMode: true } : {}) }), dbPath };
}

function stored(dbPath: string): unknown {
  const store = new ConfigStore(dbPath, { readonly: true });
  try {
    return store.get("roster/glm");
  } finally {
    store.close();
  }
}

/** A tier edit, the way the viewer would see it arrive: behind the TLS ingress, the request is http and the browser's origin https. */
function edit(headers: Record<string, string>, method = "PATCH"): Request {
  return new Request("http://viewer.lan/api/config/roster/glm", { method, headers, body: JSON.stringify({ tier: "t2" }) });
}

describe("the dashboard's own writes pass", () => {
  test("same host, JSON — through the ingress (https origin, http request) and without an Origin at all", async () => {
    const { handle, dbPath } = fixture();
    const viaIngress = await handle(edit({ "content-type": "application/json", origin: "https://viewer.lan", "sec-fetch-site": "same-origin" }));
    expect(viaIngress.status).toBe(200);
    expect(stored(dbPath)).toEqual({ ...GLM, tier: "t2" });
    // A dev server or proxy that rewrote Host but forwarded the original.
    const proxied = new Request("http://127.0.0.1:8090/api/config/roster/glm", {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=utf-8", origin: "http://localhost:5173", "x-forwarded-host": "localhost:5173" },
      body: JSON.stringify({ tier: "t1" }),
    });
    expect((await handle(proxied)).status).toBe(200);
    // A non-browser client (the operator's curl) sends no Origin and no fetch metadata.
    const curl = await handle(edit({ "content-type": "application/json" }));
    expect(curl.status).toBe(200);
  });

  test("reads are never refused, whatever they carry", async () => {
    const { handle } = fixture();
    const res = await handle(new Request("http://viewer.lan/api/config", { headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(200);
  });
});

describe("anything else is refused before a route runs, and nothing is written", () => {
  test("a text/plain or form write — the shapes a page on another site can send without a preflight", async () => {
    const { handle, dbPath } = fixture();
    for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await handle(edit({ "content-type": type }));
      expect([type, res.status]).toEqual([type, 415]);
    }
    // A bare body defaults to text/plain: the cross-site shape exactly.
    expect((await handle(new Request("http://viewer.lan/api/config/roster/glm", { method: "PUT", body: JSON.stringify(GLM) }))).status).toBe(415);
    // A bodyless write still has to say JSON.
    expect((await handle(new Request("http://viewer.lan/api/config/roster/glm", { method: "DELETE" }))).status).toBe(415);
    expect((await handle(new Request("http://viewer.lan/api/config/proposed/fetch", { method: "POST" }))).status).toBe(415);
    expect(stored(dbPath)).toEqual(GLM);
  });

  test("another origin, an opaque one, or a cross-site fetch — even as JSON", async () => {
    const { handle, dbPath } = fixture();
    for (const headers of <Record<string, string>[]>[
      { "content-type": "application/json", origin: "https://elsewhere.example" },
      { "content-type": "application/json", origin: "https://viewer.lan.elsewhere.example" },
      { "content-type": "application/json", origin: "https://viewer.lan:8443" },
      { "content-type": "application/json", origin: "null" },
      { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      { "content-type": "application/json", origin: "https://viewer.lan", "sec-fetch-site": "cross-site" },
    ]) {
      const res = await handle(edit(headers));
      expect([headers, res.status]).toEqual([headers, 403]);
    }
    expect(stored(dbPath)).toEqual(GLM);
  });

  test("every unsafe method on every path, not only the config routes", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/api/config/roster/glm", "/api/runs", "/api/run/x", "/", "/tiles/x.png"]) {
        const res = writeGuard(new Request(`http://viewer.lan${path}`, { method, headers: { "content-type": "text/plain" }, body: "{}" }));
        expect([method, path, res?.status]).toEqual([method, path, 415]);
      }
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(writeGuard(new Request("http://viewer.lan/api/config", { method }))).toBeNull();
  });

  test("a public handle keeps its 404: it has no write route, and a refusal would say it had one", async () => {
    const { handle } = fixture(true);
    const res = await handle(new Request("http://viewer.lan/api/config/roster/glm", { method: "PUT", body: "{}" }));
    expect(res.status).toBe(404);
  });
});
