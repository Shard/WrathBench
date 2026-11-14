/**
 * A world per eval: every scored or probing attempt plays on a short-lived
 * world of its own, while freeplay shares the long-lived one
 * (docs/ARCHITECTURE.md "Worlds", docs/RUNBOOK.md "Worlds").
 *
 * A world is its STATE — a characters schema, `acore_characters_<id>`, and a
 * realmlist row in the shared auth database — with a worldserver pod as a
 * stateless process over it. The pod is created from the chart's `world.json`
 * template (templates/worlds.yaml), owned by the fleet pod like a run pod, and
 * named `<id>` under the headless `worlds` Service, so its module URL,
 * `http://<id>.worlds:8086`, survives a boot onto a new pod. That URL is what
 * a run stores at its fresh launch and reuses on every resume.
 *
 * The lifecycle, all of it the roster's around one attempt:
 *
 *   create   allocate an id and a realm slot, write the world's record, the
 *            realm row and the runs' pointer files, then boot. Allocation and
 *            boot are under one cross-process lock (rosters are separate
 *            processes): one world boots at a time, against a database whose
 *            world load is the slow part.
 *   resume   the same world again, booted over its kept schema on the
 *            worldserver and db-import digests it first ran, unless it is up.
 *   park     a paused, resumable attempt keeps its world without a pod: the
 *            pod is deleted with its full grace, so the characters save.
 *   end      at the verdict: the console log saved, the pod gone, the schema
 *            dropped, the realm row deleted, the record marked ended.
 *
 * What a world must never be is a worldserver over the SHARED world's state.
 * The chart's template carries none of a world's identity, and an absent
 * variable falls back to the shared conf (realm 1, the module's stock RUNNER
 * allowlist), so `buildWorldPod` refuses a pod that does not carry all three
 * of its own: the characters schema, the realm id and the allowlist. The two
 * destructive statements, DROP DATABASE and DELETE FROM realmlist, check their
 * own argument in the function that issues them.
 *
 * Off the cluster, or with `policy.worlds` off, nothing here runs: every run
 * is on the shared world, as before.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SQL } from "bun";
import { moduleAuthHeaders } from "@wrathbench/mcp/module-auth";
import { liveOwnerOf, terminationOfTrajectory, type WorldsMode } from "../runner/src/models";
import { digestOf, K8sClient, type Pod, type PodEnvVar } from "./k8s-client";
import { isQuotaRefusal, readLauncherSettings, ROSTER_PID_LABEL } from "./run-pod";
import { WORLDS_SECRET_ENV } from "./episode-launcher";
import { worldsOf, type WorldsSetting } from "./run-fleet-credentials";
import type { FleetWorldView } from "../runner/viewer/api-types";

// ------------------------------------------------------------------ names

/** A run with no world of its own plays on the deployment's long-lived world. */
export const SHARED_WORLD = "shared";
/** The pods the deploy window and the drain select on: `app.kubernetes.io/component=world`. */
export const WORLD_COMPONENT = "world";
const LABEL_PREFIX = "wrathbench.shard.page/";
export const WORLD_ID_LABEL = `${LABEL_PREFIX}world`;
/** What `infra/k8s-deploy.sh` prints for a world pod. */
export const WORLD_ID_ANNOTATION = `${LABEL_PREFIX}world-id`;
/** The headless Service a world's pod is named under (templates/worlds.yaml). */
export const WORLDS_SERVICE = "worlds";
export const WORLD_POD_TEMPLATE_ENV = "WRATHBENCH_WORLD_POD_TEMPLATE";
export const DEFAULT_WORLD_POD_TEMPLATE = "/etc/wrathbench/run-pod/world.json";
/** A world's own records, `data/worlds/<id>/`: outside `runs/`, where every entry reads as a run. */
export const WORLDS_DIR = join("data", "worlds");
export const WORLD_RECORD_FILE = "world.json";
export const WORLD_LOG_FILE = "server.log";
/** The pointer a launcher leaves in a run directory: `{ "id": … }`, one of the launch files. */
export const WORLD_POINTER_FILE = "world.json";
export const MODULE_PORT = 8086;

/**
 * `w` and ten base32 characters, lowercase: the id is the pod's `hostname`,
 * so it must be a DNS label, and it is part of a schema name, so it carries
 * nothing that needs quoting.
 */
export const WORLD_ID_RE = /^w[a-z2-7]{10}$/;
/** The only schemas this file ever drops. */
export const WORLD_SCHEMA_RE = /^acore_characters_w[a-z2-7]{10}$/;
/** Realm slots a world may hold: 1 is the shared world's, 255 is left alone. */
export const REALM_MIN = 2;
export const REALM_MAX = 254;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newWorldId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(10);
  let id = "w";
  for (const b of bytes) id += BASE32[b % 32];
  return id;
}

export function isWorldId(id: unknown): id is string {
  return typeof id === "string" && WORLD_ID_RE.test(id);
}

export function schemaOf(id: string): string {
  if (!isWorldId(id)) throw new Error(`not a world id: ${JSON.stringify(id)}`);
  return `acore_characters_${id}`;
}

export function worldModuleUrl(id: string): string {
  if (!isWorldId(id)) throw new Error(`not a world id: ${JSON.stringify(id)}`);
  return `http://${id}.${WORLDS_SERVICE}:${MODULE_PORT}`;
}

export function worldSoapUrl(id: string, port: number): string {
  if (!isWorldId(id)) throw new Error(`not a world id: ${JSON.stringify(id)}`);
  return `http://${id}.${WORLDS_SERVICE}:${port}/`;
}

/** The episode tiers that are scored or probing, the ones a world is for; freeplay and a hand roster's unnamed episode share the long-lived world. */
const WORLD_EPISODES = new Set(["e90", "e360", "probing"]);

/** Whether an attempt of `episode` plays on a world of its own under `mode`. */
export function worldUsedBy(mode: WorldsMode, episode: string | null | undefined): boolean {
  return mode === "evals" && episode != null && WORLD_EPISODES.has(episode);
}

// ------------------------------------------------------------ the pointer

/** Leave the run's pointer to its world beside it, before the run exists. */
export function writeWorldPointer(runDir: string, id: string): void {
  if (!isWorldId(id)) throw new Error(`not a world id: ${JSON.stringify(id)}`);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, WORLD_POINTER_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ id })}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Remove a run's pointer, only while it still names `id` (or any world, when `id` is undefined). */
