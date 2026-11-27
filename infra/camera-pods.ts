/**
 * The camera's pods (docs/RUNBOOK.md, "Camera"; templates/_camera.tpl): one
 * per filmed world, never a container in a world's pod, so a camera that
 * cannot pull its image, mount its data or stay up never holds a world short
 * of Ready, never delays its deletion and never stalls a release.
 *
 * - The shared world's camera is the fleet's: `ensureSharedCamera`, every
 *   minute, creates it when it is missing, owned by the fleet pod.
 * - A world per eval's is the world launcher's: `startWorldCamera`, once the
 *   world answers ready, creates it when a slot is free, owned by the world's
 *   pod, so the garbage collector removes it after the world's pod is gone
 *   (background deletion: the world's own deletion never waits on it). Its
 *   director gets its grace on that deletion and keeps the frames its ring
 *   holds.
 *
 * Every realm row advertises 127.0.0.1:8085, so the director forwards that
 * loopback port to the world's real address (`--forward-world`).
 *
 * The cap is the template's `camera-max` (values.yaml `camera.maxConcurrent`),
 * one slot always held for the shared world's camera: worlds per eval share
 * the rest.
 *
 * Off (`camera.enabled: false`, so no template) means no camera: the fleet
 * deletes every camera pod in the namespace (`reapCameras`), the shared one
 * and the worlds' alike, so turning the camera off is a values change alone. A
 * world's camera otherwise goes with its world's pod, at a park or an end.
 */

import { readFileSync } from "node:fs";
import type { K8sClient, Pod, PodEnvVar } from "./k8s-client";

export const CAMERA_COMPONENT = "camera";
/** Which world a camera pod films: a world id, or `shared`. */
export const CAMERA_WORLD_LABEL = "wrathbench.shard.page/camera-world";
export const CAMERA_MAX_ANNOTATION = "wrathbench.shard.page/camera-max";
export const SHARED_REALM_ANNOTATION = "wrathbench.shard.page/shared-realm";
export const CAMERA_POD_TEMPLATE_ENV = "WRATHBENCH_CAMERA_POD_TEMPLATE";
export const DEFAULT_CAMERA_POD_TEMPLATE = "/etc/wrathbench/run-pod/camera.json";
export const SHARED = "shared";
export const WORLD_PORT = 8085;

export type CameraK8s = Pick<K8sClient, "createPod" | "getPod" | "listPods">;
export type CameraReapK8s = Pick<K8sClient, "listPods" | "deletePod">;
/** A reaped camera's grace: its director keeps the frames its ring holds (the template's own `terminationGracePeriodSeconds`). */
export const CAMERA_REAP_GRACE_S = 30;

/** The chart's camera pod template, or undefined when the block is off. */
export function readCameraTemplate(env: Record<string, string | undefined> = process.env): Pod | undefined {
  try {
    const t = JSON.parse(readFileSync(env[CAMERA_POD_TEMPLATE_ENV] ?? DEFAULT_CAMERA_POD_TEMPLATE, "utf8")) as Pod;
    return t.spec?.containers?.some((c) => c.name === "camera") ? t : undefined;
  } catch {
    return undefined;
  }
}

function cameraPodName(template: Pod, world: string): string {
  return `${template.metadata.generateName ?? "camera-"}${world}`;
}

function setEnv(env: PodEnvVar[] | undefined, name: string, value: string): PodEnvVar[] {
  return [...(env ?? []).filter((e) => e.name !== name), { name, value }];
}

export interface CameraPodOptions {
  /** A world id, or `shared`. */
  world: string;
  /** The realm the client picks by name. */
  realm: string;
  /** The world's own address, `host:8085`, which the director forwards 127.0.0.1:8085 to. */
  target: string;
  /** What the pod goes with: the world's pod, or the fleet pod. */
  owner?: { name: string; uid: string };
}

