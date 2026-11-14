/**
 * A world per eval (infra/world.ts), against a fake Kubernetes API, a fake
 * database and an injected clock: the pod a world is built as and every
 * refusal that keeps it off the shared world's identity, the two destructive
 * statements' own checks, the lifecycle (create, resume, park, end) and its
 * order, the boot hold, the lock, the fate read off the runs' files, the
 * reconcile, the roster's choice of world, and the planner's world key.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { K8sError, type Pod } from "./k8s-client";
import { parseLauncherSettings } from "./run-pod";
import { SlotBook, worldsOf, WORLD_KEY } from "./run-fleet-credentials";
import { jobArgv } from "./run-fleet-state";
import { openWorld } from "./run-roster";
import { parsePolicyBlock } from "../runner/src/models";
import { holdsOnlyLaunchFiles } from "../runner/src/launch-files";
import {
  buildWorldPod,
  checkRealmId,
  checkWorldSchema,
  isWorldId,
  moduleUrlOfRun,
  newWorldId,
  noteBoot,
  readWorldPointer,
  reconcileWorlds,
  schemaOf,
  stagingEnvOf,
  withWorldLock,
  WorldLauncher,
  worldFateOf,
  worldModuleUrl,
  worldPodRefusal,
  worldsHold,
  WorldStore,
  worldUsedBy,
  writeWorldPointer,
  BOOT_FAILURES_TO_HOLD,
  type WorldDb,
  type WorldK8s,
  type WorldRecord,
} from "./world";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

const ID = "wabcdefghij";
const ID2 = "wklmnopqrst";
const DIGEST_WS = `sha256:${"a".repeat(64)}`;
const DIGEST_DI = `sha256:${"b".repeat(64)}`;

/** The chart's world.json, as `helm template` renders it with worlds on (trimmed to what is read). */
function template(): Pod {
  const dbEnv = [
    { name: "WRATHBENCH_DB_HOST", value: "wrathbench-db" },
    { name: "WRATHBENCH_DB_PORT", value: "3306" },
    { name: "WRATHBENCH_DB_USER", value: "root" },
    { name: "WRATHBENCH_DB_PASSWORD", valueFrom: { secretKeyRef: { name: "wrathbench-env", key: "WRATHBENCH_DB_ROOT_PASSWORD" } } },
    { name: "AC_LOGIN_DATABASE_INFO", value: "$(WRATHBENCH_DB_HOST);3306;root;$(WRATHBENCH_DB_PASSWORD);acore_auth" },
    { name: "AC_WORLD_DATABASE_INFO", value: "$(WRATHBENCH_DB_HOST);3306;root;$(WRATHBENCH_DB_PASSWORD);acore_world" },
  ];
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { generateName: "wrathbench-world-", labels: { "app.kubernetes.io/instance": "wrathbench", "app.kubernetes.io/component": "world" } },
    spec: {
      restartPolicy: "Never",
      subdomain: "worlds",
      initContainers: [
        { name: "wait-for-db", image: "reg/wrathbench-worldserver:t1", env: dbEnv.slice(0, 4) },
        { name: "db-import", image: "reg/wrathbench-db-import:t1", env: [...dbEnv, { name: "AC_UPDATES_ENABLE_DATABASES", value: "2" }] },
      ],
      containers: [
        {
          name: "worldserver",
          image: "reg/wrathbench-worldserver:t1",
          env: [...dbEnv, { name: "AC_WRATH_BENCH_SECRET", valueFrom: { secretKeyRef: { name: "wrathbench-env", key: "WRATHBENCH_MODULE_SECRET" } } }],
          startupProbe: { periodSeconds: 10, failureThreshold: 30 },
        },
      ],
    },
  };
}

const envOf = (pod: Pod, name: string): Record<string, string | undefined> => {
  const c = [...((pod.spec["initContainers"] as Pod["spec"]["containers"]) ?? []), ...pod.spec.containers].find((x) => x.name === name)!;
  return Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value]));
};

/** What the fake API server does with a created pod. */
type Behaviour = "ready" | "never-ready" | "crash" | "quota" | "invalid";

