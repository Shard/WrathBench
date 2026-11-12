/**
 * The admin API (GitHub issue #427): what the admin pages show beside the
 * config they edit, and the two writes that are not config rows. Mounted,
 * like the config API, only on a handle with the admin switch on
 * (`groups.ts`). Every config write the admin pages make is a config-store
 * write through `config-api.ts`, validated by `parseFleet` exactly as the
 * CLI's is; the store stays the one source of truth.
 *
 *   GET    /api/admin                     the groups, the credentials with their
 *                                         status, the providers a credential may
 *                                         name, and publishing
 *   PUT    /api/admin/secrets/<NAME>      store a credential's secret, sealed
 *                                         ({ value }; write-only)
 *   DELETE /api/admin/secrets/<NAME>      remove it: the environment's stands again
 *   POST   /api/admin/codex-login/<id>    ask the supervisor to log a Codex home in
 *
 * **Secrets go in and never come out.** A credential names the env var its
 * secret is in (`secretEnv`). The value is the deployment's Secret, or a
 * secret set here, sealed in the config store under the store key
 * (`runner/src/store-secrets.ts`), which wins. A PUT takes a value and
 * answers with the name and whether one is stored; nothing here reads a
 * stored value back, serves its ciphertext, or quotes a refused value. A
 * secret is only ever one some credential names, and only a token's or a
 * key's: never an arbitrary variable, never a Codex home's path.
 *
 * Whether a variable is set is the supervisor's word, read off the state it
 * publishes (`fleet-state.json`), or a secret the store holds that opens with
 * this viewer's key; unknown (null) while neither says. Whether the chart
 * hands the variable to the model pods at all is the chart's `modelKeys`,
 * which it passes here as `WRATHBENCH_MODEL_KEYS`, and which a stored secret
 * makes moot: it reaches each launch from the store.
 *
 * **A Codex home is logged in again, not set.** Its volume is the fleet's and
 * the runner pod's, never the viewer's, so the POST leaves a request beside
 * the store for the supervisor (`runner/src/codex-login.ts`), and the
 * credential's `login` reports the link and one-time code it is waiting on.
 *
 * **Each credential's health** (`health`, `windows`, `fix`) is derived from
 * those same sources and nothing else (`credentialHealth`,
 * runner/src/credential-health.ts): the store's switch, the chart's
 * `modelKeys`, and the supervisor's published inputs — the variable, the
 * budget's holds, the newest paused run that indicts it, and the provider's
 * last read. With no supervisor up it is null (unknown) unless the store or
 * the chart already says what is wrong.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexLoginDir, effectiveCodexLogin, readCodexLogin, readCodexLoginRequest, requestCodexLogin } from "../src/codex-login";
import { configDbPath, ConfigStore } from "../src/config-store";
import { credentialHealth } from "../src/credential-health";
import { CREDENTIAL_PROVIDERS, describeBudget, parseCredentials, providerById, type Credential } from "../src/credential-slots";
import { clearStoreSecret, SecretRefused, setStoreSecret, storedSecretsAt, storeKeyOf, type StoredSecretMeta } from "../src/store-secrets";
import { publishViewFromEnv } from "../../infra/publish-settings";
import type { AdminCodexLoginView, AdminCredentialView, AdminPublishView, AdminResponse, FleetResponse } from "./api-types";
import { actorOf } from "./config-api";
import type { Groups } from "./groups";

export const ADMIN_API_PREFIX = "/api/admin";

/** A supervisor whose heartbeat is older than this is not up (`HEARTBEAT_STALE_MS`, three ticks). */
export const FLEET_UP_MS = 3 * 60_000;

