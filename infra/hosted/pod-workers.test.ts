/**
 * The hosted gateway's pod provider against a fake Kubernetes API (`Bun.serve`,
 * plain http, no CA), and the gateway entry's grants file.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGrantsFile } from "@wrathbench/mcp/hosted/grants";
import { K8sClient, type Pod } from "../k8s-client";
import { ensureGrantsFile, reservedFromEnv } from "./gateway";
import { createServer } from "node:net";
import { CREDENTIAL_LABEL, PodWorkers, volumeSubPath, WORKER_SECRET_ENV, workerPod, workerSelector } from "./pod-workers";

const ROOT = "/data/hosted";
const DIR = "/data/hosted/state/tenants/pat-1";

/** Something accepting on a local port, standing in for a worker that listens. */
async function listening(): Promise<number> {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => void server.close());
  return (server.address() as { port: number }).port;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The template the chart renders, in miniature. */
function template(port = 8097): Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { generateName: "wrathbench-worker-", namespace: "wrathbench-hosted", labels: { "app.kubernetes.io/name": "wrathbench", "app.kubernetes.io/instance": "wrathbench", "app.kubernetes.io/component": "hosted-worker" } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      containers: [
        {
          name: "worker",
          image: "harbor.example/wrathbench-runner:harness-0.5-1-gabcdef0",
          command: ["/usr/bin/tini", "--", "bun", "--no-env-file", "infra/hosted/worker.ts", "--host", "0.0.0.0", "--port", "8097"],
          ports: [{ name: "worker", containerPort: port }],
          volumeMounts: [{ name: "tenant", mountPath: "/tenant" }, { name: "tmp", mountPath: "/tmp" }],
        },
      ],
      volumes: [{ name: "tenant", persistentVolumeClaim: { claimName: "wrathbench-hosted-data" } }, { name: "tmp", emptyDir: {} }],
    },
  };
}

/** A fake API holding pods; `onCreate` decides how a created pod's status evolves. */
function fakeApi(onCreate: (pod: Pod) => Pod["status"] = () => ({ phase: "Running", podIP: "127.0.0.1" })) {
  const pods = new Map<string, Pod>();
  const calls: string[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/api\/v1\/namespaces\/([^/]+)\/pods(?:\/([^/]+))?$/.exec(url.pathname);
      if (m === null) return Response.json({ kind: "Status", reason: "NotFound" }, { status: 404 });
      const name = m[2] !== undefined ? decodeURIComponent(m[2]) : undefined;
      calls.push(`${req.method} ${name ?? (url.searchParams.get("labelSelector") ?? "")}`);
      if (req.method === "POST") {
        const pod = (await req.json()) as Pod;
        pod.metadata.name = `${pod.metadata.generateName}${++n}`;
        pod.status = onCreate(pod);
        pods.set(pod.metadata.name, pod);
        return Response.json(pod, { status: 201 });
      }
      if (req.method === "GET" && name === undefined) {
        const sel = (url.searchParams.get("labelSelector") ?? "").split(",").map((kv) => kv.split("="));
        return Response.json({ items: [...pods.values()].filter((p) => sel.every(([k, v]) => p.metadata.labels?.[k!] === v)) });
      }
      if (name === undefined) return Response.json({}, { status: 405 });
      const pod = pods.get(name);
      if (req.method === "DELETE") {
        pods.delete(name);
        return Response.json({ kind: "Status", status: "Success" });
      }
      return pod === undefined ? Response.json({ kind: "Status", reason: "NotFound" }, { status: 404 }) : Response.json(pod);
    },
  });
  cleanups.push(() => void server.stop(true));
  const client = new K8sClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t", namespace: "wrathbench-hosted" });
  return { client, pods, calls };
}

describe("the worker pod", () => {
  test("is the template with the credential's label, the worker's secret and its own directory, and nothing else", () => {
    const t = template();
    const pod = workerPod(t, "pat-1", "s".repeat(64), volumeSubPath(ROOT, DIR));
    expect(pod.metadata.labels?.[CREDENTIAL_LABEL]).toBe("pat-1");
    expect(pod.spec.containers[0]!.env).toEqual([{ name: WORKER_SECRET_ENV, value: "s".repeat(64) }]);
    // The directory the gateway prepared, as a path within the volume it mounts at ROOT.
    expect(pod.spec.containers[0]!.volumeMounts?.find((m) => m.name === "tenant")?.subPath).toBe("state/tenants/pat-1");
    // The template itself is untouched.
    expect(t.spec.containers[0]!.env).toBeUndefined();
    expect(workerSelector(t)).toBe("app.kubernetes.io/instance=wrathbench,app.kubernetes.io/component=hosted-worker");
  });

  test("refuses a template carrying a secret, and a credential that is not an id", () => {
    const t = template();
    t.spec.containers[0]!.env = [{ name: "WRATHBENCH_MODULE_SECRET", valueFrom: { secretKeyRef: { name: "x", key: "y" } } }];
    expect(() => workerPod(t, "pat-1", "s", "state/tenants/pat-1")).toThrow("neither");
    expect(() => workerPod(template(), "../other", "s", "state/tenants/x")).toThrow("not a credential id");
    expect(() => volumeSubPath(ROOT, "/etc")).toThrow("not a directory under the hosted volume");
    expect(() => volumeSubPath(ROOT, ROOT)).toThrow("not a directory under the hosted volume");
  });
});

