/**
 * The config store: the fleet config as rows in a small sqlite on the data
 * volume. It is the ONLY fleet config (operator decision, 2026-09-18): the
 * supervisor, the viewer and the deploy scripts read it and nothing else, and
 * the active config is operational state on the data volume, never a file in
 * git. `infra/fleet.example.json` is the bootstrap a fresh deployment seeds
 * from once (`seed`); `export` renders the store to a local file for reading
 * or diffing, never for committing (docs/RUNBOOK.md, "Where the config
 * lives").
 *
 * Three rules shape everything here.
 *
 * **The store holds the config as WRITTEN, never as parsed.** `parseFleet`
 * fills defaults (`preflight.timeoutMs`, `policy.subscriptions`), normalises
 * shapes (`smokes: ["x.ts"]` becomes `{script, account}`) and annotates
 * entries it refuses. Rendering a parsed config back out would therefore never
 * equal the document that came in, and an export an operator diffs against an
 * earlier export would be noise. So each row is the raw JSON document as it
 * was written, and parsing is only ever the accept/reject gate.
 *
 * **One validator.** A write renders the whole candidate config and runs it
 * through `parseFleet`, the same function the supervisor runs the store
 * through. An edit the supervisor would refuse is refused here with the same
 * message. There is deliberately no second, store-shaped schema: two
 * validators is how the store and the supervisor come to disagree about what
 * is legal.
 *
 * **Granularity is per entry, and order is kept.** `roster/<name>`,
 * `campaigns/<name>` and `queue/<n>` are rows of their own so an edit to one
 * model rewrites one row; `_notes`, `preflight`, `accounts` and `policy` are
 * singletons. Every row carries an `ord` because order is load-bearing —
 * two enabled pins on one account are resolved by "the first in order keeps
 * it" — so a key-sorted render would change which pin wins.
 *
 * **Empty and unreadable are different states** (`readFleetConfig`). A store
 * with zero rows, or none at all, is a legitimate state: the supervisor runs
 * an empty board and says how to seed it. A store that cannot be opened is
 * transient: a reader keeps its last good config. The two must never be
 * confused, because "every job vanished" and "the disk hiccupped" call for
 * opposite actions.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFleet } from "../../infra/run-fleet-config";

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
export const TOP_LEVEL_KEYS = ["_notes", "preflight", "accounts", "roster", "policy", "campaigns", "queue"] as const;

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

  /** One document, or undefined. `key` is a row key (`roster/sonnet`). */
  get(key: string): unknown | undefined {
    return this.rows().find((r) => r.key === key)?.value;
  }

  /** The whole config, in the export's shape. */
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

/** The one line every reader prints for an empty store. */
export const EMPTY_STORE_HINT =
  "config store empty — seed it: bun runner/src/config-store.ts seed infra/fleet.example.json, or add entries on /config";

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
 * property of every reader at once.
 */
export function readFleetConfig(path: string = configDbPath()): FleetRead {
  let store: ConfigStore | null = null;
  try {
    store = openConfigStore(path, { readonly: true });
    if (store === null) return { status: "empty", path };
    const rows = store.rows();
    if (rows.length === 0) return { status: "empty", path };
    return { status: "ok", path, text: JSON.stringify(renderFleet(rows)) };
  } catch (e) {
    return { status: "unreadable", path, error: e instanceof Error ? e.message : String(e) };
  } finally {
    store?.close();
  }
}

/** Whether the store at this path has been seeded (cheap, closes its handle). */
export function configStoreSeeded(env: Record<string, string | undefined> = Bun.env): boolean {
  return readFleetConfig(configDbPath(env)).status === "ok";
}

// --------------------------------------------------------------------- CLI

const USAGE = `usage: bun runner/src/config-store.ts <command>

  seed [file] [--force]     import a fleet config document (default infra/fleet.example.json, the bootstrap)
  export [file]             render the store to a config document (stdout, or write to file) — for reading or
                            diffing, never for committing
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
        const file = args[0] ?? join(repoRoot, "infra", "fleet.example.json");
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