class FakeK8s implements WorldK8s {
  readonly pods = new Map<string, Pod>();
  readonly calls: string[] = [];
  behaviour: Behaviour = "ready";
  /** Polls a deleted pod lingers for before it is gone. */
  linger = 0;
  private readonly gone = new Map<string, number>();
  constructor(private readonly onCall?: (c: string) => void) {}
  private note(c: string): void {
    this.calls.push(c);
    this.onCall?.(c);
  }
  async createPod(pod: Pod): Promise<Pod> {
    this.note(`create ${pod.metadata.name}`);
    if (this.behaviour === "quota") throw new K8sError(403, "Forbidden", `pods "${pod.metadata.name}" is forbidden: exceeded quota: wrathbench-v1, requested: limits.memory=4Gi`);
    if (this.behaviour === "invalid") throw new K8sError(422, "Invalid", "Pod is invalid");
    const p = structuredClone(pod);
    const ws = pod.spec.containers.find((c) => c.name === "worldserver")!;
    const di = (pod.spec["initContainers"] as { name: string; image: string }[]).find((c) => c.name === "db-import")!;
    p.status =
      this.behaviour === "crash"
        ? { phase: "Failed", containerStatuses: [{ name: "worldserver", state: { terminated: { exitCode: 1, reason: "Error" } } }] }
        : {
            phase: "Running",
            containerStatuses: [{ name: "worldserver", imageID: `${ws.image.split(":")[0]}@${DIGEST_WS}`, state: { running: {} } }],
            initContainerStatuses: [{ name: "db-import", imageID: `${di.image.split(":")[0]}@${DIGEST_DI}`, state: { terminated: { exitCode: 0, reason: "Completed" } } }],
          };
    this.pods.set(pod.metadata.name!, p);
    return p;
  }
  async getPod(name: string): Promise<Pod | null> {
    const left = this.gone.get(name);
    if (left !== undefined) {
      if (left <= 0) {
        this.gone.delete(name);
        this.pods.delete(name);
        return null;
      }
      this.gone.set(name, left - 1);
    }
    return this.pods.get(name) ?? null;
  }
  async listPods(selector: string): Promise<Pod[]> {
    this.note(`list ${selector}`);
    return [...this.pods.values()];
  }
  async deletePod(name: string, grace: number): Promise<void> {
    this.note(`delete ${name} grace ${grace}`);
    if (!this.pods.has(name)) return;
    this.gone.set(name, this.linger);
  }
  async podLog(name: string): Promise<ReadableStream<Uint8Array> | null> {
    this.note(`log ${name}`);
    if (!this.pods.has(name)) return null;
    return new Response(`World Initialized In 0 Minutes 13 Seconds\n`).body;
  }
}

class FakeDb implements WorldDb {
  readonly realms = new Set<number>();
  readonly schemaSet = new Set<string>();
  constructor(private readonly onCall: (c: string) => void) {}
  async realmIds() {
    return [...this.realms];
  }
  async schemas() {
    return [...this.schemaSet];
  }
  async putRealm(realmId: number, id: string) {
    checkRealmId(realmId);
    this.onCall(`putRealm ${realmId} ${id}`);
    this.realms.add(realmId);
  }
  async deleteRealm(realmId: number) {
    checkRealmId(realmId);
    this.onCall(`deleteRealm ${realmId}`);
    this.realms.delete(realmId);
  }
  async dropSchema(schema: string) {
    checkWorldSchema(schema);
    this.onCall(`dropSchema ${schema}`);
    this.schemaSet.delete(schema);
  }
  async close() {}
}

/** One launcher over the fakes, a fake clock that each sleep advances, and a log of every call in order. */
function rig(o: { behaviour?: Behaviour; ready?: (n: number) => boolean; ids?: string[]; alive?: (pid: number) => boolean } = {}) {
  const calls: string[] = [];
  const k8s = new FakeK8s((c) => calls.push(c));
  k8s.behaviour = o.behaviour ?? "ready";
  const db = new FakeDb((c) => calls.push(c));
  const dir = tempDir("wb-worlds-");
  const runs = tempDir("wb-world-runs-");
  const store = new WorldStore(dir);
  const clock = { now: 1_800_000_000_000 };
  const ids = [...(o.ids ?? [ID, ID2])];
  let healthCalls = 0;
  const log: string[] = [];
  const launcher = new WorldLauncher({
    client: k8s,
    template: template(),
    db: async () => db,
    store,
    owner: { name: "wrathbench-fleet-abc", uid: "uid-1" },
    rosterPid: 4242,
    log: (l) => log.push(l),
    health: async () => {
      healthCalls++;
      const ready = o.ready?.(healthCalls) ?? k8s.behaviour === "ready";
      return { ready, detail: ready ? "200" : "503 world_not_loaded" };
    },
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    startupMs: 60_000,
    alive: o.alive ?? (() => false),
    random: () => {
      const id = ids.shift() ?? newWorldId();
      // Bytes that spell `id` back through the base32 alphabet.
      return new Uint8Array([...id.slice(1)].map((ch) => "abcdefghijklmnopqrstuvwxyz234567".indexOf(ch)));
    },
  });
  return { launcher, k8s, db, store, dir, runs, clock, calls, log };
}

