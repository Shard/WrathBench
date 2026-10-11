/**
 * The run-pod launcher against a fake Kubernetes API (`Bun.serve`, in
 * memory, no cluster): what it creates, what it refuses, what it writes back
 * to the run directory, and how it ends an episode on each path a pod can
 * take. Plus the pure rules it is built from — the image allow-list, the env
 * builder, the launcher choice — and the chart's own rendering of the template
 * when helm is on PATH, because the env builder's guarantees are only as good
 * as the template it is handed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessSeries } from "../runner/src/comparability";
import { chooseLauncher, EPISODE_TERM_GRACE_MS, parseLaunchSpec, type EpisodeLaunch } from "./episode-launcher";
import { K8sClient, type Pod, type PodEnvVar, type PodStatus } from "./k8s-client";
import {
  buildRunPod,
  harnessStampOf,
  IMAGE_ANNOTATION,
  imageRefusal,
  loadPodLauncher,
  parseImageRef,
  PodLauncher,
  readImageRecord,
  ROSTER_PID_LABEL,
  rosterHasRunPod,
  RUN_HASH_LABEL,
  RUN_ID_ANNOTATION,
  RUN_POD_LAUNCHER_ENV,
  RUN_POD_TEMPLATE_ENV,
  runHashLabel,
  runPodEnv,
} from "./run-pod";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();
const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE = "harbor.example/library/wrathbench-runner:harness-0.5-934-ge0ca125f";
const ALLOWED = ["harbor.example/library/wrathbench-runner", "ghcr.io/shard/wrathbench-runner"];
const DIGEST = "sha256:" + "ab".repeat(32);

const secretRef = (name: string, optional = true): PodEnvVar => ({ name, valueFrom: { secretKeyRef: { name: "wrathbench-env", key: name, optional } } });

/** The template the chart renders, in miniature: the same env shape, the same volumes. */
function template(): Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { generateName: "wrathbench-run-", labels: { "app.kubernetes.io/name": "wrathbench", "app.kubernetes.io/instance": "wrathbench", "app.kubernetes.io/component": "run" } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 90,
      containers: [
        {
          name: "run",
          image: RELEASE,
          command: ["/usr/bin/tini", "--"],
          env: [
            { name: "WRATHBENCH_IN_CONTAINER", value: "1" },
            { name: "WRATHBENCH_HARNESS_VERSION", value: "harness-0.5-934-ge0ca125f" },
            { name: "WRATHBENCH_MODULE_URL", value: "http://worldserver:8086" },
            { name: "WRATHBENCH_RUNS_DIR", value: "/wrathbench/data/runs" },
            secretRef("WRATHBENCH_MODULE_SECRET", false),
            secretRef("CLAUDE_CODE_OAUTH_TOKEN"),
            secretRef("CLAUDE_CODE_OAUTH_TOKEN_2"),
            secretRef("OPENROUTER_KEY"),
            secretRef("CEREBRAS_KEY"),
            { name: "CODEX_HOME", value: "/home/bun/.codex" },
          ],
          volumeMounts: [
            { name: "data", mountPath: "/wrathbench/data/runs", subPath: "runs" },
            { name: "data", mountPath: "/wrathbench/data/wiki", subPath: "wiki" },
            { name: "codex-home", mountPath: "/home/bun/.codex" },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: "wrathbench-data" } }, { name: "codex-home", persistentVolumeClaim: { claimName: "wrathbench-codex-home" } }, { name: "tmp", emptyDir: {} }],
    },
  };
}

// ------------------------------------------------------------ the fake API

interface Deletion {
  name: string;
  grace: number;
}

