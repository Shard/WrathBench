/**
 * Bash-level tests for infra/deploy-worldserver.sh.
 *
 * The script is the one thing in the repo that can quietly ship an unverified
 * worldserver, so the properties worth pinning are behavioural, not textual:
 * a failing smoke must roll back and exit non-zero, and "verified" must never
 * print unless a smoke actually ran. Both are asserted against the real script
 * with `docker` replaced by a PATH shim — no daemon, no containers, no deploy.
 *
 * Every case runs with FORCE_COLOR=3 in the environment, which is what made
 * bun colourise `console.log(900)` into `ESC[33m900ESC[0m` and broke the
 * script's arithmetic on 2026-08-22 (docs/WORKLOG.md).
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "deploy-worldserver.sh");

/**
 * A `docker` that answers everything the script asks without a daemon, logs
 * every invocation, and fails whichever step the case is about.
 *
 *   FAKE_SMOKE_RC      exit code for `compose exec ... -e MODULE_ACCOUNT=...`
 *   FAKE_HEALTH_RC     exit code for the /health probe exec
 *   FAKE_FLEET_RUNNING 1 => `compose ps --status running fleet` names a container
 *                      until `compose stop fleet` has been called
 *   FAKE_STOP_DRAINS   0 => `compose stop fleet` leaves the state's jobs alive
 *   FAKE_STATE_JSON    the fleet-state.json the stop shim edits
 *   FAKE_DOCKER_LOG    file every argv is appended to
 */
const DOCKER_SHIM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG}"
args="$*"
case "$1" in
  image)
    # image inspect: :next and :latest both exist (so there is a rollback target)
    if [[ "\${args}" == *"{{.Id}}"* ]]; then echo "sha256:0123456789abcdef"; fi
    exit 0 ;;
  tag) exit 0 ;;
  compose)
    if [[ "\${args}" == *" ps "* ]]; then
      if [[ "\${FAKE_FLEET_RUNNING:-0}" == "1" && ! -e "\${FAKE_DOCKER_LOG}.stopped" ]]; then echo "wrathbench-fleet-1"; fi
      exit 0
    fi
    if [[ "\${args}" == *" stop fleet"* ]]; then
      touch "\${FAKE_DOCKER_LOG}.stopped"
      # A clean stop: the supervisor writes its final state with no live job.
      if [[ "\${FAKE_STOP_DRAINS:-1}" == "1" && -n "\${FAKE_STATE_JSON:-}" ]]; then
        if ! sed 's/"alive": true/"alive": false/g' "\${FAKE_STATE_JSON}" > "\${FAKE_STATE_JSON}.tmp"; then exit 1; fi
        mv "\${FAKE_STATE_JSON}.tmp" "\${FAKE_STATE_JSON}" || exit 1
      fi
      exit 0
    fi
    if [[ "\${args}" == *" up -d fleet"* ]]; then rm -f "\${FAKE_DOCKER_LOG}.stopped"; exit "\${FAKE_FLEET_UP_RC:-0}"; fi
    if [[ "\${args}" == *" up "* ]]; then exit 0; fi
    # A smoke named FAIL.ts fails whatever FAKE_SMOKE_RC says; the rest obey it.
    if [[ "\${args}" == *"MODULE_ACCOUNT="* ]]; then [[ "\${args}" == *"FAIL.ts"* ]] && exit 1; exit "\${FAKE_SMOKE_RC:-0}"; fi
    if [[ "\${args}" == *"/health"* ]]; then exit "\${FAKE_HEALTH_RC:-0}"; fi
    exit 0 ;;
