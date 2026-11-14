/**
 * The chart's `worlds` block (a world per eval), rendered with helm when it is
 * on PATH. Off by default, it renders nothing of its own. On, it renders the
 * `world.json` pod template beside the run-pod template, the headless `worlds`
 * Service its pods are named under, the world pods' ingress policy and the
 * `worlds` subPath for the fleet and log retention. What is pinned: the
 * template carries no characters schema, realm id or allowlist of the shared
 * world's (the launcher stamps a world's own, and must refuse a pod without
 * them, since an absent one falls back to the shared conf's realm 1 and
 * RUNNER); its worldserver container is the shared one's apart from those;
 * its confs are read-only and its Errors.log its own; and every container
 * states what the namespace quota counts.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];
const ON = ["--set", "worlds.enabled=true"];
const KUBE_API = ["--set", "networkPolicy.enabled=true", "--set", "networkPolicy.kubeApi[0].cidr=10.43.0.1/32", "--set", "networkPolicy.kubeApi[0].port=443"];

type Env = { name: string; value?: string; valueFrom?: { fieldRef?: { fieldPath: string }; secretKeyRef?: { name: string; key: string } } };
type Mount = { name: string; mountPath: string; subPath?: string; readOnly?: boolean };
type Resources = { requests?: Record<string, string>; limits?: Record<string, string> };
type Container = { name: string; image: string; env?: Env[]; volumeMounts?: Mount[]; resources?: Resources; ports?: { name: string; containerPort: number }[] };
type PodSpec = {
  restartPolicy?: string;
  automountServiceAccountToken?: boolean;
  subdomain?: string;
  hostname?: string;
  imagePullSecrets?: { name: string }[];
  initContainers?: Container[];
  containers: Container[];
  volumes?: { name: string; emptyDir?: { sizeLimit?: string }; persistentVolumeClaim?: { claimName: string } }[];
};
type Pod = { kind: string; metadata: { generateName?: string; labels: Record<string, string> }; spec: PodSpec };
type Peer = { podSelector?: { matchLabels?: Record<string, string> } };
type Doc = {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  spec?: {
    clusterIP?: string;
    publishNotReadyAddresses?: boolean;
    selector?: Record<string, string>;
    ports?: { name: string; port: number }[];
    podSelector?: { matchLabels: Record<string, string> };
    policyTypes?: string[];
    ingress?: { from?: Peer[]; ports?: { port: number }[] }[];
    egress?: { to?: Peer[]; ports?: { port: number }[] }[];
    template?: { spec?: PodSpec };
    jobTemplate?: { spec: { template: { spec: PodSpec } } };
  };
} | null;

function render(extra: string[]): Doc[] {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc);
}

const find = (docs: Doc[], kind: string, name: string): NonNullable<Doc> | undefined => docs.find((x) => x?.kind === kind && x.metadata?.name === name) ?? undefined;
const templateMap = (docs: Doc[]) => find(docs, "ConfigMap", "wrathbench-run-pod-template")!.data!;
const worldPod = (docs: Doc[]): Pod => JSON.parse(templateMap(docs)["world.json"]!) as Pod;
const sharedPod = (docs: Doc[]): PodSpec => find(docs, "Deployment", "wrathbench-worldserver")!.spec!.template!.spec!;
const container = (spec: PodSpec, name: string): Container => [...(spec.initContainers ?? []), ...spec.containers].find((c) => c.name === name)!;
const envOf = (c: Container) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));
const mountAt = (c: Container, path: string) => c.volumeMounts?.find((m) => m.mountPath === path);
const fleet = (docs: Doc[]) => find(docs, "Deployment", "wrathbench-fleet")!.spec!.template!.spec!.containers[0]!;
const retention = (docs: Doc[]) => find(docs, "CronJob", "wrathbench-log-retention")!.spec!.jobTemplate!.spec.template.spec.containers[0]!;
const labels = (component: string) => ({ "app.kubernetes.io/instance": "wrathbench", "app.kubernetes.io/component": component });

/** Any object or selector of a world, as JSON. */
const WORLD_LABEL = '"app.kubernetes.io/component":"world"';
/** A world's own identity, which the launcher stamps; the shared world's container has all three. */
const IDENTITY = ["AC_CHARACTER_DATABASE_INFO", "AC_REALM_ID", "AC_WRATH_BENCH_ACCOUNTS"];

