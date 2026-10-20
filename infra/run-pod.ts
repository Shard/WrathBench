/**
 * The pod launcher: one episode as one Kubernetes pod, created from the
 * chart's template and watched until it ends.
 *
 * The chart renders the template (ConfigMap `<release>-run-pod-template`,
 * mounted into the fleet pod): volumes, nodeSelector, security context,
 * tini, the enumerated secret references, the harness env, the resources.
 * Cluster specifics stay in the chart; this file fills in only what differs
 * per episode — image, command, args, env stamps, labels — and strips what the
 * episode's driver does not use. Two of those strips are the point of running
 * a pod rather than a child of the fleet process, whose environment every run
 * inherits whole: a run pod carries the module secret and the one model key or
 * lane token its driver bills, and nothing else; and no `ANTHROPIC_*` variable
 * can reach it at all (claude-code is subscription-only), nor any SOAP or
 * STAGER one (the party stager's admin console and credential), which
 * `runPodEnv` enforces by throwing rather than filtering.
 *
 * Images are refused unless their repository is in the chart's allow-list
 * (`runPods.allowedImages`; the release runner by default, GHCR's copy of it on
 * the cluster), tagged or digest-pinned, never `:latest` — so a store write
 * cannot run an arbitrary image with the fleet's tokens. Every run records the
 * digest it actually ran (`runs/<id>/image.json`) and a resume relaunches that
 * digest whatever its arm says now, because harness drift between builds is as
 * large as model differences and a resumed run is still one run.
 *
 * Waits are bounded. A pod that will not pull, cannot be scheduled, or is
 * evicted ends the attempt as a launch failure with the reason, never as a
 * hang the roster waits out all night.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRIVER_POD_VOLUMES, entryOf, HOME_LANE_ENVS, type RosterDriver } from "../runner/src/drivers";
import type { EpisodeExit, EpisodeHandle, EpisodeLaunch, EpisodeLauncher } from "./episode-launcher";
import { EPISODE_TERM_GRACE_MS, refusedEpisode } from "./episode-launcher";
import { digestOf, K8sClient, K8sError, type Pod, type PodEnvVar } from "./k8s-client";

// ------------------------------------------------------------------ names

/** The pods a drain and the deploy scripts select on: `app.kubernetes.io/component=run`. */
export const RUN_POD_COMPONENT = "run";
const LABEL_PREFIX = "wrathbench.shard.page/";
/** A run id can exceed 63 characters, so the label is its hash and the id is an annotation. */
export const RUN_HASH_LABEL = `${LABEL_PREFIX}run`;
/** The roster process that owns the pod, so the fleet's drain can ask "does this roster have an episode in flight". */
export const ROSTER_PID_LABEL = `${LABEL_PREFIX}roster-pid`;
export const RUN_ID_ANNOTATION = `${LABEL_PREFIX}run-id`;
/** The image as the arm (or the release) named it, before digest resolution. */
export const IMAGE_ANNOTATION = `${LABEL_PREFIX}image`;
/** This repository's runner, when an arm names no command. */
export const DEFAULT_RUN_COMMAND = ["bun", "runner/src/run.ts"];
/** Where the chart mounts the rendered template and the launcher's own settings into the fleet pod. */
export const RUN_POD_TEMPLATE_ENV = "WRATHBENCH_RUN_POD_TEMPLATE";
export const RUN_POD_LAUNCHER_ENV = "WRATHBENCH_RUN_POD_LAUNCHER";
export const DEFAULT_RUN_POD_TEMPLATE = "/etc/wrathbench/run-pod/pod.json";
export const DEFAULT_RUN_POD_LAUNCHER = "/etc/wrathbench/run-pod/launcher.json";
export const IMAGE_RECORD_FILE = "image.json";
/** The name of the codex lane's volume in the template; dropped for every other driver. */
const CODEX_HOME_VOLUME = "codex-home";