export function removeWorldPointer(runDir: string, id?: string): void {
  const now = readWorldPointer(runDir);
  if (now === undefined || (id !== undefined && now !== id)) return;
  try {
    rmSync(join(runDir, WORLD_POINTER_FILE), { force: true });
  } catch {
    // a read-only or vanished directory has nothing to keep
  }
}

/** The world a run's pointer names, or undefined for a run on the shared world. */
export function readWorldPointer(runDir: string): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(join(runDir, WORLD_POINTER_FILE), "utf8")) as { id?: unknown }).id;
    return isWorldId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The module a run's sessions are on: its world's, else `fallback` (the shared world's). */
export function moduleUrlOfRun(runDir: string, fallback: string): string {
  const id = readWorldPointer(runDir);
  return id === undefined ? fallback : worldModuleUrl(id);
}

/** The SOAP port the chart gives a world with staging on (values.yaml `staging.soapPort`). */
export const DEFAULT_SOAP_PORT = 7878;

/**
 * Where an attempt's stager works when the attempt has a world of its own:
 * its module, its SOAP console and its characters schema. The game data
 * (`WRATHBENCH_WORLD_DB`) stays the shared one, which every world reads.
 * `MODULE_HOST`/`MODULE_PORT` name the world's module too: the stager finds
 * its module through `moduleBase()` (infra/smoke/lib/module.ts), where those
 * two win over `WRATHBENCH_MODULE_URL`, so one inherited from the roster's
 * env would otherwise send the module calls to the shared world.
 */
export function stagingEnvOf(id: string, soapPort: number = DEFAULT_SOAP_PORT, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const worlds = env[WORLDS_SECRET_ENV];
  return {
    WRATHBENCH_MODULE_URL: worldModuleUrl(id),
    MODULE_HOST: new URL(worldModuleUrl(id)).hostname,
    MODULE_PORT: String(MODULE_PORT),
    WRATHBENCH_SOAP_URL: worldSoapUrl(id, soapPort),
    WRATHBENCH_CHARACTERS_DB: schemaOf(id),
    // Under hosted mode the world opens with its own port secret.
    ...(worlds !== undefined && worlds.length > 0 ? { WRATHBENCH_MODULE_SECRET: worlds } : {}),
  };
}

// ------------------------------------------------------------- the record

export interface WorldBoot {
  pod: string;
  at: number;
  readyAt?: number;
  bootMs?: number;
  /** Why the boot did not come up, when it did not. */
  failed?: string;
  endedAt?: number;
}

/**
 * A world's own record, `data/worlds/<id>/world.json`: operational, outside
 * the evidence. The run carries only its pointer.
 */
export interface WorldRecord {
  id: string;
  realmId: number;
  schema: string;
  accounts: string[];
  runIds: string[];
  /** The roster that holds the world now, and the fleet pod it runs in. */
  owner: { rosterPid: number; fleetPod: string | null };
  createdAt: number;
  /** The digests the first boot ran (`repo@sha256:…`), which every later boot runs too. */
  images: { worldserver?: string; dbImport?: string };
  boots: WorldBoot[];
  state: "booting" | "up" | "parked" | "ended";
  endedAt?: number;
  teardown?: { why: string; at: number; schemaDropped: boolean; realmDeleted: boolean; logSaved: boolean };
}

export class WorldStore {
  constructor(readonly dir: string) {}

  path(id: string): string {
    return join(this.dir, id, WORLD_RECORD_FILE);
  }

  read(id: string): WorldRecord | undefined {
    if (!isWorldId(id)) return undefined;
    try {
      return JSON.parse(readFileSync(this.path(id), "utf8")) as WorldRecord;
    } catch {
      return undefined;
    }
  }

  write(rec: WorldRecord): void {
    const path = this.path(rec.id);
    mkdirSync(join(this.dir, rec.id), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  }

  list(): WorldRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.filter(isWorldId).flatMap((id) => {
      const r = this.read(id);
      return r === undefined ? [] : [r];
    });
  }

  appendLog(id: string, text: string): void {
    mkdirSync(join(this.dir, id), { recursive: true });
    appendFileSync(join(this.dir, id, WORLD_LOG_FILE), text);
  }
}

// ---------------------------------------------------------- the boot hold

/** Failed boots in a row that hold every launch needing a world. */
export const BOOT_FAILURES_TO_HOLD = 3;
/** How long the hold lasts after the last failure, unless a boot succeeds first. */
export const BOOT_HOLD_MS = 30 * 60_000;
const BOOT_FAILURES_FILE = "boot-failures.json";

interface BootFailures {
  count: number;
  at: number;
  last: string;
}

export function noteBoot(dir: string, failure: string | undefined, now: number): void {
  const path = join(dir, BOOT_FAILURES_FILE);
  mkdirSync(dir, { recursive: true });
  const prev = readBootFailures(dir);
  const next: BootFailures = failure === undefined ? { count: 0, at: now, last: "" } : { count: (prev?.count ?? 0) + 1, at: now, last: failure };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next)}\n`);
  renameSync(`${path}.tmp`, path);
}

function readBootFailures(dir: string): BootFailures | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, BOOT_FAILURES_FILE), "utf8")) as BootFailures;
  } catch {
    return undefined;
  }
}

/** Why no world may be booted now, or undefined: three failed boots in a row, within the hold. */
export function worldsHold(dir: string, now: number): string | undefined {
  const f = readBootFailures(dir);
  if (f === undefined || f.count < BOOT_FAILURES_TO_HOLD || now - f.at > BOOT_HOLD_MS) return undefined;
  const left = Math.ceil((BOOT_HOLD_MS - (now - f.at)) / 60_000);
  return `worlds held: ${f.count} boots failed in a row (last: ${f.last.slice(0, 200)}) — ${left}m left, or a boot that succeeds; bun wb inspect worlds`;
}

// ------------------------------------------------------------- the lock

/**
 * One cross-process lock over allocation and boot: a directory made with
 * mkdir, which is atomic, holding its owner's pid. A holder that is gone, or
 * older than `staleMs`, is taken over.
 */
export async function withWorldLock<T>(
  dir: string,
  fn: () => Promise<T>,
  o: { staleMs: number; waitMs: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; pid?: number; alive?: (pid: number) => boolean; pod?: string },
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pid = o.pid ?? process.pid;
  const alive = o.alive ?? pidAlive;
  // Pids are per pod: a holder from another fleet pod is gone, whatever its pid.
  const pod = o.pod ?? process.env["POD_NAME"] ?? "";
  const lock = join(dir, ".boot.lock");
  mkdirSync(dir, { recursive: true });
  const deadline = now() + o.waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), `${pid} ${pod}\n`);
      break;
    } catch {
      let holder: number | undefined;
      let holderPod = pod;
      let age = 0;
      try {
        const [p, hp] = readFileSync(join(lock, "owner"), "utf8").trim().split(" ");
        holder = Number(p);
        holderPod = hp ?? "";
        age = now() - statSync(lock).mtimeMs;
      } catch {
        // half-made by a holder that died between mkdir and write; aged below
        try {
          age = now() - statSync(lock).mtimeMs;
        } catch {
          continue;
        }
      }
      const gone = holder !== undefined && Number.isInteger(holder) && holder > 0 && (holderPod !== pod || !alive(holder));
      if (gone || age > o.staleMs) {
        releaseLock(lock);
        continue;
      }
      if (now() >= deadline) return { ok: false, reason: `another world is booting (lock held by pid ${holder ?? "?"} for ${Math.round(age / 1000)}s)` };
      await sleep(o.pollMs ?? 2_000);
    }
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseLock(lock);
  }
}

function releaseLock(lock: string): void {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    // already released
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

// --------------------------------------------------------- the database

/** The statements a world's state takes, on the shared auth database and the world's schema. */
export interface WorldDb {
  /** Realm rows above the shared world's. */
  realmIds(): Promise<number[]>;
  /** Every world schema that exists. */
  schemas(): Promise<string[]>;
  putRealm(realmId: number, id: string): Promise<void>;
  deleteRealm(realmId: number): Promise<void>;
  dropSchema(schema: string): Promise<void>;
  close(): Promise<void>;
}

/** The refusal both destructive statements check, in the functions that issue them. */
export function checkRealmId(realmId: number): void {
  if (!Number.isInteger(realmId) || realmId < REALM_MIN || realmId > REALM_MAX) throw new Error(`realm ${realmId} is not a world's: worlds hold ${REALM_MIN}–${REALM_MAX}, and realm 1 is the shared world's`);
}

export function checkWorldSchema(schema: string): void {
  if (!WORLD_SCHEMA_RE.test(schema)) throw new Error(`refusing to touch schema ${JSON.stringify(schema)}: only acore_characters_w<id> is a world's`);
}