describe.skipIf(helm === null)("the chart's worlds block", () => {
  test("off by default: no template, Service, policy, mount or setting of its own", () => {
    const docs = render([]);
    expect(templateMap(docs)["world.json"]).toBeUndefined();
    expect(JSON.parse(templateMap(docs)["launcher.json"]!)).not.toHaveProperty("maxWorlds");
    expect(find(docs, "Service", "worlds")).toBeUndefined();
    expect(find(docs, "NetworkPolicy", "wrathbench-world")).toBeUndefined();
    expect(fleet(docs).volumeMounts!.some((m) => m.subPath === "worlds")).toBe(false);
    // Parsed objects, so the comments that describe the block do not count.
    expect(JSON.stringify(docs)).not.toContain(WORLD_LABEL);
    expect(envOf(retention(docs))["WRATHBENCH_WORLDS_DIR"]).toBeUndefined();
    // A cap with the block off is no setting.
    expect(JSON.parse(templateMap(render(["--set", "worlds.max=2"]))["launcher.json"]!)).not.toHaveProperty("maxWorlds");
  }, HELM_TEST_MS);

  test("on: a bare, never-restarted pod named under the headless worlds Service, which publishes it before it is ready", () => {
    const docs = render([...ON, "--set", "worlds.max=3", "--set", "imagePullSecrets={harbor-pull}"]);
    const pod = worldPod(docs);
    expect(pod.kind).toBe("Pod");
    expect(pod.metadata.generateName).toBe("wrathbench-world-");
    expect(pod.metadata.labels).toMatchObject(labels("world"));
    expect(pod.spec.restartPolicy).toBe("Never");
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.hostname).toBeUndefined();
    expect(pod.spec.imagePullSecrets).toEqual([{ name: "harbor-pull" }]);
    const svc = find(docs, "Service", "worlds")!;
    expect(pod.spec.subdomain).toBe(svc.metadata!.name!);
    expect(svc.spec!.clusterIP).toBe("None");
    expect(svc.spec!.publishNotReadyAddresses).toBe(true);
    expect(svc.spec!.selector).toEqual(labels("world"));
    expect(svc.spec!.ports!.map((p) => p.port)).toEqual([8086]);
    expect(JSON.parse(templateMap(docs)["launcher.json"]!).maxWorlds).toBe(3);
    expect(pod.spec.initContainers!.map((c) => c.name)).toEqual(["wait-for-db", "db-import"]);
    expect(container(pod.spec, "worldserver").image).toBe(container(sharedPod(docs), "worldserver").image);
    expect(container(pod.spec, "db-import").image).toBe("harbor.example/wrathbench/wrathbench-db-import:harness-0.5-1-gabcdef0");
  }, HELM_TEST_MS);

  test("the template carries none of the shared world's identity: no characters schema, realm id or allowlist in any container", () => {
    for (const extra of [ON, [...ON, "--set", "staging.enabled=true"]]) {
      const docs = render(extra);
      const pod = worldPod(docs);
      for (const c of [...pod.spec.initContainers!, ...pod.spec.containers]) {
        for (const name of IDENTITY) expect([c.name, envOf(c)[name]]).toEqual([c.name, undefined]);
      }
      expect(templateMap(docs)["world.json"]).not.toContain("acore_characters");
      // The shared world keeps all three.
      const shared = envOf(container(sharedPod(docs), "worldserver"));
      for (const name of IDENTITY) expect(shared[name]).toBeDefined();
    }
  }, HELM_TEST_MS);

  test("its worldserver is the shared world's container but for that identity, staging or not", () => {
    for (const staging of [false, true]) {
      const docs = render([...ON, "--set", `staging.enabled=${staging}`]);
      const world = container(worldPod(docs).spec, "worldserver");
      const shared = container(sharedPod(docs), "worldserver");
      // The character archive's pdump paths go with its mount, which a world has not.
      const sharedOnly = [...IDENTITY, "AC_PLAYER_DUMP_DISALLOW_PATHS"];
      expect(world.env).toEqual(shared.env!.filter((e) => !sharedOnly.includes(e.name)));
      expect(world.ports).toEqual(shared.ports);
      const soap = envOf(world)["AC_SOAP_IP"];
      expect(soap?.valueFrom?.fieldRef?.fieldPath ?? "off").toBe(staging ? "status.podIP" : "off");
    }
  }, HELM_TEST_MS);

  test("the db-import init makes the characters schema only, without asking", () => {
    const env = envOf(container(worldPod(render(ON)).spec, "db-import"));
    expect(env["AC_UPDATES_ENABLE_DATABASES"]?.value).toBe("2");
    expect(env["AC_DISABLE_INTERACTIVE"]?.value).toBe("1");
    expect(env["AC_LOGIN_DATABASE_INFO"]?.value).toContain(";acore_auth");
    expect(env["AC_WORLD_DATABASE_INFO"]?.value).toContain(";acore_world");
  }, HELM_TEST_MS);

  test("confs read-only, Errors.log its own, the audit dir the shared one on the PVC, and no character-archive mount", () => {
    const pod = worldPod(render([...ON, "--set", "staging.enabled=true"]));
    const ws = container(pod.spec, "worldserver");
    const di = container(pod.spec, "db-import");
    for (const c of [ws, di]) expect(mountAt(c, "/azerothcore/env/dist/etc")).toEqual({ name: "data", mountPath: "/azerothcore/env/dist/etc", subPath: "etc", readOnly: true });
    expect(mountAt(ws, "/azerothcore/env/dist/data")).toMatchObject({ subPath: "client", readOnly: true });
    expect(envOf(ws)["AC_LOGS_DIR"]?.value).toBe("/azerothcore/env/dist/logs");
    expect(mountAt(ws, "/azerothcore/env/dist/logs")).toEqual({ name: "logs", mountPath: "/azerothcore/env/dist/logs" });
    const audit = envOf(ws)["AC_WRATH_BENCH_AUDIT_DIR"]!.value!;
    expect(mountAt(ws, audit)).toEqual({ name: "data", mountPath: audit, subPath: "logs/wrathbench" });
    expect(ws.volumeMounts!.some((m) => m.subPath === "characters")).toBe(false);
    expect(pod.spec.volumes!.find((v) => v.name === "logs")?.emptyDir?.sizeLimit).toBe("1Gi");
    expect(pod.spec.volumes!.find((v) => v.name === "data")?.persistentVolumeClaim?.claimName).toBe("wrathbench-data");
  }, HELM_TEST_MS);

  test("every container states what the namespace quota counts, and the world's own size is the worlds block's", () => {
    const pod = worldPod(render([...ON, "--set", "worlds.resources.limits.memory=5Gi"]));
    for (const c of [...pod.spec.initContainers!, ...pod.spec.containers]) {
      expect([c.name, Object.keys(c.resources?.requests ?? {}).sort()]).toEqual([c.name, ["cpu", "ephemeral-storage", "memory"]]);
      expect([c.name, typeof c.resources?.limits?.["memory"]]).toEqual([c.name, "string"]);
    }
    expect(container(pod.spec, "worldserver").resources).toEqual({ requests: { cpu: "250m", memory: "1536Mi", "ephemeral-storage": "256Mi" }, limits: { memory: "5Gi" } });
    // The init's request is the pod's while it runs: below the worldserver's.
    expect(container(pod.spec, "db-import").resources!.requests!["cpu"]).toBe("100m");
  }, HELM_TEST_MS);

  test("the fleet keeps worlds' records, and log retention prunes their server logs, on the worlds subPath", () => {
    const docs = render(ON);
    expect(fleet(docs).volumeMounts).toContainEqual({ name: "data", mountPath: "/wrathbench/data/worlds", subPath: "worlds" });
    const job = retention(docs);
    const dir = envOf(job)["WRATHBENCH_WORLDS_DIR"]!.value!;
    expect(mountAt(job, dir)).toEqual({ name: "data", mountPath: dir, subPath: "worlds" });
  }, HELM_TEST_MS);

  test("worlds are a scored-attempt thing: with the runner or evals group off, the block renders nothing", () => {
    for (const group of ["runner", "evals"]) {
      const docs = render([...ON, "--set", `groups.${group}.enabled=false`]);
      expect(find(docs, "Service", "worlds")).toBeUndefined();
      expect(find(docs, "NetworkPolicy", "wrathbench-world")).toBeUndefined();
      expect(envOf(retention(docs))["WRATHBENCH_WORLDS_DIR"]).toBeUndefined();
    }
  }, HELM_TEST_MS);

  test("the world policy is ingress only: the module port from the fleet, run and runner pods, SOAP from the fleet and runner with staging", () => {
    const ingress = (docs: Doc[]) => find(docs, "NetworkPolicy", "wrathbench-world")!.spec!;
    const off = ingress(render(ON));
    expect(off.podSelector!.matchLabels).toEqual(labels("world"));
    expect(off.policyTypes).toEqual(["Ingress"]);
    const from = (rule: { from?: Peer[] }) => (rule.from ?? []).map((p) => p.podSelector?.matchLabels?.["app.kubernetes.io/component"]);
    expect(off.ingress!.map((r) => [r.ports!.map((p) => p.port), r.from === undefined ? "any" : from(r)])).toEqual([
      [[8085], "any"],
      [[8086], ["fleet", "run", "runner"]],
    ]);
    const on = ingress(render([...ON, "--set", "staging.enabled=true"]));
    expect(on.ingress!.map((r) => [r.ports!.map((p) => p.port), r.from === undefined ? "any" : from(r)])).toEqual([
      [[8085], "any"],
      [[8086], ["fleet", "run", "runner"]],
      [[7878], ["fleet", "runner"]],
    ]);
  }, HELM_TEST_MS);

  test("with the network switch on, the fleet and run pods reach the worlds' module port, and only the fleet their SOAP", () => {
    const docs = render([...ON, ...KUBE_API, "--set", "staging.enabled=true"]);
    const reaches = (policy: string, component: string, port: number) =>
      find(docs, "NetworkPolicy", `wrathbench-${policy}`)!.spec!.egress!.some(
        (r) => r.ports!.some((p) => p.port === port) && (r.to ?? []).some((p) => p.podSelector?.matchLabels?.["app.kubernetes.io/component"] === component),
      );
    expect(reaches("fleet", "world", 8086)).toBe(true);
    expect(reaches("run", "world", 8086)).toBe(true);
    expect(reaches("fleet", "world", 7878)).toBe(true);
    expect(reaches("run", "world", 7878)).toBe(false);
    expect(reaches("run", "worldserver", 7878)).toBe(false);
    // And without worlds, no peer of that kind at all.
    const plain = render([...KUBE_API, "--set", "staging.enabled=true"]);
    expect(JSON.stringify(plain.filter((d) => d?.kind === "NetworkPolicy"))).not.toContain(WORLD_LABEL);
  }, HELM_TEST_MS);
});
