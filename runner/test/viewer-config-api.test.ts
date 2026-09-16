/**
 * The config API (item 127): what it serves, what it refuses, and the one
 * thing it must never do — appear at all on a public handle.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { ACTOR_HEADER, NOTE_HEADER } from "../viewer/config-api";
import { ConfigStore } from "../src/config-store";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CONFIG = {
  _notes: ["n"],
  accounts: { pool: ["RUNNER", "RUNNER2"] },
  roster: {
    glm: { tier: "t1", model: "z-ai/glm-5.2:free" },
    son: { tier: "t1", model: "sonnet", driver: "claude-code" },
  },
  policy: { maxConcurrent: { openrouter: 1 } },
  queue: [],
};

function fixture(opts: { seed?: boolean; publicMode?: boolean } = {}): {
  handle: ReturnType<typeof createApi>;
  dbPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "config-api-"));
  roots.push(root);
  const dbPath = join(root, "config.sqlite");
  if (opts.seed !== false) {
    const store = new ConfigStore(dbPath);
    store.seed(CONFIG, { actor: "fixture" });
    store.close();
  }
  const handle = createApi({
    runsDir: join(root, "runs"),
    tilesDir: join(root, "tiles"),
    configDbPath: dbPath,
    ...(opts.publicMode === true ? { publicMode: true } : {}),
  });
  return { handle, dbPath };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://x${path}`, init);
}

describe("public mode", () => {
  test("every config route 404s on a public handle, read and write alike", async () => {
    const { handle } = fixture({ publicMode: true });
    for (const [method, path] of [
      ["GET", "/api/config"],
      ["GET", "/api/config/roster/glm"],
      ["GET", "/api/config/audit"],
      ["PUT", "/api/config/roster/glm"],
      ["PATCH", "/api/config/roster/glm"],
      ["DELETE", "/api/config/roster/glm"],
      ["POST", "/api/config/export"],
    ] as const) {
      const res = await handle(req(path, { method, body: method === "GET" || method === "DELETE" ? undefined : "{}" }));
      // 404, never 403: a withheld route announces that something is there.
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(await res.json()).toEqual({ error: "no such path" });
    }
  });

  test("a public handle cannot be made to write through the config store", async () => {
    const { handle, dbPath } = fixture({ publicMode: true });
    await handle(req("/api/config/roster/glm", { method: "PUT", body: JSON.stringify({ tier: "t2", model: "x:free" }) }));
    const store = new ConfigStore(dbPath, { readonly: true });
    expect(store.get("roster/glm")).toEqual({ tier: "t1", model: "z-ai/glm-5.2:free" });
    store.close();
  });
});

describe("reads", () => {
  test("GET /api/config serves the whole config, its keys and a version", async () => {
    const { handle, dbPath } = fixture();
    const res = await handle(req("/api/config"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: unknown; keys: string[]; version: number; path: string; seeded: boolean };
    expect(body.config).toEqual(CONFIG);
    expect(body.keys).toContain("roster/glm");
    expect(body.seeded).toBe(true);
    expect(body.path).toBe(dbPath);
    expect(body.version).toBeGreaterThan(0);
  });

  test("GET one key, and 404 for a key that is not there", async () => {
    const { handle } = fixture();
    const hit = (await (await handle(req("/api/config/roster/glm"))).json()) as { value: unknown };
    expect(hit.value).toEqual({ tier: "t1", model: "z-ai/glm-5.2:free" });
    expect((await handle(req("/api/config/roster/nope"))).status).toBe(404);
  });

  test("an unseeded deployment says so rather than creating a store", async () => {
    const { handle, dbPath } = fixture({ seed: false });
    const body = (await (await handle(req("/api/config"))).json()) as { seeded: boolean; keys: string[] };
    expect(body.seeded).toBe(false);
    expect(body.keys).toEqual([]);
    expect(await Bun.file(dbPath).exists()).toBe(false);
  });

  test("a write to an unseeded store is a 409, not an empty config", async () => {
    const { handle } = fixture({ seed: false });
    const res = await handle(req("/api/config/policy", { method: "PUT", body: "{}" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/seed it first/);
  });
});

describe("writes", () => {
  test("PUT replaces a key and records the actor from the header", async () => {
    const { handle, dbPath } = fixture();
    const res = await handle(
      req("/api/config/roster/glm", {
        method: "PUT",
        headers: { [ACTOR_HEADER]: "mark", [NOTE_HEADER]: "promote" },
        body: JSON.stringify({ tier: "t2", model: "z-ai/glm-5.2:free" }),
      }),
    );
    expect(res.status).toBe(200);
    const store = new ConfigStore(dbPath, { readonly: true });
    expect(store.get("roster/glm")).toEqual({ tier: "t2", model: "z-ai/glm-5.2:free" });
    const [latest] = store.audit(1);
    expect(latest?.actor).toBe("mark");
    expect(latest?.note).toBe("promote");
    store.close();
  });

  test("PATCH merges, and the actor defaults to the viewer", async () => {
    const { handle, dbPath } = fixture();
    await handle(req("/api/config/roster/glm", { method: "PATCH", body: JSON.stringify({ tier: "t0" }) }));
    const store = new ConfigStore(dbPath, { readonly: true });
    expect(store.get("roster/glm")).toEqual({ tier: "t0", model: "z-ai/glm-5.2:free" });
    expect(store.audit(1)[0]?.actor).toBe("viewer");
    store.close();
  });

  test("an invalid edit is a 400 carrying the config error, and nothing is written", async () => {
    const { handle, dbPath } = fixture();
    const res = await handle(
      req("/api/config/roster/son", { method: "PUT", body: JSON.stringify({ tier: "t1", model: "sonnet" }) }),
    );
    expect(res.status).toBe(400);
    // The supervisor's own refusal text, word for word.
    expect(((await res.json()) as { error: string }).error).toMatch(/claude models run only via the claude-code driver/);
    const store = new ConfigStore(dbPath, { readonly: true });
    expect(store.get("roster/son")).toEqual({ tier: "t1", model: "sonnet", driver: "claude-code" });
    store.close();
  });

  test("a key the renderer would never emit is refused rather than stored", async () => {
    const { handle } = fixture();
    const res = await handle(req("/api/config/nonsense", { method: "PUT", body: "{}" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/is not a config key/);
  });

  test("a body that is not JSON is a 400, not a 500", async () => {
    const { handle } = fixture();
    const res = await handle(req("/api/config/policy", { method: "PUT", body: "{nope" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("request body is not JSON");
  });

  test("DELETE removes a key; a key that is not there is a 404", async () => {
    const { handle, dbPath } = fixture();
    expect((await handle(req("/api/config/roster/glm", { method: "DELETE" }))).status).toBe(200);
    expect((await handle(req("/api/config/roster/glm", { method: "DELETE" }))).status).toBe(404);
    const store = new ConfigStore(dbPath, { readonly: true });
    expect(store.get("roster/glm")).toBeUndefined();
    store.close();
  });
});

describe("audit and export", () => {
  test("GET /api/config/audit is the change history, newest first", async () => {
    const { handle } = fixture();
    await handle(req("/api/config/roster/glm", { method: "PATCH", headers: { [ACTOR_HEADER]: "mark" }, body: JSON.stringify({ tier: "t2" }) }));
    const body = (await (await handle(req("/api/config/audit?limit=3"))).json()) as {
      audit: { key: string; actor: string; before: unknown; after: unknown }[];
    };
    expect(body.audit[0]?.key).toBe("roster/glm");
    expect(body.audit[0]?.actor).toBe("mark");
    expect((body.audit[0]?.before as { tier: string }).tier).toBe("t1");
    expect((body.audit[0]?.after as { tier: string }).tier).toBe("t2");
  });

  test("POST /api/config/export renders fleet.json's exact shape", async () => {
    const { handle } = fixture();
    const body = (await (await handle(req("/api/config/export", { method: "POST", body: "{}" }))).json()) as {
      path: string | null;
      text: string;
    };
    expect(body.path).toBeNull();
    expect(JSON.parse(body.text)).toEqual(CONFIG);
  });

  test("export writes a file only when the request names one", async () => {
    const { handle } = fixture();
    const root = mkdtempSync(join(tmpdir(), "config-api-export-"));
    roots.push(root);
    const out = join(root, "fleet.json");
    const res = await handle(req("/api/config/export", { method: "POST", body: JSON.stringify({ path: out }) }));
    expect(res.status).toBe(200);
    expect(JSON.parse(await Bun.file(out).text())).toEqual(CONFIG);
  });

  test("a method the route does not take is a 405, not a silent success", async () => {
    const { handle } = fixture();
    expect((await handle(req("/api/config", { method: "PUT", body: "{}" }))).status).toBe(405);
    expect((await handle(req("/api/config/export"))).status).toBe(405);
  });
});