class FakeApi {
  readonly pods = new Map<string, Pod>();
  readonly deletions: Deletion[] = [];
  readonly requests: string[] = [];
  readonly logs = new Map<string, string>();
  /** What a DELETE does to the pod; the default removes it at once. */
  onDelete: (pod: Pod, grace: number) => void = (pod) => {
    this.pods.delete(pod.metadata.name!);
  };
  rejectCreate: string | undefined;
  private counter = 0;
  private readonly server;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        this.requests.push(`${req.method} ${url.pathname}${url.search}`);
        if (req.headers.get("authorization") !== "Bearer fake-token") return status(401, "Unauthorized", "no token");
        const m = /^\/api\/v1\/namespaces\/wrathbench\/pods(?:\/([^/]+))?(\/log)?$/.exec(url.pathname);
        if (m === null) return status(404, "NotFound", `no route ${url.pathname}`);
        const [, name, log] = m;
        if (req.method === "POST" && name === undefined) {
          if (this.rejectCreate !== undefined) return status(403, "Forbidden", this.rejectCreate);
          const body = (await req.json()) as Pod;
          const podName = `${body.metadata.generateName ?? "pod-"}${(++this.counter).toString(36).padStart(5, "x")}`;
          const pod: Pod = { ...body, metadata: { ...body.metadata, name: podName, namespace: "wrathbench", uid: `uid-${this.counter}` }, status: { phase: "Pending" } };
          this.pods.set(podName, pod);
          return Response.json(pod, { status: 201 });
        }
        if (req.method === "GET" && name === undefined) {
          const selector = url.searchParams.get("labelSelector") ?? "";
          const want = selector.split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]);
          const items = [...this.pods.values()].filter((p) => want.every(([k, v]) => p.metadata.labels?.[k] === v));
          return Response.json({ kind: "PodList", items });
        }
        const pod = name === undefined ? undefined : this.pods.get(name);
        if (pod === undefined) return status(404, "NotFound", `pods "${name}" not found`);
        if (req.method === "GET" && log !== undefined) {
          const cs = pod.status?.containerStatuses?.[0]?.state;
          if (cs?.running === undefined && cs?.terminated === undefined) return status(400, "BadRequest", "container is waiting to start");
          return new Response(this.logs.get(pod.metadata.name!) ?? "", { headers: { "content-type": "text/plain" } });
        }
        if (req.method === "GET") return Response.json(pod);
        if (req.method === "DELETE") {
          const opts = (await req.json().catch(() => ({}))) as { gracePeriodSeconds?: number };
          this.deletions.push({ name: pod.metadata.name!, grace: opts.gracePeriodSeconds ?? -1 });
          this.onDelete(pod, opts.gracePeriodSeconds ?? -1);
          return Response.json({ kind: "Status", status: "Success" });
        }
        return status(405, "MethodNotAllowed", req.method);
      },
    });
  }

  get client(): K8sClient {
    return new K8sClient({ baseUrl: `http://127.0.0.1:${this.server.port}`, token: "fake-token", namespace: "wrathbench" });
  }

  /** The one pod created so far. */
  only(): Pod {
    expect(this.pods.size).toBe(1);
    return [...this.pods.values()][0]!;
  }

  setStatus(name: string, s: PodStatus, nodeName = "chungusjr"): void {
    const pod = this.pods.get(name)!;
    pod.status = s;
    pod.spec.nodeName = nodeName;
  }

  stop(): void {
    this.server.stop(true);
  }
}

function status(code: number, reason: string, message: string): Response {
  return Response.json({ kind: "Status", status: "Failure", code, reason, message }, { status: code });
}

const running = (imageID: string): PodStatus => ({
  phase: "Running",
  containerStatuses: [{ name: "run", imageID, state: { running: { startedAt: "2026-10-11T00:00:00Z" } } }],
});
const terminated = (exitCode: number, imageID: string, reason = "Completed"): PodStatus => ({
  phase: exitCode === 0 ? "Succeeded" : "Failed",
  containerStatuses: [{ name: "run", imageID, state: { terminated: { exitCode, reason } } }],
});

const until = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};

function launcher(api: FakeApi, over: Partial<ConstructorParameters<typeof PodLauncher>[0]> = {}): PodLauncher {
  return new PodLauncher({
    client: api.client,
    template: template(),
    allowedImages: ALLOWED,
    owner: { name: "wrathbench-fleet-abc", uid: "fleet-uid" },
    rosterPid: 4242,
    pollMs: 15,
    sink: () => {},
    ...over,
  });
}

function launch(runDir: string, over: Partial<EpisodeLaunch> & { image?: string | null; command?: string[] | null } = {}): EpisodeLaunch {
  const { image, command, ...rest } = over;
  return {
    spec: {
      runId: "fleet-race-probe-1-orc-warrior-sonnet-20260101",
      driver: "claude-code",
      tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_2",
      apiKeyEnv: "OPENROUTER_KEY",
      launch: { pod: true, image: image ?? null, command: command ?? null },
    },
    resume: false,
    runDir,
    argv: ["bun", "/wrathbench/runner/src/run.ts", "--driver", "claude-code", "--model", "sonnet"],
    args: ["--driver", "claude-code", "--model", "sonnet"],
    env: { WRATHBENCH_HARNESS_VERSION: "harness-0.5-934-ge0ca125f" },
    log: () => {},
    ...rest,
  };
}

const envOf = (pod: Pod): Record<string, PodEnvVar> => Object.fromEntries((pod.spec.containers[0]!.env ?? []).map((e) => [e.name, e]));

// --------------------------------------------------------------- image rules

