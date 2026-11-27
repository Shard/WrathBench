/**
 * The chart's `camera` block (templates/_camera.tpl, templates/camera.yaml),
 * rendered with helm when it is on PATH. Off by default, it renders nothing.
 * On, a camera is never a container in a world's pod: the chart renders only
 * the camera's own pod template (`camera.json`, for the fleet and the world
 * launcher to create from) and the sweep CronJob. Every worldserver makes a GM
 * invisible before it is on the map; the password is a Secret reference,
 * never a value; the client's data is mounted read-only; and the renderer
 * decides the GPU claim.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0", "--set", "worlds.enabled=true"];
const ON = ["--set", "camera.enabled=true", "--set", "camera.image=harbor.example/wrathbench/wrathbench-camera:camera-1", "--set", "camera.clientData.claimName=wrathbench-client-data"];

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } };
type Container = {
  name: string;
  image: string;
  command?: string[];
  env?: Env[];
  volumeMounts?: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[];
  resources?: { requests?: Record<string, string | number>; limits?: Record<string, string | number> };
};
type PodSpec = { containers: Container[]; volumes?: { name: string; persistentVolumeClaim?: { claimName: string; readOnly?: boolean } }[] };
type Doc = { kind?: string; metadata?: { name?: string; annotations?: Record<string, string> }; data?: Record<string, string>; spec?: { template?: { metadata?: { annotations?: Record<string, string> }; spec?: PodSpec } } } | null;
type Pod = { metadata: { generateName?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; spec: PodSpec & { restartPolicy?: string; terminationGracePeriodSeconds?: number } };

function render(extra: string[], ok = true): { docs: Doc[]; stderr: string } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  if (ok) expect(r.exitCode, r.stderr.toString()).toBe(0);
  return { docs: r.exitCode === 0 ? r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc) : [], stderr: r.stderr.toString() };
}

const find = (docs: Doc[], kind: string, name: string) => docs.find((x) => x?.kind === kind && x.metadata?.name === name) ?? null;
const shared = (docs: Doc[]) => find(docs, "Deployment", "wrathbench-worldserver")!.spec!.template!;
const worldPod = (docs: Doc[]): Pod => JSON.parse(find(docs, "ConfigMap", "wrathbench-run-pod-template")!.data!["world.json"]!) as Pod;
const cameraPod = (docs: Doc[]): Pod | undefined => {
  const t = find(docs, "ConfigMap", "wrathbench-run-pod-template")!.data!["camera.json"];
  return t === undefined ? undefined : (JSON.parse(t) as Pod);
};
type CronJob = { spec: { schedule: string; concurrencyPolicy: string; jobTemplate: { spec: { template: { spec: PodSpec } } } } };
const byName = (spec: PodSpec, name: string) => spec.containers.find((c) => c.name === name);
const envOf = (c: Container) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));

describe.skipIf(helm === null)("the chart's camera block", () => {
  test(
    "off by default: no camera template, CronJob, GM setting or claim anywhere",
    () => {
      const { docs } = render([]);
      const text = JSON.stringify(docs);
      for (const s of ['"name":"camera"', '"name":"camera-director"', "AC_GM_LOGIN_STATE", "AC_GM_VISIBLE", "camera-client-data", "camera-max", "devic.es/dri", "camera-sweep"]) expect(text).not.toContain(s);
      expect(cameraPod(docs)).toBeUndefined();
    },
    HELM_TEST_MS,
  );

  test(
    "on: no world pod carries a camera; the worlds make GMs invisible; the camera's own pod template and the sweep",
    () => {
      const { docs } = render(ON);
      // Never a container in a world's pod: a camera cannot hold one short of Ready.
      expect(shared(docs).spec!.containers.map((c) => c.name)).toEqual(["worldserver"]);
      expect(worldPod(docs).spec.containers.map((c) => c.name)).toEqual(["worldserver"]);
      for (const spec of [shared(docs).spec!, worldPod(docs).spec]) {
        const ws = envOf(byName(spec, "worldserver")!);
        expect(ws["AC_GM_LOGIN_STATE"]?.value).toBe("1");
        expect(ws["AC_GM_VISIBLE"]?.value).toBe("0");
      }
      const pod = cameraPod(docs)!;
      expect(pod.spec.containers.map((c) => c.name)).toEqual(["camera", "camera-director"]);
      const cam = byName(pod.spec, "camera")!;
      // The password by reference only, never a value.
      expect(envOf(cam)["CAMERA_PASSWORD"]).toEqual({ name: "CAMERA_PASSWORD", valueFrom: { secretKeyRef: { name: "wrathbench-env", key: "WRATHBENCH_CAMERA_PASSWORD" } } });
      expect(cam.resources?.limits?.["devic.es/dri"]).toBe(1);
      // The client's data, read-only.
      expect(cam.volumeMounts?.find((m) => m.name === "camera-client-data")?.readOnly).toBe(true);
      expect(pod.spec.volumes?.find((v) => v.name === "camera-client-data")?.persistentVolumeClaim).toEqual({ claimName: "wrathbench-client-data", readOnly: true });
      const cron = find(docs, "CronJob", "wrathbench-camera-sweep") as unknown as CronJob;
      expect(cron.spec.concurrencyPolicy).toBe("Forbid");
    },
    HELM_TEST_MS,
  );

  test(
    "software: no GPU claim, lavapipe; the interval, keep and cap are the values'",
    () => {
      const { docs } = render([...ON, "--set", "camera.renderer=software", "--set", "camera.intervalSeconds=5", "--set", "camera.maxConcurrent=3", "--set", "camera.frameKeepHours=6"]);
      const pod = cameraPod(docs)!;
      const cam = byName(pod.spec, "camera")!;
      expect(cam.resources?.limits?.["devic.es/dri"]).toBeUndefined();
      expect(envOf(cam)["VK_ICD_FILENAMES"]?.value).toContain("lvp_icd");
      expect(envOf(cam)["CAMERA_FPS"]?.value).toBe("2");
      expect(envOf(byName(pod.spec, "camera-director")!)["CAMERA_INTERVAL_SECONDS"]?.value).toBe("5");
      expect(pod.metadata.annotations?.["wrathbench.shard.page/camera-max"]).toBe("3");
      const cron = find(docs, "CronJob", "wrathbench-camera-sweep") as unknown as CronJob;
      expect(cron.spec.jobTemplate.spec.template.spec.containers[0]!.command!.slice(-2)).toEqual(["--keep-hours", "6"]);
    },
    HELM_TEST_MS,
  );
});
