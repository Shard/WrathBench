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
  /** False: `up -d fleet` does not refresh the heartbeat (the supervisor died). */
  boots?: boolean;
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

/** The script, Ctrl-C'd two seconds into its wait. */
function runAborted(c: Case): Result {
  return run({ ...c, interruptAfterS: 2, env: { WRATHBENCH_FLEET_TIMEOUT_S: "60", ...(c.env ?? {}) } });
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
    expect(r.out).toContain("2 run(s) still on their own clock");
    expect(r.out).toContain("TIMED OUT");
    // Nothing was recreated or stopped: the runs are untouched.
    expect(r.dockerCalls.filter((l) => l.includes("up -d") || l.includes("stop fleet"))).toEqual([]);
    // And the switch stays set, so the fleet is not quietly scheduling again.
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a DRAINING freeplay stream is counted as drained — it resumes in place, so the window completes", () => {
    // FOLLOW-UPS 93: an `idle: unlimited` session has no clock to finish on, so
    // a wait loop that treats it as live runs to its ceiling. The recreate
    // costs it nothing: it comes back on the same run id and character.
    const r = run({ jobs: [{ name: "sonnet-low-freeplay", episode: "freeplay", source: "policy", draining: true }], args: ["graceful"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("counted drained: sonnet-low-freeplay");
    expect(r.out).toContain("resumes in place");
    const up = r.dockerCalls.find((l) => l.includes("up -d"));
    expect(up).toContain("--force-recreate");
    expect(r.pauseFile).toBeNull();
  });

  test("graceful: a freeplay stream the switch has NOT reached yet is still waited on", () => {
    // `draining` is the proof the supervisor picked the switch up. It is also
    // what keeps a refused pin — deliberately spared from draining — holding
    // the window open, as OPERATIONS.md promises.
    const r = run({ jobs: [{ name: "sonnet-low-freeplay", episode: "freeplay", source: "policy", draining: false }], args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("TIMED OUT");
    expect(r.out).toContain("waiting on:      sonnet-low-freeplay");
    expect(r.dockerCalls.filter((l) => l.includes("up -d"))).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a scored e90 run still holds the window even while draining", () => {
    // The guarantee the parking must not eat: a scored attempt is spent if the
    // recreate lands on it, so it waits out its own clock.
    const r = run({ jobs: [{ name: "glm-e90", episode: "e90", source: "policy", draining: true }], args: ["graceful"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("1 run(s) still on their own clock");
    expect(r.out).toContain("waiting on:      glm-e90");
    expect(r.dockerCalls.filter((l) => l.includes("up -d"))).toEqual([]);
    expect(r.pauseFile?.paused).toBe(true);
  });

  test("graceful: a resume:true campaign run is parked only because the supervisor said so", () => {
    // The campaign's `resume` opt-in is the supervisor's to know — the switch
    // has to work while fleet.json is rejected, so the script never reads it.
    // A probing row without the flag waits; with it, it parks.
    const waits = run({ jobs: [{ name: "muse-class-probe-gnome-mage", episode: "probing", source: "policy", draining: true }], args: ["graceful"] });
    expect(waits.exitCode).toBe(1);
    expect(waits.out).toContain("waiting on:      muse-class-probe-gnome-mage");
    const parks = run({
      jobs: [{ name: "muse-class-probe-gnome-mage", episode: "probing", source: "policy", draining: true, resumesInPlace: true }],
      args: ["graceful"],
    });
    expect(parks.exitCode).toBe(0);
    expect(parks.out).toContain("counted drained: muse-class-probe-gnome-mage");
    expect(parks.pauseFile).toBeNull();
  });

  test("graceful: the supervisor's flag is believed in both directions", () => {
    // `resumesInPlace: false` on a freeplay row outranks the fallback that
    // would park it — the fallback is for supervisors that predate the field,
    // not a second opinion.
    const r = run({
      jobs: [{ name: "q-freeplay", episode: "freeplay", source: "queue", draining: true, resumesInPlace: false }],
      args: ["graceful"],
    });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("waiting on:      q-freeplay");
  });

  test("graceful: one parked stream and one scored run still waits", () => {
    const r = run({
      jobs: [
        { name: "sonnet-low-freeplay", episode: "freeplay", source: "policy", draining: true },
        { name: "glm-e90", episode: "e90", source: "policy", draining: true },
      ],
      args: ["graceful"],
    });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("waiting on:      glm-e90");
    expect(r.out).toContain("counted drained: sonnet-low-freeplay");
    expect(r.dockerCalls.filter((l) => l.includes("up -d"))).toEqual([]);
  });

  test("graceful: aborted with SIGINT, the switch stays SET and the message says how to clear it", () => {
    const r = runAborted({ jobs: [{ name: "glm-e90", episode: "e90", source: "policy", draining: true }], args: ["graceful"] });
    expect(r.out).toContain("PAUSE SWITCH IS STILL SET");
    expect(r.out).toContain("fleet-update.sh resume");
    expect(r.dockerCalls.filter((l) => l.includes("up -d") || l.includes("stop fleet"))).toEqual([]);
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
    // Nothing set the switch, so there is nothing to clear and nothing to wait for.
    expect(r.pauseFile).toBeNull();
    expect(r.out).not.toContain("first heartbeat");
  });

  test("force: a switch left set by an aborted graceful is cleared after the recreate", () => {
    // 2026-08-29: `force --yes` had to be followed by `resume` by hand. force
    // STARTS the container, so a switch it leaves set is a fleet that runs and
    // schedules nothing.
    const r = run({ aliveJobs: 1, paused_switch: true, args: ["force", "--yes"] });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("the pause switch is SET (set by hand)");
    expect(r.pauseFile).toBeNull();
  });

  test("force: a supervisor that does not come back leaves that switch SET", () => {
    const r = run({ aliveJobs: 1, paused_switch: true, boots: false, args: ["force", "--yes"] });
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("no fresh heartbeat");
    expect(r.pauseFile?.paused).toBe(true);
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
    expect(r.out).toContain("counts as drained");
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