describe("image references and the allow-list", () => {
  test("a tag or a digest under an allowed repository is admitted, matched on the repository alone", () => {
    expect(imageRefusal("ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234-pr12", ALLOWED)).toBeUndefined();
    expect(imageRefusal(`ghcr.io/shard/wrathbench-runner@${DIGEST}`, ALLOWED)).toBeUndefined();
    expect(imageRefusal(`ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234@${DIGEST}`, ALLOWED)).toBeUndefined();
    // A path prefix admits what sits under it; a bare string prefix admits nothing.
    expect(imageRefusal("ghcr.io/shard/wrathbench-runner:v1", ["ghcr.io/shard"])).toBeUndefined();
    expect(imageRefusal("ghcr.io/shard/wrathbench-runner-evil:v1", ALLOWED)).toContain("outside the allowed repositories");
  });

  test("untagged, latest, a foreign repository and a malformed digest are refused by name", () => {
    expect(imageRefusal("ghcr.io/shard/wrathbench-runner", ALLOWED)).toContain("untagged");
    expect(imageRefusal("ghcr.io/shard/wrathbench-runner:latest", ALLOWED)).toContain("mutable tag");
    expect(imageRefusal("docker.io/library/alpine:3.20", ALLOWED)).toContain("outside the allowed repositories");
    expect(imageRefusal("ghcr.io/shard/wrathbench-runner@sha256:abc", ALLOWED)).toContain("digest must be sha256:<64 hex>");
    expect(imageRefusal("not a ref", ALLOWED)).toContain("is not a repository path");
    expect(imageRefusal("", ALLOWED)).toContain("not an image reference");
  });

  test("a registry port is part of the repository, not a tag", () => {
    const r = parseImageRef("registry.local:5000/wb/runner:v1");
    expect("error" in r ? r.error : r.repo).toBe("registry.local:5000/wb/runner");
  });

  test("the harness stamp is the tag, and the PR workflow's tag still names series 0.5", () => {
    const pr = parseImageRef("ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234-pr12");
    if ("error" in pr) throw new Error(pr.error);
    expect(harnessStampOf(pr)).toBe("harness-0.5-940-gabc1234-pr12");
    expect(harnessSeries(harnessStampOf(pr))).toBe("0.5");
    // A digest-only reference has no tag to say which build it was: the stamp
    // is the repository's basename and the digest's head, and names no series.
    const pinned = parseImageRef(`ghcr.io/shard/wrathbench-runner@${DIGEST}`);
    if ("error" in pinned) throw new Error(pinned.error);
    expect(harnessStampOf(pinned)).toBe(`wrathbench-runner@sha256:${"ab".repeat(6)}`);
    expect(harnessSeries(harnessStampOf(pinned))).toBeNull();
  });
});

// --------------------------------------------------------------- env builder