describe("names", () => {
  test("a world id is w and ten lowercase base32 characters; its schema, URLs and staging env follow from it", () => {
    for (let i = 0; i < 50; i++) expect(isWorldId(newWorldId())).toBe(true);
    expect(isWorldId("w0abcdefghj")).toBe(false);
    expect(isWorldId("Wabcdefghij")).toBe(false);
    expect(isWorldId("shared")).toBe(false);
    expect(schemaOf(ID)).toBe(`acore_characters_${ID}`);
    expect(() => schemaOf("x")).toThrow();
    expect(worldModuleUrl(ID)).toBe(`http://${ID}.worlds:8086`);
    expect(stagingEnvOf(ID, 7878)).toEqual({ WRATHBENCH_MODULE_URL: `http://${ID}.worlds:8086`, WRATHBENCH_SOAP_URL: `http://${ID}.worlds:7878/`, WRATHBENCH_CHARACTERS_DB: `acore_characters_${ID}` });
  });

  test("only scored and probing tiers get a world, and only with the setting on", () => {
    for (const e of ["e90", "e360", "probing"]) expect(worldUsedBy("evals", e)).toBe(true);
    for (const e of ["freeplay", undefined, null, "e90x"]) expect(worldUsedBy("evals", e)).toBe(false);
    expect(worldUsedBy("off", "e90")).toBe(false);
  });

  test("the pointer is a launch file, and routes the run's session release to its world", () => {
    const dir = join(tempDir("wb-world-ptr-"), "run-a");
    expect(readWorldPointer(dir)).toBeUndefined();
    expect(moduleUrlOfRun(dir, "http://worldserver:8086")).toBe("http://worldserver:8086");
    writeWorldPointer(dir, ID);
    expect(readWorldPointer(dir)).toBe(ID);
    expect(moduleUrlOfRun(dir, "http://worldserver:8086")).toBe(`http://${ID}.worlds:8086`);
    expect(holdsOnlyLaunchFiles(dir)).toBe(true);
    expect(() => writeWorldPointer(dir, "shared")).toThrow();
  });
});

describe("the destructive statements check their own argument", () => {
  test("a schema is dropped only when it is a world's", () => {
    for (const bad of ["acore_characters", "acore_world", "acore_auth", "", "acore_characters_", "acore_characters_w0abcdefghj", `acore_characters_${ID}; DROP DATABASE acore_auth`, `acore_characters_${ID}x`]) {
      expect(() => checkWorldSchema(bad)).toThrow();
    }
    expect(() => checkWorldSchema(`acore_characters_${ID}`)).not.toThrow();
  });

  test("a realm row is a world's only between 2 and 254: never realm 1", () => {
    for (const bad of [0, 1, 255, -1, 2.5, Number.NaN]) expect(() => checkRealmId(bad)).toThrow();
    for (const ok of [2, 100, 254]) expect(() => checkRealmId(ok)).not.toThrow();
  });
});

