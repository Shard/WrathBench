/**
 * The chart's `camera` block (templates/_camera.tpl), rendered with helm when
 * it is on PATH. Off by default, it renders nothing: no sidecar, no volume, no
 * GM setting, no annotation. On, the shared world's pod and the world pod
 * template carry the camera client and its director; every worldserver makes
 * a GM invisible before it is on the map; the password is a Secret reference,
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
type Pod = { metadata: { annotations?: Record<string, string> }; spec: PodSpec };

function render(extra: string[], ok = true): { docs: Doc[]; stderr: string } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  if (ok) expect(r.exitCode, r.stderr.toString()).toBe(0);
  return { docs: r.exitCode === 0 ? r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc) : [], stderr: r.stderr.toString() };
}

const find = (docs: Doc[], kind: string, name: string) => docs.find((x) => x?.kind === kind && x.metadata?.name === name) ?? null;
const shared = (docs: Doc[]) => find(docs, "Deployment", "wrathbench-worldserver")!.spec!.template!;
const worldPod = (docs: Doc[]): Pod => JSON.parse(find(docs, "ConfigMap", "wrathbench-run-pod-template")!.data!["world.json"]!) as Pod;
const byName = (spec: PodSpec, name: string) => spec.containers.find((c) => c.name === name);
const envOf = (c: Container) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));

describe.skipIf(helm === null)("the chart's camera block", () => {
  test(
    "off by default: no camera container, volume, GM setting or annotation anywhere",
    () => {
      const { docs } = render([]);
      const text = JSON.stringify(docs);
      for (const s of ['"name":"camera"', '"name":"camera-director"', "AC_GM_LOGIN_STATE", "AC_GM_VISIBLE", "camera-client-data", "default-container", "camera-max", "devic.es/dri"]) expect(text).not.toContain(s);
      expect(shared(docs).spec!.containers.map((c) => c.name)).toEqual(["worldserver"]);
      expect(worldPod(docs).spec.containers.map((c) => c.name)).toEqual(["worldserver"]);
    },
    HELM_TEST_MS,
  );

  test(
    "on: the shared world and the world template carry the client and its director, the worlds invisible GMs",
    () => {
      const { docs } = render(ON);
      for (const [where, spec, annotations] of [
        ["shared", shared(docs).spec!, shared(docs).metadata?.annotations],
        ["world", worldPod(docs).spec, worldPod(docs).metadata.annotations],
      ] as const) {
        expect(spec.containers.map((c) => c.name), where).toEqual(["worldserver", "camera", "camera-director"]);
        expect(annotations?.["kubectl.kubernetes.io/default-container"]).toBe("worldserver");
        const ws = envOf(byName(spec, "worldserver")!);
        expect(ws["AC_GM_LOGIN_STATE"]?.value).toBe("1");
        expect(ws["AC_GM_VISIBLE"]?.value).toBe("0");
        const cam = byName(spec, "camera")!;
        expect(cam.image).toBe("harbor.example/wrathbench/wrathbench-camera:camera-1");
        const ce = envOf(cam);
        // The password by reference only.
        expect(ce["CAMERA_PASSWORD"]).toEqual({ name: "CAMERA_PASSWORD", valueFrom: { secretKeyRef: { name: "wrathbench-env", key: "WRATHBENCH_CAMERA_PASSWORD" } } });
        expect(ce["CAMERA_ACCOUNT"]?.value).toBe("CAMERA");
        expect(ce["WOW_CLOCK"]?.value).toBe("720");
        expect(cam.resources?.limits?.["devic.es/dri"]).toBe(1);
        expect(cam.volumeMounts?.find((m) => m.name === "camera-client-data")).toEqual({ name: "camera-client-data", mountPath: "/data/client", subPath: "Data", readOnly: true });
        const vol = spec.volumes?.find((v) => v.name === "camera-client-data");
        expect(vol?.persistentVolumeClaim).toEqual({ claimName: "wrathbench-client-data", readOnly: true });
        const dir = byName(spec, "camera-director")!;
        expect(dir.image).toBe("harbor.example/wrathbench/wrathbench-runner:harness-0.5-1-gabcdef0");
        expect(dir.command).toEqual(["/usr/bin/tini", "--", "bun", "infra/camera/director.ts"]);
        expect(envOf(dir)["CAMERA_INTERVAL_SECONDS"]?.value).toBe("10");
        expect(dir.volumeMounts?.find((m) => m.mountPath === "/wrathbench/data/runs")?.subPath).toBe("runs");
      }
      // The shared world's realm and world are its own; a world's are the launcher's to stamp.
      expect(envOf(byName(shared(docs).spec!, "camera")!)["CAMERA_REALM"]?.value).toBe("WrathBench");
      expect(envOf(byName(shared(docs).spec!, "camera-director")!)["CAMERA_WORLD"]?.value).toBe("shared");
      expect(envOf(byName(worldPod(docs).spec, "camera")!)["CAMERA_REALM"]?.value).toBe("");
      expect(worldPod(docs).metadata.annotations?.["wrathbench.shard.page/camera-max"]).toBe("2");
    },
    HELM_TEST_MS,
  );

  test(
    "software: no GPU claim, lavapipe, and more CPU; the interval and cap are the values'",
    () => {
      const { docs } = render([...ON, "--set", "camera.renderer=software", "--set", "camera.intervalSeconds=5", "--set", "camera.maxConcurrent=3"]);
      const cam = byName(shared(docs).spec!, "camera")!;
      expect(cam.resources?.limits?.["devic.es/dri"]).toBeUndefined();
      expect(envOf(cam)["VK_ICD_FILENAMES"]?.value).toContain("lvp_icd");
      expect(envOf(cam)["CAMERA_FPS"]?.value).toBe("2");
      expect(envOf(byName(shared(docs).spec!, "camera-director")!)["CAMERA_INTERVAL_SECONDS"]?.value).toBe("5");
      expect(worldPod(docs).metadata.annotations?.["wrathbench.shard.page/camera-max"]).toBe("3");
    },
    HELM_TEST_MS,
  );

  test(
    "on without an image or a data claim: refused, never a guess",
    () => {
      expect(render(["--set", "camera.enabled=true", "--set", "camera.clientData.claimName=x"], false).stderr).toContain("camera.image is required");
      expect(render(["--set", "camera.enabled=true", "--set", "camera.image=x:1"], false).stderr).toContain("camera.clientData.claimName is required");
    },
    HELM_TEST_MS,
  );
});
