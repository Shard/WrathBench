/**
 * The chart's hosted gateway (`hosted.gateway`), rendered with helm when it is
 * on PATH. Off, it renders nothing of its own. On, what is pinned:
 *
 *  - everything is in the hosted namespace, which is the release's own never;
 *  - the port secret is the gateway's alone: no other pod there carries it,
 *    and the worker template carries no secret, no ServiceAccount token and
 *    no volume but the credential's directory and its tmp;
 *  - the gateway's Role is pods in its own namespace;
 *  - the namespace is default-deny, a worker reaches DNS and the freeplay
 *    world's module port and nothing else and takes the gateway alone, and
 *    the gateway takes MCP from the ingress controller alone;
 *  - the reserved accounts the gateway starts with are the `hosted` ConfigMap's;
 *  - the worker template is one the pod provider accepts;
 *  - it refuses no API address, an Ingress without TLS, and the release's
 *    own namespace.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Pod } from "./k8s-client";
import { volumeSubPath, workerPod } from "./hosted/pod-workers";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];
const HOSTED = ["--set", "hosted.enabled=true", "--set", "worlds.enabled=true"];
const API = ["--set", "networkPolicy.kubeApi[0].cidr=10.96.0.1/32", "--set", "networkPolicy.kubeApi[0].port=443"];
const ON = [...HOSTED, ...API, "--set", "hosted.gateway.enabled=true"];
const NS = "wrathbench-hosted";

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } };
type Container = { name: string; env?: Env[]; command?: string[]; image?: string; volumeMounts?: { name: string; mountPath: string }[] };
type Rule = { from?: Record<string, unknown>[]; to?: Record<string, unknown>[]; ports?: { protocol: string; port: number }[] };
type Doc = {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  rules?: { apiGroups: string[]; resources: string[]; verbs: string[] }[];
  spec?: {
    template?: { spec?: { containers: Container[]; serviceAccountName?: string } };
    podSelector?: { matchLabels?: Record<string, string> };
    policyTypes?: string[];
    ingress?: Rule[];
    egress?: Rule[];
    tls?: unknown[];
  };
} | null;

function render(extra: string[]): { code: number; stderr: string; docs: NonNullable<Doc>[] } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  const docs = r.exitCode === 0 ? r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc).filter((d): d is NonNullable<Doc> => d !== null && d !== undefined) : [];
  return { code: r.exitCode ?? -1, stderr: r.stderr.toString(), docs };
}
function rendered(extra: string[]): NonNullable<Doc>[] {
  const r = render(extra);
  expect(r.code, r.stderr).toBe(0);
  return r.docs;
}
const find = (docs: NonNullable<Doc>[], kind: string, name: string): NonNullable<Doc> => {
  const d = docs.find((x) => x.kind === kind && x.metadata?.name === name);
  expect(d, `${kind}/${name} renders`).toBeDefined();
  return d!;
};
const workerTemplate = (docs: NonNullable<Doc>[]): Pod => JSON.parse(find(docs, "ConfigMap", "wrathbench-hosted-worker").data!["worker.json"]!) as Pod;
const gateway = (docs: NonNullable<Doc>[]): Container => find(docs, "Deployment", "wrathbench-gateway").spec!.template!.spec!.containers[0]!;

describe.skipIf(helm === null)("the hosted gateway in the chart", () => {
  test("off renders nothing of its own, with hosted mode's accounts on or off", () => {
    for (const extra of [[], HOSTED, [...HOSTED, ...API]]) {
      const docs = rendered(extra);
      expect(docs.filter((d) => d.metadata?.namespace === NS || d.kind === "Namespace")).toEqual([]);
      expect(docs.some((d) => d.metadata?.name === "wrathbench-gateway")).toBe(false);
    }
    // Without hosted mode's accounts the gateway switch alone renders nothing either.
    expect(rendered([...API, "--set", "hosted.gateway.enabled=true"]).some((d) => d.metadata?.name === "wrathbench-gateway")).toBe(false);
  }, HELM_TEST_MS);

  test("on, everything is in the hosted namespace, under its Pod Security level", () => {
    const docs = rendered(ON);
    const mine = docs.filter((d) => d.metadata?.namespace === NS);
    expect(mine.map((d) => d.kind).sort()).toEqual(["ConfigMap", "Deployment", "NetworkPolicy", "NetworkPolicy", "NetworkPolicy", "PersistentVolumeClaim", "Role", "RoleBinding", "Service", "ServiceAccount"]);
    expect(find(docs, "Namespace", NS).metadata!.labels!["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(rendered([...ON, "--set", "hosted.gateway.createNamespace=false"]).some((d) => d.kind === "Namespace")).toBe(false);
  }, HELM_TEST_MS);

  test("the port secret is the gateway's alone, and the worker carries nothing it was not given", () => {
    const docs = rendered(ON);
    const g = gateway(docs);
    expect(g.env?.find((e) => e.name === "WRATHBENCH_MODULE_SECRET")?.valueFrom?.secretKeyRef).toEqual({ name: "wrathbench-hosted", key: "WRATHBENCH_MODULE_SECRET" });
    expect(g.env?.find((e) => e.name === "WRATHBENCH_MODULE_URL")?.value).toBe("http://worldserver.wrathbench.svc:8086");
    expect(g.command).toContain("--no-env-file");
    const w = workerTemplate(docs);
    expect(w.metadata.namespace).toBe(NS);
    expect(w.spec["automountServiceAccountToken"]).toBe(false);
    const c = w.spec.containers[0]!;
    expect(c.env ?? []).toEqual([]);
    expect(c.command).toContain("--no-env-file");
    expect(c.command).toContain("infra/hosted/worker.ts");
    expect((c.volumeMounts ?? []).map((m) => m.name).sort()).toEqual(["tenant", "tmp"]);
    expect(w.spec.volumes?.map((v) => v.name).sort()).toEqual(["tenant", "tmp"]);
    // And it is a template the provider accepts: the secret and the directory are what it adds.
    const pod = workerPod(w, "pat-1", "s".repeat(64), "state/tenants/pat-1");
    expect(pod.spec.containers[0]!.volumeMounts?.find((m) => m.name === "tenant")?.subPath).toBe("state/tenants/pat-1");
    // No kubelet probe: the namespace's default-deny would drop it; the gateway tries the worker's port itself.
    expect(JSON.stringify(w)).not.toContain("Probe");
    expect(JSON.stringify(find(docs, "Deployment", "wrathbench-gateway"))).not.toContain("Probe");
  }, HELM_TEST_MS);

  test("the provider's volume root is where the gateway mounts the volume, and the gateway's state is under it", () => {
    const docs = rendered(ON);
    const g = gateway(docs);
    const root = g.env?.find((e) => e.name === "WRATHBENCH_HOSTED_ROOT")?.value;
    expect(g.volumeMounts?.find((m) => m.name === "hosted")?.mountPath).toBe(root!);
    const state = g.command![g.command!.indexOf("--state") + 1]!;
    // A credential's directory as the gateway prepares it maps to a subPath of the same volume.
    expect(volumeSubPath(root!, `${state}/tenants/pat-1`)).toBe("state/tenants/pat-1");
    expect(g.command![g.command!.indexOf("--grants") + 1]!.startsWith(`${root}/`)).toBe(true);
  }, HELM_TEST_MS);

  test("the gateway and its workers run on the chart's node unless told otherwise", () => {
    const sel = (docs: NonNullable<Doc>[]) => ({
      gateway: (find(docs, "Deployment", "wrathbench-gateway").spec!.template!.spec as unknown as { nodeSelector?: unknown }).nodeSelector,
      worker: workerTemplate(docs).spec["nodeSelector"],
    });
    expect(sel(rendered([...ON, "--set", "nodeSelector.disk=nvme"]))).toEqual({ gateway: { disk: "nvme" }, worker: { disk: "nvme" } });
    expect(sel(rendered([...ON, "--set", "nodeSelector.disk=nvme", "--set", "hosted.gateway.nodeSelector.zone=b"]))).toEqual({ gateway: { zone: "b" }, worker: { zone: "b" } });
  }, HELM_TEST_MS);

  test("the module audit's retention keeps a hosted session's files as long as the person audit, with hosted mode on only", () => {
    type CronJob = { spec: { jobTemplate: { spec: { template: { spec: { containers: { env: Env[] }[] } } } } } };
    const env = (docs: NonNullable<Doc>[]) => (find(docs, "CronJob", "wrathbench-log-retention") as unknown as CronJob).spec.jobTemplate.spec.template.spec.containers[0]!.env;
    expect(env(rendered(HOSTED)).find((e) => e.name === "WRATHBENCH_LOG_RETENTION_HOSTED_DAYS")?.value).toBe("30");
    expect(env(rendered([])).some((e) => e.name === "WRATHBENCH_LOG_RETENTION_HOSTED_DAYS")).toBe(false);
  }, HELM_TEST_MS);

  test("the gateway's Role is pods in its own namespace", () => {
    const docs = rendered(ON);
    const role = find(docs, "Role", "wrathbench-gateway");
    expect(role.metadata!.namespace).toBe(NS);
    expect(role.rules).toEqual([{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch", "create", "delete"] }]);
    expect(docs.some((d) => d.kind === "ClusterRole" || d.kind === "ClusterRoleBinding")).toBe(false);
  }, HELM_TEST_MS);

  test("the namespace is default-deny; a worker takes the gateway and reaches DNS and the module port only", () => {
    const docs = rendered(ON);
    const deny = find(docs, "NetworkPolicy", "wrathbench-hosted-default-deny");
    expect(deny.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
    const worker = find(docs, "NetworkPolicy", "wrathbench-hosted-worker");
    expect(worker.spec!.ingress).toHaveLength(1);
    expect(JSON.stringify(worker.spec!.ingress![0]!.from)).toContain('"app.kubernetes.io/component":"gateway"');
    const egressPorts = worker.spec!.egress!.flatMap((r) => (r.ports ?? []).map((p) => p.port)).sort();
    expect(egressPorts).toEqual([53, 53, 8086]);
    expect(JSON.stringify(worker.spec!.egress)).not.toContain("ipBlock");
    const gw = find(docs, "NetworkPolicy", "wrathbench-gateway");
    // No Ingress object, no source admitted.
    expect(gw.spec!.ingress).toEqual([]);
    expect(gw.spec!.egress!.flatMap((r) => (r.ports ?? []).map((p) => p.port)).sort((a, b) => a - b)).toEqual([53, 53, 443, 8086, 8097]);
  }, HELM_TEST_MS);

  test("with an Ingress, TLS is required and MCP is admitted from the controller alone", () => {
    expect(render([...ON, "--set", "hosted.gateway.ingress.enabled=true", "--set", "hosted.gateway.ingress.host=mcp.example"]).stderr).toContain("tlsSecretName");
    const docs = rendered([...ON, "--set", "hosted.gateway.ingress.enabled=true", "--set", "hosted.gateway.ingress.host=mcp.example", "--set", "hosted.gateway.ingress.tlsSecretName=mcp-tls"]);
    expect(find(docs, "Ingress", "wrathbench-gateway").spec!.tls).toEqual([{ hosts: ["mcp.example"], secretName: "mcp-tls" }]);
    const gw = find(docs, "NetworkPolicy", "wrathbench-gateway");
    expect(JSON.stringify(gw.spec!.ingress)).toContain('"kubernetes.io/metadata.name":"ingress-nginx"');
    expect(gateway(docs).command).toContain("--trust-forwarded-for");
  }, HELM_TEST_MS);

  test("starts with the reserved accounts the hosted ConfigMap names", () => {
    const docs = rendered(ON);
    const reserved = find(docs, "ConfigMap", "wrathbench-hosted").data!["reserved-accounts"];
    expect(reserved!.length).toBeGreaterThan(0);
    expect(gateway(docs).env?.find((e) => e.name === "WRATHBENCH_HOSTED_RESERVED")?.value).toBe(reserved!);
  }, HELM_TEST_MS);

  test("refuses no API address, and the release's own namespace", () => {
    expect(render([...HOSTED, "--set", "hosted.gateway.enabled=true"]).stderr).toContain("networkPolicy.kubeApi");
    expect(render([...ON, "--set", "hosted.gateway.namespace=wrathbench"]).stderr).toContain("namespace of its own");
  }, HELM_TEST_MS);
});
