/**
 * The config store: the fleet config as rows in a small sqlite on the data
 * volume, so a roster or policy change is an edit through the app rather than
 * an edit to `infra/fleet.json` and a redeploy (FOLLOW-UPS item 127).
 *
 * Three rules shape everything here.
 *
 * **The store holds the config as WRITTEN, never as parsed.** `parseFleet`
 * fills defaults (`preflight.timeoutMs`, `policy.subscriptions`), normalises
 * shapes (`smokes: ["x.ts"]` becomes `{script, account}`) and annotates
 * entries it refuses. Rendering a parsed config back out would therefore never
 * equal the file it came from, and a diff against `infra/fleet.json` — the one
 * check an operator has that the store and the seed agree — would be noise.
 * So each row is the raw JSON document the file carried, and parsing is only
 * ever the accept/reject gate.
 *
 * **One validator.** A write renders the whole candidate config and runs it
 * through `parseFleet`, the same function the supervisor runs the file
 * through. An edit the file would be refused for is refused here with the same
 * message. There is deliberately no second, store-shaped schema: two
 * validators is how the store and the file come to disagree about what is
 * legal.
 *
 * **Granularity is per entry, and order is kept.** `roster/<name>`,
 * `campaigns/<name>` and `queue/<n>` are rows of their own so an edit to one
 * model rewrites one row; `_notes`, `preflight`, `accounts` and `policy` are
 * singletons. Every row carries an `ord` because file order is load-bearing —
 * two enabled pins on one account are resolved by "the first in file order
 * keeps it" — so a key-sorted render would change which pin wins.
 *
 * The file is not retired by any of this. `seed` imports it when the store is
 * empty, so a bare clone still starts from a file, and `export` renders the
 * store back to its exact shape, so the file stays the reviewable artefact and
 * the diff stays meaningful.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFleet } from "../../infra/run-fleet-config";

/** How long a reader waits for the single writer. Same posture as `rundb.ts`. */
export const CONFIG_DB_BUSY_TIMEOUT_MS = 5000;

/**
 * The top-level keys the store knows, in the order a rendered config writes
 * them — which is the order `infra/fleet.json` itself uses, so an export is a
 * clean diff rather than a reordering of the whole file.
 *
 * A top-level key outside this list is not carried: `parseFleet` ignores
 * unknown top-level keys, and silently round-tripping something nothing reads
 * would make the store a place to hide config that does nothing.
 */
export const TOP_LEVEL_KEYS = ["_notes", "preflight", "accounts", "roster", "policy", "campaigns", "queue"] as const;
export type TopLevelKey = (typeof TOP_LEVEL_KEYS)[number];

/** The keys whose entries get a row each. Everything else is a singleton row. */
export const COLLECTION_KEYS = ["roster", "campaigns", "queue"] as const;
export type CollectionKey = (typeof COLLECTION_KEYS)[number];

function isCollection(k: string): k is CollectionKey {
  return (COLLECTION_KEYS as readonly string[]).includes(k);
}

/**
 * Whether a row key is one the renderer would actually emit.
 *
 * Checked on every write, because `renderFleet` walks the keys it knows: a row
 * under a key it does not would sit in the store, pass validation (an unknown
 * top-level key is not in the rendered config at all, so nothing refuses it)
 * and change nothing — config that does nothing, which is exactly what the
 * strict-key rules in `parseFleet` exist to prevent.
 */
export function isConfigKey(key: string): boolean {
  const slash = key.indexOf("/");
  if (slash < 0) return (TOP_LEVEL_KEYS as readonly string[]).includes(key);
  const head = key.slice(0, slash);
  const name = key.slice(slash + 1);
  if (!isCollection(head) || name.length === 0 || name.includes("/")) return false;
  if (head === "queue") return /^\d+$/.test(name);
  return /^[A-Za-z0-9_.:-]+$/.test(name);
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

/** One line of the change history. `before`/`after` null means created/deleted. */
export interface AuditRow {
  id: number;
  ts: number;
  key: string;
  before: unknown | null;
  after: unknown | null;
  actor: string;
  note: string | null;
}

/** A write refused by `parseFleet`. The message is the file's own refusal text. */
export class ConfigRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigRejected";
  }
}

