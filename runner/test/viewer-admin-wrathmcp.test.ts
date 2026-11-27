/**
 * The admin page's wrath-mcp section (`GET /api/admin`'s `wrathMcp`): the
 * module's `/health` as an allowlist of fields, never the body, and the
 * session store's sessions by viewer id. The viewer has no login, so nothing
 * here may carry a secret: not the port secret, not a lease secret, not a
 * token's fingerprint.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { displayUrl, moduleHealthReader, moduleView } from "../viewer/module-health";
import type { AdminResponse, ApiInfoResponse } from "../viewer/api-types";
import { bareSessionId } from "../src/session-store";

const roots: string[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
afterEach(() => {
  for (const s of servers.splice(0)) void s.stop(true);
});

/** A port secret and a lease secret, as the module's are: 64 hex. */
const PORT_SECRET = "5e".repeat(32);
const LEASE_SECRET = "a7".repeat(32);
const FP_LIVE = "a1b2c3d4e5f60718";
const FP_ENDED = "0f1e2d3c4b5a6978";
const FP_EMPTY = "deadbeefcafe0001";

/** The operator view as PROTOCOL.md shows it, with what a later module might add beside it. */
function healthBody(o: { ok?: boolean } = {}): Record<string, unknown> {
  return {
    ok: o.ok ?? true,
    module: "mod-wrathbench",
    worldStopped: false,
    worldLoaded: o.ok ?? true,
    sessions: 1,
    leases: 2,
    limits: { actionRate: 0, actionBurst: 40, eventsSubscribersPerToken: 4, leases: 1024, connections: 4096, connectionsPerPeer: 0, connectionsPerLease: 0, eventsBacklogBytes: 16777216, futureLimit: 9, nested: { secret: LEASE_SECRET } },
    droppedPackets: 4213,
    droppedPacketsLive: 37,
    droppedByOpcode: { SMSG_POWER_UPDATE: 1400 },
    worldLoad: { creatureSpawns: 130000, dbUptimeS: 86400 },
    build: "harness-0.3-41-g0bfe207",
    startedAtMs: 1_787_400_000_000,
    uptimeMs: 3_600_000,
    protocol: 1,
    // A field no reader knows, and one shaped like what must never leave.
    unknownExtra: "should not pass",
    leaseSecret: LEASE_SECRET,
  };
}

/** A module on a free port: answers `/health` with `status` and `body`, and records the bearer it was sent. */
function fakeModule(o: { status?: number; body?: unknown } = {}): { url: string; bearers: (string | null)[] } {
  const bearers: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      bearers.push(req.headers.get("authorization"));
      return Response.json(o.body ?? healthBody(), { status: o.status ?? 200 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, bearers };
}

function writeSession(store: string, fp: string, o: { now: number; character: string | null; ended: number | null; beat: number | null; version: string; commit?: string }): void {
  const dir = join(store, fp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({
      format: "wrath-session/1",
      id: fp,
      character: o.character === null ? null : { guid: "7", name: o.character, race: 1, class: 1 },
      stack: { version: o.version, ...(o.commit !== undefined ? { commit: o.commit } : {}) },
      module: { build: "b", protocol: 1 },
      owner: "owner-label",
      group: "c0ffee".repeat(2) + "0000",
      started: o.now - 600_000,
      opened: o.now - 600_000,
      ended: o.ended,
    }),
  );
  if (o.beat !== null) writeFileSync(join(dir, "live.json"), JSON.stringify({ ts: o.beat, observed: null, map: 0, x: 0, y: 0, z: 0, o: 0, level: 3, hp: 1, hpMax: 1, zone: 1, area: 1, flags: [], stream: null }));
}

function handle(o: { moduleUrl?: string; sessions?: boolean; groups?: { runner: boolean; evals: boolean; viewer: boolean } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "admin-wrathmcp-"));
  roots.push(root);
  const store = join(root, "sessions");
  if (o.sessions === true) {
    const now = Date.now();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    writeSession(store, FP_LIVE, { now, character: "Bramblewick", ended: null, beat: now - 5_000, version: "0.2.0", commit });
    writeSession(store, FP_ENDED, { now, character: "Thornquill", ended: now - 60_000, beat: now - 60_000, version: "0.1.0" });
    // A server start that never reached the world: not counted, as the runs page does not list it.
    writeSession(store, FP_EMPTY, { now, character: null, ended: null, beat: now - 1_000, version: "0.2.0" });
  }
  return createApi({
    runsDir: join(root, "runs"),
    tilesDir: join(root, "tiles"),
    configDbPath: join(root, "config.sqlite"),
    admin: true,
    groups: o.groups ?? { runner: false, evals: false, viewer: true },
    ...(o.moduleUrl !== undefined ? { moduleUrl: o.moduleUrl } : {}),
    ...(o.sessions === true ? { sessionStore: store } : {}),
  });
}

const admin = async (h: ReturnType<typeof createApi>): Promise<{ text: string; body: AdminResponse }> => {
  const res = await h(new Request("http://x/api/admin"));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, body: JSON.parse(text) as AdminResponse };
};

/** Run `fn` with the port secret in the environment, as the viewer's process has it. */
async function withSecret<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env["WRATHBENCH_MODULE_SECRET"];
  process.env["WRATHBENCH_MODULE_SECRET"] = PORT_SECRET;
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env["WRATHBENCH_MODULE_SECRET"];
    else process.env["WRATHBENCH_MODULE_SECRET"] = was;
  }
}

