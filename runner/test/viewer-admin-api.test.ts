/**
 * The admin API's status route (runner/viewer/admin-api.ts): mounted only with
 * the admin switch, read-only, and about credentials it says only what it can
 * know — a variable's name, whether the supervisor has it set while it is up
 * to say so, and whether the chart hands it to the model pods. Never a value.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { credentialViews } from "../viewer/admin-api";
import type { AdminResponse } from "../viewer/api-types";
import { ConfigStore } from "../src/config-store";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const CREDENTIALS = {
  "or-1": { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, budget: { kind: "spend", usdPerDay: 5 }, billing: "paid", enabled: true },
  "or-2": { provider: "openrouter", secretEnv: "OPENROUTER_KEY_2", slots: 1, billing: "paid", enabled: false },
};

function fixture(o: { admin?: boolean; publicMode?: boolean; supervisor?: { heartbeatAt: number; credentials: unknown[] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "admin-api-"));
  roots.push(root);
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const dbPath = join(root, "config.sqlite");
  const store = new ConfigStore(dbPath);
  store.seed({ credentials: CREDENTIALS, roster: {}, queue: [] }, { actor: "fixture" });
  store.close();
  if (o.supervisor !== undefined) writeFileSync(join(runsDir, "fleet-state.json"), JSON.stringify(o.supervisor));
  const handle = createApi({
    runsDir,
    tilesDir: join(root, "tiles"),
    configDbPath: dbPath,
    moduleUrl: "http://127.0.0.1:1",
    admin: o.admin !== false,
    ...(o.publicMode === true ? { publicMode: true } : {}),
  });
  return { handle, runsDir };
}

const get = async (h: ReturnType<typeof createApi>, init: RequestInit = {}): Promise<Response> =>
  await h(new Request("http://x/api/admin", { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }));

describe("GET /api/admin", () => {
  test("not there without the admin switch, nor on a public handle", async () => {
    expect((await get(fixture({ admin: false }).handle)).status).toBe(404);
    expect((await get(fixture({ publicMode: true }).handle)).status).toBe(404);
  });

  test("read-only: a write is refused and pointed at the config API", async () => {
    const res = await get(fixture().handle, { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: string }).error).toContain("/api/config");
  });

  test("with no supervisor up: the store's credentials, their status unknown rather than unset", async () => {
    const body = (await (await get(fixture().handle)).json()) as AdminResponse;
    expect(body.fleet.up).toBe(false);
    expect(body.groups).toEqual({ runner: true, evals: true, viewer: true });
    expect(body.credentials.map((c) => [c.id, c.secretEnv, c.secretSet, c.inUse, c.budget, c.enabled])).toEqual([
      ["or-1", "OPENROUTER_KEY", null, null, "$5/day", true],
      ["or-2", "OPENROUTER_KEY_2", null, null, "no budget", false],
    ]);
    expect(body.providers.map((p) => p.id)).toContain("openrouter");
    expect(body.publishing.last).toBeNull();
  });

  test("with the supervisor up: its word on each variable, joined by id", async () => {
    const now = Date.now();
    const { handle } = fixture({
      supervisor: {
        heartbeatAt: now - 10_000,
        credentials: [
          { id: "or-1", provider: "openrouter", billing: "paid", enabled: true, secretEnv: "OPENROUTER_KEY", secretSet: true, slots: 2, inUse: 1, budget: "$5/day", used: "$1.20 of $5 today", held: {}, lastError: null },
          { id: "or-2", provider: "openrouter", billing: "paid", enabled: false, secretEnv: "OPENROUTER_KEY_2", secretSet: false, slots: 1, inUse: 0, budget: "no budget", used: null, held: {}, lastError: { reason: "auth-failed", at: now - 60_000 } },
        ],
      },
    });
    const body = (await (await get(handle)).json()) as AdminResponse;
    expect(body.fleet.up).toBe(true);
    expect(body.credentials.map((c) => [c.id, c.secretSet, c.inUse, c.used])).toEqual([
      ["or-1", true, 1, "$1.20 of $5 today"],
      ["or-2", false, 0, null],
    ]);
    expect(body.credentials[1]!.lastError?.reason).toBe("auth-failed");
    // Nothing a body carries is a value: the fixture has none to leak, and the shape has no field for one.
    expect(JSON.stringify(body)).not.toMatch(/sk-|Bearer/);
  });

  test("a stale heartbeat is no supervisor: its last word is not passed off as current", async () => {
    const { handle } = fixture({ supervisor: { heartbeatAt: Date.now() - 3_600_000, credentials: [{ id: "or-1", secretEnv: "OPENROUTER_KEY", secretSet: true }] } });
    const body = (await (await get(handle)).json()) as AdminResponse;
    expect(body.fleet.up).toBe(false);
    expect(body.credentials[0]!.secretSet).toBeNull();
  });
});

describe("credentialViews", () => {
  const stored = [
    { id: "a", provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 1, budget: null, billing: "paid" as const, enabled: true },
    { id: "b", provider: "openrouter", secretEnv: "OPENROUTER_KEY_3", slots: 1, budget: null, billing: "paid" as const, enabled: true },
  ];
  test("whether the chart hands each variable to the model pods, when the viewer was told", () => {
    const views = credentialViews({ stored, fleet: {}, up: false, modelKeys: ["OPENROUTER_KEY"] });
    expect(views.map((v) => [v.id, v.deployed])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(credentialViews({ stored, fleet: {}, up: false, modelKeys: null })[0]!.deployed).toBeNull();
  });

  test("a credential renamed since the supervisor's tick reads unknown, not the old variable's answer", () => {
    const views = credentialViews({
      stored,
      fleet: { credentials: [{ id: "a", provider: "openrouter", billing: "paid", enabled: true, secretEnv: "OLD_NAME", secretSet: true, slots: 1, inUse: 0, budget: "no budget", used: null, held: {}, lastError: null }] },
      up: true,
      modelKeys: null,
    });
    expect(views[0]!.secretSet).toBeNull();
  });
});
