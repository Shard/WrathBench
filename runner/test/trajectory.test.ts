import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAUSE_REASONS, loadRunConfig, normalizePauseReason } from "../src/config";
import { Trajectory, readMeta, readTrajectory } from "../src/trajectory";

function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), "wrathbench-traj-"));
}

describe("Trajectory", () => {
  test("appends JSONL records with timestamps and survives bigints", () => {
    const dir = tempRunDir();
    let t = 100;
    const traj = new Trajectory(dir, { now: () => t });
    traj.append({ t: "snippet", code: "1n + 1n", guid: 123456789012345678901n });
    t = 200;
    traj.append({ t: "snippet_result", ok: true });
    traj.close();
    const records = readTrajectory(dir);
    expect(records).toHaveLength(2);
    expect(records[0]!.ts).toBe(100);
    expect(records[0]!["guid"]).toBe("123456789012345678901");
    expect(records[1]!.ts).toBe(200);
  });

  test("meta round-trips and lands in sqlite", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-x", adapter: "stub", model: "irrelevant" });
    traj.writeMeta({ runId: "run-x", harnessVersion: "0.0.0-test", startedAt: 5, config });
    const meta = readMeta(dir);
    expect(meta?.runId).toBe("run-x");
    expect(meta?.config.adapter).toBe("stub");
    const row = traj.runRow("run-x");
    expect(row?.["harness_version"]).toBe("0.0.0-test");
    traj.close();
  });

  test("periodic state goes to jsonl and sqlite", () => {
    const dir = tempRunDir();
    let t = 0;
    const traj = new Trajectory(dir, { now: () => ++t });
    traj.recordState("run-y", { level: 2, map: 0, x: 1, y: 2, z: 3, eventCount: 9, lastSeq: 8 });
    traj.recordState("run-y", { level: 3 });
    const rows = traj.stateRows("run-y");
    expect(rows).toHaveLength(2);
    expect(rows[0]!["level"]).toBe(2);
    expect(rows[1]!["level"]).toBe(3);
    expect(readTrajectory(dir).filter((r) => r.t === "state")).toHaveLength(2);
    traj.close();
  });

  test("money and quests completed are recorded, and stay null when unobserved", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    traj.recordState("run-m", { level: 4, money: 12345, questsCompleted: 2 });
    traj.recordState("run-m", { level: 4 });
    const rows = traj.stateRows("run-m");
    expect(rows[0]!["money"]).toBe(12345);
    expect(rows[0]!["quests_completed"]).toBe(2);
    // Never a guessed zero for something no event carried (docs/CONTRACTS.md).
    expect(rows[1]!["money"]).toBeNull();
    expect(rows[1]!["quests_completed"]).toBeNull();
    const line = readTrajectory(dir).find((r) => r.t === "state");
    expect(line?.["money"]).toBe(12345);
    expect(line?.["questsCompleted"]).toBe(2);
    traj.close();
  });

  test("a run.sqlite written before the new columns gains them on open", () => {
    const dir = tempRunDir();
    // The pre-migration state table, exactly as older runs carry it.
    const old = new Database(join(dir, "run.sqlite"));
    old.exec(`CREATE TABLE state (run_id TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER,
      xp INTEGER, map INTEGER, x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER);`);
    old.query(`INSERT INTO state (run_id, ts, level) VALUES ('run-old', 1, 7)`).run();
    old.close();

    const traj = new Trajectory(dir);
    traj.recordState("run-old", { level: 8, money: 42, questsCompleted: 1 });
    const rows = traj.stateRows("run-old");
    expect(rows).toHaveLength(2);
    // The pre-existing row keeps its data and reads null for the new columns.
    expect(rows[0]!["level"]).toBe(7);
    expect(rows[0]!["money"]).toBeNull();
    expect(rows[1]!["money"]).toBe(42);
    expect(rows[1]!["quests_completed"]).toBe(1);
    traj.close();

    // Reopening is a no-op: the migration must not fail on an already-migrated file.
    const again = new Trajectory(dir);
    expect(again.stateRows("run-old")).toHaveLength(2);
    again.close();
  });

  test("termination and pause reasons are recorded", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({});
    traj.writeMeta({ runId: "run-z", harnessVersion: "v", startedAt: 1, config });
    traj.setPause("run-z", "quota-exhausted", "429 quota");
    expect(traj.runRow("run-z")?.["pause_reason"]).toBe("quota-exhausted");
    traj.setTermination("run-z", "no-xp", "45m of nothing");
    const row = traj.runRow("run-z");
    expect(row?.["termination_reason"]).toBe("no-xp");
    expect(row?.["pause_reason"]).toBeNull();
    traj.close();
  });

  test("a pause reason stored under the old name reads as the current one", () => {
    // Nothing validates a stored pause reason, so old rows keep their bytes;
    // this is the one place the old vocabulary is translated for display.
    expect(normalizePauseReason("window-exhausted")).toBe("quota-exhausted");
    for (const r of PAUSE_REASONS) expect(normalizePauseReason(r)).toBe(r);
  });

  test("registered secrets are scrubbed from every line", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    traj.redact("sk-verysecretkey123");
    traj.append({ t: "response", text: "my key is sk-verysecretkey123 ok" });
    traj.close();
    const raw = readTrajectory(dir);
    expect(JSON.stringify(raw)).not.toContain("sk-verysecretkey123");
    expect(raw[0]!["text"]).toContain("[redacted]");
  });
});