/** The template with this camera filled in. */
function buildCameraPod(template: Pod, o: CameraPodOptions): Pod {
  if (!/^(shared|w[a-z2-7]{10})$/.test(o.world)) throw new Error(`camera pod: ${JSON.stringify(o.world)} is not a world`);
  if (!/^[A-Za-z0-9.-]+:\d+$/.test(o.target)) throw new Error(`camera pod: ${JSON.stringify(o.target)} is not host:port`);
  const pod = structuredClone(template);
  pod.apiVersion = "v1";
  pod.kind = "Pod";
  delete pod.metadata.generateName;
  pod.metadata.name = cameraPodName(template, o.world);
  pod.metadata.labels = { ...(pod.metadata.labels ?? {}), "app.kubernetes.io/component": CAMERA_COMPONENT, [CAMERA_WORLD_LABEL]: o.world };
  if (o.owner !== undefined) pod.metadata.ownerReferences = [{ apiVersion: "v1", kind: "Pod", name: o.owner.name, uid: o.owner.uid }];
  for (const c of pod.spec.containers) {
    if (c.name === "camera") c.env = setEnv(c.env, "CAMERA_REALM", o.realm);
    if (c.name === "camera-director") {
      c.env = setEnv(c.env, "CAMERA_WORLD", o.world);
      const cmd = (c as { command?: string[] }).command ?? [];
      (c as { command?: string[] }).command = [...cmd, "--forward-world", o.target];
    }
  }
  return pod;
}

function active(p: Pod): boolean {
  return p.metadata.deletionTimestamp === undefined && p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed";
}

/**
 * Whether `world` may have a camera now. The shared world's always may (its
 * slot is held for it); a world per eval may while the worlds' cameras, this
 * one's apart, number fewer than the cap less that slot.
 */
export function cameraSlotFree(template: Pod, cameraPods: readonly Pod[], world: string): boolean {
  const max = Number(template.metadata.annotations?.[CAMERA_MAX_ANNOTATION]);
  if (!Number.isInteger(max) || max < 1) return false;
  if (world === SHARED) return true;
  const worlds = cameraPods.filter((p) => {
    const of = p.metadata.labels?.[CAMERA_WORLD_LABEL];
    return active(p) && of !== undefined && of !== SHARED && of !== world;
  }).length;
  return worlds + 1 < max;
}

/** A camera beside a world per eval that is up; nothing when one is there or no slot is free. Never throws. */
export async function startWorldCamera(o: { client: CameraK8s; template: Pod; world: string; realm: string; worldPod: { name: string; uid: string }; log: (line: string) => void }): Promise<"started" | "present" | "no slot" | "failed"> {
  try {
    const name = cameraPodName(o.template, o.world);
    const there = await o.client.getPod(name);
    if (there !== null && there.metadata.deletionTimestamp === undefined) return "present";
    const cameras = await o.client.listPods(`app.kubernetes.io/component=${CAMERA_COMPONENT}`);
    if (!cameraSlotFree(o.template, cameras, o.world)) return "no slot";
    await o.client.createPod(buildCameraPod(o.template, { world: o.world, realm: o.realm, target: `${o.world}.worlds:${WORLD_PORT}`, owner: o.worldPod }));
    o.log(`world ${o.world}: camera ${name} started`);
    return "started";
  } catch (e) {
    o.log(`world ${o.world}: no camera (${e instanceof Error ? e.message : String(e)})`);
    return "failed";
  }
}

/** The shared world's camera, created when it is missing. Never throws. */
export async function ensureSharedCamera(o: { client: CameraK8s; template: Pod; owner?: { name: string; uid: string }; target: string; log: (line: string) => void }): Promise<"started" | "present" | "no slot" | "failed"> {
  try {
    const name = cameraPodName(o.template, SHARED);
    const there = await o.client.getPod(name);
    // One leaving is replaced on a later pass, once its name is free.
    if (there !== null) return "present";
    if (!cameraSlotFree(o.template, [], SHARED)) return "no slot";
    const realm = o.template.metadata.annotations?.[SHARED_REALM_ANNOTATION] ?? "WrathBench";
    await o.client.createPod(buildCameraPod(o.template, { world: SHARED, realm, target: o.target, ...(o.owner !== undefined ? { owner: o.owner } : {}) }));
    o.log(`camera ${name} started on the shared world`);
    return "started";
  } catch (e) {
    o.log(`shared camera: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

/**
 * With the camera off, every camera pod still up is deleted, with the grace its
 * director keeps its frames in. The names deleted; never throws.
 */
export async function reapCameras(o: { client: CameraReapK8s; log: (line: string) => void }): Promise<string[]> {
  const gone: string[] = [];
  try {
    for (const p of await o.client.listPods(`app.kubernetes.io/component=${CAMERA_COMPONENT}`)) {
      const name = p.metadata.name;
      if (name === undefined || p.metadata.deletionTimestamp !== undefined) continue;
      try {
        await o.client.deletePod(name, CAMERA_REAP_GRACE_S);
        gone.push(name);
        o.log(`camera ${name} removed: the camera is off`);
      } catch (e) {
        o.log(`camera ${name}: not removed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  } catch (e) {
    o.log(`cameras: not listed (${e instanceof Error ? e.message : String(e)})`);
  }
  return gone;
}
