/**
 * How a roster starts one episode, behind one interface.
 *
 * `run-roster.ts` used to `Bun.spawn` the runner and hold the process handle:
 * liveness was "has it exited", a stop was SIGTERM then SIGKILL. A probe
 * campaign's arm may now name a different container image (a branch build, or
 * a harness that is not this repository at all), and an image cannot be a
 * child process of the fleet pod. So the episode is a value with three
 * operations — wait for it, stop it, say what it is — and two implementations:
 * the child process the roster has always spawned, and a Kubernetes pod
 * (infra/run-pod.ts). Everything else the roster does around an episode
 * (session hygiene, classification, retries, the defer ladder) reads the run's
 * own files and never the handle, so it is the same for both.
 *
 * The choice is `chooseLauncher`, and it is deliberately narrow: pods only for
 * a spec that carries `launch` (the planner sets it on probing jobs), only on
 * the cluster, and only while the fleet setting `policy.runPods` is `probes`.
 * Scored lanes stay child processes until a probe campaign has proven the
 * launcher. The one thing that is never done quietly is running master's code
 * for an arm that pinned an image: off the cluster, or with the switch off,
 * that launch is refused with the reason, not downgraded.
 */

import { parseRunPodsMode, RUN_PODS_MODES, type RunPodsMode } from "../runner/src/models";

/** The fleet setting's vocabulary lives with the policy block it is part of; re-exported for the launchers' callers. */
export { parseRunPodsMode, RUN_PODS_MODES, type RunPodsMode };

/**
 * SIGTERM → SIGKILL grace for an episode, whichever launcher runs it. The
 * runner pauses on SIGTERM (pause, not terminate): it abandons the request in
 * flight, tears down a CLI child, writes the pause record and releases the
 * session; its own backstop fires at 60s. This must outlast that, and stay
 * inside the fleet pod's 180s `terminationGracePeriodSeconds` with room for
 * the supervisor's own reap. A run pod's own grace is this same number, so a
 * deletion from any side (the roster, the garbage collector after a fleet
 * crash, an operator) gives run.ts the same window.
 */
export const EPISODE_TERM_GRACE_MS = 90_000;

/**
 * The seam with the planner: set on a probing job's spec, absent everywhere
 * else. `image: null` is the release image the fleet itself runs; `command:
 * null` is this repository's runner. Both are stamped on the run.
 */
export interface LaunchSpec {
  pod: true;
  image: string | null;
  command: string[] | null;
}

/** What a launcher needs to know about the spec; `Resolved` satisfies it. */
export interface EpisodeSpec {
  runId: string;
  driver: "openai" | "claude-code" | "codex";
  /** The subscription lane's env var NAME (claude-code, codex), or the default lane. */
  tokenEnv: string | undefined;
  /** The openai driver's key, by env var NAME. */
  apiKeyEnv: string;
  launch: LaunchSpec | undefined;
}

export interface EpisodeLaunch {
  spec: EpisodeSpec;
  resume: boolean;
  /** `data/runs/<id>`, where the launcher may leave `image.json`. */
  runDir: string;
  /** The whole process argv, launcher head included: what a child process runs. */
  argv: string[];
  /** run.ts's own flags with no launcher head: what a pod's container is given as args. */
  args: string[];
  /** Stamps the roster sets on the episode's environment (`WRATHBENCH_HARNESS_VERSION`). */
  env: Record<string, string>;
  log: (line: string) => void;
}

/**
 * How the episode ended. `failure` is set only when the launcher itself ended
 * it — an image that would not pull, a pod that was never scheduled, an
 * eviction — so the roster's classification can say so when the run left no
 * record of its own.
 */
export interface EpisodeExit {
  code: number;
  failure?: string;
}

export interface EpisodeHandle {
  readonly exited: Promise<EpisodeExit>;
  /** Ask the episode to pause (SIGTERM semantics) and wait for it to be gone, `graceMs` before it is killed. */
  stop(graceMs: number): Promise<void>;
  /** One line for the log: the pid, or the pod and its node. */
  describe(): string;
}

