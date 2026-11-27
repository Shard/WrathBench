/**
 * The chart as a pure viewer beside someone else's wrath-mcp and AzerothCore
 * (values-viewer-only.yaml; values.yaml `game`, `viewer.moduleUrl`,
 * `viewer.sessionStore`). The example renders the viewer and the chart's own
 * data volume and nothing else, references no Secret, mounts the session store
 * read-only and never runs as root; what it cannot serve is refused
 * at render. With `game` on (the default) the viewer is wired as it always was.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const example = join(chart, "values-viewer-only.yaml");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } } };
type Mount = { name: string; mountPath: string; readOnly?: boolean; subPath?: string };
type Volume = { name: string; persistentVolumeClaim?: { claimName: string; readOnly?: boolean }; hostPath?: { path: string; type?: string } };
type PodSpec = {
  securityContext?: Record<string, unknown>;
  containers?: { image?: string; env?: Env[]; volumeMounts?: Mount[] }[];
  volumes?: Volume[];
};
type Doc = { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: PodSpec } } } | null;

function run(...extra: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, "--namespace", "wrathbench", ...extra], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function render(...extra: string[]): { docs: Doc[]; out: string } {
  const r = run(...extra);
  expect(r.code, r.err).toBe(0);
  return { docs: r.out.split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc).filter((d) => d !== null), out: r.out };
}

const viewerPod = (docs: Doc[]): PodSpec => docs.find((d) => d?.kind === "Deployment" && d.metadata?.name === "wrathbench-viewer")!.spec!.template!.spec!;
const envMap = (pod: PodSpec): Map<string, Env> => new Map((pod.containers![0]!.env ?? []).map((e) => [e.name, e]));

describe.skipIf(helm === null)("the chart as a viewer only", () => {
  test("the example renders the viewer's Service, Deployment and Ingress and the data volume, and nothing else", () => {
    const { docs } = render("-f", example);
    const kinds = docs.map((d) => `${d!.kind}/${d!.metadata!.name}`).sort();
    expect(kinds).toEqual(["Deployment/wrathbench-viewer", "Ingress/wrathbench-viewer", "PersistentVolumeClaim/wrathbench-data", "Service/wrathbench-viewer"]);
  }, HELM_TEST_MS);

  test("the example references no Secret, carries no module, and is told it is the viewer group alone", () => {
    const { docs, out } = render("-f", example);
    expect(out).not.toContain("secretKeyRef");
    const env = envMap(viewerPod(docs));
    expect(env.get("WRATHBENCH_GROUPS")?.value).toBe("viewer");
    expect(env.has("WRATHBENCH_MODULE_URL")).toBe(false);
    expect(env.has("WRATHBENCH_MODULE_SECRET")).toBe(false);
    for (const n of env.keys()) expect(n.startsWith("CLICKHOUSE_"), n).toBe(false);
  }, HELM_TEST_MS);

  test("the session store is a read-only PVC at a fixed path, named to the viewer", () => {
    const pod = viewerPod(render("-f", example).docs);
    expect(envMap(pod).get("WRATHBENCH_SESSION_STORE")?.value).toBe("/wrathbench/sessions");
    const mount = pod.containers![0]!.volumeMounts!.find((m) => m.name === "sessions");
    expect(mount).toEqual({ name: "sessions", mountPath: "/wrathbench/sessions", readOnly: true });
    expect(pod.volumes!.find((v) => v.name === "sessions")).toEqual({ name: "sessions", persistentVolumeClaim: { claimName: "wrath-mcp-sessions", readOnly: true } });
  }, HELM_TEST_MS);

  test("game on (the default): the runner image, the in-chart module, its required secret, uid 1000, no session store", () => {
    const pod = viewerPod(render(...BASE).docs);
    expect(pod.containers![0]!.image).toBe("harbor.example/wrathbench/wrathbench-runner:harness-0.5-1-gabcdef0");
    const env = envMap(pod);
    expect(env.get("WRATHBENCH_MODULE_URL")?.value).toBe("http://worldserver:8086");
    expect(env.get("WRATHBENCH_MODULE_SECRET")?.valueFrom?.secretKeyRef).toEqual({ name: "wrathbench-env", key: "WRATHBENCH_MODULE_SECRET" });
    expect(env.has("WRATHBENCH_SESSION_STORE")).toBe(false);
    expect(env.has("WRATHBENCH_GROUPS")).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 });
    expect(pod.volumes!.map((v) => v.name)).toEqual(["data"]);
  }, HELM_TEST_MS);

  test("game off with the runner group's pods, staging, hosted or camera on is refused", () => {
    for (const [set, says] of [
      ["groups.runner.enabled=true", "groups.runner.enabled"],
      ["staging.enabled=true", "staging.enabled"],
      ["hosted.enabled=true", "hosted.enabled"],
      ["camera.enabled=true", "camera.enabled"],
    ] as const) {
      const r = run("-f", example, "--set", set);
      expect(r.code, set).not.toBe(0);
      expect(r.err, set).toContain(says);
    }
  }, HELM_TEST_MS);

  test("what the viewer cannot serve is refused: two store sources, a store with ClickHouse, a root uid, a module URL beside the in-chart game", () => {
    for (const [args, says] of [
      [["-f", example, "--set", "viewer.sessionStore.hostPath=/srv/s"], "not both"],
      [["-f", example, "--set", "clickhouse.enabled=true"], "collector"],
      [["-f", example, "--set", "viewer.podSecurityContext.runAsUser=0"], "non-root"],
      [[...BASE, "--set", "viewer.moduleUrl=http://module.example:8086"], "game.enabled=false"],
    ] as const) {
      const r = run(...args);
      expect(r.code, args.join(" ")).not.toBe(0);
      expect(r.err, args.join(" ")).toContain(says);
    }
  }, HELM_TEST_MS);

});