describe("buildWorldPod: a world of its own, or refused", () => {
  const opts = { id: ID, realmId: 7, accounts: ["pool03", "POOL04"], owner: { name: "fleet", uid: "u" }, rosterPid: 99 };

  test("both the db-import init and the worldserver get the world's own schema; the worldserver its realm and allowlist; the pod its name and hostname", () => {
    const pod = buildWorldPod(template(), opts);
    expect(pod.metadata.name).toBe(`wrathbench-world-${ID}`);
    expect(pod.metadata.generateName).toBeUndefined();
    expect(pod.spec["hostname"]).toBe(ID);
    expect(pod.spec["subdomain"]).toBe("worlds");
    expect(pod.metadata.labels).toMatchObject({ "app.kubernetes.io/component": "world", "wrathbench.shard.page/world": ID, "wrathbench.shard.page/roster-pid": "99" });
    expect(pod.metadata.annotations?.["wrathbench.shard.page/world-id"]).toBe(ID);
    expect(pod.metadata.ownerReferences).toEqual([{ apiVersion: "v1", kind: "Pod", name: "fleet", uid: "u" }]);
    const info = `$(WRATHBENCH_DB_HOST);$(WRATHBENCH_DB_PORT);$(WRATHBENCH_DB_USER);$(WRATHBENCH_DB_PASSWORD);acore_characters_${ID}`;
    expect(envOf(pod, "db-import")["AC_CHARACTER_DATABASE_INFO"]).toBe(info);
    const ws = envOf(pod, "worldserver");
    expect(ws["AC_CHARACTER_DATABASE_INFO"]).toBe(info);
    expect(ws["AC_REALM_ID"]).toBe("7");
    expect(ws["AC_WRATH_BENCH_ACCOUNTS"]).toBe("POOL03,POOL04");
    // The variables it expands are defined before it, as the kubelet needs.
    const names = (pod.spec.containers[0]!.env ?? []).map((e) => e.name);
    expect(names.indexOf("WRATHBENCH_DB_PASSWORD")).toBeLessThan(names.indexOf("AC_CHARACTER_DATABASE_INFO"));
    // The template is not touched.
    expect(template().metadata.name).toBeUndefined();
  });

  test("a re-boot runs the digests the first boot recorded", () => {
    const pod = buildWorldPod(template(), { ...opts, images: { worldserver: `reg/wrathbench-worldserver@${DIGEST_WS}`, dbImport: `reg/wrathbench-db-import@${DIGEST_DI}` } });
    expect(pod.spec.containers[0]!.image).toBe(`reg/wrathbench-worldserver@${DIGEST_WS}`);
    expect((pod.spec["initContainers"] as { name: string; image: string }[]).find((c) => c.name === "db-import")!.image).toBe(`reg/wrathbench-db-import@${DIGEST_DI}`);
  });

  test("refused: a realm of the shared world's or none, an empty allowlist or one with STAGER, a bad id", () => {
    expect(() => buildWorldPod(template(), { ...opts, realmId: 1 })).toThrow(/realm 1/);
    expect(() => buildWorldPod(template(), { ...opts, realmId: 255 })).toThrow();
    expect(() => buildWorldPod(template(), { ...opts, accounts: [] })).toThrow(/allowlist/);
    expect(() => buildWorldPod(template(), { ...opts, accounts: ["POOL01", "stager"] })).toThrow(/STAGER/);
    expect(() => buildWorldPod(template(), { ...opts, accounts: ["POOL 01"] })).toThrow(/not an account/);
    expect(() => buildWorldPod(template(), { ...opts, id: "w0abcdefghj" })).toThrow(/not a world id/);
  });

  test("refused: a template without the db-import init or the worlds subdomain", () => {
    const noInit = template();
    noInit.spec["initContainers"] = (noInit.spec["initContainers"] as { name: string }[]).filter((c) => c.name !== "db-import");
    expect(() => buildWorldPod(noInit, opts)).toThrow(/db-import/);
    const wrongSub = template();
    wrongSub.spec["subdomain"] = "worldserver";
    expect(() => buildWorldPod(wrongSub, opts)).toThrow(/subdomain/);
  });

  test("the refusal reads the output: each of the three identity variables missing or the shared one is refused", () => {
    const good = buildWorldPod(template(), opts);
    expect(worldPodRefusal(good)).toBeUndefined();
    const without = (container: string, name: string, value?: string): Pod => {
      const p = structuredClone(good);
      const c = [...(p.spec["initContainers"] as Pod["spec"]["containers"]), ...p.spec.containers].find((x) => x.name === container)!;
      c.env = (c.env ?? []).filter((e) => e.name !== name);
      if (value !== undefined) c.env.push({ name, value });
      return p;
    };
    expect(worldPodRefusal(without("db-import", "AC_CHARACTER_DATABASE_INFO"))).toContain("db-import names no world schema");
    expect(worldPodRefusal(without("worldserver", "AC_CHARACTER_DATABASE_INFO"))).toContain("worldserver names no world schema");
    expect(worldPodRefusal(without("worldserver", "AC_CHARACTER_DATABASE_INFO", "h;3306;root;pw;acore_characters"))).toContain("shared characters");
    expect(worldPodRefusal(without("worldserver", "AC_REALM_ID"))).toContain("realm 1");
    expect(worldPodRefusal(without("worldserver", "AC_REALM_ID", "1"))).toContain("realm");
    expect(worldPodRefusal(without("worldserver", "AC_WRATH_BENCH_ACCOUNTS"))).toContain("allowlist");
    expect(worldPodRefusal(without("worldserver", "AC_WRATH_BENCH_ACCOUNTS", ""))).toContain("allowlist");
  });
});

