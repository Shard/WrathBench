/**
 * The camera's own pods (infra/camera-pods.ts): built from the chart's
 * template with the world's realm, id and forward target and an owner; a
 * world per eval gets one only while a slot is free, one slot always held for
 * the shared world's; and neither start ever throws.
 */
import { describe, expect, test } from "bun:test";
import { K8sError, type Pod } from "./k8s-client";
import { buildCameraPod, CAMERA_WORLD_LABEL, cameraPodName, cameraSlotFree, ensureSharedCamera, startWorldCamera, type CameraK8s } from "./camera-pods";

const ID = "wabcdefghij";

function template(max = 2): Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      generateName: "wrathbench-camera-",
      labels: { "app.kubernetes.io/instance": "wrathbench", "app.kubernetes.io/component": "camera" },
      annotations: { "wrathbench.shard.page/camera-max": String(max), "wrathbench.shard.page/shared-realm": "WrathBench v1" },
    },
    spec: {
      containers: [
        { name: "camera", image: "reg/camera:c1", env: [{ name: "CAMERA_REALM", value: "" }] },
        { name: "camera-director", image: "reg/wrathbench-runner:t1", env: [{ name: "CAMERA_WORLD", value: "" }], command: ["/usr/bin/tini", "--", "bun", "infra/camera/director.ts"] },
      ],
    },
  } as unknown as Pod;
}

const env = (pod: Pod, c: string, n: string) => pod.spec.containers.find((x) => x.name === c)?.env?.find((e) => e.name === n)?.value;
const camera = (world: string, extra: Partial<Pod["metadata"]> = {}, phase = "Running"): Pod =>
  ({ metadata: { name: `wrathbench-camera-${world}`, labels: { [CAMERA_WORLD_LABEL]: world }, ...extra }, spec: { containers: [] }, status: { phase } }) as unknown as Pod;

class FakeK8s implements CameraK8s {
  pods = new Map<string, Pod>();
  created: Pod[] = [];
  fail: Error | null = null;
  async createPod(p: Pod) {
    if (this.fail !== null) throw this.fail;
    this.created.push(p);
    this.pods.set(p.metadata.name!, p);
    return p;
  }
  async getPod(name: string) {
    return this.pods.get(name) ?? null;
  }
  async listPods() {
    return [...this.pods.values()];
  }
}

describe("a camera pod", () => {
  test("named after its world, stamped with its realm and world, forwarding to it, owned by what it goes with", () => {
    const pod = buildCameraPod(template(), { world: ID, realm: `WrathBench ${ID}`, target: `${ID}.worlds:8085`, owner: { name: `wrathbench-world-${ID}`, uid: "u1" } });
    expect(pod.metadata.name).toBe(`wrathbench-camera-${ID}`);
    expect(pod.metadata.generateName).toBeUndefined();
    expect(pod.metadata.labels?.[CAMERA_WORLD_LABEL]).toBe(ID);
    expect(env(pod, "camera", "CAMERA_REALM")).toBe(`WrathBench ${ID}`);
    expect(env(pod, "camera-director", "CAMERA_WORLD")).toBe(ID);
    expect((pod.spec.containers[1] as { command?: string[] }).command).toEqual(["/usr/bin/tini", "--", "bun", "infra/camera/director.ts", "--forward-world", `${ID}.worlds:8085`]);
    expect(pod.metadata.ownerReferences).toEqual([{ apiVersion: "v1", kind: "Pod", name: `wrathbench-world-${ID}`, uid: "u1" }]);
    // The template is not touched.
    expect(template().metadata.name).toBeUndefined();
    expect(() => buildCameraPod(template(), { world: "wbad", realm: "x", target: "a:1" })).toThrow();
    expect(() => buildCameraPod(template(), { world: ID, realm: "x", target: "no port" })).toThrow();
  });

  test("slots: one held for the shared world; worlds share the rest; leaving, ended and its own pod do not count", () => {
    expect(cameraSlotFree(template(1), [], "shared")).toBe(true);
    expect(cameraSlotFree(template(1), [], ID)).toBe(false);
    expect(cameraSlotFree(template(2), [camera("shared")], ID)).toBe(true);
    expect(cameraSlotFree(template(2), [camera("shared"), camera("wzzzzzzzzzz")], ID)).toBe(false);
    expect(cameraSlotFree(template(2), [camera("wzzzzzzzzzz", { deletionTimestamp: "2026-11-15T00:00:00Z" })], ID)).toBe(true);
    expect(cameraSlotFree(template(2), [camera("wzzzzzzzzzz", {}, "Failed")], ID)).toBe(true);
    expect(cameraSlotFree(template(2), [camera(ID)], ID)).toBe(true);
    expect(cameraSlotFree(template(3), [camera("wzzzzzzzzzz")], ID)).toBe(true);
    expect(cameraSlotFree(template(0), [], "shared")).toBe(false);
  });
});

describe("starting cameras", () => {
  const log: string[] = [];
  const worldPod = { name: `wrathbench-world-${ID}`, uid: "u1" };

  test("a world's: started when a slot is free, left alone when one is there, never when none is", async () => {
    const k = new FakeK8s();
    expect(await startWorldCamera({ client: k, template: template(2), world: ID, realm: `WrathBench ${ID}`, worldPod, log: (l) => log.push(l) })).toBe("started");
    expect(k.created[0]!.metadata.ownerReferences?.[0]?.uid).toBe("u1");
    expect(await startWorldCamera({ client: k, template: template(2), world: ID, realm: `WrathBench ${ID}`, worldPod, log: () => {} })).toBe("present");
    expect(await startWorldCamera({ client: new FakeK8s(), template: template(1), world: ID, realm: `WrathBench ${ID}`, worldPod, log: () => {} })).toBe("no slot");
  });

  test("a refusal (the quota, the API) is the camera's alone: never thrown", async () => {
    const k = new FakeK8s();
    k.fail = new K8sError(403, "Forbidden", "exceeded quota");
    expect(await startWorldCamera({ client: k, template: template(2), world: ID, realm: `WrathBench ${ID}`, worldPod, log: () => {} })).toBe("failed");
    expect(await ensureSharedCamera({ client: k, template: template(2), target: "worldserver:8085", log: () => {} })).toBe("failed");
  });

  test("the shared world's: made when missing, on the shared realm and the worldserver Service, owned by the fleet pod", async () => {
    const k = new FakeK8s();
    expect(await ensureSharedCamera({ client: k, template: template(1), owner: { name: "wrathbench-fleet-x", uid: "f1" }, target: "worldserver:8085", log: () => {} })).toBe("started");
    const pod = k.created[0]!;
    expect(pod.metadata.name).toBe(cameraPodName(template(), "shared"));
    expect(env(pod, "camera", "CAMERA_REALM")).toBe("WrathBench v1");
    expect(env(pod, "camera-director", "CAMERA_WORLD")).toBe("shared");
    expect((pod.spec.containers[1] as { command?: string[] }).command?.slice(-2)).toEqual(["--forward-world", "worldserver:8085"]);
    expect(pod.metadata.ownerReferences?.[0]?.name).toBe("wrathbench-fleet-x");
    expect(await ensureSharedCamera({ client: k, template: template(1), target: "worldserver:8085", log: () => {} })).toBe("present");
    expect(k.created).toHaveLength(1);
  });
});