describe("the provider", () => {
  test("starts a pod, waits for it to run and its worker to accept, and hands the gateway its address and the credential's paths", async () => {
    let reads = 0;
    const port = await listening();
    const api = fakeApi(() => ({ phase: "Pending" }));
    const workers = new PodWorkers({ client: api.client, template: template(port), mountRoot: ROOT, pollMs: 10 });
    // Running on the third read.
    const started = workers.start({ credential: "pat-1", secret: "s".repeat(64), dir: DIR });
    const timer = setInterval(() => {
      for (const p of api.pods.values()) if (++reads >= 3) p.status = { phase: "Running", podIP: "127.0.0.1" };
    }, 5);
    const h = await started;
    clearInterval(timer);
    expect({ host: h.host, port: h.port, paths: h.paths }).toEqual({ host: "127.0.0.1", port, paths: { state: "/tenant/state", sessions: "/tenant/sessions" } });
    const [pod] = [...api.pods.values()];
    expect(pod!.metadata.labels?.[CREDENTIAL_LABEL]).toBe("pat-1");
    expect(pod!.spec.containers[0]!.volumeMounts?.find((m) => m.name === "tenant")?.subPath).toBe("state/tenants/pat-1");
    await h.stop();
    expect(api.pods.size).toBe(0);
  });

  test("a pod that fails to start is deleted and the start refused", async () => {
    const api = fakeApi(() => ({ phase: "Failed" }));
    const workers = new PodWorkers({ client: api.client, template: template(), mountRoot: ROOT, pollMs: 10 });
    await expect(workers.start({ credential: "pat-1", secret: "s".repeat(64), dir: DIR })).rejects.toThrow("did not start: it ended (Failed)");
    expect(api.pods.size).toBe(0);
    // Running, but nothing accepts on the worker's port.
    const silent = fakeApi();
    await expect(new PodWorkers({ client: silent.client, template: template(1), mountRoot: ROOT, pollMs: 10, startTimeoutMs: 100 }).start({ credential: "pat-1", secret: "s".repeat(64), dir: DIR })).rejects.toThrow("did not accept on its port in time");
    expect(silent.pods.size).toBe(0);
    // A directory outside the volume is refused before any pod is made.
    await expect(workers.start({ credential: "pat-1", secret: "s".repeat(64), dir: "/elsewhere" })).rejects.toThrow("not a directory under the hosted volume");
  });

  test("a worker pod that ends is reported as exited", async () => {
    const api = fakeApi();
    const h = await new PodWorkers({ client: api.client, template: template(await listening()), mountRoot: ROOT, pollMs: 10 }).start({ credential: "pat-1", secret: "s".repeat(64), dir: DIR });
    api.pods.clear();
    const gone = await Promise.race([h.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    expect(gone).toBe(true);
  }, 10_000);

  test("reapStale deletes every worker pod of the release, and nothing else", async () => {
    const api = fakeApi();
    const workers = new PodWorkers({ client: api.client, template: template(await listening()), mountRoot: ROOT, pollMs: 10 });
    await workers.start({ credential: "pat-1", secret: "s".repeat(64), dir: DIR });
    await workers.start({ credential: "sam-1", secret: "s".repeat(64), dir: "/data/hosted/state/tenants/sam-1" });
    api.pods.set("someone-else", { metadata: { name: "someone-else", labels: { "app.kubernetes.io/component": "gateway", "app.kubernetes.io/instance": "wrathbench" } }, spec: { containers: [] } });
    expect(await workers.reapStale()).toBe(2);
    expect([...api.pods.keys()]).toEqual(["someone-else"]);
  });
});

describe("the gateway entry's grants file", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "wb-hosted-grants-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };

  test("is created with the reserved accounts when there is none, and gains any missing later", () => {
    const path = join(dir(), "grants.json");
    expect(ensureGrantsFile(path, ["RUNNER", "SMOKE1"])).toEqual(["RUNNER", "SMOKE1"]);
    expect(existsSync(path)).toBe(true);
    expect(readGrantsFile(path).reservedAccounts).toEqual(["RUNNER", "SMOKE1"]);
    expect(ensureGrantsFile(path, ["runner", "SMOKE1", "POOL01"])).toEqual(["POOL01"]);
    expect(readGrantsFile(path).reservedAccounts).toEqual(["RUNNER", "SMOKE1", "POOL01"]);
    expect(ensureGrantsFile(path, ["RUNNER"])).toEqual([]);
  });

  test("refuses to reserve an account a grant already names", () => {
    const path = join(dir(), "grants.json");
    writeFileSync(path, JSON.stringify({ version: 1, grants: [{ id: "pat-1", person: "pat", keyHashes: [], accounts: ["POOL01"], maxCharacters: 1 }] }));
    expect(() => ensureGrantsFile(path, ["POOL01"])).toThrow("account POOL01 is also in");
  });

  test("reads the chart's reserved list", () => {
    expect(reservedFromEnv({ WRATHBENCH_HOSTED_RESERVED: "RUNNER, SMOKE1,," })).toEqual(["RUNNER", "SMOKE1"]);
    expect(reservedFromEnv({})).toEqual([]);
  });
});