describe("the module, through /api/admin", () => {
  test("is an allowlist of /health's fields: an unknown field, the drop census and the world load never pass", async () => {
    const m = fakeModule();
    const { text, body } = await withSecret(async () => await admin(handle({ moduleUrl: m.url })));
    // The viewer authenticated with the port secret, and the answer does not carry it.
    expect(m.bearers).toEqual([`Bearer ${PORT_SECRET}`]);
    expect(body.wrathMcp.moduleError).toBeNull();
    expect(body.wrathMcp.module).toEqual({
      url: m.url,
      ok: true,
      worldLoaded: true,
      build: "harness-0.3-41-g0bfe207",
      protocol: 1,
      startedAtMs: 1_787_400_000_000,
      uptimeMs: 3_600_000,
      sessions: 1,
      leases: 2,
      limits: { actionRate: 0, actionBurst: 40, eventsSubscribersPerToken: 4, leases: 1024, connections: 4096, connectionsPerPeer: 0, connectionsPerLease: 0, eventsBacklogBytes: 16777216 },
    });
    for (const gone of ['"unknownExtra"', "should not pass", '"droppedByOpcode"', '"worldLoad"', '"futureLimit"', '"leaseSecret"', '"creatureSpawns"', '"worldStopped"']) expect(text).not.toContain(gone);
    expect(body.wrathMcp.secret).toEqual({ env: "WRATHBENCH_MODULE_SECRET", set: true });
  });

  test("carries no secret-shaped value anywhere in the body", async () => {
    const m = fakeModule();
    const { text } = await withSecret(async () => await admin(handle({ moduleUrl: m.url, sessions: true })));
    expect(text).not.toContain(PORT_SECRET);
    expect(text).not.toContain(LEASE_SECRET);
    expect(text).not.toMatch(/[0-9a-f]{64}/i);
    // Nor any session's token fingerprint, nor the host's labels.
    for (const fp of [FP_LIVE, FP_ENDED, FP_EMPTY]) expect(text).not.toContain(fp);
    expect(text).not.toContain("owner-label");
    expect(text).not.toContain("c0ffee");
  });

  test("a world that did not load whole is a 503 the section still reads; /api/info names no worldserver for it", async () => {
    const m = fakeModule({ status: 503, body: { ...healthBody({ ok: false }), error: "world_not_loaded" } });
    const h = handle({ moduleUrl: m.url });
    const { body } = await admin(h);
    expect(body.wrathMcp.module?.ok).toBe(false);
    expect(body.wrathMcp.module?.worldLoaded).toBe(false);
    const info = (await (await h(new Request("http://x/api/info"))).json()) as ApiInfoResponse;
    expect(info.worldserver).toBeNull();
    // One fetch for both routes, inside the cache window.
    expect(m.bearers.length).toBe(1);
  });

  test("/api/info's worldserver comes off the same read", async () => {
    const m = fakeModule();
    const info = (await (await handle({ moduleUrl: m.url })(new Request("http://x/api/info"))).json()) as ApiInfoResponse;
    expect(info.worldserver).toEqual({ build: "harness-0.3-41-g0bfe207", startedAtMs: 1_787_400_000_000 });
  });

  test("a refused credential, nothing listening, and no module URL at all read apart", async () => {
    const refused = fakeModule({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect((await admin(handle({ moduleUrl: refused.url }))).body.wrathMcp).toMatchObject({ module: null, moduleError: "refused" });
    expect((await admin(handle({ moduleUrl: "http://127.0.0.1:1" }))).body.wrathMcp).toMatchObject({ module: null, moduleError: "unreachable" });
    // Unset is tried at the loopback default, and nothing answering there reads as not configured.
    const tried: string[] = [];
    const unset = moduleHealthReader(undefined, {
      env: {},
      fetch: (async (url: string | URL | Request) => {
        tried.push(String(url));
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    expect(await unset()).toEqual({ view: null, error: "unset", status: null });
    expect(tried).toEqual(["http://127.0.0.1:8086/health"]);
    const before = process.env["WRATHBENCH_MODULE_SECRET"];
    delete process.env["WRATHBENCH_MODULE_SECRET"];
    try {
      expect((await admin(handle({ moduleUrl: "http://127.0.0.1:1" }))).body.wrathMcp.secret).toEqual({ env: "WRATHBENCH_MODULE_SECRET", set: false });
    } finally {
      if (before !== undefined) process.env["WRATHBENCH_MODULE_SECRET"] = before;
    }
  });

  test("the URL it shows has no userinfo, and a limit is copied only as a number", () => {
    expect(displayUrl("http://op:hunter2@worldserver:8086/")).toBe("http://worldserver:8086");
    expect(displayUrl("not a url")).toBe("(not a URL)");
    expect(moduleView("http://m:1", { limits: { actionRate: "20", leases: 3 }, build: 7 })).toMatchObject({ limits: { leases: 3 }, build: null, ok: false });
  });
});

describe("the session store, through /api/admin", () => {
  test("counts the sessions that reached the world, the live ones by viewer id, and the stack each reports", async () => {
    const { body } = await admin(handle({ moduleUrl: "http://127.0.0.1:1", sessions: true }));
    expect(body.wrathMcp.store).toEqual({
      sessions: 2,
      live: 1,
      versions: [
        { version: "0.2.0", commit: "0123456789abcdef0123456789abcdef01234567", sessions: 1 },
        { version: "0.1.0", commit: null, sessions: 1 },
      ],
      liveSessions: [{ id: bareSessionId(FP_LIVE), character: "Bramblewick", version: "0.2.0", commit: "0123456789abcdef0123456789abcdef01234567" }],
    });
  });

  test("is null when the viewer reads no store", async () => {
    expect((await admin(handle({ moduleUrl: "http://127.0.0.1:1" }))).body.wrathMcp.store).toBeNull();
  });
});