export function runHashLabel(runId: string): string {
  return new Bun.CryptoHasher("sha256").update(runId).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------ images

export interface ImageRef {
  /** The whole reference as given. */
  ref: string;
  /** Registry, project and name — everything before the tag or digest. */
  repo: string;
  tag: string | undefined;
  digest: string | undefined;
}

/** Split an OCI reference. Returns a reason when it is not one. */
export function parseImageRef(ref: string): ImageRef | { error: string } {
  if (typeof ref !== "string" || ref.trim().length !== ref.length || ref.length === 0) return { error: `not an image reference: ${JSON.stringify(ref)}` };
  let rest = ref;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return { error: `${ref}: the digest must be sha256:<64 hex>` };
  }
  let tag: string | undefined;
  const slash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return { error: `${ref}: ${JSON.stringify(tag)} is not a tag` };
  }
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:(?::[0-9]+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(rest)) {
    return { error: `${ref}: ${JSON.stringify(rest)} is not a repository path` };
  }
  return { ref, repo: rest, tag, digest };
}

/**
 * Why an image may not be launched, or undefined when it may. `allowedImages`
 * are repositories: a reference matches when its repository IS one of them or
 * sits under one (`ghcr.io/shard` admits `ghcr.io/shard/wrathbench-runner`),
 * never on a bare string prefix, so `…/wrathbench-runner-x` is not admitted by
 * `…/wrathbench-runner`. A tag or a digest is required and `latest` is refused:
 * a run must be able to say which build it ran.
 */
export function imageRefusal(ref: string, allowedImages: readonly string[]): string | undefined {
  const parsed = parseImageRef(ref);
  if ("error" in parsed) return parsed.error;
  if (parsed.tag === undefined && parsed.digest === undefined) return `${ref} is untagged — pin a tag or a digest`;
  if (parsed.tag === "latest") return `${ref}: a mutable tag is not a build; pin the tag or the digest`;
  const admitted = allowedImages.some((a) => parsed.repo === a || parsed.repo.startsWith(`${a.replace(/\/$/, "")}/`));
  if (!admitted) {
    return `${ref} is outside the allowed repositories (${allowedImages.join(", ") || "none configured"}) — chart value runPods.allowedImages`;
  }
  return undefined;
}

/**
 * The harness stamp a pinned image gives its runs: its tag, which for an image
 * built by `infra/build-images.sh` or the PR workflow is the `git describe` of
 * its source (`harness-0.5-940-gabc1234`, `…-pr12`) and therefore still names a
 * series. A digest-only reference has no tag to say which build it was, so the
 * stamp is `<repository basename>@sha256:<12 hex>`; that stamp names no series,
 * and such a run is grouped by its campaign and arm alone.
 */
export function harnessStampOf(image: ImageRef): string {
  if (image.tag !== undefined) return image.tag;
  const base = image.repo.slice(image.repo.lastIndexOf("/") + 1);
  return `${base}@${image.digest!.slice(0, "sha256:".length + 12)}`;
}

// -------------------------------------------------------------- image.json

export interface ImageRecord {
  /** The reference the pod was created with (the arm's, or the release's). */
  ref: string;
  /** `sha256:…` as the node resolved it, from the container's `imageID`. */
  digest: string;
  pod: string;
  node: string;
  startedAt: number;
}

export function readImageRecord(runDir: string): ImageRecord | undefined {
  const path = join(runDir, IMAGE_RECORD_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<ImageRecord>;
    if (typeof r.ref !== "string" || typeof r.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(r.digest)) return undefined;
    return { ref: r.ref, digest: r.digest, pod: typeof r.pod === "string" ? r.pod : "", node: typeof r.node === "string" ? r.node : "", startedAt: typeof r.startedAt === "number" ? r.startedAt : 0 };
  } catch {
    return undefined;
  }
}

