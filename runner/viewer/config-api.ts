/**
 * The config API: read and edit the fleet config through the app
 *.
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
  DraftRefused,
  configDbPath,
  type AuditRow,
} from "../src/config-store";
import { parsePolicyBlock } from "../src/models";
import type { RoutingSpec } from "../src/routing";
import type { DraftFetchResponse, DraftsResponse, E90TokenProfileView } from "./api-types";
import {
  CatalogueError,
  bodyError,
  draftDocument,
  draftRecordOf,
  draftRefSchema,
  draftsResponse,
  promoteSchema,
  promotedEntry,
  readCatalogue,
  reconcileDrafts,
  type DraftRecord,
} from "./drafts";

/** The prefix everything here hangs off. */
export const CONFIG_API_PREFIX = "/api/config";

/** The draft routes, under the prefix (`drafts.ts`). Ids travel in bodies, never in the path. */
export const DRAFTS_ROUTE = "proposed";

/** Who to record a change as when the request does not say. */
export const ACTOR_HEADER = "x-wrathbench-actor";
export const NOTE_HEADER = "x-wrathbench-note";
export const DEFAULT_ACTOR = "viewer";

/** The biggest audit page a client may ask for. */
export const AUDIT_MAX = 500;

export interface ConfigApiOptions {
  /** The store file. Defaults to the data volume's (`configDbPath`). */
  dbPath?: string;
  /** What reads the catalogue. A test injects a fixture; the viewer uses the global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * The token profile a draft's estimate is priced at. `api.ts` builds it from
   * the runs the viewer already serves; absent, no draft carries an estimate.
   */
  e90Profile?: () => Promise<E90TokenProfileView | null>;
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
  if (rest === DRAFTS_ROUTE || rest.startsWith(`${DRAFTS_ROUTE}/`)) {
    return await handleDrafts(req, method, rest.slice(DRAFTS_ROUTE.length).replace(/^\//, ""), dbPath, present, opts);
  }
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

/** Every roster entry's `model`, as written: what a fetch does not propose and a listing hides. */
function rosterModelsOf(config: Record<string, unknown>): Set<string> {
  const roster = config["roster"];
  const out = new Set<string>();
  if (typeof roster !== "object" || roster === null || Array.isArray(roster)) return out;
  for (const e of Object.values(roster as Record<string, unknown>)) {
    const model = typeof e === "object" && e !== null ? (e as { model?: unknown }).model : undefined;
    if (typeof model === "string" && model.length > 0) out.add(model);
  }
  return out;
}

/** The fleet's `policy.routing`, which an entry with none of its own gets. */
function policyRoutingOf(config: Record<string, unknown>): RoutingSpec | undefined {
  try {
    return parsePolicyBlock(config["policy"]).routing;
  } catch {
    return undefined; // the store refuses such a policy on write; the label falls back to the built-in rule
  }
}

/**
 * The draft routes (`drafts.ts`), behind the same gate as everything in this
 * module: `api.ts` mounts it only on a handle that is not public, so a public
 * viewer and the publisher answer 404 for all of them.
 *
 * - `GET proposed` — pending drafts newest first, the ignored apart, and the
 *   e90 profile the estimates were priced at.
 * - `POST proposed/fetch` — one read of the catalogue: proposes, refreshes,
 *   drops what the roster now runs. 502 with the reason when the catalogue
 *   cannot be read.
 * - `POST proposed/ignore` and `proposed/unignore` — `{ model }`.
 * - `POST proposed/promote` — `{ model, name, tier, race?, class? }`.
 *
 * Only promote writes config, so only promote goes through `parseFleet` and
 * into the history, with the actor and note headers. Fetch and ignore are
 * bookkeeping on rows no config reader sees; an ignore records its actor on
 * the draft itself.
 */
async function handleDrafts(
  req: Request,
  method: string,
  verb: string,
  dbPath: string,
  present: boolean,
  opts: ConfigApiOptions,
): Promise<Response> {
  if (verb === "" && method === "GET") {
    if (!present) return json({ drafts: [], ignored: [], profile: null } satisfies DraftsResponse);
    const store = new ConfigStore(dbPath, { readonly: true });
    let rows;
    let config;
    try {
      rows = store.drafts();
      config = store.render();
    } finally {
      store.close();
    }
    let profile: E90TokenProfileView | null = null;
    try {
      profile = opts.e90Profile === undefined ? null : await opts.e90Profile();
    } catch {
      profile = null; // no profile is no estimate — never a reason to withhold the drafts
    }
    return json(
      draftsResponse({ rows, roster: rosterModelsOf(config), profile, policyRouting: policyRoutingOf(config) }) satisfies DraftsResponse,
    );
  }
  const where = `${CONFIG_API_PREFIX}/${DRAFTS_ROUTE}${verb === "" ? "" : `/${verb}`}`;
  if (method !== "POST" || !["fetch", "ignore", "unignore", "promote"].includes(verb)) {
    return json({ error: `${method} ${where} is not a draft route` }, 405);
  }
  if (!present) {
    return json({ error: `no config store at ${dbPath} — seed it first: bun runner/src/config-store.ts seed infra/fleet.example.json` }, 409);
  }

  if (verb === "fetch") {
    // The network first, the store after: no write handle is held across the call.
    let catalogue;
    try {
      catalogue = await readCatalogue(opts.fetch ?? globalThis.fetch);
    } catch (e) {
      if (e instanceof CatalogueError) return json({ error: e.message }, 502);
      throw e;
    }
    const store = new ConfigStore(dbPath);
    try {
      const existing = store.drafts().flatMap((r) => draftRecordOf(r) ?? []);
      const { put, remove, report } = reconcileDrafts({ catalogue, existing, roster: rosterModelsOf(store.render()), now: Date.now() });
      store.writeDrafts({ put: put.map((d) => ({ model: d.model, value: draftDocument(d) })), remove });
      return json(report satisfies DraftFetchResponse);
    } finally {
      store.close();
    }
  }

  const body = await readJson(req);
  if (body === MALFORMED) return json({ error: "request body is not JSON" }, 400);
  const { actor, note } = actorOf(req);

  if (verb === "ignore" || verb === "unignore") {
    const parsed = draftRefSchema.safeParse(body);
    if (!parsed.success) return json({ error: bodyError(parsed.error) }, 400);
    const model = parsed.data.model;
    const store = new ConfigStore(dbPath);
    try {
      const d = store.drafts().flatMap((r) => draftRecordOf(r) ?? []).find((x) => x.model === model);
      if (d === undefined) return json({ error: `no draft for ${model}` }, 404);
      const status: DraftRecord["status"] = verb === "ignore" ? "ignored" : "draft";
      if (d.status !== status) {
        const { ignoredAt: _at, ignoredBy: _by, ...rest } = d;
        const next: DraftRecord = status === "ignored" ? { ...rest, status, ignoredAt: Date.now(), ignoredBy: actor } : { ...rest, status };
        store.writeDrafts({ put: [{ model, value: draftDocument(next) }] });
      }
      return json({ model, status });
    } finally {
      store.close();
    }
  }

  const parsed = promoteSchema.safeParse(body);
  if (!parsed.success) return json({ error: bodyError(parsed.error) }, 400);
  const key = `roster/${parsed.data.name}`;
  const store = new ConfigStore(dbPath);
  try {
    try {
      store.promote(parsed.data.model, parsed.data.name, promotedEntry(parsed.data), { actor, ...(note !== undefined ? { note } : {}) });
    } catch (e) {
      // The parser's refusal verbatim, as for any roster edit; the draft is untouched.
      if (e instanceof ConfigRejected) return json({ error: e.message, key }, 400);
      if (e instanceof DraftRefused) return json({ error: e.message, key }, e.reason === "missing" ? 404 : 409);
      throw e;
    }
    return json({ key, value: store.get(key) ?? null, version: store.version() });
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