esac
exit 0
`;

interface Case {
  smokeRc?: number;
  fleetRunning?: boolean;
  heartbeatAgeMs?: number;
  smokes?: (string | { script: string; account?: string })[];
  deploySmokes?: (string | { script: string; account?: string })[];
  args?: string[];
  /** Jobs the supervisor lists with a live process before the deploy stops it. */
  aliveJobs?: number;
  /** False: `compose stop fleet` never makes the supervisor mark its jobs exited. */
  stopDrains?: boolean;
  /** Exit code of `compose up -d fleet`. */
  fleetUpRc?: number;
}

interface Result {
  exitCode: number;
  out: string;
  dockerCalls: string[];
  /** data/runs/server-state.json as the script left it (null when never written). */
  serverState: { phase: string; build: string; prevBuild?: string; detail: string; pid: number; since: number } | null;
}

function runDeploy(c: Case = {}): Result {
  const dir = mkdtempSync(join(tmpdir(), "wb-deploy-"));
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const shim = join(bin, "docker");
  writeFileSync(shim, DOCKER_SHIM);
  chmodSync(shim, 0o755);

  const fleetJson = join(dir, "fleet.json");
  writeFileSync(
    fleetJson,
    JSON.stringify({
      preflight: {
        enabled: true,
        account: "SMOKE",
        smokes: c.smokes ?? ["infra/smoke/module-quest.ts"],
        timeoutMs: 900_000,
        ...(c.deploySmokes !== undefined ? { deploySmokes: c.deploySmokes, deployTimeoutMs: 600_000 } : {}),
      },
    }),
  );
  const stateJson = join(dir, "fleet-state.json");
  const jobs: Record<string, { account: string; alive: boolean }> = {};
  for (let i = 0; i < (c.aliveJobs ?? 0); i++) jobs[`job-${i}`] = { account: `RUNNER${i}`, alive: true };
  writeFileSync(stateJson, JSON.stringify({ heartbeatAt: Date.now() - 5_000, jobs }, null, 2));
  const serverStateJson = join(dir, "server-state.json");
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");

  const proc = Bun.spawnSync(
    ["bash", SCRIPT, ...(c.args ?? [])],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        // The exact condition that broke the deploy: bun colourises numbers
        // into a pipe when this is set.
        FORCE_COLOR: "3",
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_SMOKE_RC: String(c.smokeRc ?? 0),
        FAKE_FLEET_RUNNING: c.fleetRunning === true ? "1" : "0",
        FAKE_STOP_DRAINS: c.stopDrains === false ? "0" : "1",
        FAKE_STATE_JSON: stateJson,
        FAKE_FLEET_UP_RC: String(c.fleetUpRc ?? 0),
        WRATHBENCH_DEPLOY_FLEET_JSON: fleetJson,
        WRATHBENCH_DEPLOY_STATE_JSON: stateJson,
        WRATHBENCH_DEPLOY_SERVER_STATE_JSON: serverStateJson,
        // The drain timeout is 60s in production; the stuck-supervisor case
        // must fail in seconds here.
        WRATHBENCH_DEPLOY_DRAIN_WAIT_S: "3",
        // The script refuses the window without the module's port secret
        // (module/PROTOCOL.md "Authentication"); the fixture stack has one.
        WRATHBENCH_MODULE_SECRET: "deploy-test-secret-".padEnd(48, "0"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    dockerCalls: readFileSync(dockerLog, "utf8").split("\n").filter(Boolean),
    serverState: existsSync(serverStateJson) ? (JSON.parse(readFileSync(serverStateJson, "utf8")) as Result["serverState"]) : null,
  };
}

describe("deploy-worldserver.sh", () => {
  test("a passing smoke deploys, says what verified it, and leaves the fleet up and the phase running", () => {
    const r = runDeploy({ smokeRc: 0, fleetRunning: true, aliveJobs: 2 });
    expect(r.exitCode).toBe(0);
    // No arithmetic blew up on a colourised number.
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(r.out).toContain("smoke infra/smoke/module-quest.ts — starting");
    expect(r.out).toMatch(/smoke infra\/smoke\/module-quest\.ts — PASSED in \d+s \(exit 0\)/);
    expect(r.out).toContain("DEPLOYED and verified by 1 direct smoke(s)");
    expect(r.out).not.toContain("ROLLING BACK");
    // The window, in order: drain, swap, verify, resume, running.
    const phases = r.out.split("\n").filter((l) => l.includes("deploy: phase ")).map((l) => /phase ([a-z-]+):/.exec(l)![1]);
    expect(phases).toEqual(["draining", "swapping", "swapping", "verifying", "resuming", "running"]);
    expect(r.out).toContain("2 job(s) live — each run pauses and resumes after the deploy");
    // The fleet was stopped before the swap and started after the verification.
    const stop = r.dockerCalls.findIndex((l) => l.endsWith("stop fleet"));
    const swap = r.dockerCalls.findIndex((l) => l.includes("up -d --no-deps worldserver"));
    const up = r.dockerCalls.findIndex((l) => l.endsWith("up -d fleet"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(swap);
    expect(swap).toBeLessThan(up);
    expect(r.serverState?.phase).toBe("running");
    expect(r.serverState?.detail).toContain("verified by 1 direct smoke(s)");
    expect(r.serverState?.pid).toBeGreaterThan(0);
  });

  test("a failing smoke rolls back, verifies the old build, brings the fleet up and exits non-zero", () => {
    // The shim fails every smoke, so the rolled-back build cannot verify either:
    // the honest phase is `failed`, and the fleet is still brought up.
    const r = runDeploy({ smokeRc: 1, fleetRunning: true, aliveJobs: 1 });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("FAILED after");
    expect(r.out).toContain("ROLLING BACK to wrathbench/worldserver:prev");
    expect(r.out).not.toContain("DEPLOYED and verified");
    // The rollback actually retagged and recreated, not just printed.
    expect(r.dockerCalls).toContain("tag wrathbench/worldserver:prev wrathbench/worldserver:latest");
    expect(r.dockerCalls.filter((l) => l.includes("up -d --no-deps worldserver")).length).toBe(2);
    // Never leaves the fleet stopped.
    expect(r.dockerCalls.filter((l) => l.endsWith("up -d fleet")).length).toBe(1);
    expect(r.serverState?.phase).toBe("failed");
    expect(r.serverState?.detail).toContain("could not verify it");
  });

  test("a full-arc failure after a passing gate rolls back to a build the gate smokes re-verify: phase rolled-back", () => {
    const r = runDeploy({
      smokes: [{ script: "infra/smoke/gate.ts", account: "SMOKE" }],
      deploySmokes: [{ script: "infra/smoke/FAIL.ts", account: "SMOKE3" }],
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("smoke infra/smoke/FAIL.ts — FAILED");
    expect(r.out).toContain("ROLLING BACK");
    expect(r.out).toContain("rolled back to");
    expect(r.serverState?.phase).toBe("rolled-back");
    expect(r.serverState?.detail).toContain("fleet resumed on the old build");
    // gate on new, full arc on new (fails), gate on old.
    expect(r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT=")).map((l) => /bun (\S+)$/.exec(l)![1])).toEqual([
      "infra/smoke/gate.ts",
      "infra/smoke/FAIL.ts",
      "infra/smoke/gate.ts",
    ]);
    expect(r.dockerCalls.filter((l) => l.endsWith("up -d fleet")).length).toBe(1);
  });

  test("every configured smoke runs, and the account is passed to each", () => {
    const r = runDeploy({ smokes: ["infra/smoke/a.ts", "infra/smoke/b.ts"] });
    expect(r.exitCode).toBe(0);
    const smokeCalls = r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT=SMOKE"));
    expect(smokeCalls.length).toBe(2);
    expect(smokeCalls[0]).toContain("infra/smoke/a.ts");
    expect(smokeCalls[1]).toContain("infra/smoke/b.ts");
    expect(r.out).toContain("DEPLOYED and verified by 2 direct smoke(s)");
  });

  test("per-entry accounts reach each smoke; the deploy-only full arc runs after the gate, on its own account", () => {
    const r = runDeploy({
      smokes: [{ script: "infra/smoke/quest-accept-status.ts", account: "SMOKE" }, { script: "infra/smoke/kill-credit.ts", account: "SMOKE2" }],
      deploySmokes: [{ script: "infra/smoke/module-quest.ts", account: "SMOKE3" }],
    });
    expect(r.exitCode).toBe(0);
    const smokeCalls = r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT="));
    expect(smokeCalls.map((l) => /MODULE_ACCOUNT=(\S+)/.exec(l)![1])).toEqual(["SMOKE", "SMOKE2", "SMOKE3"]);
    expect(smokeCalls[2]).toContain("infra/smoke/module-quest.ts");
    expect(r.out).toContain("running the deploy-time full arc (1 smoke(s), budget 600s)");
    expect(r.out).toContain("full-arc smoke infra/smoke/module-quest.ts (1 of 1) running since");
    expect(r.out).toContain("DEPLOYED and verified by 2 direct smoke(s) + 1 full-arc smoke(s)");
  });

  test("preflight with no smokes is UNVERIFIED, rolls back, and exits non-zero", () => {
    const r = runDeploy({ smokes: [] });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("DEPLOYED UNVERIFIED");
    expect(r.out).not.toContain("DEPLOYED and verified");
    expect(r.dockerCalls).toContain("tag wrathbench/worldserver:prev wrathbench/worldserver:latest");
  });

  test("--no-smoke deploys, says it verified nothing, and hands the server to the fleet", () => {
    const r = runDeploy({ args: ["--no-smoke"], fleetRunning: true });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("DEPLOYED UNVERIFIED");
    expect(r.out).not.toContain("DEPLOYED and verified");
    expect(r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT="))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.endsWith("up -d fleet")).length).toBe(1);
    expect(r.serverState?.phase).toBe("running");
    expect(r.serverState?.detail).toContain("UNVERIFIED");
  });

  test("a supervisor that never marks its jobs exited fails the drain loudly, swaps nothing, and the fleet is started again", () => {
    const r = runDeploy({ fleetRunning: true, aliveJobs: 3, stopDrains: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("still lists 3 live job(s)");
    expect(r.dockerCalls.filter((l) => l.startsWith("tag "))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.includes("up -d --no-deps worldserver"))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.endsWith("up -d fleet")).length).toBe(1);
    expect(r.serverState?.phase).toBe("failed");
    expect(r.serverState?.detail).toContain("the server was not swapped");
  });

  test("a fleet that was already stopped is deployed under and started at the end", () => {
    const r = runDeploy({ fleetRunning: false });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("nothing to drain");
    expect(r.dockerCalls.filter((l) => l.endsWith("stop fleet"))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.endsWith("up -d fleet")).length).toBe(1);
    expect(r.serverState?.phase).toBe("running");
  });

  test("a fleet that will not start leaves the phase failed with the command to run", () => {
    const r = runDeploy({ fleetRunning: true, fleetUpRc: 1 });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("FLEET DID NOT START");
    expect(r.serverState?.phase).toBe("failed");
    expect(r.serverState?.detail).toContain("up -d fleet");
  });

  test("--allow-live is refused by name", () => {
    const r = runDeploy({ args: ["--allow-live"] });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("--allow-live is gone");
    expect(r.dockerCalls).toEqual([]);
  });

  test("--dry-run with no smokes names the unverified path and still exits 0", () => {
    const r = runDeploy({ args: ["--dry-run"], smokes: [] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("smokes (0)");
    expect(r.out).toContain("NONE — preflight has no smokes");
  });

  test("--help prints the header and nothing of the script body", () => {
    const r = runDeploy({ args: ["--help"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("VERIFICATION IS FAIL-CLOSED");
    expect(r.out).not.toContain("set -Eeuo pipefail");
  });

  test("--dry-run resolves the numbers and touches nothing", () => {
    const r = runDeploy({ args: ["--dry-run"], fleetRunning: true, aliveJobs: 4 });
    expect(r.exitCode).toBe(0);
    // The value that arrived as ESC[33m900ESC[0m and killed the arithmetic.
    expect(r.out).toContain("preflight budget   900s");
    expect(r.out).toContain("jobs alive         4");
    expect(r.out).toContain("the deploy would stop it");
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(r.dockerCalls.filter((l) => l.startsWith("tag "))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.includes("up -d"))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.includes("stop"))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT="))).toEqual([]);
    expect(r.serverState).toBeNull();
  });
});
