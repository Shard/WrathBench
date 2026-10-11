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
 * fleet pod is still listed, the wait is unconditional (a fleet already at 0
 * does no state-file wait at all, and "already at 0" says nothing about a pod
 * in its grace), and a pod that outlives the budget fails the window CLOSED
 * with the pod named rather than smoking on top of it.
 *
 * The EXIT trap always scales the fleet back to 1, so assertions are about the
 * relative ORDER of entries in the call log, never about the last one.
 *
 * --keep-paused is pinned here too, because it is a property of the same exit
 * paths: the fleet still comes back on every one of them, and the pause switch
 * must already be set by then and never be cleared, or every paused run
 * resumes onto a build nobody has smoked.
 *
 * FORCE_COLOR=3 throughout: that is what colourised a number into a pipe and
 * broke the deploy script's arithmetic on 2026-08-22.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePauseSidecar } from "./run-fleet-plan";
import { tempDirs } from "./temp-dirs";

const tempDir = tempDirs();

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "k8s-deploy.sh");
const TAG = "wb-test-0.9-1-gdeadbee";

/**
 * A `kubectl` with no cluster behind it.
 *
 * `exec` is mostly NOT run locally the way fleet-update.test.ts runs it: this
 * script bakes `/wrathbench/data/runs/fleet-state.json` and the module URL into
 * its `bun -e` sources, so the payload is matched by substring and answered
 * directly — no jobs alive, /health ready, a build string. The PAUSE SWITCH is
 * the exception: its path follows WRATHBENCH_FLEET_RUNS_DIR, so a payload that
 * names `$FAKE_RUNS/fleet-pause.json` (the check, the write, the rm) runs here
 * for real against a fixture directory, and the file the script wrote is what
 * the test reads back.
 *
 *   FAKE_POD_POLLS   how many `get pods` reads still report a fleet pod
 *                    (-1 = forever, which is the pod that outlives the budget)
 *   FAKE_REPLICAS    what the fleet Deployment reports for .spec.replicas
 *   FAKE_SMOKE_RC    the exit code every smoke returns
 *   FAKE_PREFLIGHT   the file `config-store.ts get preflight` answers with —
 *                    the store's preflight block, read through the runner pod
 *   FAKE_RUNS        the runs directory the pause switch lives in
 *   FAKE_SWITCH_WRITE_FAIL  the switch write exits 1 without writing
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
      *"\${FAKE_RUNS}/fleet-pause.json"*)
        case "\${payload}" in
          *"[ -f"*) log "exec pause_switch" ;;
          *"rm -f"*) log "exec clear_switch" ;;
          *) log "exec set_switch"; [[ "\${FAKE_SWITCH_WRITE_FAIL:-0}" == "1" ]] && exit 1 ;;
        esac
        exec "$@"
        ;;
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
    if [[ "\${raw}" == *"get pods"* ]]; then
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
    printf 'reg.example/library/wrathbench-worldserver:%s' "\${FAKE_TAG}"
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
  replicas?: number;
  drainWaitS?: number;
  smokeRc?: number;
  /** The pause switch file's text before the window starts; absent when undefined. */
  switchBefore?: string;
  switchWriteFails?: boolean;
}

interface Result {
  exitCode: number;
  out: string;
  calls: string[];
  /** The pause switch file's text after the run, or undefined when there is none. */
  switchAfter: string | undefined;
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

  const runs = join(dir, "runs");
  Bun.spawnSync(["mkdir", "-p", runs]);
  const pauseJson = join(runs, "fleet-pause.json");
  if (c.switchBefore !== undefined) writeFileSync(pauseJson, c.switchBefore);

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
        FAKE_REPLICAS: String(c.replicas ?? 1),
        ...(c.smokeRc !== undefined ? { FAKE_SMOKE_RC: String(c.smokeRc) } : {}),
        FAKE_PREFLIGHT: preflightJson,
        FAKE_RUNS: runs,
        ...(c.switchWriteFails === true ? { FAKE_SWITCH_WRITE_FAIL: "1" } : {}),
        WRATHBENCH_FLEET_RUNS_DIR: runs,
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
    switchAfter: existsSync(pauseJson) ? readFileSync(pauseJson, "utf8") : undefined,
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
});

