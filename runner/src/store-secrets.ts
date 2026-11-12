/**
 * Secrets in the config store: a provider key or a subscription token entered
 * on the admin page, kept sealed beside the config (operator decision,
 * 2026-11-12: encrypted in the store, the key held in the deployment's
 * existing Secret, over a SOPS PR to GitOps or an app-owned Kubernetes Secret).
 *
 * **Write-only.** A secret goes in from the browser or the CLI's stdin and
 * comes out only where a model's process needs it: the supervisor's usage
 * reader, an episode's environment, a run pod's sealed variable. No API
 * response, log line, audit row, export or public artifact carries its value
 * or its ciphertext; `storeSecretMetas` is the only listing, and it carries
 * names, times and who.
 *
 * **Sealed.** AES-256-GCM under a key derived (HKDF-SHA256) from
 * `WRATHBENCH_STORE_KEY`, 32 random bytes as 64 hex characters or base64,
 * with the variable's NAME as the additional data: a row copied onto another
 * name, or a byte changed anywhere, does not open. Each row records the id of
 * the key that sealed it (an HMAC of the key, never the key), so a row under
 * another key fails with that sentence rather than as tampering. Both fail
 * closed: the variable reads as unset, the env's value is NOT used in its
 * place, and a launch that needs it is refused.
 *
 * **Its own table.** `config_secrets`, never a `config` row: `rows()`,
 * `render`, `export`, `get`, `/api/config` and `parseFleet` read only
 * `config`, so none of them can see one by construction. A write records a
 * `secrets/<NAME>` line in `config_audit` whose before and after carry an
 * HMAC fingerprint (8 hex, keyed by the store key) and nothing else, which is
 * also what moves the store's `version()` so a reader re-derives.
 *
 * **Names, not any variable.** Only a name a token- or key-holding provider's
 * credential may name (`isProviderEnvName`): `OPENROUTER_KEY_2`,
 * `CLAUDE_CODE_OAUTH_TOKEN`. Never a Codex home (a path, not a secret), and
 * never an arbitrary variable, which an episode's environment would then
 * carry (`LD_PRELOAD`, `NODE_OPTIONS`).
 *
 * **Precedence.** Where a variable has a stored secret, it wins over the
 * environment's (the SOPS-generated Secret); without one, the environment as
 * before. It is read at each use — each launch, each supervisor tick — so a
 * new secret applies to the next launch with no restart.
 */

import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { configDbPath, CONFIG_DB_BUSY_TIMEOUT_MS, DEFAULT_ACTOR, type ConfigStore, type PutOptions } from "./config-store";
import { CREDENTIAL_PROVIDERS, isProviderEnvName } from "./credential-slots";

/** The env var holding the store key. From the deployment's Secret, optional. */
export const STORE_KEY_ENV = "WRATHBENCH_STORE_KEY";

/**
 * A run pod's one stored secret, as `<NAME>:<sealed>`: the row exactly as the
 * store holds it, which only the store key opens (`unsealLaunchSecret`). The
 * pod spec carries ciphertext, never the value.
 */
export const SEALED_SECRET_ENV = "WRATHBENCH_SEALED_SECRET";

/** The audit key prefix: `secrets/<NAME>`. */
export const SECRET_AUDIT_PREFIX = "secrets/";

/** The most a secret may be. A key or a token is far shorter. */
export const MAX_SECRET_LENGTH = 8192;

const TABLE = "config_secrets";
const FORMAT = "v1";

/** The store key, parsed: the two derived keys and its id. Never the raw bytes. */
export interface StoreKey {
  readonly enc: Buffer;
  readonly mac: Buffer;
  /** Names the key without revealing it: 8 hex of an HMAC under it. */
  readonly id: string;
}

/** The store key is missing or malformed: setting a secret is refused, reading one fails closed. */
export class StoreKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreKeyError";
  }
}

/** A secret write refused by name, by value, or for want of a key. The message never carries the value. */
export class SecretRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretRefused";
  }
}

/** A stored secret that does not open: another key, or changed bytes. */
export class SecretUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretUnreadable";
  }
}

/** Parse the store key's text: 64 hex characters, or base64 of 32 bytes. The message never quotes it. */
export function parseStoreKey(raw: string): StoreKey {
  const text = raw.trim();
  let bytes: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(text)) bytes = Buffer.from(text, "hex");
  else if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(text)) {
    const b = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) bytes = b;
  }
  if (bytes === undefined) throw new StoreKeyError(`${STORE_KEY_ENV} must be 32 random bytes, as 64 hex characters or base64 (openssl rand -hex 32)`);
  const derive = (info: string): Buffer => Buffer.from(hkdfSync("sha256", bytes!, "wrathbench-store", info, 32));
  const mac = derive("secret-fingerprint v1");
  return { enc: derive("secret-seal v1"), mac, id: createHmac("sha256", mac).update("key-id").digest("hex").slice(0, 8) };
}