/** WotLK client build, as bootstrap's realm row. */
const GAMEBUILD = 12340;

/** The fleet's database env (templates/_helpers.tpl `dbEnv`), on auth. */
export async function mysqlWorldDb(env: Record<string, string | undefined> = process.env): Promise<WorldDb> {
  const sql = new SQL({
    adapter: "mysql",
    hostname: env["WRATHBENCH_DB_HOST"] ?? "db",
    port: Number(env["WRATHBENCH_DB_PORT"] ?? "3306"),
    username: env["WRATHBENCH_DB_USER"] ?? "root",
    password: env["WRATHBENCH_DB_PASSWORD"] ?? env["WRATHBENCH_DB_ROOT_PASSWORD"] ?? "wrathbench",
    database: "acore_auth",
    // As bootstrap.ts: the connection never leaves the cluster network.
    allowPublicKeyRetrieval: true,
    max: 1,
  });
  return {
    async realmIds() {
      const rows = (await sql`SELECT id FROM realmlist WHERE id >= ${REALM_MIN}`) as { id: number }[];
      return rows.map((r) => Number(r.id));
    },
    async schemas() {
      const rows = (await sql`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'acore\\_characters\\_w%'`) as { name: string }[];
      return rows.map((r) => r.name).filter((n) => WORLD_SCHEMA_RE.test(n));
    },
    async putRealm(realmId, id) {
      checkRealmId(realmId);
      if (!isWorldId(id)) throw new Error(`not a world id: ${JSON.stringify(id)}`);
      // Never advertised to a client: a spectator port-forwards to one pod.
      await sql`
        INSERT INTO realmlist (id, name, address, localAddress, localSubnetMask, port, gamebuild)
        VALUES (${realmId}, ${`WrathBench ${id}`}, '127.0.0.1', '127.0.0.1', '255.255.255.0', 8085, ${GAMEBUILD})
        ON DUPLICATE KEY UPDATE name = VALUES(name)`;
    },
    async deleteRealm(realmId) {
      checkRealmId(realmId);
      await sql`DELETE FROM realmcharacters WHERE realmid = ${realmId}`;
      await sql`UPDATE account SET online = 0 WHERE online = ${realmId}`;
      await sql`DELETE FROM realmlist WHERE id = ${realmId}`;
    },
    async dropSchema(schema) {
      checkWorldSchema(schema);
      await sql.unsafe(`DROP DATABASE IF EXISTS \`${schema}\``);
    },
    async close() {
      await sql.close();
    },
  };
}

// ------------------------------------------------------------- the pod

export interface BuildWorldPodOptions {
  id: string;
  realmId: number;
  accounts: readonly string[];
  owner: { name: string; uid: string } | undefined;
  rosterPid: number;
  /** A re-boot's recorded digests (`repo@sha256:…`); the template's images otherwise. */
  images?: { worldserver?: string; dbImport?: string };
}

const ACCOUNT_RE = /^[A-Z0-9]{1,16}$/;

function setEnv(env: PodEnvVar[] | undefined, name: string, value: string): PodEnvVar[] {
  return [...(env ?? []).filter((e) => e.name !== name), { name, value }];
}

function envValue(c: { env?: PodEnvVar[] } | undefined, name: string): string | undefined {
  return c?.env?.find((e) => e.name === name)?.value;
}

type PodContainer = Pod["spec"]["containers"][number];

function initContainers(pod: Pod): PodContainer[] {
  return (pod.spec["initContainers"] as PodContainer[] | undefined) ?? [];
}

/**
 * Why a built world pod may not be created, or undefined. Checked on the
 * output, so every path that builds one is covered: both the db-import init
 * and the worldserver name the world's own schema, the worldserver its own
 * realm id and a non-empty allowlist without STAGER. A variable left out
 * would fall back to the shared conf, which is the shared world's identity.
 */
