/**
 * The chart's NetworkPolicies (templates/networkpolicy.yaml), rendered with
 * helm when it is on PATH and read the way a CNI would: a connection is
 * admitted when some egress rule's peer and port both match. What is pinned is
 * the set of destinations, not the YAML: the fleet and run pods reach the
 * module, DNS, TCP 443 off-LAN and the self-hosted model servers; only the
 * fleet reaches the API server and MySQL; neither reaches ClickHouse or the
 * viewer; and the switch defaults off, so shipping the chart changes nothing.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EPISODE_TERM_GRACE_MS } from "./episode-launcher";
import type { Pod } from "./k8s-client";
import { buildRunPod } from "./run-pod";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");

type Peer = {
  podSelector?: { matchLabels?: Record<string, string> };
  namespaceSelector?: { matchLabels?: Record<string, string> };
  ipBlock?: { cidr: string; except?: string[] };
};
type Rule = { to?: Peer[]; ports?: { protocol?: string; port?: number }[] };
type IngressRule = { from?: Peer[]; ports?: { protocol?: string; port?: number }[] };
type Policy = {
  kind: "NetworkPolicy";
  metadata: { name: string };
  spec: { podSelector: { matchLabels: Record<string, string> }; policyTypes: string[]; egress?: Rule[]; ingress?: IngressRule[] };
};
type Doc = { kind?: string; metadata?: { name?: string; labels?: Record<string, string> }; spec?: { template?: { metadata?: { labels?: Record<string, string> } } }; data?: Record<string, string> } | null;

const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];
const KUBE_API = ["--set", "networkPolicy.kubeApi[0].cidr=10.43.0.1/32", "--set", "networkPolicy.kubeApi[0].port=443", "--set", "networkPolicy.kubeApi[1].cidr=192.0.2.10/32", "--set", "networkPolicy.kubeApi[1].port=6443"];
/** `helm template` runs synchronously and can take longer than bun's default 5 s on a loaded CI runner. */
const HELM_TEST_MS = 30_000;
const ON = ["--set", "networkPolicy.enabled=true", ...KUBE_API, "--set", "localModelHosts={192.0.2.20:1234}"];

function render(extra: string[]): { code: number; stderr: string; docs: Doc[] } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  const docs = r.exitCode === 0 ? r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc) : [];
  return { code: r.exitCode ?? -1, stderr: r.stderr.toString(), docs };
}

const policies = (docs: Doc[]): Policy[] => docs.filter((d): d is Policy & NonNullable<Doc> => d?.kind === "NetworkPolicy") as unknown as Policy[];
const policy = (docs: Doc[], name: string): Policy => {
  const p = policies(docs).find((x) => x.metadata.name === `wrathbench-${name}`);
  expect(p, `NetworkPolicy wrathbench-${name} renders`).toBeDefined();
  return p!;
};

function ipv4(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}
function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/") as [string, string];
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4(ip) / size) === Math.floor(ipv4(base) / size);
}

/** A destination: a pod of this release (by component, or in another namespace), or an address. */
type Dest = { component?: string; namespace?: string; labels?: Record<string, string>; ip?: string; port: number; protocol?: "TCP" | "UDP" };

function peerMatches(peer: Peer, d: Dest): boolean {
  if (peer.ipBlock !== undefined) {
    if (d.ip === undefined) return false;
    return inCidr(d.ip, peer.ipBlock.cidr) && !(peer.ipBlock.except ?? []).some((c) => inCidr(d.ip!, c));
  }
  if (d.ip !== undefined) return false;
  const ns = peer.namespaceSelector?.matchLabels;
  if (ns !== undefined ? ns["kubernetes.io/metadata.name"] !== d.namespace : d.namespace !== undefined) return false;
  const labels = d.labels ?? { "app.kubernetes.io/instance": "wrathbench", "app.kubernetes.io/component": d.component ?? "" };
  return Object.entries(peer.podSelector?.matchLabels ?? {}).every(([k, v]) => labels[k] === v);
}

