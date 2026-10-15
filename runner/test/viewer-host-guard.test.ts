/**
 * The viewer's Host allowlist (`runner/viewer/host-guard.ts`): a request
 * addressed to a name the viewer does not answer to — what a DNS-rebinding
 * page sends — is a 421 on every path and method, before any route or the
 * write guard runs; the viewer's own names, localhost and IP addresses pass.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { allowedHostsFromEnv, hostAllowlist, hostGuard, hostName } from "../viewer/host-guard";
import { ConfigStore } from "../src/config-store";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GLM = { tier: "t1", model: "z-ai/glm-5.2:free" };
const OWN = "wrathbench.lan.example";

/** A private handle answering to `allowedHosts`; null gives it no allowlist at all. */
function fixture(allowedHosts: readonly string[] | null = [OWN]): { handle: ReturnType<typeof createApi>; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "host-guard-"));
  roots.push(root);
  const dbPath = join(root, "config.sqlite");
  const store = new ConfigStore(dbPath);
  store.seed({ accounts: { pool: ["RUNNER"] }, roster: { glm: GLM }, queue: [] });
  store.close();
  return {
    handle: createApi({
      runsDir: join(root, "runs"),
      tilesDir: join(root, "tiles"),
      configDbPath: dbPath,
      ...(allowedHosts !== null ? { allowedHosts } : {}),
    }),
    dbPath,
  };
}

function stored(dbPath: string): unknown {
  const store = new ConfigStore(dbPath, { readonly: true });
  try {
    return store.get("roster/glm");
  } finally {
    store.close();
  }
}

/** A request as the viewer sees it arrive, addressed to `host` (the header is what the guard reads). */
function req(host: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  return new Request(`http://viewer.invalid${path}`, { ...init, headers });
}

/** The dashboard's own replace of one roster row: same origin as the Host, JSON. */
function put(host: string, origin = `https://${host}`): Request {
  return req(host, "/api/config/roster/glm", {
    method: "PUT",
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ ...GLM, tier: "t2" }),
  });
}

describe("the viewer's own names pass", () => {
  test("the configured name, behind the ingress, on a read and on a write", async () => {
    const { handle, dbPath } = fixture();
    expect((await handle(req(OWN, "/api/info"))).status).toBe(200);
    expect((await handle(req(OWN, "/api/runs"))).status).toBe(200);
    // Case and a trailing dot name the same host; a port is not part of the name.
    expect((await handle(req("WrathBench.LAN.example.:443", "/api/config"))).status).toBe(200);
    expect((await handle(put(OWN))).status).toBe(200);
    expect(stored(dbPath)).toEqual({ ...GLM, tier: "t2" });
  });

  test("localhost and loopback addresses, with no configuration at all", async () => {
    const { handle } = fixture([]);
    for (const host of ["localhost:8090", "127.0.0.1:8090", "[::1]:8090", "localhost"]) {
      const res = await handle(req(host, "/api/config"));
      expect([host, res.status]).toEqual([host, 200]);
    }
  });

  test("the readiness probe: GET /api/info with the pod IP as Host", async () => {
    const { handle } = fixture();
    const probe = await handle(req("10.42.0.17:8090", "/api/info"));
    expect(probe.status).toBe(200);
    // A LAN browser pointed at the viewer's address is the same shape.
    expect((await handle(req("192.168.1.240", "/api/runs"))).status).toBe(200);
  });

  test("an IP Host does not skip the write guard behind it", async () => {
    const { handle, dbPath } = fixture();
    const res = await handle(put("10.42.0.17:8090", "https://elsewhere.example"));
    expect(res.status).toBe(403);
    expect(stored(dbPath)).toEqual(GLM);
  });

  test("a handle given no allowlist — the snapshot renderer's, a test's — checks nothing", async () => {
    const { handle } = fixture(null);
    expect((await handle(req("snapshot.local", "/api/info"))).status).toBe(200);
  });
});

