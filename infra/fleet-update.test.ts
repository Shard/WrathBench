/**
 * Bash-level tests for infra/fleet-update.sh, in the shape
 * infra/deploy-worldserver.test.ts established: the real script, `docker`
 * replaced by a PATH shim, no daemon and no containers.
 *
 * The properties worth pinning are the ones that cost money when they are
 * wrong: the graceful path must not touch compose until the supervisor's own
 * state file says no job is alive, it must never drop `--no-deps` (which is how
 * a fleet update recreates the worldserver under live episodes), and a timeout
 * must leave the switch set rather than fall through to a kill.
 *
 * FORCE_COLOR=3 throughout: that is what colourised a number into a pipe and
 * broke the deploy script's arithmetic on 2026-08-22.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "infra", "fleet-update.sh");

/**
 * A `docker` that logs every argv and answers `ps`. `up -d ... fleet` refreshes
 * the state file's heartbeat, which is how the script knows the new supervisor
 * came back.
 */
const DOCKER_SHIM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG}"
args="$*"
if [[ "\${args}" == *" ps "* ]]; then
  if [[ "\${FAKE_FLEET_RUNNING:-1}" == "1" ]]; then echo "wrathbench-fleet-1"; fi
  exit 0
fi
if [[ "\${args}" == *" up "* && -n "\${FAKE_STATE_JSON:-}" && "\${FAKE_BOOT:-1}" == "1" ]]; then
  bun -e 'const p=process.argv[1];const s=await Bun.file(p).json();s.heartbeatAt=Date.now();delete s.pausedSwitch;await Bun.write(p,JSON.stringify(s,null,2));' "\${FAKE_STATE_JSON}"
