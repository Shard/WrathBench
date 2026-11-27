/**
 * Where a smoke finds the module.
 *
 * One spelling for all of them: inside the runner container (compose service
 * or the cluster's runner pod) the module is `worldserver:8086` on the
 * container network, and that is the default. `MODULE_HOST` / `MODULE_PORT`
 * override it — the documented handle for pointing a smoke somewhere else —
 * and they always win, so a smoke run inside a pod behaves the same whatever
 * else is in the environment.
 *
 * `WRATHBENCH_MODULE_URL` is consulted only when neither is set. It is the
 * harness's own name for the same endpoint (docs/RUNBOOK.md), so a host-side
 * `bun infra/smoke/<name>.ts` picks up the .env value Bun autoloads instead of
 * trying to resolve a container hostname. Inside the containers the chart and
 * compose set it to the same `http://worldserver:8086`, so nothing moves.
 *
 * Empty is unset throughout, the same rule lib/auth.ts applies to the secret.
 *
 * And how a smoke that drives the module's HTTP surface by hand talks to it:
 * one request helper, `POST /action`, and `GET /health`.
 */

import { authHeaders } from "./auth";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** The module's HTTP origin, with no trailing slash. */
export function moduleBase(): string {
  const host = env("MODULE_HOST");
  const port = env("MODULE_PORT");
  if (host === undefined && port === undefined) {
    const url = env("WRATHBENCH_MODULE_URL");
    if (url !== undefined) return url.replace(/\/+$/, "");
  }
  return `http://${host ?? "worldserver"}:${port ?? "8086"}`;
}

/** The same origin as a WebSocket URL, for `/events`. */
export function moduleWsBase(): string {
  return moduleBase().replace(/^http/, "ws");
}

/** A module reply as a smoke reads it, field by field: the status and the JSON body, or undefined for none. */
export interface ModuleReply {
  status: number;
  json: any;
}

/** One request to the module's HTTP surface. */
export type ModuleRequest = (method: string, path: string, body?: unknown) => Promise<ModuleReply>;

/** Requests to the module at `base` with the smoke's credential (lib/auth.ts). */
export function moduleRequest(base: string = moduleBase()): ModuleRequest {
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...authHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json: ModuleReply["json"];
    try {
      json = await res.json();
    } catch {
      // not JSON
    }
    return { status: res.status, json };
  };
}

/**
 * `POST /action` under `token`, failing the smoke through its own `fail` on
 * anything but `200 ok`; the reply's JSON otherwise.
 */
export function moduleAction(request: ModuleRequest, token: string, fail: (msg: string) => never): (name: string, fields?: Record<string, unknown>) => Promise<any> {
  return async (name, fields = {}) => {
    const r = await request("POST", "/action", { token, action: name, ...fields });
    if (r.status !== 200 || !r.json?.ok) fail(`action ${name} failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
}

/**
 * A raw smoke's own session: `create` is `POST /session` (which creates the
 * character through CMSG_CHAR_CREATE when it does not exist) and must land in
 * world, `end` is `DELETE /session`; either failing goes through the smoke's
 * own `fail`.
 */
export function moduleSession(
  request: ModuleRequest,
  o: { token: string; account: string; character: string; race: number; class: number },
  fail: (msg: string) => never,
): { create(): Promise<any>; end(): Promise<void> } {
  return {
    async create() {
      const r = await request("POST", "/session", { token: o.token, account: o.account, character: o.character, race: o.race, class: o.class });
      if (r.status !== 200 || !r.json?.inWorld) fail(`session failed: ${JSON.stringify(r.json)}`);
      return r.json;
    },
    async end() {
      const r = await request("DELETE", "/session", { token: o.token });
      if (r.status !== 200) fail(`session delete failed: ${JSON.stringify(r.json)}`);
    },
  };
}

/** `GET /health`'s body with the smoke's credential; rejects when it is not JSON. */
export function moduleHealth(base: string = moduleBase()): Promise<any> {
  return fetch(`${base}/health`, { headers: authHeaders() }).then((r) => r.json());
}