/** The store key from the environment: the key, or why there is none. */
export function storeKeyOf(env: Record<string, string | undefined> = process.env): { key: StoreKey } | { key: null; why: string } {
  const raw = env[STORE_KEY_ENV];
  if (raw === undefined || raw.trim().length === 0) return { key: null, why: `no store key: ${STORE_KEY_ENV} is not set` };
  try {
    return { key: parseStoreKey(raw) };
  } catch (e) {
    return { key: null, why: e instanceof Error ? e.message : String(e) };
  }
}

const aad = (name: string): Buffer => Buffer.from(`wrathbench-store-secret ${FORMAT} ${name}`, "utf8");
const b64 = (b: Buffer): string => b.toString("base64url");

/** Seal one value under its name: `v1.<key id>.<iv>.<ciphertext>.<tag>`. */
export function sealSecret(key: StoreKey, name: string, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key.enc, iv);
  c.setAAD(aad(name));
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return [FORMAT, key.id, b64(iv), b64(ct), b64(c.getAuthTag())].join(".");
}

/** Open a sealed value under its name, or throw `SecretUnreadable`. */
export function openSecret(key: StoreKey, name: string, sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT) throw new SecretUnreadable(`${name}: the stored secret is not in a format this harness reads`);
  const [, keyId, iv, ct, tag] = parts as [string, string, string, string, string];
  if (keyId !== key.id) throw new SecretUnreadable(`${name}: sealed under another store key (${keyId}; this one is ${key.id})`);
  try {
    const d = createDecipheriv("aes-256-gcm", key.enc, Buffer.from(iv, "base64url"));
    d.setAAD(aad(name));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new SecretUnreadable(`${name}: the stored secret does not open — its bytes were changed, or it was sealed for another name`);
  }
}

/** 8 hex that tell two values apart without revealing either: an HMAC under the store key. */
export function secretFingerprint(key: StoreKey, name: string, value: string): string {
  return createHmac("sha256", key.mac).update(`${name}\0${value}`).digest("hex").slice(0, 8);
}

/** Why a name may not hold a stored secret, or null. Only a token's or a key's variable may. */
export function secretNameRefusal(name: string): string | null {
  const p = CREDENTIAL_PROVIDERS.find((x) => isProviderEnvName(x, name));
  if (p === undefined) {
    const names = [...new Set(CREDENTIAL_PROVIDERS.filter((x) => x.holds !== "home").map((x) => x.envBase))].join(", ");
    return `${name} is no provider's secret variable — one of ${names}, or one with a numbered suffix`;
  }
  if (p.holds === "home") return `${name} names a Codex home, a directory and not a secret — log it in again with re-auth`;
  return null;
}

/** Why a value may not be stored, or null. Never quotes it. */
export function secretValueRefusal(value: unknown): string | null {
  if (typeof value !== "string") return "the secret must be a string";
  const v = value.trim();
  if (v.length === 0) return "the secret is empty";
  if (v.length > MAX_SECRET_LENGTH) return `the secret is longer than ${MAX_SECRET_LENGTH} characters`;
  // A control character is a paste gone wrong, and a newline would split an env file.
  if (/[\u0000-\u001f\u007f]/.test(v)) return "the secret holds a control character or a line break";
  return null;
}

// ------------------------------------------------------------------ the table

/** One stored secret as it may be listed: no value, no ciphertext. */
export interface StoredSecretMeta {
  name: string;
  updatedAt: number;
  actor: string;
  /** The id of the key that sealed it. */
  keyId: string;
}

function ensureTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       name TEXT PRIMARY KEY,
       sealed TEXT NOT NULL,
       key_id TEXT NOT NULL,
       updated_at INTEGER NOT NULL,
       actor TEXT NOT NULL
     )`,
  );
}

type Row = { name: string; sealed: string; key_id: string; updated_at: number; actor: string };

function selectRows(db: Database): Row[] {
  try {
    return db.query(`SELECT name, sealed, key_id, updated_at, actor FROM ${TABLE} ORDER BY name`).all() as Row[];
  } catch (e) {
    // A store no secret was ever written to has no table: none, not an error.
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
    throw e;
  }
}

function fingerprintOf(key: StoreKey | null, name: string, sealed: string | undefined): string | null {
  if (sealed === undefined || key === null) return null;
  try {
    return secretFingerprint(key, name, openSecret(key, name, sealed));
  } catch {
    return null;
  }
}

function audit(db: Database, name: string, before: string | null, after: string | null, opts: PutOptions): void {
  db.run("INSERT INTO config_audit (ts, key, before_json, after_json, actor, note) VALUES (?, ?, ?, ?, ?, ?)", [
    Date.now(),
    `${SECRET_AUDIT_PREFIX}${name}`,
    before === null ? null : JSON.stringify({ fingerprint: before }),
    after === null ? null : JSON.stringify({ fingerprint: after }),
    opts.actor ?? DEFAULT_ACTOR,
    opts.note ?? null,
  ]);
}

/**
 * Store a secret under its variable's name, sealed, and record that it was
 * set or rotated. Refused, writing nothing, without a usable store key, for a
 * name no token or key provider uses, or for a value that cannot be one.
 * Returns the new value's fingerprint.
 */
export function setStoreSecret(
  store: ConfigStore,
  name: string,
  value: unknown,
  opts: PutOptions & { env?: Record<string, string | undefined> } = {},
): { fingerprint: string } {
  const k = storeKeyOf(opts.env ?? process.env);
  if (k.key === null) throw new SecretRefused(`setting a secret is refused — ${k.why}`);
  const byName = secretNameRefusal(name);
  if (byName !== null) throw new SecretRefused(byName);
  const byValue = secretValueRefusal(value);
  if (byValue !== null) throw new SecretRefused(byValue);
  const v = (value as string).trim();
  const key = k.key;
  const sealed = sealSecret(key, name, v);
  const fingerprint = secretFingerprint(key, name, v);
  const tx = store.db.transaction(() => {
    ensureTable(store.db);
    const was = selectRows(store.db).find((r) => r.name === name);
    store.db.run(
      `INSERT INTO ${TABLE} (name, sealed, key_id, updated_at, actor) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET sealed = excluded.sealed, key_id = excluded.key_id, updated_at = excluded.updated_at, actor = excluded.actor`,
      [name, sealed, key.id, Date.now(), opts.actor ?? DEFAULT_ACTOR],
    );
    // A row that no longer opens is still recorded as replaced, fingerprint unknown.
    audit(store.db, name, was === undefined ? null : (fingerprintOf(key, name, was.sealed) ?? "unreadable"), fingerprint, opts);
  });
  tx();
  return { fingerprint };
}

/** Remove a stored secret, so the variable falls back to the environment's. Needs no key. False when there was none. */
export function clearStoreSecret(store: ConfigStore, name: string, opts: PutOptions & { env?: Record<string, string | undefined> } = {}): boolean {
  const k = storeKeyOf(opts.env ?? process.env);
  let cleared = false;
  const tx = store.db.transaction(() => {
    const was = selectRows(store.db).find((r) => r.name === name);
    if (was === undefined) return;
    store.db.run(`DELETE FROM ${TABLE} WHERE name = ?`, [name]);
    audit(store.db, name, fingerprintOf(k.key, name, was.sealed) ?? "unreadable", null, opts);
    cleared = true;
  });
  tx();
  return cleared;
}

/** Every stored secret's name and when and by whom it was set. Never the value or the ciphertext. */
export function storeSecretMetas(db: Database): StoredSecretMeta[] {
  return selectRows(db).map((r) => ({ name: r.name, updatedAt: r.updated_at, actor: r.actor, keyId: r.key_id }));
}

/** Read the table off a store file, read-only. A file that is not there holds none. */
function readRows(dbPath: string): Row[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${CONFIG_DB_BUSY_TIMEOUT_MS}`);
    return selectRows(db);
  } finally {
    db.close();
  }
}

/** The stored secrets' metadata off a store file. */
export function storedSecretsAt(dbPath: string = configDbPath()): StoredSecretMeta[] {
  return readRows(dbPath).map((r) => ({ name: r.name, updatedAt: r.updated_at, actor: r.actor, keyId: r.key_id }));
}

// ------------------------------------------------------------------ resolution

/** One variable's stored secret as a reader finds it. */
export type StoredSecret =
  | { status: "absent" }
  | { status: "ok"; value: string; sealed: string }
  | { status: "unreadable"; why: string };

/**
 * The environment with every stored secret applied over it: what the
 * supervisor reads its keys from. A stored secret that does not open (no key,
 * another key, changed bytes) removes the variable rather than leaving the
 * environment's value in force — fail closed — and says why in `unreadable`.
 */
