/**
 * The write client over `/api/config`.
 *
 * Deliberately not part of `createClient`. Three reasons, all of them things
 * the read client is right about and this one must not inherit:
 *
 * - **It writes.** `client.ts` says in its first paragraph that nothing in it
 *   sends a body, and that is worth keeping true.
 * - **No memo.** The read client serves a URL from memory for 4 seconds; a
 *   re-read straight after a write would be served the document from before
 *   it. Config reads are one-shot and must be.
 * - **The refusal is the product.** `getJson` throws `ApiError(status,
 *   \`${url}: ${detail}\`)`. A config refusal is the sentence `parseFleet`
 *   would have refused the file with, and the page shows it verbatim beside
 *   the row — with no URL glued to the front. `ConfigError` keeps the server's
 *   `error` string untouched and the status beside it.
 *
 * There is no snapshot form of any of this: the routes are not mounted in
 * public mode at all (`api.ts` guards them on `!publicMode`), and the public
 * build reads a bucket. The page checks both before it renders anything.
 */

import type { AdminResponse, DraftFetchResponse, DraftPromoteBody, DraftStatusResponse, DraftsResponse } from "@viewer/api-types";

/**
 * One line of the change history, as `/api/config/audit` serves it.
 *
 * Declared here rather than imported from `runner/src/config-store.ts`: the
 * `@viewer/*` alias exists for modules that are import-free by construction,
 * and the store is not one — it pulls in `bun:sqlite` and the supervisor's
 * config parser. `null` on either side is a create or a delete.
 */
export interface AuditRow {
  id: number;
  ts: number;
  key: string;
  before: unknown | null;
  after: unknown | null;
  actor: string;
  note: string | null;
}

/** A non-2xx from the config API. `message` is the server's sentence, verbatim. */
export class ConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConfigError";
    this.status = status;
  }
}

/** `GET /api/config`: the whole document, its row keys, and the version. */
export interface ConfigResponse {
  config: Record<string, unknown>;
  keys: string[];
  /** Moves on every accepted write and nothing else. The page's conflict check. */
  version: number;
  path: string;
  /** False before the store has been seeded: the file is still in charge. */
  seeded: boolean;
}

export interface ConfigWriteResponse {
  key: string;
  value: unknown;
  version: number;
}

/** A secret write's answer: the name and whether one is stored now. Never the value. */
export interface AdminSecretResponse {
  name: string;
  stored: boolean;
  version: number;
}

export interface ConfigAuditResponse {
  audit: AuditRow[];
}

export interface ConfigExportResponse {
  bytes: number;
  text: string;
}

export interface ConfigClientOptions {
  fetch?: typeof globalThis.fetch;
  base?: string;
}

