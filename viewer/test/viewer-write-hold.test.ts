/**
 * The admin write hold (`viewer/write-hold.ts`): while the viewer runs a
 * different build from the fleet, as after a viewer release, every admin write
 * is refused with its reason and nothing reaches the store, while every read,
 * the export included, is served. Builds that agree, or a viewer that cannot
 * name one of them (compose, a hand-run viewer), hold nothing.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../api";
import type { AdminResponse } from "../api-types";
import { heldWrite, writeHoldFromEnv } from "../write-hold";
import { ConfigStore } from "../../runner/src/config-store";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GLM = { tier: "t1", model: "z-ai/glm-5.2:free" };
const VIEWER = "harness-0.9-17-gbbbbbbb";
const FLEET = "harness-0.9-10-gaaaaaaa";

function fixture(env: Record<string, string | undefined>): { handle: ReturnType<typeof createApi>; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "write-hold-"));
  roots.push(root);
  const dbPath = join(root, "config.sqlite");
  const store = new ConfigStore(dbPath);
  store.seed({ accounts: { pool: ["RUNNER"] }, roster: { glm: GLM }, queue: [] });
  store.close();
  const handle = createApi({ runsDir: join(root, "runs"), tilesDir: join(root, "tiles"), configDbPath: dbPath, admin: true, writeHold: writeHoldFromEnv(env) });
  return { handle, dbPath };
}

const SKEWED = { WRATHBENCH_BUILD_VERSION: VIEWER, WRATHBENCH_HARNESS_VERSION: FLEET };

function call(handle: ReturnType<typeof createApi>, method: string, path: string, body?: unknown): Promise<Response> {
  return handle(
    new Request(`http://viewer.lan${path}`, {
      method,
      headers: { "content-type": "application/json", origin: "https://viewer.lan" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function stored(dbPath: string): unknown {
  const store = new ConfigStore(dbPath, { readonly: true });
  try {
    return store.get("roster/glm");
  } finally {
    store.close();
  }
}

describe("the hold the environment implies", () => {
  test("only both builds named and different", () => {
    expect(writeHoldFromEnv(SKEWED)).toMatchObject({ viewer: VIEWER, fleet: FLEET });
    expect(writeHoldFromEnv({ WRATHBENCH_BUILD_VERSION: FLEET, WRATHBENCH_HARNESS_VERSION: FLEET })).toBeNull();
    // Outside the cluster image the build is empty (compose, a hand-run serve.ts): no fleet build to be ahead of.
    expect(writeHoldFromEnv({ WRATHBENCH_HARNESS_VERSION: FLEET })).toBeNull();
    expect(writeHoldFromEnv({ WRATHBENCH_BUILD_VERSION: "  ", WRATHBENCH_HARNESS_VERSION: FLEET })).toBeNull();
    expect(writeHoldFromEnv({ WRATHBENCH_BUILD_VERSION: VIEWER })).toBeNull();
    expect(writeHoldFromEnv({})).toBeNull();
  });

  test("the reason names both builds and where to write instead", () => {
    const why = writeHoldFromEnv(SKEWED)!.why;
    expect(why).toContain(VIEWER);
    expect(why).toContain(FLEET);
    expect(why).toContain("bun wb config");
  });

  test("only the admin surfaces' unsafe methods are held, the export aside", () => {
    const hold = writeHoldFromEnv(SKEWED);
    for (const [method, path] of [
      ["PATCH", "/api/config/roster/glm"],
      ["PUT", "/api/config/site"],
      ["DELETE", "/api/config/roster/glm"],
      ["POST", "/api/config/proposed/promote"],
      ["PUT", "/api/admin/secrets/OPENROUTER_KEY"],
      ["POST", "/api/admin/codex-login/chatgpt-1"],
    ]) {
      expect([method, path, heldWrite(hold, method!, path!)?.status]).toEqual([method, path, 409]);
    }
    for (const [method, path] of [
      ["GET", "/api/config"],
      ["HEAD", "/api/admin"],
      ["POST", "/api/config/export"],
      ["POST", "/api/configuration"],
      ["POST", "/api/other"],
    ]) {
      expect([method, path, heldWrite(hold, method!, path!)]).toEqual([method, path, null]);
    }
    expect(heldWrite(null, "PATCH", "/api/config/roster/glm")).toBeNull();
  });
});

describe("a viewer ahead of the fleet", () => {
  test("refuses a config write with the reason and writes nothing", async () => {
    const { handle, dbPath } = fixture(SKEWED);
    const res = await call(handle, "PATCH", "/api/config/roster/glm", { tier: "t2" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; held: { viewer: string; fleet: string } };
    expect(body.error).toContain("admin writes are held");
    expect(body.held).toEqual({ viewer: VIEWER, fleet: FLEET });
    expect(stored(dbPath)).toEqual(GLM);
  });

  test("refuses a secret and a Codex login request before the admin routes see them", async () => {
    const { handle } = fixture(SKEWED);
    expect((await call(handle, "PUT", "/api/admin/secrets/OPENROUTER_KEY", { value: "x" })).status).toBe(409);
    expect((await call(handle, "POST", "/api/admin/codex-login/chatgpt-1")).status).toBe(409);
  });

  test("serves every read, the export included, and says on /api/admin why writes are held", async () => {
    const { handle } = fixture(SKEWED);
    expect((await call(handle, "GET", "/api/config")).status).toBe(200);
    expect((await call(handle, "POST", "/api/config/export")).status).toBe(200);
    const admin = await call(handle, "GET", "/api/admin");
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as AdminResponse;
    expect(body.writes.ok).toBe(false);
    expect(body.writes.ok === false ? body.writes.why : "").toContain(VIEWER);
  });
});

describe("a viewer on the fleet's build", () => {
  test("writes as ever, and /api/admin says so", async () => {
    for (const env of [{ WRATHBENCH_BUILD_VERSION: FLEET, WRATHBENCH_HARNESS_VERSION: FLEET }, { WRATHBENCH_HARNESS_VERSION: FLEET }]) {
      const { handle, dbPath } = fixture(env);
      expect((await call(handle, "PATCH", "/api/config/roster/glm", { tier: "t2" })).status).toBe(200);
      expect(stored(dbPath)).toEqual({ ...GLM, tier: "t2" });
      expect(((await (await call(handle, "GET", "/api/admin")).json()) as AdminResponse).writes).toEqual({ ok: true });
    }
  });
});
