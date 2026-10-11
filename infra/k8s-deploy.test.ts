/**
 * Bash-level tests for infra/k8s-deploy.sh's DRAINING phase, in the shape
 * infra/fleet-update.test.ts and infra/k8s-release.test.ts established: the
 * real script, `kubectl` replaced by a PATH shim, no cluster and no pods.
 *
 * WHY THIS FILE EXISTS AT ALL. On 2026-09-17 the first real k8s-release.sh run
 * failed its gate smoke with 409 `account_owned_by_other_token`. The Helm
 * upgrade had put the fleet back to 1 replica under a held pause switch, its
 * new pod started the supervisor's own preflight smoke on the SMOKE account,
 * and this window scaled to 0, read "no live job" from fleet-state.json one
 * second later — true, because a preflight smoke is not a JOB — and ran the
 * same smoke on the same account while the dying pod was still inside its 180s
 * termination grace. The state file says the jobs are gone; only the POD being
 * gone says the supervisor's own session is gone.
 *
 * So the property pinned here is exactly that one: no smoke may run while a
 * fleet pod (or a run pod) is still listed, or while a read of them fails, the wait is unconditional (a fleet already at 0
 * does no state-file wait at all, and "already at 0" says nothing about a pod
 * in its grace), and a pod that outlives the budget fails the window CLOSED
 * with the pod named rather than smoking on top of it.
 *
 * The EXIT trap always scales the fleet back to 1, so assertions are about the
 * relative ORDER of entries in the call log, never about the last one.
 *
 * FORCE_COLOR=3 throughout: that is what colourised a number into a pipe and
 * broke the deploy script's arithmetic on 2026-08-22.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "k8s-deploy.sh");
const TAG = "wb-test-0.9-1-gdeadbee";

/**
 * A `kubectl` with no cluster behind it.
 *
 * `exec` is NOT run locally the way fleet-update.test.ts runs it: this script
 * bakes `/wrathbench/data/runs/fleet-state.json` and the module URL into its
 * `bun -e` sources, so the payload is matched by substring and answered
 * directly — no jobs alive, /health ready, a build string, no pause switch.
 *
 *   FAKE_POD_POLLS   how many `get pods` reads still report a fleet pod
 *                    (-1 = forever, which is the pod that outlives the budget)
 *   FAKE_POD_FAILS   how many fleet-pod reads fail first, kubectl exiting 1
 *                    with a complaint on stderr (-1 = every one); the same
 *                    for the run pods is FAKE_RUN_POD_FAILS
 *   FAKE_REPLICAS    what the fleet Deployment reports for .spec.replicas
 *   FAKE_SMOKE_RC    the exit code every smoke returns
 *   FAKE_PREFLIGHT   the file `config-store.ts get preflight` answers with —
 *                    the store's preflight block, read through the runner pod
 */