export function worldPodRefusal(pod: Pod): string | undefined {
  const ws = pod.spec.containers.find((c) => c.name === "worldserver");
  const di = initContainers(pod).find((c) => c.name === "db-import");
  if (ws === undefined) return "the world pod template has no worldserver container";
  if (di === undefined) return "the world pod template has no db-import init container";
  for (const c of [di, ws]) {
    const info = envValue(c, "AC_CHARACTER_DATABASE_INFO");
    const schema = info?.split(";").at(-1);
    if (info === undefined || schema === undefined || !WORLD_SCHEMA_RE.test(schema)) {
      return `${c.name} names no world schema of its own (AC_CHARACTER_DATABASE_INFO ${info === undefined ? "absent" : `ends ${JSON.stringify(schema)}`}) — it would boot over the shared characters`;
    }
  }
  const realm = envValue(ws, "AC_REALM_ID");
  if (realm === undefined || !/^\d+$/.test(realm) || Number(realm) < REALM_MIN || Number(realm) > REALM_MAX) {
    return `worldserver has no realm of its own (AC_REALM_ID ${realm === undefined ? "absent" : JSON.stringify(realm)}) — it would be realm 1, the shared world's`;
  }
  const accounts = envValue(ws, "AC_WRATH_BENCH_ACCOUNTS");
  const list = accounts === undefined ? [] : accounts.split(",").filter((a) => a.length > 0);
  if (list.length === 0) return "worldserver has no allowlist of its own (AC_WRATH_BENCH_ACCOUNTS absent or empty) — it would serve the shared conf's";
  if (list.some((a) => a.toUpperCase() === "STAGER")) return "STAGER may never be on a world's allowlist: it is SOAP's administrator";
  if (list.some((a) => !ACCOUNT_RE.test(a))) return `the allowlist ${JSON.stringify(accounts)} holds a name that is not an account`;
  if (pod.spec["hostname"] === undefined || !isWorldId(pod.spec["hostname"])) return "the world pod has no world id as its hostname";
  if (pod.spec["subdomain"] !== WORLDS_SERVICE) return `the world pod template's subdomain is ${JSON.stringify(pod.spec["subdomain"])}, not the ${WORLDS_SERVICE} Service`;
  return undefined;
}

/** The template with this world filled in; throws the refusal when the result is not a world of its own. */
export function buildWorldPod(template: Pod, o: BuildWorldPodOptions): Pod {
  if (!isWorldId(o.id)) throw new Error(`world pod: ${JSON.stringify(o.id)} is not a world id`);
  checkRealmId(o.realmId);
  const pod = structuredClone(template);
  pod.apiVersion = "v1";
  pod.kind = "Pod";
  const prefix = pod.metadata.generateName ?? "world-";
  delete pod.metadata.generateName;
  pod.metadata.name = `${prefix}${o.id}`;
  pod.metadata.labels = { ...(pod.metadata.labels ?? {}), "app.kubernetes.io/component": WORLD_COMPONENT, [WORLD_ID_LABEL]: o.id, [ROSTER_PID_LABEL]: String(o.rosterPid) };
  pod.metadata.annotations = { ...(pod.metadata.annotations ?? {}), [WORLD_ID_ANNOTATION]: o.id };
  if (o.owner !== undefined) pod.metadata.ownerReferences = [{ apiVersion: "v1", kind: "Pod", name: o.owner.name, uid: o.owner.uid }];
  pod.spec["hostname"] = o.id;
  const info = `$(WRATHBENCH_DB_HOST);$(WRATHBENCH_DB_PORT);$(WRATHBENCH_DB_USER);$(WRATHBENCH_DB_PASSWORD);${schemaOf(o.id)}`;
  const accounts = [...new Set(o.accounts.map((a) => a.toUpperCase()))].join(",");
  for (const c of initContainers(pod)) {
    if (c.name !== "db-import") continue;
    c.env = setEnv(c.env, "AC_CHARACTER_DATABASE_INFO", info);
    if (o.images?.dbImport !== undefined) c.image = o.images.dbImport;
  }
  for (const c of pod.spec.containers) {
    if (c.name !== "worldserver") continue;
    c.env = setEnv(setEnv(setEnv(c.env, "AC_CHARACTER_DATABASE_INFO", info), "AC_REALM_ID", String(o.realmId)), "AC_WRATH_BENCH_ACCOUNTS", accounts);
    if (o.images?.worldserver !== undefined) c.image = o.images.worldserver;
  }
  const refusal = worldPodRefusal(pod);
  if (refusal !== undefined) throw new Error(`world pod ${o.id} refused: ${refusal}`);
  return pod;
}

/** `repo@sha256:…` for a container's image as the kubelet ran it. */
function pinnedImage(image: string, imageID: string | undefined): string | undefined {
  const digest = digestOf(imageID);
  if (digest === undefined) return undefined;
  const at = image.indexOf("@");
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  const repo = at >= 0 ? image.slice(0, at) : colon > slash ? image.slice(0, colon) : image;
  return `${repo}@${digest}`;
}

// --------------------------------------------------------- the launcher

/** The client calls a world needs; a test passes its own. */
export type WorldK8s = Pick<K8sClient, "createPod" | "getPod" | "listPods" | "deletePod" | "podLog">;

/** Whether a world's module answers ready: GET /health 200 with the port secret. */
export type WorldHealth = (url: string) => Promise<{ ready: boolean; detail: string }>;

/**
 * The operator credential an eval world opens with: its own port secret under
 * hosted mode (`WRATHBENCH_WORLDS_MODULE_SECRET` on the fleet pod), else the
 * module secret every world shares.
 */
export function worldAuthHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const worlds = env[WORLDS_SECRET_ENV];
  return moduleAuthHeaders(worlds !== undefined && worlds.length > 0 ? { WRATHBENCH_MODULE_SECRET: worlds } : env);
}

export const defaultWorldHealth: WorldHealth = async (url) => {
  try {
    const r = await fetch(`${url}/health`, { headers: worldAuthHeaders(), signal: AbortSignal.timeout(3_000) });
    const body = (await r.text()).trim().slice(0, 200);
    return { ready: r.status === 200, detail: `${r.status} ${body}` };
  } catch (e) {
    return { ready: false, detail: e instanceof Error ? e.message : String(e) };
  }
};

/** A world pod's own grace when parked, so the characters save; as the long-lived world's. */
export const WORLD_PARK_GRACE_S = 120;

export interface WorldLauncherOptions {
  client: WorldK8s;
  template: Pod;
  /** Opened per use and closed after it: a roster holds no connection between attempts. */
  db: () => Promise<WorldDb>;
  store: WorldStore;
  owner: { name: string; uid: string } | undefined;
  rosterPid: number;
  log: (line: string) => void;
  health?: WorldHealth;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long a boot may take, scheduled to ready; the template's startup budget plus room. */
  startupMs?: number;
  /** How long a roster waits for another world's boot to finish before it gives up for this tick. */
  lockWaitMs?: number;
  /** Cross-process liveness, for the lock; a test injects its own. */
  alive?: (pid: number) => boolean;
  random?: (n: number) => Uint8Array;
}

