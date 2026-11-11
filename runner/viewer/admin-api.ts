/**
 * The admin API's status route (GitHub issue #427): what the admin pages show
 * beside the config they edit. Mounted, like the config API, only on a handle
 * with the admin switch on (`groups.ts`), and read-only: every write the admin
 * pages make is a config-store write through `config-api.ts`, validated by
 * `parseFleet` exactly as the CLI's is. The store stays the one source of
 * truth; this route only says how the deployment around it stands.
 *
 *   GET /api/admin   the groups, the credentials with their status, the
 *                    providers a credential may name, and publishing
 *
 * **Credentials, never their secrets.** The config store holds each
 * credential's env var NAME (`secretEnv`); the value lives in the
 * deployment's Secret and reaches only the pods that run models, never the
 * viewer. So whether a variable is set is the supervisor's word, read off the
 * state it publishes (`fleet-state.json`), and it is unknown (null) while the
 * supervisor is not up to say. Whether the chart hands the variable to those
 * pods at all is the chart's `modelKeys`, which it passes here as
 * `WRATHBENCH_MODEL_KEYS`. No value is read, served or written by this route.
 *
 * **Each credential's health** (`status` and `issues`) is derived here from
 * those same three sources and nothing else (`credentialHealth`,
 * runner/src/credential-health.ts): the store's switch, the supervisor's word
 * on the variable, its budget holds and the newest paused run that indicts
 * it, and the chart's `modelKeys`. With no supervisor up it is `unknown`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDbPath, ConfigStore } from "../src/config-store";
import { credentialHealth } from "../src/credential-health";
import { CREDENTIAL_PROVIDERS, describeBudget, parseCredentials, providerById, type Credential } from "../src/credential-slots";
import { publishViewFromEnv } from "../../infra/publish-settings";
import type { AdminCredentialView, AdminPublishView, AdminResponse, FleetResponse } from "./api-types";
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
  /** The supervisor's last heartbeat: when what it said was last true. */
  heartbeatAt?: number | null;
  modelKeys: readonly string[] | null;
}): AdminCredentialView[] {
  const status = new Map((o.up ? (o.fleet.credentials ?? []) : []).map((c) => [c.id, c]));
  return o.stored.map((c): AdminCredentialView => {
    const found = status.get(c.id);
    // A status about another variable (renamed since the tick) is about another secret.
    const s = found !== undefined && found.secretEnv === c.secretEnv ? found : undefined;
    const deployed = o.modelKeys === null ? null : o.modelKeys.includes(c.secretEnv);
    const health = credentialHealth({
      enabled: c.enabled,
      secretEnv: c.secretEnv,
      holds: providerById(c.provider)?.holds ?? "key",
      up: o.up,
      heartbeatAt: o.heartbeatAt ?? null,
      supervisor: s,
      deployed,
    });
    return {
      id: c.id,
      provider: c.provider,
      billing: c.billing,
      enabled: c.enabled,
      secretEnv: c.secretEnv,
      slots: c.slots,
      budget: describeBudget(c.budget),
      secretSet: s !== undefined ? s.secretSet : null,
      deployed,
      inUse: s?.inUse ?? null,
      used: s?.used ?? null,
      held: s?.held ?? {},
      lastError: s?.lastError ?? null,
      status: health.status,
      issues: health.issues,
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

/** The handler: `GET /api/admin`, or null for any other path. */
export function createAdminApi(opts: AdminApiOptions): (req: Request, path: string) => Response | null {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const lastPass = publishStateReader(env["WRATHBENCH_PUBLISH_STATE"]);
  return (req, path) => {
    if (path !== ADMIN_API_PREFIX && !path.startsWith(`${ADMIN_API_PREFIX}/`)) return null;
    if (path !== ADMIN_API_PREFIX) return json({ error: "no such path" }, 404);
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: `${req.method} ${path} is not an admin route: writes go through /api/config` }, 405);
    const t = now();
    const fleet = opts.groups.runner ? readSupervisor(opts.runsDir) : null;
    const heartbeatAt = fleet?.present === true ? (fleet.heartbeatAt ?? null) : null;
    const up = heartbeatAt !== null && t - heartbeatAt < FLEET_UP_MS;
    const modelKeys = modelKeysFromEnv(env);
    const body: AdminResponse = {
      groups: opts.groups,
      fleet: { up, heartbeatAt },
      modelKeys,
      credentials: credentialViews({ stored: storedCredentials(opts.dbPath ?? configDbPath()), fleet: fleet ?? {}, up, heartbeatAt, modelKeys }),
      providers: CREDENTIAL_PROVIDERS.map((p) => ({ id: p.id, label: p.label, bill: p.bill, envBase: p.envBase, holds: p.holds, budgets: p.budgets })),
      publishing: { ...publishViewFromEnv(env), last: lastPass() },
      now: t,
    };
    return json(body);
  };
}