async function send<T>(
  f: typeof globalThis.fetch,
  url: string,
  rest: RequestInit,
): Promise<T> {
  // Every write says JSON, a body or not (DELETE, the draft fetch): the viewer
  // refuses an unsafe method without it, which is what keeps another site's
  // form or `text/plain` POST from writing here (runner/viewer/write-guard.ts).
  const write = (rest.method ?? "GET").toUpperCase() !== "GET";
  const headers: Record<string, string> = { accept: "application/json", ...(write || rest.body !== undefined ? { "content-type": "application/json" } : {}) };
  const res = await f(url, { ...rest, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    /* a non-JSON body from a proxy is still an answer */
  }
  if (!res.ok) {
    const detail = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `${res.status}`;
    throw new ConfigError(res.status, detail);
  }
  return body as T;
}

export function createConfigClient(opts: ConfigClientOptions = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const base = opts.base ?? "";
  const at = (path: string): string => `${base}${path}`;
  const rowUrl = (key: string): string =>
    // A row key has one slash and both halves are path segments, so each is
    // encoded on its own rather than the whole key encoded into one.
    `${base}/api/config/${key.split("/").map(encodeURIComponent).join("/")}`;

  return {
    /** The whole config. One shot, never memoised — see the header. */
    config: (): Promise<ConfigResponse> => send<ConfigResponse>(f, at("/api/config"), { method: "GET" }),
    /** The admin pages' status beside the config (`runner/viewer/admin-api.ts`): read-only. */
    admin: (): Promise<AdminResponse> => send<AdminResponse>(f, at("/api/admin"), { method: "GET" }),
    audit: (limit = 50): Promise<ConfigAuditResponse> =>
      send<ConfigAuditResponse>(f, at(`/api/config/audit?limit=${String(limit)}`), { method: "GET" }),
    /** Shallow-merge into one row. Cannot remove a key — see `lib/config.ts`. */
    patch: (key: string, body: unknown): Promise<ConfigWriteResponse> =>
      send<ConfigWriteResponse>(f, rowUrl(key), { method: "PATCH", body: JSON.stringify(body) }),
    /** Replace one row whole. */
    put: (key: string, body: unknown): Promise<ConfigWriteResponse> =>
      send<ConfigWriteResponse>(f, rowUrl(key), { method: "PUT", body: JSON.stringify(body) }),
    /** Remove one row. Validated like any other write: a referenced entry is refused. */
    remove: (key: string): Promise<ConfigWriteResponse> =>
      send<ConfigWriteResponse>(f, rowUrl(key), { method: "DELETE" }),
    /**
     * Render the store to fleet.json's shape and hand back the text. The
     * server writes no file for a request; the page shows and copies the text.
     */
    export: (): Promise<ConfigExportResponse> =>
      send<ConfigExportResponse>(f, at("/api/config/export"), { method: "POST", body: "{}" }),
    /** The drafts, newest first, the ignored apart. One shot, like `config()`. */
    drafts: (): Promise<DraftsResponse> => send<DraftsResponse>(f, at("/api/config/proposed"), { method: "GET" }),
    /** One read of the catalogue. Not a config write: no history line. */
    fetchDrafts: (): Promise<DraftFetchResponse> =>
      send<DraftFetchResponse>(f, at("/api/config/proposed/fetch"), { method: "POST" }),
    ignoreDraft: (model: string): Promise<DraftStatusResponse> =>
      send<DraftStatusResponse>(f, at("/api/config/proposed/ignore"), { method: "POST", body: JSON.stringify({ model }) }),
    unignoreDraft: (model: string): Promise<DraftStatusResponse> =>
      send<DraftStatusResponse>(f, at("/api/config/proposed/unignore"), { method: "POST", body: JSON.stringify({ model }) }),
    /**
     * Store a credential's secret, sealed (`runner/viewer/admin-api.ts`). The
     * value travels in the body and nowhere else: never the URL, never a
     * header, and the answer never carries it back.
     */
    setSecret: (name: string, value: string): Promise<AdminSecretResponse> =>
      send<AdminSecretResponse>(f, at(`/api/admin/secrets/${encodeURIComponent(name)}`), { method: "PUT", body: JSON.stringify({ value }) }),
    /** Remove a stored secret: the deployment's Secret stands again. */
    clearSecret: (name: string): Promise<AdminSecretResponse> =>
      send<AdminSecretResponse>(f, at(`/api/admin/secrets/${encodeURIComponent(name)}`), { method: "DELETE" }),
    /** Ask the supervisor to log a Codex home in again; its link and code arrive on `/api/admin`. */
    codexLogin: (id: string): Promise<{ id: string; state: string }> =>
      send<{ id: string; state: string }>(f, at(`/api/admin/codex-login/${encodeURIComponent(id)}`), { method: "POST", body: "{}" }),
    /** A roster write: validated by `parseFleet`, recorded in the history. */
    promoteDraft: (body: DraftPromoteBody): Promise<ConfigWriteResponse> =>
      send<ConfigWriteResponse>(f, at("/api/config/proposed/promote"), { method: "POST", body: JSON.stringify(body) }),
  };
}

export type ConfigClient = ReturnType<typeof createConfigClient>;

/** The one the page uses. */
export const configApi: ConfigClient = createConfigClient();
