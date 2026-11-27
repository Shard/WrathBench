/**
 * `/api/ready`, the route the chart's readiness probe reads: it answers at
 * once whatever the game module is doing. `/api/info` asks the module's
 * /health and waits up to two seconds on it, so a probe there took the viewer
 * out of its Service whenever the worldserver hung or a module dropped
 * packets. Served on every handle and in no group; the Host guard still
 * applies (the kubelet's Host is the pod IP, which it always answers).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../api";
import type { Groups } from "../groups";

const roots: string[] = [];
/** A module that accepts the connection and never answers: the hung worldserver. */
let hung: ReturnType<typeof Bun.serve>;
const pending: (() => void)[] = [];

beforeAll(() => {
  hung = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: () => new Promise<Response>((resolve) => pending.push(() => resolve(new Response("late")))) });
});
afterAll(() => {
  for (const release of pending) release();
  hung.stop(true);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function handle(opts: { publicMode?: boolean; groups?: Groups; allowedHosts?: string[] } = {}): ReturnType<typeof createApi> {
  const root = mkdtempSync(join(tmpdir(), "viewer-ready-"));
  roots.push(root);
  return createApi({
    runsDir: join(root, "runs"),
    tilesDir: join(root, "tiles"),
    configDbPath: join(root, "config.sqlite"),
    moduleUrl: `http://127.0.0.1:${hung.port}`,
    ...opts,
  });
}

async function timed(h: ReturnType<typeof createApi>, path: string, host = "viewer.local"): Promise<{ status: number; body: unknown; ms: number }> {
  const t0 = performance.now();
  const res = await h(new Request(`http://${host}${path}`));
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body, ms: performance.now() - t0 };
}

describe("/api/ready", () => {
  test("answers at once while the module hangs; /api/info is the route that waits on it", async () => {
    const h = handle();
    const ready = await timed(h, "/api/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ready: true });
    expect(ready.ms).toBeLessThan(250);
    const info = await timed(h, "/api/info");
    expect(info.status).toBe(200);
    expect((info.body as { worldserver: unknown }).worldserver).toBeNull();
    expect(info.ms).toBeGreaterThan(1_500);
  }, 10_000);

  test("is served in public mode and with only the viewer group on", async () => {
    for (const h of [handle({ publicMode: true }), handle({ groups: { runner: false, evals: false, viewer: true } })]) {
      const r = await timed(h, "/api/ready");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ready: true });
    }
  });

  test("still sits behind the Host guard, which always answers the pod's IP", async () => {
    const h = handle({ allowedHosts: ["viewer.example.com"] });
    expect((await timed(h, "/api/ready", "10.42.0.7:8090")).status).toBe(200);
    expect((await timed(h, "/api/ready", "viewer.example.com")).status).toBe(200);
    expect((await timed(h, "/api/ready", "evil.example")).status).toBe(421);
  });
});
