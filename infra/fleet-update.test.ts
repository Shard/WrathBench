/**
 * Bash-level tests for infra/fleet-update.sh: the real script, `kubectl`
 * replaced by a PATH shim, no cluster and no pods.
 *
 * The shim answers `get` from a fixture, records `rollout`/`scale`, and — the
 * part that makes this worth doing — implements `exec ... -- <cmd>` by running
 * `<cmd>` locally. The script passes the state and pause paths as ARGV rather
 * than baking `/wrathbench/data/runs` into its bun snippets, so pointing
 * WRATHBENCH_FLEET_RUNS_DIR at a tmpdir makes the pod-side reads and writes
 * real reads and writes of real files.
 *
 * The properties worth pinning are the ones that cost money when they are
 * wrong: the graceful path must not touch the Deployment until the supervisor's
 * own state file says no job is alive, `drain` must scale to 0 and never
 * restart, `graceful`/`force` must restart and never scale to 0, and a timeout
 * must leave the switch set rather than fall through to a kill.
 *
 * FORCE_COLOR=3 throughout: that is what once colourised a number into a pipe
 * and broke the deploy script's arithmetic.
 *
 * Every wait is 0 s: each loop checks its condition before the deadline, so a
 * quiet fleet still completes and a held window times out on its first poll
 * instead of sleeping for real.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "fleet-update.sh");

/**
 * A `kubectl` that logs every argv, answers `get`, records `scale`/`rollout`,
 * and runs `exec ... -- cmd` locally. A restart or a scale back up refreshes
 * the state file's heartbeat, which is how the script knows the new supervisor
 * came back (FAKE_BOOT=0 is the one that never does).
 */
const KUBECTL_SHIM = `#!/usr/bin/env bash
log() { printf '%s\\n' "$1" >> "\${FAKE_KUBECTL_LOG}"; }
boot() {
  [[ "\${FAKE_BOOT:-1}" == "1" ]] || return 0
  bun -e 'const p=process.argv[1];const s=await Bun.file(p).json();s.heartbeatAt=Date.now();s.startedAt=Date.now();delete s.pausedSwitch;await Bun.write(p,JSON.stringify(s,null,2));' "\${FAKE_STATE_JSON}" 2>/dev/null || true
}
# FAKE_BOOT_HEARTBEAT_ONLY: the pod comes back with a fresh heartbeat but the
# SAME startedAt — a supervisor that never restarted, or a clock that made the
# dying one's last write look new.
beat_only() {
  bun -e 'const p=process.argv[1];const s=await Bun.file(p).json();s.heartbeatAt=Date.now()+30000;await Bun.write(p,JSON.stringify(s,null,2));' "\${FAKE_STATE_JSON}" 2>/dev/null || true
}
recreated() {
  if [[ "\${FAKE_BOOT_HEARTBEAT_ONLY:-0}" == "1" ]]; then beat_only; else boot; fi
}
while [[ $# -gt 0 ]]; do
  case "$1" in -n|--namespace) shift 2 ;; *) break ;; esac
done
raw="$*"
cmd="\${1:-}"; shift || true
case "\${cmd}" in
  exec)
    target=""
    while [[ $# -gt 0 && "$1" != "--" ]]; do [[ "$1" == -* ]] || target="$1"; shift; done
    shift || true
    log "exec \${target} -- \${1:-}"
    exec "$@"
    ;;
  get)
    log "\${raw}"
    [[ "\${FAKE_DEPLOY_MISSING:-0}" == "1" ]] && exit 1
    replicas="$(cat "\${FAKE_REPLICAS_FILE}")"
    if [[ "\${raw}" == *"component=run"* ]]; then
      # Run pods (infra/run-pod.ts): none in this fake cluster.
      :
    elif [[ "\${raw}" == *"pods"* ]]; then
      if [[ "\${FAKE_PODS_LINGER:-0}" == "1" ]]; then printf 'wrathbench-fleet-abc123 Terminating\\n'
      elif [[ "\${replicas}" != "0" ]]; then printf 'wrathbench-fleet-abc123 Running\\n'; fi
    elif [[ "\${raw}" == *"readyReplicas"* ]]; then
      printf '%s' "\${replicas}"
    else
      printf '%s' "\${replicas}"
    fi
    exit 0
    ;;
  scale)
    log "\${raw}"
    n="\${raw##*--replicas=}"
    printf '%s' "\${n}" > "\${FAKE_REPLICAS_FILE}"
    [[ "\${n}" == "0" ]] || recreated
    exit 0
    ;;
  rollout)
    log "\${raw}"
    [[ "\${1:-}" == "restart" ]] && recreated
    [[ "\${1:-}" == "status" && "\${FAKE_ROLLOUT_FAIL:-0}" == "1" ]] && exit 1
    exit 0
    ;;
esac
log "\${raw}"
exit 0
`;

