/**
 * The hosted gateway's workers as pods: a `WorkerProvider` (wrath-mcp
 * `mcp/src/hosted/workers.ts`) that starts each credential's worker as a pod
 * of its own in the hosted namespace, from the template the chart renders
 * (`templates/hosted-gateway.yaml`, ConfigMap `<release>-hosted-worker`).
 *
 * What a pod gives the worker that a process on the gateway's machine could
 * not: its own kernel cgroup (the CPU and memory limits), its own network
 * identity under a NetworkPolicy that lets it reach the module's port and DNS
 * and nothing else, no ServiceAccount token, and no volume but its own
 * credential's directory (a subPath of the hosted volume). The gateway's port
 * secret is in no pod but the gateway's.
 *
 * The provider sets three things on the template and nothing else: the pod's
 * credential label, the worker's secret (an env value: only the gateway's
 * ServiceAccount can read pods in this namespace, and the worker's port
 * admits only the gateway), and the subPath of the `tenant` mount. It waits
 * for the pod to be Ready (its readiness probe is the worker's port) and
 * hands the gateway the pod's address. A gateway that restarts cannot reach
 * its old workers (only it knew their secrets), so `reapStale` deletes every
 * worker pod of the release at start rather than waiting for them to exit.
 */

import { readFileSync } from "node:fs";
import type { WorkerHandle, WorkerProvider } from "@wrathbench/mcp/hosted/workers";
import type { K8sClient, Pod, PodEnvVar } from "../k8s-client";

/** Where the chart mounts the worker template into the gateway's pod. */
export const WORKER_TEMPLATE_ENV = "WRATHBENCH_HOSTED_WORKER_TEMPLATE";
export const DEFAULT_WORKER_TEMPLATE = "/etc/wrathbench/hosted/worker.json";

/** The template's container that runs the worker, and the mount that is the credential's directory. */
export const WORKER_CONTAINER = "worker";
export const TENANT_MOUNT = "tenant";
/** The label naming a worker pod's credential. */
export const CREDENTIAL_LABEL = "wrathbench.io/credential";
/** The env var the worker reads its secret from (wrath-mcp `hosted/worker.ts`). */
export const WORKER_SECRET_ENV = "WRATH_MCP_WORKER_SECRET";

export interface PodWorkersOptions {
  client: K8sClient;
  /** The rendered pod template. */
  template: Pod;
  /** How long a pod may take to be Ready. Default 180 s: a fresh node may pull the image. */
  startTimeoutMs?: number;
  /** How often a starting or running pod is read back. */
  pollMs?: number;
  log?: (line: string) => void;
}

/** The worker template the chart renders, read from where it mounts it. */
export function readWorkerTemplate(path: string = process.env[WORKER_TEMPLATE_ENV] ?? DEFAULT_WORKER_TEMPLATE): Pod {
  const pod = JSON.parse(readFileSync(path, "utf8")) as Pod;
  workerContainer(pod);
  tenantMount(pod);
  return pod;
}

function workerContainer(pod: Pod): Pod["spec"]["containers"][number] {
  const c = pod.spec.containers.find((x) => x.name === WORKER_CONTAINER);
  if (c === undefined) throw new Error(`the worker template has no container named ${WORKER_CONTAINER}`);
  return c;
}

function tenantMount(pod: Pod): { name: string; mountPath: string; subPath?: string } {
  const m = workerContainer(pod).volumeMounts?.find((x) => x.name === TENANT_MOUNT);
  if (m === undefined) throw new Error(`the worker template's ${WORKER_CONTAINER} container mounts no volume named ${TENANT_MOUNT}`);
  return m;
}

