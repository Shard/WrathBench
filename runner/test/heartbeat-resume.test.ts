/**
 * A run has one owner. The runner beats a heartbeat file for as long as its
 * process exists; `--resume` refuses a run whose heartbeat is fresh, writing
 * nothing, and takes a run whose heartbeat has gone cold — which is what a
 * SIGKILLed runner leaves behind, on whatever pod or host it died. Runs run.ts
 * as a subprocess with the stub driver: a hard kill with no SIGTERM at all,
 * a resume refused while the mark is warm, the same resume accepted once it
 * is cold, and a clean stop that removes the mark.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, newSessionToken } from "../src/config";
import { liveOwnerOf, readRunFact, RESUME_REFUSED_EXIT } from "../src/models";
import { HEARTBEAT_DEAD_MS, HEARTBEAT_FILE, heartbeatAt, startHeartbeat, Trajectory } from "../src/trajectory";

const RUN_TS = join(import.meta.dir, "..", "src", "run.ts");
const RUN_ID = "fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919";

async function until(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

function spawnRun(runsDir: string, args: string[]): ReturnType<typeof Bun.spawn> {
  return Bun.spawn({
    cmd: [process.execPath, RUN_TS, ...args, "--runs-dir", runsDir],
    cwd: runsDir,
    env: { ...process.env, WRATHBENCH_MODULE_URL: "http://127.0.0.1:9", WRATHBENCH_MODULE_SECRET: undefined },
    stdout: "ignore",
    stderr: "pipe",
  });
}

describe("the heartbeat", () => {
  test("beats at once, and a clean stop removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-beat-"));
    expect(heartbeatAt(dir)).toBeNull();
    const stop = startHeartbeat(dir, "host 1");
    expect(heartbeatAt(dir)).not.toBeNull();
    expect(readFileSync(join(dir, HEARTBEAT_FILE), "utf8")).toBe("host 1\n");
    stop();
    expect(heartbeatAt(dir)).toBeNull();
  });
});

describe("--resume and a run's live owner", () => {
  test("a hard-killed run is refused while its heartbeat is warm, untouched by the refusal, and resumed once it is cold", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-owner-"));
    const script = join(runsDir, "stub.json");
    writeFileSync(script, JSON.stringify([1, 2, 3, 4, 5, 6].map((i) => ({ content: `turn ${i}`, toolCalls: [] }))));
    const dir = join(runsDir, RUN_ID);
    const jsonl = join(dir, "trajectory.jsonl");
    const responses = (): number => (existsSync(jsonl) ? readFileSync(jsonl, "utf8").split("\n").filter((l) => l.includes('"t":"response"')).length : 0);

    const first = spawnRun(runsDir, [
      "--driver", "stub", "--stub", script,
      "--run-id", RUN_ID,
      "--episode", "freeplay",
      "--model", "deepseek/deepseek-v4.1-flash",
      "--module-url", "http://127.0.0.1:9",
      "--account", "RUNNER2",
      "--race", "3", "--class", "2",
      "--step-interval-ms", "60000",
    ]);
    void new Response(first.stderr as ReadableStream).text();
    await until(() => responses() >= 1, 20_000);
    expect(heartbeatAt(dir)).not.toBeNull();
    // No SIGTERM: the process gets no chance to write anything at all.
    first.kill("SIGKILL");
    await first.exited;

    // What the kill left: no verdict, and a heartbeat nobody removed.
    const t = new Trajectory(dir);
    const row = t.runRow(RUN_ID);
    t.close();
    expect(row?.["pause_reason"] ?? null).toBeNull();
    expect(row?.["termination_reason"] ?? null).toBeNull();
    expect(existsSync(join(dir, HEARTBEAT_FILE))).toBe(true);
    expect(liveOwnerOf(runsDir, RUN_ID)).toContain("heartbeat");

    // Warm heartbeat: refused, and nothing on disk moved.
    const before = { jsonl: readFileSync(jsonl, "utf8"), meta: readFileSync(join(dir, "meta.json"), "utf8"), beat: statSync(join(dir, HEARTBEAT_FILE)).mtimeMs };
    const refused = spawnRun(runsDir, ["--resume", RUN_ID]);
    const refusedErr = new Response(refused.stderr as ReadableStream).text();
    expect(await refused.exited).toBe(RESUME_REFUSED_EXIT);
    expect(await refusedErr).toContain("refused: the run has a live owner");
    expect(readFileSync(jsonl, "utf8")).toBe(before.jsonl);
    expect(readFileSync(join(dir, "meta.json"), "utf8")).toBe(before.meta);
    expect(statSync(join(dir, HEARTBEAT_FILE)).mtimeMs).toBe(before.beat);

    // Time passes with no owner: the heartbeat and the trajectory go cold.
    const cold = new Date(Date.now() - HEARTBEAT_DEAD_MS - 60_000);
    utimesSync(join(dir, HEARTBEAT_FILE), cold, cold);
    utimesSync(jsonl, cold, cold);
    const fact = readRunFact(runsDir, RUN_ID);
    expect(fact?.live).toBe(false);
    expect(fact?.heartbeatAt).toBe(cold.getTime());
    expect(liveOwnerOf(runsDir, RUN_ID)).toBeNull();

    // The same resume is now taken: same run id, a `resume` record, and the
    // new owner is beating.
    const second = spawnRun(runsDir, ["--resume", RUN_ID]);
    void new Response(second.stderr as ReadableStream).text();
    await until(() => readFileSync(jsonl, "utf8").includes('"t":"resume"'), 20_000);
    await until(() => (heartbeatAt(dir) ?? 0) > cold.getTime(), 5_000);
    expect(readRunFact(runsDir, RUN_ID)?.live).toBe(true);
    // A second resume while the first is playing is refused like any other.
    const double = spawnRun(runsDir, ["--resume", RUN_ID]);
    void new Response(double.stderr as ReadableStream).text();
    expect(await double.exited).toBe(RESUME_REFUSED_EXIT);

    second.kill("SIGKILL");
    await second.exited;
  }, 90_000);

  test("a runner that exits on its own takes its heartbeat with it, so the next resume waits for nothing", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-owner-exit-"));
    const script = join(runsDir, "stub.json");
    writeFileSync(script, JSON.stringify([{ content: "turn 1", toolCalls: [] }]));
    const proc = spawnRun(runsDir, [
      "--driver", "stub", "--stub", script,
      "--run-id", RUN_ID,
      "--episode", "freeplay",
      "--model", "deepseek/deepseek-v4.1-flash",
      "--module-url", "http://127.0.0.1:9",
      "--account", "RUNNER2",
      "--race", "3", "--class", "2",
      "--step-interval-ms", "10",
    ]);
    void new Response(proc.stderr as ReadableStream).text();
    await proc.exited;
    const dir = join(runsDir, RUN_ID);
    expect(existsSync(join(dir, "trajectory.jsonl"))).toBe(true);
    expect(existsSync(join(dir, HEARTBEAT_FILE))).toBe(false);
    expect(liveOwnerOf(runsDir, RUN_ID)).toBeNull();
  }, 40_000);

  test("a run with no heartbeat file keeps the old reading: a warm verdict-less trajectory is an owner, a paused one is not", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-owner-old-"));
    const dir = join(runsDir, RUN_ID);
    const t = new Trajectory(dir);
    const config = loadRunConfig({
      runId: RUN_ID,
      token: newSessionToken(),
      driver: "openai",
      model: "deepseek/deepseek-v4.1-flash",
      episode: "freeplay",
      extra: true,
      runsDir,
      moduleUrl: "http://127.0.0.1:9",
      account: "RUNNER2",
      race: 3,
      class: 2,
      watchdogs: { idleMs: 1_200_000 },
    });
    t.writeMeta({ runId: RUN_ID, harnessVersion: "harness-0.5-1", startedAt: Date.now() - 3_600_000, config, comparability: comparabilityOf(config, "harness-0.5-1") });
    t.append({ t: "response", text: "…" });
    t.recordState(RUN_ID, { level: 1, xp: 0 });
    expect(readRunFact(runsDir, RUN_ID)?.idleMs).toBe(1_200_000);
    expect(liveOwnerOf(runsDir, RUN_ID)).toContain("trajectory");
    t.setPause(RUN_ID, "operator-pause");
    expect(liveOwnerOf(runsDir, RUN_ID)).toBeNull();
    t.close();
  });
});