export interface AdminApiOptions {
  groups: Groups;
  /** The store; the data volume's by default. */
  dbPath?: string;
  /** Where the supervisor publishes its state (`fleet-state.json`): the runs directory. */
  runsDir: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The credentials the store holds, or none when it holds none or does not read. */
function storedCredentials(dbPath: string): Credential[] {
  if (!existsSync(dbPath)) return [];
  const store = new ConfigStore(dbPath, { readonly: true });
  try {
    return parseCredentials(store.render()["credentials"]);
  } catch {
    return [];
  } finally {
    store.close();
  }
}

export function modelKeysFromEnv(env: Record<string, string | undefined>): string[] | null {
  const raw = env["WRATHBENCH_MODEL_KEYS"];
  if (raw === undefined) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Every credential the store holds, in its order, joined to the supervisor's
 * status by id when the supervisor is up. A credential the supervisor has not
 * seen yet (written since its last tick) reads as unknown, not as unset.
 */
export function credentialViews(o: {
  stored: readonly Credential[];
  fleet: Pick<FleetResponse, "credentials">;
  up: boolean;
  modelKeys: readonly string[] | null;
  /** The secrets the config store holds, by name: metadata only. */
  secrets?: readonly StoredSecretMeta[];
  /** This viewer's store key's id, when it has one: a stored secret sealed under another does not open. */
  keyId?: string | null;
  /** Each Codex home credential's login, by id. */
  logins?: ReadonlyMap<string, AdminCodexLoginView>;
}): AdminCredentialView[] {
  const status = new Map((o.up ? (o.fleet.credentials ?? []) : []).map((c) => [c.id, c]));
  const secrets = new Map((o.secrets ?? []).map((m) => [m.name, m]));
  return o.stored.map((c): AdminCredentialView => {
    const found = status.get(c.id);
    // A status about another variable (renamed since the tick) is about another secret.
    const s = found !== undefined && found.secretEnv === c.secretEnv ? found : undefined;
    const deployed = o.modelKeys === null ? null : o.modelKeys.includes(c.secretEnv);
    const holds = providerById(c.provider)?.holds ?? "key";
    // The store's own word on its secret, fresher than a tick: one set a moment
    // ago is set now, and one under another key opens nowhere.
    const meta = holds === "home" ? undefined : secrets.get(c.secretEnv);
    const stored = meta !== undefined;
    const storedUnreadable =
      meta !== undefined && o.keyId != null && meta.keyId !== o.keyId ? `${c.secretEnv}: sealed under another store key (${meta.keyId}; this one is ${o.keyId})` : null;
    const storedOk = stored && storedUnreadable === null;
    const secretSet = storedOk ? true : storedUnreadable !== null ? false : s !== undefined ? s.secretSet : null;
    // A secret replaced since a refusal was seen: the refusal was the old one's.
    const login = o.logins?.get(c.id) ?? null;
    const replacedAt = Math.max(meta?.updatedAt ?? 0, login?.state === "ok" ? login.at : 0) || null;
    // Derived here again rather than taken as published: the store's switch and
    // the chart's modelKeys are the viewer's to read, and fresher than a tick.
    let derived: ReturnType<typeof credentialHealth> | null = null;
    if (s !== undefined) {
      derived = credentialHealth({
        enabled: c.enabled,
        secretEnv: c.secretEnv,
        holds,
        secretSet: secretSet === true,
        stored,
        storedUnreadable,
        deployed,
        // A supervisor that predates the codes worded its holds only.
        holdsOf: s.holds ?? Object.fromEntries(Object.keys(s.held).map((k) => [k, { code: null, until: null }])),
        lastError: s.lastError,
        read: s.lastRead ?? null,
        replacedAt,
      });
    } else if (!c.enabled || (deployed === false && !stored) || storedUnreadable !== null) {
      derived = credentialHealth({ enabled: c.enabled, secretEnv: c.secretEnv, holds, secretSet: true, stored, storedUnreadable, deployed, holdsOf: {}, lastError: null });
    }
    return {
      id: c.id,
      provider: c.provider,
      billing: c.billing,
      enabled: c.enabled,
      secretEnv: c.secretEnv,
      slots: c.slots,
      budget: describeBudget(c.budget),
      secretSet,
      stored,
      login,
      deployed,
      inUse: s?.inUse ?? null,
      used: s?.used ?? null,
      held: s?.held ?? {},
      lastError: s?.lastError ?? null,
      health: derived?.health ?? null,
      windows: s?.windows ?? null,
      fix: derived?.fix ?? null,
    };
  });
}

/** The publisher's state file, read for its last pass and memoised by size and mtime: it can run to megabytes. */
function publishStateReader(path: string | undefined): () => AdminPublishView["last"] {
  let memo: { key: string; value: AdminPublishView["last"] } | undefined;
  return () => {
    if (path === undefined || !existsSync(path)) return null;
    try {
      const st = statSync(path);
      const key = `${st.size}:${st.mtimeMs}`;
      if (memo?.key === key) return memo.value;
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        lastFlipAt?: unknown;
        lastGen?: unknown;
        held?: unknown;
        secretScan?: { at?: unknown; withheld?: unknown };
      };
      const value: AdminPublishView["last"] = {
        flipAt: typeof raw.lastFlipAt === "number" ? raw.lastFlipAt : null,
        gen: typeof raw.lastGen === "string" ? raw.lastGen : null,
        held: Array.isArray(raw.held) ? raw.held.length : 0,
        scanAt: typeof raw.secretScan?.at === "number" ? raw.secretScan.at : null,
        withheld: Array.isArray(raw.secretScan?.withheld) ? raw.secretScan.withheld.length : 0,
      };
      memo = { key, value };
      return value;
    } catch {
      return null;
    }
  };
}

/**
 * The two things this route needs of the supervisor's published state, its
 * heartbeat and its credentials, read straight from the file: `/api/fleet`'s
 * reader also walks the runs for held accounts, which this does not need.
 */
export function readSupervisor(runsDir: string): Pick<FleetResponse, "present" | "heartbeatAt" | "credentials"> {
  try {
    const raw = JSON.parse(readFileSync(join(runsDir, "fleet-state.json"), "utf8")) as { heartbeatAt?: unknown; credentials?: unknown };
    return {
      present: true,
      ...(typeof raw.heartbeatAt === "number" ? { heartbeatAt: raw.heartbeatAt } : {}),
      ...(Array.isArray(raw.credentials) ? { credentials: raw.credentials as NonNullable<FleetResponse["credentials"]> } : {}),
    };
  } catch {
    return { present: false };
  }
}

/** The biggest body a secret write may send. A key or a token is far shorter. */
const MAX_SECRET_BODY = 16 * 1024;

/** A Codex home's login as the page shows it: the supervisor's state, or a request it has not taken yet. */
function loginViews(dir: string, credentials: readonly Credential[], now: number): Map<string, AdminCodexLoginView> {
  const out = new Map<string, AdminCodexLoginView>();
  for (const c of credentials) {
    if (providerById(c.provider)?.holds !== "home") continue;
    const s = effectiveCodexLogin(readCodexLogin(dir, c.id), now);
    const req = readCodexLoginRequest(dir, c.id, now);
    if (req !== null && !req.stale) {
      out.set(c.id, { state: "requested", at: req.at, actor: req.actor, url: null, code: null, expiresAt: null, detail: null });
    } else if (req !== null) {
      out.set(c.id, { state: "failed", at: req.at, actor: req.actor, url: null, code: null, expiresAt: null, detail: "the supervisor did not take the request" });
    } else if (s !== null) {
      out.set(c.id, { state: s.state, at: s.at, actor: s.actor, url: s.url ?? null, code: s.code ?? null, expiresAt: s.expiresAt ?? null, detail: s.detail ?? null });
    }
  }
  return out;
}

/** The secrets the store holds, by name, or none when it cannot be read. */
function storedSecrets(dbPath: string): StoredSecretMeta[] {
  try {
    return storedSecretsAt(dbPath);
  } catch {
    return [];
  }
}

/** The handler: `/api/admin` and its write routes, or null for any other path. */
export function createAdminApi(opts: AdminApiOptions): (req: Request, path: string) => Promise<Response | null> | Response | null {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const lastPass = publishStateReader(env["WRATHBENCH_PUBLISH_STATE"]);
  const dbPath = (): string => opts.dbPath ?? configDbPath(env);
  const loginDir = (): string => codexLoginDir({ ...env, WRATHBENCH_CONFIG_DB: dbPath() });
  const supervisorUp = (t: number): { up: boolean; heartbeatAt: number | null; fleet: ReturnType<typeof readSupervisor> | null } => {
    const fleet = opts.groups.runner ? readSupervisor(opts.runsDir) : null;
    const heartbeatAt = fleet?.present === true ? (fleet.heartbeatAt ?? null) : null;
    return { up: heartbeatAt !== null && t - heartbeatAt < FLEET_UP_MS, heartbeatAt, fleet };
  };

  /** `PUT|DELETE /api/admin/secrets/<NAME>`. Never echoes the value, in an answer or a refusal. */
  const secretRoute = async (req: Request, name: string): Promise<Response> => {
    if (req.method !== "PUT" && req.method !== "DELETE") return json({ error: `${req.method} is not a secret route: PUT sets one, DELETE clears it` }, 405);
    const credentials = storedCredentials(dbPath());
    const named = credentials.find((c) => c.secretEnv === name && providerById(c.provider)?.holds !== "home");
    if (named === undefined) return json({ error: `no credential keeps its secret in ${name}` }, 404);
    const { actor, note } = actorOf(req);
    const att = { actor, ...(note !== undefined ? { note } : {}), env };
    const store = new ConfigStore(dbPath());
    try {
      if (req.method === "DELETE") {
        const cleared = clearStoreSecret(store, name, att);
        return json({ name, stored: false, cleared, version: store.version() });
      }
      const text = await req.text();
      if (text.length > MAX_SECRET_BODY) return json({ error: "the body is too large for a secret" }, 413);
      let value: unknown;
      try {
        value = (JSON.parse(text) as { value?: unknown } | null)?.value;
      } catch {
        return json({ error: "the body must be JSON { \"value\": \"…\" }" }, 400);
      }
      setStoreSecret(store, name, value, att);
      return json({ name, stored: true, version: store.version() });
    } catch (e) {
      // SecretRefused never carries the value; anything else is not shown at all.
      return e instanceof SecretRefused ? json({ error: e.message }, 400) : json({ error: "the secret could not be stored" }, 500);
    } finally {
      store.close();
    }
  };

  /** `POST /api/admin/codex-login/<id>`: leave a request for the supervisor. */
  const loginRoute = (req: Request, id: string): Response => {
    if (req.method !== "POST") return json({ error: `${req.method} is not a login route: POST asks for one` }, 405);
    if (!opts.groups.runner) return json({ error: "the runner group is off: no supervisor to log a home in" }, 409);
    const c = storedCredentials(dbPath()).find((x) => x.id === id);
    if (c === undefined) return json({ error: `no credential ${id}` }, 404);
    if (providerById(c.provider)?.holds !== "home") return json({ error: `${id} is not a Codex home: its secret is set, not logged in` }, 400);
    if (c.enabled) return json({ error: `${id} is enabled: disable it first, so no run is placed on it while the login replaces its token` }, 409);
    if (!supervisorUp(now()).up) return json({ error: "no supervisor is up to run the login" }, 409);
    const r = requestCodexLogin(loginDir(), id, actorOf(req).actor, now());
    return r.ok ? json({ id, state: "requested" }, 202) : json({ error: r.why }, 409);
  };

  return (req, path) => {
    if (path !== ADMIN_API_PREFIX && !path.startsWith(`${ADMIN_API_PREFIX}/`)) return null;
    const rest = path.slice(ADMIN_API_PREFIX.length + 1).split("/");
    if (rest.length === 2 && rest[0] === "secrets" && rest[1] !== "") return secretRoute(req, decodeURIComponent(rest[1]!));
    if (rest.length === 2 && rest[0] === "codex-login" && rest[1] !== "") return loginRoute(req, decodeURIComponent(rest[1]!));
    if (path !== ADMIN_API_PREFIX) return json({ error: "no such path" }, 404);
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: `${req.method} ${path} is not an admin route: writes go through /api/config` }, 405);
    const t = now();
    const { up, heartbeatAt, fleet } = supervisorUp(t);
    const modelKeys = modelKeysFromEnv(env);
    const key = storeKeyOf(env);
    const stored = storedCredentials(dbPath());
    const body: AdminResponse = {
      groups: opts.groups,
      fleet: { up, heartbeatAt },
      modelKeys,
      storeKey: key.key !== null ? { ok: true } : { ok: false, why: key.why },
      credentials: credentialViews({
        stored,
        fleet: fleet ?? {},
        up,
        modelKeys,
        secrets: storedSecrets(dbPath()),
        keyId: key.key?.id ?? null,
        logins: loginViews(loginDir(), stored, t),
      }),
      providers: CREDENTIAL_PROVIDERS.map((p) => ({ id: p.id, label: p.label, bill: p.bill, envBase: p.envBase, holds: p.holds, budgets: p.budgets })),
      publishing: { ...publishViewFromEnv(env), last: lastPass() },
      now: t,
    };
    return json(body);
  };
}