export type WorldStart = { ok: true; id: string; url: string } | { ok: false; reason: string; noCapacity?: true };

export class WorldLauncher {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly health: WorldHealth;

  constructor(readonly opts: WorldLauncherOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.health = opts.health ?? defaultWorldHealth;
  }

  private lock<T>(fn: () => Promise<T>): ReturnType<typeof withWorldLock<T>> {
    const startup = this.opts.startupMs ?? 6 * 60_000;
    return withWorldLock(this.opts.store.dir, fn, {
      staleMs: startup + 5 * 60_000,
      waitMs: this.opts.lockWaitMs ?? startup + 60_000,
      now: this.now,
      sleep: this.sleep,
      pid: this.opts.rosterPid,
      ...(this.opts.alive !== undefined ? { alive: this.opts.alive } : {}),
    });
  }

  /**
   * A new world for one attempt: its id and realm slot, its record, its realm
   * row, the runs' pointers, and a boot. Anything short of ready is no
   * attempt, and the world is ended on the spot.
   */
  async create(o: { runDirs: readonly string[]; runIds: readonly string[]; accounts: readonly string[] }): Promise<WorldStart> {
    const hold = worldsHold(this.opts.store.dir, this.now());
    if (hold !== undefined) return { ok: false, reason: hold, noCapacity: true };
    const accounts = [...new Set(o.accounts.map((a) => a.toUpperCase()))];
    const locked = await this.lock(async (): Promise<WorldStart> => {
      const db = await this.opts.db();
      let rec: WorldRecord;
      try {
        const taken = new Set([...(await db.realmIds()), ...this.opts.store.list().filter((r) => r.state !== "ended").map((r) => r.realmId)]);
        let realmId: number | undefined;
        for (let r = REALM_MIN; r <= REALM_MAX && realmId === undefined; r++) if (!taken.has(r)) realmId = r;
        if (realmId === undefined) return { ok: false, reason: `no realm slot free (${REALM_MIN}–${REALM_MAX} all held)`, noCapacity: true };
        let id = newWorldId(this.opts.random);
        while (this.opts.store.read(id) !== undefined) id = newWorldId(this.opts.random);
        rec = {
          id,
          realmId,
          schema: schemaOf(id),
          accounts,
          runIds: [...o.runIds],
          owner: { rosterPid: this.opts.rosterPid, fleetPod: this.opts.owner?.name ?? null },
          createdAt: this.now(),
          images: {},
          boots: [],
          state: "booting",
        };
        // Record first: whatever happens after, there is something for the reconcile to find.
        this.opts.store.write(rec);
        await db.putRealm(realmId, id);
      } finally {
        await db.close();
      }
      for (const dir of o.runDirs) writeWorldPointer(dir, rec.id);
      this.opts.log(`world ${rec.id}: realm ${rec.realmId}, schema ${rec.schema}, accounts ${accounts.join(",")}, for ${o.runIds.join(", ")}`);
      const booted = await this.boot(rec);
      if (!booted.ok) {
        // No attempt was made on it: the runs keep no pointer to a world that never came up.
        for (const dir of o.runDirs) removeWorldPointer(dir, rec.id);
        await this.end(rec.id, `boot failed: ${booted.reason}`);
        return booted;
      }
      return { ok: true, id: rec.id, url: worldModuleUrl(rec.id) };
    });
    return locked.ok ? locked.value : { ok: false, reason: locked.reason, noCapacity: true };
  }

  /** The world a resumed run is on, up again: as it is when it answers, booted over its kept schema when it does not. */
  async resume(id: string): Promise<WorldStart> {
    const rec = this.opts.store.read(id);
    if (rec === undefined) return { ok: false, reason: `world ${id} has no record — its run cannot resume on it` };
    if (rec.state === "ended") return { ok: false, reason: `world ${id} has ended (${rec.teardown?.why ?? "no reason recorded"}) — its run cannot resume on it` };
    rec.owner = { rosterPid: this.opts.rosterPid, fleetPod: this.opts.owner?.name ?? null };
    this.opts.store.write(rec);
    const url = worldModuleUrl(id);
    const pod = await this.opts.client.getPod(this.podName(id));
    if (pod !== null && pod.metadata.deletionTimestamp === undefined && pod.status?.phase === "Running" && (await this.health(url)).ready) {
      rec.state = "up";
      this.opts.store.write(rec);
      return { ok: true, id, url };
    }
    const hold = worldsHold(this.opts.store.dir, this.now());
    if (hold !== undefined) return { ok: false, reason: hold, noCapacity: true };
    const locked = await this.lock(async (): Promise<WorldStart> => {
      if (pod !== null) await this.removePod(id, 0);
      const fresh = this.opts.store.read(id) ?? rec;
      const booted = await this.boot(fresh);
      return booted.ok ? { ok: true, id, url } : booted;
    });
    return locked.ok ? locked.value : { ok: false, reason: locked.reason, noCapacity: true };
  }

  podName(id: string): string {
    return `${this.opts.template.metadata.generateName ?? "world-"}${id}`;
  }

