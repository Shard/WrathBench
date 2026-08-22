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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      if [[ "\${FAKE_FLEET_RUNNING:-0}" == "1" ]]; then echo "wrathbench-fleet-1"; fi
      exit 0
    fi
    if [[ "\${args}" == *" up "* ]]; then exit 0; fi
    if [[ "\${args}" == *"MODULE_ACCOUNT="* ]]; then exit "\${FAKE_SMOKE_RC:-0}"; fi
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
  /** A gate record the supervisor "wrote" after this deploy started. */
  gate?: "pass" | "fail";
}

interface Result {
  exitCode: number;
  out: string;
  dockerCalls: string[];
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
  writeFileSync(
    stateJson,
    JSON.stringify({
      heartbeatAt: Date.now() - (c.heartbeatAgeMs ?? 5_000),
      // `at` in the future so it is unambiguously after this deploy's stamp,
      // which is what the script keys on (never on an identity string).
      preflight:
        c.gate === undefined
          ? undefined
          : {
              at: Date.now() + 60_000,
              ok: c.gate === "pass",
              results: [{ script: "infra/smoke/module-quest.ts", ok: c.gate === "pass", tail: "boom" }],
            },
    }),
  );
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");

  const proc = Bun.spawnSync(
    // --allow-live: the live-episode refusal reads the real trajectory stores
    // and is not what these cases are about.
    ["bash", SCRIPT, "--allow-live", ...(c.args ?? [])],
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
        WRATHBENCH_DEPLOY_FLEET_JSON: fleetJson,
        WRATHBENCH_DEPLOY_STATE_JSON: stateJson,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    dockerCalls: readFileSync(dockerLog, "utf8").split("\n").filter(Boolean),
  };
}

describe("deploy-worldserver.sh", () => {
  test("a passing smoke deploys, and says what verified it", () => {
    const r = runDeploy({ smokeRc: 0 });
    expect(r.exitCode).toBe(0);
    // No arithmetic blew up on a colourised number.
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(r.out).toContain("smoke infra/smoke/module-quest.ts — starting");
    expect(r.out).toMatch(/smoke infra\/smoke\/module-quest\.ts — PASSED in \d+s \(exit 0\)/);
    expect(r.out).toContain("DEPLOYED and verified by 1 direct smoke(s)");
    expect(r.out).not.toContain("ROLLING BACK");
  });

  test("a failing smoke rolls back and exits non-zero", () => {
    const r = runDeploy({ smokeRc: 1 });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("FAILED after");
    expect(r.out).toContain("ROLLING BACK to wrathbench/worldserver:prev");
    expect(r.out).not.toContain("DEPLOYED and verified");
    // The rollback actually retagged and recreated, not just printed.
    expect(r.dockerCalls).toContain("tag wrathbench/worldserver:prev wrathbench/worldserver:latest");
    expect(r.dockerCalls.filter((l) => l.includes("up -d --no-deps worldserver")).length).toBe(2);
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
    expect(r.out).toContain("DEPLOYED and verified by 2 direct smoke(s) + 1 full-arc smoke(s)");
  });

  test("the full arc runs after a fleet-gate pass too, and its failure rolls back", () => {
    const ok = runDeploy({ fleetRunning: true, gate: "pass", deploySmokes: ["infra/smoke/module-quest.ts"] });
    expect(ok.exitCode).toBe(0);
    expect(ok.out).toContain("fleet gate PASSED");
    expect(ok.out).toContain("DEPLOYED and verified by fleet gate + 1 full-arc smoke(s)");
    const bad = runDeploy({ fleetRunning: true, gate: "pass", deploySmokes: ["infra/smoke/module-quest.ts"], smokeRc: 1 });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.out).toContain("smoke infra/smoke/module-quest.ts — FAILED");
    expect(bad.out).not.toContain("DEPLOYED and verified");
    expect(bad.dockerCalls).toContain("tag wrathbench/worldserver:prev wrathbench/worldserver:latest");
  });

  test("preflight with no smokes is UNVERIFIED and non-zero, never 'verified'", () => {
    const r = runDeploy({ smokes: [] });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("DEPLOYED UNVERIFIED");
    expect(r.out).not.toContain("DEPLOYED and verified");
  });

  test("--no-smoke deploys and says it verified nothing", () => {
    const r = runDeploy({ args: ["--no-smoke"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("DEPLOYED UNVERIFIED");
    expect(r.out).not.toContain("DEPLOYED and verified");
    expect(r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT="))).toEqual([]);
  });

  test("a fresh heartbeat from a stopped container does not count as gating", () => {
    // The 2026-08-22 defect: fleet stopped seconds ago, heartbeat still fresh,
    // script announced "fleet supervisor is up and gating" and waited on it.
    const r = runDeploy({ fleetRunning: false, heartbeatAgeMs: 5_000 });
    expect(r.out).toContain("the fleet supervisor is not gating");
    expect(r.out).not.toContain("up (container running");
    expect(r.out).toContain("DEPLOYED and verified by 1 direct smoke(s)");
    expect(r.exitCode).toBe(0);
  });

  test("a running container with a stale heartbeat does not count as gating", () => {
    const r = runDeploy({ fleetRunning: true, heartbeatAgeMs: 600_000 });
    expect(r.out).toContain("the fleet supervisor is not gating");
    expect(r.out).toContain("smoking directly");
    expect(r.exitCode).toBe(0);
  });

  test("a passing fleet gate verifies without smoking anything directly", () => {
    const r = runDeploy({ fleetRunning: true, heartbeatAgeMs: 5_000, gate: "pass" });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("up (container running");
    expect(r.out).toContain("fleet gate PASSED");
    expect(r.out).toContain("DEPLOYED and verified by fleet gate");
    expect(r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT="))).toEqual([]);
  });

  test("a failing fleet gate rolls back and exits non-zero", () => {
    const r = runDeploy({ fleetRunning: true, heartbeatAgeMs: 5_000, gate: "fail" });
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain("fleet gate FAILED");
    expect(r.out).toContain("ROLLING BACK");
    expect(r.out).not.toContain("DEPLOYED and verified");
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
    const r = runDeploy({ args: ["--dry-run"] });
    expect(r.exitCode).toBe(0);
    // The value that arrived as ESC[33m900ESC[0m and killed the arithmetic.
    expect(r.out).toContain("preflight budget   900s");
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(r.dockerCalls.filter((l) => l.startsWith("tag "))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.includes("up -d"))).toEqual([]);
    expect(r.dockerCalls.filter((l) => l.includes("MODULE_ACCOUNT="))).toEqual([]);
  });
});