function admits(p: Policy, d: Dest): boolean {
  return (p.spec.egress ?? []).some(
    (r) =>
      (r.to === undefined || r.to.some((peer) => peerMatches(peer, d))) &&
      (r.ports === undefined || r.ports.some((x) => (x.protocol ?? "TCP") === (d.protocol ?? "TCP") && (x.port === undefined || x.port === d.port))),
  );
}

/**
 * Whether an ingress policy admits a connection from `src` to `port`: some
 * rule's source and port both match, a rule with no `from` matching every
 * source. A port no rule lists is dropped, as a CNI drops it.
 */
function admitsIn(p: Policy, src: Omit<Dest, "port">, port: number): boolean {
  return (p.spec.ingress ?? []).some(
    (r) =>
      (r.from === undefined || r.from.some((peer) => peerMatches(peer, { ...src, port }))) &&
      (r.ports === undefined || r.ports.some((x) => (x.protocol ?? "TCP") === "TCP" && (x.port === undefined || x.port === port))),
  );
}

const DNS = { namespace: "kube-system", labels: { "k8s-app": "kube-dns" }, port: 53 };
const PUBLIC = "203.0.113.7";
const IN_CLUSTER_SERVICES: Dest[] = [
  { component: "clickhouse", port: 8123 },
  { component: "viewer", port: 8090 },
  { component: "worldserver", port: 8085 },
  { component: "authserver", port: 3724 },
];
/** Addresses on the pod network, the LAN and the tailnet, on the one port the internet rule opens. */
const PRIVATE_443 = ["10.42.0.5", "10.43.0.50", "172.17.0.2", "192.168.0.10", "192.168.1.50", "100.64.0.10", "169.254.169.254"];