export interface EpisodeLauncher {
  readonly kind: "process" | "pod";
  start(launch: EpisodeLaunch): Promise<EpisodeHandle>;
}

export type LauncherChoice = { kind: "process" } | { kind: "pod" } | { kind: "refused"; reason: string };

/**
 * Pod iff the setting is on, we are on the cluster and the spec asked; a
 * child process otherwise — except that an arm with a pinned image is refused
 * rather than run on the code the fleet happens to be made of.
 */
export function chooseLauncher(opts: { runPods: RunPodsMode; onCluster: boolean; launch: LaunchSpec | undefined }): LauncherChoice {
  if (opts.launch === undefined) return { kind: "process" };
  if (opts.runPods === "probes" && opts.onCluster) return { kind: "pod" };
  if (opts.launch.image !== null) {
    const why = !opts.onCluster
      ? "this supervisor is not on the cluster (no Kubernetes ServiceAccount), and an image cannot run as a child process"
      : `the fleet setting policy.runPods is ${JSON.stringify(opts.runPods)}; set it to "probes" to launch run pods`;
    return { kind: "refused", reason: `arm image ${opts.launch.image} refused: ${why} — a pinned arm is never run on master's code instead` };
  }
  return { kind: "process" };
}

/** The seam field as a spec carries it; a hand-written roster goes through here too. */
export function parseLaunchSpec(raw: unknown, where: string): LaunchSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: launch must be an object { pod: true, image, command }`);
  const o = raw as { pod?: unknown; image?: unknown; command?: unknown };
  if (o.pod !== true) throw new Error(`${where}: launch.pod must be true`);
  if (!(o.image === null || (typeof o.image === "string" && o.image.length > 0))) {
    throw new Error(`${where}: launch.image must be an image reference or null (the release image)`);
  }
  if (!(o.command === null || (Array.isArray(o.command) && o.command.length > 0 && o.command.every((c) => typeof c === "string")))) {
    throw new Error(`${where}: launch.command must be a non-empty array of strings or null (this repository's runner)`);
  }
  for (const k of Object.keys(o)) {
    if (k !== "pod" && k !== "image" && k !== "command") throw new Error(`${where}: launch.${k} is not a key — launch is { pod, image, command }`);
  }
  return { pod: true, image: o.image as string | null, command: o.command as string[] | null };
}

/**
 * An episode that never started. Exit 2 is the runner's own refusal code, so
 * the roster reads it the way it reads a run.ts that refused its flags: no
 * run row, `launch-failed`, with this reason.
 */
export function refusedEpisode(reason: string): EpisodeHandle {
  return {
    exited: Promise.resolve({ code: 2, failure: reason }),
    stop: async () => {},
    describe: () => `refused: ${reason}`,
  };
}

/**
 * Today's launch, unchanged: a child of this process, stdio inherited (the
 * runner's operator lines go to stderr and land in the job log), `env`
 * applied over the roster's own environment.
 */
export class ProcessLauncher implements EpisodeLauncher {
  readonly kind = "process" as const;
  constructor(private readonly opts: { cwd: string }) {}

  async start(launch: EpisodeLaunch): Promise<EpisodeHandle> {
    const proc = Bun.spawn(launch.argv, {
      cwd: this.opts.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      // Secrets still never travel via argv or env from here: Bun loads
      // /wrathbench/.env in the child itself; `env` carries only the stamps.
      env: { ...process.env, ...launch.env },
    });
    const exited = proc.exited.then((code) => ({ code }));
    return {
      exited,
      stop: async (graceMs: number) => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // already gone
        }
        const killer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, graceMs);
        killer.unref();
        await exited;
        clearTimeout(killer);
      },
      describe: () => `pid ${proc.pid}`,
    };
  }
}