// ------------------------------------------------------------------ paths

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

// --------------------------------------------------------- split and render

/** Split a fleet config document into the rows that hold it. */
export function splitFleet(raw: unknown): ConfigRow[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigRejected("fleet config must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const now = Date.now();
  const rows: ConfigRow[] = [];
  for (const [i, key] of TOP_LEVEL_KEYS.entries()) {
    if (!(key in o)) continue;
    const v = o[key];
    if (!isCollection(key)) {
      rows.push({ key, ord: i, value: v, updatedAt: now });
      continue;
    }
    if (key === "queue") {
      const list = Array.isArray(v) ? v : [];
      // An empty collection keeps the key as a singleton row, so a file that
      // says `"queue": []` exports as `"queue": []` and one that says nothing
      // exports as nothing.
      if (!Array.isArray(v) || list.length === 0) {
        rows.push({ key, ord: i, value: Array.isArray(v) ? [] : v, updatedAt: now });
        continue;
      }
      list.forEach((entry, n) => rows.push({ key: `queue/${n}`, ord: n, value: entry, updatedAt: now }));
      continue;
    }
    const entries = typeof v === "object" && v !== null && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : [];
    if (entries.length === 0) {
      rows.push({ key, ord: i, value: v, updatedAt: now });
      continue;
    }
    entries.forEach(([name, entry], n) => rows.push({ key: `${key}/${name}`, ord: n, value: entry, updatedAt: now }));
  }
  return rows;
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

/** The accept/reject gate: exactly what the supervisor does to the file. */
export function validateFleet(doc: unknown): void {
  try {
    parseFleet(doc);
  } catch (e) {
    throw new ConfigRejected(e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------- store

export interface OpenOptions {
  /** A reader (the supervisor). Never creates the file and never migrates it. */
  readonly?: boolean;
}

export interface PutOptions {
  actor?: string;
  note?: string;
}

/** The default actor: an unattributed write through the app. */
export const DEFAULT_ACTOR = "viewer";

export class ConfigStore {
  readonly db: Database;
  private readonly writable: boolean;

  constructor(path: string, opts: OpenOptions = {}) {
    this.writable = opts.readonly !== true;
    if (this.writable) mkdirSync(dirname(path), { recursive: true });
    this.db = this.writable ? new Database(path) : new Database(path, { readonly: true });
    try {
      this.db.exec(`PRAGMA busy_timeout = ${CONFIG_DB_BUSY_TIMEOUT_MS}`);
      if (this.writable) {
        // WAL so a reading supervisor never blocks the operator's edit. Writes
        // are single-writer by construction: one viewer process, one CLI at a
        // time, and the busy timeout above covers the overlap.
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS config (
             key TEXT PRIMARY KEY,
             ord INTEGER NOT NULL,
             json TEXT NOT NULL,
             updated_at INTEGER NOT NULL
           )`,
        );
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS config_audit (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             ts INTEGER NOT NULL,
             key TEXT NOT NULL,
             before_json TEXT,
             after_json TEXT,
             actor TEXT NOT NULL,
             note TEXT
           )`,
        );
      }
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Whether this store has been seeded. An empty file is NOT a seeded store. */
  isEmpty(): boolean {
    return this.rows().length === 0;
  }

  rows(): ConfigRow[] {
    let raw: { key: string; ord: number; json: string; updated_at: number }[];
    try {
      raw = this.db
        .query("SELECT key, ord, json, updated_at FROM config ORDER BY ord, key")
        .all() as { key: string; ord: number; json: string; updated_at: number }[];
    } catch {
      // A store that has never been written has no tables; that is "empty",
      // not an error a read-only supervisor should die on.
      return [];
    }
    return raw.map((r) => ({ key: r.key, ord: r.ord, value: JSON.parse(r.json) as unknown, updatedAt: r.updated_at }));
  }

  /** One document, or undefined. `key` is a row key (`roster/sonnet`). */
  get(key: string): unknown | undefined {
    return this.rows().find((r) => r.key === key)?.value;
  }

  /** The whole config, in fleet.json's shape. */
  render(): Record<string, unknown> {
    return renderFleet(this.rows());
  }

  /**
   * A monotone counter a reader can cheaply poll: the last audit id. It moves
   * on every accepted write and on nothing else.
   */
  version(): number {
    try {
      const row = this.db.query("SELECT COALESCE(MAX(id), 0) AS v FROM config_audit").get() as { v: number } | null;
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  }

  audit(limit = 100): AuditRow[] {
    let raw: { id: number; ts: number; key: string; before_json: string | null; after_json: string | null; actor: string; note: string | null }[];
    try {
      raw = this.db
        .query("SELECT id, ts, key, before_json, after_json, actor, note FROM config_audit ORDER BY id DESC LIMIT ?")
        .all(limit) as typeof raw;
    } catch {
      return [];
    }
    return raw.map((r) => ({
      id: r.id,
      ts: r.ts,
      key: r.key,
      before: r.before_json === null ? null : (JSON.parse(r.before_json) as unknown),
      after: r.after_json === null ? null : (JSON.parse(r.after_json) as unknown),
      actor: r.actor,
      note: r.note,
    }));
  }

  private requireWritable(): void {
    if (!this.writable) throw new Error("config store opened read-only");
  }

  /**
   * Write one row, after checking the config the write would produce.
   *
   * `value === undefined` deletes the row. The candidate is rendered whole and
   * parsed, so an edit that is fine in isolation and illegal in context — a
   * roster entry pinned to a subscription the policy does not list, a pin on
   * the preflight account — is refused here rather than at the next tick.
   */
  put(key: string, value: unknown, opts: PutOptions = {}): void {
    this.requireWritable();
    if (!isConfigKey(key)) {
      throw new ConfigRejected(
        `${key} is not a config key — singletons are ${TOP_LEVEL_KEYS.filter((k) => !isCollection(k)).join(", ")}; ` +
          `entries are roster/<name>, campaigns/<name> and queue/<n>`,
      );
    }
    const rows = this.rows();
    const at = Date.now();
    const before = rows.find((r) => r.key === key);
    const next = rows.filter((r) => r.key !== key);
    if (value !== undefined) {
      next.push({ key, ord: before?.ord ?? this.nextOrd(key, rows), value, updatedAt: at });
    }
    validateFleet(renderFleet(next));
    const tx = this.db.transaction(() => {
      if (value === undefined) {
        this.db.run("DELETE FROM config WHERE key = ?", [key]);
      } else {
        this.db.run(
          `INSERT INTO config (key, ord, json, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
          [key, before?.ord ?? this.nextOrd(key, rows), JSON.stringify(value), at],
        );
      }
      this.db.run("INSERT INTO config_audit (ts, key, before_json, after_json, actor, note) VALUES (?, ?, ?, ?, ?, ?)", [
        at,
        key,
        before === undefined ? null : JSON.stringify(before.value),
        value === undefined ? null : JSON.stringify(value),
        opts.actor ?? DEFAULT_ACTOR,
        opts.note ?? null,
      ]);
    });
    tx();
  }

  /**
   * Merge a partial document into an existing row. Shallow: a PATCH of a
   * roster entry sets the named keys and leaves the rest, which is what an
   * operator changing one model's tier means. A row that does not exist yet,
   * or a non-object document, is a create — there is nothing to merge into.
   */
  patch(key: string, partial: unknown, opts: PutOptions = {}): void {
    const before = this.get(key);
    if (
      typeof before !== "object" || before === null || Array.isArray(before) ||
      typeof partial !== "object" || partial === null || Array.isArray(partial)
    ) {
      this.put(key, partial, opts);
      return;
    }
    this.put(key, { ...(before as Record<string, unknown>), ...(partial as Record<string, unknown>) }, opts);
  }

  /** Where a new row of this key's kind goes: last among its own kind. */
  private nextOrd(key: string, rows: readonly ConfigRow[]): number {
    const slash = key.indexOf("/");
    if (slash < 0) {
      const i = (TOP_LEVEL_KEYS as readonly string[]).indexOf(key);
      return i < 0 ? TOP_LEVEL_KEYS.length : i;
    }
    const prefix = key.slice(0, slash + 1);
    const sibling = rows.filter((r) => r.key.startsWith(prefix));
    return sibling.length === 0 ? 0 : Math.max(...sibling.map((r) => r.ord)) + 1;
  }

  /**
   * Import a fleet config document. A no-op on a store that already has rows
   * unless `force`, which replaces every row and records one audit line per
   * key — the history says the store was reseeded, not that nothing happened.
   */
  seed(doc: unknown, opts: PutOptions & { force?: boolean } = {}): { seeded: boolean; keys: number } {
    this.requireWritable();
    const existing = this.rows();
    if (existing.length > 0 && opts.force !== true) return { seeded: false, keys: existing.length };
    validateFleet(doc);
    const rows = splitFleet(doc);
    const at = Date.now();
    const actor = opts.actor ?? DEFAULT_ACTOR;
    const note = opts.note ?? (existing.length > 0 ? "reseed --force" : "seed");
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM config");
      for (const r of rows) {
        this.db.run("INSERT INTO config (key, ord, json, updated_at) VALUES (?, ?, ?, ?)", [r.key, r.ord, JSON.stringify(r.value), at]);
        const before = existing.find((e) => e.key === r.key);
        this.db.run("INSERT INTO config_audit (ts, key, before_json, after_json, actor, note) VALUES (?, ?, ?, ?, ?, ?)", [
          at,
          r.key,
          before === undefined ? null : JSON.stringify(before.value),
          JSON.stringify(r.value),
          actor,
          note,
        ]);
      }
    });
    tx();
    return { seeded: true, keys: rows.length };
  }

  /** Import from a file path. Throws the file's own parse error if it is bad. */
  seedFromFile(path: string, opts: PutOptions & { force?: boolean } = {}): { seeded: boolean; keys: number } {
    return this.seed(JSON.parse(readFileSync(path, "utf8")) as unknown, { note: `seed from ${path}`, ...opts });
  }
}

/** Open the store. Read-only opens of a file that is not there return null. */
export function openConfigStore(path: string = configDbPath(), opts: OpenOptions = {}): ConfigStore | null {
  if (opts.readonly === true && !existsSync(path)) return null;
  return new ConfigStore(path, opts);
}

/**
 * The fleet config as JSON TEXT, from the store when it has been seeded and
 * from the file when it has not.
 *
 * This is the one seam the supervisor and the viewer read config through, so
 * "the store is live" is a property of every reader at once rather than of
 * whichever one was remembered. It returns text, not a parsed config, because
 * every caller already parses — through `parseFleet`, or through the viewer's
 * own roster schema — and handing them text leaves those refusals exactly
 * where they were.
 */
export function readFleetText(path: string, env: Record<string, string | undefined> = Bun.env): string {
  const dbPath = configDbPath(env);
  let store: ConfigStore | null = null;
  try {
    store = openConfigStore(dbPath, { readonly: true });
    if (store !== null) {
      const rows = store.rows();
      if (rows.length > 0) return JSON.stringify(renderFleet(rows));
    }
  } catch {
    // An unreadable store is not a reason to stop reading config: the file is
    // still there, and the supervisor's own rejection path reports whatever
    // comes back. Falling through is the conservative answer.
  } finally {
    store?.close();
  }
  return readFileSync(path, "utf8");
}

/** Whether the store at this path has been seeded (cheap, closes its handle). */
export function configStoreSeeded(env: Record<string, string | undefined> = Bun.env): boolean {
  const store = openConfigStore(configDbPath(env), { readonly: true });
  if (store === null) return false;
  try {
    return !store.isEmpty();
  } finally {
    store.close();
  }
}

/**
 * Seed the store from a config file if it is empty. The supervisor calls this
 * once at boot: a deployment that has never had a store gets one from the file
 * it was already reading, and from then on the file is the seed and the export.
 * Any failure is reported, never thrown — config that loads from a file is not
 * worth refusing to start over.
 */
export function seedIfEmpty(path: string, opts: PutOptions = {}, env: Record<string, string | undefined> = Bun.env): { seeded: boolean; error?: string } {
  let store: ConfigStore | null = null;
  try {
    store = new ConfigStore(configDbPath(env));
    const { seeded } = store.seedFromFile(path, { actor: "fleet", ...opts });
    return { seeded };
  } catch (e) {
    return { seeded: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    store?.close();
  }
}

// --------------------------------------------------------------------- CLI

const USAGE = `usage: bun runner/src/config-store.ts <command>

  seed [file] [--force]     import a fleet config (default infra/fleet.json)
  export [file]             render the store to fleet.json's shape (stdout, or write to file)
  get [key]                 print one row's document, or every key when omitted
  set <key> <json>          replace one row (JSON on argv, or "-" to read stdin); validated
  patch <key> <json>        merge into one row; validated
  delete <key>              remove one row; validated
  audit [n]                 the last n changes (default 20)

  --db <path>     the store (default $WRATHBENCH_CONFIG_DB, else $WRATHBENCH_DATA/config.sqlite)
  --actor <name>  who to record the change as (default "cli")
  --note <text>   why
`;

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, v === undefined ? 1 : 2);
    return v;
  };
  const has = (name: string): boolean => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const dbFlag = flag("--db");
  const actor = flag("--actor") ?? "cli";
  const note = flag("--note");
  const force = has("--force");
  const opts: PutOptions = { actor, ...(note !== undefined ? { note } : {}) };
  const cmd = args.shift();
  const dbPath = dbFlag ?? configDbPath();
  const repoRoot = resolve(import.meta.dir, "..", "..");

  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd === undefined ? 2 : 0;
  }

  const store = new ConfigStore(dbPath);
  try {
    switch (cmd) {
      case "seed": {
        const file = args[0] ?? join(repoRoot, "infra", "fleet.json");
        const { seeded, keys } = store.seedFromFile(file, { ...opts, force });
        console.error(seeded ? `seeded ${keys} keys from ${file} into ${dbPath}` : `${dbPath} already has ${keys} keys — pass --force to replace them`);
        return seeded ? 0 : 1;
      }
      case "export": {
        const text = `${JSON.stringify(store.render(), null, 2)}\n`;
        const out = args[0];
        if (out === undefined) process.stdout.write(text);
        else await Bun.write(out, text);
        return 0;
      }
      case "get": {
        const key = args[0];
        if (key === undefined) {
          for (const r of store.rows()) console.log(r.key);
          return 0;
        }
        const v = store.get(key);
        if (v === undefined) {
          console.error(`no such key: ${key}`);
          return 1;
        }
        console.log(JSON.stringify(v, null, 2));
        return 0;
      }
      case "set":
      case "patch": {
        const key = args[0];
        const raw = args[1];
        if (key === undefined || raw === undefined) {
          console.error(USAGE);
          return 2;
        }
        const text = raw === "-" ? await Bun.stdin.text() : raw;
        const doc = JSON.parse(text) as unknown;
        if (cmd === "set") store.put(key, doc, opts);
        else store.patch(key, doc, opts);
        console.error(`${cmd} ${key} ok`);
        return 0;
      }
      case "delete": {
        const key = args[0];
        if (key === undefined) {
          console.error(USAGE);
          return 2;
        }
        store.put(key, undefined, opts);
        console.error(`deleted ${key}`);
        return 0;
      }
      case "audit": {
        const n = Number(args[0] ?? "20");
        for (const r of store.audit(Number.isFinite(n) && n > 0 ? n : 20)) {
          const what = r.before === null ? "created" : r.after === null ? "deleted" : "changed";
          console.log(`${new Date(r.ts).toISOString()}  ${r.actor.padEnd(8)}  ${what.padEnd(7)}  ${r.key}${r.note === null ? "" : `  (${r.note})`}`);
        }
        return 0;
      }
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (e) {
    console.error(`config-store: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
