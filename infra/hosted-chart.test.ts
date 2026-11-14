/**
 * The chart's `hosted` block (hosted mode's share of the cluster), rendered
 * with helm when it is on PATH. Off, it renders nothing of its own. On, what
 * is pinned:
 *
 *  - the freeplay world's module settings land on the long-lived worldserver
 *    and never on a world pod, which keeps `worldserver.threads` and no cap;
 *  - a world pod's port secret is a key of its own, which only the fleet pod
 *    carries beside WRATHBENCH_MODULE_SECRET, so the freeplay world's secret
 *    (the gateway's) opens no eval's world;
 *  - the tenant pool is on the freeplay world's allowlist and in the bootstrap
 *    Job, and in no pod that parses the fleet config;
 *  - the reserved list is the allowlist without the tenants, and covers every
 *    account the repo's own config and smokes lease on that world;
 *  - it refuses a deployment whose evals would play on the freeplay world.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { accountsOf, SUITE_MEMBERS } from "./smoke/lib/suite";
import { isTenantAccountName, tenantAccountNames } from "./tenant-accounts";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];
const ON = ["--set", "hosted.enabled=true", "--set", "worlds.enabled=true"];

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } } };
type Container = { name: string; env?: Env[] };
type PodSpec = { initContainers?: Container[]; containers: Container[] };
type Doc = {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  spec?: { template?: { spec?: PodSpec }; jobTemplate?: { spec: { template: { spec: PodSpec } } } };
} | null;

function render(extra: string[]): { code: number; stderr: string; docs: Doc[] } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  const docs = r.exitCode === 0 ? r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc) : [];
  return { code: r.exitCode ?? -1, stderr: r.stderr.toString(), docs };
}

function rendered(extra: string[]): Doc[] {
  const r = render(extra);
  expect(r.code, r.stderr).toBe(0);
  return r.docs;
}

const find = (docs: Doc[], kind: string, name: string): NonNullable<Doc> => {
  const d = docs.find((x) => x?.kind === kind && x.metadata?.name === name);
  expect(d, `${kind}/${name} renders`).toBeDefined();
  return d!;
};
const containerOf = (docs: Doc[], kind: string, name: string, container: string): Container => {
  const c = find(docs, kind, name).spec!.template!.spec!.containers.find((x) => x.name === container);
  expect(c, `${kind}/${name} has ${container}`).toBeDefined();
  return c!;
};
const worldserver = (docs: Doc[]) => containerOf(docs, "Deployment", "wrathbench-worldserver", "worldserver");
/** The world pod's worldserver container, out of the run-pod template ConfigMap. */
const worldPod = (docs: Doc[]): Container => {
  const pod = JSON.parse(find(docs, "ConfigMap", "wrathbench-run-pod-template").data!["world.json"]!) as { spec: PodSpec };
  return pod.spec.containers.find((c) => c.name === "worldserver")!;
};
const value = (c: Container, name: string) => c.env?.find((e) => e.name === name)?.value;
const secretKey = (c: Container, name: string) => c.env?.find((e) => e.name === name)?.valueFrom?.secretKeyRef?.key;
const CAPS = ["AC_WRATH_BENCH_ACTION_RATE", "AC_WRATH_BENCH_ACTION_BURST", "AC_WRATH_BENCH_MAX_CONNECTIONS_PER_PEER"];

/** Every container of every pod-bearing object, by `<kind>/<name>/<container>`. */
function everyContainer(docs: Doc[]): [string, Container][] {
  const out: [string, Container][] = [];
  for (const d of docs) {
    const spec = d?.spec?.template?.spec ?? d?.spec?.jobTemplate?.spec.template.spec;
    if (!spec) continue;
    for (const c of [...(spec.initContainers ?? []), ...spec.containers]) out.push([`${d!.kind}/${d!.metadata?.name}/${c.name}`, c]);
  }
  return out;
}

