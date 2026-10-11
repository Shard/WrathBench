/**
 * The smallest Kubernetes client the fleet needs, over Bun's own `fetch`.
 *
 * The run-pod launcher (infra/run-pod.ts) creates one pod per episode, reads
 * it back until it ends, deletes it, and follows its log; the supervisor's
 * drain asks whether a roster still has a pod in flight. That is five verbs on
 * one resource in one namespace, and a client library for it would be the
 * repository's first dependency on the Kubernetes ecosystem. So this is the
 * in-cluster recipe by hand: the API at `https://kubernetes.default.svc`, the
 * ServiceAccount token and CA the kubelet projects into every pod, and the
 * namespace file beside them. Nothing here knows what a run is.
 *
 * Off the cluster `inCluster()` is null and every caller falls back to a child
 * process; a test hands the client a plain-http base URL and no CA.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const IN_CLUSTER_API = "https://kubernetes.default.svc";

/** The subset of a Pod object the launcher and the drain read. */
export interface PodStatus {
  phase?: string;
  reason?: string;
  message?: string;
  conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
  containerStatuses?: {
    name?: string;
    imageID?: string;
    state?: {
      waiting?: { reason?: string; message?: string };
      running?: { startedAt?: string };
      terminated?: { exitCode?: number; reason?: string; message?: string; finishedAt?: string };
    };
  }[];
}

export interface Pod {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name?: string;
    generateName?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { apiVersion: string; kind: string; name: string; uid: string }[];
    deletionTimestamp?: string;
  };
  spec: Record<string, unknown> & {
    nodeName?: string;
    containers: (Record<string, unknown> & {
      name: string;
      image: string;
      command?: string[];
      args?: string[];
      env?: PodEnvVar[];
      volumeMounts?: { name: string; mountPath: string; subPath?: string; readOnly?: boolean }[];
    })[];
    volumes?: ({ name: string } & Record<string, unknown>)[];
    terminationGracePeriodSeconds?: number;
  };
  status?: PodStatus;
}

export interface PodEnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean }; fieldRef?: { fieldPath: string } };
}

export class K8sError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface K8sClientOptions {
  baseUrl: string;
  token: string;
  namespace: string;
  /** The cluster CA (PEM); absent for a plain-http test server. */
  ca?: string;
}

export class K8sClient {
  readonly namespace: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly ca: string | undefined;

  constructor(opts: K8sClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.namespace = opts.namespace;
    this.ca = opts.ca;
  }

  /**
   * The client for the pod this process runs in, or null when there is no
   * projected ServiceAccount token — which is every host, every compose
   * container, and a pod whose spec says `automountServiceAccountToken: false`.
   * Read fresh per call rather than cached: the projected token rotates on the
   * kubelet's schedule (about an hour), and a supervisor is up for weeks.
   */
  static inCluster(dir: string = SERVICE_ACCOUNT_DIR, env: Record<string, string | undefined> = process.env): K8sClient | null {
    const tokenPath = join(dir, "token");
    if (!existsSync(tokenPath) || env["KUBERNETES_SERVICE_HOST"] === undefined) return null;
    let token: string;
    let namespace: string;
    let ca: string | undefined;
    try {
      token = readFileSync(tokenPath, "utf8").trim();
      namespace = readFileSync(join(dir, "namespace"), "utf8").trim();
      ca = existsSync(join(dir, "ca.crt")) ? readFileSync(join(dir, "ca.crt"), "utf8") : undefined;
    } catch {
      return null;
    }
    if (token.length === 0 || namespace.length === 0) return null;
    const host = env["KUBERNETES_SERVICE_HOST"];
    const port = env["KUBERNETES_SERVICE_PORT"] ?? "443";
    // The service DNS name is what the CA certifies; the IP is the fallback for
    // a pod whose DNS is not up yet, and the CA covers that SAN too.
    const baseUrl = host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? IN_CLUSTER_API : `https://${host}:${port}`;
    return new K8sClient({ baseUrl, token, namespace, ...(ca !== undefined ? { ca } : {}) });
  }

  private podsUrl(suffix = ""): string {
    return `${this.baseUrl}/api/v1/namespaces/${encodeURIComponent(this.namespace)}/pods${suffix}`;
  }

  private async request(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const init: RequestInit & { tls?: { ca: string } } = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(this.ca !== undefined ? { tls: { ca: this.ca } } : {}),
    };
    return fetch(url, init);
  }

  private async json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const r = await this.request(method, url, body, AbortSignal.timeout(30_000));
    const text = await r.text();
    if (!r.ok) {
      let reason = r.statusText;
      let message = text;
      try {
        const s = JSON.parse(text) as { reason?: string; message?: string };
        reason = s.reason ?? reason;
        message = s.message ?? message;
      } catch {
        // not a Status object
      }
      throw new K8sError(r.status, reason, `${method} ${url}: ${r.status} ${reason}${message ? ` — ${message}` : ""}`);
    }
    return JSON.parse(text) as T;
  }

  createPod(pod: Pod): Promise<Pod> {
    return this.json<Pod>("POST", this.podsUrl(), { apiVersion: "v1", kind: "Pod", ...pod });
  }

  /** The pod, or null once it is gone (404). */
  async getPod(name: string): Promise<Pod | null> {
    try {
      return await this.json<Pod>("GET", this.podsUrl(`/${encodeURIComponent(name)}`));
    } catch (e) {
      if (e instanceof K8sError && e.status === 404) return null;
      throw e;
    }
  }

  async listPods(labelSelector: string): Promise<Pod[]> {
    const r = await this.json<{ items?: Pod[] }>("GET", this.podsUrl(`?labelSelector=${encodeURIComponent(labelSelector)}`));
    return r.items ?? [];
  }

  /**
   * Delete with an explicit grace: the kubelet sends SIGTERM now and SIGKILL
   * after `gracePeriodSeconds`. A pod already gone is not an error here —
   * the caller wanted it gone.
   */
  async deletePod(name: string, gracePeriodSeconds: number): Promise<void> {
    try {
      await this.json("DELETE", this.podsUrl(`/${encodeURIComponent(name)}`), {
        apiVersion: "v1",
        kind: "DeleteOptions",
        gracePeriodSeconds: Math.max(0, Math.round(gracePeriodSeconds)),
      });
    } catch (e) {
      if (e instanceof K8sError && e.status === 404) return;
      throw e;
    }
  }

  /**
   * The container's log as a byte stream, following until the container
   * ends. Null when the API refuses (a container that has not started yet
   * answers 400); the caller retries on its next poll.
   */
  async podLog(name: string, opts: { follow: boolean; container?: string; signal?: AbortSignal }): Promise<ReadableStream<Uint8Array> | null> {
    const q = new URLSearchParams({ follow: String(opts.follow) });
    if (opts.container !== undefined) q.set("container", opts.container);
    const r = await this.request("GET", this.podsUrl(`/${encodeURIComponent(name)}/log?${q.toString()}`), undefined, opts.signal);
    if (!r.ok || r.body === null) {
      await r.text().catch(() => "");
      return null;
    }
    return r.body;
  }
}

/** `repo@sha256:…` out of a containerStatus `imageID`, whichever runtime wrote it. */
export function digestOf(imageID: string | undefined): string | undefined {
  if (imageID === undefined) return undefined;
  const m = /sha256:[0-9a-f]{64}/.exec(imageID);
  return m === null ? undefined : m[0];
}