describe("k8s-deploy.sh --keep-paused", () => {
  /** What `fleet-update.sh drain` leaves behind, in the shape it writes. */
  const DRAIN_SWITCH = `${JSON.stringify({ paused: true, why: "drain supervisor update, 2026-10-11 09:00", at: 1 }, null, 2)}\n`;

  test("sets the switch before the drain, never clears it, and still brings the fleet back", () => {
    const r = run({ args: ["--keep-paused"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).not.toContain("arithmetic syntax error");

    // Written before anything is drained, so no exit path can bring the fleet
    // up without it — and so before the scale-up, which is the promise.
    const set = firstIndex(r, "exec set_switch");
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(firstIndex(r, "scale deployment/wrathbench-fleet --replicas=0"));
    expect(set).toBeLessThan(lastIndex(r, "scale deployment/wrathbench-fleet --replicas=1"));
    expect(firstIndex(r, "exec clear_switch")).toBe(-1);

    // The fleet-up invariant is untouched: it came back, after the smoke.
    expect(lastIndex(r, "scale deployment/wrathbench-fleet --replicas=1")).toBeGreaterThan(firstIndex(r, "smoke "));

    // The same file and shape `fleet-update.sh drain` writes — the supervisor's
    // own parser reads it as a pause.
    expect(r.switchAfter).toBeDefined();
    const pause = parsePauseSidecar(r.switchAfter!);
    expect(pause).toBeDefined();
    expect(pause!.why).toContain("--keep-paused");
    expect(pause!.why).toContain("fleet-update.sh resume");

    // It ends by saying what to run next, after the verification line.
    expect(r.out).toContain("DEPLOYED and verified by");
    expect(r.out.lastIndexOf("./infra/fleet-update.sh resume")).toBeGreaterThan(r.out.indexOf("DEPLOYED and verified by"));
    expect(r.out).toContain("./infra/run-episode.sh --k8s --account PROBE --driver claude-code");
    expect(r.out).toContain("--driver codex");
    expect(r.out).not.toContain("pause switch CLEARED");
    // A switch set a moment ago is not the one a Helm upgrade raced.
    expect(r.out).toContain("SET (just now, by --keep-paused)");
    expect(r.out).not.toContain("a Helm upgrade resets the fleet Deployment");
    expect(r.out).toContain("resumes only after fleet-update.sh resume");
  });

  test("a switch the drain left set is left exactly as it was", () => {
    const r = run({ args: ["--keep-paused"], switchBefore: DRAIN_SWITCH });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("already SET");
    expect(firstIndex(r, "exec set_switch")).toBe(-1);
    expect(firstIndex(r, "exec clear_switch")).toBe(-1);
    expect(r.switchAfter).toBe(DRAIN_SWITCH);
    expect(r.calls.some((l) => l.includes("--replicas=1"))).toBe(true);
  });

  test("without it, the resume phase clears a set switch — the default this flag opts out of", () => {
    const r = run({ switchBefore: DRAIN_SWITCH });
    expect(r.exitCode).toBe(0);
    expect(firstIndex(r, "exec set_switch")).toBe(-1);
    expect(firstIndex(r, "exec clear_switch")).toBeGreaterThan(firstIndex(r, "smoke "));
    expect(r.switchAfter).toBeUndefined();
    expect(r.out).toContain("pause switch CLEARED");
    expect(r.out).not.toContain("run-episode.sh --k8s");
  });

  test("a failed window still brings the fleet up, with the switch still set", () => {
    const r = run({ args: ["--keep-paused"], smokeRc: 1 });
    expect(r.exitCode).toBe(1);
    expect(r.calls.some((l) => l.includes("--replicas=1"))).toBe(true);
    expect(firstIndex(r, "exec clear_switch")).toBe(-1);
    expect(parsePauseSidecar(r.switchAfter ?? "")).toBeDefined();
    expect(r.out).toContain("STILL SET");
    // The fix for a failed window is a revert, not a smoke of the build that failed.
    expect(r.out).not.toContain("run-episode.sh --k8s");
  });

  test("a switch that cannot be written refuses before anything is drained", () => {
    const r = run({ args: ["--keep-paused"], switchWriteFails: true });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("could not set the pause switch");
    expect(r.out).toContain("Nothing was drained");
    expect(r.calls.some((l) => l.includes("--replicas="))).toBe(false);
    expect(firstIndex(r, "smoke ")).toBe(-1);
    expect(r.switchAfter).toBeUndefined();
  });

  test("--dry-run shows the choice and writes nothing", () => {
    const unset = run({ args: ["--dry-run", "--keep-paused"] });
    expect(unset.exitCode).toBe(0);
    expect(unset.out).toContain("--keep-paused: it would be SET before the drain and left set");
    expect(unset.out).toContain("resume phase       --keep-paused");
    expect(firstIndex(unset, "exec set_switch")).toBe(-1);
    expect(unset.switchAfter).toBeUndefined();
    expect(unset.calls.some((l) => l.includes("--replicas="))).toBe(false);

    const set = run({ args: ["--dry-run", "--keep-paused"], switchBefore: DRAIN_SWITCH });
    expect(set.out).toContain("--keep-paused: the resume phase would LEAVE it set");
    expect(set.switchAfter).toBe(DRAIN_SWITCH);

    const plain = run({ args: ["--dry-run"], switchBefore: DRAIN_SWITCH });
    expect(plain.out).toContain("the resume phase would clear it");
    expect(firstIndex(plain, "exec clear_switch")).toBe(-1);
  });

  test("--help prints the whole header and no shell", () => {
    const r = run({ args: ["--help"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("--keep-paused");
    expect(r.out).toContain("--namespace wrathbench --release wrathbench");
    expect(r.out).not.toContain("set -Eeuo");
  });
});