describe("WorldLauncher", () => {
  test("create: record, then realm row, pointers and pod; ready on /health; the digests it ran recorded", async () => {
    const r = rig();
    const runDir = join(r.runs, "fleet-x-e90-a1");
    const got = await r.launcher.create({ runDirs: [runDir], runIds: ["fleet-x-e90-a1"], accounts: ["pool01"] });
    expect(got).toEqual({ ok: true, id: ID, url: `http://${ID}.worlds:8086` });
    expect(readWorldPointer(runDir)).toBe(ID);
    expect(r.calls.slice(0, 2)).toEqual([`putRealm 2 ${ID}`, `create wrathbench-world-${ID}`]);
    const rec = r.store.read(ID)!;
    expect(rec).toMatchObject({ id: ID, realmId: 2, schema: `acore_characters_${ID}`, accounts: ["POOL01"], runIds: ["fleet-x-e90-a1"], state: "up", owner: { rosterPid: 4242, fleetPod: "wrathbench-fleet-abc" } });
    expect(rec.images).toEqual({ worldserver: `reg/wrathbench-worldserver@${DIGEST_WS}`, dbImport: `reg/wrathbench-db-import@${DIGEST_DI}` });
    expect(rec.boots).toHaveLength(1);
    expect(rec.boots[0]!.bootMs).toBeGreaterThanOrEqual(0);
    expect(worldsHold(r.dir, r.clock.now)).toBeUndefined();
  });

  test("the realm slot skips what the database or an open record holds", async () => {
    const r = rig();
    r.db.realms.add(2);
    r.db.realms.add(4);
    const rec: WorldRecord = { id: "wzzzzzzzzzz", realmId: 3, schema: "acore_characters_wzzzzzzzzzz", accounts: ["A"], runIds: [], owner: { rosterPid: 1, fleetPod: null }, createdAt: 0, images: {}, boots: [], state: "parked" };
    r.store.write(rec);
    await r.launcher.create({ runDirs: [], runIds: ["x"], accounts: ["A"] });
    expect(r.store.read(ID)!.realmId).toBe(5);
  });

  test("a full namespace is no capacity: the world is ended at once, and it is no failed boot", async () => {
    const r = rig({ behaviour: "quota" });
    const got = await r.launcher.create({ runDirs: [], runIds: ["x"], accounts: ["A"] });
    expect(got).toMatchObject({ ok: false, noCapacity: true });
    expect(r.store.read(ID)!.state).toBe("ended");
    expect(r.calls).toContain(`dropSchema acore_characters_${ID}`);
    expect(r.calls).toContain("deleteRealm 2");
    expect(r.db.realms.size).toBe(0);
    for (let i = 0; i < 5; i++) noteBoot(r.dir, undefined, r.clock.now);
    expect(worldsHold(r.dir, r.clock.now)).toBeUndefined();
  });

  test("a boot that never comes up is ended inside its budget, with its log saved; three in a row hold the worlds", async () => {
    const r = rig({ behaviour: "never-ready", ids: [ID, ID2, "wuuuuuuuuuu", "wvvvvvvvvvv"] });
    for (let i = 0; i < BOOT_FAILURES_TO_HOLD; i++) {
      const got = await r.launcher.create({ runDirs: [], runIds: [`r${i}`], accounts: ["A"] });
      expect(got.ok).toBe(false);
    }
    const first = r.store.read(ID)!;
    expect(first.state).toBe("ended");
    expect(first.boots[0]!.failed).toContain("not ready after");
    expect(readFileSync(join(r.dir, ID, "server.log"), "utf8")).toContain("World Initialized");
    expect(worldsHold(r.dir, r.clock.now)).toContain(`${BOOT_FAILURES_TO_HOLD} boots failed in a row`);
    const callsBefore = r.k8s.calls.length;
    const held = await r.launcher.create({ runDirs: [], runIds: ["r9"], accounts: ["A"] });
    expect(held).toMatchObject({ ok: false, noCapacity: true });
    expect(r.k8s.calls.length).toBe(callsBefore);
    // The hold lapses with time, and a boot that succeeds clears it.
    expect(worldsHold(r.dir, r.clock.now + 31 * 60_000)).toBeUndefined();
    noteBoot(r.dir, undefined, r.clock.now);
    expect(worldsHold(r.dir, r.clock.now)).toBeUndefined();
  });

  test("a pod that ends while it boots is a failed boot", async () => {
    const r = rig({ behaviour: "crash" });
    const got = await r.launcher.create({ runDirs: [], runIds: ["x"], accounts: ["A"] });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("ended while it booted");
  });

  test("end: the log saved and the pod gone before the schema is dropped and the realm row deleted", async () => {
    const r = rig();
    await r.launcher.create({ runDirs: [], runIds: ["x"], accounts: ["A"] });
    r.k8s.linger = 3;
    r.calls.length = 0;
    await r.launcher.end(ID, "verdict");
    const order = r.calls.filter((c) => !c.startsWith("list"));
    expect(order).toEqual([`log wrathbench-world-${ID}`, `delete wrathbench-world-${ID} grace 0`, `dropSchema acore_characters_${ID}`, "deleteRealm 2"]);
    const rec = r.store.read(ID)!;
    expect(rec.state).toBe("ended");
    expect(rec.teardown).toMatchObject({ why: "verdict", schemaDropped: true, realmDeleted: true, logSaved: true });
    // Ending twice is a no-op.
    r.calls.length = 0;
    await r.launcher.end(ID, "again");
    expect(r.calls).toEqual([]);
  });

  test("park keeps the schema and gives the pod its grace; resume boots it again on the recorded digests; an ended world cannot be resumed", async () => {
    const r = rig();
    await r.launcher.create({ runDirs: [], runIds: ["x"], accounts: ["A"] });
    await r.launcher.park(ID, "paused");
    expect(r.calls).toContain(`delete wrathbench-world-${ID} grace 120`);
    expect(r.calls.some((c) => c.startsWith("dropSchema"))).toBe(false);
    expect(r.store.read(ID)!.state).toBe("parked");
    r.calls.length = 0;
    const back = await r.launcher.resume(ID);
    expect(back).toEqual({ ok: true, id: ID, url: `http://${ID}.worlds:8086` });
    const pod = r.k8s.pods.get(`wrathbench-world-${ID}`)!;
    expect(pod.spec.containers[0]!.image).toBe(`reg/wrathbench-worldserver@${DIGEST_WS}`);
    expect(r.store.read(ID)!.boots).toHaveLength(2);
    // A world that answers is used as it is.
    r.calls.length = 0;
    expect((await r.launcher.resume(ID)).ok).toBe(true);
    expect(r.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    await r.launcher.end(ID, "verdict");
    expect(await r.launcher.resume(ID)).toMatchObject({ ok: false });
    expect(await r.launcher.resume("wnnnnnnnnnn")).toMatchObject({ ok: false });
  });
});

describe("withWorldLock", () => {
  test("one holder at a time; a dead holder's lock is taken over; a live one is waited for, then given up on", async () => {
    const dir = tempDir("wb-world-lock-");
    const order: string[] = [];
    let release!: () => void;
    const first = withWorldLock(dir, () => new Promise<string>((res) => {
      order.push("first in");
      release = () => res("first");
    }), { staleMs: 60_000, waitMs: 60_000, pollMs: 1, pid: 111, alive: () => true });
    await Bun.sleep(5);
    const second = withWorldLock(dir, async () => {
      order.push("second in");
      return "second";
    }, { staleMs: 60_000, waitMs: 60_000, pollMs: 1, pid: 222, alive: () => true });
    await Bun.sleep(20);
    expect(order).toEqual(["first in"]);
    release();
    expect(await first).toEqual({ ok: true, value: "first" });
    expect(await second).toEqual({ ok: true, value: "second" });

    mkdirSync(join(dir, ".boot.lock"));
    writeFileSync(join(dir, ".boot.lock", "owner"), "333\n");
    expect(await withWorldLock(dir, async () => "taken", { staleMs: 60_000, waitMs: 0, pid: 444, alive: (p) => p !== 333 })).toEqual({ ok: true, value: "taken" });
    mkdirSync(join(dir, ".boot.lock"));
    writeFileSync(join(dir, ".boot.lock", "owner"), "555\n");
    const busy = await withWorldLock(dir, async () => "never", { staleMs: 60_000, waitMs: 0, pid: 666, alive: () => true });
    expect(busy).toMatchObject({ ok: false });
  });
});

describe("worldFateOf: from the runs' own files", () => {
  const run = (root: string, name: string, meta?: object, trajectory?: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (meta !== undefined) writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    if (trajectory !== undefined) writeFileSync(join(dir, "trajectory.jsonl"), trajectory);
    return dir;
  };

  test("ended when every run has its verdict or never started; parked while one may resume", () => {
    const root = tempDir("wb-world-fate-");
    const done = run(root, "done", { termination: { reason: "episode-limit" } });
    const never = run(root, "never");
    const paused = run(root, "paused", { pauseReason: "party-paused" });
    const viaTrajectory = run(root, "traj", { config: {} }, `${JSON.stringify({ t: "termination", ts: 1, reason: "death-limit" })}\n`);
    expect(worldFateOf([done, never])).toBe("end");
    expect(worldFateOf([done, viaTrajectory])).toBe("end");
    expect(worldFateOf([done, paused])).toBe("park");
    expect(worldFateOf([])).toBe("end");
  });
});

describe("reconcileWorlds", () => {
  test("a world whose roster lives is never touched; one nobody holds is ended or parked by its runs; an orphan pod is deleted; an orphan schema only listed", async () => {
    const r = rig({ ids: [ID, ID2, "wuuuuuuuuuu"] });
    const runs = r.runs;
    const runDir = (id: string, meta?: object) => {
      mkdirSync(join(runs, id), { recursive: true });
      if (meta !== undefined) writeFileSync(join(runs, id, "meta.json"), JSON.stringify(meta));
    };
    await r.launcher.create({ runDirs: [join(runs, "held")], runIds: ["held"], accounts: ["A"] });
    await r.launcher.create({ runDirs: [join(runs, "ended")], runIds: ["ended"], accounts: ["B"] });
    await r.launcher.create({ runDirs: [join(runs, "paused")], runIds: ["paused"], accounts: ["C"] });
    runDir("held");
    runDir("ended", { termination: { reason: "episode-limit" } });
    runDir("paused", { pauseReason: "rate-limited" });
    // The ended and paused worlds' rosters are gone: another fleet pod held them.
    for (const id of [ID2, "wuuuuuuuuuu"]) {
      const rec = r.store.read(id)!;
      rec.owner = { rosterPid: 1, fleetPod: "an-old-fleet-pod" };
      r.store.write(rec);
    }
    // An orphan pod and an orphan schema.
    r.k8s.pods.set("wrathbench-world-wooooooooooo", { metadata: { name: "wrathbench-world-wooooooooooo", labels: { "wrathbench.shard.page/world": "wooooooooooo" } }, spec: { containers: [] } });
    r.db.schemaSet.add("acore_characters_wqqqqqqqqqq");
    r.db.schemaSet.add(`acore_characters_${ID}`);
    const report = await reconcileWorlds({
      client: r.k8s,
      db: async () => r.db,
      store: r.store,
      runsDir: runs,
      fleetPod: "wrathbench-fleet-abc",
      alive: (pid) => pid === 4242,
      podName: (id) => `wrathbench-world-${id}`,
      log: () => {},
      now: () => r.clock.now,
      sleep: async () => {},
    });
    expect(report.ended).toEqual([ID2]);
    expect(report.parked).toEqual(["wuuuuuuuuuu"]);
    expect(report.podsDeleted).toEqual(["wrathbench-world-wooooooooooo"]);
    expect(report.orphanSchemas).toEqual(["acore_characters_wqqqqqqqqqq"]);
    expect(r.db.schemaSet.has("acore_characters_wqqqqqqqqqq")).toBe(true);
    expect(r.store.read(ID)!.state).toBe("up");
    expect(r.k8s.pods.has(`wrathbench-world-${ID}`)).toBe(true);
    expect(r.store.read("wuuuuuuuuuu")!.state).toBe("parked");
  });
});

describe("the roster's world for an attempt (openWorld)", () => {
  type Call = { kind: "create"; accounts: readonly string[]; runIds: readonly string[] } | { kind: "resume"; id: string };
  const fake = (calls: Call[]) => ({
    create: async (o: { runDirs: readonly string[]; runIds: readonly string[]; accounts: readonly string[] }) => {
      calls.push({ kind: "create", accounts: o.accounts, runIds: o.runIds });
      for (const d of o.runDirs) writeWorldPointer(d, ID);
      return { ok: true as const, id: ID, url: worldModuleUrl(ID) };
    },
    resume: async (id: string) => {
      calls.push({ kind: "resume", id });
      return { ok: true as const, id, url: worldModuleUrl(id) };
    },
  });
  const spec = (runId: string, episode: string | undefined, account?: string) => ({ runId, episode, account, campaignFile: undefined });

  test("fresh: a scored or probing launch gets a world of its own with its accounts; freeplay and worlds off share the long-lived one", async () => {
    const runs = tempDir("wb-openworld-");
    const calls: Call[] = [];
    const deps = (mode: "off" | "evals") => ({ mode, launcher: () => fake(calls) as never, runDir: (id: string) => join(runs, id) });
    expect(await openWorld([spec("a", "e90", "pool01")], false, deps("evals"))).toEqual({ world: { id: ID, url: worldModuleUrl(ID) } });
    expect(calls).toEqual([{ kind: "create", accounts: ["POOL01"], runIds: ["a"] }]);
    expect(await openWorld([spec("b", "freeplay", "RUNNER")], false, deps("evals"))).toEqual({ world: undefined });
    expect(await openWorld([spec("c", "e90")], false, deps("off"))).toEqual({ world: undefined });
    expect(calls).toHaveLength(1);
    // A party's members share one world, every account on it.
    await openWorld([spec("p-tank", "probing", "PARTY1"), spec("p-heal", "probing", "PARTY2")], false, deps("evals"));
    expect(calls.at(-1)).toEqual({ kind: "create", accounts: ["PARTY1", "PARTY2"], runIds: ["p-tank", "p-heal"] });
  });

  test("fresh with no launcher is refused, never sent to the shared world", async () => {
    const r = await openWorld([spec("a", "e360")], false, { mode: "evals", launcher: () => ({ error: "not on the cluster" }), runDir: (id) => join(tempDir("wb-ow-"), id) });
    expect(r).toEqual({ refused: "no world for a e360 attempt: not on the cluster" });
  });

  test("resume: the world the run's pointer names, whatever the setting now; none is the shared world; members that disagree are refused", async () => {
    const runs = tempDir("wb-openworld-resume-");
    const calls: Call[] = [];
    const deps = { mode: "off" as const, launcher: () => fake(calls) as never, runDir: (id: string) => join(runs, id) };
    expect(await openWorld([spec("old", "probing")], true, deps)).toEqual({ world: undefined });
    writeWorldPointer(join(runs, "a"), ID);
    expect(await openWorld([spec("a", "probing")], true, deps)).toEqual({ world: { id: ID, url: worldModuleUrl(ID) } });
    expect(calls).toEqual([{ kind: "resume", id: ID }]);
    writeWorldPointer(join(runs, "b"), ID2);
    expect(await openWorld([spec("a", "probing"), spec("b", "probing")], true, deps)).toMatchObject({ refused: expect.stringContaining("different worlds") });
    expect(await openWorld([spec("a", "probing"), spec("none", "probing")], true, deps)).toMatchObject({ refused: expect.stringContaining("different worlds") });
  });
});

describe("the planner's world key", () => {
  test("off is no key; on, a scored or probing job takes one world however many sessions, and the cap holds the rest", () => {
    expect(worldsOf("off", true, 3)).toBeUndefined();
    const book = new SlotBook([], {}, undefined, worldsOf("evals", true, 2));
    const keys = book.keysOf("openai", null, "probing");
    expect(keys).toContain(WORLD_KEY);
    expect(book.keysOf("openai", null, "freeplay")).not.toContain(WORLD_KEY);
    // A party of five is one world.
    book.add(keys, 5);
    expect(book.inUse(WORLD_KEY)).toBe(1);
    expect(book.fullKey(keys, 5)).toBeUndefined();
    book.add(book.keysOf("openai", null, "e90"));
    expect(book.fullKey(book.keysOf("openai", null, "e360"))).toBe(WORLD_KEY);
    expect(book.describe(WORLD_KEY)).toBe("worlds 2/2 (the chart's worlds.max)");
    book.remove(keys, 5);
    expect(book.inUse(WORLD_KEY)).toBe(1);
  });

  test("with worlds on, none made is a full key that says why: off the cluster, or the boot hold", () => {
    const off = new SlotBook([], {}, undefined, worldsOf("evals", false, undefined));
    expect(off.fullKey(off.keysOf("openai", null, "e90"))).toBe(WORLD_KEY);
    expect(off.describe(WORLD_KEY)).toContain("not on the cluster");
    const held = new SlotBook([], {}, undefined, worldsOf("evals", true, 4, "worlds held: 3 boots failed in a row"));
    expect(held.describe(WORLD_KEY)).toBe("worlds held: 3 boots failed in a row");
    expect(held.fullKey(held.keysOf("openai", null, "e90"))).toBe(WORLD_KEY);
  });

  test("the policy, the launcher's settings and the roster argv carry the setting", () => {
    expect(parsePolicyBlock({}).worlds).toBe("off");
    expect(parsePolicyBlock({ worlds: "evals" }).worlds).toBe("evals");
    expect(() => parsePolicyBlock({ worlds: "all" })).toThrow(/policy.worlds/);
    expect(parseLauncherSettings({ maxWorlds: 3 }).maxWorlds).toBe(3);
    expect(parseLauncherSettings({ maxWorlds: null }).maxWorlds).toBeUndefined();
    expect(() => parseLauncherSettings({ maxWorlds: 0 })).toThrow(/maxWorlds/);
    const spawn = { name: "j", enabled: true, account: "POOL01", loop: false, entries: [] };
    expect(jobArgv(spawn, { stamp: "20261114", until: undefined, worlds: "evals" })).toContain("--worlds");
    expect(jobArgv(spawn, { stamp: "20261114", until: undefined, worlds: "off" })).not.toContain("--worlds");
  });
});

test("the store lists only world ids and survives a torn file", () => {
  const dir = tempDir("wb-world-store-");
  const store = new WorldStore(dir);
  mkdirSync(join(dir, "not-a-world"), { recursive: true });
  mkdirSync(join(dir, ID), { recursive: true });
  writeFileSync(join(dir, ID, "world.json"), "{ torn");
  expect(store.list()).toEqual([]);
  expect(existsSync(join(dir, "not-a-world"))).toBe(true);
});