function writeImageRecord(runDir: string, record: ImageRecord): void {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, IMAGE_RECORD_FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

// ------------------------------------------------------------- env builder

export interface RunPodEnvOptions {
  driver: RosterDriver;
  tokenEnv: string | undefined;
  apiKeyEnv: string;
  /** Plain values set last, over the template's. */
  stamps: Record<string, string>;
}

/**
 * The template's env with every credential the driver does not bill removed,
 * then the stamps. A `secretKeyRef` survives only as the module secret or the
 * one key this driver reads: claude-code its lane's OAuth token, openai its
 * `apiKeyEnv`, codex nothing (its lane is the mounted home directory, named by
 * a plain variable that survives only for codex). Anything `ANTHROPIC_*` is
 * refused outright, template or stamp: there is no run that may carry one.
 */
export function runPodEnv(template: readonly PodEnvVar[], opts: RunPodEnvOptions): PodEnvVar[] {
  const driver = entryOf(opts.driver);
  const lane = driver.lane?.holds === "token" ? opts.tokenEnv ?? driver.lane.defaultEnv : undefined;
  const homeLane = driver.lane?.holds === "home" ? opts.tokenEnv ?? driver.lane.defaultEnv : undefined;
  const keep = new Set<string>(["WRATHBENCH_MODULE_SECRET"]);
  if (lane !== undefined) keep.add(lane);
  if (driver.endpoint) keep.add(opts.apiKeyEnv);
  // Checked on the inputs, not the output: a template that carries one is
  // wrong for every driver, and must fail before a single pod is built from it.
  for (const name of [...template.map((e) => e.name), ...Object.keys(opts.stamps)]) {
    if (name.startsWith("ANTHROPIC_")) throw new Error(`run pod env: ${name} may never reach a run pod (claude-code is subscription-only)`);
    // The party stager's SOAP console and its admin credential are the
    // fleet's and the runner's, never an episode's (docs/proposals/GROUP-PLAY.md §3).
    if (/SOAP|STAGER/.test(name)) throw new Error(`run pod env: ${name} may never reach a run pod (SOAP and the STAGER credential are the stager's alone)`);
  }
  const out: PodEnvVar[] = [];
  for (const e of template) {
    if (e.valueFrom?.secretKeyRef !== undefined && !keep.has(e.name)) continue;
    // The codex lane's directory is a plain value; it is still a credential's
    // address and goes only to the driver that reads it.
    if (HOME_LANE_ENVS.includes(e.name) && homeLane === undefined) continue;
    if (e.name in opts.stamps) continue;
    out.push(structuredClone(e));
  }
  for (const [name, value] of Object.entries(opts.stamps)) out.push({ name, value });
  return out;
}

// -------------------------------------------------------------- pod builder

export interface BuildRunPodOptions {
  runId: string;
  /** The reference the container runs: the arm's, the release's, or `repo@digest` on a resume. */
  image: string;
  /** The reference as requested, for the annotation and `WRATHBENCH_RUN_IMAGE`. */
  requestedRef: string;
  command: string[] | null;
  args: string[];
  env: RunPodEnvOptions;
  /** The fleet pod, so a fleet stop or crash takes its run pods with it. */
  owner: { name: string; uid: string } | undefined;
  rosterPid: number;
  graceMs: number;
  extraPullSecrets?: readonly string[];
}

/**
 * The template with this episode filled in. A custom `command` replaces the
 * template's whole command (tini included): a foreign image owns its own
 * pid 1 and may not have tini where this one does. The template's command is
 * the entrypoint prefix for this repository's runner only.
 */
export function buildRunPod(template: Pod, opts: BuildRunPodOptions): Pod {
  const pod = structuredClone(template);
  pod.apiVersion = "v1";
  pod.kind = "Pod";
  const container = pod.spec.containers[0];
  if (container === undefined) throw new Error("run pod template has no container");
  pod.metadata.labels = {
    ...(pod.metadata.labels ?? {}),
    "app.kubernetes.io/component": RUN_POD_COMPONENT,
    [RUN_HASH_LABEL]: runHashLabel(opts.runId),
    [ROSTER_PID_LABEL]: String(opts.rosterPid),
  };
  pod.metadata.annotations = { ...(pod.metadata.annotations ?? {}), [RUN_ID_ANNOTATION]: opts.runId, [IMAGE_ANNOTATION]: opts.requestedRef };
  if (opts.owner !== undefined) {
    pod.metadata.ownerReferences = [{ apiVersion: "v1", kind: "Pod", name: opts.owner.name, uid: opts.owner.uid }];
  }
  pod.spec.terminationGracePeriodSeconds = Math.ceil(opts.graceMs / 1000);
  container.image = opts.image;
  container.command = opts.command ?? [...(container.command ?? []), ...DEFAULT_RUN_COMMAND];
  container.args = [...opts.args];
  container.env = runPodEnv(container.env ?? [], opts.env);
  // A lane volume (the Codex home) is mounted only on its own driver's pod.
  const unused = DRIVER_POD_VOLUMES.filter((v) => !entryOf(opts.env.driver).podVolumes.includes(v));
  if (unused.length > 0) {
    container.volumeMounts = (container.volumeMounts ?? []).filter((m) => !unused.includes(m.name));
    pod.spec.volumes = (pod.spec.volumes ?? []).filter((v) => !unused.includes(v.name));
  }
  if (opts.extraPullSecrets !== undefined && opts.extraPullSecrets.length > 0) {
    const have = ((pod.spec["imagePullSecrets"] as { name: string }[] | undefined) ?? []).map((s) => s.name);
    pod.spec["imagePullSecrets"] = [...have, ...opts.extraPullSecrets.filter((n) => !have.includes(n))].map((name) => ({ name }));
  }
  return pod;
}

// ----------------------------------------------------------------- launcher

/** Waiting reasons that will not clear on their own; the attempt ends at once. */
const FATAL_WAITING = new Set(["ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull", "CreateContainerConfigError", "CreateContainerError"]);

export interface PodLauncherOptions {
  client: K8sClient;
  template: Pod;
  allowedImages: readonly string[];
  owner: { name: string; uid: string } | undefined;
  rosterPid: number;
  /** Pull Secrets the chart adds for run pods on top of the template's. */
  imagePullSecrets?: readonly string[];
  pollMs?: number;
  /** A pod still Pending this long is a launch failure. */
  pendingMaxMs?: number;
  /** `Unschedulable` this long is a launch failure (a node may free up; a wrong selector never does). */
  unschedulableMaxMs?: number;
  /** The API unreachable this long ends the attempt as unknown. */
  apiErrorMaxMs?: number;
  /** Where the pod's log goes; the roster's stdout by default. */
  sink?: (chunk: Uint8Array) => void;
  now?: () => number;
}

export class PodLauncher implements EpisodeLauncher {
  readonly kind = "pod" as const;
  constructor(readonly opts: PodLauncherOptions) {}

  /**
   * The image this launch runs, or why it may not. The release image is the
   * template's. A resume with an `image.json` relaunches that digest, whatever
   * the arm says now; the allow-list applies to it the same way.
   */
  resolveImage(launch: EpisodeLaunch): { image: string; requested: ImageRef; stamp: string } | { refused: string } {
    const templateImage = this.opts.template.spec.containers[0]?.image;
    if (templateImage === undefined) return { refused: "run pod template has no container image" };
    const requestedRef = launch.spec.launch?.image ?? templateImage;
    const requested = parseImageRef(requestedRef);
    if ("error" in requested) return { refused: requested.error };
    let image = requestedRef;
    if (launch.resume) {
      const record = readImageRecord(launch.runDir);
      if (record !== undefined) {
        const recorded = parseImageRef(record.ref);
        if ("error" in recorded) return { refused: `${IMAGE_RECORD_FILE} of ${launch.spec.runId} names ${record.ref}: ${recorded.error}` };
        const pinned = `${recorded.repo}@${record.digest}`;
        const refusal = imageRefusal(pinned, this.opts.allowedImages);
        if (refusal !== undefined) return { refused: `resume of ${launch.spec.runId}: ${refusal}` };
        if (launch.spec.launch?.image !== null && launch.spec.launch?.image !== undefined && launch.spec.launch.image !== record.ref) {
          launch.log(`resume ${launch.spec.runId}: relaunching the digest it first ran (${record.ref}) rather than the arm's current ${launch.spec.launch.image}`);
        }
        return { image: pinned, requested: recorded, stamp: harnessStampOf(recorded) };
      }
    }
    const refusal = imageRefusal(image, this.opts.allowedImages);
    if (refusal !== undefined) return { refused: refusal };
    // The release image keeps the fleet's own stamp (the roster's env); an
    // explicit image is stamped as itself, never as master.
    const stamp = launch.spec.launch?.image === null || launch.spec.launch === undefined ? launch.env["WRATHBENCH_HARNESS_VERSION"] ?? harnessStampOf(requested) : harnessStampOf(requested);
    return { image, requested, stamp };
  }

  async start(launch: EpisodeLaunch): Promise<EpisodeHandle> {
    const resolved = this.resolveImage(launch);
    if ("refused" in resolved) return refusedEpisode(resolved.refused);
    const body = buildRunPod(this.opts.template, {
      runId: launch.spec.runId,
      image: resolved.image,
      requestedRef: resolved.requested.ref,
      command: launch.spec.launch?.command ?? null,
      args: launch.args,
      env: {
        driver: launch.spec.driver,
        tokenEnv: launch.spec.tokenEnv,
        apiKeyEnv: launch.spec.apiKeyEnv,
        stamps: { ...launch.env, WRATHBENCH_HARNESS_VERSION: resolved.stamp, WRATHBENCH_RUN_IMAGE: resolved.requested.ref },
      },
      owner: this.opts.owner,
      rosterPid: this.opts.rosterPid,
      graceMs: EPISODE_TERM_GRACE_MS,
      ...(this.opts.imagePullSecrets !== undefined ? { extraPullSecrets: this.opts.imagePullSecrets } : {}),
    });
    let created: Pod;
    try {
      created = await this.opts.client.createPod(body);
    } catch (e) {
      return refusedEpisode(`run pod create refused: ${e instanceof Error ? e.message : String(e)}`);
    }
    const name = created.metadata.name ?? body.metadata.generateName ?? "?";
    launch.log(`run pod ${name} created for ${launch.spec.runId}: image ${resolved.image}, harness stamp ${resolved.stamp}`);
    return new PodHandle(this.opts, name, resolved.image, resolved.requested.ref, launch);
  }
}

class PodHandle implements EpisodeHandle {
  readonly exited: Promise<EpisodeExit>;
  private stopping = false;
  private node: string | undefined;
  private readonly now: () => number;
  private readonly sink: (chunk: Uint8Array) => void;
  private readonly logAbort = new AbortController();
  private logTask: Promise<void> | undefined;

  constructor(
    private readonly opts: PodLauncherOptions,
    private readonly name: string,
    private readonly image: string,
    private readonly requestedRef: string,
    private readonly launch: EpisodeLaunch,
  ) {
    this.now = opts.now ?? Date.now;
    this.sink = opts.sink ?? ((chunk) => process.stdout.write(chunk));
    this.exited = this.watch();
  }

  describe(): string {
    return `pod ${this.name}${this.node !== undefined ? ` on ${this.node}` : ""} (${this.image})`;
  }

  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    try {
      await this.opts.client.deletePod(this.name, Math.ceil(graceMs / 1000));
    } catch (e) {
      this.launch.log(`run pod ${this.name}: delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // The kubelet kills at the grace; the object lingers a little longer.
    await Promise.race([this.exited, Bun.sleep(graceMs + 30_000)]);
  }

  private async watch(): Promise<EpisodeExit> {
    const pollMs = this.opts.pollMs ?? 2_000;
    const pendingMax = this.opts.pendingMaxMs ?? 15 * 60_000;
    const unschedulableMax = this.opts.unschedulableMaxMs ?? 5 * 60_000;
    const apiErrorMax = this.opts.apiErrorMaxMs ?? 10 * 60_000;
    const createdAt = this.now();
    let running = false;
    let unschedulableSince: number | undefined;
    let apiErrorSince: number | undefined;
    for (let first = true; ; first = false) {
      if (!first) await Bun.sleep(pollMs);
      let pod: Pod | null;
      try {
        pod = await this.opts.client.getPod(this.name);
        apiErrorSince = undefined;
      } catch (e) {
        apiErrorSince ??= this.now();
        if (this.now() - apiErrorSince > apiErrorMax) {
          return { code: 1, failure: `the Kubernetes API has not answered for ${Math.round(apiErrorMax / 60_000)}m (${e instanceof Error ? e.message : String(e)}); pod ${this.name} may still be running` };
        }
        continue;
      }
      if (pod === null) {
        await this.drainLog();
        // Gone without reporting an exit: the garbage collector after a fleet
        // restart, or an operator's delete. run.ts had its SIGTERM either way.
        return this.stopping ? { code: 130 } : { code: 1, failure: `pod ${this.name} disappeared before it reported an exit` };
      }
      this.node = pod.spec.nodeName ?? this.node;
      const status = pod.status ?? {};
      const cs = status.containerStatuses?.[0];
      if (!running && cs?.state?.running !== undefined) {
        running = true;
        const digest = digestOf(cs.imageID);
        if (digest !== undefined) {
          writeImageRecord(this.launch.runDir, { ref: this.requestedRef, digest, pod: this.name, node: this.node ?? "", startedAt: this.now() });
        }
        this.launch.log(`run pod ${this.name} running on ${this.node ?? "?"}: ${digest !== undefined ? `${this.image} is ${digest}` : `${this.image} (digest not reported)`}`);
        this.followLog();
      }
      if (cs?.state?.terminated !== undefined) {
        const t = cs.state.terminated;
        await this.drainLog();
        await this.remove();
        const code = t.exitCode ?? 1;
        const failure = t.reason !== undefined && t.reason !== "Completed" && t.reason !== "Error" ? `container ${t.reason}${t.message !== undefined ? `: ${t.message}` : ""}` : undefined;
        return failure !== undefined ? { code, failure } : { code };
      }
      if (status.phase === "Failed" || status.phase === "Succeeded") {
        // A phase without a container verdict: evicted, or preempted before start.
        await this.drainLog();
        await this.remove();
        return { code: 1, failure: `pod ${status.phase}${status.reason !== undefined ? ` (${status.reason})` : ""}${status.message !== undefined ? `: ${status.message}` : ""}` };
      }
      if (running || this.stopping) continue;
      const waiting = cs?.state?.waiting;
      if (waiting?.reason !== undefined && FATAL_WAITING.has(waiting.reason)) {
        await this.remove();
        return { code: 1, failure: `image ${this.image} will not start: ${waiting.reason}${waiting.message !== undefined ? ` — ${waiting.message}` : ""}` };
      }
      const scheduled = status.conditions?.find((c) => c.type === "PodScheduled");
      if (scheduled?.status === "False" && scheduled.reason === "Unschedulable") {
        unschedulableSince ??= this.now();
        if (this.now() - unschedulableSince > unschedulableMax) {
          await this.remove();
          return { code: 1, failure: `pod unschedulable for ${Math.round(unschedulableMax / 60_000)}m: ${scheduled.message ?? "no message"}` };
        }
      } else {
        unschedulableSince = undefined;
      }
      if (this.now() - createdAt > pendingMax) {
        await this.remove();
        return { code: 1, failure: `pod still ${status.phase ?? "Pending"} after ${Math.round(pendingMax / 60_000)}m${waiting?.reason !== undefined ? ` (${waiting.reason})` : ""}` };
      }
    }
  }

  /** Follow the container's log into the sink; retried on the next poll when the API is not ready to serve it. */
  private followLog(): void {
    if (this.logTask !== undefined) return;
    const container = this.opts.template.spec.containers[0]?.name;
    this.logTask = (async () => {
      let stream: ReadableStream<Uint8Array> | null = null;
      for (let attempt = 0; attempt < 5 && stream === null; attempt++) {
        if (attempt > 0) await Bun.sleep(1_000);
        try {
          stream = await this.opts.client.podLog(this.name, { follow: true, ...(container !== undefined ? { container } : {}), signal: this.logAbort.signal });
        } catch {
          stream = null;
        }
      }
      if (stream === null) {
        this.launch.log(`run pod ${this.name}: its log could not be followed; read it with kubectl logs ${this.name}`);
        return;
      }
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) this.sink(value);
        }
      } catch {
        // aborted, or the pod went away under the stream
      }
    })();
  }

  /** Let the follow finish once the container has, bounded so a stuck stream never holds the roster. */
  private async drainLog(): Promise<void> {
    if (this.logTask === undefined) return;
    await Promise.race([this.logTask, Bun.sleep(10_000)]);
    this.logAbort.abort();
  }

  private async remove(): Promise<void> {
    try {
      await this.opts.client.deletePod(this.name, 0);
    } catch (e) {
      this.launch.log(`run pod ${this.name}: could not be deleted after it ended: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ------------------------------------------------------------------ loading

export interface LauncherSettings {
  allowedImages: string[];
  imagePullSecrets: string[];
}

export function parseLauncherSettings(raw: unknown): LauncherSettings {
  if (typeof raw !== "object" || raw === null) throw new Error("launcher settings must be an object");
  const o = raw as { allowedImages?: unknown; imagePullSecrets?: unknown };
  const list = (v: unknown, what: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) throw new Error(`${what} must be an array of non-empty strings`);
    return v as string[];
  };
  return { allowedImages: list(o.allowedImages, "allowedImages"), imagePullSecrets: list(o.imagePullSecrets, "imagePullSecrets") };
}

/**
 * The launcher for this fleet pod, from what the chart mounted and projected:
 * the template, the allow-list, the downward-API pod identity for the owner
 * reference, and the in-cluster client. A string is why there is none.
 */
export function loadPodLauncher(opts: { rosterPid: number; env?: Record<string, string | undefined>; client?: K8sClient | null }): PodLauncher | { error: string } {
  const env = opts.env ?? process.env;
  const client = opts.client === undefined ? K8sClient.inCluster(undefined, env) : opts.client;
  if (client === null) return { error: "no Kubernetes ServiceAccount token is mounted — this process is not a fleet pod" };
  const templatePath = env[RUN_POD_TEMPLATE_ENV] ?? DEFAULT_RUN_POD_TEMPLATE;
  const settingsPath = env[RUN_POD_LAUNCHER_ENV] ?? DEFAULT_RUN_POD_LAUNCHER;
  let template: Pod;
  let settings: LauncherSettings;
  try {
    template = JSON.parse(readFileSync(templatePath, "utf8")) as Pod;
    if (template.spec?.containers?.[0]?.image === undefined) return { error: `${templatePath} is not a pod template with a container` };
  } catch (e) {
    return { error: `run pod template ${templatePath} could not be read (${e instanceof Error ? e.message : String(e)}) — the chart mounts it; is the deployed chart older than run pods?` };
  }
  try {
    settings = parseLauncherSettings(JSON.parse(readFileSync(settingsPath, "utf8")));
  } catch (e) {
    return { error: `run pod launcher settings ${settingsPath} could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
  const name = env["POD_NAME"];
  const uid = env["POD_UID"];
  const owner = name !== undefined && name.length > 0 && uid !== undefined && uid.length > 0 ? { name, uid } : undefined;
  return new PodLauncher({ client, template, allowedImages: settings.allowedImages, imagePullSecrets: settings.imagePullSecrets, owner, rosterPid: opts.rosterPid });
}

/** How long the drain waits for the pod list on a tick: one roster's answer must not stall the others. */
export const DRAIN_POD_QUERY_TIMEOUT_MS = 5_000;

/**
 * Whether a roster process still has an episode running as a pod — the
 * supervisor's drain asks this beside its /proc scan, because a roster between
 * episodes and a roster whose episode is a pod both have no child process.
 *
 * A 403 or a 404 is a definite no: an API that will not let this fleet list
 * pods, or has no such resource, is one this fleet could not have created a
 * run pod through. Anything else that is not an answer — a timeout, a 5xx, a
 * refused connection — throws, and the caller reads that as "in flight".
 */
export async function rosterHasRunPod(client: K8sClient, rosterPid: number, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  let pods: Pod[];
  try {
    pods = await client.listPods(`app.kubernetes.io/component=${RUN_POD_COMPONENT},${ROSTER_PID_LABEL}=${rosterPid}`, opts);
  } catch (e) {
    if (e instanceof K8sError && (e.status === 403 || e.status === 404)) return false;
    throw e;
  }
  return pods.some((p) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed");
}
