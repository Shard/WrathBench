/**
 * The verdict is written the instant SIGTERM lands, before the driver is
 * asked to unwind. Replays 2026-09-20: the kubelet evicted the fleet pod under
 * DiskPressure and SIGKILLed it two seconds after SIGTERM, inside the
 * cooperative unwind, and the freeplay run it was playing was left with
 * neither a termination nor a pause. Runs run.ts as a subprocess with the
 * stub driver, sends SIGTERM mid-sleep and SIGKILL well inside any unwind,
 * and reads what is on disk afterwards.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trajectory, readMeta } from "../src/trajectory";

const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");
const RUN_ID = "fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919";

async function until(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

describe("SIGTERM writes the pause before anything else", () => {
  test("a SIGKILL right after SIGTERM still leaves run.sqlite paused and meta.json marked", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-sigterm-"));
    const script = join(runsDir, "stub.json");
    // Three turns with a long step interval: the runner is asleep between
    // turns when the signal lands, exactly as a fleet run is between requests.
    writeFileSync(script, JSON.stringify([1, 2, 3].map((i) => ({ content: `turn ${i}`, toolCalls: [] }))));
    const proc = Bun.spawn({
      cmd: [
        process.execPath, RUN_TS,
        "--driver", "stub", "--stub", script,
        "--run-id", RUN_ID,
        "--episode", "freeplay",
        "--runs-dir", runsDir,
        "--module-url", "http://127.0.0.1:9",
        "--account", "RUNNER2",
        "--race", "3", "--class", "2",
        "--step-interval-ms", "60000",
      ],
      cwd: runsDir,
      env: { ...process.env, WRATHBENCH_MODULE_URL: "http://127.0.0.1:9", WRATHBENCH_MODULE_SECRET: undefined },
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderrText = new Response(proc.stderr).text();
    const jsonl = join(runsDir, RUN_ID, "trajectory.jsonl");
    // In the loop: the first response is on disk, the runner is in its sleep.
    await until(() => existsSync(jsonl) && readFileSync(jsonl, "utf8").includes('"t":"response"'), 20_000);
    proc.kill("SIGTERM");
    // The kubelet's grace was two seconds; give the cooperative unwind far
    // less than that, so only what the handler wrote synchronously survives.
    await Bun.sleep(150);
    proc.kill("SIGKILL");
    await proc.exited;
    const stderr = await stderrText;
    expect(stderr).toContain("pausing run as `operator-pause`");

    const dir = join(runsDir, RUN_ID);
    const traj = new Trajectory(dir);
    const row = traj.runRow(RUN_ID);
    traj.close();
    expect(row?.["pause_reason"]).toBe("operator-pause");
    expect(row?.["termination_reason"]).toBeNull();
    const meta = readMeta(dir);
    expect(meta?.pause?.reason).toBe("operator-pause");
    expect(meta?.pause?.detail).toBe("SIGTERM: supervisor stop");
    // Exactly one pause record, whether or not the driver's own unwind got
    // as far as its write: the verdict is written once per segment.
    const pauses = readFileSync(jsonl, "utf8").split("\n").filter((l) => l.includes('"t":"pause"'));
    expect(pauses).toHaveLength(1);
  }, 40_000);
});