interface Case {
  /** Jobs the supervisor's state lists with a live roster process. */
  aliveJobs?: number;
  /**
   * Live job rows written out in full, for the drain view: what the wait loop
   * waits on and what it counts as drained. Added to whatever `aliveJobs`
   * generated.
   */
  jobs?: { name: string; episode: string; source: string; draining?: boolean; resumesInPlace?: boolean }[];
  /** Seconds since the supervisor's last heartbeat. */
  heartbeatAgeS?: number;
  /** Paused runs the supervisor is not resuming. */
  paused?: { runId: string; model: string; reason: string; elapsedMs: number; budgetMs: number }[];
  /** The supervisor has already picked the switch up. */
  pickedUp?: boolean;
  /** False: a restart brings nothing back (the supervisor died). */
  boots?: boolean;
  /**
   * The restart refreshes the heartbeat but NOT `startedAt`: the same
   * supervisor, or a pod clock far enough ahead that a dying supervisor's last
   * write looks like a boot.
   */
  heartbeatOnlyBoot?: boolean;
  /** The fleet pod is still Terminating long after the scale to 0. */
  podsLinger?: boolean;
  /** `kubectl rollout status` fails. */
  rolloutFails?: boolean;
  /** `.spec.replicas` on the fleet Deployment before the script runs. */
  replicas?: number;
  /** `kubectl get deployment/...` fails: nothing is installed. */
  deployMissing?: boolean;
  args: string[];
  /** Pre-existing pause file. */
  paused_switch?: boolean;
  /** Write a truncated state file: a poll that landed mid-writeState. */
  corruptState?: boolean;
  env?: Record<string, string>;
  /** Send SIGINT after this many seconds, to exercise the abort path. */
  interruptAfterS?: number;
}

interface Result {
  exitCode: number;
  out: string;
  kubectlCalls: string[];
  /** The pause sidecar as the script left it, or null. */
  pauseFile: { paused: boolean; why: string; at: number } | null;
  /** `.spec.replicas` as the script left it. */
  replicas: string;
}

