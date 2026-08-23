/**
 * --resume after a pause (ADR-0036): the stored pause mark is consumed, the
 * episode clock continues from what the paused segments had spent, and the
 * trajectory records the resume. Runs run.ts as a subprocess with the stub
 * driver; the sandbox only dials the module on connect(), which a stub that
 * never calls a tool never asks for.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig, newSessionToken } from "../src/config";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";

const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");

function pausedStubRun(elapsedMs: number): { runsDir: string; runId: string; script: string } {
  const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-resume-"));
  const runId = "run-paused";
  const script = join(runsDir, "stub.json");
  writeFileSync(script, JSON.stringify([{ content: "hello", toolCalls: [] }, { content: "again", toolCalls: [] }]));
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  const traj = new Trajectory(dir);
  const config = loadRunConfig({
    runId,
    token: newSessionToken(),
    driver: "stub",
    stubScript: script,
    stepIntervalMs: 0,
    episode: "e90",
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    character: "Navprobe",
    race: 3,
    class: 2,
  });
  traj.writeMeta({ runId, harnessVersion: "0.0.0-test", startedAt: 1, config });
  // Where the character was left, so the resume note can say so.
  traj.recordState(runId, { level: 4, xp: 586 });
  traj.setPause(runId, "operator-pause", "SIGTERM: supervisor stop", elapsedMs);
  traj.writeMeta({
    ...readMeta(dir)!,
    pause: { reason: "operator-pause", detail: "SIGTERM: supervisor stop", at: Date.now(), episodeElapsedMs: elapsedMs },
  });
  traj.close();
  return { runsDir, runId, script };
}

async function resume(runsDir: string, runId: string, extra: string[] = []): Promise<string> {
  const proc = Bun.spawn({
    cmd: [process.execPath, RUN_TS, "--resume", runId, "--runs-dir", runsDir, ...extra],
    cwd: runsDir,
    env: { ...process.env, WRATHBENCH_MODULE_URL: "http://127.0.0.1:9" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return stderr;
}

describe("--resume after a pause", () => {
  test("the episode clock continues: a carried 100m on a 90m budget trips episode-limit at once", async () => {
    const { runsDir, runId } = pausedStubRun(100 * 60_000);
    const stderr = await resume(runsDir, runId);
    expect(stderr).toContain("episode clock resumes at 100m");
    /*
     * It terminates without ever answering, so the runner archives it on the
     * way out — the rule is about the whole run, and a resumed segment that
     * adds no response leaves a run that still produced none. The records are
     * all there, in the archive.
     */
    expect(stderr).toContain("no model response — archived");
    const dir = join(runsDir, "archive", runId);
    const records = readTrajectory(dir);
    const resumed = records.find((r) => r.t === "resume");
    expect(resumed?.["after"]).toBe("operator-pause");
    expect(resumed?.["episodeElapsedMs"]).toBe(100 * 60_000);
    const term = records.find((r) => r.t === "termination");
    expect(term?.["reason"]).toBe("episode-limit");
    // The pause mark is consumed and the row is no longer paused.
    expect(readMeta(dir)?.pause).toBeUndefined();
    const traj = new Trajectory(dir);
    expect(traj.runRow(runId)?.["pause_reason"]).toBeNull();
    expect(traj.runRow(runId)?.["termination_reason"]).toBe("episode-limit");
    traj.close();
  }, 30_000);

  test("a carried clock under the budget lets the run continue and play its turns", async () => {
    const { runsDir, runId } = pausedStubRun(10 * 60_000);
    const stderr = await resume(runsDir, runId, ["--max-turns", "1"]);
    expect(stderr).toContain("episode clock resumes at 10m");
    const records = readTrajectory(join(runsDir, runId));
    expect(records.filter((r) => r.t === "response")).toHaveLength(1);
    expect(records.find((r) => r.t === "termination")?.["reason"]).toBe("turn-limit");
    // A wrathbench-harness resume reattaches its own loop: never stamped resumedFresh.
    expect(readMeta(join(runsDir, runId))?.resumedFresh).toBeUndefined();
  }, 30_000);

  test("the resume note names the character, its race and class, and the clock", async () => {
    // fleet-nav-probe-freeplay-sonnet-20260823-c3 resumed with a note that said
    // `createSession({...})`, guessed a name, and rolled a second character
    // beside the one the pause had preserved.
    const { runsDir, runId } = pausedStubRun(10 * 60_000);
    await resume(runsDir, runId, ["--max-turns", "1"]);
    const records = readTrajectory(join(runsDir, runId));
    const req = records.find((r) => r.t === "request");
    const sent = JSON.stringify(req?.["messages"] ?? "");
    expect(sent).toContain("Navprobe");
    expect(sent).toContain("Dwarf");
    expect(sent).toContain("Paladin");
    expect(sent).toContain("resumed after a pause, 10 minutes elapsed of 90");
    expect(sent).toContain("last observed at level 4 with 586 xp");
    expect(sent).not.toContain("createSession({...})");
  }, 30_000);
});
