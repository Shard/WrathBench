/**
 * The module's `GET /health` as the viewer reads it (wrath-mcp/module/PROTOCOL.md,
 * "GET /health"): one cached fetch with the port secret, behind `/api/info`'s
 * `worldserver` and the admin page's wrath-mcp section.
 *
 * **An allowlist, never the body.** The port secret opens the operator view,
 * which carries module internals (the drop census, the world load) and could
 * grow anything a later module adds. What leaves here is the fields named in
 * `moduleView`, each copied only when it has its type, so an unknown field or
 * a changed one never reaches a browser. The viewer has no login, so nothing
 * it serves may carry a secret: the URL loses any userinfo, and the secret is
 * named by its env var only.
 */

import { moduleAuthHeaders } from "@wrathbench/mcp/module-auth";
import { num } from "../runner/src/values";
import type { ApiInfoResponse, ModuleLimitKey, ModuleLimits, WrathMcpModuleError, WrathMcpModuleView } from "./api-types";

/** How long one /health answer (or one failure) stands in for the next. */
export const HEALTH_CACHE_MS = 10_000;

/** Where the module listens by default (module/PROTOCOL.md): what an unset module URL means. */
export const DEFAULT_MODULE_URL = "http://127.0.0.1:8086";

/** The limits copied from `/health`, by name. */
export const MODULE_LIMIT_KEYS: readonly ModuleLimitKey[] = [
  "actionRate",
  "actionBurst",
  "eventsSubscribersPerToken",
  "leases",
  "connections",
  "connectionsPerPeer",
  "connectionsPerLease",
  "eventsBacklogBytes",
];

/** One read of `/health`: the allowlisted view, or why there is none. `status` is the HTTP status, null when nothing answered. */
export interface ModuleRead {
  view: WrathMcpModuleView | null;
  error: WrathMcpModuleError | null;
  status: number | null;
}

/** A URL without its userinfo, so a credential written into it is never served. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "(not a URL)";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 200) : null);

/** The allowlisted view of a `/health` body. Anything not named here is dropped. */
export function moduleView(url: string, body: unknown): WrathMcpModuleView {
  const o = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const rawLimits = o["limits"];
  let limits: ModuleLimits | null = null;
  if (typeof rawLimits === "object" && rawLimits !== null && !Array.isArray(rawLimits)) {
    limits = {};
    for (const k of MODULE_LIMIT_KEYS) {
      const v = num((rawLimits as Record<string, unknown>)[k]);
      if (v !== null) limits[k] = v;
    }
  }
  return {
    url: displayUrl(url),
    ok: o["ok"] === true,
    worldLoaded: typeof o["worldLoaded"] === "boolean" ? o["worldLoaded"] : null,
    build: str(o["build"]),
    protocol: num(o["protocol"]),
    startedAtMs: num(o["startedAtMs"]),
    uptimeMs: num(o["uptimeMs"]),
    sessions: num(o["sessions"]),
    leases: num(o["leases"]),
    limits,
  };
}

/** `/api/info`'s `worldserver`, from a read: only a 200 with both identity fields, as before the wider read. */
export function worldserverOf(r: ModuleRead): ApiInfoResponse["worldserver"] {
  const v = r.view;
  if (r.status !== 200 || v === null || v.build === null || v.startedAtMs === null) return null;
  return { build: v.build, startedAtMs: v.startedAtMs };
}

/**
 * The cached reader. `configured` is whether the deployment named a module URL
 * at all: an unset one is tried at the default, and a failure there reads as
 * `unset` rather than `unreachable`. One fetch per cache window however many
 * browsers poll, a failure cached like an answer.
 */
export function moduleHealthReader(
  moduleUrl: string | undefined,
  o: { env?: Record<string, string | undefined>; fetch?: typeof globalThis.fetch } = {},
): () => Promise<ModuleRead> {
  const url = moduleUrl ?? DEFAULT_MODULE_URL;
  const configured = moduleUrl !== undefined;
  const doFetch = o.fetch ?? globalThis.fetch;
  let cached: { at: number; value: ModuleRead } | undefined;
  let inflight: Promise<ModuleRead> | undefined;
  const read = async (): Promise<ModuleRead> => {
    let res: Response;
    try {
      res = await doFetch(`${url}/health`, { headers: moduleAuthHeaders(o.env ?? process.env), signal: AbortSignal.timeout(2_000) });
    } catch {
      return { view: null, error: configured ? "unreachable" : "unset", status: null };
    }
    if (res.status === 401 || res.status === 403) return { view: null, error: "refused", status: res.status };
    // A health answer is a 200, or a 503 for a world that did not load whole; anything else is no module there.
    if (res.status !== 200 && res.status !== 503) return { view: null, error: "unreachable", status: res.status };
    try {
      // A 503 carries the body too: that is where `worldLoaded: false` is.
      const body = (await res.json()) as unknown;
      if (typeof body !== "object" || body === null) return { view: null, error: "unreachable", status: res.status };
      return { view: moduleView(url, body), error: null, status: res.status };
    } catch {
      return { view: null, error: "unreachable", status: res.status };
    }
  };
  return async () => {
    if (cached !== undefined && Date.now() - cached.at < HEALTH_CACHE_MS) return cached.value;
    if (inflight === undefined) {
      inflight = read().then((value) => {
        cached = { at: Date.now(), value };
        inflight = undefined;
        return value;
      });
    }
    return inflight;
  };
}