describe("runPodEnv", () => {
  const tpl = template().spec.containers[0]!.env!;
  const names = (env: PodEnvVar[]): string[] => env.map((e) => e.name);
  const secrets = (env: PodEnvVar[]): string[] => env.filter((e) => e.valueFrom?.secretKeyRef !== undefined).map((e) => e.name);

  test("claude-code gets the module secret and its own lane's token, nothing else that is secret", () => {
    const env = runPodEnv(tpl, { driver: "claude-code", tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", apiKeyEnv: "OPENROUTER_KEY", stamps: {} });
    expect(secrets(env).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN_2", "WRATHBENCH_MODULE_SECRET"]);
    expect(names(env)).not.toContain("CODEX_HOME");
    // The default lane when the spec names none.
    expect(secrets(runPodEnv(tpl, { driver: "claude-code", tokenEnv: undefined, apiKeyEnv: "OPENROUTER_KEY", stamps: {} })).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "WRATHBENCH_MODULE_SECRET"]);
  });

  test("openai gets its apiKeyEnv only; codex gets no key at all and keeps its home", () => {
    expect(secrets(runPodEnv(tpl, { driver: "openai", tokenEnv: undefined, apiKeyEnv: "CEREBRAS_KEY", stamps: {} })).sort()).toEqual(["CEREBRAS_KEY", "WRATHBENCH_MODULE_SECRET"]);
    const codex = runPodEnv(tpl, { driver: "codex", tokenEnv: undefined, apiKeyEnv: "OPENROUTER_KEY", stamps: {} });
    expect(secrets(codex)).toEqual(["WRATHBENCH_MODULE_SECRET"]);
    expect(names(codex)).toContain("CODEX_HOME");
  });

  test("the plain values survive and the stamps win", () => {
    const env = runPodEnv(tpl, { driver: "openai", tokenEnv: undefined, apiKeyEnv: "OPENROUTER_KEY", stamps: { WRATHBENCH_HARNESS_VERSION: "harness-0.5-940-gabc1234-pr12", WRATHBENCH_RUN_IMAGE: "x:y" } });
    const by = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(by["WRATHBENCH_IN_CONTAINER"]).toBe("1");
    expect(by["WRATHBENCH_MODULE_URL"]).toBe("http://worldserver:8086");
    expect(by["WRATHBENCH_HARNESS_VERSION"]).toBe("harness-0.5-940-gabc1234-pr12");
    expect(by["WRATHBENCH_RUN_IMAGE"]).toBe("x:y");
    expect(names(env).filter((n) => n === "WRATHBENCH_HARNESS_VERSION").length).toBe(1);
  });

  test("no ANTHROPIC_* variable can reach a run pod, from the template or a stamp", () => {
    const opts = { driver: "claude-code" as const, tokenEnv: undefined, apiKeyEnv: "OPENROUTER_KEY", stamps: {} };
    expect(() => runPodEnv([...tpl, { name: "ANTHROPIC_API_KEY", value: "sk-ant" }], opts)).toThrow(/ANTHROPIC_API_KEY may never reach a run pod/);
    expect(() => runPodEnv([...tpl, secretRef("ANTHROPIC_AUTH_TOKEN")], opts)).toThrow(/ANTHROPIC_AUTH_TOKEN/);
    expect(() => runPodEnv(tpl, { ...opts, stamps: { ANTHROPIC_BASE_URL: "https://example.invalid" } })).toThrow(/ANTHROPIC_BASE_URL/);
  });
});

// --------------------------------------------------------------- pod builder

describe("buildRunPod", () => {
  const base = { runId: "fleet-race-probe-1-orc-warrior-sonnet-20260101", image: RELEASE, requestedRef: RELEASE, command: null, args: ["--resume", "x"], env: { driver: "claude-code" as const, tokenEnv: undefined, apiKeyEnv: "OPENROUTER_KEY", stamps: {} }, owner: { name: "wrathbench-fleet-abc", uid: "fleet-uid" }, rosterPid: 77, graceMs: EPISODE_TERM_GRACE_MS };

  test("labels, annotations, the owner reference and the grace", () => {
    const pod = buildRunPod(template(), base);
    expect(pod.metadata.labels!["app.kubernetes.io/component"]).toBe("run");
    expect(pod.metadata.labels![RUN_HASH_LABEL]).toBe(runHashLabel(base.runId));
    expect(pod.metadata.labels![RUN_HASH_LABEL]).toMatch(/^[0-9a-f]{16}$/);
    expect(pod.metadata.labels![ROSTER_PID_LABEL]).toBe("77");
    expect(pod.metadata.annotations![RUN_ID_ANNOTATION]).toBe(base.runId);
    expect(pod.metadata.annotations![IMAGE_ANNOTATION]).toBe(RELEASE);
    expect(pod.metadata.ownerReferences).toEqual([{ apiVersion: "v1", kind: "Pod", name: "wrathbench-fleet-abc", uid: "fleet-uid" }]);
    expect(pod.spec.terminationGracePeriodSeconds).toBe(90);
    expect(pod.metadata.generateName).toBe("wrathbench-run-");
    // The template is not mutated.
    expect(template().metadata.labels![RUN_HASH_LABEL]).toBeUndefined();
  });

  test("the default command is tini plus this runner; an arm's command replaces the whole thing", () => {
    expect(buildRunPod(template(), base).spec.containers[0]!.command).toEqual(["/usr/bin/tini", "--", "bun", "runner/src/run.ts"]);
    expect(buildRunPod(template(), base).spec.containers[0]!.args).toEqual(["--resume", "x"]);
    expect(buildRunPod(template(), { ...base, command: ["/app/harness"] }).spec.containers[0]!.command).toEqual(["/app/harness"]);
  });

  test("the codex home volume is mounted for the codex driver only", () => {
    const claude = buildRunPod(template(), base);
    expect(claude.spec.volumes!.map((v) => v.name)).toEqual(["data", "tmp"]);
    expect(claude.spec.containers[0]!.volumeMounts!.map((m) => m.name)).not.toContain("codex-home");
    const codex = buildRunPod(template(), { ...base, env: { ...base.env, driver: "codex" } });
    expect(codex.spec.volumes!.map((v) => v.name)).toContain("codex-home");
    expect(codex.spec.containers[0]!.volumeMounts!.map((m) => m.name)).toContain("codex-home");
  });

  test("pull secrets are added to the template's, never duplicated", () => {
    const tpl = template();
    tpl.spec["imagePullSecrets"] = [{ name: "harbor" }];
    const pod = buildRunPod(tpl, { ...base, extraPullSecrets: ["ghcr-pull", "harbor"] });
    expect(pod.spec["imagePullSecrets"]).toEqual([{ name: "harbor" }, { name: "ghcr-pull" }]);
  });
});

// ------------------------------------------------------------------- choice

describe("chooseLauncher", () => {
  const pinned = { pod: true as const, image: "ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234-pr12", command: null };
  const floating = { pod: true as const, image: null, command: null };

  test("no launch field is always a child process", () => {
    expect(chooseLauncher({ runPods: "probes", onCluster: true, launch: undefined })).toEqual({ kind: "process" });
    expect(chooseLauncher({ runPods: "off", onCluster: false, launch: undefined })).toEqual({ kind: "process" });
  });

  test("a pod iff the setting is on and we are on the cluster", () => {
    expect(chooseLauncher({ runPods: "probes", onCluster: true, launch: floating })).toEqual({ kind: "pod" });
    expect(chooseLauncher({ runPods: "probes", onCluster: true, launch: pinned })).toEqual({ kind: "pod" });
  });

  test("an image-less arm falls back to a child process; a pinned arm is refused, naming why", () => {
    expect(chooseLauncher({ runPods: "off", onCluster: true, launch: floating })).toEqual({ kind: "process" });
    expect(chooseLauncher({ runPods: "probes", onCluster: false, launch: floating })).toEqual({ kind: "process" });
    const off = chooseLauncher({ runPods: "off", onCluster: true, launch: pinned });
    expect(off.kind).toBe("refused");
    expect(off.kind === "refused" ? off.reason : "").toContain('policy.runPods is "off"');
    const host = chooseLauncher({ runPods: "probes", onCluster: false, launch: pinned });
    expect(host.kind === "refused" ? host.reason : "").toContain("not on the cluster");
  });

  test("parseLaunchSpec admits the seam's shape and nothing more", () => {
    expect(parseLaunchSpec({ pod: true, image: null, command: null }, "x")).toEqual(floating);
    expect(parseLaunchSpec({ pod: true, image: pinned.image, command: ["/app/h"] }, "x")).toEqual({ ...pinned, command: ["/app/h"] });
    expect(() => parseLaunchSpec({ pod: false, image: null, command: null }, "x")).toThrow(/launch.pod must be true/);
    expect(() => parseLaunchSpec({ pod: true, image: "", command: null }, "x")).toThrow(/launch.image/);
    expect(() => parseLaunchSpec({ pod: true, image: null, command: [] }, "x")).toThrow(/launch.command/);
    expect(() => parseLaunchSpec({ pod: true, image: null, command: null, args: [] }, "x")).toThrow(/launch.args is not a key/);
  });
});

// ------------------------------------------------------------- the launcher

describe("PodLauncher against a fake API", () => {
  test("create, start, digest capture, log follow, exit code, cleanup", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const lines: string[] = [];
      const out: string[] = [];
      const h = await launcher(api, { sink: (c) => out.push(new TextDecoder().decode(c)) }).start(launch(dir, { log: (l) => lines.push(l) }));
      const pod = api.only();
      const name = pod.metadata.name!;
      expect(h.describe()).toContain(name);
      // What was created: the release image, the owner, the stamps, this driver's secrets only.
      expect(pod.spec.containers[0]!.image).toBe(RELEASE);
      expect(pod.metadata.ownerReferences![0]!.uid).toBe("fleet-uid");
      const env = envOf(pod);
      expect(env["WRATHBENCH_HARNESS_VERSION"]!.value).toBe("harness-0.5-934-ge0ca125f");
      expect(env["WRATHBENCH_RUN_IMAGE"]!.value).toBe(RELEASE);
      expect(Object.keys(env).filter((n) => env[n]!.valueFrom !== undefined).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN_2", "WRATHBENCH_MODULE_SECRET"]);
      expect(Object.keys(env).some((n) => n.startsWith("ANTHROPIC_"))).toBe(false);
      expect(pod.spec.containers[0]!.args).toEqual(["--driver", "claude-code", "--model", "sonnet"]);

      api.logs.set(name, "[wrathbench] hello from the pod\n");
      api.setStatus(name, running(`harbor.example/library/wrathbench-runner@${DIGEST}`));
      await until(() => existsSync(join(dir, "image.json")));
      const record = readImageRecord(dir)!;
      expect(record).toMatchObject({ ref: RELEASE, digest: DIGEST, pod: name, node: "chungusjr" });
      expect(record.startedAt).toBeGreaterThan(0);
      await until(() => out.join("").includes("hello from the pod"));
      expect(lines.some((l) => l.includes(`running on chungusjr`) && l.includes(DIGEST))).toBe(true);

      api.setStatus(name, terminated(7, `harbor.example/library/wrathbench-runner@${DIGEST}`, "Error"));
      expect(await h.exited).toEqual({ code: 7 });
      // Cleaned up: the finished pod is deleted at once, with no grace.
      expect(api.deletions).toEqual([{ name, grace: 0 }]);
      expect(api.pods.size).toBe(0);
    } finally {
      api.stop();
    }
  });

  test("an image that will not pull ends the attempt as a launch failure, with the reason, and no image.json", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const h = await launcher(api).start(launch(dir, { image: "ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234-pr12" }));
      const name = api.only().metadata.name!;
      api.setStatus(name, { phase: "Pending", containerStatuses: [{ name: "run", state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } } }] });
      const exit = await h.exited;
      expect(exit.code).toBe(1);
      expect(exit.failure).toContain("ImagePullBackOff");
      expect(exit.failure).toContain("ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234-pr12");
      expect(api.pods.size).toBe(0);
      expect(existsSync(join(dir, "image.json"))).toBe(false);
    } finally {
      api.stop();
    }
  });

  test("unschedulable and a pod that stays Pending are bounded, not hung", async () => {
    const api = new FakeApi();
    try {
      let t = 0;
      const now = (): number => (t += 1_000);
      const dir = join(tempDir("wb-run-pod-"), "run");
      const h = await launcher(api, { now, unschedulableMaxMs: 5_000 }).start(launch(dir));
      const name = api.only().metadata.name!;
      api.setStatus(name, { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available" }] });
      const exit = await h.exited;
      expect(exit.failure).toContain("unschedulable");
      expect(exit.failure).toContain("0/1 nodes are available");

      const api2 = new FakeApi();
      try {
        const h2 = await launcher(api2, { now, pendingMaxMs: 4_000 }).start(launch(dir));
        const exit2 = await h2.exited;
        expect(exit2.failure).toContain("still Pending");
        expect(api2.pods.size).toBe(0);
      } finally {
        api2.stop();
      }
    } finally {
      api.stop();
    }
  });

  test("an eviction is a failure with the kubelet's message, after the container ran", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const h = await launcher(api).start(launch(dir));
      const name = api.only().metadata.name!;
      api.setStatus(name, running(`x@${DIGEST}`));
      await until(() => existsSync(join(dir, "image.json")));
      api.setStatus(name, { phase: "Failed", reason: "Evicted", message: "The node was low on resource: ephemeral-storage." });
      const exit = await h.exited;
      expect(exit.code).toBe(1);
      expect(exit.failure).toContain("Evicted");
      expect(exit.failure).toContain("ephemeral-storage");
    } finally {
      api.stop();
    }
  });

  test("stop() deletes the pod with the episode grace and waits for it to be gone", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      // The kubelet's SIGTERM reaches run.ts, which pauses and exits 130; the object then goes.
      api.onDelete = (pod, grace) => {
        if (grace > 0) {
          pod.metadata.deletionTimestamp = "2026-10-11T00:00:01Z";
          pod.status = terminated(130, `x@${DIGEST}`, "Error");
        } else api.pods.delete(pod.metadata.name!);
      };
      const h = await launcher(api).start(launch(dir));
      const name = api.only().metadata.name!;
      api.setStatus(name, running(`x@${DIGEST}`));
      await until(() => existsSync(join(dir, "image.json")));
      await h.stop(EPISODE_TERM_GRACE_MS);
      expect(api.deletions[0]).toEqual({ name, grace: 90 });
      expect(await h.exited).toEqual({ code: 130 });
      expect(api.pods.size).toBe(0);
    } finally {
      api.stop();
    }
  });

  test("a pod that vanishes without an exit (the garbage collector, an operator) is reported, not waited on", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const h = await launcher(api).start(launch(dir));
      api.pods.clear();
      const exit = await h.exited;
      expect(exit.code).toBe(1);
      expect(exit.failure).toContain("disappeared");
    } finally {
      api.stop();
    }
  });

  test("an explicit image is stamped as itself, never as master, and recorded as requested", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const ref = "ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234-pr12";
      const h = await launcher(api).start(launch(dir, { image: ref, command: ["/app/harness", "serve"] }));
      const pod = api.only();
      expect(pod.spec.containers[0]!.image).toBe(ref);
      expect(pod.spec.containers[0]!.command).toEqual(["/app/harness", "serve"]);
      expect(envOf(pod)["WRATHBENCH_HARNESS_VERSION"]!.value).toBe("harness-0.5-940-gabc1234-pr12");
      expect(envOf(pod)["WRATHBENCH_RUN_IMAGE"]!.value).toBe(ref);
      expect(pod.metadata.annotations![IMAGE_ANNOTATION]).toBe(ref);
      api.setStatus(pod.metadata.name!, terminated(0, `ghcr.io/shard/wrathbench-runner@${DIGEST}`));
      expect(await h.exited).toEqual({ code: 0 });
    } finally {
      api.stop();
    }
  });

  test("a resume relaunches the digest in image.json whatever the arm says now, stamped with the first run's tag", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      mkdirSync(dir, { recursive: true });
      const first = "ghcr.io/shard/wrathbench-runner:harness-0.5-940-gabc1234-pr12";
      writeFileSync(join(dir, "image.json"), JSON.stringify({ ref: first, digest: DIGEST, pod: "old", node: "chungusjr", startedAt: 1 }));
      const lines: string[] = [];
      const h = await launcher(api).start(launch(dir, { resume: true, image: "ghcr.io/shard/wrathbench-runner:harness-0.5-999-gfffffff-pr12", log: (l) => lines.push(l), args: ["--resume", "x"] }));
      const pod = api.only();
      expect(pod.spec.containers[0]!.image).toBe(`ghcr.io/shard/wrathbench-runner@${DIGEST}`);
      expect(envOf(pod)["WRATHBENCH_HARNESS_VERSION"]!.value).toBe("harness-0.5-940-gabc1234-pr12");
      expect(envOf(pod)["WRATHBENCH_RUN_IMAGE"]!.value).toBe(first);
      expect(lines.some((l) => l.includes("relaunching the digest it first ran"))).toBe(true);
      api.setStatus(pod.metadata.name!, terminated(0, `ghcr.io/shard/wrathbench-runner@${DIGEST}`));
      await h.exited;
      // The record is rewritten by the new pod, same digest.
      expect(readImageRecord(dir)!.digest).toBe(DIGEST);
    } finally {
      api.stop();
    }
  });

  test("a resume with no image.json launches the arm's image like a fresh run", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const h = await launcher(api).start(launch(dir, { resume: true }));
      expect(api.only().spec.containers[0]!.image).toBe(RELEASE);
      api.pods.clear();
      await h.exited;
    } finally {
      api.stop();
    }
  });

  test("an image outside the allow-list, or a create the API refuses, never becomes a pod: exit 2 with the reason", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const h = await launcher(api).start(launch(dir, { image: "docker.io/library/alpine:3.20" }));
      const exit = await h.exited;
      expect(exit.code).toBe(2);
      expect(exit.failure).toContain("outside the allowed repositories");
      expect(api.requests.filter((r) => r.startsWith("POST"))).toEqual([]);

      api.rejectCreate = "pods is forbidden: User cannot create resource";
      const h2 = await launcher(api).start(launch(dir));
      const exit2 = await h2.exited;
      expect(exit2.code).toBe(2);
      expect(exit2.failure).toContain("cannot create resource");
    } finally {
      api.stop();
    }
  });

  test("rosterHasRunPod sees its own roster's live pods and not another's or a finished one", async () => {
    const api = new FakeApi();
    try {
      const dir = join(tempDir("wb-run-pod-"), "run");
      const h = await launcher(api, { rosterPid: 4242 }).start(launch(dir));
      expect(await rosterHasRunPod(api.client, 4242)).toBe(true);
      expect(await rosterHasRunPod(api.client, 4243)).toBe(false);
      api.setStatus(api.only().metadata.name!, terminated(0, `x@${DIGEST}`));
      await h.exited;
      expect(await rosterHasRunPod(api.client, 4242)).toBe(false);
    } finally {
      api.stop();
    }
  });

  test("loadPodLauncher reads the mounted template and settings, and says what is missing", () => {
    const api = new FakeApi();
    try {
      const dir = tempDir("wb-run-pod-");
      writeFileSync(join(dir, "pod.json"), JSON.stringify(template()));
      writeFileSync(join(dir, "launcher.json"), JSON.stringify({ allowedImages: ALLOWED, imagePullSecrets: ["ghcr-pull"] }));
      const env = { [RUN_POD_TEMPLATE_ENV]: join(dir, "pod.json"), [RUN_POD_LAUNCHER_ENV]: join(dir, "launcher.json"), POD_NAME: "wrathbench-fleet-abc", POD_UID: "fleet-uid" };
      const l = loadPodLauncher({ rosterPid: 1, env, client: api.client });
      expect("error" in l).toBe(false);
      if (!("error" in l)) {
        expect(l.opts.allowedImages).toEqual(ALLOWED);
        expect(l.opts.imagePullSecrets).toEqual(["ghcr-pull"]);
        expect(l.opts.owner).toEqual({ name: "wrathbench-fleet-abc", uid: "fleet-uid" });
      }
      const missing = loadPodLauncher({ rosterPid: 1, env: { ...env, [RUN_POD_TEMPLATE_ENV]: join(dir, "nope.json") }, client: api.client });
      expect("error" in missing ? missing.error : "").toContain("older than run pods");
      expect("error" in loadPodLauncher({ rosterPid: 1, env, client: null }) ? "" : "x").toBe("");
    } finally {
      api.stop();
    }
  });
});