/** The label selector matching every worker pod the template makes. */
export function workerSelector(template: Pod): string {
  const labels = template.metadata.labels ?? {};
  const keys = ["app.kubernetes.io/instance", "app.kubernetes.io/component"].filter((k) => labels[k] !== undefined);
  if (keys.length < 2) throw new Error("the worker template must label its pods with app.kubernetes.io/instance and app.kubernetes.io/component");
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

/** The pod for one credential's worker: the template with its label, its secret and its directory. */
export function workerPod(template: Pod, credential: string, secret: string): Pod {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(credential)) throw new Error(`not a credential id: ${credential}`);
  const pod = structuredClone(template);
  pod.metadata.labels = { ...(pod.metadata.labels ?? {}), [CREDENTIAL_LABEL]: credential };
  const c = workerContainer(pod);
  if ((c.env ?? []).some((e) => e.name === WORKER_SECRET_ENV || e.name === "WRATHBENCH_MODULE_SECRET")) {
    throw new Error(`the worker template must carry neither ${WORKER_SECRET_ENV} nor WRATHBENCH_MODULE_SECRET`);
  }
  c.env = [...(c.env ?? []), { name: WORKER_SECRET_ENV, value: secret } satisfies PodEnvVar];
  tenantMount(pod).subPath = `tenants/${credential}`;
  return pod;
}

const ready = (p: Pod): boolean => p.status?.podIP !== undefined && (p.status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
const ended = (p: Pod | null): boolean => p === null || p.status?.phase === "Succeeded" || p.status?.phase === "Failed" || p.metadata.deletionTimestamp !== undefined;

export class PodWorkers implements WorkerProvider {
  private readonly log: (line: string) => void;

  constructor(private readonly o: PodWorkersOptions) {
    this.log = o.log ?? (() => {});
    workerContainer(o.template);
    tenantMount(o.template);
    workerSelector(o.template);
  }

  /** The worker's port, as the template's container declares it. */
  get port(): number {
    const p = (workerContainer(this.o.template)["ports"] as { containerPort?: number }[] | undefined)?.[0]?.containerPort;
    if (p === undefined) throw new Error(`the worker template's ${WORKER_CONTAINER} container declares no port`);
    return p;
  }

  /** Delete every worker pod of this release: a restarted gateway cannot reach them. */
  async reapStale(): Promise<number> {
    const pods = await this.o.client.listPods(workerSelector(this.o.template));
    for (const p of pods) if (p.metadata.name !== undefined) await this.o.client.deletePod(p.metadata.name, 0);
    if (pods.length > 0) this.log(`deleted ${pods.length} worker pod(s) a previous gateway left`);
    return pods.length;
  }

  async start(o: { credential: string; secret: string; dir: string }): Promise<WorkerHandle> {
    const port = this.port;
    const created = await this.o.client.createPod(workerPod(this.o.template, o.credential, o.secret));
    const name = created.metadata.name;
    if (name === undefined) throw new Error("the API created a worker pod with no name");
    const poll = this.o.pollMs ?? 500;
    const until = Date.now() + (this.o.startTimeoutMs ?? 180_000);
    let pod: Pod | null = created;
    for (;;) {
      pod = await this.o.client.getPod(name);
      if (pod !== null && ready(pod)) break;
      if (ended(pod) || Date.now() > until) {
        await this.o.client.deletePod(name, 0).catch(() => {});
        const why = pod === null ? "it was deleted" : ended(pod) ? `it ended (${pod.status?.phase ?? "deleting"})` : "it was not Ready in time";
        throw new Error(`the worker pod ${name} for ${o.credential} did not start: ${why}`);
      }
      await Bun.sleep(poll);
    }
    const host = pod.status!.podIP!;
    let stopped: Promise<void> | undefined;
    let gone = false;
    const exited = (async () => {
      while (!gone) {
        await Bun.sleep(Math.max(poll, 2_000));
        try {
          if (ended(await this.o.client.getPod(name))) return;
        } catch {
          // the API is slow or away for a moment; the channel's own close says more
        }
      }
    })();
    this.log(`worker pod ${name} for ${o.credential} at ${host}:${port}`);
    return {
      host,
      port,
      // The template mounts the credential's directory here.
      paths: { state: `${tenantMount(this.o.template).mountPath}/state`, sessions: `${tenantMount(this.o.template).mountPath}/sessions` },
      exited,
      stop: () =>
        (stopped ??= (async () => {
          await this.o.client.deletePod(name, 15).catch((err: unknown) => this.log(`deleting worker pod ${name}: ${err instanceof Error ? err.message : String(err)}`));
          gone = true;
        })()),
    };
  }
}