  private async boot(rec: WorldRecord): Promise<{ ok: true } | { ok: false; reason: string; noCapacity?: true }> {
    let body: Pod;
    try {
      body = buildWorldPod(this.opts.template, { id: rec.id, realmId: rec.realmId, accounts: rec.accounts, owner: this.opts.owner, rosterPid: this.opts.rosterPid, images: rec.images });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      noteBoot(this.opts.store.dir, reason, this.now());
      return { ok: false, reason };
    }
    const name = body.metadata.name!;
    const at = this.now();
    rec.state = "booting";
    rec.boots.push({ pod: name, at });
    this.opts.store.write(rec);
    const boot = rec.boots[rec.boots.length - 1]!;
    try {
      await this.opts.client.createPod(body);
    } catch (e) {
      const reason = `world pod create refused: ${e instanceof Error ? e.message : String(e)}`;
      boot.failed = reason;
      this.opts.store.write(rec);
      // A full namespace is no capacity, not a broken world: it does not count towards the hold.
      if (isQuotaRefusal(e)) return { ok: false, reason, noCapacity: true };
      noteBoot(this.opts.store.dir, reason, this.now());
      return { ok: false, reason };
    }
    this.opts.log(`world ${rec.id}: pod ${name} created${rec.images.worldserver !== undefined ? ` on ${rec.images.worldserver}` : ""}`);
    const deadline = at + (this.opts.startupMs ?? 6 * 60_000);
    const url = worldModuleUrl(rec.id);
    let last = "not yet scheduled";
    for (;;) {
      let pod: Pod | null = null;
      try {
        pod = await this.opts.client.getPod(name);
      } catch (e) {
        last = `the Kubernetes API did not answer (${e instanceof Error ? e.message : String(e)})`;
      }
      if (pod === null && !last.startsWith("the Kubernetes API")) {
        return this.bootFailed(rec, boot, "the world pod disappeared while it booted");
      }
      const status = pod?.status;
      const ended = status?.phase === "Failed" || status?.phase === "Succeeded" || status?.containerStatuses?.some((c) => c.state?.terminated !== undefined);
      const waiting = [...(status?.initContainerStatuses ?? []), ...(status?.containerStatuses ?? [])]
        .map((c) => c.state?.waiting?.reason)
        .find((r) => r !== undefined && FATAL_WAITING.has(r));
      if (ended === true || waiting !== undefined) {
        await this.saveLog(rec.id, name, `boot ${rec.boots.length}`);
        return this.bootFailed(rec, boot, waiting !== undefined ? `the world pod will not start: ${waiting}` : `the world pod ended while it booted (${status?.phase ?? "?"}${status?.reason !== undefined ? `, ${status.reason}` : ""})`);
      }
      if (status?.phase === "Running") {
        const h = await this.health(url);
        if (h.ready) {
          boot.readyAt = this.now();
          boot.bootMs = boot.readyAt - at;
          const ws = status.containerStatuses?.find((c) => c.name === "worldserver");
          const di = status.initContainerStatuses?.find((c) => c.name === "db-import");
          const wsImage = body.spec.containers.find((c) => c.name === "worldserver")?.image;
          const diImage = initContainers(body).find((c) => c.name === "db-import")?.image;
          rec.images = {
            ...rec.images,
            ...(rec.images.worldserver === undefined && wsImage !== undefined && pinnedImage(wsImage, ws?.imageID) !== undefined ? { worldserver: pinnedImage(wsImage, ws?.imageID)! } : {}),
            ...(rec.images.dbImport === undefined && diImage !== undefined && pinnedImage(diImage, di?.imageID) !== undefined ? { dbImport: pinnedImage(diImage, di?.imageID)! } : {}),
          };
          rec.state = "up";
          this.opts.store.write(rec);
          noteBoot(this.opts.store.dir, undefined, this.now());
          this.opts.log(`world ${rec.id}: ready at ${url} in ${Math.round(boot.bootMs / 1000)}s`);
          return { ok: true };
        }
        last = `module /health: ${h.detail}`;
      } else if (status !== undefined) {
        last = `pod ${status.phase ?? "Pending"}`;
      }
      if (this.now() >= deadline) {
        await this.saveLog(rec.id, name, `boot ${rec.boots.length}`);
        return this.bootFailed(rec, boot, `not ready after ${Math.round((this.now() - at) / 1000)}s (${last})`);
      }
      await this.sleep(this.opts.pollMs ?? 3_000);
    }
  }

  private async bootFailed(rec: WorldRecord, boot: WorldBoot, reason: string): Promise<{ ok: false; reason: string }> {
    boot.failed = reason;
    this.opts.store.write(rec);
    noteBoot(this.opts.store.dir, reason, this.now());
    await this.removePod(rec.id, 0);
    this.opts.log(`world ${rec.id}: boot failed — ${reason}`);
    return { ok: false, reason: `world ${rec.id} did not boot: ${reason}` };
  }