describe("any other name is a 421 before a route runs, and nothing is written", () => {
  test("a foreign Host on GET /api/… — what a rebinding page reads with", async () => {
    const { handle } = fixture();
    for (const path of ["/api/info", "/api/runs", "/api/config", "/api/config/roster/glm", "/tiles/x.png", "/"]) {
      const res = await handle(req("evil.example", path));
      expect([path, res.status]).toEqual([path, 421]);
    }
    const body = (await (await handle(req("evil.example", "/api/info"))).json()) as { error: string };
    expect(body.error).toContain("WRATHBENCH_VIEWER_ALLOWED_HOSTS");
  });

  test("a foreign Host on PUT /api/config/… — a same-origin JSON write the write guard alone would pass", async () => {
    const { handle, dbPath } = fixture();
    const res = await handle(put("evil.example"));
    expect(res.status).toBe(421);
    // Bodyless and form writes too: the Host check runs first, so they are 421 rather than 415.
    expect((await handle(req("evil.example", "/api/config/roster/glm", { method: "DELETE" }))).status).toBe(421);
    expect(stored(dbPath)).toEqual(GLM);
  });

  test("names that only look like an allowed one", async () => {
    const { handle } = fixture();
    for (const host of [
      "10.42.0.17.nip.io", // resolves through DNS to an IP: the realistic rebinding name
      `${OWN}.evil.example`,
      `evil${OWN}`,
      "localhost.evil.example",
      "",
      "evil.example/x",
      `user@${OWN}`,
    ]) {
      const res = await handle(req(host, "/api/info"));
      expect([host, res.status]).toEqual([host, 421]);
    }
  });

  test("X-Forwarded-Host is never consulted: a rebinding page can set it", () => {
    const allowed = hostAllowlist([OWN]);
    const forged = new Request("http://evil.example/api/info", { headers: { host: "evil.example", "x-forwarded-host": OWN } });
    expect(hostGuard(forged, allowed)?.status).toBe(421);
  });
});

describe("where the names come from", () => {
  test("WRATHBENCH_VIEWER_ALLOWED_HOSTS, comma-separated, normalised, ports dropped", () => {
    expect(allowedHostsFromEnv({ WRATHBENCH_VIEWER_ALLOWED_HOSTS: " Wrathbench.Example.com , alias.lan:8443,," })).toEqual([
      "wrathbench.example.com",
      "alias.lan",
    ]);
  });

  test("unset or empty, the host of WRATHBENCH_VIEWER_URL; neither, no names beyond localhost and IPs", () => {
    expect(allowedHostsFromEnv({ WRATHBENCH_VIEWER_URL: "https://wrathbench.example.com/" })).toEqual(["wrathbench.example.com"]);
    expect(allowedHostsFromEnv({ WRATHBENCH_VIEWER_ALLOWED_HOSTS: "", WRATHBENCH_VIEWER_URL: "https://viewer.example:8443" })).toEqual(["viewer.example"]);
    expect(allowedHostsFromEnv({ WRATHBENCH_VIEWER_ALLOWED_HOSTS: "a.example", WRATHBENCH_VIEWER_URL: "https://b.example" })).toEqual(["a.example"]);
    expect(allowedHostsFromEnv({})).toEqual([]);
    expect(allowedHostsFromEnv({ WRATHBENCH_VIEWER_URL: "not a url" })).toEqual([]);
  });

  test("an entry that is not a host is refused, so a typo fails the start rather than locking the operator out", () => {
    expect(() => allowedHostsFromEnv({ WRATHBENCH_VIEWER_ALLOWED_HOSTS: "https://wrathbench.example.com" })).toThrow(
      "WRATHBENCH_VIEWER_ALLOWED_HOSTS",
    );
    expect(() => allowedHostsFromEnv({ WRATHBENCH_VIEWER_ALLOWED_HOSTS: "a.example b.example" })).toThrow();
  });

  test("hostName canonicalises the way a URL does", () => {
    expect(hostName("[::1]:8090")).toBe("[::1]");
    expect(hostName("EXAMPLE.com.")).toBe("example.com");
    expect(hostName("10.0.0.5:8090")).toBe("10.0.0.5");
    expect(hostName("")).toBeNull();
    expect(hostName("a/b")).toBeNull();
  });
});
