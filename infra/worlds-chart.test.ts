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
 * and the network policies keep the worlds' SOAP from the run pods.
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