  /**
   * Keep the world's state, give back its pod: a paused, resumable attempt
   * between its sessions. `noWait` is the roster's stop: the pod is deleted
   * with its grace and not waited for, inside the fleet pod's own grace.
   */
  async park(id: string, why: string, o: { noWait?: boolean } = {}): Promise<void> {
    const rec = this.opts.store.read(id);
    if (rec === undefined || rec.state === "ended") return;
    await this.saveLog(id, this.podName(id), `parked: ${why}`);
    if (o.noWait === true) {
      try {
        await this.opts.client.deletePod(this.podName(id), WORLD_PARK_GRACE_S);
      } catch (e) {
        this.opts.log(`world pod ${this.podName(id)}: delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      await this.removePod(id, WORLD_PARK_GRACE_S);
    }
    rec.state = "parked";
    const boot = rec.boots[rec.boots.length - 1];
    if (boot !== undefined && boot.endedAt === undefined) boot.endedAt = this.now();
    this.opts.store.write(rec);
    this.opts.log(`world ${id}: parked (${why}) — its schema is kept for the resume`);
  }

  /** The world's end: its log saved, its pod gone, then its schema and realm row. */
  async end(id: string, why: string): Promise<void> {
    await endWorld({ client: this.opts.client, db: this.opts.db, store: this.opts.store, podName: this.podName(id), log: this.opts.log, now: this.now, sleep: this.sleep }, id, why);
  }

  private async saveLog(id: string, pod: string, why: string): Promise<boolean> {
    return saveWorldLog(this.opts.client, this.opts.store, id, pod, why);
  }

  private async removePod(id: string, graceS: number): Promise<void> {
    await removeWorldPod(this.opts.client, this.podName(id), graceS, this.sleep, this.opts.log);
  }
}

/** Waiting reasons that never clear on their own. */
const FATAL_WAITING = new Set(["ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull", "CreateContainerConfigError", "CreateContainerError"]);

async function saveWorldLog(client: WorldK8s, store: WorldStore, id: string, pod: string, why: string): Promise<boolean> {
  try {
    const stream = await client.podLog(pod, { follow: false, container: "worldserver" });
    if (stream === null) return false;
    const text = await new Response(stream).text();
    store.appendLog(id, `===== ${pod}, ${why}, ${new Date().toISOString()} =====\n${text}${text.endsWith("\n") ? "" : "\n"}`);
    return true;
  } catch {
    return false;
  }
}

/** Delete a world's pod and wait for it to be gone: nothing is dropped under a worldserver that can still write. */
async function removeWorldPod(client: WorldK8s, name: string, graceS: number, sleep: (ms: number) => Promise<void>, log: (line: string) => void): Promise<boolean> {
  try {
    await client.deletePod(name, graceS);
  } catch (e) {
    log(`world pod ${name}: delete failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const polls = Math.ceil((graceS + 60) / 2);
  for (let i = 0; i < polls; i++) {
    try {
      if ((await client.getPod(name)) === null) return true;
    } catch {
      // the API is not answering; keep waiting inside the bound
    }
    await sleep(2_000);
  }
  log(`world pod ${name}: still there ${graceS + 60}s after its delete`);
  return false;
}

/**
 * End a world: save the console log, delete the pod and wait until it is
 * gone, drop the schema, delete the realm row, mark the record ended. A pod
 * that will not go keeps its schema: the record stays open for the reconcile.
 */
export async function endWorld(
  o: { client: WorldK8s; db: () => Promise<WorldDb>; store: WorldStore; podName: string; log: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void> },
  id: string,
  why: string,
): Promise<void> {
  const rec = o.store.read(id);
  if (rec === undefined || rec.state === "ended") return;
  const now = o.now ?? Date.now;
  const logSaved = await saveWorldLog(o.client, o.store, id, o.podName, `ended: ${why}`);
  const gone = await removeWorldPod(o.client, o.podName, 0, o.sleep ?? ((ms) => Bun.sleep(ms)), o.log);
  if (!gone) {
    o.log(`world ${id}: its pod would not go — the schema is kept, and the reconcile ends it later`);
    return;
  }
  let schemaDropped = false;
  let realmDeleted = false;
  try {
    const db = await o.db();
    try {
      await db.dropSchema(rec.schema);
      schemaDropped = true;
      await db.deleteRealm(rec.realmId);
      realmDeleted = true;
    } finally {
      await db.close();
    }
  } catch (e) {
    o.log(`world ${id}: teardown incomplete (${e instanceof Error ? e.message : String(e)}) — left for the reconcile`);
  }
  const boot = rec.boots[rec.boots.length - 1];
  if (boot !== undefined && boot.endedAt === undefined) boot.endedAt = now();
  if (schemaDropped && realmDeleted) {
    rec.state = "ended";
    rec.endedAt = now();
  }
  rec.teardown = { why, at: now(), schemaDropped, realmDeleted, logSaved };
  o.store.write(rec);
  if (rec.state === "ended") o.log(`world ${id}: ended (${why}); schema ${rec.schema} dropped, realm ${rec.realmId} deleted`);
}

// ------------------------------------------------------ the run's fate

/**
 * What an attempt's world gets once its roster is done with it, from the
 * runs' own files: `end` when every run has its verdict (a termination) or
 * never started (no meta.json); `park` otherwise — a paused run resumes on it,
 * and an unknown one is the reconcile's to settle.
 */
export function worldFateOf(runDirs: readonly string[]): "end" | "park" {
  for (const dir of runDirs) {
    let meta: { termination?: unknown } | null = null;
    try {
      meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as typeof meta;
    } catch {
      if (existsSync(join(dir, "meta.json"))) return "park";
      continue;
    }
    if (!terminated(dir, meta)) return "park";
  }
  return "end";
}

function terminated(dir: string, meta: { termination?: unknown } | null): boolean {
  if (meta !== null && meta.termination !== undefined && meta.termination !== null) return true;
  // The trajectory's record is written first; a meta.json rewrite that failed leaves the verdict there alone.
  try {
    return terminationOfTrajectory(join(dir, "trajectory.jsonl")) !== null;
  } catch {
    return false;
  }
}

// --------------------------------------------------------- the reconcile

export interface ReconcileReport {
  ended: string[];
  parked: string[];
  podsDeleted: string[];
  /** Schemas and realm rows that no open record holds: listed, never touched. */
  orphanSchemas: string[];
  orphanRealms: number[];
}

/**
 * Settle the worlds nobody holds, at the fleet's start and once an hour: a
 * world whose roster is gone (another fleet pod, or a pid no longer alive) is
 * ended when its runs all have their verdict and parked otherwise; a world pod
 * with no open record is deleted. A schema or realm row with no record is
 * only listed. A world whose roster lives is never touched.
 */
export async function reconcileWorlds(o: {
  client: WorldK8s;
  db: () => Promise<WorldDb>;
  store: WorldStore;
  runsDir: string;
  fleetPod: string | null;
  alive?: (pid: number) => boolean;
  /** Whether a run has a live owner (`liveOwnerOf`); a test passes its own. */
  liveRun?: (runId: string) => boolean;
  podName: (id: string) => string;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The release the fleet's pods are, so another release's worlds in the namespace are never touched. */
  release?: string;
}): Promise<ReconcileReport> {
  const alive = o.alive ?? pidAlive;
  const liveRun = o.liveRun ?? ((runId: string) => liveOwnerOf(o.runsDir, runId) !== null);
  const report: ReconcileReport = { ended: [], parked: [], podsDeleted: [], orphanSchemas: [], orphanRealms: [] };
  const open = o.store.list().filter((r) => r.state !== "ended");
  // Held by its roster, or by a run still playing on it: a supervisor container
  // that restarted left its run pods playing with no roster behind them.
  const held = (r: WorldRecord): boolean => (r.owner.fleetPod === o.fleetPod && alive(r.owner.rosterPid)) || r.runIds.some(liveRun);
  for (const rec of open) {
    if (held(rec)) continue;
    const fate = worldFateOf(rec.runIds.map((id) => join(o.runsDir, id)));
    if (fate === "end") {
      await endWorld({ client: o.client, db: o.db, store: o.store, podName: o.podName(rec.id), log: o.log, ...(o.now !== undefined ? { now: o.now } : {}), ...(o.sleep !== undefined ? { sleep: o.sleep } : {}) }, rec.id, "reconcile: every run has its verdict");
      if (o.store.read(rec.id)?.state === "ended") report.ended.push(rec.id);
    } else if (rec.state !== "parked") {
      await saveWorldLog(o.client, o.store, rec.id, o.podName(rec.id), "parked by the reconcile");
      await removeWorldPod(o.client, o.podName(rec.id), WORLD_PARK_GRACE_S, o.sleep ?? ((ms) => Bun.sleep(ms)), o.log);
      rec.state = "parked";
      o.store.write(rec);
      report.parked.push(rec.id);
    }
  }
  const stillOpen = new Map(o.store.list().filter((r) => r.state !== "ended").map((r) => [r.id, r]));
  const selector = `${o.release !== undefined ? `app.kubernetes.io/instance=${o.release},` : ""}app.kubernetes.io/component=${WORLD_COMPONENT}`;
  for (const pod of await o.client.listPods(selector)) {
    const id = pod.metadata.labels?.[WORLD_ID_LABEL];
    const rec = id === undefined ? undefined : stillOpen.get(id);
    if (rec !== undefined && (held(rec) || rec.state === "up" || rec.state === "booting")) continue;
    if (pod.metadata.deletionTimestamp !== undefined || pod.metadata.name === undefined) continue;
    await o.client.deletePod(pod.metadata.name, rec !== undefined ? WORLD_PARK_GRACE_S : 0);
    report.podsDeleted.push(pod.metadata.name);
  }
  const db = await o.db();
  try {
    const schemas = new Set([...stillOpen.values()].map((r) => r.schema));
    const realms = new Set([...stillOpen.values()].map((r) => r.realmId));
    report.orphanSchemas = (await db.schemas()).filter((s) => !schemas.has(s));
    report.orphanRealms = (await db.realmIds()).filter((r) => !realms.has(r));
  } finally {
    await db.close();
  }
  return report;
}

// ------------------------------------------------------- the fleet page

/** How long an ended world stays on the fleet page, and how many are listed at most. */
export const WORLDS_LISTED_MS = 24 * 3_600_000;
export const WORLDS_LISTED_MAX = 20;

/** The worlds the fleet page lists: every open one, and those that ended lately, newest first. */
export function fleetWorldViews(records: readonly WorldRecord[], now: number): FleetWorldView[] {
  return records
    .filter((r) => r.state !== "ended" || (r.endedAt !== undefined && now - r.endedAt < WORLDS_LISTED_MS))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, WORLDS_LISTED_MAX)
    .map((r) => {
      const ready = [...r.boots].reverse().find((b) => b.bootMs !== undefined);
      const last = r.boots.at(-1);
      return {
        id: r.id,
        state: r.state,
        realmId: r.realmId,
        runIds: [...r.runIds],
        createdAt: r.createdAt,
        endedAt: r.endedAt ?? null,
        boots: r.boots.length,
        bootMs: ready?.bootMs ?? null,
        failed: last?.failed ?? null,
      };
    });
}

// ------------------------------------------------------------- loading

/** The world launcher for this fleet pod, or why there is none. */
export function loadWorldLauncher(opts: {
  rosterPid: number;
  repoRoot: string;
  log: (line: string) => void;
  env?: Record<string, string | undefined>;
  client?: WorldK8s | null;
  db?: () => Promise<WorldDb>;
}): WorldLauncher | { error: string } {
  const env = opts.env ?? process.env;
  const client = opts.client === undefined ? K8sClient.inCluster(undefined, env) : opts.client;
  if (client === null) return { error: "no Kubernetes ServiceAccount token is mounted — worlds run on the cluster only" };
  const path = env[WORLD_POD_TEMPLATE_ENV] ?? DEFAULT_WORLD_POD_TEMPLATE;
  let template: Pod;
  try {
    template = JSON.parse(readFileSync(path, "utf8")) as Pod;
    if (!template.spec?.containers?.some((c) => c.name === "worldserver")) return { error: `${path} is not a world pod template` };
  } catch (e) {
    return { error: `world pod template ${path} could not be read (${e instanceof Error ? e.message : String(e)}) — the chart renders it with worlds.enabled` };
  }
  const name = env["POD_NAME"];
  const uid = env["POD_UID"];
  const owner = name !== undefined && name.length > 0 && uid !== undefined && uid.length > 0 ? { name, uid } : undefined;
  // The startup budget the template's probe allows, plus the init containers' time.
  const ws = template.spec.containers.find((c) => c.name === "worldserver") as { startupProbe?: { periodSeconds?: number; failureThreshold?: number } } | undefined;
  const probeMs = ((ws?.startupProbe?.periodSeconds ?? 10) * (ws?.startupProbe?.failureThreshold ?? 30)) * 1000;
  return new WorldLauncher({
    client,
    template,
    db: opts.db ?? (() => mysqlWorldDb(env)),
    store: new WorldStore(join(opts.repoRoot, WORLDS_DIR)),
    owner,
    rosterPid: opts.rosterPid,
    log: opts.log,
    startupMs: probeMs + 3 * 60_000,
  });
}

/** Why no world can be made here for want of the chart's template, or undefined when it is mounted: the chart's `worlds.enabled`. */
export function worldTemplateRefusal(env: Record<string, string | undefined> = process.env): string | undefined {
  const path = env[WORLD_POD_TEMPLATE_ENV] ?? DEFAULT_WORLD_POD_TEMPLATE;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as Pod;
    return t.spec?.containers?.some((c) => c.name === "worldserver") === true ? undefined : `${path} is not a world pod template`;
  } catch {
    return `policy.worlds is "evals" but the chart renders no world template (${path}); set worlds.enabled, or the setting back to off`;
  }
}

/** The release the chart's template labels a world's pod with (`app.kubernetes.io/instance`), or undefined without a template. */
export function worldPodRelease(env: Record<string, string | undefined> = process.env): string | undefined {
  try {
    const t = JSON.parse(readFileSync(env[WORLD_POD_TEMPLATE_ENV] ?? DEFAULT_WORLD_POD_TEMPLATE, "utf8")) as Pod;
    return t.metadata.labels?.["app.kubernetes.io/instance"];
  } catch {
    return undefined;
  }
}

/** The prefix the chart's template names a world's pod with (`<prefix><id>`), read from the mounted template. */
export function worldPodPrefix(env: Record<string, string | undefined> = process.env): string {
  try {
    const t = JSON.parse(readFileSync(env[WORLD_POD_TEMPLATE_ENV] ?? DEFAULT_WORLD_POD_TEMPLATE, "utf8")) as Pod;
    return t.metadata.generateName ?? "world-";
  } catch {
    return "world-";
  }
}

/**
 * The book's world setting where this process runs, as the supervisor's tick
 * reads it (`worldsOf`), for a report: the chart's cap and the boot hold.
 */
export function worldsHere(mode: string, env: Record<string, string | undefined> = process.env, dir: string = join(dirname(import.meta.dir), WORLDS_DIR)): WorldsSetting | undefined {
  const onCluster = env["WRATHBENCH_IN_CONTAINER"] === "1" && K8sClient.inCluster(undefined, env) !== null;
  const settings = onCluster ? readLauncherSettings(env) : undefined;
  return worldsOf(mode, onCluster, settings === undefined || "error" in settings ? undefined : settings.maxWorlds, (onCluster && mode === "evals" ? worldTemplateRefusal(env) : undefined) ?? worldsHold(dir, Date.now()));
}