const KUBECTL_SHIM = `#!/usr/bin/env bash
log() { printf '%s\\n' "$1" >> "\${FAKE_LOG}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in -n|--namespace) shift 2 ;; *) break ;; esac
done
raw="$*"
cmd="\${1:-}"; shift || true
case "\${cmd}" in
  exec)
    while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done
    shift || true
    payload="$*"
    case "\${payload}" in
      *MODULE_ACCOUNT=*)
        acct="\${payload#*MODULE_ACCOUNT=}"; acct="\${acct%% *}"
        log "smoke \${acct} \${payload##* }"
        exit "\${FAKE_SMOKE_RC:-0}"
        ;;
      *"config-store.ts get preflight"*) log "exec get_preflight"; cat "\${FAKE_PREFLIGHT}"; exit 0 ;;
      *fleet-state.json*) log "exec alive_jobs"; printf '0\\n'; exit 0 ;;
      *worldStopped*)     log "exec health_ok"; exit 0 ;;
      *j.build*)          log "exec health_build"; printf '%s' "\${FAKE_TAG}"; exit 0 ;;
      *server-state.json*) log "exec write_phase"; exit 0 ;;
      *"[ -f"*)           log "exec pause_switch"; exit 1 ;;
      *) log "exec other"; exit 0 ;;
    esac
    ;;
  get)
    if [[ "\${raw}" == *"component=run"* ]]; then
      f=0
      [[ -f "\${FAKE_LOG}.runpodfail" ]] && f="$(cat "\${FAKE_LOG}.runpodfail")"
      fails="\${FAKE_RUN_POD_FAILS:-0}"
      if [[ "\${fails}" == "-1" || "\${f}" -lt "\${fails}" ]]; then
        printf '%s' "$(( f + 1 ))" > "\${FAKE_LOG}.runpodfail"
        log "get run-pods failed"
        echo "Unable to connect to the server: net/http: TLS handshake timeout" >&2
        exit 1
      fi
      # The RUN pods (infra/run-pod.ts): FAKE_RUN_POD_POLLS reads still list one.
      n=0
      [[ -f "\${FAKE_LOG}.runpodcount" ]] && n="$(cat "\${FAKE_LOG}.runpodcount")"
      n=$(( n + 1 ))
      printf '%s' "\${n}" > "\${FAKE_LOG}.runpodcount"
      log "get run-pods"
      polls="\${FAKE_RUN_POD_POLLS:-0}"
      if [[ "\${polls}" == "-1" || "\${n}" -le "\${polls}" ]]; then
        printf 'wrathbench-run-xyz12 Running fleet-race-probe-1-orc-warrior-sonnet-20260101\\n'
      fi
      exit 0
    fi
    if [[ "\${raw}" == *"get pods"* ]]; then
      f=0
      [[ -f "\${FAKE_LOG}.podfail" ]] && f="$(cat "\${FAKE_LOG}.podfail")"
      fails="\${FAKE_POD_FAILS:-0}"
      if [[ "\${fails}" == "-1" || "\${f}" -lt "\${fails}" ]]; then
        printf '%s' "$(( f + 1 ))" > "\${FAKE_LOG}.podfail"
        log "get pods failed"
        echo "Error from server (InternalError): an error on the server has prevented the request from succeeding" >&2
        exit 1
      fi
      n=0
      [[ -f "\${FAKE_LOG}.podcount" ]] && n="$(cat "\${FAKE_LOG}.podcount")"
      n=$(( n + 1 ))
      printf '%s' "\${n}" > "\${FAKE_LOG}.podcount"
      log "get pods"
      polls="\${FAKE_POD_POLLS:-0}"
      if [[ "\${polls}" == "-1" || "\${n}" -le "\${polls}" ]]; then
        printf 'wrathbench-fleet-abc123 Running\\n'
      fi
      exit 0
    fi
    if [[ "\${raw}" == *"spec.replicas"* ]]; then
      log "get replicas"
      printf '%s' "\${FAKE_REPLICAS:-1}"
      exit 0
    fi
    log "get image"
    printf 'reg.example/wrathbench/wrathbench-worldserver:%s' "\${FAKE_TAG}"
    exit 0
    ;;
  scale) log "\${raw}"; exit 0 ;;
  rollout) log "rollout \${1:-} \${2:-}"; exit 0 ;;
esac
log "\${raw}"
exit 0
`;

/** The store's preflight block: one gate smoke, enough that the window has a verification to reach. */
const PREFLIGHT = {
  enabled: true,
  account: "SMOKE",
  smokes: [{ script: "infra/smoke/quest-accept-status.ts", account: "SMOKE" }],
  timeoutMs: 60000,
  deploySmokes: [],
  deployTimeoutMs: 60000,
};

interface Case {
  args?: string[];
  /** How many `get pods` reads still report a pod; -1 never stops reporting one. */
  podPolls?: number;
  /** The same for the RUN pods (`component=run`). */
  runPodPolls?: number;
  /** How many fleet-pod reads fail before one answers; -1 fails every one. */
  podFails?: number;
  /** The same for the run pods. */
  runPodFails?: number;
  replicas?: number;
  drainWaitS?: number;
  smokeRc?: number;
}

interface Result {
  exitCode: number;
  out: string;
  calls: string[];
}

