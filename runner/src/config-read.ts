/**
 * Reading the config store (`config-store.ts`): where it lives, how its rows
 * render back to the config document, and the one read every reader takes
 * (`readFleetConfig`). Split out of `config-store.ts`, which re-exports all of
 * it unchanged and keeps everything that writes or validates, so a reader —
 * the viewer, for its `site` block and its roster names — does not load the
 * supervisor's parser (`infra/run-fleet-config.ts`), the campaigns or the
 * credential slots the write gate runs through. `ConfigStore` selects and
 * renders through the same two functions, so a read here is the store's own.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** How long a reader waits for the single writer. Same posture as `rundb.ts`. */
export const CONFIG_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * The top-level keys the store knows, in the order a rendered config writes
 * them — the order `infra/fleet.example.json` uses, so two exports diff
 * cleanly rather than reordering the whole document.
 *
 * A top-level key outside this list is not carried: `parseFleet` ignores
 * unknown top-level keys, and silently round-tripping something nothing reads
 * would make the store a place to hide config that does nothing.
 */
export const TOP_LEVEL_KEYS = ["_notes", "preflight", "accounts", "credentials", "roster", "policy", "site", "campaign-defs", "campaigns", "queue"] as const;

/** The keys whose entries get a row each. Everything else is a singleton row. */
export const COLLECTION_KEYS = ["credentials", "roster", "campaign-defs", "campaigns", "queue"] as const;
export type CollectionKey = (typeof COLLECTION_KEYS)[number];

export function isCollection(k: string): k is CollectionKey {
  return (COLLECTION_KEYS as readonly string[]).includes(k);
}

/** One stored document: a whole singleton block, or one entry of a collection. */
export interface ConfigRow {
  /** `policy`, `roster/sonnet`, `queue/0`. */
  key: string;
  /** Position in the rendered file. Collection rows order within their key. */
  ord: number;
  /** The document, exactly as it was written. */
  value: unknown;
  updatedAt: number;
}

/** The prefix of a draft row (`config-store.ts`, "The draft key space"): never config. */
export const PROPOSED_PREFIX = "proposed/";

/** The SQL that keeps draft rows out of a config read. The prefix holds no GLOB metacharacter. */
export const DRAFT_ROWS = `key GLOB '${PROPOSED_PREFIX}*'`;

/**
 * Where the store lives: the data volume, beside `runs/`.
 *
 * `WRATHBENCH_CONFIG_DB` names the file outright; otherwise it is
 * `config.sqlite` under `WRATHBENCH_DATA`, which defaults to `data/` in the
 * checkout — the same directory `data/runs` already hangs off, and on the
 * cluster the `wrathbench-data` PVC at `/wrathbench/data`.
 */
export function configDbPath(env: Record<string, string | undefined> = Bun.env): string {
  const explicit = env["WRATHBENCH_CONFIG_DB"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const data = env["WRATHBENCH_DATA"];
  if (data !== undefined && data.length > 0) return join(data, "config.sqlite");
  return join(resolve(import.meta.dir, "..", ".."), "data", "config.sqlite");
}

/**
 * Render rows back to a fleet config document, in `TOP_LEVEL_KEYS` order and,
 * within a collection, in each row's `ord`.
 */
export function renderFleet(rows: readonly ConfigRow[]): Record<string, unknown> {
  const byKey = new Map<string, ConfigRow>();
  for (const r of rows) byKey.set(r.key, r);
  const out: Record<string, unknown> = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (!isCollection(key)) {
      const row = byKey.get(key);
      if (row !== undefined) out[key] = row.value;
      continue;
    }
    const members = rows
      .filter((r) => r.key.startsWith(`${key}/`))
      .slice()
      .sort((a, b) => a.ord - b.ord || a.key.localeCompare(b.key));
    if (members.length === 0) {
      const empty = byKey.get(key);
      if (empty !== undefined) out[key] = empty.value;
      continue;
    }
    if (key === "queue") {
      out[key] = members.map((r) => r.value);
      continue;
    }
    const obj: Record<string, unknown> = {};
    for (const r of members) obj[r.key.slice(key.length + 1)] = r.value;
    out[key] = obj;
  }
  return out;
}

/** The store's rows matching `where`, in render order: what `ConfigStore` reads and `readFleetConfig` reads. */
export function selectConfigRows(db: Database, where: string): ConfigRow[] {
  let raw: { key: string; ord: number; json: string; updated_at: number }[];
  try {
    raw = db
      .query(`SELECT key, ord, json, updated_at FROM config WHERE ${where} ORDER BY ord, key`)
      .all() as { key: string; ord: number; json: string; updated_at: number }[];
  } catch (e) {
    // A store that has never been written has no tables; that is "empty",
    // not an error a read-only supervisor should die on. ANY other failure
    // (locked, corrupt, I/O) is rethrown: reading a busy store as "zero
    // rows" would tell the supervisor every job vanished.
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
    throw e;
  }
  return raw.map((r) => ({ key: r.key, ord: r.ord, value: JSON.parse(r.json) as unknown, updatedAt: r.updated_at }));
}

/**
 * What a read of the store found. Three states, and the difference between the
 * last two is the whole point:
 *
 * - `ok`: rows, rendered to the config document as JSON text. Text, not a
 *   parsed config, because every caller already parses — through `parseFleet`,
 *   or through the viewer's own roster schema — and handing them text leaves
 *   those refusals exactly where they were.
 * - `empty`: the store has zero rows, or no file yet. Real, and legitimate:
 *   a fresh deployment before its one seed. The supervisor acts on it (an
 *   empty board) and says so every tick.
 * - `unreadable`: the store could not be opened or read (locked past the busy
 *   timeout, corrupt, a permissions slip). Transient by assumption: a reader
 *   keeps its last good config and reports the error, and never treats it as
 *   "every job vanished".
 */
export type FleetRead =
  | { status: "ok"; path: string; text: string }
  | { status: "empty"; path: string }
  | { status: "unreadable"; path: string; error: string };

/**
 * Read the fleet config from the store. The one seam the supervisor, the
 * viewer and the CLI read config through, so "what the fleet runs" is a
 * property of every reader at once. Opened as `ConfigStore` opens a reader:
 * read-only, never creating the file, with the same busy timeout.
 */
export function readFleetConfig(path: string = configDbPath()): FleetRead {
  let db: Database | null = null;
  try {
    if (!existsSync(path)) return { status: "empty", path };
    db = new Database(path, { readonly: true });
    db.exec(`PRAGMA busy_timeout = ${CONFIG_DB_BUSY_TIMEOUT_MS}`);
    const rows = selectConfigRows(db, `NOT ${DRAFT_ROWS}`);
    if (rows.length === 0) return { status: "empty", path };
    return { status: "ok", path, text: JSON.stringify(renderFleet(rows)) };
  } catch (e) {
    return { status: "unreadable", path, error: e instanceof Error ? e.message : String(e) };
  } finally {
    db?.close();
  }
}
