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

import { headerSafe } from "../lib/config";

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

/** The header names `config-api.ts` reads attribution from. */
export const ACTOR_HEADER = "x-wrathbench-actor";
export const NOTE_HEADER = "x-wrathbench-note";

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

export interface ConfigAuditResponse {
  audit: AuditRow[];
}

export interface ConfigExportResponse {
  path: string | null;
  bytes: number;
  text: string;
}

/** Who and why. The API defaults the actor and takes no note; the page requires both. */
export interface Attribution {
  actor: string;
  note: string;
}

export interface ConfigClientOptions {
  fetch?: typeof globalThis.fetch;
  base?: string;
}

async function send<T>(
  f: typeof globalThis.fetch,
  url: string,
  init: RequestInit & { attribution?: Attribution },
): Promise<T> {
  const { attribution, ...rest } = init;
  const headers: Record<string, string> = { accept: "application/json", ...(rest.body !== undefined ? { "content-type": "application/json" } : {}) };
  if (attribution !== undefined) {
    // Folded to what a header can carry: `fetch` refuses the whole request on a
    // code point above U+00FF, and an em dash in a note is the likeliest thing
    // an operator types here. See `headerSafe` in `lib/config.ts`.
    headers[ACTOR_HEADER] = headerSafe(attribution.actor);
    headers[NOTE_HEADER] = headerSafe(attribution.note);
  }
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
    audit: (limit = 50): Promise<ConfigAuditResponse> =>
      send<ConfigAuditResponse>(f, at(`/api/config/audit?limit=${String(limit)}`), { method: "GET" }),
    /** Shallow-merge into one row. Cannot remove a key — see `lib/config.ts`. */
    patch: (key: string, body: unknown, attribution: Attribution): Promise<ConfigWriteResponse> =>
      send<ConfigWriteResponse>(f, rowUrl(key), { method: "PATCH", body: JSON.stringify(body), attribution }),
    /** Replace one row whole. */
    put: (key: string, body: unknown, attribution: Attribution): Promise<ConfigWriteResponse> =>
      send<ConfigWriteResponse>(f, rowUrl(key), { method: "PUT", body: JSON.stringify(body), attribution }),
    /** Remove one row. Validated like any other write: a referenced entry is refused. */
    remove: (key: string, attribution: Attribution): Promise<ConfigWriteResponse> =>
      send<ConfigWriteResponse>(f, rowUrl(key), { method: "DELETE", attribution }),
    /**
     * Render the store to fleet.json's shape and hand back the text. The body
     * is `{}` on purpose: a `path` in it makes the server WRITE a file, and on
     * the cluster that file is a Flux-managed copy nothing reads.
     */
    export: (): Promise<ConfigExportResponse> =>
      send<ConfigExportResponse>(f, at("/api/config/export"), { method: "POST", body: "{}" }),
  };
}

export type ConfigClient = ReturnType<typeof createConfigClient>;

/** The one the page uses. */
export const configApi: ConfigClient = createConfigClient();
