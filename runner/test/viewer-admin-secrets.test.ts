/**
 * The admin API's secret and re-auth routes (runner/viewer/admin-api.ts): a
 * secret goes in and never comes out — not in an answer, a refusal, the
 * status route, the config API, the audit, an export or a captured log line.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdminApi } from "../viewer/admin-api";
import { createApi } from "../viewer/api";
import type { AdminResponse } from "../viewer/api-types";
import { codexLoginDir } from "../src/codex-login";
import { ConfigStore } from "../src/config-store";
import { readStoreSecret, STORE_KEY_ENV } from "../src/store-secrets";
import { KEY_HEX, OTHER_KEY_HEX, SENTINEL } from "./fixtures/store-secrets";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const CREDENTIALS = {
  "or-1": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, budget: { kind: "spend", usdPerDay: 5 }, billing: "paid", enabled: true },
  "claude-2": { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", slots: 1, billing: "paid", enabled: true },
  "chatgpt-1": { provider: "chatgpt", secretEnv: "CODEX_HOME", slots: 1, billing: "paid", enabled: true },
};

/** Every line the process logs while a test runs, so a test can say none carried the value. */
let logged: string[] = [];
const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
beforeEach(() => {
  logged = [];
  for (const k of ["log", "error", "warn", "info"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
});
afterEach(() => {
  Object.assign(console, originals);
});

function fixture(o: { key?: string | null; supervisorUp?: boolean } = {}) {
  const root = tempDir("admin-secrets-");
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const dbPath = join(root, "config.sqlite");
  const store = new ConfigStore(dbPath);
  store.seed({ credentials: CREDENTIALS, roster: {}, queue: [] }, { actor: "fixture" });
  store.close();
  if (o.supervisorUp === true) writeFileSync(join(runsDir, "fleet-state.json"), JSON.stringify({ heartbeatAt: Date.now(), credentials: [] }));
  const env: Record<string, string | undefined> = { WRATHBENCH_CONFIG_DB: dbPath, ...(o.key !== null ? { [STORE_KEY_ENV]: o.key ?? KEY_HEX } : {}) };
  const admin = createAdminApi({ groups: { runner: true, evals: true, viewer: true }, runsDir, dbPath, env });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> => {
    const req = new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json", "x-wrathbench-actor": "mark", "x-wrathbench-note": "rotating", ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const res = (await admin(req, new URL(req.url).pathname))!;
    return { status: res.status, text: await res.text() };
  };
  return { root, runsDir, dbPath, env, call };
}

describe("PUT /api/admin/secrets/<NAME>", () => {
  test("stores it sealed; the answer, the status and the history carry no value and no ciphertext", async () => {
    const f = fixture();
    const put = await f.call("PUT", "/api/admin/secrets/OPENROUTER_KEY", { value: SENTINEL });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.text)).toMatchObject({ name: "OPENROUTER_KEY", stored: true });
    expect(readStoreSecret("OPENROUTER_KEY", { env: f.env, dbPath: f.dbPath })).toMatchObject({ status: "ok", value: SENTINEL });

    const status = await f.call("GET", "/api/admin");
    const body = JSON.parse(status.text) as AdminResponse;
    const or1 = body.credentials.find((c) => c.id === "or-1")!;
    expect(or1).toMatchObject({ stored: true, secretSet: true });
    expect(body.storeKey).toEqual({ ok: true });

    const store = new ConfigStore(f.dbPath);
    const sealed = (store.db.query("SELECT sealed FROM config_secrets").get() as { sealed: string }).sealed;
    const audit = store.audit(5);
    const exported = JSON.stringify(store.render());
    store.close();
    expect(audit[0]).toMatchObject({ key: "secrets/OPENROUTER_KEY", actor: "mark", note: "rotating", before: null });
    for (const out of [put.text, status.text, JSON.stringify(audit), exported, logged.join("\n")]) {
      expect(out).not.toContain("SENTINEL");
      expect(out).not.toContain(sealed);
      expect(out).not.toContain(sealed.split(".")[3]!);
    }
  });

  test("the config API never lists or serves one", async () => {
    const f = fixture();
    await f.call("PUT", "/api/admin/secrets/CLAUDE_CODE_OAUTH_TOKEN_2", { value: SENTINEL });
    const handle = createApi({ runsDir: f.runsDir, tilesDir: join(f.root, "tiles"), configDbPath: f.dbPath, moduleUrl: "http://127.0.0.1:1", admin: true });
    for (const path of ["/api/config", "/api/config/audit?limit=50", "/api/config/secrets/CLAUDE_CODE_OAUTH_TOKEN_2"]) {
      const text = await (await handle(new Request(`http://x${path}`))).text();
      expect(text).not.toContain("SENTINEL");
      expect(text).not.toContain("v1.");
    }
    const exported = await (await handle(new Request("http://x/api/config/export", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).text();
    expect(exported).not.toContain("SENTINEL");
    expect(exported).not.toContain("config_secrets");
  });

  test("refused without a key, writing nothing, and saying why", async () => {
    const f = fixture({ key: null });
    const put = await f.call("PUT", "/api/admin/secrets/OPENROUTER_KEY", { value: SENTINEL });
    expect(put.status).toBe(400);
    expect(put.text).toContain("no store key");
    expect(put.text).not.toContain("SENTINEL");
    expect(JSON.parse((await f.call("GET", "/api/admin")).text).storeKey).toMatchObject({ ok: false });
    expect(readStoreSecret("OPENROUTER_KEY", { env: { [STORE_KEY_ENV]: KEY_HEX }, dbPath: f.dbPath })).toEqual({ status: "absent" });
  });

  test("only a variable a credential names, and never a Codex home's", async () => {
    const f = fixture();
    expect((await f.call("PUT", "/api/admin/secrets/LD_PRELOAD", { value: "/tmp/x.so" })).status).toBe(404);
    expect((await f.call("PUT", "/api/admin/secrets/OPENROUTER_KEY_2", { value: SENTINEL })).status).toBe(404);
    expect((await f.call("PUT", "/api/admin/secrets/CODEX_HOME", { value: "/tmp" })).status).toBe(404);
    expect((await f.call("POST", "/api/admin/secrets/OPENROUTER_KEY", { value: SENTINEL })).status).toBe(405);
  });

  test("a refused value is never quoted", async () => {
    const f = fixture();
    for (const body of [{ value: `${SENTINEL}\nNODE_OPTIONS=x` }, { value: "" }, { nope: SENTINEL }, `{"value": "${SENTINEL}`]) {
      const r = await f.call("PUT", "/api/admin/secrets/OPENROUTER_KEY", body);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain("SENTINEL");
    }
    expect((await f.call("PUT", "/api/admin/secrets/OPENROUTER_KEY", { value: "x".repeat(20_000) })).status).toBe(413);
  });

  test("DELETE clears it, and the environment's stands again", async () => {
    const f = fixture();
    await f.call("PUT", "/api/admin/secrets/OPENROUTER_KEY", { value: SENTINEL });
    const del = await f.call("DELETE", "/api/admin/secrets/OPENROUTER_KEY");
    expect(JSON.parse(del.text)).toMatchObject({ name: "OPENROUTER_KEY", stored: false, cleared: true });
    const or1 = (JSON.parse((await f.call("GET", "/api/admin")).text) as AdminResponse).credentials.find((c) => c.id === "or-1")!;
    expect(or1.stored).toBe(false);
    expect(or1.secretSet).toBeNull();
  });

  test("one sealed under another key reads as not set, and says why", async () => {
    const f = fixture({ key: OTHER_KEY_HEX });
    // Written with the other key, read by a viewer holding KEY_HEX.
    await f.call("PUT", "/api/admin/secrets/OPENROUTER_KEY", { value: SENTINEL });
    const g = createAdminApi({ groups: { runner: true, evals: true, viewer: true }, runsDir: f.runsDir, dbPath: f.dbPath, env: { ...f.env, [STORE_KEY_ENV]: KEY_HEX } });
    const body = (await (await g(new Request("http://x/api/admin"), "/api/admin"))!.json()) as AdminResponse;
    const or1 = body.credentials.find((c) => c.id === "or-1")!;
    expect(or1.secretSet).toBe(false);
    expect(or1.health).toMatchObject({ state: "secret-missing" });
    expect(or1.health?.reason).toContain("another store key");
  });

  test("a cross-site write never reaches the route", async () => {
    const f = fixture();
    const handle = createApi({ runsDir: f.runsDir, tilesDir: join(f.root, "tiles"), configDbPath: f.dbPath, moduleUrl: "http://127.0.0.1:1", admin: true });
    const res = await handle(
      new Request("http://x/api/admin/secrets/OPENROUTER_KEY", { method: "PUT", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ value: SENTINEL }) }),
    );
    expect(res.status).toBe(403);
    // And a public handle has no such route at all.
    const pub = createApi({ runsDir: f.runsDir, tilesDir: join(f.root, "tiles"), configDbPath: f.dbPath, moduleUrl: "http://127.0.0.1:1", publicMode: true });
    expect((await pub(new Request("http://x/api/admin/secrets/OPENROUTER_KEY", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(404);
  });
});

describe("a secret replaced since a refusal", () => {
  test("a run paused auth-failed before a key was stored, or before a home logged in again, no longer reads auth-failed", async () => {
    const f = fixture();
    const now = Date.now();
    const st = (id: string, provider: string, secretEnv: string) => ({ id, provider, billing: "paid", enabled: true, secretEnv, secretSet: true, slots: 1, inUse: 0, budget: "no budget", used: null, held: {}, holds: {}, lastError: { reason: "auth-failed", at: now - 60_000 } });
    writeFileSync(join(f.runsDir, "fleet-state.json"), JSON.stringify({ heartbeatAt: now, credentials: [st("or-1", "openrouter", "OPENROUTER_KEY"), st("claude-2", "claude", "CLAUDE_CODE_OAUTH_TOKEN_2"), st("chatgpt-1", "chatgpt", "CODEX_HOME")] }));
    const states = async (): Promise<Record<string, string | undefined>> =>
      Object.fromEntries((JSON.parse((await f.call("GET", "/api/admin")).text) as AdminResponse).credentials.map((c) => [c.id, c.health?.state]));
    expect(await states()).toEqual({ "or-1": "auth-failed", "claude-2": "auth-failed", "chatgpt-1": "auth-failed" });
    await f.call("PUT", "/api/admin/secrets/CLAUDE_CODE_OAUTH_TOKEN_2", { value: SENTINEL });
    const dir = codexLoginDir(f.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "chatgpt-1.state.json"), JSON.stringify({ state: "ok", requestedAt: now - 30_000, at: now - 1_000, actor: "mark" }));
    expect(await states()).toEqual({ "or-1": "auth-failed", "claude-2": "ok", "chatgpt-1": "ok" });
  });
});

describe("POST /api/admin/codex-login/<id>", () => {
  test("leaves a request beside the store for the supervisor, once", async () => {
    const f = fixture({ supervisorUp: true });
    const r = await f.call("POST", "/api/admin/codex-login/chatgpt-1", {});
    expect(r.status).toBe(202);
    const dir = codexLoginDir(f.env);
    expect(dir).toBe(join(f.root, "codex-login"));
    expect(JSON.parse(readFileSync(join(dir, "chatgpt-1.request.json"), "utf8"))).toMatchObject({ actor: "mark" });
    expect((await f.call("POST", "/api/admin/codex-login/chatgpt-1", {})).status).toBe(409);
    const view = (JSON.parse((await f.call("GET", "/api/admin")).text) as AdminResponse).credentials.find((c) => c.id === "chatgpt-1")!;
    expect(view.login).toMatchObject({ state: "requested" });
  });

  test("refused for a credential that is not a Codex home, and with no supervisor up", async () => {
    expect((await fixture({ supervisorUp: true }).call("POST", "/api/admin/codex-login/or-1", {})).status).toBe(400);
    expect((await fixture({ supervisorUp: true }).call("POST", "/api/admin/codex-login/nope", {})).status).toBe(404);
    expect((await fixture().call("POST", "/api/admin/codex-login/chatgpt-1", {})).status).toBe(409);
  });

  test("the waiting link and code reach the page from the supervisor's state", async () => {
    const f = fixture({ supervisorUp: true });
    const dir = codexLoginDir(f.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "chatgpt-1.state.json"),
      JSON.stringify({ state: "waiting", requestedAt: 1, at: 2, actor: "mark", url: "https://auth.openai.com/codex/device", code: "D5L9-SKK60", expiresAt: 3 }),
    );
    const view = (JSON.parse((await f.call("GET", "/api/admin")).text) as AdminResponse).credentials.find((c) => c.id === "chatgpt-1")!;
    expect(view.login).toEqual({ state: "waiting", at: 2, actor: "mark", url: "https://auth.openai.com/codex/device", code: "D5L9-SKK60", expiresAt: 3, detail: null });
    expect(view.stored).toBe(false);
  });
});
