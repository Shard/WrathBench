/**
 * The camera's own pods (infra/camera-pods.ts): a world per eval gets one
 * only while a slot is free, one slot always held for the shared world's;
 * neither start ever throws; and with the camera off, every camera pod left
 * up is removed.
 */
import { describe, expect, test } from "bun:test";
import { K8sError, type Pod } from "./k8s-client";
import { CAMERA_REAP_GRACE_S, CAMERA_WORLD_LABEL, cameraSlotFree, ensureSharedCamera, reapCameras, startWorldCamera, type CameraK8s } from "./camera-pods";

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
});

describe("the camera off", () => {
  class ReapK8s {
    deleted: { name: string; grace: number }[] = [];
    selectors: string[] = [];
    failList = false;
    failDelete = new Set<string>();
    constructor(readonly pods: Pod[]) {}
    async listPods(selector: string) {
      this.selectors.push(selector);
      if (this.failList) throw new K8sError(403, "Forbidden", "pods is forbidden");
      return this.pods;
    }
    async deletePod(name: string, grace: number) {
      if (this.failDelete.has(name)) throw new K8sError(500, "InternalError", "boom");
      this.deleted.push({ name, grace });
    }
  }

  test("removes every camera pod still up, the shared one and the worlds', with the director's grace", async () => {
    const k = new ReapK8s([camera("shared"), camera(ID), camera("wzzzzzzzzzz", { deletionTimestamp: "2026-11-15T10:00:00Z" })]);
    const logs: string[] = [];
    expect(await reapCameras({ client: k, log: (l) => logs.push(l) })).toEqual(["wrathbench-camera-shared", `wrathbench-camera-${ID}`]);
    expect(k.selectors).toEqual(["app.kubernetes.io/component=camera"]);
    expect(k.deleted).toEqual([
      { name: "wrathbench-camera-shared", grace: CAMERA_REAP_GRACE_S },
      { name: `wrathbench-camera-${ID}`, grace: CAMERA_REAP_GRACE_S },
    ]);
    expect(logs.every((l) => l.includes("the camera is off"))).toBe(true);
    // Nothing left: a later pass does nothing.
    expect(await reapCameras({ client: new ReapK8s([]), log: () => {} })).toEqual([]);
  });
});
