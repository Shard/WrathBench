/**
 * The camera in a world per eval (infra/world.ts): a world takes the camera's
 * sidecars only while a slot is free, the shared world's camera counted;
 * kept, they are stamped with this world's realm and id; without a slot they
 * and their volumes are gone, so the world claims nothing for a camera. A
 * camera's own container state never decides a world's boot.
 */
import { describe, expect, test } from "bun:test";
import type { Pod } from "./k8s-client";
import { buildWorldPod, CAMERA_LABEL, CAMERA_MAX_ANNOTATION, cameraSlotFree, templateHasCamera, worldPodRefusal, worldRealmName } from "./world";

const ID = "wabcdefghij";

function template(camera: boolean, max = 2): Pod {
  const ws = { name: "worldserver", image: "reg/wrathbench-worldserver:t1", env: [{ name: "AC_GM_VISIBLE", value: "0" }] };
  const cam = { name: "camera", image: "reg/camera:c1", env: [{ name: "CAMERA_REALM", value: "" }], resources: { limits: { "devic.es/dri": 1 } } };
  const dir = { name: "camera-director", image: "reg/wrathbench-runner:t1", env: [{ name: "CAMERA_WORLD", value: "" }] };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      generateName: "wrathbench-world-",
      labels: { "app.kubernetes.io/instance": "wrathbench", "app.kubernetes.io/component": "world" },
      ...(camera ? { annotations: { [CAMERA_MAX_ANNOTATION]: String(max) } } : {}),
    },
    spec: {
      restartPolicy: "Never",
      subdomain: "worlds",
      initContainers: [{ name: "db-import", image: "reg/wrathbench-db-import:t1", env: [] }],
      containers: camera ? [ws, cam, dir] : [ws],
      volumes: [{ name: "data" }, ...(camera ? [{ name: "camera-run" }, { name: "camera-client-data" }] : [])],
    },
  } as unknown as Pod;
}

const opts = { id: ID, realmId: 7, accounts: ["POOL01"], owner: undefined, rosterPid: 9 };
const env = (pod: Pod, c: string, n: string) => pod.spec.containers.find((x) => x.name === c)?.env?.find((e) => e.name === n)?.value;
const worldPod = (name: string, camera: boolean, extra: Partial<Pod["metadata"]> = {}, phase = "Running"): Pod =>
  ({ metadata: { name, labels: camera ? { [CAMERA_LABEL]: "true" } : {}, ...extra }, spec: { containers: [] }, status: { phase } }) as unknown as Pod;

describe("a world's camera slot", () => {
  test("with a slot: both sidecars stamped with this world's realm and id, and the pod labelled", () => {
    const pod = buildWorldPod(template(true), { ...opts, camera: true });
    expect(pod.spec.containers.map((c) => c.name)).toEqual(["worldserver", "camera", "camera-director"]);
    expect(env(pod, "camera", "CAMERA_REALM")).toBe(`WrathBench ${ID}`);
    expect(worldRealmName(ID)).toBe(`WrathBench ${ID}`);
    expect(env(pod, "camera-director", "CAMERA_WORLD")).toBe(ID);
    expect(pod.metadata.labels?.[CAMERA_LABEL]).toBe("true");
  });

  test("without one: no camera container, volume or label, so nothing is claimed", () => {
    const pod = buildWorldPod(template(true), { ...opts, camera: false });
    expect(pod.spec.containers.map((c) => c.name)).toEqual(["worldserver"]);
    expect((pod.spec["volumes"] as { name: string }[]).map((v) => v.name)).toEqual(["data"]);
    expect(pod.metadata.labels?.[CAMERA_LABEL]).toBeUndefined();
    // The block off: the template has no camera, and `camera` changes nothing.
    expect(buildWorldPod(template(false), { ...opts, camera: true }).spec.containers.map((c) => c.name)).toEqual(["worldserver"]);
  });

  test("a camera stamped for another world is refused: it would pick that world's realm", () => {
    const pod = buildWorldPod(template(true), { ...opts, camera: true });
    pod.spec.containers.find((c) => c.name === "camera")!.env = [{ name: "CAMERA_REALM", value: "WrathBench wzzzzzzzzzz" }];
    expect(worldPodRefusal(pod)).toMatch(/camera is not stamped/);
  });

  test("slots: the shared world's camera counts, ended or leaving pods do not, nor this world's own", () => {
    const t = template(true, 2);
    expect(templateHasCamera(t)).toBe(true);
    expect(cameraSlotFree(t, [], "wrathbench-world-a")).toBe(true);
    expect(cameraSlotFree(t, [worldPod("wrathbench-world-b", true)], "wrathbench-world-a")).toBe(false);
    expect(cameraSlotFree(t, [worldPod("wrathbench-world-a", true)], "wrathbench-world-a")).toBe(true);
    expect(cameraSlotFree(t, [worldPod("wrathbench-world-b", false)], "wrathbench-world-a")).toBe(true);
    expect(cameraSlotFree(t, [worldPod("wrathbench-world-b", true, { deletionTimestamp: "2026-11-15T00:00:00Z" })], "wrathbench-world-a")).toBe(true);
    expect(cameraSlotFree(t, [worldPod("wrathbench-world-b", true, {}, "Failed")], "wrathbench-world-a")).toBe(true);
    expect(cameraSlotFree(template(true, 1), [], "wrathbench-world-a")).toBe(false);
    expect(cameraSlotFree(template(true, 3), [worldPod("b", true)], "a")).toBe(true);
    expect(cameraSlotFree(template(false), [], "a")).toBe(false);
  });
});