describe.skipIf(helm === null)("the chart's NetworkPolicies", () => {
  test("are off by default: the default render and the example values render none", () => {
    const plain = render([]);
    expect(plain.code).toBe(0);
    expect(policies(plain.docs)).toEqual([]);
    const example = Bun.spawnSync([helm!, "template", "wrathbench", chart, "-f", join(chart, "values.example.yaml"), "--set", "image.tag=ci-lint"], { stdout: "pipe", stderr: "pipe" });
    expect(example.exitCode).toBe(0);
    expect(example.stdout.toString()).not.toContain("kind: NetworkPolicy");
  }, HELM_TEST_MS);

  test("select the pods they are about: each workload's pod template, and a run pod whatever image or command its arm names", () => {
    const { code, docs } = render(ON);
    expect(code).toBe(0);
    expect(policies(docs).map((p) => p.metadata.name).sort()).toEqual(["wrathbench-collector", "wrathbench-fleet", "wrathbench-publisher", "wrathbench-run", "wrathbench-viewer"]);
    for (const name of ["fleet", "viewer", "publisher", "collector"]) {
      const dep = docs.find((d) => d?.kind === "Deployment" && d.metadata?.name === `wrathbench-${name}`);
      const labels = dep!.spec!.template!.metadata!.labels!;
      for (const [k, v] of Object.entries(policy(docs, name).spec.podSelector.matchLabels)) expect([name, k, labels[k]]).toEqual([name, k, v]);
    }
    const cm = docs.find((d) => d?.kind === "ConfigMap" && d.metadata?.name === "wrathbench-run-pod-template");
    const tpl = JSON.parse(cm!.data!["pod.json"]!) as Pod;
    const pod = buildRunPod(tpl, {
      runId: "r",
      image: "ghcr.io/example/other-harness:v1",
      requestedRef: "ghcr.io/example/other-harness:v1",
      command: ["/entrypoint"],
      args: [],
      env: { driver: "openai", tokenEnv: undefined, apiKeyEnv: "OPENROUTER_KEY", stamps: {} },
      owner: undefined,
      rosterPid: 1,
      graceMs: EPISODE_TERM_GRACE_MS,
    });
    for (const [k, v] of Object.entries(policy(docs, "run").spec.podSelector.matchLabels)) expect([k, pod.metadata.labels![k]]).toEqual([k, v]);
  }, HELM_TEST_MS);

  test("give the fleet and run pods no ingress, and leave the viewer reachable through its Ingress", () => {
    const { docs } = render(ON);
    for (const name of ["fleet", "run"]) {
      const p = policy(docs, name);
      expect(p.spec.policyTypes).toEqual(["Ingress", "Egress"]);
      expect(p.spec.ingress ?? []).toEqual([]);
    }
    for (const name of ["viewer", "publisher", "collector"]) expect(policy(docs, name).spec.policyTypes).toEqual(["Egress"]);
  }, HELM_TEST_MS);

  test("let the fleet and run pods reach the module, DNS, TCP 443 off the LAN and the self-hosted model server, and nothing in the cluster but that", () => {
    const { docs } = render(ON);
    for (const name of ["fleet", "run"]) {
      const p = policy(docs, name);
      expect([name, admits(p, { component: "worldserver", port: 8086 })]).toEqual([name, true]);
      expect([name, admits(p, { ...DNS, protocol: "UDP" }), admits(p, { ...DNS, protocol: "TCP" })]).toEqual([name, true, true]);
      expect([name, admits(p, { ip: PUBLIC, port: 443 })]).toEqual([name, true]);
      expect([name, admits(p, { ip: "192.0.2.20", port: 1234 })]).toEqual([name, true]);
      // Denied: ClickHouse, the viewer, the world and auth ports, plain http,
      // another port on the model box, and any private address on 443.
      for (const d of IN_CLUSTER_SERVICES) expect([name, d.component, admits(p, d)]).toEqual([name, d.component, false]);
      expect([name, admits(p, { ip: PUBLIC, port: 80 })]).toEqual([name, false]);
      expect([name, admits(p, { ip: "192.0.2.20", port: 22 })]).toEqual([name, false]);
      for (const ip of PRIVATE_443) expect([name, ip, admits(p, { ip, port: 443 })]).toEqual([name, ip, false]);
      // A UDP socket goes nowhere but DNS.
      expect([name, admits(p, { ip: PUBLIC, port: 443, protocol: "UDP" })]).toEqual([name, false]);
    }
  }, HELM_TEST_MS);

  test("let only the fleet reach the API server and MySQL", () => {
    const { docs } = render(ON);
    const fleet = policy(docs, "fleet");
    const run = policy(docs, "run");
    for (const api of [{ ip: "10.43.0.1", port: 443 }, { ip: "192.0.2.10", port: 6443 }]) {
      expect([api.ip, admits(fleet, api), admits(run, api)]).toEqual([api.ip, true, false]);
    }
    expect(admits(fleet, { component: "db", port: 3306 })).toBe(true);
    expect(admits(run, { component: "db", port: 3306 })).toBe(false);
  }, HELM_TEST_MS);

  test("give the viewer, publisher and collector only what each one talks to", () => {
    const { docs } = render(ON);
    const viewer = policy(docs, "viewer");
    const publisher = policy(docs, "publisher");
    const collector = policy(docs, "collector");
    for (const p of [viewer, publisher, collector]) {
      expect([p.metadata.name, admits(p, { component: "clickhouse", port: 8123 }), admits(p, { ...DNS, protocol: "UDP" })]).toEqual([p.metadata.name, true, true]);
      expect([p.metadata.name, admits(p, { component: "db", port: 3306 })]).toEqual([p.metadata.name, false]);
    }
    for (const p of [viewer, publisher]) {
      expect([p.metadata.name, admits(p, { component: "worldserver", port: 8086 }), admits(p, { ip: PUBLIC, port: 443 })]).toEqual([p.metadata.name, true, true]);
      expect([p.metadata.name, admits(p, { ip: "192.0.2.20", port: 1234 })]).toEqual([p.metadata.name, false]);
    }
    expect([admits(collector, { component: "worldserver", port: 8086 }), admits(collector, { ip: PUBLIC, port: 443 })]).toEqual([false, false]);
  }, HELM_TEST_MS);

  test("party staging off renders no worldserver policy and no SOAP rule anywhere", () => {
    for (const extra of [[], ON]) {
      const { code, docs } = render(extra);
      expect(code).toBe(0);
      expect(policies(docs).some((p) => p.metadata.name === "wrathbench-worldserver")).toBe(false);
      for (const p of policies(docs)) expect([p.metadata.name, admits(p, { component: "worldserver", port: 7878 })]).toEqual([p.metadata.name, false]);
    }
  }, HELM_TEST_MS);

  test("party staging puts SOAP behind an ingress rule for the fleet and runner only, and leaves the world and module ports open to every source", () => {
    const STAGING = ["--set", "staging.enabled=true"];
    // With or without the egress policies: the worldserver's own rule is what holds alone.
    for (const extra of [STAGING, [...ON, ...STAGING]]) {
      const { code, docs } = render(extra);
      expect(code).toBe(0);
      const ws = policy(docs, "worldserver");
      expect(ws.spec.policyTypes).toEqual(["Ingress"]);
      const dep = docs.find((d) => d?.kind === "Deployment" && d.metadata?.name === "wrathbench-worldserver");
      for (const [k, v] of Object.entries(ws.spec.podSelector.matchLabels)) expect([k, dep!.spec!.template!.metadata!.labels![k]]).toEqual([k, v]);
      for (const component of ["fleet", "runner", "run", "viewer", "publisher", "collector", "authserver"]) {
        // Unchanged: 8085 and 8086 from any pod, as with no policy.
        expect([component, admitsIn(ws, { component }, 8085), admitsIn(ws, { component }, 8086)]).toEqual([component, true, true]);
        expect([component, admitsIn(ws, { component }, 7878)]).toEqual([component, component === "fleet" || component === "runner"]);
      }
      // And from outside the release: the world and module ports, never SOAP.
      for (const src of [{ ip: "10.42.0.99" }, { ip: PUBLIC }, { namespace: "other", labels: { "app.kubernetes.io/component": "fleet" } }]) {
        expect([JSON.stringify(src), admitsIn(ws, src, 8086), admitsIn(ws, src, 7878)]).toEqual([JSON.stringify(src), true, false]);
      }
      // A port nobody listed is dropped.
      expect(admitsIn(ws, { component: "fleet" }, 3306)).toBe(false);
    }
    // The egress half: the fleet may dial SOAP, a run pod and the rest may not.
    const { docs } = render([...ON, ...STAGING]);
    expect(policies(docs).map((p) => p.metadata.name).sort()).toEqual(["wrathbench-collector", "wrathbench-fleet", "wrathbench-publisher", "wrathbench-run", "wrathbench-viewer", "wrathbench-worldserver"]);
    expect(admits(policy(docs, "fleet"), { component: "worldserver", port: 7878 })).toBe(true);
    for (const name of ["run", "viewer", "publisher", "collector"]) {
      expect([name, admits(policy(docs, name), { component: "worldserver", port: 7878 })]).toEqual([name, false]);
    }
    // The fleet's other destinations are what they were.
    expect(admits(policy(docs, "fleet"), { component: "worldserver", port: 8086 })).toBe(true);
    expect(admits(policy(docs, "fleet"), { component: "worldserver", port: 8085 })).toBe(false);
  }, HELM_TEST_MS);

  test("refuse to render rather than open wider: no API address, or a model host that is not IPv4:port", () => {
    const noApi = render(["--set", "networkPolicy.enabled=true"]);
    expect(noApi.code).not.toBe(0);
    expect(noApi.stderr).toContain("networkPolicy.kubeApi");
    for (const host of ["lmbox.lan:1234", "192.0.2.20", "lmbox.lan"]) {
      const r = render(["--set", "networkPolicy.enabled=true", ...KUBE_API, "--set", `localModelHosts={${host}}`]);
      expect([host, r.code === 0]).toEqual([host, false]);
      expect(r.stderr).toContain("must be IPv4:port");
    }
    // Without the fleet there is no fleet or run policy, and no API to name.
    const noFleet = render(["--set", "networkPolicy.enabled=true", "--set", "fleet.enabled=false"]);
    expect(noFleet.code).toBe(0);
    expect(policies(noFleet.docs).map((p) => p.metadata.name).sort()).toEqual(["wrathbench-collector", "wrathbench-publisher", "wrathbench-viewer"]);
  }, HELM_TEST_MS);
});