fi
exit 0
`;

interface Case {
  /** Jobs the supervisor's state lists with a live roster process. */
  aliveJobs?: number;
  /** Seconds since the supervisor's last heartbeat. */
  heartbeatAgeS?: number;
  /** Paused runs the supervisor is not resuming. */
  paused?: { runId: string; model: string; reason: string; elapsedMs: number; budgetMs: number }[];
  /** The supervisor has already picked the switch up. */
  pickedUp?: boolean;
  /** False: `up -d fleet` does not refresh the heartbeat (the supervisor died). */
  boots?: boolean;
  args: string[];
  /** Pre-existing pause file. */
  paused_switch?: boolean;
  /** Write a truncated state file: a poll that landed mid-writeState. */
  corruptState?: boolean;
  env?: Record<string, string>;
}

interface Result {
  exitCode: number;
  out: string;
  dockerCalls: string[];
  /** The pause sidecar as the script left it, or null. */
  pauseFile: { paused: boolean; why: string; at: number } | null;
}

function run(c: Case): Result {
  const dir = mkdtempSync(join(tmpdir(), "wb-fleet-update-"));
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const shim = join(bin, "docker");
  writeFileSync(shim, DOCKER_SHIM);
  chmodSync(shim, 0o755);

  const stateJson = join(dir, "fleet-state.json");
  const jobs: Record<string, { account: string; alive: boolean }> = {};
  for (let i = 0; i < (c.aliveJobs ?? 0); i++) jobs[`job-${i}`] = { account: `RUNNER${i}`, alive: true };
  writeFileSync(
    stateJson,
    JSON.stringify(
      {
        heartbeatAt: Date.now() - (c.heartbeatAgeS ?? 5) * 1000,
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
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");

  const proc = Bun.spawnSync(["bash", SCRIPT, ...c.args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FORCE_COLOR: "3",
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_STATE_JSON: stateJson,
      FAKE_BOOT: c.boots === false ? "0" : "1",
      WRATHBENCH_FLEET_STATE_JSON: stateJson,
      WRATHBENCH_FLEET_PAUSE_JSON: pauseJson,
      WRATHBENCH_FLEET_POLL_S: "1",
      WRATHBENCH_FLEET_BOOT_WAIT_S: "3",
      WRATHBENCH_FLEET_TIMEOUT_S: "3",
      ...c.env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    dockerCalls: readFileSync(dockerLog, "utf8").split("\n").filter(Boolean),
    pauseFile: existsSync(pauseJson) ? (JSON.parse(readFileSync(pauseJson, "utf8")) as Result["pauseFile"]) : null,
  };
}

describe("fleet-update.sh", () => {
  test("graceful: sets the switch, waits for quiet, recreates with --no-deps, clears the switch", () => {
    const r = run({ aliveJobs: 0, args: ["graceful"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).not.toContain("arithmetic syntax error");
    expect(r.out).toContain("pause switch SET");
    expect(r.out).toContain("quiet: no job holds a live episode");
    expect(r.out).toContain("no run was interrupted");
    const up = r.dockerCalls.find((l) => l.includes("up -d"));
    expect(up).toContain("--no-deps");
    expect(up).toContain("--force-recreate");
    // The switch is gone: the new supervisor schedules again.
    expect(r.pauseFile).toBeNull();
  });

  test("graceful: a job still live holds the window open and times out WITHOUT killing anything", () => {
    const r = run({ aliveJobs: 2, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("2 job(s) still live");
    expect(r.out).toContain("TIMED OUT");
    // Nothing was recreated or stopped: the runs are untouched.
    expect(r.dockerCalls.filter((l) => l.includes("up -d") || l.includes("stop fleet"))).toEqual([]);
    // And the switch stays set, so the fleet is not quietly scheduling again.
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a provider-paused run is named before the wait — a long window turns it into a counted failure", () => {
    const r = run({
      aliveJobs: 2,
      paused: [{ runId: "fleet-glm-e90-20260825", model: "z-ai/glm-5.3", reason: "rate-limited", elapsedMs: 41 * 60_000, budgetMs: 90 * 60_000 }],
      args: ["graceful"],
    });
    expect(r.out).toContain("COUNTED failed attempt");
    expect(r.out).toContain("fleet-glm-e90-20260825");
    expect(r.out).toContain("41m of 90m");
  });

  test("graceful: a state file that did not parse is NOT quiet — the recreate never happens", () => {
    // writeState is a plain writeFileSync, so a poll can land mid-write. Reading
    // that as "no job is alive" would recreate the container over live
    // episodes, which is the one thing this path exists to prevent.
    const r = run({ corruptState: true, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("did not parse this poll");
    expect(r.dockerCalls.filter((l) => l.includes("up -d") || l.includes("stop fleet"))).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a dead supervisor's frozen job rows are not quiet either", () => {
    // No jobs alive, but nothing has ticked in an hour: the rows are stale and
    // say nothing about what is running. Timing out is the honest answer.
    const r = run({ aliveJobs: 0, heartbeatAgeS: 3600, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("is not ticking");
    expect(r.dockerCalls.filter((l) => l.includes("up -d"))).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a supervisor that does not come back leaves the switch SET", () => {
    const r = run({ aliveJobs: 0, boots: false, args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("no fresh heartbeat");
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("drain: waits for quiet, stops the fleet, and LEAVES the switch set for the deploy", () => {
    const r = run({ aliveJobs: 0, args: ["drain"] });
    expect(r.exitCode).toBe(0);
    expect(r.dockerCalls.some((l) => l.endsWith("stop fleet"))).toBe(true);
    expect(r.dockerCalls.filter((l) => l.includes("--force-recreate"))).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
    expect(r.out).toContain("fleet-update.sh resume");
  });

  test("force: says what it costs, recreates immediately with --no-deps, and needs --yes to do it unattended", () => {
    const r = run({ aliveJobs: 3, args: ["force", "--yes"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("3 job(s) are live");
    expect(r.out).toContain("attempt is spent");
    const up = r.dockerCalls.find((l) => l.includes("up -d"));
    expect(up).toContain("--no-deps");
    expect(up).toContain("--force-recreate");
    // Force does not wait for anything and does not touch the switch.
    expect(r.pauseFile).toBeNull();
  });

  test("force without --yes on a pipe refuses rather than recreating", () => {
    const r = run({ aliveJobs: 3, args: ["force"] });
    expect(r.exitCode).not.toBe(0);
    expect(r.dockerCalls.filter((l) => l.includes("up -d"))).toEqual([]);
  });

  test("--dry-run writes nothing, runs no compose command, and prints the plan", () => {
    const r = run({ aliveJobs: 2, args: ["graceful", "--dry-run"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("would: write");
    expect(r.out).toContain("--force-recreate fleet");
    expect(r.pauseFile).toBeNull();
    expect(r.dockerCalls.filter((l) => l.includes("up -d") || l.includes("stop"))).toEqual([]);
  });

  test("resume clears the switch and nothing else; status reads it back without changing it", () => {
    const cleared = run({ paused_switch: true, args: ["resume"] });
    expect(cleared.exitCode).toBe(0);
    expect(cleared.pauseFile).toBeNull();
    const s = run({ paused_switch: true, aliveJobs: 1, pickedUp: true, args: ["status"] });
    expect(s.exitCode).toBe(0);
    expect(s.out).toContain("pause switch");
    expect(s.out).toContain("SET");
    expect(s.out).toContain("picked up      yes");
    expect(s.out).toContain("jobs alive     1");
    expect(s.pauseFile?.paused).toBe(true);
  });

  test("a mode is required, and two modes are refused", () => {
    expect(run({ args: [] }).exitCode).toBe(2);
    expect(run({ args: ["graceful", "force"] }).exitCode).toBe(2);
    expect(run({ args: ["--timeout", "soon", "graceful"] }).exitCode).toBe(2);
  });
});
