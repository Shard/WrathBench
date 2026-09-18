/**
 * The config API: read and edit the fleet config through the app
 * (FOLLOW-UPS item 127).
 *
 * Everything this serves comes from `runner/src/config-store.ts` — the only
 * fleet config — and every write goes through the store's one validator,
 * `parseFleet`, the function the supervisor runs the store through. So a 400
 * from here carries the config error the supervisor would refuse with, word
 * for word, and there is no edit the app accepts that the supervisor would
 * then reject at its next tick.
 *
 * **Operator-only.** These routes are mounted only when the viewer is not in
 * public mode, and a public handle 404s them — not 403: a withheld route says
 * "there is something here you may not have", which about a write surface is a
 * sentence nobody outside needs to read. The viewer has no other
 * authentication (it binds loopback, or a trusted LAN behind
 * `WRATHBENCH_VIEWER_LAN`, docs/PUBLIC-DASHBOARD.md), so "not public" is the
 * whole of the authorisation and the actor header is attribution, not identity.
 *
 * No UI in this pass: the dashboard is a separate track. `runner/viewer/README.md`
 * has the endpoint list.
 */

import { existsSync } from "node:fs";
import {
  ConfigRejected,
  ConfigStore,
  configDbPath,
  type AuditRow,
} from "../src/config-store";

/** The prefix everything here hangs off. */
export const CONFIG_API_PREFIX = "/api/config";

/** Who to record a change as when the request does not say. */
export const ACTOR_HEADER = "x-wrathbench-actor";
export const NOTE_HEADER = "x-wrathbench-note";
export const DEFAULT_ACTOR = "viewer";

/** The biggest audit page a client may ask for. */
export const AUDIT_MAX = 500;

export interface ConfigApiOptions {
  /** The store file. Defaults to the data volume's (`configDbPath`). */
  dbPath?: string;
}

export interface ConfigResponse {
  /** The whole config, in the export's shape (`infra/fleet.example.json` is the model). */
  config: Record<string, unknown>;
  /** Every row key, in render order — what a UI lists. */
  keys: string[];
  /** Moves on every accepted write and nothing else; a cheap poll. */
  version: number;
  /** Where the store is, so an operator can find it from the page. */
  path: string;
  /** False before the store has been seeded: the supervisor runs an empty board. */
  seeded: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function actorOf(req: Request): { actor: string; note?: string } {
  const actor = req.headers.get(ACTOR_HEADER);
  const note = req.headers.get(NOTE_HEADER);
  return {
    actor: actor !== null && actor.trim().length > 0 ? actor.trim().slice(0, 64) : DEFAULT_ACTOR,
    ...(note !== null && note.trim().length > 0 ? { note: note.trim().slice(0, 500) } : {}),
  };
}

function auditBody(rows: readonly AuditRow[]): unknown {
  return { audit: rows };
}

/**
 * Handle a `/api/config...` request, or return null when the path is not one
 * of ours (so the caller falls through to its own 404).
 */
export async function handleConfigRequest(req: Request, url: URL, path: string, opts: ConfigApiOptions = {}): Promise<Response | null> {
  if (path !== CONFIG_API_PREFIX && !path.startsWith(`${CONFIG_API_PREFIX}/`)) return null;
  const rest = path.slice(CONFIG_API_PREFIX.length).replace(/^\//, "");
  const dbPath = opts.dbPath ?? configDbPath();
  const method = req.method.toUpperCase();

  /*
   * A GET never creates the store: on a deployment that has not been seeded
   * the answer is "not seeded", not a new empty database beside the runs. A
   * write does not create it either — seeding is `config-store.ts seed`, an
   * operator action with the example behind it, and an empty store would be a
   * fleet config that says nothing.
   */
  const present = existsSync(dbPath);
  if (!present && method !== "GET") {
    return json(
      { error: `no config store at ${dbPath} — seed it first: bun runner/src/config-store.ts seed infra/fleet.example.json` },
      409,
    );
  }
  if (!present) {
    if (rest === "" ) {
      return json({ config: {}, keys: [], version: 0, path: dbPath, seeded: false } satisfies ConfigResponse);
    }
    if (rest === "audit") return json(auditBody([]));
    return json({ error: `no config store at ${dbPath}` }, 404);
  }

  const store = new ConfigStore(dbPath, { readonly: method === "GET" });
  try {
    if (method === "GET" && rest === "") {
      const rows = store.rows();
      return json({
        config: store.render(),
        keys: rows.map((r) => r.key),
        version: store.version(),
        path: dbPath,
        seeded: rows.length > 0,
      } satisfies ConfigResponse);
    }

    if (method === "GET" && rest === "audit") {
      const asked = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(AUDIT_MAX, Math.floor(asked)) : 100;
      return json(auditBody(store.audit(limit)));
    }

    if (method === "POST" && rest === "export") {
      /*
       * Export renders the store to a config document and hands it back, for
       * reading or diffing — never for committing: the active config is
       * operational state, not source (2026-09-18). It writes a file only when
       * the request names one, deliberately; nothing reads such a file.
       */
      const body = await readJson(req);
      const to = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { path?: unknown }).path : undefined;
      const text = `${JSON.stringify(store.render(), null, 2)}\n`;
      if (typeof to === "string" && to.length > 0) {
        await Bun.write(to, text);
        return json({ path: to, bytes: text.length, text });
      }
      return json({ path: null, bytes: text.length, text });
    }

    if (rest === "" || rest === "audit" || rest === "export") {
      return json({ error: `${method} ${path} is not a config route` }, 405);
    }

    // Everything left names one row: `roster/sonnet`, `policy`, `queue/0`.
    const key = rest;
    if (method === "GET") {
      const value = store.get(key);
      if (value === undefined) return json({ error: `no such config key: ${key}` }, 404);
      return json({ key, value, version: store.version() });
    }

    if (method === "PUT" || method === "PATCH" || method === "DELETE") {
      const { actor, note } = actorOf(req);
      try {
        if (method === "DELETE") {
          if (store.get(key) === undefined) return json({ error: `no such config key: ${key}` }, 404);
          store.put(key, undefined, { actor, ...(note !== undefined ? { note } : {}) });
        } else {
          const body = await readJson(req);
          if (body === MALFORMED) return json({ error: "request body is not JSON" }, 400);
          if (method === "PUT") store.put(key, body, { actor, ...(note !== undefined ? { note } : {}) });
          else store.patch(key, body, { actor, ...(note !== undefined ? { note } : {}) });
        }
      } catch (e) {
        // A refused edit is a 400 carrying the config error verbatim — the same
        // sentence the supervisor prints when it rejects a file.
        if (e instanceof ConfigRejected) return json({ error: e.message, key }, 400);
        throw e;
      }
      return json({ key, value: store.get(key) ?? null, version: store.version() });
    }

    return json({ error: `${method} ${path} is not a config route` }, 405);
  } finally {
    store.close();
  }
}

/** A body that did not parse. Distinct from a body that parsed to null. */
const MALFORMED = Symbol("malformed-json");

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim().length === 0) return MALFORMED;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return MALFORMED;
  }
}
