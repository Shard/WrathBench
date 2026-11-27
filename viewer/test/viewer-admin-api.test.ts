/**
 * The admin API's status route (viewer/admin-api.ts): mounted only with
 * the admin switch, read-only, and about credentials it says only what it can
 * know — a variable's name, whether the supervisor has it set while it is up
 * to say so, and whether the chart hands it to the model pods. Never a value.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../api";
import type { AdminResponse } from "../api-types-admin";
import { ConfigStore } from "../../runner/src/config-store";

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
    // Each one's health, derived from the same state: or-1 is fine, or-2 is switched off (and unset, and failing auth).
    expect(body.credentials.map((c) => [c.id, c.health?.state, c.fix?.kind ?? null])).toEqual([
      ["or-1", "ok", null],
      ["or-2", "disabled", "enable"],
    ]);
    // Nothing a body carries is a value: the fixture has none to leak, and the shape has no field for one.
    expect(JSON.stringify(body)).not.toMatch(/sk-|Bearer/);
  });
});

describe("a credential written from the admin page", () => {
  test("names only its provider's own variable: never the module's secret, the bucket's or another provider's", async () => {
    const { handle } = fixture();
    const put = async (provider: string, secretEnv: string): Promise<number> =>
      (
        await handle(
          new Request("http://x/api/config/credentials/x1", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider, secretEnv, slots: 1, billing: "paid", enabled: false }),
          }),
        )
      ).status;
    for (const [provider, env] of [
      ["openrouter", "WRATHBENCH_MODULE_SECRET"],
      ["openrouter", "S3_SECRET_ACCESS_KEY"],
      ["claude", "OPENROUTER_KEY"],
      ["chatgpt", "WRATHBENCH_DB_PASSWORD"],
    ] as const) {
      expect([provider, env, await put(provider, env)]).toEqual([provider, env, 400]);
    }
    expect(await put("openrouter", "OPENROUTER_KEY_9")).toBe(200);
  });
});