// -------------------------------------------------------------------- chart

describe("the chart's run-pod template", () => {
  const chart = join(REPO_ROOT, "infra", "chart", "wrathbench");
  const runPods = readFileSync(join(chart, "templates", "run-pods.yaml"), "utf8");
  const fleet = readFileSync(join(chart, "templates", "fleet.yaml"), "utf8");
  /** The pod template's own define, without the file's prose around it. */
  const podDefine = runPods.slice(runPods.indexOf('{{- define "wrathbench.runPodTemplate" -}}'), runPods.indexOf("{{- end -}}"));

  test("the template carries no database env, no config store and no ANTHROPIC variable; the fleet runs as its ServiceAccount", () => {
    expect(podDefine.length).toBeGreaterThan(100);
    expect(podDefine).not.toContain("wrathbench.dbEnv");
    expect(podDefine).not.toContain("subPath: config");
    expect(podDefine).not.toMatch(/ANTHROPIC_/);
    expect(podDefine).toContain('include "wrathbench.runEnv"');
    expect(podDefine).toContain("restartPolicy: Never");
    expect(podDefine).toContain("automountServiceAccountToken: false");
    expect(fleet).toContain("serviceAccountName: {{ include \"wrathbench.fullname\" . }}-fleet");
    expect(fleet).toContain("/etc/wrathbench/run-pod/pod.json");
    // The pod's grace is the episode's.
    const m = /terminationGracePeriodSeconds:\s*(\d+)/.exec(runPods);
    expect(Number(m![1]) * 1000).toBe(EPISODE_TERM_GRACE_MS);
  });

  test("the Role is pods and pods/log in the release namespace, bound to the fleet's ServiceAccount", () => {
    expect(runPods).toContain("kind: Role\n");
    expect(runPods).not.toContain("ClusterRole");
    expect(runPods).toContain('resources: ["pods"]');
    expect(runPods).toContain('resources: ["pods/log"]');
    expect(runPods).toContain("namespace: {{ .Release.Namespace }}");
  });

  const helm = Bun.which("helm");

  test.skipIf(helm === null)("rendered, every WrathBench-image pod carries the chart-wide pull Secrets, and run pods add their own once each", () => {
    const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, "--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-934-ge0ca125f", "--set", "imagePullSecrets={wrathbench-harbor-pull}", "--set", "runPods.imagePullSecrets={ghcr-pull,wrathbench-harbor-pull}"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const docs = r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: Record<string, unknown> }; jobTemplate?: unknown } } | null);
    const specOf = (kind: string, name: string): Record<string, unknown> => {
      const d = docs.find((x) => x?.kind === kind && x.metadata?.name === name);
      expect(d, `${kind}/${name} renders`).toBeDefined();
      return d!.spec!.template!.spec!;
    };
    const want = [{ name: "wrathbench-harbor-pull" }];
    for (const name of ["fleet", "runner", "viewer", "publisher", "collector", "worldserver", "authserver"]) {
      expect(specOf("Deployment", `wrathbench-${name}`)["imagePullSecrets"], name).toEqual(want);
    }
    for (const d of docs) if (d?.kind === "Job") expect(d.spec!.template!.spec!["imagePullSecrets"], d.metadata!.name).toEqual(want);
    // Upstream public images: the database pods carry none, and do not move.
    expect(specOf("Deployment", "wrathbench-db")["imagePullSecrets"]).toBeUndefined();
    expect(specOf("StatefulSet", "wrathbench-clickhouse")["imagePullSecrets"]).toBeUndefined();
    const cm = docs.find((x) => x?.kind === "ConfigMap" && x.metadata?.name === "wrathbench-run-pod-template") as { data: { "pod.json": string } } | undefined;
    expect(cm).toBeDefined();
    const tpl = JSON.parse(cm!.data["pod.json"]) as Pod;
    expect(tpl.spec["imagePullSecrets"]).toEqual([{ name: "wrathbench-harbor-pull" }, { name: "ghcr-pull" }]);
    // The default renders no key on any pod spec at all (a public registry).
    const plain = Bun.spawnSync([helm!, "template", "wrathbench", chart, "--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=t-1-gabcdef0"], { stdout: "pipe", stderr: "pipe" });
    expect(plain.exitCode).toBe(0);
    const plainDocs = plain.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: Record<string, unknown> } }; data?: Record<string, string> } | null);
    for (const d of plainDocs) {
      if (d?.spec?.template?.spec !== undefined) expect(d.spec.template.spec["imagePullSecrets"], `${d.kind}/${d.metadata?.name}`).toBeUndefined();
    }
    const plainCm = plainDocs.find((x) => x?.kind === "ConfigMap" && x.metadata?.name === "wrathbench-run-pod-template");
    expect((JSON.parse(plainCm!.data!["pod.json"]!) as Pod).spec["imagePullSecrets"]).toBeUndefined();
  });

  test.skipIf(helm === null)("rendered, the template builds a pod the env builder accepts, with only this driver's secrets", () => {
    const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, "--namespace", "wrathbench", "--set", "image.registry=harbor.example/library", "--set", "image.tag=harness-0.5-934-ge0ca125f", "--set", "runPods.allowedImages={harbor.example/library/wrathbench-runner,ghcr.io/shard/wrathbench-runner}", "--set", "runPods.imagePullSecrets={ghcr-pull}"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const docs = r.stdout.toString().split(/^---$/m);
    const cm = docs.find((d) => d.includes("name: wrathbench-run-pod-template"));
    expect(cm).toBeDefined();
    const podJson = cm!.slice(cm!.indexOf("pod.json: |") + "pod.json: |".length, cm!.indexOf("launcher.json: |"));
    const tpl = JSON.parse(podJson.split("\n").map((l) => l.replace(/^ {4}/, "")).join("\n")) as Pod;
    const launcherJson = JSON.parse(cm!.slice(cm!.indexOf("launcher.json: |") + "launcher.json: |".length).split("\n").map((l) => l.replace(/^ {4}/, "")).join("\n")) as { allowedImages: string[]; imagePullSecrets: string[] };
    expect(launcherJson).toEqual({ allowedImages: ["harbor.example/library/wrathbench-runner", "ghcr.io/shard/wrathbench-runner"], imagePullSecrets: ["ghcr-pull"] });

    expect(tpl.spec["restartPolicy"]).toBe("Never");
    expect(tpl.spec["automountServiceAccountToken"]).toBe(false);
    expect((tpl.spec["securityContext"] as { seccompProfile: { type: string } }).seccompProfile.type).toBe("RuntimeDefault");
    expect(tpl.spec["imagePullSecrets"]).toEqual([{ name: "ghcr-pull" }]);
    const names = tpl.spec.containers[0]!.env!.map((e) => e.name);
    expect(names.some((n) => n.startsWith("ANTHROPIC_") || n.startsWith("WRATHBENCH_DB_"))).toBe(false);
    expect(names).not.toContain("WRATHBENCH_CONFIG_DB");
    expect(tpl.spec.containers[0]!.volumeMounts!.some((m) => m.subPath === "config")).toBe(false);
    expect(tpl.spec.containers[0]!.image).toBe(RELEASE);

    const pod = buildRunPod(tpl, { runId: "r", image: RELEASE, requestedRef: RELEASE, command: null, args: [], env: { driver: "claude-code", tokenEnv: undefined, apiKeyEnv: "OPENROUTER_KEY", stamps: {} }, owner: undefined, rosterPid: 1, graceMs: EPISODE_TERM_GRACE_MS });
    const env = envOf(pod);
    expect(Object.keys(env).filter((n) => env[n]!.valueFrom !== undefined).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "WRATHBENCH_MODULE_SECRET"]);
    expect(pod.spec.containers[0]!.command).toEqual(["/usr/bin/tini", "--", "bun", "runner/src/run.ts"]);
    expect(pod.spec.volumes!.map((v) => v.name)).toEqual(["data", "tmp"]);
  });
});