function run(c: Case): Result {
  const dir = tempDir("wb-fleet-update-");
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const shim = join(bin, "kubectl");
  writeFileSync(shim, KUBECTL_SHIM);
  chmodSync(shim, 0o755);

  const stateJson = join(dir, "fleet-state.json");
  const jobs: Record<string, { account: string; alive: boolean; ref?: string; episode?: string; source?: string; draining?: boolean; resumesInPlace?: boolean }> =
    {};
  for (let i = 0; i < (c.aliveJobs ?? 0); i++) jobs[`job-${i}`] = { account: `RUNNER${i}`, alive: true };
  for (const j of c.jobs ?? []) {
    jobs[j.name] = {
      account: "RUNNER9",
      alive: true,
      ref: j.name,
      episode: j.episode,
      source: j.source,
      draining: j.draining === true,
      ...(j.resumesInPlace !== undefined ? { resumesInPlace: j.resumesInPlace } : {}),
    };
  }
  writeFileSync(
    stateJson,
    JSON.stringify(
      {
        heartbeatAt: Date.now() - (c.heartbeatAgeS ?? 5) * 1000,
        startedAt: Date.now() - 3_600_000,
        jobs,
        paused: c.paused ?? [],
        ...(c.pickedUp === true ? { pausedSwitch: { why: "already paused", at: Date.now() } } : {}),
      },
      null,
      2,
    ),
  );
  if (c.corruptState === true) writeFileSync(stateJson, '{"heartbeatAt": 1, "jobs": {"job-0": {"ali');
  const pauseJson = join(dir, "fleet-pause.json");
  if (c.paused_switch === true) {
    writeFileSync(pauseJson, JSON.stringify({ paused: true, why: "set by hand", at: Date.now() }));
  }
  const kubectlLog = join(dir, "kubectl.log");
  writeFileSync(kubectlLog, "");
  const replicasFile = join(dir, "replicas");
  writeFileSync(replicasFile, String(c.replicas ?? 1));

  // `interruptAfterS` is Ctrl-C: `timeout -s INT` signals the script mid-wait,
  // which is the only way to exercise the abort trap.
  const argv =
    c.interruptAfterS !== undefined ? ["timeout", "-s", "INT", String(c.interruptAfterS), "bash", SCRIPT, ...c.args] : ["bash", SCRIPT, ...c.args];
  const proc = Bun.spawnSync(argv, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FORCE_COLOR: "3",
      FAKE_KUBECTL_LOG: kubectlLog,
      FAKE_STATE_JSON: stateJson,
      FAKE_REPLICAS_FILE: replicasFile,
      FAKE_BOOT: c.boots === false ? "0" : "1",
      ...(c.deployMissing === true ? { FAKE_DEPLOY_MISSING: "1" } : {}),
      ...(c.heartbeatOnlyBoot === true ? { FAKE_BOOT_HEARTBEAT_ONLY: "1" } : {}),
      ...(c.podsLinger === true ? { FAKE_PODS_LINGER: "1" } : {}),
      ...(c.rolloutFails === true ? { FAKE_ROLLOUT_FAIL: "1" } : {}),
      WRATHBENCH_FLEET_RUNS_DIR: dir,
      WRATHBENCH_FLEET_POLL_S: "1",
      WRATHBENCH_FLEET_BOOT_WAIT_S: "0",
      WRATHBENCH_FLEET_ROLLOUT_WAIT_S: "0",
      WRATHBENCH_FLEET_TIMEOUT_S: "0",
      ...c.env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    kubectlCalls: readFileSync(kubectlLog, "utf8").split("\n").filter(Boolean),
    pauseFile: existsSync(pauseJson) ? (JSON.parse(readFileSync(pauseJson, "utf8")) as Result["pauseFile"]) : null,
    replicas: readFileSync(replicasFile, "utf8"),
  };
}

/** The script, Ctrl-C'd two seconds into its wait (past the trap, under load too). */
function runAborted(c: Case): Result {
  return run({ ...c, interruptAfterS: 2, env: { WRATHBENCH_FLEET_TIMEOUT_S: "60", ...(c.env ?? {}) } });
}

const restarts = (r: Result) => r.kubectlCalls.filter((l) => l.startsWith("rollout restart"));
const scales = (r: Result) => r.kubectlCalls.filter((l) => l.startsWith("scale "));

