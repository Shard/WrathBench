/**
 * --resume after a pause: the stored pause mark is consumed, the
 * episode clock continues from what the paused segments had spent, and the
 * trajectory records the resume. Runs run.ts as a subprocess with the stub
 * driver; the sandbox only dials the module on connect(), which a stub that
 * never calls a tool never asks for.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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

/**
 * A paused policy-freeplay run as the live ones are actually stored: no wall
 * clock, and the 500-call ceiling the runner defaulted to when the fleet
 * emitted no `--max-tool-calls` for the lane. This is the shape
 * fleet-sub-opus-low-freeplay-opus-low-20260825-a6 was in at 410/500.
 */
function pausedFreeplayRun(storedCap: number | null = 500): { runsDir: string; runId: string } {
  const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-resume-freeplay-"));
  const runId = "fleet-sub-opus-low-freeplay-opus-low-20260825-a6";
  const script = join(runsDir, "stub.json");
  writeFileSync(script, JSON.stringify([{ content: "still going", toolCalls: [] }]));
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  const traj = new Trajectory(dir);
  const config = loadRunConfig({
    runId,
    token: newSessionToken(),
    driver: "stub",
    stubScript: script,
    stepIntervalMs: 0,
    episode: "freeplay",
    maxToolCallsPerEpisode: storedCap,
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    character: "Bramwick",
    race: 3,
    class: 2,
  });
  traj.writeMeta({ runId, harnessVersion: "0.0.0-test", startedAt: 1, config });
  traj.recordState(runId, { level: 12, xp: 4210 });
  traj.setPause(runId, "operator-pause", "SIGTERM: supervisor stop", 9 * 3_600_000);
  traj.writeMeta({
    ...readMeta(dir)!,
    pause: { reason: "operator-pause", detail: "SIGTERM: supervisor stop", at: Date.now(), episodeElapsedMs: 9 * 3_600_000 },
  });
  traj.close();
  return { runsDir, runId };
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

describe("--resume --max-tool-calls 0 migrates a run off the ceiling it was stored with", () => {
  test("the same run and the same character come back, with the ceiling rewritten to null", async () => {
    // The live case. a6 was stored with `maxToolCallsPerEpisode: 500` and had
    // reached 410 of it; run.ts reloads the stored config on --resume and only
    // overrides what a flag names, so without the flag it would have come back
    // under the 500 and ended `tool-call-limit` ninety calls later — at which
    // point the fleet starts a fresh freeplay run on a fresh level-1
    // character. The override has to actually rewrite the stored config.
    const { runsDir, runId } = pausedFreeplayRun(500);
    await resume(runsDir, runId, ["--max-tool-calls", "0", "--max-turns", "1"]);
    const dir = join(runsDir, runId);
    const meta = readMeta(dir)!;
    // Same run, same character, same account and session: identity is the
    // stored run's and a leash flag does not touch it.
    expect(meta.runId).toBe(runId);
    expect(meta.config.character).toBe("Bramwick");
    expect(meta.config.race).toBe(3);
    expect(meta.config.class).toBe(2);
    // The ceiling is gone, in the config and in the tuple, as null — never as
    // the argv sentinel 0.
    expect(meta.config.maxToolCallsPerEpisode).toBeNull();
    expect(meta.comparability?.budget.maxToolCalls).toBeNull();
    // The pause is consumed: it came back, it did not stay parked.
    expect(meta.pause).toBeUndefined();
    // And nothing fresh was started beside it — one run directory, the one
    // that was already there.
    expect(readdirSync(runsDir).filter((e) => e.startsWith("fleet-") || e.startsWith("run-"))).toEqual([runId]);
    const traj = new Trajectory(dir);
    expect(traj.runRow(runId)?.["pause_reason"]).toBeNull();
    traj.close();
  }, 30_000);

  test("without the override the stored ceiling stands — absence of a flag is not a migration", async () => {
    // The control, and the reason the flag exists at all: a resume that says
    // nothing about the ceiling leaves the stored one exactly where it was.
    const { runsDir, runId } = pausedFreeplayRun(500);
    await resume(runsDir, runId, ["--max-turns", "1"]);
    const meta = readMeta(join(runsDir, runId))!;
    expect(meta.runId).toBe(runId);
    expect(meta.config.maxToolCallsPerEpisode).toBe(500);
    expect(meta.comparability?.budget.maxToolCalls).toBe(500);
  }, 30_000);

  test("a numeric override on a resume is still a number", async () => {
    const { runsDir, runId } = pausedFreeplayRun(500);
    await resume(runsDir, runId, ["--max-tool-calls", "1000000", "--max-turns", "1"]);
    expect(readMeta(join(runsDir, runId))!.config.maxToolCallsPerEpisode).toBe(1_000_000);
  }, 30_000);
});
