/**
 * A verdict the runner recorded but could not write into its run row (a 0.5
 * run.sqlite whose write met a lock past its retries; meta.json, now, on a
 * full disk).
 *
 * `Trajectory.setTermination` appends the `termination` record first and then
 * writes the row, so a row write that fails leaves the record alone. Before, such a run read as ownerless
 * once its heartbeat went cold: a resuming lane stamped it `offline` and
 * brought back a run that had recorded its own end, and the stale sweep ended
 * a scored one a second time under another reason. `readRunFact` now takes
 * the verdict from the trajectory when the row has none, and the supervisor
 * writes it into the row (`repairRecordedTerminations`) without a second
 * record.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { comparabilityOf } from "../runner/src/comparability";
import { loadRunConfig, newSessionToken } from "../runner/src/config";
import { readRunFact, terminationOfTrajectory, verdictOfTrajectory } from "../runner/src/models";
import { HEARTBEAT_FILE, readTrajectory, Trajectory } from "../runner/src/trajectory";
import { implicitPauses, repairRecordedTerminations } from "./run-fleet";
import { tempDirs } from "./temp-dirs";
import { writeFileSync } from "node:fs";

const tempDir = tempDirs();
const HARNESS = "harness-0.5-1068-g0000000";

/** A freeplay fleet run whose runner appended its termination record and lost the row write. */
async function runWithRecordOnly(runsDir: string, runId: string, after: (t: Trajectory) => void = () => {}): Promise<string> {
  const dir = join(runsDir, runId);
  const t = new Trajectory(dir);
  const config = loadRunConfig({
    runId,
    token: newSessionToken(),
    driver: "openai",
    model: "z-ai/glm-5.2:free",
    episode: "freeplay",
    extra: true,
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    account: "RUNNER3",
    character: "Thalvorn",
    race: 3,
    class: 2,
  });
  await t.writeMeta({ runId, harnessVersion: HARNESS, startedAt: Date.now() - 3_600_000, config, comparability: comparabilityOf(config, HARNESS) });
  t.append({ t: "response", text: "…" });
  // What `setTermination` appends before its row write, and the retries' records after.
  t.append({ t: "termination", reason: "harness-error", detail: "SQLiteError: database is locked" });
  t.append({ t: "harness", kind: "rundb_retry", write: "termination", attempt: 1, waitMs: 5000, error: "SQLITE_BUSY: database is locked" });
  after(t);
  t.close();
  return dir;
}

describe("a termination on record but not in the row", () => {
  test("reads as the run's verdict once nothing owns the run, so a resuming lane does not bring it back", async () => {
    const runsDir = tempDir("wb-rec-term-");
    await runWithRecordOnly(runsDir, "fleet-rec-a1");
    const f = readRunFact(runsDir, "fleet-rec-a1", Date.now() + 10 * 60_000)!;
    expect(f.terminationReason).toBe("harness-error");
    expect(f.live).toBe(false);
    expect(f.recordedTermination).toMatchObject({ reason: "harness-error", detail: "SQLiteError: database is locked" });
    // Not stamped `offline`, which is what would have resumed it.
    expect(implicitPauses({ runs: [f], now: Date.now() + 10 * 60_000 })[0]!.pause).toBeNull();
  });

  test("is not read while the runner still beats, nor when a resume came after it", async () => {
    const runsDir = tempDir("wb-rec-term-");
    const beating = await runWithRecordOnly(runsDir, "fleet-rec-a2");
    writeFileSync(join(beating, HEARTBEAT_FILE), "host 1\n");
    expect(readRunFact(runsDir, "fleet-rec-a2", Date.now())!.terminationReason).toBeNull();

    const resumed = await runWithRecordOnly(runsDir, "fleet-rec-a3", (t) => t.append({ t: "resume", harnessVersion: "v" }));
    expect(terminationOfTrajectory(join(resumed, "trajectory.jsonl"))).toBeNull();
    expect(readRunFact(runsDir, "fleet-rec-a3", Date.now() + 10 * 60_000)!.terminationReason).toBeNull();
  });

  test("the supervisor writes it into the row, once, and appends nothing", async () => {
    const runsDir = tempDir("wb-rec-term-");
    const dir = await runWithRecordOnly(runsDir, "fleet-rec-a4");
    const before = readTrajectory(dir).length;
    const now = Date.now() + 10 * 60_000;
    const f = readRunFact(runsDir, "fleet-rec-a4", now)!;
    expect(repairRecordedTerminations(runsDir, [f])).toEqual([{ runId: "fleet-rec-a4" }]);
    expect(readTrajectory(dir).length).toBe(before);
    const t = new Trajectory(dir);
    try {
      expect(t.runRow("fleet-rec-a4")).toMatchObject({ termination_reason: "harness-error", termination_detail: "SQLiteError: database is locked" });
    } finally {
      t.close();
    }
    // Read again, the verdict is the row's, and nothing is left to repair.
    const again = readRunFact(runsDir, "fleet-rec-a4", now)!;
    expect(again.terminationReason).toBe("harness-error");
    expect(again.recordedTermination).toBeUndefined();
    expect(repairRecordedTerminations(runsDir, [f])).toEqual([]);
  });

  test("a pause only meta.json marks still reads as paused; a resume after a pause record cancels it", async () => {
    const runsDir = tempDir("wb-rec-pause-");
    const dir = join(runsDir, "fleet-rec-p2");
    const t = new Trajectory(dir);
    const config = loadRunConfig({ runId: "fleet-rec-p2", runsDir, moduleUrl: "http://127.0.0.1:9", driver: "openai", model: "z-ai/glm-5.2:free", episode: "e90" });
    const meta = { runId: "fleet-rec-p2", harnessVersion: HARNESS, startedAt: 1, config, comparability: comparabilityOf(config, HARNESS) };
    await t.writeMeta({ ...meta, pause: { reason: "rate-limited", detail: "429", at: 5_000, episodeElapsedMs: 900 } });
    t.close();
    const f = readRunFact(runsDir, "fleet-rec-p2", Date.now() + 10 * 60_000)!;
    expect(f.pause).toMatchObject({ reason: "rate-limited", at: 5_000, episodeElapsedMs: 900 });

    const resumed = await runWithRecordOnly(runsDir, "fleet-rec-p3", (tr) => {
      tr.append({ t: "pause", reason: "operator-pause", detail: "SIGTERM" });
      tr.append({ t: "resume", harnessVersion: "v" });
    });
    expect(verdictOfTrajectory(join(resumed, "trajectory.jsonl"))).toEqual({ kind: "resumed" });
  });

  test("a run whose row has its verdict never reads the trajectory for one", async () => {
    const runsDir = tempDir("wb-rec-term-");
    const dir = join(runsDir, "fleet-rec-a5");
    const t = new Trajectory(dir);
    const config = loadRunConfig({ runId: "fleet-rec-a5", runsDir, moduleUrl: "http://127.0.0.1:9", driver: "openai", model: "z-ai/glm-5.2:free", episode: "e90" });
    await t.writeMeta({ runId: "fleet-rec-a5", harnessVersion: HARNESS, startedAt: 1, config, comparability: comparabilityOf(config, HARNESS) });
    await t.setTermination("fleet-rec-a5", "manual", "by hand");
    t.close();
    const f = readRunFact(runsDir, "fleet-rec-a5", Date.now() + 10 * 60_000)!;
    expect(f.terminationReason).toBe("manual");
    expect(f.recordedTermination).toBeUndefined();
  });
});