describe("fleet-update.sh", () => {
  test("graceful: sets the switch, waits for quiet, rollout-restarts the fleet, clears the switch", () => {
    const r = run({ aliveJobs: 0, args: ["graceful"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(r.out).toContain("pause switch SET");
    expect(restarts(r)).toEqual(["rollout restart deployment/wrathbench-fleet"]);
    // A supervisor roll never scales anything: that is `drain`'s job alone.
    expect(scales(r)).toEqual([]);
    expect(r.kubectlCalls.some((l) => l.startsWith("rollout status"))).toBe(true);
    // The switch is gone: the new supervisor schedules again.
    expect(r.pauseFile).toBeNull();
  });

  test("graceful: a fleet already at 0 is scaled back to 1 rather than restarted into nothing", () => {
    const r = run({ aliveJobs: 0, replicas: 0, args: ["graceful"] });
    expect(r.exitCode).toBe(0);
    expect(restarts(r)).toEqual([]);
    expect(r.replicas).toBe("1");
    expect(r.pauseFile).toBeNull();
  });

  test("graceful: a job still live holds the window open and times out WITHOUT killing anything", () => {
    const r = run({
      aliveJobs: 2,
      paused: [{ runId: "fleet-glm-e90-x", model: "z-ai/glm-5.3", reason: "rate-limited", elapsedMs: 41 * 60_000, budgetMs: 90 * 60_000 }],
      args: ["graceful"],
    });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("2 run(s) still on their own clock");
    expect(r.out).toContain("TIMED OUT");
    // A provider pause that outlasts its budget is a counted failure, so it is named before the wait.
    expect(r.out).toContain("COUNTED failed attempt");
    expect(r.out).toContain("fleet-glm-e90-x");
    // Nothing was restarted or scaled: the runs are untouched.
    expect(restarts(r)).toEqual([]);
    expect(scales(r)).toEqual([]);
    // And the switch stays set, so the fleet is not quietly scheduling again.
    expect(r.pauseFile?.paused).toBe(true);
  });

  // Only a run that comes back where it left off may be counted drained: a
  // scored attempt is spent if the recreate lands on it. `draining` is the
  // proof the supervisor picked the switch up, and its `resumesInPlace` flag is
  // believed in both directions (the freeplay fallback is for supervisors that
  // predate the field, not a second opinion).
  type Job = NonNullable<Case["jobs"]>[number];
  const parking: { name: string; job: Job; parks: boolean }[] = [
    { name: "a draining freeplay character parks", job: { name: "sonnet-low-freeplay", episode: "freeplay", source: "policy", draining: true }, parks: true },
    {
      name: "a freeplay character the switch has not reached is waited on",
      job: { name: "sonnet-low-freeplay", episode: "freeplay", source: "policy", draining: false },
      parks: false,
    },
    { name: "a draining scored e90 run is waited on", job: { name: "glm-e90", episode: "e90", source: "policy", draining: true }, parks: false },
    {
      name: "a draining resume:true campaign run parks on the supervisor's word",
      job: { name: "muse-probe", episode: "probing", source: "policy", draining: true, resumesInPlace: true },
      parks: true,
    },
    {
      name: "resumesInPlace:false on a freeplay row outranks the fallback",
      job: { name: "q-freeplay", episode: "freeplay", source: "queue", draining: true, resumesInPlace: false },
      parks: false,
    },
  ];
  for (const p of parking) {
    test(`graceful: ${p.name}`, () => {
      // A parked character beside it never unblocks the window on its own.
      const beside: Job[] = p.parks ? [] : [{ name: "parked-freeplay", episode: "freeplay", source: "policy", draining: true }];
      const r = run({ jobs: [p.job, ...beside], args: ["graceful"] });
      if (p.parks) {
        expect(r.exitCode).toBe(0);
        expect(r.out).toContain(`counted drained: ${p.job.name}`);
        expect(restarts(r).length).toBe(1);
        expect(r.pauseFile).toBeNull();
      } else {
        expect(r.exitCode).toBe(1);
        expect(r.out).toContain(`waiting on:      ${p.job.name}`);
        expect(restarts(r)).toEqual([]);
        expect(r.pauseFile?.paused).toBe(true);
      }
    });
  }

  test("graceful: aborted with SIGINT, the switch stays SET and the message says how to clear it", () => {
    const r = runAborted({ jobs: [{ name: "glm-e90", episode: "e90", source: "policy", draining: true }], args: ["graceful"] });
    expect(r.out).toContain("PAUSE SWITCH IS STILL SET");
    expect(r.out).toContain("fleet-update.sh resume");
    expect(restarts(r)).toEqual([]);
    expect(scales(r)).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a state file that did not read back is NOT quiet — the recreate never happens", () => {
    // writeState is a plain writeFileSync, so a poll can land mid-write. Reading
    // that as "no job is alive" would restart the pod over live episodes, which
    // is the one thing this path exists to prevent.
    const r = run({ corruptState: true, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("did not read back this poll");
    expect(restarts(r)).toEqual([]);
    expect(scales(r)).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a dead supervisor's frozen job rows are not quiet either", () => {
    const r = run({ aliveJobs: 0, heartbeatAgeS: 3600, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("is not ticking");
    expect(restarts(r)).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a supervisor that does not come back leaves the switch SET", () => {
    const r = run({ aliveJobs: 0, boots: false, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("no NEW supervisor process");
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a fresh heartbeat from the SAME supervisor process is not a boot", () => {
    // `startedAt` is the pod's clock and the restart is typed on the
    // workstation's: a pod running ahead would make the dying supervisor's last
    // heartbeat look like a boot. The supervisor's own start stamp, compared
    // against itself, never asks two clocks to agree.
    const r = run({ aliveJobs: 0, heartbeatOnlyBoot: true, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("no NEW supervisor process");
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a kubectl that fails mid-window says the switch is still set", () => {
    // `set -e` alone would exit silently, the failure the abort trap exists to prevent.
    const r = run({ aliveJobs: 0, rolloutFails: true, args: ["graceful"] });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("PAUSE SWITCH IS STILL SET");
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: --namespace and --release pick the Deployment that is restarted", () => {
    const r = run({ aliveJobs: 0, args: ["graceful", "--namespace", "wb-test", "--release", "wb"] });
    expect(r.exitCode).toBe(0);
    expect(restarts(r)).toEqual(["rollout restart deployment/wb-fleet"]);
  });

  test("drain: waits for quiet, scales the fleet to 0, and LEAVES the switch set for the deploy", () => {
    const r = run({ aliveJobs: 0, args: ["drain"] });
    expect(r.exitCode).toBe(0);
    expect(r.replicas).toBe("0");
    expect(restarts(r)).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("drain: a pod still Terminating is not a drained fleet", () => {
    // A scale to 0 returns at once while the supervisor spends up to 180s
    // writing pause records; a deploy must not start on top of that.
    const r = run({ aliveJobs: 0, podsLinger: true, args: ["drain"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("STILL THERE");
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("force: says what it costs, restarts immediately, and never scales", () => {
    const r = run({ aliveJobs: 3, args: ["force", "--yes"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("attempt is spent");
    expect(restarts(r).length).toBe(1);
    expect(scales(r)).toEqual([]);
    expect(r.pauseFile).toBeNull();
  });

  test("force: a switch left set by an aborted graceful is cleared after the recreate", () => {
    // force STARTS the fleet, so a switch it left set would be a fleet that runs and schedules nothing.
    const r = run({ aliveJobs: 1, paused_switch: true, args: ["force", "--yes"] });
    expect(r.exitCode).toBe(0);
    expect(r.pauseFile).toBeNull();
  });

  test("force without --yes on a pipe refuses rather than restarting", () => {
    const r = run({ aliveJobs: 3, args: ["force"] });
    expect(r.exitCode).not.toBe(0);
    expect(restarts(r)).toEqual([]);
  });

  test("--dry-run writes nothing and runs no mutating kubectl, in every mode", () => {
    for (const mode of ["graceful", "drain", "force"]) {
      const r = run({ aliveJobs: 2, paused_switch: mode === "force", args: [mode, "--dry-run"] });
      expect(r.exitCode).toBe(0);
      expect(r.out).toContain("would: ");
      // The only pause file is the one the case wrote itself, untouched.
      expect(r.pauseFile?.why ?? null).toBe(mode === "force" ? "set by hand" : null);
      expect(restarts(r)).toEqual([]);
      expect(scales(r)).toEqual([]);
    }
  });

  test("resume clears the switch and nothing else; status reads it back without changing it", () => {
    const cleared = run({ paused_switch: true, args: ["resume"] });
    expect(cleared.exitCode).toBe(0);
    expect(cleared.pauseFile).toBeNull();
    expect(restarts(cleared)).toEqual([]);
    expect(scales(cleared)).toEqual([]);
    const s = run({ paused_switch: true, aliveJobs: 1, pickedUp: true, args: ["status"] });
    expect(s.exitCode).toBe(0);
    expect(s.out).toContain("jobs alive     1");
    expect(restarts(s)).toEqual([]);
    expect(s.pauseFile?.paused).toBe(true);
  });

  test("a mode is required, and two modes are refused", () => {
    expect(run({ args: [] }).exitCode).toBe(2);
    expect(run({ args: ["graceful", "force"] }).exitCode).toBe(2);
    expect(run({ args: ["--timeout", "soon", "graceful"] }).exitCode).toBe(2);
  });
});
