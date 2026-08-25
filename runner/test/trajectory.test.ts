import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig } from "../src/config";
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
    const config = loadRunConfig({ runId: "run-x", driver: "stub", model: "irrelevant" });
    traj.writeMeta({ runId: "run-x", harnessVersion: "0.0.0-test", startedAt: 5, config });
    const meta = readMeta(dir);
    expect(meta?.runId).toBe("run-x");
    expect(meta?.config.driver).toBe("stub");
    const row = traj.runRow("run-x");
    expect(row?.["harness_version"]).toBe("0.0.0-test");
    traj.close();
  });

  test("setCharacter records the name the model actually created", () => {
    // The launch config carries only the harness's suggestion. Three readers,
    // three places: the runs page and the positions feed read `run.character`,
    // a resumed runner reads meta.json before any database is open, and the
    // trajectory is the record of when it changed.
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-c", driver: "stub", model: "irrelevant", character: "Fleetsonnet" });
    traj.writeMeta({ runId: "run-c", harnessVersion: "0.0.0-test", startedAt: 5, config });
    traj.setCharacter("run-c", "Grimjaw");
    expect(traj.runRow("run-c")?.["character"]).toBe("Grimjaw");
    expect(readMeta(dir)?.config.character).toBe("Grimjaw");
    // The rest of the stored config is untouched, and startedAt is not restamped.
    expect(readMeta(dir)?.startedAt).toBe(5);
    expect(readMeta(dir)?.config.driver).toBe("stub");
    expect(readTrajectory(dir).some((r) => r.t === "character" && r["character"] === "Grimjaw")).toBe(true);
    traj.close();
  });

  // FOLLOW-UPS 36: both were derivable from config_json; a column means the
  // listing reads a fact rather than re-deriving a rule that could drift.
  test("writes the character and the platform as run columns", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({
      runId: "run-p",
      driver: "openai",
      model: "some/model",
      character: "Grimbold",
      apiBase: "https://openrouter.ai/api/v1",
    });
    traj.writeMeta({ runId: "run-p", harnessVersion: "0.0.0-test", startedAt: 5, config });
    const row = traj.runRow("run-p");
    expect(row?.["character"]).toBe("Grimbold");
    expect(row?.["platform"]).toBe("openrouter");
    traj.close();
  });

  // The one migration left: a 0.4-1..0.4-5 run.sqlite predates these two columns.
  test("adds character and platform to a run table written without them", () => {
    const dir = tempRunDir();
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE run (
      run_id TEXT PRIMARY KEY, harness_version TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, driver TEXT, shakeout TEXT, model TEXT, objective TEXT,
      termination_reason TEXT, termination_detail TEXT, pause_reason TEXT, config_json TEXT NOT NULL)`);
    db.close();
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId: "run-old", driver: "stub", model: "irrelevant", character: "Elsie" });
    traj.writeMeta({ runId: "run-old", harnessVersion: "0.0.0-test", startedAt: 5, config });
    expect(traj.runRow("run-old")?.["character"]).toBe("Elsie");
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

  test("items are recorded as JSON, null when the sample carried none, and the column migrates in", () => {
    const dir = tempRunDir();
    // A state table from before the `items` column (harness 0.4, pre item 50).
    const db = new Database(join(dir, "run.sqlite"));
    db.exec(`CREATE TABLE state (run_id TEXT NOT NULL, ts INTEGER NOT NULL, level INTEGER, xp INTEGER,
      map INTEGER, x REAL, y REAL, z REAL, event_count INTEGER, last_seq INTEGER, money INTEGER,
      quests_completed INTEGER, turn INTEGER, zone INTEGER, area INTEGER)`);
    db.close();
    const traj = new Trajectory(dir);
    const items = [
      { name: "Worn Mace", count: 1, equipped: true },
      { name: "Tough Jerky", count: 5, equipped: false },
    ];
    traj.recordState("run-i", { level: 1, items });
    traj.recordState("run-i", { level: 1 });
    const rows = traj.stateRows("run-i");
    expect(JSON.parse(String(rows[0]!["items"]))).toEqual(items);
    expect(rows[1]!["items"]).toBeNull();
    const line = readTrajectory(dir).find((r) => r.t === "state");
    expect(line?.["items"]).toEqual(items);
    traj.close();
  });

  test("the turn index is recorded, and absent rather than zero before the first turn", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    traj.recordState("run-t", { level: 1 });
    traj.recordState("run-t", { level: 2, turn: 14 });
    const rows = traj.stateRows("run-t");
    expect(rows[0]!["turn"]).toBeNull();
    expect(rows[1]!["turn"]).toBe(14);
    expect(readTrajectory(dir).find((r) => r.t === "state" && r["turn"] !== undefined)?.["turn"]).toBe(14);
    traj.close();
  });

  test("maxTurn is the high-water mark a resume continues from", () => {
    const dir = tempRunDir();
    const traj = new Trajectory(dir);
    expect(traj.maxTurn("run-t2")).toBe(0);
    traj.recordState("run-t2", { level: 1, turn: 4 });
    traj.recordState("run-t2", { level: 1 });
    expect(traj.maxTurn("run-t2")).toBe(4);
    traj.close();
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