describe.skipIf(helm === null)("the chart's hosted block", () => {
  test(
    "off renders nothing of it",
    () => {
      for (const extra of [[], ["--set", "worlds.enabled=true"]]) {
        const docs = rendered(extra);
        expect(docs.some((d) => d?.metadata?.name === "wrathbench-hosted")).toBe(false);
        const ws = worldserver(docs);
        expect(value(ws, "AC_WRATH_BENCH_THREADS")).toBe("2");
        for (const k of CAPS) expect(value(ws, k), k).toBeUndefined();
        expect(value(ws, "AC_WRATH_BENCH_ACCOUNTS")).not.toContain("TENANT");
        for (const [where, c] of everyContainer(docs)) {
          expect(c.env?.some((e) => e.name === "WRATHBENCH_TENANT_POOL_SIZE" || e.name === "WRATHBENCH_WORLDS_MODULE_SECRET"), where).toBe(false);
        }
      }
    },
    HELM_TEST_MS,
  );

  test(
    "the freeplay world gets the threads and caps; a world pod keeps worldserver.threads and no cap",
    () => {
      const docs = rendered(ON);
      const ws = worldserver(docs);
      expect(value(ws, "AC_WRATH_BENCH_THREADS")).toBe("8");
      expect(value(ws, "AC_WRATH_BENCH_ACTION_RATE")).toBe("20");
      expect(value(ws, "AC_WRATH_BENCH_ACTION_BURST")).toBe("40");
      expect(value(ws, "AC_WRATH_BENCH_MAX_CONNECTIONS_PER_PEER")).toBe("0");
      const world = worldPod(docs);
      expect(value(world, "AC_WRATH_BENCH_THREADS")).toBe("2");
      for (const k of CAPS) expect(value(world, k), k).toBeUndefined();
    },
    HELM_TEST_MS,
  );

  test(
    "a world pod's port secret is a key of its own, and only the fleet pod carries it beside the freeplay world's",
    () => {
      const docs = rendered(ON);
      expect(secretKey(worldserver(docs), "AC_WRATH_BENCH_SECRET")).toBe("WRATHBENCH_MODULE_SECRET");
      expect(secretKey(worldPod(docs), "AC_WRATH_BENCH_SECRET")).toBe("WRATHBENCH_WORLDS_MODULE_SECRET");
      const fleet = containerOf(docs, "Deployment", "wrathbench-fleet", "fleet");
      expect(secretKey(fleet, "WRATHBENCH_WORLDS_MODULE_SECRET")).toBe("WRATHBENCH_WORLDS_MODULE_SECRET");
      expect(secretKey(fleet, "WRATHBENCH_MODULE_SECRET")).toBe("WRATHBENCH_MODULE_SECRET");
      // A key not yet in the Secret must not wedge the fleet; a world pod without it never starts.
      expect(fleet.env!.find((e) => e.name === "WRATHBENCH_WORLDS_MODULE_SECRET")!.valueFrom!.secretKeyRef!.optional).toBe(true);
      expect(worldPod(docs).env!.find((e) => e.name === "AC_WRATH_BENCH_SECRET")!.valueFrom!.secretKeyRef!.optional).toBeUndefined();
      const carriers = everyContainer(docs)
        .filter(([, c]) => c.env?.some((e) => e.valueFrom?.secretKeyRef?.key === "WRATHBENCH_WORLDS_MODULE_SECRET"))
        .map(([where]) => where);
      expect(carriers).toEqual(["Deployment/wrathbench-fleet/fleet"]);
      const runPod = find(docs, "ConfigMap", "wrathbench-run-pod-template").data!["pod.json"]!;
      expect(runPod).not.toContain("WRATHBENCH_WORLDS_MODULE_SECRET");
      // The key is the deployment's to name, and never the freeplay world's.
      const named = rendered([...ON, "--set", "hosted.worldsSecretKey=EVAL_WORLDS_SECRET"]);
      expect(secretKey(worldPod(named), "AC_WRATH_BENCH_SECRET")).toBe("EVAL_WORLDS_SECRET");
      const same = render([...ON, "--set", "hosted.worldsSecretKey=WRATHBENCH_MODULE_SECRET"]);
      expect(same.code).not.toBe(0);
      expect(same.stderr).toContain("hosted.worldsSecretKey must name a key of its own");
    },
    HELM_TEST_MS,
  );

  test(
    "the tenant pool is on the freeplay world's allowlist after every other and in the bootstrap Job, and in no config-reading pod",
    () => {
      const docs = rendered([...ON, "--set", "hosted.tenants.size=3", "--set", "worldserver.accounts={RUNNER,SMOKE}", "--set", "worldserver.pool.size=2"]);
      expect(value(worldserver(docs), "AC_WRATH_BENCH_ACCOUNTS")).toBe(["RUNNER", "SMOKE", "POOL01", "POOL02", ...tenantAccountNames(3)].join(","));
      expect(value(containerOf(docs, "Job", "wrathbench-bootstrap", "bootstrap"), "WRATHBENCH_TENANT_POOL_SIZE")).toBe("3");
      for (const [where, c] of everyContainer(docs)) {
        if (where === "Job/wrathbench-bootstrap/bootstrap") continue;
        expect(c.env?.some((e) => e.name === "WRATHBENCH_TENANT_POOL_SIZE" || /TENANT\d\d/.test(e.value ?? "")), where).toBe(where === "Deployment/wrathbench-worldserver/worldserver");
      }
      expect(find(docs, "ConfigMap", "wrathbench-run-pod-template").data!["pod.json"]).not.toMatch(/TENANT/);
      // A world pod's allowlist is the launcher's, never the tenants'.
      expect(JSON.stringify(worldPod(docs))).not.toMatch(/TENANT/);
      expect(find(docs, "ConfigMap", "wrathbench-hosted").data!["tenant-accounts"]).toBe(tenantAccountNames(3).join(","));
    },
    HELM_TEST_MS,
  );

  test(
    "the reserved list is the freeplay world's allowlist without the tenants, the party's accounts with staging on",
    () => {
      for (const extra of [[], ["--set", "staging.enabled=true"]]) {
        const docs = rendered([...ON, ...extra]);
        const allow = value(worldserver(docs), "AC_WRATH_BENCH_ACCOUNTS")!.split(",");
        const reserved = find(docs, "ConfigMap", "wrathbench-hosted").data!["reserved-accounts"]!.split(",");
        expect(reserved).toEqual(allow.filter((a) => !isTenantAccountName(a)));
        expect(reserved.filter(isTenantAccountName)).toEqual([]);
        expect(allow.filter(isTenantAccountName)).toEqual(tenantAccountNames(20));
        expect(reserved).toEqual(expect.arrayContaining(["RUNNER", "PROBE", "SMOKE", "SMOKE2", "POOL01", "POOL08"]));
        if (extra.length > 0) expect(reserved).toEqual(expect.arrayContaining(["PARTY1", "PARTY5"]));
      }
    },
    HELM_TEST_MS,
  );

  test(
    "the reserved list covers every account the repo's fleet config and smoke suite lease on the freeplay world",
    async () => {
      const reserved = new Set(find(rendered(ON), "ConfigMap", "wrathbench-hosted").data!["reserved-accounts"]!.split(","));
      const used = new Set<string>(SUITE_MEMBERS.flatMap(accountsOf));
      const walk = (v: unknown, key = ""): void => {
        if (Array.isArray(v)) for (const x of v) walk(x, key);
        else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
        else if (typeof v === "string" && ["account", "accounts", "pool"].includes(key)) used.add(v.toUpperCase());
      };
      walk(await Bun.file(join(import.meta.dir, "fleet.example.json")).json());
      expect(used.size).toBeGreaterThan(1);
      expect([...used].filter((a) => !reserved.has(a))).toEqual([]);
    },
    HELM_TEST_MS,
  );

  test(
    "refused: evals on the freeplay world, a tenant's name among the operator's, a pool past 99",
    () => {
      const noWorlds = render(["--set", "hosted.enabled=true"]);
      expect(noWorlds.code).not.toBe(0);
      expect(noWorlds.stderr).toContain("hosted.enabled needs a world per eval");
      // No evals group: nothing scored plays anywhere, so no world per eval is needed.
      expect(render(["--set", "hosted.enabled=true", "--set", "groups.evals.enabled=false"]).code).toBe(0);
      for (const extra of [["--set", "worldserver.accounts={RUNNER,tenant05}"], ["--set", "staging.enabled=true", "--set", "staging.accounts={PARTY1,TENANT01}"]]) {
        const r = render(extra);
        expect(r.code, extra.join(" ")).not.toBe(0);
        expect(r.stderr).toContain("is a hosted tenant account");
      }
      const big = render([...ON, "--set", "hosted.tenants.size=100"]);
      expect(big.code).not.toBe(0);
      expect(big.stderr).toContain("hosted.tenants.size must be from 0 to 99");
    },
    HELM_TEST_MS,
  );
});