export interface SecretResolution {
  env: Record<string, string | undefined>;
  /** Names with a stored secret, readable or not. */
  stored: ReadonlySet<string>;
  /** Names whose stored secret does not open, with why. */
  unreadable: ReadonlyMap<string, string>;
  /** When each stored secret was last set. */
  updatedAt: ReadonlyMap<string, number>;
}

export function resolveStoreSecrets(
  env: Record<string, string | undefined> = process.env,
  opts: { dbPath?: string } = {},
): SecretResolution {
  const out: Record<string, string | undefined> = { ...env };
  const stored = new Set<string>();
  const unreadable = new Map<string, string>();
  const updatedAt = new Map<string, number>();
  let rows: Row[];
  try {
    rows = readRows(opts.dbPath ?? configDbPath(env));
  } catch (e) {
    // The store cannot be read: nothing is known to be stored. The config
    // reader reports the same failure, and keeps its last good config.
    rows = [];
    void e;
  }
  if (rows.length === 0) return { env: out, stored, unreadable, updatedAt };
  const k = storeKeyOf(env);
  for (const r of rows) {
    stored.add(r.name);
    updatedAt.set(r.name, r.updated_at);
    // A row a name check would refuse now is never applied (a table edited by hand).
    const byName = secretNameRefusal(r.name);
    if (byName !== null) {
      unreadable.set(r.name, byName);
      continue;
    }
    if (k.key === null) {
      unreadable.set(r.name, `${r.name}: stored, but ${k.why}`);
      delete out[r.name];
      continue;
    }
    try {
      out[r.name] = openSecret(k.key, r.name, r.sealed);
    } catch (e) {
      unreadable.set(r.name, e instanceof Error ? e.message : String(e));
      delete out[r.name];
    }
  }
  return { env: out, stored, unreadable, updatedAt };
}

/** One variable's stored secret, read fresh: what a launch reads. */
export function readStoreSecret(name: string, opts: { env?: Record<string, string | undefined>; dbPath?: string } = {}): StoredSecret {
  const env = opts.env ?? process.env;
  let row: Row | undefined;
  try {
    row = readRows(opts.dbPath ?? configDbPath(env)).find((r) => r.name === name);
  } catch (e) {
    return { status: "unreadable", why: `${name}: the config store cannot be read (${e instanceof Error ? e.message : String(e)})` };
  }
  if (row === undefined) return { status: "absent" };
  const byName = secretNameRefusal(name);
  if (byName !== null) return { status: "unreadable", why: byName };
  const k = storeKeyOf(env);
  if (k.key === null) return { status: "unreadable", why: `${name}: stored, but ${k.why}` };
  try {
    return { status: "ok", value: openSecret(k.key, name, row.sealed), sealed: row.sealed };
  } catch (e) {
    return { status: "unreadable", why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Where a launch's variable comes from: the stored secret when there is one,
 * else the environment's. `refused` when a stored one does not open: the
 * launch is refused with that reason rather than run on the environment's.
 */
export function launchSecret(
  name: string,
  opts: { env?: Record<string, string | undefined>; dbPath?: string } = {},
): { source: "store"; value: string; sealed: string } | { source: "env" } | { source: "refused"; why: string } {
  const s = readStoreSecret(name, opts);
  if (s.status === "ok") return { source: "store", value: s.value, sealed: s.sealed };
  if (s.status === "unreadable") return { source: "refused", why: s.why };
  return { source: "env" };
}

/**
 * In a run pod, before anything reads its environment: open the one sealed
 * secret the launcher handed it (`SEALED_SECRET_ENV`) into its variable, and
 * drop both the sealed form and the store key from the process's environment,
 * so no child can inherit either. Returns the variable set, null with nothing
 * sealed, or throws `SecretUnreadable` / `StoreKeyError` (run.ts refuses the
 * launch).
 */
export function unsealLaunchSecret(env: Record<string, string | undefined> = process.env): string | null {
  const sealed = env[SEALED_SECRET_ENV];
  const keyText = env[STORE_KEY_ENV];
  delete env[SEALED_SECRET_ENV];
  delete env[STORE_KEY_ENV];
  if (sealed === undefined || sealed.length === 0) return null;
  const colon = sealed.indexOf(":");
  const name = colon > 0 ? sealed.slice(0, colon) : "";
  const byName = secretNameRefusal(name);
  if (byName !== null) throw new SecretUnreadable(`${SEALED_SECRET_ENV}: ${byName}`);
  const k = storeKeyOf({ [STORE_KEY_ENV]: keyText });
  if (k.key === null) throw new StoreKeyError(`${name} was handed over sealed, but ${k.why}`);
  env[name] = openSecret(k.key, name, sealed.slice(colon + 1));
  return name;
}