function run(c: Case): Result {
  const dir = tempDir("wb-k8s-deploy-");
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);

  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const kubectl = join(bin, "kubectl");
  writeFileSync(kubectl, KUBECTL_SHIM);
  chmodSync(kubectl, 0o755);

  const preflightJson = join(dir, "preflight.json");
  writeFileSync(preflightJson, JSON.stringify(PREFLIGHT, null, 2));

  const proc = Bun.spawnSync(
    // --expect-tag, because the pin check runs before anything is drained and
    // this script has no REPO_ROOT override: the fake cluster reports this tag,
    // so the check passes and the test is about the drain, not about the pin.
    ["bash", SCRIPT, "--expect-tag", TAG, ...(c.args ?? [])],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FORCE_COLOR: "3",
        FAKE_LOG: log,
        FAKE_TAG: TAG,
        FAKE_POD_POLLS: String(c.podPolls ?? 0),
        FAKE_RUN_POD_POLLS: String(c.runPodPolls ?? 0),
        FAKE_POD_FAILS: String(c.podFails ?? 0),
        FAKE_RUN_POD_FAILS: String(c.runPodFails ?? 0),
        FAKE_REPLICAS: String(c.replicas ?? 1),
        ...(c.smokeRc !== undefined ? { FAKE_SMOKE_RC: String(c.smokeRc) } : {}),
        FAKE_PREFLIGHT: preflightJson,
        WRATHBENCH_DEPLOY_DRAIN_WAIT_S: String(c.drainWaitS ?? 30),
        WRATHBENCH_DEPLOY_HEALTH_WAIT_S: "10",
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  expect(existsSync(log)).toBe(true);
  return {
    exitCode: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

const firstIndex = (r: Result, prefix: string) => r.calls.findIndex((l) => l.startsWith(prefix));
const lastIndex = (r: Result, prefix: string) => r.calls.map((l) => l.startsWith(prefix)).lastIndexOf(true);

describe("k8s-deploy.sh draining", () => {
  test("no smoke runs while a fleet pod is still listed, and one runs once it is gone", () => {
    const r = run({ podPolls: 2 });
    expect(r.exitCode).toBe(0);
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(r.out).toContain("waiting for the fleet POD to go away");
    expect(r.out).toContain("drained: no fleet pod remains");

    // The pod was polled until it went away, and every one of those polls
    // happened BEFORE the smoke — the ordering the 409 came from.
    const smoke = firstIndex(r, "smoke ");
    expect(smoke).toBeGreaterThan(-1);
    expect(lastIndex(r, "get pods")).toBeLessThan(smoke);
    expect(r.calls.filter((l) => l === "get pods").length).toBeGreaterThanOrEqual(3);
    expect(r.calls.some((l) => l.includes("--replicas=0"))).toBe(true);
    expect(r.out).toContain("DEPLOYED and verified by");
  });

  test("the pod list is waited on even when the fleet was already at 0", () => {
    const r = run({ podPolls: 2, replicas: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("the fleet was already at 0");
    expect(r.out).toContain("waiting for the fleet POD to go away");
    // Nothing to scale down, but the pod in its grace is still waited out.
    expect(r.calls.some((l) => l.includes("--replicas=0"))).toBe(false);
    expect(lastIndex(r, "get pods")).toBeLessThan(firstIndex(r, "smoke "));
  });

  test("--dry-run prints the pod list and changes nothing", () => {
    const r = run({ args: ["--dry-run"], podPolls: 1 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("wrathbench-fleet-abc123 Running");
    // The claim --dry-run makes, in full: nothing is scaled, waited on or smoked.
    expect(r.calls.some((l) => l.includes("--replicas="))).toBe(false);
    expect(firstIndex(r, "smoke ")).toBe(-1);
  });

  test("--dry-run says so when no pod is there to wait for", () => {
    const r = run({ args: ["--dry-run"], podPolls: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("the drain would not have to wait for one");
  });

  test("a wait that never waited says so, rather than reading as a clean drain", () => {
    const r = run({ podPolls: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("on the first look — nothing to wait for");
  });

  test("a pod that outlives the drain budget fails the window closed and names it", () => {
    const r = run({ podPolls: -1, drainWaitS: 1 });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("wrathbench-fleet-abc123");
    expect(r.out).toContain("account_owned_by_other_token");
    // The whole point: it did not smoke on top of the dying supervisor.
    expect(firstIndex(r, "smoke ")).toBe(-1);
    // And the invariant the header promises still holds — the fleet came back.
    expect(r.calls.some((l) => l.includes("--replicas=1"))).toBe(true);
  });

  // A run pod (infra/run-pod.ts) is an episode with a game session, owned by
  // the fleet pod and deleted with a 90s grace once that pod is gone. The
  // worldserver is rolled and smoked only once none remains.
  test("run pods are waited out after the fleet pod and before the worldserver is touched", () => {
    const r = run({ podPolls: 1, runPodPolls: 1 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("waiting for every RUN pod to go away");
    expect(r.out).toContain("drained: no run pod remains");
    const lastRunPoll = lastIndex(r, "get run-pods");
    expect(r.calls.filter((l) => l === "get run-pods").length).toBeGreaterThanOrEqual(2);
    // After the fleet pod wait, before the worldserver rollout wait and the smoke.
    expect(lastRunPoll).toBeGreaterThan(lastIndex(r, "get pods"));
    expect(lastRunPoll).toBeLessThan(r.calls.findIndex((l) => l.startsWith("rollout status") && l.includes("worldserver")));
    expect(lastRunPoll).toBeLessThan(firstIndex(r, "smoke "));
  }, 20_000);

  test("a run pod that never goes away fails the window closed, naming its run", () => {
    const r = run({ podPolls: 0, runPodPolls: -1, drainWaitS: 1 });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("fleet-race-probe-1-orc-warrior-sonnet-20260101");
    expect(r.out).toContain("must not be touched under a live run");
    expect(firstIndex(r, "smoke ")).toBe(-1);
    expect(r.calls.some((l) => l.includes("--replicas=1"))).toBe(true);
  });

  test("--dry-run lists the run pods beside the fleet pods", () => {
    const r = run({ args: ["--dry-run"], runPodPolls: 1 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("run pods");
    expect(r.out).toContain("wrathbench-run-xyz12 Running");
  });

  // A kubectl that fails is not a cluster with no pods. The readers used to
  // swallow the error and print nothing, which the wait read as "gone" on its
  // first look — so one transient API error ended the drain at once.
  test("a run-pod read that fails is retried inside the budget, never taken as none", () => {
    const r = run({ podPolls: 0, runPodFails: 2, runPodPolls: 1 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("could not list the run pods (kubectl exit 1: Unable to connect to the server");
    expect(r.out).toContain("drained: no run pod remains");
    // Two failed reads, then one that still lists the pod, then the empty one.
    const reads = r.calls.filter((l) => l.startsWith("get run-pods"));
    expect(reads.slice(0, 3)).toEqual(["get run-pods failed", "get run-pods failed", "get run-pods"]);
    expect(reads.length).toBe(4);
    expect(lastIndex(r, "get run-pods")).toBeLessThan(firstIndex(r, "smoke "));
  }, 20_000);

  test("a run-pod read that keeps failing fails the window closed before the worldserver is touched", () => {
    const r = run({ podPolls: 0, runPodFails: -1, drainWaitS: 3 });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("could not list the run pods within 3s");
    expect(r.out).toContain("a failed read is not an empty one");
    expect(r.out).not.toContain("drained: no run pod remains");
    expect(r.calls.some((l) => l.startsWith("rollout status") && l.includes("worldserver"))).toBe(false);
    expect(firstIndex(r, "smoke ")).toBe(-1);
    expect(r.calls.some((l) => l.includes("--replicas=1"))).toBe(true);
  }, 20_000);

  test("a fleet-pod read that keeps failing fails the window closed too", () => {
    const r = run({ podFails: -1, drainWaitS: 3 });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("could not list the fleet pods within 3s");
    expect(r.out).toContain("an error on the server has prevented the request");
    expect(r.out).not.toContain("drained: no fleet pod remains");
    expect(firstIndex(r, "get run-pods")).toBe(-1);
    expect(firstIndex(r, "smoke ")).toBe(-1);
  }, 20_000);

  test("a fleet-pod read that fails once is retried, and the pod it then sees is waited out", () => {
    const r = run({ podFails: 1, podPolls: 1 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("could not list the fleet pods");
    expect(r.out).toContain("drained: no fleet pod remains");
    expect(r.calls.filter((l) => l.startsWith("get pods"))).toEqual(["get pods failed", "get pods", "get pods"]);
  }, 20_000);

  test("--dry-run says a failed read is one, not none", () => {
    const r = run({ args: ["--dry-run"], podFails: -1, runPodFails: -1 });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("fleet pods         COULD NOT READ (kubectl exit 1:");
    expect(r.out).toContain("run pods           COULD NOT READ (kubectl exit 1:");
    expect(r.out).not.toContain("none — no episode is running as its own pod");
  });
});
